#!/usr/bin/env node
/**
 * T-D1 / T-S1（bugfix-batch-20261009 Step 11/12）——同步派遣 childSessionId 与
 * 前台子智能体停止终态。
 *
 * ============================================================================
 * T-RV1 / T-RV5（subagent-resume-visibility Step 4 / C7）——前台失败收口与工具描述面
 * ============================================================================
 *
 * T-RV1：前台子 agent 失败时，父模型必须看到 agentId 与 SendMessage 续跑指引。
 * 双形态夹具（对应 runner 收口的两条来源）：
 *   (a) runExploreAgent reject CoreError——主场景。child 模型/provider 失败的
 *       CoreError（createTurnFailureError 链）context 不带 agentId，靠 C8（runner
 *       run() catch 的 CoreError rethrow 前浅拷贝合并身份字段）把句柄补上；其中
 *       一组刻意用 **context 为 undefined** 的 CoreError，锁浅拷贝合并不炸。
 *   (b) runExploreAgent reject 非 CoreError——走 runner 462-476 wrapper 分支
 *       （wrapper context 本就带 agentId）。
 * 两组均经 agentToolEntry.handler 收口后断言：
 *   1. 抛出的 CoreError `context.toolHandlerFailure.message` 含 agentId 与
 *      `use SendMessage with to:` 指引句（result:false + errorCode 1000）；
 *   2. 再经 executor 的 `createErrorResult` 投影（port/handler 直调看不到
 *      modelContent——它由 executor 层铸造），`modelContent` 的 `<tool_use_error>`
 *      信封内含同句；
 *   3. `error.message` 仍是注入的 provider 根因原文（selectPrimaryErrorFrame 的
 *      投影语义不变，增强层标 Wrapper 不当选 primary）；
 *   4. `error.code` 为数值字符串 "1000"（P2-4 登记的表面变化，锁住新值）。
 * 负例（第 3 轮 P2-2 钉死）：带 `context.agentId` 的 CoreError + 不含该 id 的
 * registry（setup 窗口取消后 task 已 `registry.remove`）→ 原样 rethrow，
 * 不产生 toolHandlerFailure。
 *
 * T-RV5：工具描述面与运行时能力对齐——`AGENT_PROVIDER_DESCRIPTION` 含
 * continue-a-previously-spawned-agent bullet（.reference 上游漂移丢失），
 * `SEND_MESSAGE_PROVIDER_DESCRIPTION` 的 resume 语义泛化为 finished-or-was-stopped
 * 终态（TERMINAL_STATUSES 全集）。两个 const 均未 export，经 toolEntry
 * metadata.description 断言。
 *
 * T-RV6（不回归）即本文件的 T-D1c：`AgentOutputSchema` union 保持两个分支
 * （A 方案不动 union 的守门断言），存量断言原样保留。
 *
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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// 契约单实例钩子（sub/G-1 同一性断言的地基）。`@zcode/contracts` 包入口发布的
// 是 dist 产物（package.json exports "." → ./dist/index.js），而本测试按**源码
// URL**取契约（下方 import）：handler 经包 specifier 拿到的是 dist 副本，两处是两个
// schema 实例，`===` 恒 false——runtimeOutputSchema 同一性断言会误红。钩子把契约
// specifier（含 subpath）统一改指 contracts/src 源码，让被测模块与本测试共用同一份
// 契约实例（同 packages/ui 测试 `@/` 别名钩子与 bootstrap registerHooks 的仓内范式）。
const CONTRACTS_SRC_ROOT = fileURLToPath(new URL("../../contracts/src/", import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@zcode/contracts" || specifier.startsWith("@zcode/contracts/")) {
      const relative =
        specifier === "@zcode/contracts"
          ? "index"
          : specifier.slice("@zcode/contracts/".length);
      for (const candidate of [
        `${CONTRACTS_SRC_ROOT}${relative}.ts`,
        `${CONTRACTS_SRC_ROOT}${relative}/index.ts`,
      ]) {
        if (existsSync(candidate)) {
          return { shortCircuit: true, url: pathToFileURL(candidate).href };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { createExploreSubagentPort } = await import(
  new URL("../src/subagent/runner.ts", import.meta.url).href
);
const { InMemoryRuntimeTaskRegistry } = await import(
  new URL("../src/runtime-task/registry.ts", import.meta.url).href
);
// 契约直接从源码取：dist 可能滞后，而本测试要锁的正是当前源码里的 schema 形状。
const {
  AgentOutputSchema,
  SessionEventType,
  CoreErrorType,
  createCoreError,
  isCoreError,
  AgentErrorCode,
} = await import(new URL("../../contracts/src/tools/../index.ts", import.meta.url).href);
// runtimeOutputSchema 同一性断言要从四处入口逐一取：Agent 本体、Task 兼容别名
// （对 agentToolEntry 的浅拷贝）、两个工厂（createAgentToolEntry / createTaskToolEntry，
// 工厂链靠 spread 间接同引用——锁住它是防未来工厂层覆盖 schema 而不被发现）。
const { agentToolEntry, taskToolEntry, createAgentToolEntry, createTaskToolEntry } = await import(
  new URL("../src/tool/handlers/agent.ts", import.meta.url).href
);
// T-RV5 的 SendMessage 描述面落点：const 未 export，经 sendMessageToolEntry 取。
const { sendMessageToolEntry } = await import(
  new URL("../src/tool/handlers/send-message.ts", import.meta.url).href
);
// T-RV1 要用 executor 出口投影断言 modelContent 信封（port/handler 直调看不到它）。
const { createErrorResult } = await import(
  new URL("../src/tool/executor/errors.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — T-D1 sync dispatch childSessionId / T-S1 foreground stop terminal state / T-RV1 T-RV5"
      : `TEST FAIL — T-D1/T-S1/T-RV1/T-RV5 (exit code ${code})`,
  );
});

const SESSION_ID = "ses_td1";
const TRACE_ID = "trace_td1";
const AGENT_ID = "agent_td1_1";
const CHILD_SESSION_ID = `sess_subagent_${AGENT_ID}`;
/** T-RV1 主/负例共用的父侧 toolCallId；handler 收口把它写进 request.parentToolCallId。 */
const TOOL_CALL_ID = "toolu_rv1";

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
    // 断言 2c：handler 的 runtimeOutputSchema 与契约必须是**同一个 schema 对象**。
    // 只 safeParse 契约不够——换成一份不含 childSessionId 的本地副本时，2a/2b 仍
    // 可能全绿（契约侧没动），而 Agent 工具输出的 runtimeOutputSchema 校验当场
    // 失效。四处入口逐一锁同一引用：Agent 本体、Task 别名浅拷贝、两个工厂。
    assert.equal(agentToolEntry.runtimeOutputSchema, AgentOutputSchema);
    assert.equal(taskToolEntry.runtimeOutputSchema, AgentOutputSchema);
    assert.equal(createAgentToolEntry().runtimeOutputSchema, AgentOutputSchema);
    assert.equal(createTaskToolEntry().runtimeOutputSchema, AgentOutputSchema);
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

  // e2e/R-1：async_launched 的**模型可见渲染**同样要带 sessionId 行（同步分支早有，
  // 异步分支曾漏）。夹具按 AgentBackgroundedOutputSchema（contracts 侧 .strict()）
  // 备齐字段——isAsync/backgroundTaskId/outputFile/canReadOutputFile 一个都不能少，
  // 先过 strict 契约再测渲染，少字段即红。
  const asyncOutput = {
    status: "async_launched",
    isAsync: true,
    agentId: AGENT_ID,
    agentType: "general-purpose",
    description: "probe the contract",
    prompt: "probe",
    childSessionId: CHILD_SESSION_ID,
    backgroundTaskId: "bg_td1",
    outputFile: "/tmp/td1-agent-output.md",
    canReadOutputFile: true,
  };
  const asyncParsed = AgentOutputSchema.safeParse(asyncOutput);
  assert.equal(asyncParsed.success, true, JSON.stringify(asyncParsed.error?.issues ?? {}));
  // canReadOutputFile=true 覆盖 return 路 1；false 时兜底路同样走 launchLines。
  const asyncModelText = agentToolEntry.formatModelContent(asyncOutput);
  assert.match(asyncModelText, /sessionId: /);
  assert.match(asyncModelText, new RegExp(`sessionId: ${CHILD_SESSION_ID}`));
  const asyncFallbackText = agentToolEntry.formatModelContent({
    ...asyncOutput,
    canReadOutputFile: false,
  });
  assert.match(asyncFallbackText, new RegExp(`sessionId: ${CHILD_SESSION_ID}`));
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

