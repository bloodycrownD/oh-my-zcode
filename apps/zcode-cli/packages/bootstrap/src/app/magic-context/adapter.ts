/**
 * mc-adapter-decoupling：magic-context 的**装配缝**（适配器契约）。
 *
 * ============================================================================
 * 这个文件解决什么
 * ============================================================================
 *
 * 改造前 `create-app.ts` 里散着五处 MC 接线，每一处各自推导「现在开没开」：
 *
 *   - 动态 `import()` 门（`runtimeConfig.magicContext?.enabled === true`）
 *   - `createMagicContextUsageRecorder(...)` 组装
 *   - `createMagicContextTurnTransform({ enabled: ... })` 工厂调用 + 关闭钩子登记
 *   - `createMagicContext{PromptSection,ToolDescription}Resolver(...)` 两个端口
 *   - `isMagicContextEnabled: () => runtimeConfig.magicContext?.enabled === true`
 *
 * 五处推导一旦有一处漏改，就会出现「装配门认为开着、命令面认为关着」这类分叉。
 * 现在收敛成一个工厂：**门只有一道**（{@link resolveMagicContextEffectiveEnabled}），
 * 结果是一个只读对象，`create-app` 只做字段分发。
 *
 * ============================================================================
 * 加载纪律（flag off 零加载）
 * ============================================================================
 *
 * 本模块由 `create-app.ts` **静态** import，所以它自己不许有任何 MC 运行时依赖：
 * 全部 MC 引用都是 `import type`（编译后擦除）或类型位置的 `typeof import(...)`。
 * 唯一的动态 `import("../magic-context-turn-transform.js")` 发生在
 * `enabled === true` 之后——位置语义与原 `create-app` 的 gate 之后逐行等价：
 * flag 关时整棵 MC 实现图（含 `node:sqlite`）不进内存，`transform_absent(disabled)`
 * 照旧由本模块发射（原 create-app 的 else 分支，生产侧唯一发射点）。
 *
 * 失败语义同样保持：动态 import 抛错时先发 `transform_absent(import_failed)` 再
 * **原样 rethrow**（fail-closed），不捕获成降级。
 */

import type {
  AgentRuntimeDeps,
  MagicContextPromptSectionResolver,
  MagicContextTurnTransform,
} from "@zcode/core";
import { emitMagicContextTransformAbsent } from "../magic-context-absent-event.js";
import {
  resolveMagicContextEffectiveEnabled,
  type MagicContextEffectiveConfigSource,
} from "./gate.js";
import type { MagicContextTurnTransformOptions } from "./types.js";
import type { MagicContextUsageRecorder } from "./usage.js";

// 适配器契约面包含生效口径（定义在零依赖 leaf `./gate.ts`，理由见该文件头）：
// 协议层要能在**加载 MC 实现图之前**调它，所以不能只从这里拿。
export {
  resolveMagicContextEffectiveEnabled,
  type MagicContextEffectiveConfigSource,
} from "./gate.js";

/** 装配门关闭时那条 `transform_absent(disabled)` 的 detail（与改造前逐字一致）。 */
const DISABLED_DETAIL =
  "features.magicContext / magicContext.enabled is false; no bridge, no database, no transform";

/**
 * 装配好的 magic-context 能力面。**只读**（`Object.freeze`）：调用方只分发字段，
 * 不允许在装配之后替换其中任何一项。
 *
 * 字段与改造前 `create-app` 里的局部变量一一对应（见每行注释的行号），名字刻意用
 * 中性词（`turnTransform` / `promptSection` / `toolDescription`），不复制 core 的
 * 端口类型名——类型本身直接派生自 core（见字段声明）。
 */
export interface MagicContextAdapter {
  /**
   * turn transform 端口（原 `create-app.ts:879-955` 的 `magicContextTurnTransform`）。
   *
   * 缺席 = 装配到了工厂但库开不出来（schema fence / 迁移被挡 / pending 竞争且
   * `fail_closed_blocking=false`）。此时 prompt-surface 两个端口照旧可用。
   */
  readonly turnTransform?: MagicContextTurnTransform;
  /** `## Magic Context` 段 resolver（原 `:1016-1025` 的 `magicContextPromptSection`）。 */
  readonly promptSection: MagicContextPromptSectionResolver;
  /** preset 分档工具描述求值器（原 `:1030-1035` 的 `magicContextToolDescription`）。 */
  readonly toolDescription: NonNullable<AgentRuntimeDeps["magicContextToolDescription"]>;
  /**
   * 生效判定（原 `:1281` 的 `isMagicContextEnabled`）。
   *
   * 这是**冷**求值：`runtimeConfig` 在 `resolveAppRuntimeConfig` 里已按契约 8 折算过，
   * 运行中改 `enabled` 走 transform 端口上的活值 `isEnabled()`，与本字段无关
   * （与本文件改造前逐行相同）。适配器只在 `enabled === true` 时存在，因此这里恒
   * 返回 true；保留成函数是为了让调用点的 `isMagicContextEnabled?: () => boolean`
   * 形状不变。
   */
  readonly isEnabled: () => boolean;
  /**
   * 会话关闭钩子（原 `:878/886` 的 `closeMagicContext`）。
   *
   * 由工厂经 `registerClose` 登记回来：drain（有界）→ shutdown → bridge.dispose。
   * 缺席 = 没装 transform（flag 关或库开不出来），此时 session facade 不注入。
   */
  readonly registerSessionClose?: () => Promise<void>;
  /**
   * provider usage 记录器（原 `:845-874` 创建；`:951-953` 进 transform 选项、
   * `:995` 进事件扇出）。
   *
   * 只在有 transform 时才真正被 prime/record，但**只要装配门开着就创建**——事件
   * 扇出的包装不依赖库开没开（与改造前一致）。
   */
  readonly usage: MagicContextUsageRecorder;
}

