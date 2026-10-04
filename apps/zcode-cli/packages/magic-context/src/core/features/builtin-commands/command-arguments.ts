/**
 * Step 21 真身替换：`deferred/builtin-commands.ts` 的**参数校验器**一半。
 *
 * 逐字来自 `.reference/magic-context/packages/plugin/src/hooks/magic-context/
 * command-handler.ts:96-174`（`RECOMP_USAGE` / `parseRecompArgs` / `parseWrapupArgs` /
 * `commandArgumentValidators` / `acceptsMagicContextCommandArguments`）。
 *
 * **为什么落在 `features/builtin-commands/` 而不是源路径 `hooks/magic-context/
 * command-handler.ts`**：`command-handler.ts` 整个文件按 SPEC 不搬——它的主体是
 * OpenCode 的命令派发 + Effect 204 sentinel（`throwSentinel` 那只鸭子类型的
 * `HttpServerResponse.empty({status:204})`），在 ZCode 侧由 Step 22 的
 * `cli/src/command-center/handlers/ctx.ts` 以本地命令语义重写。只把这一段**纯校验**
 * 的逻辑搬过来，是因为它仍是 `stripped-command.ts` 的安全相关谓词：
 * `matchStrippedMagicContextCommand` 用它决定一个丢了前导斜杠的 Desktop prompt
 * 是「一条 magic-context 命令，该重新派发」还是「一条普通用户消息，该原样放行」。
 * 打桩的校验器会放行真 handler 会拒绝的参数，两个方向都错。
 *
 * `/ctx-dream <task>` 的参数形如故返回 `false`：dreamer task registry 是 Batch 2，
 * `isCanonicalDreamTask` 不可问。参数形因此作为散文透传而不是被派发——这是保守的一臂；
 * 反过来（对每个参数都 `true`）会把任意用户散文送进一个随后只会报解析错的 handler。
 *
 * Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.
 */

import type { MagicContextBuiltinCommandName } from "./commands.js";

const RECOMP_USAGE = "Usage: `/ctx-recomp [full | <start>-<end>]`";

function parseRecompArgs(raw: string):
    | { kind: "full" }
    | { kind: "upgrade" }
    | { kind: "partial"; range: { start: number; end: number } }
    | { kind: "error"; message: string } {
    const trimmed = raw.trim();
    if (trimmed === "") return { kind: "full" };
    if (trimmed === "--upgrade") return { kind: "upgrade" };

    const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!match) {
        return {
            kind: "error",
            message: `Invalid /ctx-recomp arguments: \`${trimmed}\`.\n\n${RECOMP_USAGE}`,
        };
    }

    const start = Number.parseInt(match[1], 10);
    const end = Number.parseInt(match[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return { kind: "error", message: "Range values must be finite integers." };
    }
    if (start < 1) {
        return { kind: "error", message: `Start must be >= 1 (got ${start}).` };
    }
    if (end < start) {
        return { kind: "error", message: `End must be >= start (got ${start}-${end}).` };
    }

    return { kind: "partial", range: { start, end } };
}

function parseWrapupArgs(raw: string):
    | { ok: true; messagesToKeep: number }
    | { ok: false; message: string } {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: true, messagesToKeep: 20 };
    if (!/^\d+$/.test(trimmed)) {
        return {
            ok: false,
            message:
                "Usage: `/ctx-wrapup [messages_to_keep]` where messages_to_keep is a positive integer.",
        };
    }
    const messagesToKeep = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(messagesToKeep) || messagesToKeep <= 0) {
        return { ok: false, message: "messages_to_keep must be a positive integer." };
    }
    return { ok: true, messagesToKeep };
}

/**
 * The dreamer task registry is Batch 2 (`deferred/dreamer-task-registry.ts`), so
 * `isCanonicalDreamTask` cannot be consulted. See the file header for why `false`
 * is the conservative arm.
 */
function isCanonicalDreamTask(_requested: string): boolean {
    return false;
}

const commandArgumentValidators: Record<MagicContextBuiltinCommandName, (raw: string) => boolean> =
    {
        "ctx-status": (raw) => {
            const mode = raw.trim().toLowerCase();
            return mode === "" || mode === "diagnostics";
        },
        "ctx-recomp": (raw) => parseRecompArgs(raw).kind !== "error",
        "ctx-wrapup": (raw) => parseWrapupArgs(raw).ok,
        "ctx-flush": (raw) => raw.trim() === "",
        "ctx-dream": (raw) => {
            const requested = raw.trim();
            return requested === "" || isCanonicalDreamTask(requested);
        },
        "ctx-embed": (raw) => {
            const subcommand = raw.trim().toLowerCase();
            return subcommand === "" || subcommand === "start" || subcommand === "pause";
        },
    };

/**
 * Conservative pre-dispatch gate for Desktop prompts that lost their slash.
 * The actual command handler still parses the accepted text, so intercepted and
 * native slash commands share one execution path and one argument interpretation.
 */
export function acceptsMagicContextCommandArguments(
    command: MagicContextBuiltinCommandName,
    raw: string,
): boolean {
    return commandArgumentValidators[command](raw);
}