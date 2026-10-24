// 照搬上游 v3.16.2 lib/sourceServerUpdateAction.ts（53L，backlog-sweep Step 9 / P9-3）。
// omz 缺口登记：management.updateSource 走 Host 时 resolveRelease 尚未注入（Step 7-8 已知
// 缺口），因此本动作在真实 Host 上会落到 "release is unavailable" 错误面——面板把它按
// 普通错误码展示，不做伪造成功。
import { SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE } from "@zcode/shared";
import type { SourceServerManagementSnapshot, SourceServerUpdateTarget } from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export async function runSourceServerUpdate(options: {
  management: ISourceServerManagementService;
  profileId: string;
  expectedTarget?: SourceServerUpdateTarget;
  confirmForce: () => Promise<boolean>;
}): Promise<SourceServerManagementSnapshot | null> {
  try {
    return await options.management.updateSource({
      profileId: options.profileId,
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
      force: false,
    });
  } catch (error) {
    if (getErrorCode(error) !== SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE) {
      throw error;
    }
    // Bug 原因：版本 required 过去直接等价为 force update，会绕过运行中 Task guard。
    // 先受 guard 拒绝，再由用户明确确认中断，才能发送 force=true。
    if (!(await options.confirmForce())) return null;
    return await options.management.updateSource({
      profileId: options.profileId,
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
      force: true,
    });
  }
}

/** guard 拒绝后读取 Host 的活动投影；旧远端不支持时明确告知清单不可用。 */
export async function getSourceServerForceUpdateDescription(
  management: ISourceServerManagementService,
  profileId: string,
  formatMessage: (id: string) => string,
): Promise<string> {
  const snapshot = await management.getSnapshot();
  const tasks = snapshot.states.find((state) => state.profileId === profileId)?.runningTasks;
  return (
    formatMessage("settings.source.forceUpdateDescription") +
    "\n\n" +
    (tasks?.length
      ? tasks.map((task) => `${task.sessionId} — ${task.workspacePath}`).join("\n")
      : formatMessage("remote.runningTasksUnavailable"))
  );
}
