#!/usr/bin/env node
/**
 * mc-adapter-decoupling — flag off 时 adapters 配置面不得拉起 MC 实现模块。
 *
 * ============================================================================
 * 这一步锁死的失效形态
 * ============================================================================
 *
 * `features.magicContext=false` 时 bootstrap 侧确实不 `import()` MC 工厂，但
 * `@zcode/adapters/config` 在**进程启动的无条件装载链**上（bootstrap 的
 * `createConfig` / `loadFileConfig` 静态引入）。它曾经静态 import 包的 barrel
 * `@zcode/magic-context`，而 barrel 的 `src/index.ts` 静态 re-export 了
 * `storage-db` / `host/*` / `core/hooks/*`——于是 flag 关掉、transform 不构造，
 * 进程却仍然把 231 个 MC 模块（其中 92 个实现模块，含 `node:sqlite`）拉进内存。
 *
 * 修复＝本包 `src/config/schema.ts` 改走窄子路径
 * `@zcode/magic-context/host/config/schema`，barrel 不被求值。本脚本是该修复的
 * 长期守卫：只 import 本包编译产物 `dist/config/schema.js`，断言 MC 侧只出现
 * schema 自身与它的两个纯函数依赖。
 *
 * 覆盖范围说明：本脚本只测 **adapters 配置链**。bootstrap 侧的另一条链
 * （`zcode-protocol/magic-context-config.ts` 与 `magic-context-memories.ts`）已在
 * commit 32f205b7 一并收敛（前者走同一窄子路径，后者实现值改 handler 内动态 import），
 * 进程级装载清单由 `bootstrap/scripts/test-magic-context-zero-load.mjs` 守卫。
 *
 * 运行：`node --test scripts/test-magic-context-config-lazy.mjs`
 * （先 `pnpm --filter @zcode/magic-context build`、`pnpm --filter @zcode/adapters build`。）
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const MC_DIST_URL = pathToFileURL(`${REPO_ROOT}apps/zcode-cli/packages/magic-context/dist/`).href;
// 与同包其它测试同理：这几个 workspace 包发布原始 TypeScript，裸 `node` 加载不了，
// 下面的 resolve 钩子把它们改指到同布局的 `dist/`。
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

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

// 动态 import：resolve 钩子必须先于被测模块的依赖图求值注册。
const schemaModule = await import("../dist/config/schema.js");

/**
 * flag off 的配置面允许出现的 MC 模块**全集**（相对 `magic-context/dist/`）。
 * 刻意写成白名单：MC 侧给 schema 新增依赖时这里会红，让改动者显式确认新依赖
 * 仍在「纯配置」平面上，而不是把实现模块悄悄带回来。
 */
const EXPECTED_MC_MODULES = [
  "core/shared/harness-provider-map.js",
  "core/shared/prompt-surface.js",
  "host/config/language.js",
  "host/config/schema.js",
];

const mcModulesAfterSchemaImport = [...loaded]
  .filter((url) => url.startsWith(MC_DIST_URL))
  .map((url) => url.slice(MC_DIST_URL.length))
  .sort();

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — adapters config schema does not pull the magic-context implementation graph"
      : `TEST FAIL — adapters config schema loading (exit code ${code})`,
  );
});

test("只 import config schema：MC 侧只加载配置面四件（barrel 不被求值）", () => {
  const implementationLike = mcModulesAfterSchemaImport.filter(
    (modulePath) =>
      modulePath === "index.js" ||
      /^core\/(hooks|features|tools|deferred|agents)\//.test(modulePath) ||
      (/^host\//.test(modulePath) && !modulePath.startsWith("host/config/")),
  );
  assert.deepEqual(
    implementationLike,
    [],
    `flag off 时不应加载 MC 实现模块（barrel → storage-db / host/* / core/hooks/*）：\n${implementationLike.join("\n")}`,
  );
  assert.deepEqual(
    mcModulesAfterSchemaImport,
    EXPECTED_MC_MODULES,
    `MC 配置面装载清单变化，请确认新依赖仍在纯配置平面：\n${mcModulesAfterSchemaImport.join("\n")}`,
  );
});

test("窄子路径拿到的是真 schema：默认值与校验语义与包内一致", () => {
  // 反例守卫：不能靠「import 到空壳 / 被 tree-shaking 掉的假 schema」蒙过装载断言。
  assert.deepEqual(
    schemaModule.DEFAULT_MAGIC_CONTEXT_CONFIG,
    schemaModule.MagicContextConfigSchema.parse({}),
  );
  assert.equal(schemaModule.DEFAULT_MAGIC_CONTEXT_CONFIG.cache_ttl, "5m");
  assert.equal(schemaModule.DEFAULT_MAGIC_CONTEXT_CONFIG.execute_threshold_percentage, 65);
  assert.equal(
    schemaModule.ZCodeConfigFileSchema.safeParse({
      magicContext: { execute_threshold_percentage: 91 },
    }).success,
    false,
  );
  assert.equal(
    schemaModule.ZCodeConfigFileSchema.safeParse({ magicContext: { protected_tokens: 3999 } })
      .success,
    false,
  );
  assert.equal(schemaModule.ZCodeConfigFileSchema.safeParse({ magicContext: 42 }).success, false);
});

// 放在装载断言之后：本测试会 import barrel，把整棵实现图拉起来——
// 这正是上面那条断言要证明「flag off 时不会发生」的事，因此必须先取快照。
test("窄子路径与 barrel 是同一个模块实例（引用同一性不因绕开 barrel 而改变）", async () => {
  const barrel = await import("@zcode/magic-context");
  assert.equal(barrel.MagicContextConfigSchema, schemaModule.MagicContextConfigSchema);
  assert.equal(barrel.DEFAULT_MAGIC_CONTEXT_CONFIG, schemaModule.DEFAULT_MAGIC_CONTEXT_CONFIG);
});
