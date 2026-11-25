/**
 * fork 子会话的 magic-context 继承（宿主胶水）。
 *
 * 子会话首轮 turn 入口、heal 之前调用一次。规则本体在包内
 * （`inheritForkedSessionState`），这里只做三件事：取 fork 登记关系、从父会话的
 * 消息行里读出工具结果交给包（tool 类 tag 在 `source_contents` 里没有原文）、
 * 把结果写成日志。
 *
 * 继承是尽力而为：取不到登记、父会话没有可继承的东西、对齐不可信、包调用抛错，
 * 都只记日志，本轮 transform 照常进行——子会话退回到「没有任何继承」的行为。
 */

import type { SessionStorePort } from "@zcode/contracts";
import {
    inheritForkedSessionState,
    type ContextDatabase,
    type MessageLike,
    type ParentToolOutput,
} from "@zcode/magic-context";
import { takePendingForkParent } from "./session-fork-registry.js";

interface ForkInheritLogger {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
}

/** 父会话消息行里的 tool part → callID → 工具结果。父行里同一 callID 只会出现一次。 */
function toolOutputsOf(
    messages: ReadonlyArray<{ parts: readonly unknown[] }>,
): Map<string, ParentToolOutput> {
    const outputs = new Map<string, ParentToolOutput>();
    for (const message of messages) {
        for (const part of message.parts) {
            if (typeof part !== "object" || part === null) continue;
            const toolPart = part as {
                type?: unknown;
                callID?: unknown;
                tool?: unknown;
                state?: { output?: unknown } | null;
            };
            if (toolPart.type !== "tool") continue;
            if (typeof toolPart.callID !== "string" || outputs.has(toolPart.callID)) continue;
            const output = toolPart.state?.output;
            if (typeof output !== "string") continue;
            outputs.set(toolPart.callID, {
                toolName: typeof toolPart.tool === "string" ? toolPart.tool : "",
                output,
            });
        }
    }
    return outputs;
}

export async function inheritForkedSessionStateAtTurnStart(input: {
    db: ContextDatabase;
    sessionId: string;
    /** 本轮 transform 要用的同一份投影。 */
    childMessages: readonly MessageLike[];
    sessionStore: Pick<SessionStorePort, "messages"> | undefined;
    logger: ForkInheritLogger;
}): Promise<void> {
    const { db, sessionId, childMessages, sessionStore, logger } = input;
    const parentSessionId = takePendingForkParent(sessionId);
    if (parentSessionId === undefined) return;
    if (parentSessionId === sessionId) return;

    try {
        let parentToolOutputs: Map<string, ParentToolOutput> | undefined;
        if (sessionStore !== undefined) {
            try {
                const parentMessages = await sessionStore.messages({
                    sessionID: parentSessionId as never,
                });
                parentToolOutputs = toolOutputsOf(parentMessages);
            } catch (error) {
                // 读不到父会话的消息行只是丢掉 tool 类 tag 的继承，文本类的仍然可以对齐。
                logger.warn("Magic context fork inherit: parent tool outputs unavailable", {
                    sessionId,
                    parentSessionId,
                    detail: error instanceof Error ? error.message : String(error),
                });
            }
        }
        const result = inheritForkedSessionState({
            db,
            parentSessionId,
            childSessionId: sessionId,
            childMessages,
            ...(parentToolOutputs === undefined ? {} : { parentToolOutputs }),
        });
        const context = { sessionId, parentSessionId, ...result };
        // 「父会话没有可继承的东西」是正常情形（父会话很短、还没折叠过），不是异常。
        const benign = new Set(["parent-has-no-tags", "nothing-to-inherit"]);
        const notFullyInherited =
            result.kind === "tags-only" ||
            (result.kind === "skipped" && !benign.has(result.reason));
        if (notFullyInherited) {
            logger.warn("Magic context fork inherit: not fully inherited", context);
        } else {
            logger.info("Magic context fork inherit", context);
        }
    } catch (error) {
        logger.warn("Magic context fork inherit: failed", {
            sessionId,
            parentSessionId,
            detail: error instanceof Error ? error.message : String(error),
        });
    }
}
