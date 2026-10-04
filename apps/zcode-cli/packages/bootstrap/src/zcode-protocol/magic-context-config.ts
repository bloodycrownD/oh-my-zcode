import { ConfigKey } from "@zcode/contracts";
import { getDefaultConfigPath, updateMagicContextInFileConfig } from "@zcode/adapters/config";
import { MagicContextConfigSchema } from "@zcode/magic-context";
import {
  zcodeWorkspaceUpdateMagicContextConfigParamsSchema,
  zcodeWorkspaceUpdateMagicContextConfigResultSchema,
  type ZCodeWorkspaceUpdateMagicContextConfigResult,
} from "@zcode/shared";
import {
  parseParams,
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * FORK（S23 / D-12）：写 `magicContext` 参数域，并让进程内所有已装配的
 * magic-context 实例立刻看到新值。
 *
 * ============================================================================
 * 与 `interaction-preferences.ts` 的差异（spec D-12 点名：那个方法只改内存、
 * 不写盘、不推送，**不可作整体范式**）：
 *
 *   | 段 | interaction-preferences | 本方法 |
 *   |---|---|---|
 *   | 校验 | 协议 schema `.strict()` | 协议信封 `.strict()` + 包内 `MagicContextConfigSchema`（字段级） |
 *   | 写盘 | 无 | `updateMagicContextInFileConfig`（atomicWriteJson，顶层域） |
 *   | 内存 | 直接改 `context.appRuntimePreferences` 对象字段 | `ConfigPort.set(ConfigKey.MagicContext, parsed)` |
 *   | 推送 | 无（消费方主动拉） | 由 `ConfigPort.observe` 的 fan-out 完成，见 bootstrap 装配层 |
 *
 * ============================================================================
 * 三段顺序是**有意的**，不能调换：
 *
 *   ① 校验 → ② 写盘 → ③ configPort.set
 *
 * 先校验是因为写盘与 set 都不可撤销；先写盘后 set 是因为 set 会立刻通过
 * `ConfigPort.observe` 广播给正在跑的 turn——若先广播再写盘，用户会看到「新值已
 * 生效」然后磁盘写失败（只读家目录 / 磁盘满），得到一个内存与磁盘永久分叉的
 * 进程。反过来（先写盘成功、再广播）最坏只是「磁盘已改但本次进程未生效」，
 * 重启即追上，属于可恢复方向。
 *
 * 目标路径固定为用户级 `~/.zcode/cli/config.json`（`getDefaultConfigPath()`），
 * 不接受调用方传路径：D-12 的配置真源就是这一个文件，让协议参数带路径等于开一个
 * 「写到任意文件」的入口。workspace 维度只用于定位内存侧的 ConfigPort。
 */

/** 供单测注入的窄缝；生产路径固定为默认用户配置路径。 */
export interface UpdateMagicContextConfigDependencies {
  configPath?: string;
}

export async function updateMagicContextConfig(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  dependencies: UpdateMagicContextConfigDependencies = {},
): Promise<ZCodeWorkspaceUpdateMagicContextConfigResult> {
  const params = parseParams(zcodeWorkspaceUpdateMagicContextConfigParamsSchema, rawParams);

  // ① 字段级校验。协议层刻意只约束「是个 JSON 值」（见 shared 侧注释），真正的
  // 白名单在包里；这里用**同一个** schema 对象，因此 CLI 校验、config.json 装载
  // 校验与包内运行时读取三者不可能各说一套。
  const parsed = MagicContextConfigSchema.safeParse(params.config ?? {});
  if (!parsed.success) {
    throw new ProtocolRequestError(
      -32602,
      `Invalid params — magicContext: ${formatIssues(parsed.error)}`,
      parsed.error,
    );
  }

  // ② 写盘。
  const persisted = await updateMagicContextInFileConfig(
    dependencies.configPath ?? getDefaultConfigPath(),
    parsed.data,
  );

  // ③ 内存 + 推送。逐个 resident session 推：每个 App 持有自己的 ConfigPort
  // （`createConfig()` 每次新建），而每个启用了 magic-context 的 App 的 config
  // bridge 都订阅着自己那份 Port。少推一个就等于给那个 session 留一份冻结配置。
  // 没有活跃 session 时只落盘——下次建 App 时 `createConfig` 会重新读文件。
  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    const configPort = record.app.getConfigPort?.();
    if (!configPort) continue;
    configPort.set(ConfigKey.MagicContext, parsed.data);
    updatedSessionCount += 1;
  }
  context.logger?.info("magicContext config updated", {
    module: "bootstrap.zcode_protocol",
    event: "zcode_protocol.magic_context.config_updated",
    changed: persisted.changed,
    configPath: persisted.path,
    updatedSessionCount,
    workspaceKey: params.workspace.workspaceKey,
  });

  return zcodeWorkspaceUpdateMagicContextConfigResultSchema.parse({
    workspace: params.workspace,
    path: persisted.path,
    changed: persisted.changed,
    applied: true,
  });
}

function formatIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
}