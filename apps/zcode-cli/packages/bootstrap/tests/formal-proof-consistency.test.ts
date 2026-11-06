// formal-proof 全枚举 ↔ 投影 guard 一致性（13-golden-test-mapping §结构性 8）。
// packages/formal-proof/src/model.ts 的 evaluate 是可执行裁决表（02-projection「规则模块下沉」）；
// 本测试机械对账：每个 coherent ProductContext × Candidate 组合的 Decision，
// 必须与投影同源派生（computeInputRouting）一致。
//
// 对账面（v4 A 区可观测量，10 §4.2.2）：
//   sendText / setGoal → inputRouting.mode（allow→startNow / enqueue→enqueue / reject→reject）
// 不在对账面的候选：
//   compact/slashCompact —— compact 产品面已在本 fork 删除，formal-proof 候选与
//     `availability.compact` 同步移除；
//   forkLatest/forkOld/editLatest/editOld —— 行级动作（RowActions §4.4.1），M3 rows guard 接线时对账；
//   system 候选 —— 状态推进由 reducer 事件流黄金测试覆盖（product-projection.test.ts）。
import { describe, expect, it } from "vitest";
import {
  evaluate,
  userCandidates,
  type Candidate,
  type ProductContext,
} from "@zcode/formal-proof/model";
import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import {
  ProductProjection,
  computeInputRouting,
  type AvailabilityContext,
} from "../src/zcode-protocol-v4/index.js";

// ── ProductContext（formal-proof 词表）→ AvailabilityContext（v4 guard 输入面）──

// FORK：compact 产品面已删，`compacting` 不再是可达 runPhase（v4 AvailabilityContext 也没有
// 该维度），枚举里去掉它，避免用「compacting → completedSuccess」的错映射制造假差异。
const RUN_PHASES = ["idle", "running", "completed", "goalVerifying"] as const;
const QUEUES = ["empty", "text", "goal", "compact", "mixed"] as const;
const COMPACT_MEMORIES = ["never", "compactable", "justCompacted", "notNeeded"] as const;
const GOALS = ["none", "active", "verifying", "verified", "failed"] as const;
const TURNS = ["latest", "old", "none"] as const;

function toAvailabilityContext(context: ProductContext): AvailabilityContext {
  return {
    phase:
      context.runPhase === "running" || context.runPhase === "goalVerifying"
        ? "running"
        : context.runPhase === "idle"
          ? "draft"
          : "completedSuccess",
    goalStatus:
      context.goal === "none"
        ? null
        : context.goal === "verifying"
          ? "verifying"
          : context.goal === "verified"
            ? "verified"
            : context.goal === "failed"
              ? "failed"
              : "active",
    goalVerifying: context.runPhase === "goalVerifying",
    queueLength: context.queue === "empty" ? 0 : 1,
    // formal-proof 无 autoDrain 维度；不变量：completed 下滞留的 queue 只可能是
    // autoDrain=false 的 held queue（autoDrain=true 时 assistantComplete 即消费）。
    autoDrain: context.queue === "empty",
  };
}

// coherent 剪枝：goal=verifying ⇔ runPhase=goalVerifying（其余组合事件流不可达，
// 由 feature-boundary 剪枝规则背书，非本测试对账对象）。
function isCoherent(context: ProductContext): boolean {
  return (context.runPhase === "goalVerifying") === (context.goal === "verifying");
}

// formal-proof ruleId → product-protocol guard reasonCode（09 §词表）。
const REASON_CODE_BY_RULE_ID: Record<string, string> = {
  compactingAcceptsFutureInput: "compactingAcceptsFutureInput",
  goalVerifierAcceptsFutureInput: "goalVerifierAcceptsFutureInput",
  heldQueueInputRequiresChoice: "heldQueueInputRequiresChoice",
};

// FORK（2026-10-23 bug B 拍板）：暂停队列（completed + queue>0 + autoDrain=false）期间
// 输入照常入队，弃用上游 choice 确认框（product-projection/computeInputRouting 的
// `heldQueuePausesButAcceptsInput`）。`packages/formal-proof/src/model.ts` 的
// heldQueueInputRequiresChoice 规则尚未同步，属 formal-proof 模型侧待更新；这里显式登记
// 这组差异并断言 fork 的新行为，禁止静默跳过。
const HELD_QUEUE_RULE_ID = "heldQueueInputRequiresChoice";

