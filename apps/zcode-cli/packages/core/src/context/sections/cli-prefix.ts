// ============================================================
// CLI Prefix Section Builder
// ============================================================
// FORK（prompt-language-option）：模型语言为 zh-CN 时改用中文品牌前缀（omz）；
// 英文原文保留为默认/回退，全部中文文案集中在 prompt-copy-zh-cn.ts。

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
