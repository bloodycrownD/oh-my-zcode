/**
 * magic-context 生效口径的**唯一**求值点（契约 8：`features.magicContext && magicContext.enabled`）。
 *
 * 为什么要有这个文件：同一口径此前在 bootstrap 内至少两处各写一遍——
 * `runtime-config.ts` 的冷求值，以及 `zcode-protocol/magic-context-memories.ts`
 * 的配置读取。后者只读了 `magicContext.enabled` 域、漏了 `features.magicContext`
 * 这个 kill switch，于是总开关关闭时设置页仍能打开记忆库（与 `create-app` 的
 * 装配门不同频）。收成纯函数后：无包依赖、无副作用、无全局状态，装配层与协议
 * handler 共用同一份真值表。
 *
 * 防腐层意义：这是「宿主语义」而不是「magic-context 包语义」——它不 import 任何
 * `@zcode/magic-context` 符号，升级上游或整体摘除包时都不需要跟着改。后续
 * `bootstrap/src/app/magic-context/` 门面的门就钉在这里。
 *
 * 缺省语义与包内 schema 对齐：`enabled: z.boolean().default(true)`，所以
 * `domainEnabled` 缺席按开处理，只有显式 `false` 才关；`featureFlag` 由调用方
 * 解析完缺省后传入（resolved config 必为 boolean）。
 *
 * IM3（spec phase-effective-single）：本文件是**唯一**实现。三轴求值只允许在这里
 * 写一次；消费方要么调用 `resolveMagicContextEffectiveEnabled()`（有自己的原始输入），
 * 要么调用 `projectMagicContextEffectiveEnabled()` 读它算出的冷值——不得再各写一遍比较。
 * `bootstrap/scripts/test-magic-context-gate.mjs` 的「同源守卫」在全仓范围强制这一点。
 */
export interface MagicContextEffectiveEnabledInput {
  /** `features.magicContext`，调用方已解析缺省（config lane 默认 true）。 */
  featureFlag: boolean;
  /**
   * 运行期 override：`runtimeConfig.magicContext.enabled`（CLI/config 冷启动传入）。
   * 缺席 = 不覆盖，跟 feature flag 走。
   */
  overrideEnabled?: boolean;
  /** `magicContext.enabled` 域；缺席或非 false 都视为开。 */
  domainEnabled?: boolean;
}

/** `effective = (override ?? featureFlag) && domainEnabled !== false`。 */
export function resolveMagicContextEffectiveEnabled(
  input: MagicContextEffectiveEnabledInput,
): boolean {
  return (input.overrideEnabled ?? input.featureFlag) && input.domainEnabled !== false;
}

/**
 * 冷值投影：读 `RuntimeConfig` 里那一位**已由 {@link resolveMagicContextEffectiveEnabled}
 * 算出并冻结**的 `magicContext.enabled`。
 *
 * 为什么需要它：`create-app.ts` 曾在装配门 / 工厂入参 / `isMagicContextEnabled` 契约
 * 三处各写一遍同一个比较（spec W3 的 G4）。三处读的是同一个字段、同一个值，重算一次
 * 没有任何意义，只留下「三份可能漂移的判定」。收成一次调用后装配层只剩一个布尔。
 *
 * 这里**不重新求值**三轴：`RuntimeConfig.magicContext.enabled` 是冷求值的**输出**，
 * 再喂回 `resolveMagicContextEffectiveEnabled` 会得到同一结果却掩盖「谁是输入」。
 * 缺省方向与原三处逐位一致：缺席按关（冷值缺席只可能出现在未投影该字段的轻量形态）。
 */
export function projectMagicContextEffectiveEnabled(
  runtimeConfig: { readonly magicContext?: { readonly enabled?: boolean } | undefined } | undefined,
): boolean {
  return runtimeConfig?.magicContext?.enabled === true;
}
