/**
 * FORK（system-language-unification）：把界面语言联动同步到模型语言（agent 提示词语言）。
 *
 * 产品依据（用户拍板）：v1.0.4 prompt-language-option 把「界面语言」「模型语言」设成两行
 * 相互独立的设计被推翻——「难道有英文界面中文提示词的需求吗？两者统一是方便理解的」。
 * 设置页现在只有一行「系统语言」（`LocalePreference = system | zh-CN | en-US`），模型语言
 * 跟随界面语言的解析结果，`config.json` 的 `promptLanguage` 降级为内部实现细节（`auto`
 * 仅保留给无桌面宿主的 TUI / 独立 CLI 兜底）。
 *
 * 写入方纪律：只在**发起界面语言变更的窗口**执行（`IntlProvider.localeChangeToken` 只有
 * 发起方才递增；广播接收窗口直接改本地 state，不递增）。否则同一份用户级配置会被多个
 * 窗口重复写——尤其手机远控窗口的「system」解析自浏览器语言，与桌面宿主探测结果不同。
 *
 * 触发时机：
 *   ① `localeChangeToken` 变化：设置页 select 与 footer 语言子菜单两条入口（都收敛到
 *      `IntlProvider.setLocalePreference`，system 态解析值变化引起的回写也在同一函数内）；
 *   ② workspace 变为可用：覆盖启动时还没有 workspace 的漏同步，以及存量用户首次迁移
 *      （把界面语言解析值写进 `promptLanguage`，覆盖旧的 auto 或用户曾手选的旧值）。
 *
 * 同步是**从属内部细节**：无 active workspace、旧 CLI（-32601）、RPC 失败一律静默跳过
 * （debug/warn 日志），不 toast、不回滚界面语言——界面语言保存是主路径，不能因为 CLI
 * 可用性让「系统语言」行报错或被禁用。
 */
import { useCallback, useEffect, useRef } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  syncPromptLanguageWithInterfaceLocale,
  type PromptLanguageSyncLog,
} from "@/lib/promptLanguageSync.js";
import { logger } from "@/logger.js";

const syncLog: PromptLanguageSyncLog = {
  debug: (message, detail) => logger.debug(message, detail),
  warn: (message, detail) => logger.warn(message, detail),
};

export function useSystemLanguagePromptSync({
  workspacePath,
}: {
  /** 协议读写的 workspace 载体（用户级配置，workspace 只用于定位本机控制面）。 */
  workspacePath?: string | null;
}) {
  const { zcodeAgentService } = useServices();
  const { locale, localeChangeToken } = useZCodeIntl();
  /** 界面语言是否尚未成功同步到模型语言；初值 true 覆盖 mount 时的存量迁移。 */
  const pendingRef = useRef(true);
  const inFlightRef = useRef(false);
  /** 同步在飞期间又来了新触发：在飞那次结束后补跑一次，避免并发读写同一份用户级配置。 */
  const rerunAfterFlightRef = useRef(false);
  const lastLocaleChangeTokenRef = useRef(localeChangeToken);

  const sync = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) {
      rerunAfterFlightRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      do {
        rerunAfterFlightRef.current = false;
        const outcome = await syncPromptLanguageWithInterfaceLocale({
          interfaceLocale: locale,
          workspacePath,
          agentService: zcodeAgentService,
          log: syncLog,
        });
        // 只有确认「已写到一致」才清 pending；没 workspace 或失败时保持 pending，
        // workspace 后来可用、或下一次界面语言变更都会再试。
        pendingRef.current = outcome === "skipped-no-workspace" || outcome === "failed";
      } while (rerunAfterFlightRef.current);
    } finally {
      inFlightRef.current = false;
    }
  }, [locale, workspacePath, zcodeAgentService]);

  useEffect(() => {
    // 序号只在发起窗口递增：广播接收侧不会走到这里，因此不会重复写 promptLanguage。
    if (localeChangeToken === lastLocaleChangeTokenRef.current) {
      return;
    }
    lastLocaleChangeTokenRef.current = localeChangeToken;
    void sync();
  }, [localeChangeToken, sync]);

  useEffect(() => {
    if (!workspacePath?.trim() || !pendingRef.current) {
      return;
    }
    void sync();
  }, [workspacePath, sync]);
}
