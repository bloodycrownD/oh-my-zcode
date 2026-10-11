---
date: 2026-10-11 18:06
title: 上游 ZCode v3.15.1 bug 修复选择性 backport（单批次完整 spec）
keywords: upstream-sync, v3.15.1, backport, bugfix, crash, memory, dwf, windows, security
abstract: 将上游 v3.14.3→v3.15.1 增量中的 bug 修复（非新功能）选择性重放进 fork。经 6 域甄别 + 4 路只读探索（fork 侧三方核对/双改文件冲突形态/依赖链/适用性裁决）+ 两分法终裁（只分「应该做/没必要做」，无中间态无二期），裁定 30 项移植、21 项不移植。禁止整文件 takeover，全部按 diff 手工重放（fork 为快照式根提交 c34a9386，与上游无共同历史，cherry-pick 不可用）。四红线（遥测移除/magic-context 集成/原生压缩移除/品牌改名）全程不得回退。
---

# 上游 v3.15.1 bug 修复选择性 backport

## 1. 背景与目标

- 上游 zai-org/ZCode 发布 v3.15.1（git 对象 `aac4755666d09fdcd70272fcf063c077a639015f`，本地引用 `upstream/main`）。**注意陷阱：本地 tag `v3.15.1` 指向 fork 自有提交 `9ab8a64`，不是上游对象，一律用完整 hash 引用。**
- fork 基线：`baseline/v3.14.3` = 根提交 `c34a9386`（上游 29628c9 快照）。**fork 与上游无共同历史**（`git merge-base 29628c9 HEAD` 为空），同步只能按 `git diff 29628c9..aac4755 -- <file>` 手工重放。
- 上游 v3.15.1 增量构成：~70% 新功能（手机远控、插件 UI 沙箱、群聊 Bot、DWF 留白、加速卡）+ ~10-15% 真 bug 修复。本 spec 只移植 bug 修复，用户明确不关注新功能。
- 四条红线全程不得回退：①遥测移除 ②magic-context 集成 ③原生压缩移除 ④品牌改名（omz）。命名边界维持：`@zcode/*` 包名、`ZCODE_*` 环境变量、`zcode://` scheme 三族不改名。

## 2. 裁定总表

### 2.1 移植项（30 项，按域分组；编号沿用初版，跳号 #17/#19/#22/#33 为两分法裁撤项）

**P1 网络与进程崩溃（6 文件 + 1 新增）**

| # | 文件 | 上游修复 | 移植方式 |
|---|---|---|---|
| 1 | `apps/zcode-cli/packages/adapters/src/network/incoming-response.ts` | 新文件：`readIncomingResponse`/`toWebResponse`/`UnsupportedHttpStatusError` | 逐字复制 |
| 2 | `apps/zcode-cli/packages/adapters/src/network/proxy-fetch.ts` | 非 2xx–599 状态码构造 Response 抛未捕获异常打死 CLI 进程 → try/catch 转 reject + destroy 连接 | 逐字（含 `export type NetworkFetch`） |
| 3 | `apps/zcode-cli/packages/adapters/src/http/index.ts` | 回调内构造 Response 异常崩进程 → reject；类型改 `ResponseLike` | 逐字 |
| 4 | `apps/zcode-cli/packages/adapters/src/http/response-body.ts` | 204/304 无正文不走 arrayBuffer+超限误判，直接返回空 Uint8Array；新增 `ResponseLike` 导出 | 逐字 |
| 5 | `packages/services/src/zcode-agent/zcodeProtocolClient.ts` | dispose 批量拒绝 unhandledRejection + TDZ；request 拆 requestImpl 挂 no-op catch | 逐字 |
| 6 | `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` | cleanupPromise 的 catch 改为创建点无条件挂靠 | **手工融合**：只取该 hunk（fork HEAD 723-735 行区域与上游修复前逐字相同）；禁止恢复 `applyPresentationSurfaceToCommand`/`localRuntimeNetworkCapture`/`GEN_UI_OUTPUT_*`/export 化四处 hunk；保留 fork 的 presentationSurface 删除态与 `~/.omz` 注释 |
| 7 | `packages/services/src/zcode-agent/zcodeStdioTransport.ts` | stdout 分帧 O(n²) 全缓冲拼接（15MB 帧导致 9.4GB 拍平分配）→ 分片数组线性成帧 | 逐字 |

**P2 数据丢失与内存（6 文件）**

