#!/usr/bin/env node
/**
 * Step 12 / T-MC3 + Step 18 前哨（bugfix-batch-20261011 / phase-mc-prompt-surface）：
 * prompt-surface 真身（D6 壳缝①）+ 211 行段真身（D1 壳缝①）+ D7 落位的行为测试。
 *
 * 覆盖四组断言：
 *   ① preset 换挡：`resolvePromptSurface` 的 exact / bare / wildcard / provider 别名
 *      canonical-first / 坏 key 落 default 五条路径，以及 `promptSurfaceConfigIdentity`
 *      的键序稳定与「换 preset 必换身份」。
 *   ② registration 分档：full 档回 full 描述、light 档回 compact 描述、用户
 *      `tool_descriptions` 覆盖压过两者、未知 id 只告警不回退（不偷偷改描述）。
 *   ③ guidance 覆盖读取：`## Magic Context` marker 必须恰好一个；空 / 多个 / 不可读
 *      一律回落内建 guidance 且**每条只告警一次**（共享告警去重是设计而非遗漏）。
 *   ④ 211 行段装配（Step 13 的前置直证）：`buildMagicContextSection` 11 参各自的
 *      开关真的改变段文本——memoryEnabled 关掉 MEMORY_GUIDANCE、light 档换掉 desk 副本、
 *      subagentMode 只留 §N§ 机制、primaryOverride 拥有整段但保留 language 尾句。
 *   ⑤ **工具名闭合直证**（Step 18 的 regex 检查不在本节点，这里先钉住轻量版）：
 *      `ACTIVE_TOOL_IDS` 与 `LIGHT_TOOL_DESCRIPTIONS` 的键集合逐一相等，且四名与
 *      ZCode 工具注册面（ZCODE_CTX_TOOL_IDS，硬编码的对照表）一致——漏一条常量或漏
 *      一个 light 描述都会在这里红。
 *
 * 运行：`node scripts/test-prompt-surface.mjs`（先 `pnpm build`，读 `dist/`）。
 * 隔离：本测试不开库；guidance 覆盖走 `userConfigDirectory` 注入缝指临时目录，
 * 不碰真实 `~/.omz`。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ACTIVE_TOOL_IDS,
  LIGHT_TOOL_DESCRIPTIONS,
  buildMagicContextSection,
  createPromptSurfaceGuidanceEpochCache,
  createPromptSurfaceRuntime,
  isValidPromptSurfaceModelKey,
  promptSurfaceConfigIdentity,
  promptSurfaceHashMaterial,
  resolvePromptSurface,
} from "../dist/index.js";

/**
 * ZCode D 组工具注册面对照表（core/src/tool/handlers/index.ts 的 builtInTools 里四个
 * ctx_* 工具名，来自 @zcode/contracts 的名字常量）。写死在这里是**故意的**：它是被测面
 * 的外部事实，测试必须有一条独立于被测代码的副本，否则「常量与自身比对」永远是绿。
 */
const ZCODE_CTX_TOOL_IDS = ["ctx_reduce", "ctx_expand", "ctx_search", "ctx_memory"];

let passed = 0;
let failed = 0;

const it = (name, fn) =>
  test(name, async (t) => {
    try {
      await fn(t);
      passed += 1;
    } catch (error) {
      failed += 1;
      throw error;
    }
  });

process.on("exit", () => {
  const total = passed + failed;
  console.log("");
  if (failed === 0) {
    console.log(`TEST PASS — ${total}/${total} prompt-surface tests (D6 + D1 + D7)`);
  } else {
    console.log(`TEST FAIL — ${failed}/${total} prompt-surface tests failed`);
  }
});

// ── ① preset 换挡 ────────────────────────────────────────────────────────────

it("missing config resolves to the full preset and reports a default resolution", () => {
  const resolved = resolvePromptSurface(undefined, "anthropic/claude-sonnet-4-5");
  assert.deepEqual(resolved, { preset: "full", source: "default" });
});

