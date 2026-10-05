/**
 * FORK（Step 29 / D-12）：magic-context 设置表单 ↔ `magicContext` 参数域的映射。
 *
 * 单独成文件而不是塞进组件，有三个具体理由：
 *
 *   1. **整域覆盖必须显式做「读 → 改 → 写回」。** S23 的 RPC 是整域替换而非 partial
 *      patch，所以 UI 只提交它编辑过的字段会静默抹掉其余字段。这里的
 *      `buildMagicContextConfigFromForm` 以**读回来的 effective 域为基底**逐字段覆盖，
 *      未编辑的键原样带回；`magicContextSettingsFormFromConfig` 则是反向的那一步。
 *   2. **边界必须复述包的 schema，不能发明第二套。** `MagicContextConfigSchema` 是唯一
 *      权威（CLI handler 写盘前用它、config.json 装载用它），但 UI 依赖不到那个包
 *      （`@zcode/magic-context` 是 CLI 侧包）。因此数值字段的 min/max/step 在下面按
 *      同一组约束复述一份，每项注明 schema 的哪一行产生它——真正的拒绝仍然只发生在
 *      CLI 的 schema parse 上（-32602），UI 这一层只负责不给用户必然被拒的输入。
 *   3. **纯函数可被 CLI 侧测试直接加载。** T-U1 套件跑的就是本文件的 dist 产物，
 *      而不是把同一套映射在测试里复刻一遍（复刻只会证明复刻是对的）。因此本文件
 *      只依赖 `@zcode/shared`（CLI 与 UI 共用的那个包），**不用 `@/` 别名**——
 *      别名只有 UI 的打包器解析得了，而这个模块还要被 node 直接 import。
 */
import { encodeCustomModelValue, parseModelPickerValue } from "@zcode/shared";

/**
 * 表单可编辑的字段集。与包的 schema 白名单一一对应，**只少不多**——
 * `historian` 除 `model` 外的元数据（temperature/tools/prompt/…）、`language`、
 * `fallback_models`、`variant`、`two_pass` 等在首版不暴露编辑入口，
 * 但它们会被原样带回写盘，不会被表单抹掉。
 *
 * 数值字段的 min/max **不在这里复述**：本文件下方的 `MAGIC_CONTEXT_NUMBER_FIELD_SPECS`
 * 是 UI 侧唯一副本，i18n description 也不写死数字（改了 schema 时文案不会跟着变）。
 */
export interface MagicContextSettingsForm {
  enabled: boolean;
  /** 上下文占用百分比阈值。per-model 覆盖形态首版只编辑 `default` 分支。 */
  executeThresholdPercentage: number;
  /** 绝对 token 阈值覆盖。空 = 不覆盖，走百分比。 */
  executeThresholdTokens: number | null;
  /** 自动回收的 token 地板。空 = 用包内默认。 */
  protectedTokens: number | null;
  /** 会话历史块占可用上下文的比例。 */
  historyBudgetPercentage: number;
  /** 前缀缓存 TTL，如 "5m" / "1h" / "never"。 */
  cacheTtl: string;
  /** historian 旁路模型 ID（"provider/model"）。空 = 未配置。 */
  historianModel: string;
  smartDrops: boolean;
  failClosedBlocking: boolean;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 百分比阈值在 schema 里是 `number | { default, [model]: number }`。
 * 表单只编辑 `default` 分支：per-model 表是给「同一台机器多个模型」准备的，
 * 首版 UI 不提供按模型编辑的入口，也不该在这里悄悄丢掉用户已有的按模型覆盖。
 */
function readPercentageDefault(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (isRecord(value) && typeof value.default === "number") return value.default;
  return undefined;
}

/** 同上：`execute_threshold_tokens` 恒为对象（`{ default?, [model]: number }`）。 */
function readTokensDefault(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.default === "number" ? value.default : undefined;
}

/** `cache_ttl` 同为 `string | { default, [model]: string }`。 */
function readCacheTtlDefault(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.default === "string") return value.default;
  return undefined;
}

