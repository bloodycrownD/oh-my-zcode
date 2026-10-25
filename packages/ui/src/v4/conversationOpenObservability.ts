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
 * 这里注册的是最近一次 subscribe 命中的那条 transport 上的读取闭包。
 */
import type {
  ConversationOpenPhases,
  ConversationOpenTiming,
  V4ConversationRuntimeReadyResult,
} from "@zcode/shared/zcode-protocol-v4";

/** 一次 subscribe ACK 的摘要（不含任何行正文）。 */
export interface ConversationOpenAckSample {
  topic: string;
  sessionId: string;
  mode: "snapshot" | "resume";
  /** 取到 ACK 的本地时刻（epoch ms）。 */
  at: number;
  /**
   * ACK 侧分段。`manifestMs` / `materializeMs` 要到 phase-row-manifest /
   * phase-paged-materialization 才有生产者，本阶段常态缺席。
   */
  openPhases?: ConversationOpenPhases;
  /** Host/CLI 进程级打开耗时（既有诊断面，与本迭代的 openPhases 并列保留）。 */
  openTiming?: ConversationOpenTiming;
}

export type ConversationRuntimeReadyReader = () => Promise<V4ConversationRuntimeReadyResult>;

/** window 上的调试面；`acks` 只存摘要，容量固定。 */
export interface ConversationOpenProbe {
  acks: ConversationOpenAckSample[];
  reset(): void;
  /** 读指定（缺省 = 最近一次 ACK 命中的）会话的 runtime 激活耗时；没有 reader 时返回 null。 */
  runtimeReady(sessionId?: string): Promise<V4ConversationRuntimeReadyResult | null>;
}

const MAX_ACK_SAMPLES = 20;

type ConversationOpenProbeWindow = Window & {
  __zcodeV4ConversationOpensE2E?: ConversationOpenProbe;
};

const runtimeReadyReaders = new Map<string, ConversationRuntimeReadyReader>();
let lastAckSessionId: string | null = null;

function ensureProbe(): ConversationOpenProbe | null {
  if (typeof window === "undefined") return null;
  const host = window as ConversationOpenProbeWindow;
  const existing = host.__zcodeV4ConversationOpensE2E;
  if (existing) return existing;
  const probe: ConversationOpenProbe = {
    acks: [],
    reset() {
      probe.acks.length = 0;
    },
    async runtimeReady(sessionId) {
      const target = sessionId ?? lastAckSessionId;
      if (!target) return null;
      const read = runtimeReadyReaders.get(target);
      if (!read) return null;
      return read();
    },
  };
  host.__zcodeV4ConversationOpensE2E = probe;
  return probe;
}

/** 记账一次 subscribe ACK。窗口不存在（非浏览器/生产无关环境）时静默跳过。 */
export function recordConversationOpenAck(sample: ConversationOpenAckSample): void {
  const probe = ensureProbe();
  if (!probe) return;
  probe.acks.push(sample);
  if (probe.acks.length > MAX_ACK_SAMPLES) {
    probe.acks.splice(0, probe.acks.length - MAX_ACK_SAMPLES);
  }
  lastAckSessionId = sample.sessionId;
}

/**
 * 注册某会话的 runtimeReady 读取闭包（每条 transport 的 subscribe 覆盖一次）。
 *
 * 注意 reader 与 probe 分居模块级与 window 两处：Vite HMR 重求值本模块会清空 readers，
 * 但 window 上的 probe 仍在——采样期不要热更新 renderer，或重开一次会话重建 reader
 * （与 `lib/perfProbe.ts` 的 HMR 取舍同源）。
 */
export function registerConversationRuntimeReadyReader(
  sessionId: string,
  read: ConversationRuntimeReadyReader,
): void {
  if (typeof window === "undefined") return;
  runtimeReadyReaders.set(sessionId, read);
  ensureProbe();
}
