# 探索报告 D：端点基建死代码判定 + 构建/测试/文档约束

子代理：Explore（readonly）。HEAD=ba7c240（v0.1.1）。日期：2026-10-05。

## 1）探索范围

shared/src/zcodeEndpoint.ts（297 行逐符号）、zcode-source-headers.ts、env.ts、official-glm-model-id.ts、model-provider-family.ts、plugin-marketplaces.ts、helpAppConfig.ts、node/officialPluginCache.ts；deviceMid 四实现及消费面（anthropic-request-metadata.ts、feedbackService.ts、onboardingRecordService.ts、ui/lib/streamClientId.ts、desktopMainIpcPlatform.ts、server/entry-stdio.ts）；.env.example/.env.development/.env.production/cli/.env.template；构建注入三处（desktop/vite.config.ts、desktop/tsup.config.ts、web/vite.config.ts、cli/scripts/build.mjs:208、scripts/load-endpoint-env.mjs）；门禁（package.json、knip.json、.oxlintrc.json、.oxfmtrc.json、typecheck-desktop-full.mjs、desktop-typecheck-baseline.txt、licenses.mjs）；文档（UPSTREAM-SYNC.md 五节、NOTICE.md、CHANGELOG.md、release-desktop.yml、p1-tt1-residual-scan.md、.iteration-state.yaml）；测试（test-plugin-marketplace-official-alias.mjs、magic-context test-config.mjs）；E2E 沙箱 seed。

## 2）现状实现摘要

zcodeEndpoint.ts 双层结构：①默认值层 5 个硬编码官方 origin/clientId；②注入层 pickProductEndpointEnv（7-key 白名单）+ readProductEndpointEnv（合并 __ZCODE_ENDPOINT_ENV__ define 与 process.env），三处 vite/tsup define 注入（CLI 侧不 define 走 process.env）；③解析层 resolve/build/rewrite/normalize 族；④兄弟族 BigModel/ZAI OAuth。

__ZCODE_ENDPOINT_ENV__ 唯一消费者是 readProductEndpointEnv，后者只被 resolveRuntime* 当默认参数 + desktopRuntimeEnv.ts:242/267 显式调用——注入机制无第二个复用点，但机制本身承重（见陷阱 2）。

official-glm-model-id.ts：OFFICIAL_GLM_MODEL_IDS 全仓零 import（barrel re-export 掩盖，knip 看不见）；normalizeOfficialGlmModelId 有 2 活消费者（zaiStartPlanBilling.ts:144 计费面 + legacy-model-provider-identity.ts:12 **通用路径**）→ 文件不能整删。

**任务书两处事实修正**：① env.ts 无任何端点常量（只有 ZCodeEnv/ZCODE_ENV 等），端点 env 逻辑全在 zcodeEndpoint.ts + desktopRuntimeEnv.ts；② desktop 差分基线实测 705 行/366 唯一键（非 59 键，59 疑为另一次 kinds 口径）。

## 3）端点基建符号逐个判定表

**A 组 ZCode 控制面（zcode.z.ai 系）**

