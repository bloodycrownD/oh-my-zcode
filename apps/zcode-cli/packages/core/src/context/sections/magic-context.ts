// ============================================================
// Magic Context Section Builder
// ============================================================
// Step 13（D1 / spec Step 13）——`## Magic Context` agent 系统提示词段的落位。
//
// 文案本体在上游逐字区（`@zcode/magic-context` 的 `core/agents/magic-context-prompt.ts`，
// 211 行真身，Step 12 壳缝①落位）。本文件只做 core 的活：**把一个已装配好的字符串放进
// section 栈**，并按 spec 裁定与 ZCode 原生 `# Memory` 段互斥。
//
// 为什么「互斥」而不是「共存」：原生 `# Memory` 段（sections/memory.ts）教模型把事实写成
// `<memoryRoot>/` 下的 Markdown 文件、维护 `MEMORY.md` 索引；而 magic-context 的段教模型
// 用 `ctx_memory` 往 SQLite 记忆库钉 `#id: fact` 行。同一轮对话里给两套「如何记忆」的
// 指令，模型会按训练先验挑一套（通常是文件式），于是另一套的写入口永远空着——这正是
// 本批缺陷④「只接了压缩半边、记忆半边整缺」的现场症状之一。裁定：magicContext 开着时
// 原生段退场，且退场是**二选一**而不是「都注入但提示只提一个」。
//
// 装配权在 bootstrap（见 runtime/helpers/magic-context-prompt-section.ts 的端口说明），
// 本文件拿到的已经是最终字节。

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

/** 段标题。与上游 `buildMagicContextSection` 的输出字面一致（cp 对 cp 的注册依据）。 */
export const MAGIC_CONTEXT_SECTION_HEADING = "## Magic Context";

/**
 * 把已装配的 `## Magic Context` 段包成 ContextSection。
 *
 * `content` 必须是以上述 heading 开头的完整段文本；否则说明装配层的 resolver 出了岔子
 * （返回了别的段或被截断的字节），这里大声失败而不是静默注入一段没有标题的散文——
 * system prompt 里一段无标题的指令会被模型当成上一段的续句。
 *
 * 返回 `null` = 不注入（缺席或空内容）。
 */
export function buildMagicContextSectionEntry(content: string | undefined): ContextSection | null {
  if (content === undefined) return null;
  if (!content.startsWith(MAGIC_CONTEXT_SECTION_HEADING)) {
    throw new Error(
      `ContextBuilder: magic context section must start with ${JSON.stringify(MAGIC_CONTEXT_SECTION_HEADING)}`,
    );
  }
  if (content.trim().length === 0) return null;

  return {
    name: "Magic Context",
    source: "magic_context",
    injectionTarget: "system",
    // dynamic：preset / guidance 覆盖 / memory 开关都可能在会话中途变化，段文本随之变。
    // 声明成 dynamic 让 provider 侧的 cache break 路径显式处理它，而不是假装它稳定。
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
