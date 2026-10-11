---
date: 2026-10-05 23:40
title: 智谱遥测清理复核：管道已删净（双重验证），涉密使用仍有 4 项差距
keywords: 遥测, telemetry, ARMS, OTLP, T-T4, 抓包, 涉密, deviceMid, sourceHeaders, autoUpdater, zcode.z.ai, 白名单
abstract: 用户确认「智谱遥测是否处理干净、涉密组织可否使用」。复核结论：专用遥测链路（ARMS RUM/OTLP/telemetryCore/崩溃采集/会话遥测/漏斗归因，-40518 行）Phase 1 已删净且 cr-func 两轮通过，本日全库复查零真实残留（此前 grep 命中均为 camelCase 误报如 PrewarmStatus 含 armS）；但涉密可用≠遥测干净，差距 4 项：T-T4 真机抓包从未执行（挂 pending_user_items）、autoUpdater ManifestUpdateProvider 默认端点仍是 https://zcode.z.ai 且自动轮询、官方端点（OAuth/计费/CDN/分享/闲时）仍在、模型流量必须指内网。deviceMid 属白名单有意保留（本地文件+只读复用，仅随官方端点请求附带，纯外部 API 不带）。
---

user:
我确认下，现在智谱遥测已经全部处理干净了吗？在涉密组织使用是否可行？

assistant:
**结论：「专用遥测管道已删干净」成立（双重验证）；「涉密组织可用」是有条件可行，还差 4 项配套，不能开箱即用。**

已删净的证据（Phase 1，tag phase1/telemetry-removed=0e4c58d，-40518 行，cr-func 两轮 func-ready）：ARMS RUM 全家桶（@arms/rum-electron+patch+overrides）、OTLP exporter/SDK、telemetryCore 数仓上报通道（ZCODE_TELEMETRY_REPORT_ENDPOINT 唯一出口）、崩溃采集、conversationTelemetrySupervisor（1958行）、app/message/userAction telemetry、Coding Plan 购买漏斗归因、localTtft/rendererActionTrace/heap sample、11 个遥测 IPC 通道；依赖闭包 -47 包、notices -85 条；T-T1 白名单外代码级命中 0。本日（2026-10-05）对 main(v0.1.1) 全库复查：ARMS/OTLP/telemetryCore 零真实残留（git grep 命中全是 camelCase 误报——PrewarmStatus 含 "armS"、注释里的英文 "arms"）。

白名单有意保留（非遗漏）：deviceMid 设备标识（~/.omz/v2/telemetry-state.json 本地文件；sourceHeaders.ts 已改为只读不生成；仅随官方端点请求附带平台/OS版本/时区等 header，纯外部 API 请求不带）；turn 事实链（纯本地，驱动运行中任务数）；本地 MCP 资源采样 tracker。

涉密使用的 4 项差距：①T-T4（30 分钟真机抓包零遥测出网，blocking 门禁）从未执行，仅静态证据，挂 .iteration-state.yaml pending_user_items；②desktop autoUpdater 的 ManifestUpdateProvider 默认 manifest 端点=DEFAULT_ZCODE_ENDPOINT_ORIGIN=https://zcode.z.ai（manifestUpdateProvider.ts:185），存在自动轮询 check（autoDownload=false、Win 手动安装，但 check 本身出网）——fork 发布渠道换了但代码默认 feed 未改，涉密部署需禁用轮询或指内网；③官方端点仍在（OAuth chat.z.ai/bigmodel.cn、计费 zcode.z.ai/api.z.ai、marketplace CDN cdn-zcode.z.ai、分享、帮助配置、闲时 offPeakServerClient）——免登录（85258f0）可绕过大部分，但用户主动操作仍出网；④模型流量本身必须指向内网端点（ZCODE_BASE_URL/BIGMODEL_API_BASE_URL 支持重定向，v0.1.1 免登录+纯外部 API 已打通）。

涉密部署 checklist：网络层白名单只放行内网模型端点 / 显式处置 autoUpdater feed / 补跑 T-T4 抓包 / 免登录+外部 API 配置。

user:
自动更新移除（未来要更新也是自己 GitHub）；登录 OAuth、计费、marketplace CDN、分享、帮助配置、闲时任务 server、免登录补丁逻辑也全移除。定位拍板：omz 是开源通用 agent，不再是 ZCode 自己的。需要走迭代吗？

