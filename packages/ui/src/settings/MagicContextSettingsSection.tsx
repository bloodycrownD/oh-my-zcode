/**
 * FORK（Step 29 / D-12）：magic-context 参数域设置分区。
 *
 * 保存链：`zcodeAgentService.updateMagicContextConfig` → CLI 的
 * `workspace/updateMagicContextConfig` handler → `updateMagicContextInFileConfig`
 * 写盘 + `ConfigPort.set` → `ConfigPort.observe` 扇出 → 下一个 turn 直接读新值。
 * **不需要重启**，因此本分区没有「需要重启才能生效」那类提示（与需要重启的设置项
 * 刻意不同）。
 *
 * 初值必须先读：RPC 是整域替换而非 partial patch，所以挂载时先
 * `readMagicContextConfig` 拿回 effective 域，再在上面编辑。字段渲染在
 * `MagicContextSettingsFields`，本文件只管这条读写链。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useServices } from "@/hooks/useServices.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { MagicContextSettingsFields } from "@/settings/MagicContextSettingsFields.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  buildMagicContextConfigFromForm,
  magicContextSettingsFormFromConfig,
  toModelPickerValue,
  type MagicContextSettingsForm,
} from "@/settings/magicContextSettingsForm.js";
import {
  buildRegistryModelSelectGroups,
  resolveModelDisplayName,
} from "@/lib/modelSelectionGroups.js";

/**
 * 读失败时的表单初值。这些值与 `MagicContextConfigSchema.parse({})` 的 `.default()`
 * 一致（65 / 0.15 / "5m" / true / true / false），因此「读失败」退化成「显示包内默认」，
 * 而不是把用户已有的配置展示成一片空白。
 */
const DEFAULT_FORM: MagicContextSettingsForm = {
  enabled: true,
  executeThresholdPercentage: 65,
  executeThresholdTokens: null,
  protectedTokens: null,
  historyBudgetPercentage: 0.15,
  cacheTtl: "5m",
  historianModel: "",
  smartDrops: false,
  failClosedBlocking: true,
};

