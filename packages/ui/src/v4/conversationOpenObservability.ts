/**
 * v4 会话打开的观测面（dev 采样脚本用，见 `scripts/dev/long-session-perf-sample.mjs`）。
 *
 * 为什么必须有一个窗口出口：会话打开的分段 timing 只存在于 conversation subscribe
 * **ACK 帧**（`openPhases` / `openTiming`）里——二者都不进 snapshot/delta，所以页面内的
 * perfProbe 看不到它，CDP 侧也只能用 `Runtime.evaluate` 取数。这里把 ACK 摘要写进
 * window 上的有界环形缓冲，与 `v4/commandAckObservability.ts` 同口径：只存标量，不含
 * 正文/行数据。
 *
 * 第二个出口 `runtimeReady`：`runtimeReadyMs` **不在** ACK 里（view-only 的激活发生在
 * view-ready ACK 之后，见 `conversationOpenPhasesSchema` 的注释），只能事后走
 * `v4/conversation/runtimeReady` query。采样脚本在「打开会话」之后调它读激活耗时；
 * 这里注册的是该 topic 上最近一次 subscribe 命中的那条 transport 的读取闭包。
 *
 * **两套口径不可互相替代**（cr-func 2026-10-25）：
 *   - `openPhases.viewReadyMs` 只是 **CLI 进程内**的视图就绪段；
 *   - 验收基准是 renderer 侧的 `uiViewReadyMs`（+ `paintAfterApplyMs`），因为它才含
 *     host 准备、CLI spawn、RPC 往返、首帧传输与 React commit。
 */
