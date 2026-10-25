/**
 * magic-context 装配的对外契约类型：工厂入参（{@link MagicContextTurnTransformOptions}）
 * 与包内 transform 的形状（{@link ZCodeMagicContextTransform}）。
 *
 * 从 `../magic-context-turn-transform.ts` 拆出（Step 3 / phase-facade，零行为）。
 * 为什么单独成文件：这两个类型被 `create-app.ts` 与 11 个脚本各自引用，独立成文件
 * 后「只想拿类型」的消费者不必把装配实现拖进类型图。
 */

import type { Logger } from "@zcode/core";
import type { ConfigPort, SessionStorePort, TraceContext } from "@zcode/contracts";
import type { SessionMagicContextUsage } from "@zcode/shared/zcode-protocol-v4";
import type { CreateSidecarModel } from "../magic-context-historian.js";
import type { MagicContextUsageRecorder } from "./usage.js";

/** 包内 `createTransform` 的返回值形状（单测用桩实现替换它）。 */
export type ZCodeMagicContextTransform = (
  input: Record<string, never>,
  output: { messages: unknown[] },
) => Promise<void>;

/**
 * FORK（spec phase-compartment-rewind / C1）：rewind 事实，交给 compartment 失效
 * 回调的**唯一**入参形状。
 *
 * `anchorMessageId` = 被裁掉的第一条消息（`ConversationRewindResult.targetMessageId`）；
 * `keptMessageCount` = rewind 结果里的保留条数，仅作「持久序换算出不来」时的兜底
 * 水位（见 `storage.ts` 的 `invalidateMagicContextCompartmentsForRewind`）。
 */
export interface MagicContextCompartmentRewindInput {
  anchorMessageId: string;
  keptMessageCount: number;
}

/** rewind → compartment 失效回调。`undefined` 返回值不存在：内部已把错误收成 warn。 */
export type MagicContextCompartmentInvalidator = (
  input: MagicContextCompartmentRewindInput,
) => Promise<void>;

/**
 * FORK（spec phase-zero-load / W2 / 变更点 #11）：装配层交出的**已装好**的库句柄。
 *
 * `db` 故意是 `unknown`，**不写成 `ReturnType<typeof import("@zcode/magic-context").openDatabase>`**：
 *   - 这个端口要穿过宿主**保留**的 `app/types.ts`（摘除后仍要过 typecheck，不能
 *     `import type` 一个被删的包），所以两边的形状必须是不透明的结构型；
 *   - 写成 `typeof import(...)` 会往 IM7 耦合预算里多记一处散点，而这一处对「升级
 *     时要看多少处」没有贡献（它只是一个透传字段）。
 *
 * 唯一的消费者（`magic-context-memories.ts`）在包在场时把 `db` 窄回真实类型，那一处
 * cast 是本设计**刻意**的边界转换，不是漏网的类型洞。
 */
export type MagicContextStorageHandle = { readonly db: unknown };

