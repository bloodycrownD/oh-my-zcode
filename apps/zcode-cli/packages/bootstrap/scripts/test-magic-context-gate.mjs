#!/usr/bin/env node
/**
 * IM3（spec phase-effective-single）的**同源守卫 + 两张真值表**。
 *
 * 背景：契约 8 的 `effective = features.magicContext && magicContext.enabled` 曾在宿主侧
 * 分叉——`runtime-config.ts` 两个都读、`zcode-protocol/magic-context-memories.ts` 只读域值
 * （总开关关掉后设置页仍能打开记忆库）；`create-app.ts` 又把同一个比较写了三遍（W3 的 G4）；
 * core 侧三个消费点各自把「已算出的冷值」与布尔字面量比较了一遍（G6/G7/G8）。
 *
 * 本脚本钉五件事：
 *
 *   1. **bootstrap 三轴表**：`featureFlag × overrideEnabled × domainEnabled` 的组合，
 *      尤其「域缺席按 schema 缺省开」与「override 优先于 feature」；
 *   2. **core 布尔投影表**：`isMagicContextEffectiveByConfig(enabled, { whenUnset })`。
 *      core 三个调用点的 `undefined` 缺省方向**本来不一致**（T-MC1），收口只统一真值
 *      来源、不合并语义，因此表里逐行写死三处的原表达式等价性；
 *   3. **同源守卫**：全仓（`apps/` + `packages/` + `scripts/`）扫描，除唯一实现文件外
 *      不允许再出现任何形态的生效判定——比较（`=== true|false` / `!== …`）、取反
 *      （`!cfg.magicContext?.enabled`）、真值化（`if (cfg.magicContext.enabled)` /
 *      `Boolean(…)` / 三元条件）。判定方式是**剥注释 + 逐行正则**，不是 AST；
 *      覆盖边界：正则不认类型层面的别名与间接调用（`const f = () => cfg.magicContext.enabled;`
 *      `f()`），这类写法靠评审兜住；
 *   4. **调用点接线守卫**：`create-app` 只投影一次且实参必须是 `runtimeConfig`；core 三处
 *      必须**整段**形如 `isMagicContextEffectiveByConfig(runtime.config.magicContext?.enabled,
 *      { whenUnset })`——只查 `whenUnset` 字面量会被 `(true, { whenUnset: false })` 混过去；
 *   5. **扫描面守卫**：`REPO_ROOT` 是 5 级 `../` 推导，三个扫描根必须存在、文件数有下限、
 *      已知锚点必须被扫到，否则脚本被移动后会「零扫描通过」。
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

/** 唯一实现文件（三轴求值 + 冷值投影都在这里）。 */
const EFFECTIVE_IMPL_RELATIVE = join(
  "bootstrap",
  "src",
  "app",
  "magic-context",
  "effective-enabled.ts",
);

/** 冷值投影唯一允许的生产调用点。 */
const CREATE_APP_RELATIVE = join("bootstrap", "src", "app", "create-app.ts");

/**
 * 重复的生效判定表达式（剥注释后逐行判定）。除唯一实现外，任何形态都算违规：
 *   1. 比较：`x.magicContext.enabled === true` / `!== false`（含松散相等与反向写法）；
 *   2. 取反：`!x.magicContext?.enabled`；
 *   3. 真值化：`if (x.magicContext.enabled)` / `Boolean(x.magicContext?.enabled)` /
 *      `x.magicContext?.enabled ? a : b` / `…enabled && y`。
 * 只匹配布尔字面量与真值位置——`=== undefined` 这类「分辨缺席还是 false」的写法是三轴
 * 输入侧必需的，不在禁止范围内。
 */
