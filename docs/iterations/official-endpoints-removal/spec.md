---
date: 2026-10-05
---

# omz 官方端点全清（official-endpoints-removal）技术规格（SPEC）

## 需求来源

用户口述拍板（2026-10-05，对话记录见 `docs/apm/memory/20261005-telemetry-audit-confirm.md`）：omz 定位为**独立开源通用 agent，不再是 ZCode 自己的**。移除全部官方（智谱/Z.ai）端点集成：自动更新（未来更新走自己的 GitHub，本轮不留代码）、登录 OAuth、Coding Plan 计费/订阅/额度、会话分享、帮助配置、闲时任务 server、marketplace CDN 源（保留本地插件安装，市场结构留空壳待未来接自己 GitHub）。产品目标：删除完成后**唯一出网点 = 用户自配 provider 端点**（涉密组织可用的代码前提，配合 T-T4 抓包验收）。

探索证据（四份 readonly 报告，本 spec 文件级细节全部追溯到这些报告）：
- `cache/explore-A-account-model-access.md`（账号体系与模型访问链）
- `cache/explore-B-desktop-official-ui.md`（桌面 main+UI 官方面与更新链）
- `cache/explore-C-marketplace-offpeak.md`（插件市场 CDN 链 + 闲时/自动化）
- `cache/explore-D-endpoint-infra-gates.md`（端点基建死代码判定 + 构建/测试/文档约束）

基线：main=ba7c240（v0.1.1）之后新分支。上游参照 `.reference/ZCode`（只读）。

## 设计目标

1. 删除下列官方端点集成面：自动更新整链、账号/登录/OAuth、Coding Plan 订阅/计费/额度/购买 webview、会话分享（发布+导入）、帮助配置/反馈/社区/changelog/productDocs、闲时任务远端 server、marketplace CDN 拉取、Built-in provider 配置远端下发、官方 coding-plan 网关劫持。
2. 保留能力（防误删白名单见下）：纯外部 API 模型访问、MCP OAuth、本地 cron 自动化、bots（第三方 IM）、本地/自建源插件安装、远端工作区机制、本地导出、onboarding 主体。
3. 涉密验收：出网点静态扫描白名单外 0 命中；T-T4 真机抓包仅用户自配端点。

## 总体方案

按**功能域横切**推进：每个 Step 删一个功能域的「shared 契约 + 全部跨包消费者」并在 Step 末跑相关门禁（Phase 1 遥测移除的按包纵切容易留半删即崩中间态，本轮域横切让每步自洽）。顺序：先门禁准备（i18n parity 脚本）→ 自动更新（最独立）→ 账号核心（registry/模型执行）→ services 账号面 → CLI+UI 登录/订阅 → 分享 → offPeak → 帮助 → marketplace → 端点基建死代码收口 → 文档合规 → 全量回归+抓包。

关键架构处置（详见 D-* 决策）：
- Registry 双数据源（config + account overlay）**单源化**：accountSource 降为恒定空 overlay，复用既有 `EmptyAccountProviderConfigSource` 形态（A 报告证明「账号缺席、外部 API 独立可跑」是既有设计）。
- 模型请求通用头（HTTP-Referer/X-Title/X-Release-Channel/X-ZCode-Agent）**保留机制、默认值去官方化**。
- 端点注入机制三件套（`__ZCODE_ENDPOINT_ENV__`/`pickProductEndpointEnv`/`readProductEndpointEnv`）**保留为构建基础设施**（web bundle 配置入口 + host/scheduler 子进程 env 组装 + shared 子路径导出三方复用），改为「无官方默认值的可选覆盖」。
- MCP OAuth 凭据底座（shared-credentials/localhost-callback/credential-cipher）**完整保留**，仅删 ZCode 账号键族。

## 关键设计决策

