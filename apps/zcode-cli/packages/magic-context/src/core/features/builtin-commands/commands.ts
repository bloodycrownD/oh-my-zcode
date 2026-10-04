/**
 * Step 21 真身替换：`deferred/builtin-commands.ts` 的命令注册表归位为源文件本体。
 *
 * 逐字来自 `.reference/magic-context/packages/plugin/src/features/builtin-commands/
 * commands.ts`（46 行）。命令**处理**不在这里（源在 `hooks/magic-context/
 * command-handler.ts`，其 Effect 204 sentinel 按 SPEC 不搬，由 Step 22 在 ZCode 侧
 * 重写为本地命令语义）；本文件只提供「哪些 `/ctx-*` 名字存在、描述是什么」这份
 * 注册表，`stripped-command.ts` 用它做 allow-list 判定。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import type { BuiltinCommandConfig } from "./types.js";

const COMPACTION_ENABLED_PATH = `compaction${".enabled"}`;

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

export type MagicContextBuiltinCommandName = keyof ReturnType<
    typeof getMagicContextBuiltinCommands
>;