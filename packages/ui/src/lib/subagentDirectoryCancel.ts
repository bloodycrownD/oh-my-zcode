// 子智能体目录页「停止」按钮的可见性判据（bugfix-batch-20261009 / ③ 3c）。
// 放在 lib 而非 .tsx 里：packages/ui/test 的 node:test 基建对 .tsx 的依赖链
// （@/components/ui/button.tsx 等）不可加载，纯 model 模块才能进 test:v4-perf。
import type { ZCodeSessionEndedSubagent, ZCodeSessionRunningSubagent } from "@zcode/shared";

export type SubagentDirectoryItem = ZCodeSessionRunningSubagent | ZCodeSessionEndedSubagent;

/**
 * 目录行「停止」按钮的目标 workId；null = 该行不渲染停止按钮。
 *
 * 三道门缺一不可：上游未放行取消（只读 pane，cancellable=false）、行不在 running
 * 状态、agentId 缺席（协议里 optional，构造不出 runtime stopTask 的 taskId）。与
 * 状态面板的 controlWorkId 回退（conversationStatusPanelModel：仅 running 且
 * agentId 存在才给控制句柄）保持同口径。
 */
export function resolveDirectoryRowCancelWorkId(
  item: SubagentDirectoryItem,
  cancellable: boolean,
): string | null {
  if (!cancellable) return null;
  if (item.status !== "running") return null;
  return item.agentId ?? null;
}