| # | 文件 | 上游修复 | 移植方式 |
|---|---|---|---|
| 8 | `apps/zcode-cli/packages/core/src/runtime/helpers/tool-result-media-persistence.ts` | 落盘脱离 Stop 信号（用户停止回合不再丢冷恢复内容） | 逐字 + **配套**：`turn-tools.ts:294` 同步删 `signal: state.turnAbortSignal` 实参（excess property 会编译错） |
| 9 | `apps/zcode-cli/packages/core/src/runtime/methods/events.ts` | ensureSessionPersisted WeakMap 去重（并发首入重复建会话互覆盖） | 逐字，**放弃** `dynamic-workflow-activation` import 行（fork 无该 182 行新模块，写了编译不过）；保持 `sessionPersisted = true` 置位时序 |
| 10 | `apps/zcode-cli/packages/contracts/src/events/session-event-retention.ts` | `slimRetainedModelRequest`：model_request 淘汰时瘦身（长会话 ~150MB 线性驻留） | 逐字 + 配套调用点 `in-memory-session-event-store.ts:104`（fork 干净） |
| 11 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts` | `mapModelRequestPayload` 支持瘦身形态两种映射同值（base 467-480 区域 fork 未动） | 叠加（A 类，与 fork 的 mapSnapshotMessages 重写区不重叠）；**不搬** `approvalMode` 透传；**与 #10 为 producer/consumer 对，必须同批落地**（分批会出现瘦身事件被旧 mapper 投影成 `messageCount: undefined` 的语义缺口） |
| 12 | `apps/zcode-cli/packages/core/src/subagent/context-builder.ts` | prompt 缓存断点合并（Anthropic prompt cache 命中率） | 叠加（fork 改动在 config 接口 `magicContextSection` HEAD:33 与 `buildSubagentContextSections` 内 `magicContextEntry` HEAD:152，上游 fix 落 `build()` systemMessages 组装区 base 48-61=fork HEAD 55-68 **fork 未动**，hunk 级零重叠可直接叠）；**magic-context 红线区**，移植后须跑 subagent prompt 回归 |
| 13 | `apps/zcode-cli/packages/adapters/src/model/transform.ts` | tool-result cacheControl 从 message 级移到结果块级（3 行） | 逐字 |

**P3 DWF 大 run 读放大（3 文件 + port 扩展）**

| # | 文件 | 上游修复 | 移植方式 |
|---|---|---|---|
| 14 | `apps/zcode-cli/packages/dynamic-workflow/src/engine/scheduler.ts` | recordedAsks 一次建 Map + seedRecordedAsks，registerActor 不再 O(actor×行) 全表扫 | 逐字核心（上游 diff 中 `cachedAskFacts` 新模块/hash-mismatch 搬迁/drainAdmission 内联/actorPersonaModel 不搬；**import 区保留 fork 原 `./scheduler-types.js` 导入行，不套上游 hunk 1 的模块迁移**）+ **配套**：fork `engine.ts:352` `listNodes` 后 filter+seed 一行 |
| 15 | `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-observation.ts` | count(*) + 前 256 条 / 8MiB 界 | **中深链**：contracts 补 2 常量（`DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS=256`/`DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES=8MiB`，上游实名以此为准）→ `JournalStorePort` 的 `listNodes` 加可选 opts 参数（fork 采用类型=`ListNodesOptions{kinds, withResult, limit?, maxResultBytes?}` 对齐上游 `journal-read-types.ts`）+ 可选 `countNodes?(runId, kind)` → `journal-memory.ts` 与 adapters `dwf-journal.ts`(363/413) 两实现 → observation.ts；**偏离声明**：上游把 opts/countNodes 改必填，fork 保持可选以不破坏既有测试替身，`countNodes` 缺席时 fallback=省略 `reportCount` 字段（observation 输出可选化）；**不搬** holes/modelBindings/`concurrencyCeiling→defaultConcurrency` 改名 |
| 16 | `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-replay.ts` | 冷回放 reportItems 限 64 | **中深链**：`ListEventsOptions` 加可选 `types` 与 `reportItems: "all" \| { limit: number }`（对齐上游形状，存储层 json_remove 剥离/过滤，禁止全量再切片）→ memory/sqlite 两实现 → replay.ts；`WORKFLOW_RUNS_LIMITS.maxReports=64` fork 已有；`COLD_REPLAY_EVENT_READ` 常量随 `types` 字段一并引入 |

**P4 协议与服务（9 文件）**

| # | 文件 | 上游修复 | 移植方式 |
|---|---|---|---|
| 18 | `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` | ①流式 turn 完成兜底补后缀（streamedTurnKeys→streamedTurnText Map，兜底 chunk 去掉已流式前缀）②legacy ACP 只读恢复（readLegacyTaskSnapshot + 订阅守卫） | **手工融合**（与 fork 的 compact 删除交织于 mapSessionEvent 区域）。前置符号 fork 齐备（`getLegacyTaskSessionSnapshotPath`/`safeParseLegacyTaskSessionFile`/`applyOverlayToMeta` 等均存在）；**不搬** bot group/topicAdmission/codex/switchAgent 新 API |
| 20 | `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts` | readSession 传 `contentProfile: "index"`（每轮全量 15MB 快照 → 裁剪） | **6 处联动小改**：新增 `packages/shared/src/zcode-session-content-profile.ts`（逐字）+ shared/index.ts 导出 1 行 + `zcodeSessionReadParamsSchema` 加可选 `contentProfile`（`.strict()` schema 增量）+ `zcodeAgent.ts` 参数类型 + `zcodeAgentService.ts` 白名单转发 + server-operations.ts agent 侧 `elideSessionSnapshotForIndex` 分支；**不搬** `mode: "build"→"default"`（依赖 v3.15 ZCodeTaskMode 扩张） |
| 21 | `packages/services/src/subagents/subagentsService.ts` | catch 区分 ENOENT/JSON 才回退空配置，其它 IO 错误重抛 | 融合（fork 仅 1 行品牌改名）；**fork 同款问题扩展修**：`readPluginConfig`(397-418) 的 catch-all 伪装空配置同修 |
| 23 | `packages/shared/src/tool-plan-adapter.ts` | 读 `_meta.claudeCode.parentToolUseId`（Claude Code 父子工具投影） | 逐字（17 行，零依赖） |
| 24 | `packages/shared/src/zcode-protocol-v4/workflow-runs-eviction.ts` | B2 拒新规则扩展到 `seat.born`（resume 宽 fan-out 卡死） | 逐字（~10 行重排；`seat.born` fork 已有 :151） |
| 25 | `packages/shared/src/zcode-protocol-v4/transport.ts` | 附件预览放行 `text/plain` + workflow run 分页 maxBytes 常量化 | 叠加（A 类，修复区域与 fork 的 ttft 删除/turnDirectory 新增零重叠） |
| 26 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts` | subscriber buffer 钳位到 `logicalFrameAssemblyMaxBytes - 64KiB` 帧界 | **手工融合**：上游第一个调用点 hunk 落在 fork 新提取的 `fanOutDeltas` 方法体内（710-717）——机械融合；**两处调用点统一改 `this.subscriberBufferLimits()`（上游新增私有方法，输入 fork 已有 `wireSnapshotBytesUpperBound` :255）**——第二调用点在 fork `resyncRollback` 内（**:1160-1163**，只融第一处则 resubscribe 合并路径不钳位）；**配套 hunk（r5 补）**：`ConversationSubscriberBufferLimits`（:164-167）补 `snapshotBytesUpperBound?` 字段、`appendConversationSubscriberBuffer`（:217-237）按上游引入 `conversationSubscriberBufferByteLimit` 并把 `encodedBytes > maxBytes` 判定改为 byteLimit 裁决；pluginUi 过滤 hunk 不搬；**magic-context 红线**：不得破坏 `publishMagicContextUsage` 推送路径（共用同一 delta 扇出） |
| 27 | `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts` | `editPendingInputById` 同步 `intent.text` canonical（排队输入编辑后发送仍是旧消息——fork 自身 20261009 修过同族 bug①，本修复补齐 intent 元数据侧） | 叠加（fix 主体 base 873 行区域，fork 删除在 450/466 行不重叠）；`conversationQuotes` 部分不搬 |
| 28 | `apps/zcode-cli/packages/core/src/memory/memory-file-path.ts` | 敏感路径段补 `.claude` | 叠加（fork 已加 `.omz`，同一 Set 相邻行）；上游的 `export` 化可取可舍 |