/** 把 unknown（RPC result 的 `config`）收敛成一份可编辑表单。 */
export function magicContextSettingsFormFromConfig(
  config: unknown,
  fallback: MagicContextSettingsForm,
): MagicContextSettingsForm {
  if (!isRecord(config)) return fallback;
  const historian = isRecord(config.historian) ? config.historian : {};
  const historianModel = typeof historian.model === "string" ? historian.model : "";

  return {
    enabled: typeof config.enabled === "boolean" ? config.enabled : fallback.enabled,
    executeThresholdPercentage:
      readPercentageDefault(config.execute_threshold_percentage) ??
      fallback.executeThresholdPercentage,
    executeThresholdTokens: readTokensDefault(config.execute_threshold_tokens) ?? null,
    protectedTokens: typeof config.protected_tokens === "number" ? config.protected_tokens : null,
    historyBudgetPercentage:
      typeof config.history_budget_percentage === "number"
        ? config.history_budget_percentage
        : fallback.historyBudgetPercentage,
    cacheTtl: readCacheTtlDefault(config.cache_ttl) ?? fallback.cacheTtl,
    historianModel: historianModel.trim() || fallback.historianModel,
    smartDrops: typeof config.smart_drops === "boolean" ? config.smart_drops : fallback.smartDrops,
    failClosedBlocking:
      typeof config.fail_closed_blocking === "boolean"
        ? config.fail_closed_blocking
        : fallback.failClosedBlocking,
  };
}

/**
 * 以读回的 effective 域为基底生成写盘用的**整域**。
 *
 * 三条不能省的语义：
 *   - 未编辑的键原样带回（RPC 是整域替换，带不回就等于删除）；
 *   - `execute_threshold_tokens` / `cache_ttl` 若原本是 per-model 对象，
 *     只改写 `default` 分支并保留其它模型键；
 *   - 可选数字字段留空时**删键**而不是写 `null`——`z.number().optional()` 不接受 null。
 *
 * 第三条对「表里还有 per-model 键」的情形不适用：`execute_threshold_tokens` 的
 * `default` 在 schema 里可选，留空时的正确处置是**只摘 `default` 分支**（见下），
 * 而不是删掉整张 per-model 表。
 */
export function buildMagicContextConfigFromForm(
  base: unknown,
  form: MagicContextSettingsForm,
): JsonRecord {
  const previous = isRecord(base) ? { ...base } : {};
  const previousThreshold = previous.execute_threshold_percentage;
  const previousTokens = previous.execute_threshold_tokens;
  const previousCacheTtl = previous.cache_ttl;

  const next: JsonRecord = {
    ...previous,
    enabled: form.enabled,
    execute_threshold_percentage:
      isRecord(previousThreshold) && "default" in previousThreshold
        ? { ...previousThreshold, default: form.executeThresholdPercentage }
        : form.executeThresholdPercentage,
    history_budget_percentage: form.historyBudgetPercentage,
    cache_ttl:
      isRecord(previousCacheTtl) && "default" in previousCacheTtl
        ? { ...previousCacheTtl, default: form.cacheTtl }
        : form.cacheTtl,
    smart_drops: form.smartDrops,
    fail_closed_blocking: form.failClosedBlocking,
  };

  // `execute_threshold_tokens` 的 schema 是 `{ default?: number, [model]: number }`：
  // **`default` 本身可选**，所以一份只带 per-model 键的配置完全合法，而表单的首版
  // 没有按模型编辑入口——读侧因此把它坍缩成 `null`（表单里「未覆盖」）。
  //
  // 曾经的写法是 `null` ⇒ `delete next.execute_threshold_tokens`，也就是「删整表」。
  // 那会把用户在设置页**看不见**的 per-model 键一次性抹掉：点一次保存就销毁配置，
  // 且页面上没有任何提示（键可见性为零 ⇒ 用户无从恢复）。属于数据损坏级。
  //
  // 现在改为只摘 `default` 分支：per-model 键原样带回，摘完还剩键才保留该对象，
  // 否则才删键。这样「清空 Token 覆盖」回到的正是 schema 允许的 per-model-only 形态。
  if (form.executeThresholdTokens === null) {
    if (isRecord(previousTokens)) {
      const { default: _droppedDefault, ...perModelOnly } = previousTokens;
      if (Object.keys(perModelOnly).length > 0) {
        next.execute_threshold_tokens = perModelOnly;
      } else {
        delete next.execute_threshold_tokens;
      }
    } else {
      delete next.execute_threshold_tokens;
    }
  } else if (isRecord(previousTokens)) {
    next.execute_threshold_tokens = { ...previousTokens, default: form.executeThresholdTokens };
  } else {
    next.execute_threshold_tokens = { default: form.executeThresholdTokens };
  }

  if (form.protectedTokens === null) {
    delete next.protected_tokens;
  } else {
    next.protected_tokens = form.protectedTokens;
  }

  // historian 只改 model 键：temperature/tools/prompt 等元数据原样保留，
  // 但空值必须**删键**而不是写 "" 或留旧值——`z.string().trim().min(1).optional()`
  // 拒绝空串，而保留旧值会让「清空」这个操作静默失效（用户点了清空却什么都没变，
  // 下一次保存又把旧模型写回 config.json）。
  const previousHistorian = isRecord(previous.historian) ? previous.historian : {};
  const model = form.historianModel.trim();
  if (model) {
    next.historian = { ...previousHistorian, model };
  } else if ("model" in previousHistorian) {
    const { model: _dropped, ...rest } = previousHistorian;
    next.historian = rest;
  } else {
    next.historian = { ...previousHistorian };
  }

  return next;
}

