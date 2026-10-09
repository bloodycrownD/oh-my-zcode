import { resolveRuntimeZCodeEndpointOrigin, ZCODE_VERSION } from "@zcode/shared";
import { dirname, join } from "node:path";
import {
  NodeModelSelectionConfigRepository,
  NodeProviderRegistryRuntime,
  resolveNodeProviderRuntimePaths,
  downloadZCodeBuiltinRelease,
  resolveZCodeBuiltinClientPlatform,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  type ZCodeBuiltinRefreshEvent,
} from "@zcode/provider-node";
import { readLegacyCliPersonalProviderConfig } from "./legacy-cli-personal-provider-config-importer.js";

export interface ProcessProviderRegistryRuntimeOptions {
  /** Standalone Prompt CLI / TUI 自己拥有旧配置的一次性导入。 */
  readonly standalone?: {
    readonly legacyCliUserConfigFilePath?: string;
    readonly request?: typeof fetch;
    readonly onBuiltinRefreshError?: (error: unknown) => void;
    readonly onBuiltinRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
  };
}

export async function startProcessProviderRegistryRuntime(
  env: Readonly<Record<string, string | undefined>>,
  options: ProcessProviderRegistryRuntimeOptions = {},
) {
  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths) {
    throw new Error("缺少进程 Provider Registry 的 ZCode Built-in / Personal Config 路径");
  }

  // BUNDLED env 的读取不设 standalone 门槛：Desktop host 给 agent 下发的 spawn env
  // 里 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 永远是「按 endpoint 隔离的 Active 缓存」，
  // 升级用户的旧缓存仍是已删字段（如 access.accountType）时，没有随包基线可回落
  // 就只能整段判死（模型配置加载失败）。远端同步仍只属于 standalone——本 fork 的
  // Built-in 目录已冻结为打包内置，桌面 agent 不得自行远端拉取。
  const bundledFile = env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]?.trim();
  const runtime = new NodeProviderRegistryRuntime({
    ...paths,
    ...(bundledFile
      ? {
          zcodeBuiltinFilePath: bundledFile,
          zcodeBuiltinActiveFilePath: paths.zcodeBuiltinFilePath,
        }
      : {}),
    ...(bundledFile && options.standalone
      ? {
          zcodeBuiltinRemote: {
            controlFilePath: join(
              dirname(paths.zcodeBuiltinFilePath),
              "zcode-builtin-refresh.json",
            ),
            resolveEndpointKey: () => resolveRuntimeZCodeEndpointOrigin(env),
            fetchRelease: (endpointOrigin, signal) =>
              downloadZCodeBuiltinRelease({
                endpointOrigin,
                signal,
                appVersion: ZCODE_VERSION,
                platform: resolveZCodeBuiltinClientPlatform(),
                request: options.standalone?.request ?? globalThis.fetch,
              }),
            onRefreshResult: options.standalone?.onBuiltinRefreshResult,
          },
        }
      : {}),
    onZCodeBuiltinRefreshError: options.standalone?.onBuiltinRefreshError,
    ...(options.standalone
      ? {
          importLegacy: () =>
            readLegacyCliPersonalProviderConfig({
              ...(options.standalone?.legacyCliUserConfigFilePath
                ? { filePath: options.standalone.legacyCliUserConfigFilePath }
                : {}),
            }),
        }
      : {}),
  });
  try {
    await runtime.start();
    const snapshot = runtime.registryService.getSnapshot()!;
    const modelSelectionConfigRepository = new NodeModelSelectionConfigRepository({
      personalRepository: runtime.personalRepository,
    });
    try {
      const configuredDefaultModelSelection = await modelSelectionConfigRepository.read();
      // ①默认模型实时（spec 1f）：Personal 文件的 defaultModelSelection 是进程内可变的
      // （TUI /model、设置页写回都会改它），首读快照会过期，而消费面（会话装配、
      // fallback 解析）需要**同步**拿到「此刻的默认选择」。repository 只有 async
      // read()，因此这里维护同步缓存：首读 await 后即缓存，onDidChange 触发后台刷新。
      // 缓存的唯一读者是 getConfiguredDefaultModelSelection()，退订挂在 dispose 上，
      // 进程退出不会留下悬挂订阅。
      let cachedConfiguredDefaultModelSelection = configuredDefaultModelSelection;
      let modelSelectionConfigDisposed = false;
      // 刷新链：并发的配置变更可能交错，链式执行保证缓存停在某个已提交版本上，
      // 不会被一次更早的读覆盖更晚的读。
      let configuredDefaultRefreshChain: Promise<void> = Promise.resolve();
      const unsubscribeModelSelectionConfig = modelSelectionConfigRepository.onDidChange(() => {
        if (modelSelectionConfigDisposed) return;
        configuredDefaultRefreshChain = configuredDefaultRefreshChain
          .then(() => modelSelectionConfigRepository.read())
          .then((next) => {
            cachedConfiguredDefaultModelSelection = next;
          })
          .catch(() => {
            // 读失败保持旧缓存：配置读取异常不得沿 registry 事件链反向抛出，
            // 下一次变更还会再刷一次。
          });
      });
      return Object.freeze({
        dispose() {
          modelSelectionConfigDisposed = true;
          unsubscribeModelSelectionConfig();
          modelSelectionConfigRepository.dispose();
          runtime.dispose();
        },
        /** 同步活读：同进程内默认模型配置变更后，这里返回新值。 */
        getConfiguredDefaultModelSelection: () => cachedConfiguredDefaultModelSelection,
        runtime,
        snapshot,
        modelSelectionConfigRepository,
        configuredDefaultModelSelection,
      });
    } catch (error) {
      modelSelectionConfigRepository.dispose();
      throw error;
    }
  } catch (error) {
    runtime.dispose();
    throw error;
  }
}
