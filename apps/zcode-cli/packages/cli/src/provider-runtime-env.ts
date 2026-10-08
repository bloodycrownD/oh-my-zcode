import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  decodeZCodeBuiltinRelease,
  materializeZCodeBuiltinProviderConfig,
  NodeZCodeBuiltinProviderConfigSource,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  resolveBundledZCodeBuiltinProviderConfigPath,
  resolveZCodeBuiltinCachePaths,
  resolveZCodeBuiltinClientPlatform,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  type ZCodeBuiltinRefreshEvent,
} from "@zcode/provider-node";
import { resolveRuntimeZCodeEndpointOrigin, ZCODE_VERSION } from "@zcode/shared";
import type { CliEnv } from "./env.js";

export const SEA_ZCODE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY = "zcode-provider/zcode-builtin.json";

export function createCliProviderRefreshReporter(
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
) {
  return {
    onBuiltinRefreshError(error: unknown) {
      stderr.write(
        `ZCode Built-in 刷新失败: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    },
    onBuiltinRefreshResult(event: ZCodeBuiltinRefreshEvent) {
      // TTL 检查不是生产事件；成功更新才默认留痕，不能输出 CDN URL 查询参数或内容。
      if (event.result === "updated" || process.env.NODE_ENV !== "production") {
        stderr.write(
          `ZCode Built-in ${event.result}${event.reason ? ` (${event.reason})` : ""}${event.revision === undefined ? "" : ` revision=${event.revision} source=CDN`}\n`,
        );
      }
    },
  };
}

type SeaProviderConfigAssets = Pick<typeof import("node:sea"), "getAsset" | "isSea">;

interface PrepareCliProviderRuntimeEnvOptions {
  readonly argv: readonly string[];
  readonly env: CliEnv;
  readonly dataBaseDir?: string;
  readonly entrypoint?: string;
  readonly sea?: SeaProviderConfigAssets;
  readonly appVersion?: string;
  readonly platform?: string;
}

/** 为运行 Core 或写入模型选择的 CLI Entry 定位同一 Environment 的 Provider Config。 */
export async function prepareCliProviderRuntimeEnv(
  options: PrepareCliProviderRuntimeEnvOptions,
): Promise<Record<string, string>> {
  if (!requiresProviderRuntime(options.argv)) return {};

  let explicitZCodeBuiltin = options.env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const explicitPersonal = options.env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const dataBaseDir = options.dataBaseDir ?? options.env.ZCODE_DATA_BASE_DIR?.trim() ?? homedir();
  if (explicitZCodeBuiltin && explicitPersonal) {
    // FORK（readonly-provider-fallback）：显式成对时也不能免检——本机残留的全局
    // ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 可能与 personal 一同存在且 builtin 一侧已失效
    // （旧安装缓存，schema 不兼容），原样透传会让 app-server 在
    // startProcessProviderRegistryRuntime 里再次「Bundled 与 Active 均不可用」整进程退出。
    // 先用无兜底探针校验显式 builtin：可读才按原样返回；失效则清空显式值，落到下方
    // 主路径按「随包基线解析 + bundledFallbackFilePath 兜底」救援。
    // FORK（cr-fix DF-C-1）：探针改为纯读取校验（readFile + JSON.parse +
    // decodeZCodeBuiltinRelease）。早先经 NodeZCodeBuiltinProviderConfigSource.read() 会
    // mkdir/加锁写盘，在（可能属于另一旧安装的）用户目录留下 lock 目录；纯校验不应有副作用。
    if (!(await isZCodeBuiltinReleaseFileReadable(explicitZCodeBuiltin))) {
      explicitZCodeBuiltin = undefined;
    }
    if (explicitZCodeBuiltin) {
      return {
        [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: explicitZCodeBuiltin,
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: explicitPersonal,
      };
    }
  }

  // FORK（readonly-provider-fallback）：显式 env 值可能指向与当前 schema 脱节的旧缓存
  // （本机遗留的 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向 ~/.zcode 3.14.x），此时它充当的
  // 「随包基线」本身无效，又没有兜底，app-server/TUI 会在启动时整进程退出（桌面侧表现为
  // 「ZCode agent transport closed: stdout_closed」，设置页报「读取上下文管理配置失败」）。
  // 这里与桌面侧 bundledFallbackFilePath、构建脚本 D-16 同语义：无条件解析真实随包基线
  // 作为 source 的兜底，显式值失效时回落并告警，而不是让进程死掉。
  let bundledBaselinePath: string | undefined;
  try {
    bundledBaselinePath = await resolveBundledZCodeBuiltinProviderConfig({
      dataBaseDir,
      entrypoint: options.entrypoint ?? process.argv[1],
      sea: options.sea ?? getSeaProviderConfigAssets(),
    });
  } catch {
    // 基线本身不可解析（个别自定义部署形态）时保留显式值的既有行为，不新增失败面。
    // FORK（cr-fix DF-A-1 改法 3）可选兜底：宿主（如桌面 Host 经 spawn env）已下发的
    // ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE 若真实存在，接受它作最后候选——否则
    // 显式值失效且本机解析不出基线时，进程仍会「Bundled 与 Active 均不可用」整段退出。
    const inheritedBundled = options.env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]?.trim();
    bundledBaselinePath =
      inheritedBundled && existsSync(inheritedBundled) ? inheritedBundled : undefined;
  }
  const zcodeBuiltinFilePath = explicitZCodeBuiltin ?? bundledBaselinePath;
  if (!zcodeBuiltinFilePath) {
    throw new Error("无法定位 CLI ZCode Built-in Provider Config：缺少入口路径");
  }
  const personalFilePath =
    explicitPersonal ?? join(dataBaseDir, ".omz", "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  const appVersion = options.appVersion ?? ZCODE_VERSION;
  const platform = options.platform ?? resolveZCodeBuiltinClientPlatform();
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(options.env);
  const cachePaths = resolveZCodeBuiltinCachePaths({
    environmentConfigRoot: join(dataBaseDir, ".omz", "v2"),
    platform,
    appVersion,
    zcodeEndpointOrigin,
  });
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: zcodeBuiltinFilePath,
    activeFilePath: cachePaths.activeFilePath,
    bundledFallbackFilePath:
      explicitZCodeBuiltin && bundledBaselinePath && bundledBaselinePath !== explicitZCodeBuiltin
        ? bundledBaselinePath
        : undefined,
    watch: false,
  });
  // 入口只准备资源和路径；下载由 Prompt/TUI 长生命周期 Runtime 持有并取消。
  try {
    await source.read();
  } finally {
    source.dispose();
  }

  return {
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: cachePaths.activeFilePath,
    // 随包基线恒返回真实基线路径：即使本次以显式值作为读取入口，下游 registry
    // （startProcessProviderRegistryRuntime）也不得把可能陈旧的显式值当 bundled 基线，
    // 否则那里会再次失去兜底能力。
    [ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]: bundledBaselinePath ?? zcodeBuiltinFilePath,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
  };
}

function requiresProviderRuntime(argv: readonly string[]): boolean {
  if (argv.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v")) {
    return false;
  }
  if (
    argv.some(
      (arg) =>
        arg === "--prompt" ||
        arg.startsWith("--prompt=") ||
        arg === "--target" ||
        arg.startsWith("--target="),
    )
  ) {
    return true;
  }

  const command = argv[0];
  if (command === undefined || command.startsWith("-")) return true;
  return command === "tui" || command === "app-server" || command === "agent-server";
}

async function resolveBundledZCodeBuiltinProviderConfig(input: {
  readonly dataBaseDir: string;
  readonly entrypoint: string | undefined;
  readonly sea: SeaProviderConfigAssets | undefined;
}): Promise<string> {
  if (input.sea?.isSea()) {
    const content = input.sea.getAsset(SEA_ZCODE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY, "utf8");
    return materializeZCodeBuiltinProviderConfig({
      environmentConfigRoot: join(input.dataBaseDir, ".omz", "v2"),
      content,
    });
  }

  const entrypoint = input.entrypoint?.trim();
  if (!entrypoint) throw new Error("无法定位 CLI ZCode Built-in Provider Config：缺少入口路径");
  // 全局 bin 可以是软链接，随包配置必须相对真实入口定位。
  const entryDirectory = dirname(realpathSync(resolve(entrypoint)));
  // FORK（cr-fix DF-A-1）：候选布局（CLI 打包/dev、桌面打包 resources/glm → resources/config/
  // provider、桌面 dev）由 @zcode/provider-node 的 resolveBundledZCodeBuiltinProviderConfigPath
  // 单点维护，与 packages/desktop/src/main/desktopProviderConfig.ts 共用同一函数。
  return resolveBundledZCodeBuiltinProviderConfigPath({ entryDirectory });
}

/**
 * FORK（cr-fix DF-C-1）：显式成对路径的无写入探针。
 * 判定口径与 NodeZCodeBuiltinProviderConfigSource 的候选解码一致（decodeZCodeBuiltinRelease），
 * 但不构造 source、不 mkdir/加锁、不物化 Active 缓存。
 */
async function isZCodeBuiltinReleaseFileReadable(filePath: string): Promise<boolean> {
  try {
    decodeZCodeBuiltinRelease(JSON.parse(await readFile(filePath, "utf8")));
    return true;
  } catch {
    return false;
  }
}

function getSeaProviderConfigAssets(): SeaProviderConfigAssets | undefined {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => typeof import("node:sea"))
    | undefined;
  return getBuiltinModule?.("node:sea");
}
