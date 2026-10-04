/**
 * 逐字移植自 `.reference/magic-context/packages/plugin/src/tools/ctx-reduce/tools.ts`
 * （288 行），含 `commandIdForInvocation` 的幂等键逻辑（T-M11）。
 *
 * 剥离两处（SPEC 明确「不搬」）：
 *
 *   1. `@opencode-ai/plugin` 的 `tool()` / `ToolDefinition` 运行时值导入 → 本文件用
 *      `./tool-definition.ts` 的 `CtxToolDefinition` + `toolSchema`（zod）。
 *   2. `plugin/rust-tool-backends` 的 `RustToolBackends` 类型导入（type-only 亦不搬）
 *      → 随之删掉 `deps.rustToolBackends` 与它那整个 `rustReduce` 分支：fork 没有
 *      Rust 模块，pending ops 就是真身排队面。
 *
 * **幂等语义因此换了实现位置，而不是被丢弃。** 上游把 `commandIdForInvocation` 交给
 * Rust 模块，由模块按 commandId 去重；fork 没有那一层，于是去重落回工具自身：
 * `commandIdLedger` 用同一个 commandId 记住「这次调用已经排过队」，重复的
 * commandId 直接回放当初的确认文本，绝不二次入队。键的推导逻辑逐字未改
 * （callID → `oc-<session>-<callID>`，超过 128 字节取 sha256；无 callID 时走
 * 单调序号），所以同一条不变式在两侧都成立。
 *
 * 其余逻辑（range 解析、未知 tag、protected window、inert whitespace、compacted
 * 冲突、事务化入队、held/immediate 的措辞分流）逐字保留。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import { createHash } from "node:crypto";

import { getProtectionWindowForSession } from "../../features/magic-context/protection-window.js";
import type { ProtectionWindowResult } from "../../features/magic-context/protection-window.js";
import { parseRangeString } from "../../features/magic-context/range-parser.js";
import {
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage.js";
import { getInertWhitespaceAssistantTags } from "../../features/magic-context/storage-tags.js";
import { BoundedSessionMap } from "../../shared/bounded-session-map.js";
import { getErrorMessage } from "../../shared/error-message.js";
import type { Database } from "../../shared/sqlite.js";
import { renderCapabilityRefusal } from "../../shared/user-facing-codes.js";
import { type CtxToolContext, type CtxToolDefinition, toolSchema } from "../tool-definition.js";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args.js";
import { CTX_REDUCE_DESCRIPTION } from "./constants.js";
import type { CtxReduceArgs } from "./types.js";

export interface CtxReduceToolDeps {
    db: Database;
    /**
     * Union projection form: protectedSet (tag-number set form).
     * Coordinate space: tag-number space.
     * Empty-window behavior: empty set means zero tool tags are protected by the window;
     * requested drops apply immediately, and non-tool tags are never reclaim targets.
     */
    protectedSet?: ReadonlySet<number> | ((sessionId: string) => ReadonlySet<number>);
    getProtectionWindow?: (sessionId: string) => ProtectionWindowResult;
    floor?: number;
    getSessionTokens?: (sessionId: string) => number;
}

function formatRawDropForAck(rawDrop: string): string {
    return rawDrop
        .trim()
        .split(",")
        .map((token) => {
            const trimmed = token.trim();
            return /^\d+$/.test(trimmed) ? `§${trimmed}§` : trimmed;
        })
        .join(", ");
}