- **D-1 自动更新整链删除**：含强更 gate、更新状态子窗口、菜单/托盘入口、preload/renderer 14+13 方法、设置项、electron-updater 依赖、electron-builder publish 段。v0.1.1 GitHub release 流与 latest.yml 通道零耦合（B 报告 §2.1），不受影响。未来 GitHub 自更新另行立项。
- **D-2 marketplace 空壳 + 存量记录改写（重写而非移除）+ 缺失补录**：`DEFAULT_PLUGIN_MARKETPLACES` 置空数组+注释扩展位（探索 C Q1b 方案）；**ensure 收敛双动作**（`ensureDefaultPluginMarketplaces`）：①对 `known_marketplaces.json` 中官方 id（canonical+legacy）的**既有**记录**就地改写 source 为本地源**（`{source:"directory", path:<storageRoot>/marketplaces/oh-my-zcode-official}`），保留 id/name/pluginCount 并清 `lastRefreshFailure`（**legacy 记录除外**——其 id 按下述②收敛为 canonical，不走「保留 id」）；②官方 canonical id **缺失时补一条** directory-source known 记录（id=`ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID` 常量，name/pluginCount 自 bundled merged manifest 或常量推导）——否则全新 profile 下 `DEFAULT_PLUGIN_MARKETPLACES` 置空后无人创建记录，`catalogs/availablePlugins`（bootstrap/plugins.ts:279-314 全自 known 推导，`resolveEffectiveMarketplaceRecords:1094` 对官方 id 补录 continue 无二次兜底）官方段全空。directory source 在 marketplace.ts:1545-1561 只读文件零网络；刷新经 addMarketplace:396-403 官方分支时改为**直接沿用 loaded.manifest（或显式保留一次 rebuildOfficialMarketplaceSync），二者等价**（原 CDN 写盘分支摘除后此为替代形态）。bundled seed 链（writeBundled 分片/loadBundledOfficialPluginRootsSync/scanOfficialCache/officialPluginCache 三处硬编码路径）完整保留；S33 legacy 别名（zcode-plugins-official）与 CDN 写盘分支摘除；官方插件 icon CDN 删（UI 降级字母头像）——**含两处 icon 资产消费**：`bootstrap/official-plugin-definitions.ts:58` 的 `OFFICIAL_PLUGIN_ASSETS_BASE_URL`（9 处 listing icon）与 `packages/ui/src/v4/featureSuggestedPrompts.ts:11` 的 `ASSETS` 基址（22 处 CDN 派生 iconUrl），后者降级为本地静态资产/字母头像（该文件已 import 7 个本地静态资产，有既有落点）；`OFFICIAL_PLUGIN_DEFINITIONS` seed 定义完整保留，listing 保留除 icon，`ZAI_AUTHOR` 改 fork 自有标识。canonical id `oh-my-zcode-official` **不改**（磁盘目录名+已装插件 id 后缀）。**②补录判据**：canonical **与** legacy id 均不在 known 中时才补录；legacy 记录就地改写时同时收敛为 canonical id（防 legacy-only 存量下出现同指本地目录的影子重复记录，违反 addMarketplace:370-374 的不并存不变量）。
- **D-3 offPeak 删 / cron+bots 留**：offPeak 远端链全删（services 6 文件+scheduler 装配+UI idle tab+core 工具面）；`automations` 本地 cron（AutomationRepo/claimDue/CronRun/botDeliveryTarget/cronBotDelivery）完整保留；`AutomationsSection` 收窄 scheduled-only（既有 `resolveVisibleAutomationTabs(["scheduled"])` 支持）。`off_peak_tasks` 建表迁移历史**不可删**（停止新增即可）。`assertNotOffPeakTurn` 的 SendMessage/Bash 纵深防护**改挂中立位置保留**（C 报告 T1）。
- **D-4 账号体系整删**：adapters auth（bigmodel-oauth 死代码/cli-oauth/coding-plan-api-key/browser 删；shared-credentials 瘦身删 8 个账号键族）、services oauth/、订阅 provider、official-mcp 凭据、usage 官方 providers、feedback；`zhipu-account` access 型全链删除；`/login` `/logout` 命令面删；UI 登录树删、首启直接主界面。
- **D-5 官方 coding-plan 网关删除**：`createOfficialCodingPlanGatewayFetch` 按 URL 劫持**所有** provider transport（用户自配 api.z.ai baseUrl 也被改写）——劫持语义与通用 agent 定位冲突，整删（A 报告 §2.3）。
- **D-6 Built-in 远端配置下发删除（已拍板，非检视）**：`zcodeBuiltinRemoteConfig`/`zcode-builtin-download` 删，provider 目录冻结为打包内置 `zcode-builtin.json`（未来随版本发布更新）。**`clientConfigService` 整删**（`/api/v1/client/configs` 消费者收口，`usePluginStoreOrder` 退化为空序/内置序）；**`clientScenesService` 删网络拉取改本地内置模板清单**（`/api/v1/client/scenes` 的两个消费方兜底：`AutomationsSection` scheduled-only 的模板区与 `useDraftSuggestedPromptItems` 改读内置默认，无网络）；`services/src/providers/api/apiEndpoints.ts` **整文件删**（模块顶层 `ZCODE_CLIENT_SCENES_URL`+`ZAI_API_HOST`）。
- **D-7 分享发布+导入全删**：UI 12 文件、SessionPane 装配段、deep link `zcode://…/share/<code>` 支路、`localizeConversationShareUrl`、shared-context-import 硬绑段。deep link 四合一路由**保留 workspace 支路**（B 报告 §5.3）。`deleteSharedContext` 协议命令与分享不同物，保留。
- **D-8 帮助/反馈/社区/changelog/docs 整块下线**：`config/default.json` 三官方 URL 删、远端 help config 删、内嵌反馈对话框删（其 feedbackService 上报官方端点）、CanOpenCommunity/openChangelog/productDocs/quickpick 社区项删。帮助菜单仅留本地项。【待拍板-5：可改为指向 fork GitHub repo 链接】
- **D-9 通用模型请求头去官方化**：`ZCODE_SOURCE_HEADERS`（HTTP-Referer/X-Title）与 `model-config.ts` 复刻头保留机制，默认值由 `zcode.z.ai` 改为 fork 自有标识（如 `https://github.com/<owner>/oh-my-zcode`）；`X-ZCode-Agent: "glm"` 改 `"oh-my-zcode"`；`X-Release-Channel` 语义保留（产品身份）。涉密关键：不再向任何 provider 泄露官方域名。【待拍板-1/-7 确认具体值】
- **D-10 deviceMid 两留两删**：`cli-device-mid`（Anthropic 通用请求 metadata，本地脱敏）与 `desktopDeviceMid`（renderer owner/observer 身份）留；`services/deviceMid`+`server/stdioDeviceMid`（Start Plan billing 耦合）删。`telemetry-state.json` 文件名/路径口径不变（跨端身份文件，改名=重置全部用户身份）。`sourceHeaders.ts` 删 deviceMid 段（注入点只剩官方出口）。
- **D-11 端点基建按判定表瘦身**（D 报告 §3 全表）：B 组 BigModel/ZAI 符号全删；A 组 `resolveRuntimeZCodeEndpointOrigin`（HTTP-Referer/缓存键）、`normalizeZCodeEndpointOrigin`（通用校验）、`resolveRuntimeZCodeEnv`、注入三件套**留**；`buildRuntimeZCodeEndpointUrls`/`resolveRuntimeProductEndpointConfig`/`isTrustedCodingPlanWebviewOrigin` 删；`buildZCodeEndpointUrls` 瘦身为 origin/apiBaseUrl 两键；`DEFAULT_ZCODE_ENDPOINT_ORIGIN` 常量删除、`rewriteZCodeEndpointUrl` 随 NodeApiClient 收窄同步处置（防静默 no-op）。`model-provider-family.ts:45` 顶层求值必须同批重构（删 `buildBigModelCodingPlanTeamManageUrl` 而不改该行 → shared barrel 初始化抛错；因是编译期可检类型断链，表现为 typecheck 立即红而非运行时崩，但漏改即全仓不可编译）。**打包身份三处改值**：`packages/desktop/electron-builder.config.js` 的 `extraMetadata.homepage`（:453）/`author.email`（:456）/`deb.maintainer`（:697）官方标识改 fork 自有标识（取值与【待拍板-9】同批确定）——**不得删除**（Linux fpm 打包硬性校验字段，缺失产物阶段失败）。
- **D-12 旧会话 `account:*` 容错**：**不改 `validateSelection` 本体**（纯判定，`providerProvisioningTarget.ts:113-120` 依赖其断言语义）。**唯一落点 = `ApiProviderModelRuntime.modelFactory` 入口**（`provider-registry-model-runtime.ts:43-54`；`createRegistrySelectionProtocolError` 的 provider-not-found 分支从 `resolveRegistryOwnedModelSelection` **不可达**——:105-107 先软返回 undefined，故不作落点）。API 方案：给 `ApiProviderModelRuntimeOptions` 增 `resolveFallbackSelection?: (bad: ModelSelection) => ModelSelection | undefined`，**注入来源=`ZCodeAppOptions.configuredDefaultModelSelection`（types.ts:144-145 已存在，zcode-protocol-entrypoint.ts:68-78 已有注入链，无需新增装配）**。**回退必须先经 `this.#registry.validateSelection(fallback)`：`ok` 才以 fallback 重建 Model（`logger.warn` 记 bad/fallback）；`!ok` 保留原 `createRegistrySelectionProtocolError` 抛出**——否则 `#createRegistryModel` 的 `target.selection.options!.reasoningLevel!`（model-runtime.ts:73）会 TypeError（`ModelSelection.options` 与 `options.reasoningLevel` 均 optional，用户配置的 default 很可能不带）。执行时先复现旧会话失败环（复现结果只用于确认落点，不推翻落点）。不新增 migration。【待拍板-2】
- **D-13 providerFamilyDomain 字段保留，family 字段级瘦身**：`MODEL_PROVIDER_FAMILY_SPECS` 是 **2 个 family**（zai/bigmodel），各含 startPlan/individualCodingPlanProviderId 等 3 个 codingPlan providerId 字段——**删这 6 个字段，family 本体保留字段集 `{ id, label, rootDomain, oauthProviderId }`**（`oauthProviderId` 仍被 `StatusCards.tsx:249`、`useModelProviderNavigation.ts:95/114` 消费，误删即断）。`teamCodingPlanManageUrl` 字段**两处形态**（`:35` 字面量 URL 与 `:45` 构造调用，含 import）随 S5 删（唯一消费者 `providerFamilyConnectionVisibility.ts:484,630,676` 在 S5 订阅删除面内）；`list-models.tsx:4` 的 `getModelProviderFamilySpec` import 在 :164 消费点删除后成未用 import，须同步摘除（knip/lint 会报）。连带面（登记降级，**一律按符号口径不按行号**）：`MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID` 变恒空 Map，`resolveModelProviderFamilyIdByProviderId` 恒 null——`list-models.tsx:162-175` 分组名回落 providerLabel、`providerFamilyDomainMigration.ts` **整文件两函数**（`inferProviderFamilyDomainFromSelection`+`ensureProviderFamilyDomainMigration`，后者含依赖 services.oauthService 的 OAuth 分支，S4 删 oauthService 后简并为恒 null）、`WorkspaceSidebarFooterUsageSummary.tsx:146`/`modelTriggerDisplay.ts:48,119` 同走 null 兜底；其余 `resolveModelProviderFamilySpecByProviderId` 消费点（shared 外实测约 60 处引用）分三类——**保留面·零改动**走既有兜底（`modelSelectionGroups.ts:76` 兜底已存在、`StatusCards.tsx:249` 只读保留字段 oauthProviderId、`ModelProviderSection.tsx:878` 只读 familySpec.id、`Navigation.tsx:76`/`Detail.tsx`/`ProviderFamilyModeHeader`）；**须显式重写**（r5 核实无兜底、直接读被删字段）：`ModelProviderSection.tsx:191-195 resolveProviderFamilySideNodeKey`（读 startPlanProviderId，回落 null——调用点 :226/299/343 已有 `?? item.key` 兜底可承）与 `:1100-1111 startPlanSubscriptionCount`（索引 startPlanProviderId，随订阅面删）；**静默行为回归·必须摘除**：`ModelProviderSection.tsx:168-177 shouldShowPresetProviderForActiveOAuth`+`:610` 调用——它是 **preset provider 列表可见性过滤器**（非 codingPlan 守卫），family map 恒 null 后 `resolveModelProviderFamilyIdByProviderId(presetId) === domain` 恒 false，升级用户（providerFamilyDomain 持久化非空）设置页**内置 preset provider 全部消失**且 T-AC3 首启场景测不出——删函数+filter 去掉该条件；**订阅面**随 S5 删除（`useModelProviderNavigation.ts:202/468/528/535/540`、`startPlan*`/`codingPlanUsageSources`/`V4ComposerToolbar` 相关）。`list-models.tsx:3-6` 的 `getModelProviderFamilySpec` 与 `resolveModelProviderFamilyIdByProviderId` **两个 import** 随 `:162-165` 死路径删除同步摘除（knip/lint 会报）。降级结论写入 CHANGELOG（S11）。**`teamCodingPlanManageUrl` 字段（:45，含 `buildBigModelCodingPlanTeamManageUrl` import）随 S5 一并删除**——唯一消费者 `providerFamilyConnectionVisibility.ts:484,630,676` 在 S5 订阅 UI 删除面内（该文件原本被 r1 误标「保留」，r2 核实其承载购买页可见性判定，属删除面）。settings 字段与 CAS 并发比对不动。轴一扫描白名单登记：`model-provider-family.ts` 内 `rootDomain: "z.ai"|"bigmodel.cn"` 两行（现 :30/:40；S5 删 teamCodingPlanManageUrl 后行号上移，**T-INF1 按符号复核不按行号**）、`ui/settings/model-provider-section/constants.ts:83,90`（purchaseUrl，provider 预设配置数据）。
- **D-14 presentation surface 翻转接受**：`desktopContextPromptRollout` 删（官方灰度），`ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED` 跨包清理后 `resolveZCodeAgentPresentationSurface` 恒 undefined（桌面上下文注入恒关）。行为翻转记录在 CHANGELOG。【待拍板-3】
- **D-15 remoteCdn 去默认值**：`DEFAULT_CDN_BASE_URL` 删，未配置则远端 workspace 资源不下载（机制保留）。`.env.example` 的 `ZCODE_CDN_BASE_URL`/`ZCODE_REMOTE_ASSET_CDN_BASE_URL` 8 个官方端点变量删（留内网自配 3 个）。
- **D-16 zcode-builtin.json 分段处置**：8 条 `account:*` 规则删；`zcode.z.ai/api/v1/zcode-plan/*`、`off-peak/*` 网关段删；bigmodel/zai **标准开放 API 预设保留**（用户自配 key 的普通 provider 预设，属配置数据非出网点）。
- **D-17 web 包最小处理**：shared 符号删除波及处做编译通过的最小修复+update stubs/communityUrl 删；web UI 级清理登记遗留（非目标面）。
- **D-18 i18n parity 门禁新建**：`scripts/check-i18n-parity.mjs`（zh/en key 集合相等为门禁；现状差 1+21 域内不对称，S1 先修齐作基线）。`shared/desktopMenu.ts` 既有类型约束同步。
- **D-19 首启流程**：WelcomeScreen 删后 Root 两级早退，首启=主界面+OccupationOnboarding；provider 配置走设置页（`LoginApiKeyForm` 删除损失的「首启一步配置」引导不补，后续可自建）。侧栏 profile/plan badge 区显式重构（不留占位 UI）。
- **D-20 dynamicWorkflow 灰度本地化**：`getDynamicWorkflowClientConfig` 远端灰度删后，动态工作流客户端开关改本地配置（默认 **true**，保持功能可用）【待拍板-4】。`getOffPeakClientConfig` 随 offPeak 删；`getForceUpdateConfig` 随更新链删；`getStaticProducts` 删。
- **D-21 image-search / restore-legacy-sessions 插件**：二者依赖官方 MCP 认证（C 报告 Q3），从 `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS` 移除、定义保留（seed 不装）【待拍板-6】。

