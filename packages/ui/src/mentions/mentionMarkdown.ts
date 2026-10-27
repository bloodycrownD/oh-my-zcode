import type { MentionCategory, MentionItemData } from "@/mentions/mentionTypes.js";

const LINK_MENTION_MARKDOWN_PATTERN =
  /\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)])*))\)/g;
const INLINE_MENTION_TOKEN_PATTERN =
  /(^|\s)(\$[a-zA-Z0-9._-]+|\/[a-zA-Z0-9._-]+|@[a-zA-Z0-9._-]+|#sess_[a-zA-Z0-9._-]+)(?=$|\s)/g;

function escapeMarkdownLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeMarkdownDestination(destination: string): string {
  return destination.replaceAll("\\", "\\\\").replaceAll(">", "\\>");
}

function unescapeMarkdownText(text: string): string {
  let result = "";

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && index + 1 < text.length) {
      result += text[index + 1];
      index += 1;
      continue;
    }

    result += text[index];
  }

  return result;
}

function normalizeMarkdownDestination(destination: string): string {
  if (
    destination.startsWith("/") ||
    destination.startsWith("./") ||
    destination.startsWith("../") ||
    destination.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(destination)
  ) {
    return destination;
  }

  // Streamdown/rehype-harden 会把 `foo/bar.ts` 这种裸路径当成自定义协议 `foo:`，
  // 结果用户消息里的文件引用会被渲染成 `[blocked]`。这里统一补成 `./foo/bar.ts`，
  // 让它明确成为相对路径链接，既保留 Markdown 语义，也能通过安全校验正常展示。
  return `./${destination}`;
}

function normalizeFileMentionRelativePath(
  relativePath: string,
  kind: "file" | "directory",
): string {
  const trimmedRelativePath = relativePath.trim();
  if (kind === "directory") {
    return `${trimmedRelativePath.replace(/[\\/]+$/, "")}/`;
  }

  return trimmedRelativePath;
}

export function buildFileMentionMarkdown(
  relativePath: string,
  label: string,
  kind: "file" | "directory" = "file",
): string {
  const normalizedRelativePath = normalizeFileMentionRelativePath(relativePath, kind);
  return `[${escapeMarkdownLabel(label)}](${escapeMarkdownDestination(normalizeMarkdownDestination(normalizedRelativePath))})`;
}

export function buildSkillMentionMarkdown(label: string, skillPath?: string): string {
  if (!skillPath) {
    return `$${label}`;
  }

  return `[${escapeMarkdownLabel(`$${label}`)}](${escapeMarkdownDestination(normalizeMarkdownDestination(skillPath))})`;
}

export function buildSubagentMentionMarkdown(label: string): string {
  return `@${label}`;
}

export function buildSessionMentionMarkdown(sessionId: string, label?: string): string {
  const trimmedLabel = label?.trim();
  if (!trimmedLabel || trimmedLabel === sessionId) {
    return `#${sessionId}`;
  }
  return `[${escapeMarkdownLabel(`#${trimmedLabel}`)}](#${escapeMarkdownDestination(sessionId)})`;
}

// Plugin 引用的 canonical 持久化载体：
// `[@Label](plugin://stable-id)`。身份只在 destination；label 仅用于展示。
export function buildPluginMentionMarkdown(label: string, pluginId: string): string {
  return `[${escapeMarkdownLabel(`@${label}`)}](plugin://${escapeMarkdownDestination(pluginId)})`;
}

type MentionTextPart =
  | { type: "text"; text: string }
  | { type: "file"; label: string }
  | { type: "directory"; label: string }
  | { type: "skill"; label: string }
  | { type: "command"; label: string }
  | { type: "subagent"; label: string }
  | { type: "session"; label: string }
  | { type: "plugin"; label: string; pluginId?: string };

