type ProviderFetch = typeof globalThis.fetch;

const SSE_FRAME_SEPARATOR_PATTERN = /\r\n\r\n|\n\n|\r\r/;

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

export function createAnthropicCompatFetch(baseFetch: ProviderFetch): ProviderFetch {
  return async (input, init) => {
    const response = await baseFetch(input, applyAnthropicRequestBodyCompatibility(init));
    return rewriteAnthropicJsonThinkingResponse(filterAnthropicStream(response));
  };
}

function applyAnthropicRequestBodyCompatibility(
  init: RequestInit | undefined,
): RequestInit | undefined {
  if (typeof init?.body !== "string") return init;

  const body = safeParseRecord(init.body);
  if (!body) return init;
  const restoredMagicContextBody = restoreMagicContextMessageBoundaries(body);
  const restoredSystemBody = restoreMidConversationSystemStringContent(restoredMagicContextBody);
  if (restoredSystemBody === body) return init;

  return {
    ...init,
    body: JSON.stringify(restoredSystemBody),
  };
}

// FORK (upstream-v3.15.1-backport)：上游对 memory selector 的「合并后拆分」修复
// （restoreMemorySelectorMessageBoundaries：按 output_config.format.schema 判据 + 固定正文前缀
// 把首条 user 的两个文本块拆回两条消息）在 fork 全树零触发——fork 的 selector 不是同族格式。
// fork 的同形真实威胁是 magic-context 的 m[0]/m[1]：`inject-compartments.ts` 的
// prependM0M1Messages unshift 两条相邻 synthetic user，`hoistHeadsAfterSystemPrefix` 保证它们
// 相邻；`@ai-sdk/anthropic` 的 convertToAnthropicMessagesPrompt 在 groupIntoBlocks 里**无条件**
// 合并连续同角色消息，m[0]/m[1] 边界会被吞进一条 wire message，破坏 memory 注入的双消息基线。
//
// 判据按 fork 投影形状自研：m[0]/m[1] 投影后都是完整的 `<system-reminder>` 信封文本
// （wrapSystemReminderForSource 恒定包装），m[0] 可带 mural image part、m[1] 恒纯文本；
// 正文没有固定前缀可用（段序随渲染预算变化），所以判据只能用「信封完整性 + 结构标签」。
// 拆分范围与上游同法：只还原 m[0]/m[1] 各自的边界，其余段（prompt_attachment 等信封与本轮
// 真实 user 输入）保持合并；上游先例证明 Anthropic API 接受 wire 级连续 user 消息，拆分安全。
function restoreMagicContextMessageBoundaries(
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

function restoreMidConversationSystemStringContent(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;

  let changed = false;
  const messages = body.messages.map((value) => {
    const message = safeRecord(value);
    if (message?.role !== "system") return value;
    const text = singlePlainTextBlock(message.content);
    if (text === undefined) return value;

    changed = true;
    return { ...message, content: text };
  });

  // 在最终 messages[] 中保留 string content；
  // AI SDK 会将同一纯文本扩成单元素 block array。这里只恢复该 wire shape，顶层
  // system[]、带 cache_control 的 block 和其他 message role 均保持原样。
  return changed ? { ...body, messages } : body;
}

function singlePlainTextBlock(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const block = safeRecord(value[0]);
  if (block?.type !== "text" || typeof block.text !== "string") return undefined;
  if (Object.keys(block).some((key) => key !== "type" && key !== "text")) return undefined;
  return block.text;
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

function shouldFilterAnthropicStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true;
}

function filterAnthropicStream(response: Response): Response {
  if (!shouldFilterAnthropicStream(response)) {
    return response;
  }

  const body = response.body;
  if (!body) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  return new Response(body.pipeThrough(createAnthropicStreamCompatTransform()), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function rewriteAnthropicJsonThinkingResponse(response: Response): Promise<Response> {
  if (!shouldRewriteAnthropicJson(response)) {
    return response;
  }

  const text = await response.clone().text();
  const parsed = safeParseRecord(text);
  if (!parsed) {
    return response;
  }

  const sanitized = sanitizeJsonThinkingBlocks(parsed);
  if (!sanitized.changed) {
    return response;
  }

  return cloneTextResponse(response, JSON.stringify(sanitized.value));
}

function shouldRewriteAnthropicJson(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/json") || contentType.includes("+json");
}

function cloneTextResponse(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function sanitizeJsonThinkingBlocks(value: Record<string, unknown>): {
  changed: boolean;
  value: Record<string, unknown>;
} {
  if (!Array.isArray(value.content)) {
    return { changed: false, value };
  }

  const content = value.content.filter((block) => !isUnsignedThinkingBlock(block));
  if (content.length === value.content.length) {
    return { changed: false, value };
  }

  return {
    changed: true,
    value: {
      ...value,
      content,
    },
  };
}

function isUnsignedThinkingBlock(value: unknown): boolean {
  const block = safeRecord(value);
  if (block?.type !== "thinking") {
    return false;
  }

  // 部分 Anthropic-compatible 服务在非流式 JSON 中返回无签名
  // thinking block。AI SDK 会按 Anthropic 原生 schema 校验 signature 并拒绝
  // 整个响应；这里删除不可校验的思考块，保留 text/usage/stop_reason 继续解析。
  return typeof block.signature !== "string" && typeof block.redactedData !== "string";
}

interface AnthropicStreamCompatState {
  pendingThinkingSignatures: Map<number, string>;
  suppressedIndexes: Set<number>;
}

function createAnthropicStreamCompatTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state: AnthropicStreamCompatState = {
    pendingThinkingSignatures: new Map(),
    suppressedIndexes: new Set(),
  };
  let pending = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      pending = emitCompleteFrames(pending, controller, encoder, state);
    },
    flush(controller) {
      pending += decoder.decode();
      pending = emitCompleteFrames(pending, controller, encoder, state);
      if (pending.length > 0) {
        emitFrame(pending, "", controller, encoder, state);
      }
    },
  });
}

