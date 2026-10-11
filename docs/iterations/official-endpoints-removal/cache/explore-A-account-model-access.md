# 探索报告 A：账号体系与模型访问链

子代理：Explore（readonly）。HEAD=ba7c240（v0.1.1）。日期：2026-10-05。

## 1）探索范围

- **adapters/auth 全目录 8 文件**：index.ts、bigmodel-oauth.ts、cli-oauth.ts、coding-plan-api-key.ts、credential-cipher.ts、shared-credentials.ts、browser.ts、localhost-callback.ts
- **adapters/model**：model-execution.ts（300-580 段，:355 zhipu-account 分支与 :505-521 网关装配）、official-coding-plan-gateway.ts（全文）、runner.ts（90-330）、runner-runtime-headers.ts、runner-options.ts、runner-generate.ts
- **bootstrap**：auth-login.ts（全文）、app/standalone-account-provider-runtime.ts（全文）、app/process-provider-registry-runtime.ts（全文）、provider-registry-model-runtime.ts、provider-registry-selection.ts、create-app.ts（805-865）、zcode-protocol/provider-runtime-headers.ts
- **services**：providers/api/、coding-plan-subscription/、model-provider/（accountProviderConnectionResolver、providerRuntime、accountRequestAuthService、accountProviderInvalidation、providerProvisioningSource、zcodeBuiltinRemoteConfig、codingPlanProviderAvailability）、oauth/ 目录、credential/、official-mcp/officialMcpCredentials.ts、paths.ts、node.ts（1390-1700/2060-2130/2340-2400 段）
- **provider/provider-node**：account-provider-resolution.ts、sources.ts、resolver.ts、config-service.ts、config/{provider-config,provider-data-schema,schema,rule-data-schema}.ts、account-provider-service.ts、registry-service.ts；provider-registry-runtime.ts、runtime-paths.ts、zcode-builtin-download.ts
- **CLI/TUI**：login-command.ts（全文）、command-center/{create,login-flow,history,slash-commands}.ts、cli-types.ts、tui-auth.ts、tui-login-state.ts、run.ts、provider-runtime-env.ts
- **core/contracts**：runtime/methods/model-runtime-headers.ts、session-title.ts、runtime/types.ts:395-420、contracts/model/invocation-context.ts
- **shared/ui/config**：model-provider-family.ts、oauth.ts、model-provider-types.ts、zcode-protocol/index.ts 相关段、provider-provisioning.ts、plan-identity.ts、validationAppSettings.ts；ui/root/useProviderAvailabilityLoginEntryGuard.ts、lib/{modelProviderAvailability,accountProviderAccess,rootStartupGate}.ts、Root.tsx:395-475；config/provider/zcode-builtin.json:670-850；adapters/mcp/oauth*；session-store/migrations/0020/0021/0022
- 构建契约：根 package.json、architecture-policy.yaml、knip.json

## 2）现状实现摘要

### 2.1 auth/ 模块职责与消费者矩阵

