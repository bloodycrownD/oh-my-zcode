import { loadEndpointEnv } from "./load-endpoint-env.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function resolveBuiltinProviderBuildEnvironment({
  root = repositoryRoot,
  env = process.env,
} = {}) {
  let value = env.ZCODE_ENV;
  if (!value?.trim()) {
    const files = [
      ".env",
      ...(env.NODE_ENV === "production"
        ? [".env.production"]
        : [".env.development", ".env.development.local"]),
    ];
    for (const file of files) {
      let content;
      try {
        content = await readFile(resolve(root, file), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const parsed = parseEnv(content);
      if (parsed.ZCODE_ENV !== undefined) value = parsed.ZCODE_ENV;
    }
  }
  const normalized = value?.trim().toLowerCase() || "test";
  if (normalized !== "test" && normalized !== "production") {
    throw new Error(`Invalid ZCODE_ENV for Built-in Provider build: ${normalized}`);
  }
  return normalized;
}

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function loadBuiltinProviderConfig({ root = repositoryRoot, env = process.env } = {}) {
  env = await loadEndpointEnv({ root, env });
  const environment = await resolveBuiltinProviderBuildEnvironment({ root, env });
  const bundledPath = resolve(root, "config/provider/zcode-builtin.json");
  const sourcePath = resolve(
    root,
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() || "config/provider/zcode-builtin.json",
  );
  // tsx 仅供构建工具加载仓库 TS，不进入产品 bundle，也不复制一份校验规则。
  // Windows 绝对路径的盘符会被 ESM 当作协议，转为 file URL 后各平台共用同一加载入口。
  const { decodeZCodeBuiltinRelease } = await tsImport(
    pathToFileURL(resolve(repositoryRoot, "packages/provider-node/src/zcode-builtin-release.ts"))
      .href,
    import.meta.url,
  );
  /** @param {string} path */
  const loadValidated = async (path) => {
    const content = await readFile(path, "utf8");
    // 构建期复用运行时的完整 Release 校验，避免打包成功后才发现 Schema 不兼容。
    decodeZCodeBuiltinRelease(JSON.parse(content));
    return content;
  };

  try {
    return { environment, sourcePath, content: await loadValidated(sourcePath) };
  } catch (error) {
    // FORK（D-16）：升级用户的旧缓存仍是已删除的 access schema（如 zhipu-account）时，
    // 显式指向它的构建会直接失败。这里按运行时同款语义回落随包基线并给出可检索的告警——
    // 缓存本就是可丢弃物，让它阻断构建没有收益。
    const isSchemaMismatch =
      typeof error === "object" &&
      error !== null &&
      (error.name === "ZodError" || error.code === "invalid_value");
    if (!isSchemaMismatch || sourcePath === bundledPath) {
      throw new Error(`Invalid Built-in Provider config (${environment}): ${sourcePath}`, {
        cause: error,
      });
    }
    console.warn(
      `[builtin-provider-config] ${sourcePath} 与当前 schema 不兼容，已回落随包基线：${bundledPath}`,
    );
    return { environment, sourcePath: bundledPath, content: await loadValidated(bundledPath) };
  }
}

/** @param {{directory: string, root?: string, env?: Record<string, string | undefined>}} options */
export async function stageBuiltinProviderConfig({ directory, ...options }) {
  const config = await loadBuiltinProviderConfig(options);
  await mkdir(directory, { recursive: true });
  // bootstrap 可以复用 JS，但不能连带复用上一环境／上一版本的独立配置资源。
  await writeFile(resolve(directory, "zcode-builtin.json"), config.content, "utf8");
  return config;
}
