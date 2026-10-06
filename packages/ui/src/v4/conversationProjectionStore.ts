/* eslint-disable max-lines -- projection/base/recovery/optimistic 必须共享一个原子 store 状态机，拆分会重新引入跨对象竞态。 */
// Per-session projection store（只读 projection store）。
// 唯一写入方是订阅推送；UI 只读。客户端遵守三条规则：
//   1. snapshot → 整体替换，绝不 merge；
//   2. delta 帧仅在区间衔接（frame.fromSeq === snapshot.seq）时 apply，断档不猜、不缓存补偿；
//   3. base 与状态同生共死——断档时状态未被污染，携当前水位重订阅，由服务端裁决 resume/snapshot。
// 除 optimistic overlay（pending 命令展示）外，本 store 不产生任何 conversation 事实。
import {
  isDeterministicContentFault,
  parseConversationTopic,
  PROTOCOL_V4_LIMITS,
  SUBSCRIPTION_CONTENT_REJECTED,
  type ConversationRow,
  type ConversationDelta,
  type ConversationSnapshot,
  type ConversationOpenTiming,
  type ConversationTopicFrame,
  type SessionModelTransition,
  type ToolCallRow,
  type TopicFrameDeliveryKind,
  type TurnDirectoryEntry,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { ConversationTurnNavigatorHydrationResult } from "@/v4/conversationTurnNavigatorHelpers.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/**
 * runtime 换代打断 subscribe 后的退避节奏。
 *
 * CUA Helper 冷启动就绪会 recycleUntilStable → disposeWorkspace 回收 agent
 * runtime，在途 subscribe 被 rejectAll 打断。若把这次瞬态失败定格成 status="error"，
 * 懒启动的 agent 在 dispose 后可能无人拉起，onRuntimeRestart 就不会到达，面板只能靠用户
 * 手点「重新连接」。subscribeConversationV4 走 start-if-needed，重订阅自身会拉起 runtime，
 * 所以这里按 sessionsIndexStore 的既定模式做有界退避。
 */
const RUNTIME_RECYCLE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/**
 * accepted ACK 后等待权威输入投影的宽限期。
 *
 * Core admission 的 ACK 不等待 TurnStarted/QueueItem/userInput 投影；正常情况下这两条
 * 路径只相差一个 renderer/network round-trip。把窗口设为 2s 可以覆盖正常 desktop/mobile
 * 延迟，又能尽快从“CLI 继续工作、订阅完全静默”的半开通道自愈。超时只恢复订阅，不重放命令。
 */
const ACCEPTED_INPUT_PROJECTION_GRACE_MS = 2_000;
const ACCEPTED_INPUT_COMMAND_TYPES = new Set(["sendText"]);

/** 退避耗尽时展示给用户的 lastError（无底层 error 对象可引用的换代路径）。 */
const RUNTIME_RECYCLED_ERROR = "ZCode agent runtime 已被回收，重连未成功";

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundedDuration(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

/**
 * 是否为 runtime 换代/回收导致的瞬态 subscribe 失败。
 *
 * 三种文案都来自同一次回收：transport 关闭时 ZCodeProtocolClient.rejectAll 打断在途请求
 * （transport closed），复用已回收 client 时 assertNotDisposed 早退（client disposed），
 * 以及 runtime 尚未重新拉起时的 fail-fast（runtime is not running）。
 */
function isRuntimeRecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // 冷订阅可能亲自拉起新 runtime；restart 令在途 ACK 失效后仍须有界重订，不能停在 error。
    message.includes("fault.subscription.runtimeRestarted") ||
    message.includes("ZCode agent transport closed") ||
    message.includes("ZCode Protocol client disposed") ||
    message.includes("ZCode Protocol client is disposed") ||
    message.includes("ZCode Agent runtime is not running")
  );
}

function hasAcceptedInputProjection(
  snapshot: ConversationSnapshot | null,
  commandId: string,
): boolean {
  if (!snapshot) return false;
  if (snapshot.queue.items.some((item) => item.sourceCommandId === commandId)) return true;
  return snapshot.rows.window.some(
    (row) =>
      row.kind === "userInput" && row.origin === "realUser" && row.sourceCommandId === commandId,
  );
}

export type ConversationStoreStatus =
  // subscribe 在途（首连或断档重订阅）。
  | "connecting"
  // 已订阅且帧连续。
  | "live"
  // subscribe 失败，等待 retry()。
  | "error"
  // 已释放（SessionDataLayer 退订后），不再接受任何操作。
  | "closed";

/** optimistic overlay 条目：命令已上行、服务端尚未在投影中确认。 */
export interface OptimisticCommand {
  commandId: string;
  type: string;
  issuedAt: number;
}

export interface ConversationStoreState {
  status: ConversationStoreStatus;
  snapshot: ConversationSnapshot | null;
  subscriptionId: string | null;
  lastError: string | null;
  /** 首次 conversation subscribe 的低频 Host/CLI timing；不进入 snapshot 事实。 */
  openTiming?: ConversationOpenTiming;
  /** Renderer 首帧 timing；与 snapshot 一起通知，避免 UI 读取到半更新的诊断状态。 */
  rendererTiming?: SessionOpenRendererTiming;
  optimisticCommands: readonly OptimisticCommand[];
  /** loadOlder 在途标记（自动预取防重入）。 */
  loadingOlder: boolean;
  /** CLI 完整有效 projection 返回的终态计划目录。 */
  sessionPlans: readonly ToolCallRow[];
  /** 只用于触发计划目录只读 query，不属于 conversation 协议事实。 */
  planDirectoryRevision: number;
  plansLoading: boolean;
  /**
   * 问题导航目录（turnNavigator）的失效代际。
   * not-enough-queries 终态过去只以 logEpoch 判定有效，但
   * "是否已有 ≥2 条可导航 query"是随增量变化的派生条件，logEpoch 表示日志代际而非
   * 内容静止。real-user query 增删（row.appended/row.upserted 命中 realUser userInput，
   * 或 row.removed 截断分支）与 snapshot 整体替换时递增此 revision，使终态失效重探测。
   *
   * **代际分工**：本 revision 只做「要不要重查目录」的 UI 闸门（含 250ms trailing 去抖）；
   * 单次目录读自身是否陈旧由服务端随读返回的 `atRevision`/`atLogEpoch` 裁决，两者不互相替代。
   */
  turnNavigatorDirectoryRevision: number;
  /**
   * turnNavigator 窄投影目录（`v4/conversation/turnDirectory` 只读查询的结果）。
   *
   * 目录与正文窗口解耦：条目**不并入** `rows.window`——为一个宽屏 rail 把完整历史
   * 常驻 renderer 正是本轮要消除的成本。条目数据源消费在 items 合并层；
   * 这里只保留窄投影与它的裁决水位。
   */
  turnDirectory: ConversationTurnDirectoryState;
  /** 目录只读查询在途（自动重查防重入 + rail hydration 态）。 */
  loadingDirectory: boolean;
  /**
   * 最近一个 delta 帧的变更定位（变更行 rowId → turnId）。
   *
   * renderUnits 增量重建据此把「每帧全量」降到 O(dirty)。任何整体替换窗口的路径
   * （snapshot 帧、loadOlder / loadAllOlder 前插补拉）都必须把它清成 undefined：
   * 那几帧的行集合是整块换的，用上一帧的变更集当失效依据会漏掉真正变过的轮。
   */
  lastMutation?: ConversationProjectionLastMutation;
}

export interface SessionOpenRendererTiming {
  rendererPrepareMs?: number;
  initialFrameTransportMs?: number;
  rendererSnapshotApplyMs?: number;
  snapshotAppliedAt?: number;
}

/**
 * turnNavigator 目录缓存态（只读 query 结果 + 裁决水位，非 conversation 协议事实）。
 *
 * 水位字段是陈旧读丢弃的依据：目录查询与订阅流并行，跨 revision/跨纪元拼接出的
 * 目录既可能漏条目（游标按全量行现算）也可能复活已被裁剪的分支。
 */
export interface ConversationTurnDirectoryState {
  /** 服务端按 queryRowId 升序返回的目录条目（客户端已按同向拼接）。 */
  entries: readonly TurnDirectoryEntry[];
  /** 服务端从全量投影行现算的 realUser query 权威总数（不受游标与 limit 影响）。 */
  realUserQueryTotal: number;
  /** 最近一次被接纳的读的服务端水位（跨 revision 拼接的裁决依据）。 */
  atRevision: number | null;
  atSeq: number | null;
  atLogEpoch: string | null;
  /** 更早方向仍有条目（本次未续拉至齐）。 */
  hasMore: boolean;
  /**
   * 提交时条目数少于服务端现算的权威总数（翻页撞到 50 页上限）。
   *
   * 截断必须显式存在：`hasMore` 只说「更早方向还有」，rail 拿它继续想上拉，
   * 用户看到的却是一条「到此为止」的完整目录。rail 据此在顶部渲染提示。
   */
  truncated: boolean;
  /** 是否成功取过一次目录（rail 隐藏判定与失效重查都以「已取过」为前提）。 */
  loaded: boolean;
}

