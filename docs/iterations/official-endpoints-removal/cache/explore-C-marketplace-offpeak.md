# 探索报告 C：插件市场 CDN 链 + 闲时任务/自动化

子代理：Explore（readonly）。HEAD=ba7c240（v0.1.1）。日期：2026-10-05。

## 1）探索范围

**A. 插件市场**：shared/src/plugin-marketplaces.ts（全文）、contracts/src/plugins/index.ts（全文含 S32/S33 别名注释）、bootstrap/src/app/official-plugin-definitions.ts（全文 394 行）、adapters/src/plugins/official-marketplace.ts（全文）、adapters/src/plugins/marketplace.ts（260-440 段）、bootstrap/src/app/bundled-plugins.ts（330-450 段）、bootstrap/src/plugins.ts（470-590、960-1200 段）、adapters/src/plugins/index.ts（845-891 scanOfficialCache）、ui/src/settings/PluginStorePage.tsx、PluginAddMenu.tsx、adapters/scripts/test-plugin-marketplace-official-alias.mjs。

**B. 闲时/自动化**：services/src/session/offPeakServerClient.ts（全文）、desktop/src/main/desktopCronScheduler.ts（全文）、desktop/src/scheduler/index.ts、shared/src/automation-types.ts、shared/src/bots.ts、ui/src/settings/AutomationsSection.tsx、ui/src/hooks/useOffPeakEligibility.ts、bootstrap/src/zcode-protocol/offpeak-port.ts、adapters/src/model/offpeak-retry.ts、core/src/tool/handlers/off-peak.ts、core/src/runtime/methods/turn-loop-state.ts/turn-loop.ts、services/src/accessor.ts、services/src/node.ts 装配段、desktop/src/main/remoteCdn.ts。

全仓 grep：cdn-zcode、offPeak 系、zcode-plugins-official、off_peak_tasks、isOffPeakToolSupported、DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS。

## 2）现状实现摘要

### 2.1 市场身份与 CDN 源
- **双 ID 并存**：shared/plugin-marketplaces.ts:10 与 contracts/plugins/index.ts:7 各自硬编码 `"oh-my-zcode-official"`（canonical，两处独立字面量）；contracts:16 `ZCODE_LEGACY_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official"`（S33 CDN 过渡别名）。commandsService.ts:47、skillsService.ts:55 还有第三、四次硬编码。
- **CDN 源唯一落点**：shared/plugin-marketplaces.ts:37 `source: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json"` —— DEFAULT_PLUGIN_MARKETPLACES 唯一默认市场记录，ensureDefaultPluginMarketplaces()（marketplace.ts:283）唯一 seed 输入。
- CDN 资产 URL（图标）：official-plugin-definitions.ts:58 `OFFICIAL_PLUGIN_ASSETS_BASE_URL`、ui/v4/featureSuggestedPrompts.ts:11 同源。desktop/src/main/remoteCdn.ts:4 是 **Electron release 包下载，与市场无关，勿一起删**。

### 2.2 分片/合并/断言链
adapters/src/plugins/official-marketplace.ts 三分片于 `<storageRoot>/marketplaces/oh-my-zcode-official/`：bundled-marketplace.json（seed 写入）、cdn-marketplace.json（CDN 刷新）、marketplace.json（合并产物）。
- rebuildOfficialMarketplaceSync()（:60）：CDN 条目优先，同名滤掉 bundled，name 归一 canonical。**删 CDN 后退化为「读 bundled→写 merged」，可简化不能整函数删**（loadBundledOfficialPluginRootsSync 是运行时加载官方插件的承重函数）。
- assertOfficialManifest()（:118）= S33 别名容忍，接受 canonical∪legacy。删 CDN 后 legacy 分支整体摘除。
- CDN 写盘唯一入口 marketplace.ts:396-403，条件 isOfficialMarketplaceId(loaded.manifest.name)——用户自建同名市场也会走，删后该分支应收紧为只对受信任 canonical 刷新生效。

### 2.3 本地安装路径（不依赖 CDN，必须保留）
- 目录扫描 discoverNodePluginsSync：config.plugins.dirs + .zcode-plugin/plugin.json（ZCODE_MANIFEST_PATH，index.ts:100）。
- 官方 seed 目录 `<storageRoot>/cache/oh-my-zcode-official/<name>/<version>/`，由 bundled-plugins.ts 从 filesystem/SEA 资产复制，零网络。
- 非官方市场源全支持：url/github/git/npm/file/directory（PluginMarketplaceSourceConfig，contracts:90-96）；file/directory 即手动放目录。addMarketplace 解析在 marketplace.ts:255-272。
- UI 手动添加：PluginAddMenu.tsx → AddMarketplaceSourceDialog → addMarketplace（PluginStorePage.tsx:331）。

