import { app } from "electron";
import { join } from "node:path";
import { resolveBundledZCodeBuiltinProviderConfigPath } from "@zcode/provider-node";

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
 *
 * FORK（cr-fix DF-A-1）：布局候选与 CLI 共用 @zcode/provider-node 的
 * resolveBundledZCodeBuiltinProviderConfigPath（CLI 打包/dev、桌面打包 resources/glm、
 * 桌面 dev 四种布局单点维护）。本函数在 Main 进程同步调用点使用，探测不到（未打包资产的
 * 自定义部署）时回退到与 electron-builder `to:` 对齐的默认布局，保持「必返回路径」语义。
 */
export function resolveDefaultZCodeBuiltinProviderConfigFilePath(options?: {
  readonly appPath?: string;
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
}): string {
  const isPackaged = options?.isPackaged ?? app.isPackaged;
  const resourcesPath = options?.resourcesPath ?? process.resourcesPath;
  const appPath = options?.appPath ?? app.getAppPath();
  try {
    return resolveBundledZCodeBuiltinProviderConfigPath({
      // 打包态 agent 入口是 resources/glm/zcode.cjs（electron-builder extraResources），
      // 从它上溯一级得到 resources/config/provider；开发态入口在 app 包根，命中仓库基线。
      entryDirectory: isPackaged ? join(resourcesPath, "glm") : appPath,
    });
  } catch {
    return isPackaged
      ? join(resourcesPath, "config/provider/zcode-builtin.json")
      : join(appPath, "../../config/provider", "zcode-builtin.json");
  }
}
