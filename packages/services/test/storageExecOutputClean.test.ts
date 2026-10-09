/**
 * T-C2（Step 17 / 6c）—— `cli/exec` 单列可清理 + 不误伤 + 在飞保护。
 *
 * 背景：`cli/exec/<sessionId>/<toolCallId>-stdout.log` 是 Bash 合并输出的落盘位置，
 * 失控命令（子代理后台死循环灌 stdout）曾把单文件写到 5.13GiB、5 次共 25.7GB，
 * 而它历史上被 `CLEANABILITY.toolOutputs: "none"` 整组统管，现网没有回收手段。
 *
 * 本次按 per-path 覆盖单列 `cli/exec`（judge P2-11：不动整组）：
 *   - `getStorageCleanScopes("toolOutputs")` 只枚举 `cli/exec`，不枚举整组；
 *   - `planStorageClean` 用 `isStoragePathInCleanScope` 再过滤一遍候选（双保险），
 *     `cli/artifacts` / `cli/agents` 因此永远进不了删除目标；
 *   - 在飞保护（round-2 P1-4b）：24h 内有过写入的 exec 文件跳过，避免一键清理
 *     删掉仍在运行的后台任务输出（fd 仍被持有）。
 *
 * 用例为纯函数直测（`tsx --test` 直吃 TS 源，无需 build）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { planStorageClean } from "../src/storage/domain/cleanPlan.js";
import {
  classifyStoragePath,
  getStorageCategoryCleanability,
  getStorageCleanScopes,
  hasStorageCleanPathOverride,
  isStoragePathInCleanScope,
} from "../src/storage/domain/storageCatalog.js";
import type { StorageCatalogContext } from "../src/storage/domain/storageCatalog.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = 1_700_000_000_000;

const CONTEXT: StorageCatalogContext = { rootId: "home", hasCustomDataBaseDir: false };

function candidate(relativePath: string, mtimeMs: number, bytes = 1024) {
  return { relativePath, bytes, mtimeMs };
}

// ── T-C2-1：清理范围只覆盖 cli/exec ────────────────────────────────────────

test("T-C2-1a: toolOutputs 的清理 scope 收敛到 cli/exec（不枚举整组）", () => {
  const scopes = getStorageCleanScopes("toolOutputs");
  assert.deepEqual(
    scopes.map((scope) => scope.prefix),
    ["cli/exec"],
  );
  assert.equal(
    scopes.every((scope) => scope.recursive),
    true,
  );
});

test("T-C2-1b: cli/artifacts / cli/agents 不在 toolOutputs 清理范围内", () => {
  assert.equal(
    isStoragePathInCleanScope("toolOutputs", "cli/exec/sess_a/call_1-stdout.log", CONTEXT),
    true,
  );
  assert.equal(isStoragePathInCleanScope("toolOutputs", "cli/exec", CONTEXT), true);
  for (const untouched of [
    "cli/artifacts/sess_a/call_1.png",
    "cli/agents/sess_a/agent_1/transcript.jsonl",
    "cli/agents/sess_a/agent_1/output.txt",
    "cli/sessions/sess_a/state.json",
    "tmp/scratch.bin",
    "clipboard/item-1",
  ]) {
    assert.equal(
      isStoragePathInCleanScope("toolOutputs", untouched, CONTEXT),
      false,
      `${untouched} 不得进入 toolOutputs 清理范围`,
    );
  }
});

test("T-C2-1c: 占用分类不变——exec 仍统计在 toolOutputs 行", () => {
  // per-path 覆盖只动清理范围，不动分类：否则资源管理器里的工具输出占用会凭空少一块。
  assert.equal(
    classifyStoragePath("cli/exec/sess_a/call_1-stdout.log", CONTEXT).categoryId,
    "toolOutputs",
  );
  assert.equal(
    classifyStoragePath("cli/artifacts/sess_a/call_1.png", CONTEXT).categoryId,
    "toolOutputs",
  );
});

// ── T-C2-2：不误伤（清理计划目标集合） ────────────────────────────────────

test("T-C2-2a: 清理 toolOutputs 只删 cli/exec，绝不带上 artifacts/agents", () => {
  const candidates = [
    candidate("cli/exec/sess_a/call_1-stdout.log", NOW - 30 * DAY_MS),
    candidate("cli/exec/sess_a/call_2-stdout.log", NOW - 30 * DAY_MS),
    candidate("cli/artifacts/sess_a/call_1.png", NOW - 30 * DAY_MS),
    candidate("cli/artifacts/sess_a/call_1.json", NOW - 30 * DAY_MS),
    candidate("cli/agents/sess_a/agent_1/transcript.jsonl", NOW - 30 * DAY_MS),
    candidate("cli/agents/sess_a/agent_1/output.txt", NOW - 30 * DAY_MS),
    candidate("cli/sessions/sess_a/state.json", NOW - 30 * DAY_MS),
  ];
  const plan = planStorageClean({
    categoryId: "toolOutputs",
    candidates,
    context: CONTEXT,
    now: NOW,
  });
  assert.deepEqual(plan.targets.map((target) => target.relativePath).sort(), [
    "cli/exec/sess_a/call_1-stdout.log",
    "cli/exec/sess_a/call_2-stdout.log",
  ]);
  assert.equal(plan.skippedCount, candidates.length - plan.targets.length);
});

// ── T-C2-3：在飞保护 ──────────────────────────────────────────────────────

test("T-C2-3a: 24h 内有写入的 exec 文件不被清理（运行中的后台任务）", () => {
  const candidates = [
    // 正在运行的后台 Bash：持续追加，mtime 就是现在
    candidate("cli/exec/sess_running/call_live-stdout.log", NOW - 5_000),
    // 一小时前还在写的任务（长构建）
    candidate("cli/exec/sess_build/call_build-stdout.log", NOW - 3 * HOUR_MS),
    // 已终态的旧日志：可回收
    candidate("cli/exec/sess_old/call_old-stdout.log", NOW - 25 * DAY_MS),
  ];
  const plan = planStorageClean({
    categoryId: "toolOutputs",
    candidates,
    context: CONTEXT,
    now: NOW,
  });
  assert.deepEqual(
    plan.targets.map((target) => target.relativePath),
    ["cli/exec/sess_old/call_old-stdout.log"],
  );
  assert.equal(plan.skippedCount, 2);
});

test("T-C2-3b: 同会话里的旧日志不受在飞任务影响，仍可回收", () => {
  const candidates = [
    candidate("cli/exec/sess_mixed/call_live-stdout.log", NOW - 60_000),
    candidate("cli/exec/sess_mixed/call_old-stdout.log", NOW - 40 * DAY_MS),
  ];
  const plan = planStorageClean({
    categoryId: "toolOutputs",
    candidates,
    context: CONTEXT,
    now: NOW,
  });
  assert.deepEqual(
    plan.targets.map((target) => target.relativePath),
    ["cli/exec/sess_mixed/call_old-stdout.log"],
  );
});

test("T-C2-3c: 恰好在窗口边界外的文件可清理（24h 整）", () => {
  const candidates = [
    candidate("cli/exec/sess_edge/call_edge-stdout.log", NOW - DAY_MS),
    candidate("cli/exec/sess_edge/call_edge2-stdout.log", NOW - (DAY_MS + 1)),
  ];
  const plan = planStorageClean({
    categoryId: "toolOutputs",
    candidates,
    context: CONTEXT,
    now: NOW,
  });
  assert.deepEqual(
    plan.targets.map((target) => target.relativePath),
    ["cli/exec/sess_edge/call_edge2-stdout.log"],
  );
});

// ── T-C2-4：类别清理性状 ──────────────────────────────────────────────────

test("T-C2-4a: toolOutputs 可清理（接进清理入口），其余 none 类别维持原状", () => {
  assert.equal(hasStorageCleanPathOverride("toolOutputs"), true);
  assert.notEqual(getStorageCategoryCleanability("toolOutputs"), "none");
  // 整组其余成员仍然没有独立的清理入口
  for (const none of ["sessionStore", "runtimes", "config", "other"]) {
    assert.equal(getStorageCategoryCleanability(none), "none", `${none} 必须维持不可清理`);
    assert.equal(hasStorageCleanPathOverride(none), false);
  }
  // 其它类别不受 per-path 覆盖影响：logs 仍是「跳过当天」，subagentTranscripts 仍是 24h 目录窗口
  assert.equal(hasStorageCleanPathOverride("logs"), false);
  assert.equal(hasStorageCleanPathOverride("subagentTranscripts"), false);
});

test("T-C2-4b: 其它类别的清理计划行为不变（logs 跳当天 / subagent 24h 目录窗口）", () => {
  const logsPlan = planStorageClean({
    categoryId: "logs",
    candidates: [
      candidate("v2/logs/app-2026-01-01.log", NOW),
      candidate("v2/logs/app-2026-01-02.log", NOW - 3 * DAY_MS),
    ],
    context: CONTEXT,
    now: NOW,
  });
  assert.deepEqual(
    logsPlan.targets.map((target) => target.relativePath),
    ["v2/logs/app-2026-01-02.log"],
  );

  const subagentPlan = planStorageClean({
    categoryId: "subagentTranscripts",
    candidates: [
      candidate("cli/agents/sess_live/agent_1/transcript.jsonl", NOW - HOUR_MS),
      candidate("cli/agents/sess_live/agent_1/output.txt", NOW - HOUR_MS),
      candidate("cli/agents/sess_dead/agent_1/transcript.jsonl", NOW - 40 * DAY_MS),
      candidate("cli/agents/sess_dead/agent_1/output.txt", NOW - 40 * DAY_MS),
    ],
    context: CONTEXT,
    now: NOW,
  });
  assert.deepEqual(
    subagentPlan.targets.map((target) => target.relativePath),
    ["cli/agents/sess_dead/agent_1/transcript.jsonl"],
  );
});

test("T-C2-4c: 受保护路径即使在 cli/exec 下也不删", () => {
  const candidates = [candidate("cli/exec/sess_x/credentials.json", NOW - 40 * DAY_MS)];
  const plan = planStorageClean({
    categoryId: "toolOutputs",
    candidates,
    context: CONTEXT,
    now: NOW,
  });
  assert.deepEqual(plan.targets, []);
  assert.equal(plan.skippedCount, 1);
});
