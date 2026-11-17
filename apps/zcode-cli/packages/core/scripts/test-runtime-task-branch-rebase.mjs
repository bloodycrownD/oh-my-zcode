#!/usr/bin/env node
/**
 * 单测（node:test）：rewind 之后后台任务的代际重盖与出队 fence。
 *
 * 背景（2026-11-17 现场诊断）：会话 rewind 会把 `branchGeneration` 推进一位，而启动轮被保留的
 * 后台任务（尤其是 workflow run）仍在跑，registry 条目却还带着旧代际。完成/升级通知在入队
 * （`background-notifications.ts`）与出队（`runtime-command-generation.ts`）两处都按代际
 * fence，于是通知被静默丢弃——`GetWorkflowRun` 能看到 completed / pending_questions，模型
 * 却永远收不到。修复由两半组成：
 *
 *   1. rewind 提交后 `rebaseRuntimeTasksOntoBranch` 把启动轮保留的任务重盖到新代际
 *      （终态任务也重盖：它的通知可能还卡在队列里）；
 *   2. 出队时 `isStaleBranchRuntimeCommand` 对 task-notification 按**任务当前**代际判定，
 *      而不是命令入队那一刻的代际——否则长回合期间发生 rewind，队列里的通知仍会被丢。
 *
 * 依赖已构建的 `dist/`：`pnpm --filter @zcode/core build`。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// `runtime-command-generation` 经 deps 触到 `@zcode/shared` / `@zcode/model-option-map`，
// 这两个包的入口发布的是原始 TypeScript。与同目录其他测试共用同一个 resolve 钩子，
// 把裸说明符改指到同布局的编译产物。
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
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

const { InMemoryRuntimeTaskRegistry, rebaseRuntimeTasksOntoBranch } = await import(
  new URL("../dist/runtime-task/registry.js", import.meta.url).href
);
const { isStaleBranchRuntimeCommand } = await import(
  new URL("../dist/runtime/methods/runtime-command-generation.js", import.meta.url).href
);

/** 建一个 registry，先钉 active generation，再登记任务（register 会按它盖章）。 */
function registryWith(tasks, activeGeneration) {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.setActiveBranchGeneration(activeGeneration);
  for (const task of tasks) registry.register(task);
  return registry;
}

function notificationCommand(overrides = {}) {
  return {
    branchGeneration: 7,
    id: "runtime_command_test",
    mode: "task-notification",
    taskId: "dwfrun-1",
    text: "notification text",
    traceContext: { traceId: "trace_test" },
    ...overrides,
  };
}

function runtimeWith(registry, branchGeneration) {
  const logs = [];
  return {
    logs,
    branchGeneration,
    logger: {
      debug(message, context) {
        logs.push({ level: "debug", message, context });
      },
      info(message, context) {
        logs.push({ level: "info", message, context });
      },
    },
    runtimeTaskRegistry: registry,
  };
}

test("rewind 后把仍 running 的旧代任务重盖到新代", () => {
  const registry = registryWith(
    [
      {
        taskId: "dwfrun-1",
        type: "local_dynamic_workflow",
        status: "running",
        turnId: "turn_keep",
        isBackgrounded: true,
      },
    ],
    7,
  );

  const rebased = rebaseRuntimeTasksOntoBranch(registry, 8);

  assert.equal(rebased, 1);
  assert.equal(registry.get("dwfrun-1")?.branchGeneration, 8);
});

test("终态任务也重盖：它的通知可能还卡在队列里等待出队", () => {
  const registry = registryWith(
    [
      {
        taskId: "dwfrun-done",
        type: "local_dynamic_workflow",
        status: "completed",
        turnId: "turn_keep",
      },
    ],
    7,
  );

  const rebased = rebaseRuntimeTasksOntoBranch(registry, 8);

  assert.equal(rebased, 1);
  assert.equal(registry.get("dwfrun-done")?.branchGeneration, 8);
});

test("启动轮被裁掉的任务保持旧代际：它的通知不该回到新分支", () => {
  const registry = registryWith(
    [
      {
        taskId: "dwfrun-fenced",
        type: "local_dynamic_workflow",
        status: "running",
        turnId: "turn_removed",
      },
      {
        taskId: "dwfrun-kept",
        type: "local_dynamic_workflow",
        status: "running",
        turnId: "turn_keep",
      },
    ],
    7,
  );

  const rebased = rebaseRuntimeTasksOntoBranch(registry, 8, {
    fencedTurnIds: new Set(["turn_removed"]),
  });

  assert.equal(rebased, 1);
  assert.equal(registry.get("dwfrun-fenced")?.branchGeneration, 7);
  assert.equal(registry.get("dwfrun-kept")?.branchGeneration, 8);
});

test("没有 turnId 的 running 任务也重盖：无法归因到被裁轮次，不能让它静默失联", () => {
  const registry = registryWith(
    [{ taskId: "exec-1", type: "local_bash", status: "running", isBackgrounded: true }],
    7,
  );

  const rebased = rebaseRuntimeTasksOntoBranch(registry, 8, {
    fencedTurnIds: new Set(["turn_removed"]),
  });

  assert.equal(rebased, 1);
  assert.equal(registry.get("exec-1")?.branchGeneration, 8);
});

test("已经在新代际的任务不重盖，计数为 0", () => {
  const registry = registryWith(
    [
      {
        taskId: "dwfrun-new",
        type: "local_dynamic_workflow",
        status: "running",
        turnId: "turn_keep",
      },
    ],
    8,
  );

  const rebased = rebaseRuntimeTasksOntoBranch(registry, 8);

  assert.equal(rebased, 0);
  assert.equal(registry.get("dwfrun-new")?.branchGeneration, 8);
});

test("出队 fence 按任务当前代际判定：rewind 前入队的通知在任务重盖后仍可投递", () => {
  const registry = registryWith(
    [
      {
        taskId: "dwfrun-1",
        type: "local_dynamic_workflow",
        status: "completed",
        turnId: "turn_keep",
      },
    ],
    7,
  );
  rebaseRuntimeTasksOntoBranch(registry, 8);

  const runtime = runtimeWith(registry, 8);
  // 命令上仍是入队时的旧代际；任务条目已被重盖。
  const stale = isStaleBranchRuntimeCommand(runtime, notificationCommand());

  assert.equal(stale, false, "按任务当前代际判定后，这条通知必须允许出队");
  assert.equal(runtime.logs.length, 0);
});

test("被裁轮次的任务没有被重盖：它的通知仍在出队时被丢弃并记 info", () => {
  const registry = registryWith(
    [
      {
        taskId: "dwfrun-1",
        type: "local_dynamic_workflow",
        status: "completed",
        turnId: "turn_removed",
      },
    ],
    7,
  );

  const runtime = runtimeWith(registry, 8);
  const stale = isStaleBranchRuntimeCommand(runtime, notificationCommand());

  assert.equal(stale, true);
  assert.equal(runtime.logs.length, 1);
  assert.equal(runtime.logs[0].level, "info");
  assert.equal(runtime.logs[0].context?.event, "runtime.command.stale_branch_dropped");
});
