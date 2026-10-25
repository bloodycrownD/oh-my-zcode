#!/usr/bin/env node
/**
 * MC `§N§` 自标注剥离回归（bug mc-tag-leak-to-bubble）。
 *
 * 背景：MC 提示词要求模型「每条回复以 §N§ 开头」（magic-context-prompt.ts SELF_TAG_GUIDANCE），
 * transform 层又用 prependTag 再打一次；上游在持久化边界调 stripPersistedAssistantText，
 * omz 移植了该函数却零调用，导致落库原文、UI 也不清洗（实测 9,522 条 / 390 会话）。
 *
 * 修复 = shared 层共享剥离函数（packages/shared/src/text/magic-context-tag.ts），
 * 落库（core turn-model-step）与消费端（ui / bootstrap 投影）共用同一语义。
 *
 * 本文件验证：
 *   1. 剥离行为（含裸前导数字不误伤）；
 *   2. 消费端各落点确实引用同一函数（源码形状断言，防止只改一半）。
 *
 * 运行：node --import tsx --test scripts/test-magic-context-tag-strip.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

const { stripMagicContextTagNotation, stripMagicContextTagPrefix, hasMagicContextTagNotation } =
  await import(
    new URL("../../../../../packages/shared/src/text/magic-context-tag.ts", import.meta.url).href
  );

function read(relativePath) {
  return readFileSync(`${REPO_ROOT}${relativePath}`, "utf8");
}

test("完整剥离：叠加前缀 → 只剩正文", () => {
  assert.equal(stripMagicContextTagNotation("§3017§ §3017§ 直接回答"), "直接回答");
});

test("完整剥离：单个前缀", () => {
  assert.equal(stripMagicContextTagNotation("§42§ Hello"), "Hello");
});

test("完整剥离：裸前导数字原样保留（不是标签）", () => {
  assert.equal(stripMagicContextTagNotation("99 files"), "99 files");
  assert.equal(stripMagicContextTagNotation("2024 roadmap"), "2024 roadmap");
  assert.equal(stripMagicContextTagNotation("1. do this now"), "1. do this now");
});

test("完整剥离：正文中间的标签对移除，只留正文", () => {
  // 上游不折叠空白，移除 `§12§` 后保留两侧空格（逐字对齐 stripPersistedAssistantText）。
  const stripped = stripMagicContextTagNotation("答完后 §12§ 继续");
  assert.equal(stripped, "答完后  继续");
  assert.equal(stripped.includes("§"), false);
});

test("完整剥离：畸形 hybrid 与悬空开标签", () => {
  assert.equal(stripMagicContextTagNotation('§15298">§ hello'), "hello");
  assert.equal(stripMagicContextTagNotation("§103012$ hi"), "hi");
});

test("前缀剥离：只动开头，不动正文中间", () => {
  assert.equal(stripMagicContextTagPrefix("§42§ Hello"), "Hello");
  assert.equal(stripMagicContextTagPrefix("§3017§ §3017§ 直接回答"), "直接回答");
  assert.equal(stripMagicContextTagPrefix("答完后 §12§ 继续"), "答完后 §12§ 继续");
  assert.equal(stripMagicContextTagPrefix("99 files"), "99 files");
});

test("探测：有/无标签", () => {
  assert.equal(hasMagicContextTagNotation("§42§ Hello"), true);
  assert.equal(hasMagicContextTagNotation("99 files"), false);
  assert.equal(hasMagicContextTagNotation("plain text"), false);
});

test("共享出口：shared barrel 导出剥离模块", () => {
  assert.match(
    read("packages/shared/src/index.ts"),
    /export \* from "\.\/text\/magic-context-tag\.js";/,
  );
});

test("落库落点：core 持久化 text part 使用同一函数", () => {
  const source = read("apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts");
  assert.match(source, /import \{ stripMagicContextTagNotation \} from "@zcode\/shared";/);
  assert.match(source, /text: stripMagicContextTagNotation\(state\.modelResponse\)/);
});

test("消费端落点：UI 展示/复制、查找索引、会话预览、CLI transcript 同源", () => {
  const rowView = read("packages/ui/src/v4/ConversationRowView.tsx");
  assert.match(rowView, /stripMagicContextTagNotation,/);
  assert.match(rowView, /stripMagicContextTagNotation\(\s*projectsCodeComments/);
  assert.match(rowView, /text=\{stripMagicContextTagNotation\(copyText \?\? row\.text\)\}/);
  assert.match(rowView, /text=\{stripMagicContextTagNotation\(text\)\}/);

  const findIndex = read("packages/ui/src/v4/conversationFindIndex.ts");
  assert.match(findIndex, /import \{ stripMagicContextTagNotation \} from "@zcode\/shared";/);
  assert.match(findIndex, /text: stripMagicContextTagNotation\(/);

  const sessionsIndex = read(
    "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts",
  );
  assert.match(sessionsIndex, /stripMagicContextTagNotation\(row\.text\)\.slice/);

  const transcript = read("apps/zcode-cli/packages/bootstrap/src/session-transcript.ts");
  assert.match(transcript, /const text = stripMagicContextTagNotation\(/);
});
