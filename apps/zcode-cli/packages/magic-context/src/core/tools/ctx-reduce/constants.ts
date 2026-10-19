/**
 * 逐字移植自 `.reference/magic-context/packages/plugin/src/tools/ctx-reduce/constants.ts`。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

/**
 * FORK（magic-context-system-prompt-guard，guards/A-1）：
 * - 源位置：上游 `.reference/magic-context/packages/plugin/src/tools/ctx-reduce/constants.ts`；
 *   本文件为逐字移植区。
 * - 上游语义：上游没有 `tags.message_role` / system 消息保护概念，Keep 行之后没有禁盖句。
 * - ZCode 差异：fork 在 Keep 行后新增一句「Never stamp a system prompt segment…」，
 *   与 tags.message_role 四层防线配套。
 * - 同步面：宿主 full 描述（core/src/tool/handlers/ctx-context.ts）与包内 light 描述
 *   （core/tools/light-descriptions.ts）两处模型可见落点 + 本常量，共三处同步。
 * - 改动面：本常量当前**无模型可见消费方**（两调用方只取 `.execute`），保留此句并与
 *   上述两处同步，仅为与上游 diff 最小。
 */
export const CTX_REDUCE_DESCRIPTION = `Stamp an item on your desk as no longer needed for the work ahead. Not a delete: stamping QUEUES it, the item stays fully readable until Magic Context clears stamped items in one sweep, and the newest tags are protected so stamping recent output is harmless. A cleared item goes to the archive — a recent one leaves a \`[dropped §N§]\` placeholder, an older one leaves nothing — and \`ctx_expand(tag=N)\` is the way back. So the question before stamping is not "have I finished reading this?" but "does this need to stay on my desk for what comes next?" — a file you read and will keep editing stays; the grep that found it goes.

Stamp: file reads, search results and tool outputs the work ahead no longer needs; build/test output after you acted on it; repeated or redundant dumps; data written to disk; status/log output that only confirmed what you expected; a large block pasted inside a user message once you have used it.
Keep: user messages (never stamp one for its directive), your own conversation text, unresolved errors, raw evidence you haven't extracted yet, and outputs whose exact wording may still matter.
Never stamp a system prompt segment — tags on system (prompt) messages are protected and never archivable; a drop request containing them is refused.

Look at each tag before stamping it; never blanket-stamp a range like "1-50". Many small targeted stamps beat one sweep. \`drop\` accepts "3-5", "1,2,9", "1-5,8,12-15".`;