## 防误删白名单（探索报告提炼，评审与残留扫描共用）

MCP OAuth 底座：`shared-credentials.ts` 文件本体、`localhost-callback.ts`、`credential-cipher.ts`、`credentialService.ts`、credentials.json 文件本体与 `mcp:oauth:*` 键、`credentialKeySchema` 全量校验。
市场承重：`scanOfficialCache`、`loadBundledOfficialPluginRootsSync`、`writeBundledOfficialMarketplacePartitionSync`、`rebuildOfficialMarketplaceSync`（简化不删）、`requiredSeedPaths`、`officialPluginCache` 路径、非官方源解析（url/github/git/npm/file/directory）、`PluginStorePage` 手动刷新、`PluginAddMenu`、`upsert-dev-marketplace.mjs`、`DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS` 两份对账（按 D-21 调整后仍需对齐）。
offPeak/cron 切分线：`AutomationRepo`/`claimDue`/`MISFIRE_GRACE_MS`/`HostMessageTypes.CronRun`/`isAutomationMutationRestrictedTurn`/`botDeliveryTarget`/`cronBotDelivery.ts`/bots 全目录。
模型请求通用面：`ensureCliDeviceMid`→`anthropic-request-metadata.ts`、`ensureDesktopDeviceMidSync`→`GetDeviceId`/`streamClientId`、`nodeApiNetwork` 全文（undici Agent/ProxyAgent/自签 CA 企业代理能力，与官方端点无关）、`NodeApiClient` **类骨架**（官方耦合仅三处符号可摘：`rewriteZCodeEndpointUrl`+`DEFAULT_ZCODE_ENDPOINT_ORIGIN`+`buildZCodeSourceHeaders` 注入，其余保留）、`resolveRuntimeZCodeEndpointOrigin`、`__ZCODE_ENDPOINT_ENV__` 三件套、`remoteWorkspaceServiceCollection.ts:185` baseUrl。
UI 承重：onboarding 主体与 `useOnboardingTrigger` 3s 兜底、`contextUsage.tsx` 通用区（瘦身非删除）、`desktopWindowChrome` `will-attach-webview` 通用钩子、`exportLogs`/`previewPane*`/`deleteSharedContext`、`SessionPane` 非 share/quota/login 段。
门禁流程：`licenses.mjs notices` 重生成（EMFILE 方案见 UPSTREAM-SYNC.md:114）、`typecheck-desktop-full.mjs` 差分键机制、knip stash 对比法。

