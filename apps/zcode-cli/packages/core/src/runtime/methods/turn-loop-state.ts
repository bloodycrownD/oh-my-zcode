import { OFF_PEAK_EXECUTION_TOOL_DENYLIST } from "@zcode/shared";
import type {
  MessageId,
  ModelStreamRecoveryStatus,
  Model,
  ModelSelection,
  OutputStylePromptConfig,
  SessionEvent,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";
import type { ActiveTurnSteeringState } from "../types.js";
import type { SubagentRunOptions } from "@zcode/contracts";
import type { DrainedPendingInputDiagnostics, ModelExecutionContext } from "../types.js";
import type { TurnMachineImpl } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

export type PendingStreamRecoveryRequest = ModelStreamRecoveryStatus;

export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;
const AUTOMATION_QUERY_ID_PREFIX = "automation-";
/**
/**
 * 无值班次派发轮隐藏的工具。
 * - SendMessage / Workflow：会在本轮 modelExecution 之外重新启动子 Agent（SendMessage 续跑
 *   已完成子 Agent、Workflow 派生脚本子会话），按父会话常驻选择建模型。
 *
 * 与 AUTOMATION_MUTATION_TOOL_NAMES 独立：cron automation turn 是本地定时能力，
 * 其派生与工具面隔离单独裁决，不受本名单影响。
 */
export const UNATTENDED_DISPATCH_DENIED_TOOL_NAMES = ["SendMessage", "Workflow"] as const;

// TODO(upgrade-316): 上游 3.16 新增的 turn-tool-visibility.ts（getTurnTools）依赖下面两个
// 闲时派发符号；fork 已整体移除官方闲时执行面，这里只保留判定形状以维持上游文件的类型
// 闭合，仓内没有任何生产者会触发该分支。若后续删除上游的闲时工具面，应连同本段一起删。
export const OFF_PEAK_MUTATION_TOOL_NAMES = OFF_PEAK_EXECUTION_TOOL_DENYLIST;
// 闲时派发 init 段 traceId 无固定前缀，只有 resume 段是 `${offPeakTaskId}:resume:*`
// （offpeak- 开头）；前缀只是 resume 兜底信号，主信号必须是显式闲时任务身份。
const OFF_PEAK_QUERY_ID_PREFIX = "offpeak-";

export interface TurnRequestState {
  entries: readonly RuntimeMessageEntry[];
  outputTokenContinuationCount: number;
}

export interface RegularTurnLoopState {
  offPeakExecutionId?: string;
  activeTurn?: ActiveTurnSteeringState;
  /** Host admission 显式传入的本轮 automation 身份；不能从持久 task metadata 推断。 */
  automationId?: string;
  /** CronCreate 命中全局上限后，本用户 turn 永久切为纯文本回复，禁止模型自行恢复。 */
  automationCreateLimitReached?: boolean;
  anomalyWarningsInjected: number;
  /** 本轮是否已消费来源为 subagent 的后台结果通知。 */
  backgroundSubagentResultConsumed: boolean;
  /** 本轮是否已消费来源为 workflow（dynamic-workflow run）的后台通知。 */
  workflowResultConsumed: boolean;
  currentUserMessageId: MessageId;
  drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
  events: SessionEvent[];
  input: string;
  inputId?: string;
  modelResponse: string;
  /** 本轮固定使用的可调用模型；配置变化只影响以后创建的 Loop。 */
  model: Model;
  /** execution 表示当前 Active Model 不能被同 loop 的 guide 改写。 */
  modelSelectionScope?: "execution";
  /** 本轮执行 Selection 的降级声明；命中一次后清空，退回后的模型不再二次降级。 */
  selectionFallback?: ModelExecutionContext["selectionFallback"];
  /** 请求期失败已命中退回声明但无可用退回目标；TurnError 归因据此发布，Renderer 作废匹配卡。 */
  highspeedFallbackUnavailable?: boolean;
  /** 仅加速卡过期回退使用的启动快照；不用于闲时换票。 */
  highspeedFallbackSelection?: ModelSelection;
  /** Core Server 的前台 child Selection override；优先于 profile 与父模型继承。 */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  modelStepCount: number;
  /** 当前 query 已成功写入 provider 可见持久历史的 assistant 产物数量。 */
  historyRoundCount: number;
  /** 上游新增：本轮是否已有一批真实 tool result 完整闭合，用于一次性注入项目记忆召回。 */
  completedRealToolResultBatch?: boolean;
  repeatedToolCallSignature?: string;
  repeatedToolCallStreakCount: number;
  pendingStreamRecoveryRequest?: PendingStreamRecoveryRequest;
  stopHookContinuationCount: number;
  /** 最终成功 product turn 的 raw transcript 起点；只有确认不再 continue 时才赋值。 */
  stableProductStartMessageId?: MessageId;
  /** 最终成功 assistant boundary；与 stableProductStartMessageId 成对出现。 */
  stableBoundaryAssistantMessageId?: MessageId;
  streamRecoveryRetryCount: number;
  tokenCount: number;
  toolCallCount: number;
  /** 当前 Turn 的 provider-local history；Turn 结束后直接释放。 */
  turnRequestState: TurnRequestState;
  /** 当前 turn 不向 provider 暴露的工具名；registry 仍保留，供执行边界做纵深校验。 */
  toolDisallowlist?: readonly string[];
  traceId: TraceId;
  turnAbortSignal: AbortSignal;
  turnId: TurnId;
  turnMachine: TurnMachineImpl;
  /** 当前 Turn 捕获的 provider-visible output style；不表示显式 subagent model override。 */
  turnOutputStyle?: OutputStylePromptConfig;
  turnTraceContext: TraceContext;
  userMessageId: MessageId;
}

export function isAutomationMutationRestrictedTurn(state: RegularTurnLoopState): boolean {
  if (state.automationId?.trim()) return true;
  if (state.turnTraceContext.queryId?.trim().startsWith(AUTOMATION_QUERY_ID_PREFIX)) return true;

  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  // active/busy automation 输入会把 turn-scoped denylist 合并进当前 loop；即使原始
  // automationId 不再是 loop 首输入，也必须把同一事实继续传到 handler 执行边界。
  return AUTOMATION_MUTATION_TOOL_NAMES.every((toolName) => disallowedTools.has(toolName));
}

/**
 * 本轮是否为无值班次派发 turn（无用户在场、结果自动回填）。
 *
 * 信号源与 isAutomationMutationRestrictedTurn 同构：显式 turn denylist 是主信号，
 * 兜底哨兵取 SendMessage（无值班次名单里第一个工具名）。
 *
 * 当前状态：闲时任务派发面已随官方端点全清移除，仓内没有生产者会为无值班次轮
 * 合并这份 denylist，因此恒返回 false——即普通交互轮与 cron automation 轮的既有
 * 行为完全不变。保留该判定是为了让 SendMessage / Bash 的 handler 级纵深守卫在
 * 未来新增无值班次执行面时不必重新打通整条字段链。
 */
export function isUnattendedDispatchTurn(state: RegularTurnLoopState): boolean {
  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  return disallowedTools.has(UNATTENDED_DISPATCH_DENIED_TOOL_NAMES[0]);
}

// TODO(upgrade-316): 上游 turn-tool-visibility.ts 的 getTurnTools 会调用本判定；fork 没有
// 闲时执行面，恒 false 之外的信号只做形状保留（见上方 OFF_PEAK_MUTATION_TOOL_NAMES 的说明）。
export function isOffPeakCreateRestrictedTurn(state: RegularTurnLoopState): boolean {
  if (state.offPeakExecutionId?.trim()) return true;
  if (state.turnTraceContext.queryId?.trim().startsWith(OFF_PEAK_QUERY_ID_PREFIX)) return true;
  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  return disallowedTools.has(OFF_PEAK_MUTATION_TOOL_NAMES[0]);
}

export function recordModelHistoryRound(state: RegularTurnLoopState): void {
  // toolCallCount 会把并行工具按数量展开，无法表达模型真正写入历史的轮次。
  // 调用点沿用既有 modelStepCount 的提交边界，额外累计历史轮次而不改变 loop 控制语义。
  state.historyRoundCount += 1;
}