function emitCompleteFrames(
  input: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: AnthropicStreamCompatState,
): string {
  let pending = input;
  for (;;) {
    const match = SSE_FRAME_SEPARATOR_PATTERN.exec(pending);
    if (!match) {
      return pending;
    }

    const separator = match[0] ?? "";
    const frame = pending.slice(0, match.index);
    pending = pending.slice(match.index + separator.length);
    emitFrame(frame, separator, controller, encoder, state);
  }
}

function emitFrame(
  frame: string,
  separator: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: AnthropicStreamCompatState,
): void {
  const decision = decideFrame(frame, state);
  if (decision === false) {
    return;
  }

  if (decision !== true) {
    controller.enqueue(encoder.encode(createSignatureDeltaFrame(decision, separator)));
  }
  controller.enqueue(encoder.encode(`${frame}${separator}`));
}

function decideFrame(
  frame: string,
  state: AnthropicStreamCompatState,
): boolean | { index: number; signature: string } {
  const data = readSseData(frame);
  if (data === undefined || data === "[DONE]") {
    return true;
  }

  const parsed = safeParseRecord(data);
  if (!parsed) {
    return true;
  }

  const type = typeof parsed.type === "string" ? parsed.type : undefined;
  if (type === "message_start") {
    state.pendingThinkingSignatures.clear();
    state.suppressedIndexes.clear();
    return true;
  }

  const index = typeof parsed.index === "number" ? parsed.index : undefined;
  if (index === undefined) {
    return true;
  }

  if (type === "content_block_start") {
    const block = safeRecord(parsed.content_block);
    if (
      block?.type === "thinking" &&
      typeof block.signature === "string" &&
      block.signature.length > 0
    ) {
      state.pendingThinkingSignatures.set(index, block.signature);
    }

    // Some Anthropic-compatible APIs expose provider-internal image tool results as
    // assistant-side bare tool_result blocks. AI SDK rejects that non-standard shape.
    if (block?.type === "tool_result") {
      state.suppressedIndexes.add(index);
      return false;
    }
  }

  if (type === "content_block_delta" && safeRecord(parsed.delta)?.type === "signature_delta") {
    state.pendingThinkingSignatures.delete(index);
  }

  let missingSignatureDelta: { index: number; signature: string } | undefined;
  if (type === "content_block_stop") {
    const signature = state.pendingThinkingSignatures.get(index);
    state.pendingThinkingSignatures.delete(index);
    if (signature) {
      // 部分 Anthropic-compatible 服务把最终签名直接放在 thinking start，
      // 但 AI SDK 只从 signature_delta 读取签名；仅在缺少原生 delta 时补成标准事件。
      missingSignatureDelta = { index, signature };
    }
  }

  if (state.suppressedIndexes.has(index)) {
    if (type === "content_block_stop") {
      state.suppressedIndexes.delete(index);
    }
    return false;
  }

  return missingSignatureDelta ?? true;
}

function createSignatureDeltaFrame(
  value: { index: number; signature: string },
  separator: string,
): string {
  const frameSeparator = separator || "\n\n";
  const lineEnding =
    frameSeparator === "\r\n\r\n" ? "\r\n" : frameSeparator === "\r\r" ? "\r" : "\n";
  const data = JSON.stringify({
    type: "content_block_delta",
    index: value.index,
    delta: { type: "signature_delta", signature: value.signature },
  });
  return `event: content_block_delta${lineEnding}data: ${data}${frameSeparator}`;
}

function readSseData(frame: string): string | undefined {
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r\n|\n|\r/)) {
    if (!rawLine.startsWith("data:")) {
      continue;
    }

    let value = rawLine.slice("data:".length);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    dataLines.push(value);
  }

  return dataLines.length === 0 ? undefined : dataLines.join("\n");
}

function safeParseRecord(value: string): Record<string, unknown> | undefined {
  try {
    return safeRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
