// 照搬上游 v3.16.2 project-sidebar/grouped/ids.ts（upstream-v316-fullsync P4.1 分组视角批；omz 化差异见文件内注释）
import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";

import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

function taskKey(
  task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
): string {
  return `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}\u0000${task.taskId}`;
}

export { taskKey };