| 符号 | 判定 | 依据 |
|---|---|---|
| DEFAULT_ZCODE_ENDPOINT_ORIGIN | 留（需解耦） | 15+ 活点几乎全是删除面（autoUpdater/forceUpdateGuard/manifestUpdateProvider/desktopCommandHandlers/desktopArchitectureGuard/codingPlanEmbeddedWebview/oauthStateCodec/communityUrl/webZaiOAuthConfig/desktop/index:1213）；但 zcode-source-headers.ts:5（HTTP-Referer 默认值）与 nodeApiClient.ts:56/93 是通用面耦合 |
| resolveZCodeEndpointOrigin | 留（降纯函数） | desktop/vite.config.ts:158 构建期、desktopCommandHandlers:470、desktop/index.ts:598（endpoint 覆盖设置=帮助配置面） |
| resolveRuntimeZCodeEndpointOrigin | **留（通用承重不可删）** | bootstrap/model-config.ts:56（HTTP-Referer 进所有模型请求含用户自配 provider）、cli/provider-runtime-env.ts:79（builtin provider 缓存目录键）、process-provider-registry-runtime.ts:73、legacyZCodeConfigProviderReader、desktopRuntimeEnv:275 |
| buildZCodeEndpointUrls | 部分删 | 7 键中 5 键纯官方面；origin/apiBaseUrl 两键被 clientConfigService:71、desktop/host/remoteWorkspaceServiceCollection.ts:185（远端工作区通用面）消费 |
| buildRuntimeZCodeApiUrl | 部分删 | 12 消费点；删除面 offPeakServerClient/zaiMcpQuotaProvider/bigmodelUsageQuotaProvider/feedbackService:43；**remoteWorkspaceServiceCollection.ts:185 远端工作区通用面不可删** |
| buildRuntimeZCodeEndpointUrls | 删 | 仅 zaiStartPlanBilling.ts:10 + ui/rendererZCodeEndpoint.ts:29 |
| resolveRuntimeZCodeEnv | 留 | model-config.ts:60（X-Release-Channel 所有模型请求）、legacyZCodeConfigProviderReader:71/78。语义是产品身份非端点 |
| normalizeZCodeEndpointOrigin | 留 | validationAppSettings.ts:132（通用设置校验）、nodeApiClient:39、desktopCommandHandlers:415 |
| rewriteZCodeEndpointUrl | 留（需重定位） | nodeApiClient:94。若 NodeApiClient 留则必须留；删 DEFAULT_* 留它 → 永远 early-return 静默 no-op |
| isTrustedCodingPlanWebviewOrigin | 删 | 3 活点全在 coding-plan webview |
| pickProductEndpointEnv / readProductEndpointEnv / __ZCODE_ENDPOINT_ENV__ | **留（机制承重）** | 见陷阱 2 |
| resolveRuntimeProductEndpointConfig | 删 | 零外部 import |
| Runtime*EndpointEnv 类型 | 留 | readProductEndpointEnv 默认参数类型 |
| ZCodeEndpointUrls | 瘦身 | 只留 origin/apiBaseUrl |

**B 组 BigModel/ZAI（登录/计费专属无通用承重）——全部删**：DEFAULT_BIGMODEL_API_ORIGIN / DEFAULT_ZAI_OAUTH_ORIGIN / DEFAULT_ZAI_BUSINESS_BASE_URL / DEFAULT_ZAI_OAUTH_CLIENT_ID（webZaiOAuthConfig.ts:58 还硬编码同一 clientId 字面量）/ resolveBigModelApiOrigin / buildBigModelApiUrl / buildBigModelCodingPlanPersonal/TeamManageUrl / resolveZaiOAuthOrigin / buildZaiOAuthUrl / buildRuntimeZaiOAuthUrl / resolveZaiBusinessBaseUrl / buildRuntimeZaiBusinessUrl / resolveZaiOAuthClientId。

## 4）deviceMid / sourceHeaders / telemetry-state 判定

