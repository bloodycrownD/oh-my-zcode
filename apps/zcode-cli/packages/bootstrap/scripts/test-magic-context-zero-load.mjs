#!/usr/bin/env node
/**
 * mc-adapter-decoupling — flag off 时 bootstrap 入口不得拉起 MC 实现模块。
 *
 * ============================================================================
 * 这一步锁死的失效形态
 * ============================================================================
 *
 * `features.magicContext=false` 时 `create-app` 确实不 `import()` MC 工厂，但
 * **bootstrap 入口自身**（`dist/zcode-protocol-entrypoint.js` → `create-app` /
 * `zcode-protocol/server.ts`）曾经静态 import 了两条会拉起实现图的链：
 *
 *   - `zcode-protocol/magic-context-config.ts` → barrel `@zcode/magic-context`
 *     （barrel 的 `src/index.ts` 静态 re-export `storage-db` / `host/*` /
 *     `core/hooks/*`）；
 *   - `zcode-protocol/magic-context-memories.ts` → 同一 barrel 的实现值
 *     （`openDatabase` / `archiveProjectMemories` / …）。
 *
 * 于是 flag 关掉、transform 不构造，进程却仍然把整棵 MC 实现图（含 `node:sqlite`）
 * 拉进内存。修复＝前者改窄子路径 `@zcode/magic-context/host/config/schema`、
 * 后者把实现值改成 handler 内部 `await import()`。本脚本是该修复的长期守卫。
 *
 * ============================================================================
 * 判据（真实加载清单，不是源码字符串检查）
 * ============================================================================
 *
 * `registerHooks` 的 resolve 钩子记录**每一个**被解析到的 `file:` 模块；断言分三段：
 *
 *   T1 入口装载后，MC dist 里只有配置面（`host/config/schema` /
 *      `host/config/language` 与它们自己的纯函数依赖），**没有**实现模块：
 *      `storage-db*` / `core/hooks/*` / `host/*`（除上述两个配置面文件）。
 *   T2 关闭态下真实调用 `createMagicContextAdapter`（`features.magicContext=false`
 *      + `magicContext.enabled=true`，即「参数域想开、总开关关」这个最容易误开的
 *      组合）→ 返回 `undefined`、发一条 `transform_absent(reason=disabled)`，
 *      且加载清单**一条新模块都不增加**（动态 import 确实没发生）。
 *   T3 反例守卫：`features.magicContext=false` 时口径函数必须是 false，且
 *      `magicContext.enabled=false` 也必须压过 `features=true`——防止「门被写成
 *      恒 false」这种让 T1/T2 白过的假绿。
 *
 * 运行：`node --test scripts/test-magic-context-zero-load.mjs`
 * 前置构建：`@zcode/shared`、`@zcode/model-option-map`、`@zcode/magic-context`、
 * `@zcode/adapters`、`@zcode/contracts`、`@zcode/core` 与 bootstrap 自身 dist。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const MC_DIST_URL = pathToFileURL(`${REPO_ROOT}apps/zcode-cli/packages/magic-context/dist/`).href;
const BOOTSTRAP_DIST_URL = pathToFileURL(
  `${REPO_ROOT}apps/zcode-cli/packages/bootstrap/dist/`,
).href;
// 与同包其它测试同理：这些 workspace 包发布原始 TypeScript，裸 `node` 加载不了，
// 下面的 resolve 钩子把它们改指到同布局的 `dist/`。入口图比单个 handler 宽，
// 所以 provider / provider-node 也必须在这里（见 test-e2e-live-all.mjs 的同款清单）。
const TS_SOURCE_PACKAGES = new Set([
  "@zcode/shared",
  "@zcode/model-option-map",
  "@zcode/provider",
  "@zcode/provider-node",
]);

/** 本次 import 完整记录：任何被解析到的 file: 模块都进集合。 */
const loaded = new Set();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(`${specifier.split("/").slice(0, 2).join("/")}`)
        ? `${specifier.split("/").slice(0, 2).join("/")}`
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
        if (existsSync(candidate)) {
          const result = { url: pathToFileURL(candidate).href, shortCircuit: true };
          loaded.add(result.url);
          return result;
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    const result = nextResolve(specifier, context);
    if (typeof result?.url === "string" && result.url.startsWith("file:")) {
      loaded.add(result.url);
    }
    return result;
  },
});

/** MC dist 内已加载模块（相对 `magic-context/dist/`，排序后稳定）。 */
function mcModules() {
  return [...loaded]
    .filter((url) => url.startsWith(MC_DIST_URL))
    .map((url) => url.slice(MC_DIST_URL.length))
    .sort();
}

/**
 * flag off 的配置面允许出现的 MC 模块**全集**（相对 `magic-context/dist/`）。
 * 刻意写成白名单：MC 侧给配置面新增依赖时这里会红，让改动者显式确认新依赖仍在
 * 「纯配置」平面上，而不是把实现模块悄悄带回来。
 */
const EXPECTED_MC_MODULES = [
  "core/shared/harness-provider-map.js",
  "core/shared/prompt-surface.js",
  "host/config/language.js",
  "host/config/schema.js",
];

