import type { ZCodeTaskListKind, ZCodeTaskListSortBy } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { resolveWorkspaceStateKey } from "@/store/zcodeSessionStoreSelectors.js";

export type TaskEntityKey = string;
export type TaskListCacheKey = string;
export type TaskListQueryKind = ZCodeTaskListKind | "workspace";

export interface TaskListCacheDescriptor {
  kind: TaskListQueryKind;
  sortBy: ZCodeTaskListSortBy;
  search: string;
  expanded: boolean;
  visibleLimit: number | null;
  workspaceKeys: string[];
}

export interface CachedTaskListResult {
  taskKeys: TaskEntityKey[];
  /** workspace 分页前的完整未读成员；其它列表查询可省略。 */
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  fetchedAt: number;
  /** 每次 query scope 失效都递增；旧异步结果只能提交到它启动时观察到的代次。 */
  invalidationVersion: number;
  stale: boolean;
  partial: boolean;
  loadingShardKeys: string[];
  failedShardKeys: string[];
  descriptor: TaskListCacheDescriptor;
}

export function buildTaskWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
}

export function buildTaskEntityKey(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
): TaskEntityKey {
  return `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}::${task.taskId}`;
}
