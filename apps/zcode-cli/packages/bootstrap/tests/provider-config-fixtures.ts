import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  type ModelId,
  type ProviderApiType,
} from "@zcode/provider";

interface CommonProviderFixtureInput {
  readonly label?: string | null;
  readonly apiFormat?: ProviderApiType | null;
  readonly baseURL?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly models?: readonly ModelId[] | null;
  readonly enabled?: boolean | null;
}

export function createApiKeyProviderConfig(
  input: CommonProviderFixtureInput & {
    readonly apiKey?: string | null;
  } = {},
): ProviderConfig {
  return new ProviderConfig({
    label: input.label,
    access: new ApiKeyAccessConfig({ apiKey: input.apiKey }),
    api: createProviderApi(input),
    builtinModelIds: input.models,
    personalModelIds: [],
    enabled: input.enabled ?? true,
    visibility: "visible",
  });
}

// FORK（D-4）：账号 Overlay 已随 zhipu-account 计费面整删，本夹具不再提供
// createAccountProviderConfig；测试统一走 api-key 形态。

function createProviderApi(input: CommonProviderFixtureInput): ProviderApiConfig | undefined {
  return input.apiFormat !== undefined || input.baseURL !== undefined || input.headers !== undefined
    ? new ProviderApiConfig({
        type: input.apiFormat,
        baseUrl: input.baseURL,
        headers: input.headers,
      })
    : undefined;
}
