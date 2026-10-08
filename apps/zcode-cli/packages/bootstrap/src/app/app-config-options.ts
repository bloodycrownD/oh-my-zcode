import type { ConfigResult } from "@zcode/adapters/config";
import { detectLocale, resolveLocale } from "@zcode/i18n";
import type {
  PromptLanguage,
  RuntimeConfigPatch,
  SupportedLocale,
  UiLocale,
} from "@zcode/contracts";
import type { ZCodeAppOptions } from "./types.js";

export function isMessageEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ZCODE_MESSAGE_ENABLED === "1" || env.ZCODE_MESSAGE_ENABLED === "true";
}

export function createConfigCliOverrides(options: ZCodeAppOptions): RuntimeConfigPatch | undefined {
  const overrides: RuntimeConfigPatch = {};
  const permission: NonNullable<RuntimeConfigPatch["permission"]> = {};

  if (options.runtimeConfig?.mode) {
    permission.mode = options.runtimeConfig.mode;
  }
  if (options.runtimeConfig?.toolAllowlist) {
    permission.allowedTools = [...options.runtimeConfig.toolAllowlist];
  }
  if (options.runtimeConfig?.toolDisallowlist) {
    // headless CLI 的 denylist 同时投影到 permission config，让执行期权限
    // 路径与 provider-visible 工具面共享同一份禁用清单。
    permission.disallowedTools = [...options.runtimeConfig.toolDisallowlist];
  }
  if (Object.keys(permission).length > 0) {
    overrides.permission = permission;
  }
  if (options.uiLocale) {
    overrides.ui = {
      locale: options.uiLocale,
    };
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function resolveEffectiveConfigResult(
  configResult: ConfigResult,
  options: ZCodeAppOptions,
): ConfigResult {
  const requestedLocale = configResult.config.ui.locale;
  const effectiveLocale = resolveEffectiveLocale(requestedLocale, options);

  if (effectiveLocale === requestedLocale) {
    return configResult;
  }

  return {
    ...configResult,
    config: {
      ...configResult.config,
      ui: {
        ...configResult.config.ui,
        locale: effectiveLocale,
      },
    },
  };
}

export function resolveEffectiveLocale(
  requestedLocale: UiLocale,
  options: ZCodeAppOptions,
): SupportedLocale {
  const detectedLocale = requestedLocale === "auto" ? detectAppLocale(options) : undefined;
  return resolveLocale(requestedLocale, detectedLocale);
}

/**
 * FORK（prompt-language-option / PL-B-1）：把配置域的「模型语言」解析成实际提示词语言。
 *
 * - 显式 zh-CN / en-US：原样透传；
 * - auto 或缺省：按 env（LC_ALL / LC_MESSAGES / LANG / LANGUAGE）→ intlLocale → 进程 Intl
 *   的顺序探测，解析结果非 zh-CN 一律落 en-US。
 *
 * 冷启动装配（app/runtime-config.ts）与热更新 handler
 * （zcode-protocol/prompt-language.ts 的 updatePromptLanguage）共用这一条函数，
 * 保证同一 (env, intlLocale) 输入两处输出一致：Windows/GUI 启动下 LANG/LC_* 常缺位，
 * 两边都必须靠 Intl 兜底，否则设置页选/回切 auto 会与下次冷启动分叉（PL-B-1）。
 */
export function resolvePromptLanguage(
  promptLanguage: PromptLanguage | undefined,
  input: {
    env?: Record<string, string | undefined>;
    /**
     * 调用方显式注入的 Intl 探测结果（单测注入缝）；缺席或为 null 时回落到进程 Intl
     * （resolveIntlLocale）。生产热路径不传，由本函数统一兜底。
     */
    intlLocale?: string | null;
  } = {},
): SupportedLocale {
  if (promptLanguage !== undefined && promptLanguage !== "auto") {
    return promptLanguage;
  }

  // 缺省（undefined）与 "auto" 同义：走探测。resolveLocale 只把 "auto" 当探测请求
  // （undefined 会落默认 en-US），这里归一后再交给它——冷启动旧实现同样是
  // 「auto 或缺省都探测」，合并后不能把缺省态偷偷改成恒 en-US。
  return resolveLocale(
    "auto",
    detectLocale({
      env: input.env,
      intlLocale: input.intlLocale ?? resolveIntlLocale(),
    }),
  );
}

/**
 * 进程 Intl 探测结果，作为语言探测的最后一道系统来源。
 * 导出供热路径注入缝与单测共用；Intl 不可用时返回 undefined。
 */
export function resolveIntlLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

function detectAppLocale(options: ZCodeAppOptions): SupportedLocale | undefined {
  if (options.uiDetectedLocale !== undefined) {
    return detectLocale({
      intlLocale: options.uiDetectedLocale,
    });
  }

  return detectLocale({
    env: options.env ?? process.env,
    intlLocale: resolveIntlLocale(),
  });
}
