export type TrajectoryVisualRole =
  | "system"
  | "user"
  | "assistant"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  // 回合外壳（B-1/B-8）：不是 wire 消息角色，是「自定义展开」里的回合级命令槽，
  // 让「全部展开/收起」与逐回合展开共用同一条命令版本通道。
  | "turn";

const roleTextClasses: Record<TrajectoryVisualRole, string> = {
  system: "text-foreground-subtle",
  user: "text-trajectory-user/80",
  assistant: "text-trajectory-assistant/80",
  reasoning: "text-trajectory-reasoning/80",
  "tool-call": "text-trajectory-tool-call/80",
  "tool-result": "text-trajectory-tool-result/80",
  turn: "text-foreground",
};

export function trajectoryRoleTextClass(role: TrajectoryVisualRole): string {
  return roleTextClasses[role];
}
