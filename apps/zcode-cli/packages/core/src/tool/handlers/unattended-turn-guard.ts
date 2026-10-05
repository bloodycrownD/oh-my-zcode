// ============================================================
// 无值班次派发守卫（中立位置）
// ============================================================
// 历史沿革：此守卫最初挂在 core/src/tool/handlers/off-peak.ts，判定信号是闲时任务
// 派发轮（context.offPeakTurn）。闲时任务整链已随官方端点全清移除，off-peak.ts 与
// offPeakTurn 字段链（runtime/types → tool/types → executor/types → call-runner →
// batch-runner → turn-tools → streaming-tool-coordinator）同步删除。
//
// 保留原因（C 报告 T1）：SendMessage / Bash 的纵深防护依赖这个「本轮是无值班次执行、
// 不是用户在前台交互」的判定。它与闲时任务的具体协议无关，是所有无值班次派发场景的
// 共性约束，因此改挂本中立模块，并把信号改名为主动语义的 unattendedDispatchTurn。
//
// 当前状态：闲时派发面已删除，本仓库内没有生产者会置该标记为 true，因此守卫恒放行
// （与删除前对普通交互轮的行为完全一致）。保留接口是为后续新增的无值班次执行面
// （如未来的定时/批处理派发）预留同一道纵深防护位置：provider denylist 只是可见性
// 约束，异常 provider 仍可能直接提交工具，handler 层必须有最终拒绝。

import { CoreErrorType, createCoreError } from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";

/**
 * 无值班次派发轮的 handler 级拒绝（turn denylist 之外的第二层纵深）。
 * provider denylist 只是可见性约束；异常 provider 仍可能直接提交。handler 以
 * executor 传入的本轮事实做最终拒绝。
 *
 * 注意：刻意不检查 automationTurn——cron automation 自动轮是本地定时能力，
 * 其派生与工具面隔离由 isAutomationMutationRestrictedTurn / automation 轮 denylist
 * 单独裁决，不在本守卫范围内。
 *
 * SendMessage / Workflow 复用本函数——它们会绕开本轮 modelExecution 重新启动子
 * Agent 并落到用户套餐；拒绝时给模型可恢复的替代路径提示。
 */
export function assertNotUnattendedDispatchTurn(
  context: ToolExecutionContext,
  toolName: string,
  options?: { hint?: string; recoverable?: boolean },
): void {
  if (!context.unattendedDispatchTurn) return;
  const hint = options?.hint ? ` ${options.hint}` : "";
  throw createCoreError(
    CoreErrorType.PermissionDenied,
    `${toolName} is not allowed while running an unattended dispatch turn.${hint}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: options?.recoverable ?? false,
      retryable: false,
    },
  );
}