#!/usr/bin/env node
/**
 * T-RV4（subagent-resume-visibility Step 4 / C7）——终态 SendMessage resume 回归网。
 *
 * 这是本迭代**完全无覆盖**的行为契约：registry 里的 task 处于终态
 * （failed / killed）时，SendMessage 把消息续到该 agent 的后台新 turn，
 * 返回 `delivery: "resumed_background"`（runtimeTerminalAgentInBackground 对
 * TERMINAL_STATUSES 全集可续，runner.ts:1035-1143）。
 *
 * 夹具事实（第 1 轮审查补钉）：
 *   - registry 置终态 snapshot 必带 `childSessionId`，否则
 *     createSubagentLifecycleFromTask 返回 undefined 走 failure 分支；
 *   - 注入的假 runExploreAgent 必须调 `request.onSessionReady?.()` 放行 readyGate
 *     （runner.ts:1089-1115 resume 路径 onSessionReady → readyGate.resolve()；
 *     范式同 test-subagent-sync-dispatch.mjs 的 makeGatedChild）；
 *   - profile 无虞：normalizeAgentProfiles 恒含 general-purpose 内置；
 *   - outputRootDir 指 mkdtempSync 临时目录（E2E 隔离红线，绝不碰真实 ~/.omz）。
 *
 * 断言：输出过 SendMessageOutputSchema.safeParse（.strict()）+ delivery 为
 * resumed_background + message 含 was stopped (<status>) + agentId 句柄；
 * resume 后台 turn 放行后 registry 回到 running，最终由后台 finalize 收口 completed。
 *
 * 运行方式：`npx tsx --test scripts/test-send-message-terminal-resume.mjs`
 * （必须 tsx：被测模块是 TypeScript 源码，裸 node 吃不下去）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// 契约单实例钩子（sub/G-1 同一性断言的地基，同 test-subagent-sync-dispatch.mjs 范式）：
// 被测 runner 与 SendMessageOutputSchema 必须共用同一份契约实例。
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
const { SendMessageOutputSchema } = await import(
  new URL("../../contracts/src/tools/../index.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — T-RV4 终态 SendMessage resume（failed / killed → resumed_background）"
      : `TEST FAIL — T-RV4 (exit code ${code})`,
  );
});

const SESSION_ID = "ses_rv4";
const TRACE_ID = "trace_rv4";
const AGENT_ID = "agent_rv4_1";
const CHILD_SESSION_ID = `sess_subagent_${AGENT_ID}`;

/**
 * 轮询等待 resume 后台 turn 落终态：finalizeBackgroundCompletion 链上有真实
 * 异步文件 IO（writeCompletedAgentArtifacts），固定让出轮数不稳定，等到终态为止。
 */
async function waitForTerminalStatus(registry, agentId) {
  for (let index = 0; index < 500; index += 1) {
    const status = registry.get(agentId)?.status;
    if (status !== undefined && status !== "running") return status;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return registry.get(agentId)?.status;
}

/**
 * 端口夹具：registry 由外部持有（先置终态 snapshot），outputRootDir 指临时目录。
 * 假 runExploreAgent 调 onSessionReady 放行 readyGate 后立即返回——
 * readyGate 只管「child session 已建立」，不等整轮跑完。
 */
function makeHarness() {
  const registry = new InMemoryRuntimeTaskRegistry();
  const outputRootDir = mkdtempSync(join(tmpdir(), "zcode-sendmessage-test-"));
  const port = createExploreSubagentPort({
    runExploreAgent: async (request) => {
      await request.onSessionReady?.();
      return { response: "resumed answer", traceId: TRACE_ID, events: [] };
    },
    emitParentEvent: async () => {},
    enqueueParentTaskNotification: () => undefined,
    outputRootDir,
    runtimeTaskRegistry: registry,
    createAgentId: () => AGENT_ID,
    // 别让 60s 空闲看门狗在用例中途开火。
    inactivityTimeoutMs: 10 * 60 * 1000,
  });
  return {
    port,
    registry,
    dispose() {
      rmSync(outputRootDir, { force: true, recursive: true });
    },
  };
}

/** 在册终态 snapshot：childSessionId 必带（createSubagentLifecycleFromTask 的闸门）。 */
function registerTerminalTask(registry, status) {
  registry.register({
    taskId: AGENT_ID,
    agentId: AGENT_ID,
    agentType: "general-purpose",
    description: "resume probe",
    childSessionId: CHILD_SESSION_ID,
    parentToolCallId: "toolu_rv4",
    parentSessionId: SESSION_ID,
    prompt: "probe",
    startedAt: new Date(),
    status,
    isBackgrounded: true,
    type: "local_agent",
    taskType: "local_agent",
  });
}

function makeSendMessageRequest() {
  return {
    sessionId: SESSION_ID,
    turnId: "turn_rv4",
    parentToolCallId: "toolu_rv4",
    to: AGENT_ID,
    summary: "continue the probe",
    message: "keep going",
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    trace: { traceId: TRACE_ID },
  };
}

for (const status of ["failed", "killed"]) {
  test(`T-RV4[${status}]: 终态任务经 SendMessage 恢复为 resumed_background`, async () => {
    const harness = makeHarness();
    try {
      registerTerminalTask(harness.registry, status);

      const result = await harness.port.sendMessage(makeSendMessageRequest());

      // 输出必须过 .strict() 契约（自动校验字段形状，不是断言作者脑补）。
      const parsed = SendMessageOutputSchema.safeParse(result);
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? {}));
      assert.equal(result.status, "success");
      assert.equal(result.delivery, "resumed_background");
      assert.equal(result.agentId, AGENT_ID);
      assert.equal(result.taskId, AGENT_ID);
      // 文案模板（runner createSendMessageSuccess）：`Agent "<id>" was stopped (<status>); …`。
      assert.match(result.message ?? "", new RegExp(`was stopped \\(${status}\\)`));
      // readyGate 放行瞬间 registry 已被 resume 重新注册为 running。
      assert.equal(harness.registry.get(AGENT_ID)?.status, "running");

      // 后台 turn（假 child 立即返回）由 finalizeBackgroundCompletion 收口 completed。
      await waitForTerminalStatus(harness.registry, AGENT_ID);
      assert.equal(harness.registry.get(AGENT_ID)?.status, "completed");
    } finally {
      harness.dispose();
    }
  });
}
