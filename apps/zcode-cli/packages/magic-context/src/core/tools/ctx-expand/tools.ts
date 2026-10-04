/**
 * 逐字移植自 `.reference/magic-context/packages/plugin/src/tools/ctx-expand/tools.ts`
 * （147 行，import 路径加 `.js` 后缀）。
 *
 * 剥离一处（SPEC 明确「不搬」）：`@opencode-ai/plugin` 的 `tool()` / `ToolDefinition`
 * 运行时值导入 → 本文件用 `./tool-definition.ts` 的 `CtxToolDefinition` + `toolSchema`。
 * 参数形状、passthrough 解析、mode 分派、compartment 边界钳制、verbose 预算截断、
 * 继续提示全部逐字保留。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage.js";
import type { ContextDatabase } from "../../features/magic-context/storage.js";
import { readSessionChunk } from "../../hooks/magic-context/read-session-chunk.js";
import { type CtxToolContext, type CtxToolDefinition, toolSchema } from "../tool-definition.js";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args.js";
import { CTX_EXPAND_DESCRIPTION, CTX_EXPAND_TOKEN_BUDGET } from "./constants.js";
import { resolveCtxExpandMode } from "./mode.js";
import { renderItemByTag, renderMessageByOrdinal, renderVerboseRange } from "./render.js";
import type { CtxExpandArgs } from "./types.js";

export interface CtxExpandToolDeps {
    db: ContextDatabase;
}

const ctxExpandArgsShape = {
    tag: toolSchema
        .union([toolSchema.number(), toolSchema.string()])
        .optional()
        .describe(
            "Tag number from a §N§ tag or a [dropped §N§] placeholder, not a message ordinal. Returns that one item in full. Use alone.",
        ),
    start: toolSchema
        .number()
        .optional()
        .describe(
            "First message ordinal of the range (a <session-history> heading's start, or a ctx_search hit), not a tag number.",
        ),
    end: toolSchema
        .number()
        .optional()
        .describe("Last message ordinal of the range, inclusive, not a tag number."),
    verbose: toolSchema
        .boolean()
        .optional()
        .describe(
            "With start/end: one entry per message with ordinal and per-part preview instead of the transcript.",
        ),
    message: toolSchema
        .number()
        .optional()
        .describe(
            "Message ordinal from a <session-history> heading or a ctx_search hit, not a tag number. Returns that one message in full. Use alone.",
        ),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxExpandArgsSchema = toolSchema.object(ctxExpandArgsShape).passthrough();

function createCtxExpandTool(deps: CtxExpandToolDeps): CtxToolDefinition<CtxExpandArgs> {
    return {
        description: CTX_EXPAND_DESCRIPTION,
        args: ctxExpandArgsShape,
        async execute(rawArgs: CtxExpandArgs, toolContext: CtxToolContext): Promise<string> {
            const parsedArgs = ctxExpandArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxExpandArgs;
            args = unwrapImitatedReducedArgs(args, ["tag", "message", "start"], {
                start: "number",
                end: "number",
                verbose: "boolean",
                message: "number",
            });
            const sessionId = toolContext.sessionID;
            const mode = resolveCtxExpandMode(args, "positive");
            if (mode.kind === "error") {
                return mode.message;
            }
            if (mode.kind === "tag") {
                return renderItemByTag(deps.db, sessionId, mode.tag);
            }
            if (mode.kind === "message") {
                return renderMessageByOrdinal(sessionId, mode.message);
            }
            const { start, end, verbose } = mode;

            // Clamp the range to the last compartment boundary, mirroring
            // ctx_search: anything after that boundary is the live tail the
            // agent already sees in context, so re-reading it just burns output
            // tokens and duplicates visible content. -1 means "no compartments
            // yet" → nothing is compacted, so don't clamp.
            const lastCompartmentEnd = getLastCompartmentEndMessage(deps.db, sessionId);
            if (lastCompartmentEnd >= 0 && start > lastCompartmentEnd) {
                return `Range ${start}-${end} is entirely within the live tail (after the last compacted message ${lastCompartmentEnd}); those messages are already visible in context.`;
            }
            const effectiveEnd = lastCompartmentEnd >= 0 ? Math.min(end, lastCompartmentEnd) : end;

            // Verbose mode: each message separate, with ids + per-part previews.
            if (verbose) {
                const v = renderVerboseRange(
                    sessionId,
                    start,
                    effectiveEnd,
                    CTX_EXPAND_TOKEN_BUDGET,
                );
                if (!v.text) {
                    return `No messages found in range ${start}-${effectiveEnd}. The range may be outside this session's history.`;
                }
                const out = [
                    `Messages ${start}-${v.lastOrdinal} (verbose). Recover any one in full with ctx_expand(message=<ordinal>):`,
                    "",
                    v.text,
                ];
                if (v.truncated) {
                    out.push(
                        "",
                        `Truncated at message ${v.lastOrdinal} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${v.lastOrdinal + 1} end=${effectiveEnd} verbose=true for more.`,
                    );
                }
                return out.join("\n");
            }

            const chunk = readSessionChunk(
                sessionId,
                CTX_EXPAND_TOKEN_BUDGET,
                start,
                effectiveEnd + 1, // readSessionChunk uses exclusive end
            );

            if (!chunk.text || chunk.messageCount === 0) {
                return `No messages found in range ${start}-${end}. The range may be outside this session's history.`;
            }

            const lines: string[] = [];
            lines.push(
                `Messages ${chunk.startIndex}-${chunk.endIndex} (${chunk.messageCount} messages, ~${chunk.tokenEstimate} tokens):`,
            );
            lines.push("");
            lines.push(chunk.text);

            if (chunk.endIndex < effectiveEnd) {
                lines.push("");
                lines.push(
                    `Truncated at message ${chunk.endIndex} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${chunk.endIndex + 1} end=${effectiveEnd} for more.`,
                );
            }

            return lines.join("\n");
        },
    };
}

export function createCtxExpandTools(
    deps: CtxExpandToolDeps,
): Record<string, CtxToolDefinition<CtxExpandArgs>> {
    return {
        ctx_expand: createCtxExpandTool(deps),
    };
}