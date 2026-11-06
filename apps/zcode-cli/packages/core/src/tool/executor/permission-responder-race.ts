// PermissionRequest hook 链与交互 broker 的并发竞速。
//
// 旧路径在 emitPermissionRequested 之后串行 await hook
// 链，broker 的应答 deferred 要等 hook 返回才注册。同步 hook（把权限请求转投外部 UI 并
// 阻塞等待外部点击的桥接程序）挂起期间，确认窗已对用户可见，但所有点击都被
// resolveInteraction 按「未命中即幂等成功」丢弃——确认窗永久死亡，turn 永久挂起。
// 修法：两个应答方并发启动、先到的决定生效、败者立即 abort 且不被等待。
import type {
  CollaborationMode,
  PermissionBrokerRequest,
  PermissionBrokerResult,
  PermissionRuleset,
  PermissionUpdate,
  TraceContext,
} from "@zcode/contracts";
import { traceContextToLogContext } from "@zcode/contracts";
import { CoreErrorType, createCoreError } from "@zcode/contracts";
import { linkAbortSignal } from "./timeout.js";
import type { PermissionDecisionResult } from "../../permission/service.js";
import { normalizeToolExecutionInput } from "../input-normalization.js";
import { runPermissionRequestHooks } from "./hook-flow.js";
import { recheckPermissionHookModifiedInput } from "./permission-input-recheck.js";
import { resolveRuntimePermissionContext } from "./permission-capability.js";
import { validateInput } from "./validation.js";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import type { resolveToolApproval } from "./approval-gate.js";

export interface PermissionResponderRaceInput {
  /**
   * hook 链应答方。resolve `undefined` 表示无决定（退赛，只剩 broker 单边等待）；
   * 抛错同样按退赛处理并回调 {@link PermissionResponderRaceInput.onHookFailure}——
   * 辅助应答方的基础设施故障不应替用户做拒绝决定。
   */
  runHooks: (signal: AbortSignal) => Promise<PermissionBrokerResult | undefined>;
  /**
   * broker 应答方。应答通道（v4 interaction deferred / TUI 审批队列）必须在本函数
   * 调用内同步建立——这是确认窗「可见即可答」的前提，由既有 broker 契约保证。
   * 拒绝（超时、取消、fail-closed）在 hook 未胜出时原样上抛，错误形态与旧串行路径一致。
   */
  requestBroker: (
    signal: AbortSignal,
    claimResponse: () => boolean,
  ) => Promise<PermissionBrokerResult>;
  /** 外层 turn 取消信号：abort 双方，随后 broker 的拒绝按上一条上抛。 */
  signal?: AbortSignal;
  /** hook 链抛错且竞速尚未收口时回调（调用方记 warn 日志）。 */
  onHookFailure?: (error: unknown) => void;
}

export interface PermissionResponderRaceOutcome {
  result: PermissionBrokerResult;
  source: "hook" | "broker";
}

