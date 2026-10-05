#!/usr/bin/env node
/**
 * Step 23 — `magicContext` 参数域验收测试（D-12 配置真源 + 热生效判据）。
 *
 * 覆盖 spec Step 23 点名的映射项，锚点沿用 Step 19a（`features.magicContext`）的
 * 七处手写映射范式：
 *   1. contracts `ConfigKey.MagicContext`
 *   2. contracts `ConfigValue<"magicContext">` 分支（类型层不可运行时观测，改为
 *      断言它的可观测投影：key 在 `ConfigKey` 里 + `has()` 命中默认域登记）
 *   3. contracts `RuntimeConfig.magicContext` / `RuntimeConfigPatch.magicContext`
 *   4. adapters `ZCodeConfigFileSchema.magicContext`（直接复用包内 schema）
 *   5. adapters `ConfigStore.merge()` 整域透传
 *   6. adapters `getAll()` 默认域
 *   7. adapters `getDefaultValue()` 登记
 *   8. `updateMagicContextInFileConfig`：幂等 + 保留其余顶层键
 *   9. **热生效判据**（spec Step 16）：改 ConfigPort 后**下一读**拿到新值，无需重启
 *
 * 第 9 项用的是**真实的** `ConfigPortImpl` 与**真实的** `createConfigBridge`
 * （包内 dist），不是 mock：这条判据的全部价值就在于「ConfigPort 的 observe 扇出
 * 与 bridge 的 digest 短路能不能对上」，用 mock 验等于把要测的东西换掉。
 *
 * Runs on `node:test`（本仓无 vitest/jest），import 编译产物 `dist/`——
 * 先 `pnpm --filter @zcode/magic-context build`、`pnpm --filter @zcode/contracts build`、
 * `pnpm --filter @zcode/adapters build`。
 *
 * 与 `test-feature-flag.mjs` 同理，几个 workspace 包发布的是原始 TypeScript，
 * 裸 `node` 加载不了；下面的 resolve 钩子把它们改指到同布局的 `dist/`。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

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
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

// 动态 import：resolve 钩子必须先于被测模块的依赖图求值注册。
const { ConfigKey, ConfigScope } = await import("@zcode/contracts");
const {
  ConfigPortImpl,
  createConfigPort,
  updateMagicContextInFileConfig,
} = await import("../dist/config/index.js");
const {
  DEFAULT_MAGIC_CONTEXT_CONFIG,
  MagicContextConfigSchema,
  ZCodeConfigFileSchema,
  parseConfigFileToRuntimePatchWithDiagnostics,
} = await import("../dist/config/schema.js");
// 「热生效」这一侧是包内 bridge：与 bootstrap 装配层用的是同一个对象。
const { createConfigBridge } = await import("@zcode/magic-context");

// Printed from the exit handler, not `after()`: the node:test `after` hook runs
// before the runner has assigned the exit code, so it would always report PASS.
process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — magicContext parameter domain (D-12 mapping + persistence + hot reload)"
      : `TEST FAIL — magicContext parameter domain (exit code ${code})`,
  );
});

const DEFAULT_EXECUTOR = { execute_threshold_percentage: 65 };

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-mc-domain-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf-8"));
}

// ── mappings 1 / 3 / 7 ───────────────────────────────────────────────────────

test("mapping 1: ConfigKey.MagicContext is the top-level config.json domain key", () => {
  assert.equal(ConfigKey.MagicContext, "magicContext");
});

test("mapping 2: ConfigValue<\"magicContext\"> is the unknown tail, pinned by the key", () => {
  // contracts 的 `ConfigValue<K>` 是一条以 `unknown` 收尾的条件类型链，
  // `"magicContext"` 走的就是这个兜底（它曾有一个与兜底同值的恒等分支，已删——
  // 见 contracts `src/config/index.ts` 的登记注释）。类型层不可运行时观测，能观测的
  // 是它的**投影**：key 必须在 `ConfigKey` 里（否则整条链都够不着它），且
  // `RuntimeConfigPatch.magicContext` 也声明为 `unknown` 承载。
  assert.equal(ConfigKey.MagicContext, "magicContext");
  assert.equal(Object.values(ConfigKey).includes("magicContext"), true);
  // `getDefaultValue` 的登记面：key 可被 `has()` 命中，说明它确实走的是
  // 「已登记的 key → 取默认域」这条路径，而不是落进未登记的 undefined 兜底。
  const port = createConfigPort();
  assert.equal(port.has(ConfigKey.MagicContext), true);
  assert.notEqual(port.get(ConfigKey.MagicContext), undefined);
  // 兜底是 `unknown` 而不是 `any`：`any` 会让下游 `get()` 的结果丢掉一切检查。
  // 运行时不可区分，但至少确认值仍然是对象而不是被展开的原始值。
  assert.equal(typeof port.get(ConfigKey.MagicContext), "object");
});

test("mapping 3: RuntimeConfigPatch.magicContext round-trips through the file patch", () => {
  const { config } = parseConfigFileToRuntimePatchWithDiagnostics({
    magicContext: { enabled: false, protected_tokens: 8000 },
  });
  // 解析后的值一定已被包内 schema 补齐成**完整域**（整域替换的前提）。
  assert.equal(config.magicContext.enabled, false);
  assert.equal(config.magicContext.protected_tokens, 8000);
  assert.equal(config.magicContext.historian.model, undefined);
  assert.deepEqual(config.magicContext.fallback_models, undefined);
  assert.equal(typeof config.magicContext.cache_ttl, "string");
});

test("mapping 4: config file schema rejects out-of-range magicContext values", () => {
  // execute_threshold_percentage 上限 90（EXECUTE_THRESHOLD_CAP_MESSAGE）。
  assert.equal(
    ZCodeConfigFileSchema.safeParse({ magicContext: { execute_threshold_percentage: 91 } }).success,
    false,
  );
  assert.equal(
    ZCodeConfigFileSchema.safeParse({ magicContext: { execute_threshold_percentage: 20 } }).success,
    true,
  );
  // protected_tokens 下限 PROTECTED_TOKENS_MIN = 4000。
  assert.equal(
    ZCodeConfigFileSchema.safeParse({ magicContext: { protected_tokens: 3999 } }).success,
    false,
  );
  // language 是 2 字母 ISO 639-1。
  assert.equal(ZCodeConfigFileSchema.safeParse({ magicContext: { language: "zh" } }).success, true);
  assert.equal(ZCodeConfigFileSchema.safeParse({ magicContext: { language: "zho" } }).success, false);
  // 顶层不是对象时整体拒绝（不是「静默忽略」）。
  assert.equal(ZCodeConfigFileSchema.safeParse({ magicContext: 42 }).success, false);
  assert.equal(ZCodeConfigFileSchema.safeParse({ magicContext: "on" }).success, false);
});

test("mapping 4: fork-excluded keys are stripped rather than carried to runtime", () => {
  // `compaction.*` 在本 fork 无意义（D-7 已移除原生压缩）。留在 config 里会让
  // 「文件里有、运行时不认」持续误导读者，所以解析阶段就剥掉。
  const { config } = parseConfigFileToRuntimePatchWithDiagnostics({
    magicContext: { enabled: true, compaction: { enabled: true, threshold: 0.5 } },
  });
  assert.equal("compaction" in config.magicContext, false);
});

test("mapping 4: absent magicContext stays absent so the default wins", () => {
  const { config } = parseConfigFileToRuntimePatchWithDiagnostics({ features: {} });
  assert.equal("magicContext" in config, false);
});

// ── mappings 6 / 7 ───────────────────────────────────────────────────────────

test("mapping 6/7: unset domain resolves to DEFAULT_MAGIC_CONTEXT_CONFIG", () => {
  for (const port of [createConfigPort(), createConfigPort({}), new ConfigPortImpl()]) {
    assert.deepEqual(port.get(ConfigKey.MagicContext), DEFAULT_MAGIC_CONTEXT_CONFIG);
    assert.deepEqual(port.getAll().magicContext, DEFAULT_MAGIC_CONTEXT_CONFIG);
    assert.equal(port.has(ConfigKey.MagicContext), true);
  }
});

test("mapping 7: DEFAULT_MAGIC_CONTEXT_CONFIG is the package's own parse of {}", () => {
  // 防「adapters 侧写了第二份默认值」的回归：默认域必须与包内 `.default()` 逐字段相同。
  assert.deepEqual(DEFAULT_MAGIC_CONTEXT_CONFIG, MagicContextConfigSchema.parse({}));
  assert.equal(DEFAULT_MAGIC_CONTEXT_CONFIG.execute_threshold_percentage, 65);
  assert.equal(DEFAULT_MAGIC_CONTEXT_CONFIG.history_budget_percentage, 0.15);
  assert.equal(DEFAULT_MAGIC_CONTEXT_CONFIG.cache_ttl, "5m");
});

// MF-21：上面那条 `deepEqual` 只证明「值相同」，不证明「是同一个对象」——
// adapters 若哪天改成 `{ ...DEFAULT }` 或重新 parse 一份，值照样相等，但
// `DEFAULT_MAGIC_CONTEXT_CONFIG === <包内那个>` 的引用同一性就断了。引用同一性
// 是 packages/adapters/src/config/schema.ts:332-336 那段 re-export 注释承诺的
// （「调用方取到的是与包内运行时**同一个对象**」），这里把它钉住。
test("MF-21: adapters re-export IS the package's own object (identity, not just equality)", async () => {
  const pkg = await import("@zcode/magic-context");
  assert.equal(pkg.DEFAULT_MAGIC_CONTEXT_CONFIG, DEFAULT_MAGIC_CONTEXT_CONFIG);
  assert.equal(pkg.MagicContextConfigSchema, MagicContextConfigSchema);
  // 同一性成立，则对 adapters 这份做的 parse 与对包内那份做的 parse 走的是同一条
  // 校验管线（zod schema 身份比较成立），运行时 schema 比对不会分叉。
  assert.equal(
    MagicContextConfigSchema.parse({ cache_ttl: "1h" }).cache_ttl,
    pkg.MagicContextConfigSchema.parse({ cache_ttl: "1h" }).cache_ttl,
  );
});

// ── mapping 5 ────────────────────────────────────────────────────────────────

test("mapping 5: merge() passes the whole domain through and notifies observers", () => {
  const port = createConfigPort({});
  const seen = [];
  port.observe().subscribe(ConfigKey.MagicContext, (value) => seen.push(value));

  const next = MagicContextConfigSchema.parse({ ...DEFAULT_EXECUTOR, protected_tokens: 9000 });
  port.merge({ magicContext: next }, ConfigScope.User);

  assert.deepEqual(seen, [next]);
  assert.deepEqual(port.get(ConfigKey.MagicContext), next);
  assert.deepEqual(port.getAll().magicContext, next);
});

test("mapping 5: a merge that omits the domain leaves the previous value intact", () => {
  const configured = MagicContextConfigSchema.parse({ protected_tokens: 9000 });
  const port = createConfigPort({ magicContext: configured });
  port.merge({ features: { magicContext: true } }, ConfigScope.Project);
  assert.deepEqual(port.getAll().magicContext, configured);
});

// ── mapping 8: updateMagicContextInFileConfig ────────────────────────────────

test("mapping 8: patch writes the domain at the top level and preserves every other key", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        $schema: "https://example.invalid/config.json",
        ui: { locale: "zh-CN", theme: "dark" },
        features: { magicContext: true },
        plugins: { enabledPlugins: { "a@x": true } },
      }),
      "utf-8",
    );

    const result = await updateMagicContextInFileConfig(path, DEFAULT_MAGIC_CONTEXT_CONFIG);
    assert.equal(result.changed, true);
    assert.equal(result.path, path);

    const onDisk = await readJson(path);
    assert.deepEqual(onDisk.magicContext, DEFAULT_MAGIC_CONTEXT_CONFIG);
    assert.equal(onDisk.$schema, "https://example.invalid/config.json");
    assert.deepEqual(onDisk.ui, { locale: "zh-CN", theme: "dark" });
    assert.deepEqual(onDisk.features, { magicContext: true });
    assert.deepEqual(onDisk.plugins, { enabledPlugins: { "a@x": true } });
  });
});

test("mapping 8: patch is idempotent — rewriting identical content does not touch the file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json");
    await updateMagicContextInFileConfig(path, DEFAULT_MAGIC_CONTEXT_CONFIG);
    const before = await readJson(path);

    const second = await updateMagicContextInFileConfig(path, DEFAULT_MAGIC_CONTEXT_CONFIG);
    assert.equal(second.changed, false);
    assert.deepEqual(await readJson(path), before);

    // 键序不同但内容相同 → 仍判定为未改动（比较是深比较，不是字符串比较）。
    const reordered = Object.fromEntries(Object.entries(DEFAULT_MAGIC_CONTEXT_CONFIG).reverse());
    assert.equal((await updateMagicContextInFileConfig(path, reordered)).changed, false);

    // 内容真变了 → changed:true。
    const next = MagicContextConfigSchema.parse({ protected_tokens: 9000 });
    assert.equal((await updateMagicContextInFileConfig(path, next)).changed, true);
    assert.deepEqual((await readJson(path)).magicContext, next);
  });
});

test("mapping 8: patch creates the file when it does not exist yet", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "nested", "config.json");
    const result = await updateMagicContextInFileConfig(path, DEFAULT_MAGIC_CONTEXT_CONFIG);
    assert.equal(result.changed, true);
    assert.deepEqual((await readJson(path)).magicContext, DEFAULT_MAGIC_CONTEXT_CONFIG);
  });
});

// ── mapping 9: hot reload (spec Step 16 acceptance criterion) ─────────────────

/**
 * 与 `bootstrap/src/app/magic-context-turn-transform.ts` 里 `createConfigSource`
 * 逐字对应的 source 装配。此处重复三行是有意的：它就是被判据约束的那段接线，
 * 复制到测试里才能在不起 CLI 的前提下验证「observe 扇出 → bridge bump」这条路。
 */