// ── T-RV1（subagent-resume-visibility 前台失败收口）─────────────────────────

/**
 * 先放行 readyGate 再抛错的假 child（与 makeGatedChild 同范式）。必须调
 * onSessionReady：否则 run() 会走前置 catch 的 registry.remove 路径（另一条与
 * 本次无关的 setup 取消分支），到不了 458 行的 C8 身份合并。
 */
function makeFailingChild(error) {
  return async (request) => {
    await request.onSessionReady?.();
    throw error;
  };
}

/** handler 直调所需的最小 ToolExecutionContext。 */
function makeToolContext({ subagentPort, registry }) {
  return {
    toolCallId: TOOL_CALL_ID,
    traceId: TRACE_ID,
    abortSignal: new AbortController().signal,
    sessionId: SESSION_ID,
    turnId: "turn_rv1",
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    // Read/Bash 在列才能读到后台产出文件；与前台断言无关，给全量更贴近真实。
    providerVisibleToolNames: ["Read", "Bash"],
    subagentPort,
    runtimeTaskRegistry: registry,
  };
}

/**
 * T-RV1 两组夹具共用的投影断言：
 * 1. handler 抛出的增强 CoreError 带 toolHandlerFailure 指引句；
 * 2. 经 executor createErrorResult 投影后 modelContent 信封含同句；
 * 3. error.message 仍是注入根因原文（投影语义不变）；
 * 4. error.code 为数值字符串 "1000"（C1 局部常量 AGENT_TOOL_FAILURE_CODE 表面变化锁）。
 */
