// 虚拟滚动核心：v4 timeline 行高缓存 + 切会话初始落点 guard 的纯判定层
// （纯数据/纯函数，无 DOM/React 依赖，可被 node:test 直接覆盖）。
//
// 为什么需要它：@tanstack/react-virtual 自身的 measurementsCache 按 itemKey 缓存，
// 行在窗口内卸载/重挂不丢测量；但流式行高度持续增长时，virtualizer 重置
// （rows 数组重建、组件 StrictMode 重挂、error 态 ↔ timeline 切换）会把缓存清回
// estimateSize 的固定值，导致滚动条跳动与底部锚定抖动。这里以 render unit 的稳定
// key（turnId）为键做一层组件实例内持久缓存，保证「行卸载重挂保测高缓存」。
//
// 两个 sessionKey 维度（bugfix-batch-20261009 缺陷②「切会话跳顶」）：
// - B：行高缓存按 sessionKey 分区。turnId 跨会话可重复，同一行键会在不同 session
//   指向不同行；不分区就得靠切会话时全量清缓存防串号，而全量清又会让「切回旧
//   会话即命中真实高度」的收益归零（judge P1-3）。分区后两类诉求同时成立：
//   同 session 内卸载重挂命中，跨 session 天然隔离。
// - A：初始落点 guard。切会话清测高后，virtualizer 只能按 estimateSize（72px）
//   估总高；少量行的会话（2-5 unit）估计总高 < 视口，立即 scrollToBottom/restore
//   会被浏览器把 scrollTop 钳到 0，首帧渲染窗口里最旧的内容，用户看到「msg 列表
//   跳到最上方」。guard 只记录「本会话尚未定位」，等首批真实测高到达后再执行一次
//   落点。「首批真实测高」的信号由组件自有的 measuredKeys tracker
//   （SessionMeasuredKeysTracker，uix/A-1）提供——只收本 arm 周期内两写点
//   新写入的 key，不再读 virtualizer.measurementsCache 非响应式快照。
//   判定逻辑全部收敛为本文件的纯函数/状态机，便于 T-U1 直测。

/** 未测量行的兜底估计高度（与旧 ConversationTimeline 的 ROW_ESTIMATE_PX 一致）。 */
export const DEFAULT_ROW_HEIGHT_ESTIMATE_PX = 72;

/** 缓存上限：超长会话防内存膨胀；淘汰最久未写入的行（写入序 ≈ 行序，旧行先淘汰）。 */
export const MAX_ROW_HEIGHT_CACHE_ENTRIES = 4000;

type TimelineRowHeightCacheKey = string | number;

/**
 * 分区缓存键：`sessionKey \u0000 行key`。
 * 用 \u0000（不可打印分隔符）而非 ":"/"|"：sessionKey 与 turnId 都可能含常规
 * 分隔符，逐字符拼接会产生歧义（例：session "a:b"+键 "c" 撞上 session "a"+键 "b:c"）。
 */
function partitionedCacheKey(sessionKey: string, key: TimelineRowHeightCacheKey): string {
  return `${sessionKey}\u0000${String(key)}`;
}

export class TimelineRowHeightCache {
  /** 扁平单表（分区键 → 高度）。Map 迭代序 = 写入序，天然支撑跨分区全局 LRU。 */
  private readonly sizes = new Map<string, number>();

  constructor(private readonly maxEntries: number = MAX_ROW_HEIGHT_CACHE_ENTRIES) {}

  get size(): number {
    return this.sizes.size;
  }

  /** 记录一次真实测量。重复写入会刷新淘汰顺序（活跃行不被淘汰）。 */
  set(sessionKey: string, key: TimelineRowHeightCacheKey, heightPx: number): void {
    if (!Number.isFinite(heightPx) || heightPx <= 0) {
      return;
    }
    // Map 迭代序 = 插入序；先删再插把该行移到「最新」端。
    this.sizes.delete(partitionedCacheKey(sessionKey, key));
    this.sizes.set(partitionedCacheKey(sessionKey, key), heightPx);
    while (this.sizes.size > this.maxEntries) {
      const oldest = this.sizes.keys().next();
      if (oldest.done) break;
      this.sizes.delete(oldest.value);
    }
  }

  get(sessionKey: string, key: TimelineRowHeightCacheKey): number | undefined {
    return this.sizes.get(partitionedCacheKey(sessionKey, key));
  }

  /** estimateSize 入口：有测量用测量，无测量回落估计值。 */
  estimate(
    sessionKey: string,
    key: TimelineRowHeightCacheKey | undefined,
    fallbackPx: number = DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  ): number {
    if (key === undefined) return fallbackPx;
    return this.sizes.get(partitionedCacheKey(sessionKey, key)) ?? fallbackPx;
  }

