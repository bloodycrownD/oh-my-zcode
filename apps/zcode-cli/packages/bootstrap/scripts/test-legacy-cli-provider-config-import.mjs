#!/usr/bin/env node
/**
 * U1 — CLI 旧 config.json 导入保留 maxOutputTokens（上游 v3.16 A2 缺陷修复）。
 *
 * ============================================================================
 * 这一步要钉死什么
 * ============================================================================
 *
 * 旧 CLI 用户文件（omz 语境即 `~/.omz/cli/config.json`）里的模型预算此前在
 * 迁移时被整段丢弃：只有 `contextWindow` 的模型会被投影成 ModelProperties，
 * 只写 `limit.output` / `options.max_tokens` / 顶层 `maxOutputTokens` 的模型
 * 则**整个被跳过**（上游修复前的 `if (member.contextWindow === undefined) continue`）。
 *
 * 上游 v3.16.2 的修法（逐 hunk 重放进本仓库，文件与上游逐字一致）：
 *   ① 引入 `ModelOptionSpecsConfig`，把输出上限写成
 *      `optionSpecs.maxOutputTokens.max`；
 *   ② 成员投影条件从「只看 contextWindow」展开为「contextWindow 或
 *      maxOutputTokens 任一存在即迁移」；
 *   ③ `LegacyCliModelMember` 增加 `maxOutputTokens` 字段；
 *   ④ 取值优先级 `limit.output > options.max_tokens > 顶层 maxOutputTokens`，
 *      并沿用既有 `isPositiveInteger` 收窄（`options.max_tokens` 在旧 schema
 *      里是 unknown，不能未校验就写进正式 Config）。
 *
 * 本脚本的五组断言（T-C1）：
 *   C1 内置套餐丢弃只留 Key（`builtin:bigmodel` / `builtin:zai` 只迁 API Key，
 *      `builtin:*` / `account:*` / 非 custom source 一律不迁）；
 *   C2 显式 Provider 投影：模型带 `limit.output=16000` 时，正式 Config 必须出现
 *      `optionSpecs:{maxOutputTokens:{max:16000}}`，且与 contextWindow 共存；
 *   C3 只选 model 不迁 Provider（没有 provider 定义就不产生 Provider 与 Model 规则）；
 *   C4 已退出产品的 ZAPI（`builtin:zapi`）不迁；
 *   C5 旧 options 中的任意字段一律忽略（不产生 requestParameters 之类的正式语义）。
 *
 * 附带的 C6 钉死取值优先级本身：`limit.output > options.max_tokens > 顶层
 * maxOutputTokens`，且 `extra_body.max_tokens` 这类嵌套字段不被当成预算。
 *
 * 依赖已构建的 dist：`pnpm --filter @zcode/bootstrap build`（被测实现从
 * `dist/app/legacy-cli-personal-provider-config-importer.js` 加载，与
 * test-magic-context-absent-event 同一手法）。`@zcode/shared` /
 * `@zcode/model-option-map` / `@zcode/provider` 的包入口发布的是原始
 * TypeScript（`exports["."] = "./src/index.ts"`），裸 node 既无法把内部 `.js`
 * 说明符改指到 `.ts`，也会在 strip-only 模式下拒绝参数属性；因此用
 * `registerHooks` 只改解析（改指到已编译的 dist），不桩被测代码。
 *
 * Exits 0 on success, 1 on any failed assertion（node:test 自行置退出码）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

// 入口发布原始 TypeScript 的包：只改解析目标，不改被测逻辑。
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map", "@zcode/provider"]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : segments.length >= 2 && TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
        : null;
    if (packageName === null) return nextResolve(specifier, context);
    const distRoot = join(REPO_ROOT, "packages", packageName.slice("@zcode/".length), "dist");
    const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
    for (const candidate of [
      join(distRoot, `${subpath}.js`),
      join(distRoot, subpath, "index.js"),
    ]) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
  },
});

const IMPORTER_DIST = fileURLToPath(
  new URL("../dist/app/legacy-cli-personal-provider-config-importer.js", import.meta.url),
);
if (!existsSync(IMPORTER_DIST)) {
  throw new Error(`missing ${IMPORTER_DIST} — run \`pnpm --filter @zcode/bootstrap build\` first`);
}

const { importLegacyCliPersonalProviderConfig } = await import(pathToFileURL(IMPORTER_DIST).href);

/** 迁移结果的可比对投影：Provider 规则与 Model 规则各自的编码形态。 */
function encoded(update) {
  return {
    providers: update.providers.toJSON(),
    models: update.models.toJSON(),
  };
}

// 新存储格式按规则种类分桶；空模型规则的完整分桶形状。
const emptyModelRules = {
  builtinProviderModelRules: [],
  manualProviderModelRules: [],
  modelApiRules: [],
  modelRules: [],
  providerSiteRules: [],
  templateModelRules: [],
};

test("C1：内置套餐丢弃只留 Key，其它内置/账号 Provider 一律不迁", () => {
  const update = importLegacyCliPersonalProviderConfig({
    input: {
      provider: {
        "builtin:bigmodel-coding-plan": {
          kind: "anthropic",
          source: "custom",
          options: { apiKey: "discard", apiKeyRequired: false },
          models: { old: {} },
        },
        "builtin:bigmodel": {
          kind: "anthropic",
          source: "custom",
          name: "old",
          options: { apiKey: " kept ", baseURL: "https://old.test" },
          models: { old: {} },
        },
        "builtin:zai": { kind: "anthropic", source: "builtin", options: { apiKey: "" } },
        "account:zai-start-plan": {
          kind: "anthropic",
          source: "custom",
          options: { apiKey: "discard" },
        },
        "legacy-builtin": {
          kind: "anthropic",
          source: "builtin",
          options: { apiKey: "discard" },
        },
      },
    },
  });

  assert.deepEqual(update.providers.keys(), ["bigmodel-api"]);
  assert.deepEqual(update.providers.get("bigmodel-api")?.toJSON(), {
    group: "standard-personal",
    access: { type: "api-key", apiKey: "kept" },
  });
});

