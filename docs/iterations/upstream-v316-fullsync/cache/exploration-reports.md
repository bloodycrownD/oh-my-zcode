# 探索证据包（exp-pack r1，2026-10-23）

> 生产者：4 个并行 readonly 探索子代理（spec-generate 阶段）。
> 所涉代码 sha：上游快照 `.reference/ZCode` @ 3c5b2276（对比基线 aac47556）；omz worktree `D:\worktree\upstream-316` @ 1ff8cad9（upstream-v3.16-backport，含 v1.0.20）。
> 消费者：spec-check-loop 各轮审查子代理（judge 仍须新鲜读关键代码路径，本包只作事实底座）。

## 报告 1：C1+C2 融合面

### C1 上游（合并入口）
- 控件树（上游新增 6 文件 + 1 CSS）：`packages/ui/src/ModelConfigSelect.tsx`（823 行，diff +335）：props 新增唯一关键字段 `composerOptions?: ComposerModelOptions`（:146-148）。传它即进入 Composer 合并模式：菜单内容换成 `ComposerModelMenu`（:712-735）、触发器包 `ComposerTriggerTransition` 动效（:632）、打开态锁宽 ≥8rem（:599-605）、选模型后 `event.preventDefault()` 保持菜单可继续调档（:407-412）、providerMenu.pending 期间冻结展示（:244-264）。不传则保持原模型选择行为——所有旧消费点零破坏。
- `chat-input-toolbar/ComposerModelMenu.tsx`（382 行）：导出 `ComposerModelOptions`（:37-53）、`getComposerThoughtDisplay`（:55）、`isGlmHighspeedModel`（:65）、`ComposerThoughtIndicator`（:70）、`ComposerModelMenu`（:102；`menuGroups = options.providerMenu?.groups ?? groups`（:123）——providerMenu 缺席时退化为纯目录浏览，omz 无 CodingPlan 也能用）。
- `ComposerProviderMenu.tsx`（209 行）：宽屏 DropdownMenuSub（:182-190）/窄屏（matchMedia 639px）back 模式双形态；错误回开子菜单（:68-70）。
- `ComposerEffortHeading.tsx`（27 行）：依赖 `ControlShortcutBadge`（omz 缺）+ RollingToolbarLabel（omz 有）。
- `ComposerTriggerTransition.tsx`（29 行）：motion/react ^12.38.0 omz 已有。
- `composer-thought-slider.css`（3.7KB）+ `thoughtLevelLabels.ts`（35 行外提）。
- thoughtLevelLabels 外提形态：THOUGHT_LEVEL_LABEL_IDS 表 + thoughtLevelLabelId() 从 thoughtLevelOptions.ts 移入新文件；thoughtLevelOptions.ts 变 import + re-export；getThoughtLevelLabel 改查外提函数；isNoThoughtLevel 参数收窄为 Pick<ThoughtLevelEntry,"value">。
- 构造方 `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`（1386 行，diff +269）：composerOptions useMemo（:1148-1209）：i18n 键 chat.toolbar.combined.provider/models/effort/selectModel（en-US.ts:5881-5884，zh-CN.ts:5508-5511）；渲染 ModelConfigSelect 传 composerOptions（:1320-1357）；ThoughtLevelCycleControl 降级为兜底仅 modelLocked||highspeedPresented（:1362-1379）；Ctrl+T 循环档位保留（:1117-1130）。
- 上游 contextUsage.tsx 本轮只改 import 路径（TID_CHAT_CONTEXT_USAGE_TRIGGER 迁 @zcode/shared/test-ids）。