it("exact provider/model beats bare, bare beats wildcard, wildcard beats default", () => {
  const config = {
    default: "full",
    models: {
      "zhipu/glm-4.6": "light",
      "glm-4.6": "full",
      "zhipu/*": "light",
    },
  };
  // exact wins over bare for the same specificity tier.
  assert.equal(resolvePromptSurface(config, "zhipu/glm-4.6").preset, "light");
  assert.equal(resolvePromptSurface(config, "zhipu/glm-4.6").source, "exact");
  // a different model on the same provider falls to the wildcard.
  assert.equal(resolvePromptSurface(config, "zhipu/glm-4.5").preset, "light");
  assert.equal(resolvePromptSurface(config, "zhipu/glm-4.5").source, "wildcard");
  // an unlisted provider falls all the way to the default.
  assert.equal(resolvePromptSurface(config, "openai/gpt-5").preset, "full");
  assert.equal(resolvePromptSurface(config, "openai/gpt-5").source, "default");
});

it("a date-suffixed model walks down to its base key (progressive specificity)", () => {
  const config = { models: { "glm-4": "light" } };
  assert.equal(resolvePromptSurface(config, "zhipu/glm-4-20260101").preset, "light");
  assert.equal(resolvePromptSurface(config, "zhipu/glm-4-20260101").source, "bare");
});

it("unknown and malformed model keys never partially match; they use the default", () => {
  const config = { default: "light", models: { "glm-4": "full" } };
  for (const badKey of [undefined, "", "noslash", "/model", "provider/"]) {
    const resolved = resolvePromptSurface(config, badKey);
    assert.equal(resolved.preset, "light", `key ${JSON.stringify(badKey)} must fall to default`);
    assert.equal(resolved.source, "default");
  }
});

it("isValidPromptSurfaceModelKey rejects the shapes that could never match", () => {
  assert.equal(isValidPromptSurfaceModelKey("glm-4"), true);
  assert.equal(isValidPromptSurfaceModelKey("zhipu/glm-4"), true);
  assert.equal(isValidPromptSurfaceModelKey("zhipu/*"), true);
  // a model id may contain extra slashes.
  assert.equal(isValidPromptSurfaceModelKey("zhipu/org/glm-4"), true);
  assert.equal(isValidPromptSurfaceModelKey(""), false);
  assert.equal(isValidPromptSurfaceModelKey(" glm"), false);
  assert.equal(isValidPromptSurfaceModelKey("gl*m"), false);
  assert.equal(isValidPromptSurfaceModelKey("/glm"), false);
  assert.equal(isValidPromptSurfaceModelKey("zhipu/"), false);
  assert.equal(isValidPromptSurfaceModelKey("zhipu//glm"), false);
  assert.equal(isValidPromptSurfaceModelKey("zhipu/gl*m"), false);
});

it("promptSurfaceConfigIdentity is key-order stable and preset-sensitive", () => {
  const a = promptSurfaceConfigIdentity({
    models: { b: "light", a: "full" },
    tool_descriptions: { ctx_search: "x", ctx_reduce: "y" },
  });
  const b = promptSurfaceConfigIdentity({
    tool_descriptions: { ctx_reduce: "y", ctx_search: "x" },
    models: { a: "full", b: "light" },
  });
  assert.equal(a, b, "declaration order must not change the identity");
  const c = promptSurfaceConfigIdentity({
    models: { b: "light", a: "full" },
    default: "light",
    tool_descriptions: { ctx_search: "x", ctx_reduce: "y" },
  });
  assert.notEqual(a, c, "flipping the default must change the identity");
});

it("promptSurfaceHashMaterial keeps the full preset byte-identical and tags other presets", () => {
  assert.equal(promptSurfaceHashMaterial("body"), "body");
  assert.equal(promptSurfaceHashMaterial("body", "full"), "body");
  assert.notEqual(promptSurfaceHashMaterial("body", "light"), "body");
  assert.match(promptSurfaceHashMaterial("body", "light"), /magic-context-prompt-surface:light/);
});

// ── ② registration 分档 ──────────────────────────────────────────────────────

/** Full-preset descriptions are the caller's; the runtime only decides which one wins. */
const FULL_DESCRIPTIONS = {
  ctx_reduce: "FULL reduce",
  ctx_expand: "FULL expand",
  ctx_search: "FULL search",
  ctx_memory: "FULL memory",
};

function runtimeFor(dir) {
  const warnings = [];
  const runtime = createPromptSurfaceRuntime({
    userConfigDirectory: dir,
    warn: (message) => warnings.push(message),
  });
  return { runtime, warnings };
}

