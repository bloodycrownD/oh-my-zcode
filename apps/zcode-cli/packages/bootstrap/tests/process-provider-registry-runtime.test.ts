import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION,
} from "@zcode/provider-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startProcessProviderRegistryRuntime } from "../src/app/process-provider-registry-runtime.js";

/**
 * FORK（D-4）：本文件只保留账号面删除后仍然 live 的配置容灾 / 生命周期用例。
 * 已随 zhipu-account 计费面整删、不再恢复的用例：
 * - Account Overlay 重解析（`snapshot.account.basedOnZCodeBuiltinRevision` 由账号源驱动）
 * - 独立 Account Config 同步入口（`syncAccountProviderConfig` / 进程侧解析函数）的往返用例
 * - Standalone 账号凭据生成 Overlay、凭据读取失败的 fail-closed 启动
 * 上述符号在 `@zcode/provider` / `process-provider-registry-runtime` 均已不存在。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("process provider registry runtime", () => {
  it("Standalone 长生命周期下载 URL Release 后跟进 Registry；Managed Worker 不下载", async () => {
    const root = await temporaryDirectory();
    const builtin = JSON.parse(
      await readFile(
        new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const bundled = join(root, "bundled.json");
    const active = join(root, "active.json");
    await writeFile(bundled, JSON.stringify(builtin));
    await writeFile(active, JSON.stringify(builtin));
    builtin.revision += 1;
    let releaseDownload!: () => void;
    const wait = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      if (String(url).includes("/api/v1/client/configs?"))
        return new Response(
          JSON.stringify({
            code: 0,
            data: { configs: { builtin_provider_config_json: "https://cdn.example.com/new.json" } },
          }),
        );
      await wait;
      return new Response(JSON.stringify(builtin));
    });
    const env = {
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: active,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(root, "personal.json"),
      ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: bundled,
    };
    const runtime = await startProcessProviderRegistryRuntime(env, {
      standalone: {
        request,
        legacyCliUserConfigFilePath: join(root, "absent.json"),
      },
    });
    const old = runtime.runtime.registryService.getSnapshot()!;
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(runtime.runtime.registryService.getSnapshot()).toBe(old);
      releaseDownload();
      await vi.waitFor(() =>
        expect(runtime.runtime.registryService.getSnapshot()!.config.zcodeBuiltinRevision).toMatch(
          `zcode-builtin:${builtin.revision}:`,
        ),
      );
      const next = runtime.runtime.registryService.getSnapshot()!;
      expect(JSON.parse(await readFile(active, "utf8")).revision).toBe(builtin.revision);
      expect(JSON.parse(await readFile(bundled, "utf8")).revision).toBe(builtin.revision - 1);
      const worker = await startProcessProviderRegistryRuntime(env);
      try {
        expect(worker.snapshot.config.zcodeBuiltinRevision).toBe(next.config.zcodeBuiltinRevision);
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        worker.dispose();
      }
    } finally {
      releaseDownload();
      runtime.dispose();
    }
  });

  it("未注入 Provider Config 路径时拒绝启动", async () => {
    await expect(startProcessProviderRegistryRuntime({})).rejects.toThrow(
      "缺少进程 Provider Registry",
    );
  });

  it("Personal 文件损坏时保留原文件并以内存空配置启动", async () => {
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    const personalFilePath = join(root, "personal.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify(zcodeBuiltinRelease({ providers: {}, templates: {}, models: [] })),
    );
    await writeFile(personalFilePath, "{not-json");
    const started = await startProcessProviderRegistryRuntime({
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: zcodeBuiltinFilePath,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
    });
    try {
      expect(started.configuredDefaultModelSelection).toBeUndefined();
      expect(await readFile(personalFilePath, "utf8")).toBe("{not-json");
      await expect(
        started.modelSelectionConfigRepository.saveConfiguredDefault(undefined),
      ).rejects.toThrow();
    } finally {
      started.dispose();
    }
    await expect(started.modelSelectionConfigRepository.read()).rejects.toThrow("已 dispose");
    await expect(started.runtime.start()).rejects.toThrow("已 dispose");
  });

  it("从进程环境启动一份 Registry，并由调用方持有生命周期", async () => {
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    const personalFilePath = join(root, "personal.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify(
        zcodeBuiltinRelease({
          providers: {},
          templates: {
            "zcode-template": {
              access: { type: "api-key" },
              api: {
                type: "anthropic-messages",
                baseUrl: "https://api.example.com",
              },
              builtinModelIds: ["model-a"],
            },
          },
          models: [
            {
              modelMatch: "model-a",
              config: {
                enabled: true,

                properties: {
                  requiresMfjsToolSchema: false,
                  contextWindow: 200000,
                  inputFormat: {
                    supportsText: true,
                    supportsImage: false,
                    supportsVideo: false,
                    supportsAudio: false,
                    supportsPdf: false,
                  },
                  outputFormat: { supportsText: true },
                  supportsToolCall: true,
                  supportsJsonSchemaOutput: true,
                  supportsNativeWebSearch: false,
                  supportsMidConversationSystem: false,
                },
                optionSpecs: {
                  reasoningLevel: { values: ["disabled"], map: "{}" },
                  maxOutputTokens: {
                    max: 32000,
                    map: '{"max_completion_tokens":maxOutputTokens}',
                  },
                },
              },
            },
          ],
        }),
      ),
      "utf8",
    );
    await writeFile(
      personalFilePath,
      JSON.stringify(
        personalRelease([
          {
            providerId: "personal-api",
            templateId: "zcode-template",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "secret" },
            },
          },
        ]),
      ),
      "utf8",
    );

    const started = await startProcessProviderRegistryRuntime({
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: zcodeBuiltinFilePath,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
    });

    expect(
      started.snapshot.registry.providers.map((provider) => provider.providerId).sort(),
    ).toEqual(["personal-api"]);
    expect(started.runtime.registryService.getModel("personal-api", "model-a")).toBeDefined();
    expect(started.runtime.registryService.getProvider("personal-api")?.config).toMatchObject({
      api: { type: "anthropic-messages" },
      builtinModelIds: ["model-a"],
    });
    started.dispose();
  });

  it("只有显式开启 Standalone 导入时才迁移旧 CLI 用户 Provider", async () => {
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    const personalFilePath = join(root, "personal.json");
    const legacyFilePath = join(root, "legacy-cli.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify(
        zcodeBuiltinRelease({
          providers: {},
          templates: {},
          // Personal Provider 仍由 Built-in 通用规则补齐静态模型事实；迁移器只搬运旧文件显式字段。
          models: [completeZCodeBuiltinModelRule()],
        }),
      ),
      "utf8",
    );
    await writeFile(
      legacyFilePath,
      JSON.stringify({
        model: "custom/model-a",
        provider: {
          custom: {
            kind: "anthropic",
            options: {
              apiKey: "secret",
              baseURL: "https://custom.example.com",
            },
            models: {
              "model-a": {
                limit: { context: 64_000, output: 8_000 },
              },
            },
          },
        },
      }),
      "utf8",
    );
    const env = {
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: zcodeBuiltinFilePath,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
    };

    // Protocol 启动会创建自己的空目标文件；若与 Standalone 共用目标，就会提前消费
    // “仅目标不存在时导入”的机会，无法再证明 Standalone importer 的独立边界。
    const protocolRuntime = await startProcessProviderRegistryRuntime({
      ...env,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(root, "protocol-personal.json"),
    });
    expect(protocolRuntime?.snapshot.registry.providers).toEqual([]);
    expect(protocolRuntime?.configuredDefaultModelSelection).toBeUndefined();
    protocolRuntime?.dispose();

    const standaloneRuntime = await startProcessProviderRegistryRuntime(env, {
      standalone: { legacyCliUserConfigFilePath: legacyFilePath },
    });
    expect(standaloneRuntime?.snapshot.registry.providers.map((entry) => entry.providerId)).toEqual(
      ["custom"],
    );
    expect(JSON.parse(await readFile(personalFilePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            { providerId: "custom", config: { access: { type: "api-key", apiKey: "secret" } } },
          ],
        },
      },
    });
    expect(standaloneRuntime?.configuredDefaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    expect(
      JSON.parse(await readFile(personalFilePath, "utf8")).config.defaultModelSelection,
    ).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    standaloneRuntime?.dispose();

    const protocolRestart = await startProcessProviderRegistryRuntime(env);
    expect(protocolRestart?.configuredDefaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    protocolRestart?.dispose();

    await writeFile(
      legacyFilePath,
      JSON.stringify({
        provider: {
          replacement: {
            kind: "anthropic",
            options: {
              apiKey: "replacement-secret",
              baseURL: "https://replacement.example.com",
            },
            models: {
              "model-b": { limit: { context: 32_000, output: 4_000 } },
            },
          },
        },
      }),
      "utf8",
    );
    const restarted = await startProcessProviderRegistryRuntime(env, {
      standalone: { legacyCliUserConfigFilePath: legacyFilePath },
    });
    expect(restarted?.snapshot.registry.providers.map((entry) => entry.providerId)).toEqual([
      "custom",
    ]);
    expect(restarted?.configuredDefaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });
    restarted?.dispose();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-process-provider-registry-"));
  temporaryDirectories.push(directory);
  return directory;
}

function completeZCodeBuiltinModelRule() {
  return {
    modelMatch: ".*",
    config: {
      enabled: true,

      properties: {
        requiresMfjsToolSchema: false,
        contextWindow: 200_000,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      },
      optionSpecs: {
        reasoningLevel: { values: ["disabled"], map: "{}" },
        maxOutputTokens: {
          max: 32_000,
          map: '{"max_completion_tokens":maxOutputTokens}',
        },
      },
    },
  } as const;
}

function zcodeBuiltinRelease(input: {
  readonly providers: object;
  readonly templates: object;
  readonly models: readonly unknown[];
}): object {
  return {
    schemaVersion: ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: 1,
    config: {
      providerConfigRules: {
        providerRules: Object.entries(input.providers).map(([providerId, config]) => ({
          providerId,
          config,
        })),
        templateRules: Object.entries(input.templates).map(([templateId, config]) => ({
          templateId,
          templateNameMap: { "en-US": templateId, "zh-CN": templateId },
          config,
        })),
      },
      modelConfigRules: {
        modelRules: input.models,
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  };
}

function personalRelease(providerRules: readonly unknown[]) {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}
