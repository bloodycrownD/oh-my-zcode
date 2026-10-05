import { ProviderConfigMap, ProviderTemplateMap, type ModelConfigRules } from "./config/index.js";

export interface ProviderSource<TSnapshot> {
  read(): Promise<TSnapshot>;
  onDidChange(listener: (reason: string) => void): () => void;
}

export interface ProviderConfigSnapshot {
  readonly revision: string;
  readonly zcodeBuiltinRevision: string;
  readonly personalRevision: string;
  readonly zcodeBuiltinProviders: ProviderConfigMap;
  readonly zcodeBuiltinProviderTemplates: ProviderTemplateMap;
  readonly personalProviders: ProviderConfigMap;
  readonly zcodeBuiltinModelRules: ModelConfigRules;
  readonly personalModels: ModelConfigRules;
  readonly personalProviderOrder?: readonly string[];
}

/**
 * FORK（D-4）：账号 Overlay 已整删，快照退化为恒空形状。
 * 保留它只是为了让 Registry 的读取路径不为「第二事实源」留分支。
 */
export interface AccountProviderConfigSnapshot {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: ProviderConfigMap;
}

const EMPTY_ACCOUNT_PROVIDER_CONFIG_SNAPSHOT: AccountProviderConfigSnapshot = Object.freeze({
  revision: "empty-account-config-v1",
  basedOnZCodeBuiltinRevision: "uninitialized",
  providers: ProviderConfigMap.empty(),
});

/** FORK（D-4）：恒定空账号源；Registry 只读 Config 一个数据源。 */
export function createEmptyAccountProviderConfigSource(): ProviderSource<AccountProviderConfigSnapshot> {
  return {
    async read(): Promise<AccountProviderConfigSnapshot> {
      return EMPTY_ACCOUNT_PROVIDER_CONFIG_SNAPSHOT;
    },
    onDidChange(): () => void {
      return () => undefined;
    },
  };
}
