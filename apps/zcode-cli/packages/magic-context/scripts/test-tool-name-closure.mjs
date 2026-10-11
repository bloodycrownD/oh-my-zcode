#!/usr/bin/env node
/**
 * Step 18 / T-P2（bugfix-batch-20261011 / phase-mc-hook-closure）：
 * 211 行段文本与 light-descriptions 目录的**工具名闭合**断言（r1 P0-2 口径）。
 *
 * 断言的命题（spec Step 18 原文）：「从段文本正则提取工具名集合，断言 ⊆
 * {ctx_reduce, ctx_expand, ctx_search, ctx_memory} ∪ 登记豁免集」。
 *
 * 覆盖两组被测面：
 *   ① **211 行段文本**：`buildMagicContextSection` 的 11 参矩阵（ctxReduceCallable ×
 *      preset × memoryEnabled × dreamer × temporal × caveman × subagent = 128 组合）
 *      逐个装配后 regex 提取 `\bctx_[a-z]+\b`；
 *   ② **同模块导出常量**：`MEMORY_MURAL_GUIDANCE` / `MEMORY_MURAL_BLOCK`
 *      （inject-compartments 注入 `<memory-mural>` 的那段指导，同属本逐字模块）与
 *      `LIGHT_TOOL_DESCRIPTIONS` 目录（键 + 值两向）。
 *
 * 豁免集**写死**为 `["ctx_note"]`：ctx_note 按 spec N2 终局不注册（ZCode D 组工具面
 * 只有四条），而上游把 note 当 memory 的分流判据写进了 prose（211 行段
 * `CTX_NOTE_GUIDANCE` / light 变体 + `CTX_MEMORY_LIGHT_DESCRIPTION` 末句）——逐字
 * 移植区不剪辑 prose，引用作为**惰性**边界保留，host 装配层的降级适配在 core 侧
 * （`core/src/context/sections/magic-context.ts`，core 测试直证）。豁免集长大
 * （任何 ctx_note 之外的新工具名出现在文案里）本断言即红。
 *
 * 强度自证（防「断言永不红」）：对含假名 `ctx_ghost` 的合成文本跑同一条闭合谓词，
 * 断言它**失败**——证明这套 regex + 豁免真的会咬人，而不是恒真。
 *
 * 运行：`node scripts/test-tool-name-closure.mjs`（先 `pnpm build`，读 `dist/`）。
 * 隔离：本测试不开库、不碰文件系统。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * 直取内部 dist 模块而不是包 barrel：barrel 会拉起 mural 渲染链
 * （render-trigger → resolve-mural → memory barrel），那是 Step 15 并行节点的在飞面，
 * 与工具名闭合无关。本测试只取段文本与 light 目录两个逐字模块，链最短、与并行节点的
 * 落地节奏解耦。barrel 导出面由 `test-prompt-surface.mjs`（Step 12）覆盖。
 */
const loadDist = (rel) => {
  const p = join(PKG_ROOT, "dist", rel);
  if (!existsSync(p)) {
    throw new Error(`no compiled dist for ${rel} — run the package build first`);
  }
  return import(pathToFileURL(p).href);
};

const { MEMORY_MURAL_BLOCK, MEMORY_MURAL_GUIDANCE, SELF_TAG_GUIDANCE, buildMagicContextSection } =
  await loadDist("core/agents/magic-context-prompt.js");
const { ACTIVE_TOOL_IDS, LIGHT_TOOL_DESCRIPTIONS } = await loadDist(
  "core/shared/prompt-surface-runtime.js",
);

/**
 * ZCode D 组工具注册面对照表（contracts `tools/ctx-context.ts` 的四个
 * `CTX_*_TOOL_NAME` 常量 → core `builtInTools` 注册名）。写死在这里是**故意的**：
 * 它是被测面的外部事实，测试必须有一条独立于被测代码的副本，否则「常量与自身比对」
 * 永远是绿。core 侧 `test-magic-context-section-ctx-note.mjs` 另做 contracts↔目录的
 * 双侧对齐，两侧副本互为参照。
 */
const ZCODE_CTX_TOOL_IDS = ["ctx_reduce", "ctx_expand", "ctx_search", "ctx_memory"];

/** spec T-P2 登记豁免集：ctx_note（N2 终局不注册，文案惰性引用保留）。写死。 */
const REGISTERED_EXEMPTIONS = ["ctx_note"];

const CTX_TOOL_REFERENCE = /\b(ctx_[a-z]+)\b/g;