it("full preset passes every description through untouched", () => {
  const { runtime, warnings } = runtimeFor(undefined);
  const registration = runtime.resolveRegistration({}, "zhipu/glm-4.6");
  assert.equal(registration.preset, "full");
  for (const [toolId, full] of Object.entries(FULL_DESCRIPTIONS)) {
    assert.equal(registration.descriptionFor(toolId, full), full);
  }
  assert.deepEqual(warnings, []);
});

it("light preset swaps in the compact catalog", () => {
  const { runtime } = runtimeFor(undefined);
  const registration = runtime.resolveRegistration({ default: "light" });
  assert.equal(registration.preset, "light");
  for (const [toolId, full] of Object.entries(FULL_DESCRIPTIONS)) {
    assert.equal(registration.descriptionFor(toolId, full), LIGHT_TOOL_DESCRIPTIONS[toolId]);
    assert.notEqual(registration.descriptionFor(toolId, full), full);
  }
});

it("a user tool_descriptions override outranks both catalogs", () => {
  const { runtime, warnings } = runtimeFor(undefined);
  const registration = runtime.resolveRegistration({
    default: "light",
    tool_descriptions: { ctx_search: "MINE" },
  });
  assert.equal(registration.descriptionFor("ctx_search", "FULL search"), "MINE");
  // untouched ids keep the preset catalog, not the full one.
  assert.equal(
    registration.descriptionFor("ctx_reduce", "FULL reduce"),
    LIGHT_TOOL_DESCRIPTIONS.ctx_reduce,
  );
  // blank overrides are ignored rather than served.
  const blank = runtime.resolveRegistration({
    default: "full",
    tool_descriptions: { ctx_reduce: "   " },
  });
  assert.equal(blank.descriptionFor("ctx_reduce", "FULL reduce"), "FULL reduce");
  assert.deepEqual(warnings, [
    "prompt_surface.tool_descriptions.ctx_reduce is empty; the override was ignored.",
  ]);
});

it("an unknown ctx_* id is warned about once and never has its description rewritten", () => {
  const { runtime, warnings } = runtimeFor(undefined);
  const registration = runtime.resolveRegistration({
    default: "light",
    tool_descriptions: { ctx_note: "from a tool this fork does not register" },
  });
  assert.equal(registration.descriptionFor("ctx_note", "FULL note"), "FULL note");
  registration.descriptionFor("ctx_note", "FULL note");
  assert.deepEqual(warnings, [
    "prompt_surface.tool_descriptions.ctx_note is not a known ctx_* tool ID; the override was ignored.",
  ]);
});

// ── ③ guidance 覆盖读取 ──────────────────────────────────────────────────────

