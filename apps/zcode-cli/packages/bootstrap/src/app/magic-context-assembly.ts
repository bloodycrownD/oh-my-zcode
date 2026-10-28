import type { Logger, SessionId } from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import { emitMagicContextTransformAbsent } from "./magic-context-absent-event.js";
import {
  completeAuxiliaryRegistryModelSelection,
  resolveRegistryOwnedSelection,
} from "./provider-registry-selection.js";
import type { ApiProviderModelRuntime, ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

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

type TurnTransformParams = Parameters<
  MagicContextAssemblyModule["createMagicContextTurnTransform"]
>[0];

/** turn transform 工厂里由本模块自行构造、调用方不必提供的两个探针。 */
type InjectedTurnTransformParam = "registerClose" | "muralVisionProbe" | "createSidecarModel";

/**
 * 第二阶段装配：加载门通过之后，构造 turn transform、提示词段解析器与工具描述求值器。
 *
 * 为什么与 `loadMagicContextAssembly` 分开：加载门与「flag 关也要发 absent 事件」
 * 的纪律属于第一段；这里全是**已经拿到了模块命名空间之后**的构造，失败语义不同
 * （不吞错、不降级，装配失败就是启动失败）。分成两段后，调用点读起来就是
 * 「先开灯，再按灯接线」。
 *
 * 参数取自 `createMagicContextTurnTransform` 的签名（`Parameters<...>`），不在这里
 * 另抄一份类型——那会变成第二份真相，工厂加参数时这里会静默落后。
 */
export interface AssembleMagicContextDeps {
  assembly: MagicContextAssemblyModule;
  enabled: TurnTransformParams["enabled"];
  logger: Logger;
  sessionId: SessionId;
  workingDirectory: TurnTransformParams["workingDirectory"];
  configPort: TurnTransformParams["configPort"];
  configDomain: unknown;
  sessionStore: TurnTransformParams["sessionStore"];
  processExitsAfterTurn: TurnTransformParams["processExitsAfterTurn"];
  onMagicContextUsage?: TurnTransformParams["onMagicContextUsage"];
  providerRegistry: ProviderRegistryModelSource;
  modelFactory: ApiProviderModelRuntime["modelFactory"];
  traceContext: TurnTransformParams["traceContext"];
  usageRecorder?: ReturnType<MagicContextAssemblyModule["createMagicContextUsageRecorder"]>;
}

export interface AssembledMagicContext {
  turnTransform: Awaited<ReturnType<MagicContextAssemblyModule["createMagicContextTurnTransform"]>>;
  promptSection: ReturnType<MagicContextAssemblyModule["createMagicContextPromptSectionResolver"]>;
  toolDescription: ReturnType<
    MagicContextAssemblyModule["createMagicContextToolDescriptionResolver"]
  >;
  /** 装配工厂注册回来的关闭钩子；缺席 = 没装成（DB 开不出来等）。 */
  close?: () => Promise<void>;
}

export async function assembleMagicContext(
  deps: AssembleMagicContextDeps,
): Promise<AssembledMagicContext> {
  const {
    assembly,
    enabled,
    logger,
    sessionId,
    workingDirectory,
    configPort,
    configDomain,
    sessionStore,
    processExitsAfterTurn,
    onMagicContextUsage,
    providerRegistry,
    modelFactory,
    traceContext,
    usageRecorder,
  } = deps;

  // FORK（MF-05）：magic-context 的关闭钩子由装配工厂**注册**回来，而不是这里
  // 拿它的内部对象——后者会把 drain/shutdown/dispose 的顺序知识泄到装配层。
  // 缺席 = 没装 magic-context（DB 开不出来），此时不注入 session facade。
  let close: (() => Promise<void>) | undefined;

  const turnTransform = await assembly.createMagicContextTurnTransform({
    // FORK（MF-01）：传**同一次求值**的 effective，而不是硬编码 true。契约 8
    // 是 `features.magicContext && magicContext.enabled`，这一位与装配门读的是
    // 同一个字段——门面不接受「装配门认为开着、transform 却认为关着」。
    enabled,
    registerClose: (registered) => {
      close = registered;
    },
    // FORK（S23 / D-12）：传本 App 的配置口，config bridge 据此订阅
    // `ConfigPort.observe(ConfigKey.MagicContext)`，运行中改配置下一 turn
    // 生效、无需重启（spec Step 16 判据）。`configDomain` 降级为无配置口时
    // 的静态源，生产路径恒有 `configPort`。
    configPort,
    configDomain,
    sessionId,
    workingDirectory,
    // FORK（bugfix-batch-20261011 / phase-mc-settle-bg）：进程形态透传。
    // 三个入口（protocol / TUI / print）各自知道自己是不是长驻，bootstrap 不
    // 做 argv 嗅探——TUI 与 `-p` 在 argv 上不可区分。缺省 true = 保守，保持
    // print 与所有未声明形态的现有前台 settle 行为（求值在调用方，这里只透传）。
    processExitsAfterTurn,
    sessionStore,
    logger,
    // FORK（D-13）：把预算摘要交给协议宿主的投影层。缺席（CLI/TUI）时本条
    // 推送不存在，magic-context 其余行为逐行不变。
    ...(onMagicContextUsage === undefined ? {} : { onMagicContextUsage }),
    // FORK（bugfix-batch-20261011 / Step 15，D5）：mural 的 vision 判定源。
    // 包内 render-trigger 上游读 models-dev apiCache（本 fork 零生产者、恒
    // false），判定改走**静态目录** `ModelInputFormatData.supportsImage`
    // （packages/shared/src/model-config.ts:51-59，与 contracts
    // media-policy.ts:40 同一源）；「provider/model → properties」的解析只有
    // provider Registry 做得到。未知模型/catalog 缺字段一律 false（fail-closed，
    // 与上游「缺失 cache 条目不出图」同向）。冒号 tag 后缀（modelID:tag）与
    // 上游 `modelSupportsVision` 的 fallback 同款：先整键、再去 tag 试一次。
    muralVisionProbe: (modelKey: string) => {
      const separator = modelKey.indexOf("/");
      if (separator <= 0) return false;
      const providerId = modelKey.slice(0, separator);
      const modelId = modelKey.slice(separator + 1);
      const accepts = (id: string): boolean => {
        const model = providerRegistry.getModel(providerId, id);
        return model?.config?.properties?.inputFormat?.supportsImage === true;
      };
      if (accepts(modelId)) return true;
      const colon = modelId.lastIndexOf(":");
      return colon > 0 ? accepts(modelId.slice(0, colon)) : false;
    },
    // FORK（S24 / D-6）：historian 的 sidecar 请求要一个能发请求的 `Model`，而
    // 「这个模型此刻造不造得出来」这件事只有 provider Registry 知道。
    // `completeAuxiliaryRegistryModelSelection` 正是为「连通性这类辅助调用」准备
    // 的（它给未带 reasoning 档位的选择补上最低档），所以旁路请求与主会话选模型
    // 走的是**同一条**校验，而不是这里再抄一份解析。
    createSidecarModel: (modelId: string) => {
      const resolved = resolveRegistryOwnedSelection(providerRegistry, modelId, undefined, {
        allowMissingReasoning: true,
      });
      if (!resolved) return undefined;
      return modelFactory({
        selection: completeAuxiliaryRegistryModelSelection(providerRegistry, resolved.selection),
      });
    },
    traceContext,
    ...(usageRecorder === undefined ? {} : { usageRecorder }),
  });

  // FORK（bugfix-batch-20261011 / Step 13，D1）：`## Magic Context` agent 提示词段
  // 的装配端口。core 的 context builder 是同步的且不许静态 import 包，所以 11 参
  // 装配只能由装配层做。缺席（flag 关）时 context builder 回落原生 `# Memory` 段
  // （互斥裁定，见 core `context/sections/magic-context.ts`）。
  const promptSection = assembly.createMagicContextPromptSectionResolver({
    configPort,
    configDomain,
    logger,
  });

  // FORK（bugfix-batch-20261011 / Step 14）：同一个门注入 preset 分档描述求值器。
  // 设置页的 `prompt_surface.default` / `models` 经它第一次真正影响模型看得见的
  // 工具描述（light 档换紧凑文案）；在那之前这两个字段写下去没有任何运行期消费者。
  const toolDescription = assembly.createMagicContextToolDescriptionResolver({
    configPort,
    configDomain,
    logger,
  });

  return { turnTransform, promptSection, toolDescription, close };
}