## 变更点清单

文件级清单以四份 cache 报告 §4/影响面表为准（A §4 账号、B §4 桌面/UI、C §4.1-4.4 市场+offPeak、D §3/§4 端点基建），本 spec 不重复罗列；Step 与报告小节的映射：

| Step | 功能域 | 证据锚点 |
|---|---|---|
| S2 | 自动更新 | B §2.1/§4A/§5.1 |
| S3 | 账号核心（adapters/bootstrap/provider） | A §2.1/§2.2/§4A/§4B 前半 |
| S4 | services 账号面+Built-in 下发 | A §4A services 段/§5.5-6；D §8 |
| S5 | CLI /login + UI 登录/订阅/额度 | A §2.5/§4A UI 段；B §2.3/§2.4/§4C/§4D/§5.2 |
| S6 | 分享 | B §2.5/§4E/§5.3 |
| S7 | offPeak | C §2.6-2.8/§4.4/§5 T1-T6 |
| S8 | 帮助/反馈/社区 | B §2.2/§2.6/§4B/§5.3 |
| S9 | marketplace CDN | C §2.1-2.5/§4.1-4.3/§5 T3-T4 |
| S10 | 端点基建死代码收口 | D §3/§4/§5/§7 |

## 详细实现步骤

- Step 1 — phase-gates-prep — blocking: yes — qa: auto：新建 `scripts/check-i18n-parity.mjs`（zh/en key 集合 diff，非零退出）并修齐现状不对称（5891/5892 差 1 + share/usage/codingPlan/account 域 21 键）作为基线；**落盘测试名单快照** `cache/test-suite-inventory.md`（枚举全部 package.json 接线的 test 脚本：路径+脚本名；r2 实测接线 13 条=magic-context 6+bootstrap 4+adapters 2+cli 1，core/contracts 的 3 个脚本为直接 node 跑不在接线内——名单以脚本枚举为准）；desktop-typecheck-baseline 当前态留档；建分支 `feat/official-endpoints-removal`。
  > 【执行注记 2026-10-06，impl-s1 f871822】parity 脚本实测仅 1 键不对称（`settings.memory.viewer.disabled` en 侧多余、两侧无消费已删，两侧各 5891）——「share/usage/codingPlan/account 域 21 键不对称」为探索期误报（该 21 为 r2 轮域内 key 总数差 zh794/en815 的口径混淆，非不对称键数）；各域 asym=0。名单快照已落盘（接线 13 条+未接线 7 条清单）。
