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
//
// Step 18（spec Step 18 / T-P2 / N2 终局）：本文件另承担两件收口——
//   ① OQ-PS（cr-fix-spec 波次⑤）：空串 / 纯空白内容归 `null` 路径。「空=不注入」是
//      契约注释承诺的语义，但旧实现里 heading 校验先执行（`"".startsWith(heading)`
//      为 false 直接抛错），使「空串→null」成为死代码；将来 resolver 若以 `""` 表达
//      「本会话不注入」，每轮 context build 都会在这里崩。
//   ② ctx_note 引用的 host 装配层最小适配（`degradeCtxNoteReference`）：上游 211 行
//      段真身无条件把 `ctx_note` 介绍成「托盘」工具，而该工具按 N2 终局不在 ZCode
//      注册面内。适配落在宿主侧本文件（漏斗），**不改动包内逐字常量**，差异在此登记。

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

/** 段标题。与上游 `buildMagicContextSection` 的输出字面一致（cp 对 cp 的注册依据）。 */
export const MAGIC_CONTEXT_SECTION_HEADING = "## Magic Context";

/**
 * Step 18（spec Step 18 / N2 终局）：ctx_note 引用的 host 装配层最小适配。
 *
 * 背景：上游 211 行段真身（`@zcode/magic-context` 的
 * `core/agents/magic-context-prompt.ts`，逐字常量 `CTX_NOTE_GUIDANCE` 与
 * `CTX_NOTE_GUIDANCE_LIGHT`）无条件把 `ctx_note` 介绍成「待办托盘」工具。但 ctx_note
 * 按 spec N2 **终局不注册**——ZCode 的 D 组工具面只有 ctx_reduce / ctx_expand /
 * ctx_search / ctx_memory 四条（contracts 的四个 `CTX_*_TOOL_NAME` 常量是注册事实）。
 * 原句不受任何 flag 控制（`dreamerEnabled` 只摘掉 SMART_NOTE 从句，主语句在场），
 * 因此按 spec「无 flag 则 host 装配处最小适配」的口径在此收口。
 *
 * 为何落在这里而不是包内：`src/core/**` 是上游逐字移植区、纪律是零改动，适配只能落
 * 宿主侧。`buildMagicContextSectionEntry` 是段文本进入 system prompt 的**唯一漏斗**
 * （主路径 `context/builder.ts:104` 与子智能体路径 `subagent/context-builder.ts:152`
 * 都经过它），一份实现覆盖两条注入路径，不产生第二条写入路径。
 *
 * 适配口径：把两句托盘文案**逐字**替换为「本宿主没有这个工具」的降级说明，并把待办的
 * 归宿指回已注册的 `ctx_memory`（跨会话耐久之事的落点）。匹配是逐字 regex——上游若改
 * 写句子，匹配落空、ctx_note 引用会原样留在段里，`core/scripts/
 * test-magic-context-section-ctx-note.mjs` 的闭合断言随即变红（fail-visible），不会
 * 静默注入一条介绍幽灵工具的指令。降级文案与上游句子的差异在本注登记：
 *   - 上游：「`ctx_note` is the tray for work you intend to return to…（托盘隐喻）」；
 *   - 宿主：「`ctx_note` is not available on this host: … `ctx_memory`」——删隐喻、
 *     明示缺席、给已注册替代。其余字节（partner frame / desk 副本 / §N§ 规则）不动。
 */
const CTX_NOTE_TRAY_SENTENCE =
  /`ctx_note` is the tray for work you intend to return to.*?(?:goes in the tray\.|goes there)/gs;

const CTX_NOTE_DEGRADED_SENTENCE =
  "`ctx_note` is not available on this host: keep work you intend to return to in your own reasoning for the rest of the turn, and pin anything that must survive beyond this session with `ctx_memory`";

/** 把段文本里的 ctx_note 托盘文案替换为宿主降级说明；无则不碰一个字节。 */
function degradeCtxNoteReference(content: string): string {
  return content.replaceAll(CTX_NOTE_TRAY_SENTENCE, CTX_NOTE_DEGRADED_SENTENCE);
}

/**
 * 把已装配的 `## Magic Context` 段包成 ContextSection。
 *
 * `content` 必须是以上述 heading 开头的完整段文本；否则说明装配层的 resolver 出了岔子
 * （返回了别的段或被截断的字节），这里大声失败而不是静默注入一段没有标题的散文——
 * system prompt 里一段无标题的指令会被模型当成上一段的续句。
 *
 * 返回 `null` = 不注入（缺席或空内容）。
 *
 * Step 18（cr-fix-spec 波次⑤ OQ-PS）：空串 / 纯空白归 `null` 路径，且判定必须先于
 * heading 校验——「空=不注入」是契约承诺的语义，而 heading 校验对空串是抛错，两者
 * 的顺序反过来会让空串永远走不到 null（未来 resolver 以 `""` 表达不注入时每轮崩）。
 */
export function buildMagicContextSectionEntry(content: string | undefined): ContextSection | null {
  if (content === undefined || content.trim().length === 0) return null;
  if (!content.startsWith(MAGIC_CONTEXT_SECTION_HEADING)) {
    throw new Error(
      `ContextBuilder: magic context section must start with ${JSON.stringify(MAGIC_CONTEXT_SECTION_HEADING)}`,
    );
  }

  // Step 18（spec Step 18 / N2）：ctx_note 引用的 host 装配层最小适配——在段文本
  // 进入 system prompt 前把上游的幽灵工具说明换成宿主降级说明（理由见上方长注）。
  const adapted = degradeCtxNoteReference(content);

  return {
    name: "Magic Context",
    source: "magic_context",
    injectionTarget: "system",
    // dynamic：preset / guidance 覆盖 / memory 开关都可能在会话中途变化，段文本随之变。
    // 声明成 dynamic 让 provider 侧的 cache break 路径显式处理它，而不是假装它稳定。
    cacheHint: "dynamic",
    chars: adapted.length,
    tokens: estimateTokens(adapted),
    content: adapted,
    preview: adapted.slice(0, 100),
  };
}