const EMPTY_TURN_DIRECTORY_STATE: ConversationTurnDirectoryState = {
  entries: [],
  realUserQueryTotal: 0,
  atRevision: null,
  atSeq: null,
  atLogEpoch: null,
  hasMore: false,
  truncated: false,
  loaded: false,
};

/** 目录续拉页数上限（每页 turnDirectoryMaxEntries 条）；到顶即以「已取到的部分」提交。 */
const TURN_DIRECTORY_MAX_PAGES = 50;

const INITIAL_STATE: ConversationStoreState = {
  status: "connecting",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  rendererTiming: undefined,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
  turnDirectory: EMPTY_TURN_DIRECTORY_STATE,
  loadingDirectory: false,
  lastMutation: undefined,
};

const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

function shouldInvalidatePlanDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return (
      row.kind === "toolCall" &&
      row.toolName === "ExitPlanMode" &&
      TERMINAL_PLAN_STATUSES.has(row.status)
    );
  });
}

function logSubagentProjectionTransition(
  topic: string,
  previous: ConversationSnapshot | null,
  next: ConversationSnapshot,
  delivery: "snapshot" | "deltas",
): void {
  const previousIds = previous?.subagents?.running.map((item) => item.childSessionId) ?? [];
  const nextIds = next.subagents?.running.map((item) => item.childSessionId) ?? [];
  if (
    previousIds.length === nextIds.length &&
    previousIds.every((childSessionId, index) => childSessionId === nextIds[index])
  ) {
    return;
  }
  // 交互 bug 的根因位于订阅快照交接，不在 React DOM；仅在 Agent 运行集变化时
  // 记录轻量身份与水位，使本地复现能区分合法终态和迟到快照覆盖。
  logger.info("[v4-store] running subagent projection changed", {
    delivery,
    nextBackgroundWorkIds: next.backgroundWorks
      .filter((work) => work.kind === "subagent" && work.status === "running")
      .map((work) => work.childSessionId ?? work.workId),
    nextIds,
    nextSeq: next.seq,
    previousIds,
    previousSeq: previous?.seq ?? null,
    topic,
  });
}

/**
 * 还有更早历史可拉 ⇔ 窗口首行不是全序首行（firstRowId 判定）。
 * 纯函数供 store/组件共用；快照缺失/空窗口/未知 firstRowId 一律 false。
 */
export function hasOlderRows(snapshot: ConversationSnapshot | null): boolean {
  if (!snapshot) return false;
  const first = snapshot.rows.window[0];
  if (!first || snapshot.rows.firstRowId === null) return false;
  return first.rowId > snapshot.rows.firstRowId;
}

/**
 * 冷快照尾窗是否从一个 turn 的中间截断。turnHeader 是完整 turn 的权威起点；首行允许是
 * lightBoundary，因此不能只判断首行 kind，必须检查首个 turn 在当前窗口里是否已有 header。
 */
export function shouldAutoLoadIncompleteLeadingTurn(
  snapshot: ConversationSnapshot | null,
  loadingOlder: boolean,
): boolean {
  if (loadingOlder || !hasOlderRows(snapshot) || !snapshot) return false;
  const leadingTurnId = snapshot.rows.window[0]?.turnId;
  if (!leadingTurnId) return false;
  return !snapshot.rows.window.some(
    (row) => row.turnId === leadingTurnId && row.kind === "turnHeader",
  );
}

// 合并规范、accumulator 应用包装与 copy-on-notify 发布已下沉到 @/-free 的
// conversationProjectionCore（可测性前置：被测模块传递依赖链零 `@/` 导入）。
// 这里 import + re-export 保持既有外部引用不破。
import {
  accumulateTurnDirectoryPages,
  createConversationProjectionAccumulator,
  createTrailingDebouncer,
  mergeOlderRows,
  nextTurnNavigatorDirectoryRevision,
  TurnDirectoryAbortedError,
  TURN_NAVIGATOR_DIRECTORY_REQUERY_DEBOUNCE_MS,
  type ConversationProjectionAccumulator,
  type ConversationProjectionLastMutation,
  type TrailingDebouncer,
} from "@/v4/conversationProjectionCore.js";

export { mergeOlderRows };
export type { ConversationProjectionAccumulator, ConversationProjectionLastMutation };

/**
 * 外部 store（useSyncExternalStore 兼容：subscribe + getState 返回稳定引用）。
 * 生命周期由 SessionDataLayer 管（引用计数 + keep-warm），组件不直接 new。
 */
// 内存诊断计数器：统计存活 store 数与其 rows.window 行数之和，
// 用于观察窗口数据的内存增长。构造时加入、close() 时移除。
const liveProjectionStores = new Set<ConversationProjectionStore>();
uiMemoryDiagnosticsRegistry.register("projection", () => {
  let rows = 0;
  for (const store of liveProjectionStores) {
    rows += store.countProjectionRows();
  }
  return { stores: liveProjectionStores.size, rows };
});

export class ConversationProjectionStore {
  private state: ConversationStoreState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly modelTransitionListeners = new Set<
    (transition: SessionModelTransition) => void
  >();
  private observedModelTransitionEventId: string | null = null;
  // 订阅代际：并发 connect 只认最新一代，过期结果立即退订防服务端悬挂。
  private generation = 0;
  // 首次订阅尚未拿到 ACK 时，runtime available 只是当前启动流程的正常完成信号；
  // 记录在途数量，避免生命周期通知再次启动 connect，制造同 topic 的订阅替换竞态。
  private connectInFlight = 0;
  /**
   * subscribe ACK mode 持久到该代首个 logical frame；不能只依赖同步 activate 栈，
   * 因为 notification 可在 ACK Promise resolve 后异步到达。
   */
  private awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
  /** 当前 subscription 是否已由旧 applied base 或本代 logical frame 证明水位有效。 */
  private subscriptionHasAppliedBase = false;
  private recovery: {
    subscriptionId: string;
    requestInFlight: boolean;
    ackReceived: boolean;
    validFrameSeen: boolean;
    upgradePending: boolean;
    ackMode: "snapshot" | "resume" | null;
    forceSnapshot: boolean;
    postRecoveryGapPending: boolean;
    frameDeadline: ReturnType<typeof setTimeout> | null;
    /** 本次 flight 是为内容确定性失败发起的：终态用 contentRejected，不混进瞬态统计。 */
    contentFault: boolean;
  } | null = null;
  private readonly offAssemblyFault: () => void;
  private readonly offRuntimeRestart: (() => void) | null = null;
  private readonly offRuntimeLifecycle: (() => void) | null = null;
  private runtimeRecycleRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRecycleRetryAttempt = 0;
  private sessionOpenRendererTiming: SessionOpenRendererTiming = {};
  private initialSubscribeAckAt: number | null = null;
  private planQueryInFlight = false;
  private planQueryPending = false;
  /** accepted input 的 projection confirmation watchdog；不承载命令，也不生成本地事实。 */
  private readonly acceptedInputProjectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // hydrated/not-enough-queries 终态缓存。过去仅以
  // logEpoch 判定有效，同一 epoch 内追加 real-user query 后仍永久命中。现追加
  // directoryRevision——real-user query 增删会递增该 revision，使终态失效重探测。
  private turnNavigatorHydrationTerminal:
    | (Extract<
        ConversationTurnNavigatorHydrationResult,
        { status: "hydrated" | "not-enough-queries" }
      > & { directoryRevision: number })
    | null = null;
  /**
   * 目录路径（{@link loadTurnDirectory}）**自己的**终态缓存。
   *
   * 刻意不与 {@link turnNavigatorHydrationTerminal} 共用：那条缓存代表「完整历史正文
   * 已经并入窗口」，而目录终态只代表「rail 的条目取齐了」。共用会让分享模式的首轮
   * 补齐命中目录终态后直接返回，正文永远补不齐——两条路径的产物根本不是一回事。
   */
  private turnDirectoryHydrationTerminal:
    | (Extract<
        ConversationTurnNavigatorHydrationResult,
        { status: "hydrated" | "not-enough-queries" }
      > & { directoryRevision: number })
    | null = null;
  /** 目录重查去抖器（trailing 250ms）；懒建，未 hydrate 过的会话不排。 */
  private turnDirectoryDebouncer: TrailingDebouncer | null = null;
  /** 目录查询在途标记：在途期间来的重查并入下一次，不并发打 RPC。 */
  private turnDirectoryQueryInFlight = false;
  private turnDirectoryQueryPending = false;
  private closed = false;
  /**
   * delta 应用的可变累加器（copy-on-notify）。
   *
   * `state.snapshot` 永远是它发布出来的**外壳副本**，不是累加器本体：本帧之后的
   * 原地变更只落在累加器自己的 window 数组上，已发布的那一份保持定格。因此
   * setState 之后的任何读（reconcile / observeModelTransition / 子组件 memo）
   * 拿到的都是稳定的帧快照。
   */
  private accumulator: ConversationProjectionAccumulator | null = null;