- Step 2 — phase-auto-update — blocking: yes — qa: auto：按 B §4A+§5.1 全表执行：desktop main 5 文件整删；index.ts 装配重构（强更 gate 渗透 5 处、`SecondInstanceWorkspaceDeps` 接口收缩、updateStatusWindow、appShutdownPolicy 简化、prepareWindowsProcessesForUpdateInstall 孤儿对）；菜单三处（含托盘）+ `setAutoUpdaterMenuLocale` 调用；IPC 两处注册点+options 类型；preload 13 方法+3 on 转发；renderer desktopPlatform 14 方法+main.tsx update-status 分支+UpdateStatusWindowRoot；UI UpdateStatus* 族/useDesktopUpdateMenu/useAppChromeState hasUpdateReady/SettingsPage 两个开关+settingsPageHelpers；shared channels 12 常量/platform 14 方法/protocol 4 字段/validationAppSettings/desktopMenu 5 条/update.ts/forceUpdate.ts；electron-builder :749-759/:141-145（"ms" 删需验证 debug 链）/dev-app-update.yml/依赖 electron-updater+lockfile。判据：T-AU1。
- Step 3 — phase-account-core — blocking: yes — qa: auto：adapters auth 删减（A §2.1 表）+ `auth-login.ts` 全族 + `standalone-account-provider-runtime.ts` 整删 + `process-provider-registry-runtime` 无账号化 + `model-execution.ts:355` 无条件 apiKey + 网关装配删（D-5）+ runner accountAccess 链 + `ProviderRuntimeHeadersPort` 整族（含 session-title defer 配套）+ provider 包（sources 恒空/registry-service 单源化/resolver/config-service/schema/rule-data zhipu-account 删）+ provider-node runtime + `zcode-builtin.json` account:*/网关段（D-16）。
- Step 4 — phase-account-services — blocking: yes — qa: auto：services/oauth/、bigmodel/、coding-plan-subscription/（先按 D-20 处置四个 config 方法：dynamicWorkflow 本地默认/offPeakClientConfig 随 S7/forceUpdate 随 S2 已删/staticProducts 删）、accountProvider* 11 文件、zaiStartPlanBilling/bigmodelStartPlanZcodeJwt、official-mcp/officialMcpCredentials、usage-stats 3 providers、feedback/、conversationShareHttpClient、offPeakRuntimeModel、node.ts 装配块（1390-1700/2062-2093）+ accessor 字段（oauthService/feedbackService/codingPlanSubscriptionService/usageStatsService，Wave 2 内与 S7 的 offPeakTaskService 分先后同波串行）；D-6 落地：zcodeBuiltinRemoteConfig/zcode-builtin-download/clientConfigService 整删（**removal 按文件级 6 个**：`services/accessor.ts`（:24 type import+:73 字段）、`services/node.ts`（:208/399/400/2459-2460）、`services/index.ts:304`、`client/remoteServiceAccess.ts:79/174`、`desktop/host/index.ts`（:30/1604/1649）、`desktop/host/remoteWorkspaceServiceCollection.ts`（:24/87/362）——编译期响亮，删后 typecheck 兜底）+ `providers/api/index.ts:9` 的 apiEndpoints re-export 摘除、`usePluginStoreOrder` 保留 hook 但返回 `{order:null, refresh:noop}`（3 消费者 PluginStorePage:64/WorkspacePluginPreview:63/pluginsMentionProvider:113 零改动）、clientScenesService 删网络改**内置本地模板**（数据落点 `packages/services/src/client-scenes/builtin-templates.ts` 新建；**模板 scene 固定 `"scheduled-task"`；每个 cronExpr 的 zh/en 两 locale 文本必须逐字相同；再过 `isValidCronExpr`+`canVisualizeCronInAutomationEditor`**——automationTemplateCatalog.ts:115/118/129 任一不满足即全量 reject 致 T-HP1 红；消费方 AutomationsSection:516,542 与 useDraftSuggestedPromptItems.ts:22 兜底）、apiEndpoints.ts 整文件删。
- Step 5 — phase-account-cli-ui — blocking: yes — qa: manual_user：CLI（login-command/create.ts login+logout 分支/login-flow/slash-commands:112/slash-command-types:52/history 过滤/run.ts:548-556/tui-auth/cli-types）+ UI 登录树（WelcomeScreen/login//useOAuth/useRootOAuthEffects/guard/oauth root 族 8 文件逐个判定/Root.tsx 重构——**canRestoreWorkspaceSession 死锁陷阱**/store 11 字段/侧栏 footer profile 区重构）+ 订阅额度 UI（B §4D 全表：CodingPlan 族/**providerFamilyConnectionVisibility.ts**（teamCodingPlanManageUrl 唯一消费者，随删，见 D-13）/contextUsage 通用区瘦身/quota banner/usage 分区+settingsPageConfig/coding-plan webview **四件套**：desktopWindowChrome 段+**desktopMainIpcRemote.ts:53-80 的 coding-plan webview origin 守卫（isCodingPlanPaypalNavigationUrl/isCodingPlanWebviewUrl，与 desktopWindowChrome.ts:293 同对）**+preload+tsup entry）+ **model-provider-family.ts:45 的 teamCodingPlanManageUrl 字段与 import 同批删**（D-13）+ D-12 旧会话容错（唯一落点 modelFactory + resolveFallbackSelection 注入，按 D-12）。**不删 i18n key**（归 S10）。
- Step 6 — phase-share — blocking: yes — qa: auto：B §4E 全表 + deep link 收窄（保 workspace 支路；onPaymentCallback/isPaymentCallbackUrl 随购买删）+ i18n share 域 key 删除归 S10。**composer 无需改动**：已核实 `ConversationComposer.tsx:574-577` 只消费 sharedContextImport，不读 `command.ts:104-123` 的 offPeakTaskId/offPeakRunType——执行方勿误改 composer。
- Step 7 — phase-offpeak — blocking: yes — qa: auto：C §4.4 全表（services 6 文件/scheduler index tick :97-102/desktopCron 瘦身/desktop main 转发 4 处/desktopHostProcess/host index/UI OffPeak 族+AutomationsSection 收窄/core：assertNotOffPeakTurn 中立化+offPeakTurn 7 处字段链+turn-loop-state 三信号/contracts+bootstrap 协议段/zcodeAgentService offPeak 段（S4 之后）/automationToolPolicy/shared v4 command+zcode-task-types/**`zcode-protocol-v4/telemetry.ts` 的 7 处 offPeak 命中**（C 约束 5）/channels+validation+test-ids/accessor+remoteServiceAccess **同 commit**（T6）/coding-plan OffPeakClientConfig+mock 分支/zcode-builtin offpeak 段/off_peak_tasks 迁移停止新增+孤儿数据说明）。**UI 残留补齐**（C §4.4 未列全）：`v4/ConversationTurnGroup.tsx:477-478,1196,1401`（OffPeakTurnCards+task 过滤）、`TaskListItem.tsx:660,751`、`ChatErrorBanner.tsx:34,77`、`lib/providerBusinessError.ts:16,245-252`、`settings/AutomationDesignPrimitives.tsx`、`settings/automationStatusFilter.ts`、`settings/automationTemplateCatalog.ts`、`workspace-grouped-tasks/*`。收口判据：`git grep -i offpeak -- packages/ui packages/shared packages/services` 仅剩白名单（迁移历史列名/注释/测试）。i18n offPeak 90 键×2 归 S10。
- Step 8 — phase-help — blocking: yes — qa: auto：desktopHelpConfig/desktopContextPromptRollout/singleFeatureRollout 整删 + ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED 跨包清理（services/node.ts、server/remote/connect.ts、shared/runtimeEnv.ts）+ presentation surface 翻转记录（D-14）+ config/default.json 删+extraResources 单项删 + OpenFeedbackDialog/feedbackStore openSubmit/openFeatureRequest/CanOpenCommunity IPC/quickpick 社区项/WorkspaceHelpMenuButton 3 项/productDocs/changelog + **web 最小处理扩充**（D-17，纳入删除而非遗留：`web/src/auth/webZaiOAuthConfig.ts` 随 web 登录面删、`web/src/share/ConversationShareLandingPage.tsx:91` 的 ZCODE_DOWNLOAD_URL 下载入口随 web 分享面处置——此两处若留会使 T-INF1 白名单外命中）。
- Step 9 — phase-marketplace — blocking: yes — qa: auto：C §4.1 删表+§4.2 保留线+§4.3 definitions 处置（D-2/D-21）+ **存量收敛（D-2 改写方案）**：ensureDefaultPluginMarketplaces 对 known_marketplaces.json 官方 id 记录**就地改写 source 为本地 directory 源**（非移除）+ mkt-alias 测试整删 + `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS` 两份同步调整 + **更新测试名单**（见 T-R1 名单机制）。
- Step 10 — phase-infra-deadcode — blocking: yes — qa: auto：D §3/§4 判定表落地（services/deviceMid+stdioDeviceMid+node.ts:129-130/sourceHeaders deviceMid 段/zcodeEndpoint 剩余死符号与 A 组解耦——**`model-provider-family.ts:45` 已随 S5 删除**（D-13），此处仅复核零残留）+ D-9 请求头默认值去官方化+D-15 remoteCdn 去默认值 + `.env.example` 8 官方变量删 + `official-glm-model-id` 瘦身（normalize 保留供 legacy 迁移）+ `shared/src/index.ts` barrel 摘 zcodeEndpoint re-export（knip 可见性）+ web update stubs（D-17）+ **i18n 统一收口**（login/share/codingPlan/account/offPeak 90×2/help/update 域双语对称删除+T-G1 parity 门禁；**desktopMenu 域的删除在 S2 已完成，本步只校验对称**——S5/S6/S7/S8 均不碰 locale 文件，本步单点完成）。
- Step 11 — phase-docs-compliance — blocking: yes — qa: auto：UPSTREAM-SYNC.md（§2 tag 链补本轮/§3 旧 id 别名行失效+**新增「同文件生死代码混合→按符号粒度判定重放/丢弃」规则**/§4 测试族数字勘误为 cache/test-suite-inventory.md 名单口径并附名单/§5 重采记录）；CHANGELOG（v0.1.1「静默降级」表述勘误+新区写明移除范围与「仅用户自配端点出网」+**D-13 family map 恒空降级**：list-models 分组名回落 providerLabel、providerFamilyDomain 迁移推断恒 null+D-5 网关删除对自配 api.z.ai 用户的行为变化+D-14 presentation surface 恒关）；NOTICE.md（零节加移除声明；第二节 7-8 行整删+「模型请求附加设备/会话标识」行精确改写——cli deviceMid 仍存在；第三节 telemetry-state.json 披露）；README 双语检查；THIRD-PARTY-NOTICES+inventory 重生成（EMFILE 串行方案后回滚）。
- Step 12 — phase-regression — blocking: yes — qa: auto：**八门禁**全绿（根 typecheck 0err/turbo/typecheck:desktop-full **fresh=0 后 --snapshot 重采**/lint 0e 无新增 warning/knip stash 对比零新增/oxfmt 改动文件零新增/**licenses.mjs check**/**architecture:check**——后者两项为本步必跑，S11 只做 notices 重生成）+ **测试名单内全绿**（判据=`cache/test-suite-inventory.md` 名单（S9 删 mkt-alias 后更新），非数字口径）+ E2E（四步主链路+resume 容错用例+隔离审计；seed 改 3 文件——credentials.json 不再复制）+ 轴一出网点扫描白名单外 0 + 轴二符号扫描白名单内逐条理由 + 外发通道探针 0 + desktop build + CLI build。tag `official-endpoints-removed`（版本号是否跳 v0.2.0 待发布时定）。
- Step 13 — phase-packet-capture — blocking: yes — qa: manual_user：T-T4 真机运行 30 分钟抓包（合并 Phase 1 遗留项），预期仅用户自配 provider 连接；完成后更新 `.iteration-state.yaml`：pending_user_items 的 T-T4 项、oh-my-zcode-fork 节 `:75` 登录种子口径（4 文件→3 文件）与测试族数量。