  /**
   * 仅删除某个 session 分区。
   *
   * 适用场景只有「本会话内容被级重置」（rewind/logEpoch 变更等需要精确失效时）。
   * 切会话路径禁止调用它——清了当前分区，切回来照样命中不到（与全量 clear 等效），
   * 分区的切回命中收益会被抹平。
   */
  clearSession(sessionKey: string): void {
    const prefix = `${sessionKey}\u0000`;
    for (const key of this.sizes.keys()) {
      if (key.startsWith(prefix)) {
        this.sizes.delete(key);
      }
    }
  }

  /**
   * 全量重置（组件卸载/极端兜底）。
   *
   * 切会话切换 effect 不得调用：那会在切会话瞬间抹掉全部分区、命中率恒 0
   * （judge P1-3）。跨会话串号已由分区键消除，无需全量清兜底。
   */
  clear(): void {
    this.sizes.clear();
  }
}

/** 滚动记忆的最小形状（避免本模块耦合 chatSessionScrollMemory 的具体类型）。 */
interface SessionScrollMemoryLike {
  wasPinnedToBottom?: boolean;
}

/** guard 释放后应执行的落点动作。 */
export type SessionInitialAnchorAction = "stickToBottom" | "restore";

/** 一次「切换后首次落点」计划：属于哪个会话、贴底还是恢复记忆位置。 */
export interface SessionInitialAnchorPlan<
  T extends SessionScrollMemoryLike = SessionScrollMemoryLike,
> {
  /** 计划所属会话（防切会话竞态时拿旧会话计划落点）。 */
  sessionKey: string;
  action: SessionInitialAnchorAction;
  /** action === "restore" 时携带的滚动记忆；stickToBottom 时恒为 null。 */
  restoredState: T | null;
}

/**
 * 按记忆状态推导首次落点计划（对应组件原 restore() 的分支语义）：
 * - 无记忆 / 记忆为吸底 → 贴底；
 * - 离底记忆 → 恢复记忆位置。
 */
export function resolveSessionInitialAnchorPlan<T extends SessionScrollMemoryLike>(
  restoredState: T | null,
  sessionKey: string,
): SessionInitialAnchorPlan<T> {
  if (!restoredState || restoredState.wasPinnedToBottom === true) {
    return { sessionKey, action: "stickToBottom", restoredState: null };
  }
  return { sessionKey, action: "restore", restoredState };
}

/**
 * guard 释放判据：本会话第一批真实测高是否已到达。
 *
 * 信号由调用方以 measuredKeys 注入（uix/A-1 起为组件自有
 * SessionMeasuredKeysTracker 的本 arm 快照——只含本 arm 周期内两写点真实测高
 * 写入的 key；不再直读 virtualizer.measurementsCache：那是非响应式内部快照，
 * 同 commit 内的陈旧同键测量可让释放早于首个真实测高）。窗口首项做判据而不是
 * 任意项：释放越晚只是延迟一帧，释放越早则估计高度仍在、仍有被钳到 0 的跳顶
 * 风险。
 */
export function canPlaceSessionInitialAnchor(input: {
  /** guard 挂起的 sessionKey（null = 无挂起 guard）。 */
  pendingSessionKey: string | null;
  /** 当前组件 sessionKey。 */
  currentSessionKey: string;
  /** 本会话虚拟行 key（窗口内顺序，首项为判据）。 */
  // key 取 unknown：virtual-core 的 VirtualItem.key 是泛型 Key（含小端类型），
  // 判定只需要引用相等，不要求键可枚举。
  unitKeys: readonly unknown[];
  /** virtualizer.measurementsCache 中已测 key 集合。 */
  measuredKeys: ReadonlySet<unknown>;
}): boolean {
  if (input.pendingSessionKey !== input.currentSessionKey) return false;
  const firstUnitKey = input.unitKeys[0];
  // 本会话还没有任何虚拟行（rows 未到达）：无从判定首项已测，继续挂起。
  if (firstUnitKey === undefined) return false;
  return input.measuredKeys.has(firstUnitKey);
}

/** tracker 空快照：未写入的会话直接复用，避免每次分配空 Set。 */
const EMPTY_MEASURED_KEYS: ReadonlySet<unknown> = new Set();

