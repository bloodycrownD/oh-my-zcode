import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  type ModelId,
  type ProviderApiType,
  type ProviderGroup,
  type ProviderLogoRef,
  type ProviderVisibility,
} from "../src/index.js";

interface CommonProviderFixtureInput {
  readonly group?: ProviderGroup | null;
  readonly label?: string | null;
  readonly logo?: ProviderLogoRef | null;
  readonly apiFormat?: ProviderApiType | null;
  readonly baseURL?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly models?: readonly ModelId[] | null;
  readonly personalModels?: readonly ModelId[] | null;
  readonly visibility?: ProviderVisibility | null;
}

interface ApiKeyProviderFixtureInput extends CommonProviderFixtureInput {
  readonly apiKey?: string | null;
  readonly apiKeyManagementUrl?: string | null;
}

// FORK: createAccountProviderConfig（zhipu-account 计费面）已随账号 Overlay 整删；
// 该面不再回归，测试统一走 api-key 形态。

/** 测试夹具把常用字段压平；生产 Schema 仍使用 access/api 两个明确边界。 */
export function createApiKeyProviderConfig(input: ApiKeyProviderFixtureInput = {}): ProviderConfig {
  return new ProviderConfig({
    group: input.group === null ? undefined : (input.group ?? "standard-personal"),
    logo: input.logo,
    access: new ApiKeyAccessConfig({
      apiKey: input.apiKey,
      apiKeyManagementUrl: input.apiKeyManagementUrl,
    }),
    api: createProviderApi(input),
    builtinModelIds: input.models,
    personalModelIds: input.personalModels,
    visibility: input.visibility,
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