## 测试策略

新增测试与门禁以「防误删白名单」为反向验收（删完后白名单成员必须仍工作）：

### 测试用例

- T-G1 — blocking: yes — Step 1：i18n parity 脚本通过（zh/en key 集合相等）。
- T-AU1 — blocking: yes — Step 2：update 符号全仓 0 残留（channels 12 常量/platform 14 方法/preload/renderer/菜单/托盘/设置项枚举）；desktop build 绿；应用启动菜单/托盘无更新入口。
- T-AC1 — blocking: yes — Step 3/4：外部 API 端到端真实会话（自配 provider apiKey+baseUrl 发消息收回复）；`~/.omz/v2/credentials.json` 清理后仅剩 `mcp:oauth:*` 键。
- T-AC2 — blocking: yes — Step 5：含 `account:*` providerId 的旧会话 resume 打开（按 D-12 落点回退默认 provider，日志可查），`validateSelection` 断言语义不变（providerProvisioningTarget 测试不破）。
- T-AC3 — blocking: yes — Step 5：首启直接主界面无死锁（canRestoreWorkspaceSession）；设置页 provider 增删改/选模型可用；侧栏无登录入口/无占位头像；**升级 profile（providerFamilyDomain 已持久化非空）下内置 preset provider 列表仍可见可编辑**（D-13 的 shouldShowPresetProviderForActiveOAuth 摘除验证——首启场景（domain=null 走早退）测不出该回归）。
- T-SH1 — blocking: yes — Step 6：分享菜单/dock 全消；`zcode://` workspace deep link 仍能开工作区；exportLogs 本地导出可用；composer 行为无变化（已核实不消费 offPeak 字段）。
- T-OP1 — blocking: yes — Step 7：cron 自动化创建+到点触发 E2E；SendMessage/Bash 工具回归（T1 陷阱）；设置页无 idle tab；`git grep -i offpeak -- packages/ui packages/shared packages/services` 仅剩白名单。
- T-MK1 — blocking: yes — Step 9：**全新 profile** 与**升级 profile**（预置含官方 CDN source 的 known_marketplaces.json 记录，**另加 legacy-only profile**（仅有 zcode-plugins-official 旧 id 记录））三场景：市场页显示 bundled 内置插件（官方市场分组与插件卡**非空**——机制=bundled seed 写 manifest 分片 + ensure 缺失补录/既有改写收敛为 canonical）且**零 CDN 请求**（升级场景验证 source 改写：手动刷新后 record.source 指向本地 directory 路径；**收敛后 known 中官方 id 有且只有一条 canonical**——legacy-only 不产生影子重复）；`file://`/`directory` 自建市场源添加+手动刷新可用；已启用插件（`browser-use@oh-my-zcode-official`）不丢；skills/commands/subagents 旁路（commandsService:259/skillsService:691）仍工作。
- T-HP1 — blocking: yes — Step 8：帮助菜单无反馈/社区/changelog/docs 项；openCommunity 无操作不报错；automation 模板区有内置兜底（clientScenes 本地化后 scheduled 模板非空且通过 isValidCronExpr+canVisualizeCronInAutomationEditor，rejectedScheduledTemplateIds 为空）。
- T-INF1 — blocking: yes — Step 10：轴一扫描（模式集 `zcode\.z\.ai|bigmodel\.cn|chat\.z\.ai|api\.z\.ai|cdn-zcode\.z\.ai|z\.ai`，单 glob 排除法；**扫描前剥离纯注释行**）白名单外 0——白名单显式登记：`model-provider-family.ts` 内 `rootDomain: "z.ai"|"bigmodel.cn"` 两行（**按符号复核不按行号**——S5 删字段后行号上移；同文件 `teamCodingPlanManageUrl` 两处形态——`:35` 字面量与 `:45` 构造调用——随 S5 字段整删一并消解，按字段符号复核）、`ui/settings/model-provider-section/constants.ts:83,90`（purchaseUrl，provider 预设配置数据）、`services/model-provider/legacyZCodeConfigProviderReader.ts:64`（历史迁移常量；S10 复核若无活消费者则连行删除）、zcode-builtin.json 的 bigmodel/zai 标准 API 预设与管理页深链（D-16）、LICENSE/THIRD-PARTY；web 的 `webZaiOAuthConfig`/`ConversationShareLandingPage` 下载入口已在 S8 删除（不属白名单）。剥离规则：**行首 `//`、行尾注释与 `/* */` 块注释全部剥离后再匹配**；`magic-context/src/host/config/schema.ts:16` 的「D-2 keeps exactly one backend (zcode.z.ai)」陈旧官方前提注释在 S10 改写为中性表述（官方单后端前提本轮已废）。轴二符号扫描白名单内逐条理由（**一律按符号口径复核，不按行号**）；探针 `fetch.*zcodeEndpoint|downloadZCodeBuiltinRelease|resolveRemoteCdnBaseUrls|createHostApiNetworkTransport` 0 命中（remoteCdn 机制保留但无默认值）。
- T-D1 — blocking: yes — Step 11：NOTICE/UPSTREAM-SYNC/CHANGELOG 与代码态一致（含 §4 测试族勘误为 cache 名单口径并附名单）；THIRD-PARTY 重生成 diff 与依赖闭包变化吻合（electron-updater 族净减）。
- T-R1 — blocking: yes — Step 12：八门禁+**`cache/test-suite-inventory.md` 名单内全部测试绿**（S9 删 mkt-alias 后更新的名单，非数字口径）+E2E 全绿；desktop baseline 重采后 fresh=0。
- T-T4 — blocking: yes — Step 13：真机抓包 30 分钟，仅用户自配 provider 出网（manual_user）。

