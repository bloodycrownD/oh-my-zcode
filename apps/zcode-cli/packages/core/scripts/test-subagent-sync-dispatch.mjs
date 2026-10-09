#!/usr/bin/env node
/**
 * T-D1 / T-S1（bugfix-batch-20261009 Step 11/12）——同步派遣 childSessionId 与
 * 前台子智能体停止终态。
 *
 * ============================================================================
 * T-D1：同步派遣返回 childSessionId，与 SubagentStopped 事件一致
 * ============================================================================
 *
 * 失效面是**半边契约**：`AgentCompletedOutput` 接口与 `AgentCompletedOutputSchema`
 * （`.strict()`）必须同 PR 双改。runner 只改接口不改 zod，工具输出在
 * `runtimeOutputSchema` 校验处直接失败；只改 zod 不改 runner，字段就是 undefined。
 * 因此这里用两条互不依赖的断言分别锁住两侧：
 *
 *   1. runner 行为：同步 run 的返回对象带 childSessionId，且与父会话收到的
 *      SubagentStopped 事件里的 childSessionId **逐字节相同**（同一个源，两处
 *      消费方读到的必须是同一个值）。
 *   2. schema：`AgentOutputSchema.safeParse` 对完整输出通过，对**故意删掉
 *      childSessionId** 的输出必须失败（strict 缺字段即红）。
 *
 * 另外一并锁 4c 的两处渲染/声明面：
 *   - `formatAgentOutputForModel` 同步分支透出 sessionId 行；
 *   - AGENT_TOOL_OUTPUT_SCHEMA 的 completed / async_launched **两个**分支都声明
 *     childSessionId（异步分支原本漏字段，是本次顺带消解的不一致）。
 *
 * ============================================================================
 * T-S1：前台 stopTask 后终态是 killed，父通知是 cancelled，不被覆写 failed
 * ============================================================================
 *
 * 链路：GUI cancelBackgroundWork → runtime.cancelBackgroundTask →
 * stopBackgroundTask → subagentPort.stopTask。stopTask 把 registry 置成终态
 * killed 并发出 cancelled 事件/通知；但前台 run() 的 catch 过去不认这个终态，
 * 收口时把 killed 覆写成 failed 并再发一条 status=failed 的 SubagentStopped——
 * 用户主动停止于是显示成「失败」。3b 的修法是 catch 开头 isTerminalRuntimeTask
 * 早退，改以 ToolCancelled 语义抛出（与 guardSubagentPromiseWithAbort 同款）。
 *
 * 测试跑的是**真的端口**（createExploreSubagentPort + InMemoryRuntimeTaskRegistry），
 * child runtime 用可操控的假实现：run 期间不 settle，等 stopTask 落终态后再放行，
 * 这样才能稳定打进 catch 的早退分支。
 *
 * 运行方式：`npx tsx --test scripts/test-subagent-sync-dispatch.mjs`
 * （必须 tsx：被测模块与被测契约都是 TypeScript 源码，裸 node 吃不下去；
 *  与同目录 `test:prompt-language-context` 的 dist 范式不同——那个依赖已构建产物）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { createExploreSubagentPort } = await import(
  new URL("../src/subagent/runner.ts", import.meta.url).href
);
const { InMemoryRuntimeTaskRegistry } = await import(
  new URL("../src/runtime-task/registry.ts", import.meta.url).href
);
// 契约直接从源码取：dist 可能滞后，而本测试要锁的正是当前源码里的 schema 形状。
const { AgentOutputSchema, SessionEventType, CoreErrorType } = await import(
  new URL("../../contracts/src/tools/../index.ts", import.meta.url).href
);
const { agentToolEntry } = await import(
  new URL("../src/tool/handlers/agent.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — T-D1 sync dispatch childSessionId / T-S1 foreground stop terminal state"
      : `TEST FAIL — T-D1/T-S1 (exit code ${code})`,
  );
});

const SESSION_ID = "ses_td1";
const TRACE_ID = "trace_td1";
const AGENT_ID = "agent_td1_1";
const CHILD_SESSION_ID = `sess_subagent_${AGENT_ID}`;

/** 让出 microtask/macrotask，等待 stopTask 内部 await 的两个父事件发射完。 */
const flush = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function makeRequest(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    turnId: "turn_td1",
    parentToolCallId: "toolu_td1",
    agentType: "general-purpose",
    description: "probe the contract",
    prompt: "probe",
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    trace: { traceId: TRACE_ID },
    ...overrides,
  };
}

