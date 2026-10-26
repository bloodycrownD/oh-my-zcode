// 冷恢复协调器：订阅落在「不在内存注册表、但可能已持久化」的会话时
// （CLI 重启后打开历史会话），经宿主钩子把 record 拉起来，再回到既有
// gateway READY hydration 路径。从 v4-gateway 拆出（单一职责 + max-lines）。
//
// 语义要点：
// - 这里只保留既有 runtime activation 单飞；完整 READY 水位由 gateway 负责；
// - 错误分型（项目规范：不靠错误文本分流）：
//   fault.subscribe.sessionNotFound（store 里也没有 / 宿主不支持恢复）
//   vs fault.subscribe.resumeFailed（恢复中途失败，保留原始 cause）。
//   message 附带 reasonCode——renderer 订阅错误块直显 lastError，无需 UI 改动即透出。

import type { MessageWithParts } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";

export type ColdSessionResumeOutcome =
  | { status: "resumed"; persistedMessages?: MessageWithParts[] }
  | { status: "notFound" };

/** 协调器需要的宿主能力窄面（与 V4GatewayHost 同形，避免循环 import）。 */
interface ColdSessionResumeHost {
  resumePersistedSession?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ColdSessionResumeOutcome>;
  /** view-only 外壳的物化入口（Step 9）；缺席 = 旧宿主，调用方退回「先激活再建投影」。 */
  materializeSessionShell?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ColdSessionShellOutcome>;
  onDebug?(message: string): void;
  onError?(scope: string, error: unknown, context?: Record<string, unknown>): void;
}

/** 外壳物化的结论：`notFound` 与激活路径共用同一套 subscribe 错误分型。 */
export type ColdSessionShellOutcome = { status: "materialized" } | { status: "notFound" };

/** 订阅不可用会话的结构化错误（reasonCode 见文件头）。 */
class V4SubscribeSessionUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reasonCode: "fault.subscribe.sessionNotFound" | "fault.subscribe.resumeFailed",
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${detail} (${reasonCode})`, options);
    this.name = "V4SubscribeSessionUnavailableError";
  }
}

export class ColdSessionResumeCoordinator {
  /** sessionId → 进行中的 runtime activation；settle 后立即释放。 */
  private readonly flights = new Map<string, Promise<MessageWithParts[] | undefined>>();
  /** sessionId → 进行中的 view-only 外壳物化（与激活是两条独立的水位）。 */
  private readonly shellFlights = new Map<string, Promise<void>>();

  constructor(private readonly host: ColdSessionResumeHost) {}

  ensureResumed(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<MessageWithParts[] | undefined> {
    const inFlight = this.flights.get(sessionId);
    if (inFlight) {
      this.host.onDebug?.(`cold resume joined existing flight session=${sessionId}`);
      return inFlight;
    }
    this.host.onDebug?.(`cold resume flight created session=${sessionId}`);
    const flight = this.resume(sessionId, resumeThoughtLevel, workspace).finally(() => {
      this.flights.delete(sessionId);
      this.host.onDebug?.(`cold resume flight cleared session=${sessionId}`);
    });
    this.flights.set(sessionId, flight);
    return flight;
  }

  clear(): void {
    this.flights.clear();
    this.shellFlights.clear();
  }

  /**
   * **只物化外壳**（view-only 路径的入口，Step 9）：store 读 session + 首屏种子 +
   * `createRecord(resume:false)`，**不** resume。
   *
   * 与 `ensureResumed` 拆成两条水位：读/翻页只等这一条，send 类命令与预激活等那一条。
   * 错误分型与激活路径一致（`notFound` → `fault.subscribe.sessionNotFound`，
   * 中途失败 → `fault.subscribe.resumeFailed`），否则同一类不可用会话会在「看」和「跑」
   * 两条路径上得到不同的 reasonCode。
   *
   * `host.materializeSessionShell` 缺席（旧宿主 / 测试桩）时**什么都不做**：调用方
   * （`ensureViewReadyPublisher`）已经退回 Step 8 的「先激活再建投影」。
   */
  ensureShellMaterialized(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<void> {
    const inFlight = this.shellFlights.get(sessionId);
    if (inFlight) {
      this.host.onDebug?.(`cold shell joined existing flight session=${sessionId}`);
      return inFlight;
    }
    const materialize = this.host.materializeSessionShell;
    if (!materialize) return Promise.resolve();
    this.host.onDebug?.(`cold shell flight created session=${sessionId}`);
    const flight = (async () => {
      let outcome: ColdSessionShellOutcome;
      try {
        outcome = workspace
          ? await materialize.call(this.host, sessionId, resumeThoughtLevel, workspace)
          : await materialize.call(this.host, sessionId, resumeThoughtLevel);
      } catch (error) {
        this.host.onError?.("v4.subscribe.shell", error, {
          phase: "materializeSessionShell",
          sessionId,
        });
        throw new V4SubscribeSessionUnavailableError(
          sessionId,
          "fault.subscribe.resumeFailed",
          `Failed to materialize session shell ${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      if (outcome.status === "notFound") {
        throw new V4SubscribeSessionUnavailableError(
          sessionId,
          "fault.subscribe.sessionNotFound",
          `Session is not active and not persisted: ${sessionId}`,
        );
      }
    })().finally(() => {
      if (this.shellFlights.get(sessionId) === flight) this.shellFlights.delete(sessionId);
      this.host.onDebug?.(`cold shell flight cleared session=${sessionId}`);
    });
    this.shellFlights.set(sessionId, flight);
    return flight;
  }

  private async resume(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<MessageWithParts[] | undefined> {
    const resume = this.host.resumePersistedSession;
    if (!resume) {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active: ${sessionId}`,
      );
    }
    let outcome: ColdSessionResumeOutcome;
    try {
      outcome = workspace
        ? await resume.call(this.host, sessionId, resumeThoughtLevel, workspace)
        : await resume.call(this.host, sessionId, resumeThoughtLevel);
    } catch (error) {
      this.host.onError?.("v4.subscribe.resume", error, {
        phase: "resumePersistedSession",
        sessionId,
      });
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.resumeFailed",
        `Failed to resume persisted session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (outcome.status === "notFound") {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.sessionNotFound",
        `Session is not active and not persisted: ${sessionId}`,
      );
    }
    return outcome.persistedMessages;
  }
}
