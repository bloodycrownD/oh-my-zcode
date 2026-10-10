/**
 * FORK（Step 29 / D-12）：magic-context 参数域的字段行集合。
 *
 * 从 `MagicContextSettingsSection` 里拆出来的唯一理由是文件行数上限（400），不是
 * 职责上的分层——但拆点选在「总开关之后的全部字段」这条天然的语义边界上：
 * `MagicContextSettingsSection` 保留**读写链**（读 RPC → 表单状态 → 写 RPC → 回填），
 * 本文件只负责**渲染**字段，不发任何请求，因此也更容易在 UI 之外复用。
 *
 * 关闭总开关时不渲染本组件：那一刻「transform 直通、无预算管理」，其余参数全部
 * 不生效，把它们留在页面上只会诱导用户去调一个当前不起作用的旋钮。
 */
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  HISTORIAN_MODEL_INHERIT,
  MAGIC_CONTEXT_NUMBER_FIELD_SPECS,
  toPersistedModelId,
  type MagicContextSettingsForm,
} from "@/settings/magicContextSettingsForm.js";

/** historian 是旁路模型，不受会话模型可用性约束，因此不锁定任何候选。 */
const MODEL_ITEM_NEVER_LOCKED = () => false;

function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function NumberField(props: {
  description: string;
  disabled: boolean;
  inputMode: "numeric" | "decimal";
  label: string;
  max: number;
  min: number;
  onChange: (value: number | null) => void;
  placeholder?: string;
  step: number;
  testId: string;
  value: number | null;
}) {
  return (
    <SettingsRow
      label={props.label}
      description={props.description}
      controlLayout="wide"
      detail={
        <Input
          type="number"
          inputMode={props.inputMode}
          className="w-40"
          placeholder={props.placeholder}
          aria-label={props.label}
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value ?? ""}
          disabled={props.disabled}
          data-testid={props.testId}
          onChange={(event) => {
            // 空串优先判 null：`Number("")` 是 0 且 finite，先走数字分支会把
            // 「用户清空了输入框」翻译成「把值设成 0」——对 historyBudget 来说
            // 0 低于 schema 下界 0.05，保存必被 -32602 拒，而用户看不出原因。
            if (event.target.value.trim() === "") {
              props.onChange(null);
              return;
            }
            const next = parseOptionalNumber(event.target.value);
            if (next === null) return;
            // 越界不采纳（也不 clamp）：min/max 的权威是 CLI 的 schema parse，
            // 这一层按「不给用户必然被拒的输入」的既定意图挡住越界输入即可
            // （见 magicContextSettingsForm.ts 的 SPECS 注释）。不采纳意味着
            // 输入框保持原值，用户能立刻看出这个数不被接受。
            if (next < props.min || next > props.max) return;
            props.onChange(next);
          }}
        />
      }
      control={null}
    />
  );
}

