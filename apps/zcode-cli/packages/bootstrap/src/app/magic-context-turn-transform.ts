/**
 * Step 19b — bootstrap 侧的 magic-context 装配。
 *
 * ============================================================================
 * 这里是 bootstrap 侧 magic-context 的运行时装配入口，而且只在
 * `features.magicContext` 打开时才 import（`create-app` 经
 * `app/magic-context/adapter.ts` 动态 import 本文件）。`@zcode/magic-context`
 * 的**运行时**静态 import 面全仓共 6 处，全部落在这棵「门后」子图里：
 * `app/magic-context/{assembly,ports,prompt-surface,usage}.ts` 与
 * `app/magic-context-{historian,usage-summary}.ts`（另有
 * `app/magic-context/{projection,types}.ts` 与
 * `app/magic-context-prompt-section-zh-cn.ts` 只是 `import type`，编译后擦除）。
 * 配置面走窄子路径 `@zcode/magic-context/host/config/schema`（adapters 与
 * `zcode-protocol/magic-context-{config,memories}.ts`）；`zcode-protocol` 下的
 * 实现值一律 handler 内部动态 import。关掉 flag 时本文件与它拉起的整棵运行时
 * 装配图都不加载；长期守卫见 `scripts/test-magic-context-zero-load.mjs`。
 * 原因见 `core/src/runtime/helpers/magic-context-turn-transform.ts` 的文件头。
 * ============================================================================
 *
 * 本文件负责三件事：
 *
 *   1. **投影**：ZCode `RuntimeMessageEntry[]` → magic-context `MessageLike[]`，
 *      跑 transform，再把结果**反投影**回 `RuntimeMessageEntry[]`。反投影是 ZCode
 *      侧的知识（ZCode 用 `kind:"attachment"` 与独立的 `role:"tool"` entry，而
 *      magic-context/OpenCode 把 tool 结果挂在一条 user 消息的 part 上），所以它
 *      必须写在 ZCode 侧而不是包内。
 *
 *   2. **TransformDeps 装配**（映射表见 `TRANSFORM_DEPS_MAPPING`）。
 *
 *   3. **失败分级**：完全照 B 组既有语义（上游 `plugin/messages-transform.ts` 的
 *      三档）——fail-closed 重抛 / LKG replay / fail-open 放行。本层不自创分类。
 *
 * ── 拆分结构（mc-adapter-decoupling：纯搬迁，零行为变化）──────────────────────
 *   实现按职责拆到 ./magic-context/ 下，本文件保留为薄门面、只做再导出：
 *
 *   ./magic-context/types.ts      公共类型面（options / transform 形状）
 *   ./magic-context/usage.ts      预算摘要推送 + provider usage 记录器 + 窗口三源
 *   ./magic-context/projection.ts 反投影（MessageLike[] → RuntimeMessageEntry[]）
 *   ./magic-context/ports.ts      端口工厂（turn transform 端口、失败分级、settle / 历史快照助手）
 *   ./magic-context/prompt-surface.ts  prompt-surface 端口（section resolver / 工具描述 resolver）
 *   ./magic-context/assembly.ts   装配（开库 / config bridge / historian / deps / settle 生命周期）
 *
 * 导出名、签名与默认值一字未改，调用方（含单测对 dist 的具名 import）无需改动。
 *
 * ── TransformDeps 字段 → ZCode 能力（Step 19b 交接表）────────────────────────
 *
 *   db                              openDatabase(getMagicContextDatabasePath())
 *   tagger                          createTagger()
 *   scheduler                       createZCodeScheduler()：包内真身（S21）+ 键名映射
 *   contextUsageMap                 S24：宿主 usage recorder 的内存表（装配期 prime
 *                                   回上一轮落库读数）
 *   hostProcessLifetime             S24-fix：`"one-process-per-turn"`。ZCode CLI 一轮
 *                                   prompt 一个进程，所以包内 transform 的「首 pass
 *                                   usage 重置」必须走累积语义——不声明它，每一轮都
 *                                   会把上一轮的占用读数清成 0%（T-M2/T-M3/T-M6 的
 *                                   共同根因，见 MVP 报告 §3）。**保持硬编码不动**：
 *                                  改 per-session / 新增枚举的代价见下方 FORK 注释
 *                                   （bugfix-batch-20261011 / Step 2）
 *   settle 形态                      bugfix-batch-20261011 / Step 2：两处 settle
 *                                   （`settleInFlightHistorian` 与端口钩子
 *                                   `settleScheduledPass`）按 `processExitsAfterTurn`
 *                                   条件化——短驻（print / 未声明）前台有界等待，
 *                                   长驻（app-server / TUI）后台化，靠调度器自行
 *                                   publish + close 钩子 drain 收口。core turn-loop
 *                                   零改动
 *   clearReasoningAge               50（源 hook.ts 的 `?? 50`；clear_reasoning_age
 *                                   不在 E 组白名单）
 *   historyRefreshSessions /        装配层持有的 Set / Map（生产者 S20）
 *   pendingMaterializationSessions
 *   lastHeuristicsTurnId /
 *   commitSeenLastPass
 *   hiddenCompletionExecutor        S24：`createMagicContextHistorianHost` 造的 D-6
 *                                   sidecar executor；historian 模型三态 off（显式
 *                                   清空）或显式模型造不出来时**不装**，缺省/
 *                                   "inherit" 无条件装（见下「已知缺口」）
 *   historianRunnable               同上：有 executor 才 true
 *   historianModel /fallbackModels/ two_pass / maxTokens → 同一次装配从 E 组 schema
 *   historianTimeoutMs /                 读出并原样下发；historianModel 在 inherit
 *   getHistorianChunkTokens             模式下是**活值**（live 绑定，见 bindLiveModel）
 *   client                          不传 —— ZCode 无 PluginContext client
 *                                   （通知缝缺口 S20）
 *   hostRawMessages /               createRawMessageProvider：内存 borrow +
 *   hostMessageReconciliationSource session store 快照
 *   hostModelFallback               liveModelBySession —— ZCode 的「上次 assistant
 *                                   模型」等价物（`opencode-db-path` 不再使用）
 *   directory / projectPath         runtimeConfig.workingDirectory
 *   storeGeneration                 不传 —— ZCode 会话库既非 OpenCode v1 也非
 *                                   v2，跳过坐标 rebase
 *   cacheTtlConfig / protectedTokens / smartDrops / historyBudgetPercentage /
 *   executeThresholdPercentage / executeThresholdTokens
 *                                   config bridge 快照；**S23 起是真配置口**：
 *                                   bridge 订阅 `ConfigPort.observe(
 *                                   ConfigKey.MagicContext)`（全仓首个消费者），
 *                                   配置变更原地改写同一份 deps 对象，下一 pass 即生效
 *   liveModelBySession / getModelKey / getNotificationParams / getToolSetHash
 *                                   每 pass 用 turn-loop 传入的 model 刷新
 *
 * ── 已知缺口 ────────────────────────────────────────────────────────────────
 *   - historian executor：`createMagicContextTurnTransformOptions.createSidecarModel`
 *     缺席、`magicContext.historian.model` 显式清空（off）、或显式模型此刻造不出
 *     Model 时不装，`historianRunnable` 保持 false。缺省/`"inherit"` 则无条件装
 *     （impl-historian-inherit：折叠模型跟随会话模型，会话模型 turn 开始才绑得到）。
 *     「报错」与「装配炸掉」仍是两件事：装配期只可能是显式模型造不出来，那时记
 *     `historian_model_unavailable` 诊断后保持关闭。
 *   - 模型窗口几何（`models-dev-cache` / `window-geometry`）：包内模块级单例且没有
 *     注入缝，包外改不了（改包内是 S20 的特权）。S19b 让 transform 走自己的默认/检测
 *     回退，窗口偏小只会让阈值更保守，不会误发超大请求。
 *   - `contextUsageMap` 的生产者（S24）在宿主侧：后台 historian pass 因此能读到真实
 *     占用读数来解 protected-tail 边界（`readUsage`），不再需要 `usage:null` 的
 *     provisional-zero。真正没有读数时才回 `null`（不知道 ≠ 很空）。
 *   - 首 pass usage 重置的上游语义由 `hostProcessLifetime` 关掉（见上表）。
 *   - 配置面（D-12）已接线：写盘 `updateMagicContextInFileConfig`、内存
 *     `ConfigPort.set`、推送 `ConfigPort.observe` 三段齐备；桌面设置页的调用侧
 *     （Step 29）落地后才有用户可改的入口。
 *   - mc/BG-1（2026-10-10 调查，降级登记）：transform pass 是 turn-loop 插入点内的
 *     `await`（发 wire 前必须完成投影，设计使然），阈值命中时的大 pass（长会话全量
 *     投影）计入用户首 token 延迟。「turn 成功后后台预投影 + 下一 turn 走
 *     `lkg_replayed` 快路径」经调查**本期不落地**，四条不可行原因：①
 *     `registerLkgPersistence`（LKG durable hydration backend）生产零调用、且未出
 *     barrel 公共面——CLI「一进程一轮」下后台 pass 落的内存 slot 随进程退出消失、
 *     durable 行也无人 hydrate；② `lkg_replayed` 只是**失败分级**的 outcome
 *     （bootstrap `tryReplayLkg` 与包内 wrapper），成功 pass 没有「先试 replay」的
 *     入口；③ 在端口层 pre-replay 会让 LKG 固化（capture 只发生在 pass 内，replay
 *     后压缩永远不更新），必须新增「何时可 replay」判据，等价重写 scheduler 决策；
 *     ④ 补齐任何一块都要动 `magic-context/src/core/**` 上游逐字区主流程或扩 barrel
 *     面，违反「能不动包内就不动」的 FORK 纪律。降级收益替代：core 侧
 *     `magic_context.wire` 事件已补 `passDurationMs` 计时字段（见 core helper
 *     `runtime/helpers/magic-context-turn-transform.ts`），「pass 耗时是否计入首
 *     token 延迟」先有日志对照面；boot open 收敛（mc/OQ-1R，本文件
 *     `BOOT_OPEN_BUSY_TIMEOUT_MS`）已在同批次收口。后续若要重开：先接线
 *     hydration backend（扩 barrel：load），再评估成功路径快放的判据归属。
 */

export type {
  MagicContextTurnTransformOptions,
  ZCodeMagicContextTransform,
} from "./magic-context/types.js";

export {
  MAGIC_CONTEXT_CONSERVATIVE_CONTEXT_WINDOW,
  MAGIC_CONTEXT_DEFAULT_CONTEXT_WINDOW_ENV,
  createMagicContextUsageRecorder,
  pushMagicContextUsageSummary,
  type MagicContextRecorderModel,
  type MagicContextUsageMapEntry,
  type MagicContextUsageRecorder,
} from "./magic-context/usage.js";

export {
  createMagicContextTurnTransform,
  describeStorageUnavailability,
  openMagicContextStorageWithBusyRetry,
} from "./magic-context/assembly.js";

export {
  createMagicContextPromptSectionResolver,
  createMagicContextToolDescriptionResolver,
} from "./magic-context/prompt-surface.js";

export { createZCodeMagicContextTurnTransformPort } from "./magic-context/ports.js";