| 实现 | 判定 | 理由 |
|---|---|---|
| cli-device-mid.ts（ensureCliDeviceMid） | **留** | 唯一消费者 anthropic-request-metadata.ts:27 是通用模型请求路径（providerKind==="anthropic"，用户自配 Anthropic 兼容端点也走），已本地脱敏。与官方端点无关 |
| desktopDeviceMid.ts（ensureDesktopDeviceMidSync） | **留** | 消费者 PlatformChannels.GetDeviceId（desktopMainIpcPlatform:387→preload:747→ui/streamClientId.ts renderer owner/observer 身份）+ HostInitMessage.deviceMid + onboarding。与官方端点无关 |
| services/deviceMid.ts（ensureDeviceMid） | **删** | 唯一活消费者 server/stdioDeviceMid.ts（注释自陈 Start Plan billing）→ 计费面专属。连带删 node.ts:129-130 |
| server/stdioDeviceMid.ts | **删** | 唯一调用 entry-stdio.ts:57；注释明写「Start Plan 权益由远端自查询，billing/balance 因缺 X-Device-Mid 被拒」→ 账号耦合成立 |
| services/providers/sourceHeaders.ts | 部分删 | readExistingDeviceMid():41-63 + cachedDeviceMid 只服务 X-Device-Mid，注入点仅 NodeApiClient（官方出口）+ offPeakServerClient（删）。NodeApiClient 留 → 留文件删 deviceMid 段；也删 → 整文件删 |
| shared/zcode-source-headers.ts | 留（需瘦身） | 3 活消费者中 2 个是删除面（desktopHelpConfig、desktopContextPromptRollout）；但 ZCODE_SOURCE_HEADERS:3（HTTP-Referer/X-Title）是所有模型请求通用来源头 |
| telemetry-state.json/.lock | 文件名/路径口径不能动 | CLI+Desktop 两份实现共享读写；改名=重置所有用户设备身份=破坏 onboarding 锚点与 renderer 身份。Phase 1 白名单注释链需重写 |

env 文件：.env.example 8 个官方端点变量全部删除面；ZCODE_DEPS_BASE_URL/INTRANET_MACHINE_HOST/ZCODE_DIST_BASE_URL（内网自配）留；.env.development/.env.production/cli/.env.template 不改。

## 5）承重面陷阱

1. **HTTP-Referer 不是官方面**：ZCODE_SOURCE_HEADERS 与 buildZCodeSourceHeadersFromContext 的头打进所有模型请求含用户自配 provider；model-config.ts:56 独立复刻同套头。删官方端点后语义悬空：填 zcode.z.ai=继续向自配 provider 泄露官方域名（涉密失败）；删头=改所有模型请求指纹。**需用户拍板**。
2. **__ZCODE_ENDPOINT_ENV__ 构建注入被三方复用（最易误删）**：① web bundle 唯一端点配置入口（web 无 process.env，readProductEndpointEnv:30 的 typeof process==="undefined" 分支为它写）；② desktopRuntimeEnv.ts:242/267/273 给 host/scheduler 子进程组装 env patch=远端工作区/多进程通用机制；③ shared/package.json:17 子路径导出存在的原因=Node 侧不能 import 整个 barrel。**构建基础设施。建议保留三件套+三处 define，7-key 白名单改为「无默认值可选覆盖」**。
3. **model-provider-family.ts:45 模块顶层求值** teamCodingPlanManageUrl: buildBigModelCodingPlanTeamManageUrl({ZCODE_ENV})。删函数不改这行 → shared barrel 初始化即抛 "endpoint origin is empty" → 全仓 import shared 即崩（半删即崩典型）。
4. rewriteZCodeEndpointUrl:281 写死 sourceOrigin=DEFAULT_ZCODE_ENDPOINT_ORIGIN。删常量留函数 → 永远 early-return 静默 no-op。
5. official-glm-model-id.ts 整删打断通用 legacy 身份迁移（legacy-model-provider-identity.ts:12）。
6. ensureCliDeviceMid 是通用模型请求路径，误判计费面会打断模型请求。
7. desktop/host/remoteWorkspaceServiceCollection.ts:185 的 buildRuntimeZCodeApiUrl(env,"/api/v1") 是远端工作区（SSH/WSL/Docker）服务集合 baseUrl，通用部署能力，删掉打断远端工作区。

## 6）门禁基线处置

