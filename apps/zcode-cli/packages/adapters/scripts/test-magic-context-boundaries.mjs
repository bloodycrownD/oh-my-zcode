#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）T-MC-1——magic-context m0/m1 消息边界在 wire 层保持独立。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 P6 #34）
 * ============================================================================
 *
 * magic-context 的 memory selector 基线是**两条相邻的 synthetic user 消息**（m0 会话摘要 +
 * m1 增量分舱）。`@ai-sdk/anthropic` 的 `convertToAnthropicMessagesPrompt` 会无条件把连续同
 * 角色 user 并为一条 wire 消息——基线被吃掉，selector 再也认不出这两段。
 *
 * fork 的修复（`restoreMagicContextMessageBoundaries`，挂在 `createAnthropicCompatFetch`）在
 * **发请求前**把已合并的 m0/m1 按信封结构拆回独立消息；只拆 m0/m1 边界，其余段保持合并
 * （对齐上游先例：Anthropic API 接受 wire 级连续 user 消息）。
 *
 * 本脚本用**真实 SDK**（`createAnthropic` + `doStream` → 真实 `convertToAnthropicMessagesPrompt`）
 * 生成合并体，再经 compat fetch 还原，断言最终 wire body。覆盖：
 *   形态 1  三段合并体（m0 纯文本 / m1 / 本轮输入）
 *   形态 2  m0 带 mural image
 *   形态 3  四段合并体（m1 与输入之间夹 prompt_attachment 信封）——其余段保持合并
 *   形态 4  拆分不新增 cache_control 断点（只最后一段末块携带）
 *   形态 5  合并体前有 system role 消息（直传 wire body）
 *   形态 6  fork 合并层补的尾随 "\n" 容错
 *   负例 1  真实用户输入含 <system-reminder> 文本不被误拆
 *   负例 2  用户粘贴「像 m0 但缺 session-history 结构」的信封文本不拆
 *   负例 3  本就分离的 m0/m1（SDK 未合并）逐字节不变
 *   负例 4  首条 user 不是 m0 时保守不动
 *
 * 运行：`node --test scripts/test-magic-context-boundaries.mjs`
 * （先 `pnpm --filter @zcode/adapters build`。）
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(`${specifier.split("/").slice(0, 2).join("/")}`)
        ? `${specifier.split("/").slice(0, 2).join("/")}`
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

const { createAnthropic } = await import("@ai-sdk/anthropic");
// FORK (upstream-v3.15.1-backport) T-MC-1: 被测符号经 compat fetch 挂载点进入
// （model-execution.ts 的 createAnthropicCompatFetch 同形）。
const { createAnthropicCompatFetch } = await import("../dist/model/anthropic-stream-compat.js");

const M0_ENVELOPE =
  "<system-reminder>\n<session-history>\n[compartment §1§] 旧会话摘要\n</session-history>\n</system-reminder>";
const M1_ENVELOPE =
  "<system-reminder>\n<session-history-since>\n<new-compartments>\n新增分舱\n</new-compartments>\n</session-history-since>\n</system-reminder>";
const M1_EMPTY_ENVELOPE =
  "<system-reminder>\n<session-history-since>(no new content since last materialization)</session-history-since>\n</system-reminder>";
const ATTACH_ENVELOPE =
  "<system-reminder>\n<referenced-session-context>\n引用片段\n</referenced-session-context>\n</system-reminder>";