const ctxReduceArgsShape = {
    drop: toolSchema
        .string()
        .optional()
        .describe('Tag IDs to drop: "3-5", "1,2,9", "1-5,8,12-15".'),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxReduceArgsSchema = toolSchema.object(ctxReduceArgsShape).passthrough();

function createCtxReduceTool(deps: CtxReduceToolDeps): CtxToolDefinition<CtxReduceArgs> {
    let fallbackCommandSequence = 0;

    const commandIdForInvocation = (sessionId: string, toolContext: unknown): string => {
        const context =
            toolContext !== null && typeof toolContext === "object"
                ? (toolContext as Record<string, unknown>)
                : {};
        const callId =
            (typeof context.callID === "string" && context.callID.trim()) ||
            (typeof context.callId === "string" && context.callId.trim());
        if (callId) {
            const stableId = `oc-${sessionId}-${callId}`;
            if (Buffer.byteLength(stableId) <= 128) return stableId;
            return `oc-${createHash("sha256").update(stableId).digest("hex")}`;
        }
        fallbackCommandSequence += 1;
        const monotonicId = `oc-${sessionId}-${fallbackCommandSequence}`;
        return Buffer.byteLength(monotonicId) <= 128
            ? monotonicId
            : `oc-${createHash("sha256").update(monotonicId).digest("hex")}`;
    };

    /**
     * T-M11：命令幂等账本。键是 `commandIdForInvocation` 的输出，值是那次调用已经回给
     * 模型的确认文本。重复的 commandId 命中即回放，绝不二次入队——这就是上游 Rust
     * 模块用 commandId 提供的同一条不变式，在没有那一层时由工具自身承担。
     */
    const commandIdLedger = new BoundedSessionMap<string>(2000);

    return {
        description: CTX_REDUCE_DESCRIPTION,
        args: ctxReduceArgsShape,
        async execute(rawArgs: CtxReduceArgs, toolContext: CtxToolContext): Promise<string> {
            const parsedArgs = ctxReduceArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxReduceArgs;
            args = unwrapImitatedReducedArgs(args, ["drop"], { drop: "string" });
            const sessionId = toolContext.sessionID;

            if (!args.drop) {
                return "Error: 'drop' must be provided.";
            }

            // 幂等闸门在参数校验之后、取任何 db 写之前：一次已确认过的 commandId 重放
            // 上次的确认文本，pending_ops 一行都不多。
            const commandId = commandIdForInvocation(sessionId, toolContext);
            const settled = commandIdLedger.get(commandId);
            if (settled !== undefined) {
                return settled;
            }

            let dropIds: number[] = [];

            try {
                dropIds = parseRangeString(args.drop);
            } catch (e) {
                return `Error: Invalid range syntax. ${(e as Error).message}`;
            }

            const allIds = [...new Set(dropIds)];

            const allTags = getTagsBySession(deps.db, sessionId);
            const foundSet = new Set(allTags.map((tag) => tag.tagNumber));
            const unknownIds = allIds.filter((id) => !foundSet.has(id));
            if (unknownIds.length > 0) {
                return `Error: Unknown tag(s) ${formatIds(unknownIds)}. Check available tags in conversation.`;
            }

            // Form: protectedSet (tag-number set form). Coordinate space: tag-number space.
            // Empty-window behavior: empty set means zero tool tags are protected by the window;
            // non-tool tags never become reclaim targets.
            let protectedSet: ReadonlySet<number>;
            if (deps.protectedSet) {
                protectedSet =
                    typeof deps.protectedSet === "function"
                        ? deps.protectedSet(sessionId)
                        : deps.protectedSet;
            } else if (deps.getProtectionWindow) {
                protectedSet = deps.getProtectionWindow(sessionId).protectedTagNumbers;
            } else {
                protectedSet = getProtectionWindowForSession(
                    deps.db,
                    sessionId,
                    deps.floor,
                ).protectedTagNumbers;
            }

            const tagStatusMap = new Map(allTags.map((tag) => [tag.tagNumber, tag.status]));
            const inertWhitespaceTagNumbers = new Set(
                getInertWhitespaceAssistantTags(deps.db, sessionId).map((tag) => tag.tagNumber),
            );
            const inertDropIds = [
                ...new Set(dropIds.filter((id) => inertWhitespaceTagNumbers.has(id))),
            ];
            const inertNote =
                inertDropIds.length > 0
                    ? `Skipped: ${inertDropIds
                          .map((id) => `§${id}§ is provider framing, nothing to reclaim`)
                          .join("; ")}.`
                    : "";

            const pendingOps = getPendingOps(deps.db, sessionId);
            const pendingMap = new Map(pendingOps.map((op) => [op.tagId, op.operation]));

            const conflicts: string[] = [];
            for (const id of dropIds) {
                if (tagStatusMap.get(id) === "compacted" && !inertWhitespaceTagNumbers.has(id)) {
                    conflicts.push(`§${id}§ is from before compaction`);
                }
            }
            if (conflicts.length > 0) {
                return `Error: Conflicting operations — ${conflicts.join("; ")}.`;
            }

            const preFilterDropCount = dropIds.length;
            dropIds = dropIds.filter(
                (id) =>
                    !inertWhitespaceTagNumbers.has(id) &&
                    tagStatusMap.get(id) !== "dropped" &&
                    pendingMap.get(id) !== "drop",
            );
            const skippedCount = preFilterDropCount - dropIds.length;

            if (dropIds.length === 0) {
                return settle(
                    [
                        inertNote,
                        "All requested tags were already queued or processed. No new action is needed.",
                    ]
                        .filter(Boolean)
                        .join(" "),
                );
            }

            try {
                deps.db
                    .transaction(() => {
                        const now = Date.now();
                        for (const id of dropIds) {
                            queuePendingOp(deps.db, sessionId, id, "drop", now);
                        }
                    })
                    .immediate();
            } catch (error) {
                const errorMessage = getErrorMessage(error);
                return `Error: Failed to queue ctx_reduce operations. ${errorMessage}`;
            }

            const currentInputTokens =
                deps.getSessionTokens?.(sessionId) ??
                getOrCreateSessionMeta(deps.db, sessionId).lastInputTokens;
            updateSessionMeta(deps.db, sessionId, { lastNudgeTokens: currentInputTokens });

            const immediateDropIds = dropIds.filter((id) => !protectedSet.has(id));
            const deferredDropIds = [...new Set(dropIds.filter((id) => protectedSet.has(id)))];
            const skippedNote =
                skippedCount > 0
                    ? ` ${skippedCount} requested tag${skippedCount === 1 ? " was" : "s were"} already queued and need no action.`
                    : "";

            let heldSentence = "";
            if (deferredDropIds.length === 1) {
                heldSentence = `Held: §${deferredDropIds[0]} is inside the protected working set; it applies once newer work displaces it.`;
            } else if (deferredDropIds.length > 1) {
                heldSentence = `Held: ${deferredDropIds.map((id) => `§${id}`).join(", ")} are inside the protected working set; they apply once newer work displaces them.`;
            }

            if (immediateDropIds.length > 0 && heldSentence.length > 0) {
                return settle(
                    `Queued: drop ${formatIds(immediateDropIds)}.${skippedNote}${inertNote ? ` ${inertNote}` : ""} ${heldSentence}`,
                );
            }
            if (immediateDropIds.length > 0) {
                return settle(
                    `Queued: drop ${formatIds(immediateDropIds)}.${skippedNote}${inertNote ? ` ${inertNote}` : ""}`,
                );
            }
            if (heldSentence.length > 0) {
                return settle(
                    `${heldSentence}${skippedNote}${inertNote ? ` ${inertNote}` : ""}`,
                );
            }
            return settle(
                `Queued: drop ${formatIds(dropIds)}.${skippedNote}${inertNote ? ` ${inertNote}` : ""}`,
            );

            /** 记入幂等账本并回给调用方。 */
            function settle(text: string): string {
                commandIdLedger.set(commandId, text);
                return text;
            }
        },
    };
}

function formatIds(ids: number[]): string {
    return ids.map((id) => `§${id}§`).join(", ");
}

export function createCtxReduceTools(
    deps: CtxReduceToolDeps,
): Record<string, CtxToolDefinition<CtxReduceArgs>> {
    return {
        ctx_reduce: createCtxReduceTool(deps),
    };
}