| 门禁 | 处置 |
|---|---|
| 根 typecheck（tsc -b 11 project） | 不需重采（0 err 本身即最强信号，断链直接报错） |
| CLI turbo typecheck | 不需重采 |
| typecheck:desktop-full 差分 | **必须重采**。大删产生大量 removed；typecheck-desktop-full.mjs:55 拒写保护只在 fresh>0 触发，大删 fresh=0 可直接 --snapshot。步骤：删前记基线 → 删后跑（不带 --snapshot）拿 removed+fresh → 判据 fresh 必须为空、removed 逐条确认没误伤通用面 → --snapshot 重写 → UPSTREAM-SYNC.md §5 登记新数字 |
| 根 lint | 需重采。判据改「0 errors 且无新增 warning」 |
| knip | **必须 stash 对比法重采**（绝对数 676~742 波动不可信）。建议本轮顺手摘掉 zcodeEndpoint 的 shared/src/index.ts:94-95 barrel re-export 让 knip 看见真实死符号；knip.json:13-27 workspace entry 白名单同步裁剪 |
| oxfmt | 不需重采；大删后应跑 pnpm fmt 而非只 fmt:check |
| licenses.mjs notices+check | 必须重生成（reviewRequired 15 项基线）。EMFILE 坑按 UPSTREAM-SYNC.md:114 登记方案处理（third-party-npm.mjs 临时串行后回滚；pnpm -C <dir> ls 在本机返回空树） |

## 7）涉密验收：残留出网点与扫描设计

预期删除完成后出网点=仅用户自配模型端点。仍需处理/登记的出网点：