function createConfigSource(configPort) {
  return {
    read: () => configPort.get(ConfigKey.MagicContext),
    subscribe: (listener) => configPort.observe().subscribe(ConfigKey.MagicContext, () => listener()),
  };
}

test("mapping 9: ConfigPort.set is visible on the bridge's next read, no restart", () => {
  const configPort = createConfigPort({});
  const bridge = createConfigBridge(createConfigSource(configPort));

  const initial = bridge.getSnapshot();
  assert.equal(initial.generation, 1);
  assert.deepEqual(initial.effective, DEFAULT_MAGIC_CONTEXT_CONFIG);

  // ── 写入一个新值：不调 refresh、不重建任何东西 ──
  const next = MagicContextConfigSchema.parse({
    execute_threshold_percentage: 45,
    protected_tokens: 12000,
    historian: { model: "zcode/glm-4.6" },
  });
  configPort.set(ConfigKey.MagicContext, next);

  // observe 的扇出是同步的：set 返回时 bridge 已经 bump 过。
  const after = bridge.getSnapshot();
  assert.equal(after.generation, 2, "ConfigPort.observe 的扇出必须 bump generation");
  assert.deepEqual(after.effective, next);
  assert.equal(after.effective.protected_tokens, 12000);
  assert.equal(after.effective.historian.model, "zcode/glm-4.6");
  assert.deepEqual(bridge.getChangedKeys().sort(), [
    "execute_threshold_percentage",
    "historian.model",
    "protected_tokens",
  ]);

  // 下一读拿到新值 —— 不需要任何重建/刷新调用。
  assert.equal(bridge.getSnapshot().effective.protected_tokens, 12000);

  // 退订后不再收到推送（observe 的返回值直传给了 source）。
  const unsubscribe = configPort.observe().subscribe(ConfigKey.MagicContext, () => {
    throw new Error("unsubscribed listener must not be called");
  });
  unsubscribe();
  configPort.set(
    ConfigKey.MagicContext,
    MagicContextConfigSchema.parse({ protected_tokens: 13000 }),
  );
  assert.equal(bridge.getSnapshot().effective.protected_tokens, 13000);
});

