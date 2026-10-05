/**
 * FORK（Step 29 / D-12）：magic-context 参数域设置分区。
 *
 * 保存链：`zcodeAgentService.updateMagicContextConfig` → CLI 的
 * `workspace/updateMagicContextConfig` handler → `updateMagicContextInFileConfig`
 * 写盘 + `ConfigPort.set` → `ConfigPort.observe` 扇出 → 下一个 turn 直接读新值。
 * **不需要重启**，因此本分区没有「需要重启才能生效」那类提示（与需要重启的设置项
 * 刻意不同）。
 *
 * 交互是**自动保存**：没有保存/放弃按钮，任何字段变更在短防抖后整域写回。保存失败
 * 用 toast 报错并把表单回滚到上次成功的 effective 域——自动保存场景下留着一个
 * 未保存的表单态，用户会误以为已经存上了。
 *
 * 初值必须先读：RPC 是整域替换而非 partial patch，所以挂载时先
 * `readMagicContextConfig` 拿回 effective 域，再在上面编辑。字段渲染在
 * `MagicContextSettingsFields`，本文件只管这条读写链。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
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

/** 输入类字段的防抖：等用户停手再写盘，避免每个按键一次整域 RPC。 */
const AUTOSAVE_DEBOUNCE_MS = 600;
/** 「已自动保存」提示的驻留时长；到点淡出，避免常驻一行无信息量的状态。 */
const AUTOSAVE_SAVED_HINT_MS = 3000;

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<MagicContextSettingsForm>(DEFAULT_FORM);
  /** effective 域基底：整域替换的写回必须以它为底，否则未编辑的键会被抹掉。 */
  const [baseConfig, setBaseConfig] = useState<unknown>(null);
  /** 自动保存阶段：idle（无待写变更或提示已淡出）/ saving / saved（短驻提示）。 */
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const loadVersionRef = useRef(0);
  /** 丢弃过期响应：连续编辑时只有最后一次保存有权回填表单。 */
  const saveVersionRef = useRef(0);

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
      // 读失败时保留 DEFAULT_FORM 并显示错误：分区仍可编辑（下一次自动保存会重试
      // 并在失败时给出同样的错误），比整页空白或卡在 loading 好。
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

  const dirty =
    JSON.stringify(buildMagicContextConfigFromForm(baseConfig, form)) !==
    JSON.stringify(baseConfig);

  const save = useCallback(async () => {
    const version = ++saveVersionRef.current;
    setSaveState("saving");
    try {
      const result = await services.zcodeAgentService.updateMagicContextConfig({
        workspacePath: targetWorkspacePath,
        config: buildMagicContextConfigFromForm(baseConfig, form),
      });
      if (saveVersionRef.current !== version) return;
      // 用 CLI 回传的 effective 域回填，而不是本地草稿：schema 的 `.default()` 与
      // 未移植键的 strip 只有服务端知道，本地猜测会让表单显示与内存不一致的状态。
      setBaseConfig(result.config);
      setForm(magicContextSettingsFormFromConfig(result.config, DEFAULT_FORM));
      setSaveState("saved");
    } catch (error) {
      if (saveVersionRef.current !== version) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[MagicContextSettingsSection] 自动保存 magicContext 配置失败", {
        error: message,
      });
      // 服务端的错误消息里带字段路径（-32602 的 refine/zod issue 会点名
      // `config.execute_threshold_tokens` 之类），丢掉它等于让用户对着一条
      // 「保存失败」去猜是哪个旋钮越界。formatIssues 已在协议层拼好路径。
      toast(`${intl.formatMessage({ id: "settings.context.saveFailed" })} ${message}`);
      // 自动保存没有「放弃修改」按钮：失败后留在表单里的草稿会让用户误以为已保存，
      // 回滚到上次成功的 effective 域才是诚实的状态。
      setForm(magicContextSettingsFormFromConfig(baseConfig, DEFAULT_FORM));
      setSaveState("idle");
    }
  }, [baseConfig, form, intl, services, targetWorkspacePath]);

  // 自动保存本体：dirty 成立且不在装载/读失败态时，防抖到期即整域写回。
  // 依赖里的 save 会随 form/baseConfig 变化，用户连续编辑时旧计时器被清理重设，
  // 防抖窗口自然合并；保存成功回填后 dirty 归 false，不会再次触发。
  useEffect(() => {
    if (loading || loadError !== null) return;
    if (!targetWorkspacePath || !dirty) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dirty, loadError, loading, save, targetWorkspacePath]);

  // 「已自动保存」短驻后淡出。
  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = setTimeout(() => setSaveState("idle"), AUTOSAVE_SAVED_HINT_MS);
    return () => clearTimeout(timer);
  }, [saveState]);

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

  // 只在装载初读时锁字段；自动保存进行中不锁——锁了会把「连续调整阈值」变成
  // 一次只能改一格的糟糕体验，而整域 RPC + 版本守卫已经处理了竞态。
  const disabled = loading;
  // 模型目录仍在加载时不做就绪性判断：把「还没读到」当成「没配模型」会给出一个
  // 假的报错提示。S16 的缺省语义（enabled 但无 historian 模型 → 无法运行折叠）在这里
  // 以一条说明文案呈现，不阻断编辑。
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

      {/* 自动保存状态行：占住 SettingsFormActions 原来的位置，给「存没存上」一个
          可扫视的答案，而不是弹一条每次都要消失的 toast。 */}
      <div
        className="flex min-h-8 items-center gap-2 text-ui-sm text-foreground-subtle"
        data-testid="magic-context-autosave-status"
      >
        {saveState === "saving" ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            {intl.formatMessage({ id: "common.saving" })}
          </>
        ) : saveState === "saved" ? (
          <>
            <Check className="size-3.5" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.context.autosave.saved" })}
          </>
        ) : dirty ? (
          intl.formatMessage({ id: "settings.context.autosave.pending" })
        ) : null}
      </div>
    </div>
  );
}