/**
 * 端口夹具。`runExploreAgent` 可注入，`outputRootDir` 指到临时目录，
 * 绝不碰真实 ~/.omz（RULE.md E2E 隔离约束，同 magic-context 测试的口径）。
 */
function makePort({ runExploreAgent, agentId = AGENT_ID } = {}) {
  const parents = [];
  const notifications = [];
  const registry = new InMemoryRuntimeTaskRegistry();
  const outputRootDir = mkdtempSync(join(tmpdir(), "zcode-subagent-test-"));
  const port = createExploreSubagentPort({
    runExploreAgent:
      runExploreAgent ??
      (async () => ({
        response: "child answer",
        traceId: TRACE_ID,
        events: [],
      })),
    emitParentEvent: async (event) => {
      parents.push(event);
    },
    enqueueParentTaskNotification: (notification) => {
      notifications.push(notification);
      return undefined;
    },
    outputRootDir,
    runtimeTaskRegistry: registry,
    createAgentId: () => agentId,
    // 别让 60s 空闲看门狗在用例中途开火。
    inactivityTimeoutMs: 10 * 60 * 1000,
  });
  return {
    port,
    registry,
    parents,
    notifications,
    dispose() {
      rmSync(outputRootDir, { force: true, recursive: true });
    },
  };
}

// ── T-D1 ────────────────────────────────────────────────────────────────────

test("T-D1a: 同步派遣返回 childSessionId，且与 SubagentStopped 事件一致", async () => {
  const harness = makePort();
  try {
    const output = await harness.port.run(makeRequest());

    assert.equal(output.status, "completed");
    // 断言 1（行为锁）：runner 真的把这个字段放在了同步输出对象里。
    assert.equal(output.childSessionId, CHILD_SESSION_ID);
    assert.equal(typeof output.childSessionId, "string");

    const stopped = harness.parents.find(
      (event) => event.type === SessionEventType.SubagentStopped,
    );
    assert.ok(stopped, "父会话应收到 SubagentStopped 事件");
    // 同一来源、两个消费方（tool result 与事件）读到同一个值。
    assert.equal(stopped.payload.childSessionId, CHILD_SESSION_ID);
  } finally {
    harness.dispose();
  }
});

test("T-D1b: AgentOutputSchema strict 双校验（漏字段必须红）", async () => {
  const harness = makePort();
  try {
    const output = await harness.port.run(makeRequest());

    // 断言 2a：完整输出通过 strict union。
    const passed = AgentOutputSchema.safeParse(output);
    assert.equal(passed.success, true, JSON.stringify(passed.error?.issues ?? {}));
    // 断言 2b：删掉 childSessionId 后必须失败——这锁定「schema 侧也必须同 PR 改」，
    // 只改接口不改 zod 时这里立刻红。
    const { childSessionId: _omitted, ...withoutChildSessionId } = output;
    const rejected = AgentOutputSchema.safeParse(withoutChildSessionId);
    assert.equal(rejected.success, false);
    // handler 的 runtimeOutputSchema 与契约同一个 schema 对象，行为必须一致。
    assert.equal(harness.registry.get(AGENT_ID)?.status, "completed");
  } finally {
    harness.dispose();
  }
});

test("T-D1c: 模型可见渲染与两个分支的 JSON schema 都带 childSessionId", () => {
  const output = {
    status: "completed",
    agentId: AGENT_ID,
    agentType: "general-purpose",
    description: "probe the contract",
    prompt: "probe",
    childSessionId: CHILD_SESSION_ID,
    content: [{ type: "text", text: "child answer" }],
    totalToolUseCount: 2,
    totalDurationMs: 12,
  };
  const modelText = agentToolEntry.formatModelContent(output);
  assert.match(modelText, /sessionId: /);
  assert.match(modelText, new RegExp(`sessionId: ${CHILD_SESSION_ID}`));

  const branches = agentToolEntry.outputSchema.oneOf;
  assert.ok(Array.isArray(branches) && branches.length === 2, "两个输出分支");
  const completed = branches[0];
  const asyncLaunched = branches[1];
  // completed 分支：properties 有、required 也有。
  assert.ok(completed.properties.childSessionId, "completed 分支缺 childSessionId 声明");
  assert.ok(completed.required.includes("childSessionId"), "completed 分支 required 缺 childSessionId");
  // 异步分支：本次顺带消解的 additionalProperties:false 缺字段不一致。
  assert.ok(asyncLaunched.properties.childSessionId, "async 分支缺 childSessionId 声明");
  assert.ok(
    asyncLaunched.required.includes("childSessionId"),
    "async 分支 required 缺 childSessionId",
  );
});

