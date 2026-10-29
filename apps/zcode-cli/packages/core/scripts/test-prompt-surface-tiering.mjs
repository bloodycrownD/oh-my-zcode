#!/usr/bin/env node
/**
 * Step 14（bugfix-batch-20261011 / phase-mc-prompt-surface）：prompt-surface 的 preset
 * 分档真正接进工具注册链。
 *
 * 背景：`prompt_surface.default` / `prompt_surface.models` 自 Step 11 起就能写进
 * config.json，但在本步之前**没有任何运行期消费者**——设置页保存成功、schema 校验通过、
 * ConfigPort 广播到位，然后模型看到的永远是 full 档工具描述。分档文案的唯一权威在
 * `@zcode/magic-context` 的 `light-descriptions`（宿主不得自抄），所以本测试一并钉住
 * 「core 侧注册开关 × 包侧 resolver」这条接缝。
 *
 * 五组断言：
 *   A. light 档：四个 ctx_* 工具的描述换成紧凑文案，参数 schema / 权限不动；
 *   B. full 档：描述逐字不变（换档开关的默认态必须是恒等）；
 *   C. 优先级：用户的 `tool_descriptions` 覆盖压过 light 目录；
 *   D. 作用域：只改 ctx_* 四工具，其它工具（Read）的描述一个字节都不动；没有
 *      description 的工具不参与分档；
 *   E. `resolveMagicContextPromptSurfaceOptions`：端口缺席返回空（不换档），
 *      modelKey 从会话模型选择推导。
 *
 * 依赖已构建的 dist：`pnpm --filter @zcode/core build`（以及
 * `@zcode/magic-context` 的 dist，见 resolve 钩子）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/**
 * workspace 包的 dist 兜底（与 test-magic-context-prompt-section.mjs 同一范式）：
 * `@zcode/magic-context` 的 dist 内部会 import `@zcode/contracts`，必须把它指到
 * contracts 的 dist，否则 node 会去解析 `.ts` 源码。
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
    return nextResolve(specifier, _context);
  },
});

const { registerBuiltInTools } = await import(
  new URL("../dist/tool/handlers/index.js", import.meta.url).href
);
const { resolveMagicContextPromptSurfaceOptions } = await import(
  new URL("../dist/runtime/helpers/magic-context-tool-surface.js", import.meta.url).href
);
const package_ = await import("@zcode/magic-context");

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — prompt-surface tool-description tiering (light/full/override/scope)"
      : `TEST FAIL — prompt-surface tool-description tiering (exit code ${code})`,
  );
});

/** 与 bootstrap 的 `createMagicContextToolDescriptionResolver` 同一条链接法。 */
function describeFor(config, modelKey) {
  const warnings = [];
  const runtime = package_.createPromptSurfaceRuntime({
    userConfigDirectory: REPO_ROOT,
    warn: (message) => warnings.push(message),
  });
  const registration = runtime.resolveRegistration(config, modelKey);
  return {
    // 注意签名：`registerBuiltInTools` 调的是一个对象参数（toolId / fullDescription /
    // modelKey），不是 positional——core 侧的端口形状就是对象，这里必须照抄。
    describe: ({ toolId, fullDescription, modelKey: routeKey }) =>
      registration.descriptionFor(toolId, fullDescription),
    preset: registration.preset,
    warnings,
  };
}

/** 最小 registry：只收集注册进来的 entry，够本测试用。 */
function collectEntries(options) {
  const registered = new Map();
  registerBuiltInTools(
    { register: (entry) => registered.set(entry.metadata.name, entry) },
    options,
  );
  return registered;
}

const CTX_TOOL_NAMES = ["ctx_reduce", "ctx_expand", "ctx_search", "ctx_memory"];

