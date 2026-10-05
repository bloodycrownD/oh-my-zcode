#!/usr/bin/env node
/**
 * Step 19a acceptance tests — features.magicContext gating chain (D-11).
 *
 * Covers the 7 hand-written mappings the feature flag needs, anchored on
 * `features.rewind` as the template (`features.compact` was the original
 * template and was removed together with the compaction subsystem in step 26):
 *   1. contracts ConfigKey.FeatureMagicContext
 *   2. contracts ConfigValue<K> boolean branch (miss -> silent `unknown`)
 *   3. contracts RuntimeConfig["features"].magicContext
 *   4. adapters featuresSchema.magicContext
 *   5. adapters ConfigStore.merge() passthrough
 *   6. adapters getAll() default  <-- now `?? true` again, matching its neighbours
 *   7. DefaultRuntimeConfig + getDefaultValue() both `true`
 *
 * Step 28 flipped 6/7 from `false` to `true` once D-11's gates (MVP acceptance
 * T-M1..T-M8 plus the compaction-removal full regression) passed. `false` is no
 * longer the absent-config value; it is the user's explicit opt-out, and the
 * suites below still cover it as such.
 *
 * Runs on `node:test` (no vitest/jest in this repo), importing the compiled
 * `dist/` — run `pnpm --filter @zcode/adapters build` first.
 *
 * Several workspace packages (`@zcode/shared`, `@zcode/model-option-map`, ...)
 * publish raw TypeScript as their entry points, so plain `node` cannot load
 * them: internal `.js` specifiers do not remap to `.ts`, and strip-only mode
 * rejects parameter properties. Each ships a compiled `dist/` with the same
 * layout, so the resolve hook below redirects them there — keeping the test
 * dependency-free, with no experimental loader flags and no stubbed code.
 *
 * Exits 0 when every test passes, 1 otherwise.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
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
        if (existsSync(candidate))
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

// Dynamic imports: the resolve hook above must be registered before the
// adapters config barrel (and its `@zcode/shared` chain) is evaluated.
const { ConfigKey, ConfigScope, DefaultRuntimeConfig } = await import("@zcode/contracts");
const { createConfigPort } = await import("../dist/config/index.js");
const { ZCodeConfigFileSchema, parseConfigFileToRuntimePatchWithDiagnostics } =
  await import("../dist/config/schema.js");

// Printed from the exit handler, not `after()`: the node:test `after` hook runs
// before the runner has assigned the exit code, so it would always report PASS.
process.on("exit", (code) => {
  const passed = code === 0;
  console.log("");
  console.log(
    passed
      ? "TEST PASS — features.magicContext gating chain (D-11 default on)"
      : `TEST FAIL — features.magicContext gating chain (exit code ${code})`,
  );
});

test("mapping 1/3/7: ConfigKey + RuntimeConfig + DefaultRuntimeConfig register magicContext", () => {
  assert.equal(ConfigKey.FeatureMagicContext, "features.magicContext");
  assert.equal("magicContext" in DefaultRuntimeConfig.features, true);
});

test("mapping 7: DefaultRuntimeConfig.features.magicContext defaults to true (step 28)", () => {
  assert.equal(DefaultRuntimeConfig.features.magicContext, true);
});

test("mapping 4/5/6: empty config merge keeps magicContext on", () => {
  const config = createConfigPort({});
  // Empty patch at the highest scope must not resurrect the flag either way.
  config.merge({}, ConfigScope.Cli);
  assert.equal(config.getAll().features.magicContext, true);
});

test("mapping 6: getAll() default is true, matching its `?? true` neighbours", () => {
  // `createConfigPort({})` leaves the store empty, so getAll() must take the
  // literal fallback. `createConfigPort()` instead seeds DefaultConfig into the
  // store and would never reach it — the fallback must be caught here.
  const features = createConfigPort({}).getAll().features;
  assert.equal(features.magicContext, true);
  // Guard the neighbours: magicContext joining them must not have shifted any.
  assert.equal(features.rewind, true);
  assert.equal(features.mcp, true);
  // Same fallback path via the fully-defaulted port.
  assert.equal(createConfigPort().getAll().features.magicContext, true);
});

// MF-19：mapping 2 在本仓有两处同名条目（feature flag 侧在这里、参数域侧在
// test-magic-context-domain.mjs），两侧各钉一半——这里钉「两个 key 是不同的 key」。
// D-11 的开关是 `features.magicContext`（一级 boolean），D-12 的参数域是顶层
// `magicContext`（整域对象）；它们曾经只差一个 `features.` 前缀。哪次「顺手统一」
// 把其中一个删掉或改名，另一个会静默接管它的语义，而两处断言都还在绿。
test("mapping 2: the feature flag key and the parameter-domain key are distinct", () => {
  assert.equal(ConfigKey.FeatureMagicContext, "features.magicContext");
  assert.equal(ConfigKey.MagicContext, "magicContext");
  assert.notEqual(ConfigKey.FeatureMagicContext, ConfigKey.MagicContext);
  // 两者的运行时投影也必须分开：一个 boolean，一个对象。
  const port = createConfigPort();
  assert.equal(typeof port.get(ConfigKey.FeatureMagicContext), "boolean");
  assert.equal(typeof port.get(ConfigKey.MagicContext), "object");
});

test("mapping 2/5: get(ConfigKey.FeatureMagicContext) falls back to the registered default", () => {
  const config = createConfigPort();
  assert.equal(config.get(ConfigKey.FeatureMagicContext), true);
  assert.equal(config.has(ConfigKey.FeatureMagicContext), true);
});

test("mapping 5: explicit features.magicContext=false overrides the on default", () => {
  const config = createConfigPort();
  config.merge({ features: { magicContext: false } }, ConfigScope.User);
  assert.equal(config.getAll().features.magicContext, false);
  assert.equal(config.get(ConfigKey.FeatureMagicContext), false);
});

test("mapping 5: explicit magicContext:false survives a merge that omits the key", () => {
  const config = createConfigPort({ features: { magicContext: false } });
  config.merge({ features: { rewind: false } }, ConfigScope.Project);
  assert.equal(config.getAll().features.magicContext, false);
  config.merge({ features: { magicContext: true } }, ConfigScope.Cli);
  assert.equal(config.getAll().features.magicContext, true);
});

test("mapping 5: merge notifies subscribers of the flag change", () => {
  const config = createConfigPort();
  const seen = [];
  config.observe().subscribe(ConfigKey.FeatureMagicContext, (value) => seen.push(value));
  // Merged from the (now `true`) default down to the explicit opt-out, so the
  // notification carries a value that differs from the absent-config default.
  config.merge({ features: { magicContext: false } }, ConfigScope.User);
  assert.deepEqual(seen, [false]);
});

test("mapping 4: config file schema accepts boolean magicContext and rejects non-boolean", () => {
  assert.deepEqual(ZCodeConfigFileSchema.parse({ features: { magicContext: true } }).features, {
    magicContext: true,
  });
  assert.equal(
    ZCodeConfigFileSchema.safeParse({ features: { magicContext: false } }).success,
    true,
  );
  for (const bad of ["true", 1, 0, null, {}]) {
    assert.equal(
      ZCodeConfigFileSchema.safeParse({ features: { magicContext: bad } }).success,
      false,
      `expected magicContext: ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test("mapping 4: absent magicContext stays absent so the default wins", () => {
  const { config } = parseConfigFileToRuntimePatchWithDiagnostics({ features: {} });
  assert.deepEqual(config.features, {});
  const port = createConfigPort();
  port.merge(config, ConfigScope.System);
  assert.equal(port.getAll().features.magicContext, true);
});

test("end-to-end: config file magicContext:true reaches getAll()", () => {
  const { config, diagnostics } = parseConfigFileToRuntimePatchWithDiagnostics({
    features: { magicContext: true },
  });
  assert.deepEqual(diagnostics, []);
  const port = createConfigPort();
  port.merge(config, ConfigScope.System);
  assert.equal(port.getAll().features.magicContext, true);
});

// ── T-M10 (step 26): the retired `features.compact` key must be survivable ──
// A user upgrading from an older build still has `features.compact` in their
// config.json. Removing the key from the schema must not turn that file into a
// load error: the strict object simply drops the unknown key, and the rest of
// the file (including the neighbouring live flags) still lands.
test("T-M10: config.json with the retired features.compact key loads and is stripped", () => {
  const fileConfig = {
    features: { compact: true, magicContext: true, rewind: false },
  };
  assert.equal(ZCodeConfigFileSchema.safeParse(fileConfig).success, true);
  const parsed = ZCodeConfigFileSchema.parse(fileConfig);
  assert.equal("compact" in parsed.features, false, "retired key must not survive parsing");

  const { config, diagnostics } = parseConfigFileToRuntimePatchWithDiagnostics(fileConfig);
  assert.deepEqual(diagnostics, []);
  assert.equal("compact" in config.features, false);

  const port = createConfigPort();
  port.merge(config, ConfigScope.System);
  const features = port.getAll().features;
  assert.equal("compact" in features, false, "retired key must not reach the runtime config");
  // Neighbouring live flags in the same file are unaffected.
  assert.equal(features.magicContext, true);
  assert.equal(features.rewind, false);
});

test("T-M10: the retired features.compact key is absent from every config surface", () => {
  assert.equal("FeatureCompact" in ConfigKey, false);
  assert.equal("compact" in DefaultRuntimeConfig.features, false);
  assert.equal("compact" in createConfigPort().getAll().features, false);
});
