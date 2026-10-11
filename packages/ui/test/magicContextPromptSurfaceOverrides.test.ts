// Step 14（bugfix-batch-20261011）——prompt_surface per-model 覆盖的只读呈现读侧。
//
// 被测模块 settings/magicContextSettingsForm.ts 的两个只读读侧：
//   - readPromptSurfaceModelRoutes：`prompt_surface.models` → 稳定的展示串数组；
//   - readPromptSurfaceToolOverrides：`prompt_surface.tool_descriptions` → 键名数组。
//
// 为什么要单测：这两个读侧的职责是「让用户已配置但页面不可编辑的覆盖**可见**」，
// 而写侧的策略是经 base 原样带回。读侧一旦把坏值显示成选中态、或两次读同一份配置给出
// 不同顺序的列表，用户就会以为配置变了——那是比「看不见」更难排查的故障。
//
// tsx 不解析 ui 包的 `@/*` 别名，但被测文件只 import `@zcode/shared`（dist 兜底见
// 下方 resolve 钩子，与 core 侧测试同范式）。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PACKAGE_DIST_ENTRY = {
  "@zcode/shared": `${REPO_ROOT}packages/shared/dist/index.js`,
  "@zcode/model-option-map": `${REPO_ROOT}packages/model-option-map/dist/index.js`,
  "@zcode/contracts": `${REPO_ROOT}apps/zcode-cli/packages/contracts/dist/index.js`,
};
const TS_SOURCE_PACKAGES = ["@zcode/shared", "@zcode/model-option-map"];

/**
 * workspace 包的 dist 兜底（与 core 侧测试同范式）：`@zcode/shared` 在 workspace 根植根
 * 于 `src/index.ts`，其内部又会 import `@zcode/contracts`；两侧都指到 dist，node 才不必
 * 解析 `.ts`。返回类型用 `ResolveHookSync` 认的形状逐个分支构造，不做统一 unknown。
 */
function resolveWorkspaceDist(specifier: string): { url: string; shortCircuit: true } | undefined {
  const entry = (PACKAGE_DIST_ENTRY as Record<string, string | undefined>)[specifier];
  if (entry !== undefined) return { url: pathToFileURL(entry).href, shortCircuit: true };
  const segments = specifier.split("/");
  for (const name of TS_SOURCE_PACKAGES) {
    const packageName = specifier === name || segments.slice(0, 2).join("/") === name ? name : null;
    if (packageName === null) continue;
    const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
    const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
    for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  return undefined;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    return resolveWorkspaceDist(specifier) ?? nextResolve(specifier, context);
  },
});

const { magicContextSettingsFormFromConfig, buildMagicContextConfigFromForm } = await import(
  new URL("../src/settings/magicContextSettingsForm.js", import.meta.url).href
);

const FALLBACK = {
  enabled: true,
  executeThresholdPercentage: 65,
  executeThresholdTokens: null,
  protectedTokens: null,
  historyBudgetPercentage: 0.15,
  cacheTtl: "5m",
  historianModel: "inherit",
  smartDrops: false,
  failClosedBlocking: true,
  memoryEnabled: true,
  promptSurfaceDefault: "full",
  promptSurfaceGuidancePath: "",
  promptSurfaceModelRoutes: [],
  promptSurfaceToolOverrides: [],
  muralEnabled: false,
};

test("per-model prompt-surface routes are presented as stable display strings", () => {
  const form = magicContextSettingsFormFromConfig(
    {
      prompt_surface: {
        default: "full",
        models: { "zhipu/glm-4.6": "light", "glm-4.5": "light", "openai/gpt-5": "full" },
      },
    },
    FALLBACK,
  );
  // 字典序稳定：同一份配置两次读必须给出同一份列表。
  assert.deepEqual(form.promptSurfaceModelRoutes, [
    "glm-4.5 → light",
    "openai/gpt-5 → full",
    "zhipu/glm-4.6 → light",
  ]);
  const again = magicContextSettingsFormFromConfig(
    {
      prompt_surface: {
        default: "full",
        models: { "zhipu/glm-4.6": "light", "glm-4.5": "light", "openai/gpt-5": "full" },
      },
    },
    FALLBACK,
  );
  assert.deepEqual(again.promptSurfaceModelRoutes, form.promptSurfaceModelRoutes);
});

test("tool-description override keys are presented, values are not surfaced", () => {
  const form = magicContextSettingsFormFromConfig(
    {
      prompt_surface: {
        tool_descriptions: { ctx_search: "a long override", ctx_reduce: "another" },
      },
    },
    FALLBACK,
  );
  // 只呈现键：覆盖正文可能很长，且页面没有编辑入口，铺开只会挤占版面。
  assert.deepEqual(form.promptSurfaceToolOverrides, ["ctx_reduce", "ctx_search"]);
});

test("bad values are shown as not configured, never as a selected preset", () => {
  const form = magicContextSettingsFormFromConfig(
    {
      prompt_surface: {
        models: { "bad key": "medium", ok: "light" },
        tool_descriptions: { "  ": "blank", ctx_memory: "ok" },
      },
    },
    FALLBACK,
  );
  assert.deepEqual(form.promptSurfaceModelRoutes, ["ok → light"]);
  assert.deepEqual(form.promptSurfaceToolOverrides, ["ctx_memory"]);
});

test("no overrides at all yields two empty read-only lists", () => {
  const form = magicContextSettingsFormFromConfig(
    { prompt_surface: { default: "light" } },
    FALLBACK,
  );
  assert.equal(form.promptSurfaceDefault, "light");
  assert.deepEqual(form.promptSurfaceModelRoutes, []);
  assert.deepEqual(form.promptSurfaceToolOverrides, []);
});

test("the read-only fields never reach the write path: overrides round-trip byte-for-byte", () => {
  const base = {
    prompt_surface: {
      default: "full",
      models: { "zhipu/glm-4.6": "light" },
      tool_descriptions: { ctx_search: "MINE" },
    },
  };
  const form = magicContextSettingsFormFromConfig(base, FALLBACK);
  const next = buildMagicContextConfigFromForm(base, {
    ...form,
    promptSurfaceDefault: "light",
  });
  // 写侧只改 default：per-model 表与工具描述覆盖经 base 原样带回。
  assert.deepEqual(next.prompt_surface, {
    default: "light",
    models: { "zhipu/glm-4.6": "light" },
    tool_descriptions: { ctx_search: "MINE" },
  });
});