| 文件 | 入口符号 | 消费者 | 备注 |
|---|---|---|---|
| bigmodel-oauth.ts | createBigmodelOAuthClient、createBigmodelOAuthState | **零消费者** | 已死代码 |
| cli-oauth.ts | createCliOAuthClient 等 | 仅 bootstrap/auth-login.ts | 默认 baseUrl 硬编码 https://zcode.z.ai/api/v1 |
| coding-plan-api-key.ts | createCodingPlanApiKeyResolver | 仅 auth-login.ts | 打 api.z.ai/api/auth/z/login、bigmodel.cn/api/biz/* |
| shared-credentials.ts | createSharedZCodeCredentialStore 等 | **adapters/mcp/index.ts（MCP OAuth 凭据）**、auth-login.ts、process-provider-registry-runtime.ts | 凭据文件 ~/.omz/v2/credentials.json；**同时是 MCP OAuth 通用凭据底座** |
| credential-cipher.ts | createZCodeCredentialCipher | 仅 shared-credentials.ts | 与 services 侧 credentialCipherProvider.ts 同算法两份实现 |
| browser.ts | openUrlInBrowser | 仅 auth-login.ts | |
| localhost-callback.ts | createLocalhostOAuthCallbackServer | **adapters/mcp/oauth-interactive.ts**（MCP 交互式 OAuth） | 与 ZCode 账号无关，MCP 通用能力 |

### 2.2 账号型访问 access.type="zhipu-account" 全链
- 定义：provider/config/provider-config.ts:76（ZhipuAccountAccessConfig）、provider-data-schema.ts:43、schema.ts:145-153
- 协议：shared/zcode-protocol/index.ts:763-800（zcodeAccountAccessSchema）、:2072-2103（provider/updateAccountConfig RPC）
- Registry 解析：resolver.ts:221（账号 provider 永 enabled）、:249-255（accessEntitled+accountCurrent 决定 providerExecutable）
- 第三层 Account Overlay：sources.ts（AccountProviderConfigSnapshot、createFailClosedAccountProviderConfigSnapshot）、account-provider-resolution.ts、account-provider-service.ts
- CLI 进程内：standalone-account-provider-runtime.ts（凭据+Built-in 合成 entitled overlay + ProviderRuntimeHeadersPort）；Desktop/Host 侧：accountProviderConnectionResolver.ts、node.ts:1400-1650
- 模型执行：model-execution.ts:355（非账号且 apiKey 才带 apiKey）、runner.ts:124-212（accountAccess 透传+refreshRuntimeHeadersBeforeAttempt）
- 配置层禁写：config-service.ts:158-167（账号 provider 不可 disable）
- Built-in 声明：config/provider/zcode-builtin.json:693-855 共 8 条 account:* 规则

### 2.3 官方网关（关键）
official-coding-plan-gateway.ts 的 createOfficialCodingPlanGatewayFetch 在 model-execution.ts:516-521 装进**所有** provider 的出站 transport，命中 open.bigmodel.cn/api/anthropic/v1/messages 与 api.z.ai/api/anthropic/v1/messages 时改写到 ZCODE_ENDPOINT_ORIGIN/api/v1/ultra[-zai]/...。**不看 access.type 只看 URL——用户自配 apiKey+同款 baseUrl 也会被劫持到网关**。

### 2.4 凭据落盘
~/.omz/v2/credentials.json（CLI/Desktop 共用同一文件，withFileLock+atomicWritePrivateTextFile 并发协调；onDidChange 是进程内 registry 刷新唯一触发）。键：oauth:active_provider、oauth:{zai,bigmodel}:*、zcodejwttoken、account-provider:*、MCP 的 mcp:oauth:<hash>:*。账号编码 revision:"account:"+JSON（sources.ts:61）；session-store migrations 0020/0021/0022 固化 account:* providerId 字面量。

### 2.5 CLI 命令面
独立命令 run.ts:548/556 → login-command.ts；slash：create.ts:86-201（/login、/logout）、login-flow.ts（TUI 4 选项）；登录态门禁 isLoginRequired（create.ts:396，判据=有没有可选模型）；免登录补丁 useProviderAvailabilityLoginEntryGuard.ts:57-63（shouldOpenLoginEntry = !user && !hasUsableProvider）。

## 3）与需求相关的约束

1. **shared-credentials.ts 不能整目录删**：MCP OAuth（第三方 MCP Server 授权）通用凭据底座，mcp/index.ts、oauth-credentials/refresh/lease/shared/interactive 六处依赖。localhost-callback.ts、credential-cipher.ts 也是 MCP 承重件。
2. **AccountProviderConfigSnapshot 是 Registry 第二数据源**：registry-service.ts:190-231 无条件 Promise.all 双源读取，revision 不齐时保留旧快照（:205-212）。删账号必须同时降恒定空 overlay，否则 Registry 永不发布。
3. **EmptyAccountProviderConfigSource（providerRuntime.ts:50-60）已证明「账号缺席、外部 API 独立可跑」是既有设计**——删除后可直接复用的降级形态。
4. access.type 是 Registry 判定承重字段（resolver.ts:221/249-255），删 zhipu-account 分支需重新推导 personal provider 判定式。
5. 凭据 schema 全量字符串校验（parseCredentialRecord），**任何一个非字符串 value 会让整份文件不可读**——删账号键必须走「删除指定 key」而非「重建文件」。
6. providerFamilyDomain 只是 UI family 语义（null → 全展示安全降级）；删字段需同步 validationAppSettings.ts:458-460/526-528、settingService.ts:307/404。
7. **BigModelCodingPlanSubscriptionProvider 承载非账号远端配置下发**：getDynamicWorkflowClientConfig（动态工作流灰度）、getOffPeakClientConfig（闲时灰度）、getForceUpdateConfig、getStaticProducts，走 /api/v1/client/configs，node.ts:2078/2093 无条件注入。**整目录删会连带砍掉动态工作流灰度开关**（本就 fail-closed）。
8. 官方网关只看 URL 不看 access 类型（见 2.3）——删除会改变「用户自配 api.z.ai baseUrl+自己的 key」路径行为。
9. 构建契约：adapters/package.json:69 暴露 ./auth 子路径导出需同步改；**仓库内几乎无账号链路单测**（services/test/ 仅 3 个无关文件），删除缺测试护栏，风险靠人工。
10. knip 会报删完残留的孤儿导出；architecture-policy.yaml 无账号硬规则。

## 4）变更影响面

### A. 可直接删除（零外部消费者）
- adapters/src/auth/bigmodel-oauth.ts（已死）+ auth/index.ts 导出
- bootstrap/auth-login.ts 的 loginZCodeCli/loginBigmodelCodingPlan/configureCodingPlanApiKey/logoutZCodeCli/hasConfiguredStandaloneCodingPlan/ZCodeCliLoginError 全族
- adapters/src/auth/{cli-oauth,coding-plan-api-key,browser}.ts
- cli/login-command.ts、tui-auth.ts 的 4 函数、command-center/login-flow.ts 5 函数、create.ts login/logout 分支、slash-commands.ts:112、slash-command-types.ts:52、history.ts api-key 过滤、run.ts:548/556、provider-runtime-env.ts:127-128、cli-types.ts:21-33/75-81/102、i18n tui.loginSetup/loginRequired（部分）
- services/coding-plan-subscription/（bigmodel 1352 行+zai+service+descriptor）——**先剥离四个非账号 config 方法**
- services/oauth/（oauthService.ts 1193 行、zai/bigmodel ProviderAdapter、oauthCredentialRepo、oauthUnauthorizedRequest、callbackAttribution、runtimeConfig、oauthProfileSchema）
- services/bigmodel/（codingPlanEntitlement、teamPlanApiKey）
- services/model-provider/accountProvider*.ts 11 文件、codingPlanProviderAvailability.ts、bigmodelStartPlanZcodeJwt.ts、zaiStartPlanBilling.ts、accountProviderTeamPlanRequestKey.ts、legacyTeamOrganizationResolver.ts、offPeakModelSelectionView.ts、providerProvisioning 的 OAUTH_CREDENTIAL_KEYS
- services/official-mcp/officialMcpCredentials.ts、session/offPeakRuntimeModel.ts（zcodejwttoken 通道）
- services/usage-stats/providers/{bigmodelUsageQuotaProvider,bigmodelSubscriptionProvider,zcodeMcpQuotaProvider}.ts
- services/feedback/（依赖 zcodejwttoken）
- services/conversation-share/conversationShareHttpClient.ts
- shared/oauth.ts、plan-identity.ts、coding-plan-reset.ts、usage-stats.ts accountAccess 分支
- config/provider/zcode-builtin.json 8 条 account:* 规则
- shared/model-provider-family.ts 的 startPlan/individualCodingPlan/teamCodingPlan 三个 providerId 字段
- ui：WelcomeScreen.tsx、login/、useProviderAvailabilityLoginEntryGuard.ts、oauthProviderFamilySelectionRefresh.ts、accountConnectionLossSuggestion.ts、useRootOAuthEffects.ts、providerFamilyDomain*.ts、useCodingPlanEntitlements.ts、ModelProviderSection.tsx account 分支、WorkspaceSidebarFooterUsageSummary 额度块等

### B. 需改造而非删除（承重面）
- shared-credentials.ts：保留，删 SHARED_ZCODE_CREDENTIAL_KEYS 8 个 oauth:*/zcodejwttoken 键、save/clearZaiLoginCredentials、ZaiLoginCredential* 类型
- localhost-callback.ts / credential-cipher.ts：保留（MCP）
- provider/sources.ts：fail-closed 改恒定空实现；revision account: 前缀改常量
- provider/registry-service.ts:187-231：accountSource 降可选恒定源，去 revision 对齐门
- provider/{resolver,config-service,config/*}.ts：删 zhipu-account 分支
- provider-node/provider-registry-runtime.ts:31-52、runtime-paths.ts ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV
- services/providerRuntime.ts：EmptyAccountProviderConfigSource 保留为 no-op
- services/node.ts：删 1390-1700、2062-2093 账号装配块；保留 credentialService、providerRuntime、订阅 service 四个 config 方法
- adapters/model-execution.ts:355 改无条件带 apiKey；runner.ts:124-215 删 accountAccess 分支；runner-runtime(-headers).ts、runner-options.ts:22、runner-generate.ts:347、runner-stream.ts:630/1159
- official-coding-plan-gateway.ts：**建议整删**（劫持语义与通用 agent 冲突；见拍板点）
- core ProviderRuntimeHeadersPort 整族可删（唯一生产者是账号路径）——但 session-title.ts:155-167 shouldDeferSessionTitleForRuntimeHeaders 必须一并清（否则首条消息标题永久 defer）
- services/providers/api/（nodeApiClient/nodeApiNetwork）：保留（clientConfigService、zcodeBuiltinRemoteConfig、Built-in 下发在用）
- bootstrap/standalone-account-provider-runtime.ts：整删；process-provider-registry-runtime.ts 装配块改无账号版
- services/credential/credentialService.ts + credentialCipherProvider.ts：保留（MCP 共用）
- services/zcodeBuiltinRemoteConfig.ts + provider-node/zcode-builtin-download.ts：**决策点**——是否保留从官方端点拉 Built-in provider 配置

### C. 迁移/失效面
- credentials.json 8 个 oauth:*/zcodejwttoken 键 + account-provider:* 键变孤儿（不影响 mcp:oauth:*）；需一次性清理或接受残留
- setting.json 的 providerFamilyDomain 系字段：删字段需同步 normalizeSettingsPatch.ts:82-89、settingService.ts:307/404 CAS 比对
- **旧会话 account:* providerId：resume 命中 provider-not-found → ProviderNotFound，旧会话打不开**——需产品决策（丢弃/回退默认模型/新 migration）
- legacyPersonalProviderConfigImporter 已跳过 builtin:/account: 前缀，导入路径天然安全
- revision account: 前缀消失 → registry-service hasSameSourceRevisions 与 process-provider-registry-runtime.ts:131 builtin-recovery 判定需复核

## 5）风险与疑点

### 承重面陷阱（看着是账号功能、实则被通用路径依赖）
1. **shared-credentials.ts = MCP OAuth 底座（最危险）**。只删 SHARED_ZCODE_CREDENTIAL_KEYS 常量与 save/clearZaiLoginCredentials，文件本体必须留。
2. localhost-callback.ts = MCP 交互式授权，误删破坏第三方 MCP Server 授权码流程。
3. **createOfficialCodingPlanGatewayFetch 挂在所有 provider transport 上，按 URL 匹配——用户自配 api.z.ai baseUrl 当前也走官方网关**。删=静默改变现有外部用户行为；不删=保留官方端点依赖。**最需拍板的取舍点**。
4. BigModelCodingPlanSubscriptionProvider 四个「配置下发」方法与订阅无关（动态工作流/闲时/强更/静态商品），node.ts 无条件注入。整目录删连带砍远端灰度开关（本就 fail-closed default）。
5. ProviderRuntimeHeadersPort 整族被 9 个 core 方法调用；删端口必须同删 session-title 的 defer 逻辑。
6. nodeApiClient/nodeApiNetwork 名字像官方 API 客户端，但 Built-in 配置下发链在用。删了 → 纯外部 API 用户永远只能用打包时的 zcode-builtin.json。
7. credential-cipher.ts 与 credentialCipherProvider.ts 同算法两份（同 fallback 字符串），删一份不破坏兼容但保留两份是隐患。
8. providerFamilyDomain 双重身份（UI 过滤 + 账号连接判据）；删账号后只剩 UI 语义但不能顺手删字段（CAS 并发保护）。

### 静默降级点（关键 8 处完全静默）
- sources.ts:35-53 fail-closed entitled=false（静默）
- registry-service.ts:205-212 revision 不齐保留旧快照（静默无日志）
- accountProviderConnectionResolver.ts:137 loadCodingPlanApiKey catch(()=>null)（完全静默）
- accountProviderCredentialService.ts:81/85 return null（完全静默）
- resolveCurrentAccountAccess 6 处 return null（完全静默）
- model-runtime-headers.ts:26-36 shouldRefresh false → 不装 refresh 钩子静态鉴权（完全静默）
- codingPlanSubscriptionProvider:257-268 配置下发失败 fail-closed（静默）
- create.ts:396-403 isLoginRequired 异常 return false（完全静默）
（另有 10+ 处抛错型/半静默，原文见任务通知）

### 与需求可能冲突处
1. **/login <provider>-coding-plan-api-key 手工填官方 Key 路径**：写 account-provider:* 键+zhipu-account overlay，非纯外部 API。删除后 /login 整条命令消失，用户只能走 /model 或设置页建 personal provider。需确认可接受。
2. **「移除全部官方端点」与 Built-in 配置下发冲突（最大未决点）**：zcode-builtin.json 非账号 provider（opencode 等）+ zcodeBuiltinRemoteConfig 从 zcode.z.ai/api/v1/client/configs 拉取。保留=仍有官方端点依赖；删除=Built-in provider 目录冻结在打包时版本。
3. 免登录补丁依赖 providerFamilyDomain 概念：v0.1.1 只是绕过，概念全链仍在；删账号≠删概念，一并删需评估 CAS 并发保护放宽。
4. 旧会话 account:* providerId（见 4C）。
5. credentials.json 是 CLI/Desktop/MCP 三方共用——不要顺手「清理」文件本体，否则 MCP OAuth 一起挂。

## 6）关键证据（核心锚点）

- shared-credentials.ts：createSharedZCodeCredentialStore、resolveSharedZCodeCredentialsPath、SHARED_ZCODE_CREDENTIAL_KEYS（8键）、save/clearZaiLoginCredentials、parseCredentialRecord:333
- cli-oauth.ts:4 DEFAULT_ZCODE_OAUTH_BASE_URL="https://zcode.z.ai/api/v1"；coding-plan-api-key.ts:4 ZAI_API_HOST
- localhost-callback.ts → mcp/oauth-interactive.ts:127；credential-cipher.ts：ZCODE_CREDENTIAL_SECRET
- model-execution.ts:355、:331-338 resolveProviderTransport、:505-521 网关装配；official-coding-plan-gateway.ts：OFFICIAL_CODING_PLAN_GATEWAY_ROUTES、resolveOfficialCodingPlanGatewayUrl
- runner.ts:124/137/153/174/200/212；runner-runtime-headers.ts:36-38；runner-options.ts:22
- provider/config/provider-config.ts:76 ZhipuAccountAccessConfig；resolver.ts:221/249-255/46；sources.ts:35-53/55-66；registry-service.ts:187-231；config-service.ts:158-167；account-provider-service.ts:202-209/215
- provider-node/provider-registry-runtime.ts:31-52/44-52、runtime-paths.ts:1-4
- config/provider/zcode-builtin.json:693-855（8 条 account:*）
- services：accountProviderConnectionResolver.ts:117-126/137/174/207/236-241/314-328；providerRuntime.ts:50-60 EmptyAccountProviderConfigSource；node.ts:1390-1700/2062-2093/2340-2400；bigmodelCodingPlanSubscriptionProvider.ts:202/221/246/276 四个 config 方法
- CLI：login-command.ts；create.ts:86-201/396-403；login-flow.ts；tui-login-state.ts
- core：runtime/types.ts:402-417 ProviderRuntimeHeadersPort；model-runtime-headers.ts；session-title.ts:155-167
- shared：model-provider-family.ts；zcode-protocol/index.ts:763-800/2072-2103/3627；zcodeEndpoint.ts:3-6
- UI：useProviderAvailabilityLoginEntryGuard.ts:57-63/101-107；modelProviderAvailability.ts；rootStartupGate.ts；providerFamilyDomain*.ts
- 历史：session-store/migrations/0020:22-25、0021:32、0022:4-9/48-51（account:* 字面量）