const MAGIC_CONTEXT_ENABLED = String.raw`magicContext\s*\??\.\s*enabled\b`;
const DUPLICATED_EFFECTIVE_EXPRESSIONS = [
  // `x.magicContext.enabled === true` / `!== false`（含 == / !=）
  new RegExp(`${MAGIC_CONTEXT_ENABLED}\\s*(?:===|!==|==|!=)\\s*(?:true|false)\\b`),
  // 反向：`true === x.magicContext.enabled`
  new RegExp(`(?:true|false)\\s*(?:===|!==|==|!=)\\s*[\\w$?.]*${MAGIC_CONTEXT_ENABLED}`),
  // 取反：`!cfg.magicContext?.enabled`
  new RegExp(`!\\s*[\\w$?.]*${MAGIC_CONTEXT_ENABLED}`),
  // 真值位置：`if (…)` / `while (…)` / `Boolean(…)` / `assert[.ok](…)`
  new RegExp(
    `\\b(?:if|while|Boolean|assert(?:\\.ok)?)\\s*\\(\\s*!?[\\w$?.]*${MAGIC_CONTEXT_ENABLED}`,
  ),
  // 三元条件 / 布尔链：`…enabled ? a : b`、`…enabled && y`
  new RegExp(`[\\w$?.]*${MAGIC_CONTEXT_ENABLED}\\s*(?:\\?|&&|\\|\\|)`),
];

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

/**
 * 一次性列出扫描面并记录根的存在性。
 *
 * `REPO_ROOT` 由 5 级 `../` 推导，脚本一旦被移动或层级变化，三个根就会全部落空。旧实现
 * 对缺失根直接 `continue`，violations 仍是 `[]` → 守卫「零扫描通过」的假绿。所以根存在性
 * 与扫描规模必须在下面的独立测试里先断言，再谈违规清单。
 */
function collectScanFiles() {
  const files = [];
  const presentRoots = [];
  const missingRoots = [];
  for (const root of SCAN_ROOTS) {
    let isDirectory = false;
    try {
      isDirectory = statSync(root).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      missingRoots.push(root);
      continue;
    }
    presentRoots.push(root);
    for (const file of walkSourceFiles(root)) files.push(file);
  }
  return { files, presentRoots, missingRoots };
}

const SCAN = collectScanFiles();

/** 至少扫到这么多文件才算真的扫了全仓（本仓实测 4000+）。 */
const MIN_SCANNED_FILES = 1000;

/** 已知锚点：任何一个不在扫描清单里，说明扫描面已跑偏，守卫的 `[]` 不可信。 */
const SCAN_ANCHORS = [
  join(
    "apps",
    "zcode-cli",
    "packages",
    "bootstrap",
    "src",
    "app",
    "magic-context",
    "effective-enabled.ts",
  ),
  join("apps", "zcode-cli", "packages", "core", "src", "runtime", "helpers", "runtime-tools.ts"),
  join("apps", "zcode-cli", "packages", "bootstrap", "scripts", "test-magic-context-gate.mjs"),
  join("packages", "shared", "src", "zcode-protocol-v4", "snapshot.ts"),
];

/** 生产源码判定：scripts/（测试夹具）与 *.test./*.spec./test-* 不算生产接线。 */
const PRODUCTION_EXCLUDED_SEGMENT = new Set(["scripts", "tests", "__tests__"]);
function isProductionSource(relativePath) {
  const segments = relativePath.split(/[\\/]/);
  const basename = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((segment) => PRODUCTION_EXCLUDED_SEGMENT.has(segment))) {
    return false;
  }
  return !basename.startsWith("test-") && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(basename);
}

test("同源守卫：扫描面有效（扫描根存在 + 文件数达标 + 锚点在列），不是零扫描假绿", () => {
  assert.deepEqual(
    SCAN.missingRoots,
    [],
    `扫描根缺失：${SCAN.missingRoots.join(", ")}（REPO_ROOT=${REPO_ROOT}）。` +
      "守卫需要 apps / packages / scripts 三个根；脚本被移动或 ../ 层数变了都会导致零扫描通过。",
  );
  assert.ok(
    SCAN.presentRoots.length >= 1,
    `三个扫描根一个都不存在（REPO_ROOT=${REPO_ROOT}），守卫将零扫描通过`,
  );
  assert.ok(
    SCAN.files.length >= MIN_SCANNED_FILES,
    `只扫到 ${SCAN.files.length} 个源文件（下限 ${MIN_SCANNED_FILES}），扫描面异常——` +
      "守卫的「无违规」不可信",
  );
  const scanned = new Set(SCAN.files);
  for (const anchor of SCAN_ANCHORS) {
    assert.ok(
      scanned.has(join(REPO_ROOT, anchor)),
      `锚点文件未被扫描到：${anchor}。扫描根齐全但锚点缺席，说明扫描面已跑偏（假绿）`,
    );
  }
});