function extractToolNames(text) {
  return [...new Set([...text.matchAll(CTX_TOOL_REFERENCE)].map((m) => m[1]))];
}

/** 闭合谓词：文案里出现的 ctx_* 名 ⊆ 已注册面 ∪ 豁免集。失败即命题被违反。 */
function assertToolNamesClosed(text, where) {
  const names = extractToolNames(text);
  const unknown = names.filter(
    (name) => !ZCODE_CTX_TOOL_IDS.includes(name) && !REGISTERED_EXEMPTIONS.includes(name),
  );
  assert.deepEqual(unknown, [], `${where}: unknown ctx_* references ${JSON.stringify(names)}`);
  return names;
}

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
    console.log(`TEST PASS — ${total}/${total} tool-name closure tests (T-P2)`);
  } else {
    console.log(`TEST FAIL — ${failed}/${total} tool-name closure tests failed`);
  }
});

// ── ①② 被测面闭合 ──────────────────────────────────────────────────────────

it("the light catalog and the registration table agree (catalog identity)", () => {
  assert.deepEqual([...ACTIVE_TOOL_IDS].sort(), [...ZCODE_CTX_TOOL_IDS].sort());
  assert.deepEqual(Object.keys(LIGHT_TOOL_DESCRIPTIONS).sort(), [...ACTIVE_TOOL_IDS].sort());
});

it("light descriptions close against the registered surface (exemption: ctx_note)", () => {
  for (const [toolId, description] of Object.entries(LIGHT_TOOL_DESCRIPTIONS)) {
    assertToolNamesClosed(description, `LIGHT_TOOL_DESCRIPTIONS.${toolId}`);
  }
  // 豁免集非空转：ctx_note 的惰性引用真的在场（host 层的降级适配见 core 测试）。
  const referenced = new Set();
  for (const description of Object.values(LIGHT_TOOL_DESCRIPTIONS)) {
    for (const name of extractToolNames(description)) referenced.add(name);
  }
  assert.equal(referenced.has("ctx_note"), true, "the ctx_note exemption must be exercised");
  assert.deepEqual(REGISTERED_EXEMPTIONS, ["ctx_note"], "the exemption set is pinned");
});

it("mural guidance constants (same prompt module) close against the registered surface", () => {
  for (const [name, text] of Object.entries({ MEMORY_MURAL_GUIDANCE, MEMORY_MURAL_BLOCK })) {
    assertToolNamesClosed(text, name);
  }
});

it("the 211-line section closes across the full 11-parameter matrix", () => {
  let combos = 0;
  for (const ctxReduceCallable of [true, false]) {
    for (const preset of ["full", "light"]) {
      for (const memoryEnabled of [true, false]) {
        for (const dreamerEnabled of [true, false]) {
          for (const temporalAwarenessEnabled of [true, false]) {
            for (const cavemanTextCompressionEnabled of [true, false]) {
              for (const subagentMode of [true, false]) {
                const where = `reduce=${ctxReduceCallable} preset=${preset} memory=${memoryEnabled} dreamer=${dreamerEnabled} temporal=${temporalAwarenessEnabled} caveman=${cavemanTextCompressionEnabled} subagent=${subagentMode}`;
                const section = buildMagicContextSection(
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
                );
                assertToolNamesClosed(section, where);
                combos += 1;
              }
            }
          }
        }
      }
    }
  }
  assert.equal(combos, 128, "the matrix must really enumerate 128 combinations");
});

it("SELF_TAG_GUIDANCE closes trivially (exported separately for the subagent host side)", () => {
  assertToolNamesClosed(SELF_TAG_GUIDANCE, "SELF_TAG_GUIDANCE");
});

// ── 强度自证：假名必须红 ────────────────────────────────────────────────────

it("strength: a synthetic ctx_* name outside the exemption set fails the closure", () => {
  // 与生产谓词同一条代码路径：把假名喂进去，谓词必须throws。
  assert.throws(
    () => assertToolNamesClosed("Run `ctx_ghost` and `ctx_reduce` together.", "synthetic"),
    /ctx_ghost/,
  );
  // 豁免内的名字不红（豁免集恰好只放行 ctx_note）。
  assertToolNamesClosed("Run `ctx_note` and `ctx_reduce` together.", "synthetic-exempt");
  // 已注册四条不红。
  for (const name of ZCODE_CTX_TOOL_IDS) {
    assertToolNamesClosed(`Run \`${name}\` now.`, `synthetic-registered:${name}`);
  }
});
