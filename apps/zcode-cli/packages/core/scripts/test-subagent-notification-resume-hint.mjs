#!/usr/bin/env node
/**
 * T-RV3（subagent-resume-visibility Step 2 / C3+C4）——后台失败/停止通知的子 agent
 * 续跑指引三态与截断次序。
 *
 * 背景：`<task-notification>` 的 `<task-id>` 就是 agentId（句柄已在，缺的只是指引句）。
 * C3 在 formatLocalAgentTaskNotification 的 XML 闭合标签之后追加
 * localAgentResumeGuidance（仿 workflowDeliveryGuidance 范式），仅 failed/stopped
 * 两支；completed 反向不出现（已跑完的 agent 没有「续」的语义）。
 *
 * 四条断言：
 *   a. failed / stopped 通知含续跑指引句，且句柄引用 `<task-id>` = agentId；
 *   b. completed 通知**不含**指引（反向锁）；
 *   c. summary 前缀逐字节不变（UI Agent 卡「子智能体输出」的来源，
 *      completion-notification.ts:48-49 注释锁定）；
 *   d. 超长 `<result>`（>120k）时指引先于正文被斩（指引排最后，
 *      truncateTaskNotification 从尾部斩断）。
 *
 * 夹具走真实调用方入口 `formatLocalAgentTaskNotification`（completion-notification.ts，
 * runner finalizeBackground* 直接调它），不走任何 mock。
 *
 * 运行方式：`npx tsx --test scripts/test-subagent-notification-resume-hint.mjs`
 * （必须 tsx：被测模块是 TypeScript 源码）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// 契约单实例钩子（同 test-subagent-sync-dispatch.mjs 范式）：notification.ts 与
// completion-notification.ts 经 @zcode/contracts 取类型（ModelUsage 等），统一改指源码。
const CONTRACTS_SRC_ROOT = fileURLToPath(new URL("../../contracts/src/", import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@zcode/contracts" || specifier.startsWith("@zcode/contracts/")) {
      const relative =
        specifier === "@zcode/contracts"
          ? "index"
          : specifier.slice("@zcode/contracts/".length);
      for (const candidate of [
        `${CONTRACTS_SRC_ROOT}${relative}.ts`,
        `${CONTRACTS_SRC_ROOT}${relative}/index.ts`,
      ]) {
        if (existsSync(candidate)) {
          return { shortCircuit: true, url: pathToFileURL(candidate).href };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { formatLocalAgentTaskNotification } = await import(
  new URL("../src/subagent/completion-notification.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — T-RV3 通知续跑指引三态与截断次序"
      : `TEST FAIL — T-RV3 (exit code ${code})`,
  );
});

const AGENT_ID = "agent_rv3_1";

/** 构造一条 local_agent 终态通知（真实入口，无 mock）。 */
function makeNotice({ status, error, result }) {
  return formatLocalAgentTaskNotification({
    agentId: AGENT_ID,
    agentType: "general-purpose",
    description: "probe the notice",
    ...(error === undefined ? {} : { error }),
    outputFile: "/tmp/zcode-test-notice/output.md",
    parentToolCallId: "toolu_rv3",
    ...(result === undefined ? {} : { result }),
    status,
    totalDurationMs: 42,
  });
}

// 指引共用的续跑句骨架（文案由实现定义，测试锁的是行为事实而非字面量全集）。
const RESUME_SENTENCE = new RegExp(
  `use SendMessage with to: '${AGENT_ID}' to continue this agent`,
);

test("T-RV3a: failed 通知含指引句、task-id 即 agentId、summary 前缀逐字节不变", () => {
  const notice = makeNotice({ status: "failed", error: "child model 503", result: "partial findings" });

  // 句柄就是 <task-id>（C3 指引引用它作为 agentId 来源）。
  assert.match(notice, new RegExp(`<task-id>${AGENT_ID}</task-id>`));
  assert.match(notice, /This subagent task failed before it finished\./);
  assert.match(notice, /still resumable in this session/);
  assert.match(notice, RESUME_SENTENCE);
  // 截断次序的事实：指引排在 </task-notification> 之后（超长时先斩它）。
  assert.ok(
    notice.indexOf("</task-notification>") < notice.indexOf("use SendMessage with to:"),
    "指引必须排在 XML 闭合标签之后",
  );
  // summary 前缀逐字节不变（UI Agent 卡「子智能体输出」来源；failed 追加 error 原文；
  // 注：summary 经 escapeXml，描述里的引号呈现为 &quot;）。
  assert.ok(
    notice.includes(
      `<summary>Agent general-purpose task &quot;probe the notice&quot; failed. child model 503</summary>`,
    ),
    `summary 前缀漂移：${notice}`,
  );
  // 正文节不受指引追加影响。
  assert.ok(notice.includes("<result>partial findings</result>"));
});

test("T-RV3b: stopped 通知含 stopped 版指引且不含 failed 版措辞", () => {
  const notice = makeNotice({ status: "stopped", result: "salvaged output" });

  assert.match(notice, /This subagent task was stopped before it finished\./);
  assert.match(notice, RESUME_SENTENCE);
  assert.doesNotMatch(notice, /failed before it finished/);
  // stopped 的 summary 不追加 error（completion-notification.ts:47 只对 failed 追加）。
  assert.ok(
    notice.includes(
      `<summary>Agent general-purpose task &quot;probe the notice&quot; stopped.</summary>`,
    ),
  );
});

test("T-RV3c: completed 通知反向不含续跑指引", () => {
  const notice = makeNotice({ status: "completed", result: "final answer" });

  assert.doesNotMatch(notice, /use SendMessage with to:/);
  assert.doesNotMatch(notice, /resumable/);
  assert.doesNotMatch(notice, /This subagent task (failed|stopped) before it finished/);
  // completed summary 逐字节不变。
  assert.ok(
    notice.includes(
      `<summary>Agent general-purpose task &quot;probe the notice&quot; completed.</summary>`,
    ),
  );
  // 无指引时通知在 XML 闭合标签处收尾（不追加空段）。
  assert.match(notice, /<\/task-notification>\s*$/);
});

test("T-RV3d: 超长 result（>120k）指引先于正文被斩", () => {
  const notice = makeNotice({
    status: "failed",
    error: "child crashed mid-run",
    // 130k 纯文本正文：总长度远超 TASK_NOTIFICATION_MAX_CHARS（120k），
    // 排在最后的指引被截断先斩，result 正文保留被截断的前缀。
    result: "x".repeat(130_000),
  });

  // 截断事实：文本停在 120k 截断点并带 [truncated] 标记。
  assert.ok(notice.endsWith("[truncated]"), "超长通知必须带截断标记");
  assert.ok(notice.length <= 120_000 + "[truncated]".length + 2);
  // 指引被斩：正文还活着（<result> 前缀在场），但续跑句已不在。
  assert.ok(notice.includes("<result>xxx"), "result 正文应在截断保留范围内");
  assert.doesNotMatch(notice, RESUME_SENTENCE, "超长时指引必须先于正文被斩");
});