const PLUGIN_STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parsePluginStableId(destination: string): string | undefined {
  if (!destination.startsWith("plugin://")) return undefined;
  const candidate = destination.slice("plugin://".length);
  return candidate.length <= 256 && PLUGIN_STABLE_ID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

/**
 * 将技能 slug（如 code-review）格式化为聊天气泡中的可读标题（Code Review）。
 * 已是包含空格的短语时原样返回，避免破坏用户自定义展示名。
 */
export function formatSkillMentionDisplayLabel(label: string): string {
  const t = label.trim();
  if (!t) {
    return label;
  }
  if (t.includes(" ") && !t.includes("-") && !t.includes("_")) {
    return t;
  }
  const words = t.split(/[-_]/).filter(Boolean);
  if (words.length === 0) {
    return label;
  }
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

function isDirectoryMentionDestination(destination: string): boolean {
  return /[\\/]$/.test(destination);
}

function parseInlineMentionTokens(segment: string): MentionTextPart[] {
  const parts: MentionTextPart[] = [];
  INLINE_MENTION_TOKEN_PATTERN.lastIndex = 0;
  let cursor = 0;

  for (const match of segment.matchAll(INLINE_MENTION_TOKEN_PATTERN)) {
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    if (!token) {
      continue;
    }
    const matchStart = match.index ?? 0;
    const tokenStart = matchStart + prefix.length;
    if (tokenStart > cursor) {
      parts.push({
        type: "text",
        text: segment.slice(cursor, tokenStart),
      });
    }
    if (token.startsWith("$")) {
      parts.push({ type: "skill", label: token.slice(1) });
    } else if (token.startsWith("/")) {
      parts.push({ type: "command", label: token.slice(1) });
    } else if (token.startsWith("@")) {
      parts.push({ type: "subagent", label: token.slice(1) });
    } else if (token.startsWith("#")) {
      parts.push({ type: "session", label: token.slice(1) });
    } else {
      parts.push({ type: "text", text: token });
    }
    cursor = tokenStart + token.length;
  }

  if (cursor < segment.length) {
    parts.push({ type: "text", text: segment.slice(cursor) });
  }

  return parts;
}

export function parseMentionMarkdown(content: string): MentionTextPart[] {
  const parts: MentionTextPart[] = [];
  LINK_MENTION_MARKDOWN_PATTERN.lastIndex = 0;
  let cursor = 0;

  for (const match of content.matchAll(LINK_MENTION_MARKDOWN_PATTERN)) {
    const fullMatch = match[0] ?? "";
    const label = match[1] ? unescapeMarkdownText(match[1]) : "";
    const destination = match[2] ?? match[3] ?? "";
    const matchStart = match.index ?? 0;
    if (matchStart > cursor) {
      parts.push(...parseInlineMentionTokens(content.slice(cursor, matchStart)));
    }
    if (/^#sess_[a-zA-Z0-9._-]+$/.test(destination)) {
      parts.push({ type: "session", label: label.startsWith("#") ? label.slice(1) : label });
    } else if (destination.startsWith("plugin://")) {
      // Plugin 引用链接绝不能落入 file 分支或被当外链处理；
      // 发送后曾只保留 label，消息层失去 stable ID，只能固定显示兜底图标。
      // 这里原样保留合法 destination 身份供 UI 与 Session catalog 关联；非法目标仍保持
      // display-only，不做 label 猜测、percent decode 或 canonical 改写。
      const pluginId = parsePluginStableId(destination);
      parts.push({
        type: "plugin",
        label: label.startsWith("@") ? label.slice(1) : label,
        ...(pluginId ? { pluginId } : {}),
      });
    } else if (label.startsWith("$")) {
      parts.push({ type: "skill", label: label.slice(1) });
    } else if (isDirectoryMentionDestination(destination)) {
      // 目录 mention 之前只按普通 file 还原，消息回显层拿不到 folder 语义，
      // 于是文件夹候选在气泡里会继续显示成普通文件图标。这里根据链接目标是否以斜杠结尾恢复目录类型。
      parts.push({ type: "directory", label: label.startsWith("@") ? label.slice(1) : label });
    } else {
      parts.push({ type: "file", label: label.startsWith("@") ? label.slice(1) : label });
    }
    cursor = matchStart + fullMatch.length;
  }

  if (cursor < content.length) {
    parts.push(...parseInlineMentionTokens(content.slice(cursor)));
  }

  return parts;
}

/**
 * 恢复进编辑器用的反解结果：与 `MentionTextPart` 同源，但**保留原始片段**。
 *
 * `parseMentionMarkdown` 是给消息气泡展示写的，只留 label（链接目标、原始字节都丢了），
 * 拿它重建 Lexical 节点会让 `getMarkdown()` 无法逐字节往返。这里额外携带 `markdown`
 * 与 `data`，供编辑器侧 `$createPromptMentionNode` 原样保存。
 */
export type MentionMarkdownPart =
  | { kind: "text"; text: string }
  | {
      kind: "mention";
      category: MentionCategory;
      label: string;
      value: string;
      /** 原始片段（`[...](...)` 或裸 token），节点必须原样保存。 */
      markdown: string;
      data?: MentionItemData;
    };

/** `https:` / `mailto:` 这类外链不是文件 mention，必须留在纯文本里。 */
const DESTINATION_PROTOCOL_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

function stripLeadingDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

function mentionPartFromLink(
  label: string,
  destination: string,
  markdown: string,
): MentionMarkdownPart | null {
  if (/^#sess_[a-zA-Z0-9._-]+$/.test(destination)) {
    return {
      kind: "mention",
      category: "sessions",
      label: label.startsWith("#") ? label.slice(1) : label,
      value: destination.slice(1),
      markdown,
    };
  }

  if (destination.startsWith("plugin://")) {
    const pluginId = parsePluginStableId(destination);
    // 非法 plugin target 保持文本（与气泡层的 display-only 口径一致）。
    if (!pluginId) return null;
    return {
      kind: "mention",
      category: "plugins",
      label: label.startsWith("@") ? label.slice(1) : label,
      value: pluginId,
      markdown,
      data: { pluginId },
    };
  }

  if (label.startsWith("$") && !DESTINATION_PROTOCOL_PATTERN.test(destination)) {
    return {
      kind: "mention",
      category: "skills",
      label: label.slice(1),
      value: label.slice(1),
      markdown,
      data: { path: stripLeadingDotSlash(destination) },
    };
  }

  if (DESTINATION_PROTOCOL_PATTERN.test(destination)) return null;

  const relativePath = stripLeadingDotSlash(destination);
  const kind = isDirectoryMentionDestination(destination) ? "directory" : "file";
  return {
    kind: "mention",
    category: "files",
    label: label.startsWith("@") ? label.slice(1) : label,
    value: relativePath,
    markdown,
    data: { kind, path: relativePath, relativePath },
  };
}

function parseInlineMentionTokensAsParts(segment: string): MentionMarkdownPart[] {
  const parts: MentionMarkdownPart[] = [];
  INLINE_MENTION_TOKEN_PATTERN.lastIndex = 0;
  let cursor = 0;

  for (const match of segment.matchAll(INLINE_MENTION_TOKEN_PATTERN)) {
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    if (!token) continue;
    const matchStart = match.index ?? 0;
    const tokenStart = matchStart + prefix.length;
    if (tokenStart > cursor) {
      parts.push({ kind: "text", text: segment.slice(cursor, tokenStart) });
    }

    const value = token.slice(1);
    if (token.startsWith("$")) {
      parts.push({ kind: "mention", category: "skills", label: value, value, markdown: token });
    } else if (token.startsWith("/")) {
      parts.push({ kind: "mention", category: "commands", label: value, value, markdown: token });
    } else if (token.startsWith("@")) {
      parts.push({ kind: "mention", category: "subagents", label: value, value, markdown: token });
    } else if (token.startsWith("#")) {
      parts.push({ kind: "mention", category: "sessions", label: value, value, markdown: token });
    } else {
      parts.push({ kind: "text", text: token });
    }

    cursor = tokenStart + token.length;
  }

  if (cursor < segment.length) {
    parts.push({ kind: "text", text: segment.slice(cursor) });
  }

  return parts;
}

/**
 * 把 prompt markdown 反解成「文本段 + mention 段」，供编辑器**恢复胶囊**用。
 *
 * 不变式（单测钉住）：把所有段的 `markdown`（mention）或 `text`（文本）按顺序拼回去，
 * 必须与原串逐字节相等——否则「点一下编辑、内容就被改写」。
 */
export function parseMentionMarkdownParts(content: string): MentionMarkdownPart[] {
  const parts: MentionMarkdownPart[] = [];
  LINK_MENTION_MARKDOWN_PATTERN.lastIndex = 0;
  let cursor = 0;

  for (const match of content.matchAll(LINK_MENTION_MARKDOWN_PATTERN)) {
    const markdown = match[0] ?? "";
    const label = match[1] ? unescapeMarkdownText(match[1]) : "";
    const destination = match[2] ?? match[3] ?? "";
    const matchStart = match.index ?? 0;
    if (matchStart > cursor) {
      parts.push(...parseInlineMentionTokensAsParts(content.slice(cursor, matchStart)));
    }

    const mention = mentionPartFromLink(label, destination, markdown);
    parts.push(mention ?? { kind: "text", text: markdown });

    cursor = matchStart + markdown.length;
  }

  if (cursor < content.length) {
    parts.push(...parseInlineMentionTokensAsParts(content.slice(cursor)));
  }

  return parts;
}
