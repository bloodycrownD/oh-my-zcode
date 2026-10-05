import {
  ProviderConfigMap,
  ProviderTemplateMap,
  type ModelConfigRules,
} from "./config/index.js";
import type { AccountProviderStates } from "./account-provider-state.js";

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

export interface AccountProviderConfigSnapshot {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: ProviderConfigMap;
  readonly states?: AccountProviderStates;
}

const EMPTY_ACCOUNT_PROVIDER_CONFIG_SNAPSHOT: AccountProviderConfigSnapshot = Object.freeze({
  revision: "empty-account-config-v1",
  basedOnZCodeBuiltinRevision: "uninitialized",
  providers: ProviderConfigMap.empty(),
});

/**
 * FORK（D-4）：账号体系整删后 Registry 只剩 Config 一个数据源。
 *
 * 快照形状保留是为了让 Registry 的读取路径不必为「第二事实源」留分支；
 * 这里恒定返回空 Overlay，不再有 revision 对齐门，Registry 永远能发布。
 */
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