/** 用真实 SDK 生成 wire body：base fetch 只负责把请求体截下来。 */
async function captureWireBody(prompt) {
  let captured;
  const baseFetch = async (_input, init) => {
    captured = JSON.parse(init.body);
    return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createAnthropic({
    apiKey: "test-key",
    baseURL: "https://example.test/v1",
    fetch: createAnthropicCompatFetch(baseFetch),
  });
  try {
    await provider("claude-sonnet-4-5").doStream({ prompt });
  } catch {
    // 只关心已发出的请求体，SSE 解析失败无所谓。
  }
  assert.ok(captured, "base fetch 未被调用，wire body 未捕获");
  return captured;
}

/** 直传 wire body：模拟 SDK 不可达的形态（前置 system role 消息等）。 */
async function sendRawWireBody(body) {
  let captured;
  const baseFetch = async (_input, init) => {
    captured = JSON.parse(init.body);
    return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const compatFetch = createAnthropicCompatFetch(baseFetch);
  await compatFetch("https://example.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return captured;
}

const userText = (text, providerOptions) => ({
  role: "user",
  content: [{ type: "text", text, ...(providerOptions ? { providerOptions } : {}) }],
});
const m0User = (extraParts = []) => ({
  role: "user",
  content: [{ type: "text", text: M0_ENVELOPE }, ...extraParts],
});
const muralPart = {
  type: "file",
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
};

test("T-MC-1 形态 1：三段合并体（m0 纯文本 / m1 / 本轮输入）拆回三条 user 消息", async () => {
  const body = await captureWireBody([
    { role: "system", content: "system prompt" },
    m0User(),
    userText(M1_ENVELOPE),
    userText("本轮用户输入"),
  ]);
  const { messages } = body;
  assert.equal(messages.length, 3, JSON.stringify(messages.map((m) => m.role)));
  assert.equal(messages[0].role, "user");
  assert.deepEqual(messages[0].content, [{ type: "text", text: M0_ENVELOPE }]);
  assert.deepEqual(messages[1].content, [{ type: "text", text: M1_ENVELOPE }]);
  assert.equal(messages[2].content[0].text, "本轮用户输入");
});

test("T-MC-1 形态 2：m0 带 mural image——image 块跟随 m0 独立成条", async () => {
  const body = await captureWireBody([
    { role: "system", content: "system prompt" },
    m0User([muralPart]),
    userText(M1_EMPTY_ENVELOPE),
    userText("带图轮输入"),
  ]);
  const { messages } = body;
  assert.equal(messages.length, 3);
  assert.equal(messages[0].content.length, 2);
  assert.equal(messages[0].content[0].text, M0_ENVELOPE);
  assert.equal(messages[0].content[1].type, "image");
  assert.equal(messages[1].content.length, 1);
  assert.equal(messages[1].content[0].text, M1_EMPTY_ENVELOPE);
});

test("T-MC-1 形态 3：四段合并体——只拆 m0/m1 边界，其余段保持合并", async () => {
  const body = await captureWireBody([
    { role: "system", content: "system prompt" },
    m0User(),
    userText(M1_ENVELOPE),
    userText(ATTACH_ENVELOPE),
    userText("四段场景输入"),
  ]);
  const { messages } = body;
  assert.equal(messages.length, 3, String(messages.length));
  assert.equal(messages[2].content.length, 2);
  assert.equal(messages[2].content[0].text, ATTACH_ENVELOPE);
  assert.equal(messages[2].content[1].text, "四段场景输入");
});

test("T-MC-1 形态 4：拆分不新增 cache_control 断点（仅最后一段末块）", async () => {
  const body = await captureWireBody([
    { role: "system", content: "system prompt" },
    m0User(),
    userText(M1_ENVELOPE),
    userText("带缓存断点的输入", { anthropic: { cacheControl: { type: "ephemeral" } } }),
  ]);
  const marked = [];
  for (let i = 0; i < body.messages.length; i += 1) {
    for (const block of body.messages[i].content) {
      if (block.cache_control) marked.push(`${i}:${block.type}`);
    }
  }
  assert.deepEqual(marked, [`${body.messages.length - 1}:text`]);
});

test("T-MC-1 形态 5：合并体前存在 system role 消息——跳过它仍拆首个 user 合并体", async () => {
  const body = await sendRawWireBody({
    model: "claude-sonnet-4-5",
    system: [{ type: "text", text: "system prompt" }],
    messages: [
      { role: "system", content: [{ type: "text", text: "mid conversation system" }] },
      {
        role: "user",
        content: [
          { type: "text", text: M0_ENVELOPE },
          { type: "text", text: M1_ENVELOPE },
          { type: "text", text: "前置 system 场景输入" },
        ],
      },
    ],
  });
  assert.equal(body.messages.length, 4, JSON.stringify(body.messages.map((m) => m.role)));
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].content[0].text, M0_ENVELOPE);
  assert.equal(body.messages[2].content[0].text, M1_ENVELOPE);
  assert.equal(body.messages[3].content[0].text, "前置 system 场景输入");
});

test('T-MC-1 形态 6：合并层尾随 "\\n" 容错', async () => {
  const body = await captureWireBody([
    { role: "system", content: "system prompt" },
    {
      role: "user",
      content: [
        { type: "text", text: `${M0_ENVELOPE}\n` },
        { type: "text", text: M1_ENVELOPE },
      ],
    },
  ]);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].content[0].text.trim(), M0_ENVELOPE);
  assert.equal(body.messages[1].content[0].text, M1_ENVELOPE);
});