export function MagicContextSettingsFields({
  disabled,
  form,
  intl,
  modelGroups,
  modelPickerValue,
  historianModelTriggerLabel,
  showHistorianHint,
  patch,
}: {
  disabled: boolean;
  form: MagicContextSettingsForm;
  intl: IntlInstance;
  modelGroups: readonly ModelSelectGroup[];
  /** 表单的 "provider/model" ↔ 选择器 `custom:provider:model` 的展示态编码。 */
  modelPickerValue: string;
  historianModelTriggerLabel: string;
  showHistorianHint: boolean;
  patch: <K extends keyof MagicContextSettingsForm>(
    key: K,
    value: MagicContextSettingsForm[K],
  ) => void;
}) {
  const specs = MAGIC_CONTEXT_NUMBER_FIELD_SPECS;

  return (
    <>
      <NumberField
        label={intl.formatMessage({ id: "settings.context.executeThreshold.label" })}
        description={intl.formatMessage({ id: "settings.context.executeThreshold.description" })}
        inputMode="numeric"
        min={specs.executeThresholdPercentage.min}
        max={specs.executeThresholdPercentage.max}
        step={specs.executeThresholdPercentage.step}
        value={form.executeThresholdPercentage}
        disabled={disabled}
        testId="magic-context-execute-threshold-percentage"
        onChange={(value) => {
          if (value !== null) patch("executeThresholdPercentage", value);
        }}
      />

      <NumberField
        label={intl.formatMessage({ id: "settings.context.executeThresholdTokens.label" })}
        description={intl.formatMessage({
          id: "settings.context.executeThresholdTokens.description",
        })}
        placeholder={intl.formatMessage({
          id: "settings.context.executeThresholdTokens.placeholder",
        })}
        inputMode="numeric"
        min={specs.executeThresholdTokens.min}
        max={specs.executeThresholdTokens.max}
        step={specs.executeThresholdTokens.step}
        value={form.executeThresholdTokens}
        disabled={disabled}
        testId="magic-context-execute-threshold-tokens"
        onChange={(value) => patch("executeThresholdTokens", value)}
      />

      <NumberField
        label={intl.formatMessage({ id: "settings.context.protectedTokens.label" })}
        description={intl.formatMessage({ id: "settings.context.protectedTokens.description" })}
        placeholder={intl.formatMessage({ id: "settings.context.protectedTokens.placeholder" })}
        inputMode="numeric"
        min={specs.protectedTokens.min}
        max={specs.protectedTokens.max}
        step={specs.protectedTokens.step}
        value={form.protectedTokens}
        disabled={disabled}
        testId="magic-context-protected-tokens"
        onChange={(value) => patch("protectedTokens", value)}
      />

      <NumberField
        label={intl.formatMessage({ id: "settings.context.historyBudget.label" })}
        description={intl.formatMessage({ id: "settings.context.historyBudget.description" })}
        inputMode="decimal"
        min={specs.historyBudgetPercentage.min}
        max={specs.historyBudgetPercentage.max}
        step={specs.historyBudgetPercentage.step}
        value={form.historyBudgetPercentage}
        disabled={disabled}
        testId="magic-context-history-budget"
        onChange={(value) => {
          if (value !== null) patch("historyBudgetPercentage", value);
        }}
      />

      <SettingsRow
        label={intl.formatMessage({ id: "settings.context.cacheTtl.label" })}
        description={intl.formatMessage({ id: "settings.context.cacheTtl.description" })}
        controlLayout="wide"
        detail={
          <Input
            type="text"
            className="w-40"
            aria-label={intl.formatMessage({ id: "settings.context.cacheTtl.label" })}
            value={form.cacheTtl}
            disabled={disabled}
            data-testid="magic-context-cache-ttl"
            onChange={(event) => patch("cacheTtl", event.target.value)}
          />
        }
        control={null}
      />

      <SettingsRow
        label={intl.formatMessage({ id: "settings.context.historianModel.label" })}
        description={intl.formatMessage({ id: "settings.context.historianModel.description" })}
        controlLayout="wide"
        detail={
          <ModelConfigSelect
            modelGroups={modelGroups}
            normalizedValue={modelPickerValue}
            triggerLabel={historianModelTriggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={MODEL_ITEM_NEVER_LOCKED}
            onValueChange={(value) => patch("historianModel", toPersistedModelId(value))}
            footerActions={[
              {
                // FORK（impl-historian-inherit）：三态下拉。继承是默认项（缺省
                // 即继承，bootstrap 侧同语义），关闭是显式哨兵 ""。
                key: "historian-model:inherit",
                label: intl.formatMessage({ id: "settings.context.historianModel.inherit" }),
                onSelect: () => patch("historianModel", HISTORIAN_MODEL_INHERIT),
                selected: form.historianModel.trim() === HISTORIAN_MODEL_INHERIT,
              },
              {
                key: "historian-model:none",
                label: intl.formatMessage({ id: "settings.context.historianModel.clear" }),
                onSelect: () => patch("historianModel", ""),
                selected: form.historianModel.trim().length === 0,
              },
            ]}
            manageModelsLabel={intl.formatMessage({ id: "chat.toolbar.model.manageModels" })}
            contentSide="bottom"
            focusSelectorOnClose={null}
            labelVisibilityClassName="inline-flex min-w-0"
            triggerClassName="h-8 w-fit max-w-52 min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
            triggerLabelClassName="inline-flex min-w-0 truncate text-left"
            disabled={disabled}
          />
        }
        control={null}
      />
      {showHistorianHint ? (
        <div className="border-t border-border px-4 py-3 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.context.historianModel.missingHint" })}
        </div>
      ) : null}

      <SettingsRow
        label={intl.formatMessage({ id: "settings.context.smartDrops.label" })}
        description={intl.formatMessage({ id: "settings.context.smartDrops.description" })}
        control={
          <Switch
            checked={form.smartDrops}
            disabled={disabled}
            aria-label={intl.formatMessage({ id: "settings.context.smartDrops.label" })}
            data-testid="magic-context-smart-drops-switch"
            onCheckedChange={(checked) => patch("smartDrops", checked)}
          />
        }
      />

      <SettingsRow
        label={intl.formatMessage({ id: "settings.context.failClosedBlocking.label" })}
        description={intl.formatMessage({ id: "settings.context.failClosedBlocking.description" })}
        control={
          <Switch
            checked={form.failClosedBlocking}
            disabled={disabled}
            aria-label={intl.formatMessage({ id: "settings.context.failClosedBlocking.label" })}
            data-testid="magic-context-fail-closed-switch"
            onCheckedChange={(checked) => patch("failClosedBlocking", checked)}
          />
        }
      />
    </>
  );
}
