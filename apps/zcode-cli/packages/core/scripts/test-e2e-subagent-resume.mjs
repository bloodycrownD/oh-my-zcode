#!/usr/bin/env node
/**
 * subagent-resume-visibility / e2e —— 终态续跑三幕剧情（真 handler → 真 port →
 * 真 registry → 真 SendMessage 链，一镜到底）。
 *
 * ============================================================================
 * 与 T-RV1/T-RV4 单测的差别（e2e 的增量价值）
 * ============================================================================
 *
 *   - T-RV1 是 handler 直调 + 手动 createErrorResult 投影，port 整个是 mock；
 *   - T-RV4 是 port 直调（sendMessage），但终态 snapshot 是手工 register 的；
 *   - 本文件把三幕串成一个连续剧情，唯一注入点是 runExploreAgent 的剧情脚本
 *     （同既有单测范式：生产真实现拉 AgentRuntime，测试注入等价的失败/挂起/成功
 *     行为），其余全部真实：
 *
 *   幕1 前台失败透出（C8→C1→executor 投影全链）：
 *     agentToolEntry.handler 真调用 → 真 port.run → 真 launch 收口（C8 浅拷贝
 *     合并 agentId）→ handler 增强收口（C1 toolHandlerFailure）→ executor
 *     createErrorResult 真投影 → modelContent 信封含 agentId+SendMessage 指引。
 *     然后**模拟父模型**：从 modelContent 里正则提取 agentId（句柄只能从这里来）。
 *
 *   幕2 终态续跑（SendMessage 消费闭环）：
 *     用幕1 提取的 agentId 调真 port.sendMessage → resumeTerminalAgentInBackground
 *     → registry failed→running→completed 真状态机 → 输出过 SendMessageOutputSchema
 *     (.strict())。这是「模型读到句柄后真的能续上」的端到端证明。
 *
 *   幕3 后台停止通知指引（C3/C4 真链）：
 *     真 port.start 后台派遣（child 挂起）→ 真 port.stopTask →
 *     finalizeBackgroundStopped → formatLocalAgentTaskNotification（真函数）→
 *     enqueueParentTaskNotification 捕获的 text 必须含 stopped 状态与
 *     `use SendMessage with to:` 指引句——后台通知链一镜到底。
 *
 * 隔离：outputRootDir/workingDirectory 全指 mkdtempSync 临时目录，绝不碰真实
 * ~/.omz；挂起的 child promise 在 finally 放行，进程不泄漏。
 *
 * 运行方式：`npx tsx --test scripts/test-e2e-subagent-resume.mjs`
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// 契约单实例钩子（同 test-subagent-sync-dispatch.mjs）：handler 经包 specifier
// 拿到的契约与本测试直取的源码契约必须是同一实例，schema 同一性才成立。
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
const {
  SendMessageOutputSchema,
  CoreErrorType,
  createCoreError,
  isCoreError,
} = await import(new URL("../../contracts/src/tools/../index.ts", import.meta.url).href);
const { agentToolEntry } = await import(
  new URL("../src/tool/handlers/agent.ts", import.meta.url).href
);
const { createErrorResult } = await import(
  new URL("../src/tool/executor/errors.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — e2e 子智能体终态续跑三幕（失败透出 → SendMessage 消费 → 停止通知指引）"
      : `TEST FAIL — e2e 子智能体终态续跑 (exit code ${code})`,
  );
});

const SESSION_ID = "ses_e2e_rv";
const TRACE_ID = "trace_e2e_rv";
const TOOL_CALL_ID = "toolu_e2e_rv";
const AGENT_1 = "agent_e2e_1";
const AGENT_2 = "agent_e2e_2";
const ROOT_CAUSE = "child model call failed: 502 bad gateway from upstream provider";

/**
 * 轮询等待 registry 终态（后台 finalize 有真实异步文件 IO）。
 *
 * 修复：原先按固定 500 次 setImmediate 轮数等待，一轮只有 ~0.1ms，磁盘写入
 * 稍有抖动（Windows 临时目录 3 次写文件）就会在 finalize 落终态前耗尽轮数，
 * 造成「resume 后台 turn 收口 completed」偶发超时。轮数不是时间，改为固定
 * 时间预算，断言本身保持不变。
 */
async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), `等待超时：${label}`);
}

