#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）T-MEM-2——工具结果媒体的落盘脱离本回合 Stop 信号。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 P2 #8）
 * ============================================================================
 *
 * 用户按下 Stop 会 abort 本回合的 signal；工具结果媒体（mural / 截图 / 附件）的落盘原先把这个
 * signal 一路透传给 artifact store，于是**已经跑完的工具**的媒体保存被中断，服务端只剩一段指向
 * 未落盘产物的引用——冷恢复（重启后重开会话）读到的就是丢内容的占位符。
 *
 * 修复：`persistToolResultMediaAttachments` 不再接收/透传 signal（已完成工具的媒体属于结果收尾），
 * 配套 `turn-tools.ts` 的调用点同步删掉 `signal:` 实参。两条都钉住：
 *   1) 行为面——落盘调用不带任何 signal，且全部媒体块都写成功；
 *   2) 接线面——调用点源码里不再出现 `signal:`（excess property 会编译错，这里是源码级防回潮）。
 *
 * 运行：`npx tsx --test scripts/test-tool-media-stop-signal.mjs`
 * （被测模块是 TypeScript 源码，与同目录 ctx 测试同范式）
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { persistToolResultMediaAttachments } =
  await import("../src/runtime/helpers/tool-result-media-persistence.ts");

const TRACE_CONTEXT = { traceId: "trace-t-mem-2" };
const BASE = {
  assistantMessageId: "msg-assistant-1",
  sessionId: "ses-t-mem-2",
  toolCallId: "call-1",
  toolName: "mural",
  traceContext: TRACE_CONTEXT,
  turnId: "turn-1",
};

/** 记录每次 writeToolResultArtifact 的入参，供"不带 signal"与"全量落盘"两条断言共用。 */
function createArtifactStore() {
  const calls = [];
  return {
    calls,
    store: {
      async writeToolResultArtifact(input) {
        calls.push(input);
        return { uri: `zcode-artifact://written-${calls.length}` };
      },
    },
  };
}

test("T-MEM-2 落盘调用不带 signal，且两个媒体块都完整写出", async () => {
  const { calls, store } = createArtifactStore();
  const result = await persistToolResultMediaAttachments({
    ...BASE,
    artifactStore: store,
    // sessionStore 只做"这一路径是否启用"的开关（函数只判存在性）。
    sessionStore: {},
    content: [
      { type: "text", text: "截图如下" },
      { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
      {
        type: "file",
        mediaType: "image/jpeg",
        name: "mural.jpg",
        dataUrl: "data:image/jpeg;base64,BBBB",
      },
    ],
  });

  assert.equal(calls.length, 2, "两个媒体块都必须写完（Stop 信号不得中断收尾）");
  for (const call of calls) {
    assert.equal(
      Object.hasOwn(call, "signal"),
      false,
      "已完成工具的媒体落盘不得继承本回合 Stop 信号",
    );
    assert.equal(call.retention, "session");
    assert.equal(call.sessionId, BASE.sessionId);
    assert.equal(call.turnId, BASE.turnId);
  }
  assert.deepEqual(
    calls.map((call) => call.toolCallId),
    ["call-1-media-1", "call-1-media-2"],
  );

  assert.equal(result.attachments.length, 2);
  assert.deepEqual(
    result.attachments.map((attachment) => attachment.url),
    ["zcode-artifact://written-1", "zcode-artifact://written-2"],
  );
  // 布局面：文本与附件按原顺序记录，冷恢复据此重建结果形态。
  assert.deepEqual(result.modelContentLayout, [
    { type: "text", text: "截图如下" },
    { type: "attachment", attachmentIndex: 0 },
    { type: "attachment", attachmentIndex: 1 },
  ]);
});

test("T-MEM-2 已落盘（zcode-artifact://）的块不重复写", async () => {
  const { calls, store } = createArtifactStore();
  const result = await persistToolResultMediaAttachments({
    ...BASE,
    artifactStore: store,
    sessionStore: {},
    content: [
      {
        type: "image",
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,AAAA",
        source: { uri: "zcode-artifact://already-there" },
      },
    ],
  });
  assert.equal(calls.length, 0);
  assert.equal(result.attachments[0].url, "zcode-artifact://already-there");
});

test("T-MEM-2 调用点不再传 signal（源码级防回潮）", () => {
  // FORK(upgrade-316)：上游 v3.16 把工具结果结算拆成 tool-result-settlement.ts，
  // persistToolResultMediaAttachments 的唯一调用点随之从 turn-tools.ts 搬到此处
  // （tool-result-settlement.ts:110）。守卫锚定当前真实位置；防回潮语义不变：
  // 该调用不得再传 signal（excess property 会编译错，防止修复被回退）。
  const settlement = readFileSync(
    new URL("../src/runtime/methods/tool-result-settlement.ts", import.meta.url),
    "utf-8",
  );
  const callIndex = settlement.indexOf("persistToolResultMediaAttachments(");
  assert.notEqual(callIndex, -1, "找不到调用点");
  // 取到该调用的结束括号之前的一整段实参。
  const callTail = settlement.slice(callIndex, settlement.indexOf("});", callIndex) + 3);
  assert.equal(
    /signal:/.test(callTail),
    false,
    "tool-result-settlement 调用点不得再传 signal（excess property 会编译错，防止修复被回退）",
  );
});