| 出网点 | 位置 | 处置 |
|---|---|---|
| 远程资源 CDN 默认值 | desktop/main/remoteCdn.ts:4（https://cdn-zcode.z.ai） | 保留但显式化：改「无默认 CDN，未配置则不下载」 |
| 内置 provider 预设 | config/provider/zcode-builtin.json:16,20,38,42,85,107,705,726,747,810,832,854（含 zcode.z.ai/api/v1/zcode-plan/*、off-peak/*） | 逐条判定：用户可自配预设=留；官方专属端点段=删 |
| 官方插件资产 CDN | definitions:58、featureSuggestedPrompts.ts:11 | 随市场面删 |
| 硬编码 OAuth base | adapters/auth/cli-oauth.ts:4（不经 zcodeEndpoint 的字面量） | 随登录面删 |
| webview 导航白名单字面量 | desktopMainIpcRemote.ts:63、desktopWindowChrome.ts:293 | 随登录/计费面删 |
| 文档/下载/首页链接 | ui/lib/productDocs.ts:2、web/share/ConversationShareLandingPage.tsx:91、electron-builder.config.js:453 | 改 fork 自有 URL 或删 |
| /api/v1 baseUrl（helpAppConfig.ts:27、clientConfigService.ts:70、desktopContextPromptRollout.ts:88、remoteWorkspaceServiceCollection.ts:185） | 通用路径 | **不能一刀删**：远端工作区 baseUrl 保留机制去官方默认值 |

**T 系列扫描（两轴）**：
- 轴一出网点扫描（本轮核心新增）：模式集（大小写敏感避免假阳性）`zcode\.z\.ai|bigmodel\.cn|chat\.z\.ai|api\.z\.ai|cdn-zcode\.z\.ai|z\.ai`；范围 packages/、apps/zcode-cli/packages/、scripts/、config/、public/、.env*、根与 cli 构建配置；排除 glob 单 glob 逐个绝不组合（本机 rg 多 glob 静默零结果坑）；白名单：zcode-builtin.json 的 API Key 管理页深链（文档性 URL）、用户自配 provider baseUrl（预设非默认）、LICENSE/THIRD-PARTY-NOTICES/third-party、docs/.agents。外发通道探针（照抄 Phase 1 手法）：`fetch.*zcodeEndpoint|downloadZCodeBuiltinRelease|resolveRemoteCdnBaseUrls|createHostApiNetworkTransport`。
- 轴二符号扫描：`zcodeEndpoint|ZCODE_BASE_URL|ZAI_OAUTH|BIGMODEL_API|ZCODE_CDN|X-Device-Mid|deviceMid|telemetry-state|ZCODE_SOURCE_HEADERS|HTTP-Referer`；白名单：机制承重三件套、HTTP-Referer/X-Title/User-Agent（**待拍板项非已接受项**）、deviceMid cli+desktop 两份、telemetry-state.json 文件名、official-glm-model-id 注释、desktop-typecheck-baseline.txt。
- **真机抓包必做**：Phase 1 遗留 T-T4 至今未做；本轮删除面更大含 HTTP 出网链，静态扫描不足以验收。预期只观察到用户自配 provider 连接，作为涉密硬门禁。

## 8）依赖闭包与 CI

- **electron-updater**（desktop/package.json:43 ^6.8.3）：活消费面仅自动更新（autoUpdater.ts:19 + manifestUpdateProvider.ts:18-19 自定义 Provider）。可整摘，lockfile 净减。⚠️ 传递依赖 builder-util-runtime 也被 electron-builder 用（打包仍需）→ 不能整族删，只摘顶层后确认真净减。预估保守 −3~−8 包。
- **@arms 残留**：无（Phase 1 已净）。
- **nodeApiNetwork.ts**：名字易误判，实为 Host 进程 HTTP 代理/自定义 CA transport（undici Agent/ProxyAgent + rootCertificates），**企业代理/自签 CA 通用能力，与官方端点无关，保留**（undici 保留）。
- **NodeApiClient**：是 ApiClient 的 Node 实现（代理/超时/重写/来源头/JWT 失效），被 OAuth/clientConfig/feedback/offPeak/conversationShare 共用。**不能因名字删**。官方耦合集中在 rewriteZCodeEndpointUrl+DEFAULT_ZCODE_ENDPOINT_ORIGIN+buildZCodeSourceHeaders 三处可摘，类骨架保留。
- **release-desktop.yml 与被删面无耦合**：latest.json 通道不在该流内（属 CLI tarball 链：build-zcode.mjs:274 生成 + installer.mjs:24 消费，该链保留）。**release 流不删**（删的是桌面自动更新检查，不是构建发布）。installer.nsh:297 是 NSIS 行为随打包保留。

## 9）测试与 E2E 波及

- mkt-alias 4 case（test-plugin-marketplace-official-alias.mjs）→ 整删。
- magic-context test-config.mjs 10 case → **保留**（与帮助配置无关，易误判）。
- smoke 族全本地不触网 → 保留。**仓内 15 套对账号/市场/分享/offPeak 零波及**（grep offPeak 在 cli packages scripts 下 0 命中）。
- E2E seed 复制 4 文件含 v2/credentials.json（zcodejwttoken 登录凭据）→ 登录删后 seed 改 3 文件；.iteration-state.yaml:75 口径需更新。
- **T-P2 整条作废**（coding plan 真回复+市场合并+CDN 别名）——它同时是唯一真实访问官方端点的 E2E，作废后失去唯一真机抓包时机，与 T-T4 合并处理。
- M8 GUI 登录 / M9 --web UI 冒烟随登录面失效需更新。

## 10）文档约束

- UPSTREAM-SYNC.md：§2 tag 链补本轮；§3 第 4 行「官方市场 id 保留旧 id 别名兼容」失效；**§3 关键增补——同文件既有死代码也有承重代码（zcodeEndpoint.ts/deviceMid*/sourceHeaders*），上游改动落在保留面（pickProductEndpointEnv 机制、normalizeZCodeEndpointOrigin、ensureCliDeviceMid）必须重放，按文件粒度丢弃会误删承重面**；§4 四处判据数字同 PR 更新（lint 71w/0e、desktop 基线、reviewRequired 15、测试族 15→14）；§5 新增重采记录。
- CHANGELOG：新区写明移除范围+「只支持用户自配端点」；v0.1.1 节「静默降级」表述过时需勘误。
- NOTICE.md：零节加移除声明；第二节逐行删登录/套餐/官方网关/分享/闲时票据/更新 7-8 行——「主动反馈」行含 X-Device-Mid 需复核，「模型请求附加设备和会话标识」部分仍成立（anthropic-request-metadata 保留）→ **精确改写非整删**；第三节 telemetry-state.json 若保留需披露。
- THIRD-PARTY-NOTICES/inventory：licenses.mjs 重生成不手改。
- README：查登录/订阅/官方模型宣传段。

## 11）风险汇总

