import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";
// FORK（prompt-language-option）：
// ── 上游语义 ───────────────────────────────────────────────────────────
// 源位置：上游 ZCode v3.14.3 `core/src/context/sections/desktop.ts`。
// `buildDesktopContextSection()` 无参数，整段 "ZCode Desktop Context"（含
// Files & URLs / Inline Code Comments 小节）英文硬编码；`language` 通路存在但
// 提示词层零消费者。
// ── ZCode 的差异 ───────────────────────────────────────────────────────
// 新增可选 `language`：zh-CN 改用中文桌面端上下文段（标题与小节名翻译，
// ::code-comment 协议指令字面量原样保留）；其余值/缺席回落英文原文。
// ── 改法与改动面 ───────────────────────────────────────────────────────
// `buildDesktopContextSection(language?)`；中文文案集中在 ../prompt-copy-zh-cn.ts；
// 调用点 context/builder.ts 的 desktop 段装配处（仅 presentationSurface=zcode_desktop
// 且非工作流子代理时输出）。
import { DESKTOP_CONTEXT_ZH_CN, isChinesePromptLanguage } from "../prompt-copy-zh-cn.js";

export function buildDesktopContextSection(language?: string): ContextSection {
  if (isChinesePromptLanguage(language)) {
    return createDesktopSection("ZCode Desktop Context", "desktop_context", DESKTOP_CONTEXT_ZH_CN);
  }
  return createDesktopSection(
    "ZCode Desktop Context",
    "desktop_context",
    [
      "# ZCode Desktop Context",
      "",
      "### Files & URLs",
      "- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).",
      "- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
      "- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)).",
      "",
      "### Inline Code Comments",
      "- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.",
      "- Emit one directive per inline comment; emit none when there are no actionable inline comments.",
      "- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).",
      "- Optional attributes: start, end (1-based line numbers), priority (0-3).",
      "- file should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
      "- Keep line ranges tight; end defaults to start.",
      '- Example: ::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}',
    ].join("\n"),
  );
}

function createDesktopSection(
  name: string,
  source: ContextSection["source"],
  content: string,
): ContextSection {
  return {
    name,
    source,
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