  constructor(
    readonly topic: string,
    private readonly transport: ConversationTransport,
  ) {
    liveProjectionStores.add(this);
    this.offAssemblyFault = transport.onAssemblyFault((fault) => {
      if (fault.topic === this.topic) {
        this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
      }
    });
    // runtime 换代（CLI 进程换代）按 sessionsIndexStore 的约定优先走 lifecycle：dispose
    // 当场只有 unavailable 可观测，onRuntimeRestart 要等新进程 spawn——懒启动下可能永不到达。
    if (transport.onRuntimeLifecycle) {
      this.offRuntimeLifecycle = transport.onRuntimeLifecycle((state) => {
        if (state === "available") this.handleRuntimeAvailable();
        else this.handleRuntimeUnavailable();
      });
      // proxy handoff 不是 runtime 换代，只有 restart 通道携带该语义——
      // ReplaceableConversationTransport.replace() 只广播 runtimeRestartListeners，不发任何
      // lifecycle 事件。若这里因"二选一"完全放弃 restart 通道，远程 workspace 的 proxy 换代
      // 就无人接收：replace() 已 best-effort 退订旧 proxy 的订阅，store 却停在 live + 旧
      // subscriptionId，帧流静默中断且不自愈。
      // 只认 transportReplaced 即可两不重叠：底层 runtime restart 经 bindRuntimeRestartListener
      // 转发时调的是 listener()（reason 为 undefined），已由 lifecycle 的 available 接管。
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) => {
        if (reason !== "transportReplaced") return;
        this.handleRuntimeRestart(reason);
      });
    } else {
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) =>
        this.handleRuntimeRestart(reason),
      );
    }
  }

  getState(): ConversationStoreState {
    return this.state;
  }

  getSessionOpenRendererTiming(): SessionOpenRendererTiming {
    return { ...this.sessionOpenRendererTiming };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onOnlineModelTransition(listener: (transition: SessionModelTransition) => void): () => void {
    this.modelTransitionListeners.add(listener);
    return () => this.modelTransitionListeners.delete(listener);
  }

  private setState(patch: Partial<ConversationStoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * 发起/重发订阅。base 取自当前 snapshot 水位（水位不变量：仅当真持有该时刻
   * 一致状态才携带）；forceSnapshot 用于 resume 续传帧仍断档的兜底，丢 base 要全量。
   */
  async connect(
    options: {
      forceSnapshot?: boolean;
      initialOverflowRetry?: boolean;
      rendererPrepareStartedAt?: number;
    } = {},
  ): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    this.discardRecovery();
    const snapshot = options.forceSnapshot ? null : this.state.snapshot;
    const connectStartedAt = options.rendererPrepareStartedAt ?? monotonicNow();
    const subscribeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store connect started", {
      event: "v4.conversation.store.connect.started",
      generation,
      hasBase: Boolean(snapshot),
      module: "ui.v4.conversation_projection_store",
      status: "started",
      topic: this.topic,
    });
    this.sessionOpenRendererTiming = {
      rendererPrepareMs: roundedDuration(connectStartedAt, subscribeStartedAt),
    };
    this.initialSubscribeAckAt = null;
    this.connectInFlight += 1;
    this.setState({ status: "connecting", rendererTiming: this.sessionOpenRendererTiming });
    try {
      const result = await this.transport.subscribe({
        topic: this.topic,
        base: snapshot ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq } : undefined,
      });
      if (generation !== this.generation || this.closed) {
        // 过期代际：这份订阅已无人消费，立即退订。
        logger.lifecycle.warn("v4 conversation store connect ACK became stale", {
          event: "v4.conversation.store.connect.stale_ack",
          generation,
          currentGeneration: this.generation,
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId: result.ack.subscriptionId,
          topic: this.topic,
        });
        void this.transport.unsubscribe(result.ack.subscriptionId);
        return;
      }
      // 线上 fault.subscription.notOwned 卡死的根因：connect() 只在发起时
      // discardRecovery，subscribe ACK 的 await 窗口内旧订阅仍可能创建 same-sub recovery；
      // 而 host scope 在新 ACK remember() 时已按 ownershipKey 静默驱逐旧订阅，该 recovery
      // 的在途 resync 注定被 notOwned 拒绝。换代成功即丢弃旧 recovery——新订阅的 initial
      // 会原子替换整个投影，旧恢复流已无意义；否则其迟到失败会把 live 的新订阅打成 error。
      this.discardRecovery();
      this.runtimeRecycleRetryAttempt = 0;
      this.initialSubscribeAckAt = monotonicNow();
      this.setState({
        status: "live",
        subscriptionId: result.ack.subscriptionId,
        lastError: null,
        openTiming: result.ack.openTiming,
      });
      this.subscriptionHasAppliedBase = Boolean(
        snapshot && result.ack.mode === "resume" && result.ack.logEpoch === snapshot.logEpoch,
      );
      // 公共 result 已是 ACK-only；initial 与 online 统一走 notification。
      // subscriptionId 必须先入 store，activate 才能同步释放同一 read 中暂存的 own initial。
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      this.transport.activate(result.ack.subscriptionId);
      logger.lifecycle.info("v4 conversation store connect completed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        event: "v4.conversation.store.connect.completed",
        generation,
        logEpoch: result.ack.logEpoch,
        mode: result.ack.mode,
        module: "ui.v4.conversation_projection_store",
        status: "completed",
        subscriptionId: result.ack.subscriptionId,
        topic: this.topic,
      });
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        // ACK 前 physical batch 已残缺，active same-sub 尚不存在；只能 fresh
        // subscribe 强制 snapshot。最多自动一次，避免异常 peer 造成重试风暴。
        await this.connect({ forceSnapshot: true, initialOverflowRetry: true });
        return;
      }
      if (this.scheduleRuntimeRecycleRetry(error, generation)) {
        logger.lifecycle.warn("v4 conversation store connect retry scheduled", {
          durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
          errorMessage: message,
          event: "v4.conversation.store.connect.retry_scheduled",
          generation,
          module: "ui.v4.conversation_projection_store",
          status: "retrying",
          topic: this.topic,
        });
        logger.warn(`[v4-store] subscribe ${this.topic} 被 runtime 换代打断，退避重连: ${message}`);
        return;
      }
      logger.lifecycle.warn("v4 conversation store connect failed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        errorMessage: message,
        event: "v4.conversation.store.connect.failed",
        generation,
        module: "ui.v4.conversation_projection_store",
        status: "failed",
        topic: this.topic,
      });
      logger.warn(`[v4-store] subscribe ${this.topic} 失败: ${message}`);
      this.setState({ status: "error", lastError: message });
    } finally {
      this.connectInFlight -= 1;
    }
  }

  private clearRuntimeRecycleRetry(): void {
    if (this.runtimeRecycleRetryTimer === null) return;
    clearTimeout(this.runtimeRecycleRetryTimer);
    this.runtimeRecycleRetryTimer = null;
  }

  /**
   * runtime 换代导致的 subscribe 失败：保持 connecting 并有界退避重连。
   * 返回 true 表示已接管本次失败，调用方不应再落 error。
   */
  private scheduleRuntimeRecycleRetry(error: unknown, generation: number): boolean {
    if (!isRuntimeRecycleError(error)) return false;
    return this.scheduleRuntimeRecycleReconnect(generation);
  }

  /**
   * 有界退避重连。重订阅走 start-if-needed（zcodeAgentService.subscribeConversationV4），
   * 自身即可把懒启动的 runtime 拉起来——这是 available 永不到达时唯一的自愈路径。
   * 返回 true 表示已接管，调用方不应再落 error。
   */
  private scheduleRuntimeRecycleReconnect(generation: number): boolean {
    if (this.closed) return false;
    const delayMs = RUNTIME_RECYCLE_RETRY_DELAYS_MS[this.runtimeRecycleRetryAttempt];
    if (delayMs === undefined) return false;
    this.runtimeRecycleRetryAttempt += 1;
    this.clearRuntimeRecycleRetry();
    // 保留旧 snapshot：换代期间投影未被污染，重连成功会原子替换。
    this.setState({ status: "connecting" });
    this.runtimeRecycleRetryTimer = setTimeout(() => {
      this.runtimeRecycleRetryTimer = null;
      if (this.closed || generation !== this.generation) return;
      void this.connect();
    }, delayMs);
    return true;
  }

  /** workspace-dispose 当场：旧 runtime 已死，新的尚不存在，不可重订阅。 */
  private handleRuntimeUnavailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation += 1;
    // 旧 subscriptionId 属于已死 runtime，不得再 unsubscribe（host 侧 owner 已失效）。
    this.setState({ status: "connecting", subscriptionId: null });
    // 不能只 dormant 等 available：agent 懒启动，dispose 后无人拉起时该信号永不到达，
    // 面板会永久转圈。退避重连自身会拉起 runtime；available 先到则复位计数并即时重连。
    if (this.scheduleRuntimeRecycleReconnect(this.generation)) return;
    // 退避额度耗尽（runtime 反复回收）：必须落 error 暴露「重新连接」入口，
    // 否则 connecting 无 timer 就是永久转圈，连手动重试都没有。
    this.setState({ status: "error", lastError: RUNTIME_RECYCLED_ERROR });
  }

  /** 新 runtime 就绪：与 onRuntimeRestart 同义，携原水位重订阅。 */
  private handleRuntimeAvailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    if (this.connectInFlight > 0) {
      // 冷启动 spawn 会在首次 subscribe ACK
      // 返回前广播 available。若这里立即再 connect，服务端会按同一 connection/topic
      // 替换旧订阅；旧 ACK 随即被本地代际防护退订，首帧交接存在竞态，面板可能永久无快照。
      // 当前在途 connect 已经负责完成这次启动，不需要重复重订阅。
      return;
    }
    this.handleRuntimeRestart("runtimeRestart");
  }

  /** 订阅失败后的手动重试入口（pane 层「重新连接」按钮落点）。 */
  retry(): Promise<void> {
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    return this.connect();
  }

  /** row command/query 的 epoch/entity authority 失效，复用 same-sub recovery 收敛。 */
  recoverFromStaleAuthority(): void {
    this.requestRecovery();
  }

  /** SessionDataLayer 帧路由入口。 */
  handleFrame(
    frame: ConversationTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // 代际防护：旧订阅的迟到帧直接丢弃。
    if (frame.subscriptionId !== this.state.subscriptionId) return;
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    const frameReceivedAt = monotonicNow();
    // RPC 时序无法证明帧用途。只有 publisher 标记的 initial 才消费
    // awaitingInitial；recovery 必须优先清除此状态，避免 recovery gap 被误判为
    // original subscribe gap 而换新 subId。迟到 online duplicate 不得消费任何闸门。
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      // online overflow snapshot 本身是完整权威状态，可建立 applied base；但它不冒充
      // recovery delivery，flight 仍等待自己的 recovery frame/ACK 收口。
      this.applyFrame(frame, { subscribeMode: null, recovery: false, online: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      // recovery reservation 之后的 online 可能与 ACK 同 read 到达；在 recovery
      // logical frame 已 apply 后看到非重复 online，ACK 收口时必须再开 successor flight。
      if (frame.toSeq > (this.state.snapshot?.seq ?? 0)) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      // ACK(snapshot) 不构成 applied base；initial 丢失后即便数值 fromSeq 恰好
      // 对上旧 projection，也不能把新 epoch delta 拼到旧状态。
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.applyFrame(frame, {
      subscribeMode: initial?.mode ?? null,
      recovery: deliveryKind === "recovery",
      online: deliveryKind === "online",
      frameReceivedAt,
    });
  }

  /**
   * 统一 rebuild 入口：凡是把 rows.window 整体换掉（新 snapshot、mergeOlderRows
   * 前插补拉）的路径都必须过这里。返回重建好的累加器，**发布给订阅者的必须是它的
   * `publish()` 外壳副本，不是它本身**。
   *
   * 为什么漏一次就是静默内容错乱：累加器内部用 rowId → 下标 的索引命中行，
   * mergeOlderRows 换了数组之后旧索引全部错位，后续 row.delta 会把流式文本
   * 追加到别的行上——不报错、不掉帧，只是内容慢慢错位。
   */
  private rebuildAccumulator(
    nextSnapshot: ConversationSnapshot,
  ): ConversationProjectionAccumulator {
    this.accumulator = createConversationProjectionAccumulator(nextSnapshot);
    return this.accumulator;
  }

  /**
   * delta 帧的应用入口：走可变累加器，返回通知用的外壳副本与本帧变更定位。
   *
   * 正常路径下这里必定已有累加器——delta 帧要先过 handleFrame 的
   * subscriptionHasAppliedBase 闸门，而该标志只由已 apply 过的帧置位。缺失只可能是
   * 累加器被丢掉（close 之后不再收帧）；真到了就从当前外壳重建再施加，绝不吞掉本帧。
   * 重建出来的累加器没有 lastMutation，返回 null 即「本帧无失效依据」，
   * 下游 renderUnits 会退化为全量重建——宁可慢，不可错。
   */
  private applyFrameDeltas(
    current: ConversationSnapshot,
    deltas: readonly ConversationDelta[],
    toSeq: number,
  ): {
    snapshot: ConversationSnapshot;
    lastMutation: ConversationProjectionLastMutation | null;
  } {
    const accumulator = this.accumulator ?? this.rebuildAccumulator(current);
    const snapshot = accumulator.applyDeltas(deltas, toSeq);
    return { snapshot, lastMutation: accumulator.lastMutation() };
  }

  private applyFrame(
    frame: ConversationTopicFrame,
    context: {
      subscribeMode: "snapshot" | "resume" | null;
      recovery: boolean;
      online: boolean;
      frameReceivedAt?: number;
    },
  ): void {
    if (frame.payload.kind === "snapshot") {
      const hadAppliedBase = this.subscriptionHasAppliedBase;
      // 规则 1：整体替换，扔掉手里的一切换新的。整体替换后行下标全变，
      // 必须走 rebuildAccumulator，否则后续 row.delta 会按旧索引写错行。
      // 转换日志只打 publish 之后这一次：那才是真正发布给订阅者的外壳副本，
      // 打 rebuild 入参等于把同一帧记两遍，且记的是没人看见的中间态。
      const next = this.rebuildAccumulator(frame.payload.snapshot).publish();
      logSubagentProjectionTransition(this.topic, this.state.snapshot, next, "snapshot");
      this.setState({
        snapshot: next,
        // 窗口整块换掉，上一帧的变更集不再描述这批行；清空让 renderUnits 走全量重建。
        lastMutation: undefined,
        planDirectoryRevision: this.state.planDirectoryRevision + 1,
        // snapshot 整体替换后 real-user query 集合可能已变，终态缓存必须失效。
        turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
      });
      this.scheduleTurnDirectoryRequery();
      this.subscriptionHasAppliedBase = true;
      // 以下三步一律读发布后的外壳副本 next，绝不读累加器本体：
      // 本体是活的，下一帧的原地变更会改掉它此刻读到的一切。
      this.reconcileOptimistic(next);
      this.reconcileAcceptedInputProjection(next);
      // initial 丢失时，publisher 允许完整 online snapshot 建立首个
      // applied base；其中的持久 transition 可能早于本次订阅，不能冒充实时新事件。
      // 首帧只播种观察基线，后续 online 跃迁才通知 pane。
      this.observeModelTransition(next, context.online && hadAppliedBase);
      if (context.subscribeMode !== null && context.frameReceivedAt !== undefined) {
        const snapshotAppliedAt = monotonicNow();
        this.sessionOpenRendererTiming = {
          ...this.sessionOpenRendererTiming,
          ...(this.initialSubscribeAckAt === null
            ? {}
            : {
                initialFrameTransportMs: roundedDuration(
                  this.initialSubscribeAckAt,
                  context.frameReceivedAt,
                ),
              }),
          rendererSnapshotApplyMs: roundedDuration(context.frameReceivedAt, snapshotAppliedAt),
          snapshotAppliedAt,
        };
        this.setState({ rendererTiming: this.sessionOpenRendererTiming });
      }
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    const current = this.state.snapshot;
    // 规则 2a：迟到/重复 logical frame 永远静默丢弃。若它是 ACK 后的 aligned
    // recovery `(N,N]`，则只收口 flight，不重复 apply。
    if (current && frame.toSeq <= current.seq) {
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    if (!current || frame.fromSeq !== current.seq) {
      // 规则 2：断档不猜。状态本身仍是 seq=current.seq 时刻的一致投影（这帧没碰它），
      // 所以 base 仍合法——重订阅让服务端裁决续传或全量；若断档发生在 subscribe 的
      // resume 续传帧上（服务端已裁决过一次仍不衔接），丢 base 强制 snapshot 防循环。
      logger.warn(
        `[v4-store] ${this.topic} 帧断档 fromSeq=${frame.fromSeq} local=${current?.seq ?? "none"}，重订阅`,
      );
      if (context.subscribeMode !== null) {
        // fresh subscribe 的 resume initial 仍断档，换代订阅强制 snapshot；active
        // subscription 的 online/recovery gap 则保持 same-sub。
        void this.connect({ forceSnapshot: true });
      } else {
        this.requestRecovery(context.recovery);
      }
      return;
    }
    // 规则 3a：delta 帧走可变累加器，通知边界换三层引用。
    // current 是上一帧发布的外壳副本（不是累加器本体），因此可以直接当 previous 传给
    // subagent 观察日志：它定格在上一帧，不会被本帧的原地变更改写。
    const { snapshot: next, lastMutation } = this.applyFrameDeltas(
      current,
      frame.payload.deltas,
      frame.toSeq,
    );
    logSubagentProjectionTransition(this.topic, current, next, "deltas");
    const removedFromRowId = frame.payload.deltas.reduce<number | null>(
      (earliest, delta) =>
        delta.op === "row.removed"
          ? Math.min(earliest ?? delta.fromRowId, delta.fromRowId)
          : earliest,
      null,
    );
    // real-user query 增删（row.appended/row.upserted 命中 realUser userInput，
    // 或 row.removed 截断分支）递增导航目录 revision，使终态缓存失效允许重新探测。
    const previousDirectoryRevision = this.state.turnNavigatorDirectoryRevision;
    const nextDirectoryRevision = nextTurnNavigatorDirectoryRevision(
      previousDirectoryRevision,
      frame,
    );
    // 空变更集（纯 state.updated 水位推进）复用上一帧的 lastMutation 对象：空集是任意
    // 脏集的子集，下游只按 turnId 集合做失效裁决，消费结果逐条等价，却省掉一次
    // `[lastMutation]` 依赖的失效。上一帧压根没有对象（刚 rebuild / 整块换窗）时才沿用
    // 本帧空集——那几帧的语义是「无失效依据，走全量重建」，不能被复用改写成增量。
    const publishedLastMutation =
      lastMutation === null
        ? undefined
        : lastMutation.turnIdByRowId.size === 0
          ? (this.state.lastMutation ?? lastMutation)
          : lastMutation;
    this.setState({
      snapshot: next,
      // 累加器刚重建过就没有 lastMutation：这一帧无失效依据，下游退化为全量重建。
      lastMutation: publishedLastMutation,
      // row.removed 已给出权威裁剪边界，可以同步删掉缓存目录中的旧分支计划；
      // 完整 query 继续负责补回 wire tail 之外、但仍属于当前分支的早期计划。
      ...(removedFromRowId === null
        ? {}
        : {
            sessionPlans: this.state.sessionPlans.filter((row) => row.rowId < removedFromRowId),
          }),
      ...(shouldInvalidatePlanDirectory(frame)
        ? { planDirectoryRevision: this.state.planDirectoryRevision + 1 }
        : {}),
      ...(nextDirectoryRevision === previousDirectoryRevision
        ? {}
        : { turnNavigatorDirectoryRevision: nextDirectoryRevision }),
    });
    // 目录失效代际变了 → 250ms trailing 合并重查（代际是 UI 闸门，不替代读自身的
    // atRevision 陈旧读丢弃）。setState 同步换过 this.state，必须与旧值比。
    if (nextDirectoryRevision !== previousDirectoryRevision) {
      this.scheduleTurnDirectoryRequery();
    }
    this.subscriptionHasAppliedBase = true;
    // 与 snapshot 分支同款禁令：只读发布后的外壳副本 next。读累加器本体等于读一个
    // 「已发布但仍在变」的对象——reconcile 的判定结果会随下一帧的流式追加漂移。
    this.reconcileOptimistic(next);
    this.reconcileAcceptedInputProjection(next);
    this.observeModelTransition(next, context.online);
    if (context.recovery) this.markRecoveryFrameSeen();
  }

  private observeModelTransition(snapshot: ConversationSnapshot, online: boolean): void {
    const transition = snapshot.modelTransition;
    const eventId = transition?.eventId ?? null;
    if (eventId === this.observedModelTransitionEventId) return;
    // 持久 transition 会随 initial/recovery snapshot 重放；若只在 toast 时记 ID，
    // 后续普通 online snapshot 会把旧 fallback 误当新事件。所有合法帧都更新观察基线，
    // 只有首次实时 online 跃迁才通知当前客户端。
    this.observedModelTransitionEventId = eventId;
    if (!online || !transition) return;
    for (const listener of this.modelTransitionListeners) listener(transition);
  }

  /** physical assembly fault：旧 projection 保持可见，active sub 上 single-flight 恢复。 */
  handleAssemblyFault(
    subscriptionId: string,
    deliveryKind?: TopicFrameDeliveryKind,
    reasonCode?: string,
  ): void {
    if (this.closed || subscriptionId !== this.state.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // 内容确定性失败不进瞬态阶梯（04-sync 封闭规则 11）：resume 只会把同一批 delta 再投一遍，
    // 必然再被拒；deliveryKind 也不改变结论——本端读不懂这份内容。唯一可能产出不同字节的是
    // 强制 snapshot，所以直接跳到它，它再被内容拒绝就停手，不把订阅烧在必然失败的重试上。
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    // 缺失/伪 deliveryKind 会以 undefined typed fault 到达；若 recovery 已在途，
    // 必须 fail closed/升级，不能把坏 recovery 当普通 burst 后永远等待。
    const recoveryFault =
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null);
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(recoveryFault);
  }

  private requestRecovery(recoveryEvent = false, options: { contentFault?: boolean } = {}): void {
    if (this.closed) return;
    const subscriptionId = this.state.subscriptionId;
    if (!subscriptionId) {
      void this.connect({ forceSnapshot: true });
      return;
    }
    const contentFault = options.contentFault === true;
    const existing = this.recovery;
    if (existing) {
      // 一旦本次 flight 里出现过内容失败，终态就归内容失败：后续瞬态 fault 不该把它洗白。
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      // recovery logical/fault 可早于 ACK Promise continuation；记住升级意图，
      // ACK=resume 后立即 force snapshot。普通 burst gap 不设置此标记。
      if (existing.requestInFlight || !existing.ackReceived) {
        existing.upgradePending = true;
        return;
      }
      if (existing.ackMode === "resume") this.issueRecovery(existing, true);
      else this.failRecovery("fault.subscription.recoveryFailed");
      return;
    }
    const recovery = {
      subscriptionId,
      requestInFlight: false,
      ackReceived: false,
      validFrameSeen: false,
      upgradePending: false,
      ackMode: null,
      forceSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
      contentFault,
    };
    this.recovery = recovery;
    // 内容失败跳过 resume 档直接强制 snapshot；瞬态失败仍按原阶梯先试 resume。
    this.issueRecovery(recovery, contentFault);
  }

  private issueRecovery(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
    forceSnapshot: boolean,
  ): void {
    this.clearRecoveryDeadline(recovery);
    const snapshot = this.state.snapshot;
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.upgradePending = false;
    recovery.validFrameSeen = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void this.transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          this.subscriptionHasAppliedBase && snapshot
            ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq }
            : null,
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (this.closed || this.recovery !== recovery) return;
        if (result.ack.subscriptionId !== recovery.subscriptionId) {
          throw new Error("fault.subscription.resyncGenerationMismatch");
        }
        recovery.requestInFlight = false;
        recovery.ackReceived = true;
        recovery.ackMode = result.ack.mode;
        this.settleRecovery(recovery);
      })
      .catch((error) => {
        if (this.closed || this.recovery !== recovery) return;
        this.clearRecoveryDeadline(recovery);
        this.recovery = null;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[v4-store] resync ${this.topic} 失败: ${message}`);
        if (message.includes("fault.subscription.notOwned")) {
          // 线上事件：notOwned 表示某一层已不认这份 subscription
          // ownership（scope 换代静默驱逐、错位 unsubscribe 等状态分歧），是确定性失效
          // 而非瞬态故障；停在 error 等手动重连会让会话永久卡死。本地 snapshot 仍是一致
          // 投影，携当前水位 fresh subscribe 由服务端裁决 resume/snapshot（04-sync 规则 3），
          // 完成自愈。仅对 notOwned 特判，避免瞬态错误引发重连风暴。
          void this.connect();
          return;
        }
        this.setState({ status: "error", lastError: message });
      });
  }

  private markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  private settleRecovery(recovery: NonNullable<ConversationProjectionStore["recovery"]>): void {
    if (this.recovery !== recovery || !recovery.ackReceived || recovery.requestInFlight) return;
    if (recovery.upgradePending) {
      this.clearRecoveryDeadline(recovery);
      if (!recovery.forceSnapshot && recovery.ackMode === "resume") {
        this.issueRecovery(recovery, true);
      } else {
        this.failRecovery("fault.subscription.recoveryFailed");
      }
      return;
    }
    if (recovery.validFrameSeen) {
      this.clearRecoveryDeadline(recovery);
      if (recovery.postRecoveryGapPending) {
        this.issueRecovery(recovery, false);
      } else {
        this.recovery = null;
      }
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (this.closed || this.recovery !== recovery || recovery.validFrameSeen) return;
      if (!recovery.forceSnapshot) this.issueRecovery(recovery, true);
      else
        this.failRecovery("fault.subscription.recoveryFrameTimedOut", { contentEligible: false });
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
  }

  private clearRecoveryDeadline(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
  ): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  private discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  /**
   * `contentEligible: false` 给**超时**终态用：deadline 没等到 recovery 帧是传输症状，即使本次
   * flight 起因是内容失败，也不该被重标成 contentRejected——那会连带取消一次仍然有意义的重试。
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    if (!this.recovery) return;
    // 内容确定性失败与传输失败必须可区分：前者重连不会变好，遥测按 code 聚合时也不该把一次
    // 版本失配读成网络抖动（reasonCode 词表见 wire-fault.ts）。
    const contentFault = this.recovery.contentFault && options.contentEligible !== false;
    const code = contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode;
    this.discardRecovery();
    logger.warn(`[v4-store] ${this.topic} recovery fail-closed: ${code}`);
    this.setState({ status: "error", lastError: code });
  }

  private handleRuntimeRestart(reason?: "runtimeRestart" | "transportReplaced"): void {
    if (this.closed) return;
    // transport 已先失效旧 ownership/assembler；旧 transport/runtime subId 不得再 unsubscribe，
    // 直接 fresh subscribe，保留旧 snapshot 直到新 snapshot 原子替换。
    this.generation += 1;
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.setState({ status: "connecting", subscriptionId: null });
    // proxy handoff 不等于 CLI runtime 重启；强制 snapshot 会把用户已加载的
    // older rows 替换回 tail window。handoff 保留一致 projection 水位，由服务端按
    // logEpoch/seq 裁决 resume 或 snapshot；真实 runtime restart 仍保持 full subscribe。
    if (reason === "transportReplaced") void this.connect();
    else void this.connect({ forceSnapshot: true });
  }

  /**
   * loadOlder：以窗口首行为游标向上拉一窗历史行并前插。
   * - 单飞：在途期间重复调用 no-op（loadingOlder 防重入）；
   * - 陈旧读防护：atLogEpoch ≠ 当前快照 epoch 的结果整体丢弃（跨 CLI 重启）；
   * - 合并以 rowId 为键：与订阅流的 row.upserted/removed 天然一致，
   *   在途期间到达的 delta 帧不受影响（它们只动 ≥ 窗口首行的行）。
   */
  async loadOlder(limit: number = PROTOCOL_V4_LIMITS.snapshotTailWindowRows): Promise<void> {
    if (this.closed || this.state.loadingOlder) return;
    const snapshot = this.state.snapshot;
    if (!hasOlderRows(snapshot) || !snapshot) return;
    const sessionId = parseConversationTopic(this.topic);
    if (!sessionId) return;
    const beforeRowId = snapshot.rows.window[0]?.rowId;
    if (beforeRowId === undefined) return;
    this.setState({ loadingOlder: true });
    try {
      const result = await this.transport.rowsRange({
        sessionId,
        beforeRowId,
        limit,
      });
      if (this.closed) return;
      const current = this.state.snapshot;
      if (!current || result.atLogEpoch !== current.logEpoch) {
        logger.warn(
          `[v4-store] ${this.topic} rows/range 纪元不匹配（${result.atLogEpoch}），整体丢弃`,
        );
        return;
      }
      // 在途期间游标失效（row.removed 截断 / snapshot resync 整体替换）→ 结果作废，
      // 防止把权威侧已移除的历史行复活；下次触发按新窗口重新拉。
      if (current.rows.window[0]?.rowId !== beforeRowId) return;
      const window = mergeOlderRows(current.rows.window, result.rows);
      if (window === null) return;
      // window 换了数组 → 行下标全变，必须 rebuild 重建 rowId 索引。
      this.setState({
        snapshot: this.rebuildAccumulator({
          ...current,
          rows: { ...current.rows, window },
        }).publish(),
        // 前插补拉是整块窗口变化，上一帧变更集不描述新增的更早行。
        lastMutation: undefined,
      });
    } catch (error) {
      // query 只读且可重发：失败不进 error 态，留给下次触发重试。
      logger.warn(
        `[v4-store] rowsRange ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (!this.closed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * 完整问题目录：沿既有 rows/range 游标把当前有效分支一次补齐。
   *
   * 问题导航过去直接扫描 renderer 的 tail window，因此 1000 轮会话只显示
   * 已加载的几十轮。这里按协议上限分页读取，但等全部页成功后只换一次 snapshot，
   * 避免每 200 行重建一次 timeline render units 与两个 virtualizer。
   */
  async loadAllOlder(): Promise<ConversationTurnNavigatorHydrationResult> {
    const stale = (logEpoch = this.state.snapshot?.logEpoch ?? "unknown") => ({
      status: "stale" as const,
      logEpoch,
    });
    if (this.closed || this.state.loadingOlder) return stale();
    const snapshot = this.state.snapshot;
    if (!snapshot) return stale();
    // 终态必须同时匹配 logEpoch 与 directoryRevision。logEpoch 表示日志代际，
    // 不表示内容静止——real-user query 增删会递增 revision 使终态失效，允许重新探测。
    const directoryRevision = this.state.turnNavigatorDirectoryRevision;
    if (
      this.turnNavigatorHydrationTerminal?.logEpoch === snapshot.logEpoch &&
      this.turnNavigatorHydrationTerminal.directoryRevision === directoryRevision
    ) {
      return this.turnNavigatorHydrationTerminal;
    }
    if (!hasOlderRows(snapshot)) return stale(snapshot.logEpoch);
    const sessionId = parseConversationTopic(this.topic);
    const initialBeforeRowId = snapshot.rows.window[0]?.rowId;
    if (!sessionId || initialBeforeRowId === undefined) return stale(snapshot.logEpoch);

    const initialLogEpoch = snapshot.logEpoch;
    const preserveIncompleteLeadingTurn = shouldAutoLoadIncompleteLeadingTurn(snapshot, false);
    const pages: ConversationRow[][] = [];
    let beforeRowId = initialBeforeRowId;
    let committed = false;
    this.setState({ loadingOlder: true });
    logger.debug("[v4-store] 完整问题目录开始补拉历史 rows", {
      beforeRowId,
      loadedRows: snapshot.rows.window.length,
      sessionId,
      totalRows: snapshot.rows.totalCount,
    });

    try {
      while (true) {
        const result = await this.transport.rowsRange({
          sessionId,
          beforeRowId,
          limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
        });
        if (this.closed) return stale(initialLogEpoch);
        const current = this.state.snapshot;
        if (
          !current ||
          result.atLogEpoch !== initialLogEpoch ||
          current.logEpoch !== initialLogEpoch ||
          current.rows.window[0]?.rowId !== initialBeforeRowId
        ) {
          logger.warn("[v4-store] 完整问题目录补拉期间投影游标失效，整批丢弃", {
            currentBeforeRowId: current?.rows.window[0]?.rowId,
            expectedBeforeRowId: initialBeforeRowId,
            resultLogEpoch: result.atLogEpoch,
            sessionId,
          });
          return stale(initialLogEpoch);
        }

        const older = result.rows.filter((row) => row.rowId < beforeRowId);
        const nextBeforeRowId = older[0]?.rowId;
        if (nextBeforeRowId === undefined || nextBeforeRowId >= beforeRowId) {
          logger.warn("[v4-store] 完整问题目录 rows/range 未推进游标，停止补拉", {
            beforeRowId,
            hasMore: result.hasMore,
            sessionId,
          });
          return { status: "retryable-failure", logEpoch: initialLogEpoch };
        }
        pages.push(older);
        beforeRowId = nextBeforeRowId;
        if (!result.hasMore) break;
      }

      const current = this.state.snapshot;
      if (
        !current ||
        current.logEpoch !== initialLogEpoch ||
        current.rows.window[0]?.rowId !== initialBeforeRowId
      ) {
        return stale(initialLogEpoch);
      }
      const olderRows = [...pages].reverse().flat();
      const realUserQueryCount = [...olderRows, ...current.rows.window].reduce(
        (count, row) => (row.kind === "userInput" && row.origin === "realUser" ? count + 1 : count),
        0,
      );
      if (realUserQueryCount < 2) {
        if (preserveIncompleteLeadingTurn) {
          const window = mergeOlderRows(current.rows.window, olderRows);
          if (window === null) return stale(initialLogEpoch);
          committed = true;
          this.setState({
            loadingOlder: false,
            snapshot: this.rebuildAccumulator({
              ...current,
              rows: { ...current.rows, window },
            }).publish(),
            lastMutation: undefined,
          });
          // navigator 已经拿到补齐首轮所需的权威 rows，必须在隐藏 rail 前先提交它们。
          logger.debug("[v4-store] 完整问题目录不足两条 query，保留首轮补齐 rows", {
            loadedRows: window.length,
            pages: pages.length,
            sessionId,
          });
        }
        // wire snapshot 只保留最后 60 rows，tail 中的 0/1 条 query 不能证明
        // 完整分支也是单 query。宽屏必须探测到分支起点；确认不足两条后不合并探测页，
        // 避免为一个不会显示的 rail 把完整历史常驻 renderer projection。
        logger.debug("[v4-store] 完整问题目录探测后不足两条 query", {
          pages: pages.length,
          preservedIncompleteLeadingTurn: preserveIncompleteLeadingTurn,
          realUserQueryCount,
          sessionId,
        });
        const result = {
          status: "not-enough-queries" as const,
          logEpoch: initialLogEpoch,
          directoryRevision,
        };
        this.turnNavigatorHydrationTerminal = result;
        return result;
      }
      const window = mergeOlderRows(current.rows.window, olderRows);
      if (window === null) return stale(initialLogEpoch);
      committed = true;
      this.setState({
        loadingOlder: false,
        snapshot: this.rebuildAccumulator({
          ...current,
          rows: { ...current.rows, window },
        }).publish(),
        lastMutation: undefined,
      });
      logger.debug("[v4-store] 完整问题目录历史 rows 补拉完成", {
        loadedRows: window.length,
        pages: pages.length,
        sessionId,
      });
      const result = {
        status: "hydrated" as const,
        logEpoch: initialLogEpoch,
        directoryRevision,
      };
      this.turnNavigatorHydrationTerminal = result;
      return result;
    } catch (error) {
      logger.warn(
        `[v4-store] 完整问题目录 rowsRange ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: "retryable-failure", logEpoch: initialLogEpoch };
    } finally {
      if (!this.closed && !committed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * turnNavigator 窄投影目录查询（宽屏 rail 的数据源，与正文补齐路径解耦）。
   *
   * 与 {@link loadAllOlder} 的分工：那条路把历史**行**并进 `rows.window`，服务正文与
   * 分享模式的全量语义；这条路只取目录**条目**，代价是 O(总行数) 的一次现算，
   * 换来「为一个 rail 不把完整历史常驻 renderer」。
   *
   * 三条硬纪律：
   * - 陈旧读丢弃：`atLogEpoch` 与当前快照纪元不符 → 整批弃；翻页期间 `atRevision`
   *   漂移 → 整批弃（游标语义按全量行现算，跨 revision 拼接必漏条目）；
   * - `realUserQueryTotal < 2` 首屏即终态：服务端现算的权威总数替代旧路径
   *   「翻页探测后 reduce」，`not-enough-queries` 不再需要探测页；
   * - 不并入窗口：目录条目与 `rows.window` 互不影响，正文路径的既有行为不变。
   */
  async loadTurnDirectory(): Promise<ConversationTurnNavigatorHydrationResult> {
    const stale = (logEpoch = this.state.snapshot?.logEpoch ?? "unknown") => ({
      status: "stale" as const,
      logEpoch,
    });
    if (this.closed) return stale();
    if (this.turnDirectoryQueryInFlight) {
      // 单飞：在途期间来的重查并入 finally 的一次补跑，不并发打第二条只读查询。
      this.turnDirectoryQueryPending = true;
      return stale();
    }
    const snapshot = this.state.snapshot;
    if (!snapshot) return stale();
    // 目录终态与 (logEpoch, directoryRevision) 一起缓存：同一代际内不重复查，
    // real-user query 增删（revision 自增）后自动失效重查。
    const directoryRevision = this.state.turnNavigatorDirectoryRevision;
    if (
      this.turnDirectoryHydrationTerminal?.logEpoch === snapshot.logEpoch &&
      this.turnDirectoryHydrationTerminal.directoryRevision === directoryRevision
    ) {
      return this.turnDirectoryHydrationTerminal;
    }
    const sessionId = parseConversationTopic(this.topic);
    if (!sessionId) return stale(snapshot.logEpoch);

    const logEpoch = snapshot.logEpoch;
    this.turnDirectoryQueryInFlight = true;
    this.setState({ loadingDirectory: true });
    try {
      // 分页循环的纯逻辑已下沉 core（纪元弃 / 跨页 revision pin / 游标未推进 guard /
      // 50 页上限都在那里可测）；本层只留 closed 判定、setState 与终态写入。
      // closed 由 fetchPage 就地抛哨兵——翻页途中 store 被 close 时必须立刻停，
      // 那不是一次查询失败，不能走清空目录态的分支。
      const accumulated = await accumulateTurnDirectoryPages({
        fetchPage: async (cursor, limit) => {
          if (this.closed) throw new TurnDirectoryAbortedError();
          return this.transport.turnDirectory({
            sessionId,
            limit,
            ...(cursor === undefined ? {} : { beforeQueryRowId: cursor }),
          });
        },
        expectedLogEpoch: logEpoch,
        limit: PROTOCOL_V4_LIMITS.turnDirectoryMaxEntries,
        maxPages: TURN_DIRECTORY_MAX_PAGES,
        readCurrentLogEpoch: () => this.state.snapshot?.logEpoch,
        sessionId,
      });
      const { entries, pages, pinnedRevision, realUserQueryTotal, stopReason } = accumulated;
      if (stopReason === "aborted") return stale(logEpoch);
      if (stopReason === "epoch-mismatch") {
        logger.warn("[v4-store] turn 目录纪元不匹配，整批丢弃", {
          currentLogEpoch: this.state.snapshot?.logEpoch,
          sessionId,
        });
        return stale(logEpoch);
      }
      if (stopReason === "revision-mismatch") {
        logger.warn("[v4-store] turn 目录翻页跨 revision，整批丢弃", {
          sessionId,
        });
        return stale(logEpoch);
      }
      if (stopReason === "cursor-stalled" || stopReason === "fetch-failed") {
        // 失败即清空目录态。旧目录配已前进的 revision 就是「旧目录 + 新 revision」：
        // 流式期的 assistantText 帧不触发目录失效，rail 会无限期停在陈旧条目上。
        // 清空后 loaded=false → rail 隐藏；组件 effect 的退避阶梯（250/1000ms×2）
        // 重试 3 次，耗尽后 attempt=terminal 挡住重查——目录在 revision 下次变化前
        // 保持隐藏，这是本方案已知的取舍（详见 cr-fix-spec full/B-2）。
        logger.warn(
          stopReason === "cursor-stalled"
            ? "[v4-store] turn 目录游标未推进，停止翻页并清空目录态"
            : `[v4-store] turnDirectory ${this.topic} 失败并清空目录态: ${accumulated.failure instanceof Error ? accumulated.failure.message : String(accumulated.failure)}`,
          { sessionId },
        );
        this.clearTurnDirectory();
        return { status: "retryable-failure", logEpoch };
      }
      // 权威总数不足两条 → 首屏即终态，不再翻页探测（旧路径靠 reduce 才有这个结论）。
      if (stopReason === "not-enough-queries") {
        this.setState({
          turnDirectory: {
            ...EMPTY_TURN_DIRECTORY_STATE,
            atRevision: pinnedRevision,
            atSeq: accumulated.atSeq,
            atLogEpoch: logEpoch,
            loaded: true,
            realUserQueryTotal,
            truncated: false,
          },
        });
        logger.debug("[v4-store] turn 目录不足两条 query，跳过翻页", {
          pages,
          realUserQueryTotal,
          sessionId,
        });
        const terminal = {
          status: "not-enough-queries" as const,
          logEpoch,
          directoryRevision,
        };
        this.turnDirectoryHydrationTerminal = terminal;
        return terminal;
      }
      // 翻到页数上限：rail 只拿到前若干页。静默提交会被读成「更早方向没有条目」，
      // 因此先打一条可定位的 warn，再把截断事实本身写进目录态交给 rail 提示。
      const truncated = entries.length < realUserQueryTotal;
      if (stopReason === "page-limit") {
        logger.warn("[v4-store] turn 目录翻页达到页数上限，仅取到部分条目", {
          entryCount: entries.length,
          pages,
          realUserQueryTotal,
          sessionId,
        });
      }
      this.setState({
        turnDirectory: {
          atLogEpoch: logEpoch,
          atRevision: pinnedRevision,
          atSeq: accumulated.atSeq,
          entries,
          hasMore: accumulated.hasMore,
          loaded: true,
          realUserQueryTotal,
          truncated,
        },
      });
      logger.debug("[v4-store] turn 目录查询完成", {
        entryCount: entries.length,
        hasMore: accumulated.hasMore,
        pages,
        realUserQueryTotal,
        sessionId,
      });
      const terminal = { status: "hydrated" as const, logEpoch, directoryRevision };
      this.turnDirectoryHydrationTerminal = terminal;
      return terminal;
    } catch (error) {
      // 兜底 catch：accumulateTurnDirectoryPages 已经把查询失败表达成 stopReason，
      // 能落到这里的都是它之外的意外。同样按「失败不留旧目录」处理。
      logger.warn(
        `[v4-store] turnDirectory ${this.topic} 失败并清空目录态: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.clearTurnDirectory();
      return { status: "retryable-failure", logEpoch };
    } finally {
      this.turnDirectoryQueryInFlight = false;
      if (!this.closed) this.setState({ loadingDirectory: false });
      if (this.turnDirectoryQueryPending && !this.closed) {
        this.turnDirectoryQueryPending = false;
        void this.loadTurnDirectory();
      }
    }
  }

  /**
   * 目录查询失败后的降级：清空目录态（loaded 归 false → rail 隐藏）。
   *
   * 已经处于空态时不重复通知——退避阶梯会在同一代际里重试好几次，每次都推一份
   * 等值的新 state 只会白白惊动所有 useSyncExternalStore 订阅者。
   */
  private clearTurnDirectory(): void {
    if (this.state.turnDirectory === EMPTY_TURN_DIRECTORY_STATE) return;
    this.setState({ turnDirectory: EMPTY_TURN_DIRECTORY_STATE });
  }

  /**
   * 目录失效代际变更后按 250ms trailing 合并重查。
   *
   * 触发源是 {@link nextTurnNavigatorDirectoryRevision} 命中的三类帧（append/upsert/
   * removed + snapshot 整体替换）。只在「本会话已经取过目录」时排——从未 hydrate 过的
   * 会话没有目录可失效，交给组件的首轮 effect 决定要不要查。
   */
  private scheduleTurnDirectoryRequery(): void {
    if (this.closed || !this.state.turnDirectory.loaded) return;
    this.turnDirectoryDebouncer ??= createTrailingDebouncer(
      TURN_NAVIGATOR_DIRECTORY_REQUERY_DEBOUNCE_MS,
      () => {
        void this.loadTurnDirectory();
      },
    );
    this.turnDirectoryDebouncer.schedule();
  }

  /**
   * 按本地失效 revision 合并并发的计划目录查询。
   * 旧计划可能早于 snapshot tail；同时 edit/retry 的 row.removed 会让在途
   * query 立刻过期，必须以 revision + epoch 双重校验，不能把旧分支计划重新写回 UI。
   */
  async refreshPlans(): Promise<void> {
    if (this.closed) return;
    if (this.planQueryInFlight) {
      this.planQueryPending = true;
      return;
    }
    const snapshot = this.state.snapshot;
    const sessionId = parseConversationTopic(this.topic);
    if (!snapshot || !sessionId) return;
    const requestedGeneration = this.generation;
    const requestedRevision = this.state.planDirectoryRevision;
    this.planQueryInFlight = true;
    this.setState({ plansLoading: true });
    try {
      const result = await this.transport.plans({ sessionId });
      if (this.closed) return;
      if (this.generation !== requestedGeneration) return;
      const current = this.state.snapshot;
      if (!current || current.logEpoch !== result.atLogEpoch) {
        return;
      }
      if (this.state.planDirectoryRevision !== requestedRevision) {
        this.planQueryPending = true;
        return;
      }
      this.setState({ sessionPlans: result.plans });
    } catch (error) {
      if (!this.closed) {
        logger.warn(
          `[v4-store] plans ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.planQueryInFlight = false;
      if (!this.closed) this.setState({ plansLoading: false });
      if (this.planQueryPending && !this.closed) {
        this.planQueryPending = false;
        void this.refreshPlans();
      }
    }
  }

  /** 命令上行前登记 overlay（pending/stopping 展示用）。 */
  markCommandPending(command: OptimisticCommand): void {
    if (this.closed) return;
    this.setState({
      optimisticCommands: [...this.state.optimisticCommands, command],
    });
  }

  /**
   * ACK accepted/duplicate 后登记“必须能在权威投影中看见”的输入命令。
   *
   * command RPC 与 conversation topic 是两条独立通路；只有收到后续
   * delta 才能发现 gap，若 topic 在 ACK 后完全静默，CLI 继续工作但 UI 永远等不到 user row。
   * 这里不伪造消息，只在有限窗口后复用既有 same-sub recovery；权威 projection 一旦出现
   * queue/user row，watchdog 立即收口。
   */
  expectAcceptedInputProjection(commandId: string): void {
    if (this.closed || this.acceptedInputProjectionTimers.has(commandId)) return;
    const command = this.state.optimisticCommands.find((item) => item.commandId === commandId);
    if (!command || !ACCEPTED_INPUT_COMMAND_TYPES.has(command.type)) return;
    if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
      this.settleCommand(commandId);
      return;
    }
    const timer = setTimeout(() => {
      this.acceptedInputProjectionTimers.delete(commandId);
      if (
        this.closed ||
        !this.state.optimisticCommands.some((item) => item.commandId === commandId)
      ) {
        return;
      }
      if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
        this.settleCommand(commandId);
        return;
      }
      logger.warn("[v4-store] accepted input projection silent, trigger same-sub recovery", {
        commandId,
        topic: this.topic,
      });
      this.requestRecovery();
    }, ACCEPTED_INPUT_PROJECTION_GRACE_MS);
    this.acceptedInputProjectionTimers.set(commandId, timer);
  }

  private clearAcceptedInputProjectionWatch(commandId: string): void {
    const timer = this.acceptedInputProjectionTimers.get(commandId);
    if (timer !== undefined) clearTimeout(timer);
    this.acceptedInputProjectionTimers.delete(commandId);
  }

  /** 命令被拒/失败等本地收口时移除 overlay。 */
  settleCommand(commandId: string): void {
    this.clearAcceptedInputProjectionWatch(commandId);
    const remaining = this.state.optimisticCommands.filter(
      (command) => command.commandId !== commandId,
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  // 服务端投影出现同 commandId（pendingCommands / userInput.sourceCommandId 锚点）即代表权威侧已接管展示，overlay 条目退场。
  private reconcileOptimistic(snapshot: ConversationSnapshot): void {
    if (this.state.optimisticCommands.length === 0) return;
    const acknowledged = new Set<string>(
      snapshot.pendingCommands.map((command) => command.commandId),
    );
    const inputProjectionIds = new Set<string>();
    for (const item of snapshot.queue.items) {
      inputProjectionIds.add(item.sourceCommandId);
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        acknowledged.add(row.sourceCommandId);
        if (row.origin === "realUser") inputProjectionIds.add(row.sourceCommandId);
      }
    }
    const remaining = this.state.optimisticCommands.filter((command) =>
      ACCEPTED_INPUT_COMMAND_TYPES.has(command.type)
        ? !inputProjectionIds.has(command.commandId)
        : !acknowledged.has(command.commandId),
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  private reconcileAcceptedInputProjection(snapshot: ConversationSnapshot): void {
    for (const commandId of this.acceptedInputProjectionTimers.keys()) {
      if (!hasAcceptedInputProjection(snapshot, commandId)) continue;
      this.clearAcceptedInputProjectionWatch(commandId);
      this.settleCommand(commandId);
    }
  }

  /** 内存诊断：当前 rows.window 行数；只读。 */
  countProjectionRows(): number {
    return this.state.snapshot?.rows.window.length ?? 0;
  }

  /** 退订并终结本 store（仅 SessionDataLayer 调用）。 */
  async close(): Promise<void> {
    if (this.closed) return;
    liveProjectionStores.delete(this);
    const closeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store close started", {
      event: "v4.conversation.store.close.started",
      generation: this.generation,
      module: "ui.v4.conversation_projection_store",
      status: "started",
      subscriptionId: this.state.subscriptionId,
      topic: this.topic,
    });
    this.closed = true;
    this.offAssemblyFault();
    this.offRuntimeRestart?.();
    this.offRuntimeLifecycle?.();
    this.clearRuntimeRecycleRetry();
    this.turnDirectoryDebouncer?.cancel();
    this.turnDirectoryDebouncer = null;
    for (const timer of this.acceptedInputProjectionTimers.values()) clearTimeout(timer);
    this.acceptedInputProjectionTimers.clear();
    this.modelTransitionListeners.clear();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.accumulator = null;
    this.generation++;
    const { subscriptionId } = this.state;
    this.setState({ status: "closed", subscriptionId: null });
    if (subscriptionId) {
      try {
        await this.transport.unsubscribe(subscriptionId);
      } catch (error) {
        logger.lifecycle.warn("v4 conversation store close unsubscribe failed", {
          durationMs: roundedDuration(closeStartedAt, monotonicNow()),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "v4.conversation.store.close.unsubscribe_failed",
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId,
          topic: this.topic,
        });
        logger.warn(`[v4-store] unsubscribe ${this.topic} 失败（忽略）: ${String(error)}`);
      }
    }
    logger.lifecycle.info("v4 conversation store close completed", {
      durationMs: roundedDuration(closeStartedAt, monotonicNow()),
      event: "v4.conversation.store.close.completed",
      module: "ui.v4.conversation_projection_store",
      status: "completed",
      topic: this.topic,
    });
  }
}
