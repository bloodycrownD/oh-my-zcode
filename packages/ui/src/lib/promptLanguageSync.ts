/**
 * FORK（system-language-unification）：界面语言 → 模型语言（agent 提示词语言）的联动同步。
 *
 * 产品决策（用户拍板，v1.0.4 prompt-language-option 的「界面语言 / 模型语言两行相互独立」
 * 设计被推翻）：「难道有英文界面中文提示词的需求吗？两者统一是方便理解的」。因此设置页
 * 只保留一行「系统语言」（值域 `LocalePreference = system | zh-CN | en-US`），模型语言
 * 跟随界面语言的解析结果：由发起界面语言变更的窗口把解析出的具体 locale 经既有协议
 * `workspace/updatePromptLanguage` 写入 CLI 的 `config.json` 顶层 `promptLanguage`。
 *
 * 这里的 `promptLanguage` 是存储细节而不是用户设置：`auto` 只保留给无桌面宿主的
 * TUI / 独立 CLI 兜底（CLI 侧 env → Intl 探测），桌面/Web 宿主场景一律写成具体值，
 * 否则「英文系统 + 中文界面」会让提示词落回英文。
 *
 * 本文件刻意保持零 `@/` 依赖（只用类型导入）：既能被 hooks 复用，也能被
 * `packages/ui/test` 下的 node 单测直接 import，把同步判据（何时写、何时跳过）
 * 与 React 生命周期分开验证。
 */
import type { Locale, ZCodePromptLanguage } from "@zcode/shared";

/** 同步结果：调用方据此决定是否需要重试（无 workspace / RPC 失败才算未完成）。 */
export type PromptLanguageSyncOutcome =
  /** 没有可用 workspace：协议读写都定位不到本机控制面。 */
  | "skipped-no-workspace"
  /** 当前 CLI 不认识该方法（services 层把 -32601 降级成 supported:false）。 */
  | "skipped-unsupported"
  /** 模型语言已是界面语言解析值，无需写盘。 */
  | "skipped-unchanged"
  /** 已写入具体 locale（CLI 侧写盘 + 热更新）。 */
  | "updated"
  /** 读或写失败：静默跳过，等待下一次触发（如 workspace 变为可用）。 */
  | "failed";

/** 只依赖模型语言协议读写的窄接口，便于注入假实现做回归测试。 */
export interface PromptLanguageSyncPort {
  readPromptLanguage(params: { workspacePath: string }): Promise<{
    promptLanguage: ZCodePromptLanguage;
    supported?: boolean;
  }>;
  updatePromptLanguage(params: {
    workspacePath: string;
    promptLanguage: ZCodePromptLanguage;
  }): Promise<unknown>;
}

/** 同步日志出口：调用方（renderer）注入 ui logger，单测注入收集器。 */
export interface PromptLanguageSyncLog {
  debug(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
}

export interface PromptLanguageSyncParams {
  /** 界面语言解析后的具体语言（system 态已由宿主探测解析，不会是 "system"）。 */
  interfaceLocale: Locale;
  /** 协议读写的 workspace 载体（用户级配置，workspace 只用于定位本机控制面）。 */
  workspacePath?: string | null;
  agentService: PromptLanguageSyncPort;
  log: PromptLanguageSyncLog;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把模型语言同步到界面语言解析值（幂等：读一次，只在不一致时写）。
 *
 * 从属内部细节，因此所有失败只记日志、不抛给调用方：界面语言保存是主路径，
 * 不能因为 CLI 不可用就让「系统语言」设置项报错或被禁用。
 */
export async function syncPromptLanguageWithInterfaceLocale(
  params: PromptLanguageSyncParams,
): Promise<PromptLanguageSyncOutcome> {
  const { interfaceLocale, agentService, log } = params;
  const workspacePath = params.workspacePath?.trim() ?? "";
  if (!workspacePath) {
    log.debug("[systemLanguage] 无可用 workspace，跳过模型语言同步");
    return "skipped-no-workspace";
  }

  let currentPromptLanguage: ZCodePromptLanguage;
  try {
    const result = await agentService.readPromptLanguage({ workspacePath });
    if (result.supported === false) {
      // 旧 CLI 的 -32601 在 services 层已降级成 supported:false；这里是静默跳过，
      // 不再像 v1.0.4 那样给设置行加「当前 CLI 不支持」的禁用态。
      log.debug("[systemLanguage] 当前 CLI 不支持模型语言，跳过同步");
      return "skipped-unsupported";
    }
    currentPromptLanguage = result.promptLanguage;
  } catch (error) {
    log.warn("[systemLanguage] 读取模型语言失败，跳过本次同步", {
      error: toMessage(error),
      workspacePath,
    });
    return "failed";
  }

  if (currentPromptLanguage === interfaceLocale) {
    return "skipped-unchanged";
  }

  try {
    await agentService.updatePromptLanguage({ workspacePath, promptLanguage: interfaceLocale });
  } catch (error) {
    // 写失败不阻断界面语言：下一次界面语言变更或 workspace 变为可用时会再试。
    log.warn("[systemLanguage] 写入模型语言失败", {
      error: toMessage(error),
      interfaceLocale,
      previousPromptLanguage: currentPromptLanguage,
      workspacePath,
    });
    return "failed";
  }

  log.debug("[systemLanguage] 模型语言已跟随界面语言", {
    interfaceLocale,
    previousPromptLanguage: currentPromptLanguage,
    workspacePath,
  });
  return "updated";
}
