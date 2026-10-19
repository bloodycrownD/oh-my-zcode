import {
    getPendingOps,
    getTagById,
    removePendingOp,
    updateTagStatus,
} from "../../features/magic-context/storage.js";
import { getErrorMessage } from "../../shared/error-message.js";
import { sessionLog } from "../../shared/logger.js";
import type { Database } from "../../shared/sqlite.js";

export function executeFlush(db: Database, sessionId: string): string {
    try {
        const pendingOps = getPendingOps(db, sessionId);

        if (pendingOps.length === 0) {
            return "No pending operations to flush.";
        }

        let dropped = 0;

        db.transaction(() => {
            for (const op of pendingOps) {
                // FORK（magic-context-system-prompt-guard 防线二补丁）：`executeFlush`
                // 是上游零调用死码，但直写 dropped 的路径若未来被复活会绕过 apply
                // 守卫。system tag 直接跳过该 op：不置 dropped、不计入 dropped 计数、
                // 不删队列项（留队由 applyPendingOperations 的 system_protected 语义
                // 处理）。已知限制：本函数没有 targets 上下文，判据只看
                // `tags.message_role`——升级首 pass 前/克隆后列尚为 NULL 的 system
                // 行不在守卫内，依赖 tagMessages 下一 pass 的 stamp 回填（死码 + 防线
                // 二/三的 target 兜底在先，接受此口径）。
                if (getTagById(db, sessionId, op.tagId)?.messageRole === "system") {
                    continue;
                }
                updateTagStatus(db, sessionId, op.tagId, "dropped");
                removePendingOp(db, sessionId, op.tagId);
                dropped++;
            }
        }).immediate();

        // FORK（magic-context-system-prompt-guard，guards/B-1）：系统提示词守卫让
        // 全 system 队列的 dropped 保持 0；无条件输出计数，避免出现
        // `Flushed: . Changes take effect...` 的畸形确认文案（守卫前不可达）。
        const parts: string[] = [`${dropped} dropped`];

        return `Flushed: ${parts.join(", ")}. Changes take effect on next message.`;
    } catch (error) {
        sessionLog(sessionId, "ctx-flush failed:", error);
        return `Error: Failed to flush context operations. ${getErrorMessage(error)}`;
    }
}