function* coherentContexts(): Generator<ProductContext> {
  for (const runPhase of RUN_PHASES) {
    for (const queue of QUEUES) {
      for (const compactMemory of COMPACT_MEMORIES) {
        for (const canCompactAgain of [true, false]) {
          for (const goal of GOALS) {
            for (const selectedTurn of TURNS) {
              for (const forked of [true, false]) {
                const context: ProductContext = {
                  runPhase,
                  queue,
                  compactMemory,
                  canCompactAgain,
                  goal,
                  selectedTurn,
                  forked,
                };
                if (isCoherent(context)) yield context;
              }
            }
          }
        }
      }
    }
  }
}

function candidateById(id: string): Candidate {
  const candidate = userCandidates.find((item) => item.id === id);
  if (!candidate) throw new Error(`unknown candidate: ${id}`);
  return candidate;
}

describe("formal-proof 全枚举 ↔ guard 同源派生一致", () => {
  it("sendText/setGoal：Decision ↔ inputRouting.mode 全枚举一致", () => {
    let checked = 0;
    let heldQueueRows = 0;
    for (const context of coherentContexts()) {
      const routing = computeInputRouting(toAvailabilityContext(context), "queue");
      for (const candidateId of ["sendText", "setGoal"]) {
        const decision = evaluate(context, candidateById(candidateId));
        const label = `${JSON.stringify(context)} × ${candidateId} → ${decision.ruleId}`;
        if (decision.kind === "allow") {
          expect(routing.mode, label).toBe("startNow");
        } else if (decision.kind === "enqueue") {
          expect(routing.mode, label).toBe("enqueue");
          // 维护/验证 work 入队必须带 reasonCode（催化 UI 提示「忙态中，已入队」）。
          if (
            decision.ruleId === "compactingAcceptsFutureInput" ||
            decision.ruleId === "goalVerifierAcceptsFutureInput"
          ) {
            expect(routing.reasonCode, label).toBe(REASON_CODE_BY_RULE_ID[decision.ruleId]);
          }
        } else if (decision.kind === "choice") {
          // 见 HELD_QUEUE_RULE_ID 注释：fork 已把 held choice 改成 pause-but-enqueue。
          expect(decision.ruleId, label).toBe(HELD_QUEUE_RULE_ID);
          expect(routing, label).toEqual({
            mode: "enqueue",
            reasonCode: "heldQueuePausesButAcceptsInput",
          });
          heldQueueRows += 1;
        } else if (decision.kind === "reject") {
          expect(routing.mode, label).toBe("reject");
          expect(routing.reasonCode, label).toBe(REASON_CODE_BY_RULE_ID[decision.ruleId]);
        } else if (decision.kind === "undefined") {
          // formal-proof 未定义区：不作为一致性断言对象；登记数量防呆
          // （膨胀说明规则被删）。
          checked -= 1;
        } else {
          throw new Error(`send 候选出现未预期裁决种类：${label}`);
        }
        checked += 1;
      }
    }
    // held-queue 差异行必须真实命中，否则上面的 fork 分支会退化成死断言。
    expect(heldQueueRows).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(2000);
  });
});

// ── reducer 落地对账：runPhase 原型经真实事件流构造，guard 与裁决表一致 ──
// compact 产品面已删（`availability.compact` 不存在），本组只对账 inputRouting。

