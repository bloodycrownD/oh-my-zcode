#!/usr/bin/env node
/**
 * IM3（spec phase-effective-single）的**同源守卫 + 两张真值表**。
 *
 * 背景：契约 8 的 `effective = features.magicContext && magicContext.enabled` 曾在宿主侧
 * 分叉——`runtime-config.ts` 两个都读、`zcode-protocol/magic-context-memories.ts` 只读域值
 * （总开关关掉后设置页仍能打开记忆库）；`create-app.ts` 又把同一个比较写了三遍（W3 的 G4）；
 * core 侧三个消费点各自把「已算出的冷值」与布尔字面量比较了一遍（G6/G7/G8）。
 *
 * 本脚本钉四件事：
 *
 *   1. **bootstrap 三轴表**：`featureFlag × overrideEnabled × domainEnabled` 的组合，
 *      尤其「域缺席按 schema 缺省开」与「override 优先于 feature」；
 *   2. **core 布尔投影表**：`isMagicContextEffectiveByConfig(enabled, { whenUnset })`。
 *      core 三个调用点的 `undefined` 缺省方向**本来不一致**（T-MC1），收口只统一真值
 *      来源、不合并语义，因此表里逐行写死三处的原表达式等价性；
 *   3. **同源守卫**：全仓（`apps/` + `packages/` + `scripts/`）扫描，除唯一实现文件外
 *      不允许再出现 `magicContext.enabled === true|false` / `!== true|false`（剥注释后判定）；
 *   4. **调用点接线守卫**：`create-app` 只投影一次、core 三处必须带正确的 `whenUnset`。
 *
 * 运行：`pnpm --dir apps/zcode-cli/packages/bootstrap run test:magic-context-gate`
 * （tsx 直接加载 TS 源，不依赖 dist）。
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const BOOTSTRAP_SRC = fileURLToPath(new URL("../src/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

const { resolveMagicContextEffectiveEnabled, projectMagicContextEffectiveEnabled } = await import(
  new URL("../src/app/magic-context/effective-enabled.ts", import.meta.url).href
);
const { isMagicContextEffectiveByConfig } = await import(
  new URL("../../core/src/runtime/helpers/magic-context-effective-enabled.ts", import.meta.url).href
);

// ─────────────────────────────────────────────────────────────────────────────
// 表 1：bootstrap 三轴（唯一口径的唯一实现）
// ─────────────────────────────────────────────────────────────────────────────

const bootstrapCases = [
  // [说明, input, expected]
  ["两个开关都开 → 开", { featureFlag: true, domainEnabled: true }, true],
  ["域缺席 → 按 schema 缺省开", { featureFlag: true }, true],
  ["域显式 false → 关", { featureFlag: true, domainEnabled: false }, false],
  ["feature 关、域开 → 关（kill switch 优先）", { featureFlag: false, domainEnabled: true }, false],
  ["feature 关、域缺席 → 关", { featureFlag: false }, false],
  [
    "override false 覆盖 feature true",
    { featureFlag: true, overrideEnabled: false, domainEnabled: true },
    false,
  ],
  [
    "override true 覆盖 feature false",
    { featureFlag: false, overrideEnabled: true, domainEnabled: true },
    true,
  ],
  [
    "override true 但不能绕过域 false",
    { featureFlag: true, overrideEnabled: true, domainEnabled: false },
    false,
  ],
  [
    "override 缺席时跟 feature",
    { featureFlag: true, overrideEnabled: undefined, domainEnabled: true },
    true,
  ],
];

for (const [label, input, expected] of bootstrapCases) {
  test(`bootstrap 三轴表：${label}`, () => {
    assert.equal(resolveMagicContextEffectiveEnabled(input), expected);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 表 2：core 布尔投影（真值来源是表 1 的输出，缺省方向逐点显式）
// ─────────────────────────────────────────────────────────────────────────────

/** 三个调用点**收口前**的原表达式——表 2 用它们逐行对齐，防止静默改语义。 */
const ORIGINAL_CORE_EXPRESSIONS = {
  /** `runtime-tools.ts:126`（ctx 工具注册门） */
  runtimeTools: (enabled) => enabled === true,
  /** `magic-context-prompt-section.ts:84`（段注入门） */
  promptSection: (enabled) => enabled !== true,
  /** `magic-context-turn-transform.ts:234`（turn-loop 兜底否决） */
  turnTransformVeto: (enabled) => enabled === false,
};

const coreCases = [
  // [说明, enabled, whenUnset, expected]
  ["enabled=true、缺省按关 → 开", true, false, true],
  ["enabled=false、缺省按关 → 关", false, false, false],
  ["enabled 缺席、缺省按关 → 关", undefined, false, false],
  ["enabled=true、缺省按开 → 开", true, true, true],
  ["enabled=false、缺省按开 → 关", false, true, false],
  ["enabled 缺席、缺省按开 → 开", undefined, true, true],
];

