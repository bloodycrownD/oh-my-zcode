#!/usr/bin/env node
/**
 * Step 19b — core 集成单测（node:test，零新依赖）。
 *
 * 覆盖本步真正交付的那段代码——**投影 → transform → 反投影**这一圈，以及 turn-loop
 * 插入点的门控：
 *
 *   1. flag off（端口缺席）→ 输出与输入**逐引用相等**（同一份数组）。
 *   2. flag on 但配置显式关闭 → 同样逐引用相等（防御性二次门控）。
 *   3. 桩 transform 注入 m[0]/m[1] → 它们落在**开头 system 段之后**、位于最前、
 *      `metadata.source === "magic_context"`，且原 user 轮次序保持。
 *   4. 桩 transform 改写一条 user 文本（模拟 §N§ 打标）→ 那一条被重建，其余条目
 *      仍是**原对象**（cache 前缀稳定性的前提）。
 *   5. 桩 transform 抛普通错 → fail-open 放行原始输入（B 组第 ⑤ 档）。
 *   6. 桩 transform 抛 EmergencyFailClosedError → 重抛（B 组第 ① 档）。
 *   7. wire 调试摘要的形状：role / source / syntheticHead / cacheControl 落点。
 *
 * 真实 `createTransform` 不在本测试范围内：它需要 magic-context.db 与 historian，
 * 属 S20/S24 的实跑范围（T-M4）。这里用**桩 transform**驱动同一条链路，验的是
 * Step 19b 自己拥有的代码（反投影与落位），不是 B 组的注入决策。
 *
 * 依赖已构建的 `dist/`：`pnpm --filter @zcode/magic-context build`、
 * `pnpm --filter @zcode/core build`、`pnpm --filter @zcode/bootstrap build`。
 * 本模块在运行时只 import `@zcode/magic-context`，所以加载代价很小。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MAGIC_CONTEXT_CONFIG, EmergencyFailClosedError } from "@zcode/magic-context";

// core 的这段 helper 是零运行时 import 的纯门控 + 诊断模块，因此可以直接按文件路径
// 加载（`@zcode/core` 的包入口会拉起 contracts/shared 的 workspace `src/*.ts`，
// 那是 bundler 的活，node 直接 import 不了）。
const CORE_HELPER = new URL(
  "../../core/dist/runtime/helpers/magic-context-turn-transform.js",
  import.meta.url,
);
const { buildMagicContextWireDebugSnapshot, runMagicContextTurnTransform } = await import(
  CORE_HELPER.href
);

const { createZCodeMagicContextTurnTransformPort } = await import(
  new URL("../dist/app/magic-context-turn-transform.js", import.meta.url).href
);

const SESSION_ID = "ses_test_magic_context";
const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

/** 一条真实的 ZCode request entries：system → user → assistant(toolCall) → tool → user。 */
function sampleEntries() {
  return [
    { kind: "message", message: { role: "system", content: "you are zcode" } },
    {
      kind: "message",
      message: { role: "user", content: "first question" },
      metadata: { source: "real_user" },
    },
    {
      kind: "message",
      message: {
        role: "assistant",
        content: "let me read it",
        toolCalls: [{ id: "call_1", name: "read", input: { path: "a.ts" } }],
      },
    },
    {
      kind: "message",
      message: { role: "tool", content: "file body", toolCallId: "call_1", toolName: "read" },
    },
    {
      kind: "message",
      message: { role: "user", content: "second question" },
      metadata: { source: "real_user" },
    },
  ];
}

function portWith(transform, config = DEFAULT_MAGIC_CONTEXT_CONFIG) {
  return createZCodeMagicContextTurnTransformPort(transform, config, {
    sessionId: SESSION_ID,
    logger: NOOP_LOGGER,
  });
}

async function runPort(port, entries) {
  return await port({
    entries,
    model: { providerId: "zcode", modelId: "glm-4.6" },
    sessionId: SESSION_ID,
    workingDirectory: "D:/tmp/project",
  });
}

/** 复刻 `inject-compartments.ts:prependM0M1Messages` 的注入形状。 */
const injectM0M1 = async (_input, output) => {
  output.messages.unshift(
    {
      info: { role: "user", sessionID: SESSION_ID, syntheticHead: true },
      parts: [{ type: "text", text: "<project-memory>…</project-memory>", synthetic: true }],
    },
    {
      info: { role: "user", sessionID: SESSION_ID, syntheticHead: true },
      parts: [{ type: "text", text: "<session-history>…</session-history>", synthetic: true }],
    },
  );
};

test("flag off（端口缺席）时输出与输入逐引用相等", async () => {
  const entries = sampleEntries();
  const out = await runMagicContextTurnTransform({ config: {} }, { entries });
  assert.equal(out, entries, "必须返回同一份数组，而不是副本");
});

test("配置显式关闭时同样逐引用相等（防御性二次门控）", async () => {
  const entries = sampleEntries();
  const out = await runMagicContextTurnTransform(
    {
      config: { magicContext: { enabled: false } },
      magicContextTurnTransform: portWith(injectM0M1),
    },
    { entries },
  );
  assert.equal(out, entries);
});

