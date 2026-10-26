import type {
  ZCodeProtocolError,
  ZCodeProtocolMessage,
  ZCodeProtocolNotification,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolResponse,
} from "@zcode/shared";
import { zcodeProtocolMessageSchema, zcodeProtocolMethods } from "@zcode/shared";
import type { Logger } from "@zcode/contracts";
import { commandConcurrencyOf, type CommandConcurrency } from "./command-concurrency.js";
import { RequestConcurrencyGate } from "./request-concurrency-gate.js";

type ZCodeProtocolOutgoingMessage =
  | ZCodeProtocolError
  | ZCodeProtocolNotification
  | ZCodeProtocolRequest
  | ZCodeProtocolResponse;

type ZCodeProtocolMessageHandler = (
  message: ZCodeProtocolMessage,
) => Promise<ZCodeProtocolOutgoingMessage | undefined>;

const PROTOCOL_EOF_DRAIN_MS = 100;
/**
 * 排队等待超过这个数就升到 `warn`：真机冷开的正常值是个位数毫秒，一旦越过它
 * 就说明「请求到了、CLI 还在忙别的」——冷开账单里那 800~1150ms 的可检索信号。
 *
 * fix-c20 之后只有两种情况会越过它：①前面有一条**变更**在独占（读被它挡住是契约要求）；
 * ②前面有一条同 requestId 的请求在飞（客户端违约，见 `dispatchLine`）。
 */
const PROTOCOL_SLOW_QUEUE_WAIT_MS = 200;

/**
 * 请求的**三段**耗时打点（fix-c19）：这段曾经是冷开账单里的盲区。
 *
 * 真机读数显示 `uiViewReadyMs − openPhases.viewReadyMs` 有 800~1150ms 落在 CLI handler
 * 开始之前，但没人知道它落在「renderer → host → stdio」、「stdio 到达 → handler 出队」
 * 还是「handler 内部」——本类三者都拿得到：
 *
 *   - `receivedAt`：这一行**读进来**的墙钟（`onData` 的 dispatchLine）；
 *   - `dispatchedAt`：这一行**真正进入 handler** 的墙钟（并发闸门放行之后）；
 *   - `queueWaitMs`：两者之差 —— 就是「请求到了、但 CLI 还在忙别的」的那一段；
 *   - `handlerMs`：handler 本体（含帧编码 + outbox take）；
 *   - `respondedAt`：response 交给 stdout 的墙钟。
 *
 * 全部是 epoch 毫秒，因此可以和 renderer 侧的 `click.dispatchedAt` / ACK 到达时刻直接相减
 * （同一台机器、同一个时钟），把 `click → ACK` 完整拆开。只走 debug、只在请求上打，
 * 不进协议、不进 `openPhases`（IS8 的键集合不变）。
 */
interface ProtocolRequestTiming {
  receivedAt: number;
  dispatchedAt: number;
  respondedAt: number;
  /**
   * 这条请求走的是哪条通道（fix-c20）：`readonly` / `mutating` 是闸门给的并发类，
   * `bypass` 是停止/取消旁路（不过锁）。等待到底是被谁挡住的，只有这一位能回答。
   */
  dispatchClass: CommandConcurrency | "bypass";
}

interface ZCodeProtocolNdjsonConnectionOptions {
  signal?: AbortSignal;
  clearPostResponseMessages?: () => void;
  handleMessage: ZCodeProtocolMessageHandler;
  input: NodeJS.ReadableStream;
  logger?: Logger;
  onTransportClosed?: (error: Error) => void;
  output: NodeJS.WritableStream;
  takePostResponseMessages?: (
    requestId: ZCodeProtocolRequestId,
  ) => readonly ZCodeProtocolOutgoingMessage[];
  takePostResponseBatch?: (requestId: ZCodeProtocolRequestId) => {
    readonly messages: readonly ZCodeProtocolOutgoingMessage[];
    commit(): boolean;
  } | null;
}

