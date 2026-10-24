/**
 * magic-context 的**唯一**生效口径（契约 8）：
 *
 *   effective = features.magicContext && magicContext.enabled !== false
 *
 * 两个字段缺席时都按「不拦」处理，依据各自的上游缺省：
 *   - `features.magicContext`：配置文件的 features 域缺席时，`ZCodeConfigFileSchema`
 *     的缺省就是 true（kill switch 默认开）；
 *   - `magicContext.enabled`：包内 schema 是 `z.boolean().default(true)`。
 *
 * ── 为什么是零依赖 leaf ─────────────────────────────────────────────────────
 * 本函数有四个消费者，其中 `zcode-protocol/magic-context-memories.ts` 的生效门必须
 * 在**加载 MC 实现图之前**得出结论（关着时连 `openDatabase` 都不该发生）。把它放进
 * `./adapter.ts` 会让那条链顺带拉起 adapter 的依赖面；而 `./adapter.ts` 本身虽然只
 * 做类型引用，仍不该成为协议层为了算一个布尔值的加载对象。这里只导出纯函数与
 * 结构类型，零 import、零副作用。
 *
 * 口径同源纪律（MF-01 / MF-06 的硬约束）：装配门（`create-app` → adapter）、命令面
 * （`isMagicContextEnabled`）与设置页的记忆管理 RPC 必须都调用本函数，任何一处自行
 * 重算都会在 `features=true + enabled=false` 这类组合上分叉。
 */

/**
 * 生效判定能看到的两个域。刻意写成结构类型而不是 import 某个包的 config 类型：
 * 三个调用点喂进来的对象形状不同（`AgentRuntimeConfig` 只带已折算的
 * `magicContext.enabled`，`RuntimeConfigPatch` 带未校验的 `unknown` 域，ConfigPort
 * 分两个 key 取），共同点只有这两处。
 */
export interface MagicContextEffectiveConfigSource {
  /** 全局 kill switch。`AgentRuntimeConfig` 没有这一层——它的 `enabled` 已折过。 */
  features?: { magicContext?: boolean | undefined } | undefined;
  /** 参数域总开关（包内 schema 缺省 true）。 */
  magicContext?: { enabled?: boolean | undefined } | undefined;
}

/**
 * 生效判定。**只判显式 false**：缺席按上游缺省 true 处理（见文件头）。
 *
 * `source === undefined` 返回 false——没有配置可读时按关处理（fail-closed 方向：
 * 宁可不插桩，也不在配置未知时开库）。
 */
export function resolveMagicContextEffectiveEnabled(
  source: MagicContextEffectiveConfigSource | undefined,
): boolean {
  if (source === undefined) return false;
  if (source.features?.magicContext === false) return false;
  return source.magicContext?.enabled !== false;
}