export async function racePermissionResponders(
  input: PermissionResponderRaceInput,
): Promise<PermissionResponderRaceOutcome> {
  const hookController = new AbortController();
  const brokerController = new AbortController();
  const unlinkHook = linkAbortSignal(input.signal, hookController);
  const unlinkBroker = linkAbortSignal(input.signal, brokerController);

  let settled = false;
  let brokerClaimed = false;
  let rejectRace: ((error: unknown) => void) | undefined;
  let abortFallback: ReturnType<typeof setTimeout> | undefined;
  // 外层 turn 取消：两个应答方都 abort 之后，若 broker 自己的实现不理会 signal
  // （注册尚未完成、或桥接程序挂死），竞速会一直挂着。先让 broker 用它自己的拒绝收口
  // （它更清楚原因），一个宏任务后仍无人收口才由竞速补一个 ToolCancelled。
  const onOuterAbort = () => {
    if (settled || abortFallback !== undefined) return;
    abortFallback = setTimeout(() => {
      abortFallback = undefined;
      if (settled) return;
      settled = true;
      rejectRace?.(
        createCoreError(CoreErrorType.ToolCancelled, "Permission request was cancelled", {
          recoverable: true,
        }),
      );
    }, 0);
  };
  try {
    return await new Promise<PermissionResponderRaceOutcome>((resolve, reject) => {
      rejectRace = reject;
      if (input.signal?.aborted) {
        onOuterAbort();
        return;
      }
      input.signal?.addEventListener("abort", onOuterAbort, { once: true });
      const settle = (action: () => void, abortLoser: AbortController) => {
        if (settled) return;
        settled = true;
        action();
        // 先兑现结果再 abort 败者：败者的收尾（子进程终止、反向 RPC 取消）绝不能
        // 反过来阻塞胜者——挂死的就是败者本身。
        abortLoser.abort();
      };

      // broker 先启动：requestPermission 内同步注册应答 deferred，保证确认窗一可见
      // 用户点击就有归宿，不给 hook 留任何独占窗口期。
      input
        .requestBroker(brokerController.signal, () => {
          if (settled || brokerController.signal.aborted) return false;
          brokerClaimed = true;
          hookController.abort();
          return true;
        })
        .then(
          (result) => settle(() => resolve({ result, source: "broker" }), hookController),
          (error) => {
            // hook 胜出后我们主动 abort broker 产生的拒绝是自己的取消，吞掉；
            // 竞速未收口时的拒绝（超时/外层取消/fail-closed）是真实错误，原样上抛。
            settle(() => reject(error), hookController);
          },
        );

      input.runHooks(hookController.signal).then(
        (decision) => {
          // 无决定 = 退赛：不迁移竞速状态，broker 继续单边等待。
          if (decision === undefined || brokerClaimed) return;
          settle(() => resolve({ result: decision, source: "hook" }), brokerController);
        },
        (error) => {
          if (settled) return;
          input.onHookFailure?.(error);
        },
      );
    });
  } finally {
    if (abortFallback !== undefined) clearTimeout(abortFallback);
    input.signal?.removeEventListener("abort", onOuterAbort);
    unlinkHook();
    unlinkBroker();
  }
}


/**
 * `registered` 是挂在 requestPermission 返回值上的独立 promise：broker 自己的
 * timeoutMs / abort 只收口 pending，不保证这份登记承诺一定会结算。这里按同样的
 * 超时与取消兜底，否则第三方 broker 返回一个永不结算的 registered 会让请求永久挂起。
 * 取消不在这里造错误——交给 broker 自己的拒绝收口（它更清楚原因）。
 */
async function waitForBrokerRegistration(
  registered: Promise<void>,
  signal: AbortSignal,
  timeoutMs: number | undefined,
  context: { requestId: string; toolName: string },
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      action();
    }
    function onAbort(): void {
      finish(resolve);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        finish(() =>
          reject(
            createCoreError(
              CoreErrorType.PermissionTimeout,
              `Permission request timed out after ${timeoutMs}ms`,
              { context, recoverable: true },
            ),
          ),
        );
      }, timeoutMs);
    }
    // 登记失败原样上抛（与 await registered 旧语义一致）；成功只负责结束等待。
    registered.then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    );
  });
}

/** 改写前后是否同一份输入（用于识别"hook 改写了个寂寞"）。 */
function isSamePermissionInput(next: unknown, current: unknown): boolean {
  try {
    return JSON.stringify(next) === JSON.stringify(current);
  } catch {
    return false;
  }
}

export interface PermissionAskRaceOptions {
  deps: ToolExecutorDeps;
  toolCall: ExecutableToolCall;
  entry: ToolEntry;
  executionInput: unknown;
  permissionDecision: PermissionDecisionResult;
  suggestedPermissionUpdates: PermissionUpdate[] | undefined;
  approval: ReturnType<typeof resolveToolApproval>;
  requestId: string;
  mode: CollaborationMode;
  projectRules: PermissionRuleset | null;
  traceContext: TraceContext;
  signal?: AbortSignal;
  /** broker 已登记应答方、确认窗即将可见：此时才发布 PermissionRequested 事件。 */
  onBrokerRegistered?: () => Promise<void> | void;
  /** 重判后的重问：hook 已经在上一轮表态过，这一轮只等用户本人。 */
  skipHooks?: boolean;
  /**
   * 首次判权用的运行时上下文（mode / bashShellSelection / cwd 快照）。
   * hook 改写后的重判必须与首次判权同源，否则会按另一套 shell 文法或工作目录得出结论。
   */
  permissionContext?: ToolRuntimePermissionCapabilityContext;
}