## 风险与回滚方案

**风险分级**（完整陷阱表见四份 cache 报告 §5，执行 agent 的任务书必须逐条携带对应小节）：
- 半删即崩（最高）：`model-provider-family.ts:45` 顶层求值；`registry-service` 双源 revision 门；`setAutoUpdaterMenuLocale` 残留调用；canRestoreWorkspaceSession 死锁；accessor 必填字段与 DI 不同 commit。
- 静默行为变化：网关删除改变自配 api.z.ai 用户路径（D-5 记录 CHANGELOG）；presentation surface 恒关（D-14）；dynamicWorkflow 默认值（D-20）。
- 误删承重面：MCP OAuth 底座/市场 bundled 链/onboarding 主体/contextUsage 通用区/will-attach-webview 钩子/remoteCdn 远端 workspace。
- 门禁失配：desktop baseline 行号级快照必须重采；knip barrel 盲区先摘再采；licenses EMFILE 坑按 SOP。

**回滚**：每 Step 一组 WIP 检查点 commit（RULE.md 纪律），phase 边界可独立 revert；S12 前不打 tag，全量回归失败按 phase 二分定位回滚。数据面：不写任何用户数据迁移（credentials.json 只删键不重建文件；off_peak_tasks 孤儿数据无害保留）。

**执行纪律**（继承 RULE.md）：长任务后台派+TaskOutput 阻塞等+失败 SendMessage 续跑同 agent；并发 agent 提交必须带 pathspec 或独占作用域；网络闪断按 WIP 检查点恢复；改文件用 Write 类工具保 UTF-8+LF。

