// renderUnits 的「多轮装配」层：把 rows 分组到各轮、裁决保留集、末位归位，并提供
// 带缓存句柄的增量重建。单轮物化（可见性切分 / workSegments / flowItems）在
// conversationTurnRenderUnitsDraft.ts。
//
// 本模块是 renderUnits 增量构建器的宿主，必须保持 `@/`-free（可测性硬 gate：
// Node/tsx 下无别名解析，被测模块传递依赖链零 `@/` 才能 `npx tsx --test`）。
import type { ConversationRow, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import {
  createDraftUnit,
  isHookInvocationRow,
  isTurnHeaderRow,
  isUserInputRow,
  materializeDraftUnit,
  normalizeRenderUnitPosition,
  resolveDraftVisibility,
  resolveTurnRunning,
  shouldKeepDraftUnit,
  type BuildConversationTurnRenderUnitsOptions,
  type ConversationTurnRenderUnit,
  type DraftTurnRenderUnit,
} from "./conversationTurnRenderUnitsDraft.js";

export type {
  AssistantWorkRow,
  ConversationTurnFlowItem,
} from "./conversationTurnFlowItems.js";
export type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "./conversationTurnWorkSegments.js";
export type {
  BuildConversationTurnRenderUnitsOptions,
  ConversationTurnRenderUnit,
} from "./conversationTurnRenderUnitsDraft.js";

/**
 * 一次通知里「本帧变更行」的定位信息，由 projection store 提供。
 *
 * `row.delta` / `row.removed` 协议上不带 turnId，必须由 store 从累加器命中的行解析后
 * 才能给出，因此这里只收 rowId→turnId 映射，不让构建器自己去猜。
 * 缺省（`undefined`）= 本帧无变更信息可依据 → 一律走全量重建，不做任何复用。
 */
export type ConversationTurnRenderUnitsMutation = ReadonlyMap<number, string>;

/** 按 rows 顺序把行归到各轮 draft（首次出现的 turnId 决定轮序）。 */
function groupConversationRowsIntoDraftTurns(rows: readonly ConversationRow[]): {
  drafts: DraftTurnRenderUnit[];
  draftByTurnId: Map<string, DraftTurnRenderUnit>;
} {
  const drafts: DraftTurnRenderUnit[] = [];
  const draftByTurnId = new Map<string, DraftTurnRenderUnit>();

  for (const row of rows) {
    let draft = draftByTurnId.get(row.turnId);
    if (!draft) {
      draft = createDraftUnit(row.turnId);
      drafts.push(draft);
      draftByTurnId.set(row.turnId, draft);
    }
    if (isTurnHeaderRow(row)) {
      draft.header = row;
      continue;
    }
    draft.orderedRows.push(row);
    if (isUserInputRow(row)) {
      draft.userInputs.push(row);
      continue;
    }
    if (isHookInvocationRow(row)) {
      draft.hookInvocations.push(row);
      continue;
    }
    draft.assistantWorkRows.push(row);
  }

  return { drafts, draftByTurnId };
}

/**
 * unit 缓存键：`turnId 字符串化 + "|" + isLastTurn + "|" + sessionPhase`。
 * turnId 作为外层 Map 键（同时也是失效集的元素），后两段作为内层键——
 * 逻辑上就是这条三段式字符串，只是把 turnId 提升成外层键以便失效集与缓存同源、
 * 且不必在清理时反向解析字符串。
 *
 * `sessionPhase` 必须入键：`resolveTurnRunning` 与 `shouldForceOpenAbnormalHistory`
 * 都读它（无 turnHeader 的冷恢复尾窗靠它裁决终态），phase 迁移即整轮语义变化。
 * `nowMs` 反而不入键——计时已由 `WorkingDurationText` 局部 tick 承担，构建器不再收该实参。
 *
 * 光把它放进键里**不够**：phase 迁移那一帧往往不带任何行 delta（只有 `state.updated`），
 * 失效集里只有末轮锚点，若此时命中「上一次处于该 phase 时」的旧条目就会拿到过期内容。
 * 因此 phase 变化一律整表作废（见 handle 的 reset 条件）——终态迁移一辈子只发生几次。
 */
function renderUnitCacheKey(
  isLastTurn: boolean,
  sessionPhase: SessionPhase | undefined,
): string {
  return `${isLastTurn ? "1" : "0"}|${sessionPhase ?? ""}`;
}

interface TurnCacheEntry {
  /** keep 判定（按 sessionPhase 分区，见 renderUnitCacheKey 的说明）。 */
  keepByPhase: Map<string, boolean>;
  /** 已物化 + 已归位的 unit 输出。 */
  unitByKey: Map<string, ConversationTurnRenderUnit>;
}

/** 单轮内层分区的上界：2（isLastTurn 取值）× 若干 sessionPhase 取值，留足余量后硬封顶。 */
export const MAX_PARTITIONS_PER_TURN = 8;

function createTurnCacheEntry(): TurnCacheEntry {
  return { keepByPhase: new Map(), unitByKey: new Map() };
}

/** Map 保持插入序：超限时先淘汰最久未用的分区，防止长期会话里 phase 抖动把缓存撑爆。 */
function setBoundedPartition<V>(partitions: Map<string, V>, key: string, value: V): void {
  partitions.set(key, value);
  while (partitions.size > MAX_PARTITIONS_PER_TURN) {
    const oldest = partitions.keys().next();
    if (oldest.done) return;
    partitions.delete(oldest.value);
  }
}

function entryFor(
  cacheByTurnId: Map<string, TurnCacheEntry>,
  turnId: string,
): TurnCacheEntry {
  let entry = cacheByTurnId.get(turnId);
  if (!entry) {
    entry = createTurnCacheEntry();
    cacheByTurnId.set(turnId, entry);
  }
  return entry;
}

function collectDirtyTurnIds(
  lastMutation: ConversationTurnRenderUnitsMutation,
  lastUnitTurnId: string | null,
): Set<string> {
  const dirty = new Set<string>();
  for (const turnId of lastMutation.values()) dirty.add(turnId);
  if (lastUnitTurnId !== null) dirty.add(lastUnitTurnId);
  return dirty;
}

/**
 * 是否跑在开发构建里（供 DEV-only 断言用）。
 *
 * 与 perfProbe 的 `isPerfProbeEnabled` 同款取法：Vite 构建里 `import.meta.env.DEV`
 * 一定是布尔值；Node 单测（tsx）下 `import.meta.env` 是 undefined，这里按 dev 处理——
 * 断言本来就只能在可测环境里被观测到，测试依赖的正是这一侧。
 */
function isDevBuild(): boolean {
  const viteDev = ((import.meta as ImportMeta & { env?: { readonly DEV?: boolean } }).env ?? {}).DEV;
  return typeof viteDev === "boolean" ? viteDev : true;
}

/**
 * 增量重建的缓存句柄（显式传入，不藏全局单例之外的隐式状态）。
 *
 * 为什么值得做：每个 delta 通知帧过去都要把整棵 rows 重跑一遍
 * `materializeDraftUnit`（每轮多次 filter + Set + workSegments 构建），
 * 长会话里这是每帧 O(N) 的主要来源，而一帧真正变化的通常只有最后几行。
 *
 * 失效集（dirtyTurns）= 本帧变更行的 turnId ∪ { 上一帧最后一个 unit 的 turnId }。
 * 后半段是必须的：新 turn 追加、或末位 turn 被 `shouldKeepDraftUnit` 过滤掉时，
 * 前一末轮的 isLastTurn 会翻转，它的末段 `assistantHistoryDefaultOpen` 必须重算。
 * 传入的 lastMutation 缺省时无失效依据，一律按全量重建处理，绝不猜。
 */
export interface ConversationTurnRenderUnitsCache {
  build(
    rows: readonly ConversationRow[],
    options?: BuildConversationTurnRenderUnitsOptions,
    lastMutation?: ConversationTurnRenderUnitsMutation,
  ): ConversationTurnRenderUnit[];
  /** 当前缓存的轮数（诊断/测试用）。 */
  size(): number;
  /**
   * 测试专用探针（cr-fix-spec full/C-2）：单轮内层分区数（keepByPhase + unitByKey
   * 条目之和），用于断言「同一 turnId 多 phase 注入后分区数 ≤ MAX_PARTITIONS_PER_TURN」。
   * 生产代码不得依赖；命名沿用 G-3 的 `__…ForTest` 惯例。
   */
  __partitionCountForTest(turnId: string): number;
}

export function createConversationTurnRenderUnitsCache(): ConversationTurnRenderUnitsCache {
  const cacheByTurnId = new Map<string, TurnCacheEntry>();
  let scopeKey: string | undefined;
  let cachedSessionPhase: SessionPhase | undefined;
  /** 上一帧最后一个保留 unit 的 turnId——isLastTurn 翻转的失效锚点。 */
  let lastUnitTurnId: string | null = null;
  let scopeMismatchWarned = false;

  /**
   * (scopeKey, sessionPhase) 同源不变量的运行时断言。
   *
   * `ConversationTimeline` 的 renderUnits 与 `SessionPane` 的 shareRenderUnits 写的是
   * 同一张表，两侧喂的值一旦不同源，后写的一方会把前一方刚写下的条目整表清掉。
   * 这类错不抛异常、不报错，只表现为「复用率莫名归零」，因此在 DEV 下留一次告警证据。
   * 只告警一次，且只在换代时缓存非空（首帧建表不算冲突）；换会话与 phase 迁移本身
   * 也是合法换代，会命中同一条告警——这是本断言的已知噪声边界。
   */
  const assertScopeInvariant = (
    nextScopeKey: string | undefined,
    nextSessionPhase: SessionPhase | undefined,
  ): void => {
    if (scopeMismatchWarned || !isDevBuild() || cacheByTurnId.size === 0) return;
    if (nextScopeKey === scopeKey && nextSessionPhase === cachedSessionPhase) return;
    scopeMismatchWarned = true;
    console.warn(
      "[v4-renderUnits] 共享缓存的 (scopeKey, sessionPhase) 与缓存内不一致：",
      "ConversationTimeline 与 SessionPane 必须喂同一组值，否则两侧会互相把对方的条目冲掉。",
      { cached: { scopeKey, sessionPhase: cachedSessionPhase }, next: { scopeKey: nextScopeKey, sessionPhase: nextSessionPhase } },
    );
  };

  return {
    build(rows, options = {}, lastMutation) {
      const nextScopeKey = options.scopeKey;
      const sessionPhase = options.sessionPhase;
      assertScopeInvariant(nextScopeKey, sessionPhase);
      if (nextScopeKey !== scopeKey || sessionPhase !== cachedSessionPhase) {
        // 换会话（turnId 撞号也拿不到别家的条目）或 phase 迁移（该 phase 下的旧条目
        // 未必描述当前内容，迁移帧又常常不带行 delta）→ 整表清空，绝不跨代复用。
        scopeKey = nextScopeKey;
        cachedSessionPhase = sessionPhase;
        cacheByTurnId.clear();
        lastUnitTurnId = null;
      }
      const { drafts, draftByTurnId } = groupConversationRowsIntoDraftTurns(rows);
      // null = 无失效依据（无可用 lastMutation），整表重算。
      const dirtyTurns =
        lastMutation === undefined
          ? null
          : collectDirtyTurnIds(lastMutation, lastUnitTurnId);
      const isDirty = (turnId: string): boolean => dirtyTurns === null || dirtyTurns.has(turnId);

      // 第一遍：keep 判定。未命中的轮才付 resolveDraftVisibility 的钱。
      const phaseKey = renderUnitCacheKey(false, sessionPhase);
      const keepFlags: boolean[] = [];
      for (const draft of drafts) {
        const cached = isDirty(draft.turnId)
          ? undefined
          : cacheByTurnId.get(draft.turnId)?.keepByPhase.get(phaseKey);
        if (cached !== undefined) {
          keepFlags.push(cached);
          continue;
        }
        const keep = shouldKeepDraftUnit(
          draft,
          resolveDraftVisibility(draft),
          resolveTurnRunning(draft, options),
        );
        keepFlags.push(keep);
        // 与 unitByKey 同样走有界写入：keepByPhase 也是按 phase 分区的缓存，
        // 裸 .set 会绕过 MAX_PARTITIONS_PER_TURN 上界，phase 抖动能把这一张表撑爆。
        setBoundedPartition(
          entryFor(cacheByTurnId, draft.turnId).keepByPhase,
          phaseKey,
          keep,
        );
      }

      // 第二遍：只物化保留的轮；命中缓存的轮直接复用上一帧的输出对象。
      const keptTotal = keepFlags.reduce((total, keep) => total + (keep ? 1 : 0), 0);
      const units: ConversationTurnRenderUnit[] = [];
      let keptIndex = 0;
      for (let index = 0; index < drafts.length; index += 1) {
        if (!keepFlags[index]) continue;
        const draft = drafts[index]!;
        const isLastTurn = keptIndex === keptTotal - 1;
        const cacheKey = renderUnitCacheKey(isLastTurn, sessionPhase);
        const cached = isDirty(draft.turnId)
          ? undefined
          : cacheByTurnId.get(draft.turnId)?.unitByKey.get(cacheKey);
        if (cached !== undefined) {
          units.push(cached);
          keptIndex += 1;
          continue;
        }
        const unit = normalizeRenderUnitPosition(
          materializeDraftUnit(draft, index, drafts.length, options),
          keptIndex,
          keptTotal,
          options,
        );
        units.push(unit);
        setBoundedPartition(entryFor(cacheByTurnId, draft.turnId).unitByKey, cacheKey, unit);
        keptIndex += 1;
      }

      // 清理已不在窗口里的轮（裁剪分支 / 换会话后残留），否则缓存无上界增长。
      // 空 rows 是「这一侧这一帧没有窗口可依据」，不是「窗口里的轮都没了」——
      // 分享侧在受闸口径下（timelineSnapshot 为 null）会喂空数组，此时清空整表等于
      // 抹掉 Timeline 侧仍持有的真实条目。只跳过清理，锚点仍归零：保留上一帧的
      // lastUnitTurnId 会让下一帧把一个当前根本不存在的末轮白标成脏轮。
      if (rows.length === 0) {
        lastUnitTurnId = null;
      } else {
        for (const turnId of cacheByTurnId.keys()) {
          if (!draftByTurnId.has(turnId)) cacheByTurnId.delete(turnId);
        }
        lastUnitTurnId = units.at(-1)?.turnId ?? null;
      }
      return units;
    },
    size() {
      return cacheByTurnId.size;
    },
    __partitionCountForTest(turnId: string) {
      const entry = cacheByTurnId.get(turnId);
      return entry ? entry.keepByPhase.size + entry.unitByKey.size : 0;
    },
  };
}

/**
 * 全量重建（缓存句柄的「全部失效」退化形态）。
 *
 * 增量与全量共用同一条实现路径，所以「增量 ≡ 全量」不是靠两套代码对齐，而是
 * 结构上就只有一份构建逻辑——T-AP4 的等价性断言钉的是这条不变量。
 */
export function buildConversationTurnRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions = {},
): ConversationTurnRenderUnit[] {
  const { drafts } = groupConversationRowsIntoDraftTurns(rows);
  const keepFlags = drafts.map((draft) =>
    shouldKeepDraftUnit(draft, resolveDraftVisibility(draft), resolveTurnRunning(draft, options)),
  );
  const keptTotal = keepFlags.reduce((total, keep) => total + (keep ? 1 : 0), 0);
  const units: ConversationTurnRenderUnit[] = [];
  let keptIndex = 0;
  for (let index = 0; index < drafts.length; index += 1) {
    if (!keepFlags[index]) continue;
    units.push(
      normalizeRenderUnitPosition(
        materializeDraftUnit(drafts[index]!, index, drafts.length, options),
        keptIndex,
        keptTotal,
        options,
      ),
    );
    keptIndex += 1;
  }
  return units;
}