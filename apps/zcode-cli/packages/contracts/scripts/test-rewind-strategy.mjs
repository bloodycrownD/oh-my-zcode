#!/usr/bin/env node
/**
 * MF-08 验收：RewindStrategy 收窄行为 + 「只回滚文件」死值的彻底退役。
 *
 * 背景：评审 A-1 查出 RewindStrategy 里挂着一个「只回滚文件、不动对话链」的枚举成员，
 * 但 evaluateRewindTarget 从来不产生它（只产出 active_chain / unavailable）。于是
 *   1. contracts 的枚举与 rewindTriggeredPayloadSchema 白宣告一个产不出的 wire 值；
 *   2. core 侧两处 `!== FileOnly` 守卫恒假、两处 `=== FileOnly` 三元恒假，
 *      后者还挂着唯一漏网的面向用户 compaction 措辞（"…stayed at the compacted context."）。
 * 改法是删枚举 + 删 wire 项 + 把四处比较收敛成只看 active_chain + 删掉那段文案。
 *
 * 本脚本钉住「收窄」本身，防止死值以后又被加回来、或 evaluateRewindTarget 悄悄
 * 长出第四种取值（那会让 core 侧那两处收敛后的守卫重新变成有意义的分支）。
 *
 * 跑在 `node:test` 上（本仓无 vitest/jest），直接 import 编译产物 `dist/`——
 * 先跑 `pnpm --filter @zcode/contracts build`。
 *
 * 全绿退出 0，否则退出 1。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// 直接走 rewind 子路径而不是包根 barrel：`dist/index.js` 会经 `@zcode/shared`
// 拉进原始 TypeScript 源码（内部 `.js` specifier 不重映射到 `.ts`），裸 node
// 加载不了。rewind 子模块的对外依赖只有 zod，可以独立加载。
const {
  RewindScope,
  RewindStrategy,
  RewindTargetStatus,
  evaluateRewindTarget,
  rewindTriggeredPayloadSchema,
} = await import("../dist/rewind/index.js");

// Printed from the exit handler, not `after()`: the node:test `after` hook runs
// before the runner has assigned the exit code, so it would always report PASS.
process.on("exit", (code) => {
  const passed = code === 0;
  console.log("");
  console.log(
    passed
      ? "TEST PASS — RewindStrategy 收窄（无 file-only 死值，evaluateRewindTarget 只两值）"
      : `TEST FAIL — RewindStrategy 收窄（exit code ${code}）`,
  );
});

const items = [{ id: "msg_1" }, { id: "msg_2" }, { id: "msg_3" }];
const base = { items, targetMessageId: "msg_2" };

/** 构造一个只填必填项的 rewindTriggered 载荷。 */
const payload = (strategy) => ({ rewindId: "rewind_1", scope: "workspace", strategy });

// ── 1) 枚举面：只剩三个成员，且不含 file-only ─────────────────────────────
test("RewindStrategy 恰好剩三个成员，file-only 值已退役", () => {
  assert.deepEqual(Object.values(RewindStrategy).sort(), [
    "active_chain",
    "fork_required",
    "unavailable",
  ]);
  // 显式钉死这两条：key 名与 wire 串都不能以任何形式复活。
  assert.equal("FileOnly" in RewindStrategy, false);
  assert.equal(Object.values(RewindStrategy).includes("file_only"), false);
  // 邻居未被顺手删改。
  assert.equal(RewindStrategy.ActiveChain, "active_chain");
  assert.equal(RewindStrategy.ForkRequired, "fork_required");
  assert.equal(RewindStrategy.Unavailable, "unavailable");
});

// ── 2) wire 面：schema 不再接受 file_only ─────────────────────────────────
test("rewindTriggeredPayloadSchema 接受三个存活取值、拒绝 file_only", () => {
  for (const strategy of Object.values(RewindStrategy)) {
    assert.equal(
      rewindTriggeredPayloadSchema.safeParse(payload(strategy)).success,
      true,
      `strategy: ${strategy} 应被 wire schema 接受`,
    );
  }
  const rejected = rewindTriggeredPayloadSchema.safeParse(payload("file_only"));
  assert.equal(rejected.success, false, "file_only 必须从 wire schema 中消失");
});

// ── 3) evaluateRewindTarget 的取值域恒为两值（收窄的核心不变量）──────────────
test("evaluateRewindTarget 只产出 active_chain / unavailable 两值", () => {
  const scopes = [RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both];
  const seen = new Set();
  for (const checkpointAvailable of [true, false, undefined]) {
    for (const scope of scopes) {
      for (const targetMessageId of ["msg_1", "msg_3", "msg_absent"]) {
        seen.add(
          evaluateRewindTarget({
            checkpointAvailable,
            items,
            scope,
            targetMessageId,
          }).strategy,
        );
      }
    }
  }
  assert.deepEqual([...seen].sort(), ["active_chain", "unavailable"]);
});