test("A: light preset swaps the four ctx_* descriptions for the compact catalog", () => {
  const light = collectEntries({
    includeMagicContextTools: true,
    magicContextToolDescription: describeFor({ default: "light" }).describe,
  });
  const full = collectEntries({ includeMagicContextTools: true });
  for (const toolId of CTX_TOOL_NAMES) {
    const lightDescription = light.get(toolId).metadata.description;
    const fullDescription = full.get(toolId).metadata.description;
    assert.notEqual(lightDescription, fullDescription, `${toolId} must be re-tiered`);
    assert.equal(
      lightDescription,
      package_.LIGHT_TOOL_DESCRIPTIONS[toolId],
      `${toolId} must use the package light catalog verbatim (no host-side copy)`,
    );
    // 参数 schema 与权限不动：分档是「同一份能力的详简叙述」，不是第二个工具。
    assert.deepEqual(light.get(toolId).inputSchema, full.get(toolId).inputSchema);
    assert.deepEqual(light.get(toolId).permission, full.get(toolId).permission);
    assert.equal(light.get(toolId).handler, full.get(toolId).handler);
  }
});

test("B: full preset (and no option at all) leaves the descriptions byte-identical", () => {
  const baseline = collectEntries({ includeMagicContextTools: true });
  const full = collectEntries({
    includeMagicContextTools: true,
    magicContextToolDescription: describeFor({ default: "full" }).describe,
  });
  for (const toolId of CTX_TOOL_NAMES) {
    assert.equal(full.get(toolId).metadata.description, baseline.get(toolId).metadata.description);
  }
  // 缺省态（options 里没有分档开关）也必须与 full 逐字相同——否则「没配 preset」
  // 会悄悄变成 light。
  const noOption = collectEntries({ includeMagicContextTools: true });
  for (const toolId of CTX_TOOL_NAMES) {
    assert.equal(
      noOption.get(toolId).metadata.description,
      baseline.get(toolId).metadata.description,
    );
  }
});

test("C: a user tool_descriptions override outranks the light catalog", () => {
  const { describe } = describeFor({
    default: "light",
    tool_descriptions: { ctx_search: "MINE" },
  });
  const entries = collectEntries({
    includeMagicContextTools: true,
    magicContextToolDescription: describe,
  });
  assert.equal(entries.get("ctx_search").metadata.description, "MINE");
  // 未覆盖的工具仍走 light 目录。
  assert.equal(
    entries.get("ctx_reduce").metadata.description,
    package_.LIGHT_TOOL_DESCRIPTIONS.ctx_reduce,
  );
});

test("D: only the four ctx_* tools are re-tiered; everything else is untouched", () => {
  const baseline = collectEntries({ includeMagicContextTools: true, includeSkill: true });
  const tiered = collectEntries({
    includeMagicContextTools: true,
    includeSkill: true,
    magicContextToolDescription: describeFor({ default: "light" }).describe,
  });
  assert.equal(baseline.size, tiered.size);
  for (const [name, entry] of baseline) {
    if (CTX_TOOL_NAMES.includes(name)) continue;
    assert.equal(
      tiered.get(name).metadata.description,
      entry.metadata.description,
      `${name} must not be re-tiered`,
    );
  }
  // 四个工具一个都不能漏：漏一个意味着那个工具永远拿不到 light 描述，而这种偏差
  // 在 prompt 面上是静默的。
  for (const toolId of CTX_TOOL_NAMES) {
    assert.ok(tiered.get(toolId), `${toolId} must be registered for the tiering to apply`);
  }
});

test("E: resolveMagicContextPromptSurfaceOptions gates on the port and derives the model key", () => {
  // 端口缺席 → 不换档（返回空对象，注册侧因此照原样注册 full 描述）。
  assert.deepEqual(resolveMagicContextPromptSurfaceOptions({ config: {} }), {});
  // 端口在场 + 有会话模型选择 → modelKey 参与路由。
  const describe = () => "x";
  const withModel = resolveMagicContextPromptSurfaceOptions({
    config: { modelSelection: { providerId: "zhipu", modelId: "glm-4.6" } },
    magicContextToolDescription: describe,
  });
  assert.equal(withModel.magicContextToolDescription, describe);
  assert.equal(withModel.magicContextModelKey, "zhipu/glm-4.6");
  // 端口在场但没有模型选择 → 只传求值器，求值器自己按 configured default 解析。
  const withoutModel = resolveMagicContextPromptSurfaceOptions({
    config: {},
    magicContextToolDescription: describe,
  });
  assert.deepEqual(Object.keys(withoutModel), ["magicContextToolDescription"]);
});