/**
 * 请求的 requestId 键（字符串化）：只用于「同 id 在飞」的独占判定与打点，
 * 不参与协议语义。反向 response 不在此列（它们不进闸门）。
 */
function requestKeyOf(message: ZCodeProtocolMessage): string | undefined {
  if (!("id" in message)) return undefined;
  const id = (message as { id?: unknown }).id;
  return id === undefined || id === null ? undefined : String(id);
}

export class ZCodeProtocolNdjsonConnection {
  private buffer = "";
  /**
   * 普通命令的并发闸门（fix-c20）：只读共享、变更独占、严格 FIFO。
   *
   * 改造前这里是一条 `processing` 串行链——所有请求（含互不相干的只读）排成一列。
   * after3 实测这条链把冷开的 `subscribe` 挡在同一次打开里更早到达的
   * `workflowRuns`（首次 handler 1s，见风险 27/28）后面 918ms。
   * 只用串行换来的那点「次序确定性」在只读之间是**不存在的语义**，所以换成读写锁；
   * 变更侧仍然严格串行且保序（见 `RequestConcurrencyGate` 的三条语义）。
   */
  private readonly requestGate = new RequestConcurrencyGate();
  private lastQueuedMessageStarted: Promise<void> = Promise.resolve();
  /**
   * 在飞的 requestId 计数。**不是**为并发去重服务的（那是客户端的契约），而是为了在客户端
   * 违约时退化成旧行为：`postResponseOutbox` 与响应路由都按 requestId 键控，两条同 id 的
   * 请求并发会互相 `delete` / `set`（初始帧静默丢失）。串行队列顺带掩盖了这个违约，
   * 换成并发之后必须显式挡住——所以「同 id 在飞」一律按变更（独占）处理。
   */
  private readonly inFlightRequestIds = new Map<string, number>();
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: Error) => void;
  private terminal = false;
  private transportCloseNotified = false;
  private draining = false;
  private drainTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ZCodeProtocolNdjsonConnectionOptions) {
    this.closedPromise = new Promise((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
  }

  start(): void {
    this.options.input.on("data", this.onData);
    this.options.input.once("end", this.onClose);
    this.options.input.once("close", this.onClose);
    this.options.input.on("error", this.onError);
    this.options.output.on("error", this.onError);
    this.options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (this.options.signal?.aborted) this.onAbort();
  }

  waitForClose(): Promise<void> {
    return this.closedPromise;
  }

  send(message: ZCodeProtocolOutgoingMessage): void {
    if (this.terminal) return;
    try {
      this.options.output.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.terminal || this.draining) return;
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.dispatchLine(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  };

  private readonly onClose = (): void => {
    if (this.terminal || this.draining) return;
    const trailing = this.buffer.trim();
    if (trailing.length > 0) {
      this.dispatchLine(trailing);
      this.buffer = "";
    }
    this.draining = true;
    this.notifyTransportClosed(new Error("ZCode Protocol client connection closed"));
    // EOF 保留短请求半关闭响应，但挂起 handler 不能让进程永久保活。
    this.drainTimer = setTimeout(() => this.finish(), PROTOCOL_EOF_DRAIN_MS);
    void this.requestGate.waitForIdle().then(
      () => this.finish(),
      (error: Error) => this.fail(error),
    );
  };

  private readonly onAbort = (): void => {
    this.notifyTransportClosed(new Error("ZCode Protocol runtime stopping"));
    this.finish();
  };

  private readonly onError = (error: Error): void => {
    this.notifyTransportClosed(error);
    this.fail(error);
  };

  private notifyTransportClosed(error: Error): void {
    if (this.transportCloseNotified) return;
    this.transportCloseNotified = true;
    this.options.onTransportClosed?.(error);
  }

  private finish(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.detachInput();
    this.options.clearPostResponseMessages?.();
    this.resolveClosed();
  }

  private fail(error: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    this.notifyTransportClosed(error);
    this.detachInput();
    this.options.clearPostResponseMessages?.();
    this.rejectClosed(error);
  }

  private detachInput(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.options.input.off("data", this.onData);
    this.options.input.off("end", this.onClose);
    this.options.input.off("close", this.onClose);
    this.options.signal?.removeEventListener("abort", this.onAbort);
    // 错误 listener 保留到流本身结束，吸收已经排入事件循环的迟到 stream error。
  }

  private dispatchLine(line: string): void {
    if (this.terminal) return;
    // 打点起点：这一行读进来的时刻（与 renderer 侧 click 同一时钟）。
    const receivedAt = Date.now();
    const message = this.decodeLine(line);
    if (!message) {
      return;
    }
    if ("id" in message && ("result" in message || "error" in message)) {
      // Agent 发出反向 request 前已同步登记 pending response。
      // 若 response 等待“最后一个排队请求开始”，后续普通请求会把等待点推到当前长请求之后，
      // 形成「当前请求等 response、response 等后续请求」的死锁。
      void this.handleMessage(message, receivedAt, "bypass").catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }
    if (this.shouldBypassProcessingQueue(message)) {
      // 停止/取消控制必须等它前面的普通请求真正进入 handler、建立 abort
      // controller，再越过该请求的异步执行；只延后一轮微任务会让控制请求提前成为空操作。
      // 旁路**不过并发闸门**：它必须能越过一条正在飞的长变更，否则「停止」永远发不出去。
      void this.lastQueuedMessageStarted
        .then(() => this.handleMessage(message, receivedAt, "bypass"))
        .catch((error: unknown) => {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        });
      return;
    }
    const concurrency = this.concurrencyFor(message);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    // 旁路的等待点仍是「最后一条排队消息**开始**跑」，不是「跑完」。
    this.lastQueuedMessageStarted = started;
    const requestKey = requestKeyOf(message);
    const releaseRequestKey = this.trackInFlightRequest(requestKey);
    void this.requestGate
      .run(concurrency, () => this.handleMessage(message, receivedAt, concurrency), markStarted)
      .catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(releaseRequestKey);
  }

  /**
   * 这条请求走哪个并发类。分类只来自 `command-concurrency.ts` 的显式表（未知方法名
   * 一律 `mutating`，见该文件）；这里只额外加一条**与分类无关**的安全闸：
   * 同一 requestId 已在飞 ⇒ 强制独占（理由见 `inFlightRequestIds` 的注释）。
   */
  private concurrencyFor(message: ZCodeProtocolMessage): CommandConcurrency {
    if (!("method" in message)) return "mutating";
    const declared = commandConcurrencyOf(message.method);
    if (declared === "mutating") return "mutating";
    const requestKey = requestKeyOf(message);
    if (requestKey !== undefined && (this.inFlightRequestIds.get(requestKey) ?? 0) > 0) {
      return "mutating";
    }
    return declared;
  }

  private trackInFlightRequest(requestKey: string | undefined): () => void {
    if (requestKey === undefined) return () => {};
    this.inFlightRequestIds.set(requestKey, (this.inFlightRequestIds.get(requestKey) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.inFlightRequestIds.get(requestKey) ?? 1) - 1;
      if (next <= 0) this.inFlightRequestIds.delete(requestKey);
      else this.inFlightRequestIds.set(requestKey, next);
    };
  }

  private decodeLine(line: string): ZCodeProtocolMessage | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (error) {
      this.options.logger?.warn("ZCode Protocol JSON parse failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.parse.failed",
        module: "bootstrap.zcode_protocol",
        status: "failed",
      });
      this.sendError("parse-error", -32700, "Parse error");
      return null;
    }

    const parsed = zcodeProtocolMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      this.sendError("invalid-message", -32600, "Invalid ZCode Protocol message", {
        issues: parsed.error.issues,
      });
      return null;
    }

    return parsed.data;
  }

  private shouldBypassProcessingQueue(message: ZCodeProtocolMessage): boolean {
    // 模型任务占住串行队列时，停止/取消请求必须仍能进入 server，
    // 才能把底层 AbortSignal 传给真实模型请求。控制面只旁路当前执行，普通请求仍保持串行。
    return (
      "id" in message &&
      "method" in message &&
      (message.method === zcodeProtocolMethods.sessionStop ||
        message.method === zcodeProtocolMethods.workspaceCancelGenerateText)
    );
  }

  private async handleMessage(
    message: ZCodeProtocolMessage,
    receivedAt: number,
    dispatchClass: CommandConcurrency | "bypass",
  ): Promise<void> {
    if (this.terminal) return;
    const dispatchedAt = Date.now();
    const response = await this.options.handleMessage(message);
    if (response) {
      // 确定性时序：先一次性 take 当前 request 的 outbox，再连续写 response
      // 与 notification。禁止 queueMicrotask/setTimeout 或依赖底层分包先后。
      const postResponseBatch =
        "id" in response && ("result" in response || "error" in response)
          ? (this.options.takePostResponseBatch?.(response.id) ?? {
              messages: this.options.takePostResponseMessages?.(response.id) ?? [],
              commit: () => true,
            })
          : { messages: [], commit: () => true };
      // output EPIPE 可能发生在 subscribe handler 在途期间。fail() 已清过
      // 当时的 outbox，但迟到 handler 仍可能新建 request entry；这里先 take 精确释放，
      // terminal 时不再写 response/initial，避免 close 后引用泄漏或继续写坏流。
      if (this.terminal) return;
      this.send(response);
      for (const postResponseMessage of postResponseBatch.messages) {
        this.send(postResponseMessage);
      }
      // 旧 outbox 在生成 logical frame 时已推进 publisher 水位。这里以
      // Writable.write() 未同步抛错作为“进入本 connection-owned queue”的 admission；
      // 后续异步 EPIPE 会终结整个 connection epoch，旧 subscription 不会在新管道复用。
      if (!this.terminal) postResponseBatch.commit();
    }
    this.logRequestTiming(message, {
      dispatchClass,
      dispatchedAt,
      receivedAt,
      respondedAt: Date.now(),
    });
  }

  /**
   * 每个**请求**一行三段耗时（见 `ProtocolRequestTiming`）。
   *
   * 只在请求上打（response / notification 不打），且只在 debug 级：这是开发机与真机
   * 采样的诊断面，不进协议、不进 `openPhases`。`receivedAt` / `dispatchedAt` / `respondedAt`
   * 是 epoch 毫秒，可与 renderer 侧的 click / ACK 时刻直接相减——冷开账单里那段
   * 「handler 之前的 800~1150ms」只有靠这三段才分得开。
   *
   * `dispatchClass`（fix-c20）是「为什么等」的那一位：`readonly` 之间不再互相挡，
   * 所以任何一次 queueWait 都能归因到「被一条变更独占」或「同 requestId 在飞」。
   */
  private logRequestTiming(message: ZCodeProtocolMessage, timing: ProtocolRequestTiming): void {
    if (!("method" in message)) return;
    const queueWaitMs = Math.max(0, timing.dispatchedAt - timing.receivedAt);
    const handlerMs = Math.max(0, timing.respondedAt - timing.dispatchedAt);
    const fields = {
      event: "zcode_protocol.request.timing",
      module: "bootstrap.zcode_protocol",
      method: message.method,
      requestId: String((message as { id?: unknown }).id ?? ""),
      receivedAt: timing.receivedAt,
      dispatchedAt: timing.dispatchedAt,
      respondedAt: timing.respondedAt,
      queueWaitMs,
      handlerMs,
      dispatchClass: timing.dispatchClass,
    };
    this.options.logger?.debug("ZCode Protocol request timing", fields);
    // 冷开采样只需要一眼就能 grep 到的文本行（与 `v4 cold load breakdown` 同一习惯）。
    if (queueWaitMs >= PROTOCOL_SLOW_QUEUE_WAIT_MS) {
      this.options.logger?.warn("ZCode Protocol request waited in queue", fields);
    }
  }

  private sendError(id: string, code: number, message: string, data?: unknown): void {
    this.send({
      error: {
        code,
        data,
        message,
      },
      id,
    });
  }
}
