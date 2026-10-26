import { zcodeProtocolMethods } from "@zcode/shared";
import type { ZCodeProtocolMethod } from "@zcode/shared";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import type { V4Method } from "@zcode/shared/zcode-protocol-v4";

/**
 * 命令的**并发类**（fix-c20）：`ZCodeProtocolNdjsonConnection` 的调度器按它决定
 * 「这条命令能否与别的命令同时在飞行中」。
 *
 * - `readonly`：只读、无状态、超时重发安全。两条只读之间**没有任何次序语义**，
 *   因此并发执行不会改变任何可观察结论。全局串行只会把它们排成一列互相白等
 *   （after3 实测：一次打开里 `workflowRuns` 的首次 handler 占住队列 1s，
 *   把真正决定首屏的 `subscribe` 挡在后面 918ms）。
 * - `mutating`：任何**写**服务端状态、或者**依赖到达次序**的命令。独占执行。
 *
 * 三条纪律：
 *
 * 1. **显式登记，不许推断**。分类只来自下面这张表，不用前缀、不用「名字里带 read/list」。
 *    表是 `Record<V4Method | ZCodeProtocolMethod, …>`：协议方法表里少登记一条就是
 *    **编译错误**，`test:command-concurrency` 的 K5 再在运行期按 `server.ts` 的
 *    `dispatchRequest` 逐 case 复核一遍（漏登记 / 写裸字符串用例两路都红）。
 * 2. **拿不准一律归 `mutating`**。漏一条只读最多是慢；漏一条变更就是次序错乱。
 *    因此 `commandConcurrencyOf` 对**未知**方法名返回 `mutating`（fail-safe），
 *    下面也刻意把「其实是读、但不在这条决定性路径上」的一大票命令归了 `mutating`
 *    （插件市场、工作流文件、模型连通性测试、legacy `session/*` 写入面）。
 * 3. **旁路优先于分类**。`session/stop` 与 `workspace/cancelGenerateText` 在 transport 里
 *    先命中旁路名单、根本不过锁（否则「停止」要等正在飞的变更跑完才发得出去）；
 *    它们的分类只是登记事实，不是调度依据。
 *
 * 为什么不把 `subscribe` 归 `mutating`：那会让它继续排在更早到达的只读后面
 * （after3 的 918ms 正是这么来的），等于什么都没改。它的共享副作用是
 * **按 key 的注册 + 按会话单飞的水化**：publisher 订阅键 `(connectionId, topic,
 * subscriptionId)`，视图/运行时水位分别是 `viewReadyFlights` / `runtimeReadyFlights`
 * 的 per-session 单飞。这两样本来就要求「同一会话被 host 与手机 web 同时订阅」时正确，
 * 与任何别的只读命令都没有次序依赖。
 */
export type CommandConcurrency = "readonly" | "mutating";

/**
 * 协议全表的并发类。键是 **wire 方法名**（`server.ts` 的 switch 用的就是这两个常量表）。
 *
 * 归 `readonly` 的判据（三条全中）：
 *  ① handler 不写服务端自有可变状态（不改进程内 registry、不写盘、不动会话 map、
 *    不注册/注销订阅、不申请/提交附件事务）；
 *  ② 幂等：同一条命令重复发（含超时重发）得到同一结论，不做「再次调用即推进」的动作；
 *  ③ 不依赖与其它命令的先后：它的结论不会因为「另一条命令先跑了」而不同。
 *
 * 具体逐条的「为什么没有变更副作用」记在各自的行上。
 */
