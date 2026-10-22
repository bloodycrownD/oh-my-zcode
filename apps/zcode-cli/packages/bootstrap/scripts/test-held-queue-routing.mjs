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
  assert.equal(
    computeInputRouting({ ...baseContext, phase: "running" }, "queue").mode,
    "enqueue",
  );
  assert.equal(
    computeInputRouting({ ...baseContext, phase: "prewarming" }, "guide").mode,
    "guide",
  );
  assert.equal(
    computeInputRouting({ ...baseContext, phase: "completedInterrupted", queueLength: 0 }, "queue")
      .mode,
    "startNow",
  );
  assert.equal(
    computeInputRouting({ ...baseContext, autoDrain: true }, "queue").mode,
    "startNow",
  );
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
  assert.match(source, /if \(!autoDrainPromotion\) \{\s*\n\s*try \{\s*\n\s*await record\.app\.setQueueAutoDrain\(true\)/);
  assert.match(source, /queue_auto_drain_resumed/);
  // P2-4：恢复步骤失败降级 warn，不得把已 promoted 的命令误报失败
  assert.match(source, /v4 sendQueuedNow resume autoDrain failed/);
});

test("tripwire：sendText 执行层在 held 暂停走 deferred 入队（不 idle 起轮插队）", () => {
  const source = readFileSync(
    join(srcRoot, "zcode-protocol-v4", "commands", "handlers", "session-flow.ts"),
    "utf8",
  );
  // held 分支必须以 reasonCode 判定（区分 busy enqueue），且经 enqueueDeferredInputForBusyWork
  const heldIdx = source.indexOf('heldRoutingReason === "heldQueuePausesButAcceptsInput"');
  assert.ok(heldIdx > 0, "sendText 含 held reasonCode 判定");
  const branchBody = source.slice(heldIdx, source.indexOf("return { type: \"inputAccepted\", delivery: \"queue\"", heldIdx));
  assert.match(branchBody, /enqueueDeferredInputForBusyWork/);
  // gateway 侧提供 reasonCode 全量路由
  const gateway = readFileSync(
    join(srcRoot, "zcode-protocol-v4", "v4-gateway.ts"),
    "utf8",
  );
  assert.match(gateway, /getInputRouting\(sessionId: string\)/);
});

test("防御面：choice 裁决（applyHeldQueueDisposition）保留为兜底", () => {
  const source = readFileSync(
    join(srcRoot, "zcode-protocol-v4", "commands", "handlers", "session-flow.ts"),
    "utf8",
  );
  assert.match(source, /V4HeldQueueDispositionRequiredError/);
  assert.match(source, /routing !== "choice"/);
});
