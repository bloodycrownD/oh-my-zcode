# 证据包：upstream-v3.15.1-bugfix-backport 探索取证（round 0）

- 轮次：round 0（spec 撰写前的探索阶段产物，供 spec-check-loop 各轮 judge 复用）
- 所涉代码 sha：fork HEAD = d4a6cb22（v1.0.7）；上游基线 = 29628c9（v3.14.3，= fork 根 c34a9386 的快照源）；上游目标 = aac4755666d09fdcd70272fcf063c077a639015f（v3.15.1，upstream/main）
- 边界：本包只放稳定背景（三方核对结论/冲突形态/依赖链/适用性裁决）。**被审 spec 与代码必须新鲜读**；本包结论过期时仅作线索。
- 生产者：4 个并行 readonly 探索子代理（本包为它们的报告全文转录）。

---

## 报告 A：崩溃级/网络协议修复的三方核对（11 文件）

### 探索范围
- 仓库 `D:\Dev\Js\oh-my-zcode`（fork HEAD = `d4a6cb22` "chore(release): 1.0.7"）
- 三方基线：fork HEAD（= 上游基线 tag `baseline/v3.14.3` = `29628c9`）、上游 `aac4755666d09fdcd70272fcf063c077a639015f`（v3.15.1，refs/remotes/upstream/main）
- 核对命令：`git diff --stat 29628c9 HEAD -- <files>`、`git diff 29628c9 aac4755 -- <file>`、`git show aac4755:<path>`、`git grep -rln <symbol> HEAD / 29628c9 / aac4755`

### 总体事实
- 11 个文件中 10 个在 fork HEAD 与上游 v3.14.3 逐字一致（`git diff 29628c9 HEAD` 为空）。唯一例外：`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`（fork 相对 baseline：+11/-58）。
- fork 的 adapters/bootstrap 无 tests 目录（fork 走 `scripts/test-*.mjs` 自研脚本）；`packages/services/test` 仅 7 文件且不覆盖目标模块。

### 逐文件结论

**proxy-fetch.ts**：与 v3.14.3 完全一致。上游 diff 引入 `import { readIncomingResponse, toWebResponse } from "./incoming-response.js"`——v3.15 新文件（fork 不存在），自身只依赖 node:http/node:stream。附带 `export type NetworkFetch`。回调内 `new Response(...)` 改 try/catch → `message.destroy()` + `rejectOnce(error)`。→ 逐字应用。

**http/index.ts**：完全一致。依赖新增 incoming-response 与 response-body 新导出 `ResponseLike`；`fetchHttpResponse` 返回类型改 `Promise<ResponseLike & {...}>`；调用点只用 `.url/.status/.statusText/.headers`。→ 逐字。

**response-body.ts**：完全一致。新增 `export interface ResponseLike`；无正文直接返回 `new Uint8Array(0)`；`createHttpClientError` 仍被用。唯一调用方是 http/index.ts。→ 逐字。

**transform.ts**：完全一致。3 行：`...providerOptionsForCacheControl(message.cacheControl)` 从 content 数组后（message 级）移到 tool-result 结果块级。`providerOptionsForCacheControl` fork 有（transform.ts:499）。→ 逐字。

**anthropic-stream-compat.ts**：完全一致。新增 `restoreMemorySelectorMessageBoundaries`/`isMemorySelectorOutput`/`hasTextPrefix`，依赖文件内既有 `safeRecord`（fork :329）。**触发条件（`output_config.format.schema.required` 含 `selected_memories`、首条 user 两个文本块以 `Available memories:\n`/`Select memories relevant to:\n` 开头）在 fork 全树零命中 → 无效守卫，行为零变化**。→ 逐字可选（价值低无害）。

**bootstrap/zcode-protocol/transport.ts**：完全一致，但依赖链全部断裂：`MCP_APP_CONCURRENT_METHODS` 引用 `mcpReadResource`+19 个 `mcpUi*`（v3.15 index.ts 中 mcpUi 32 处，fork 仅 `mcpList`:3469）；背压块引用 `zcodeProtocolNotifications.processNetworkRequests`（fork :334 无）；非 id 分支引用 `processNetworkCapture`+`networkCaptureControlSchema`（fork 零命中）。→ **跳过**（不可移植）。

**browser-control-broker.ts**：完全一致。上游 diff 三段：①per-context WeakMap（`brokerStateByContext`+`ProtocolBrowserBrokerState`+`brokerState()`，只依赖 fork 有的 `ZCodeProtocolAgentServerContext`）②`closeTabs` 扩展（fork contracts 无）③`forChildSession`/`childTabOwnerChildren`（fork 全树零命中，v3.15 有 12+ 处跨 5 包——子代理浏览器会话特性）。fork 侧闭包分裂真实存在：server.ts:258 与 server-operations.ts:3228 各造一份。→ 只移植第①段+rememberConnection 移到 requireSession 之后；②③丢弃；裁剪后 parentSessionId 恒 undefined，无行为回退。

