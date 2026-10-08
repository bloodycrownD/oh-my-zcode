export const ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";
export const ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV =
  "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";
export const ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";
export const PERSONAL_PROVIDER_CONFIG_FILE_NAME = "provider_config.json";

export interface NodeProviderRuntimePaths {
  readonly zcodeBuiltinFilePath: string;
  readonly personalFilePath: string;
}

export function createNodeProviderRuntimePathEnv(
  paths: NodeProviderRuntimePaths,
): Record<string, string> {
  return {
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: paths.zcodeBuiltinFilePath,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: paths.personalFilePath,
  };
}

export function resolveNodeProviderRuntimePaths(
  env: Readonly<Record<string, string | undefined>>,
): NodeProviderRuntimePaths | null {
  const zcodeBuiltinFilePath = env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const personalFilePath = env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!zcodeBuiltinFilePath && !personalFilePath) return null;
  if (!zcodeBuiltinFilePath || !personalFilePath) {
    throw new Error("ZCode Built-in 与 Personal Provider Config 路径必须同时提供");
  }
  return Object.freeze({ zcodeBuiltinFilePath, personalFilePath });
}

export interface ZCodeBuiltinBundledEnvSource {
  /** 随包基线路径（桌面 Main 按 packed/dev 布局解析，可能缺省）。 */
  readonly zcodeBuiltinProviderConfigFallbackFilePath?: string;
  /** 显式覆盖路径（Active/显式 env）；仅在无 fallback 时兜底，语义上只是读取入口。 */
  readonly zcodeBuiltinProviderConfigFilePath?: string;
}

// FORK（cr-fix DF-C-orch-1）：BUNDLED env 必须是「真实随包基线」——优先下发桌面 Main
// 解析出的 fallback；仅当 fallback 缺省时才退回显式值（此时该值即随打包布局解析出的
// 基线）。services/node.ts 的 agent spawn env 用此函数取值：CLI 成对显式早退路径不返回
// BUNDLED 时，agent 继承到的不会是可能 stale 的显式覆盖，避免
// process-provider-registry-runtime 把它当 bundled 基线、Active 坏即整段判死。
export function createZCodeBuiltinBundledEnv(
  source: ZCodeBuiltinBundledEnvSource,
): Record<string, string> {
  const bundled =
    source.zcodeBuiltinProviderConfigFallbackFilePath ?? source.zcodeBuiltinProviderConfigFilePath;
  // 双缺省时不注入该键：undefined 值本就不会随 env 序列化下发，保持 spawn env 的
  // Record<string, string> 契约。
  return bundled === undefined ? {} : { [ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]: bundled };
}