test("mapping 9: an identical write is a digest no-op (no spurious generation bump)", () => {
  const configPort = createConfigPort({});
  const bridge = createConfigBridge(createConfigSource(configPort));
  const generation = bridge.getSnapshot().generation;

  configPort.set(ConfigKey.MagicContext, DEFAULT_MAGIC_CONTEXT_CONFIG);
  assert.equal(bridge.getSnapshot().generation, generation);

  const next = MagicContextConfigSchema.parse({ protected_tokens: 9000 });
  configPort.set(ConfigKey.MagicContext, next);
  assert.equal(bridge.getSnapshot().generation, generation + 1);
});

test("mapping 9: a malformed domain keeps last-known-good instead of disabling the feature", () => {
  const configPort = createConfigPort({});
  const failures = [];
  const bridge = createConfigBridge(createConfigSource(configPort), {
    onReloadFailure: (failure) => failures.push(failure.error),
  });
  const good = MagicContextConfigSchema.parse({ protected_tokens: 9000 });
  configPort.set(ConfigKey.MagicContext, good);

  // ConfigPort.set 不做校验（这是 S16 的结构匹配点：read 返回未校验原始值）。
  configPort.set(ConfigKey.MagicContext, { execute_threshold_percentage: 999 });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^execute_threshold_percentage: /);
  assert.match(failures[0], /capped at 90%/);
  assert.equal(bridge.getSnapshot().effective.protected_tokens, 9000);
  assert.equal(bridge.getSnapshot().generation, 2);
});

test("mapping 9: dispose() unsubscribes from ConfigPort (no leak across app teardown)", () => {
  const configPort = createConfigPort({});
  const bridge = createConfigBridge(createConfigSource(configPort));
  const generation = bridge.getSnapshot().generation;
  bridge.dispose();

  configPort.set(
    ConfigKey.MagicContext,
    MagicContextConfigSchema.parse({ protected_tokens: 9000 }),
  );
  assert.equal(bridge.getSnapshot().generation, generation);
});