describe("formal-proof 原型 ↔ reducer 事件流投影一致", () => {
  let eventSeq = 0;
  function makeEvent(type: SessionEvent["type"], payload: unknown, turnId?: string): SessionEvent {
    eventSeq += 1;
    return {
      id: `event-${eventSeq}`,
      sessionId: "session-1",
      turnId,
      type,
      timestamp: new Date(1_700_000_000_000 + eventSeq * 1000),
      traceId: "trace-1",
      sequenceNumber: eventSeq,
      payload,
    } as SessionEvent;
  }

  function project(events: SessionEvent[]): ProductProjection {
    const projection = new ProductProjection("session-1", "epoch-1");
    for (const event of events) projection.applyEvent(event);
    return projection;
  }

  const created = () =>
    makeEvent(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 1000,
    });
  const turnStarted = () =>
    makeEvent(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi" }, "turn-1");
  const turnDone = () =>
    makeEvent(
      SessionEventType.TurnComplete,
      {
        response: "ok",
        tokenCount: 1,
        toolCallCount: 0,
        duration: 10,
        resultType: "success",
      },
      "turn-1",
    );

  it("idle（draft）：输入 startNow", () => {
    const snapshot = project([created()]).getSnapshot();
    expect(snapshot.inputRouting.mode).toBe("startNow");
  });

  it("running：输入 enqueue", () => {
    const snapshot = project([created(), turnStarted()]).getSnapshot();
    expect(snapshot.inputRouting.mode).toBe("enqueue");
  });

  it("completed：输入 startNow", () => {
    const snapshot = project([created(), turnStarted(), turnDone()]).getSnapshot();
    expect(snapshot.inputRouting.mode).toBe("startNow");
  });

  it("goalVerifying：消息可入队；验证通过后恢复立即执行", () => {
    const projection = project([
      created(),
      turnStarted(),
      turnDone(),
      makeEvent(SessionEventType.TargetChanged, {
        action: "set",
        source: "command",
        target: {
          sessionID: "session-1",
          targetID: "target-1",
          objective: "修绿测试",
          summaryTitle: null,
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          time: { created: 0, updated: 0 },
        },
        previousTarget: null,
      }),
      makeEvent(SessionEventType.TargetCompletionVerification, {
        targetId: "target-1",
        status: "started",
        verificationId: "verify-1",
        goalIteration: 1,
      }),
    ]);
    expect(projection.getSnapshot().inputRouting).toEqual({
      mode: "enqueue",
      reasonCode: "goalVerifierAcceptsFutureInput",
    });

    projection.applyEvent(
      makeEvent(SessionEventType.TargetCompletionVerification, {
        targetId: "target-1",
        status: "completed",
        verificationId: "verify-1",
        goalIteration: 1,
        verification: { passed: true, reason: "ok" },
      }),
    );
    expect(projection.getSnapshot().inputRouting.mode).toBe("startNow");
  });

  it("held（stop + 残留 queue）：autoDrain=false，输入照常 enqueue（fork 弃用 choice）", () => {
    const projection = project([
      created(),
      turnStarted(),
      makeEvent(
        SessionEventType.TurnSteerQueued,
        {
          pendingInputId: "pi-1",
          input: "顺便加个测试",
          inputPreview: "顺便加个测试",
          inputSize: 6,
          targetTurnId: "turn-1",
          queueLength: 1,
        },
        "turn-1",
      ),
      makeEvent(
        SessionEventType.TurnComplete,
        {
          response: "",
          tokenCount: 0,
          toolCallCount: 0,
          duration: 100,
          resultType: "cancelled",
        },
        "turn-1",
      ),
    ]);
    const snapshot = projection.getSnapshot();
    // stopKeepsQueueAndDisablesAutoDrain：queue 原样保留 + 不自动消费。
    expect(snapshot.queue.items).toHaveLength(1);
    expect(snapshot.queue.autoDrain).toBe(false);
    // 2026-10-23 bug B：暂停期间输入照常入队（等「继续」按 FIFO 放行），不再弹 choice。
    expect(snapshot.inputRouting).toEqual({
      mode: "enqueue",
      reasonCode: "heldQueuePausesButAcceptsInput",
    });

    // held 消解路径之一：queue 清空后回到 startNow。
    projection.applyEvent(
      makeEvent(
        SessionEventType.TurnSteerDiscarded,
        { pendingInputIds: ["pi-1"], reason: "user_cleared" },
        "turn-1",
      ),
    );
    expect(projection.getSnapshot().inputRouting.mode).toBe("startNow");
  });
});
