import type {
  SessionId,
  SessionMessageIndexEntry,
  SessionStorePort,
  TurnManifestQueryRecord,
  TurnManifestReadInput,
  TurnManifestReadResult,
  TurnManifestSnapshot,
  TurnManifestTurnRecord,
} from "@zcode/contracts";
import { PROTOCOL_V4_LIMITS, type TurnDirectoryEntry } from "@zcode/shared/zcode-protocol-v4";
import {
  createSessionMessageIndexCache,
  type SessionMessageIndexCache,
} from "./session-conversation-index.js";

/**
 * `session-row-manifest.ts` —— **全序计数与 rowId base 的唯一读路径**（spec Step 4 / IS5）。
 *
 * 这个模块只做三件事，且刻意都能被纯函数测到：
 *   1. 把 manifest 快照翻译成客户端/投影真正要用的四个量：`totalCount`、`firstRowId`、
 *      `realUserQueryTotal`、`turnDirectory`；
 *   2. 给出每个 turn 的 **rowId base**（`1 + Σ 前序 active turn 的 row_count`），并且这个
 *      函数是 live 投影与 cold 读路径**共用的唯一实现**（IS1：任意路径逐值一致）；
 *   3. 把 store 的读取结果收敛成唯一一个判定：`manifest`（可用）或 `fallback`（降级为
 *      全量物化 + 重建 manifest）。**`missing` / `schemaMismatch` / `inconsistent` 三者
 *      走同一个分支**——这是 Step 3 明确留给本步钉住的约束，见 `decideRowManifestAction`。
 *
 * 明确不做：本模块不读 message/part 正文，不扫投影行。`row_count` 是 manifest 的持久事实，
 * 覆盖全序计数的责任在这里是「读出来」，不是「再算一遍」。
 */

/**
 * rowId base 的唯一公式（IS1）：`originBase + Σ priorRowCounts`。
 *
 * - live 投影：`originBase = 1`，`priorRowCounts` = 本 turn 之前各 active turn 的块行数；
 * - manifest 读端：`originBase = firstRowId ?? 1`（全分支恒为 1），`priorRowCounts` =
 *   `turns[0..ordinal).rowCount`；
 * - 窗口化物化（Step 5/7）：`originBase` = 窗口**首轮**的 base（由 manifest 给出），
 *   于是窗口内每一轮的 base 与全量物化逐值一致，rewind 后新轮复用被截轮的 base，
 *   **不再产生空洞**（这是废除全局 `nextRowId++` 的数学前提）。
 *
 * 负数行数按 0 处理：行数是存储事实，出现负数只能是损坏数据，不得让 base 向前倒退。
 */
export function deriveTurnRowIdBase(priorRowCounts: readonly number[], originBase = 1): number {
  let base = originBase;
  for (const count of priorRowCounts) base += Math.max(0, count);
  return base;
}

/** 一段 active 分支的全序事实（读端唯一形状；不含正文）。 */
export interface SessionRowManifestFacts {
  branchGeneration: number;
  /** Σ turn.rowCount；空 active 分支为 0。 */
  totalCount: number;
  /** 空 active 分支为 null；否则恒为 1（base 从 1 起）。 */
  firstRowId: number | null;
  /** 目录表登记数（只含 `origin === "realUser"`）。 */
  realUserQueryTotal: number;
  /** 目录条目，按 `queryRowId` 升序（协议三条硬定义之一）。 */
  entries: TurnDirectoryEntry[];
  /** turnId → rowId base。 */
  rowIdBaseByTurnId: Map<string, number>;
  /** messageId → turnId（`durableTurnByMessageId` 的数据源，Step 9 接）。 */
  turnIdByMessageId: Map<string, string>;
  /** active 分支的 turn 数（= manifest 行数）。 */
  turnCount: number;
}

/**
 * manifest 快照 → 读端事实。
 *
 * 计数**直接取仓储给出的 `totalCount` / `firstRowId` / `realUserQueryTotal`**（仓储里的
 * `deriveTurnManifestTotals` 是这一口径的唯一实现）：读端再求和一次就是第二份实现，
 * 空分支 `totalCount=0 / firstRowId=null` 的边界迟早会漂。
 */
