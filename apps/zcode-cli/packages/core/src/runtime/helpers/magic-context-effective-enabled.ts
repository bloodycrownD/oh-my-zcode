/**
 * core 侧对「magic-context 生效开关」的**唯一**投影点（spec IM3 / phase-effective-single）。
 *
 * ============================================================================
 * 真值来源是 bootstrap 唯一口径的输出，不是这里重新推导的开关
 * ============================================================================
 *
 * `runtime.config.magicContext.enabled` 是 bootstrap `resolveMagicContextEffectiveEnabled()`
 * （`bootstrap/src/app/magic-context/effective-enabled.ts`，契约 8）算出的**冷值**：
 * `(override ?? features.magicContext) && magicContext.enabled`。core 侧三个消费点今天
 * 各自把它与布尔字面量比较了一边，于是「判定」这件事在 core 里被抄了三份。
 *
 * 收口方式按 spec 定案：**不合并成单函数语义**。三处的 `undefined` 缺省方向本来就
 * 不一致（T-MC1 逐行写死），收口只能统一「真值来源」，不得顺手改掉任何一处的缺省：
 *
 * | 调用点 | 原表达式 | 缺省方向 | 收口后 |
 * |---|---|---|---|
 * | `runtime-tools.ts`（ctx 工具注册门） | `=== true` | 缺席→关 | `whenUnset: false` |
 * | `magic-context-prompt-section.ts`（段注入） | `!== true` | 缺席→关 | `whenUnset: false` |
 * | `magic-context-turn-transform.ts`（turn-loop 兜底否决） | `=== false` | 缺席→开（端口在场为前提） | `whenUnset: true` |
 *
 * `whenUnset` 因此是**必填**参数：新增调用点必须显式声明缺省方向，不允许靠默认值
 * 静默继承某一处的历史语义。
 *
 * 零依赖（只有 type 无关的纯算术）：本文件与 `magic-context-turn-transform.ts` 的
 * 「可以被 node 直接加载、不拉 core 运行时图」纪律兼容。
 */
export interface MagicContextEffectiveByConfigOptions {
  /** `enabled` 缺席（配置未投影该字段的轻量 runtime）时的判定方向。 */
  whenUnset: boolean;
}

/**
 * 把 bootstrap 算出的冷值投影成一个布尔，只做「缺席按谁」这一个决定。
 *
 * 注意：`enabled` 已经是 effective，**不要**再叠加 `features.magicContext` 或
 * `magicContext` 域的判断——那样会造出第二个实现（IM3 禁止，且有同源守卫）。
 */
export function isMagicContextEffectiveByConfig(
  enabled: boolean | undefined,
  options: MagicContextEffectiveByConfigOptions,
): boolean {
  return enabled ?? options.whenUnset;
}