it("a guidance override with exactly one marker replaces the built-in section", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-prompt-surface-"));
  try {
    writeFileSync(join(dir, "guidance.md"), "# mine\n\n## Magic Context\n\nmy desk\n", "utf8");
    const { runtime, warnings } = runtimeFor(dir);
    const selection = runtime.resolveGuidance(
      { guidance_override_path: "guidance.md" },
      "zhipu/glm-4.6",
    );
    assert.equal(selection.preset, "full");
    assert.match(selection.primaryOverride ?? "", /my desk/);
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("guidance overrides that cannot own the section fall back and say so once", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-prompt-surface-"));
  try {
    writeFileSync(join(dir, "two.md"), "## Magic Context\n\n## Magic Context\n", "utf8");
    writeFileSync(join(dir, "empty.md"), "   \n", "utf8");
    mkdirSync(join(dir, "a-directory.md"));
    const { runtime, warnings } = runtimeFor(dir);
    // two markers
    assert.equal(
      runtime.resolveGuidance({ guidance_override_path: "two.md" }).primaryOverride,
      undefined,
    );
    // blank
    assert.equal(
      runtime.resolveGuidance({ guidance_override_path: "empty.md" }).primaryOverride,
      undefined,
    );
    // path is a directory, not a file
    assert.equal(
      runtime.resolveGuidance({ guidance_override_path: "a-directory.md" }).primaryOverride,
      undefined,
    );
    // missing file
    assert.equal(
      runtime.resolveGuidance({ guidance_override_path: "absent.md" }).primaryOverride,
      undefined,
    );
    assert.equal(warnings.length, 4, "one warning per bad override, not per call");
    runtime.resolveGuidance({ guidance_override_path: "two.md" });
    assert.equal(warnings.length, 4, "repeat resolutions are de-duplicated");
    assert.match(warnings[0], /exactly one "## Magic Context" section marker; found 2/);
    assert.match(warnings[1], /is empty/);
    assert.match(warnings[2], /is not a file/);
    assert.match(warnings[3], /could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the guidance epoch cache freezes one selection per (session, config, model key)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-prompt-surface-"));
  try {
    writeFileSync(join(dir, "guidance.md"), "## Magic Context\n\nepoch\n", "utf8");
    const { runtime } = runtimeFor(dir);
    const epochs = createPromptSurfaceGuidanceEpochCache(runtime);
    const config = { guidance_override_path: "guidance.md" };
    const first = epochs.resolve("s1", config, "zhipu/glm-4.6");
    assert.equal(epochs.resolve("s1", config, "zhipu/glm-4.6"), first);
    // a different canonical model key is a new epoch.
    assert.notEqual(epochs.resolve("s1", config, "zhipu/glm-4.5"), first);
    epochs.clear("s1");
    assert.notEqual(epochs.resolve("s1", config, "zhipu/glm-4.6"), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ④ 211 行段装配 ───────────────────────────────────────────────────────────

it("the section always carries the ## Magic Context heading and the partner frame", () => {
  const section = buildMagicContextSection(null, 0, true);
  assert.match(section, /^## Magic Context\n\n/);
  assert.match(section, /### You are the user's long-term partner on this project/);
  assert.match(section, /reduction prompts are routine housekeeping/i);
});

it("memoryEnabled=false drops the memory guidance but keeps ctx_search", () => {
  const on = buildMagicContextSection(null, 0, true, false, false, false, false, undefined, true);
  const off = buildMagicContextSection(null, 0, true, false, false, false, false, undefined, false);
  assert.match(on, /`<project-memory>` is the pinboard/);
  assert.match(on, /`ctx_memory` pins a new one/);
  assert.doesNotMatch(off, /`<project-memory>` is the pinboard/);
  assert.doesNotMatch(off, /`ctx_memory` pins a new one/);
  // ctx_search guidance is independent of the memory switch (Step 13 rationale).
  assert.match(off, /`ctx_search` searches the archive/);
});

it("preset=light swaps the desk copy for the compact one", () => {
  const full = buildMagicContextSection(
    null,
    0,
    true,
    false,
    false,
    false,
    false,
    undefined,
    true,
    "full",
  );
  const light = buildMagicContextSection(
    null,
    0,
    true,
    false,
    false,
    false,
    false,
    undefined,
    true,
    "light",
  );
  assert.notEqual(full, light);
  assert.match(full, /Think of your context as a desk\. Every message and every tool output/);
  assert.match(
    light,
    /Your context is a desk\. Every message and tool output lands on it with a §N§ tag/,
  );
  // both presets still teach the self-tag rule for reduce-callable sessions.
  assert.match(full, /Start the text of each reply with exactly §N§/);
  assert.match(light, /Start the text of each reply with exactly §N§/);
});

it("ctxReduceCallable=false drops the stamping taxonomy and the self-tag rule", () => {
  const noReduce = buildMagicContextSection(null, 0, false);
  assert.doesNotMatch(noReduce, /`ctx_reduce` with its tag/);
  assert.doesNotMatch(noReduce, /Start the text of each reply with exactly §N§/);
  // the archive / filing / search half survives.
  assert.match(noReduce, /`ctx_expand\(message=N\)` brings it back whole/);
  assert.match(noReduce, /Context is managed for you entirely automatically/);
});

it("subagentMode reduces the section to the tag mechanics only", () => {
  const sub = buildMagicContextSection(null, 0, true, false, false, false, true);
  assert.match(sub, /^## Magic Context\n\nYour context is a desk\./);
  assert.match(sub, /never blanket-stamp a range like "1-50"/);
  assert.doesNotMatch(sub, /long-term partner/);
  assert.doesNotMatch(sub, /`<project-memory>` is the pinboard/);
  const subLight = buildMagicContextSection(
    null,
    0,
    true,
    false,
    false,
    false,
    true,
    undefined,
    true,
    "light",
  );
  assert.notEqual(sub, subLight);
  assert.match(subLight, /stamp it with `ctx_reduce`/);
});

it("a primaryOverride owns the section body while composer-owned clauses stay", () => {
  const withOverride = buildMagicContextSection(
    null,
    0,
    true,
    false,
    false,
    false,
    false,
    "tr",
    true,
    "full",
    "## Magic Context\n\nuser copy\n",
  );
  assert.match(withOverride, /user copy/);
  // the language directive is appended by the composer, not by the override.
  assert.match(withOverride, /Use Turkish \(Türkçe\) for your natural-language replies/);
  // none of the built-in desk copy survives.
  assert.doesNotMatch(withOverride, /Think of your context as a desk/);
  assert.doesNotMatch(withOverride, /Start the text of each reply with exactly §N§/);
});

it("language unset emits no directive; a bad code emits none either", () => {
  assert.doesNotMatch(buildMagicContextSection(null, 0), /natural-language replies/);
  assert.doesNotMatch(
    buildMagicContextSection(null, 0, true, false, false, false, false, "zzz"),
    /natural-language replies/,
  );
});

it("caveman and temporal arms are off by default and change the text when on", () => {
  const base = buildMagicContextSection(null, 0);
  const caveman = buildMagicContextSection(null, 0, true, false, false, true);
  assert.match(caveman, /BEWARE\*\*: History compression is on/);
  assert.doesNotMatch(base, /BEWARE/);
  const temporal = buildMagicContextSection(null, 0, true, false, true);
  assert.match(temporal, /<!-- \+Xm -->/);
  assert.doesNotMatch(base, /<!-- \+Xm -->/);
  // dreamer is N3: the fork passes false, and its note clause must stay absent then.
  // Proving the clause is gated (rather than simply never written) keeps the arm honest.
  assert.doesNotMatch(buildMagicContextSection(null, 0), /surface_condition/);
  assert.match(buildMagicContextSection(null, 0, true, true), /surface_condition/);
});

// ── ⑤ 工具名闭合直证（Step 18 前哨） ─────────────────────────────────────────

it("ACTIVE_TOOL_IDS, LIGHT_TOOL_DESCRIPTIONS and the ZCode registration agree", () => {
  assert.deepEqual([...ACTIVE_TOOL_IDS].sort(), [...ZCODE_CTX_TOOL_IDS].sort());
  assert.deepEqual(Object.keys(LIGHT_TOOL_DESCRIPTIONS).sort(), [...ACTIVE_TOOL_IDS].sort());
});

it("every light description is real compact prose, not a stub", () => {
  const descriptions = Object.values(LIGHT_TOOL_DESCRIPTIONS);
  assert.equal(new Set(descriptions).size, descriptions.length, "descriptions must be distinct");
  for (const [toolId, description] of Object.entries(LIGHT_TOOL_DESCRIPTIONS)) {
    assert.ok(description.length > 120, `${toolId} light description looks truncated`);
  }
});

it("light-description tool references close against the ZCode tool surface (T-P2 prelude)", () => {
  // Step 18 runs the same closure check over the 211 行段 text. This is the light-catalog
  // half, done here because Step 12 is where the catalog lands: a light description that
  // names a tool ZCode never registers sends the model hunting for a missing tool.
  const referenced = new Set();
  for (const description of Object.values(LIGHT_TOOL_DESCRIPTIONS)) {
    for (const match of description.matchAll(/\b(ctx_[a-z]+)\b/g)) referenced.add(match[1]);
  }
  const unknown = [...referenced].filter((id) => !ACTIVE_TOOL_IDS.includes(id));
  // `ctx_note` is the single registered exemption (spec N2: tool not ported, references kept
  // verbatim). Step 18 owes the same decision for the 211 行段's CTX_NOTE_GUIDANCE.
  assert.deepEqual(unknown, ["ctx_note"], JSON.stringify({ referenced: [...referenced], unknown }));
  const ctxMemory = LIGHT_TOOL_DESCRIPTIONS.ctx_memory;
  assert.match(
    ctxMemory,
    /ctx_note/,
    "the ctx_note reference must be visible, not silently edited",
  );
});

it("ctx_note is not part of the fork surface (N2 terminal decision)", () => {
  assert.equal(ACTIVE_TOOL_IDS.includes("ctx_note"), false);
  assert.equal("ctx_note" in LIGHT_TOOL_DESCRIPTIONS, false);
});