**zcodeProtocolClient.ts**：完全一致。自包含：request 拆 requestImpl 非 async 包装+no-op catch；PendingRequest 加 promise 补绑；rejectAll 补 catch。新增导出无冲突、fork 无子类。→ 逐字。

**zcodeAgentProcessManager.ts**：**不一致**。fork 本地改动：删 `presentationSurface`/`applyPresentationSurfaceToCommand`（commit a2741b59）+ `~/.zcode`→`~/.omz` 注释。上游 diff 四段：①`localRuntimeNetworkCapture`（fork 无该模块）②`GEN_UI_OUTPUT_ROOT_ENV`/`GEN_UI_OUTPUT_DIRECTORY`（fork @zcode/shared 无导出）③`applyPresentationSurfaceToCommand` 等 export 化 ④cleanupPromise catch 创建点无条件挂靠（**目标修复**，fork 文件 723-735 行与上游修复前逐字相同）。→ 只取④；①②属 v3.15 新特性不搬；③的 hunk 上下文锚在 fork 已删函数上，cherry-pick 必冲突，须手工。

**zcodeStdioTransport.ts**：完全一致。自包含：`stdoutBuffer += chunk`+全缓冲 indexOf 改 `stdoutPendingChunks: string[]` 分片+`consumeStdoutText` LF 时 join 一次；纯私有替换无签名变化。→ 逐字。

**zcodeTaskIndexSyncer.ts**：完全一致。上游两处：①目标修复 `readSession` 加 `contentProfile: "index"`；②`mode: "build"`→`"default"`（依赖 v3.15 `ZCodeTaskMode` 扩张（shared zcode-task-types-core.ts:149 新增 default/guarded/acceptEdits/dontAsk/bypassPermissions）；fork 的联合无 default → 编译失败，跳过）。①的依赖链（fork 全缺，需逐个补）：
- 新文件 `packages/shared/src/zcode-session-content-profile.ts`（`ZCodeSessionContentProfile`、`elideSessionSnapshotForIndex`；只 import fork 已有的 `ZCodeSessionStateSnapshot`/`ZCodeMessagePart`/`ZCodeMessageWithParts`，字段 input/raw/output/metadata/error 在 fork `zcodeToolStateSchema` 全存在 → 可逐字复制）
- `packages/shared/src/index.ts` 增一行 export（fork 有本地删减，插入点 85-88 行附近）
- `packages/shared/src/zcode-protocol/index.ts` 的 `zcodeSessionReadParamsSchema`（fork 1553-1560，`.strict()`）加 `contentProfile: z.enum(["full","index"]).optional()`
- `packages/services/src/zcode-agent/zcodeAgent.ts:234` `ZCodeAgentReadSessionParams` 加可选字段
- `zcodeAgentService.ts:2885-2892` readSession 请求体转发（fork 是显式白名单转发非 spread）
- `bootstrap/src/zcode-protocol/server-operations.ts:1820-1831` agent 侧 readSession：`params.contentProfile === "index" ? elideSessionSnapshotForIndex(result) : result`

### 约束
1. 遥测红线：transport.ts 与 zcodeAgentProcessManager.ts 的上游新代码依赖 v3.15 进程网络观测面（fork 已删，红线同域）——不搬。
2. 品牌红线：#9 手工融合不得把上游 `.zcode` 文案回写。
3. 产品面：不得借 backport 恢复 `--surface desktop`/presentationSurface。
4. 测试形态：fork 无本批模块单测；v3.15 测试不可整搬（browser-control-broker.test.ts 441 行等都是新增/重排）；按 `scripts/test-*.mjs` 形态自写最小验证。上游新增架构守卫 core/tests/io-boundary.test.ts 白名单含 network/incoming-response.ts（fork 无此测试不阻塞）。

### 风险
1. #9 手工融合边界：两个 hunk 上下文锚在 fork 已删函数（上游 v3.15:470/504）；必须按 fork 723-735 手工套用。
2. #11 mode 行强烈不搬（牵动 sessionModeOptions/zcodeTaskServiceAdapter:2683/3197/3217/config/schema 一大片）。
3. #3 行为变化面：body===null 从 arrayBuffer+超限误判改空 Uint8Array；只搬 #3 不搬 #1/#2 时 Response 路径 body 永不为 null（安全）。
4. #5 零触发说明：列 backport 只为同源减 merge 噪音。

---

## 报告 B：20 个双改文件的冲突形态

### 基线
fork `baseline/v3.14.3` = `c34a9386`（= 上游 29628c9）；上游 v3.15.1 = aac4755；fork HEAD = d4a6cb22（v1.0.7）。

### 逐文件判定（A=正交可叠加 / B=同区域需手工融合 / C=fork 已有等价或无落点 / D=特性依附）

