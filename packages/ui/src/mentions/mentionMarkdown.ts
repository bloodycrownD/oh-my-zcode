import type { MentionItemData } from "./mentionTypes.js";

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

/** 富反解析产出的 mention 种类：装填面只承认这四类 canonical 链接。 */
type RichMentionCategory = "files" | "skills" | "sessions" | "plugins";

/**
 * 装填用 mention 事实：`markdown` 恒等于原文链接子串（fullMatch），
 * 供 PromptMentionNode 原样序列化回正文，保证往返字节不变。
 */
export interface RichMentionPart {
  category: RichMentionCategory;
  label: string;
  value: string;
  markdown: string;
  data?: MentionItemData;
}

export type RichMentionSegment =
  | { type: "text"; text: string }
  | ({ type: "mention" } & RichMentionPart);

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

// ── 富反解析（胶囊装填面） ────────────────────────────────────────────────────
//
// 上面 parseMentionMarkdown 面向「展示」：label 前缀决定类型、inline 裸 token 也画胶囊，
// 因为气泡只需要看起来对。输入框装填必须更严格：
// 1) 只有 canonical 链接（目的地命中白名单）才还原成 chip —— 正文里的 http 链接、
//    自定义协议、普通 Markdown 都必须逐字留在正文里（R7：胶囊误伤正文链接）；
// 2) inline 裸 token（@name / $slug / /cmd / #sess_x）一律不转 —— 用户手打的文本
//    往返一次就变成不可编辑 token 是不可接受的（用户拍板）；
// 3) 代码块 fence 内整段跳过 —— 里面的 ``` 示例不能被解析成 chip。

const RICH_MENTION_LINK_PATTERN =
  /\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)])*))\)/g;
const FENCE_LINE_PATTERN = /^\s*(`{3,}|~{3,})/;

/**
 * 装填白名单：`plugin://`（合法 stable id）、`#sess_*`、`./`、`../`、`/`、盘符绝对路径。
 * 其余目的地（`https:`、`mailto:`、未知协议、裸相对路径以外的一切）都不是 mention。
 */
function isRichMentionFileDestination(destination: string): boolean {
  if (destination.startsWith("./") || destination.startsWith("../")) return true;
  // 协议相对 URL（`//cdn.example.com/a.ts`）同样以 `/` 开头，但它是网络地址而不是工作区路径。
  // 无条件命中绝对路径白名单会把 `[doc](//cdn.example.com/a.ts)` 还原成本地文件胶囊，
  // 违反 R7「白名单外目的地一律逐字留在正文」。
  if (destination.startsWith("/") && !destination.startsWith("//")) return true;
  return /^[a-zA-Z]:[\\/]/.test(destination);
}

function resolveRichMentionFileData(
  destination: string,
  kind: "file" | "directory",
): MentionItemData {
  // 相对路径按 file provider 的口径去掉 `./` 前缀；绝对路径（POSIX / 盘符）进 path。
  if (destination.startsWith("./")) {
    const relativePath = destination.slice(2);
    return relativePath ? { kind, relativePath } : { kind };
  }
  if (destination.startsWith("../")) {
    return { kind, relativePath: destination };
  }
  return { kind, path: destination };
}

function resolveRichMentionPart(
  label: string,
  destination: string,
  markdown: string,
): RichMentionPart | null {
  if (!destination) return null;

  if (destination.startsWith("plugin://")) {
    // 身份只在 destination；非法 stable id 不造身份，宁可保留正文。
    const pluginId = parsePluginStableId(destination);
    if (!pluginId) return null;
    return {
      category: "plugins",
      label: label.startsWith("@") ? label.slice(1) : label,
      value: pluginId,
      markdown,
      data: { pluginId },
    };
  }

  if (/^#sess_[a-zA-Z0-9._-]+$/.test(destination)) {
    return {
      category: "sessions",
      label: label.startsWith("#") ? label.slice(1) : label,
      value: destination.slice(1),
      markdown,
    };
  }

  if (!isRichMentionFileDestination(destination)) return null;

  if (label.startsWith("$")) {
    return { category: "skills", label: label.slice(1), value: destination, markdown };
  }

  const kind = isDirectoryMentionDestination(destination) ? "directory" : "file";
  const data = resolveRichMentionFileData(destination, kind);
  return {
    category: "files",
    label: label.startsWith("@") ? label.slice(1) : label,
    value: data.relativePath || data.path || destination,
    markdown,
    data,
  };
}

/**
 * 按代码块 fence 切段：fence 内（含 fence 行）整段是正文，不做任何链接解析。
 * 未闭合 fence 一直吃到文末，避免「开了半个代码块」时把后文当正文解析。
 */
function splitMarkdownFenceSegments(content: string): { fenced: boolean; text: string }[] {
  const segments: { fenced: boolean; text: string }[] = [];
  const lines = content.split("\n");
  let fenced = false;
  let fenceMarker = "";
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    segments.push({ fenced, text: buffer });
    buffer = "";
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    // 逐行拼回原文：除末行外都带换行，保证文本段拼接后与输入逐字节相同。
    const lineWithBreak = index < lines.length - 1 ? `${line}\n` : line;
    const fenceChar = FENCE_LINE_PATTERN.exec(line)?.[1]?.[0];
    if (!fenced && fenceChar) {
      flush();
      fenced = true;
      fenceMarker = fenceChar;
      buffer += lineWithBreak;
      continue;
    }
    if (fenced && fenceChar === fenceMarker) {
      buffer += lineWithBreak;
      flush();
      fenced = false;
      fenceMarker = "";
      continue;
    }
    buffer += lineWithBreak;
  }
  flush();
  return segments;
}