/**
 * guard 释放信号的 measuredKeys tracker（uix/A-1，替代
 * virtualizer.measurementsCache 快照读取）。
 *
 * 只收「当前 arm 周期内」组件两写点（measureElement 与 live-tail cacheHeight）
 * 新写入的行 key——即真实发生过的 DOM 测高，与非响应式的 measurementsCache
 * 快照划清界限。
 *
 * per-arm 代际契约（cr-fix-spec r2，本类存在的主因）：arm()（切会话武装 guard）
 * 时整体清零，只保留本次 arm 之后的写入。分区（按 sessionKey 分表）只负责防
 * 「旧会话写点闭包误写入新 arm」的跨会话串键，不承担跨 arm 保留——heights
 * 缓存（TimelineRowHeightCache）是跨会话持久 LRU 且切会话刻意不清，若 tracker
 * 与缓存同源持久，A→B→A 重访会在首个 commit 用 A 分区的旧键误释放 guard
 * （跳顶回归借 tracker 复活；guard 一次性，误判=本会话永久回退跳顶形态）。
 */
export class SessionMeasuredKeysTracker {
  /** 分区表：sessionKey → 当前 arm 周期内该会话写点写入的 key 集合。 */
  private readonly partitions = new Map<string, Set<unknown>>();

  /**
   * 切会话武装 guard 时调用：清空全部分区（per-arm 代际契约）。
   * 必须与 guard.arm() 同点调用（ConversationTimeline 的 sessionKey effect）。
   */
  arm(): void {
    this.partitions.clear();
  }

  /** 写点调用：记录一次本会话真实测高到达（与 heightCacheRef.set 同处调用）。 */
  record(sessionKey: string, key: unknown): void {
    if (key === undefined) return;
    let partition = this.partitions.get(sessionKey);
    if (partition === undefined) {
      partition = new Set<unknown>();
      this.partitions.set(sessionKey, partition);
    }
    partition.add(key);
  }

  /** 释放判据：该 key 是否在本 arm 周期内由本会话写点写入过。 */
  has(sessionKey: string, key: unknown): boolean {
    if (key === undefined) return false;
    return this.partitions.get(sessionKey)?.has(key) ?? false;
  }

  /** 本会话本 arm 已测 key 快照（供 canPlaceSessionInitialAnchor 消费）。 */
  snapshot(sessionKey: string): ReadonlySet<unknown> {
    return this.partitions.get(sessionKey) ?? EMPTY_MEASURED_KEYS;
  }
}

/** 组件侧 guard 状态机接口（实现全闭包，无 React/DOM 依赖）。 */
export interface SessionInitialAnchorGuard<
  T extends SessionScrollMemoryLike = SessionScrollMemoryLike,
> {
  /** 切会话时武装 guard：只记录「本会话尚未定位」，不执行任何落点。 */
  arm(restoredState: T | null, sessionKey: string): SessionInitialAnchorPlan<T>;
  /**
   * 尝试释放：满足测高信号时返回待执行的落点计划（每次会话最多一次），
   * 否则返回 null。调用方执行落点后不得再次尝试（防重入由本状态机保证）。
   */
  tryRelease(input: {
    currentSessionKey: string;
    unitKeys: readonly unknown[];
    measuredKeys: ReadonlySet<unknown>;
  }): SessionInitialAnchorPlan<T> | null;
  /** 该会话的 guard 是否仍挂起（首次落点未执行）。 */
  isArmedFor(sessionKey: string): boolean;
  /** 该会话的首次落点是否已交给 guard 负责（armed 或已释放执行过）。 */
  tracksSession(sessionKey: string): boolean;
}

/** 创建切会话初始落点 guard（组件挂载期间单例，参考 heightCacheRef 的懒初始化模式）。 */
export function createSessionInitialAnchorGuard<
  T extends SessionScrollMemoryLike = SessionScrollMemoryLike,
>(): SessionInitialAnchorGuard<T> {
  let pending: (SessionInitialAnchorPlan<T> & { armed: boolean }) | null = null;
  return {
    arm(restoredState, sessionKey) {
      pending = { ...resolveSessionInitialAnchorPlan(restoredState, sessionKey), armed: true };
      return pending;
    },
    tryRelease(input) {
      if (!pending) return null;
      // armed 判定在前：已释放过的会话（armed=false）无论 measured 信号如何
      // 都不得再产出计划，否则「仅一次」防重入会被绕过。
      if (!pending || !pending.armed) return null;
      const releasable = canPlaceSessionInitialAnchor({
        pendingSessionKey: pending.sessionKey,
        currentSessionKey: input.currentSessionKey,
        unitKeys: input.unitKeys,
        measuredKeys: input.measuredKeys,
      });
      if (!releasable) return null;
      // 先摘 armed 再交计划：后续 tryRelease 一律 null，保证「仅执行一次」。
      pending = { ...pending, armed: false };
      return pending;
    },
    isArmedFor(sessionKey) {
      return pending?.sessionKey === sessionKey && pending.armed;
    },
    tracksSession(sessionKey) {
      return pending?.sessionKey === sessionKey;
    },
  };
}