### 2.4 市场页 UI 的 CDN 依赖点
- PluginStorePage.tsx:128-139 唯一主动 CDN 拉取（claimMarketplaceAutoRefresh 10 分钟节流入页自动刷）→ 删整块 effect。
- :306 顶栏手动刷新 updateMarketplace(null) 刷全部 → **保留**（自建源要能刷）。
- ui/settings/officialMarketplaceAutoRefresh.ts 整文件删。

### 2.5 官方插件运行时加载（完全离线，绝对不能误伤）
adapters/src/plugins/index.ts:852-891 scanOfficialCache()：先 loadBundledOfficialPluginRootsSync（读 bundled 分片 cachePath 只加载当前版本）→ 兜底 readdirSync 全扫。bootstrap/plugins.ts:256,907 与 startup-marks.ts:25 通过 resolveOfficialPluginRoots() 直接注入 officialPluginRoots（contracts:287）是**另一条独立通道**。

### 2.6 offPeak 远端链
offPeakServerClient.ts 五端点 `{origin}/api/v1/off-peak` 下 ticket/availability、ticket、ticket/status、ticket/{id}/settle；凭证 OffPeakCredentialSnapshot（JWT + x-coding-plan-api-key）。装配 services/src/node.ts:2485-2546（client+Repo+Service+startSync）。