export function MagicContextSettingsSection({
  workspacePath,
}: {
  /** 载体 workspace；magicContext 本身是用户级配置，workspace 只用于定位控制面。 */
  workspacePath?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const localHostServices = useBaseWorkspaceServices();
  const modelSelectionRead = useModelSelectionServiceView(localHostServices.modelSelectionService);
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const modelSelectionLoading = modelSelectionRead.state.status !== "ready";

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<MagicContextSettingsForm>(DEFAULT_FORM);
  /** effective 域基底：整域替换的写回必须以它为底，否则未编辑的键会被抹掉。 */
  const [baseConfig, setBaseConfig] = useState<unknown>(null);
  const loadVersionRef = useRef(0);

  const targetWorkspacePath = workspacePath?.trim() ?? "";

  const load = useCallback(async () => {
    if (!targetWorkspacePath) {
      setLoading(false);
      return;
    }
    const version = loadVersionRef.current + 1;
    loadVersionRef.current = version;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await services.zcodeAgentService.readMagicContextConfig({
        workspacePath: targetWorkspacePath,
      });
      if (loadVersionRef.current !== version) return;
      setBaseConfig(result.config);
      setForm(magicContextSettingsFormFromConfig(result.config, DEFAULT_FORM));
    } catch (error) {
      if (loadVersionRef.current !== version) return;
      // 读失败时保留 DEFAULT_FORM 并显示错误：分区仍可编辑（用户可重试、或改完直接
      // 保存——保存同样会被服务端拒绝并给出同样的错误），比整页空白或卡在 loading 好。
      logger.warn("[MagicContextSettingsSection] 读取 magicContext 配置失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (loadVersionRef.current === version) setLoading(false);
    }
  }, [services, targetWorkspacePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    <K extends keyof MagicContextSettingsForm>(key: K, value: MagicContextSettingsForm[K]) => {
      setForm((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const reset = useCallback(() => {
    setForm(magicContextSettingsFormFromConfig(baseConfig, DEFAULT_FORM));
  }, [baseConfig]);

  const canSave = !loading && !saving && targetWorkspacePath.length > 0;
  const dirty =
    JSON.stringify(buildMagicContextConfigFromForm(baseConfig, form)) !==
    JSON.stringify(baseConfig);

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const result = await services.zcodeAgentService.updateMagicContextConfig({
        workspacePath: targetWorkspacePath,
        config: buildMagicContextConfigFromForm(baseConfig, form),
      });
      // 用 CLI 回传的 effective 域回填，而不是本地草稿：schema 的 `.default()` 与
      // 未移植键的 strip 只有服务端知道，本地猜测会让表单显示与内存不一致的状态。
      setBaseConfig(result.config);
      setForm(magicContextSettingsFormFromConfig(result.config, DEFAULT_FORM));
      toast(intl.formatMessage({ id: "settings.context.saved" }));
    } catch (error) {
      logger.warn("[MagicContextSettingsSection] 保存 magicContext 配置失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.context.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [baseConfig, canSave, form, intl, services, targetWorkspacePath]);

  const modelGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelSelectionView, {
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
    });
  }, [intl, modelSelectionView]);

  const modelPickerValue = toModelPickerValue(form.historianModel);
  const historianModelTriggerLabel = useMemo(() => {
    if (!form.historianModel) {
      return intl.formatMessage({ id: "settings.context.historianModel.select" });
    }
    return resolveModelDisplayName(modelGroups, modelPickerValue) ?? form.historianModel;
  }, [form.historianModel, intl, modelGroups, modelPickerValue]);

  if (!targetWorkspacePath) {
    return (
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.context.noWorkspace" })}
      </p>
    );
  }

  const disabled = loading || saving;
  // 模型目录仍在加载时不做就绪性判断：把「还没读到」当成「没配模型」会给出一个
  // 假的报错提示。S16 的缺省语义（enabled 但无 historian 模型 → 无法运行折叠）在这里
  // 以一条说明文案呈现，不阻断保存。
  const showHistorianHint = form.enabled && !form.historianModel && !modelSelectionLoading;

  return (
    <div className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.context.description" })}
      </div>

      {loadError ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          <span className="min-w-0">
            {intl.formatMessage({ id: "settings.context.loadFailed" })}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}

      <SettingsGroupCard>
        {/* 顶部总开关：关闭 = transform 直通、无预算管理。说明文案放在 description 里，
            因为这是整张表单里唯一一个「关掉会改变所有其它字段含义」的控制项。 */}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.context.enabled.label" })}
          description={intl.formatMessage({ id: "settings.context.enabled.description" })}
          control={
            <Switch
              checked={form.enabled}
              disabled={disabled}
              aria-label={intl.formatMessage({ id: "settings.context.enabled.label" })}
              data-testid="magic-context-enabled-switch"
              onCheckedChange={(checked) => patch("enabled", checked)}
            />
          }
        />

        {form.enabled ? (
          <MagicContextSettingsFields
            disabled={disabled}
            form={form}
            intl={intl}
            modelGroups={modelGroups}
            modelPickerValue={modelPickerValue}
            historianModelTriggerLabel={historianModelTriggerLabel}
            showHistorianHint={showHistorianHint}
            patch={patch}
          />
        ) : null}
      </SettingsGroupCard>

      <SettingsFormActions>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !dirty}
          onClick={reset}
          data-testid="magic-context-reset"
        >
          <RotateCcw className="size-4" />
          {intl.formatMessage({ id: "settings.context.reset" })}
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={!canSave || !dirty}
          onClick={() => void handleSave()}
          data-testid="magic-context-save"
        >
          <Save className="size-4" />
          {saving
            ? intl.formatMessage({ id: "common.saving" })
            : intl.formatMessage({ id: "common.save" })}
        </Button>
      </SettingsFormActions>
    </div>
  );
}