export interface MagicContextTurnTransformOptions {
  /**
   * **冷**求值后的 effective 开关（`features.magicContext && magicContext.enabled`，
   * 见 spec 契约 8 与 `runtime-config.ts`）。false → 工厂直接返回 undefined：不开
   * bridge、不 import 模块图、不开 DB。
   *
   * 运行中切换走返回端口上的 `isEnabled()`，不是这里。
   */
  enabled: boolean;
  /**
   * FORK（S23 / D-12）：本 App 的配置口。提供时 config bridge 订阅
   * `ConfigPort.observe(ConfigKey.MagicContext)`，运行中改配置**下一 turn 即生效**，
   * 无需重启。
   *
   * 缺席时退回 S19b 的静态快照（只读 `configDomain`），保留给单测与不装配配置面的
   * embedder；生产装配（`create-app.ts`）一定传入。
   */
  configPort?: ConfigPort;
  /** `RuntimeConfig.magicContext` 参数域快照；仅在没有 `configPort` 时作为配置源。 */
  configDomain?: unknown;
  sessionId: string;
  workingDirectory: string;
  /**
   * FORK（bugfix-batch-20261011 / Step 1-2）：本进程是否「跑完一轮就退出」。
   *
   * 这是本文件两处 settle（`settleInFlightHistorian` 与端口钩子
   * `settleScheduledPass`）**唯一**的判据来源。三个入口经
   * `ZCodeAppOptions`（`app/types.ts`）把它显式透传进来：stdio 协议宿主与 TUI 是
   * 长驻进程 → `false`；`print`（`-p`）一次性进程 → `true`。取进程生命周期而不是
   * 「是不是桌面」，是因为 TUI 与 print 在 argv 上不可区分，只有入口自己知道。
   *
   * `true`（缺省）= 进程会退出，于是在这一轮交还控制权之前替 historian 等一个
   * 有界窗口（本批改动之前的逐行行为）；`false` = 进程长驻，两处 settle 都不阻塞
   * 前台——调度器契约自陈 fire-and-forget 自行 publish，优雅关闭时由
   * `registerClose` 的 drain 收口兜底（MF-05）。
   *
   * 缺省 `true` 是刻意的保守方向：不声明形态时按「进程会退出」处理，即便那是长驻
   * 进程，代价也只是一次多余的有界等待，而不是把在飞的折叠丢在半路。
   */
  processExitsAfterTurn?: boolean;
  /**
   * FORK（bugfix-batch-20261011 / Step 15，D5）：mural 的 **vision 判定源**。
   *
   * 为什么由宿主注入：包内 render-trigger 的 `modelKeyAcceptsImages` 上游读
   * `models-dev-cache` 的 apiCache，而本 fork 那条链零生产者（refresh 零调用者）——
   * 恒 false 会让整条移植的渲染路径成为死代码。判定改走**静态目录**
   * `ModelInputFormatData.supportsImage`（packages/shared/src/model-config.ts:51-59，
   * 与 contracts media-policy.ts:40 同一源），而「provider/model → properties」
   * 的解析只有持有 provider Registry 的宿主做得到，包内零包依赖碰不到共享目录。
   *
   * 契约：入参是 canonical `provider/model` 键（包内已做 pi 前缀规范化），
   * 返回 true 表示这个模型吃图。**未知即 false**（fail-closed，与上游「缺失
   * cache 条目不出图」同向）；缺席（不传）时包内同样按 false 处理——即整个
   * mural 渲染静默不触发，与 Step 15 之前的现场行为一致。
   *
   * 注入是进程级（包内 `setMuralVisionProbe`，与 `setRawMessageProvider` 同范式）：
   * 模型目录与会话无关，多会话共享同一份 Registry 视图。
   */
  muralVisionProbe?: (canonicalModelKey: string) => boolean;
  /** 读历史的第二数据源；缺席时 raw-message provider 只服务内存历史。 */
  sessionStore?: SessionStorePort;
  logger: Logger;
  /**
   * FORK（S24 / D-6）：`"provider/model"` → 一个可发请求的 `Model`。historian 的
   * sidecar 请求经它发出，缺席时 executor **不装**、`historianRunnable` 保持 false
   * （见 `createMagicContextHistorianHost`）。生产装配（`create-app.ts`）由
   * provider Registry + `modelFactory` 提供。
   */
  createSidecarModel?: CreateSidecarModel;
  /** 会话根 trace；sidecar 请求在它下面开子 span。 */
  traceContext?: TraceContext;
  /**
   * FORK（MF-05）：把本装配的**关闭钩子**交给装配层。
   *
   * 之前 `drainHistorianSchedulerWithTimeout` / `historian.shutdown` /
   * `bridge.dispose` 三件事没有任何生产调用方（config bridge 在
   * `config-bridge.ts` 里订阅 `ConfigPort` 且永不退订），于是会话/进程结束时
   * 在飞的 historian 不会被收口、订阅计数也不会归零。
   *
   * 装配层把它挂进 `session-facade.ts` 的 `close()` 链——**必须**在
   * `closeSessionResources` 之前：historian 的在飞请求要写库，而 store / execution
   * port 一旦先关，写库就落在已关闭的 store 上。
   *
   * 缺席（单测与不装 historian 的装配）= 不产生关闭钩子，行为与本 fork 之前逐行
   * 相同。
   */
  registerClose?(close: () => Promise<void>): void;
  /**
   * FORK（spec phase-compartment-rewind / C1）：把「rewind 之后让 compartment 失效」
   * 的回调交给装配层（与 `registerClose` 同范式，构造期回填，不在返回值上加字段）。
   *
   * 回调入参是 **rewind 事实**（锚点 messageId + 被保留的消息条数），不是包内坐标：
   * 「messageId → 持久序序号」的换算要用 `sessionStore.messages()` 的顺序，那是
   * 宿主持有的东西（包内 `toStoredRows` 也是同一条顺序）；包只消费序号。
   *
   * 时序：工厂在 DB 开出来之后立刻回填（早于任何 turn），所以端口在场即「能失效」；
   * 关闭态 / db_null 时不存在这个回调，`record.app.invalidateMagicContextCompartments`
   * 也就不会被挂上——调用方按可选方法处理。
   *
   * 为什么不在 core 侧让 `rewind-message.ts` 调包：core 只能 `import type`（IM4），
   * 且 rewind 级联属另一条工作线；host 的 `fork-edit-retry.ts` 是 v4 编辑重发/重试
   * 的唯一 rewind 调点，一行可选调用即可覆盖 C1 的范围（TUI `/rewind` 不在本 spec
   * 范围，见 phase-compartment-rewind 的收窄裁定）。
   */
  registerCompartmentInvalidator?(invalidate: MagicContextCompartmentInvalidator): void;
  /**
   * FORK（spec phase-zero-load / W2 / 变更点 #11）：库开出来之后把句柄回填给装配层。
   *
   * 与 `registerClose` / `registerCompartmentInvalidator` 同一范式（构造期回填，不在
   * 返回值上加字段）：直构路径（11 个脚本 + 单测）不需要知道它，缺席即零行为。
   *
   * **它解决的缺陷**：`magic-context-memories.ts` 的两条 RPC（list / archive）此前自己
   * `openDatabase(getMagicContextDatabasePath())`。`openDatabase` 按路径缓存、不开第二条
   * 连接，但它会**创建并迁移**库——于是一条只读 RPC 在「装配缺席 / db_null」时把库造了
   * 出来。端口让 handler 只消费「装配层已经装好的」句柄，装配没成就不开库。
   *
   * 时序：在 `db` 成功之后、`deps`/transform 构造之前回填（早于任何 turn）。
   */
  registerStorage?(storage: MagicContextStorageHandle): void;
  /**
   * FORK（S24）：provider usage 的记录口。上游 OpenCode 的 plugin 在
   * `message.updated` 事件里写这张表，ZCode 没有 plugin 事件通道，于是这里由宿主
   * 从 `model_complete` 事件喂。**不接它等于永久 `percentage=0`**——scheduler 永远
   * `defer`，drop 与 historian 都不会启动（实测见 E2E 报告 T-M2 的 FAIL 记录）。
   * 缺席时退回 S19b 的空 Map，行为与那时逐行相同。
   */
  usageRecorder?: MagicContextUsageRecorder;
  /**
   * FORK（D-13）：预算摘要的出口。装配层（`create-app`）把它接到 v4 gateway 的
   * `updateMagicContextUsage`，于是 `usage.magicContext` 出现在桌面 ChatContextUsage
   * 面板上。
   *
   * **缺席 = 整条推送不存在**：CLI/TUI 前端没有 snapshot 投影层，不传它；没有它时
   * 本文件只多两个 `if (!sink) return`，DB 读写一次都不多。传 `null` 表示「读不到」，
   * 投影层据此删掉该键（面板整段收起），**不是**写一份全零。
   */
  onMagicContextUsage?: (usage: SessionMagicContextUsage | null) => void;
}