assistant:
**用户拍板产品方向：官方端点集成全清，omz 通用化。** 规模摸底（git grep -il 文件数，簇间有重叠）：login/OAuth 162 / codingPlan 计费 179 / offPeak 128 / autoUpdate 24 / 分享 55 / 帮助配置 7 / marketplace 105 / endpoint+deviceMid 78，并集估 300-500 文件——Phase 1 遥测移除同量级（314 文件/-40518 行），必须走迭代（防误删承重面如 Phase 1 的 D-8 turn 事实教训）。连带效应：官方端点全死后 deviceMid/sourceHeaders/zcodeEndpoint.ts 变死代码可顺手全删（涉密诉求正解）；zhipu-account 模型访问型删除后本机 historian.model=account:bigmodel 配置需迁移外部 API；上游同步成本上升（S34 SOP 对照面变窄，可接受）。待拍板：marketplace 是彻底删源（仅本地安装）还是接自己 GitHub；offPeak 远端删后本地 cron 调度去留（spec 探索定）。

user:
（AskUserQuestion 拍板）走独立迭代；marketplace 删 CDN 源、保留本地插件安装。开工。

assistant:
独立迭代启动：**docs/iterations/official-endpoints-removal/**（需求来源=用户口述，无 prd）。spec-generate 流程：4 个 readonly Explore 并行——A 账号与模型访问链（adapters/auth + services 订阅 + zhipu-account 语义）、B 桌面 UI 与 main 官方面（autoUpdater 全链/帮助配置/登录订阅分享 UI）、C marketplace+闲时自动化（CDN 拉取链边界 + offPeak/cron 边界）、D 端点基建死代码与构建测试约束（zcodeEndpoint/deviceMid/sourceHeaders 消费方 + 门禁基线波及）→ 汇总 → spec.md → 用户确认。

assistant:
探索完成：4 份报告落盘 docs/iterations/official-endpoints-removal/cache/explore-{A-account-model-access,B-desktop-official-ui,C-marketplace-offpeak,D-endpoint-infra-gates}.md。**spec 已落盘待确认：docs/iterations/official-endpoints-removal/spec.md**（13 Steps / 7 phase / 21 条 D 决策 / 14 个 T 用例 / 8 项待拍板）。关键发现修正了三处直觉：①「端点基建=死代码」不成立——`__ZCODE_ENDPOINT_ENV__` 三件套是 web bundle 配置+子进程 env 组装的构建基础设施，6 符号有通用活消费者，只能按判定表瘦身；②shared-credentials.ts 是 MCP OAuth 底座（只删账号键族）；③官方 coding-plan 网关按 URL 劫持所有 provider（含用户自配 api.z.ai），整删。规模：整删 60+ 文件（autoUpdater 1924 行/oauthService 1193/bigmodelSubscription 1352 等），预计净删 3-5 万行。T-T4 抓包并入本轮 Step 13。待用户确认 spec 与 8 项拍板（HTTP-Referer 默认值/旧会话容错/presentation surface/dynamicWorkflow 默认/帮助菜单/两条官方认证插件/X-ZCode-Agent/版本号）。

user:
/spec-check-loop 走一轮审查收敛。

assistant:
**spec-check-loop 5 轮收敛完成（r1-r5），主代理认定等效 Go，待用户确认 execute-ready。** 轨迹：r1 No-Go P0×4+P1×7+P2×3（存量 known record 出网/clientScenes 悬置/validateSelection 落点错/S5-S9 并行同文件打架）→ r2 No-Go 新 P0×2（r1 修复方案自身与代码冲突：移除 known 记录致商店页空；D-12 落点 API 不存在）→ r3 No-Go 收敛尾声（机制全核实可行，T-MK1 全新 profile 互斥+白名单行号自删）→ r4 No-Go 轻量（8 条闭合，2 处登记遗漏）→ r5 No-Go 无 P0（6 处 D-13 分类登记错误，judge 判定补完即 Go）。轮次上限 5 已达且无未闭合 P0，按 execute-ready 定义主代理认定等效 Go。**审查循环的最大价值**：三轮各抓住一个「照 spec 写必与代码打架」的真问题（商店页条目唯一来源=known 记录/modelFactory 无默认 selection 入口/preset provider 可见性守卫恒 false 静默回归）。待拍板扩为 9 项（新增 fork 打包身份取值）。状态在 docs/.iteration-state.yaml official_endpoints_removal 节。

user:
确认开工：/code-dev-loop，新建 worktree 于 D:\Dev\worktree。

assistant:
**code-dev-loop 进行中（2026-10-06）**：worktree=D:\Dev\worktree\official-endpoints-removal（分支 feat/official-endpoints-removal，base ba7c240，完整 pnpm install 未挂 junction）。9 项拍板按推荐值执行（第 9 项占位 oh-my-zcode）。**DAG 已重排至 v3**（关键执行发现：账号域删除闭包横跨 S5 UI 与 S7 offPeak 凭据链，S4 无法独立绿→S7 提前、C+D+D-6+shared+S5 合并为 impl-s4-s5-account）。已交付：S1（f871822）/S2 自动更新 7 commits/S3 A+B 面+D-16（aa12513+dac6be0）/S7 offPeak 全链（-9284 行，cr-func 后 16 项机械 must-fix 主代理闭合）/impl-s4-s5-account 主体（**9 轮续跑 26 commits，f735e5f..5d23388**：Registry 单源化+D-16 缓存回落+D-6 builtin-templates+CLI /login+UI 登录树/订阅 68 文件+Root 死锁陷阱+D-13 全族+preset 过滤器摘除+contextUsage/SettingsPage 收口——根 typecheck 157→0、lint 72w/0e 回基线、parity 过、符号扫描活代码 0）。**分支累计 452 文件 +1224/−58471**。**impl-s4-s5-account 已完成（电脑重启前最后一刻收尾，29 commits f735e5f..bc47780，重启后核实树干净）**：全门禁绿——根 typecheck 0（起点 157）/desktop-full 57 kinds（removed 310，唯一 NEW=已知 TS7016 假阳性）/magic-context+desktop build 绿（D-16 回落延伸到构建期 loader，旧缓存用户 build 也修复）/lint 73w 0e（优于 76w 基线）/CLI 27 包全绿/parity 5891=5891/符号扫描活代码 0/**T-AC2 ALL_PASS**（三种 account providerId 回退 builtin:zai-standard+warn 日志+反例不静默）。T-AC1/T-AC3 留人工真机验收。8 项 spec 偏离已登记（最关键：shouldShowBuiltinModelProviderForDomain 恒 true 防 T-AC3 冲突/feedback 目录提前吃 S8 面/usage-stats 收缩保留 AppUsage）。**待办：cr-func-s4-s5 → S6+S8 → S9 → S10 → S11 → S12 → cr-func-final；S13 抓包留用户**。关键执行经验：①大节点单 agent 会触预算顶——WIP 检查点+SendMessage 续跑同 agent 是标准解（s4-s5 跑了 10 轮）；②>1000 行 .tsx 禁止行匹配/正则批量删（两次截断事故均自愈），Edit 逐段+花括号配平；③commit 中文 message 用 -m 短句或 -F 文件；④账号域三教训被 spec 预判全部命中（死锁条件同删/preset 过滤器摘除/modelFactory fallback）。

user:
继续（impl-s6-s8 收尾；此前子代理重派后 27 分钟死于 server error，留 -1497 未提交，主代理手工接手）。

assistant:
**impl-s6-s8 完成（S6 分享收口+S8 帮助下线+计划外 s4-s5 死管道补漏，4 commits：f0da6e1/40463a1 s6 + a2741b5 s8 + 948e056 s4-s5，-5275 行；eaa9934 子代理 WIP 已含 -11695）**。S6：SessionPane/Composer/RowView/TurnGroup(shareSelection 勾选机器)/Timeline/dock transition 消费点收口；shared-context-import 删 /cn/share/<code> 硬绑、schema 仅存旧会话解析容错（zod 非 strict 容器剥离未知键安全）；accessor/RemoteServiceAccess/远端服务集 conversationShareService 面整删；useRootPlatformEffects -251。S8：rollout 三件+ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED 跨包清理+presentationSurface 整 seam 删除（D-14 恒关，含 processManager --surface 注入与 storagePreparationProcesses:124 漏网）；config/default.json 三官方 URL+extraResources 单项删；OpenFeedback/Community/Changelog/productDocs 全 IPC 链+quickpick 命令+原生菜单项；feedback 工单类型域/FeedbackLogArchive host 消息链/feedbackPrivacy 全删；web auth 7 文件+回调路由整删（D-17）。计划外：OAuth/支付 deep link 死管道（desktopOAuthDeepLink→desktopDeepLinkRouter 更名，仅留 workspace 支路）、oauth.ts 瘦身至 provider 标识+凭据解密契约（MCP OAuth 底座在用）、UI UserInfo/onLogin 死链。**门禁全绿**：root typecheck 0/desktop-full 55 kinds removed 311 gate OK/desktop build 绿/lint 71w 0e（优于 73w 基线）/parity 5891=5891/diff 新增行官方端点 0。教训：①git rm 的删除会预暂存——pathspec commit 必须用 `git commit -F msg -- <paths>` 限制（本次踩坑后 reset 重做）；②zod 非 strict 容器删字段=旧日志安全剥离，是「协议字段删除+旧会话容错」的两全解；③desktop renderer 不在 root typecheck 内——desktop-full 才查得到（OAuth 死管道因此漏网两轮）。**待办：cr-func-s6-s8 → S9 marketplace → S10 端点+i18n 收口 → S11 文档 → S12 全量回归+tag → S13 抓包留用户**。

