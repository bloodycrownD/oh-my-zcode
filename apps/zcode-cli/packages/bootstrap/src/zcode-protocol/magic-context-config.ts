import { ConfigKey } from "@zcode/contracts";
import { getDefaultConfigPath, loadFileConfig, updateMagicContextInFileConfig } from "@zcode/adapters/config";
import { MagicContextConfigSchema } from "@zcode/magic-context";
import {
  zcodeWorkspaceReadMagicContextConfigParamsSchema,
  zcodeWorkspaceReadMagicContextConfigResultSchema,
  zcodeWorkspaceUpdateMagicContextConfigParamsSchema,
  zcodeWorkspaceUpdateMagicContextConfigResultSchema,
  type ZCodeWorkspaceReadMagicContextConfigResult,
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
 *   | 校验 | 协议 schema `.strict()` | 协议信封 `.strict()` + 包内 `MagicContextConfigSchema`（字段级；未知键 strip 而非拒） |
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
 * 目标路径固定为用户级 `~/.omz/cli/config.json`（`getDefaultConfigPath()`），
 * 不接受调用方传路径：D-12 的配置真源就是这一个文件，让协议参数带路径等于开一个
 * 「写到任意文件」的入口。workspace 维度只用于定位内存侧的 ConfigPort。
 */

/** 供单测注入的窄缝；生产路径固定为默认用户配置路径。 */
export interface UpdateMagicContextConfigDependencies {
  configPath?: string;
}

/**
 * FORK（Step 29 / D-12）：读回 effective 域，供设置分区渲染表单初值。
 *
 * 读取顺序刻意是「ConfigPort 优先、文件兜底」，与 update 的写入顺序相反：
 * update 刚把值推给所有 resident session，此刻 ConfigPort 才是运行时真正在用的
 * 那一份；只在有活动 session 时才「碰得到」，没有活动 session 说明配置面此刻
 * 没有读者，读文件得到的就是下次建 App 时 `createConfig` 会读到的同一份值。
 * 两条路径都过同一个 `MagicContextConfigSchema`，因此返回给 UI 的形状恒定，
 * 不会因为「有没有活动 session」而让表单在两种字段布局之间跳。
 *
 * 同样走 `getDefaultConfigPath()`，不接受调用方传路径——与 update 同一条纪律。
 */
export async function readMagicContextConfig(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  dependencies: UpdateMagicContextConfigDependencies = {},
): Promise<ZCodeWorkspaceReadMagicContextConfigResult> {
  const params = parseParams(zcodeWorkspaceReadMagicContextConfigParamsSchema, rawParams);
  const configPath = dependencies.configPath ?? getDefaultConfigPath();

  for (const record of context.sessions.values()) {
    const configPort = record.app?.getConfigPort?.();
    if (!configPort) continue;
    // ConfigPort 的 MagicContext 域**恒有值**（注册时就把 `.default()` 解析结果
    // 钉进去了，见 adapters config `setInitialConfig`），所以这里不需要再兜一层
    // undefined 合并——真有值就直接用，避免读路径与 update 路径各自补一遍默认值。
    const result = zcodeWorkspaceReadMagicContextConfigResultSchema.parse({
      workspace: params.workspace,
      path: configPath,
      config: configPort.get(ConfigKey.MagicContext),
    });
    return result;
  }

  const loaded = loadFileConfig(configPath);
  const result = zcodeWorkspaceReadMagicContextConfigResultSchema.parse({
    workspace: params.workspace,
    path: loaded.path,
    // `loadFileConfig` 装载失败时给的是 `{}`，这里让 schema 补齐成完整默认域，
    // 与 update 的 `params.config ?? {}` 兜底语义一致：文件坏掉时 UI 仍然看到
    // 一份可编辑的完整表单，而不是一堆 undefined 输入框。
    config: MagicContextConfigSchema.parse(loaded.config.magicContext ?? {}),
  });
  context.logger?.info("magicContext config read", {
    module: "bootstrap.zcode_protocol",
    event: "zcode_protocol.magic_context.config_read",
    configPath: loaded.path,
    fromConfigPort: false,
    workspaceKey: params.workspace.workspaceKey,
  });
  return result;
}

export async function updateMagicContextConfig(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  dependencies: UpdateMagicContextConfigDependencies = {},
): Promise<ZCodeWorkspaceUpdateMagicContextConfigResult> {
  const params = parseParams(zcodeWorkspaceUpdateMagicContextConfigParamsSchema, rawParams);

  // ① 字段级校验。协议层刻意只约束「是个 JSON 值」（见 shared 侧注释），真正的
  // 字段域在包里；这里用**同一个** schema 对象，因此 CLI 校验、config.json 装载
  // 校验与包内运行时读取三者不可能各说一套。
  //
  // 注意 `MagicContextConfigSchema` 是 `z.object({...})` 的默认语义 —— 对白名单外的
  // 键 **strip 而非 reject**：未知键被静默丢弃（不进 `parsed.data`，因而也不会被写盘
  // 或推给 ConfigPort），**只有类型/形状错误**才落到下面的 -32602 分支。措辞上
  // 不能把它读成「未知键会被拒」。
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
    // `app` / `getConfigPort` 都是可选的（轻量 embedder 与测试 record 不实现）。
    // 一个 record 缺能力不能让它后面的 workspace 收不到配置——整轮 fan-out 照常走完。
    const configPort = record.app?.getConfigPort?.();
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
    // FORK（Step 29 / D-12）：回 effective 域而不是 `params.config`。schema 的
    // `.default()` 与 strip 已经把它规范化过一次，写盘的与推入内存的都是
    // `parsed.data`；回显原始入参会让 UI 在成功保存后展示一份与内存不一致的表单。
    config: parsed.data,
  });
}

function formatIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
}