高：①「端点基建=死代码」前提部分不成立（6 符号有活消费者不能整文件删）；②HTTP-Referer 语义悬空需拍板；③X-ZCode-Agent:"glm" 硬编码（model-config.ts:63）与通用 agent 定位冲突，任务书未提及。中：④model-provider-family.ts:45 顶层求值半删即崩；⑤NodeApiClient 命名误导；⑥任务书两处事实修正（env.ts、59 键）；⑦T-T4 未做本轮必须补；⑩E2E seed 口径重定义。低：knip barrel 盲区、knip.json entry 白名单。

## 12）关键证据

（原文含完整路径:行号清单，核心锚点）
- zcodeEndpoint.ts 全符号：DEFAULT_ZCODE_ENDPOINT_ORIGIN:3 / DEFAULT_BIGMODEL_API_ORIGIN:4 / DEFAULT_ZAI_OAUTH_ORIGIN:5 / DEFAULT_ZAI_BUSINESS_BASE_URL:6 / DEFAULT_ZAI_OAUTH_CLIENT_ID:7 / __ZCODE_ENDPOINT_ENV__:10 / pickProductEndpointEnv:11 / readProductEndpointEnv:27 / normalizeZCodeEndpointOrigin:87 / isTrustedCodingPlanWebviewOrigin:104 / resolveZCodeEndpointOrigin:126 / resolveRuntimeZCodeEnv:135 / resolveRuntimeZCodeEndpointOrigin:142 / buildRuntimeZCodeEndpointUrls:154 / buildRuntimeZCodeApiUrl:160 / resolveBigModelApiOrigin:168 / buildBigModelApiUrl:176 / buildBigModelCodingPlanPersonalManageUrl:184 / TeamManageUrl:191 / resolveZaiOAuthOrigin:197 / resolveZaiBusinessBaseUrl:205 / resolveZaiOAuthClientId:213 / buildZaiOAuthUrl:223 / buildRuntimeZaiOAuthUrl:228 / buildRuntimeZaiBusinessUrl:235 / resolveRuntimeProductEndpointConfig:243 / buildZCodeEndpointUrls:260 / rewriteZCodeEndpointUrl:273。
- 构建注入：desktop/vite.config.ts:7,158,191,198,200；desktop/tsup.config.ts:1,103；web/vite.config.ts:12-16,36,39,85,89,91；cli/scripts/build.mjs:208-210；scripts/load-endpoint-env.mjs。
- deviceMid 链：cli-device-mid.ts:34→anthropic-request-metadata.ts:27；desktopDeviceMid.ts:29→index.ts:673→desktopMainIpcPlatform.ts:387→preload:747→ui/streamClientId.ts:17；services/deviceMid.ts:173,195→node.ts:129-130→stdioDeviceMid.ts:21→entry-stdio.ts:13,54-57；sourceHeaders.ts:25,41-63→nodeApiClient.ts:10,49+offPeakServerClient.ts:12,159；zcode-source-headers.ts:3,30,57；channels.ts:394-395。
- official-glm：official-glm-model-id.ts:29,31；zaiStartPlanBilling.ts:4,144；legacy-model-provider-identity.ts:5,12。
- 门禁：typecheck-desktop-full.mjs:39,48-63；package.json:29-38；knip.json:13-27；UPSTREAM-SYNC.md:96,97,100,101,114。
- 硬编码官方端点扫描目标：plugin-marketplaces.ts:37；productDocs.ts:2；featureSuggestedPrompts.ts:11；remoteCdn.ts:4；electron-builder.config.js:453；desktopMainIpcRemote.ts:63；desktopWindowChrome.ts:293；cli-oauth.ts:4；official-plugin-definitions.ts:57-58；webZaiOAuthConfig.ts:30,58；ConversationShareLandingPage.tsx:91；zcode-builtin.json:16,20,38,42,85,107,705,726,747,810,832,854。
- 扫描方法论范本：docs/iterations/oh-my-zcode-fork/cache/p1-tt1-residual-scan.md。