/**
 * 实现模块判据（与本任务验收口径逐字对应）：`storage-db` / `core/hooks/*` /
 * `host/*`（除 `host/config/schema` 与 `host/config/language`）。barrel
 * `index.js` 也算——它静态 re-export 全部实现，被加载即等价于实现图被拉起。
 */
const CONFIG_ONLY_MC_MODULES = new Set(["host/config/schema.js", "host/config/language.js"]);

function isImplementationModule(modulePath) {
  if (modulePath === "index.js") return true;
  if (/^core\/hooks\//.test(modulePath)) return true;
  if (/(^|\/)storage-db(\/|\.|$)/.test(modulePath)) return true;
  return /^host\//.test(modulePath) && !CONFIG_ONLY_MC_MODULES.has(modulePath);
}

// 动态 import：resolve 钩子必须先于被测模块的依赖图求值注册。
// `zcode-protocol-entrypoint` 是真正的 bootstrap 入口（CLI 进程第一步加载它）；
// `index.js` 是包公共面（embedder 形态）。两个都进装载面。
await import("../dist/zcode-protocol-entrypoint.js");
await import("../dist/index.js");

const mcModulesAfterEntryImport = mcModules();

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — bootstrap entry does not pull the magic-context implementation graph"
      : `TEST FAIL — bootstrap entry loading (exit code ${code})`,
  );
});

test("T1 入口装载后：MC 侧只有配置面，零实现模块", () => {
  const implementation = mcModulesAfterEntryImport.filter(isImplementationModule);
  assert.deepEqual(
    implementation,
    [],
    `flag off 时不应加载 MC 实现模块（barrel → storage-db / host/* / core/hooks/*）：\n${implementation.join("\n")}`,
  );
  assert.deepEqual(
    mcModulesAfterEntryImport,
    EXPECTED_MC_MODULES,
    `MC 配置面装载清单变化，请确认新依赖仍在纯配置平面：\n${mcModulesAfterEntryImport.join("\n")}`,
  );
});

test("T2 关闭态真实装配：适配器返回 undefined、发 disabled 事件、零新加载", async () => {
  const { createMagicContextAdapter, resolveMagicContextEffectiveEnabled } =
    await import("../dist/app/magic-context/adapter.js");
  const warnings = [];
  const logger = {
    debug() {},
    info() {},
    warn(message, context) {
      warnings.push({ message, context });
    },
    error() {},
  };

  const before = mcModules();
  const adapter = await createMagicContextAdapter(
    // 最容易误开的组合：参数域 enabled=true，总开关 features.magicContext=false。
    { features: { magicContext: false }, magicContext: { enabled: true } },
    { sessionId: "zero-load", workingDirectory: REPO_ROOT, logger },
  );
  const after = mcModules();

  assert.equal(adapter, undefined, "总开关关闭时适配器必须是 undefined");
  assert.equal(
    resolveMagicContextEffectiveEnabled({
      features: { magicContext: false },
      magicContext: { enabled: true },
    }),
    false,
    "features.magicContext=false 必须压过 magicContext.enabled=true",
  );
  assert.deepEqual(
    after,
    before,
    `关闭态装配不得加载任何新模块（动态 import 必须被门挡住）：\n新增：${after
      .filter((modulePath) => !before.includes(modulePath))
      .join("\n")}`,
  );
  const absent = warnings.find(
    (entry) => entry.context?.event === "magic_context.transform_absent",
  );
  assert.ok(absent, "关闭态必须留下 transform_absent 事件（生产侧唯一 disabled 发射点）");
  assert.equal(absent.context?.reason, "disabled");
  assert.equal(absent.context?.module, "bootstrap");
});

test("T3 反例守卫：口径函数不是恒 false，两处开关各自能关掉", async () => {
  const { resolveMagicContextEffectiveEnabled } = await import("../dist/app/magic-context/gate.js");
  assert.equal(resolveMagicContextEffectiveEnabled(undefined), false);
  assert.equal(resolveMagicContextEffectiveEnabled({}), true);
  assert.equal(
    resolveMagicContextEffectiveEnabled({ features: { magicContext: true } }),
    true,
    "features 开、参数域缺席（schema 缺省 true）必须判开",
  );
  assert.equal(
    resolveMagicContextEffectiveEnabled({
      features: { magicContext: true },
      magicContext: { enabled: false },
    }),
    false,
    "magicContext.enabled=false 必须能关掉",
  );
  assert.equal(
    resolveMagicContextEffectiveEnabled({
      features: { magicContext: false },
      magicContext: { enabled: false },
    }),
    false,
  );
});

// 放在装载断言之后：确认入口图里没有任何「看起来加载了但其实是空壳」的情况——
// 装配层的动态 import 目标在关闭态下确实不在装载清单里。
test("T4 入口图里没有装配门后的 facade（`app/magic-context-turn-transform.js`）", () => {
  const facade = [...loaded].filter((url) =>
    url.startsWith(`${BOOTSTRAP_DIST_URL}app/magic-context-turn-transform.js`),
  );
  assert.deepEqual(facade, [], "关闭态下 facade 不得被静态装载（它只能经适配器动态 import）");
});
