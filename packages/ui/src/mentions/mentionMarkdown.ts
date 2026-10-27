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
    const classified = classifyMentionLink(label, destination);
    if (classified) {
      parts.push(toMentionTextPart(classified));
    } else if (destination !== "" && !destination.startsWith("#")) {
      // 气泡层保留历史口径：既不是 mention、也不是页内锚点/空目标的链接，仍按
      // file / directory 展示（`[Google](https://…)` 一直是这样）。
      // 改成纯文本会让消息里出现 markdown 字面量、复制还会丢 URL——那是另一件事，
      // 由气泡渲染层单独处理；编辑器侧（mentionPartFromLink）不走这条兜底。
      const bareLabel = label.startsWith("@") ? label.slice(1) : label;
      parts.push(
        isDirectoryMentionDestination(destination)
          ? { type: "directory", label: bareLabel }
          : { type: "file", label: bareLabel },
      );
    } else {
      parts.push({ type: "text", text: fullMatch });
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

/**
 * `https:` / `mailto:` 这类外链不是文件 mention，必须留在纯文本里。
 *
 * 协议名要求**至少两个字符**：Windows 盘符 `C:`、`D:` 是单字母 + 冒号，
 * 若按 `*` 匹配会被当成 scheme，`C:\\Users\\...\\SKILL.md` 这类绝对路径的
 * skill / 文件 mention 就整体退化成字面量（真机回归 2026-10-27）。
 */
const DESTINATION_PROTOCOL_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]+:/;

function stripLeadingDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

type ClassifiedMentionLink =
  | { category: "sessions"; label: string; value: string }
  | { category: "plugins"; label: string; value: string; pluginId?: string }
  | { category: "skills"; label: string; value: string; data: MentionItemData }
  | { category: "files"; label: string; value: string; data: MentionItemData };

/**
 * 链接形态 mention 的**唯一**分类入口：气泡层（`parseMentionMarkdown`）与编辑器恢复
 * （`parseMentionMarkdownParts`）都必须走这里，避免两套判据各自漂移——历史上气泡层
 * 没有协议判据，`[Google](https://google.com)` 会被画成文件胶囊。
 *
 * 返回 `null` 表示「不是 mention，保持纯文本」：
 * - 空 destination（`[x]()`）与页内锚点（`[见上文](#commit-3)`）——后者按文件还原会
 *   把可见文字改成 `#commit-3`（`resolveFileDisplayDescriptor` 取 path leaf）；
 * - 命中 `DESTINATION_PROTOCOL_PATTERN` 的外链（盘符已被该判据排除）。
 */
function classifyMentionLink(label: string, destination: string): ClassifiedMentionLink | null {
  if (/^#sess_[a-zA-Z0-9._-]+$/.test(destination)) {
    return {
      category: "sessions",
      label: label.startsWith("#") ? label.slice(1) : label,
      value: destination.slice(1),
    };
  }

  if (destination.startsWith("plugin://")) {
    // Plugin 引用绝不能落入 file 分支或被当外链：合法 stable id 进 value/data，
    // 非法目标仍保留 plugin 类型（气泡 display-only），但不带 pluginId。
    const pluginId = parsePluginStableId(destination);
    return {
      category: "plugins",
      label: label.startsWith("@") ? label.slice(1) : label,
      value: pluginId ?? "",
      ...(pluginId ? { pluginId } : {}),
    };
  }

  if (destination === "" || destination.startsWith("#")) return null;
  if (DESTINATION_PROTOCOL_PATTERN.test(destination)) return null;

  if (label.startsWith("$")) {
    return {
      category: "skills",
      label: label.slice(1),
      value: label.slice(1),
      data: { path: stripLeadingDotSlash(destination) },
    };
  }

  const relativePath = stripLeadingDotSlash(destination);
  // 目录 mention 之前只按普通 file 还原，消息回显层拿不到 folder 语义，
  // 于是文件夹候选在气泡里会继续显示成普通文件图标；按目标是否以斜杠结尾恢复目录类型。
  const kind = isDirectoryMentionDestination(destination) ? "directory" : "file";
  return {
    category: "files",
    label: label.startsWith("@") ? label.slice(1) : label,
    value: relativePath,
    data: { kind, path: relativePath, relativePath },
  };
}

function toMentionTextPart(classified: ClassifiedMentionLink): MentionTextPart {
  if (classified.category === "sessions") {
    return { type: "session", label: classified.label };
  }
  if (classified.category === "plugins") {
    return {
      type: "plugin",
      label: classified.label,
      ...(classified.pluginId ? { pluginId: classified.pluginId } : {}),
    };
  }
  if (classified.category === "skills") {
    return { type: "skill", label: classified.label };
  }
  return classified.data.kind === "directory"
    ? { type: "directory", label: classified.label }
    : { type: "file", label: classified.label };
}

function mentionPartFromLink(
  label: string,
  destination: string,
  markdown: string,
): MentionMarkdownPart | null {
  const classified = classifyMentionLink(label, destination);
  // 判据与气泡层共用 `classifyMentionLink`，这里只多一条编辑器侧要求：
  // 没有稳定 pluginId 的 plugin 链接建不出可用的节点，退回文本。
  if (!classified) return null;
  if (classified.category === "plugins" && !classified.pluginId) return null;

  const data =
    classified.category === "plugins"
      ? { pluginId: classified.value }
      : "data" in classified
        ? classified.data
        : undefined;

  return {
    kind: "mention",
    category: classified.category,
    label: classified.label,
    value: classified.value,
    markdown,
    ...(data ? { data } : {}),
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
    // destination 与 `escapeMarkdownDestination` 对称反转义：落库形态是
    // `C:\\Users\\...`（反斜杠被转义），data.path 必须是真实路径。
    const destination = unescapeMarkdownText(match[2] ?? match[3] ?? "");
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
