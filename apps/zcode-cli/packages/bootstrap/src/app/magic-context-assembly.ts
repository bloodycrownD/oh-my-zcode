import type { Logger, SessionId } from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import { emitMagicContextTransformAbsent } from "./magic-context-absent-event.js";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

type MagicContextAssemblyModule = typeof import("./magic-context-turn-transform.js");

/**
 * magic-context 的加载门 + usage recorder 装配。
 *
 * 为什么单独成文件：`create-app.ts` 是上游 ZCode 的 App 装配入口，跟随上游升级时
 * 改动概率最高。MC 在这里原本占 76 行（门控 + recorder + 回退窗口解析），全部是
 * fork 自有的知识——搬走后上游文件只留一次调用。
 *
 * ---------------------------------------------------------------------------
 * 门控与可观测性（搬自原 create-app 的 Step 19b 注释）
 * ---------------------------------------------------------------------------
 *
 * `features.magicContext` 关闭时，本模块**连 `import()` 都不发生**——于是既不
 * 加载 magic-context 模块图，也不创建 transform / provider 实例，更不会打开
 * magic-context.db。用户显式关掉 flag 时的成本就是这一个三元判空。
 *
 * 打开时先跑装配工厂：它内部第一句就是 `initializeMagicContextHost()`
 * （S15 遗留 #6：setHarness("zcode") + project-dir resolver），且在任何 DB 写
 * 之前——调用点必须保证这一点：ZCode 自己的 session store 早在
 * `openStartupSessionStore` 就已开完，而 magic-context 的 DB 由工厂自己开。
 *
 * ⑤-5b：动态 import 失败当前是**冒泡 throw**（fail-closed 性状），修复只补
 * 可观测性——发 `magic_context.transform_absent`（reason=import_failed）后
 * **照旧 rethrow**，不捕获成降级。事件名/reason 词表与工厂侧同源，统一走
 * `magic-context-absent-event.ts` 这个零依赖 leaf（工厂本模块不能静态 import
 * ——否则 flag 关时也会把整个 magic-context 模块图拖进启动路径；leaf 没有
 * 这个成本）。
 *
 * ⑤-5a：**disabled 也要发事件**。flag 关时工厂永不执行，`transform_absent`
 * (reason=disabled) 若只由工厂发就一次都不会出现——「压缩停机」在 disabled
 * 形态下依旧静默（mc/A-1 收口）。这是生产侧 disabled 的唯一发射点；工厂内
 * 的 disabled 分支只保留给直构/测试。
 */
export interface LoadMagicContextAssemblyDeps {
  /** 契约 8 的 effective：`features.magicContext && magicContext.enabled`，调用方求值后传入。 */
  enabled: boolean;
  logger: Logger;
  sessionId: SessionId;
  providerRegistry: ProviderRegistryModelSource;
  /** 会话 runtime 访问器；装配期不求解，只在 turn 期间被 recorder 回调。 */
  getRuntime: () => AgentRuntime;
  /** agent/C-1：回落式收敛在 `resolveConfiguredDefaultModelSelectionOf`，此处只取结果。 */
  readConfiguredDefaultModelSelection: () => { providerId: string; modelId: string } | undefined;
}

export interface LoadedMagicContextAssembly {
  /** 动态 import 的模块命名空间；flag 关或 import 失败时为 undefined。 */
  assembly?: MagicContextAssemblyModule;
  /** usage recorder；assembly 缺席时 undefined。 */
  usageRecorder?: ReturnType<MagicContextAssemblyModule["createMagicContextUsageRecorder"]>;
}

export async function loadMagicContextAssembly(
  deps: LoadMagicContextAssemblyDeps,
): Promise<LoadedMagicContextAssembly> {
  const { enabled, logger, sessionId, providerRegistry, getRuntime, readConfiguredDefaultModelSelection } =
    deps;

  let assembly: MagicContextAssemblyModule | undefined;
  if (enabled) {
    try {
      assembly = await import("./magic-context-turn-transform.js");
    } catch (error) {
      emitMagicContextTransformAbsent(
        logger,
        "import_failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  } else {
    emitMagicContextTransformAbsent(
      logger,
      "disabled",
      "features.magicContext / magicContext.enabled is false; no bridge, no database, no transform",
    );
  }

  const usageRecorder = assembly?.createMagicContextUsageRecorder(sessionId, logger, {
    // e2e/R-2 二层兜底：模型自带 `properties.contextWindow` 缺席（用户实证：
    // 未设置历史/默认模型时 catalog 无窗口）时，解析**会话生效模型**的 registry
    // 窗口。会话生效模型 = 显式选择（runtime 持有，含 restore 的持久选择）??
    // 活默认（`readConfiguredDefaultModelSelection`，即 agent/C-1 的
    // `resolveConfiguredDefaultModelSelectionOf` 同源 accessor）——与子代理
    // 默认模型继承同范式，无会话/未设置模型也必然有值。
    //
    // 闭包只在 turn 期间被调用（recorder 绑定时），那时 runtime 已建；装配期
    // 不求解。查不到/没 runtime 都返回 undefined，由 recorder 的保守默认层
    // （128k / env 覆盖）收口。
    resolveFallbackContextWindow: () => {
      try {
        const selection =
          getRuntime().getSessionModelSelection() ?? readConfiguredDefaultModelSelection();
        if (!selection) return undefined;
        const registryModel = providerRegistry.getModel(
          selection.providerId,
          selection.modelId,
        );
        return registryModel?.config?.properties?.contextWindow;
      } catch {
        return undefined;
      }
    },
  });

  return { assembly, usageRecorder };
}