1. **memory-file-path.ts**：fork +2 行（SENSITIVE_MEMORY_PATH_SEGMENTS 加 `.omz`，品牌 S32）；上游 +3 行（同 Set 加 `.claude`）+`containsSensitiveMemoryPathSegment` export 化（上游全仓无消费方）。**A**（同一 Set 不同行）。
2. **permission-flow.ts**：fork −10 行（仅删 telemetry）；上游 590 行重构（while 循环+循环顶 aborted+rewrite transition 解决 requestId 复用竞态；拆 4 新模块；签名加 preparedContext；依赖 fork 无的 `approvalMode`/`"guarded"`——fork contracts 无 approvalMode，已 grep 确认）。**B**（上游重写整函数且依赖缺失）。
3. **steering.ts**：fork −2 行（firstInlineGuideIndex 等删 `commandKind !== "compact"`，原生压缩红线）；上游 `editPendingInputById` 同步 `intent.text`（fork `TurnInputIntentMetadata` 已有 `text?` 字段可直接应用）+conversationQuotes 部分（fork 无特性）。**A**（fix 主体 base 873 行，fork 删除在 450/466 不重叠）/ **D**。
4. **provider-registry-model-runtime.ts**：fork 删除整个 `zhipu-account && mode==="off-peak"` requestDependencies 块（D-4）+加 D-12 fallback；上游把该条件改 `mode === "off-peak" || mode === "highspeed"`。**C**（上游改的正是 fork 已删的行；fork 无 highspeed/zhipu-account access 型；切勿带回条件块）。
5. **session-mapper.ts**：fork 重写 mapSnapshotMessages（+40 行观测）+删 compact boundary 块；上游 `mapModelRequestPayload` 支持 messageCount 瘦身（base 467-480，fork 未动该区域）+approvalMode 透传。**A** / approvalMode **D**。
6. **conversation-topic-publisher.ts**：fork 提取 `fanOutDeltas` 私有方法（内含 buffer append 调用点）+新增 getTurnDirectory/publishMagicContextUsage（D-13）+删 compact envelope；上游 `appendConversationSubscriberBuffer` 加 snapshotBytesUpperBound→byteLimit 钳位（新导出 `conversationSubscriberBufferByteLimit`=logicalFrameAssemblyMaxBytes−64KiB）+两处调用点改 `this.subscriberBufferLimits()`+冷测量排除 pluginUi.*。**B**（上游第一调用点 hunk 落在 fork fanOutDeltas 体内 710-717；机械融合。前置 wireSnapshotBytesUpperBound fork 已有；logicalFrameAssemblyMaxBytes 在 fork shared core.ts 存在）。
7. **transcript-hydration.ts**：fork 删全部 compact 合成机制（~230 行）；上游新增 transcriptFootprint/projectionFootprint/footprintCovered/eventsCoverTranscript（引用 fork 已删的 compactPayloadFrom*——需改写或放弃 compactMarkerCount）+highspeed 过滤+intent 新字段。**B**；且上游 v3.15.1 eventsCoverTranscript **仅测试消费**（cold-event-merge.ts 未接线）。highspeed/intent **D**。
8. **server-operations.ts**：fork 删 offpeak-port/compact/offPeakTaskId+sendPrompt 加 modelSelectionPinned+snapshotWithDiagnostics 加 logger；目标修复 REMOTE_AUTOMATION_TOOL_NAMES+resolveSessionToolDenylist（`isRemoteWorkspaceIdentity` 已由 @zcode/shared 导出，fork 只需补 import）；其余 hunk 为 v3.15 新功能。**B**（可独立移植但 createRecord hunk 与 fork 改过的 dynamic-workflow 注释区相邻，须逐行挑拣）。
9. **runner.ts**：fork 删 statusSink/requestAuthRequired 整块/accountAccess 透传/reasoning telemetry（−96 行）；上游 requestAuthRequired 加 highspeed+refreshOffPeakRequestAuth+resolveRetryOptionsForBudget。**C**+**D**（modelRetryBudget 为 v3.15 新字段）。
10. **model-execution.ts**：fork 删 createProviderTransportFetch（官方网关直连化）+apiKey 条件去 zhipu-account；上游 apiKeyId 不进 Provider 缓存 transport（经新 endpointRoutingPort）+applyModelRequestAuth 动态鉴权前剥离静态 auth 头（withoutModelAuthHeaders/withoutRequestVerificationHeaders）+resolveProviderTransport 改写。**B/C 混合**：endpointRouting 段无可融合；静态头剥离可独立移植但需先移植 model-request-headers.ts 新导出（fork 无）。
11. **providerRuntimeResolver.ts**：fork 仅 2 处 `.zcode`→`.omz`；上游纯新增 buildCleanEnv（Windows SHELL 无效 POSIX 路径→ComSpec/cmd.exe + Path→PATH 归一）、findBinary、GLM dev entry 发现。**A**。**重要事实**：buildCleanEnv 在 upstream v3.15.1 无任何调用方（死代码）；fork 的 runtimeCommandEnv.ts 已有 normalizeRuntimeProcessEnv 做 Windows PATH 归一（139/145/253 行），但 SHELL 修复 fork 不存在——若修 Windows stdio MCP 应在 fork env 链加而非搬死代码。
12. **autoUpdater.ts**：fork 整文件已删除（−1924 行）；package.json 无 electron-updater；src 无任何引用。上游 243 行更新状态机多修。**D**（唯一提及在 THIRD-PARTY-NOTICES.md/installer.nsh/omz-publish skill）。
13. **desktopWindowLifecycle.ts**：fork 删 syncAutoUpdater*/awaitFirstHostSpawnDecision/scheduleArmsBrowserPerfLoadNudge 等（−29）；上游 handleDesktopWindowCloseRequest：closeToTrayOnWindows→closeToTray+closeToTraySupported（托盘失败→确认退出，含 Linux spec）+webRemoteControlManager.disposeWindow。**A/B**：目标修复区域（handleDesktopWindowCloseRequest）fork 未动→**A**；webRemoteControlManager hunk **D**（fork 无模块）。移植只搬「托盘成功才可隐藏」裁决，保留 fork closeToTrayOnWindows 命名（调用点 index.ts 203/974/1212）。
14. **zcodeTaskServiceAdapter.ts**：fork 删 compactSession facade/compact timeline/turnPhase==="compact" 失败分支/offpeak denylist/emitNetworkTelemetryObservation（−364 行）；上游 ①流式 turn 兜底：streamedTurnKeys: Set→streamedTurnText: Map<turnKey,{messageId,text}>，turn.completed 计算 missingResponse= response.startsWith(streamed)?slice:response 补投 chunk（涉及 turn.started/modelStreaming/tool.updated/turn.completed/turn.failed/dispose）②legacy ACP 只读恢复：readLegacyTaskSnapshot+resumeSnapshotOrLegacy+legacySnapshotTaskKeys 订阅守卫+resumeTask/getTaskSnapshot 两调用点 ③bot group/topicAdmission/connectionScope/codex/switchAgent 新 API。**B**+**D**。legacy 前置符号 fork 齐备：getLegacyTaskSessionSnapshotPath/getLegacyDeletedTaskSessionSnapshotPath（services paths.ts）、safeParseLegacyTaskSessionFile（legacyTaskSessionFile.ts 同名同形）、applyOverlayToMeta/getOverlay/rememberIndexedTaskMeta/ZCodeTaskSnapshot/limitTaskSnapshotMessages/getTaskSnapshotMessageDiagnostics 均存在——20 文件中最接近可直接落地。fork 旧兜底逻辑 HEAD:3975 `if (response && !streamedTurnKeys.has(turnKey))`。
15. **taskIndexRepo.ts**：fork 删 off-peak 回填两函数+ensureOffPeakGroupMembership+offPeakTaskId 列读写（−96 行）；上游 legacy acp_session_id→真实 session id 迁移（migrateLegacyAcpTaskIds/hasColumn/buildLegacyAcpMigratedRow/migrateLegacyAcpTaskGroupingReferences/migrateLegacyTaskMetaJson）+normalizeAgentProviderToZCodeAgent。**B** 但 fork schema **无 acp_session_id 列**（全仓 grep 无；off_peak_task_id 列仍在 migrations.ts:18 值 NULL 不炸）→ hasColumn guard 直接 return，迁移大概率 no-op。
16. **subagentsService.ts**：fork 1 行（readPluginConfig 路径 .zcode→.omz，HEAD:399）；上游 readAgentStateFile 拆 readAgentStateAtPath+catch 区分 ENOENT/SyntaxError 才回退空配置、其它 IO 错误重抛+collectAgentMarkdownPaths/runtime config cache 新 API。**B**（相邻函数）。fork 额外发现：readPluginConfig（397-418）与 readAgentStateFile（158-183，183 行 return emptyAgentsState()）自身也有 catch-all 伪装空配置问题——上游只修了后者，建议两处同修。
17. **toolCallTree.ts**：fork 1 行（import 路径改相对）；上游 +173 行 areTaskChatToolCallsRenderEqual/buildToolCallTree/reconcileToolCallTree。**A**（纯新增零冲突）。**关键疑点**：上游两导出无生产消费方（仅 packages/ui/test/toolCallTree.test.ts 引用；其余 8 处为 type-only）。不接线=死代码。
18. **display.tsx**：fork re-export 删 getContextCompressionCommand；上游 import 重排+HIGH_PERMISSION_MODE_VALUES（补 bypassPermissions/full-access/agent-full-access）+搜索函数+guarded 蓝样式+mode 回显兜底。**B**（上游第一 hunk 与 fork 删除 re-export base 44-50 相距 <3 行；整体搬回会因 getContextCompressionCommand re-export 编译失败）。「mode 切换 3s 保护窗口」不在本文件 diff 内。
19. **transport.ts (shared v4)**：fork 删 ttft 族字段（遥测）+新增 turnDirectory schema/method（fork 功能）；上游 v4AttachmentReadResultSchema 放行 text/plain（fork 1066-1095 与上游 base 完全一致）+WORKFLOW_RUN_EVENTS_PAGE_LIMITS 抽常量（maxEvents=500 同旧值，maxBytes 注释/hasMore 语义注释）。**A**（两处修复区域 base 596-650/1016-1050，与 fork 改动 base ~191/~340/~528+ 零重叠；PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes fork 已有）。
20. **plugin-marketplaces.ts**：fork 全量改 `oh-my-zcode-official`（品牌）；上游 DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS 补 `visualize@zcode-plugins-official`+CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID（Claude 官方市场）。**D**（fork 全仓无 visualize 插件，三处 grep 空）。