function parseRichMentionPlainSegment(text: string, segments: RichMentionSegment[]): void {
  const pushText = (chunk: string) => {
    if (!chunk) return;
    const last = segments.at(-1);
    if (last?.type === "text") {
      // 相邻文本段合并：装填时少造 TextNode，也便于调用方按段断言。
      segments[segments.length - 1] = { type: "text", text: last.text + chunk };
      return;
    }
    segments.push({ type: "text", text: chunk });
  };

  let cursor = 0;
  RICH_MENTION_LINK_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(RICH_MENTION_LINK_PATTERN)) {
    const fullMatch = match[0] ?? "";
    const rawLabel = match[1] ?? "";
    const rawDestination = match[2] ?? match[3] ?? "";
    const part = resolveRichMentionPart(
      unescapeMarkdownText(rawLabel),
      // 目的地可能被 escapeMarkdownDestination 转义（Windows 路径的 `\`）；白名单按还原值判定。
      unescapeMarkdownText(rawDestination),
      fullMatch,
    );
    // 白名单外的链接不是 mention：整段（含 fullMatch 原文）留在正文里。
    if (!part) continue;
    const matchStart = match.index ?? 0;
    if (matchStart > cursor) pushText(text.slice(cursor, matchStart));
    segments.push({ type: "mention", ...part });
    cursor = matchStart + fullMatch.length;
  }
  pushText(text.slice(cursor));
}

/**
 * 富反解析：把 canonical mention markdown 还原成「文本段 + mention 段」序列。
 *
 * 不变量（T-PR1 钉住）：`text` 段与 `markdown` 段按序拼接恒等于输入原文，
 * 即编辑器 getMarkdown() 往返字节不变。
 */
export function parseMentionMarkdownRich(content: string): RichMentionSegment[] {
  const segments: RichMentionSegment[] = [];
  for (const chunk of splitMarkdownFenceSegments(content)) {
    if (chunk.fenced) {
      // fence 内不解析；与相邻文本段合并（fence 行是正文的一部分）。
      const last = segments.at(-1);
      if (last?.type === "text") {
        segments[segments.length - 1] = { type: "text", text: last.text + chunk.text };
      } else {
        segments.push({ type: "text", text: chunk.text });
      }
      continue;
    }
    parseRichMentionPlainSegment(chunk.text, segments);
  }
  return segments;
}

/**
 * 按编辑器段落契约（Lexical getTextContent 用 `\n\n` 分隔段落）把富反解析结果装配成段落。
 *
 * 必须先整篇 `parseMentionMarkdownRich` 再调本函数：fence 状态跨段落有效，
 * 代码块内含空行时后半段依然属于 fence 内正文。先 `text.split("\n\n")` 再逐段解析会让
 * fence 状态在段间丢失，把代码块里的 mention 误转成 chip（编辑器视觉与解析器判定不一致）。
 * 段落拼接不变量：段内各段按序拼接、段间补 `\n\n`，恒等于输入原文。
 */
export function splitRichMentionParagraphs(
  segments: readonly RichMentionSegment[],
): RichMentionSegment[][] {
  const paragraphs: RichMentionSegment[][] = [];
  let current: RichMentionSegment[] = [];
  const startNextParagraph = () => {
    paragraphs.push(current);
    current = [];
  };
  for (const segment of segments) {
    if (segment.type === "mention") {
      current.push(segment);
      continue;
    }
    // mention markdown 不含空行：段落边界只会出现在文本段内部。
    const chunks = segment.text.split("\n\n");
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) startNextParagraph();
      const chunk = chunks[index] ?? "";
      if (chunk) current.push({ type: "text", text: chunk });
    }
  }
  // 末尾段落（可能为空）同样是真实段落：与 replaceEditorText 的 split 结果保持同段落数。
  paragraphs.push(current);
  return paragraphs;
}