function assertResumableFailure(thrown, rootCauseMessage) {
  assert.ok(isCoreError(thrown), "handler 必须 reject CoreError");
  const failure = thrown.context?.toolHandlerFailure;
  assert.ok(failure, "增强版 CoreError 必须带 toolHandlerFailure");
  assert.equal(failure.result, false);
  assert.equal(failure.errorCode, 1000);
  assert.match(failure.message, new RegExp(`agentId: '${AGENT_ID}'`));
  assert.match(failure.message, new RegExp(`use SendMessage with to: '${AGENT_ID}'`));
  // 增强层标 Wrapper：投影 primary frame 仍落 cause 链上的 provider 根因。
  assert.equal(thrown.context?.errorPayloadRole, "wrapper");
  assert.equal(thrown.message, rootCauseMessage);

  const projected = createErrorResult(
    { id: `${TOOL_CALL_ID}_projection`, name: "Agent", input: {} },
    thrown,
    12,
  );
  assert.equal(projected.success, false);
  assert.match(
    projected.modelContent ?? "",
    new RegExp(`<tool_use_error>[\\s\\S]*use SendMessage with to: '${AGENT_ID}'[\\s\\S]*</tool_use_error>`),
    "modelContent 的 <tool_use_error> 信封必须含续跑指引句",
  );
  assert.equal(projected.error?.message, rootCauseMessage);
  assert.equal(projected.error?.code, "1000");
}

test("T-RV1a1: 前台失败（reject context 为 undefined 的 CoreError，主场景）", async () => {
  const rootCause = "child model call failed: rate limited by upstream provider";
  const harness = makePort({
    runExploreAgent: makeFailingChild(
      // 不传 options：createTurnFailureError 链产出的 CoreError context 为 undefined，
      // 锁 C8 浅拷贝合并（{ ...undefined, agentId, ... }）不炸，原样 rethrow 带上句柄。
      createCoreError(CoreErrorType.ToolExecutionFailed, rootCause),
    ),
  });
  try {
    const thrown = await agentToolEntry
      .handler(
        { description: "probe the contract", prompt: "probe", subagent_type: "general-purpose" },
        makeToolContext({ subagentPort: harness.port, registry: harness.registry }),
      )
      .then(
        () => null,
        (error) => error,
      );
    assertResumableFailure(thrown, rootCause);
  } finally {
    harness.dispose();
  }
});