**P5 Windows 平台与安全（4 文件）**

| # | 文件 | 上游修复 | 移植方式 |
|---|---|---|---|
| 29 | `packages/services/src/runtime-tools/runtimeCommandEnv.ts` | Windows 下 git-bash/WSL 注入的 `SHELL=/usr/bin/bash` 使所有 stdio MCP 启动失败 | **fork 自研落点**（上游 `buildCleanEnv` 在 fork 无生产调用方、仅上游测试引用，不搬该死代码）：在 fork 已有 `normalizeRuntimeProcessEnv`(128-153) 里增补「`SHELL` 为无效 POSIX 路径时回退 `ComSpec`/cmd.exe」；PATH 归一 fork 已有，勿重复 |
| 30 | `packages/desktop/src/main/desktopDeepLinkRouter.ts` | win32 深链注册 argv 追加 `--`，防 URL 内容注入为 Electron 启动参数 | **落点换文件**（上游修的 desktopOAuthDeepLink.ts 已被 fork 删除，fork 的 228-247 行是同款漏洞代码）；保留 `"zcode"` scheme 字面量（命名边界） |
| 31 | `packages/desktop/electron-builder.config.js` | `electronFuses: { enableNodeCliInspectArguments: false }`（win32，关 --inspect-brk 注入面） | 逐字（fork 全仓无任何 fuses；插入点 468 行 `electronVersion` 之后；fork 该文件遥测删除区在 base 101-137（@opentelemetry/* import 块），与插入点不冲突，仅插入不覆盖） |
| 32 | `packages/desktop/src/main/desktopWindowLifecycle.ts` | 托盘创建失败仍隐藏窗口=应用失联 → closeToTray 裁决合并确认退出 | **裁剪**：只搬「托盘成功才可隐藏」裁决；**保留 fork 的 `closeToTrayOnWindows` 命名与 Windows-only 语义**（上游改名 `closeToTray`+Linux 能力不搬）；不搬 `webRemoteControlManager`（fork 无） |

**P6 magic-context 咬合修复（fork 自研，1 文件，上游思路转化；r2 审查后重定向落点）**

| # | 文件 | 问题 | 修复 |
|---|---|---|---|
| 34 | `apps/zcode-cli/packages/adapters/src/model/anthropic-stream-compat.ts` | 上游修的「合并连续 user message 破坏 memory selector 双消息基线」在 fork 的同形状真实威胁：**两层合并都会吃掉 m0/m1 的消息边界**（`inject-compartments.ts:3323-3339` unshift 的两条相邻 synthetic user，`hoistHeadsAfterSystemPrefix` 保证相邻）——①fork 自有 `reasoning-history-normalization.ts` 的 `mergeAdjacentUserMessages`（:210-230，仅当 `removeWhitespaceOnlyAssistants` 删除过空白 assistant 帧时条件触发，一旦触发作用于全部相邻 user 对）；②**主要威胁**：`@ai-sdk/anthropic@3.0.81` 的 `convertToAnthropicMessagesPrompt` 无条件把连续同角色 user 并为一条 wire 消息（fork patch 未触及）。m0/m1 被合并即破坏 memory 注入的双消息基线 | **wire 层「合并后拆分」**（对齐上游修复的层级与手法，r2 查证确认 fork 的挂载点存在且空置）：在 fork `anthropic-stream-compat.ts` 的 `applyAnthropicRequestBodyCompatibility`（:12-26 入口，经 `model-execution.ts:295` `createAnthropicCompatFetch` 挂载）新增 fork 版 `restoreMagicContextMessageBoundaries`——发请求前对 body 判定已合并的 m0/m1 边界并拆回独立消息。判据按 fork 投影形状设计（m0/m1 投影后均为 `<system-reminder>` 信封文本、m0 可带 image part、m1 恒纯文本；正文无固定前缀——判据用信封特征+结构标签，负例锁定真实用户输入含同类文本）；m1 后紧跟本轮 user 输入时（新会话首轮）合并体为三段，按信封边界逐段拆。**不搬**上游 `restoreMemorySelectorMessageBoundaries` 原判据（`selected_memories` 格式 fork 零触发，2.2 已裁定）；**可选纵深**：同时在 fork 自有 `mergeAdjacentUserMessages` 加信封豁免防条件触发合并（独立小改，非必须）。上游先例证明 Anthropic API 接受 wire 级连续 user 消息（拆分安全） |

### 2.2 不移植项（21 项，每项带理由；前 16 项为初版裁定，后 5 项为两分法终裁增补）

| 项 | 理由 |
|---|---|
| `bootstrap/src/zcode-protocol/transport.ts`（MCP UI 死锁+stdout 背压） | fork 无 MCP UI 协议面（上游 bootstrap 源内 `mcpUi*` 64 处：server.ts/transport.ts 各 16 等；fork 0 处、仅 `mcpList`），死锁场景不存在；背压丢弃依赖 `processNetworkRequests` 观测通知（遥测同域）。搬=引入两个 v3.15 特性整体 |
| `adapters/src/model/anthropic-stream-compat.ts` 原样移植 | 触发条件（`selected_memories`/`Available memories:` 前缀）fork 全树零命中，行为零变化；其价值已转化为 2.1-P6#34（fork 版边界恢复函数复用同一挂载点，但判据/目标消息按 fork m0/m1 机制自研） |
| `bootstrap/src/app/provider-registry-model-runtime.ts`（highspeed 透传） | 上游改的正是 fork 已删除的账号型 access 条件块（D-4），无落点；**切勿带回该条件块** |
| `adapters/src/model/runner.ts`（requestAuth/重试预算） | 同上，账号型派生模式 fork 已删（−96 行），`modelRetryBudget` 亦为 v3.15 新字段 |
| `desktop/src/main/autoUpdater.ts` | fork 已整链删除自动更新（official-endpoints-removal D-1/S2，`electron-updater` 依赖不存在，全仓零引用），修复无意义 |
| `services/src/session/taskIndexRepo.ts`（acp_session_id 迁移） | fork DB schema 无 `acp_session_id` 列（全仓 grep 无），`hasColumn` guard 直接 return，纯成本 no-op |
| `bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`（footprint 双向比对） | 上游自身未接线（`eventsCoverTranscript` 仅测试消费）；且 `transcriptFootprint` 引用 fork 已删的 `compactPayloadFrom*`，需改写 compact 计数——收益不抵 |
| `shared/src/plugin-marketplaces.ts`（visualize 插件 id） | fork 全仓无 `visualize` 插件，补 id 无意义；Claude 官方市场为 v3.15 新功能 |
| `ui/src/chat-input-toolbar/display.tsx`（权限模式集合） | 上游 `HIGH_PERMISSION_MODE_VALUES`/guarded 蓝样式属 v3.15 权限模式体系（`bypassPermissions` 等），fork 无该体系；「mode 切换 3s 保护窗口」实际不在该文件 diff 内（探索澄清）。整文件搬回会因 `getContextCompressionCommand` re-export 编译失败 |
| `ui/src/lib/toolCallTree.ts`（reconcile 渲染风暴） | 上游导出无生产消费方（仅测试引用）；fork UI 消费面已重构，接线成本 > 收益。若未来 fork 自身出现渲染风暴再评估 |
| `ui/src/lib/chatStatus.ts`、`taskListRefreshPolicy.ts`、`mobileTextInput.ts` | 模块自包含可打，但 fork 消费端（ChatView/v4 composer/useWorkspaceTaskLists）已被 fork 重构，不接线=死代码。本轮不做，记为可选后续 |
| `ui/src/lib/chatAttachments.ts`（restore API+video 尺寸） | 修复藏于上游自身未接线的 `restoreChatComposerAttachment` 新 API；单独搬 video 估算无落点 |
| `ui/src/lib/zcodeSessionProjection.ts` | ~86 个 v3.15 新 shared 符号成片依赖，非 bug 修复范畴 |
| `bootstrap/src/app/session-store.ts`（highspeed 守卫） | 依赖 `isHighspeedProviderId`（fork 无 highspeed 概念），本地复刻 4 行谓词后守卫恒不命中，零收益 |
| 额度重置 UI 集群（7 文件） | Coding Plan 计费体系已整体删除（official-endpoints-removal D-4/D-5/S5，`hasCodingPlanUsageRemaining` 硬编码 false），死代码上的修复 |
| `zcodeTaskIndexSyncer` 的 `mode: "default"` | 依赖 v3.15 `ZCodeTaskMode` 联合扩张（+5 成员），牵动 sessionModeOptions/zcodeTaskServiceAdapter/config-schema 一大片，与崩溃修复无关 |
| **#17** `browser-control-broker.ts`（WeakMap 状态共享） | **两分法终裁**：分裂症状仅在 node_repl 浏览器入口与 app runtime 入口交替使用同一会话时显现（连接重建级别，不崩不丢数据）；浏览器控制低频使用，症状不可感知；裁剪移植需重构 `buildBrowserRequestContext` 签名，成本中等收益无感。遇实际症状再补 |
| **#19** `server-operations.ts`（远程会话禁 Cron） | **两分法终裁**：修复只作用于 SSH/WSL/Docker 远程会话内建 Cron 的场景；无远程会话使用，本地 Cron 与此无关，不可感知 |
| **#22** `bots.ts`（legacy provider 归一） | **两分法终裁**：bot 功能默认关、需显式配 token 启用且未使用；旧配置 parse 失败场景不可达。日后启用 bots 随时可补 10 行 |
| **#33** `model-execution.ts`（静态头剥离） | **两分法终裁**：修复挂在动态鉴权前剥离静态 auth 头的路径；fork 已删官方端点/账号体系，静态 API key 模式下动态鉴权路径基本不存在，修复不触发 |
| `permission-flow.ts` requestId 复用竞态（原 2.3 待拍板项） | **两分法终裁**：竞态触发前提=hook 改写输入+窗口期应答，fork 无 hook 改写配置，路径不可达；且时序测试构造成本大于修复本身。若日后引入 hook 改写用法再评估 |

## 3. 分步实现计划

统一纪律：每 Step 独立 commit 且带 pathspec；Windows 用便携 Node 24（`.tools/node-v24.14.0-win-x64`）；写文件 UTF-8+LF；magic-context `src/core/**` 逐字区如被触碰必须加 `FORK (xxx)` 注释块。

- **Step 1 — phase-reference — blocking: yes — qa: auto**
  更新 `.reference/ZCode` 快照到 v3.15.1（该快照当前在 29628c9，**不含 aac4755 对象**；fetch 后 checkout aac4755666d09fdcd70272fcf063c077a639015f）。同时恢复 `UPSTREAM-SYNC.md`（当前为未提交删除；`git checkout -- UPSTREAM-SYNC.md`），其 SOP 六节是本批次的操作依据。本步不产生产品代码变更。
- **Step 2 — phase-net-crash — blocking: yes — qa: auto**（P1 #1-#7）
  adapters 3 文件 + 新增 incoming-response.ts + services 3 文件。zcodeAgentProcessManager 按 2.1#6 手工摘 hunk。
- **Step 3 — phase-mem-loss — blocking: yes — qa: auto**（P2 #8-#13）
  含 turn-tools.ts 与 in-memory-session-event-store.ts 两个配套点；events.ts 放弃 activation 行；**#10 与 #11 是 producer/consumer 对，本 Step 同批落地**。
- **Step 4 — phase-proto-lite — blocking: yes — qa: auto**（P4 轻项 6 项：steering #27 / memory-file-path #28 / tool-plan-adapter #23 / eviction #24 / transport #25 / subagentsService #21）
- **Step 5 — phase-dwf — blocking: yes — qa: auto**（P3 #14-#16）
  port 可选字段化（`countNodes?`/`listNodes` options/`reportItems` options）不破坏既有测试替身；存储层过滤禁止全量切片。
- **Step 6 — phase-svc-heavy — blocking: yes — qa: manual_user**（P4 重项：zcodeTaskServiceAdapter #18 / contentProfile 六联动 #20 / topic-publisher 钳位 #26）
  topic-publisher 融合触碰 magic-context 推送路径，红线②前置回归=新增 `test-publisher-buffer-clamp.mjs`（含 publishMagicContextUsage 路径）+ 既有 `test:magic-context` + `test:turn-directory` 三者先行。
- **Step 7 — phase-win-sec — blocking: yes — qa: manual_user**（P5 #29-#32）
  SHELL 修复、深链 `--`、fuses、托盘裁决。
- **Step 8 — phase-magic-context — blocking: yes — qa: manual_user**（P6 #34）
  `restoreMagicContextMessageBoundaries`（wire 层合并后拆分，落点 anthropic-stream-compat.ts）+ 验证：fetch compat 层断言或 `ZCODE_MAGIC_CONTEXT_DEBUG_WIRE=1` wire dump，确认 m0/m1 到达 Anthropic API 时保持独立 user 消息（含 m0 带 image、m1 后紧跟本轮输入的三段合并两个形态）。
- **Step 9 — phase-tests — blocking: yes — qa: auto**
  新增 T 用例（见 §4）落地；接线规则（r4 补，r5 微调）：各 T 用例落点=其目标包既有测试形态——core/bootstrap 为 `scripts/test-*.mjs` 自研形态，**services 为 `test/*.test.ts` 形态（无 scripts/ 目录，T-PROC-3/T-SVC-3 按此先例）**；`packages/shared`/`packages/services` 新测试**必须显式接线**进根 `test:v4-perf`（shared 测试无 package.json 自动接线）；adapters/dynamic-workflow/contracts 等无聚合入口的包，新建脚本一律在根 `package.json` `test:v4-perf` 手工枚举清单（:32）追加条目。**Step 9 交付登记表**：`cache/test-wiring-map.md`——逐 T 用例登记「脚本路径 / 所在包 / 是否接线 test:v4-perf（或注明不接线由 Step 10 手工实跑并记录）」，Step 10 门禁 9 按登记表核对。
- **Step 10 — phase-gates — blocking: yes — qa: auto**
  全门禁逐条实跑（§5 清单），oxfmt 归一若失守按 20261011 先例独立 commit 修。
- **Step 11 — phase-changelog — blocking: no — qa: manual_user**
  CHANGELOG Unreleased 段「修复」分类汇总本批（omz-changelog 四分类规则），版本 bump 走 omz-publish 流程另行发布。

## 4. 测试策略

基线：`test:v4-perf` 本批前 236 pass（198 为更早迭代口径，前序迭代 +38 已计入）；Step 9 接线后 309 pass（新增 73 例）；magic-context `test:all` 142 case。新增用例：

- **T-NET-1**：proxy-fetch 对 999/异常状态码返回请求失败，进程不崩（node --test 新脚本）。
- **T-NET-1b（#3，r4 修正）**：`createNodeHttpClientAdapter({ caCertFile })` 打本地 **https** server 返 999（caCertFile 仅对 https 生效、强制走 transport 回调分支——http 会走全局 fetch 捷径 `:167-176` 绕过修复点），断言 `request()` **resolve 且 status=999**（post-fix `readIncomingResponse` 原样带回非标准状态码、不 reject——reject 语义仅属 proxy-fetch 路径 T-NET-1 的 `toWebResponse`/`UnsupportedHttpStatusError`）、进程无 uncaughtException；修复前该路径回调 `new Response(...)` throw 直接打死进程。独立覆盖，不能由 T-NET-1/2 替代（post-fix 的 proxy-fetch 与 http/index.ts 无调用关系）。
- **T-NET-2**：204 响应 readResponseBody 返回空 Uint8Array，不误判超限。
- **T-PROC-1**：zcodeProtocolClient dispose 时 pending 全 reject 且进程无 unhandledRejection（process 监听断言）。
- **T-PROC-2**：zcodeStdioTransport 喂 15MB 单行帧，峰值内存有界（process.memoryUsage 断言上界）。
- **T-PROC-3**：zcodeAgentProcessManager `reportError:false` 路径 cleanup reject 不产生 unhandledRejection（进程级 unhandledRejection 监听断言零触发）。
- **T-EVT-1**：并发两次 ensureSessionPersisted 只建一次会话（WeakMap 去重），`sessionPersisted = true` 置位时序不变。
- **T-MEM-1**：retention 淘汰后 model_request 只留瘦身形态（slim 字段断言），**且瘦身形态经 `mapModelRequestPayload` 投影的 `messageCount` 与全量形态相等（#10/#11 producer/consumer 同值断言）**。
- **T-MEM-2**：Stop 信号触发回合中，媒体工具结果仍完整落盘。
- **T-XFRM-1**：tool-result cacheControl 落在结果块级（构造带 cacheControl 的 tool-result，断言 providerOptions 注入位置）。
- **T-DWF-1**：scheduler registerActor 后 recordedAsks 与旧全表扫描结果等价（构造 N actor × M 行，输出 diff 为空）。
- **T-DWF-2**：observation 读取返回 ≤256 条且 SQL 层生效（fake journal 断言未收全量请求）。
- **T-DWF-3**：replay 冷回放 reportItems ≤64。
- **T-SVC-1**：流式 turn 兜底：构造 streamedTurnText 有前缀的 turn.completed，补投 chunk 不含已流式前缀。
- **T-SVC-2**：contentProfile=index 的 readSession 返回裁剪快照（无 raw/output 字段）且 full 行为不变。
- **T-SVC-3**：subagentsService 对 EACCES 抛错而非返回空配置；ENOENT 仍回退空配置。
- **T-MC-1**（manual_user 辅以 wire dump）：经 `restoreMagicContextMessageBoundaries` 后，wire 层 body 中 m0/m1 保持独立 user 消息（覆盖：m0 纯文本 / m0 带 mural image / m1 后紧跟本轮 user 输入的三段合并 / **m1 与用户输入间夹 `prompt_attachment` 等信封的四段以上合并（`reorderAttachmentLikeEntries` 会把其它 attachment 冒泡到当前输入之前）**；作用域=只拆 m0/m1 边界、其余段保持合并（对齐上游先例）；**断言拆分后仅最后一段末块携带 cache_control，不引入第二个缓存断点**；负例：真实用户输入含 `<system-reminder>` 或结构标签文本不被误拆）。Step 9 实跑 **10 用例**（原探针冒烟 17 PASS 行的转正版，登记见 `cache/test-wiring-map.md`）。
- **T-WIN-1**（C2 口径）：`SHELL=/usr/bin/bash` 环境下 stdio MCP spawn 使用 ComSpec/cmd.exe。单元断言两处：`normalizeRuntimeProcessEnv(env, "win32")` 的返回值 + `initializeRuntimeProcessEnv` 对真实 `process.env` 的写回（win32 专属，非 win32 skip）；**不断言** `buildRuntimeProcessEnvPatch` 输出——SHELL 不在下发的 runtime 工具环境变量 patch 里。
- **T-WIN-2**（manual_user）：Windows 注册表深链打开后 argv 末尾含 `--`，URL 注入参数被隔离；`--inspect-brk` 被 fuse 拒绝（打包后验证）。
- **T-WIN-3**：托盘创建失败路径走确认退出（单测 fake tray 抛错）。
- **T-X1**：全门禁回归（§5 全条目）。
- **T-EVICT-1**：seat.born 场景 B2 拒新生效。

T 覆盖说明：#1/#2 配 T-NET-1（proxy-fetch 主体验收，顺带覆盖 #1 的 `toWebResponse`）；#3 配 T-NET-1b（r3/r4 修正：proxy-fetch 与 http/index.ts 无调用关系，「经调用链覆盖」不成立；终态=resolve 原样带回 999，非 reject）；#5/#6/#7 配 T-PROC-1/2/3；#9 配 T-EVT-1；#13 配 T-XFRM-1；#12（subagent systemMessages 缓存断点合并）回归=在 `apps/zcode-cli/packages/core/scripts/` 按 `test-*.mjs` 自研形态新增断点断言脚本并接线根 `test:v4-perf`；#26（topic-publisher 钳位）回归=新增 `apps/zcode-cli/packages/bootstrap/scripts/test-publisher-buffer-clamp.mjs`（覆盖普通 delta 钳位 + `publishMagicContextUsage` 经 fanOutDeltas 的推送路径——r4 修正：既有 `test:magic-context`/`test:turn-directory` 不覆盖 subscriber buffer / fanOutDeltas 钳位路径（无 `subscribe` 调用；`test-turn-directory.mjs` 虽 import 真 publisher 但只走 `ingest()`/`getTurnDirectory()`），红线②前置回归此前无自动化）并接线根 `test:v4-perf`，另跑既有 `test:magic-context` + `test:turn-directory` 套件；#23（tool-plan-adapter 17 行纯读取）、#25（transport text/plain 放行+常量化）、#27（steering intent.text 单字段同步）、#28（memory-file-path 3 行）为小型纯函数/字段叠加改动，不单配 T，以 typecheck + 既有回归（test:v4-perf 全量、magic-context test:all）兜底。

## 5. 门禁清单（Step 10 逐条实跑）

1. 根 `pnpm typecheck`（tsc -b 13 个 paths 工程）= 0 err
2. `cd apps\zcode-cli && pnpm typecheck`（turbo 全 successful，`--force` 真跑）
3. 根 oxlint 计数**排除未跟踪快照 `.reference/**`** 后 ≤ **74w / 0e**（允许持平或下降；71w 为 20261009 旧基线，树漂移 +3w）。**统计范围警告（r5 修正）**：`.reference/` 不在 `.gitignore` 亦不在 `.oxlintrc.json` ignorePatterns——Step 1 将快照更到 v3.15.1 后直接跑根 `pnpm lint` 实测会被污染为 790w/307e（error 全在 `.reference/**`）；随 Step 1 把 `.reference/**` 补进 `.oxlintrc.json` ignorePatterns（一行配置修正，非产品代码），门禁按排除后计数裁定。
4. oxfmt：改动文件零新增不合规（根域仓根跑；apps/zcode-cli 域必须 `cd apps\zcode-cli` 跑包内 oxfmt）
5. knip：stash 对比零新增 + 零 magic-context 命中
6. `node scripts/typecheck-desktop-full.mjs` fresh=0（重采须 `--snapshot --accept-new` 显式确认）
7. `pnpm architecture:check --changed`
8. magic-context `pnpm run build && pnpm run test:all`（142 case 基线）
9. `pnpm test:v4-perf`（本批前基线 236 pass（前序迭代 +38 已计入；198 为更早口径）+ Step 9 新增接线 73 例 = 309 pass）
10. `pnpm --filter @zcode/cli build`
11. `scripts/check-i18n-parity.mjs`（zh/en key 集合相等）
12. 测试隔离红线：绝不写真实 `~/.omz`/`~/.zcode`；magic-context 测试显式 `MAGIC_CONTEXT_DB_DIR`/`MAGIC_CONTEXT_LOG_PATH`；exec 类 `ZCODE_STORAGE_DIR`（注意用户级 `~/.zcode/cli/config.json` 不受 ZCODE_STORAGE_DIR 重定向）

## 6. 风险与回滚

- **回滚**：每 Step 独立 commit 带 pathspec，可逐 Step `git revert`；无跨 Step 状态残留（Step 5 port 扩展为可选字段，向后兼容）。
- **高风险点**：
  1. #6/#18（zcodeAgentProcessManager/zcodeTaskServiceAdapter）两个三方冲突手工融合项，直接 patch 必错位，须按 fork 现状逐 hunk 核对；
  2. #26 topic-publisher 融合触碰 magic-context 推送路径（红线②），T-MC 类回归必须先行；
  3. #34 自研修复动 `anthropic-stream-compat.ts`（fetch 挂载层，所有 anthropic 请求经手），判据无固定前缀可用（m0/m1 正文顺序不定），误拆负例与三段合并形态的 T-MC-1 验证不可省；
  4. 无 CI 门禁（release-desktop.yml 仅 tag 触发），Step 11 全靠人工实跑，漏跑无告警；
  5. knip stash 对比避免 Windows worktree/junction 坑（`git worktree remove --force` 会穿透 junction 损坏主 node_modules）。
- **红线自检**（每 Step commit 前）：diff 中不得出现 `telemetry`/`statusSink`/`emitNetworkTelemetry`/compact 族符号回潮；不得出现 `applyPresentationSurfaceToCommand`/`zhipu-account`/`highspeed` 恢复；品牌文案 `~/.zcode` 不得回写。

## 7. Open questions

1. 发布节奏：本批是否随 v1.0.8 一并发布，还是累积到下个功能批次？（不影响实现，仅 changelog 归档时机）

（初版 Open question 1/2——permission-flow 竞态与静态头剥离去留——已按两分法终裁并入 2.2 不移植表，不再是开放问题。）