**offPeak 与 cron 已是两个独立子系统**：数据表 off_peak_tasks vs automations/automation_runs；Repo OffPeakTaskRepo vs AutomationRepo；协议方法 offPeakCreate/offPeakList vs automation/*；消息 offpeak-dispatch-request/result vs cron-dispatch-request/result；状态机 offPeak 无 misfire-skip、cron 有 MISFIRE_GRACE_MS=5min；结算 offPeakDispatchSettlement.ts 独立。唯一耦合=同一 scheduler 进程（scheduler/index.ts tick() :97-102 夹带 offPeak claim）+ 同一 desktopCronScheduler 管理器。

### 2.7 纯本地 cron 能独立工作
**能**。AutomationRepo/automationCron(Validation)/computeAutomationNextRunAt 只读写 tasks-index.sqlite；tick() 的 claimDue+claimManualRuns 零网络；派发走 HostMessageTypes.CronRun → 本地 host createTask+sendPrompt。删 offPeak 后 tick() 只需删 :97-102 四行和 OffPeakTaskRepo 导入。

### 2.8 UI 上 Cron 与 OffPeak
同一设置页同一组件：AutomationsSection.tsx 内部路由 AutomationsTab="scheduled"|"idle"（:224），AutomationsView 含 offpeak-create/offpeak-edit mode。resolveVisibleAutomationTabs()（:229）已支持只显示 ["scheduled"]；offPeakVisible===false 时 idle tab 自动隐藏。删后退化为单 tab 列表。

### 2.9 bots 与官方端点
**services/src/bots/ 整目录零官方端点依赖**（grep https://|api.|z.ai|bigmodel|offPeak 全零命中）。走 Telegram/Feishu/Lark/Weixin/Webhook/Discord/WeCom 第三方 IM，凭证本地。**划为不动区**。bot 与 automation 唯一交集 BotDeliveryTarget（bots.ts:41-52）= cron 跑完回推 IM，纯本地，完整保留。

## 3）与需求相关的约束

1. marketplace id 是多处硬编码（shared:10、contracts:7、commandsService:47、skillsService:55、definitions 全部 id 拼接）。**不要顺手改 canonical 值**——它是磁盘目录名（marketplaces/、cache/oh-my-zcode-official/）和已装插件 id 后缀（enabledPlugins 落盘 browser-use@oh-my-zcode-official），改名打断存量启用态与缓存路径。
2. DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS 两份（plugin-marketplaces.ts:13 手写 vs definitions:370 派生）有 bootstrap 单测机械对照，删 CDN 不影响但必须保持对齐。
3. requiredSeedPaths 是 seed 完整性闸门（filesystem/SEA seed 缺项拒绝生成残缺缓存），与 assertOfficialManifest 同名易混——**删 CDN 只能动后者**。
4. offpeak-retry.ts:15-18 OFF_PEAK_TICKET_EXPIRED_MARKER 与 shared/off-peak-types.ts 同值常量必须同步删，不能只删一边。
5. shared/zcode-protocol-v4/telemetry.ts 仍有 7 处 offPeak 命中，需确认为残留一并清。
6. IServiceAccessor.offPeakTaskService 是**必填字段**（accessor.ts:76）。删时必须同 commit 改接口 + client/remoteServiceAccess.ts:81,180 ProxyChannel 注册 + UI useServices() 消费点。
7. .env.example:8,14 的 ZCODE_CDN_BASE_URL/ZCODE_REMOTE_ASSET_CDN_BASE_URL 是 release 包下载，与市场 CDN 两个东西，归属另一责任块。

## 4）变更影响面

### 4.1 删 CDN——必须删
| 文件 | 动作 |
|---|---|
| shared/plugin-marketplaces.ts:32-42 | DEFAULT_PLUGIN_MARKETPLACES 的 CDN source（建议：数组结构保留、内容空数组+注释留扩展位，见 Q1） |
| adapters/plugins/official-marketplace.ts:29-36 | writeCdnOfficialMarketplacePartitionSync |
| 同 :9 | CDN_PARTITION_FILE |
| 同 :62-80 | rebuildOfficialMarketplaceSync 的 CDN 分支 |
| 同 :118-132 | assertOfficialManifest legacy 分支（断言收紧为只认 canonical） |
| contracts/plugins/index.ts:16 | ZCODE_LEGACY_OFFICIAL_PLUGIN_MARKETPLACE |
| 同 :38-45 | isOfficialMarketplaceId 扩集分支；isCanonicalOfficialMarketplaceId 若无他调则合回 |
| adapters/plugins/marketplace.ts:396-403 | CDN 写盘分支（收紧为受信任 canonical） |
| 同 :345-395 | trustedId/officialRefresh 守卫的 legacy 注释与分支 |
| ui/settings/officialMarketplaceAutoRefresh.ts | 整文件 |
| ui/settings/PluginStorePage.tsx:128-139 | 自动刷新 effect |
| adapters/scripts/test-plugin-marketplace-official-alias.mjs | 整文件（专测别名容忍） |
| bootstrap/official-plugin-definitions.ts:58 | OFFICIAL_PLUGIN_ASSETS_BASE_URL 及 9 处 icon 引用（降级字母头像） |
| ui/v4/featureSuggestedPrompts.ts:11 | ASSETS CDN 前缀 |

### 4.2 删 CDN——必须保留（勿误伤）
official-marketplace.ts 的 writeBundledOfficialMarketplacePartitionSync(:17-27)、loadBundledOfficialPluginRootsSync(:38-58 承重)、rebuildOfficialMarketplaceSync(:60-83 简化)；adapters/plugins/index.ts scanOfficialCache(:852-891)、ZCODE_MANIFEST_PATH(:100)；marketplace.ts 非官方源解析(:230-272)、ensureDefaultPluginMarketplaces(:283-304 留函数删 source)；bootstrap/plugins.ts 市场 CRUD；bundled-plugins.ts 全文；definitions 的 requiredSeedPaths/rootCandidates/hostMcpServerNames/defaultEnabled；PluginStorePage.tsx:306 手动刷新；PluginAddMenu；plugin-creator 的 upsert-dev-marketplace.mjs（纯本地 dev 市场）。

### 4.3 official-plugin-definitions 硬编码清单去留
- **(a) OFFICIAL_PLUGIN_DEFINITIONS 数组本体：完整保留**——是内置插件 seed 定义（复制哪些文件/版本/宿主 MCP 注入/requiredSeedPaths 闸门），与市场源正交。删了官方插件（browser-use、zcode-guide、文档四件套、node-repl-host）立刻无法加载。
- **(b) listing 字段：瘦身不删**——icon 去掉（UI 降级字母头像）；displayName/displayName_i18n/description_i18n/category/author 保留（零 CDN 依赖）；author `{name:"Z.ai"}`(:57 ZAI_AUTHOR) 需改本项目标识。
- **(c) DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS 两份对账：完整保留**。

### 4.4 删 offPeak server——影响面
**整删**：services/session/{offPeakServerClient,offPeakMockGateway,offPeakRuntimeModel,offPeakTaskService,offPeakTask,offPeakTaskRepo}.ts；model-provider/offPeakModelSelectionView.ts；shared/off-peak-types.ts；contracts/interfaces/off-peak.port.ts、contracts/tools/off-peak.ts、session.events.ts 相关；core/tool/handlers/off-peak.ts（注意 T1）；bootstrap/zcode-protocol/offpeak-port.ts；desktop/scheduler/offPeakDispatchSettlement.ts；desktop/host/offPeakDispatchPlan.ts；ui OffPeak*.tsx 4 个、offPeakUiPresentation、store/offPeakTaskStore、useOffPeak* 2 个、renderers/offpeak-create.tsx；adapters/model/offpeak-retry.ts；tasksDatabase schema-v1.ts:148-186 **迁移历史不可删只能停止新增**。
**瘦身**：desktop/scheduler/index.ts（:8-9 注释、:15 import、:48-54 状态、:97-102 claim、reportOffPeakActiveCount、handler）；schedulerProtocol.ts（offpeak-* 消息）；desktopCronScheduler.ts（OffPeakRunResultPayload:24-31、onOffPeakActiveCountChanged:43、handleOffPeakRunResult:50,:196-198、:93-96、:148-184）；desktop/main/index.ts（forwardOffPeakRunResult:569、wakeOffPeakScheduler:577、:1554-1556、:1791）；desktopHostProcess.ts（:209-210、:220、:472-490）；desktop/host/index.ts（:442 终态回写+OffPeakRun 分支）；services/node.ts（:252-269 exports、:391/:435-445 imports、:651-674 auth builder、:1309 wake hook、:2065-2088 tool wiring、:2348-2380 凭证 resolver、:2411-2546 DI、:2593、:2648、:2682）；accessor.ts（:1、:75-76）；client/remoteServiceAccess.ts（:81、:180）；services/index.ts（:230、:242-243）；ui/AutomationsSection.tsx（idle tab 体系整删：AutomationsTab 收窄 scheduled、AutomationsView 删两 mode、resolve* 简化、:545/:612-637/:649/:673/:795-802/:1315）；ui/App.tsx（:66 useOffPeakTaskNotifications）；core/tool/handlers/index.ts（:48/:95-96 注册、:183 注释）；core runtime/types.ts:722、tool/types.ts:135、executor/types.ts:166 的 offPeakTurn 字段（见 T1）；bootstrap/zcode-protocol/*（off-peak-tool-policy.ts、server.ts:252、server-types.ts:136、server-operations.ts:3273、v4-bridge.ts:1101,1121、types.ts:236、handlers/session-mgmt.ts:53）；zcodeAgentService.ts 80 处命中（isOffPeakToolSupported:3203、:348/355/374/385 omit 名单）；automationToolPolicy.ts offPeak 分支；shared/zcode-protocol-v4/command.ts（:62、:104-123）；zcode-task-types.ts:63 isOffPeakTask；channels.ts/validation.ts/test-ids.ts；i18n en/zh 各删 91 条 offPeak.* key；coding-plan-subscription.ts + services/coding-plan-subscription/* 的 OffPeakClientConfig 与 mock 分支（:222/:1326-1339）；config/provider/zcode-builtin.json offpeak 段；scripts/desktop-typecheck-baseline.txt 相关条目。

## 5）风险与疑点（承重面陷阱）

- **T1【高】assertNotOffPeakTurn 有两个非 offPeak 调用方**：core/tool/handlers/send-message.ts:13,50 直接 import；bash.ts:128 读 context.offPeakTurn 禁后台任务。这是「闲时轮禁止递归派生/后台任务」纵深防护，与闲时无关。删 off-peak.ts 时必须把 assertNotOffPeakTurn 挪中立位置或删两调用点，并同步清 offPeakTurn 传递链（runtime/types.ts:722、tool/types.ts:135、executor/types.ts:166、call-runner.ts:334、batch-runner.ts:43、turn-tools.ts:181、streaming-tool-coordinator.ts:291）。**只删 tool entry 留 executor 字段是最小改法。**
- **T2【高】OFF_PEAK_QUERY_ID_PREFIX 在 turn-loop-state.ts:109 作兜底判据**。isOffPeakCreateRestrictedTurn 三重信号（offPeakTaskId/traceId 前缀/denylist 哨兵）全删；勿混同 :99 isAutomationMutationRestrictedTurn（cron 的，必须留）。
- **T3【高】官方插件缓存目录名=marketplace id，三处独立硬编码**：official-marketplace.ts:42、adapters/plugins/index.ts:869、shared/node/officialPluginCache.ts:20，外加 commandsService.ts:259、skillsService.ts:691、subagentsService.ts:437 旁路。误改 id 或删路径推导 → 官方插件 skills/commands/subagents 静默消失。
- **T4【高】bundled-marketplace.json 分片不能顺手删**。删 CDN 后目录剩 bundled+merged；bundled 没了 → loadBundledOfficialPluginRootsSync 返回 undefined → scanOfficialCache 退化全扫加载旧版本缓存（index.ts:857-860 注释警告过）。
- **T5【中】off_peak_tasks 迁移历史不可删**（schema-v1.ts:148、migrations.ts:29-42 是版本链）。存量记录变孤儿（无害，需清理策略说明）。
- **T6【中】IServiceAccessor.offPeakTaskService 必填字段**，接口与 DI 注册必须同 commit。
- **T7【中】botDeliveryTarget 是 cron 的 IM 回推**（automation-types.ts:162、bots.ts:41-52、desktop/host/cronBotDelivery.ts），保留勿随 bots 清。
- **T8【中】desktop/main/remoteCdn.ts 与市场 CDN 无关**（Electron release 下载），本轮归属另一责任块。
- **Q1 决策**：官方市场留空壳建议 (b)——数组结构保留、内容空数组+注释扩展位（(a) 占位 GitHub URL 会致每次启动尝试添加不存在市场产生噪音）。
- **Q2**：「公开」分段语义变为「内置 vs 自建」仍成立，不必改。
- **Q3**：DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS 里 image-search、restore-legacy-sessions 依赖官方 MCP 认证（definitions:186 注释）——官方端点残留，建议本轮标记待处理（归账号/端点责任块）。
- **Q4**：cron 建议完整保留（schema/repo/协议/消息全独立、纯本地 sqlite、botDeliveryTarget 挂其上、UI 已支持 scheduled-only）。唯一要改=idle tab 类型层面删干净。
- **Q5**：offPeakToolEnabled 是 session create/resume 可选字段，删后 core runtime-tools.ts:75 的注入逻辑整段删，与 T1 一并处理。

## 6）关键证据

（符号:行号 清单——原文详见任务通知；核心锚点）
- 市场：shared/plugin-marketplaces.ts:10,13,32,37,45,47；contracts/plugins/index.ts:7,16,38,43,90,187；adapters/plugins/official-marketplace.ts:9,17,29,38,60,118,134；adapters/plugins/marketplace.ts:230-272,283,306,334,339-395,398；shared/node/officialPluginCache.ts:20；services/commands/commandsService.ts:47,259；skillsService.ts:55,691；subagentsService.ts:431,437；ui officialMarketplaceAutoRefresh.ts:39；PluginStorePage.tsx:128-139,306,331。
- definitions：bootstrap/official-plugin-definitions.ts:32,37,57,58,89-364,370,376,387；bundled-plugins.ts:227,409；adapters/plugins/index.ts:100,852-891。
- offPeak：services/session/offPeakServerClient.ts:115,146,213-272；offPeakMockGateway.ts:68-138,512；offPeakRuntimeModel.ts；offPeakTaskService.ts；offPeakTaskRepo.ts；tasksDatabase/schema-v1.ts:148；migrations.ts:29-42；services/node.ts:2348-2546,252-269,2648,2682；accessor.ts:76；client/remoteServiceAccess.ts:81,180；adapters/model/offpeak-retry.ts:15-18,30。
- 耦合点：desktop/scheduler/index.ts:34,48-54,89,93,97-102；schedulerProtocol.ts；offPeakDispatchSettlement.ts；desktopCronScheduler.ts:24-31,43,50,125,93-96,148-184,196-198；desktop/main/index.ts:569,577,1554-1556,1791。
- 横向污染：core/tool/handlers/off-peak.ts:39；send-message.ts:13,50；bash.ts:128；core/runtime/types.ts:722；tool/types.ts:135；executor/types.ts:166；call-runner.ts:334；batch-runner.ts:43；turn-tools.ts:181；streaming-tool-coordinator.ts:291；turn-loop-state.ts:99,107,108,109；turn-loop.ts:180-196,189；tool/handlers/index.ts:48,95-96,183。
- bots 不动区：shared/bots.ts:41-52 全文零 URL；services/bots/botsService.ts 零命中；desktop/host/cronBotDelivery.ts。
- 无关 CDN：desktop/main/remoteCdn.ts:4；.env.example:8,14；ui/v4/featureSuggestedPrompts.ts:11。
