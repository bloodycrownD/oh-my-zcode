import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES, type ZCodeSlashCommand } from "@zcode/shared";

/**
 * App `/` 面板与加号菜单按本顺序展示（UI 不维护排序白名单）。`workflow` 紧随 `goal`：两者都是
 * 「开启一段工作」的入口；它受动态工作流开关约束，
 * 由 zcode-protocol/slash-commands.ts 在装配时剔除。
 *
 * `ctx-*` 四条排在 `init` 之后：它们是 magic-context 的上下文控制面，靠后免得挤在
 * 「开启一段工作」的入口前面。
 */
export const APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES = [
  "goal",
  "workflow",
  "init",
  "ctx-status",
  "ctx-reduce",
  "ctx-expand",
  "ctx-recomp",
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
 * magic-context 的控制命令（Step 22）。
 *
 * 这四个名字在 `BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES` 里有条目，因此已经被
 * `RESERVED_SLASH_COMMAND_NAMES` 收进去（用户/插件的同名自定义命令不会漏回来）。
 * 它们同时进了 `APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES`，所以这份名单在这里
 * 只是**显式复述**一个事实，而不是把它们排除在外：
 *
 *   - 两个执行面各有各的派发路径，但语义只有一份（`bootstrap/src/ctx-commands`）：
 *     CLI TUI 由 `cli/src/command-center/handlers/ctx.ts` 就地消费；桌面 App 由
 *     `zcode-protocol-v4/commands/handlers/ctx.ts` 经 v4 命令通道消费，结果回在 ACK 的
 *     `ctxCommand.response` 里。**两条路径都不经过 prompt 解析**，因此命令原文不会被
 *     转发给模型。
 *   - 保留名单仍然必要：没有它，用户在 `.zcode/commands/` 里写一个 `ctx-status.md`
 *     会抢走这个名字，让上面两条本地语义静默失效。
 *
 * 保留名单与「可见目录」是两份互不干涉的清单：删掉这份名单不会让命令重新出现在 `/`
 * 面板，但会让自定义命令重新抢名。
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