for (const [label, enabled, whenUnset, expected] of coreCases) {
  test(`core 布尔投影表：${label}`, () => {
    assert.equal(isMagicContextEffectiveByConfig(enabled, { whenUnset }), expected);
  });
}

test("core 布尔投影表：与三处原表达式逐位等价（含 undefined）", () => {
  const values = [true, false, undefined];
  for (const enabled of values) {
    // runtime-tools.ts 原式 `=== true` ↔ whenUnset:false（含在 include 语义里）
    assert.equal(
      isMagicContextEffectiveByConfig(enabled, { whenUnset: false }),
      ORIGINAL_CORE_EXPRESSIONS.runtimeTools(enabled),
      `runtime-tools 语义漂移：enabled=${String(enabled)}`,
    );
    // prompt-section.ts 原式 `!== true`（取反后判 null）
    assert.equal(
      !isMagicContextEffectiveByConfig(enabled, { whenUnset: false }),
      ORIGINAL_CORE_EXPRESSIONS.promptSection(enabled),
      `prompt-section 语义漂移：enabled=${String(enabled)}`,
    );
    // turn-transform.ts 原式 `=== false`（取反后提前 return）
    assert.equal(
      !isMagicContextEffectiveByConfig(enabled, { whenUnset: true }),
      ORIGINAL_CORE_EXPRESSIONS.turnTransformVeto(enabled),
      `turn-transform 语义漂移：enabled=${String(enabled)}`,
    );
  }
});

