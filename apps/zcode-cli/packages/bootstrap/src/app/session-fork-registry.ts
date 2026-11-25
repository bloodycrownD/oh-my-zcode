/**
 * fork 子会话登记表（进程内）。
 *
 * `registerForkedSession` 是所有 fork 路径（旧版 `session/fork`、V4 稳定 fork、编辑
 * 重发的 fork 分支、selection 侧聊）在宿主侧的唯一收口。子会话落库后、`resume()`
 * 之前在这里登记「它的父会话是谁」，供子会话首轮 turn 入口取用一次。
 *
 * 只登记事实，不携带任何下游用途的概念，也不 import magic-context：这是 fork 与
 * 继承之间的防腐层，下游怎么用这份关系由下游自己决定。
 *
 * 进程在 fork 与子会话首轮之间退出时登记会丢失；这是可接受的降级——下游拿不到
 * 登记就按「没有这回事」处理，行为与登记之前完全一致。
 */

const pendingForks = new Map<string, string>();

export function noteForkedSession(parentSessionId: string, childSessionId: string): void {
    pendingForks.set(childSessionId, parentSessionId);
}

/** 取出并移除子会话的父会话 ID；每个子会话在每个进程里只能取到一次。 */
export function takePendingForkParent(childSessionId: string): string | undefined {
    const parentSessionId = pendingForks.get(childSessionId);
    pendingForks.delete(childSessionId);
    return parentSessionId;
}

/** 仅供测试重置进程内状态。 */
export function clearForkRegistryForTests(): void {
    pendingForks.clear();
}
