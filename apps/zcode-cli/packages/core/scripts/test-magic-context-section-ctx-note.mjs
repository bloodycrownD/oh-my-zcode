#!/usr/bin/env node
/**
 * Step 18（bugfix-batch-20261011 / phase-mc-hook-closure / T-P2 宿主半边）：
 * `## Magic Context` 段文本的 ctx_note 引用在 host 装配层的最小适配（spec Step 18 / N2）。
 *
 * 背景：上游 211 行段真身（`@zcode/magic-context` 的 `core/agents/magic-context-prompt.ts`）
 * 无条件把 `ctx_note` 介绍成「待办托盘」工具；而 ctx_note 按 spec N2 终局不在 ZCode 工具
 * 注册面内（注册事实 = contracts 的四个 `CTX_*_TOOL_NAME` 常量 + 包侧
 * `ACTIVE_TOOL_IDS`）。该句不受任何 flag 控制，故 spec 裁定「host 装配处最小适配」：
 * `core/src/context/sections/magic-context.ts` 的 `buildMagicContextSectionEntry`（段文本
 * 进入 system prompt 的唯一漏斗）把托盘文案逐字替换为降级说明，**不改动包内逐字常量**。
 *
 * 本测试钉死五件事：
 *   A. **闭合（适配后）**：对 `buildMagicContextSection` 的 11 参矩阵（reduce × preset ×
 *      memory × dreamer × temporal × caveman × subagent 共 128 组合 + override 变体）
 *      逐组合断言——适配后剥掉降级句，段文本里 `ctx_*` 工具名 ⊆ 四个已注册名（ctx_note
 *      只允许出现在降级句内部：它在那里是被宣布缺席的名字，不再是可调用的工具）；
 *      primaryOverride 用户自选文案若无托盘句则原样穿过（不碰一个字节）。
 *   B. **闭合（适配前）**：同一矩阵的原始段文本 ⊆ 四个已注册 ∪ {ctx_note}——豁免集
 *      只有 ctx_note 一项（spec T-P2 口径；light 目录那一半由包侧
 *      `scripts/test-tool-name-closure.mjs` 直证）。
 *   C. **降级说明在场且诚实**：含「not available on this host」、指回已注册的
 *      `ctx_memory`；替换是逐字精确的（其余字节与原文只差托盘句那一段）。
 *   D. **subagent 分支不受影响**：上游 subagentMode 分支本就无 note 文案，适配必须
 *      逐字节恒等（证明适配不是无脑重写整段）。
 *   E. **OQ-PS 收口**（cr-fix-spec 波次⑤）：空串 / 纯空白归 null（空=不注入，而不是
 *      撞 heading 校验抛错）；非空但无 heading 仍然大声失败；undefined 归 null。
 *
 * 依赖已构建的 dist：`pnpm --filter @zcode/core build` 与
 * `pnpm --filter @zcode/magic-context build`（被测的包侧逐字模块经绝对路径取其 dist，
 * 见下方 `magicContextModule`；`@zcode/contracts` 经 resolve 钩子指到其 dist）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const MAGIC_CONTEXT_DIST = join(REPO_ROOT, "apps/zcode-cli/packages/magic-context/dist");

/**
 * workspace 包的 dist 兜底：`@zcode/contracts` 的裸 import 必须指到 contracts 的
 * dist，否则 node 会去解析 `.ts` 源码（与 `scripts/test-prompt-surface-tiering.mjs`
 * 同一范式）。`@zcode/shared` / `@zcode/model-option-map` 的 workspace 链接在 Node 下
 * 会解析到 `src/index.ts`，其内部 `./x.js` 说明符没有对应产物——同样指到各自 dist。
 * 被测的 core 代码走 `../dist/**`，magic-context 的两个逐字模块走
 * `MAGIC_CONTEXT_DIST` 绝对路径。
 *
 * 为何不走 `@zcode/magic-context` barrel：barrel 会拉起 mural 渲染链
 * （render-trigger → resolve-mural → memory barrel），那是 Step 15 并行节点的在飞
 * 面，与工具名闭合无关。本测试只取段文本与 light 目录两个逐字模块，链最短、与并行
 * 节点的落地节奏解耦。
 */