test("C2：显式 Provider 投影保留 maxOutputTokens（optionSpecs.maxOutputTokens.max）", () => {
  const update = importLegacyCliPersonalProviderConfig({
    input: {
      model: "custom/model-a",
      provider: {
        custom: {
          kind: "openai-compatible",
          name: "Custom API",
          options: {
            apiKey: "secret",
            baseURL: "https://custom.example.com/v1",
            includeUsage: false,
          },
          models: {
            "model-a": {
              headers: { "X-Model-Route": "legacy" },
              limit: { context: 128_000, output: 16_000 },
              modalities: { input: ["text", "image", "video"] },
              structured_output: true,
              tool_call: true,
            },
          },
        },
      },
    },
  });

  assert.deepEqual(encoded(update), {
    providers: [
      {
        providerId: "custom",
        providerName: "Custom API",
        config: {
          group: "standard-personal",
          access: { type: "api-key", apiKey: "secret" },
          api: {
            type: "openai-chat-completions",
            baseUrl: "https://custom.example.com/v1",
          },
          personalModelIds: ["model-a"],
          modelOrder: ["model-a"],
        },
      },
    ],
    models: {
      ...emptyModelRules,
      builtinProviderModelRules: [
        {
          providerId: "custom",
          modelId: "model-a",
          config: {
            properties: { contextWindow: 128_000 },
            optionSpecs: { maxOutputTokens: { max: 16_000 } },
          },
        },
      ],
    },
  });
});

test("C3：只选 model、没有 provider 定义时不迁 Provider", () => {
  const update = importLegacyCliPersonalProviderConfig({
    input: { model: "missing/model-a" },
  });

  assert.deepEqual(encoded(update), { providers: [], models: emptyModelRules });
});

test("C4：已退出产品的 ZAPI 不迁成 Personal Provider", () => {
  const update = importLegacyCliPersonalProviderConfig({
    input: {
      provider: {
        "builtin:zapi": {
          kind: "anthropic",
          options: { baseURL: "https://retired.example.com", apiKey: "retired" },
          models: { retired: {} },
        },
        custom: {
          kind: "openai-compatible",
          options: { baseURL: "https://custom.example.com", apiKey: "current" },
          models: { current: {} },
        },
      },
    },
  });

  assert.deepEqual(update.providers.keys(), ["custom"]);
});

test("C5：旧 model options 中没有正式语义的任意字段一律忽略", () => {
  const update = importLegacyCliPersonalProviderConfig({
    input: {
      provider: {
        custom: {
          kind: "openai-compatible",
          options: {
            apiKey: "secret",
            baseURL: "https://custom.example.com/v1",
          },
          models: {
            "model-a": {
              limit: { context: 128_000, output: 16_000 },
              options: {
                openaiCompatible: {
                  reasoningSummary: "auto",
                  metadata: { source: "legacy" },
                },
              },
            },
            "model-b": {
              options: { reasoningSummary: "concise" },
            },
          },
        },
      },
    },
  });

  const rules = encoded(update).models.builtinProviderModelRules;
  assert.equal(rules.length, 1);
  assert.ok(!("requestParameters" in rules[0].config));
  assert.deepEqual(rules[0].config, {
    properties: { contextWindow: 128_000 },
    optionSpecs: { maxOutputTokens: { max: 16_000 } },
  });
});

test("C6：maxOutputTokens 取值优先级为 limit.output > options.max_tokens > 顶层字段", () => {
  const update = importLegacyCliPersonalProviderConfig({
    input: {
      provider: {
        custom: {
          kind: "openai-compatible",
          options: {
            apiKey: "secret",
            baseURL: "https://custom.example.com/v1",
          },
          models: {
            // limit.output 压过 options.max_tokens 与顶层 maxOutputTokens。
            "by-limit": {
              limit: { output: 16_000 },
              options: { max_tokens: 8_000 },
              maxOutputTokens: 4_000,
            },
            // options.max_tokens 压过顶层 maxOutputTokens。
            "by-options": { options: { max_tokens: 24_000 }, maxOutputTokens: 4_000 },
            // 只有顶层字段时也必须迁移。
            "by-top-level": { maxOutputTokens: 4_000 },
            // 嵌套在 extra_body 里的 max_tokens 不算预算。
            "by-extra-body": { options: { extra_body: { max_tokens: 12_000 } } },
          },
        },
      },
    },
  });

  assert.deepEqual(update.models.getExact("custom", "by-limit")?.toJSON(), {
    optionSpecs: { maxOutputTokens: { max: 16_000 } },
  });
  assert.deepEqual(update.models.getExact("custom", "by-options")?.toJSON(), {
    optionSpecs: { maxOutputTokens: { max: 24_000 } },
  });
  assert.deepEqual(update.models.getExact("custom", "by-top-level")?.toJSON(), {
    optionSpecs: { maxOutputTokens: { max: 4_000 } },
  });
  assert.equal(update.models.getExact("custom", "by-extra-body"), undefined);
});