/**
 * 装配输入。除 `resolveFallbackContextWindow` 外全部派生自
 * {@link MagicContextTurnTransformOptions}（`Omit` 掉由本模块负责的三项），因此
 * 「工厂需要什么」只有一处权威，不新增同名类型。
 */
export type MagicContextAdapterDeps = Omit<
  MagicContextTurnTransformOptions,
  "enabled" | "registerClose" | "usageRecorder"
> & {
  /**
   * FORK（e2e/R-2 二层兜底）：模型自带 `properties.contextWindow` 缺席时，解析
   * 「会话生效模型」的 registry 窗口。闭包只在 turn 期间被调用，装配期不求解
   * （原 `create-app.ts:859-872` 的注释保留在那里）。
   */
  resolveFallbackContextWindow?: () => number | undefined;
};

/**
 * 装配 magic-context。`enabled === false` → 发 `transform_absent(disabled)` 后返回
 * `undefined`（原 create-app 的 else 分支）。
 *
 * 顺序与改造前逐行等价：
 *   ① 生效门 → ② 动态 import（失败发事件后 rethrow）→ ③ usage recorder →
 *   ④ transform 工厂（含关闭钩子登记）→ ⑤ prompt-surface 两个 resolver。
 */
export async function createMagicContextAdapter(
  runtimeConfig: MagicContextEffectiveConfigSource | undefined,
  deps: MagicContextAdapterDeps,
): Promise<MagicContextAdapter | undefined> {
  if (!resolveMagicContextEffectiveEnabled(runtimeConfig)) {
    emitMagicContextTransformAbsent(deps.logger, "disabled", DISABLED_DETAIL);
    return undefined;
  }

  let assembly: typeof import("../magic-context-turn-transform.js");
  try {
    assembly = await import("../magic-context-turn-transform.js");
  } catch (error) {
    // ⑤-5b：先留可观测痕迹，再**照旧 rethrow**（fail-closed 性状不变）。
    emitMagicContextTransformAbsent(
      deps.logger,
      "import_failed",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }

  const { resolveFallbackContextWindow, ...transformOptions } = deps;

  // recorder 必须先于 transform 工厂创建：工厂要用它 prime / 绑 live 模型，事件
  // 扇出也要它（原 create-app 的三处顺序：先 recorder、再工厂、最后包 sink）。
  const usage = assembly.createMagicContextUsageRecorder(deps.sessionId, deps.logger, {
    // 缺省 undefined 与「不带该键」在 recorder 侧等价（`options?.resolveFallback…?.()`）。
    resolveFallbackContextWindow,
  });

  let registerSessionClose: (() => Promise<void>) | undefined;
  const turnTransform = await assembly.createMagicContextTurnTransform({
    ...transformOptions,
    // FORK（MF-01）：门与工厂读**同一次**求值结果，工厂不接受「装配门认为开着、
    // transform 却认为关着」的形态。
    enabled: true,
    usageRecorder: usage,
    registerClose: (close) => {
      registerSessionClose = close;
    },
  });

  // ⑤ prompt-surface 两个 resolver：与 transform 同一个门（原 create-app 的注释：
  // 同一模块唯一的 import 点；core 的 context builder 是同步的且不许静态 import 包）。
  const promptSectionOptions = {
    configPort: deps.configPort,
    configDomain: deps.configDomain,
    logger: deps.logger,
  };

  return Object.freeze({
    turnTransform,
    promptSection: assembly.createMagicContextPromptSectionResolver(promptSectionOptions),
    toolDescription: assembly.createMagicContextToolDescriptionResolver(promptSectionOptions),
    isEnabled: () => true,
    registerSessionClose,
    usage,
  });
}
