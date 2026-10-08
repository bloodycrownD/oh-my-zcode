// ============================================================
// CLI Prefix Section Builder
// ============================================================
// FORK（prompt-language-option）：
// ── 上游语义 ───────────────────────────────────────────────────────────
// 源位置：上游 ZCode v3.14.3 `core/src/context/sections/cli-prefix.ts`。
// 恒定英文硬编码：`const CLI_PREFIX_PROMPT = "You are ZCode, an interactive coding
// agent"`，`buildCliPrefixSection()` 无参数。`language` 通路存在（见上游
// `core/src/runtime/types.ts` 与 `core/src/context/types.ts` 的 `language?: string`）
// 但提示词层零消费者。
// ── ZCode 的差异 ───────────────────────────────────────────────────────
// 新增可选 `language`：zh-CN（含 zh_CN/zh-TW 等区域性标签）改用中文品牌前缀
// 「你是 omz，一个交互式编码助手」；其余值/缺席回落英文原文。
// ── 改法与改动面 ───────────────────────────────────────────────────────
// `buildCliPrefixSection(language?)` 按 `isChinesePromptLanguage` 二选一；中文文案
// 常量与判定函数集中在 ../prompt-copy-zh-cn.ts（唯一文案落点）；调用点
// context/builder.ts 的 cli prefix 装配处。

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";
import { CLI_PREFIX_PROMPT_ZH_CN, isChinesePromptLanguage } from "../prompt-copy-zh-cn.js";

const CLI_PREFIX_PROMPT = "You are ZCode, an interactive coding agent";

export function buildCliPrefixSection(language?: string): ContextSection {
  const content = isChinesePromptLanguage(language) ? CLI_PREFIX_PROMPT_ZH_CN : CLI_PREFIX_PROMPT;

  return {
    name: "CLI Prefix",
    source: "cli_prefix",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
