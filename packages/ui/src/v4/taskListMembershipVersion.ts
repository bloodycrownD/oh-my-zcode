// tasks-index 行/membership 权威版本号。
// sessions-index 只承载列表活性与 detail；task create/delete 以及 pin/archive/unread 等组织态
// 持久化在 tasks-index.sqlite，派生列表无法从 sessions 变化感知正向行或归属变化。
// mutation 提交后 bump 这里的版本号，让所有 task-row 左表 + session detail join 重新读取再过滤。
let version = 0;
const listeners = new Set<() => void>();

/** task row 或 membership mutation 后调用：通知所有 sessions-index 派生列表重新拉取左表。 */
export function bumpTaskListMembershipVersion(): void {
  version += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}