test("T-MC-1 负例 1：真实用户输入含 <system-reminder> 文本不被误拆", async () => {
  const body = await captureWireBody([
    { role: "system", content: "system prompt" },
    m0User(),
    userText(M1_ENVELOPE),
    userText("帮我看看这段：<system-reminder>\nhello\n</system-reminder> 是什么意思？"),
  ]);
  assert.equal(body.messages.length, 3, String(body.messages.length));
  assert.equal(body.messages[2].content.length, 1);
  assert.equal(body.messages[2].content[0].text.includes("是什么意思？"), true);
});

test("T-MC-1 负例 2：像 m0 但缺 session-history 结构的信封文本不拆", async () => {
  const notM0Envelope =
    "<system-reminder>\n用户自己贴的提醒文本，不含 session-history 结构\n</system-reminder>";
  const body = await captureWireBody([
    { role: "system", content: "system prompt" },
    {
      role: "user",
      content: [
        { type: "text", text: notM0Envelope },
        { type: "text", text: "后半句" },
      ],
    },
  ]);
  assert.equal(body.messages.length, 1, String(body.messages.length));
});

test("T-MC-1 负例 3：已分离的 m0/m1 wire 消息逐字节不变", async () => {
  let captured = null;
  const baseFetch = async (_input, init) => {
    captured = init.body;
    return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createAnthropic({
    apiKey: "test-key",
    baseURL: "https://example.test/v1",
    fetch: createAnthropicCompatFetch(baseFetch),
  });
  // prompt 里 m0/m1 之间夹 assistant（SDK 不可能合并这两条），模拟未合并态。
  try {
    await provider("claude-sonnet-4-5").doStream({
      prompt: [
        { role: "system", content: "system prompt" },
        m0User(),
        { role: "assistant", content: [{ type: "text", text: "ack" }] },
        userText(M1_ENVELOPE),
      ],
    });
  } catch {
    // 同上：只关心请求体。
  }
  const parsed = JSON.parse(captured);
  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.messages[0].content[0].text, M0_ENVELOPE);
  assert.equal(parsed.messages[2].content[0].text, M1_ENVELOPE);
});

test("T-MC-1 负例 4：首条 user 不是 m0（保守不动）", async () => {
  const body = await sendRawWireBody({
    model: "claude-sonnet-4-5",
    messages: [
      { role: "user", content: [{ type: "text", text: "历史里的真实用户消息" }] },
      {
        role: "user",
        content: [
          { type: "text", text: M0_ENVELOPE },
          { type: "text", text: M1_ENVELOPE },
        ],
      },
    ],
  });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].content[0].text, "历史里的真实用户消息");
  assert.equal(body.messages[1].content.length, 2);
});
