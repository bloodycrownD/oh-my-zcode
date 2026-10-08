// ============================================================
// Identity Section Builder
// ============================================================
// FORK（prompt-language-option）：模型语言为 zh-CN 时改用中文身份段文案（品牌 omz）；
// 英文原文保留为默认/回退，中文文案集中在 ../prompt-copy-zh-cn.ts。
// buildSecurityNotice / buildHarnessBlock 的语言参数可选——工作流子代理身份段
// （sections/workflow-actor.ts）继续不传参，逐字复用英文版。

import type { ContextSection } from "../types.js";
import type { OutputStylePromptConfig } from "../types.js";
import { estimateTokens } from "../utils.js";
import {
  HARNESS_BLOCK_ZH_CN,
  IDENTITY_INTRO_OUTPUT_STYLE_ZH_CN,
  IDENTITY_INTRO_ZH_CN,
  SECURITY_NOTICE_ZH_CN,
  isChinesePromptLanguage,
} from "../prompt-copy-zh-cn.js";

const SECURITY_NOTICE =
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

/** 安全 IMPORTANT 行：交互式身份与工作流子代理身份共用，逐字同一份。 */
export function buildSecurityNotice(language?: string): string {
  return isChinesePromptLanguage(language) ? SECURITY_NOTICE_ZH_CN : SECURITY_NOTICE;
}

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

  const identityLines = ["", intro, "", buildSecurityNotice(language)].join("\n");

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
