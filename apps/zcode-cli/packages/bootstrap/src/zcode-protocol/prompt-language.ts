/**
 * FORK（prompt-language-option）：模型语言（agent 系统提示词语言）读写。
 *
 * 三段顺序（与 magic-context-config.ts 同一条纪律，不能调换）：
 *
 *   ① 校验 → ② 写盘 → ③ configPort.set + runtime.updateConfig
 *
 * 先校验是因为写盘与推送都不可撤销；先写盘后推送是因为推送会立刻改变正在跑的
 * 会话——若先推送再写盘，用户会看到「新值已生效」然后磁盘写失败，得到内存与磁盘
 * 永久分叉的进程。反过来最坏只是「磁盘已改但本次进程未生效」，重启即追上。
 *
 * 与 magic-context 的两点差异：
 *   1. 载荷是**单标量**（"auto" | "zh-CN" | "en-US"），没有「整域替换」语义，因此
 *      不需要先读后写的配对纪律；read 方法只为设置页渲染 effective 初值而存在。
 *   2. 除了 `ConfigPort.set`（配置事实），还要调 `runtime.updateConfig({ language })`
 *      ——language 是 runtime config 的活值：core 的 updateConfig 会重建 context
 *      prefix（有 activeTurn 时下一轮生效）。只 set ConfigPort 不会改变正在运行的
 *      会话下一条 system prompt。
 *
 * 目标路径固定为用户级 `~/.omz/cli/config.json`（`getDefaultConfigPath()`），
 * 不接受调用方传路径：配置真源只有一个文件。
 */
import { ConfigKey, type PromptLanguage, type SupportedLocale } from "@zcode/contracts";
import {
  getDefaultConfigPath,
  loadFileConfig,
  updatePromptLanguageInFileConfig,
} from "@zcode/adapters/config";
import { detectLocale, resolveLocale } from "@zcode/i18n";
import {
  zcodeWorkspaceReadPromptLanguageParamsSchema,
  zcodeWorkspaceReadPromptLanguageResultSchema,
  zcodeWorkspaceUpdatePromptLanguageParamsSchema,
  zcodeWorkspaceUpdatePromptLanguageResultSchema,
  type ZCodeWorkspaceReadPromptLanguageResult,
  type ZCodeWorkspaceUpdatePromptLanguageResult,
} from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/** 供单测注入的窄缝；生产路径固定为默认用户配置路径与 process.env。 */
export interface PromptLanguageDependencies {
  configPath?: string;
  env?: Record<string, string | undefined>;
}

/**
 * 读回 effective 值，供设置页渲染初值。
 *
 * 读取顺序与 update 的写入顺序一致：ConfigPort 优先（有 resident session 时它才是
 * 运行时真正在用的那一份，且恒有值——注册了 "auto" 默认值），没有活动 session 时
 * 直接读文件（缺省 "auto"）。文件坏掉也回落 "auto"：设置页永远拿到可渲染的值。
 */
export async function readPromptLanguage(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  dependencies: PromptLanguageDependencies = {},
): Promise<ZCodeWorkspaceReadPromptLanguageResult> {
  const params = parseParams(zcodeWorkspaceReadPromptLanguageParamsSchema, rawParams);
  const configPath = dependencies.configPath ?? getDefaultConfigPath();

  for (const record of context.sessions.values()) {
    const configPort = record.app?.getConfigPort?.();
    if (!configPort) continue;
    return zcodeWorkspaceReadPromptLanguageResultSchema.parse({
      workspace: params.workspace,
      path: configPath,
      promptLanguage: configPort.get(ConfigKey.PromptLanguage),
      supported: true,
    });
  }

  const loaded = loadFileConfig(configPath);
  return zcodeWorkspaceReadPromptLanguageResultSchema.parse({
    workspace: params.workspace,
    path: loaded.path,
    promptLanguage: loaded.config.promptLanguage ?? "auto",
    supported: true,
  });
}

export async function updatePromptLanguage(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  dependencies: PromptLanguageDependencies = {},
): Promise<ZCodeWorkspaceUpdatePromptLanguageResult> {
  const params = parseParams(zcodeWorkspaceUpdatePromptLanguageParamsSchema, rawParams);

  // ① 值域校验已由协议 schema（z.enum）完成，无需第二份白名单。

  // ② 写盘。
  const persisted = await updatePromptLanguageInFileConfig(
    dependencies.configPath ?? getDefaultConfigPath(),
    params.promptLanguage,
  );

  // ③ 内存 + 热更新。逐个 resident session 推（与 magic-context 同一理由：每个 App
  // 持有自己的 ConfigPort 与 runtime）。没有活跃 session 时只落盘，下次建 App 时
  // `createConfig` 会重新读文件。
  const effectiveLanguage = resolveEffectivePromptLanguage(
    params.promptLanguage,
    dependencies.env ?? process.env,
  );
  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    const configPort = record.app?.getConfigPort?.();
    if (!configPort) continue;
    configPort.set(ConfigKey.PromptLanguage, params.promptLanguage);
    // language 的活值链：core 的 updateConfig 在非 activeTurn 时重建 context prefix，
    // activeTurn 中留给下一轮（见 core/src/runtime/methods/config.ts）。
    record.app.runtime.updateConfig({ language: effectiveLanguage });
    updatedSessionCount += 1;
  }

  context.logger?.info("promptLanguage updated", {
    module: "bootstrap.zcode_protocol",
    event: "zcode_protocol.prompt_language.updated",
    configPath: persisted.path,
    effectiveLanguage,
    promptLanguage: params.promptLanguage,
    updatedSessionCount,
    workspaceKey: params.workspace.workspaceKey,
  });

  return zcodeWorkspaceUpdatePromptLanguageResultSchema.parse({
    workspace: params.workspace,
    path: persisted.path,
    promptLanguage: params.promptLanguage,
    updatedSessionCount,
  });
}

/**
 * 把用户偏好解析成实际提示词语言，与 bootstrap/app/runtime-config.ts 的
 * `resolvePromptLanguage` 同一语义（auto → 宿主/系统探测；解析结果非 zh-CN 即
 * en-US；显式值透传）。
 *
 * 一处已知近似：宿主传入的 `uiDetectedLocale` 在 CLI 协议侧不可见，这里只能用
 * 环境变量探测（LC_ALL / LC_MESSAGES / LANG / LANGUAGE 等）。对显式选择的中文/
 * 英文无影响；仅「auto + 宿主语言与 CLI 环境语言不一致」的运行中会话可能在本次
 * 热更新里落到与下次启动不同的值，重启即收敛。
 */
function resolveEffectivePromptLanguage(
  promptLanguage: PromptLanguage,
  env: Record<string, string | undefined>,
): SupportedLocale {
  return resolveLocale(promptLanguage, detectLocale({ env }));
}