### 红线交叉验证
- 遥测：上游 v3.15.1 仍带 telemetry?.setPermissionDecision（#2）、statusSink（#9）、emitNetworkTelemetryObservation（#14）、localTtftFacts（#19 上游未删）——**不能整文件 takeover**。
- magic-context（D-13）：#6 fork 新增 publishMagicContextUsage/fanOutDeltas 与上游 buffer 钳位同函数——不得破坏推送路径。
- 压缩：#7 上游新代码反向依赖 compact 机制；#18 re-export；#14 compact timeline——涉 compact hunk 都需 fork-adapt。
- 品牌：#1/#11/#16/#14 单行与上游 hunk 同文件；#20 全量改写作废上游补丁。@zcode/* 包名、ZCODE_* env、zcode:// scheme 未出现改动需求。

### 合并顺序风险
#6/#14/#15/#16/#18 的 fork 删除行与上游新增/修改行相距 <3 行，3-way merge 大概率冲突；#18 整体取上游文件会编译失败。

---

## 报告 C：17 个候选文件的基线验证与依赖链

### git 拓扑
- fork HEAD = d4a6cb22（v1.0.7），fork 根提交 = c34a9386「baseline: import ZCode v3.14.3 snapshot (zai-org/ZCode 29628c9, Apache-2.0)」，与上游无共同历史（merge-base 空）→ 不能 cherry-pick/rebase，只能 diff 手工移植（git apply -3 或手工，每文件独立可回滚）。
- 标签陷阱：本地 `v3.14.3` tag → 29628c9a（上游对象）；`v3.15.1` tag → **9ab8a64（fork 自有 tag，不是上游 aac4755）**。`baseline/v3.14.3` = c34a9386。

