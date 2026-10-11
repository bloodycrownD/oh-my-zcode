#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）T-EVT-1——ensureSessionPersisted 的并发去重（WeakMap）。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 P2 #9）
 * ============================================================================
 *
 * App sampling 可与首轮任务并发进入 `ensureSessionPersisted`。原实现只有一个 `sessionPersisted`
 * 布尔门：两个并发调用都读到 false 就各自走一遍建会话，重复 insert 且后写覆盖先写的模型配置
 * （表现为首轮模型选型丢失）。修复把 in-flight 的 persistence promise 收进 WeakMap：同一 runtime
 * 的并发首入合并成同一次创建。
 *
 * 同时钉住 `sessionPersisted = true` 的**置位时序**：它仍在 createSession 成功之后才置位，
 * 不能在入口提前翻真——提前翻会让后续读面在会话尚未落库时当成已持久化。
 *
 * 运行：`npx tsx --test scripts/test-session-persistence-dedupe.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { ensureSessionPersisted, isSessionPersisted } =
  await import("../src/runtime/methods/events.ts");

const TRACE_CONTEXT = { traceId: "trace-t-evt-1" };

function createRuntime() {
  let releaseCreate;
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  const created = [];
  const runtime = {
    sessionStore: {
      async createSession(input) {
        created.push(input);
        await createGate;
      },
      async saveSessionEntry() {},
    },
    logger: { info() {}, debug() {}, warn() {} },
    workingDirectory: "C:/example/t-evt-1",
    config: {},
    sessionId: "ses-t-evt-1",
    appVersion: "0.0.0-test",
    sessionPersisted: false,
    getSessionModelSelection: () => undefined,
    // 标题事件的收尾路径与本用例的判据（去重 + 置位时序）无关，桩掉即可。
    createEvent: (type, payload) => ({
      type,
      payload,
      id: 1,
      sessionId: "ses-t-evt-1",
      timestamp: new Date(0),
      sequenceNumber: 1,
      traceId: TRACE_CONTEXT.traceId,
    }),
    appendEvent: async () => {},
  };
  return { runtime, created, releaseCreate };
}

test("T-EVT-1 并发两次 ensureSessionPersisted 只建一次会话", async () => {
  const { runtime, created, releaseCreate } = createRuntime();

  // 故意不 await 第一条：模拟 App sampling 与首轮任务并发进入。
  const first = ensureSessionPersisted.call(runtime, "首轮输入", TRACE_CONTEXT);
  const second = ensureSessionPersisted.call(runtime, "首轮输入", TRACE_CONTEXT);

  // 两次进入都返回可等待的 promise（async 包装会让外层 promise 各自新建——内部合并的判据是
  // createSession 只被调用一次，见下）。
  assert.equal(typeof first.then, "function");
  assert.equal(typeof second.then, "function");
  // 等一下让 createSession 真正被调用（只剩门闩未放行）。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 1, "只允许一次 session 创建");

  // 置位时序：createSession 尚未完成时不得提前置真。
  assert.equal(isSessionPersisted.call(runtime), false);
  assert.equal(runtime.sessionPersisted, false);

  releaseCreate();
  await Promise.all([first, second]);
  assert.equal(runtime.sessionPersisted, true);
  assert.equal(created.length, 1);

  // 已持久化后的再次进入是纯早退：不再建会话、也不再新建 promise。
  assert.equal(await ensureSessionPersisted.call(runtime, "第二轮", TRACE_CONTEXT), undefined);
  assert.equal(created.length, 1);
});

test("T-EVT-1 失败后不残留 in-flight（下一次可重试）且不置位", async () => {
  let attempts = 0;
  const runtime = {
    sessionStore: {
      async createSession() {
        attempts += 1;
        throw new Error("session store unavailable");
      },
      async saveSessionEntry() {},
    },
    logger: { info() {}, debug() {}, warn() {} },
    workingDirectory: "C:/example/t-evt-1",
    config: {},
    sessionId: "ses-t-evt-1-fail",
    appVersion: "0.0.0-test",
    sessionPersisted: false,
    getSessionModelSelection: () => undefined,
    createEvent: () => ({
      type: "session_title_updated",
      payload: {},
      id: 1,
      sessionId: "ses-t-evt-1-fail",
      timestamp: new Date(0),
      sequenceNumber: 1,
      traceId: TRACE_CONTEXT.traceId,
    }),
    appendEvent: async () => {},
  };

  await assert.rejects(
    ensureSessionPersisted.call(runtime, "首轮输入", TRACE_CONTEXT),
    /session store unavailable/,
  );
  assert.equal(runtime.sessionPersisted, false, "失败不得置位");
  await assert.rejects(
    ensureSessionPersisted.call(runtime, "首轮输入", TRACE_CONTEXT),
    /session store unavailable/,
  );
  assert.equal(attempts, 2, "失败后 WeakMap 条目已清理，下一次进入必须真的重试");
});