import type {
  ConversationOpenPhases,
  ConversationOpenTiming,
  V4ConversationRuntimeReadyResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

/**
 * renderer 侧首屏就绪的原始量。全部取 `performance.now()` 单调时钟，**同源可相减**，
 * 但各段嵌套、不可相加（见字段注释）。
 *
 * **唯一一份定义**：`conversationProjectionStore` 的 `SessionOpenRendererTiming` 是它的
 * 别名（`import type`），不得再复制第二份 shape——两份定义一旦分叉，回填的字段与采样
 * 脚本读的字段就会悄悄对不上。
 */
export interface ConversationOpenRendererTiming {
  /** connect 入口 → subscribe 发起（renderer 侧准备段）。 */
  rendererPrepareMs?: number;
  /** subscribe ACK 抵达 → 首帧抵达（RPC 往返尾段 + 首帧传输）。 */
  initialFrameTransportMs?: number;
  /** 首帧抵达 → snapshot 应用完成。 */
  rendererSnapshotApplyMs?: number;
  /** 应用完成的单调时刻（其余 renderer 分段的对齐锚点）。 */
  snapshotAppliedAt?: number;
  /**
   * **总量口径**：connect 入口 → snapshot 应用完成。
   *
   * 这是唯一能与「冷开 ≤1s」直接比较的 renderer 侧总量：起点早于 CLI spawn，终点晚于
   * 首帧应用。`openPhases.viewReadyMs` 只是它内部的一段（CLI 进程内视图就绪），
   * 因此两者不可互换、也不可相减。
   *
   * 两个读法陷阱：①起点是 `SessionDataLayer.acquire`，acquire 在 `useEffect` 里执行，
   * **比用户点击晚一个 React commit**，不能当完整点击延迟；②runtime recycle 有界重试
   * 重入 `connect()` 时不传起始时间戳，起点被重置——带 recycle 的冷开会显得很快。
   */
  uiViewReadyMs?: number;
  /**
   * snapshot 应用完成 → 两个 `requestAnimationFrame` 后的回调（近似首帧 paint）。
   * 与 {@link uiViewReadyMs} 相加才是「到首绘」的体感总量；非浏览器环境缺席。
   */
  paintAfterApplyMs?: number;
}

/** 一次 subscribe ACK 的摘要（不含任何行正文）。 */
export interface ConversationOpenAckSample {
  topic: string;
  sessionId: string;
  mode: "snapshot" | "resume";
  /** 取到 ACK 的本地时刻（epoch ms）。 */
  at: number;
  /**
   * ACK 侧分段。`manifestMs` / `materializeMs` 要到 phase-row-manifest /
   * phase-paged-materialization 才有生产者，本阶段常态缺席（缺席 ≠ 0）。
   *
   * `viewReadyMs` 是 **CLI 进程内**视图就绪段：不含 host 准备 / CLI spawn / RPC 往返 /
   * 渲染。它内部还嵌套 `mergeMs`、`rehydrateMs`（以及阶段 0 的 runtime 激活），
   * 各段不可相加。
   */
  openPhases?: ConversationOpenPhases;
  /** Host/CLI 进程级打开耗时（既有诊断面，与本迭代的 openPhases 并列保留）。 */
  openTiming?: ConversationOpenTiming;
  /**
   * renderer 侧分段（ACK 之后回填，一次打开更新 2~3 次）。
   * 验收基准 `uiViewReadyMs` 在 {@link ConversationOpenRendererTiming} 里。
   */
  renderer?: ConversationOpenRendererTiming;
}

export type ConversationRuntimeReadyReader = () => Promise<V4ConversationRuntimeReadyResult>;

/**
 * `paintAfterApplyMs` 采样**被丢弃**的原因（缺席原因，不是数值）。
 *
 * 两种丢弃都是设计内的早退（`conversationProjectionStore.scheduleOpenPaintSample`），但过去是
 * **静默**的：`renderer.paintAfterApplyMs` 在快路径 regime 上无声缺席，报告里只剩
 * `uiViewReadyMs`，`uiViewReadyMs + paintAfterApplyMs` 这条「到首绘」口径永远凑不齐，
 * 也无法区分「rAF 还没跑」与「样本已作废」。
 */
export type ConversationOpenPaintMissingReason = "closed" | "generation_changed";

/** 一条被丢弃的首绘采样记录（按 topic 只留最近一条）。 */
export interface ConversationOpenPaintMissingSample {
  reason: ConversationOpenPaintMissingReason;
  /** 丢弃发生时刻（epoch ms，用于判断它属于哪一次打开）。 */
  at: number;
}

/** window 上的调试面；`acks` 只存摘要，容量固定。 */
export interface ConversationOpenProbe {
  acks: ConversationOpenAckSample[];
  /**
   * topic → 最近一次**被丢弃**的首绘采样原因。
   *
   * 与 `acks[].renderer.paintAfterApplyMs` 并列、而不是塞进 `renderer`：被丢弃的是「上一代 /
   * 已关闭」那一次打开的首绘，写进当前 ACK 样本的 `renderer` 会与它自己的
   * `paintAfterApplyMs` 互相打架（一个说测到了、一个说缺席）。新 ACK 覆盖该 topic 时清空，
   * `reset()` 也清空。
   */
  paintMissing: Record<string, ConversationOpenPaintMissingSample>;
  reset(): void;
  /**
   * 读指定（缺省 = 最近一次 ACK 命中的）会话的 runtime 激活耗时；没有 reader 时返回 null。
   *
   * **仅 dev 构建挂载**：这个出口会触发一次可能拉起 CLI 进程的 RPC（`subscribe` 族走
   * start-if-needed），生产面不该有它。`acks` 环形缓冲是纯数据，保持常驻。
   */
  runtimeReady?(sessionId?: string): Promise<V4ConversationRuntimeReadyResult | null>;
}

/** 同时记住的 **topic** 数上限（每个 topic 只留最近一条 ACK，见 `recordConversationOpenAck`）。 */
const MAX_ACK_SAMPLES = 20;

type ConversationOpenProbeWindow = Window & {
  __zcodeV4ConversationOpensE2E?: ConversationOpenProbe;
};

/**
 * `topic → 读取闭包`。键必须是 topic（不是 sessionId 再转一道）：会话关闭时 store 手上
 * 只有 topic，用 topic 作键才能在同一处对称地摘掉。
 */
const runtimeReadyReaders = new Map<string, ConversationRuntimeReadyReader>();
let lastAckTopic: string | null = null;

/**
 * dev 门控口径与 `lib/perfProbe.ts` 一致：只在 Vite dev build + 浏览器里启用。
 * Node 单测下 `import.meta.env` 为 undefined，退化成 false。
 */
export function isConversationOpenProbeDevEnabled(): boolean {
  const viteDev =
    ((import.meta as ImportMeta & { env?: { readonly DEV?: boolean } }).env ?? {}).DEV === true;
  return viteDev && typeof window !== "undefined";
}

/** 按 sessionId 反查最近一次命中它的 topic；调用方传入显式 sessionId 时才需要。 */
function topicForSession(
  acks: readonly ConversationOpenAckSample[],
  sessionId: string,
): string | null {
  for (let index = acks.length - 1; index >= 0; index -= 1) {
    const sample = acks[index];
    if (sample && sample.sessionId === sessionId) return sample.topic;
  }
  return null;
}

function ensureProbe(): ConversationOpenProbe | null {
  if (typeof window === "undefined") return null;
  const host = window as ConversationOpenProbeWindow;
  const existing = host.__zcodeV4ConversationOpensE2E;
  if (existing) return existing;
  const probe: ConversationOpenProbe = {
    acks: [],
    paintMissing: {},
    reset() {
      probe.acks.length = 0;
      for (const topic of Object.keys(probe.paintMissing)) delete probe.paintMissing[topic];
    },
  };
  // 读取出口只在 dev 挂载：它会把 RPC 打到 agentService，进而可能拉起 CLI 进程。
  if (isConversationOpenProbeDevEnabled()) {
    probe.runtimeReady = async (sessionId) => {
      const topic = sessionId ? topicForSession(probe.acks, sessionId) : lastAckTopic;
      if (!topic) return null;
      const read = runtimeReadyReaders.get(topic);
      if (!read) return null;
      return read();
    };
  }
  host.__zcodeV4ConversationOpensE2E = probe;
  return probe;
}

/** 记账一次 subscribe ACK。窗口不存在（非浏览器/生产无关环境）时静默跳过。 */
export function recordConversationOpenAck(sample: ConversationOpenAckSample): void {
  const probe = ensureProbe();
  if (!probe) return;
  // **按 topic 保留最近一条**（cr-func N3）：renderer 分段是事后按 topic 回填的，全局
  // FIFO 会被侧 pane / 子代理的 ACK 把目标会话样本挤出缓冲，回填随即静默丢数。
  // 覆盖旧样本而不是追加，也符合「一次打开只关心该 topic 最近一次 subscribe」。
  const previousIndex = probe.acks.findIndex((existing) => existing.topic === sample.topic);
  if (previousIndex >= 0) probe.acks.splice(previousIndex, 1);
  probe.acks.push(sample);
  if (probe.acks.length > MAX_ACK_SAMPLES) {
    probe.acks.splice(0, probe.acks.length - MAX_ACK_SAMPLES);
  }
  // 新一代 ACK 代表一次新的打开：上一次打开留下的「首绘被丢弃」标记不再描述它。
  // 不清的话，采样脚本会把上一代的缺席原因当成本次样本的结论。
  delete probe.paintMissing[sample.topic];
  lastAckTopic = sample.topic;
}

/**
 * 记录一次**被丢弃**的首绘采样（`scheduleOpenPaintSample` 的早退分支调用）。
 *
 * 缺席原因必须能和「还没到」区分开：脚本读到 `paintMissing.reason` 才知道
 * `uiViewReadyMs + paintAfterApplyMs` 为什么凑不齐，而不是把它当成「rAF 尚未触发」继续等。
 * 同样打 warn——静默丢弃正是 phase-0 里 5/9 次无声缺席的来源。
 */
export function recordConversationOpenPaintMissing(
  topic: string,
  reason: ConversationOpenPaintMissingReason,
): void {
  const probe = ensureProbe();
  if (!probe) return;
  probe.paintMissing[topic] = { reason, at: Date.now() };
  logger.warn(
    `[v4-open-probe] ${topic} 的首绘采样被丢弃（paint_missing=${reason}），` +
      "该次打开的 paintAfterApplyMs 不会出现（缺席 ≠ 0）",
  );
}

/**
 * 回填 renderer 侧分段到该 topic 最近一次 ACK 样本。
 *
 * 为什么事后回填而不是在 ACK 里带：`uiViewReadyMs` 的终点（snapshot 应用完成）与
 * `paintAfterApplyMs` 的终点（首绘回调）都在 ACK 之后。找不到样本时**必须留信号**
 * （warn）而不能静默丢弃：那时窗口面未挂载、或该 topic 的 ACK 已被缓冲挤出，验收指标
 * `uiViewReadyMs` 会凭空消失，采样报告里只剩 `uiViewReadyMs=unavailable`。
 */
export function recordConversationOpenRendererTiming(
  topic: string,
  timing: ConversationOpenRendererTiming,
): void {
  const probe = ensureProbe();
  if (!probe) return;
  for (let index = probe.acks.length - 1; index >= 0; index -= 1) {
    const sample = probe.acks[index];
    if (!sample || sample.topic !== topic) continue;
    sample.renderer = { ...timing };
    return;
  }
  logger.warn(
    `[v4-open-probe] ${topic} 没有可回填的 ACK 样本，renderer 分段丢弃` +
      `（字段=${Object.keys(timing).join(",") || "空"}）`,
  );
}

/**
 * 注册某会话的 runtimeReady 读取闭包（该 topic 每次 subscribe 覆盖一次）。
 *
 * 闭包持有 transport 与 agentService，因此**只按 topic 保留最新一份**，并由
 * {@link unregisterConversationRuntimeReadyReader} 在会话关闭时摘掉：只增不删会把已
 * dispose 的 transport 一直钉在内存里。
 *
 * 注意 reader 与 probe 分居模块级与 window 两处：Vite HMR 重求值本模块会清空 readers，
 * 但 window 上的 probe 仍在——采样期不要热更新 renderer，或重开一次会话重建 reader
 * （与 `lib/perfProbe.ts` 的 HMR 取舍同源）。
 */
export function registerConversationRuntimeReadyReader(
  topic: string,
  read: ConversationRuntimeReadyReader,
): void {
  if (!isConversationOpenProbeDevEnabled()) return;
  runtimeReadyReaders.set(topic, read);
  ensureProbe();
}

/**
 * 摘掉某 topic 的 reader（会话关闭 / transport dispose / SessionDataLayer 回收时调用）。
 *
 * 不摘的后果有两层：闭包把 transport 与 agentService 强引用住；而 `probe.runtimeReady()`
 * 一旦被再次调用，读的就是一个已 dispose 的 transport——该 RPC 会走 start-if-needed，
 * 等于为一次「观测」拉起 CLI 进程。
 */
export function unregisterConversationRuntimeReadyReader(topic: string): void {
  runtimeReadyReaders.delete(topic);
}