### 逐文件（基线验证 / 依赖链 / 分级）

1. **context-builder.ts**：**已改**（+15，magic-context Step 13）。上游修复在 build() systemMessages 组装区；fork 改动在 config 接口+buildSubagentContextSections（HEAD 56-68/152-154），两区不重叠；零新依赖。→ 可直接打。fork 改动证据：152-154 行 buildMagicContextSectionEntry(config.magicContextSection)。
2. **tool-result-media-persistence.ts**：干净。上游删 signal 入参；**配套**：fork turn-tools.ts:288-294 仍传 `signal: state.turnAbortSignal`（对象字面量 excess property 报错）必须同删；第二参本就可选。→ 2 文件 1 行配套。
3. **events.ts**：干净。WeakMap 去重自包含；但上游 import 了 v3.15 全新模块 dynamic-workflow-activation.ts（182 行）——fork 无，其依赖（SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION、dynamicWorkflowToolsActivated/OnDemand、isDynamicWorkflowToolName）fork 全不存在。→ 核心修复可独立打；activation 行必须放弃。上游把 ensureSessionPersisted 拆 persistSession 并把 activation 调用置于 sessionPersisted=true 之前——fork 需保持置位时序不变。上游有 session-persistence-concurrency.test.ts 可考虑一并搬。
4. **session-event-retention.ts**：干净。新增纯函数 slimRetainedModelRequest；调用方 in-memory-session-event-store.ts（fork 干净，HEAD:104 retained.push）+import 4 行。→ 2 文件 ~20 行。
5. **session-store.ts**：干净。fix 依赖 isHighspeedProviderId（@zcode/shared 上游 highspeed.ts:36）——fork 整 monorepo 无此符号；函数仅 4 行字面量比较。→ 本地复刻后守卫恒不命中、价值低零风险。
6. **dynamic-workflow-run-observation.ts**：干净。上游 89/33 diff 与三个 v3.15 特性纠缠（holes 架构 DynamicWorkflowRunHole/CompiledHole/dynamic-workflow-run-holes.js fork 无；modelBindings readRunModelBindings fork 无；concurrencyCeiling→defaultConcurrency 改名）。核心读放大修复仅 reportsOf 重写。**最小链**：contracts 加 2 常量（上游值=256 条/8MiB，dynamic-workflow-run.port.ts:222/230）→ JournalStorePort 加 countNodes(runId,kind)+listNodes 选项（fork types.ts:901 仅 listNodes(runId)）→ journal-memory.ts:121+adapters dwf-journal.ts:363/413 两处实现 → observation.ts。fork 已有 settled 门（status==="running"）与 countNodesByStatus（不同形状）。concurrencyCeiling 改名是语义改名（判据从「低于天花板」变「不等于默认值」）横跨 observation/replay/run-service——本批不做。→ 中深链（4-5 辅助点）。
7. **dynamic-workflow-run-replay.ts**：干净。核心 fix=COLD_REPLAY_EVENT_READ（reportItems 限 64）。WORKFLOW_RUNS_LIMITS.maxReports=64 fork 已有（workflow-runs.ts:39）；缺 ListEventsOptions.reportItems（fork types.ts:852 仅 afterSequence/limit）→ port+memory/sqlite 两实现+replay.ts。同 diff 内 holes/modelBindings/defaultConcurrency 不搬。→ 中深链。
8. **scheduler.ts**：干净。上游 102/86 与 cachedAskFacts 新模块、hash-mismatch.ts 搬迁、drainAdmission 内联、actorPersonaModel 纠缠。核心 fix（recordedAsks Map+seedRecordedAsks+registerActor 不再扫全表）自包含；上游在 engine-resume.ts:28 调 seed——fork engine.ts:352 已有 `const nodes = this.journal.listNodes(this.runId)`，其后 filter+seed 一行即可；refToString 已在 fork scheduler 导入。→ 2 文件 engine 加一行。
9. **tool-plan-adapter.ts**：干净。新增本地 readClaudeParentToolUseId；isRecord/readString 文件内既有。→ 零依赖 17 行。
10. **workflow-runs-eviction.ts**：干净。seat.born fork 已有（:146）；workflow-runs-unlisted.ts fork 已有；改动=函数内判断重排+注释。→ ~10 行。
11. **bots.ts**：干净。上游整文件 374/2 主体是 v3.15 飞书特性族（botGroupDeliverySchema、channel-mention.js、conversationSelection.js、trace.js）；真 fix=legacyBotAgentProviderSchema（enum+transform→ZCODE_AGENT_PROVIDER，fork 已有 import，HEAD 405/411 两处 z.literal）。→ 核心 10 行零依赖；勿搬 374 行。
12. **chatStatus.ts**：干净。上游重写式新增 7 导出，仅需 fork 已有的 ZCodeWorkspaceInitStatus。但 fork UI 消费面已重构：全 UI 仅 workspaceRemovalSafety.ts 用 isChatTaskRunning；上游新函数喂 ChatView/Composer——fork 无消费方。→ 模块可打需接线。
13. **taskListRefreshPolicy.ts**：干净。新导出 4 函数+2 reason 集；TaskRealtimeReason 已含所需（zcode-task-types-core.ts:1102-1121）；消费方 useWorkspaceTaskLists.ts 干净但只用旧函数。→ 需接线。
14. **chatAttachments.ts**：干净。185/3 主体是新函数 restoreChatComposerAttachment（草稿恢复 API），video base64 估算藏其内部；错误类 fork chatAttachmentErrors.ts 已有（:37-55）。**上游全树 restoreChatComposerAttachment 只有定义+测试引用、无生产消费方**。→ 不建议单独移植。
15. **mobileTextInput.ts**：干净。102/0 纯增量（useIsMobileTextInputViewport 等，React+matchMedia addListener 兼容、iOS 16px）；零新模块。→ 需消费端接线。
16. **zcodeSessionProjection.ts**：**干净**（预判不成立——3433 行大 diff 是上游侧的）。上游 3363/70：~86 个 @zcode/shared 新符号 fork 均无。→ 成片依赖不建议。
17. **desktopOAuthDeepLink.ts**：**fork 整文件删除（507 行）**，逻辑迁入 fork 新建 desktopDeepLinkRouter.ts（285 行）。上游 fix=win32 两分支 argv 追加 `--`（8/2 行）。**fork desktopDeepLinkRouter.ts:228-247 是修复前同款代码（同类漏洞存在）**，移植落点换为该文件。electronFuses：上游 v3.15 在 electron-builder.config.js 加 electronFuses:{enableNodeCliInspectArguments:false}（仅 win32）+test；fork 全仓无任何 electronFuses；fork 的 electron-builder.config.js 因遥测移除改过 37/42 但 electronVersion:"41.0.3" 同基线，插入点=468 行后。scheme 字面量 "zcode"（fork router :226 同值，品牌改名未触及 scheme）。→ `--` 直接打落点换文件；fuses 独立 5 行配套。