### C1 omz 现状
- `packages/ui/src/ModelConfigSelect.tsx`（664 行，v3.15.1 底子）：props 接口（:135-184）与上游差集恰好只有 composerOptions。
- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`（641 行）：:587-616 渲染 ModelConfigSelect（无 composerOptions）；:618-634 独立渲染 ThoughtLevelCycleControl；:560-566 ChatContextUsage 传 magicContext={usage?.magicContext ?? null}（fork 自研链）。thoughtOption/handleThoughtValueChange 全就位（:440-496）。
- `packages/ui/src/chat-input-toolbar/thoughtLevelOptions.ts`（90 行）档位表内联；消费方：workflow-timeline/subagent-model-label.ts、ToolCallBlocks/renderers/list-models.tsx。
- `packages/ui/src/chat-input-toolbar/contextUsage.tsx`（474 行 fork 自研）：ChatContextUsage（:205）；TID 双常量从 @zcode/shared 导入（:11-16）；omz shared 已有 ./test-ids 子路径导出。
- 依赖件在位：scroll-fade-viewport、pickerFocus、ProviderLogo、ModelInputCapabilityBadge、ControlHintTooltip（162 行）、RollingToolbarLabel、motion。缺：4 Composer* 组件、thoughtLevelLabels.ts、composer-thought-slider.css、ControlShortcutBadge.tsx、composerPlanGroups.ts（可省）。
- omz 无 modelConfigSelect/thoughtLevel/contextUsage 的 UI 测试（packages/ui/test 只有 modelTrajectory* 等 21 文件）。

### C2 上游（组包统一）
- 签名 `apps/zcode-cli/packages/core/src/agent/message-history.ts:596-644`：`buildUserMessageEntries(input: ModelMessageContent, attachments: readonly UserMessageAttachment[]): [RuntimeMessageMessageEntry, ...RuntimeAttachmentEntry[]]`；UserMessageAttachment = Pick<FilePart,"filename"|"mime"|"source"|"metadata"> & { contentBlock }。
- entry 类型与顺序：[user entry, ...prompt_attachment attachment entries]；user entry=role:"user"+metadata: realUserRuntimeMetadata()，content 由 normalizeRealUserContent 合成，块顺序=正文 text→非附件类 realUserBlocks→pastedImageBlocks。附件四分类：①粘贴图入正文（:656-666）②text 附件走 systemReminderAttachmentEntry("prompt_attachment",body) 独立条目 ③读取失败占位丢弃（errorCode=attachment_read_failed :725-731）④其余入正文。
- 调用点：session-history-hydrator.ts:355（冷恢复，real_user envelope 恢复规则 :359-363 + logger 参数）、runtime/helpers/conversation.ts:114（薄包装：先 formatBrowserAmbientUserInput 再委托 :107-118）。间接：turn.ts:668/694、steering.ts:1252、control-only-turn.ts:64。同族 modelCallWrapper/toModelToolCall/compactBoundary/toolSearchAnnouncement metadata 深拷贝（:495-513）属 ToolSearch 族。

### C2 omz 现状与 MC 三端口
- 装配已存在但位置不同：conversation.ts:106-158 内联版 buildRuntimeUserEntriesFromTurn（与上游分类逐行等价、输出 shape 等价）；:64-104 buildUserContentFromTurn（含上游同款 video 分支）；:160-175 formatBrowserAmbientUserInput（两侧同源）。分类辅助在 conversation.ts:220+。
- 装配入口：methods/turn.ts:472（首发 addEntries）与 :446（model-only）；steering.ts:1400；control-only-turn.ts:64。
- 冷恢复侧未统一：session-history-hydrator.ts:229-301 仍内联装配（三处组装漂移的恢复侧）。
- omz message-history.ts（约 558 行导出面）已具备构件：systemReminderAttachmentEntry(:346)、realUserRuntimeMetadata(:334)、RuntimeMessageEntry 类型(:49-86)。
- MC 三端口接线：
  1. transform：挂点 methods/turn-loop.ts:119（providerEntries(:114)→runMagicContextTurnTransform→双投影 :131/:141）；core 派发器 runtime/helpers/magic-context-turn-transform.ts:221-237；bootstrap 实现 bootstrap/src/app/magic-context-turn-transform.ts（2241 行，rebuildEntry:783、isUnchanged:738、isAttachment:611、magicContextAttachment:829）；接线 create-app.ts:879/:1009；子代理透传 methods/subagent.ts:339-347。
  2. 提示词段：core runtime/helpers/magic-context-prompt-section.ts:78 ← methods/context.ts:115；实现 bootstrap 同文件 :1185 + 中文变体；接线 create-app.ts:1019。
  3. 工具描述：core runtime/helpers/runtime-tools.ts:80-90 → tool/handlers/index.ts:378-384；另 methods/embedded-search-branch.ts:48；实现 bootstrap :1272；接线 create-app.ts:1030-1031。
- 切上游形态后三端口重接清单：端口1挂点零改动（前提=生产者输出 shape 不变，已实证等价；不带 D4 字段则 transform 侧零感知）；端口2 零改动；端口3 零改动（tool-part-metadata/persistence 属 D4 须显式划出不移植）。
- C2 验收门禁：bootstrap/scripts/test-magic-context-turn-transform.mjs（test:magic-context）、magic-context/scripts/test-transform.mjs、test-magic-context-historian/absent-event/usage-projection.mjs、test:mc-section-zh/lifecycle/config-rpc/memories-rpc/ui-config/ui-model-picker、core test:magic-context-section/section-ctx-note/test:ctx-tool-descriptions/ctx-search-memory/ctx-memory-archive、adapters test-magic-context-boundaries/domain、ui magicContextPromptSurfaceOverrides.test.ts、services magicContextMemoriesDegradation.test.ts。omz core 无 hydrator/conversation 装配专用测试（实证空缺）。

### C1/C2 约束与风险
- 政策=UI 以 omz 为准：composerOptions 可选 prop；omz 版面（triggerLabel=fullLabel+prefix、compact 尺寸链、ChatContextUsage 位置）不动；旧消费点（settings/SubagentsSection、AutomationEditView、workflow-timeline、MagicContextSettingsFields）零破坏。
- 红线：contextUsage.tsx 原样保留；D4 剥离纪律；v3.15.1 基线问题（ModelConfigSelect 335 行 delta 打在 v3.15.1 上须人工适配）；providerMenu 可选回退；omz 测试基建（无 vitest）；max-lines 400（上游 823 行靠 disable；omz 须拆分或 disable 拍板）。
- 风险：hydrator 是冷恢复关键路径且无专用测试；ThoughtLevelCycleControl 去留产品拍板；窄屏 matchMedia SSR fallback；browserAmbient/video 与 omz 同源防「照上游删」误伤；attachments.ts 职责边界（只做解析/占位，无冲突）。

## 报告 2：远程家族（relay v2 + source-server R3 + B5）

### relay v2（+5347/−2596 src，5 managed 模块）
- 传输层：外部 Go relay 服务（zcode-server 仓库，不在本仓）+双端客户端。WS /api/v1/remote/ws2?token= 四类消息（auth_init/pair_status_query/data/error；下行 auth_ack/pair_status_ack/data/error），HTTP 四操作（register/list/delete device+token，JWT Bearer，一次性 16 字节 token 60s 有效）。心跳 5s±1s、ACK deadline 15s。二维码契约 sid/mid/name/app_version；V1 整体删除（relay-v2-pairing.md:71）。
- 模块切分（pairing.md:553-559）：shared web-remote-relay、desktop-main web-remote-relay、web web-remote-control、ui web-remote-control、ui components/mobile-ui。
- 桌面 device transport：generation/pairedGeneration 代际防护（webRemoteControlTransport.ts:41-42,:233）+退避+heartbeat watchdog。
- 外部依赖（pairing.md:613-620）：生产 Go relay 部署、网关 /api/v1/remote/ws2 精确路由（同 MID 同实例）、/remote/v4 OSS 版本目录、OAuth 回调白名单——四项全在基础设施侧。
- 上游 7 项真机矩阵全部未执行（pairing.md:624-636）。

### source-server R3（家族 +12957/−1159；核心去 packaging ≈+11926/−816）
- 生命周期：Transport Adapter 接口 probe/installOrUpdate/ensureDaemon/openChannel/exec/createFileTransfer（transportAdapter.ts:91-119）；SSH 走 ssh2 forwardOut、WSL/Docker 走 zcode server proxy-stdio；server CLI serve/status/stop/restart/update/uninstall + --daemon/--supervisor（zcode-server-cli/src/cli.ts:90-164）；握手三请求复用同一 HTTP keep-alive Duplex（serverRemoteDuplexTransport.ts:37-55）。
- 三层状态机：
  1. SourceServerConnectionManager（1460 行）owner 层：onlineBySourceServerId 单 owner 表+connectFlights+retry/offlineProbe timers；重连唯一事实源=「同一 sourceServerId 非在线→在线再次发布」（:1138-1161）；事件 onDidChangeState/onDidReconnect/onDidInvalidateConnection/onDidAppendOperationLog（:315-331）。
  2. host/index.ts wrapper（4158 行）：订阅 Manager 两事件，reconnect 重建 services 集合并向 handle 发 reconnectListeners（:2042-2060,:2173-2176）；invalidate 按 recoverable: reason==="update" 区分（:2036-2040）。
  3. WindowRemoteConnectionRegistry（上游 1777 行）：entry 持 closePhase "none"|"recovering"|"terminal"+transitionEpoch（:106,:114）；handle.onDidReconnect→handleConnectionReconnected→replaceDisconnectedSessions（新 remoteSessionId+generation+1，commit 不可逆边界 :931-939，失败回滚 :476-490）；begin/complete/failRecovery promise 屏障（:420-458）；epoch 捕获-校验贯穿（:884/:896-899/:1023-1026/:1286-1295/:1311），违例抛 WindowRemoteConnectionTransitionStaleError（:122-127）。
- 桌面 UX：ui/src/remote-connection-flow/（index 2185 行）、ui/src/remote/（remoteWorkspaceController intent 模型+remoteWorkspaceProjection 233 行）、ui/src/project-sidebar/ 13 新文件（Remote* ≈+1900）、重写 RemoteConnectionDialogContent(+570−)/RemoteConnectionFields(+1359−)/useRemoteWorkspaceHistory(+1577−)；删旧 mobile 面板（WebRemoteControlDialog −886、MobileTaskHome −986、TaskIndex −618）。
- includeArchived 替代语义：tasks 表持久化 archived 列（taskIndexRepo.ts:72,:86）；列表查询改 membership kind（:1310-1314：pinned=pinned=1 AND archived=0；archived=archived=1；timeline=pinned=0 AND archived=0）；API listArchivedTasks/deleteArchivedTask(s)/archive/unarchive+emitWorkspaceTaskListChanged（zcodeTaskServiceAdapter.ts:2552,:2966,:3068-3075）；协议 v4 TaskListMembershipKind（controller.ts:125-140）；zcodeSessionListParamsSchema 删 includeArchived（diff @:1961）；旧 repairSubagentTaskIndex.ts 整文件删除。注意：这套语义挂 task-index/project-storage/task-groups 新层，随项目组织主题走。
- omz 零基线（git ls-tree 0 匹配 source-server/relay v2 命名——但 relay v1 死 UI 残留见报告 4 补充）；omz 链：host/index.ts:2411-2414 connectRemote→server/src/remote/connect.ts:183 deployServer→createWindowRemoteConnectionHandle（host/index.ts:1304-1326 唯一实现，已含 dispose）→windowRemoteConnectionRegistry（787 行旧形态：无 closePhase/epoch/recovery，handleConnectionClosed 直接置 disconnected 删 entry :364-384；CloseEvent 无 recoverable :17-21）。
- omz 自研手动重连替换流：host/index.ts:2047-2092 connect 成功后找同 workspacePath+identity 的 disconnected session 逐个 replaceDisconnectedSource——无原子性、无 epoch 守卫（上游 R3-ISSUE-011 同款）。
- omz 无 serverRemoteConnection.ts（上游 424 行双形态握手）；仍保留上游已删 legacyRemoteWorkspaceRpcContract.ts/remotePromptAttachments.ts。
- omz connect() 竞态实锤：registry :525-531——await entry.ready 与 await prepareWorkspaceRuntime 两窗口内 onDidClose 可触发，但 connect 恢复后无条件 session.state="online"（:527 仅查身份不查 entry 存活）。cancelConnect 仅 ssh+connecting 有对象身份防护（:575-583），wsl/docker 迟到 completion 未验证。

### 分期切割（三期）
- 一期（≈3300 行）：shared source-server 契约（893）+server 861+desktop duplex 164+serverRemoteConnection 166+packaging 531+daemon serve --daemon——产出 daemon+安装升级+隧道握手，无 UX 不动旧链。
- 二期：ConnectionManager 薄 owner 层+registry 恢复状态机/epoch（≈+990）+remoteWorkspacePreparation+schema 迁移两支（230，仅采纳时）。
- 三期：sourceServerDirectory 1487+aliasRepo 2355+identityMigration 318+entriesBySourceServerId+ui remote-connection-flow/project-sidebar Remote*（≈+5000）+includeArchived→membership+relay v2（独立特性）。
- relay 与 source-server 是两条不相干产品线（relay=手机远控+外部 Go 服务；source-server=SSH/WSL/Docker daemon），不存在「relay 先行」的地基关系。
- B5 评估：R3 采纳→B5 并入（registry 重写带入 epoch+恢复状态机）；R3 不采纳→最小形态 30-60 行（entry 加 epoch，connect() 首个 await 前捕获、commit online 前校验）。
- 体量表：R3 全家族 +12957/−1159；核心 +11926/−816；relay src +5347/−2596；上游 host/index 4158 vs omz 2434（差≈1700）；registry 上游 1777 vs omz 787（差≈990）。
- 风险：两套主链并存（deployServer vs daemon，上游语义 R3 内不保留旧主链）；ConnectionManager 裁 Directory 后 sourceServerId 稳定性需设计；fork 分叉冲突面（replaceDisconnectedSource vs replaceDisconnectedSessions）；workspaceIdentity 冲突（上游 remote:server:<sourceServerId>:<path> 强制改写 vs omz workspaceIdentity?.trim()||workspacePath）；relay 真机证据为零；上游 24 条 open issues（R3-ISSUE-005/006/011/020/021/023/024 registry 恢复相关高 bug 密度）。

## 报告 3：虚拟项目 + ToolSearch + i18n

### 虚拟项目
- 服务/存储层（全新，omz 零基线）9+2 目录 84 文件 +7562：project-storage/ 25 文件 +2878（node:sqlite ProjectRepository）；project/ 10 文件 +1274（IProjectService，ServiceChannels.Project）；task-groups/ 8 文件 +756；remote-projects/ 12 文件 +1373（source-server 耦合段）；bot-project-runtime/ 6 文件 +393（同耦合）；project-workspace-navigation/ 6 文件 +423；task-facts/ 7 文件 +432；project-catalog/ 7 文件 +120；window-project-directory/ 6 文件 +87；source-server-{management,workspace}/ 4 文件 +417。
- 配套：shared/sqlite-migrations/（12 文件 +906，通用迁移框架，消费者横跨 CLI 与 services 与协议层 :4346）；desktop/host/database-startup/（8 文件 +413，omz 对应物=旧摆放 hostDatabaseStartup.ts+databaseStartupCoordinator/startupDiskSampler 分叉）；services/session/tasksDatabase（omz 已有；上游 migrations.ts +205/−107、新增 controller-remote-schema-v4 +17 与 source-server-schema-v5 +213、删 startup.ts −124）。
- 协议层 VirtualProject/ProjectTree/ProjectRepositoryContract 不在 shared，全在 services 包内。
- UI 骨架 project-sidebar 71 文件 +10765：37 组件（ProjectNode/ProjectEditor 723L/ProjectComposerMenu 630L/TaskGroupedView 507L+Remote* 7 件+Archive* 2 件）+20 hooks+grouped/ 19 文件；上游 WorkspaceSidebar.tsx 替换为 2 行转发；净删旧侧栏 12 文件 ≈−8260（WorkspaceSidebarItem 1210、GroupedTasksSection 1946、TimelineTasksSection 1058、PinnedTasksSection 769 等）+删 remotePinnedTaskStore/remoteTimelineTaskStore（−371）。
- 消费链：useProjectTree.ts:11 走 useBaseWorkspaceServices 不碰 DB。
- 「存储照搬 vs UI 保 omz」边界：照搬=sqlite-migrations+7 目录（project-storage/project/project-catalog/task-facts/task-groups/project-workspace-navigation/window-project-directory）+database-startup+tasksDatabase 换代+zcode-protocol 迁移类型 re-export（该 7 目录对 source-server 0 命中）；保 omz=project-sidebar 组件层/app-shell 壳层（WorkspaceShellLayout）/workbench/useAppPanels/tabStore；灰色带=remote-projects+bot-project-runtime（+1766）与 project-sidebar Remote* 7 组件+useProjectRemoteSync（引用 sourceServerId 10 文件）。
- tasksDatabase 挂 desktop host 侧（tasksStorageWorker/database-startup），CLI 与 host 各有迁移链共用 sqlite-migrations——移植存储层必须连带 host 启动挂载。

### ToolSearch
- 体量：源码 12 文件约 +900（core/src/tool/search/ 5 文件 531+deferred 三件 194+contracts 94+adapters 30+hydration 29+handlers/tool-search.ts 80）+设计文档 736；集成改动 ~20 文件 +700/−150；测试 28 CLI 用例 +~5600、desktop e2e 37+ 文件、prompt-trajectory +427——测试占 82%+（合计 ~14k）。
- 接缝：上游 turn-loop.ts 把请求组装从 buildRuntimeProviderRequestMessages 换成 prepareRuntimeProviderRequest（工具暴露决策内化再投影）+buildToolSearchAnnouncement 公告块；omz 对应 turn-loop.ts:119（runMagicContextTurnTransform）→:131/:141——MC transform 恰在暴露决策与投影之间。
- 与虚拟项目完全独立（8 源文件对 project*/source-server 0 命中）；contracts/src/model/index.ts +17（tool_reference/deferLoading/toolSearchEnabled）；UI 侧仅 T08 resolveRenderer 分流与 settings.toolSearch 4 键。
- 陷阱：上游 turn-loop diff 混入 refreshOffPeakTurnAfterTakeover（omz 已删）与 persistRuntimeReminderMessage/buildProjectionAnchor；message-history.ts +202 与 C2 共享同一文件。

### i18n（实测 HEAD=1ff8cad9）
- zh：上游 6982/omz 5936/共有 5709；上游独有 1273、omz 独有 227（旧报告 228）、值不同 159。en：上游独有 1277/omz 独有 227。
- 上游独有 1273 分桶：死桶约 60%（settings.source 161+sourceServer/server 18+remote.* 大半+webRemoteControl 73+conversationShare 54+manualClaimPlan 49+genUi 21+pluginUi 14+marketingTouch 7+rewards 5+chat.highspeed 14+chat.contextCompaction 8）；通用约 40%（chat.toolCall 70、chat.permission 20、settings.memory 36、settings.modelProvider 30、settings.plugins 13、settings.dynamicWorkflow 9、sidePane 20、browser 47、project 85+archives 29+taskGroup 17+workspaceSidebar 17、settings.toolSearch 4、preview 6、fileManager 5、ssh 12+docker 2 等）。
- omz 独有 227 位置：settings 103、chat 26、workspaceSidebar 24、modelTrajectory.* 18（轨迹面板，一条不能丢）、taskList 15、conversationShare 14（死键）、remote 14、v4Pane 4。
- 上游有 1 个 omz 没有的 modelTrajectory.source.compact 键；27 个上游独有键值含 zcode/ZCode 字样（品牌改写面）。
- 机械方案：按 key 挑拣脚本（禁三方 merge-file）；omz 227 键硬断言；159 值冲突逐键仲裁（默认上游新文案+品牌改写；轨迹面板保 omz）；清 14 conversationShare 死键；产出四栏报告；上游 locale 头 @/request-security-edition/messages.js import 视产品线剔除。

### useAppPanels/workbench
- useAppPanels.ts +240/−189（30 hunk）：side-pane tab 作用域化（currentSidePaneScope/ownerTaskId/isSidePaneTabVisibleInScope/closeSidePaneTabForScope）+折叠态记忆（isSidePaneCollapsed×taskSidePaneMemory）+文件面板/新 tab/插件市场入口+office mode；0 个 project 符号——T03 面板体系演化，不与虚拟项目直接耦合。omz 1618 行/workspaceSidePane.ts 2232/tabStore 656 在场。
- workbench：上游 v4 布局系 8 文件净简化 +46/−407（WorkbenchPane −166、workbenchSessionPlacement −147、workbenchDragDrop −37）且删指针拖拽三件套（workbenchPointerDragDrop/workbenchPointerPositionTracker/workbenchNewTaskTarget）；omz 12 文件对两上游版本全 hash 分叉且持有上游已删三件套。
- 体量总表：存储核心 57 文件 +4243（含测试 +3183，22 文件）+配套 ≈+5.8k 零 source-server；remote-projects+bot-project-runtime 18 文件 +1766；project-sidebar UI 71 文件 +10765；壳层接线 ~35 文件 +3528/−8636；workbench 增量 6 文件 +46/−407；ToolSearch 源码 ~+1600/−160、测试 ~+13400；i18n 目标增量 +400~600 键。
- 风险：虚项目最大风险在壳层融合（WorkspaceShellLayout omz 残差 4057 行、上游 +2388/−2538 冲突块 57）；omz workbench 分叉且持上游已删文件；tasksDatabase 换代数据迁移（两链合流按 B7 口径）；测试须逐条重写 scripts/test-*.mjs（omz 无 vitest、无 packages/desktop/test/e2e）；architecture-policy.yaml 登记（上游 module.ts 形态 omz 不适用，否则 pnpm architecture:check 失败）；shared package.json 需加 ./sqlite-migrations 子路径（现状 18 exports 无此项）；max-lines 400 对大文件（project-editor 723L 等）适用。

## 报告 4：office-runtime + B7 + 品牌/约束面

### office-runtime（上游）
- @zcode/office-runtime@0.2.0 private MIT，apps/zcode-cli/packages/office-runtime，90 文件（77 码文件 431KB、fixtures 97KB、+13258）。依赖全在 devDependencies（构建期 esbuild 打进插件 dist，无运行时 npm 分发）。
- 结构：contract.ts（OFFICE_RUNTIME_OUTPUTS=["dist/server.mjs","dist/ui/assets.json","dist/ui/panel.html"]）；adapters/main.ts（每插件一个 stdio MCP server，@modelcontextprotocol/sdk@1.29.0，读 ZCODE_WORKSPACE_ROOT，4MiB 分块导入 .zcode/document-imports/<uuid>/、100MiB 上限）；parse/{docx,xlsx,pptx,pdf,ooxml,dommatrix}+domain/{anchor,cjk,model,text}（kind-filter 行级裁剪 build.mjs:81-88）；ui/main.tsx+viewers/{Docx,Pdf,Pptx,Xlsx}View.tsx+shell+panel.css（~1301 行）。
- 构建（scripts/build.mjs 269 行）：每插件三产物（面板 UI IIFE 切 4MiB bundle-N.txt+assets.json；bootstrap IIFE 内联 panel.html；server ESM node24）；exceljs 流式依赖以桩模块替换；PDF 复制 pdfjs cmaps/standard_fonts/wasm+worker+≥50 片 Noto Sans SC woff2（build.mjs:54-67）；xlsx 复制 react-xlsx worker+sheets.wasm；两个版本钉死源码补丁（react-xlsx worker URL :117-121、pdfjs canvas 字体链 :132-152，needle 失败即抛错）；THIRD_PARTY_NOTICES.txt 随 metafile。
- 插件声明 pdf-plugin/.zcode-plugin/plugin.json:15-40（mcpServers stdio node ${ZCODE_PLUGIN_ROOT}/dist/server.mjs + ui.surfaces ui://pdf/panel.html + availability:"session"）。
- 仓内消费：4 插件 package.json+bootstrap official-plugin-definitions.ts（OFFICIAL_OFFICE_VIEWER_RUNTIME_PATHS :68、四条目 :232-248）+三份资产清单（cli/scripts/sea-official-plugin-assets.mjs:20-21、desktop/scripts/prepare-agent-node-bundle.mjs:100-167/:356、server zcodeAgentOfficialPluginAssets.ts:92-117）。
- 面板宿主=MCP Apps 栈：desktop/src/main/pluginSandbox、shared/src/mcp-apps、ui/src/plugin-ui、services/src/plugin-ui-bridge——omz 四者全无（v3.15.1 基线就有，omz 从未有）。
- omz 落地面：聊天内文件预览同款技术栈且平价（PreviewPane.tsx+previewPaneOffice{Docx,Xlsx,Pdf,Pptx}Content.tsx+pptxRendererPreviewEngine.ts；docx-preview renderAsync、@extend-ai/react-xlsx+wasm?url、pdf-viewer、@aiden0z/pptx-renderer/browser；7 文件 6 identical，仅 officeFilePreview.ts sanitizeDocumentLinks 收窄差）；v3.16 增量只有 PreviewPane.tsx +269/−217（header portal/resolvePreviewPaneImageFileReference/test-ids 导入）；official-plugin 基建在场（definitions/runtime/cache-fs/seed-lock，四文档插件 0.1.7 无 viewer 面）；pnpm-workspace 已含 glob、turbo.json build=^build+dist/**（office-runtime build 仅 tsc --noEmit）。
- 依赖：omz 已有 pdfjs-dist 5.4.296/docx-preview ^0.4.0/react-xlsx ^0.16.0/pptx-renderer 1.2.4/playwright-core 1.59.1/zod/esbuild/react 19.2.7；真正新增仅 7 个：@fontsource/noto-sans-sc 5.3.1、exceljs 4.4.0、fast-xml-parser 5.11.2、jszip 3.10.1（inventory 已有）、@modelcontextprotocol/sdk 1.29.0（注意 browser-use 用 server/client 2.0.0 双版本线并存）、core 2.0.0（inventory 已有）、ext-apps 2.0.0（全新）。
- 体积估算：每插件 dist pdfjs 数据 15-25MB+Noto 5-10MB+xlsx wasm 1-2MB+bundle 1-6MB；四插件合计数十 MB；SEA 资产清单四处同改漏一处即残缺（seed fail-soft 回退旧缓存）。

### B7 四条迁移
- 新 runner：上游 migrations.ts 310 行 async 化+scope 三分（"base"|"controller-remote"|"source-server" :123）委托 @zcode/shared/sqlite-migrations；迁移前备份 <dataRoot>/backup；scope 调用方 controller-remote 仅 controllerRemoteIdentityMigration.ts:242、source-server 仅 sourceServerWorkspaceAliasRepo.ts 6 处——后两条服务方全为 R3 家族。omz：同步 runner、startup.ts 在、无 scope（automationRepo.ts:288、taskIndexRepo.ts:530、startup.ts:76 三调用点）。
- checksum 同源复验：omz migrations.ts:98-100 与上游 :165,168 均 sha256(JSON.stringify(checksumInput))。
- 四条：①0004_project_execution_scopes（base，automations/off_peak_tasks 各加 3 可空 TEXT 列，checksumInput=[executionColumns,"nullable-text-v1"] migrations.ts:51-58,98-114，PRAGMA 幂等）②0006_task_group_admissions（base，task-groups/migration-v6.ts 10 行独立冻结 SQL 建表，上游故意跳 0005）③0004_controller_remote_identity（17 行审计表）④0005_source_server_workspace_schema（213 行 6 表+v1/v2 账本 11 hasColumn 探测）。
- 撞号：base 与 controller-remote 同号 0004 写同一账本 tasks_schema_migration；完整 ID 不同不触发冲突；areApplied 只校验本 scope ID 集（:257-268）；databaseMigrationIdSchema ^[a-zA-Z0-9_-]{1,128}$ 对编号无约束（omz shared/database-startup.ts:96）。
- 红线复验：schema-v1.ts 两侧唯一差异=omz 多 8 行模板字面量外中文注释；official-glm-selection-v3.ts 逐字节相同（sha256 a873c857d5dcd4e3）——当前提交点照抄两文件不改 checksum，但红线降为冻结纪律保留；真实陷阱=不得整抄上游 migrations.ts（async+scope+硬编码 appVersion "3.12.0"），只以冻结 checksumInput 原文追加 0004/0006 进 omz definitions。

### 品牌/约束面（全量扫描 aac47556..3c5b2276，26MB patch、3919 文件有新增行）
- 新增行 671 处 .zcode 字面量/242 文件（生产码 39 文件多属 D1/D2/D3）；ZCODE_SESSION_DB/ZCODE_SESSION_DB_PATH omz 0 命中（A6 移植须重写路径/env 推导）；其他 omz 缺失生产键：ZCODE_JWT_TOKEN_KEY/ZCODE_JWT_INVALID_BROADCAST_CHANNEL、ZCODE_MIGRATION_BACKUP_SKIPPED、ZCODE_CREDENTIAL_KEYS、ZCODE_WORKSPACE_ROOT、ZCODE_PLUGIN_ROOT/ZCODE_PROJECT_DIR（manifest 占位符 omz 3 处在用）、ZCODE_COMPATIBILITY_MANIFEST/ZCODE_ERROR_CODES；omz 已有：ZCODE_DATA_BASE_DIR/STORAGE_DIR/PERSONAL_PROVIDER_CONFIG_FILE/BUILTIN_PROVIDER_CONFIG_FILE/OFFICIAL_PLUGIN_MARKETPLACE(23 处)。omz 保留 ZCODE_* 键名（shared 117 键）。
- patchedDependencies：omz 2 条 vs 上游 6 条；可带 @radix-ui/react-collapsible@1.1.12；不带 vitest@4.1.7/wdio-electron-service@9.2.1；禁带 @arms/rum-electron@0.0.3（遥测红线）；上游 patches/@open-pencil__core@0.14.0.patch 未登记进 patchedDependencies（上游遗留）勿照目录整拷。
- Node 24.14.0/pnpm 10.33.2/react 19.2.7 两侧一致。
- 遥测成对面（import 级，不拿遥测文件则编译断）：①bootstrap conversation-telemetry-facts.ts（上游 760 行 vs omz 152，sanitizeTelemetrySkillName omz 已删；omz v4-gateway.ts:150 在用 Normalizer）②shared/validation.ts←mobilePluginDiscoveryTelemetrySchema ③shared/telemetry.ts←redactTelemetryText（telemetryRedaction.ts 258 行 omz 无）④shared/web-remote-control.ts←MobilePluginDiscoveryTelemetry ⑤ui PluginStorePage/RemotePluginSyncDialog/plugin-ui←withPluginTelemetry+appTelemetry（随 MCP Apps 栈不引即消解）⑥bootstrap telemetry.ts←sanitizeTelemetrySkillName ⑦core title-generation-sidecar.ts←AgentTelemetryCausation（D6 off-peak 家族）。

### 报告 4 补充（主代理核验后追加，2026-10-23）：relay v1 死 UI 残留（omz 实存）
- packages/ui/src/WebRemoteControlDialog.tsx（「移动端远程控制」对话框）；packages/ui/src/WorkspaceWebRemoteControlTrigger.tsx（触发器）；packages/ui/src/WorkspaceSidebarFooter.tsx（入口消费方）；i18n webRemoteControl.* 15 键×2 locale（zh :1630-1644：trigger/title/description/botChannel.{title,description,weixin,feishu,lark,telegram,configure,manageBots} 等）。
- 无任何后端（transport/auth/服务器 0 命中）；上游 v3.16 已删该对话框（−886）与 MobileTaskHome（−986）。清理=2 组件+侧栏入口+i18n 15×2+Bot Channels 死链核验。
