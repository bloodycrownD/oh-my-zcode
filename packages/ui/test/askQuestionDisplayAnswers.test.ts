// AskUserQuestion 用户回答的 UI 桥接防线（docs/specs/ask-user-question-display-answers.md）。
//
// v4 下用户回答只存在于 row.output.display（kind: "ask_user_question"）；
// toolCallRowAdapter 必须把它桥接成旧形态 output={answers}，ask-question renderer
// 的既有解析（readAskUserQuestionAnswers → getAskUserQuestionAnswerText）才能命中。
// 任何一个环节退回「只桥接文本」，工具卡就重新显示「未提供回答」。
//
// 硬约束：本文件与被测模块的传递依赖链零 `@/` 导入（与
// conversationProjectionCore.test.ts 同一约束，node --test / tsx 直载源码）。
import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { toolCallRowToLegacyNode } from "../src/v4/toolCallRowAdapter.js";
import {
  getAskUserQuestionAnswerText,
  normalizeAskUserQuestionInput,
  readAskUserQuestionInput,
  readAskUserQuestionAnswers,
} from "../src/lib/askUserQuestion.js";

const QUESTION = "这是一个功能测试问题：你希望下一步做什么？";
const NO_ANSWER = "未提供回答";

/** 最小 AskUserQuestion ToolCallRow：adapter 只读这些字段（其余 undefined 安全）。 */
function askRow(output: ToolCallRow["output"]): ToolCallRow {
  return {
    toolCallId: "call_aq_1",
    toolName: "AskUserQuestion",
    status: "success",
    inputText: "",
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
    output,
  } as ToolCallRow;
}

/** renderer 的取值路径：旧形态 toolCall → 问题列表 + 回答文本。 */
function renderAnswerText(toolCall: { input?: unknown; output?: unknown; raw?: unknown }): {
  questions: ReturnType<typeof normalizeAskUserQuestionInput>["questions"];
  answers: ReturnType<typeof readAskUserQuestionAnswers>;
  text: string;
} {
  const data = normalizeAskUserQuestionInput(readAskUserQuestionInput(toolCall));
  const answers = readAskUserQuestionAnswers(toolCall);
  const firstQuestion = data.questions[0];
  const text = firstQuestion
    ? getAskUserQuestionAnswerText(firstQuestion, answers, NO_ANSWER)
    : NO_ANSWER;
  return { questions: data.questions, answers, text };
}

test("display.answers 桥接后 renderer 解析命中：显示所选 label，而非「未提供回答」", () => {
  const node = toolCallRowToLegacyNode(
    askRow({
      text: 'User has answered your questions:\n"这是一个功能测试问题：你希望下一步做什么？"="测试通过"',
      display: { kind: "ask_user_question", answers: { [QUESTION]: "测试通过" } },
    }),
  );
  // 桥接产物就是旧形态 {answers}；模型文本退到 raw.rawOutput，其他通道不动。
  assert.deepEqual(node.toolCall.output, { answers: { [QUESTION]: "测试通过" } });
  const raw = node.toolCall.raw as { rawOutput?: unknown } | undefined;
  assert.equal(typeof raw?.rawOutput === "string" && raw.rawOutput.includes("测试通过"), true);
  const { text } = renderAnswerText(node.toolCall);
  assert.equal(text, "测试通过");
});

test("空对象 answers（零作答/自动继续）必须原样桥接：{} ≠ 缺席", () => {
  const node = toolCallRowToLegacyNode(
    askRow({
      text: "User has answered your questions: (no answers)",
      display: { kind: "ask_user_question", answers: {} },
    }),
  );
  assert.deepEqual(node.toolCall.output, { answers: {} });
  const { answers, text } = renderAnswerText(node.toolCall);
  // renderer 的 wasAutomaticallyContinued 前提：answers 已定义且键数为 0。
  assert.notEqual(answers, undefined);
  assert.equal(Object.keys(answers ?? {}).length, 0);
  // 该前提下 renderer 走「自动继续」文案；本断言只钉解析层不误造回答。
  assert.equal(text, NO_ANSWER);
});

test("无 display 的历史行（修复前会话/降级）不回归：维持「未提供回答」", () => {
  const node = toolCallRowToLegacyNode(askRow({ text: "User has answered your questions: ..." }));
  assert.equal(node.toolCall.output, "User has answered your questions: ...");
  const { answers, text } = renderAnswerText(node.toolCall);
  assert.equal(answers, undefined);
  assert.equal(text, NO_ANSWER);
});

test("其它 display kind 不串道：output 仍桥接纯文本", () => {
  const node = toolCallRowToLegacyNode(
    askRow({
      text: "done",
      display: { kind: "mcp_tool", serverName: "srv", toolName: "t" },
    }),
  );
  assert.equal(node.toolCall.output, "done");
});