const PACKAGE_DIST_ENTRY = {
  "@zcode/contracts": `${REPO_ROOT}apps/zcode-cli/packages/contracts/dist/index.js`,
};
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

registerHooks({
  resolve(specifier, _context, nextResolve) {
    const entry = PACKAGE_DIST_ENTRY[specifier];
    if (entry !== undefined) {
      return { url: pathToFileURL(entry).href, shortCircuit: true };
    }
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
    return nextResolve(specifier);
  },
});

const magicContextModule = (rel) => {
  const p = join(MAGIC_CONTEXT_DIST, rel);
  if (!existsSync(p)) {
    throw new Error(`no compiled dist for ${rel} — run the @zcode/magic-context build first`);
  }
  return import(pathToFileURL(p).href);
};

const { buildMagicContextSectionEntry, MAGIC_CONTEXT_SECTION_HEADING } = await import(
  new URL("../dist/context/sections/magic-context.js", import.meta.url).href
);
const { MEMORY_MURAL_BLOCK, MEMORY_MURAL_GUIDANCE, SELF_TAG_GUIDANCE, buildMagicContextSection } =
  await magicContextModule("core/agents/magic-context-prompt.js");
const { ACTIVE_TOOL_IDS } = await magicContextModule("core/shared/prompt-surface-runtime.js");
const { CTX_EXPAND_TOOL_NAME, CTX_MEMORY_TOOL_NAME, CTX_REDUCE_TOOL_NAME, CTX_SEARCH_TOOL_NAME } =
  await import("@zcode/contracts");

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — ctx_note host degradation + empty-section null path (Step 18 / T-P2 host half)"
      : `TEST FAIL — ctx_note host degradation (exit code ${code})`,
  );
});

/** 注册事实：contracts 的四个工具名常量（D 组注册链的唯一名字来源）。 */
const REGISTERED = [
  CTX_REDUCE_TOOL_NAME,
  CTX_EXPAND_TOOL_NAME,
  CTX_SEARCH_TOOL_NAME,
  CTX_MEMORY_TOOL_NAME,
];

/** spec T-P2 豁免集：ctx_note（N2 终局不注册，文案惰性引用保留，host 层已降级）。 */
const EXEMPT = ["ctx_note"];

const CTX_TOOL_REFERENCE = /\b(ctx_[a-z]+)\b/g;

function extractToolNames(text) {
  return [...new Set([...text.matchAll(CTX_TOOL_REFERENCE)].map((m) => m[1]))];
}

/** 11 参矩阵：reduce × preset × memory × dreamer × temporal × caveman × subagent。 */
function sectionMatrix() {
  const combos = [];
  for (const ctxReduceCallable of [true, false]) {
    for (const preset of ["full", "light"]) {
      for (const memoryEnabled of [true, false]) {
        for (const dreamerEnabled of [true, false]) {
          for (const temporalAwarenessEnabled of [true, false]) {
            for (const cavemanTextCompressionEnabled of [true, false]) {
              for (const subagentMode of [true, false]) {
                combos.push({
                  label: `reduce=${ctxReduceCallable} preset=${preset} memory=${memoryEnabled} dreamer=${dreamerEnabled} temporal=${temporalAwarenessEnabled} caveman=${cavemanTextCompressionEnabled} subagent=${subagentMode}`,
                  args: [
                    null,
                    0,
                    ctxReduceCallable,
                    dreamerEnabled,
                    temporalAwarenessEnabled,
                    cavemanTextCompressionEnabled,
                    subagentMode,
                    undefined,
                    memoryEnabled,
                    preset,
                  ],
                });
              }
            }
          }
        }
      }
    }
  }
  return combos;
}

