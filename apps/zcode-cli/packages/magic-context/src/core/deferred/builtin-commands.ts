// FORK-NOT-PORTED: `features/builtin-commands/commands.ts` 的 getMagicContextBuiltinCommands / MagicContextBuiltinCommandName 与 `hooks/magic-context/command-handler.ts` 的 acceptsMagicContextCommandArguments 摘录，Step 21 决定移植或删除后重写本文件
//
// WHY NOT PORTED (BUT VERBATIM). The builtin-command registry describes the
// `/ctx-*` slash commands Magic Context registers with its host, and
// `acceptsMagicContextCommandArguments` is the pre-dispatch gate that validates
// their arguments. ZCode's command surface is ZCode's own; this fork registers
// none of these commands.
//
// It is nevertheless reproduced verbatim, because the ONE ported B-group file
// that reaches it — `stripped-command.ts` — uses it as a security-relevant
// predicate, not as a display table. `matchStrippedMagicContextCommand` decides
// whether a Desktop prompt that LOST its leading slash is a Magic Context command
// whose handler must be re-dispatched, or an ordinary user message that must pass
// through untouched. The registry is the allow-list (`Object.hasOwn(registry,
// command)`) and the argument validator is the second gate. A stubbed registry
// would either swallow every slash-less prompt or let a Magic Context command
// through as prose; a stubbed validator would accept arguments the real handler
// rejects. Both are wrong in the user-visible direction, so the six-command
// registry and all six validators are reproduced exactly.
//
// The only upstream dependency is `features/builtin-commands/types.ts`'s
// `BuiltinCommandConfig`, which is `NonNullable<Config["command"]>` from
// `@opencode-ai/sdk`. That SDK type is not a fork dependency, so the registry's
// `satisfies BuiltinCommandConfig` check is preserved against a locally declared
// structural stand-in of the same shape.
//
// Step 21: delete this file and repoint `stripped-command.ts` back at
// `../../features/builtin-commands/commands.js` and `./command-handler.js`.

const COMPACTION_ENABLED_PATH = `compaction${".enabled"}`;

/**
 * Structural stand-in for `features/builtin-commands/types.ts`'s
 * `BuiltinCommandConfig` (= `NonNullable<Config["command"]>` from
 * `@opencode-ai/sdk`). Declared locally because the SDK is not a fork
 * dependency; the shape is the one OpenCode's `Config` declares.
 */
export type BuiltinCommandConfig = Record<string, { template: string; description: string }>;

/** Verbatim: `commands.ts:5-42`. */
export function getMagicContextBuiltinCommands(compactionEnabled = true) {
    const unavailableInCompactionOff = (command: string) =>
        `Unavailable when ${COMPACTION_ENABLED_PATH} is false: /${command} manages compacted history.`;

    return {
        "ctx-status": {
            template: "ctx-status",
            description: "Show magic context status, pending queue, cache TTL, and debug info",
        },
        "ctx-recomp": {
            template: "ctx-recomp",
            description: compactionEnabled
                ? "Rebuild compressed history from raw history (full or <start>-<end> range); memories are not changed"
                : unavailableInCompactionOff("ctx-recomp"),
        },
        "ctx-wrapup": {
            template: "ctx-wrapup",
            description: compactionEnabled
                ? "Compact older live history while keeping the newest messages raw"
                : unavailableInCompactionOff("ctx-wrapup"),
        },
        "ctx-flush": {
            template: "ctx-flush",
            description: compactionEnabled
                ? "Force-process all pending magic context operations immediately"
                : unavailableInCompactionOff("ctx-flush"),
        },
        "ctx-dream": {
            template: "ctx-dream",
            description: "Run the hidden dreamer maintenance pass for this project now",
        },
        "ctx-embed": {
            template: "ctx-embed",
            description:
                "Embedding status, or start/pause history compartment embedding (start | pause)",
        },
    } satisfies BuiltinCommandConfig;
}

/** Verbatim: `commands.ts:44-46`. */
export type MagicContextBuiltinCommandName = keyof ReturnType<
    typeof getMagicContextBuiltinCommands
>;

/** Verbatim: `command-handler.ts:96-124` (`RECOMP_USAGE` inlined below). */
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
 * `isCanonicalDreamTask` cannot be consulted.
 * `/ctx-dream <task>` therefore answers `false` — the argument form passes
 * through as prose rather than being dispatched. That is the conservative arm:
 * the alternative (`true` for every argument) would route arbitrary user prose
 * into a command handler that would then reject it with a parse error.
 */
function isCanonicalDreamTask(_requested: string): boolean {
    return false;
}

/** Verbatim: `command-handler.ts:145-162`. */
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
 *
 * Verbatim: `command-handler.ts:169-174`.
 */
export function acceptsMagicContextCommandArguments(
    command: MagicContextBuiltinCommandName,
    raw: string,
): boolean {
    return commandArgumentValidators[command](raw);
}