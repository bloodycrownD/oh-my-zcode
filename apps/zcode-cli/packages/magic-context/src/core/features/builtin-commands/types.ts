/**
 * Step 21 真身替换：`deferred/builtin-commands.ts` 里内联声明的 `BuiltinCommandConfig`
 * 归位为源文件本体。
 *
 * 源文件（`.reference/.../features/builtin-commands/types.ts`）只有两行，唯一的 import
 * 是 `@opencode-ai/sdk` 的 `Config`——OpenCode SDK 不是 fork 依赖，因此按与被替换的缝
 * 完全相同的做法，本地重声明同形状的结构替身（源里 `satisfies` 的形状不变）。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

/**
 * Structural stand-in for `NonNullable<Config["command"]>` from `@opencode-ai/sdk`
 * (`features/builtin-commands/types.ts:1-3`). Declared locally because the OpenCode SDK
 * is not a fork dependency; the shape is the one OpenCode's `Config` declares.
 */
export type BuiltinCommandConfig = Record<string, { template: string; description: string }>;