test("e2e 三幕：前台失败透出句柄 → SendMessage 续跑成功 → 后台停止通知带指引", async () => {
  const outputRootDir = mkdtempSync(join(tmpdir(), "zcode-e2e-subagent-resume-"));
  const workRoot = mkdtempSync(join(tmpdir(), "zcode-e2e-subagent-work-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const notifications = [];
  let releaseHangingChild;
  const hangingChildGate = new Promise((resolve) => {
    releaseHangingChild = resolve;
  });
  // 剧情序号（不用第二参：runExploreAgent 的第二参是 executionOptions）。
  let callSeq = 0;

  const port = createExploreSubagentPort({
    // 剧情脚本：三次调用三种行为（失败 → 成功续答 → 挂起等 stop）。
    runExploreAgent: async (request) => {
      await request.onSessionReady?.();
      const callIndex = callSeq++;
      if (callIndex === 0) {
        // 幕1：子会话已建立、子模型请求打到 provider 层被拒（主场景形态：
        // createTurnFailureError 链产出的 CoreError，context 无 agentId）。
        throw createCoreError(CoreErrorType.ToolExecutionFailed, ROOT_CAUSE);
      }
      if (callIndex === 1) {
        // 幕2：resume 后的子 turn 正常完成。
        return { response: "resumed answer after SendMessage", traceId: TRACE_ID, events: [] };
      }
      // 幕3：后台 child 挂起（模拟长任务），直到测试放行——防进程泄漏。
      return await hangingChildGate.then(() => ({
        response: "should not be observed",
        traceId: TRACE_ID,
        events: [],
      }));
    },
    emitParentEvent: async () => {},
    enqueueParentTaskNotification: (notification) => {
      notifications.push(notification);
      return undefined;
    },
    outputRootDir,
    runtimeTaskRegistry: registry,
    createAgentId: (() => {
      let seq = 0;
      return () => (seq++ === 0 ? AGENT_1 : AGENT_2);
    })(),
    inactivityTimeoutMs: 10 * 60 * 1000,
  });

  const makeToolContext = () => ({
    toolCallId: TOOL_CALL_ID,
    traceId: TRACE_ID,
    abortSignal: new AbortController().signal,
    sessionId: SESSION_ID,
    turnId: "turn_e2e_rv",
    workingDirectory: workRoot,
    workspaceRoot: workRoot,
    providerVisibleToolNames: ["Read", "Bash"],
    subagentPort: port,
    runtimeTaskRegistry: registry,
  });

  try {
    // ── 幕1：前台失败透出（C8 → C1 → executor 投影全链）─────────────────────
    const thrown = await agentToolEntry
      .handler(
        {
          description: "probe that will fail at the provider layer",
          prompt: "probe",
          subagent_type: "general-purpose",
        },
        makeToolContext(),
      )
      .then(
        () => null,
        (error) => error,
      );
    assert.ok(thrown, "前台子 agent 失败必须 reject 到 handler 层");
    assert.ok(isCoreError(thrown), "handler 必须 reject CoreError");
    assert.match(
      thrown.context?.toolHandlerFailure?.message ?? "",
      new RegExp(`use SendMessage with to: '${AGENT_1}'`),
      "收口指引句必须带句柄",
    );

    // executor 投影：父 turn transcript 里真实记录的 tool result 形态。
    const projected = createErrorResult(
      { id: TOOL_CALL_ID, name: "Agent", input: {} },
      thrown,
      30,
    );
    assert.equal(projected.success, false);
    assert.equal(projected.error?.code, "1000");
    assert.equal(projected.error?.message, ROOT_CAUSE, "投影 primary 仍是 provider 根因");
    assert.match(
      projected.modelContent ?? "",
      new RegExp(`<tool_use_error>[\\s\\S]*use SendMessage with to: '${AGENT_1}'[\\s\\S]*</tool_use_error>`),
      "modelContent 信封必须含续跑指引句",
    );

    // 模拟父模型：句柄只能从错误文本里读出来。
    const handle = (projected.modelContent ?? "").match(/agentId: '([^']+)'/);
    assert.ok(handle, "modelContent 必须能提取出 agentId");
    const extractedAgentId = handle[1];
    assert.equal(extractedAgentId, AGENT_1);

    // 失败终态已入册（SendMessage resume 的前提）。
    assert.equal(registry.get(AGENT_1)?.status, "failed");

    // ── 幕2：SendMessage 消费闭环（终态 → resumed_background → completed）────
    const resumed = await port.sendMessage({
      sessionId: SESSION_ID,
      turnId: "turn_e2e_rv",
      parentToolCallId: TOOL_CALL_ID,
      to: extractedAgentId,
      summary: "continue after provider failure",
      message: "the provider is back, keep going",
      workingDirectory: workRoot,
      workspaceRoot: workRoot,
      trace: { traceId: TRACE_ID },
    });
    const parsed = SendMessageOutputSchema.safeParse(resumed);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? {}));
    assert.equal(resumed.status, "success");
    assert.equal(resumed.delivery, "resumed_background", "终态 failed 必须可续");
    assert.equal(resumed.agentId, extractedAgentId);
    await waitFor(
      () => registry.get(AGENT_1)?.status === "completed",
      "resume 后台 turn 收口 completed",
    );

    // ── 幕3：后台停止通知带指引（start → stopTask → format → enqueue 真链）──
    const started = await port.start({
      sessionId: SESSION_ID,
      turnId: "turn_e2e_rv",
      parentToolCallId: "toolu_e2e_bg",
      agentType: "general-purpose",
      description: "background probe that will be stopped",
      prompt: "hang around",
      workingDirectory: workRoot,
      workspaceRoot: workRoot,
      trace: { traceId: TRACE_ID },
    });
    assert.equal(registry.get(AGENT_2)?.status, "running", "后台任务在册 running");
    assert.ok(started, "后台启动必须返回 AgentBackgroundedOutput");

    await port.stopTask(AGENT_2);
    // registry 终态字面量是 killed（BACKGROUND_AGENT_STOPPED_STATE.registryStatus），
    // 通知文案状态才是 stopped（notificationStatus）。
    await waitFor(
      () => registry.get(AGENT_2)?.status === "killed",
      "stopTask 后 registry 终态 killed",
    );
    await waitFor(
      () => notifications.some((n) => n.taskId === AGENT_2),
      "停止通知入列",
    );
    // 队列里同时有幕2 resume 完成的 completed 通知——按 taskId 取本幕的。
    const stoppedNotification = notifications.find((n) => n.taskId === AGENT_2);
    assert.match(
      stoppedNotification.text,
      /<status>stopped<\/status>/,
      "通知文案必须报 stopped 状态",
    );
    assert.match(
      stoppedNotification.text,
      new RegExp(`use SendMessage with to: '${AGENT_2}'`),
      "停止通知必须带续跑指引句",
    );
    assert.equal(stoppedNotification.taskId, AGENT_2);
  } finally {
    releaseHangingChild();
    rmSync(outputRootDir, { force: true, recursive: true });
    rmSync(workRoot, { force: true, recursive: true });
  }
});
