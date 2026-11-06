import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  type ModelId,
  type ProviderApiType,
  type ProviderLogoRef,
} from "@zcode/provider";

interface CommonProviderFixtureInput {
  readonly label?: string | null;
  readonly logo?: ProviderLogoRef | null;
  readonly apiFormat?: ProviderApiType | null;
  readonly baseURL?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly models?: readonly ModelId[] | null;
  readonly enabled?: boolean | null;
}

export function createApiKeyProviderConfig(
  input: CommonProviderFixtureInput & {
    apiKey?: string | null;
    apiKeyManagementUrl?: string | null;
  } = {},
): ProviderConfig {
  return new ProviderConfig({
    label: input.label,
    logo: input.logo,
    access: new ApiKeyAccessConfig({
      apiKey: input.apiKey,
      apiKeyManagementUrl: input.apiKeyManagementUrl,
    }),
    api: createProviderApi(input),
    builtinModelIds: input.models,
    enabled: input.enabled,
  });
}

// FORK（D-4）：createAccountProviderConfig 随 zhipu-account 计费面整删；
// 账号 Overlay 不再回归，测试统一走 api-key 形态。

export function createCompleteApiKeyProviderConfig(
  input: CommonProviderFixtureInput & {
    apiKey?: string | null;
  } = {},
): ProviderConfig {
  return new ProviderConfig({
    label: input.label,
    logo: input.logo,
    access: new ApiKeyAccessConfig({ apiKey: input.apiKey }),
    api: new ProviderApiConfig({
      type: input.apiFormat ?? "anthropic-messages",
      baseUrl: input.baseURL ?? "https://api.example.com",
      headers: input.headers,
    }),
    builtinModelIds: input.models,
    enabled: input.enabled,
  });
}

function createProviderApi(input: CommonProviderFixtureInput): ProviderApiConfig | undefined {
  return input.apiFormat !== undefined || input.baseURL !== undefined || input.headers !== undefined
    ? new ProviderApiConfig({
        type: input.apiFormat,
        baseUrl: input.baseURL,
        headers: input.headers,
      })
    : undefined;
}