export function deriveSessionRowManifestFacts(
  snapshot: TurnManifestSnapshot,
): SessionRowManifestFacts {
  const originBase = snapshot.firstRowId ?? 1;
  const rowIdBaseByTurnId = new Map<string, number>();
  const turnIdByMessageId = new Map<string, string>();
  let priorRowCounts: number[] = [];
  for (const turn of snapshot.turns) {
    rowIdBaseByTurnId.set(turn.turnId, deriveTurnRowIdBase(priorRowCounts, originBase));
    for (const messageId of turn.messageIds) turnIdByMessageId.set(messageId, turn.turnId);
    priorRowCounts = [...priorRowCounts, turn.rowCount];
  }

  // 目录顺序 = queryRowId 升序。manifest 的 query 表按 (turn 序, turn 内序) 存储，
  // 但目录契约是 queryRowId 升序——rewind 复用 base 后两者同向，这里仍以协议的键为准。
  const entries = snapshot.queries
    .toSorted((left, right) => left.queryRowId - right.queryRowId)
    .map(toDirectoryEntry);

  return {
    branchGeneration: snapshot.branchGeneration,
    totalCount: snapshot.totalCount,
    firstRowId: snapshot.firstRowId,
    realUserQueryTotal: snapshot.realUserQueryTotal,
    entries,
    rowIdBaseByTurnId,
    turnIdByMessageId,
    turnCount: snapshot.turns.length,
  };
}

function toDirectoryEntry(query: TurnManifestQueryRecord): TurnDirectoryEntry {
  return {
    turnId: query.turnId,
    queryRowId: query.queryRowId,
    queryPreview: query.queryPreview,
    assistantPreview: query.assistantPreview,
    assistantPreviewKind: query.assistantPreviewKind,
  };
}

/**
 * 目录分页（与 `ConversationTopicPublisher.getTurnDirectory` 的三条硬定义逐字同规）：
 *   1. `entries` 按 queryRowId 升序；
 *   2. `beforeQueryRowId` 只取严格更小的更早条目；
 *   3. `hasMore` = 更早方向仍有条目，不是「这页正好拉满 limit」。
 * `realUserQueryTotal` 不受游标与 limit 影响。
 */
export function selectManifestTurnDirectory(
  facts: Pick<SessionRowManifestFacts, "entries" | "realUserQueryTotal">,
  params: { limit?: number; beforeQueryRowId?: number },
): { entries: TurnDirectoryEntry[]; realUserQueryTotal: number; hasMore: boolean } {
  const limit = Math.max(
    1,
    Math.min(
      params.limit ?? PROTOCOL_V4_LIMITS.turnDirectoryMaxEntries,
      PROTOCOL_V4_LIMITS.turnDirectoryMaxEntries,
    ),
  );
  const eligible =
    params.beforeQueryRowId === undefined
      ? facts.entries
      : facts.entries.filter((entry) => entry.queryRowId < (params.beforeQueryRowId as number));
  const page = eligible.slice(-limit);
  return {
    entries: page,
    realUserQueryTotal: facts.realUserQueryTotal,
    hasMore: eligible.length > page.length,
  };
}

/** turnId → rowId base（未知 turn = null；调用方据此判「这一轮不在 manifest 里」）。 */
export function manifestRowIdBase(facts: SessionRowManifestFacts, turnId: string): number | null {
  return facts.rowIdBaseByTurnId.get(turnId) ?? null;
}

/**
 * 读端降级原因。`portAbsent` = 宿主没实现 manifest 存储（旧宿主 / 内存 store）；
 * `readFailed` = store 抛错（**同样按降级处理**：重建是幂等的，而「读不到 manifest 就当真
 * 空分支」会让全序归零——那是唯一不能接受的结果）。
 */
export type RowManifestFallbackReason =
  | "portAbsent"
  | "missing"
  | "schemaMismatch"
  | "inconsistent"
  | "readFailed";

