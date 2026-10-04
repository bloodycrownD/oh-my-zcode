import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES, type ZCodeSlashCommand } from "@zcode/shared";

/**
 * App `/` 面板与加号菜单按本顺序展示（UI 不维护排序白名单）。`workflow` 紧随 `goal`：两者都是
 * 「开启一段工作」的入口；它受动态工作流开关约束，
 * 由 zcode-protocol/slash-commands.ts 在装配时剔除。
 */
export const APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES = [
  "goal",
  "workflow",
  "init",
] as const;

/** 仅供 App Composer 使用的命令，不扩展 CLI TUI/help surface。 */
export const APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS = [
  {
    description: "Switch to Plan mode and optionally send a task.",
    inputHint: "/plan [task]",
    name: "plan",
    source: "builtin",
  },
] as const satisfies readonly ZCodeSlashCommand[];

/**
 * magic-context 的本地控制命令（Step 22）。
 *
 * 这四个名字在 `BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES` 里有条目，因此已经被
 * `RESERVED_SLASH_COMMAND_NAMES` 收进去（用户/插件的同名自定义命令不会漏回来）。
 * 这里再显式列一份，是为了让「它们是 CLI/TUI 本地命令」这件事在装配面上可见：
 *
 *   - 它们**刻意不进** `APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES`。App 的
 *     `/` 面板按那份目录展示，而 App composer 的 slash 命令是发给服务端的 prompt
 *     指令；`/ctx-status` 在 App 里没有对应的服务端派发路径，列出来只会给用户一个
 *     按下去没有反应的面板项。CLI TUI 侧由 `cli/src/command-center` 就地消费。
 *   - 保留名的作用仍然必要：没有它，用户在 `.zcode/commands/` 里写一个
 *     `ctx-status.md` 会抢走这个名字，让 CLI 侧的本地语义静默失效。
 */
const MAGIC_CONTEXT_LOCAL_SLASH_COMMAND_NAMES = [
  "ctx-status",
  "ctx-reduce",
  "ctx-expand",
  "ctx-recomp",
] as const;

const EXTRA_RESERVED_SLASH_COMMAND_NAMES = [
  "plan",
  // 本地命令不在 App 目录里，但要占住名字（见上方注释）。
  ...MAGIC_CONTEXT_LOCAL_SLASH_COMMAND_NAMES,
] as const;

const RESERVED_SLASH_COMMAND_NAMES = new Set(
  BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.flatMap((entry) => [
    entry.name,
    ...(entry.aliases ?? []),
  ]).concat([...EXTRA_RESERVED_SLASH_COMMAND_NAMES]),
);

function normalizeZCodeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function isReservedZCodeSlashCommandName(name: string): boolean {
  return RESERVED_SLASH_COMMAND_NAMES.has(normalizeZCodeSlashCommandName(name));
}
