#!/usr/bin/env node
/**
 * bug B 回归（2026-10-23 用户拍板语义）：中断暂停队列的输入路由。
 *
 * ============================================================================
 * 这个脚本钉住什么
 * ============================================================================
 * 1) computeInputRouting：completed + queue>0 + autoDrain=false（held 暂停）→
 *    mode="enqueue"（reasonCode=heldQueuePausesButAcceptsInput）——暂停期间输入
 *    **照常入队**，等「继续」（setAutoDrain）按 FIFO 放行。上游 choice（clear/keep
 *    确认框）路由被 omz 有意弃用；confirmationRequired 分支仅保留为兜底防御。
 * 2) queue.ts sendQueuedNow 源码形状：手动提升（非 autoDrainPromotion）成功后必须
 *    setQueueAutoDrain(true) + afterLegacyStateMutation("queue_auto_drain_resumed")
 *    ——「立即发送」=恢复语义（tripwire，防回归）。
 * 3) 防御面：applyHeldQueueDisposition 的 choice 裁决代码仍在（兜底不被误删）。
 *
 * 运行形态：worktree 根 `node --import tsx --test apps/zcode-cli/packages/bootstrap/scripts/test-held-queue-routing.mjs`
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");
const { computeInputRouting } = await import(
  pathToFileURL(join(srcRoot, "zcode-protocol-v4", "projection-state.ts")).href
);

const baseContext = {
  goalVerifying: false,
  phase: "completedInterrupted",
  queueLength: 2,
  autoDrain: false,
};

test("held 暂停（completed+queue>0+autoDrain=false）：输入照常入队（omz 拍板）", () => {
  assert.deepEqual(computeInputRouting(baseContext, "queue"), {
    mode: "enqueue",
    reasonCode: "heldQueuePausesButAcceptsInput",
  });
});

test("completedInterrupted 换 completedSuccess 同样入队；guide 会话也走 queue 车道（无 turn 可 steer）", () => {
  assert.equal(
    computeInputRouting({ ...baseContext, phase: "completedSuccess" }, "queue").mode,
    "enqueue",
  );
  assert.equal(computeInputRouting(baseContext, "guide").mode, "enqueue");
});

test("running/prewarming 保持原语义（queue/guide 车道）；无队列暂停时 startNow", () => {
  assert.equal(computeInputRouting({ ...baseContext, phase: "running" }, "queue").mode, "enqueue");
  assert.equal(computeInputRouting({ ...baseContext, phase: "prewarming" }, "guide").mode, "guide");
  assert.equal(
    computeInputRouting({ ...baseContext, phase: "completedInterrupted", queueLength: 0 }, "queue")
      .mode,
    "startNow",
  );
  assert.equal(computeInputRouting({ ...baseContext, autoDrain: true }, "queue").mode, "startNow");
});

test("goalVerifying 覆盖一切 phase（原语义保持）", () => {
  assert.equal(
    computeInputRouting({ ...baseContext, goalVerifying: true }, "queue").reasonCode,
    "goalVerifierAcceptsFutureInput",
  );
});

test("tripwire：sendQueuedNow 手动提升成功后恢复 autoDrain（立即发送=恢复语义）", () => {
  const source = readFileSync(
    join(srcRoot, "zcode-protocol-v4", "commands", "handlers", "queue.ts"),
    "utf8",
  );
  assert.match(
    source,
    /if \(!autoDrainPromotion\) \{\s*\n\s*await record\.app\.setQueueAutoDrain\(true\)/,
  );
  assert.match(source, /queue_auto_drain_resumed/);
});

test("防御面：choice 裁决（applyHeldQueueDisposition）保留为兜底", () => {
  // 上游 v3.16.2 合并后裁决本体在 input-admission.applyHeldQueueDisposition 里：
  // 「routing 不是 choice → 放行」「choice 且没给裁决 → V4HeldQueueDispositionRequiredError」。
  // 两条写面分开钉：sendText 在 session-flow.ts（两个 forceStartNow 分支各一次），
  // sendGoalCommand 在 goal.ts（applyGoalCommand 内一次）。数 session-flow 的总调用
  // 恰好被 sendText 自身两分支满足，钉不到 goal 写面——曾因此让 goal 侧 tripwire 失效。
  const admissionSource = readFileSync(
    join(srcRoot, "zcode-protocol-v4", "commands", "input-admission.ts"),
    "utf8",
  );
  assert.match(admissionSource, /V4HeldQueueDispositionRequiredError/);
  assert.match(admissionSource, /routing !== "choice"/);
  const sendTextSource = readFileSync(
    join(srcRoot, "zcode-protocol-v4", "commands", "handlers", "session-flow.ts"),
    "utf8",
  );
  const sendTextCalls = sendTextSource.match(/await applyHeldQueueDisposition\(/g) ?? [];
  assert.ok(sendTextCalls.length >= 2, "sendText 的两个 forceStartNow 分支都必须调裁决兜底");
  const goalSource = readFileSync(
    join(srcRoot, "zcode-protocol-v4", "commands", "handlers", "goal.ts"),
    "utf8",
  );
  const goalCalls = goalSource.match(/await applyHeldQueueDisposition\(/g) ?? [];
  assert.ok(goalCalls.length >= 1, "sendGoalCommand（goal.ts）必须调裁决兜底");
});