export type SessionRowManifestReadOutcome =
  | {
      kind: "manifest";
      facts: SessionRowManifestFacts;
      /** 本次读做过账目修正（就地改 row_count，不重读正文）。 */
      manifestAdjusted: boolean;
      adjustedTurnIds: string[];
      /** false = 消息索引端口缺席，`messageIndexMismatch` 这一路**没有**被检查（不是通过）。 */
      messageIndexChecked: boolean;
    }
  | {
      kind: "fallback";
      reason: RowManifestFallbackReason;
      /** inconsistent 时带出 Step 3 的细分原因与诊断（截断到前 20 条 messageId）。 */
      detail?: {
        inconsistentReason?: "ordinalGap" | "unregisteredTurns" | "messageIndexMismatch";
        turnIds?: string[];
        missingMessageIds?: string[];
        expectedVersion?: number;
        foundVersions?: number[];
        /** fullyMaterialized 观察里「manifest 多出、投影没有」的 turn（见 toFallback 注释）。 */
        unobservedTurnIds?: string[];
        message?: string;
      };
    };

/**
 * 读端对 manifest 的唯一裁决动作。
 *
 * **`missing` / `schemaMismatch` / `inconsistent` 与其它降级原因必须走同一条路**
 * （全量物化 + 重建 manifest）：前两者是「没有可用清单」，后者是「清单与事实不一致」，
 * 而读端能用同一份全量物化的产物重建它。把它们分开处理就会让「清单少了半截」被当成
 * 有效全序（totalCount 偏小、rowId base 整体前移），症状是翻页错位而不是报错。
 */
export type RowManifestAction = "use-manifest" | "materialize-and-rebuild";

export function decideRowManifestAction(outcome: SessionRowManifestReadOutcome): RowManifestAction {
  return outcome.kind === "manifest" ? "use-manifest" : "materialize-and-rebuild";
}

/** 读路径请求。观察输入全部来自调用方（读端不回读正文）。 */
export interface SessionRowManifestReadRequest {
  branchGeneration: number;
  expectedProjectionSchemaVersion: number;
  /**
   * 调用方的权威 turn 序。全量物化时 = 投影的 active turn 序；窗口化物化时只能是窗口内的
   * turn（那时抓不到尾部丢轮，需由 `fullyMaterialized: false` 明确声明）。
   */
  observedTurnIds?: readonly string[];
  /** turnId → 投影里该轮的实际行数（账目修正的唯一输入）。 */
  observedRowCounts?: ReadonlyMap<string, number>;
  /**
   * 投影是否覆盖整条 active 分支。只有 true 时才能做**双向** turn 集合校验
   * （manifest 多出的 turn 在投影里不存在 = 清单比事实长）；窗口化时必须 false，
   * 否则每一页都会被判成不一致。
   */
  fullyMaterialized?: boolean;
}

export interface SessionRowManifestReader {
  read(
    sessionID: SessionId,
    request: SessionRowManifestReadRequest,
  ): Promise<SessionRowManifestReadOutcome>;
  /** 失效该会话的消息索引缓存（live ingest / rewind）。 */
  invalidateMessageIndex(sessionID: SessionId): void;
  dispose(): void;
}

/**
 * 建读端。`store` 是 getter（宿主可能在网关构造后才注入）；`indexCache` 可注入以便测试
 * 断言「一次会话只读一次索引」。
 */
