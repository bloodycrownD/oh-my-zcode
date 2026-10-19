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
 *   5. 系统提示词禁律句（spec 变更点 14）：四个含盖章指引的变体各出现一次；no-reduce
 *      两变体不含（EN 侧同批只加这四个变体，中文孪生镜像）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// resolver 直驱（第 4 节）要 import 完整 dist transform，它传递依赖「入口发布原始
// TS 的 workspace 包」——与 test-model-live.mjs 同手法：这些包改指同布局 dist。
// 必须放在任何顶层 await import 之前。
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set([
  "@zcode/shared",
  "@zcode/model-option-map",
  "@zcode/provider",
  "@zcode/provider-node",
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

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

// ── 3b. 系统提示词禁律句（spec 变更点 14）─────────────────────────────────────
// 与 tags.message_role 四层防线配套的教育句：只落在含盖章指引的四个变体上。
// no-reduce 两变体没有 ctx_reduce 指引，出现该句即说明加错了变体。
// FORK（promptdoc/G-1+G-2）：禁用 matchAll（无 g 的 GUARD 调 matchAll 会抛 TypeError，
// 加 g 又与 assert.match 的 lastIndex 残留冲突），改用整句字面量 split 计数——「各出现
// 一次」才是真正锁死的断言；EN 四正两反复用同一 countOf，非中文会话的教育层不再只靠
// zh↔en 同源对比（那样两边同步丢失时仍绿）。
{
  const GUARD = /绝不给系统提示词段盖章——system（提示词）消息上的标签受保护、永不归档。/;
  const GUARD_TEXT = "绝不给系统提示词段盖章——system（提示词）消息上的标签受保护、永不归档。";
  const EN_GUARD_TEXT =
    "Never stamp a system prompt segment — tags on system (prompt) messages are protected and never archivable.";
  const countOf = (text, needle) => text.split(needle).length - 1;
  const guarded = [
    { subagentMode: false, preset: "full", label: "主档" },
    { subagentMode: false, preset: "light", label: "light 主档" },
    { subagentMode: true, preset: "full", label: "子代理档" },
    { subagentMode: true, preset: "light", label: "子代理 light" },
  ];
  for (const { subagentMode, preset, label } of guarded) {
    const zh = buildMagicContextSectionZhCn(
      null,
      0,
      true,
      false,
      false,
      false,
      subagentMode,
      "zh-CN",
      true,
      preset,
      undefined,
    );
    assert.equal(countOf(zh, GUARD_TEXT), 1, `zh ${label}必须恰好出现一次系统提示词禁律句`);
  }
  for (const preset of ["full", "light"]) {
    const noReduce = buildMagicContextSectionZhCn(
      null,
      0,
      false,
      false,
      false,
      false,
      false,
      "zh-CN",
      true,
      preset,
      undefined,
    );
    assert.equal(countOf(noReduce, GUARD_TEXT), 0, `zh no-reduce（${preset}）不得含禁律句`);
    assert.doesNotMatch(noReduce, GUARD, `zh no-reduce（${preset}）不得含禁律句`);
  }
  // EN 侧同批四变体：禁句在源文件中逐字相同，出现次数同样是 1；no-reduce 为 0。
  for (const { subagentMode, preset, label } of guarded) {
    const en = buildMagicContextSection(
      null,
      0,
      true,
      false,
      false,
      false,
      subagentMode,
      undefined,
      true,
      preset,
      undefined,
    );
    assert.equal(countOf(en, EN_GUARD_TEXT), 1, `en ${label} must carry the guard exactly once`);
  }
  for (const preset of ["full", "light"]) {
    const enNoReduce = buildMagicContextSection(
      null,
      0,
      false,
      false,
      false,
      false,
      false,
      undefined,
      true,
      preset,
      undefined,
    );
    assert.equal(
      countOf(enNoReduce, EN_GUARD_TEXT),
      0,
      `en no-reduce (${preset}) must not carry the guard`,
    );
  }
}

// ── 4. resolver 选路（真装配路径 + 字节级 golden 对比）────────────────────────
// CR P2-3：选路点在 createMagicContextPromptSectionResolver 的三元
// （isChinesePromptLanguage ? zh 孪生 : 上游）。三元写反/传错 builder 只有靠真驱动
// resolver 才能发现——直接调 builder 测不到这一层。golden = 同 11 参直调对应 builder，
// 逐字节相等证明「选路正确 + 装配参数零漂移」。
const { createMagicContextPromptSectionResolver } =
  await import("../dist/app/magic-context-turn-transform.js");
const resolver = createMagicContextPromptSectionResolver({ configDomain: {} });
const resolverInput = (language) => ({
  ctxReduceCallable: true,
  subagentMode: false,
  language,
  modelKey: "zcode/glm-4.6",
});

{
  const viaResolver = resolver(resolverInput("zh-CN"));
  const golden = buildMagicContextSectionZhCn(
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
    undefined,
  );
  assert.equal(viaResolver, golden, "zh-CN 经 resolver 必须与 zh 孪生直调逐字节一致");
  assert.match(viaResolver, /你的桌面/);
}
for (const language of ["zh", "zh-TW"]) {
  assert.match(
    resolver(resolverInput(language)),
    /你的桌面/,
    `zh 变体域（${language}）必须路由到 zh 孪生`,
  );
}
for (const language of [undefined, "en-US"]) {
  const viaResolver = resolver(resolverInput(language));
  const golden = buildMagicContextSection(
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
  assert.equal(viaResolver, golden, `en/缺席（${language}）经 resolver 必须与上游直调逐字节一致`);
  assert.ok(!/你的桌面/.test(viaResolver), `en 路径不得出现中文（${language}）`);
}

console.log(
  "TEST PASS — magic-context-section-zh (16-case matrix + resolver routing + prompt guard)",
);
