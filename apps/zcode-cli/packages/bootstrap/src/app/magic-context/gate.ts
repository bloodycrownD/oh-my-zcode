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