export interface PermissionAskRaceOutcome {
  brokerResult: PermissionBrokerResult;
  normalizedHookModifiedInput?: unknown;
  useNormalizedHookModifiedInput: boolean;
  permissionDecision: PermissionDecisionResult;
  /**
   * hook 把输入改写成仍需审批的内容：调用方要关掉这次请求、拿新输入重新走确认窗。
   * 存在时 brokerResult 只是 fail-closed 的占位（不会被采用）。
   */
  rewriteInput?: unknown;
  /**
   * 重判后按改写后的输入重算的「始终允许」落盘建议；缺省表示沿用调用方入口算出的一份
   * （原始输入），调用方只能在字段存在时覆盖，避免把改写前的命令写进项目规则。
   */
  suggestedPermissionUpdates?: PermissionUpdate[];
}

/**
 * ask 应答内芯：hook 链与 broker 并发竞速 + PermissionRequest hook 的 modify
 * 改写输入复核（recheck）。抽自 permission-flow（行数红线）；抛错语义不变——
 * 由调用方的 catch 统一降级为 deny。hook 链故障只令其退赛的注释见上方
 * racePermissionResponders 头注。
 */
export async function runPermissionAskRace(
  options: PermissionAskRaceOptions,
): Promise<PermissionAskRaceOutcome> {
  const { deps, toolCall, entry, executionInput, permissionDecision, mode, traceContext } = options;
  // 首次判权 / 重判共用同一份上下文：caller 已准备好的那份（含 bashShellSelection 与
  // guarded 的 cwd 快照）优先，缺省才按 deps 现算。
  const runtimePermissionContext =
    options.permissionContext ?? resolveRuntimePermissionContext(deps);
  const raceOutcome = await racePermissionResponders({
    onHookFailure: (error) => {
      deps.logger?.warn("PermissionRequest hook chain failed; waiting for client decision", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "tool.permission.hook_race_forfeited",
        module: "core.tool.executor",
        requestId: options.requestId,
        status: "waiting",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
    },
    requestBroker: async (brokerSignal, claimResponse) => {
      const pending = deps.permissionBroker.requestPermission(
        {
          input: executionInput,
          mode,
          reason: permissionDecision.reason ?? `Tool ${toolCall.name} requires approval`,
          requestId: options.requestId,
          requestedAt: new Date(),
          riskLevel: permissionDecision.riskLevel,
          ruleId: permissionDecision.ruleId,
          sessionId: deps.sessionId,
          sideEffectScope: permissionDecision.sideEffectScope,
          suggestedPermissionUpdates: options.suggestedPermissionUpdates,
          // 单次确认要标在请求上：客户端据此只给「允许一次 / 拒绝」，
          // 不带出去就会变成一次普通 ask（可始终允许）。
          ...(permissionDecision.approvalMode
            ? { approvalMode: permissionDecision.approvalMode }
            : {}),
          ...(options.approval.optionsPolicy
            ? { optionsPolicy: options.approval.optionsPolicy }
            : {}),
          toolCallId: toolCall.id as PermissionBrokerRequest["toolCallId"],
          toolName: toolCall.name,
          traceId: traceContext.traceId,
          turnId: traceContext.turnId ?? deps.turnId,
        },
        { signal: brokerSignal, claimResponse, timeoutMs: deps.permissionTimeoutMs },
      );
      // broker 的实现可能在登记时就同步 reject（signal 已 abort），而调用方要等到
      // await registered 之后才回到这里；先挂一个空 catch，避免这段窗口里被判成未处理拒绝。
      void pending.catch(() => {});
      // requestPermission 内部同步登记应答 deferred，所以到这里确认窗才第一次可见；
      // 事件必须在登记之后再发，否则用户点得快会点在尚未登记的请求上（点击被幂等丢弃）。
      // 有些 broker 的登记是延迟的（返回的 promise 上挂 registered），要等它兑现再发；
      // 期间被取消就不再发布——取消后的确认窗不该出现在用户眼前。
      const registered = pending.registered;
      if (registered) {
        await waitForBrokerRegistration(registered, brokerSignal, deps.permissionTimeoutMs, {
          requestId: options.requestId,
          toolName: toolCall.name,
        });
      }
      if (brokerSignal.aborted) return pending;
      await options.onBrokerRegistered?.();
      return pending;
    },
    runHooks: async (hookSignal) => {
      // 重问轮：hook 上一轮已经表过态（正是它把输入改写成现在这份），再问一次只会
      // 得到同一个改写。这一轮直接退赛，把确认窗留给用户。
      if (options.skipHooks) return undefined;
      const hookDecision = await runPermissionRequestHooks(
        deps,
        toolCall,
        executionInput,
        options.requestId,
        permissionDecision,
        mode,
        traceContext,
        hookSignal,
      );
      // hook 把输入"改写"成当前这份输入 = 没有新信息。此时若按改写再问一轮，
      // 每轮都会得到同一个改写，确认窗永远轮不完；让 hook 退赛、由 broker 回答。
      // 比较要用规范化之后的形状：hook 交回来的是原始 input，和解析后的 executionInput
      // 直接比会永远不等，于是每轮都判成"又改了"。
      if (hookDecision?.decision === "modify") {
        const normalizedRewrite = normalizeToolExecutionInput({
          entry,
          input: hookDecision.modifiedInput ?? executionInput,
          logger: deps.logger,
          source: "permission",
        });
        if (isSamePermissionInput(normalizedRewrite, executionInput)) {
          // 这条分支没有事件可发（hook 主动退赛），只留日志：否则"hook 改了但等于没改"
          // 在日志里完全静默，排查确认窗为什么没重问时无从下手。
          deps.logger?.debug("Permission hook rewrote the input to the current input; ignoring", {
            ...traceContextToLogContext(traceContext),
            event: "tool.permission.hook_rewrite_ignored",
            module: "core.tool.executor",
            requestId: options.requestId,
            status: "waiting",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
          return undefined;
        }
      }
      return hookDecision;
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  let brokerResult = raceOutcome.result;
  let permissionDecisionNext = permissionDecision;
  let normalizedHookModifiedInput: unknown;
  let useNormalizedHookModifiedInput = false;
  const permissionHookResult = raceOutcome.source === "hook" ? raceOutcome.result : undefined;
  if (permissionHookResult?.decision === "modify") {
    normalizedHookModifiedInput = normalizeToolExecutionInput({
      entry,
      input: permissionHookResult.modifiedInput ?? executionInput,
      logger: deps.logger,
      source: "permission",
    });
    useNormalizedHookModifiedInput = true;
    if (!validateInput(normalizedHookModifiedInput, entry)) {
      // PermissionRequest hook 可以改写目标路径，修改后的输入不能沿用修改前的权限结果。
      const recheck = recheckPermissionHookModifiedInput({
        // 与首次判权同源：沿用同一份运行时上下文，无 preparedContext 时按 deps 快照构造。
        context: {
          ...runtimePermissionContext,
          workingDirectory:
            runtimePermissionContext.workingDirectory ?? deps.getWorkingDirectory(),
          workspaceRoot: runtimePermissionContext.workspaceRoot ?? deps.getWorkspaceRoot(),
        },
        deps,
        entry,
        mode,
        modifiedInput: normalizedHookModifiedInput,
        projectRules: options.projectRules,
        toolCall,
      });
      if (recheck.permissionDecision) {
        permissionDecisionNext = recheck.permissionDecision;
        if (recheck.permissionDecision.decision === "ask") {
          // 改写后的输入仍要用户点头：交回调用方重新走确认窗（新 requestId）。
          // 不能拿改写前的批准去执行改写后的输入。
          return {
            brokerResult: {
              decision: "deny",
              reason:
                recheck.permissionDecision.reason ??
                `Permission hook modified ${toolCall.name} input requires a new approval`,
            },
            normalizedHookModifiedInput,
            useNormalizedHookModifiedInput: false,
            permissionDecision: permissionDecisionNext,
            rewriteInput: normalizedHookModifiedInput,
            ...(recheck.suggestedPermissionUpdates === undefined
              ? {}
              : { suggestedPermissionUpdates: recheck.suggestedPermissionUpdates }),
          };
        }
        if (recheck.permissionDecision.decision === "deny") {
          // 改写后的输入被拒（项目 deny / memory-file deny）必须 fail-closed：
          // 降级成可点的确认窗等于把被 deny 的输入交回用户「允许一次」执行。
          brokerResult = {
            decision: "deny",
            reason:
              recheck.permissionDecision.reason ??
              `Permission hook modified ${toolCall.name} input is denied`,
          };
          useNormalizedHookModifiedInput = false;
        }
      }
    }
  }
  return {
    brokerResult,
    normalizedHookModifiedInput,
    useNormalizedHookModifiedInput,
    permissionDecision: permissionDecisionNext,
  };
}