// ── 4) 目标不在活动链 → Unavailable / Missing，且不给出任何 scope ──────────
test("目标不存在：Unavailable + Missing + allowedScopes 空", () => {
  const evaluation = evaluateRewindTarget({
    checkpointAvailable: true,
    ...base,
    targetMessageId: "msg_absent",
  });
  assert.equal(evaluation.strategy, RewindStrategy.Unavailable);
  assert.equal(evaluation.targetStatus, RewindTargetStatus.Missing);
  assert.equal(evaluation.reason, "target_not_found");
  assert.deepEqual(evaluation.allowedScopes, []);
});

// ── 5) 无 checkpoint 时 scope 收窄到 conversation ──────────────────────────
test("checkpointAvailable=false：workspace/both 被拒且 allowedScopes 只剩 conversation", () => {
  for (const scope of [RewindScope.Workspace, RewindScope.Both]) {
    const evaluation = evaluateRewindTarget({ ...base, scope });
    assert.equal(evaluation.strategy, RewindStrategy.Unavailable);
    assert.equal(evaluation.targetStatus, RewindTargetStatus.ActiveChain);
    assert.equal(evaluation.reason, "checkpoint_required_for_workspace_rewind");
    assert.deepEqual(evaluation.allowedScopes, [RewindScope.Conversation]);
  }
  // conversation scope 在无 checkpoint 时仍然放行（这是 core 侧
  // rewindConversationToMessage 不传 checkpointAvailable 的依据）。
  const conversation = evaluateRewindTarget({
    ...base,
    scope: RewindScope.Conversation,
  });
  assert.equal(conversation.strategy, RewindStrategy.ActiveChain);
  assert.equal(conversation.reason, "target_in_active_chain");
});

// checkpointAvailable 缺席等价于 false（core 侧靠这条走 conversation-only 路径）。
test("checkpointAvailable 缺席等价于 false", () => {
  const absent = evaluateRewindTarget({
    ...base,
    scope: RewindScope.Workspace,
  });
  const explicitFalse = evaluateRewindTarget({
    checkpointAvailable: false,
    ...base,
    scope: RewindScope.Workspace,
  });
  assert.deepEqual(absent, explicitFalse);
  assert.equal(absent.strategy, RewindStrategy.Unavailable);
});

// ── 6) 有 checkpoint 时三个 scope 全放行 ───────────────────────────────────
test("checkpointAvailable=true：三个 scope 全部 ActiveChain，allowedScopes 全开", () => {
  for (const scope of [RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both]) {
    const evaluation = evaluateRewindTarget({
      checkpointAvailable: true,
      ...base,
      scope,
    });
    assert.equal(evaluation.strategy, RewindStrategy.ActiveChain);
    assert.equal(evaluation.targetStatus, RewindTargetStatus.ActiveChain);
    assert.equal(evaluation.reason, "target_in_active_chain");
    assert.deepEqual(evaluation.allowedScopes, [
      RewindScope.Conversation,
      RewindScope.Workspace,
      RewindScope.Both,
    ]);
  }
});

// ── 7) 自定义 getId 与缺省 getId 的行为 ───────────────────────────────────
test("getId 缺省读 item.id，自定义 getId 时改用它", () => {
  const messages = [{ info: { id: "msg_9" } }];
  const viaDefault = evaluateRewindTarget({
    checkpointAvailable: true,
    items: messages,
    scope: RewindScope.Conversation,
    targetMessageId: "msg_9",
  });
  assert.equal(viaDefault.strategy, RewindStrategy.Unavailable);
  assert.equal(viaDefault.targetStatus, RewindTargetStatus.Missing);

  const viaCustom = evaluateRewindTarget({
    checkpointAvailable: true,
    getId: (message) => message.info.id,
    items: messages,
    scope: RewindScope.Conversation,
    targetMessageId: "msg_9",
  });
  assert.equal(viaCustom.strategy, RewindStrategy.ActiveChain);
  assert.equal(viaCustom.targetStatus, RewindTargetStatus.ActiveChain);
});

// ── 8) 回归锚点：core 侧那两处「只看 active_chain」的守卫依赖的不变量 ────────
// rewind.ts / rewind-message.ts 在 workspace 路径上恒以 checkpointAvailable: true
// 调用 evaluateRewindTarget，因此走到守卫处时 strategy 要么是 ActiveChain
// （继续回滚），要么是 Unavailable 且 scope 为 workspace —— 后者正是守卫拦下的
// 唯一分支。这里把两条路径各走一遍，确保收敛后的单条件守卫不会误杀。
test("core workspace 守卫的两条路径：命中即 ActiveChain，拦下即 Unavailable", () => {
  const onHit = evaluateRewindTarget({
    checkpointAvailable: true,
    items,
    scope: RewindScope.Workspace,
    targetMessageId: "msg_2",
  });
  assert.equal(onHit.strategy !== RewindStrategy.ActiveChain, false);

  // 目标缺失会先被 target_not_found 拦下——同样以 Unavailable 结束。
  const onGuard = evaluateRewindTarget({
    checkpointAvailable: true,
    items,
    scope: RewindScope.Workspace,
    targetMessageId: "msg_absent",
  });
  assert.equal(onGuard.strategy !== RewindStrategy.ActiveChain, true);
  assert.equal(onGuard.strategy, RewindStrategy.Unavailable);
});