test("bootstrap 三轴输出喂进 core 投影后与 `enabled === true` 逐行一致", () => {
  for (const [label, input, expected] of bootstrapCases) {
    const effective = resolveMagicContextEffectiveEnabled(input);
    assert.equal(effective, expected, label);
    // 装配层把 effective 冻结进 RuntimeConfig，core 再读出来——两步之间不得有任何变化。
    assert.equal(
      projectMagicContextEffectiveEnabled({ magicContext: { enabled: effective } }),
      effective,
    );
    assert.equal(isMagicContextEffectiveByConfig(effective, { whenUnset: false }), effective);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 冷值投影（create-app 的唯一读取点）
// ─────────────────────────────────────────────────────────────────────────────

test("冷值投影：缺席按关，与收口前的 `=== true` 一致", () => {
  assert.equal(projectMagicContextEffectiveEnabled({ magicContext: { enabled: true } }), true);
  assert.equal(projectMagicContextEffectiveEnabled({ magicContext: { enabled: false } }), false);
  assert.equal(projectMagicContextEffectiveEnabled({ magicContext: {} }), false);
  assert.equal(projectMagicContextEffectiveEnabled({}), false);
  assert.equal(projectMagicContextEffectiveEnabled(undefined), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 同源守卫：全仓禁止再出现重复的生效判定表达式
// ─────────────────────────────────────────────────────────────────────────────

/** 唯一允许出现比较的文件（唯一实现）。 */
const ALLOWED_COMPARISON_FILE = join(
  "bootstrap",
  "src",
  "app",
  "magic-context",
  "effective-enabled.ts",
);

/** 重复的生效判定表达式：`magicContext.enabled` 与布尔字面量的比较（可选链两形都算）。 */
const DUPLICATED_EFFECTIVE_EXPRESSION =
  /magicContext\s*\??\.\s*enabled\s*(?:===|!==)\s*(?:true|false)\b/;

const SCAN_ROOTS = ["apps", "packages", "scripts"].map((dir) => join(REPO_ROOT, dir));
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".turbo",
  ".next",
  ".reference",
  ".zcode",
  "out",
]);

/**
 * 剥掉块注释与行注释后再判定（spec phase-gates：源码形状守卫不能因注释里的函数名/表达式
 * 通过或失败）。`//` 前的 `[^:]` 保护 `https://` 这类字符串里的双斜杠。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function* walkSourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkSourceFiles(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0 || !SCAN_EXTENSIONS.has(entry.name.slice(dot))) continue;
    yield join(dir, entry.name);
  }
}

test("同源守卫：全仓除唯一实现外不再出现 magicContext.enabled 的布尔比较", () => {
  const violations = [];
  for (const root of SCAN_ROOTS) {
    if (!existsSync(root)) continue;
    if (!statSync(root).isDirectory()) continue;
    for (const file of walkSourceFiles(root)) {
      const relativePath = relative(REPO_ROOT, file);
      if (relativePath.endsWith(ALLOWED_COMPARISON_FILE)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      source.split("\n").forEach((line, index) => {
        if (DUPLICATED_EFFECTIVE_EXPRESSION.test(line)) {
          violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(
    violations,
    [],
    `生效判定必须走唯一实现（bootstrap/src/app/magic-context/effective-enabled.ts / ` +
      `core/src/runtime/helpers/magic-context-effective-enabled.ts），不得再各写一遍比较：\n` +
      violations.join("\n"),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 调用点接线守卫
// ─────────────────────────────────────────────────────────────────────────────

function readSource(path) {
  return stripComments(readFileSync(join(BOOTSTRAP_SRC, path), "utf8"));
}

const CORE_SRC = join(
  REPO_ROOT,
  "apps",
  "zcode-cli",
  "packages",
  "core",
  "src",
  "runtime",
  "helpers",
);

function readCoreSource(name) {
  return stripComments(readFileSync(join(CORE_SRC, name), "utf8"));
}

test("同源守卫：runtime-config 走唯一口径（冷求值）", () => {
  const source = readSource("app/runtime-config.ts");
  assert.ok(
    source.includes("resolveMagicContextEffectiveEnabled("),
    "runtime-config.ts 必须调用 resolveMagicContextEffectiveEnabled",
  );
});

test("同源守卫：memories RPC 走唯一口径，且不再只读域值", () => {
  const source = readSource("zcode-protocol/magic-context-memories.ts");
  assert.ok(
    source.includes("resolveMagicContextEffectiveEnabled("),
    "magic-context-memories.ts 必须调用 resolveMagicContextEffectiveEnabled",
  );
  assert.ok(
    source.includes("ConfigKey.FeatureMagicContext"),
    "memories 的 effective 门必须同时读 feature kill switch",
  );
});

test("同源守卫：create-app 三处消费收敛为一次冷值投影", () => {
  const source = readSource("app/create-app.ts");
  const projectionCalls = source.match(/projectMagicContextEffectiveEnabled\(/g) ?? [];
  assert.equal(projectionCalls.length, 1, "create-app.ts 只允许调用一次冷值投影");
  const consumers = source.match(/magicContextEffectiveEnabled/g) ?? [];
  // 1 次声明 + 3 处消费（装配门 / 工厂 enabled / isMagicContextEnabled 契约）。
  assert.ok(consumers.length >= 4, `三处消费必须复用同一个布尔，实际引用 ${consumers.length} 次`);
  assert.ok(
    source.includes("isMagicContextEnabled: () => magicContextEffectiveEnabled"),
    "ctx 命令契约只转发那一次求值，不得自行重算",
  );
});

test("同源守卫：core 三处调用统一投影，缺省方向与历史语义一一对应", () => {
  const runtimeTools = readCoreSource("runtime-tools.ts");
  assert.ok(
    runtimeTools.includes("isMagicContextEffectiveByConfig(") &&
      runtimeTools.includes("whenUnset: false"),
    "runtime-tools.ts 必须用 whenUnset:false（原 `=== true`，缺席按关）",
  );

  const promptSection = readCoreSource("magic-context-prompt-section.ts");
  assert.ok(
    promptSection.includes("isMagicContextEffectiveByConfig(") &&
      promptSection.includes("whenUnset: false"),
    "magic-context-prompt-section.ts 必须用 whenUnset:false（原 `!== true`，缺席按关）",
  );

  const turnTransform = readCoreSource("magic-context-turn-transform.ts");
  assert.ok(
    turnTransform.includes("isMagicContextEffectiveByConfig(") &&
      turnTransform.includes("whenUnset: true"),
    "magic-context-turn-transform.ts 必须用 whenUnset:true（原 `=== false`，缺席按开）",
  );
  // G5（活值）与 G8（兜底否决）的结构不可合并：端口优先、config 只做否决。
  assert.ok(
    turnTransform.indexOf("isEnabled?.() === false") <
      turnTransform.lastIndexOf("isMagicContextEffectiveByConfig("),
    "端口 isEnabled() 必须先于 config 投影求值（config 只做否决）",
  );
});

test("同源守卫：gate.ts 已更名，旧路径不再被引用", () => {
  assert.equal(
    existsSync(join(BOOTSTRAP_SRC, "app", "magic-context", "gate.ts")),
    false,
    "gate.ts 应已更名为 effective-enabled.ts",
  );
  assert.equal(
    existsSync(join(BOOTSTRAP_SRC, "app", "magic-context", "effective-enabled.ts")),
    true,
    "effective-enabled.ts 必须存在",
  );
  const offenders = [];
  for (const root of SCAN_ROOTS) {
    if (!existsSync(root)) continue;
    for (const file of walkSourceFiles(root)) {
      const source = stripComments(readFileSync(file, "utf8"));
      if (/magic-context\/gate(?:\.js|\.ts)?["']/.test(source)) {
        offenders.push(relative(REPO_ROOT, file));
      }
    }
  }
  assert.deepEqual(offenders, [], `旧路径 magic-context/gate 仍被引用：${offenders.join(", ")}`);
});
