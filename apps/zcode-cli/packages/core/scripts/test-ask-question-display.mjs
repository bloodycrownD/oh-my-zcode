#!/usr/bin/env node
/**
 * AskUserQuestion display 派生防线（docs/specs/ask-user-question-display-answers.md）。
 *
 * ============================================================================
 * 这一步新出现的失效面
 * ============================================================================
 *
 * v4 桌面端「未提供回答」的根因：handler 的结构化 answers 只进模型文本
 * （formatModelContent），UI 拿到的 output 是纯文本，无处解析。修复后 answers 走
 * tool result display 通道下发，而这条链有四个必须同时成立的环节，任何一个静默
 * 失败都会退回旧行为：
 *
 *   A. **派生**：`createToolResultDisplay("AskUserQuestion", output)` 必须产出
 *      `{kind: "ask_user_question", answers}`；answers 为空对象（用户零作答、
 *      自动继续）时照发不误——空对象承载着「自动继续」语义，不能丢。
 *   B. **contracts union**：派生出的 payload 必须过 `toolResultDisplayPayloadSchema`
 *      strict 判别（持久化 metadata 与 v4 投影都以它为准）。
 *   C. **降级边界**：answers 值超长（>16K）时整块 display 被 strict 校验拒收——
 *      这是 spec 声明的降级语义（回退「未提供回答」，不截断、不报错），钉住
 *      防止有人改成静默截断还自以为无害。
 *   D. **非本工具输出不受影响**：别的工具名 / 形状不符的 output 依旧返回 undefined。
 *
 * 运行方式：`npx tsx --test scripts/test-ask-question-display.mjs`
 * （必须 tsx：被测模块是 TypeScript 源码，与同目录 ctx 测试同范式。）
 */

import assert from "node:assert/strict";
import test from "node:test";

const { createToolResultDisplay } = await import("../src/tool/executor/result-display.ts");
const { toolResultDisplayPayloadSchema } = await import("@zcode/contracts");

const QUESTION = "这是一个功能测试问题：你希望下一步做什么？";

function askOutput(answers) {
  return {
    questions: [
      {
        question: QUESTION,
        header: "测试",
        options: [
          { label: "测试通过", description: "工具链路回传正常" },
          { label: "测试失败", description: "回传异常" },
        ],
        multiSelect: false,
      },
    ],
    answers,
  };
}

test("A1: AskUserQuestion 输出派生 {kind, answers} display", () => {
  const display = createToolResultDisplay("AskUserQuestion", askOutput({ [QUESTION]: "测试通过" }));
  assert.deepEqual(display, {
    kind: "ask_user_question",
    answers: { [QUESTION]: "测试通过" },
  });
});

test("A2: 空对象 answers（用户零作答/自动继续）照发，不吞 display", () => {
  // 空对象 ≠ 缺席：UI 靠 answers === {} 区分「自动继续」与「未提供回答」。
  const display = createToolResultDisplay("AskUserQuestion", askOutput({}));
  assert.deepEqual(display, { kind: "ask_user_question", answers: {} });
});

test("A3: annotations 与多余键不进 display——投影只承载 UI 需要的 answers", () => {
  const display = createToolResultDisplay("AskUserQuestion", {
    ...askOutput({ [QUESTION]: "Other" }),
    annotations: { [QUESTION]: { notes: "补充说明" } },
  });
  assert.deepEqual(display, { kind: "ask_user_question", answers: { [QUESTION]: "Other" } });
});

test("A4: 形状不符的 output（缺 questions）返回 undefined，不产半截 display", () => {
  assert.equal(createToolResultDisplay("AskUserQuestion", { answers: { a: "b" } }), undefined);
  assert.equal(createToolResultDisplay("AskUserQuestion", "User has answered..."), undefined);
});

test("B: 派生 payload 过 contracts 的 strict 判别 union（持久化/投影的统一卡点）", () => {
  const parsed = toolResultDisplayPayloadSchema.safeParse(
    createToolResultDisplay("AskUserQuestion", askOutput({ [QUESTION]: "测试通过" })),
  );
  assert.equal(parsed.success, true, `union 拒收派生 display: ${String(parsed.error)}`);
  assert.deepEqual(parsed.success && parsed.data, {
    kind: "ask_user_question",
    answers: { [QUESTION]: "测试通过" },
  });
});

test("C: answers 值超过 16K 边界时整块 display 被拒（降级语义，不做静默截断）", () => {
  const oversized = "x".repeat(16_385);
  const display = createToolResultDisplay("AskUserQuestion", askOutput({ [QUESTION]: oversized }));
  // 派生侧不截断（它没有预算职责）；strict 校验在 union 卡点拒收整块。
  assert.equal(display.answers[QUESTION].length, 16_385);
  assert.equal(toolResultDisplayPayloadSchema.safeParse(display).success, false);
});

test("D: 其他工具名不进 ask_user_question 分支", () => {
  // 同形状 output 落到别的工具名上：既不该产出 ask display，也不该被误吞。
  const display = createToolResultDisplay("Read", askOutput({ [QUESTION]: "测试通过" }));
  assert.equal(display, undefined, "Read 工具没有 filePath/structuredPatch，必须保持 undefined");
});

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — AskUserQuestion display derivation"
      : `TEST FAIL — AskUserQuestion display derivation (exit code ${code})`,
  );
});