**执行顺序（按文件独占重排；本迭代以串行为主，仅标注允许的并行例外）**——共享热点文件多步交集，波内按序：
- **Wave 1**：S2（更新链，独占 desktop main/preload/renderer 的 update 面+shared update 契约+desktopMenu 域）。**允许与 Wave 2 的 S3 并行**（文件集不相交：S2=desktop/preload/renderer/ui UpdateStatus 族+shared channels/platform/protocol/validationAppSettings/desktopMenu，S3=apps/zcode-cli packages+provider 包；开工前执行 agent 需再核一次交集为空，有交集则改串行）。
- **Wave 2（串行）**：S3 → S4 → S7。`packages/services/src/node.ts`、`accessor.ts`、`zcode-agent/zcodeAgentService.ts` 三个多步共改文件集中在本波**串行**处置：S4 负责账号段（zcodeAgentService 的 accountRequestAuthService/accountProviderConfigSource/providerUpdateAccountConfig 等）+ accessor 的 oauthService/feedbackService/codingPlanSubscriptionService/usageStatsService 字段；S7 在 S4 产物之上做 offPeak 段（zcodeAgentService offPeak 46 行 + accessor 的 offPeakTaskService 字段与 DI **同 commit**）。S8 虽也动 services/node.ts（ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED 清理）但在 Wave 3，跨波不并行即无冲突。
- **Wave 3（按序合并）**：S5 → S6 → S8。三域（登录订阅/分享/帮助）文件集基本不相交，但共享 `preload/index.ts`、`desktopCommandHandlers.ts`、`desktopMainIpcPlatform.ts`、`desktopOAuthDeepLink.ts`、`useRootPlatformEffects.ts`、**`SettingsPage.tsx`**（S5 订阅块实测跨 :343-592+:701-716+:1452/:1555/:1759，S8 帮助菜单渲染点 :91/1327/1494 同文件；`settingsPageConfig.ts` 仅 S5 删 usage section 时触及、无 help 内容，不构成交集）——按 S5→S6→S8 顺序串行合并（后者基于前者产物改自己的段），不允许同时开工这三步。
- **Wave 4（串行收口）**：S9 → S10 → S11 → S12 → S13。
- **i18n 两份 locale 文件单点收口**：S5/S6/S7/S8 **均不删 i18n key**（组件删除后残留 key 不破 T-G1 对称门禁）；全部 key 删除（login/share/codingPlan/account/offPeak 域 90 键×2/help/update 域）统一在 **S10 i18n 收口**执行并跑 T-G1（desktopMenu 域 S2 已删，S10 仅校验）。
- 并发纪律（后台派+pathspec 提交）仅在「S2×S3 并行例外」与单步内部的子代理波次生效；其余按上述顺序单线推进。S12 前不打 tag；全量回归失败按 Wave 二分定位回滚。

## 待拍板清单（spec 确认时一并拍）

> **【执行注记 2026-10-06】** 用户调用 code-dev-loop 开工，未逐项回复——9 项按推荐值执行：1/HTTP-Referer/X-Title 改 fork GitHub repo URL；2/旧会话容错回退默认 provider；3/接受 presentation surface 恒关；4/dynamicWorkflow 默认 true；5/帮助菜单整块下线；6/两条官方认证插件移出默认启用；7/X-ZCode-Agent→"oh-my-zcode"；8/跳 v0.2.0；9/fork 打包身份用占位值（homepage=repo URL、author "oh-my-zcode <oh-my-zcode@users.noreply.github.com>"、ZAI_AUTHOR 同名占位——发布前可再改）。

1. **D-9 具体值**：HTTP-Referer/X-Title 默认值——改为 fork GitHub repo URL（推荐）还是彻底不发这两个头？
2. **D-12 旧会话**：account:* resume 容错回退默认 provider（推荐）/报错提示/写 migration 迁移到默认。
3. **D-14**：接受 presentation surface 恒关？（推荐接受，CHANGELOG 记录）
4. **D-20**：dynamicWorkflow 本地默认 true（推荐，保持功能可用）/false（最保守）。
5. **D-8**：帮助菜单整块下线（推荐）/留 GitHub repo 链接（需提供 repo URL）。
6. **D-21**：image-search/restore-legacy-sessions 移出默认启用（推荐，保留定义）/连定义一起删。
7. **X-ZCode-Agent**：`"glm"`→`"oh-my-zcode"`（推荐）/删头。
8. **版本号**：本轮破坏性变更是否跳 v0.2.0（推荐）。
9. **fork 打包身份取值**：homepage（建议=repo URL）、author.name、author.email、deb.maintainer（格式 `Name <email>`）、`ZAI_AUTHOR` 的 name/url（D-2）——electron-builder 三处与插件作者署名的具体字符串，需你给出（或先用 `oh-my-zcode` + 仓库 URL 占位）。