/**
 * 表单的 historian 模型值（"provider/model"）↔ 模型选择器值（`custom:provider:model`）
 * 互转。选择器用的是自定义模型编码（`encodeCustomModelValue`），而 config.json 存的是
 * CLI 侧的 "provider/model" 身份串——两者不能混用，否则保存下去 CLI 侧解析不出
 * providerId，historian 会在运行时报「模型缺少 Provider」。
 *
 * 放这里而不是组件里：这是一对**纯字符串变换**，且与「整域写回」是同一条数据链的
 * 两端（读出来要能显示、选完要能写回），放一起才不会只改一端。
 */

/** 空 historian 模型的选择器哨兵值。与 Subagents 的 `inherit` 同构：展示态专用。 */
const NO_HISTORIAN_MODEL_VALUE = "none";

export function toModelPickerValue(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return NO_HISTORIAN_MODEL_VALUE;
  try {
    const selection = parseModelPickerValue(trimmed);
    return encodeCustomModelValue(selection.providerId, selection.modelId);
  } catch {
    // 配置里写了一个解析不出来的身份串（缺 "/" 之类）。原样回显而不是丢掉，
    // 否则用户会以为这条配置不存在，并可能用一次保存把它静默清掉。
    return trimmed;
  }
}

export function toPersistedModelId(pickerValue: string): string {
  if (pickerValue === NO_HISTORIAN_MODEL_VALUE) return "";
  try {
    const selection = parseModelPickerValue(pickerValue);
    return `${selection.providerId}/${selection.modelId}`;
  } catch {
    return "";
  }
}

interface MagicContextNumberFieldSpec {
  min: number;
  max: number;
  step: number;
}

/**
 * 各数值字段的输入边界。
 *
 * 这些上下界本该由 `MagicContextConfigSchema` 拥有，但 UI 不依赖 CLI 侧的
 * `@zcode/magic-context` 包（依赖方向反了），所以这里按同一组约束复述一份，
 * 每一项都在注释里点名 schema 的哪一行产生它。驱动输入框的 min/max/step，
 * 让用户拿不到必然被拒的输入；**真正的拒绝仍然只发生在 CLI handler 的
 * schema parse 上（-32602）**——这一层是体验，不是第二份真相。
 */
export const MAGIC_CONTEXT_NUMBER_FIELD_SPECS = {
  // schema: ThresholdPercentageSchema = z.number().min(20).max(90)
  executeThresholdPercentage: { min: 20, max: 90, step: 1 },
  // schema: z.number().min(5_000).max(2_000_000)
  executeThresholdTokens: { min: 5_000, max: 2_000_000, step: 1_000 },
  // schema: z.number().int().min(PROTECTED_TOKENS_MIN=4_000).max(1_000_000)
  protectedTokens: { min: 4_000, max: 1_000_000, step: 1_000 },
  // schema: z.number().min(0.05).max(0.5)
  historyBudgetPercentage: { min: 0.05, max: 0.5, step: 0.01 },
} as const satisfies Record<string, MagicContextNumberFieldSpec>;
