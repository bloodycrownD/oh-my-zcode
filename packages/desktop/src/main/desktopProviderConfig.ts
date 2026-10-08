import { app } from "electron";
import { join } from "node:path";

export function resolveZCodeBuiltinProviderConfigFilePath(options?: {
  readonly appPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
}): string {
  const explicitPath = (options?.env ?? process.env)["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim();
  if (explicitPath) return explicitPath;
  return resolveDefaultZCodeBuiltinProviderConfigFilePath(options);
}

/**
 * 随包基线路径：与显式 env 覆盖无关的兜底候选。
 * 显式覆盖可能指向旧版本缓存（schema 不兼容）或损坏文件，Bundled 基线无效时
 * Host 会回落到这份路径（语义与构建脚本 builtin-provider-config.mjs 一致）。
 */
export function resolveDefaultZCodeBuiltinProviderConfigFilePath(options?: {
  readonly appPath?: string;
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
}): string {
  if (options?.isPackaged ?? app.isPackaged) {
    return join(
      options?.resourcesPath ?? process.resourcesPath,
      "config/provider/zcode-builtin.json",
    );
  }
  // 开发态与打包共用唯一线上配置源。
  const filename = "zcode-builtin.json";
  return join(options?.appPath ?? app.getAppPath(), "../../config/provider", filename);
}