### 依赖链分级汇总
- A 级（无依赖/1 配套点）：1、2、3（去重部分）、4、8、9、10、11（核心）、17（--）
- B 级：5（本地 4 行谓词）、17-fuses
- C 级：6（constants+port+两实现+bootstrap）、7（port+两实现+replay）
- D 级（可打需接线）：12、13、15
- E 级（不建议）：14、16

### 风险
- 数值易混：#6 上限 256 条/8MiB（DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS/MAX_REPORT_BYTES）≠ #7 的 64（WORKFLOW_RUNS_LIMITS.maxReports）——不同源勿混用。
- port 扩展全部可选字段化（countNodes?/listNodes options/reportItems options）避免破坏 fake journal/测试替身；listEvents 过滤必须存储层完成（上游注释明确禁止取全量再切片）。
- fuses 测试（vitest 动态 import electron-builder.config.js 顶层有 I/O）移植需评估 desktop 测试基建。
- 深链修复落点 fork desktopDeepLinkRouter.ts:230/247 app.setAsDefaultProtocolClient；fork 删除的 507 行含 share/payment/workspace-open 路由——修复前确认 handleDeepLink 的 URL 校验仍在。

---

## 报告 D：门禁/测试链现状 + 适用性裁决

### 门禁链（fork 当前口径）
1. 根 `pnpm typecheck`（tsc -b 12 工程：rpc/provider/provider-node/shared/services/client/server/zcode-server-cli/ui/web/desktop(tsconfig.host.json)/shared(test)/ui(test)）= 0 err
2. `cd apps\zcode-cli && pnpm typecheck`（turbo 全 successful 27 包，--force 真跑；CI 同款）
3. 根 `pnpm lint` = 71w/0e 真基线，允许持平或下降；CLI turbo lint 非门禁（.oxlintrc.json:63 ignorePatterns 含 apps/zcode-cli；max-lines 400 基线即红）
4. oxfmt：改动文件零新增不合规。根域仓根跑；apps/zcode-cli 域必须 cd 进去跑包内 oxfmt（根 .prettierignore 整条忽略该子树）。apps/zcode-cli 基线本就红（~1285/1403），历史上发过 4 个 oxfmt 归一 commit（3d482b8f/28c23a5c/9182a420）
5. knip：stash 对比零新增 + 零 magic-context 命中（knip.json:30-37 magic-context ignore src/**+ignoreDependencies ai-tokenizer）；不用绝对行数
6. 桌面差分：node scripts/typecheck-desktop-full.mjs fresh=0（diffKey=文件+错误码+消息去行列号，与 scripts/desktop-typecheck-baseline.txt 比集；--snapshot 须 --accept-new 二次确认）
7. `pnpm architecture:check --changed`（.architecture-baseline.json 存在）
8. magic-context `pnpm run build && pnpm run test:all`（14 子脚本聚合，142 case 基线）
9. `pnpm test:v4-perf`（198 pass 基线；手工枚举清单 package.json:32——新增 ui/shared 测试必须同步接线）
10. `pnpm --filter @zcode/cli build`
11. i18n parity：scripts/check-i18n-parity.mjs（zh/en key 集合相等；历史 5893 键基线）
12. licenses.mjs check + THIRD-PARTY 重生成（官方端点轮八门禁之二；EMFILE 串行方案见 UPSTREAM-SYNC.md:114——该文件当前为删除态）
13. 工具链：Windows 便携 Node 24（.tools/node-v24.14.0-win-x64；node:sqlite 需 24；系统 nvm node 22 会被 pnpm shim 选中）；pnpm@10.33.2；UTF-8+LF（* text eol=lf）
14. FORK 纪律：magic-context/src/core/** 上游逐字区改动必须加 FORK (xxx) 注释块；magic-context-turn-transform.ts 与 bootstrap 对应文件 turn-loop 禁区
15. fail-closed：host/config/schema.ts fail_closed_blocking 默认 true；busy 重试有上界且上界后 throw；openDatabase 同步 API
16. 协议契约：工具输出 zod .strict()，接口与 schema 同 PR 双改
17. 测试隔离：绝不写真实 ~/.omz/~/.zcode；magic-context 测试显式 MAGIC_CONTEXT_DB_DIR/MAGIC_CONTEXT_LOG_PATH；exec 类 ZCODE_STORAGE_DIR（用户级 ~/.zcode/cli/config.json 不受其重定向，项目级 <cwd>/.zcode/config.json 才行）

### CI 现状
.github/workflows/ 仅 release-desktop.yml（tag v* 触发）：pnpm typecheck + turbo typecheck --force + bundle；**无 PR/push CI，门禁全靠人工**。

### 测试入口现状
- 无 wdio（桌面 e2e=CDP 自研脚本，模板 .cu-shots/ 已删）；无 uix 入口
- packages/ui/test/ 14 个 .test.ts（tsconfig.test.json 参与根 tsc -b，跑在根 typecheck）；test:v4-perf 直接 tsx --test 枚举
- packages/services 唯一接线测试 test:storage-exec-output-clean；另有 7 个未接线测试文件（importedClaudeRecovery/nonCliAcpRetirement/promptLanguageDegradation/providerConfigMigration/providerModelList/zcodeBuiltinBundledEnv）
- packages/shared/test/ 仅 2 文件且无 package.json 接线，仅由根 test:v4-perf 显式点名 apply.test.ts/previewText.test.ts——**新增 shared 测试不会自动进任何门禁**
- realdevice-e2e 已 stopped（活库拷贝种子事故，4 场景 blocked）

### 适用性裁决表
| 修复组 | 裁决 | 证据 |
|---|---|---|
| autoUpdater | **不适用** | fork 整链删除（official-endpoints-removal D-1/S2 head d752d8f）；package.json 无 electron-updater；全仓零引用 |
| telegram/bots | 适用（裁剪） | fork 完整保留（bots 27 文件；D-3「offPeak 删/cron+bots 留」白名单）；telegramChannelRuntime.ts:88-101 已有 token 空 error 上报但仅 polling 入口；telegramProvider.ts:344 等路径需逐一核对 |
| Cron/远程会话 | 适用 | remoteTarget.ts 三分支/desktopRemoteSessions.ts/automationRepo.ts:129 location_kind==="remote" 均在；createProtocolAutomationPort(server-operations.ts:108/:3225) 只校验 activeAutomationId/绑定会话，无远程守卫=真缺陷 |
| 额度重置 UI 集群 | 不适用 | Coding Plan 整删（D-4/D-5/S5）；contextUsage.tsx:235-236 硬编码 false；CodingPlanUsage*.tsx 零 importers 孤岛 |
| DWF | 适用 | dynamic-workflow+runtime 两包在；DEFAULT_DYNAMIC_WORKFLOW_MODE="alwaysOn"（dynamic-workflow-feature.ts:26，FORK D-20：远端灰度链已删本地默认启用）；装配 node.ts:1733-1734 |
| memory selector/anthropic-stream-compat | 适用（高风险） | fork 双消息基线真实存在：inject-compartments.ts:3300-3341 prependM0M1Messages unshift 两条连续 synthetic user（m0/m1，syntheticHead:true+synthetic part）；memory-selection.ts 真身（20261011 D3 缝②）；**fork 自己的合并实现在同一路径运行**：reasoning-history-normalization.ts:210-261 mergeAdjacentUserMessages（removeWhitespaceOnlyAssistants 收尾调用），runner.ts:270-279 projectRequestHistory 在 providerKind==="anthropic" 每请求投一次；显式豁免 toolResult user 但**未豁免 syntheticHead/synthetic m0/m1**。上游修的正是这个形状。验证：runner 出口 asserting 或 ZCODE_MAGIC_CONTEXT_DEBUG_WIRE=1 wire dump；magic-context-turn-transform.ts:850-894 用 metadata.source==="magic_context" 重识别（与上游 info.syntheticHead 机制不同源——裁剪点） |

### UPSTREAM-SYNC 工作树状态
- git status 唯一未提交删除=UPSTREAM-SYNC.md（unstaged D）。third-party/ 与 THIRD-PARTY-NOTICES.md **未被删除**（git ls-files tracked 且工作区完整存在）。
- untracked：.reference/、docs/iterations/、docs/apm/、docs/.iteration-state.yaml、.tmp-realdevice-e2e/、.tools/、.zcodeignore、日志文件、根目录两个垃圾文件 `console.log(l))}` 与 `l.split('`（oxfmt/knip 扫描噪音）
- .reference 只在 D:\Dev\Js\oh-my-zcode\.reference\（含 ZCode/magic-context/pi 三个快照）；D:\Dev\Js\.reference 不存在
- .reference\ZCode HEAD=29628c9（tag v3.14.3）；**aac4755 对象不在该快照中**（git cat-file 报 could not get object info）→ backport 前必须 fetch+checkout 更新快照
- UPSTREAM-SYNC.md（git HEAD 版）六节：§1 更新参照快照/§2 diff 与影响面评估/§3 重放改造（src/core/** 移植件更新流程、各 phase 不可回退点）/§4 门禁清单/§5 已知不适配项

### 历史 spec 结构先例
- bugfix-batch-20261009：Step N — phase-xxx — blocking: yes/no — qa: auto/manual_user 四元组；T-{M/E/D/S/U/C/X}-n 编号；Context Bundle YAML 段
- bugfix-batch-20261011：front matter date + 裁定总表（做/不做两栏，不做带理由+不影响使用论证+收口动作）+ cr-fix-spec.md 姊妹文档 + .iteration-state.yaml 编排状态
