#!/usr/bin/env node
/**
 * Step 13 / T-P1（bugfix-batch-20261011 / phase-mc-prompt-surface）：
 * `## Magic Context` 段注入与原生 `# Memory` 段互斥。
 *
 * 四组断言：
 *
 *   A. **注入**：`magicContextSection` 在场 → `source: "magic_context"`、
 *      `injectionTarget: "system"` 的段进入 system prompt（dynamic block），
 *      段文本原样可见（spec「m0 注入可见 project-memory 内容」的同级判据——
 *      这里断言的是 system prompt 侧的那一半）。
 *   B. **互斥**：段在场时原生 `# Memory` 段**缺席**、`MEMORY.md` 索引块也不进
 *      meta_user；段缺席时两者照旧在场（回归护栏：互斥不能顺手关掉原生面）。
 *   C. **装配端口**：`resolveMagicContextPromptSection` 的三条 null 路径（无端口 /
 *      flag 关 / resolver 返回 null）与活值转发——`ctxReduceCallable` 必须由**真实工具
 *      表**推导，而不是照抄 flag。
 *   D. **子智能体**：`SubagentContextBuilder` 落位同一段（subagentMode 分支的产物），
 *      且与主路径共用同一个 entry 工厂。
 *
 * 依赖已构建的 dist：`pnpm --filter @zcode/core build`。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/**
 * 与 `test-prompt-language-context.mjs` 同一范式：workspace 包的 dist 之间存在「dist 引用
 * dist」与「dist 引用 ts 源码」两种形态，把被测链会碰到的 workspace 包指到各自 dist，node
 * 才不必解析 `.ts`。被测的 core 代码走 `../dist/**`，同样在此之外。
 */
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);
const PACKAGE_DIST_ENTRY = {
  "@zcode/contracts": `${REPO_ROOT}apps/zcode-cli/packages/contracts/dist/index.js`,
};

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
    return nextResolve(specifier, _context);
  },
});

const { ContextBuilder } = await import(
  new URL("../dist/context/builder.js", import.meta.url).href
);
const { SubagentContextBuilder } = await import(
  new URL("../dist/subagent/context-builder.js", import.meta.url).href
);
const { MAGIC_CONTEXT_SECTION_HEADING } = await import(
  new URL("../dist/context/sections/magic-context.js", import.meta.url).href
);
const { resolveMagicContextPromptSection } = await import(
  new URL("../dist/runtime/helpers/magic-context-prompt-section.js", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Magic Context section injection + native Memory mutual exclusion (T-P1)"
      : `TEST FAIL — Magic Context section injection (exit code ${code})`,
  );
});

/** 上游 `buildMagicContextSection` 的真实输出形状（完整 211 行段的缩样，heading 逐字一致）。 */
const SECTION = `${MAGIC_CONTEXT_SECTION_HEADING}

### You are the user's long-term partner on this project — not a one-off hire

Think of your context as a desk. Every message and every tool output lands on it, and each item arrives with a §N§ tag (§1§, §42§) — the tag is the item's handle.

\`ctx_memory\` pins a new one when you learn something that must not have to be found again.`;

/** 子智能体档：上游 subagentMode 分支只保留 §N§ 机制，不含 partner frame。 */
const SUBAGENT_SECTION = `${MAGIC_CONTEXT_SECTION_HEADING}

Your context is a desk. Every message and every tool output lands on it, and each item arrives with a §N§ tag (§1§, §42§) — the tag is the item's handle.`;

const ENV_INFO = {
  cwd: "D:/tmp/project",
  platform: "win32",
  shell: "cmd.exe",
  osVersion: "10.0.26200",
  nodeVersion: "v24.14.0",
  isGitRepository: false,
};

function buildConfig(overrides = {}) {
  return new ContextBuilder({
    workingDirectory: "D:/tmp/project",
    envInfo: ENV_INFO,
    currentDate: "2026-10-11",
    memoryRoot: "D:/tmp/project/.omz/memory",
    memoryIndexContent: "- [keep-tests-green](../green.md) — always run the suite",
    ...overrides,
  });
}

function sectionBySource(result, source) {
  return result.sections.find((section) => section.source === source);
}

function mustSection(result, source) {
  const section = sectionBySource(result, source);
  assert.ok(section, `expected a ${source} section`);
  return section;
}