test("A/B/C/D: every matrix combo closes after adaptation and degrades ctx_note honestly", () => {
  for (const { label, args } of sectionMatrix()) {
    const raw = buildMagicContextSection(...args);
    assert.match(raw, /^## Magic Context/, label);

    // B（适配前闭合）：原始段文本 ⊆ 已注册 ∪ {ctx_note}；且豁免集被精确用尽——
    // 非 subagent 组合（上游 BASE_INTRO 家族）的 tray 文案无条件在场，subagent
    // 分支（上游 SUBAGENT_*_INTRO）本就不含 note 文案。
    const rawNames = extractToolNames(raw);
    assert.deepEqual(
      rawNames.filter((name) => !REGISTERED.includes(name) && !EXEMPT.includes(name)),
      [],
      `raw ${label}: ${JSON.stringify(rawNames)}`,
    );
    if (args[6] === true) {
      assert.equal(rawNames.includes("ctx_note"), false, `subagent raw ${label}`);
    } else {
      assert.deepEqual(
        rawNames.filter((name) => !REGISTERED.includes(name)),
        EXEMPT,
        `raw ${label}: ${JSON.stringify(rawNames)}`,
      );
    }

    const entry = buildMagicContextSectionEntry(raw);
    assert.ok(entry !== null, label);
    const adapted = entry.content;

    // D（subagent 分支逐字节恒等）：上游 subagentMode 分支没有 note 文案。
    if (args[6] === true) {
      assert.equal(adapted, raw, `subagent ${label} must pass through byte-identical`);
      continue;
    }

    // A（适配后闭合）：ctx_note 只允许出现在降级句内部（被宣布缺席的那个名字），
    // 剥掉降级句之后不得再有任何 ctx_note——即模型不会再把 ctx_note 当成可调工具。
    const DEGRADED =
      "`ctx_note` is not available on this host: keep work you intend to return to in your own reasoning for the rest of the turn, and pin anything that must survive beyond this session with `ctx_memory`";
    const adaptedNames = extractToolNames(adapted);
    assert.deepEqual(
      adaptedNames.filter((name) => !REGISTERED.includes(name)),
      EXEMPT,
      `adapted ${label}: ${JSON.stringify(adaptedNames)}`,
    );
    assert.ok(adapted.includes(DEGRADED), `degraded sentence missing for ${label}`);
    assert.equal(
      adapted.replaceAll(DEGRADED, "").includes("ctx_note"),
      false,
      `adapted ${label}: ctx_note outside the degraded sentence`,
    );
    const trayCount = [...raw.matchAll(/is the tray for work you intend to return to/g)].length;
    assert.equal(trayCount, 1, `exactly one tray sentence expected for ${label}`);
    assert.equal(adapted.includes(`${DEGRADED}${DEGRADED}`), false, label);
    const expected = raw.replaceAll(
      /`ctx_note` is the tray for work you intend to return to.*?(?:goes in the tray\.|goes there)/gs,
      DEGRADED,
    );
    assert.equal(adapted, expected, `adaptation must replace only the tray sentence for ${label}`);

    // 段契约不因适配而变。
    assert.equal(entry.name, "Magic Context");
    assert.equal(entry.source, "magic_context");
    assert.equal(entry.injectionTarget, "system");
    assert.equal(entry.cacheHint, "dynamic");
    assert.equal(entry.chars, adapted.length);
    assert.equal(entry.preview, adapted.slice(0, 100));
    assert.ok(entry.tokens > 0);
    // partner frame / desk 副本 / self-tag 规则都还在（适配没有顺手重写整段）。
    assert.match(adapted, /### You are the user's long-term partner on this project/, label);
    assert.ok(adapted.includes(SELF_TAG_GUIDANCE) || args[2] === false, label);
  }
});

test("A: a primaryOverride body passes through untouched when it names no ctx_note", () => {
  const override = "## Magic Context\n\nmy own desk copy\n";
  const raw = buildMagicContextSection(
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
    override,
  );
  const entry = buildMagicContextSectionEntry(raw);
  assert.equal(entry.content, raw);
  assert.deepEqual(
    extractToolNames(entry.content).filter((n) => !REGISTERED.includes(n)),
    [],
  );
});

test("A: a primaryOverride that quotes the upstream tray sentence is degraded too", () => {
  // 用户覆盖体不是法外之地：漏斗对 resolver 返回的一切字节一视同仁。
  const override = `${MAGIC_CONTEXT_SECTION_HEADING}\n\n\`ctx_note\` is the tray for work you intend to return to, with its findings attached; findings without an intention are not a note. When the user says "take a note", it always goes in the tray.\n`;
  const raw = buildMagicContextSection(
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
    override,
  );
  const entry = buildMagicContextSectionEntry(raw);
  // 剥掉降级句后不得再有 ctx_note（降级句本身会提到这个被宣布缺席的名字）。
  const DEGRADED =
    "`ctx_note` is not available on this host: keep work you intend to return to in your own reasoning for the rest of the turn, and pin anything that must survive beyond this session with `ctx_memory`";
  assert.ok(entry.content.includes(DEGRADED), "the override's tray sentence must be degraded too");
  assert.equal(entry.content.replaceAll(DEGRADED, "").includes("ctx_note"), false);
  // 原文里托盘句真的在场（证明这个用例测的是替换而不是空转）。
  assert.match(raw, /is the tray for work you intend to return to/);
});

test("A: the mural guidance constant (same prompt module) only names registered tools", () => {
  const names = extractToolNames(`${MEMORY_MURAL_GUIDANCE}\n${MEMORY_MURAL_BLOCK}`);
  assert.deepEqual(
    names.filter((name) => !REGISTERED.includes(name)),
    [],
    JSON.stringify(names),
  );
});

test("C: the degradation sentence names the registered alternative and the absence", () => {
  const raw = buildMagicContextSection(null, 0, true, false, false, false, false, undefined, true);
  const adapted = buildMagicContextSectionEntry(raw).content;
  assert.match(adapted, /ctx_note` is not available on this host/);
  assert.match(adapted, /pin anything that must survive beyond this session with `ctx_memory`/);
  // 原文的托盘隐喻必须真的没了（不是降级句追加在旁边）。
  assert.doesNotMatch(adapted, /is the tray for work you intend to return to/);
});

test("E: an empty or blank section is a null path, not a heading-check crash (OQ-PS)", () => {
  assert.equal(buildMagicContextSectionEntry(""), null);
  assert.equal(buildMagicContextSectionEntry("   \n\t "), null);
  assert.equal(buildMagicContextSectionEntry(undefined), null);
  // 非空但无 heading 仍然大声失败（A3 的回归护栏）。
  assert.throws(
    () => buildMagicContextSectionEntry("### Your desk\n\nno heading"),
    /## Magic Context/,
  );
});

test("two-sided truth: contracts names, package catalog and the section agree", () => {
  const full = buildMagicContextSection(null, 0, true, false, false, false, false, undefined, true);
  const taught = extractToolNames(full);
  for (const name of REGISTERED) {
    assert.equal(
      taught.includes(name),
      true,
      `${name} is registered but never taught by the section`,
    );
  }
  // 双侧真值：contracts 的注册名常量 == 包侧 ACTIVE_TOOL_IDS 目录（写死副本会在此漂移）。
  assert.deepEqual([...REGISTERED].sort(), [...ACTIVE_TOOL_IDS].sort());
  assert.deepEqual([...ACTIVE_TOOL_IDS].sort(), [
    "ctx_expand",
    "ctx_memory",
    "ctx_reduce",
    "ctx_search",
  ]);
  // 豁免集只有 ctx_note 一项，且原文真的引用了它（豁免非空转）。
  assert.deepEqual(EXEMPT, ["ctx_note"]);
  assert.equal(extractToolNames(full).includes("ctx_note"), true);
});
