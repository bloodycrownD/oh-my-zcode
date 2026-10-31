import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
} from "@zcode/provider";
import { NodeZCodeBuiltinProviderConfigSource } from "@zcode/provider-node";

const currentModelIds = ["mimo-v2.6-pro", "mimo-v2.6-flash"];
const apiModelIds = [...currentModelIds, "mimo-v2.5-pro", "mimo-v2.5"];

// FORK: 正式随包目录（zcode-builtin.json）由 fork 自维护——xiaomi-mimo 模板命名为
// "Xiaomi MiMo"，token-plan 计费模板已随 zhipu 计费面删除，模板模型清单停留在 v2.5，
// v2.6 通过 templateModelRules 挂到 xiaomi-mimo。测试目录（zcode-builtin.test.json）
// 保留上游双模板形态。
const forkTemplate = {
  templateId: "xiaomi-mimo",
  name: "Xiaomi MiMo",
  baseUrl: "https://api.xiaomimimo.com/anthropic",
  // v2.6 由本次上游合并引入（补齐 builtinModelIds 后可达），模型属性走 fork 通用兜底。
  builtinModelIds: ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"],
} as const;
const upstreamTemplates = [
  ["xiaomi-mimo", "Xiaomi MiMo API", "https://api.xiaomimimo.com/anthropic"],
  [
    "xiaomi-mimo-token-plan",
    "Xiaomi MiMo Token Plan",
    "https://token-plan-cn.xiaomimimo.com/anthropic",
  ],
] as const;

async function readSnapshot(filename: string) {
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: fileURLToPath(
      new URL(`../../../config/provider/${filename}`, import.meta.url),
    ),
    watch: false,
  });
  return { source, snapshot: await source.read() };
}

