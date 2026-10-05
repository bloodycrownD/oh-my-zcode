export type V4VisibleSlashCommand =
  | {
      kind: "planShortcut";
      task: string;
      displayText: string;
    }
  | {
      kind: "unsupportedPlanShortcut";
      task: string;
      displayText: string;
    }
  | {
      kind: "sendGoalCommand";
      objective: string;
      displayText: string;
    }
  | {
      kind: "resumeGoal";
      displayText: string;
    }
  | {
      kind: "emptyGoal";
      displayText: string;
    }
  | {
      kind: "unsupportedGoal";
      action: string;
      displayText: string;
    }
  | {
      /**
       * magic-context 本地控制命令（`/ctx-status` / `/ctx-reduce` / `/ctx-expand` /
       * `/ctx-recomp`）。App 侧由 v4 `ctxCommand` 通道就地执行，结果以文本回来，
       * 不进对话历史——与 CLI/TUI 的 command-center 语义同源。
       *
       * `range` 是命令名之后的**剩余文本逐字**：文法（tag=/message=/区间/verbose）只有
       * 服务端与包内工具路径共享一份实现，客户端不再抄第二遍。
       */
      kind: "ctxCommand";
      command: CtxCommandKind;
      range?: string;
      displayText: string;
    };

/** 四个 `/ctx-*` 对应的 v4 命令 kind（契约见 shared/zcode-protocol-v4/command.ts）。 */
export type CtxCommandKind = "ctxStatus" | "ctxReduce" | "ctxExpand" | "ctxRecomp";

interface V4VisibleSlashCommandParseOptions {
  contextAttachmentCount?: number;
}

interface SelectionSideSlashCommand {
  command: "side" | "btw";
  text: string;
  displayText: string;
}

interface SelectionSideSlashCommandParseOptions {
  contextAttachmentCount?: number;
  /** CLI catalog 中已经注册的同名命令；同名 CLI 命令优先，不由 App 消费。 */
  enabledCommandNames?: readonly string[];
}

const GOAL_COMMAND_RE = /^\/(?:goal|target)(?:\s|$)/i;

/**
 * `/ctx-*` 的命令名 → v4 kind。键是连字符形式，与 App `/` 目录（`/ctx-status` 等）
 * 和 CLI 的 `parseSlashCommand` 逐字对齐。
 */
const CTX_COMMAND_KINDS: Readonly<Record<string, CtxCommandKind>> = {
  "ctx-expand": "ctxExpand",
  "ctx-recomp": "ctxRecomp",
  "ctx-reduce": "ctxReduce",
  "ctx-status": "ctxStatus",
};

export function parseV4VisibleSlashCommand(
  content: string,
  attachments: readonly unknown[] = [],
  options: V4VisibleSlashCommandParseOptions = {},
): V4VisibleSlashCommand | null {
  const displayText = content.trim();
  if (!displayText.startsWith("/")) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(displayText);
  if (!match) return null;
  const commandName = match[1]?.toLowerCase() ?? "";
  const args = match[2]?.trim() ?? "";

  if (commandName === "plan") {
    const hasUnsupportedPayload =
      attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0;
    return {
      kind: hasUnsupportedPayload ? "unsupportedPlanShortcut" : "planShortcut",
      task: args,
      displayText,
    };
  }

  if (attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0) {
    return null;
  }

  // magic-context 本地控制命令。它们与 goal 一样**不走 prompt 通道**（那会把 `/ctx-status`
  // 原文当 prompt 发给模型），改由 v4 `ctxCommand` 就地执行。
  //
  // 位置在附件门之后：携带附件/网页元素上下文时不消费为 v4 原生命令，随 sendText 直发。
  // 这与 `/goal` 的取舍一致——先不引入「带附件敲 `/ctx-*` 该怎么办」这份额外语义，
  // 也让未消费时的行为与本次改动前逐字相同（原文进 prompt）。
  const ctxKind = CTX_COMMAND_KINDS[commandName];
  if (ctxKind) {
    return { command: ctxKind, displayText, kind: "ctxCommand", ...(args ? { range: args } : {}) };
  }

  if (commandName !== "goal" && commandName !== "target") {
    return null;
  }
  if (!args) return { kind: "emptyGoal", displayText };

  const action = args.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (action === "resume") return { kind: "resumeGoal", displayText };
  if (action === "pause" || action === "clear" || action === "show") {
    return { kind: "unsupportedGoal", action, displayText };
  }
  const objective = action === "replace" ? args.replace(/^replace\s*/i, "").trim() : args;
  if (!objective) return { kind: "emptyGoal", displayText };
  return { kind: "sendGoalCommand", objective, displayText };
}

/**
 * 解析带首条输入的选择副屏命令。
 *
 * 这是 App 层的完整输入消费门：只接受整条文本，且只在没有附件/结构化上下文时
 * 命中。参数只去除首尾空白，保留正文内部的空格和换行，避免改写用户原文。
 */
export function parseSelectionSideSlashCommand(
  content: string,
  attachments: readonly unknown[] = [],
  options: SelectionSideSlashCommandParseOptions = {},
): SelectionSideSlashCommand | null {
  if (attachments.length > 0 || (options.contextAttachmentCount ?? 0) > 0) return null;
  const displayText = content.trim();
  const match = /^\/(side|btw)(?:\s+([\s\S]*))?$/i.exec(displayText);
  if (!match) return null;
  const command = match[1]?.toLowerCase() as SelectionSideSlashCommand["command"] | undefined;
  const enabledNames = options.enabledCommandNames;
  if (
    enabledNames &&
    !enabledNames.some((name) => name.trim().replace(/^\/+/, "").toLowerCase() === command)
  ) {
    return null;
  }
  const text = match[2]?.trim() ?? "";
  if (!text || !command) return null;
  return { command, text, displayText };
}

export function v4QueuedCommandText(kind: "sendText" | "sendGoalCommand", text: string): string {
  if (kind !== "sendGoalCommand") return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  return GOAL_COMMAND_RE.test(trimmed) ? text : `/goal ${trimmed}`;
}