export const COMMAND_CONCURRENCY = {
  // ─── v4 会话通道：读面（V4_METHODS 的注释逐条写着「只读、无状态、超时重发安全」）──
  //
  // subscribe / resync 是**视图入口**，形状上是注册。见文件头第 3 段：注册按 key、
  // 水化按会话单飞，两条只读并发订阅与「host + 手机 web 同时订阅」同一形态。
  [V4_METHODS.conversationSubscribe]: "readonly",
  [V4_METHODS.conversationResync]: "readonly",
  // 行分页 / turn 目录 / 计划目录 / 用量 / 文件摘要 / 回滚预览：纯派生查询，
  // 结论只取决于 (manifest, 投影, 参数) 三元组，不写任何状态。
  [V4_METHODS.conversationRowsRange]: "readonly",
  [V4_METHODS.conversationTurnDirectory]: "readonly",
  [V4_METHODS.conversationRuntimeReady]: "readonly",
  [V4_METHODS.conversationPlans]: "readonly",
  [V4_METHODS.conversationFileChanges]: "readonly",
  [V4_METHODS.conversationFileRewindPreview]: "readonly",
  [V4_METHODS.conversationUsage]: "readonly",
  [V4_METHODS.usageStats]: "readonly",
  // 后台 bash 输出只是读已有任务的输出游标，不启动/停止任务。
  [V4_METHODS.backgroundBashOutput]: "readonly",
  // dwf 的五个读面：journal 只读分页与产物读，写路径是引擎不在这些 handler 里。
  [V4_METHODS.conversationWorkflowRunEvents]: "readonly",
  [V4_METHODS.conversationWorkflowRuns]: "readonly",
  [V4_METHODS.conversationWorkflowRunArtifacts]: "readonly",
  [V4_METHODS.conversationWorkflowRunArtifactData]: "readonly",
  [V4_METHODS.conversationWorkflowRunArtifactRead]: "readonly",
  [V4_METHODS.conversationWorkflowRunWorkspace]: "readonly",
  [V4_METHODS.conversationWorkflowRunNodeResult]: "readonly",
  // 附件读面：按 row/index 授权的分块读，不落盘、不改编排状态。
  [V4_METHODS.attachmentRead]: "readonly",
  [V4_METHODS.conversationAttachmentRead]: "readonly",
  [V4_METHODS.conversationAttachmentStat]: "readonly",
  [V4_METHODS.attachmentPreviewSource]: "readonly",
  // 命令结果查询：只等**已在飞**的水位并读 inbox 幂等表，不创建水位、不入队输入。
  [V4_METHODS.commandsQuery]: "readonly",
  // ─── v4 变更面 ───
  [V4_METHODS.connectionFlow]: "mutating", // 写连接流控状态（saturated/drained/closed）
  [V4_METHODS.conversationUnsubscribe]: "mutating", // 注销订阅（幂等性不是重点，次序是）
  [V4_METHODS.attachmentBegin]: "mutating", // 开附件事务（会激活 runtime）
  [V4_METHODS.attachmentChunk]: "mutating", // 附件事务分块写入
  [V4_METHODS.attachmentCommit]: "mutating", // 附件事务提交
  [V4_METHODS.attachmentAbort]: "mutating", // 附件事务撤销
  [V4_METHODS.command]: "mutating", // 用户输入命令面（send / stop / rewind / fork …）
  // 控制面**反向**方法（CLI→host），本 server 从不接收；登记为 mutating 是保守侧。
  [V4_METHODS.controllerSubscribe]: "mutating",
  [V4_METHODS.controllerResync]: "mutating",
  [V4_METHODS.controllerUnsubscribe]: "mutating",

  // ─── legacy session/* 读面（只读持久化 + 已驻留 record）──
  //
  // `session/read` 与 `session/subscribe` **刻意不在**只读里：两者都写
  // `record.deliveryKind` / `record.legacyStreamSubscribed`（server-operations.ts
  // `readSession` / `subscribeSession` 的首几行），是客户端可决定的服务端状态。
  [zcodeProtocolMethods.sessionList]: "readonly",
  [zcodeProtocolMethods.sessionSubagents]: "readonly",
  [zcodeProtocolMethods.sessionMessages]: "readonly",
  [zcodeProtocolMethods.sessionEvents]: "readonly",
  [zcodeProtocolMethods.sessionDebug]: "readonly", // 只读进程内观测快照，无副作用
  [zcodeProtocolMethods.sessionUsage]: "readonly",
  [zcodeProtocolMethods.usageStats]: "readonly",
  // ─── legacy session/* 变更面 ───
  [zcodeProtocolMethods.sessionCreate]: "mutating",
  [zcodeProtocolMethods.sessionResume]: "mutating",
  [zcodeProtocolMethods.sessionRead]: "mutating", // 写 record.deliveryKind
  [zcodeProtocolMethods.sessionSubscribe]: "mutating", // 写 deliveryKind + legacyStreamSubscribed
  [zcodeProtocolMethods.sessionSend]: "mutating",
  [zcodeProtocolMethods.sessionStop]: "mutating", // 旁路执行；登记只为完整性
  [zcodeProtocolMethods.sessionCancelBackgroundTask]: "mutating",
  [zcodeProtocolMethods.sessionFork]: "mutating",
  [zcodeProtocolMethods.sessionGoal]: "mutating",
  [zcodeProtocolMethods.sessionSetModel]: "mutating",
  [zcodeProtocolMethods.sessionSetThoughtLevel]: "mutating",
  [zcodeProtocolMethods.sessionSetMode]: "mutating",
  [zcodeProtocolMethods.sessionClose]: "mutating",
  [zcodeProtocolMethods.sessionRequestRuntimePreferences]: "mutating", // 反向方法，本 server 不接收

  // ─── workspace/*：四个 read 归只读，其余一律变更（写盘 / 改 registry / 跑模型）──
  [zcodeProtocolMethods.workspaceReadPresentation]: "readonly", // 读 slash 命令目录，无写
  [zcodeProtocolMethods.workspaceReadPromptLanguage]: "readonly",
  [zcodeProtocolMethods.workspaceReadMagicContextConfig]: "readonly",
  [zcodeProtocolMethods.workspaceListMagicContextMemories]: "readonly",
  [zcodeProtocolMethods.workspaceHookTrustGrant]: "mutating", // 写信任事实 + 扇出通知
  [zcodeProtocolMethods.workspaceUpdateInteractionPreferences]: "mutating",
  [zcodeProtocolMethods.workspaceUpdateMagicContextConfig]: "mutating", // 写盘 + 内存双写
  [zcodeProtocolMethods.workspaceArchiveMagicContextMemories]: "mutating", // 软删
  [zcodeProtocolMethods.workspaceUpdatePromptLanguage]: "mutating",
  [zcodeProtocolMethods.workspaceUpdateModelIoPreferences]: "mutating",
  [zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy]: "mutating",
  [zcodeProtocolMethods.workspaceGenerateText]: "mutating",
  [zcodeProtocolMethods.workspaceCancelGenerateText]: "mutating", // 旁路执行

  // ─── 其余：一律变更（保守侧）。理由统一：不在冷开路径上，且未逐行证明无写。──
  [zcodeProtocolMethods.runtimeCapabilities]: "mutating",
  [zcodeProtocolMethods.computerUseOperationEvent]: "mutating",
  [zcodeProtocolMethods.providerTestModelConnectivity]: "mutating",
  [zcodeProtocolMethods.mcpList]: "mutating",
  [zcodeProtocolMethods.mcpRefreshSessions]: "mutating",
  [zcodeProtocolMethods.pluginsList]: "mutating",
  [zcodeProtocolMethods.pluginsReferenceCatalog]: "mutating",
  [zcodeProtocolMethods.pluginsReferenceCatalogWithCategory]: "mutating",
  [zcodeProtocolMethods.pluginsResolveSuggestedReference]: "mutating",
  [zcodeProtocolMethods.skillsReferenceCatalog]: "mutating",
  [zcodeProtocolMethods.pluginsSetEnabled]: "mutating",
  [zcodeProtocolMethods.pluginsOverview]: "mutating",
  [zcodeProtocolMethods.pluginsMarketplaceAdd]: "mutating",
  [zcodeProtocolMethods.pluginsMarketplaceRemove]: "mutating",
  [zcodeProtocolMethods.pluginsMarketplaceUpdate]: "mutating",
  [zcodeProtocolMethods.pluginsInstall]: "mutating",
  [zcodeProtocolMethods.pluginsCancelOperation]: "mutating",
  [zcodeProtocolMethods.pluginsUninstall]: "mutating",
  [zcodeProtocolMethods.pluginsUpdate]: "mutating",
  [zcodeProtocolMethods.pluginsRestoreBuiltin]: "mutating",
  [zcodeProtocolMethods.pluginsConfigure]: "mutating",
  [zcodeProtocolMethods.pluginsResetConfig]: "mutating",
  [zcodeProtocolMethods.pluginsValidate]: "mutating",
  [zcodeProtocolMethods.pluginsDescribe]: "mutating",
  [zcodeProtocolMethods.workflowsList]: "mutating",
  [zcodeProtocolMethods.workflowsGet]: "mutating",
  [zcodeProtocolMethods.workflowsUpdateMeta]: "mutating",
  [zcodeProtocolMethods.workflowsDelete]: "mutating",
  [zcodeProtocolMethods.workflowsRuns]: "mutating",
  [zcodeProtocolMethods.workflowsMove]: "mutating",
  [zcodeProtocolMethods.automationCreate]: "mutating",
  [zcodeProtocolMethods.automationUpdate]: "mutating",
  [zcodeProtocolMethods.automationCheckTaskBinding]: "mutating",
  [zcodeProtocolMethods.automationList]: "mutating",
  [zcodeProtocolMethods.automationDelete]: "mutating",
  [zcodeProtocolMethods.processChildProcesses]: "mutating",
  [zcodeProtocolMethods.interactionRequestPermission]: "mutating",
  [zcodeProtocolMethods.interactionRequestUserInput]: "mutating",
  [zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders]: "mutating",
  [zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders]: "mutating",
  [zcodeProtocolMethods.interactionBrowserList]: "mutating",
  [zcodeProtocolMethods.interactionBrowserExecute]: "mutating",
} as const satisfies Record<V4Method | ZCodeProtocolMethod, CommandConcurrency>;

/**
 * 一条 wire 方法名的并发类。
 *
 * **未知方法名返回 `mutating`**：协议方法表之外的字符串只有两种来源——通知（本 server
 * 不解释，保持原有串行）与将来新增却没登记的命令。两种都按「可能写、可能依赖次序」办，
 * 这就是「拿不准一律归变更」的落点。已知方法漏登记在这里不可能发生：表是穷尽类型
 * （漏一条编译即红），运行期还有 K5 按 `dispatchRequest` 复核。
 */
export function commandConcurrencyOf(method: string): CommandConcurrency {
  return (
    (COMMAND_CONCURRENCY as Record<string, CommandConcurrency | undefined>)[method] ?? "mutating"
  );
}

/** 只读命令的 wire 名清单（诊断 / 测试用；顺序为表定义顺序）。 */
export function readonlyCommandNames(): string[] {
  return Object.entries(COMMAND_CONCURRENCY)
    .filter(([, concurrency]) => concurrency === "readonly")
    .map(([method]) => method);
}