test("同源守卫：全仓除唯一实现外不再出现任何形态的 magicContext.enabled 生效判定", () => {
  const violations = [];
  for (const file of SCAN.files) {
    const relativePath = relative(REPO_ROOT, file);
    if (relativePath.endsWith(EFFECTIVE_IMPL_RELATIVE)) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    source.split("\n").forEach((line, index) => {
      if (DUPLICATED_EFFECTIVE_EXPRESSIONS.some((pattern) => pattern.test(line))) {
        violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    `生效判定必须走唯一实现（bootstrap/src/app/magic-context/effective-enabled.ts / ` +
      `core/src/runtime/helpers/magic-context-effective-enabled.ts），不得再各写一遍：\n` +
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
  const projectionCalls = source.match(/projectMagicContextEffectiveEnabled\s*\(/g) ?? [];
  assert.equal(projectionCalls.length, 1, "create-app.ts 只允许调用一次冷值投影");
  const consumers = source.match(/magicContextEffectiveEnabled/g) ?? [];
  // 1 次声明 + 3 处消费（装配门 / 工厂 enabled / isMagicContextEnabled 契约）。
  assert.ok(consumers.length >= 4, `三处消费必须复用同一个布尔，实际引用 ${consumers.length} 次`);
  assert.ok(
    source.includes("isMagicContextEnabled: () => magicContextEffectiveEnabled"),
    "ctx 命令契约只转发那一次求值，不得自行重算",
  );
});

test("同源守卫：冷值投影只允许 create-app 的生产装配点调用，且实参必须是 runtimeConfig", () => {
  const offenders = [];
  const badArguments = [];
  let callSites = 0;
  for (const file of SCAN.files) {
    const relativePath = relative(REPO_ROOT, file);
    // 测试夹具用结构化字面量直构冷值来验证投影语义，不属于生产接线。
    if (!isProductionSource(relativePath)) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (!source.includes("projectMagicContextEffectiveEnabled")) continue;
    if (relativePath.endsWith(EFFECTIVE_IMPL_RELATIVE)) continue;
    if (relativePath.endsWith(CREATE_APP_RELATIVE)) {
      for (const match of source.matchAll(/projectMagicContextEffectiveEnabled\s*\(([^)]*)/g)) {
        callSites += 1;
        const argument = match[1].trim();
        if (argument !== "runtimeConfig") {
          badArguments.push(`${relativePath}: projectMagicContextEffectiveEnabled(${argument}`);
        }
      }
      continue;
    }
    offenders.push(relativePath);
  }
  assert.deepEqual(
    offenders,
    [],
    "冷值投影只允许在 create-app.ts 使用（唯一允许的入参是 resolveAppRuntimeConfig 的返回值）：\n" +
      offenders.join("\n"),
  );
  assert.equal(
    callSites,
    1,
    `生产代码里冷值投影必须恰好调用一次（create-app.ts 装配点），实际 ${callSites} 处`,
  );
  assert.deepEqual(
    badArguments,
    [],
    "冷值投影的实参必须是 `runtimeConfig`——传 raw config 域会绕过 features kill switch：\n" +
      badArguments.join("\n"),
  );
});

/**
 * core 三处的调用必须**整段**长这样：首参是 `runtime.config.magicContext?.enabled`、次参
 * 显式声明缺省方向。旧断言只查文件里有没有 `whenUnset` 字面量，`isMagicContextEffectiveByConfig(true,
 * { whenUnset: false })` 这种把判定短路成常量的写法能混过去——所以这里连首参一起钉。
 */
function coreCallPattern(whenUnset) {
  return new RegExp(
    String.raw`isMagicContextEffectiveByConfig\(\s*runtime\.config\.magicContext\?\.enabled\s*,` +
      String.raw`\s*\{\s*whenUnset:\s*` +
      whenUnset +
      String.raw`\s*,?\s*\}\s*,?\s*\)`,
    "g",
  );
}

function assertCoreCallSite(file, whenUnset, note) {
  const source = readCoreSource(file);
  const allCalls = source.match(/isMagicContextEffectiveByConfig\s*\(/g) ?? [];
  const wellFormed = source.match(coreCallPattern(whenUnset)) ?? [];
  assert.ok(allCalls.length >= 1, `${file} 必须调用 isMagicContextEffectiveByConfig`);
  assert.equal(
    wellFormed.length,
    allCalls.length,
    `${file} 的每一处调用都必须形如 ` +
      `isMagicContextEffectiveByConfig(runtime.config.magicContext?.enabled, ` +
      `{ whenUnset: ${whenUnset} })（${note}）；` +
      `实际调用 ${allCalls.length} 处、合规 ${wellFormed.length} 处`,
  );
}

test("同源守卫：core 三处调用统一投影，缺省方向与历史语义一一对应", () => {
  assertCoreCallSite("runtime-tools.ts", false, "原 `=== true`，缺席按关");
  assertCoreCallSite("magic-context-prompt-section.ts", false, "原 `!== true`，缺席按关");
  assertCoreCallSite("magic-context-turn-transform.ts", true, "原 `=== false`，缺席按开");

  // G5（活值）与 G8（兜底否决）的结构不可合并：端口优先、config 只做否决。
  const turnTransform = readCoreSource("magic-context-turn-transform.ts");
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
  for (const file of SCAN.files) {
    const source = stripComments(readFileSync(file, "utf8"));
    if (/magic-context\/gate(?:\.js|\.ts)?["']/.test(source)) {
      offenders.push(relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `旧路径 magic-context/gate 仍被引用：${offenders.join(", ")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// N1：门控层零 MC 依赖
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `test-magic-context-absent-event.mjs` 的 `FACTORY_MODULE_ALLOWED_MARKERS` 放行了
 * `dist/app/magic-context/effective-enabled.js`（它在关闭态本来就该被解析），并在
 * 注释里声明「它自己不许 import MC 由本文件负责」——**这条不变量此前没有任何守卫**，
 * 等于放行条件裸奔：只要有人往门控层加一行 `import "@zcode/magic-context"`，关闭态
 * 就会把整棵 MC 图拉进启动路径（IM1），而 absent-event 那条守卫仍全绿（白名单直接
 * 跳过它）。这里把那句补偿声明变成可执行的断言。
 *
 * 判定同样是「剥注释 + 正则」（不做 AST，与全仓源码形状守卫同口径）：
 *   ① 静态值导入 / type-only 导入 / 窄子路径导入：`from "@zcode/magic-context…"`；
 *   ② 动态形态：`import("@zcode/magic-context…")` / `require("@zcode/magic-context…")`
 *      ——它们同样会在运行期解析包（调用期也算，门控层是同步求值的，没有「以后再
 *      import」的合法场景）。
 * 覆盖边界：正则不认类型别名与间接调用（`const p = "@zcode/" + "magic-context"`），
 * 这类写法靠评审兜住，与 spec `:339` 的守卫覆盖面一致。
 */
test("零依赖门控层：effective-enabled.ts 不 import @zcode/magic-context（N1）", () => {
  const source = readSource("app/magic-context/effective-enabled.ts");
  // `from "@zcode/magic-context…"`（值导入 / type-only / 窄子路径 / re-export），
  // 外加**副作用导入** `import "@zcode/magic-context"`——它没有 `from`，只匹配
  // `from` 会被这一种写法整个绕过。
  assert.ok(
    !/(?:from\s*|import\s*)["']@zcode\/magic-context/.test(source),
    "effective-enabled.ts 出现指向 `@zcode/magic-context…` 的导入：它是关闭态唯一被放行的" +
      "门控层（IM1 / spec :106），任何指向包的导入都会把 MC 模块图拉进关闭态，而 " +
      "test-magic-context-absent-event.mjs 的白名单不会报红",
  );
  assert.ok(
    !/\b(?:import|require)\s*\(\s*["']@zcode\/magic-context/.test(source),
    "effective-enabled.ts 出现指向 @zcode/magic-context 的动态 import()/require()：同上",
  );
});
