#!/usr/bin/env node
/**
 * magic-context-decoupling / phase-zero-load / Step 5 — adapters 配置装载面的
 * **窄子路径守卫**（spec 风险 3：「Step 5 先加仓内 import 守卫测试」）。
 *
 * ============================================================================
 * 为什么这个守卫必须存在（它守的不是风格）
 * ============================================================================
 *
 * `adapters/src/config/schema.ts` 的 `magicContextDomainSchema` 在**模块顶层**求值，
 * 而该模块由 `config/index.ts` 静态引入——配置装载是每次启动的必经路径，早于
 * `features.magicContext` 存在。所以这一行的导入形态直接决定「关闭态加载了多少
 * MC 模块」：
 *
 *   - `from "@zcode/magic-context"`（**barrel**）→ 整棵图（实测 231 个包内文件）；
 *   - `from "@zcode/magic-context/host/config/schema"`（窄子路径）→ 3 个文件 + zod。
 *
 * 而**顶层求值本身要保留**：字段级校验是 D-12 的既定决定（不复制第二份白名单），
 * 代价就是 M0 必然加载（spec IM1 因此写成「M0 白名单之外零加载」而不是「零模块」）。
 * 所以这里同时守两件相反方向的事：**导入必须是窄的**、**求值必须是顶层且存在的**。
 *
 * 端到端版本在 `bootstrap/scripts/test-magic-context-zero-load.mjs`（子进程 +
 * resolve hook 数模块）。本脚本是**秒级本地信号**：不建 dist、不起子进程，只做
 * 「剥注释 + 正则」的源码形状判定（与全仓源码形状守卫同口径，不做 AST）。
 *
 * 覆盖边界：正则只认字面形态。`const P = "@zcode/" + "magic-context"` 这类拼接
 * 绕过靠评审兜住。
 *
 * 运行：`pnpm --dir apps/zcode-cli/packages/adapters run test:magic-context-config-narrow`
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ADAPTERS_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ADAPTERS_SCHEMA = join(ADAPTERS_ROOT, "src/config/schema.ts");
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const MC_ROOT = join(REPO_ROOT, "apps/zcode-cli/packages/magic-context");
const MC_SCHEMA_SRC = join(MC_ROOT, "src/host/config/schema.ts");
const MC_LANGUAGE_SRC = join(MC_ROOT, "src/host/config/language.ts");
const MC_KEY_LEAF_SRC = join(MC_ROOT, "src/core/shared/prompt-surface-key.ts");
const MC_PACKAGE_JSON = join(MC_ROOT, "package.json");

/**
 * 剥注释后再判定（与 `bootstrap/scripts/test-magic-context-gate.mjs` 的
 * `stripComments` 逐字同款）：本仓库的 FORK 注释里大量出现 `@zcode/magic-context`
 * 字面量，不剥注释会让「有注释 = 有导入」这种假红/假绿出现。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * 字面量说明符的**所有**形态（ZL-3）。守卫只允许在这张表上做「加一条」，不允许
 * 在断言侧列举「我想到的写法」——旧守卫正是后者：只认 `import {` / `import(`，
 * 于是 `import x from "pkg"`、`import * as x from "pkg"`、`export … from "pkg"`
 * 三种形态全部漏检，而它们与被覆盖的形态没有任何语义差别。
 *
 *   `from "x"`      → import / import type / export … from / export * as ns from
 *   `import("x")`   → 动态 import（含 await）
 *   `require("x")`  → CommonJS / TS 的 import x = require("x")
 *   `import "x"`    → 副作用导入
 *
 * 覆盖边界照旧：只认字面量。`const P = "@zcode/" + "magic-context"` 这类拼接靠评审兜住。
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\b(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]/g,
  /\bimport\s*["']([^"']+)["']/g,
];

/** 收集源码里所有字面量说明符（保序、不去重——重复导入本身就该被看见）。 */
function importSpecifiers(source) {
  const specifiers = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** 收集源码里所有指向 MC 包的**字面量**说明符（值导入 / type-only / 动态 import / require）。 */
function magicContextSpecifiers(source) {
  return importSpecifiers(source).filter(
    (specifier) =>
      specifier === "@zcode/magic-context" || specifier.startsWith("@zcode/magic-context/"),
  );
}

const NARROW_SCHEMA = "@zcode/magic-context/host/config/schema";

test("adapters 配置 schema 只走窄子路径，不得出现 barrel 值导入（W1）", () => {
  assert.ok(existsSync(ADAPTERS_SCHEMA), `缺失 ${ADAPTERS_SCHEMA}`);
  const source = stripComments(readFileSync(ADAPTERS_SCHEMA, "utf8"));
  const specifiers = magicContextSpecifiers(source);
  assert.deepEqual(
    specifiers,
    [NARROW_SCHEMA],
    "adapters/src/config/schema.ts 必须**恰好**有一处、且只能是从窄子路径 " +
      `${NARROW_SCHEMA} 的导入；barrel（"@zcode/magic-context"）会把整棵 MC 图` +
      "（实测 231 个文件）拉进每次启动的配置装载路径，任何开关都拦不住（spec W1 / IM1）",
  );
});

test("adapters 配置 schema 的顶层求值必须保留（M0 必然加载是设计，不是回归）", () => {
  const source = stripComments(readFileSync(ADAPTERS_SCHEMA, "utf8"));
  const topLevel = source
    .split(/\r?\n/)
    .filter((line) => /^const magicContextDomainSchema\s*=/.test(line));
  assert.equal(
    topLevel.length,
    1,
    "`magicContextDomainSchema` 必须仍是**模块顶层**的 `const … = …`（缩进 0）。" +
      "把它挪进函数/改成惰性会让字段级校验在 ConfigPort 注册前缺席，" +
      "而 D-12 的 `.default()` 整域语义依赖它（spec `:65` / 风险 3）",
  );
  assert.match(
    topLevel[0],
    /MagicContextConfigSchema\.optional\(\)/,
    "顶层求值必须仍复用包内 schema（`.optional()`），不得复制第二份白名单",
  );
});

test("MC 包 exports 提供窄子路径，且三条件同构（Z1）", () => {
  const pkg = JSON.parse(readFileSync(MC_PACKAGE_JSON, "utf8"));
  const entry = pkg.exports?.["./host/config/schema"];
  assert.ok(
    entry,
    "magic-context/package.json 必须导出 `./host/config/schema`——缺了它，" +
      "adapters 的窄子路径导入会在运行期抛 ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
  assert.deepEqual(
    entry,
    {
      types: "./dist/host/config/schema.d.ts",
      import: "./dist/host/config/schema.js",
      require: "./dist/host/config/schema.js",
    },
    "窄子路径必须是 types/import/require 三条件同构对象（与 `.` 入口形态一致），" +
      "避免 verbatimModuleSyntax 下的邻接推断失败",
  );
});

test("MC schema 的 prompt_surface key 校验必须取自零依赖叶子（闭包 4 → 3，Z2）", () => {
  const schemaSource = stripComments(readFileSync(MC_SCHEMA_SRC, "utf8"));
  const relatives = [...schemaSource.matchAll(/\bfrom\s*["'](\.[^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    relatives.sort(),
    ["../../core/shared/prompt-surface-key.js", "./language.js"].sort(),
    "host/config/schema.ts 的相对导入必须只有 `./language.js` 与 " +
      "`../../core/shared/prompt-surface-key.js`。若出现 " +
      "`../../core/shared/prompt-surface.js`，闭包会连带 `harness-provider-map.js` " +
      "涨到 4 个文件（spec `:188` 点名的回归）",
  );

  // 叶子本身必须真的是零 import——否则「闭包塌到 3」只是把依赖挪了个位置。
  const leafSource = stripComments(readFileSync(MC_KEY_LEAF_SRC, "utf8"));
  assert.deepEqual(
    importSpecifiers(leafSource),
    [],
    "prompt-surface-key.ts 必须是零 import 叶子（spec `:45`：把 isValidPromptSurfaceModelKey " +
      "抽成零依赖叶子，否则窄子路径闭包降不到 2→3 个文件）。" +
      "旧守卫用 `/\\b(?:import|require)\\s*[({]/` 只认 `import {` / `import(`，" +
      "`import x from` / `import * as x` / `export … from` 全部漏检——收集器覆盖全部形态",
  );
});

// ══ ZL-3：M0 三文件的**外部 npm 依赖**守卫（包内文件计数看不见这一面）═════════
//
// `bootstrap/scripts/test-magic-context-zero-load.mjs` 只数「MC 包内文件」，对 M0 的
// 外部依赖完全没有约束：往 `language.ts` 加一行
// `import heavy from "some-heavy-npm-pkg"` 今天全绿，而它会在**每次启动**（早于任何
// 开关判定）被加载。所以 M0 的外部面必须由静态形状守卫钉住：
//
//   `host/config/language.ts`  —— 零 import（纯 Intl.DisplayNames，零依赖叶子）
//   `host/config/schema.ts`    —— 外部说明符**恰好** `["zod"]`
//   `core/shared/prompt-surface-key.ts` —— 零 import（上一条用例已断言）
//
// 判据用收集器（importSpecifiers），不是「列举我想到的写法」。

test("M0 language.ts 必须零 import（ZL-3：外部 npm 依赖无守卫）", () => {
  const source = stripComments(readFileSync(MC_LANGUAGE_SRC, "utf8"));
  assert.deepEqual(
    importSpecifiers(source),
    [],
    "host/config/language.ts 是 M0 三文件之一（关闭态每次启动必经），必须保持零 import。" +
      "任何外部 npm 包都会随配置装载一起加载，而零加载门禁只数包内文件，看不到这一层",
  );
});

test('M0 schema.ts 的非相对说明符必须恰好是 ["zod"]（ZL-3）', () => {
  const source = stripComments(readFileSync(MC_SCHEMA_SRC, "utf8"));
  const nonRelative = importSpecifiers(source).filter((specifier) => !specifier.startsWith("."));
  assert.deepEqual(
    nonRelative,
    ["zod"],
    "host/config/schema.ts 的外部依赖必须恰好是 zod（M0 闭包 = 3 文件 + zod 4.6.5）。" +
      "新增任何外部包都会进入每次启动的配置装载路径；它也不在零加载门禁的「包内文件」计数里，" +
      "所以必须在这里拦下",
  );
});