export function createSessionRowManifestReader(input: {
  store: () => SessionStorePort | undefined;
  indexCache?: SessionMessageIndexCache;
}): SessionRowManifestReader {
  const indexCache = input.indexCache ?? createSessionMessageIndexCache();

  async function read(
    sessionID: SessionId,
    request: SessionRowManifestReadRequest,
  ): Promise<SessionRowManifestReadOutcome> {
    const store = input.store();
    const port = store?.turnManifest;
    if (!port) return { kind: "fallback", reason: "portAbsent" };

    try {
      // 第一趟只带 turn 观察（便宜）：turn 集合/ordinal/版本不对时根本不需要读 O(messages)
      // 的消息索引——降级路径（老会话第一次冷开）本来就没有可用清单。
      // **不带** observedRowCounts：账目修正只在最终那一趟做，否则第一趟就把偏差改掉，
      // 第二趟的 `manifestAdjusted` 永远是 false，打点会谎报「没修正过」。
      const first = await port.readTurnManifest(toReadInput(sessionID, request, false));
      const firstFallback = toFallback(first, request);
      if (firstFallback) return firstFallback;

      // 第二趟带消息索引观察：`messageIndexMismatch` 是「manifest 指向已不存在的消息」
      // 的唯一检测手段（消息索引没有 turn 维度，抓不到尾部丢轮，反过来也一样）。
      // 索引按会话缓存，Step 5/7 的翻页读复用同一份；这里只付一次 O(messages)。
      // 空数组是**有效观察**（消息全没了），只有 `null`（端口缺席）才跳过这一路。
      const indexEntries = await readIndexForCheck(store, sessionID);
      const second = await port.readTurnManifest({
        ...toReadInput(sessionID, request, true),
        ...(indexEntries === null
          ? {}
          : { observedMessageIds: indexEntries.map((entry) => entry.id) }),
      });
      const secondFallback = toFallback(second, request);
      if (secondFallback) return secondFallback;
      if (second.status !== "ok") return { kind: "fallback", reason: "readFailed" };

      return {
        kind: "manifest",
        facts: deriveSessionRowManifestFacts(second.snapshot),
        manifestAdjusted: second.snapshot.manifestAdjusted,
        adjustedTurnIds: second.snapshot.adjustedTurnIds,
        messageIndexChecked: indexEntries !== null,
      };
    } catch (error) {
      // store 抛错 = 读不到清单。不把异常往上抛：冷开会因为一次瞬时 sqlite 错误整体失败，
      // 而降级的代价只是「多物化一次 + 重建清单」。
      return {
        kind: "fallback",
        reason: "readFailed",
        detail: { message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async function readIndexForCheck(
    store: SessionStorePort,
    sessionID: SessionId,
  ): Promise<readonly SessionMessageIndexEntry[] | null> {
    try {
      return await indexCache.read(store, sessionID);
    } catch {
      // 索引读失败不能把「清单正确」判成错误：这一路只是交叉验证，缺席即跳过，
      // 由 `messageIndexChecked: false` 让「没查」可见（而不是静默当成通过）。
      return null;
    }
  }

  return {
    read,
    invalidateMessageIndex(sessionID) {
      indexCache.invalidate(sessionID);
    },
    dispose() {
      indexCache.clear();
    },
  };
}

function toReadInput(
  sessionID: SessionId,
  request: SessionRowManifestReadRequest,
  withObservedRowCounts: boolean,
): TurnManifestReadInput {
  return {
    sessionID,
    branchGeneration: request.branchGeneration,
    expectedProjectionSchemaVersion: request.expectedProjectionSchemaVersion,
    ...(request.observedTurnIds === undefined ? {} : { observedTurnIds: request.observedTurnIds }),
    ...(withObservedRowCounts && request.observedRowCounts !== undefined
      ? { observedRowCounts: request.observedRowCounts }
      : {}),
  };
}

/**
 * 读结果 → 降级判定（null = 可用）。
 *
 * `fullyMaterialized` 的**反向**校验在这里补：契约的 `unregisteredTurns` 只判「观察到但
 * 没登记」，反方向（登记了但投影里没有）在窗口化路径上是合法的（窗口只覆盖尾部），所以
 * 不能进契约；只有全量物化时它才是错误，而且它正是「manifest 把已删的轮次留在清单里」
 * 的症状（totalCount 偏大、firstRowId 之外整体错位）。
 */
function toFallback(
  result: TurnManifestReadResult,
  request: SessionRowManifestReadRequest,
): SessionRowManifestReadOutcome | null {
  if (result.status === "missing") return { kind: "fallback", reason: "missing" };
  if (result.status === "schemaMismatch") {
    return {
      kind: "fallback",
      reason: "schemaMismatch",
      detail: {
        expectedVersion: result.expectedVersion,
        foundVersions: result.foundVersions,
      },
    };
  }
  if (result.status === "inconsistent") {
    return {
      kind: "fallback",
      reason: "inconsistent",
      detail: {
        inconsistentReason: result.reason,
        turnIds: result.turnIds,
        missingMessageIds: result.missingMessageIds,
      },
    };
  }
  if (request.fullyMaterialized && request.observedTurnIds !== undefined) {
    const observed = new Set(request.observedTurnIds);
    const unobserved = result.snapshot.turns
      .filter((turn) => !observed.has(turn.turnId))
      .map((turn) => turn.turnId);
    if (unobserved.length > 0) {
      return {
        kind: "fallback",
        reason: "inconsistent",
        detail: { inconsistentReason: "unregisteredTurns", unobservedTurnIds: unobserved },
      };
    }
  }
  return null;
}
