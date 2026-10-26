import type {
  ActiveConversationBranchRewind,
  MessageId,
  MessageWithParts,
  SessionId,
  SessionMessageIndexEntry,
  SessionStorePort,
  TurnManifestQueryRecord,
  TurnManifestReadInput,
  TurnManifestReadResult,
  TurnManifestSnapshot,
  TurnManifestTurnRecord,
} from "@zcode/contracts";
import { selectActiveConversationBranchIds } from "@zcode/contracts";
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
  /**
   * 逐轮布局（按 ordinal 升序）：Step 7 的翻页定位用它把 `beforeRowId` 翻成「页内哪几个
   * 整轮」，再取正文游标。**不驻留 messageIds 数组**——那等于把整条分支的消息 id 复制
   * 一份进 publisher；页内的 messageId 由 `turnIdByMessageId` 反查（见 `selectColdRowPage`）。
   */
  turns: SessionRowManifestTurnLayout[];
}

/** facts 里的逐轮布局（manifest 快照的最小投影，不含消息全表）。 */
export interface SessionRowManifestTurnLayout {
  ordinal: number;
  turnId: string;
  rowCount: number;
  /** 该轮首条 messageId；该轮没有可投影消息时为 null（不能当正文读游标）。 */
  firstMessageId: MessageId | null;
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
    turns: snapshot.turns.map((turn) => ({
      ordinal: turn.ordinal,
      turnId: turn.turnId,
      rowCount: turn.rowCount,
      firstMessageId: turn.firstMessageId,
    })),
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
 * 冷开首屏的尾窗（phase-paged-materialization / IS6）：从 active 分支尾部对齐到**整 turn**。
 *
 * 双约束取 min（`PROTOCOL_V4_LIMITS.coldWindowTurns` / `coldWindowMaxRows`）：
 * - 只限 turn 数时，一个几百 toolCall 的超大 turn 会让「窗口化」失效（行数是硬上界）；
 * - 只限行数时，窗口边界会落在 turn 中间，toolCall ↔ result 跨窗、合成器身份也跟着漂。
 *
 * **至少取一轮**：单个 turn 自己就超过行上限时仍然返回它。返回空窗等于首屏空白，而
 * 「行数硬上界」在这里只是内存/时延的预算，不是正确性约束——正确性靠 turn 对齐。
 *
 * 返回值是 Step 6/7 唯一的窗口身份来源：
 * - `ordinal` → 合成器的 `initialTurnNumber`（RC4：窗口从 0 编号会让 turnId 整体漂移）；
 * - `rowIdBase` → 投影的 `rowIdOrigin`（否则窗口内 rowId 与全量物化整体平移）；
 * - `limitBefore` → `readActiveBranchTail` 的窗口游标（窗口首条 messageId，含）。
 */
export interface ColdTailWindow {
  /** 窗口首轮在 manifest 里的 ordinal（= 该轮之前有多少轮）。 */
  ordinal: number;
  /** 窗口首轮的 turnId（诊断用；身份由 ordinal 表达）。 */
  turnId: string;
  /** 窗口首轮的 rowId base（`deriveTurnRowIdBase` 口径）= 冷窗口的 `rowIdOrigin`。 */
  rowIdBase: number;
  /** 窗口覆盖的 turn 数（≤ maxTurns；单轮超行上限时为 1）。 */
  turnCount: number;
  /** 窗口覆盖的 manifest 行数（Σ rowCount，与 `totalCount` 同口径）。 */
  rowCount: number;
  /** 窗口首条 messageId（`readActiveBranchTail` 的 `limitBefore`）；整窗无消息时为 null。 */
  limitBefore: MessageId | null;
  /** 窗口内按行序排列的 messageId（= active 分支的后缀）。 */
  messageIds: MessageId[];
}

export function selectColdTailWindow(
  snapshot: Pick<TurnManifestSnapshot, "turns"> & { firstRowId?: number | null },
  limits: { maxTurns?: number; maxRows?: number } = {},
): ColdTailWindow | null {
  const turns = snapshot.turns;
  if (turns.length === 0) return null;
  // 上限非法值（0 / 负数）按「至少一轮」处理：窗口化是性能优化，不能让它产出空窗。
  const maxTurns = Math.max(1, limits.maxTurns ?? PROTOCOL_V4_LIMITS.coldWindowTurns);
  const maxRows = Math.max(0, limits.maxRows ?? PROTOCOL_V4_LIMITS.coldWindowMaxRows);

  let start = turns.length - 1;
  let turnCount = 1;
  let rowCount = Math.max(0, turns[start]!.rowCount);
  while (start > 0) {
    if (turnCount + 1 > maxTurns) break;
    const nextRowCount = Math.max(0, turns[start - 1]!.rowCount);
    // 行数是硬上界：再加一轮就会超预算就停（正好等于预算时才允许加入）。
    if (rowCount + nextRowCount > maxRows) break;
    start -= 1;
    turnCount += 1;
    rowCount += nextRowCount;
  }

  const first = turns[start]!;
  const priorRowCounts = turns.slice(0, start).map((turn) => turn.rowCount);
  // 窗口内 messageId 按行序拼（重复 id 由 `readActiveBranchTail` 按首现去重）。
  const messageIds = turns
    .slice(start)
    .flatMap((turn) => turn.messageIds) as unknown as MessageId[];
  return {
    ordinal: first.ordinal,
    turnId: first.turnId,
    rowIdBase: deriveTurnRowIdBase(priorRowCounts, snapshot.firstRowId ?? 1),
    turnCount,
    rowCount,
    limitBefore: messageIds[0] ?? null,
    messageIds,
  };
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
      /**
       * 原始快照（账目修正后的）。`facts` 是给客户端/投影用的四个量与 base，**窗口选择**
       * 还要 per-turn 的 `rowCount` / `messageIds`（`selectColdTailWindow` 的输入），
       * 所以两份都带出来——重新读一遍 store 是第二次实现，迟早与 facts 分叉。
       */
      snapshot: TurnManifestSnapshot;
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
  /**
   * 该会话的全序消息索引（与 `read` 共用同一份缓存）。
   *
   * 冷窗口的裁断与尾窗读都要全序 id 序，而 `read` 内部已经把索引读过一遍——这里必须
   * 复用那份缓存，否则一次冷开会把 O(messages) 的索引读付两次。`null` = 端口缺席。
   */
  readMessageIndex(sessionID: SessionId): Promise<readonly SessionMessageIndexEntry[] | null>;
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
        snapshot: second.snapshot,
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
    readMessageIndex(sessionID) {
      const store = input.store();
      if (!store?.listSessionMessageIndex) return Promise.resolve(null);
      return readIndexForCheck(store, sessionID);
    },
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

// ── 冷开尾窗的**唯一**物化计划（Step 6 接线）────────────────────────────────

/**
 * 尾窗物化降级到全量的原因。**每一种都必须打点**（gateway / bridge 各有一条日志）：
 * 静默退全量在现象上等于「窗口化没生效」，与「清单与索引不同步」完全无法区分。
 */
export type ColdTailWindowFallbackReason =
  | RowManifestFallbackReason
  | "emptyBranch"
  | "noIndexPort"
  | "indexReadFailed"
  | "noTailPort"
  | "noWindowCursor"
  | "limitBeforeMissed"
  | "emptyTail";
// `sharedContextImport` 曾是「窗口会静默丢掉分享导入元数据」的降级原因；Step 9 改成按 id
// 单条确认那条 model-only 上下文消息（`cold-event-merge` 的 isSharedContextImportMessage），
// 该降级已删除——分享导入的会话现在也走窗口化。

/**
 * 窗口坐标（**不含正文**）：冷开后面几步要用的身份一次给全，避免各自再读一遍清单。
 * gateway 只吃这一份：`rowIdBase` → `seedRowIdOrigin`、`ordinal` → `initialTurnNumber` 与
 * 降级回写的 `ordinalBase`、`branchTurnIds` → 剪枝的 `keptTurnIds`。
 */
export interface ColdTailWindowPlan {
  ordinal: number;
  rowIdBase: number;
  turnCount: number;
  rowCount: number;
  limitBefore: MessageId | null;
  /**
   * **整条** active 分支的 turn 序（不是窗口）。降级回写的 `keptTurnIds` 必须用它：
   * 窗口投影的 `activeTurnIds` 只含窗口内 turn，拿它剪枝会把没物化的头部真实轮次删掉。
   */
  branchTurnIds: string[];
  /** 全序 active message id：`buildColdFileChangeSummaries` 仍要按整条分支过滤。 */
  activeMessageIds: MessageId[];
  /**
   * 窗口内的 messageId（清单口径）。用于过滤**锚在窗口外**的 goal verification 事实：
   * 合成器对「anchor 找不到」的 entry 会落到时间线末尾，那会给窗口凭空加行。
   */
  windowMessageIds: MessageId[];
  /** manifest 快照的四个量与 base → publisher facts 的唯一来源。 */
  facts: SessionRowManifestFacts;
  manifestAdjusted: boolean;
  messageIndexChecked: boolean;
  /**
   * 合成器的非零起点上下文（RC4）：`baseTimestampMs` 取**整条分支**首条消息时间；
   * 窗口前一轮的首条 messageId 用于 `initialModelKey`（窗口即整条分支时缺席）。
   */
  precedingTurnFirstMessageId: MessageId | null;
  baseTimestampMs?: number;
}

/** 窗口物化的完整产出 = 坐标 + 窗口正文（正文只含窗口内的 message + part）。 */
export interface ColdTailWindowMaterialization extends ColdTailWindowPlan {
  messages: MessageWithParts[];
}

export type ColdTailWindowReadResult =
  | ({ kind: "window" } & ColdTailWindowMaterialization)
  | { kind: "full"; reason: ColdTailWindowFallbackReason; detail?: string };

/**
 * 冷开尾窗的读计划（Step 6 / IS2 / IS6）——**冷开正文读只经这一个入口**。
 *
 * 顺序是有意的：
 *   1. 先读 manifest（两趟 + 索引交叉验证，全部走 `reader`，索引缓存跨步复用）；
 *   2. `decideRowManifestAction` 不是 `use-manifest` → 直接全量物化（清单不可信时
 *      `selectColdTailWindow` 的 `ordinal` 会给出错的 `initialTurnNumber`）；
 *   3. 只信 `use-manifest` 之后才选窗口，然后按**全序** active id 序读窗口正文。
 *
 * 任何一步不成立都返回 `kind:"full"` 并带上原因——**宁可慢，不可少读**：窗口是一份
 * 视图，缺口会表现为「首屏少了几轮」，而全量物化永远是对的。
 *
 * `limitBefore` 找不到（清单与索引不同步）必须单独成一个原因：那时实际读到的是整条
 * 分支，若仍按窗口播种 `rowIdOrigin` / `initialTurnNumber`，rowId 会整体平移。
 */
export async function readColdTailWindowMaterialization(input: {
  sessionID: SessionId;
  store: SessionStorePort | undefined;
  reader: SessionRowManifestReader;
  branchGeneration: number;
  expectedProjectionSchemaVersion: number;
  /** `session.revert` 的四个裁断字段（与全量路径同一份规则，见 `selectActiveConversationBranchIds`）。 */
  rewind?: ActiveConversationBranchRewind;
  /**
   * runtime resume 已经拿到的全量正文（`persistedMessages`）。给出时**不读 store**，
   * 只在内存里按下界切片：同一份窗口、零 IO（resume 已经把正文读进内存，再读一次 DB
   * 是纯浪费；而窗口本身仍然省掉整条分支的合成与投影）。
   */
  loadedMessages?: readonly MessageWithParts[];
}): Promise<ColdTailWindowReadResult> {
  const store = input.store;
  if (!store) return { kind: "full", reason: "portAbsent" };
  if (!store.listSessionMessageIndex) return { kind: "full", reason: "noIndexPort" };
  // 内存正文路径不需要尾窗读端口；只有真要读 DB 时才要求它。
  if (!store.readActiveBranchTail && !input.loadedMessages) {
    return { kind: "full", reason: "noTailPort" };
  }

  const outcome = await input.reader.read(input.sessionID, {
    branchGeneration: input.branchGeneration,
    expectedProjectionSchemaVersion: input.expectedProjectionSchemaVersion,
  });
  if (decideRowManifestAction(outcome) !== "use-manifest" || outcome.kind !== "manifest") {
    return {
      kind: "full",
      reason: outcome.kind === "fallback" ? outcome.reason : "readFailed",
      ...(outcome.kind === "fallback" && outcome.detail?.message !== undefined
        ? { detail: outcome.detail.message }
        : {}),
    };
  }

  const window = selectColdTailWindow(outcome.snapshot);
  // 空 active 分支：全量物化本来就是一次空读（`totalCount=0 / firstRowId=null` 由 facts 表达）。
  if (!window) return { kind: "full", reason: "emptyBranch" };

  const indexEntries = await input.reader.readMessageIndex(input.sessionID);
  if (indexEntries === null) return { kind: "full", reason: "indexReadFailed" };
  const orderedMessageIds = indexEntries.map((entry) => String(entry.id));
  // 裁断只吃 id 序（IS2）：窗口绝不能进这里，否则 rewind 的 target/cut 落在窗口外时
  // 会原样返回窗口（复活旧分支）或整段清空。
  const activeMessageIds = selectActiveConversationBranchIds(
    orderedMessageIds,
    input.rewind ?? {},
  ) as MessageId[];

  const limitBefore = window.limitBefore;
  if (limitBefore === null) return { kind: "full", reason: "noWindowCursor" };
  if (!activeMessageIds.includes(limitBefore)) {
    // 清单指向的窗口首条消息不在 active 序里 = 清单与索引不同步。此时读全文是对的，
    // 但**必须**让调用方看见——否则这一项会永远静默地退化成全量。
    return { kind: "full", reason: "limitBeforeMissed", detail: String(limitBefore) };
  }

  const messages = await readWindowBody(input, store, activeMessageIds, limitBefore);
  if (messages === null)
    return { kind: "full", reason: "limitBeforeMissed", detail: String(limitBefore) };
  if (messages.length === 0) return { kind: "full", reason: "emptyTail" };

  const precedingTurn = window.ordinal > 0 ? outcome.snapshot.turns[window.ordinal - 1] : undefined;
  const baseTimestampMs = indexEntries.find(
    (entry) => String(entry.id) === activeMessageIds[0],
  )?.timeCreated;

  return {
    kind: "window",
    ordinal: window.ordinal,
    rowIdBase: window.rowIdBase,
    turnCount: window.turnCount,
    rowCount: window.rowCount,
    limitBefore,
    branchTurnIds: outcome.snapshot.turns.map((turn) => turn.turnId),
    activeMessageIds,
    windowMessageIds: [...window.messageIds],
    facts: outcome.facts,
    manifestAdjusted: outcome.manifestAdjusted,
    messageIndexChecked: outcome.messageIndexChecked,
    precedingTurnFirstMessageId: (precedingTurn?.messageIds[0] ?? null) as MessageId | null,
    ...(baseTimestampMs === undefined ? {} : { baseTimestampMs }),
    messages,
  };
}

/**
 * 窗口正文：内存里有（resume 的 `persistedMessages`）就按游标切片，否则走
 * `readActiveBranchTail`（**冷开唯一的正文读入口**，`messages()` 全量读不再参与）。
 *
 * 返回 null = 内存正文里找不到游标（与 DB 路径的 `limitBeforeMissed` 同义：不同步，退全量）。
 */
async function readWindowBody(
  input: {
    sessionID: SessionId;
    loadedMessages?: readonly MessageWithParts[];
  },
  store: SessionStorePort,
  activeMessageIds: readonly MessageId[],
  limitBefore: MessageId,
): Promise<MessageWithParts[] | null> {
  const loaded = input.loadedMessages;
  if (loaded) {
    const start = loaded.findIndex((message) => String(message.info.id) === String(limitBefore));
    return start < 0 ? null : loaded.slice(start);
  }
  // 端口缺席已在入口判过（`noTailPort`），这里的断言只是让类型收窄。
  if (!store.readActiveBranchTail) return null;
  // Bug 原因（Step 13 端到端查出的）：这里曾经把方法**摘下来**再调
  // （`const readTail = store.readActiveBranchTail; readTail(...)`），而生产的
  // `SqliteSessionStore` 是类实例、方法体读 `this.db`——摘下来之后 `this` 是 undefined，
  // 真 sqlite 冷开在窗口正文读这一步必抛 `Cannot read properties of undefined (reading 'db')`。
  // 之前没暴露是因为 Step 6/7 的用例都用对象字面量夹具（`readActiveBranchTail` 是闭包）。
  // 修复依据：与同文件 `readColdRowPageMaterialization:914` 的调用形态保持一致（保留 `this`）。
  return await store.readActiveBranchTail({
    sessionID: input.sessionID,
    activeMessageIds,
    limitBefore,
  });
}

// ── 按需物化的一页（Step 7 / IS6）──────────────────────────────────────────

/**
 * 翻页选不出一页的原因。**都能打点、都不产生错数据**：选不出就退回「投影现算的那一页」，
 * 客户端看到的是「更早方向没有了」（`hasMore:false`），与 Step 6 的已知代价一致。
 */
export type ColdRowPageUnavailableReason =
  /** 空 active 分支：没有页可物化（`totalCount=0 / firstRowId=null` 已表达）。 */
  | "emptyBranch"
  /** `beforeRowId` 不高于权威首行 = 上面本来就没有行（不是失败）。 */
  | "noOlderRows"
  /** 页首轮没有可投影消息（没有正文游标，读不出它的行）。 */
  | "noMessageCursor"
  /** facts 里查不到页首轮的 base（清单自身不一致，读端不该到这）。 */
  | "noRowIdBase";

/**
 * 一页的 manifest 坐标（**不含正文**）。三个消费者各取一段：
 * - gateway：`rowIdBase` → 临时投影的 `rowIdOrigin`，`turnCount`/`rowCount` → 一致性守卫；
 * - 宿主读正文：`limitBefore` / `limitAfter`；
 * - 合成器：`ordinal` → `initialTurnNumber`，`precedingTurnFirstMessageId` → `initialModelKey`。
 */
export interface ColdRowPagePlan {
  /** 页首轮的 manifest ordinal（= 合成器的 `initialTurnNumber`）。 */
  ordinal: number;
  /** 页首轮的 rowId base（= 临时投影的 `rowIdOrigin`）。 */
  rowIdBase: number;
  /** 页覆盖的 turn 数（一致性守卫的期望值）。 */
  turnCount: number;
  /** 页覆盖的 manifest 行数（Σ rowCount，与 `totalCount` 同口径）。 */
  rowCount: number;
  firstTurnId: string;
  lastTurnId: string;
  /** 页内 turn 序（升序）；宿主用它把 goal verification 归户到页内的轮。 */
  turnIds: string[];
  /** 页内 messageId（manifest 口径；goal verification 的 anchor 过滤）。 */
  messageIds: MessageId[];
  /** 正文读下界（含）= 页首轮首条 messageId。 */
  limitBefore: MessageId;
  /** 正文读上界（不含）= 页末轮之后第一个有消息的轮的首条 messageId；null = 读到分支末尾。 */
  limitAfter: MessageId | null;
  /** 页前一轮的首条 messageId（`initialModelKey`）；页即分支头时为 null。 */
  precedingTurnFirstMessageId: MessageId | null;
}

export type ColdRowPageSelection =
  | { kind: "page"; plan: ColdRowPagePlan }
  | { kind: "unavailable"; reason: ColdRowPageUnavailableReason };

/**
 * `beforeRowId` → 一页整轮（Step 7 / IS6 的定位半边）。
 *
 * 三条规则，缺一条就会与全量物化错位：
 *   1. **按整轮对齐**：页的上下界都扩到 turn 边界，`toolCall ↔ result` 不跨页，合成器的
 *      轮边界也不会与 manifest 的轮边界打架（`preface` 保持默认）。
 *   2. **rowId base 只从 `rowIdBaseByTurnId` 取**：那是 `deriveTurnRowIdBase` 的唯一落点，
 *      这里再求和一次就是第二份实现（IS1 的同一函数要求）。
 *   3. **页外不读**：`limitAfter` 取「页末轮之后第一个有消息的轮」，于是翻第 N 页的成本
 *      与「页在会话里的位置」无关（否则每页都会把后缀重读重合成一遍）。
 *
 * `limitBefore` 取不到（页首轮没有可投影消息）时**不猜**：直接判不可用。少一页可以用
 * `hasMore:false` 表达，猜一个游标会让页内 rowId 整体平移。
 */
export function selectColdRowPage(
  facts: Pick<
    SessionRowManifestFacts,
    "turns" | "firstRowId" | "rowIdBaseByTurnId" | "turnIdByMessageId"
  >,
  params: { beforeRowId: number; limit: number },
): ColdRowPageSelection {
  const firstRowId = facts.firstRowId;
  if (firstRowId === null || facts.turns.length === 0) {
    return { kind: "unavailable", reason: "emptyBranch" };
  }
  if (params.beforeRowId <= firstRowId) {
    return { kind: "unavailable", reason: "noOlderRows" };
  }
  const limit = Math.max(1, params.limit);
  // 页的偏移区间 [wantStart, rowsBefore) 相对权威首行；两端都不含尾部的追逐。
  const rowsBefore = params.beforeRowId - firstRowId;
  const wantStart = Math.max(0, rowsBefore - limit);
  let offset = 0;
  let firstIndex = -1;
  let lastIndex = -1;
  for (let index = 0; index < facts.turns.length; index += 1) {
    const rowCount = Math.max(0, facts.turns[index]!.rowCount);
    if (firstIndex < 0 && offset + rowCount > wantStart) firstIndex = index;
    if (offset < rowsBefore) lastIndex = index;
    offset += rowCount;
  }
  if (firstIndex < 0 || lastIndex < firstIndex) {
    return { kind: "unavailable", reason: "noOlderRows" };
  }
  const first = facts.turns[firstIndex]!;
  const last = facts.turns[lastIndex]!;
  const limitBefore = first.firstMessageId;
  if (limitBefore === null) return { kind: "unavailable", reason: "noMessageCursor" };
  const rowIdBase = facts.rowIdBaseByTurnId.get(first.turnId);
  if (rowIdBase === undefined) return { kind: "unavailable", reason: "noRowIdBase" };

  // 页末轮之后第一个有消息的轮 = 正文读的**上界**（不含）。找不到（页末轮之后全是空轮）
  // 就是「读到分支末尾」——此时后缀本来也没有消息可读。
  let limitAfter: MessageId | null = null;
  for (let index = lastIndex + 1; index < facts.turns.length; index += 1) {
    const candidate = facts.turns[index]!.firstMessageId;
    if (candidate !== null) {
      limitAfter = candidate;
      break;
    }
  }
  // 页前一轮的模型基线：向前找最近的有消息的轮（空轮给不出选型）。
  let precedingTurnFirstMessageId: MessageId | null = null;
  for (let index = firstIndex - 1; index >= 0; index -= 1) {
    const candidate = facts.turns[index]!.firstMessageId;
    if (candidate !== null) {
      precedingTurnFirstMessageId = candidate;
      break;
    }
  }

  const selected = facts.turns.slice(firstIndex, lastIndex + 1);
  const turnIds = selected.map((turn) => turn.turnId);
  const selectedTurnIds = new Set(turnIds);
  // 页内 messageId 由 `turnIdByMessageId` 反查（保持快照里的原序，去重交给下游）。
  const messageIds: MessageId[] = [];
  for (const [messageId, turnId] of facts.turnIdByMessageId) {
    if (selectedTurnIds.has(turnId)) messageIds.push(messageId as MessageId);
  }
  const rowCount = selected.reduce((sum, turn) => sum + Math.max(0, turn.rowCount), 0);
  return {
    kind: "page",
    plan: {
      ordinal: first.ordinal,
      rowIdBase,
      turnCount: selected.length,
      rowCount,
      firstTurnId: first.turnId,
      lastTurnId: last.turnId,
      turnIds,
      messageIds,
      limitBefore,
      limitAfter,
      precedingTurnFirstMessageId,
    },
  };
}

/** 一页正文读的降级原因（宿主侧；每一种都只导致「这一页不物化」）。 */
export type ColdRowPageReadFallbackReason =
  | "portAbsent"
  | "noIndexPort"
  | "noTailPort"
  | "sessionReadFailed"
  | "indexReadFailed"
  | "limitBeforeMissed"
  | "emptyPage";

export type ColdRowPageReadResult =
  | {
      kind: "page";
      plan: ColdRowPagePlan;
      /** 页内整轮的正文（message + part，别的轮一条都不读）。 */
      messages: MessageWithParts[];
      /** `baseTimestampMs` 的唯一来源：**整条**分支首条消息的 timeCreated。 */
      baseTimestampMs?: number;
    }
  | { kind: "unavailable"; reason: ColdRowPageReadFallbackReason; detail?: string };

/**
 * 按页读正文（Step 7）：`plan` 由 gateway 用 manifest 的 facts 选出，本函数只负责
 * 「全序 active 序 + 两端游标的正文读」。
 *
 * 为什么裁断在**这里**再算一遍而不是复用 hydration 的结果：裁断吃的是全序 id 序
 * （IS2），而翻页可能发生在冷开很久之后（进程内没有保存 active 序）；索引按会话缓存，
 * 这里付的是缓存命中，不是第二次 O(messages) 读。
 *
 * 页内消息必须真的落在 active 序里（`limitBeforeMissed`）：清单与索引不同步时宁可
 * 这一页不物化，也不能把已回滚分支的正文当成历史交给客户端。
 */
export async function readColdRowPageMaterialization(input: {
  sessionID: SessionId;
  store: SessionStorePort | undefined;
  reader: SessionRowManifestReader;
  plan: ColdRowPagePlan;
}): Promise<ColdRowPageReadResult> {
  const store = input.store;
  if (!store) return { kind: "unavailable", reason: "portAbsent" };
  if (!store.listSessionMessageIndex) return { kind: "unavailable", reason: "noIndexPort" };
  if (!store.readActiveBranchTail) return { kind: "unavailable", reason: "noTailPort" };

  let rewind: ActiveConversationBranchRewind;
  try {
    const session = await store.getSession(input.sessionID);
    rewind = {
      branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
      rewindCreatedMessageId: session?.revert?.createdMessageID,
      rewindKeptMessageIds: session?.revert?.keptMessageIDs,
      rewindTargetMessageId: session?.revert?.targetMessageID,
    };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: "sessionReadFailed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const indexEntries = await input.reader.readMessageIndex(input.sessionID);
  if (indexEntries === null) return { kind: "unavailable", reason: "indexReadFailed" };
  const orderedMessageIds = indexEntries.map((entry) => String(entry.id));
  const activeMessageIds = selectActiveConversationBranchIds(
    orderedMessageIds,
    rewind,
  ) as MessageId[];
  if (!activeMessageIds.includes(input.plan.limitBefore)) {
    return {
      kind: "unavailable",
      reason: "limitBeforeMissed",
      detail: String(input.plan.limitBefore),
    };
  }

  const messages = await store.readActiveBranchTail({
    sessionID: input.sessionID,
    activeMessageIds,
    limitBefore: input.plan.limitBefore,
    ...(input.plan.limitAfter === null ? {} : { limitAfter: input.plan.limitAfter }),
  });
  if (messages.length === 0) return { kind: "unavailable", reason: "emptyPage" };

  // 时间基准取**整条分支**首条消息（不是页首条）：合成器用它推导 createdAt，
  // 取页首条会让同一行在冷窗口与翻页里算出两个时间（IS1 破）。
  const baseTimestampMs = indexEntries.find(
    (entry) => String(entry.id) === activeMessageIds[0],
  )?.timeCreated;
  return {
    kind: "page",
    plan: input.plan,
    messages,
    ...(baseTimestampMs === undefined ? {} : { baseTimestampMs }),
  };
}
