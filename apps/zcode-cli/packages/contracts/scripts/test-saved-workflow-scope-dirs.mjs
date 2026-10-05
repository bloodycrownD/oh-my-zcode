#!/usr/bin/env node
/**
 * MF-17 验收：saved workflow 两档作用域目录常量的一致性断言。
 *
 * 背景：评审 C-orch-1 查出 `SAVED_WORKFLOW_PROJECT_DIR` 的值是对的（`.zcode/workflows`），
 * 但围绕它的六处注释里有五处把它写成 `.omz/workflows`——注释与代码分叉，而注释正是
 * 后来人（L1 品牌改名、S32 数据根改名）唯一能读到的「为什么这里不跟着改名」的线索。
 * 注释改完之后需要一个**机器可执行**的不变量，否则下一次改名又会只改一半。
 *
 * 本脚本钉住三条：
 *   1. 工作区级目录是 `.zcode/workflows`（刻意保留旧产品名：它随仓库提交、跨机器共享）；
 *   2. 用户级目录是 `.omz/workflows`（L1/S32 已把用户级数据根改成 `.omz`）；
 *   3. 两者**不得**相同——一旦某次「顺手统一」把它们并成一个，工作区档与全局档的
 *      作用域隔离就静默消失了，而这个 bug 不会以异常的形式出现。
 *
 * 跑在 `node:test` 上（本仓无 vitest/jest），直接 import 编译产物 `dist/`——
 * 先跑 `pnpm --filter @zcode/contracts build`。
 *
 * 全绿退出 0，否则退出 1。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// 走 `dist/tools/saved-workflow.js` 子路径而不是包根 barrel：`dist/index.js` 会经
// `@zcode/shared` 拉进原始 TypeScript 源码（内部 `.js` specifier 不重映射到 `.ts`），
// 裸 node 加载不了。这个子模块的对外依赖只有 zod，可以独立加载。
const { SAVED_WORKFLOW_GLOBAL_DIR, SAVED_WORKFLOW_PROJECT_DIR, WORKFLOW_DRAFTS_DIR } =
  await import("../dist/tools/saved-workflow.js");

// Printed from the exit handler, not `after()`: the node:test `after` hook runs
// before the runner has assigned the exit code, so it would always report PASS.
process.on("exit", (code) => {
  const passed = code === 0;
  console.log("");
  console.log(
    passed
      ? "TEST PASS — saved workflow 作用域目录（工作区级 .zcode / 用户级 .omz，分层不合并）"
      : `TEST FAIL — saved workflow 作用域目录（exit code ${code}）`,
  );
});

test("工作区级目录刻意保留 .zcode 前缀", () => {
  assert.equal(SAVED_WORKFLOW_PROJECT_DIR, ".zcode/workflows");
  // 显式钉死：不能是 `.omz`，也不能退化成裸 `workflows`（丢了工作区归属）。
  assert.equal(SAVED_WORKFLOW_PROJECT_DIR.startsWith(".omz"), false);
});

test("用户级目录是 .omz（L1/S32 改名的那一档）", () => {
  assert.equal(SAVED_WORKFLOW_GLOBAL_DIR, ".omz/workflows");
});

test("两档不得相同——作用域隔离靠的就是这个差", () => {
  assert.notEqual(SAVED_WORKFLOW_PROJECT_DIR, SAVED_WORKFLOW_GLOBAL_DIR);
});

test("草稿目录与项目档同为工作区级 .zcode 兄弟目录", () => {
  // 草稿是机器自有的，不随仓库提交，但同样留在 .zcode 下——L1 只改了用户级数据根。
  assert.equal(WORKFLOW_DRAFTS_DIR, ".zcode/workflow-drafts");
  assert.equal(
    WORKFLOW_DRAFTS_DIR.startsWith(`${SAVED_WORKFLOW_PROJECT_DIR.split("/")[0]}/`),
    true,
  );
});
