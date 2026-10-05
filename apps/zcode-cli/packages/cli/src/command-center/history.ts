import type { TuiPromptInput } from "@zcode/tui";
import type { SlashCommand } from "./slash-command-types.js";
import type { CommandCenterDeps } from "./types.js";

export async function recordSlashCommandInHistory(
  deps: CommandCenterDeps,
  input: TuiPromptInput,
  command: SlashCommand,
): Promise<void> {
  if (!deps.recordInputHistory || !shouldRecordSlashCommand(command)) return;
  try {
    await deps.recordInputHistory(input, "slash_command");
  } catch {
    // Input history is recall UX; command execution must not depend on it.
  }
}

// FORK（D-4）：`/login <provider>-coding-plan-api-key <key>` 已删除，
// 输入历史不再需要过滤含 API Key 的命令——已无任何命令会在 args 里带密钥。
function shouldRecordSlashCommand(_command: SlashCommand): boolean {
  return true;
}
