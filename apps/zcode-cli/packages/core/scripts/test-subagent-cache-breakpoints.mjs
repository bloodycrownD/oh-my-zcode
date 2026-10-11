#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）#12 回归——subagent systemMessages 的缓存断点合并。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 P2 #12 + T 覆盖说明）
 * ============================================================================
 *
 * `SubagentContextBuilder.build()` 原先给**每一个** system 段各发一条 system message 并各带一个
 * `cache_control` 断点。Anthropic 的 prompt cache 断点额度有限，逐段标记会把额度耗尽，**对话末尾**
 * 的断点被 provider 丢弃——整段前缀缓存命中率下跌（只影响成本，因此长期无感）。修复把 system 段
 * 按「cli_prefix（稳定子代理身份前缀）」与「其余段」两组合并，断点因此落在**稳定前缀那一条**上。
 *
 * 同时钉住合并的边界归一（cr-func-1 M3）：fork 新增的 `## Magic Context` 段以 heading 起头（无前导
 * 换行），而它前面的 Subagent Environment 段以 `</env>`/model 行收尾（无尾随换行），直接
 * `join("")` 会粘成 `</env>## Magic Context`——markdown heading 不再是行首，排版回归。
 *
 * 运行：`npx tsx --test scripts/test-subagent-cache-breakpoints.mjs`
 */

import assert from "node:assert/strict";
import test from "node:test";

const { SubagentContextBuilder } = await import("../src/subagent/context-builder.ts");

const MAGIC_CONTEXT_SECTION =
  "## Magic Context\n\n会话里有 §1§ 这样的盖章分舱；没有 tool result 就不要编。\n";

function buildContext({ withMagicContext = true } = {}) {
  const builder = new SubagentContextBuilder({
    agentPrompt: "你是 Explore 子代理。",
    envInfo: { cwd: "D:/example/ws", platform: "win32", isGitRepo: false },
    ...(withMagicContext ? { magicContextSection: MAGIC_CONTEXT_SECTION } : {}),
  });
  return builder.build();
}

test("#12 systemMessages 合并成「稳定前缀 + 其余」两组，断点跟着组走而不是逐段", () => {
  const result = buildContext();
  const systemMessages = result.systemMessages;

  assert.equal(systemMessages.length <= 2, true, `期望 ≤2 条 system message，实际 ${systemMessages.length}`);
  // 合并前后内容不丢：所有 system 段正文都能在合并结果里找到。
  const merged = systemMessages.map((message) => message.content).join("");
  for (const section of result.sections) {
    if (section.injectionTarget !== "system") continue;
    assert.equal(
      merged.includes(section.content.trim()),
      true,
      `段 ${section.name} 的内容在合并后丢失`,
    );
  }
});

test("#12 每条 system message 都带 ephemeral 缓存断点，且第一组是稳定的 cli_prefix", () => {
  const result = buildContext();
  const systemMessages = result.systemMessages;
  assert.equal(systemMessages.length >= 1, true);
  for (const message of systemMessages) {
    assert.deepEqual(message.cacheControl, { type: "ephemeral" });
  }
  // 第一组必须是 cli_prefix：断点要落在**稳定**前缀上，否则缓存前缀每次都变。
  const cliPrefix = result.sections.find((section) => section.source === "cli_prefix");
  assert.ok(cliPrefix, "缺少 cli_prefix 段");
  assert.equal(
    systemMessages[0].content.startsWith(cliPrefix.content.trim()),
    true,
    "cli_prefix 必须在第一条 system message 的首部",
  );
});

test("#12 合并后相邻段边界有换行（不出现 `</env>## Magic Context` 粘连）", () => {
  const result = buildContext();
  const merged = result.systemMessages.map((message) => message.content).join("");

  // 段内容整体在场。
  assert.equal(merged.includes(MAGIC_CONTEXT_SECTION.trim()), true);
  // heading 必须落在行首：任何「非换行字符紧邻 `## Magic Context`」都是排版回归。
  assert.equal(/[^\n]## Magic Context/.test(merged), false, "heading 未落在行首（段边界粘连）");
  // Environment 段的收尾 `</env>` 之后不得同行紧跟别的段（下一个字符必须是换行或文末）。
  assert.equal(/<\/env>(?=[^\n])/.test(merged), false, "</env> 之后缺少段边界换行");
});

test("#12 无 magic-context 段时形态不变（单段组零操作）", () => {
  const result = buildContext({ withMagicContext: false });
  const systemMessages = result.systemMessages;
  assert.equal(systemMessages.length <= 2, true);
  assert.equal(
    systemMessages.every((message) => message.cacheControl?.type === "ephemeral"),
    true,
  );
  const merged = systemMessages.map((message) => message.content).join("");
  assert.equal(/[^\n]<\/env>[^\n]/.test(merged), false);
});
