/**
 * FORK（prompt-language-option）：设置页 General 分区的「模型语言」行。
 *
 * 数据流（照 MagicContextSettingsSection 的协议范式裁剪成单行）：
 * `zcodeAgentService.readPromptLanguage` / `updatePromptLanguage` →
 * CLI 的 `workspace/readPromptLanguage` / `workspace/updatePromptLanguage` →
 * 写盘 + ConfigPort.set + runtime.updateConfig（运行中会话下一轮生效）。
 *
 * 自动保存语义：选中即写；**await 成功再更新本地态**——失败时选择器保持上一次
 * 生效值（无需额外回滚状态），另给一条 toast。旧 CLI 的 -32601 由 services 降级成
 * `supported:false`，这里把选项禁用并换成「当前 CLI 不支持」的说明，而不是让用户
 * 反复保存失败。
 *
 * 与界面语言（ui.locale）相互独立：这一项只影响 agent 系统提示词与模型回复语言。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  TID_SETTINGS_MODEL_LANGUAGE_SELECT_ITEM,
  TID_SETTINGS_MODEL_LANGUAGE_SELECT_TRIGGER,
  testId,
  type ZCodePromptLanguage,
} from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

/** 值域与 config.json 的顶层 `promptLanguage` 一致（契约：PromptLanguage）。 */
const PROMPT_LANGUAGE_OPTIONS: readonly ZCodePromptLanguage[] = ["auto", "zh-CN", "en-US"];

export function ModelLanguageSetting({ workspacePath }: { workspacePath?: string | null }) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const targetWorkspacePath = workspacePath?.trim() ?? "";

  const [language, setLanguage] = useState<ZCodePromptLanguage>("auto");
  const [loading, setLoading] = useState(true);
  /** 旧 CLI 降级：read 返回 supported:false 时禁用选项。 */
  const [supported, setSupported] = useState(true);
  const [saving, setSaving] = useState(false);
  /** 丢弃过期响应：连续切换时只有最后一次有权回填/报错。 */
  const loadVersionRef = useRef(0);
  const saveVersionRef = useRef(0);

  const load = useCallback(async () => {
    if (!targetWorkspacePath) {
      setLoading(false);
      return;
    }
    const version = loadVersionRef.current + 1;
    loadVersionRef.current = version;
    setLoading(true);
    try {
      const result = await services.zcodeAgentService.readPromptLanguage({
        workspacePath: targetWorkspacePath,
      });
      if (loadVersionRef.current !== version) return;
      setLanguage(result.promptLanguage);
      setSupported(result.supported);
    } catch (error) {
      if (loadVersionRef.current !== version) return;
      // 读失败保留缺省 auto 并保持可编辑（下一次选择会走 update 并在失败时给出同样
      // 的错误），比整行卡死好。
      logger.warn("[ModelLanguageSetting] 读取模型语言失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (loadVersionRef.current === version) setLoading(false);
    }
  }, [services, targetWorkspacePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleChange = useCallback(
    async (next: ZCodePromptLanguage) => {
      const version = ++saveVersionRef.current;
      setSaving(true);
      try {
        const result = await services.zcodeAgentService.updatePromptLanguage({
          workspacePath: targetWorkspacePath,
          promptLanguage: next,
        });
        if (saveVersionRef.current !== version) return;
        // await 成功再更新本地态：失败时选择器仍显示上一次生效值。
        setLanguage(result.promptLanguage);
      } catch (error) {
        if (saveVersionRef.current !== version) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[ModelLanguageSetting] 保存模型语言失败", { error: message });
        toast(`${intl.formatMessage({ id: "settings.modelLanguage.saveFailed" })} ${message}`);
      } finally {
        if (saveVersionRef.current === version) setSaving(false);
      }
    },
    [intl, services, targetWorkspacePath],
  );

  const disabled = loading || saving || !supported || !targetWorkspacePath;

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "settings.modelLanguage" })}
      description={
        supported
          ? intl.formatMessage({ id: "settings.modelLanguageDescription" })
          : intl.formatMessage({ id: "settings.modelLanguage.unsupported" })
      }
      control={
        <div className="flex items-center gap-2">
          {saving ? (
            <Loader2
              className="size-3.5 animate-spin text-foreground-subtle"
              aria-hidden="true"
              data-testid="settings-model-language-saving"
            />
          ) : null}
          <Select
            value={language}
            disabled={disabled}
            onValueChange={(value) => void handleChange(value as ZCodePromptLanguage)}
          >
            <SelectTrigger
              size="lg"
              className="w-[260px] min-w-0 justify-between"
              data-testid={TID_SETTINGS_MODEL_LANGUAGE_SELECT_TRIGGER}
              aria-label={intl.formatMessage({ id: "settings.modelLanguage" })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROMPT_LANGUAGE_OPTIONS.map((option) => (
                <SelectItem
                  key={option}
                  value={option}
                  data-testid={testId(TID_SETTINGS_MODEL_LANGUAGE_SELECT_ITEM, option)}
                >
                  {intl.formatMessage({ id: `settings.modelLanguage.${option}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    />
  );
}
