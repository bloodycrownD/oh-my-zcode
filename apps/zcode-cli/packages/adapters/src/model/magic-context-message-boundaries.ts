/**
 * FORK：把被 `@ai-sdk/anthropic` 合并掉的 magic-context 双 user 消息边界还原回 wire。
 *
 * 为什么单独成文件：`anthropic-stream-compat.ts` 是上游 ZCode 的 Anthropic 传输层
 * 兼容垫片，跟随上游升级时改动概率高；这段判据是本 fork 独有的（上游对应的是
 * memory selector 的另一套形状，在 fork 全树零触发），夹在里面纯属冲突面。
 *
 * ---------------------------------------------------------------------------
 * 判据来源（搬自原文件注释）
 * ---------------------------------------------------------------------------
 *
 * 上游对 memory selector 的「合并后拆分」修复（restoreMemorySelectorMessageBoundaries：
 * 按 output_config.format.schema 判据 + 固定正文前缀把首条 user 的两个文本块拆回两条
 * 消息）在 fork 全树零触发——fork 的 selector 不是同族格式。
 *
 * fork 的同形真实威胁是 magic-context 的 m[0]/m[1]：`inject-compartments.ts` 的
 * prependM0M1Messages unshift 两条相邻 synthetic user，`hoistHeadsAfterSystemPrefix`
 * 保证它们相邻；`@ai-sdk/anthropic` 的 convertToAnthropicMessagesPrompt 在
 * groupIntoBlocks 里**无条件**合并连续同角色消息，m[0]/m[1] 边界会被吞进一条 wire
 * message，破坏 memory 注入的双消息基线。
 *
 * 判据按 fork 投影形状自研：m[0]/m[1] 投影后都是完整的 `<system-reminder>` 信封文本
 * （wrapSystemReminderForSource 恒定包装），m[0] 可带 mural image part、m[1] 恒纯文本；
 * 正文没有固定前缀可用（段序随渲染预算变化），所以判据只能用「信封完整性 + 结构标签」。
 * 拆分范围与上游同法：只还原 m[0]/m[1] 各自的边界，其余段（prompt_attachment 等信封
 * 与本轮真实 user 输入）保持合并；上游先例证明 Anthropic API 接受 wire 级连续 user
 * 消息，拆分安全。
 */

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

export function restoreMagicContextMessageBoundaries(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  if (!messages) return body;

  // m[0]/m[1] 是请求前缀（descriptor channel=request_prefix），恒为 body.messages 里最早的
  // user 消息；SDK 合并后边界只剩第一条 user message 可还原。只查这一条——历史里的真实
  // 用户消息不参与判定，避免误拆。
  const headIndex = messages.findIndex((value) => safeRecord(value)?.role === "user");
  if (headIndex < 0) return body;

  const headMessage = safeRecord(messages[headIndex]);
  const content = Array.isArray(headMessage?.content) ? headMessage.content : undefined;
  if (!headMessage || !content || content.length < 2) return body;

  const deltaIndex = findMagicContextDeltaIndex(content);
  if (deltaIndex < 0) return body;

  const restored: Record<string, unknown>[] = [
    // m[0]：信封文本 + 可能跟随的 mural 图片块（`{...headMessage}` 保留其余 wire 字段）。
    { ...headMessage, content: content.slice(0, deltaIndex) },
    { role: "user", content: [content[deltaIndex]] },
  ];
  if (deltaIndex + 1 < content.length) {
    // 其余段保持合并：prompt_attachment 等信封与本轮 user 输入仍归一条消息。
    restored.push({ role: "user", content: content.slice(deltaIndex + 1) });
  }

  return {
    ...body,
    messages: [...messages.slice(0, headIndex), ...restored, ...messages.slice(headIndex + 1)],
  };
}

/**
 * 在合并体里定位 m[1] 增量信封，返回其下标；未命中返回 -1。
 *
 * 判据全部是结构判据（无正文前缀）：
 *  - content[0] 必须是完整的 m[0] 信封：`<system-reminder>` 全包，且正文含完整
 *    `<session-history>` 元素——renderM0 恒定产出该段（空历史时是
 *    `<session-history></session-history>`，即 M0_EMPTY_BODY）。
 *  - m[1] 必须是其后第一个文本块，且是完整信封 + 正文恰好是 `<session-history-since>`
 *    元素——renderM1 恒定产出该段（无新内容时是带占位正文的同标签元素）。
 *  - 两块之间只允许非文本块（mural 图片等）。出现其它文本块即判负：真实用户输入含
 *    `<system-reminder>` 或结构标签文本时形状对不上，不拆——宁可漏拆不误拆。
 */
function findMagicContextDeltaIndex(content: readonly unknown[]): number {
  if (!isMagicContextBaselineEnvelope(content[0])) return -1;

  for (let index = 1; index < content.length; index += 1) {
    const block = content[index];
    if (isMagicContextDeltaEnvelope(block)) return index;
    if (safeRecord(block)?.type === "text") return -1;
  }
  return -1;
}

function isMagicContextBaselineEnvelope(value: unknown): boolean {
  const body = magicContextEnvelopeBody(value);
  return body !== undefined && containsElement(body, "session-history");
}

function isMagicContextDeltaEnvelope(value: unknown): boolean {
  const body = magicContextEnvelopeBody(value);
  return (
    body !== undefined &&
    body.startsWith("<session-history-since>") &&
    body.endsWith("</session-history-since>")
  );
}

/**
 * 完整 `<system-reminder>` 信封 → 正文；否则 undefined。
 * 允许合并层（reasoning-history-normalization / provider-request-messages 的
 * mergeUserContent）在前一块末尾补的 `\n`，故用 trim 收敛首尾空白。
 */
function magicContextEnvelopeBody(value: unknown): string | undefined {
  const block = safeRecord(value);
  if (block?.type !== "text" || typeof block.text !== "string") return undefined;

  const text = block.text.trim();
  if (!text.startsWith(`${SYSTEM_REMINDER_OPEN}\n`)) return undefined;
  if (!text.endsWith(`\n${SYSTEM_REMINDER_CLOSE}`)) return undefined;

  return text.slice(
    SYSTEM_REMINDER_OPEN.length + 1,
    text.length - SYSTEM_REMINDER_CLOSE.length - 1,
  );
}

function containsElement(body: string, tag: string): boolean {
  const openIndex = body.indexOf(`<${tag}>`);
  return openIndex >= 0 && body.indexOf(`</${tag}>`, openIndex) > openIndex;
}

/** 与宿主文件 `safeRecord` 同形（4 行小工具，本地复制以避免反向依赖）。 */
function safeRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