test("T-RV1a2: 前台失败（reject 带 context 的 CoreError，主场景）", async () => {
  const rootCause = "child model call failed: 503 service unavailable";
  const harness = makePort({
    runExploreAgent: makeFailingChild(
      createCoreError(CoreErrorType.ToolExecutionFailed, rootCause, {
        cause: new Error("upstream 503"),
        // createTurnFailureError 风格的 context：带 code 但不带 agentId。
        context: { code: AgentErrorCode.CHILD_RUNTIME_FAILED, modelId: "step-5-preview" },
        recoverable: true,
      }),
    ),
  });
  try {
    const thrown = await agentToolEntry
      .handler(
        { description: "probe the contract", prompt: "probe", subagent_type: "general-purpose" },
        makeToolContext({ subagentPort: harness.port, registry: harness.registry }),
      )
      .then(
        () => null,
        (error) => error,
      );
    assertResumableFailure(thrown, rootCause);
    // C8 只补身份、保留原 context 键；增强层在其上再挂 toolHandlerFailure。
    assert.equal(thrown.context?.code, AgentErrorCode.CHILD_RUNTIME_FAILED);
    assert.equal(thrown.context?.agentType, "general-purpose");
    assert.equal(thrown.context?.parentToolCallId, TOOL_CALL_ID);
  } finally {
    harness.dispose();
  }
});

test("T-RV1b: 前台失败（reject 非 CoreError，runner wrapper 分支）", async () => {
  const rootCause = "connection reset by peer";
  const harness = makePort({
    runExploreAgent: makeFailingChild(new Error(rootCause)),
  });
  try {
    const thrown = await agentToolEntry
      .handler(
        { description: "probe the contract", prompt: "probe", subagent_type: "general-purpose" },
        makeToolContext({ subagentPort: harness.port, registry: harness.registry }),
      )
      .then(
        () => null,
        (error) => error,
      );
    assertResumableFailure(thrown, rootCause);
    // wrapper 分支的 cause 就是注入的原 error。
    assert.ok(thrown.cause instanceof Error);
    assert.equal(thrown.cause.message, "Explore subagent failed");
  } finally {
    harness.dispose();
  }
});

test("T-RV1d: 带 agentId 但 registry 不在册 → 原样 rethrow 不吞不增强", async () => {
  // setup 窗口取消的 task 已被 registry.remove（不在册），不能发空头指引。
  const injected = createCoreError(CoreErrorType.ToolExecutionFailed, "setup cancelled mid-launch", {
    context: {
      code: AgentErrorCode.CHILD_RUNTIME_FAILED,
      agentId: "agent_never_registered",
      agentType: "general-purpose",
    },
    recoverable: true,
  });
  const harness = makePort();
  try {
    const thrown = await agentToolEntry
      .handler(
        { description: "probe the contract", prompt: "probe", subagent_type: "general-purpose" },
        makeToolContext({
          // 直调 handler：launch 即抛注入错误，不经 runner（runner 会 register，负例
          // 要的正是「handler 侧 registry 不含该 id」的形态）。
          subagentPort: {
            launch: async () => {
              throw injected;
            },
          },
          registry: harness.registry,
        }),
      )
      .then(
        () => null,
        (error) => error,
      );
    // 原样 rethrow：同一个对象、无 toolHandlerFailure。
    assert.equal(thrown, injected);
    assert.equal(thrown.context?.toolHandlerFailure, undefined);
  } finally {
    harness.dispose();
  }
});

// ── T-RV5（subagent-resume-visibility 工具描述面）───────────────────────────

test("T-RV5: 工具描述含终态续跑语义与上游 continue bullet", () => {
  // Agent 侧：补回上游漂移丢失的「用 agentId 续跑已派生子 agent」bullet。
  assert.match(
    agentToolEntry.metadata.description ?? "",
    /Use SendMessage with the agent's ID to continue a previously spawned agent/,
  );
  // SendMessage 侧：resume 语义泛化为「已跑完或被停止」的终态（TERMINAL_STATUSES 全集），
  // 并带 within the current session 会话边界限定。
  assert.match(
    sendMessageToolEntry.metadata.description ?? "",
    /To resume an agent that has finished or was stopped/,
  );
  assert.match(
    sendMessageToolEntry.metadata.description ?? "",
    /use its `agentId` within the current session/,
  );
});