// ── T-S1 ────────────────────────────────────────────────────────────────────

/** 一个在放行前不 settle 的假 child runtime。 */
function makeGatedChild() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    // 必须调 onSessionReady：真实 AgentRuntime 在 child session persist 后就调它，
    // 不调会让 readyGate 永不 settle，abort 会落到 run() 前置 catch 的
    // registry.remove 上（那是另一条与本次无关的路径）。
    runExploreAgent: async (request) => {
      await request.onSessionReady?.();
      await gate;
      return { response: "late", traceId: TRACE_ID, events: [] };
    },
    release: () => release(),
  };
}

test("T-S1a: 前台 stopTask 后 registry 终态 killed、失败收口不覆写", async () => {
  const child = makeGatedChild();
  const harness = makePort({ runExploreAgent: child.runExploreAgent });
  try {
    const runPromise = harness.port.run(makeRequest());
    const rejection = runPromise.then(
      () => null,
      (error) => error,
    );

    // 等 registry 里出现 running 的 task 再停——stopped 分支要求 task 非终态。
    for (let index = 0; index < 200 && !harness.registry.get(AGENT_ID); index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(harness.registry.get(AGENT_ID)?.status, "running");

    await harness.port.stopTask(AGENT_ID);
    child.release();
    const error = await rejection;
    await flush();

    // 终态保持 stopTask 置的 killed，没有被 catch 的 failed 收口覆写。
    assert.equal(harness.registry.get(AGENT_ID)?.status, "killed");
    assert.ok(error, "被停止的 run 必须 reject");
    assert.equal(error.type, CoreErrorType.ToolCancelled);
    // 断言「不覆写」最直接的一条：failed 收口会发一条 status=failed 的
    // SubagentStopped；早退后父会话收到的 SubagentStopped 只能是 stopped。
    const subagentStoppedEvents = harness.parents.filter(
      (event) => event.type === SessionEventType.SubagentStopped,
    );
    assert.equal(subagentStoppedEvents.length, 1);
    assert.equal(subagentStoppedEvents[0].payload.status, "stopped");
    assert.equal(
      harness.parents.some((event) =>
        event.type === SessionEventType.SubagentStopped &&
        event.payload.status === "failed",
      ),
      false,
      "失败收口不得在被停止后改写父事件状态",
    );
  } finally {
    harness.dispose();
  }
});

test("T-S1b: 被停止时父通知 status=cancelled", async () => {
  const child = makeGatedChild();
  const harness = makePort({ runExploreAgent: child.runExploreAgent });
  try {
    const runPromise = harness.port.run(makeRequest());
    const rejection = runPromise.then(
      () => null,
      (error) => error,
    );
    for (let index = 0; index < 200 && !harness.registry.get(AGENT_ID); index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await harness.port.stopTask(AGENT_ID);
    child.release();
    const error = await rejection;
    await flush();

    // stopBackgroundTask 的 cancelled 判定（toBackgroundTaskInfoStatus: killed→cancelled）
    // 依赖这条 BackgroundTaskCompleted 事件带 status:"cancelled"。
    const backgroundCompleted = harness.parents.find(
      (event) => event.type === SessionEventType.BackgroundTaskCompleted,
    );
    assert.ok(backgroundCompleted, "父会话应收到 BackgroundTaskCompleted 事件");
    assert.equal(backgroundCompleted.payload.status, "cancelled");
    assert.equal(backgroundCompleted.payload.cancellable, false);
    assert.equal(backgroundCompleted.payload.childSessionId, CHILD_SESSION_ID);

    assert.equal(error.type, CoreErrorType.ToolCancelled);
    assert.ok(
      harness.notifications.length >= 1,
      "stop 后父任务通知必须入队（否则 run 收口会重新发一条 failed 通知）",
    );
    assert.equal(
      harness.parents.some(
        (event) =>
          event.type === SessionEventType.BackgroundTaskCompleted &&
          event.payload.status === "failed",
      ),
      false,
    );
  } finally {
    harness.dispose();
  }
});
