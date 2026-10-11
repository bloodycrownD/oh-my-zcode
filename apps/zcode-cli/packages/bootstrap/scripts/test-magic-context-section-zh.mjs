/**
 * FORK（用户裁定 2026-10-11）：magic-context 段中文孪生测试。
 *
 * 面向 bootstrap/scripts 侧（registerHooks 把 workspace TS 改指 dist，不桩被测代码）：
 *   1. 结构矩阵：zh builder 与上游 en builder 的 5 个返回分支一一对应——
 *      subagentMode×preset、ctxReduceCallable×preset、primaryOverride——zh 输出
 *      以 `## Magic Context` 开头（core 漏斗 heading 校验依据）。
 *   2. 协议记号保持原字节：§N§、ctx_reduce/ctx_expand/ctx_search/ctx_memory、
 *      <session-history> 等标记、`## start-end · date · title`、[dropped §N§]。
 *   3. 工具闭合（T-P2 的 zh 面）：zh 输出引用的 ctx_* ⊆ 四个注册工具；
 *      不出现 ctx_note（zh 以降级语义直接撰写，见孪生头注④）。
 *   4. resolver 选路：language=zh-CN → zh 文案；en-US/undefined → 上游英文实现
 *      （对同一 11 参做字节级对比，证明英文路径零改动）。
 */

import assert from "node:assert/strict";

// 本测试的两个被测入口都走包 exports/相对 dist 解析（@zcode/magic-context 有 dist
// exports；zh 孪生经 ../dist/ 相对路径），不需要 test-model-live 的 TS→dist resolve 钩子。
const { buildMagicContextSection } = await import("@zcode/magic-context");
const { buildMagicContextSectionZhCn } =
  await import("../dist/app/magic-context-prompt-section-zh-cn.js");

// ── 1. 结构矩阵 + 2/3. 记号与闭合 ────────────────────────────────────────────

const REGISTERED = new Set(["ctx_reduce", "ctx_expand", "ctx_search", "ctx_memory"]);
const PROTOCOL_TOKENS = [
  /§N§/,
  /`ctx_reduce`/,
  /`ctx_expand\(tag=N\)`/,
  /`<session-history>`/,
  /`## start-end · date · title`/,
  /`\[dropped §N§\]`/,
];

function extractCtxToolNames(text) {
  return [...new Set(text.match(/\bctx_[a-z]+/g) ?? [])];
}

const matrix = [];
for (const subagentMode of [false, true]) {
  for (const ctxReduceCallable of [true, false]) {
    for (const preset of ["full", "light"]) {
      matrix.push({ subagentMode, ctxReduceCallable, preset, memoryEnabled: true });
      matrix.push({ subagentMode, ctxReduceCallable, preset, memoryEnabled: false });
    }
  }
}

let cases = 0;
for (const { subagentMode, ctxReduceCallable, preset, memoryEnabled } of matrix) {
  const zh = buildMagicContextSectionZhCn(
    null,
    0,
    ctxReduceCallable,
    false,
    false,
    false,
    subagentMode,
    "zh-CN",
    memoryEnabled,
    preset,
    undefined,
  );
  cases++;
  assert.ok(
    zh.startsWith("## Magic Context"),
    `zh 段必须以注册标题开头（${preset}/${subagentMode}）`,
  );
  if (subagentMode) {
    // 子代理段是精简面：无桌面全量文案，但必须带 §N§ 把手语义。
    assert.match(zh, /§N§/, `zh 子代理段必须含标签语义（${preset}）`);
    assert.doesNotMatch(zh, /公告板/, `zh 子代理段不得含记忆面文案（${preset}）`);
  } else {
    assert.match(zh, /你的桌面/, `zh 段必须含中文桌面文案（${preset}）`);
  }
  // 闭合与包侧 T-P2 同口径：豁免集只含 ctx_note，且豁免必须非空转——豁免成立的
  // 前提是降级句（「在本宿主未注册…用 ctx_memory 钉住」）在场；没有降级句却出现
  // ctx_note 即为引入幽灵工具介绍，变红。
  const degradedPresent = /`ctx_note` 在本宿主未注册[^\n]*`ctx_memory`/.test(zh);
  const allowed = degradedPresent ? new Set([...REGISTERED, "ctx_note"]) : REGISTERED;
  const ghost = extractCtxToolNames(zh).filter((name) => !allowed.has(name));
  assert.deepEqual(ghost, [], `zh 段不得引用未注册工具（${preset}/${subagentMode}）：${ghost}`);
  if (zh.includes("ctx_note")) {
    assert.ok(degradedPresent, `ctx_note 只能以降级语义出现（${preset}/${subagentMode}）`);
  }
  for (const token of PROTOCOL_TOKENS) {
    if (subagentMode) break; // 子代理段是精简面，不逐 token 断言
    // §N§/ctx_reduce/ctx_expand(tag=N) 只属于 reduce 可用变体（no-reduce 会话没有
    // 标签前缀，上游 EN 同语义——BASE_INTRO_NO_REDUCE 全文无 §N§）。
    // 注意用 token.source 字符串判（regex source 里的 \( 带转义符，正则互测会失配）。
    const src = token.source;
    const reduceOnly = src.includes("§N§") || src.includes("ctx_reduce") || src.includes("tag=N");
    if (!reduceOnly || ctxReduceCallable) {
      assert.match(zh, token, `zh 段必须保留协议记号 ${token}（${preset}）`);
    }
  }
}
assert.ok(cases === 16, `矩阵应有 16 组，实际 ${cases}`);

// 子代理分支：含 §N§ 规则与 zh 版 SELF_TAG 指引，不含桌面全量文案。
{
  const zh = buildMagicContextSectionZhCn(
    null,
    0,
    true,
    false,
    false,
    false,
    true,
    "zh-CN",
    true,
    "full",
    undefined,
  );
  assert.match(zh, /每条回复的文本以恰好 §N§ 加一个空格开头/);
  assert.doesNotMatch(zh, /公告板/);
}
// primaryOverride：用户覆盖文本原样在前，运行时子句跟后。
{
  const zh = buildMagicContextSectionZhCn(
    null,
    0,
    true,
    false,
    false,
    false,
    false,
    "zh-CN",
    true,
    "full",
    "用户自定义覆盖段",
  );
  assert.ok(zh.startsWith("用户自定义覆盖段"));
  assert.ok(zh.includes("除非用户明确要求其他语言"), "zh 语言指令应跟随 override 段");
}

// ── 4. resolver 选路（英文路径字节级不变）────────────────────────────────────

for (const language of [undefined, "en-US", "zh", "zh-CN"]) {
  const en = buildMagicContextSection(
    null,
    0,
    true,
    false,
    false,
    false,
    false,
    language,
    true,
    "full",
    undefined,
  );
  const zh = buildMagicContextSectionZhCn(
    null,
    0,
    true,
    false,
    false,
    false,
    false,
    language,
    true,
    "full",
    undefined,
  );
  if (language === undefined || language === "en-US") {
    assert.ok(!/你的桌面/.test(en), `en 路径不得出现中文（${language}）`);
  } else {
    assert.ok(/你的桌面/.test(zh), `zh 路径必须是中文桌面（${language}）`);
    assert.ok(en !== zh, `zh/en 必须是两份文本（${language}）`);
  }
}

console.log("TEST PASS — magic-context-section-zh (16-case matrix + resolver routing)");
