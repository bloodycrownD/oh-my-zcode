#!/usr/bin/env node
/**
 * AskUserQuestion display 的 v4 投影防线（docs/specs/ask-user-question-display-answers.md）。
 *
 * ============================================================================
 * 这一步新出现的失效面
 * ============================================================================
 *
 * core 侧派生 display 只是第一步；它必须活着穿过 bootstrap 的 v4 投影才算到达 UI。
 * 这条链上有两个历史上真实翻过车的静默丢弃点，本测试用真实 SessionEvent 灌
 * ProductProjection 把它们钉住：
 *
 *   A. **toProtocolToolCallDisplay 白名单**：实时投影按 kind 白名单收窄，漏一个
 *      case 就丢 display——引入 create_workflow 时就漏过一份名单，桌面端只有
 *      重载之后才看得到。ask_user_question 必须同时出现在 row.display（顶层）与
 *      row.output.display（canonical）上。
 *   B. **hydration 等价**：冷恢复走 beginHydrationReplay/applyHydrationEvent，
 *      与实时路径共用 onToolCallResult；display 在两条路径下必须逐字节一致，
 *      否则「实时看得到、重开就丢」。
 *   C. **wire 合法性**：投影出的 row 必须过 shared 侧 conversationRowSchema 的
 *      strict 校验——shared zod union 若没同步收编新 kind，display 会在客户端
 *      解析时整块被剥（CUA 修过的同款 bug）。
 *
 * 运行方式：`npx tsx --test scripts/test-ask-question-projection.mjs`
 * （必须 tsx：被测模块是 TypeScript 源码，与 test-turn-directory 同范式。）
 */

import assert from "node:assert/strict";
import test from "node:test";

const { conversationRowSchema } = await import("@zcode/shared/zcode-protocol-v4");
const { SessionEventType } = await import("@zcode/contracts");
const { ProductProjection } = await import(
  new URL("../src/zcode-protocol-v4/product-projection.ts", import.meta.url).href
);

const SESSION_ID = "ses_aq_proj";
const EPOCH = "epoch-aq";
const TURN_ID = "turn-aq-1";
const QUESTION = "这是一个功能测试问题：你希望下一步做什么？";
const ANSWERS = { [QUESTION]: "测试通过" };
const DISPLAY = { kind: "ask_user_question", answers: ANSWERS };

let eventSeq = 0;
function event(type, payload) {
  eventSeq += 1;
  return {
    id: `evt-${eventSeq}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    type,
    timestamp: new Date(),
    traceId: "trace-aq-proj",
    sequenceNumber: eventSeq,
    payload,
  };
}

function askToolEvents(display) {
  return [
    event(SessionEventType.TurnStarted, {
      input: "帮我测试提问工具",
      messageId: "msg_u_aq",
    }),
    event(SessionEventType.ToolCallScheduled, {
      toolCallId: "call_aq_1",
      toolName: "AskUserQuestion",
      input: {
        questions: [
          {
            question: QUESTION,
            header: "测试",
            options: [
              { label: "测试通过", description: "工具链路回传正常" },
              { label: "测试失败", description: "回传异常" },
            ],
          },
        ],
      },
      schedule: { parallelGroups: [["call_aq_1"]], executionOrder: ["call_aq_1"] },
    }),
    event(SessionEventType.ToolCallStarted, {
      toolCallId: "call_aq_1",
      startedAt: new Date(),
    }),
    event(SessionEventType.ToolCallResult, {
      toolCallId: "call_aq_1",
      duration: 42,
      result: {
        success: true,
        content: 'User has answered your questions:\n"这是一个功能测试问题：你希望下一步做什么？"="测试通过"',
        ...(display ? { display } : {}),
      },
    }),
  ];
}

function askRow(projection) {
  const row = projection
    .getSnapshot()
    .rows.window.find((item) => item.kind === "toolCall" && item.toolCallId === "call_aq_1");
  assert.ok(row, "AskUserQuestion 工具行必须被投影出来");
  return row;
}

test("A: 实时投影把 ask_user_question display 写上 row（顶层 + output 两处）", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  for (const item of askToolEvents(DISPLAY)) {
    projection.applyEvent(item);
  }
  const row = askRow(projection);
  assert.equal(row.status, "success");
  assert.deepEqual(row.display, DISPLAY, "toProtocolToolCallDisplay 白名单必须放行 ask_user_question");
  assert.deepEqual(row.output?.display, DISPLAY, "buildToolOutput 必须保留结构化 display");
  assert.equal(typeof row.output?.text, "string", "模型文本通道不受影响");
});

test("B: 冷恢复 hydration 重放与实时投影产出相同的 display", () => {
  const live = new ProductProjection(SESSION_ID, EPOCH);
  for (const item of askToolEvents(DISPLAY)) {
    live.applyEvent(item);
  }

  const cold = new ProductProjection(SESSION_ID, EPOCH);
  cold.beginHydrationReplay();
  for (const item of askToolEvents(DISPLAY)) {
    cold.applyHydrationEvent(item);
  }
  cold.completeHydrationReplay();

  const liveRow = askRow(live);
  const coldRow = askRow(cold);
  assert.deepEqual(coldRow.display, liveRow.display);
  assert.deepEqual(coldRow.output?.display, liveRow.output?.display);
});

test("C: 投影出的 toolCall row 过 shared 侧 strict row schema（wire 合法性）", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  for (const item of askToolEvents(DISPLAY)) {
    projection.applyEvent(item);
  }
  const row = askRow(projection);
  assert.doesNotThrow(
    () => conversationRowSchema.parse(row),
    "shared zod union 未同步收编 ask_user_question 时，客户端解析会整块剥掉 display",
  );
  const parsed = conversationRowSchema.parse(row);
  assert.equal(parsed.kind, "toolCall");
  assert.deepEqual(parsed.display, DISPLAY);
});

test("D: 无 display 的历史事件（修复前会话）投影不回归", () => {
  const projection = new ProductProjection(SESSION_ID, EPOCH);
  for (const item of askToolEvents(undefined)) {
    projection.applyEvent(item);
  }
  const row = askRow(projection);
  assert.equal(row.status, "success");
  assert.equal(row.output?.display, undefined, "没有 display 就不凭空造——UI 回退「未提供回答」");
  // 顶层 display 也不得凭空出现（node_repl_images 之外的顶层通道保持关闭）。
  assert.equal(row.display, undefined);
});

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — AskUserQuestion display projection"
      : `TEST FAIL — AskUserQuestion display projection (exit code ${code})`,
  );
});