describe("MiMo API 与 Token Plan 官方模板", () => {
  it("zcode-builtin.json 单模板承载 v2.5/v2.6，个人地址与旧身份不变", async () => {
    const { source, snapshot } = await readSnapshot("zcode-builtin.json");
    try {
      // FORK: token-plan 模板已删面，随包目录只保留 xiaomi-mimo 单模板。
      expect(snapshot.providerTemplates?.has("xiaomi-mimo-token-plan")).toBe(false);
      const template = snapshot.providerTemplates?.get(forkTemplate.templateId);
      expect(template).toBeDefined();
      expect(template!.templateNameMap).toEqual({
        "zh-CN": forkTemplate.name,
        "en-US": forkTemplate.name,
      });
      expect(template!.config.api?.toJSON()).toEqual({
        type: "anthropic-messages",
        baseUrl: forkTemplate.baseUrl,
      });
      expect(template!.config.access?.toJSON()).toEqual({
        type: "api-key",
        apiKeyManagementUrl: "https://platform.xiaomimimo.com/",
      });
      expect(template!.config.builtinModelIds).toEqual([...forkTemplate.builtinModelIds]);
      expect(template!.config.logo).toEqual({ type: "builtin", key: "xiaomi-mimo" });
      for (const modelId of template!.config.builtinModelIds!) {
        const model = snapshot.models.resolve({
          providerId: "test",
          templateId: forkTemplate.templateId,
          modelId,
          apiType: "anthropic-messages",
          baseUrl: forkTemplate.baseUrl,
        });
        expect(model.validateComplete()).toEqual([]);
        expect(model.enabled).toBe(true);
        if (modelId.startsWith("mimo-v2.5")) {
          // v2.5 有专用 modelRule：1M 上下文 + 多模态 + 131072 输出上限。
          expect(model.properties?.contextWindow).toBe(1000000);
          expect(model.properties?.inputFormat.toJSON()).toMatchObject({
            supportsImage: modelId !== "mimo-v2.5-pro",
            supportsVideo: modelId !== "mimo-v2.5-pro",
            supportsAudio: modelId !== "mimo-v2.5-pro",
          });
          expect(model.optionSpecs?.maxOutputTokens?.max).toBe(131072);
          expect(model.optionSpecs?.reasoningLevel?.values).toEqual(["disabled", "enabled"]);
          for (const reasoningLevel of ["disabled", "enabled"]) {
            expect(
              compileModelOptionMaps({
                reasoningLevel: { map: model.optionSpecs!.reasoningLevel!.map! },
                maxOutputTokens: { map: model.optionSpecs!.maxOutputTokens!.map! },
              }).apply({}, { reasoningLevel, maxOutputTokens: 1024 }),
            ).toEqual({
              thinking: { type: reasoningLevel },
              max_tokens: 1024,
            });
          }
        } else {
          // FORK: v2.6 无专用 modelRule，属性来自 fork 通用兜底（200k / 纯文本 / 32000 上限）。
          expect(model.properties?.contextWindow).toBe(200000);
          expect(model.properties?.inputFormat.toJSON()).toMatchObject({
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
          });
          expect(model.optionSpecs?.maxOutputTokens?.max).toBe(32000);
          expect(model.optionSpecs?.reasoningLevel?.values).toEqual(["disabled", "enabled"]);
          for (const reasoningLevel of ["disabled", "enabled"]) {
            expect(
              compileModelOptionMaps({
                reasoningLevel: { map: model.optionSpecs!.reasoningLevel!.map! },
                maxOutputTokens: { map: model.optionSpecs!.maxOutputTokens!.map! },
              }).apply({}, { reasoningLevel, maxOutputTokens: 1024 }),
            ).toEqual(
              reasoningLevel === "disabled"
                ? { thinking: { type: "disabled" }, max_tokens: 1024 }
                : {
                    thinking: { type: "adaptive" },
                    output_config: { effort: "high" },
                    max_tokens: 1024,
                  },
            );
          }
        }
      }

      // 旧实例可能已手动填地址；fork 单模板下同样不能重命名、重新启用或覆盖其地址。
      const personal = new ProviderConfigMap([
        {
          providerId: `new-${forkTemplate.templateId}`,
          templateId: forkTemplate.templateId,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: `test-${forkTemplate.templateId}` }),
          }),
        },
        {
          providerId: "legacy-mimo",
          templateId: forkTemplate.templateId,
          providerName: "My MiMo",
          enabled: false,
          config: new ProviderConfig({
            api: new ProviderApiConfig({ baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic" }),
            access: new ApiKeyAccessConfig({ apiKey: "old-test-only" }),
          }),
        },
      ]);
      const before = personal.toJSON();
      const resolution = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: ProviderConfigMap.empty(),
        zcodeBuiltinProviderTemplates: snapshot.providerTemplates,
        accountProviders: ProviderConfigMap.empty(),
        personalProviders: personal,
        zcodeBuiltinModelRules: snapshot.models,
        personalModels: new ModelConfigRules([
          {
            type: "provider-model",
            providerId: `new-${forkTemplate.templateId}`,
            modelId: "mimo-v2.6-pro",
            config: new ModelConfig({ enabled: false }),
          },
        ]),
      });
      const provider = resolution.registryProviders.find(
        (p) => p.providerId === `new-${forkTemplate.templateId}`,
      );
      expect(provider?.config.api?.baseUrl).toBe(forkTemplate.baseUrl);
      // v2.6 已入模板清单；personalModels 已把 mimo-v2.6-pro 禁用，余下三个可用。
      expect(provider?.models.map((m) => m.modelId)).toEqual([
        "mimo-v2.6-flash",
        "mimo-v2.5-pro",
        "mimo-v2.5",
      ]);
      expect(provider?.config.access?.toJSON()).toMatchObject({
        apiKey: `test-${forkTemplate.templateId}`,
      });
      expect(resolution.registryProviders.some((p) => p.providerId === "legacy-mimo")).toBe(
        false,
      );
      const legacy = resolution.resolvedProviders.find((p) => p.providerId === "legacy-mimo");
      expect(legacy?.config.access?.toJSON()).toMatchObject({ apiKey: "old-test-only" });
      expect(legacy?.providerName).toBe("My MiMo");
      expect(legacy?.config.api?.baseUrl).toBe("https://token-plan-cn.xiaomimimo.com/anthropic");
      expect(personal.toJSON()).toEqual(before);
    } finally {
      source.dispose();
    }
  });

  it("zcode-builtin.test.json 两模板复用模型规则，个人地址与旧身份不变", async () => {
    const { source, snapshot } = await readSnapshot("zcode-builtin.test.json");
    try {
      for (const [templateId, name, baseUrl] of upstreamTemplates) {
        const template = snapshot.providerTemplates?.get(templateId);
        expect(template, templateId).toBeDefined();
        expect(template!.templateNameMap).toEqual({ "zh-CN": name, "en-US": name });
        expect(template!.config.api?.toJSON()).toEqual({ type: "anthropic-messages", baseUrl });
        expect(template!.config.access?.toJSON()).toEqual({
          type: "api-key",
          apiKeyManagementUrl: "https://platform.xiaomimimo.com/",
        });
        expect(template!.config.builtinModelIds).toEqual(
          templateId === "xiaomi-mimo" ? apiModelIds : currentModelIds,
        );
        expect(template!.config.logo).toEqual({ type: "builtin", key: "xiaomi-mimo" });
        for (const modelId of template!.config.builtinModelIds!) {
          const model = snapshot.models.resolve({
            providerId: "test",
            templateId,
            modelId,
            apiType: "anthropic-messages",
            baseUrl,
          });
          expect(model.validateComplete()).toEqual([]);
          expect(model.enabled).toBe(true);
          expect(model.properties?.contextWindow).toBe(1000000);
          expect(model.properties?.inputFormat.toJSON()).toMatchObject({
            supportsImage: modelId !== "mimo-v2.5-pro",
            supportsVideo: modelId !== "mimo-v2.5-pro",
            supportsAudio: modelId !== "mimo-v2.5-pro",
          });
          expect(model.optionSpecs?.maxOutputTokens?.max).toBe(131072);
          expect(model.optionSpecs?.reasoningLevel?.values).toEqual(["disabled", "enabled"]);
          for (const reasoningLevel of ["disabled", "enabled"]) {
            expect(
              compileModelOptionMaps({
                reasoningLevel: { map: model.optionSpecs!.reasoningLevel!.map! },
                maxOutputTokens: { map: model.optionSpecs!.maxOutputTokens!.map! },
              }).apply({}, { reasoningLevel, maxOutputTokens: 1024 }),
            ).toEqual({
              thinking: { type: reasoningLevel },
              max_tokens: 1024,
            });
          }
        }
      }

      // 旧实例可能已手动填 Token Plan 地址；拆模板不能重命名、重新启用或覆盖其地址。
      const personal = new ProviderConfigMap([
        ...upstreamTemplates.map(([templateId]) => ({
          providerId: `new-${templateId}`,
          templateId,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: `test-${templateId}` }),
          }),
        })),
        {
          providerId: "legacy-mimo",
          templateId: "xiaomi-mimo",
          providerName: "My MiMo",
          enabled: false,
          config: new ProviderConfig({
            api: new ProviderApiConfig({ baseUrl: upstreamTemplates[1][2] }),
            access: new ApiKeyAccessConfig({ apiKey: "old-test-only" }),
          }),
        },
        {
          providerId: "international-mimo",
          templateId: "xiaomi-mimo-token-plan",
          config: new ProviderConfig({
            group: "standard-personal",
            api: new ProviderApiConfig({
              baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
            }),
            access: new ApiKeyAccessConfig({ apiKey: "test-only" }),
          }),
        },
      ]);
      const before = personal.toJSON();
      const resolution = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: ProviderConfigMap.empty(),
        zcodeBuiltinProviderTemplates: snapshot.providerTemplates,
        accountProviders: ProviderConfigMap.empty(),
        personalProviders: personal,
        zcodeBuiltinModelRules: snapshot.models,
        personalModels: new ModelConfigRules([
          {
            type: "provider-model",
            providerId: "international-mimo",
            modelId: "mimo-v2.6-pro",
            config: new ModelConfig({ enabled: false }),
          },
        ]),
      });
      for (const [templateId, , baseUrl] of upstreamTemplates) {
        const provider = resolution.registryProviders.find(
          (p) => p.providerId === `new-${templateId}`,
        );
        expect(provider?.config.api?.baseUrl).toBe(baseUrl);
        expect(provider?.models.map((m) => m.modelId)).toEqual(
          templateId === "xiaomi-mimo" ? apiModelIds : currentModelIds,
        );
        expect(provider?.config.access?.toJSON()).toMatchObject({
          apiKey: `test-${templateId}`,
        });
      }
      expect(
        resolution.registryProviders.find((p) => p.providerId === "international-mimo")?.config
          .api?.baseUrl,
      ).toBe("https://token-plan-sgp.xiaomimimo.com/anthropic");
      expect(
        resolution.registryProviders
          .find((p) => p.providerId === "international-mimo")
          ?.models.map((m) => m.modelId),
      ).toEqual(["mimo-v2.6-flash"]);
      expect(resolution.registryProviders.some((p) => p.providerId === "legacy-mimo")).toBe(
        false,
      );
      const legacy = resolution.resolvedProviders.find((p) => p.providerId === "legacy-mimo");
      expect(legacy?.config.access?.toJSON()).toMatchObject({ apiKey: "old-test-only" });
      expect(legacy?.providerName).toBe("My MiMo");
      expect(legacy?.config.api?.baseUrl).toBe(upstreamTemplates[1][2]);
      expect(personal.toJSON()).toEqual(before);
    } finally {
      source.dispose();
    }
  });
});
