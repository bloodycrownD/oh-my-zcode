#!/usr/bin/env node
/**
 * 1.0.x 回归 —— turn 终态必须回调 `onTurnSettled`，让队列有重评机会。
 *
 * 缺陷（用户实测）：异步消息（后台任务完成通知）驱动的 turn 走 core 内部
 * `task-notification` runtime command，不经过 v4 prompt 命令层的
 * `afterLegacyStateMutation`，而 1.0.x 的 autoDrain 重评只挂在
 * ① 命令层的 mutation、② `onTargetCompleted`（仅 canonical goal complete）。
 * 于是「通知回合结束、队列里还有排队命令」时没有人重评，排队命令不会自动弹出。
 *
 * 1.1.x 用 `onTurnSettled` 补了这个口子；这里把同一条契约补到 1.0.x：
 *   - TurnComplete / TurnError 投影提交后回调一次；
 *   - hydration 回放的旧终态事件不算实时 turn 结束，不回调。
 *
 * 跑法：pnpm --dir apps/zcode-cli/packages/bootstrap test:v4-turn-settled
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { ConversationV4Gateway } = await import("../src/zcode-protocol-v4/v4-gateway.js");
const { SessionEventType } = await import("@zcode/contracts");

/**
 * 只提供「被观察的那一个钩子」，其余宿主能力一律缺席（网关对可选钩子都有 `?.`）。
 * 任何未预期的宿主依赖都会直接抛错暴露出来，而不是被静默吞掉。
 */
function createHarness() {
  const settled = [];
  const errors = [];
  const host = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "onTurnSettled") {
          return (sessionId, event) => settled.push({ sessionId, type: event.type });
        }
        if (property === "onError") {
          return (scope, error) => errors.push({ error, scope });
        }
        // 网关的必需宿主能力（非可选钩子）：测试只关心终态回调，其余给最小可用值。
        if (property === "sessionExists") return () => true;
        return undefined;
      },
      has() {
        return true;
      },
    },
  );
  return { errors, host, settled };
}

let sequence = 0;
function sessionEvent(type, payload = {}) {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    payload,
    // 0 走「无 transport 序号」分支：网关直接归一化并单条投递，不需要造 N-1 前序事件。
    sequenceNumber: 0,
    sessionId: "s1",
    timestamp: new Date(),
    type,
  };
}

const TURN_ERROR_PAYLOAD = {
  error: { code: "error_during_execution", message: "boom" },
  turnPhase: "execute",
};

test("TurnComplete 提交后回调 onTurnSettled", () => {
  const harness = createHarness();
  const gateway = new ConversationV4Gateway(harness.host);
  gateway.ingest("s1", sessionEvent(SessionEventType.TurnComplete));

  assert.deepEqual(
    harness.settled.map((entry) => entry.type),
    [SessionEventType.TurnComplete],
    "异步通知回合结束时必须给宿主一次重评机会",
  );
  assert.deepEqual(harness.errors, [], "回调本身不能抛错");
});

test("TurnError 同样回调（失败的 turn 也要放行排队命令）", () => {
  const harness = createHarness();
  const gateway = new ConversationV4Gateway(harness.host);
  gateway.ingest("s1", sessionEvent(SessionEventType.TurnError, TURN_ERROR_PAYLOAD));

  assert.deepEqual(
    harness.settled.map((entry) => entry.type),
    [SessionEventType.TurnError],
  );
});

test("非终态事件不回调", () => {
  const harness = createHarness();
  const gateway = new ConversationV4Gateway(harness.host);
  gateway.ingest("s1", sessionEvent(SessionEventType.TurnStart));

  assert.deepEqual(harness.settled, [], "TurnStart 不能触发自动提升重评");
});