test("桩 transform 不改任何东西时输出逐引用等于输入", async () => {
  const entries = sampleEntries();
  const result = await runPort(
    portWith(async () => {}),
    entries,
  );
  assert.equal(result.outcome, "unchanged");
  assert.deepEqual(
    result.entries.map((entry) => entry === entries[result.entries.indexOf(entry)]),
    [true, true, true, true, true],
  );
  result.entries.forEach((entry, index) => assert.equal(entry, entries[index]));
});

test("m[0]/m[1] 落在最前（开头 system 段之后）且标记为 magic_context", async () => {
  const entries = sampleEntries();
  const result = await runPort(portWith(injectM0M1), entries);

  assert.equal(result.outcome, "applied");
  assert.equal(result.entries.length, entries.length + 2);
  assert.deepEqual(result.syntheticHeadPositions, [1, 2]);

  // system 仍是第一条、且是原对象。
  assert.equal(result.entries[0], entries[0]);
  // m[0]/m[1] 是 provider-visible 的 meta attachment。
  const m0 = result.entries[1];
  const m1 = result.entries[2];
  assert.equal(m0.kind, "attachment");
  assert.equal(m0.metadata.source, "magic_context");
  assert.match(m0.content, /<project-memory>/);
  assert.equal(m1.kind, "attachment");
  assert.equal(m1.metadata.source, "magic_context");
  assert.match(m1.content, /<session-history>/);

  // 原对话次序保持：user → assistant → tool → user。
  assert.deepEqual(
    result.entries.slice(3).map((entry) => entry.message.role),
    ["user", "assistant", "tool", "user"],
  );
  result.entries.slice(3).forEach((entry, index) => assert.equal(entry, entries[index + 1]));
});

test("transform 改写一条 user 文本时只有那一条被重建，其余仍是原对象", async () => {
  const entries = sampleEntries();
  const tagFirstUser = async (_input, output) => {
    // 模拟 §N§ 打标：只动第一条真实 user 消息的 text part。
    const target = output.messages[1];
    target.parts[0].text = `§1§ ${target.parts[0].text}`;
  };
  const result = await runPort(portWith(tagFirstUser), entries);

  assert.equal(result.outcome, "applied");
  assert.equal(result.entries.length, entries.length);
  assert.notEqual(result.entries[1], entries[1], "被改写的那条必须重建");
  assert.deepEqual(result.entries[1].message.content, [
    { type: "text", text: "§1§ first question" },
  ]);
  // metadata.source 保留 —— 否则 provider projection 会把它当 legacy_synthetic 气泡。
  assert.equal(result.entries[1].metadata.source, "real_user");

  // 其余条目保持对象身份（cache 前缀稳定性的前提）。
  assert.equal(result.entries[0], entries[0]);
  assert.equal(result.entries[2], entries[2], "带 toolCalls 的 assistant 也应复用原对象");
  assert.equal(result.entries[3], entries[3], "tool 结果 entry 也应复用原对象");
  assert.equal(result.entries[4], entries[4]);
});

test("普通错误按 B 组第 ⑤ 档 fail-open：放行原始输入", async () => {
  const entries = sampleEntries();
  const result = await runPort(
    portWith(async () => {
      throw new Error("boom");
    }),
    entries,
  );
  assert.equal(result.outcome, "fail_open");
  result.entries.forEach((entry, index) => assert.equal(entry, entries[index]));
});

test("EmergencyFailClosedError 按 B 组第 ① 档重抛", async () => {
  const entries = sampleEntries();
  await assert.rejects(
    () =>
      runPort(
        portWith(async () => {
          throw new EmergencyFailClosedError("engine down");
        }),
        entries,
      ),
    (error) => error instanceof EmergencyFailClosedError,
  );
});

test("fail_closed_blocking=false 时 fail-closed 降级为放行", async () => {
  const entries = sampleEntries();
  const config = { ...DEFAULT_MAGIC_CONTEXT_CONFIG, fail_closed_blocking: false };
  const result = await runPort(
    portWith(async () => {
      throw new EmergencyFailClosedError("engine down");
    }, config),
    entries,
  );
  assert.equal(result.outcome, "fail_open");
  result.entries.forEach((entry, index) => assert.equal(entry, entries[index]));
});

test("wire 调试摘要给出 role / source / syntheticHead / cacheControl 落点", () => {
  const entries = sampleEntries();
  entries[0].message.cacheControl = { type: "ephemeral" };
  const withHeads = [
    entries[0],
    { kind: "attachment", content: "<project-memory/>", metadata: { source: "magic_context" } },
    ...entries.slice(1),
  ];
  const snapshot = buildMagicContextWireDebugSnapshot(withHeads, [1]);

  assert.equal(snapshot.total, withHeads.length);
  assert.equal(snapshot.syntheticHeadCount, 1);
  assert.deepEqual(snapshot.syntheticHeadPositions, [1]);
  assert.equal(snapshot.entries[0].role, "system");
  assert.equal(snapshot.entries[0].entryCacheControl, '{"type":"ephemeral"}');
  assert.equal(snapshot.entries[1].source, "magic_context");
  assert.equal(snapshot.entries[1].syntheticHead, true);
  assert.equal(snapshot.entries[2].syntheticHead, false);
  assert.equal(snapshot.entries[2].role, "user");
  assert.equal(snapshot.entries[2].source, "real_user");
});
