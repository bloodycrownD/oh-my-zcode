// ============================================================
// Identity Section Builder
// ============================================================
// FORK（prompt-language-option）：
// ── 上游语义 ───────────────────────────────────────────────────────────
// 源位置：上游 ZCode v3.14.3 `core/src/context/sections/identity.ts`。
// `buildHarnessBlock()` / `buildIdentitySection(outputStyle?)` 均无语言参数，
// intro、Harness 两段英文硬编码；`language` 通路存在（上游 runtime/context types
// 的 `language?: string`）但提示词层零消费者。
// ── ZCode 的差异 ───────────────────────────────────────────────────────
// 入口各加可选 `language`：zh-CN 改用中文身份段文案（品牌统一 omz）；其余值/
// 缺席回落英文原文。
// 上游的 SECURITY_NOTICE（安全 IMPORTANT 行）按用户裁定（2026-10-11）整体移除：
// 交互式身份与工作流子代理身份均不再注入。
// ── 改法与改动面 ───────────────────────────────────────────────────────
// 中文文案常量（intro 两版 / Harness）与判定函数集中在
// ../prompt-copy-zh-cn.ts；调用点 context/builder.ts 的 identity 段装配处。
// buildHarnessBlock 的语言参数可选——工作流子代理身份段
// （sections/workflow-actor.ts）继续不传参，逐字复用英文版。

import type { ContextSection } from "../types.js";
import type { OutputStylePromptConfig } from "../types.js";
import { estimateTokens } from "../utils.js";
import {
  HARNESS_BLOCK_ZH_CN,
  IDENTITY_INTRO_OUTPUT_STYLE_ZH_CN,
  IDENTITY_INTRO_ZH_CN,
  isChinesePromptLanguage,
} from "../prompt-copy-zh-cn.js";

/**
 * `# Harness` 块：稳定运行时约束，不属于 output style 可替换的 coding instructions，
 * 也是工作流子代理身份（sections/workflow-actor.ts）逐字复用的那一段。
 */
export function buildHarnessBlock(language?: string): string {
  if (isChinesePromptLanguage(language)) {
    return HARNESS_BLOCK_ZH_CN;
  }
  return [
    "# Harness",
    "- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.",
    "- Tools run behind a user-selected permission mode; a denied call means the user declined it \u2014 adjust, don't retry verbatim.",
    "- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.",
    "- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.",
    "- Reference code as `file_path:line_number` \u2014 it's clickable.",
  ].join("\n");
}

function buildIdentityPrompt(outputStyle?: OutputStylePromptConfig, language?: string): string {
  const zh = isChinesePromptLanguage(language);
  const intro = outputStyle
    ? zh
      ? IDENTITY_INTRO_OUTPUT_STYLE_ZH_CN
      : "You respond to the user according to the active Output Style below while using ZCode's tools and instructions."
    : zh
      ? IDENTITY_INTRO_ZH_CN
      : "You are an interactive ZCode agent that helps users with software engineering tasks.";

  // 安全 IMPORTANT 行已按用户裁定（2026-10-11）移除，不再注入身份段。
  const identityLines = ["", intro, ""].join("\n");

  return [identityLines, "", buildHarnessBlock(language)].join("\n");
}

export function buildIdentitySection(
  outputStyle?: OutputStylePromptConfig,
  language?: string,
): ContextSection {
  const content = buildIdentityPrompt(outputStyle, language);

  return {
    name: "Agent Identity",
    source: "identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
