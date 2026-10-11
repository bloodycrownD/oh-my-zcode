# 探索报告 B：桌面端（Electron main + packages/ui）官方面

子代理：Explore（readonly）。HEAD=ba7c240（v0.1.1）。日期：2026-10-05。

## 1）探索范围

desktop main：autoUpdater.ts（1924 行全量符号表）、manifestUpdateProvider.ts（259 行全文）、forceUpdateGuard.ts（254 行）、forceUpdatePrompt.ts、index.ts（2123 行全部装配点）、desktopApplicationMenu.ts、desktopCommandHandlers.ts（688 行全文）、desktopHelpConfig.ts、desktopContextPromptRollout.ts、singleFeatureRollout.ts、desktopMainIpcPlatform.ts、desktopWindowLifecycle.ts、desktopTray.ts、desktopSecondInstanceDeepLink.ts（全文）、windowsInstallResourceLocks.ts、appShutdownPolicy.ts（全文）、remoteCdn.ts、exportLogs.ts（导出面）、desktopOAuthDeepLink.ts（全文四分支）、desktopWindowChrome.ts、preload/index.ts、preload/codingPlanWebview.ts、preload/oauthCallbackBridge.ts、renderer/desktopPlatform.ts（全文）、renderer/main.tsx、electron-builder.config.js、dev-app-update.yml、build/installer.nsh、package.json、tsup.config.ts。
shared：helpAppConfig.ts、remoteAppConfig.ts、channels.ts、desktopMenu.ts、platform.ts、protocol.ts、validationAppSettings.ts、conversation-share.ts、zcodeEndpoint.ts、plugin-marketplaces.ts、update.ts、forceUpdate.ts、test-ids.ts、config/default.json。
ui：WelcomeScreen.tsx、login/LoginApiKeyForm、useOAuth、useRootOAuthEffects、Root.tsx、UpdateStatus* 族、updateStatusModel、updateReleaseNotes、desktopUpdateMenu、useDesktopUpdateMenu、useAppChromeState、WorkspaceShellLayout、WorkspaceHeader、DesktopTopOverlay、SettingsPage 装配段、settingsPageHelpers、settingsPageConfig（全文）、UsageStatsSection、usage-stats/*、WorkspaceHelpMenuButton（全文）、helpMenuActions、productDocs、quickPickCommands、ConversationShare* 族、SessionPane share 段、shareImportIntent、useRootPlatformEffects、WorkspaceSidebarFooter 族、onboarding/*、i18n locales（域计数）、IntlProvider。
其它：release-desktop.yml（全文）、architecture-policy.yaml、.architecture-baseline.json、desktop-typecheck-baseline.txt。

## 2）现状实现摘要

### 2.1 自动更新全链
- **唯一数据源** ManifestUpdateProvider 继承 electron-updater Provider，打 `${endpointOrigin}/api/v1/releases/electron/manifest`（ELECTRON_MANIFEST_API_PATH），带 platform/device_mid/channel+X-Release-Channel 头。**不是 latest.yml 通道**。
- 装配链 index.ts:1836 initAutoUpdater → 5 个 ipcMain handler（QuitAndInstall/Download/Cancel/Skip + desktopMainIpcPlatform 侧 5 个）+ 60 分钟轮询 + provider 注入。
- menuState 状态机（idle|checking|update-available|download-progress|update-downloaded），broadcast 向所有窗口 send。
- 菜单三处独立入口：desktopApplicationMenu.ts:121-130（macOS app 菜单）+ :262-271（Win/Linux 帮助菜单）+ **desktopTray.ts:76-83（托盘，最易漏）**；:378 setAutoUpdaterMenuLocale 无条件调用（不删则启动即崩）。
- **强更 gate 进程级**：index.ts:2002-2020 maybeBlockStartupForForceUpdate → forceUpdateMainWindowCreationBlocked 渗透 5 处（primaryWindowCoordinator/open-url/second-instance/desktopSecondInstanceDeepLink 两 dep/focusForceUpdateGateWindow）。
- updateStatusWindow 子窗口整套（windowKind:"update-status"，3 档高度），getApplicationWindowsExcludingCuaIndicator 排除它。
- 设置项 autoDownloadAndInstallUpdates + receivePreviewUpdates；shared 层 channels 12 常量、platform.ts 14 方法、protocol.ts 4 AppSettings 字段、validationAppSettings 双 zod。
- 构建侧：electron-builder :749-759 detectUpdateChannel:false+publish 占位 localhost；:141-145 注入 "ms"（electron-updater 专用，但 debug 也依赖）；dev-app-update.yml；desktop/package.json:43 electron-updater ^6.8.3。
- **v0.1.1 GitHub release 流零依赖**：上传只收安装包不收 blockmap/latest，gh release upload 直挂。删更新链不影响发版。

### 2.2 帮助配置与 rollout
- desktopHelpConfig.ts 薄封装 electron.net.fetch `${origin}/api/v1/client/configs`；**内置 fallback 硬依赖**：config/default.json（feedback_url 飞书表单/community_urls 飞书+discord）经 extraResources 进包，resolveLocalAppConfigPath packaged/dev 双路径。**默认内容本身是官方外链**——删远端≠删官方端点。
- desktopContextPromptRollout：单功能灰度 defaultValue:{enabled:false} fail-open。消费链 index.ts:1543 → desktopHostProcess ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED → services/node.ts → zcodeAgentPresentationSurface.ts:20。**删除后 presentation surface 恒关（行为翻转，需拍板）**。singleFeatureRollout 唯一消费者即它。
- ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV 在 services/node.ts、server/remote/connect.ts、shared/runtimeEnv.ts 有引用，不能 desktop 单方面删。

### 2.3 登录 UI 树
- WelcomeScreen.tsx 557 行（LoginPanel+useOAuth+LoginApiKeyForm）；LoginCompleteReason 被 Root.tsx:23 import。
- Root.tsx 三级早退（isStartupRenderBlocked → welcomeScreenOpenReason 5 枚举 → 无 workspace → RootShell）；guard 会 setLoginEntryOpen 强开 WelcomeScreen 且被 canRestoreWorkspaceSession 当阻断条件。
- useRootOAuthEffects 391 行（onOAuthCallback/onPaymentCallback 常驻+轮询）。useOnboardingTelemetry 零命中（Phase 1 已清）。
- onboarding/* 通用（occupation+agents-file+settings-sync）——仅 OccupationOnboarding:56 的 userId 与 useOnboardingTrigger 的 claimAnonymousRecord/换号回填是登录专属；**3s 超时兜底是防黑屏保护必须保留**。
- store/index.ts 11 个登录态字段。

### 2.4 订阅与额度
- settings/model-provider-section 依赖远端 client/configs 套餐目录；CodingPlanEmbeddedWebviewDialog 515 行（persist:zcode-coding-plan partition）；main 侧 desktopWindowChrome:640-650 will-attach-webview 切 codingPlanWebview.cjs preload；tsup.config.ts:185 entry。
- 额度 UI：useCodingPlanQuotaResetUi 887 行、CodingPlanUsageRemainingPanel（**被 composer 通用区 contextUsage.tsx 复用——最易误判**）、ConversationQuotaBanner、CodingPlanUsagePanel。SettingsPage:340-501 resolveEntitledAccountProviderAccess* 块。

### 2.5 分享
- 发布：ConversationShareMenu→Selection 族→SessionPane:3887 share_url；URL 硬绑 /cn/share/<code>，域名由 zcodeEndpoint 决定。
- 导入：deep link zcode://…/share/<code>→desktopDeepLinkUrl→desktopOAuthDeepLink pendingShareImports 队列→ShareImport IPC→useRootPlatformEffects→ImportNotice。
- **本地导出不受影响**（exportLogs 独立无交集）；deleteSharedContext 协议命令与分享不同物（极易误删）。
- **deep link 是 workspace/payment/share/oauth 四合一路由**——整删文件会干掉 workspace（必须保留）。

### 2.6 其它官方外链
productDocs.ts zcode.z.ai/docs（App.tsx:680+helpMenuActions:33）；changelog ${origin}/cn|changelog（desktopCommandHandlers:448-463）；社区 CanOpenCommunity IPC→WorkspaceHelpMenuButton 3 项+quickpick；web 包 main.tsx:318-330 13 个 update stub+communityUrl.ts 同构残留。

## 3）与需求相关约束

1. 发布流零耦合（见 2.1）。"ms" 包删除需评估（debug 也依赖）。
2. 帮助配置 fallback 内容本身官方（见 2.2）。
3. singleFeatureRollout 孤儿可删；但 ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED 跨 services/server 边界。
4. web 侧同构残留：删 shared/helpAppConfig 符号 web 编译失败——必须同轮最小处理 web。
5. architecture-policy desktop/ui/shared 全 managed:false 不触发层级门禁；desktop-typecheck-baseline 705 行行号级快照（已含 manifestUpdateProvider:140 一条 TS2352）删文件必须重采。**i18n parity 门禁不存在实体**（IntlProvider messages[id]??id 静默显示原始 key；现状 zh 5891 vs en 5892 已差 1；share/usage/codingPlan/account 域现状已 21 key 不对称）；shared/desktopMenu.ts 是全仓唯一类型约束对称点。

## 4）变更影响面（要点）

A 自动更新整删：autoUpdater.ts/manifestUpdateProvider.ts/forceUpdateGuard.ts/forceUpdatePrompt.ts/windowsInstallResourceLocks.ts/dev-app-update.yml 整删；electron-builder 删 :749-759/:141-145/评估 extraResources default.json 项。
B 帮助/rollout：desktopHelpConfig/desktopContextPromptRollout/singleFeatureRollout 整删；helpAppConfig/remoteAppConfig 改造；config/default.json 替换或删。
C 登录 UI：WelcomeScreen/login//useOAuth/useRootOAuthEffects/guard 整删；oauth root 族 8 文件逐个判定；Root.tsx 重构；store 11 字段；desktopOAuthDeepLink 删 OAuth 分支保留 workspace/payment/share（payment 随购买删则三分支剩 workspace/share）；preload registerOAuthState/onOAuthCallback；oauthCallbackBridge 整删；desktopMainIpcRemote:176 oauth-register-state。
D 订阅/额度：ui 20+ 文件+main 配套（desktopCommandHandlers:44/132-149/682-684、desktopWindowChrome coding-plan 段、preload/codingPlanWebview、tsup:185）+settingsPageConfig usage 分区+SettingsPage 块。
E 分享：ui 12 文件+SessionPane 5 段+useRootPlatformEffects 5 段+desktopDeepLinkUrl/desktopOAuthDeepLink 段+shared/conversation-share.ts+shared-context-import.ts。
F 设置页：settingsPageHelpers 两个 Switch+SettingsPage state/handler/props。
G preload/renderer 残留：preload 13 update 方法+canOpenCommunity+onPaymentCallback+codingPlanWebview；desktopPlatform 14 方法；main.tsx update-status 分支+UpdateStatusWindowRoot import；web stubs+communityUrl。

## 5）风险与疑点

### 5.1 autoUpdater 重构点（非纯删）
1. desktopApplicationMenu :13 import 与 :378 setAutoUpdaterMenuLocale 必须同步删否则启动崩；托盘第三处易漏。
2. desktopCommandHandlers CheckForUpdates case+shared/platform.ts:487 枚举项。
3. 强更 gate 渗透 5 处：整删 focusForceUpdateGateWindow 连带改 desktopSecondInstanceDeepLink 的 SecondInstanceWorkspaceDeps 接口（forceUpdateBlocked+focus 两个必填 dep）与 index.ts:1713-1717——**必须重构非简单删**。
4. updateStatusWindow filter 表达式删后退化恒真，整体简化但不能留语法残留。
5. appShutdownPolicy "update-install" kind：删后 WINDOWS_NORMAL_SHUTDOWN_POLICY 唯一分支，建议整文件简化但不能只删类型字面量。
6. prepareWindowsProcessesForUpdateInstall+runWindowsUpdateProcessCleanup 成对孤儿。
7. desktopMainIpcPlatform 5 handler 的 options 类型字段（:78-89/:342-364）与 autoUpdater.ts 4 handler 分散两文件。

### 5.2 登录 UI 删除后首启
- Root 变两级早退；**canRestoreWorkspaceSession 的 isStartupProviderLoginEntryOpen 必须同删，否则「guard 文件删了阻断条件留」→ 首启死锁（最危险误删路径）**。
- onLogin/onLogout/user 三 prop 链同步删，否则侧栏留「永远不可点的登录菜单+空白头像区」（getSidebarProfileName 恒 "Z"）。
- store.user 恒 null 会留占位 UI——侧栏 profile/plan badge 区需显式重构。
- LoginApiKeyForm 删除失去「首启一步配置」引导（设置页 provider 配置能力独立保留）；首启体验=直接主界面，需拍板接受。

### 5.3 帮助/分享
- 内置 default.json 三 URL 官方：须替换或整块下线（连带 OpenFeedbackDialog/CanOpenCommunity IPC、feedbackStore、quickpick 社区项、HelpMenuButton 3 项）。
- feedback_use_external_form:false → openFeedback 走内嵌对话框（但 feedbackService 上报官方端点，须连 services 一起删）；resolveCommunityUrl undefined → openCommunity warn 后 no-op（安全降级）。
- 分享不波及 exportLogs/previewPane/deleteSharedContext；真风险在 deep link 四合一共用函数。
- localizeConversationShareUrl 若「删发布留导入」须留——需求是全删则一并删（拍板点）。
- onPaymentCallback/isPaymentCallbackUrl 随购买删除后确认无合法来源。

### 5.4 i18n
update 域 zh/en 各 ~24 key；login 域各 ~32；share/usage/codingPlan/account 合计 zh 794/en 815（现状已不对称 21）；desktopMenu 更新相关 6 条在 shared 两份（类型约束强制对称）。无 parity 门禁实体，本轮大批删必须新建脚本。

### 5.5 承重面
1. LoginApiKeyForm 像登录实为 provider 配置向导（仅 zai/bigmodel 模板）；设置页 provider 配置独立不依赖它。
2. useOAuth 独占 WelcomeScreen 但 oauthService 在 services 边界。
3. onboarding 主体绝不能当账号功能删（仅 userId 行+claimAnonymousRecord 专属）。
4. CodingPlanUsageRemainingPanel 被 composer 通用区 contextUsage.tsx:30/1047 复用。
5. **SessionPane.tsx >4500 行**：share/quota/login 混在同一组件，单文件改动量最大冲突最高。
6. desktopWindowChrome :640-650 will-attach-webview 是通用钩子（删 coding-plan 分支不能删钩子本体）。
7. shared/helpAppConfig 被 web/communityUrl 共用。
8. web 侧 update stubs/communityUrl 需同轮处理。
9. manifestUpdateProvider 在 desktop baseline 有一条既有 TS2352，删文件必须重采 baseline。
10. extraResources 不能整块删（default.json 与其它资源同段）。
11. **remoteCdn.ts 不是更新链**——被 server/remote/remoteAsset*.ts 与 desktopRuntimeEnv 用于远端 workspace 资源下载，删了打断远程 workspace（极易误伤）。

## 6）关键证据
（完整符号清单见探索报告原文；核心锚点）
- 更新链：autoUpdater.ts（CHECK_FOR_UPDATE_MENU_ID/menuState 状态机/broadcastAutoUpdaterState/initAutoUpdater/AUTO_UPDATE_POLL_INTERVAL_MS/resolveUpdateFeedSourceFromStartupConfig）；manifestUpdateProvider.ts（ELECTRON_MANIFEST_API_PATH/buildElectronManifestUrl）；forceUpdateGuard.ts（maybeBlockStartupForForceUpdate/ZCODE_CLIENT_CONFIG_API_PATH）；index.ts（updateStatusWindow/prepareWindowsProcessesForUpdateInstall/forceUpdateMainWindowCreationBlocked/focusForceUpdateGateWindow）；desktopApplicationMenu.ts:13/121-130/262-271/378；desktopTray.ts:7/76-83；desktopCommandHandlers.ts:25/591-598；desktopMainIpcPlatform.ts:78-89/325-364；appShutdownPolicy.ts:43-51；windowsInstallResourceLocks.ts；preload/index.ts:662-723/819-831；desktopPlatform.ts:106-118/128-132；renderer/main.tsx:8/152/333/338-342；channels.ts:341-379/980-1056；platform.ts:872-930；protocol.ts:352-364；validationAppSettings.ts:59-72/469-472/554-557；desktopMenu.ts:45-49/104-108/156-160；electron-builder.config.js:141-145/562-579/749-759。
- 帮助/rollout：desktopHelpConfig.ts；desktopContextPromptRollout.ts；singleFeatureRollout.ts:53；helpAppConfig.ts:43-44；remoteAppConfig.ts:21-95；desktopCommandHandlers.ts:151-285/448-463；config/default.json；zcodeAgentPresentationSurface.ts:12-24；desktopHostProcess.ts:151/262-264；services/node.ts:1375-1380/2098。
- 登录：WelcomeScreen.tsx（557 行）；useOAuth.ts（156 行）；useRootOAuthEffects.ts（391 行）；Root.tsx:23/84-88/398-444/635-690/920-929/997-999；store/index.ts:49/136-166/314-378；OccupationOnboarding.tsx:55-78；useOnboardingTrigger.ts:43-73；desktopOAuthDeepLink.ts:42/446-507；oauthCallbackBridge.ts。
- 订阅/额度：useCodingPlanQuotaResetUi.ts（887 行）；CodingPlan* 族；CodingPlanUsageRemainingPanel.tsx；contextUsage.tsx:30/1047；SettingsPage.tsx:128-215/340-501/1756；settingsPageConfig.ts:163-166；desktopWindowChrome.ts:57/60-122/382-476/640-650；preload/codingPlanWebview.ts；tsup.config.ts:185。
- 分享：ConversationShare* 族 12 文件；SessionPane.tsx:127/3616-3617/3887/3974/4551；shared-context-import.ts:7-26；conversation-share.ts:40-48；desktopDeepLinkUrl.ts:82-91；desktopOAuthDeepLink.ts:318-353/461-469/496-500。
- 官方外链：productDocs.ts:2；desktopCommandHandlers.ts:448-463；web/main.tsx:318-330；web/communityUrl.ts；desktopMainIpcRemote.ts:63；desktopWindowChrome.ts:293。
- 门禁：architecture-policy.yaml；desktop-typecheck-baseline.txt:140；mise.toml（无 parity 任务）。