test("A1: the magic-context section is injected into the dynamic system block", () => {
  const result = buildConfig({ magicContextSection: SECTION }).build();
  const section = mustSection(result, "magic_context");
  assert.equal(section.name, "Magic Context");
  assert.equal(section.injectionTarget, "system");
  assert.equal(section.cacheHint, "dynamic");
  assert.equal(section.content, SECTION);
  assert.equal(section.chars, SECTION.length);
  assert.ok(section.tokens > 0);
  assert.equal(section.preview, SECTION.slice(0, 100));
  // 落在 dynamic system block 里（不是 stable、不是 meta_user）。
  const system = result.systemMessages.map((message) => message.content).join("\n");
  assert.match(system, /## Magic Context/);
  assert.match(system, /ctx_memory` pins a new one/);
});

test("A2: an absent magicContextSection injects nothing and keeps every other section", () => {
  const result = buildConfig().build();
  assert.equal(sectionBySource(result, "magic_context"), undefined);
  assert.equal(sectionBySource(result, "memory")?.name, "Memory");
});

test("A3: a malformed section fails loudly instead of injecting prose without a heading", () => {
  assert.throws(() => buildConfig({ magicContextSection: "### Your desk\n\nno heading" }).build(), /## Magic Context/);
});

test("B1: the native # Memory section and MEMORY.md index both retire while the section is served", () => {
  const result = buildConfig({ magicContextSection: SECTION }).build();
  assert.equal(sectionBySource(result, "memory"), undefined, "native # Memory must retire");
  const metaUser = result.metaUserAttachments.map((a) => a.content).join("\n");
  assert.doesNotMatch(metaUser, /MEMORY\.md/, "the file-index block must retire too");
  // AGENTS.md 等其他 request-user-context 内容不受影响（互斥只针对记忆面）。
  assert.match(metaUser, /As you answer the user's questions/);
});

test("B2: without the section both native memory surfaces are back (regression guard)", () => {
  const result = buildConfig().build();
  assert.match(mustSection(result, "memory").content, /^# Memory/);
  const metaUser = result.metaUserAttachments.map((a) => a.content).join("\n");
  assert.match(metaUser, /MEMORY\.md/);
});

test("B3: a custom system prompt path is untouched by the mutual exclusion", () => {
  // hasCustomSystemPrompt 分支整段跳过 dynamic 段；那时既没有 magic-context 段也没有
  // 原生 Memory 段——既有行为，本步不改。
  const result = buildConfig({
    customSystemPrompt: "You are a bespoke agent.",
    magicContextSection: SECTION,
    memoryRoot: "D:/tmp/project/.omz/memory",
  }).build();
  assert.equal(sectionBySource(result, "magic_context"), undefined);
  assert.equal(sectionBySource(result, "memory"), undefined);
});

test("C1: no port / flag off / resolver null all mean no injection", () => {
  const base = {
    config: { magicContext: { enabled: true } },
    getTools: () => [{ name: "ctx_reduce" }],
  };
  assert.equal(
    resolveMagicContextPromptSection({ ...base, magicContextPromptSection: undefined }, undefined),
    null,
  );
  assert.equal(
    resolveMagicContextPromptSection({ ...base, config: { magicContext: { enabled: false } }, magicContextPromptSection: () => SECTION }, undefined),
    null,
  );
  assert.equal(
    resolveMagicContextPromptSection({ ...base, magicContextPromptSection: () => null }, undefined),
    null,
  );
});

test("C2: ctxReduceCallable comes from the real tool table, not the flag", () => {
  const seen = [];
  const runtime = {
    config: { magicContext: { enabled: true }, language: "zh-CN" },
    getTools: () => [{ name: "ctx_expand" }],
    magicContextPromptSection: (input) => {
      seen.push(input);
      return SECTION;
    },
  };
  const resolved = resolveMagicContextPromptSection(runtime, undefined);
  assert.equal(resolved, SECTION);
  assert.deepEqual(seen, [
    { language: "zh-CN", ctxReduceCallable: false, subagentMode: false },
  ]);
});

test("C3: model key and subagent mode reach the resolver as live facts", () => {
  const seen = [];
  const runtime = {
    config: { magicContext: { enabled: true }, taskType: "subagent_child" },
    getTools: () => [{ name: "ctx_reduce" }],
    magicContextPromptSection: (input) => {
      seen.push(input);
      return SUBAGENT_SECTION;
    },
  };
  resolveMagicContextPromptSection(runtime, {
    providerId: "zhipu",
    modelId: "glm-4.6",
  });
  assert.deepEqual(seen, [
    { modelKey: "zhipu/glm-4.6", ctxReduceCallable: true, subagentMode: true },
  ]);
});

test("D1: the subagent builder places the same entry", () => {
  const builder = new SubagentContextBuilder({
    agentPrompt: "You are a bounded explorer.",
    envInfo: ENV_INFO,
    currentDate: "2026-10-11",
    userInstructions: {
      filePath: "D:/tmp/project/AGENTS.md",
      fileName: "AGENTS.md",
      content: "Run the test suite before finishing.",
      bytesRead: 31,
      sizeBytes: 31,
      truncated: false,
    },
    magicContextSection: SUBAGENT_SECTION,
  });
  const result = builder.build();
  const section = mustSection(result, "magic_context");
  assert.equal(section.content, SUBAGENT_SECTION);
  // 行为契约位置：出现在 request-user-context 之前（工作区说明不该隔开它）。
  const order = result.sections.map((s) => s.source);
  assert.ok(
    order.indexOf("magic_context") < order.indexOf("request_user_context"),
    `unexpected section order: ${order.join(" > ")}`,
  );
  // 子智能体构建路径没有原生 Memory 段，因此互斥在这里是无操作的而非覆盖。
  assert.equal(sectionBySource(result, "memory"), undefined);
});
