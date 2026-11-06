---
date: 2026-11-04
title: 上游 ZCode v3.16.2 → v3.17.2 选择性同步：UI / Web 区域缺陷修复与性能优化候选
upstream_base: 3c5b2276（v3.16.2）
upstream_target: v3.17.2（a9fe401e）
fork_head: main @ 36bc100f（omz v1.1.3）
scope: packages/ui/src/**、packages/web/src/**、packages/ui 的 i18n 与样式、packages/ui/index.ts
excluded: packages/*/test/**、docs/
---

# 0. 结论摘要

- 候选 **20 项**：bugfix **14** 项，perf **6** 项。
- 融合成本分布：fork 从未改过该文件（可直接重放）**10** 项；fork 改过、需人工融合 **8** 项；部分融合 **2** 项（BF-14、PF-02）。其中 BF-10、BF-12 还依赖 `packages/shared` / CLI 侧协议先就绪。
- 最值得做：**BF-01**（发送结算 `unknown` 提前清账，直接造成重复消息与正文回退）、**BF-04**（终端最后一个 tab 关闭不释放 PTY，改动小、风险低）、**PF-06**（Windows 中文输入法组合态逐键提交，影响本仓主力平台的手感）。
- S 级顺手项：BF-03、BF-07、BF-09、BF-13（各 ≤ 10 行逻辑 + 一处调用点）。

# 1. 区域规模

统计口径：`git diff --numstat 3c5b2276 v3.17.2 -- packages/ui packages/web`，共 1506 个条目，其中 1501 个有行号；另 5 个无行号（4 个新增 provider 图标 PNG + 1 个被判为二进制的测试文件），未计入行数。行数按「+/−」分别累加。

| 区域 | 状态 | 文件数 | +行 | −行 |
| --- | --- | ---: | ---: | ---: |
| `packages/ui/src`（源码） | M 修改 | 242 | 12631 | 8627 |
| `packages/ui/src`（源码） | A 新增 | 73（含 4 个图标 PNG，无行号） | 8677 | 0 |
| `packages/ui/src`（源码） | D 删除 | 38 | 0 | 6022 |
| `packages/ui/src`（源码） | R 重命名 | 4 | 371 | 47 |
| `packages/ui/test`（测试） | 删除为主 | 1092 | 5553 | 278231 |
| `packages/ui`（包级配置） | M | 2 | 0 | 9 |
| `packages/web/src`（源码） | M 修改 | 6 | 240 | 292 |
| `packages/web/src`（源码） | A 新增 | 6 | 370 | 0 |
| `packages/web/src`（源码） | D 删除 | 1 | 0 | 42 |
| `packages/web/test`（测试） | 删除为主 | 41 | 1126 | 7021 |

说明与判读：

1. **测试的 −28 万行不是候选**。`packages/ui/test` 有 1092 个文件变更、净删约 27.8 万行；BRIEF 已确认其中约 1031 个是上游 v3.17.1 删除的 UI 单测（开源导出裁剪），不是缺陷修复。
2. **`packages/ui/src` 合计 +21679/−14696，真正的新产品线占大头**：`data-sync`（约 +3000）、`file-menu`（约 +600）、`image-preview-editor`（约 +1000）、`project-sidebar` 项目管理（约 +1200）、`settings-scope`（约 +260）、`PersonalizationSection`（+307）。这些在 fork 中要么整目录不存在，要么是已下线产品面。
3. **源码文档**：`packages/ui/src/**/*.md`（CONTRACT）11 个 +95/−12；`packages/web/src/**/*.md` 2 个 +20/−1；均为新模块契约，不是缺陷修复。
4. 上游删除了 `RemoteMcpSyncDialog`（−617）、`RemotePluginSyncDialog`（−1964）、`RemoteSkillSyncDialog`（−509）、`SettingsMachine`（−76）、`OnboardingWelcomeView`（−67）及 `RemoteSkillSync*` 系列与 `RemoteSyncActions`（D 合计 −6022，其余为随包 `contract.test.ts`），属产品面下线与新交互重做。
5. UI 源码里 **fork 已删除**、因此本轮候选天然不适用：`packages/ui/src/highspeed/**`（Highspeed 卡整个 UI 特性）、`packages/ui/src/v4/mcpUnavailableBannerNotice.ts`（官方 Server MCP 不可用横幅）、`packages/ui/src/v4/telemetry/**`（红线 1）、`packages/ui/src/share/**`、`packages/ui/src/data-sync/**`、`packages/ui/src/image-preview-editor/**`。

# 2. 候选表

「fork 是否改过」判定：`git diff --name-only 3c5b2276 main -- <file>` 非空即视为改过（非空 ⇒ 移植需人工融合）。
「已修」列额外注明 fork 当前代码是否已存在同一修复。

| ID | 类型 | 一句话问题 | 上游文件（v3.17.2） | fork 改过 | 已修 | 红线 | 成本 | 建议 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BF-01 | bugfix | 发送后查询先返回 `unknown` 就清账，正文被恢复回草稿、迟到 ACK 丢结算 | `v4/pendingCommandRegistry.ts`（:268-278、:318、:446） | 是 | 否 | 无 | M | 取 |
| BF-02 | bugfix | ACK 丢失＋断连后草稿回填无人清空，用户再点发送产生重复消息（R3A-B-07） | `v4/ConversationComposer.tsx`（:1230 附近） | 是 | 否 | 无 | M | 取 |
| BF-03 | bugfix | 首发已提交但投影未到时 placeholder 闪回「新任务」 | `lib/chatPlaceholder.ts`（:17） | 否 | 否 | 无 | S | 取 |
| BF-04 | bugfix | 终端最后一个 tab 的关闭按钮只收面板、不删 session，PTY 泄漏 | `Terminal.tsx`（:190）、`terminal/terminalPanelState.ts`（:107） | 否 | 否 | 无 | M | 取 |
| BF-05 | bugfix | 首连期间重叠点击共享同一 logical session，被替代的旧导航把新导航要用的连接释放掉 | `project-sidebar/remote-navigation.ts`（:124 附近） | 否 | 否 | 无 | M | 取 |
| BF-06 | bugfix | 未提交的导航（下载型 URL/ERR_FAILED）被当成当前页与恢复地址，每次重挂重复下载 | `browser-use/UnifiedBrowserView.tsx`（:232、:459、:579） | 否 | 否 | 无 | M~L | 适配后取（仅恢复 URL 部分） |
| BF-07 | bugfix | 只开远程项目时「测试模型连通性」直接报本地工作区不可用 | `hooks/useModelProviders.ts`（:191） | 否 | 否 | 无 | S | 取 |
| BF-08 | bugfix | 关闭弹窗/切工作区后，首启检测的迟到回包让迁移弹窗重新弹出；无项目时导入静默跳过 | `hooks/useSettingsSync.ts`（:210-221、:462 起） | 否 | 否 | 无 | M | 取 |
| BF-09 | bugfix | turn 刚完成时的 `proto.staleRevision` 竞态让本轮 md/html 预览卡永久被抑制 | `v4/useAssistantPreviewCardsForRow.ts`（:124） | 否 | 否 | 无 | S | 取 |
| BF-10 | bugfix | 后台任务通知：失败 hover 无详情；合并轮只更新其中一条工具状态 | `lib/zcodeSessionProjection.ts` | 是 | 否 | 无 | L | 适配后取（分两段） |
| BF-11 | bugfix | 写 MCP 配置用的是「最后一个初始化 tab」的全局目录服务，跨主机写到错误设备 | `store/mcpStore.ts`（:170 附近、:215、:412） | 是 | 否 | 无 | M | 适配后取 |
| BF-12 | bugfix | 项目 MCP「未授权」被降级成 `unknown`，UI 提示重启 Agent 而非授权 | `store/mcpStoreStatusList.ts`（:36-42） | 否 | 否 | 无 | M | 适配后取（待验证） |
| BF-13 | bugfix | 「全部更新」对同一插件并发两次 update；单个失败中断后续；切 scope 后仍继续写 | `settings/pluginStoreListing.ts`（:108 起） | 否 | 否 | 无 | S | 取 |
| BF-14 | bugfix | 会话查找在虚拟窗口内定位失效／被 `scrollToIndex` 抢滚动／smooth 落点被测高补偿取消 | `v4/useConversationTimelineFind.ts`、`v4/conversationFindHighlightDom.ts`、`v4/ConversationTimeline.tsx`（:1692） | 部分 | 否 | 无 | M | 取 |
| PF-01 | perf | 流式帧每帧重建整窗 render unit / 目录 / 查找索引，成本随历史线性增长 | `v4/conversationTurnRenderUnits.ts`、`v4/conversationProjectionStore.ts`、`v4/conversationTimelineLiveTail.ts`、`v4/SessionPane.tsx` | 是 | 否 | 无 | L | 适配后取（分 3 阶段） |
| PF-02 | perf | 若干每帧执行的派生仍在整窗扫描（shareDeltaRows / reconcileSnapshot / `[...rows].reverse()` 等） | 见 §3 PF-02 | 部分 | 否 | 无 | M | 取 |
| PF-03 | perf | 查找高亮把每个命中都重新遍历整行文本，二次复杂度 | `v4/conversationFindHighlightDom.ts` | 否 | 否 | 无 | S | 取 |
| PF-04 | perf | 查找结果被动回报每次都改 App 状态，整棵 App 随流式帧重渲染 | `App.tsx`（:659-668） | 是 | 否 | 无 | S | 取 |
| PF-05 | perf | 时间线每像素滚动都 setState；未知长轮按 72px 估高导致首屏挂载十几轮 | `v4/ConversationTimeline.tsx`（:745-767、:857-876） | 是 | 否 | 无 | M | 取 |
| PF-06 | perf | Windows 中文输入法组合态每次更新都序列化前后全文并写父级草稿/localStorage（ZCT-2112490732581797888） | `LexicalChatInput.tsx`、`v4/ConversationComposer.tsx`（:983）、`v4/composer/useDraftConfigControl.ts`（:773） | 是 | 否 | 无 | L | 适配后取 |

# 3. 候选逐项

## BF-01 pendingCommandRegistry：`unknown` 不应提前清账；确认重发不应带旧 sessionId

- **旧行为**：`applyRecoveryResults` 收到 `unknown` 时调用 `notifyResolution(..., "unknown")` 并 `settle()`（v3.16.2 注释写着「renderer 静默清账」）。但 Host 侧「发送」可能仍在准备，CLI 查询先返回 `unknown`；清账会恢复已提交正文，并丢掉迟到 ACK 的结算订阅 → 用户看到正文回到输入框、命令状态永久未知。另一处：用户确认重发 `createSession` 时沿用旧 `payload.sessionId`，CLI 因该会话已 admission 而拒绝。
- **新行为**：`unknown` 直接 `continue`，把线索留给 accepted/duplicate、明确失败、权威投影或既有 TTL；`buildReplayRequest` 对 `createSession` 删除 `payload.sessionId`。
- **证据**：`packages/ui/src/v4/pendingCommandRegistry.ts:268-278`、`:318`、`:446`（@v3.17.2）；规格 `docs/ui/task-scoped-composer-drafts.md`「提交与查询交接（2026-10-28）」明确写「查询先返回 unknown 不证明命令失败……不自动重发」。
- **移植要点与风险**：需要与 fork 的 `composerSubmissionSettlement` / `ConversationComposer` 的 claim/restore/finalize 一起看；fork 该文件被改过（删掉了原生压缩相关的 `compact` replay 类型与 `timelineMarker` 收口分支，属红线 3），不能整文件覆盖——只改 `applyRecoveryResults` 的 `unknown` 分支与 `buildReplayRequest` 两处。风险：`unknown` 长留会让 pending 横幅存活更久，须确认 TTL 与 UI 兜底仍在。

## BF-02 R3A-B-07：ACK 丢失后草稿回填造成重复发送

- **旧行为**：ACK 丢失时传输先 reject，提交正文被恢复回草稿；随后断连使 SessionPane 与 composer 卸载，闭包里的结算订阅一起消失。重连重挂后正文从草稿回填，而权威 projection 已到达却无人清空 → 用户再点发送，同一输入被发送两次。
- **新行为**：草稿回填后向**模块级**结算账本认领该 scope 尚未结算的提交，结算已到则同步清空，否则等待；只清「确实是那次提交且用户未在其上继续编辑」的正文。
- **证据**：`packages/ui/src/v4/ConversationComposer.tsx:1230` 起（`subscribeComposerSubmissionSettled`）；`docs/ui/task-scoped-composer-drafts.md` 的 CST01–04/CST05 与「传输异常 → 恢复原正文但保留待确认」时序图。
- **移植要点与风险**：`subscribeComposerSubmissionSettled` 与模块级账本在基线（`packages/ui/src/v4/composer/composerSubmissionSettlement.ts:80`）已存在，fork 未改过该文件，所以修复只落在 `ConversationComposer` 的草稿回填副作用里，属纯增量。风险：`contentRevisionRef` 与 fork 的 composer revision 计数必须一致，否则会误清用户新输入。

## BF-03 chat placeholder：处理中优先于空历史

- **旧行为**：`!hasHistoryMessages` 先返回 `chat.placeholder.newTask`。首发已提交、ack 已接受但消息投影尚未到达时历史仍为空，输入框闪回「新任务」提示（并可能带动 placeholder 相关状态跳变）。
- **新行为**：`if (isTaskProcessing) return "chat.placeholder.followUpQueue"` 提前，再判历史。
- **证据**：`packages/ui/src/lib/chatPlaceholder.ts:17`（@v3.17.2）；fork 当前 `packages/ui/src/lib/chatPlaceholder.ts:20-26` 仍是旧顺序（文件未被 fork 改过）。
- **移植要点与风险**：纯函数级改动，需同步更新 fork 的 `chatPlaceholder` 单测（若有）；风险极低。注意 `shouldDeferChatPlaceholder` 的 creating/restoring 抑制逻辑保持不变。

## BF-04 终端：最后一个 tab 的关闭按钮必须释放 PTY

- **旧行为**：`getTerminalSessionCloseAction` 对唯一 tab 返回 `close-panel`，`handleCloseSession` 只调 `onClose()` 收起面板，**不删除 descriptor**，`TerminalSession` 不卸载，后端 PTY 不 `dispose`。用户「关掉终端」后进程仍在。
- **新行为**：`closeTerminalSession` 对 `close-panel` 也删除 session 与（无 fallback 时的）workspace 记录；`Terminal` 先删除唯一状态源里的 session，提交后再收起面板，PTY 仍由 `TerminalSession` 卸载统一释放；面板右上角关闭仍只隐藏、保活。
- **证据**：`packages/ui/src/Terminal.tsx:190`（`handleCloseSession`，注释「Bug 原因：单 tab 的关闭按钮过去只收起保活面板，没有删除 descriptor」）、`packages/ui/src/terminal/terminalPanelState.ts:107-135`（`closeTerminalSession` 与 `exitTerminalSession` 复用）；规格 `docs/ui/terminal-sessions.md`：TERM-TAB-05 由「session 保活」改为「删除 session、dispose PTY 并收起空面板」。
- **移植要点与风险**：`Terminal.tsx`、`terminalPanelState.ts`、`TerminalSession.tsx` 在 fork 中均未被改动，可整体对照移植；但要保留 fork 的 side-pane terminal（`terminal/sidePaneTerminalSessionRegistry.ts` 在 fork 已存在且上游又加了 clientNamespace/terminalOwnerId 维度）。同一文件里「persistent session scope mismatch」修复（防止手机切设备把旧 PTY id 交给新设备）建议一并取。

## BF-05 remote-navigation：在途连接按 deviceId 合并

- **旧行为**：`existing = findSession(identity); sessionId = existing?.sessionId ?? await connect(...)`。首连 Provisioning 可达十几秒，期间再次点击会再发一次 connect，Host 把两次 join 到同一 logical session；旧逻辑把每次 connect 结果都当「本次创建」，被替代的旧点击在连接迟到成功后 `cancel(sessionId)` → 最新点击随之失败、会话被释放、UI 留在本地草稿。
- **新行为**：`hostConnectionFlights`（按 hostId）合并进行中的 connect，记录 `waiters` 与 `claimed`；只有接管者（开始目录绑定）或最后一个等待者在失败时释放；被替代的等待者只退出。
- **证据**：`packages/ui/src/project-sidebar/remote-navigation.ts:124` 起（注释「Bug 原因：首连 Provisioning 可达十几秒……」）；工单 `docs/issues/e2e-promotion/24-remote-project-entry-overlapping-navigation.md`（含 `projectentry-ownership-probe.json` 的受控端口验证，结论「connect 返回 session 不代表本次调用独占创建了它」）。
- **移植要点与风险**：fork 该文件未被改过，可整体重放。风险：`cancel` 语义依赖 Host 侧 join 行为；移植后需覆盖「A 被替代、B 成功绑定」与「B 放弃、A 释放」两条路径。工单同时指出 `useProjectTaskNavigation` 有同类「连点任务」问题（fork 该文件亦未改过，可一并取）。

## BF-06 内嵌浏览器：恢复 URL 只能来自主框架已提交的 URL

- **旧行为**：`lastRestorableUrlRef` 在导航**发起前**写入（`openUrl` 与 `initialUrl` effect 都写），`did-fail-load` 又把 `event.validatedURL` 写进 `currentUrl`。附件 URL（会触发下载但不提交页面）或 ERR_FAILED 因此成为「当前页/恢复地址」，每次 rebind/重新挂载都再下载一次；下载型导航还会弹「页面加载失败」。
- **新行为**：新增 `settleRestorableUrl`，只在一次导航结束（`finally`）后读取 `getURL()` 记录**已提交**地址；失败主框架导航不再改写 `currentUrl`；订阅 main 的 `onBrowserViewDownloadStarted`，把 ERR_FAILED 且在下载集合内的导航视为下载而非失败；恢复只读 `lastRestorableUrlRef`；重试改用 `lastRequestedUrlRef`。
- **证据**：`packages/ui/src/browser-use/UnifiedBrowserView.tsx:232`（ref 初始化去掉 `initialUrl`）、`:459`（`settleRestorableUrl`）、`:579`（`handleDidFailLoad` 不再写 `currentUrl`）、`:741-750`（residency 上报只认 `lastRestorableUrlRef`）。
- **移植要点与风险**：`onBrowserViewDownloadStarted` 与 `browserViewLoadUrl` 都是上游本轮**新增**的 `IPlatformService` 端口（`packages/shared/src/platform.ts` +155/+166 行），fork 的 platform 里**都不存在**；上游 `UnifiedBrowserView` 的 `loadBrowserUrl` 在缺该端口时直接抛 `"Browser navigation is unavailable"`，所以**不能整文件覆盖**。fork 建议只取不依赖新端口的部分：① `lastRestorableUrlRef` 只在主框架提交后写入（`getURL()`）；② `did-fail-load` 不再改写 `currentUrl`；③ 恢复/重试只读 `lastRestorableUrlRef` / `lastRequestedUrlRef`。这样能消除「失败导航被当成当前页」与大部分重复恢复，但**下载型导航仍会报一次加载失败**（要彻底修需在 main 增 `browserViewDownloadStarted` 推送）。

## BF-07 远程项目下的模型连通性测试

- **旧行为**：`target.connectivityWorkspaceRequired || workspaceIdentity` 且没有 `connectivityWorkspacePath` 时直接返回失败「A local workspace is unavailable for connectivity testing」。只打开远程项目（没有本地 tab）时，Provider 设置页的「测试模型连通性」完全不可用。
- **新行为**：没有本地 cwd 时调用 `fileService.ensureConversationWorkspace()` 取本机 Host 的对话目录（Host 始终有），仍不把远端路径交给本机；解析失败才返回原错误。
- **证据**：`packages/ui/src/hooks/useModelProviders.ts:191` 起（Bug 根因 ZCT-2112556538453495808）。
- **移植要点与风险**：fork 的 `IFileService.ensureConversationWorkspace()` 已存在（`packages/services/src/file/file.ts:28`、`fileService.ts:439`），可直接用。风险：低；需确认 Host 侧创建目录有权限，且不改变「远程激活时不用远端 cwd」的边界。

## BF-08 useSettingsSync：首启检测的代次守卫与无项目导入

两个独立缺陷、同一文件：

1. **旧行为**：`loadDiscovery` 的回包（成功/失败/空结果）无条件 `setState`。首启检测进行中用户手动打开或关闭弹窗、或切换 workspace，迟到回包仍会把 `open:true`/loading/error 写回，弹窗「自己弹回来」或停在旧工作区内容；`close()` 也不清 `loading`。
   **新行为**：`discoveryRequestRef` 代次令牌，每次 detect 只提交到自己的请求代次（连排队中的 React updater 也复核），`close()`/卸载/换 workspace 都递增代次。
2. **旧行为**：`importSelected` 开头 `if (!params.workspacePath) return;`——从「无项目」的入口（数据同步页/设置页「迁移」）进入时，技能/命令/MCP 导入整体静默跳过，结果页仍显示完成。
   **新行为**：用户级项照常导入，需要项目的项记为失败并计数（`workspaceRequiredCount`），完成页写明原因。
- **证据**：`packages/ui/src/hooks/useSettingsSync.ts:210-221`（`discoveryRequestRef`/`isCurrent`）、`:462` 起（`mergeWorkspaceRequiredResults`）；`packages/ui/src/Root.tsx` 同步修「没有打开项目时 Root 只渲染独立设置页，迁移向导没挂载」。
- **移植要点与风险**：fork 该文件未被改过，可重放。风险：fork 的 onboarding 迁移入口与上游 data-sync 页入口不同（fork 无 `data-sync`），第 2 子项需按 fork 的 `reopen()` 入口验证；`workspaceRequiredCount` 需要 `OnboardingFlowParts` 展示位（上游新增 i18n key `onboarding.finish.workspaceRequired`）。

## BF-09 预览卡片：staleRevision 竞态重试

- **旧行为**：turn 刚 `complete` 时 projection revision 仍会被后续事件推进，`fetchFileChanges` 携带的 `baseRevision` 被判 `proto.staleRevision`；错误分支记成空列表。`requestKey` 不含 revision，于是本轮 md/html 卡片**永久**被抑制，直到用户切走再回来。
- **新行为**：`shouldResyncForStaleAuthority(error)` 时按 150ms×(attempt+1) 退避重试，最多 3 次；重试前不写空列表。
- **证据**：`packages/ui/src/v4/useAssistantPreviewCardsForRow.ts:124` 起（Bug 根因文字与 `STALE_FILE_CHANGES_MAX_RETRIES = 3`）。
- **移植要点与风险**：fork 该文件未被改过；依赖 `shouldResyncForStaleAuthority`（fork 已有）。风险：低。注意不要给非 stale 错误加重试。

## BF-10 后台任务通知：失败详情与合并轮

- **旧行为**：（a）`tool_call_update` 只在 `notification.error` 存在时写 `error`，而纯文本通知并不携带该字段，ToolLayout 的失败 hover 只有空详情；（b）一条通知文本只解析出**一条** notification，合并轮（一次消息里多条后台任务结果）只更新其中一条工具状态，其余停在 running。
- **新行为**：`parseZCodeBackgroundTaskNotifications(input, originMeta)` 返回数组并逐条更新；`error` 改由 `zcodeBackgroundTaskNotificationFailureText(notification)` 统一生成，优先取本轮 `originMeta` 的结构化结果。
- **证据**：`packages/ui/src/lib/zcodeSessionProjection.ts` 的 `backgroundTaskNotificationToolUpdatesFromInput`（@v3.17.2，注释两处「修复原因」）；`packages/shared/src/background-task-notifications.ts` +63/−24。
- **移植要点与风险**：fork 的 shared 只有单数 `parseZCodeBackgroundTaskNotificationText`，缺复数解析与 failure-text helper，且 `originMeta` 的结构化结果需要 CLI/Host 侧配合写入。**分段建议**：先只取「失败详情文案」（shared 内纯函数，S），「合并轮多条更新」等 CLI 侧 originMeta 就绪后再取（否则拿不到结构化结果，只能靠文本猜测）。**待验证**：fork 的 Host 是否在 `payload.originMeta` 里写后台任务终态。

## BF-11 mcpStore：目录服务与目标必须同一组绑定

- **旧行为**：`mcpDirectoryService` 是模块级单例，由「最后一个初始化 MCP 的 tab」通过 `setMcpStoreDirectoryService` 覆盖；`persistScopedChange`/`toggleServer` 调用 `resolveMcpDirectoryService()` 不传参 → 用全局那个；而 `resolveMcpDirectoryService` 在**没有 workspace identity** 时直接返回 `null`（走本机 platform）。结果是：本机 tab 与远端 tab 同时打开时，写 MCP 配置可能落到另一台设备；远端「用户」目标（只有 home 路径 + authority、无 identity）读写劈叉（读 B、写 A）。
- **新行为**：`currentDirectoryService` 与 `currentProjectPath/currentWorkspaceIdentity/currentAuthorityKey` 作为一组写入；`resolveTargetDirectoryService()` 只看当前绑定，远端目标缺服务时 **fail-closed**（抛错，不回退本机）；`loadMcpFromUserDirectory()` 不再接收目录服务参数。
- **证据**：`packages/ui/src/store/mcpStore.ts:170` 起（Bug 原因整段）、`:215`（`resolveTargetDirectoryService`）、`:412`（toggle 使用同一解析）；`packages/ui/src/hooks/useEnsureWorkspaceMcpLoaded.ts` 与 `settings/McpSettingsSection.tsx` 同步改。
- **移植要点与风险**：fork 的 mcpStore 仍是单例 `mcpDirectoryService`（`packages/ui/src/store/mcpStore.ts:47-54、153-163、215、271、412`），**修复缺失**。fork 无 `settings-scope`（无 `currentAuthorityKey`），因此只能取「服务与 projectPath 同绑定 + 远端无服务 fail-closed」的骨架，去掉 authority 维度。风险：`persistCliMcpToUserDirectory` 的签名在 fork 侧可能不同；需回归「本机 tab 写本机」「远端 tab 写远端」「远端 attachment 换代只换服务不清列表」三条。

## BF-12 项目 MCP「未授权」不应降级为 unknown

- **旧行为**：`mapRuntimeStatusToUi` 把 `untrusted` 映射成 `{status:"unknown", error:"Project MCP server requires explicit connection before use.", failureKind:"status_unavailable"}`。UI 因此显示「状态未知/请重启 Agent」，而真实事实是「该项目 MCP 需要用户显式授权」。（英文原文还可能直接漏到中文界面。）
- **新行为**：`case "untrusted": return { status: "untrusted" }`；合并时补 `workspaceTrust`（仅 `scope === "workspace"`）。
- **证据**：`packages/ui/src/store/mcpStoreStatusList.ts:36-42`（@v3.17.2）；fork 同文件 36-42 仍是旧映射；上游 `packages/shared/src/mcp.ts` +49/−22 新增 `"untrusted"` 与 `WorkspaceMcpTrustReview`，fork 的 `McpServerStatus`（`packages/shared/src/mcp.ts:56`）无该项。
- **移植要点与风险**：**待验证**：fork 的 Host/CLI 是否真的会产出 `status:"untrusted"` 的 MCP 快照（fork 已删官方 MCP 鉴权，但项目级 trust 是另一套）。若状态源存在，UI 侧需同步 `McpServerStatus` 联合类型与列表渲染（含 i18n）；若状态源不存在，本项跳过。

## BF-13 插件「全部更新」的串行与守卫

- **旧行为**：批量更新按 store 里的 `updateStatus` 判断是否仍需更新，而 `updateStatus` 要等 `loadInto` 结束才变 `none`；行内更新已发出但未结束时，同一插件会被并发发起两次 `plugins/update`。单个插件抛错会中断后续；批量耗时较长时用户切换 Scope，循环仍继续写。
- **新行为**：新增 `needsPluginUpdate(state, pluginId)`（额外看 `activeOperations` 里的 `plugin:update:<id>`）与 `updatePluginsSerially(ids, update, guard)`（逐个 await，单失败计入 failed 不中断，`guard.isCurrent()` 变化即中止且不计入切换期间完成的那一项）。
- **证据**：`packages/ui/src/settings/pluginStoreListing.ts:108` 起；配套 `store/pluginManagementStore.ts` 的 `updatePlugin` 返回 `Promise<boolean>`（`runWorkspaceOperation` 的 owns 结果）。
- **移植要点与风险**：fork 的 `pluginStoreListing.ts` 未被改过；`pluginManagementStore.ts` 在 fork 中只有空白改动，可直接重放 `updatePlugin` 返回值的改动。风险：调用方（`PluginsSection`）在 fork 中未改过，需要接上 `updatePluginsSerially` 与 toast 汇总。

## BF-14 会话查找：定位与滚动权的收口

- **旧行为**：
  1. 单命中时只更新 DOM 高亮请求，不驱动虚拟窗口定位；命中一旦离开窗口就没有 Range，`scrollToUnit` 不会发生 → 「1/1 但不跳」。
  2. `scrollToUnit` 用 `virtualizer.scrollToIndex()`，它会持续校正 turn 起点，与随后命中 Range 的居中争夺滚动权，并在 scroll 的同步提交里逐行测高，反复挂载错误窗口。
  3. `scrollIntoView({behavior:"smooth"})`，而虚拟窗口居中会挂载新的缓冲行、随后测高补偿取消 smooth 动画，留下错误落点。
  4. 目标行已挂载但源码标记/链接地址没有 DOM Range 时，请求不收口，用户滚走后又被反复拉回。
- **新行为**：`scrollKey` 纳入 `conversationFindNavigationRequestId`；命中未挂载时显式 `scrollToUnit`；`scrollToUnit` 改为一次 `scrollTo({top: offset})`（不再用 `scrollToIndex`）；`scrollIntoView` 改 `behavior:"auto"`；引入 `isMountedLayoutMeasured()`，布局未入账不居中；已挂载但无 Range 时结束请求（清高亮、回调 done）。
- **证据**：`packages/ui/src/v4/useConversationTimelineFind.ts:76`、`:166`、`:332` 附近；`packages/ui/src/v4/conversationFindHighlightDom.ts`（`scrollConversationFindRangeIntoView`）；`packages/ui/src/v4/ConversationTimeline.tsx:1692`（`scrollToIndex` 注释）；工单 `docs/issues/e2e-promotion/09-git-find-match-not-centered.md`（会话范围需居中；**注意该工单的文件变更范围（Git diff 内文本定位）上游仍未修**）。
- **移植要点与风险**：`ConversationTimeline.tsx` 在 fork 被改过（虚拟滚动/锚点），`isMountedLayoutMeasured` 依赖 `measureRowHeight`/`elementsCache` 等内部结构，需人工融合。风险：`behavior:"auto"` 会让「平滑滚动」的视觉反馈消失（上游认为这是必要取舍）；不要在 Git 范围复用本修复。

## PF-01 冻结历史 + 尾轮分区（每帧派生成本与历史长度无关）

- **优化前**：`rows.window` 每帧都是新数组，所有按行派生（render unit 分组+materialize、问题目录、查找索引、插件卡片、highspeed、workflow 联接、MCP 横幅、发送渲染通知、pending 对账）都在整窗上跑一遍；select 复用判定用 zustand `shallow`，每帧为每个历史轮各建一个 Map。上游实测（1000 回合/3000 行、macOS arm64）：renderer 非空闲时间 1649ms→1083ms（−34%），帧间隔 P95 18.3→17.5ms。
- **优化后**：`rows.window` 增加 WeakMap 分区缓存 `{history, tail}`，`advanceConversationRowsPartition` 只在 delta 命中尾轮时复用上一份 history 数组；消费方按 history 引用缓存历史派生，每帧只算尾轮。`createConversationTurnRenderUnitsSelector()` 以 turn key 复用 unit，`sameItems` 取代 `shallow` 消除每帧分配；`splitConversationTimelineLiveTail` 让虚拟列表直接用 history 数组（引用稳定）。
- **证据**：`docs/ui/chat-virtual-scroll.md`「每帧派生成本」整节（含分区规则、跨轮合并规则、成本边界与实测表）；代码在 `packages/ui/src/v4/conversationProjectionStore.ts`（`getConversationRowsPartition`/`memoizeByRows`/`advanceConversationRowsPartition`）、`v4/conversationTurnRenderUnits.ts:416/513/545`、`v4/conversationTimelineLiveTail.ts`、`shared/zcode-protocol-v4/rows.ts`（+19/−1 新增 `ConversationRowsPartition` 类型）。
- **移植要点与风险**：这是本轮最大的一块（L）。fork 的 `conversationProjectionStore` / `conversationTurnRenderUnits` / `ConversationTimeline` 都被改过，包含 fork 自己的草稿/生命周期逻辑。建议分 3 阶段：① 只引入分区缓存 + `memoizeByRows` + `sameItems`（不改消费方语义，可用「值对照」测试）；② 改 render unit selector 与 live tail；③ 逐个消费方迁移（SessionPane 的分享目录/工作流联接/插件图标、find 索引、问题目录）。风险：分区是 `rows` 的纯派生，必须保证 `history ++ tail` 逐项等于 `rows`；`tail` 可能含多轮（不能假设 1 轮）；「只改尾轮」判定依赖 window 按 rowId 升序。

## PF-02 其余每帧整窗扫描的清零

| 子项 | 优化前 | 优化后 | 证据 |
| --- | --- | --- | --- |
| `shareDeltaRows` / `applyConversationDelta` | 每帧 `forEach` 整个 window 才找到 delta 命中的几行 | 从尾部扫一次、找齐目标即停；目标不在窗口时退化为整窗（与原来相同） | `v4/conversationProjectionStore.ts:1002` |
| `pendingCommandRegistry.reconcileSnapshot` | 每个流式帧逐行扫描历史收集 sourceCommandId | 无待对账条目且无结算监听时直接返回 | `v4/pendingCommandRegistry.ts:318` |
| `assistantPreviewPptxAutoOpen` | `[...rows].reverse().find` 每帧复制并反转整窗 | `rows.findLast` | `v4/assistantPreviewPptxAutoOpen.ts:40` |
| `assistantCodeComment` | 先算 Markdown 代码区，再抽指令；没有指令也扫全文 | 先抽指令，空则直接返回 | `lib/assistantCodeComment.ts:52` |
| `pluginUiInstancePolicy` | `turnOrder.includes()` 查重，随回合数平方级 | 对象表查重 O(1) | `plugin-ui/domain/pluginUiInstancePolicy.ts` |
| `workflowRunCardJoin` / `pluginReferenceIconProjection` | 每次 snapshot 变化对每个工具行重做正则归一/逐行扫描 | 按行对象/按分区缓存（依赖 PF-01；也可单独用 WeakMap） | `v4/workflowRunCardJoin.ts`、`v4/pluginReferenceIconProjection.ts` |

- **判定说明**：`pluginUiInstancePolicy`、`assistantCodeComment`、`assistantPreviewPptxAutoOpen` 是纯逻辑替换（不依赖分区），风险最低；`shareDeltaRows`、`reconcileSnapshot` 在 fork 中被改过（需融合）；`workflowRunCardJoin` / `pluginReferenceIconProjection` 的上游实现依赖 PF-01 的分区 API，但也可单独用 WeakMap 按行数组缓存。
- **不适用**：`v4/mcpUnavailableBannerNotice.ts`（官方 Server MCP，fork 已删）、`highspeed/highspeedConversationRows.ts`（Highspeed UI，fork 已删）。

## PF-03 查找高亮的 DOM 扫描

- **优化前**：`applyConversationFindHighlights` 对**每个命中**调用一次 `getMountedConversationFindRange`，后者从 row 元素起 TreeWalker 遍历全文并转小写；同一行的多个命中放大为二次复杂度，屏外行也逐命中查 DOM。
- **优化后**：先一次性收集挂载的 `[data-row-id]`，按 rowId 缓存 `collectTextRangesInElement` 结果，命中按 `rowMatchIndex` 取；同时 `buildConversationFindIndex` 生成器带 WeakMap 文本缓存（避免每次输入重新投影代码注释与 toLowerCase）。
- **证据**：`packages/ui/src/v4/conversationFindHighlightDom.ts`（`applyConversationFindHighlights` 新实现）、`v4/conversationFindIndex.ts`（`createConversationFindIndexBuilder`）。
- **移植要点与风险**：`conversationFindHighlightDom.ts` 在 fork 未被改过，可重放；`conversationFindIndex.ts` 被 fork 改过（需融合）。风险：`rowMatchIndex` 与缓存 range 数组的对应关系必须与命中构建顺序一致，否则会高亮错词；建议加「同一行多命中」回归。

## PF-04 查找结果被动回报不再整 App 重渲染

- **优化前**：`App.tsx` 的 `onConversationFindMatchStateChange` 每次都 `setConversationFindState(changeTaskFindSelection(...))`；消息索引随流式帧反复回报相同命中，整个 App（含侧栏、时间线）跟着更新。
- **优化后**：`activeIndex` 未变时返回 `current`，不产生 state 变更。
- **证据**：`packages/ui/src/App.tsx:659-668`（@v3.17.2，注释「被动回报没有导航意图」）。
- **移植要点与风险**：`App.tsx` 被 fork 改过，但该回调独立；风险极低。注意只在 `activeIndex` 相同的情况下跳过，`matchCount` 仍需更新。

## PF-05 时间线：目录视口状态与估高

- **优化前**：（a）`syncTurnNavigatorViewport` 每次滚动都 `setTurnNavigatorViewport({scrollOffsetPx, viewportHeightPx, activeQueryRowId})`，像素级滚动驱动整棵 timeline 重渲染（且每次滚动都 `querySelectorAll` 重新收集锚点）；（b）`estimateSize` 用固定 72px，而一个虚拟单元是**一整轮**长正文，未知长轮会让首屏一次挂载十几轮 Markdown；（c）容器宽度每像素变化都 `setTurnNavigatorContainerWidthPx`。
- **优化后**：只发布语义变化 `activeQueryRowId`；锚点按 `mountedKey + queryIds` 缓存、只读实时几何；宽度只裁决「是否达到目录资格」布尔；估高改用 `scrollRef.clientHeight`（一屏预算），实际尺寸仍由缓存与 RO 决定。
- **证据**：`packages/ui/src/v4/ConversationTimeline.tsx:745-767`（宽度/资格）、`:857-876`（估高）、`syncTurnNavigatorViewport` 整段。
- **移植要点与风险**：fork 的 `ConversationTimeline.tsx` 改动较多（含 fork 自己的锚点补偿），需人工融合。风险：估高从 72px 改为一屏会改变「首屏挂载单元数」的时序，可能影响依赖「挂载即测量」的既有断言；`isMountedLayoutMeasured` 与 BF-14 强耦合，建议同批。

## PF-06 Windows IME 组合态逐键提交（ZCT-2112490732581797888）

- **优化前**：`TextContentPlugin` 的 update listener 每次都对 `editorState` 与 `prevEditorState` 各做一次 `getEditorMarkdown()`，再 `onChange(next)` → `ConversationComposer.updateText` → `setText(next)` + `advanceComposerDraftRevision` + 写父级草稿/localStorage。Windows 中文输入法一次候选提交前会产生多次 composition 更新，每次都同步序列化前后两份全文并读写整份 localStorage，表现为文字和退格约数百毫秒后才出现。
- **优化后**：组合态只更新 Lexical/ref 与 `raw/trimmed` 布尔量（供发送按钮）；`resolveTextContentPublication` 去重「已发布正文」，`compositionend` 后才发布最终快照（Chrome 由 update listener 先发，Firefox/Safari 由 rAF 兜底）；父级草稿改为 350ms 静默窗口合并保存 + scope 绑定的 lifecycle commit；提交时读取 Lexical 当前快照而不是可能落后的 `textRef`。
- **证据**：`docs/ui/task-scoped-composer-drafts.md`「输入响应性回归（ZCT-2112490732581797888）」与「持久化规则」改写；代码在 `packages/ui/src/LexicalChatInput.tsx:823`（`resolveTextContentPublication`）、`v4/ConversationComposer.tsx:983`（「IME 候选阶段不向 React 发布正文，textRef 会暂时落后于 Lexical」）、`v4/composer/useDraftConfigControl.ts:773`（「350ms 自动保存走配置 setState，导致整页、Logo 和 Timeline 一起刷新」）。
- **移植要点与风险**：L。fork 的 `ConversationComposer` / `useDraftConfigControl` 都被改过（草稿 scope、首发提升），且上游这一版引入了 `stageComposerContent` / `persistComposerContent` / `composerDraftScopeToken` / `captureComposerSubmissionDraftTransaction` 一整套接口与 SessionPane 侧的新 props。**建议只取「Lexical 组合态不逐键发布 + 发布去重」这一层（M）**，把 350ms 静默窗口与 scope transaction 留给后续，避免与 fork 的草稿归属/首发提升逻辑冲突。风险：组合态不发布正文会改变「候选期发送按钮状态」的判定来源，必须保留 `onUserInputPresenceChange`。

# 4. 「看起来像修复但排除」

| 项 | 上游改动 | 排除理由 |
| --- | --- | --- |
| e2e-promotion 01 项目创建埋点来源 | `lib/sessionCreateTelemetry.ts` / `lib/appTelemetry.ts` | **红线 1**（遥测链已移除）；工单本身是埋点取值问题，不是用户可感知缺陷 |
| e2e-promotion 02 编辑重发/Fork 模型选择 | 无业务代码改动 | diff 中未见 `handleEdit`/`handleFork` 的模型选择参数改动，工单仍 `needs-triage`；只在测试侧记录 |
| e2e-promotion 03 自动压缩重复命令 | CLI `compact` 路径 | fork 已移除 ZCode 原生压缩（红线 3），`pendingCommandRegistry` 的 `compact` replay 分支在 fork 也已删除 |
| e2e-promotion 06 插件来源错误丢失 | `pluginManagementStore.updatePlugin` 改为返回 `boolean`；`pluginStoreListing` 新增串行更新 | 来源错误的 `ownsVisibleOperation` 丢弃未修（`addMarketplace` 只多了一个返回值）。**部分可借**：`updatePlugin` 返回值是后续修复的前提，已并入 BF-13 |
| e2e-promotion 04 重复连接早于 renderer attachment | 在 `packages/desktop/src/main/desktopRemoteSessions.ts` | 超出本区域（Main 进程）；UI 侧 `remote-navigation` 的修复是另一个竞态（BF-05），不能替代 |
| e2e-promotion 05 首发列表行早于详情绑定 | 无对应修复 | 工单仍 `needs-triage`；SessionPane 的 `promoteComposerDraft` 门禁解决的是「旧首发抢回已切走页面」，不是逐帧可见顺序 |
| e2e-promotion 07 远程项目编辑器 Escape 不关闭 | 无 | 工单仍 `needs-triage`，未定位 `preventDefault` 的拦截者；`ConfirmDialog`/`ProjectManagement` 的改动不含该修复 |
| e2e-promotion 08 文件树 tooltip | `docs/ui/sidebar-tooltips.md` 改 SBT03 验收范围 | **判为 spec/E2E 问题**：用户确认右侧文件树保留原生 `title`，业务代码未改（`WorkspaceFileTreeRowView` 的改动全是文件菜单/保存为/在文件管理器中显示等新功能） |
| e2e-promotion 09 Git 文件变更查找定位 | 只改会话范围（PF-03/BF-14） | Git diff 内文本定位未实现（工单写明「未将命中的行位置传给 diff 展示层」），无候选代码 |
| e2e-promotion 10 飞书群组草稿模式缺失 | 在 `apps/zcode-cli` bots 运行时 + `packages/services` | 不属 `packages/ui`/`packages/web` 改动面 |
| e2e-promotion 11 超限图片错误码 | 无 | `lib/chatAttachmentErrors.ts`、`v4/composer/useComposerAttachments.ts` 的错误分支未改（该文件只加了 `registerImageComposerTarget`，属 image-preview-editor 新功能） |
| e2e-promotion 12 定时任务归属丢失 | 无 UI 改动 | `cronAutomationId` 丢失在索引同步（services/Host），UI 侧只有未读投影，diff 中无对应修复 |
| e2e-promotion 13 配置 pending 阻塞首发 | 无 UI 改动 | 等待链在 `services/zcode-agent` 的 session 初始化，不在本区域 |
| e2e-promotion 14 附加目录 subagent 缺失 | 无 | 在 Host subagent 配置快照（services），UI 的 `SubagentsSection` 改动属 settings-scope 新功能 |
| e2e-promotion 15 切草稿销毁内嵌浏览器 guest | 无 | `UnifiedBrowserView` 的改动是恢复 URL/下载（BF-06），与 guest 销毁无关；工单仍 `needs-triage` |
| e2e-promotion 16 闲时模型泄漏 | `settings/OffPeakEditView.tsx` | fork 已下线闲时任务（BRIEF 已列），且工单仍 `needs-triage` |
| e2e-promotion 18 Electron 退出窗口未关 | 在 `packages/desktop` | 超出本区域（UI/Web），且工单仍 `needs-triage` |
| e2e-promotion 19 冷恢复水合顺序 | 无登录守卫改动 | diff 中 `useProviderAvailabilityLoginEntryGuard`/`providerFamilyDomainMigrationComplete` 均无变化；Root 的改动是 onboarding 挂载与项目接纳 |
| e2e-promotion 20 标题更新附近编辑被拒 | 无 | SessionPane 新增的是 `commandLease`/生命周期恢复，不是 revision 冲突处理 |
| e2e-promotion 21 运行时关闭后继续查询 | 新增 `getSessionLifecycle`/`onDynamicSessionLifecycle` 全链 | **新能力**：`SessionLifecycleSnapshot` 协议 + store 生命周期状态机；不是修复（BRIEF：新协议字段不算候选）。工单本身仍 `needs-triage` |
| e2e-promotion 22 Start Plan 思考档位 | 测试侧 `subagentSettingsReadyCursor` 屏障 | 明确「未修改刷新或禁用逻辑」，pure test |
| e2e-promotion 23 模型轨迹 Store 暴露 | `shouldExposeE2EStoreBridge` 已在基线存在 | 测试基建，不是产品缺陷 |
| onboarding 启动即扫描 Claude 历史 | `onboarding/OnboardingDialog.tsx` 加 `settingsSync.state.open` 门禁 | **不适用 fork**：该回归由上游删除欢迎页（`view === "wizard"` 门禁消失）引入；fork 仍保留 `view` 与欢迎页，扫描仍被 `view === "wizard"` 约束（fork `OnboardingDialog.tsx:78/187`） |
| 插件安装完成回放旧 prompt 覆盖用户编辑 | `ConversationComposer` 的 `prepend-if-missing` 分支 | **fork 已自行修复**：`packages/ui/src/v4/ConversationComposer.tsx:254-264` 已与上游一致 |
| `conversationTurnWorkSegments.ts` guided user 分段 | 每段 guided user 开一段 → runtime 单一边界 | 属显示语义对齐，依赖 CLI 侧 guide 边界语义；无用户可感知「错误 → 正确」的对照证据，判为重构 |
| `ChatErrorBanner` 长错误文案/请求安全校验错误 | `request-security-edition/errors.ts` | 新错误族（安全校验/下载）+ 横幅排版；不是既有缺陷修复 |
| `toast.tsx` progress/success 变体、`chat-loading.tsx` 像素动画+计时 | — | 纯新增 UI 能力（长任务进度、运行时耗显示） |
| `ConfirmDialog.tsx` yolo 确认/代码块/长说明滚动 | — | 新特性（yolo 模式确认、远端服务停止前任务清单） |
| `message.tsx` 文件链接「保存为/在文件管理器中显示/复制链接」 | — | 新 file-menu 能力；`MessageFileLink` 的 stale-request 守卫是伴随重构 |
| `i18n/locales/*` +949/−218 | — | 全部跟随新功能（projectManagement、remote-daemon、personalization、yolo…）与移除功能（remoteSync、machine scope）；未发现错译修正 |
| `PreviewPane.tsx` −223、`WorkspaceHeaderSections.tsx` −112、`OpenSplitButton.tsx` +219 | — | 纯重构/新文件菜单入口（`OpenSplitButton` 抽出、帮助菜单重排） |
| `personalization`、`project management`（`ProjectManagement*.tsx`、`RemovedProjects`）、`file-menu`、`image-preview-editor`、`data-sync`、`settings-scope` | — | 纯新产品线/新面板；fork 无对应目录或已下线 |
| `settings/SourceServerManagementPanel.tsx` +1245/−736、`remote-connection-flow/*`、`Root/root/*`（远端历史、重连） | — | 依赖 source-server R3 远程架构（BRIEF 已列下线面）；虽含若干真实 bugfix 注释，但移植需先恢复 R3 端口，成本远超收益 |
| `v4/telemetry/conversationTelemetrySupervisor.ts` −1924、`lib/messageTelemetry.ts` −1569、`lib/providerTelemetryIdentity.ts`、`local-ttft/*` 重命名 | — | **红线 1**：fork 已删遥测；`local-ttft` 是目录重构（`v4/telemetry/localTtft*` → `local-ttft/*` + contract），属重构 |
| 上游删除 1031 个 UI 单测 / 38 个 src D | — | 开源导出裁剪（BRIEF 明示），不是缺陷修复 |
| `web/src/web-remote-control/**`（transport 挂起丢 rpc-frame、AUTH_FAILED 重注册、401 否定在途 JWT） | — | 依赖 web-remote relay v2（BRIEF 已列下线面）；fork 的 `webRemoteControlEntry.ts` 已自行改造，需单独评估 |
| `web/src/platform/index.ts`（A +240）、`saveBrowserFile.ts`（A） | — | Web 平台层新模块 |
| `hooks/useGlobalTaskList`（host scope + enabled）、`store/zcodeSessionStoreWorkspaceSlice`（pluginUiOpenRequest） | — | 新查询能力/草稿内打开插件 UI，不是缺陷 |
| `settings/McpSettingsSection`、`settings/SubagentsSection`、`settings/PluginScopeMenu`（+318/−107） | — | settings-scope「按设备选择作用域」新功能；其 bugfix 注释都服务于该新模型（fork 无 `currentAuthorityKey`） |
| `terminal/terminalComposedInputFallback.ts` 手机 229 输入接管 | — | **新能力**（手机软键盘支持）；`docs/ui/terminal-sessions.md` 明确「尚未取得反馈手机的原生事件记录」。若 fork 要做手机远控输入可另立项目，本轮不取 |
| `hooks/useModelProviders` 的 `providerBusinessError` 3106 闲时超时 | — | 闲时任务已下线 |

# 5. 纯新功能 / 纯重构 / 纯测试（不候选）

1. **纯新功能（面板/产品线）**：`data-sync/**`（14 个新文件）、`file-menu/**`（12）、`image-preview-editor/**`（9）、`project-sidebar` 项目管理 6 件套、`settings-scope/**`（9）、`settings/PersonalizationSection.tsx`、`settings/SourceServerDeviceRow.tsx`、`project-sidebar/useWebRemoteControlRendererActions.ts`、`web/src/platform/**`、`web/src/web-remote-control/app/webRemoteControlBridgeRecovery.ts`、`onboarding` 欢迎页删除、`ConfirmDialog` yolo/代码块、`toast` 进度、`chat-loading` 计时、`message` 文件菜单、`WorkspaceShellLayout`（+253）、`useDraftSessionPrewarm`、`plugin-ui` 后台保活/页面会话。
2. **纯重构**：`OpenSplitButton` 抽出、`PreviewPane` 瘦身、`WorkspaceHeaderSections` 瘦身、`localTtft` → `local-ttft/*`（contract/module 分层）、`App.tsx` 的 `setConversationFindState` 结构、`AgentConversationTransport` 的 `ConversationV4AgentService` 提取、`terminalComposedInputFallback` 函数抽取、`v4/transport.ts`、`project-sidebar/view.ts`（部分含 bugfix，见 BF-05/§4）。
3. **纯测试**：`packages/ui/test/**` 1092 个文件（+5553/−278231）、`packages/web/test/**` 41 个（+1126/−7021）、`docs/issues/**` 与 `docs/ui/**` 规格更新（作为证据使用，不算候选）。
4. **纯文档/契约**：13 个 `CONTRACT.md`/示例文件。

# 6. 方法与局限

- 判定流程：`git diff --numstat` 聚类 → 只读 M 文件确认 hunk 的「旧错 → 新对」→ 用 `git diff --name-only 3c5b2276 main -- <file>` 判 fork 交集 → 用工作区文件/`git grep` 复核 fork 是否已修。
- 上游测试在 `packages/ui/test`（vitest，根 `node_modules\.bin\vitest.CMD run packages/ui/test`）；本报告未运行任何测试，也未修改产品代码。
- **待验证清单**（缺证据，移植前必须补）：
  1. BF-06：已确认 fork 缺 `onBrowserViewDownloadStarted` / `browserViewLoadUrl` 两个新端口；只取恢复 URL 部分可落在本区域，若要连「下载型导航不报加载失败」一起修，需改 `packages/desktop`（超出本区域）。
  2. BF-10：fork 的 Host/CLI 是否在后台任务通知 `payload.originMeta` 写入结构化终态与失败原文（决定「合并轮」与「失败详情」是否可分离）。
  3. BF-12：fork 的 MCP 状态源是否产出 `untrusted`（决定该项是否成立，还是纯上游项目 trust 能力）。
  4. BF-11：fork 无 `currentAuthorityKey`，「远端用户目标」场景需按两 tab（本机 + 远端）复现后再确认收益。
  5. PF-06：fork 的 `ConversationComposer` 草稿 scope/首发提升与上游 `composerDraftScopeToken` 语义不等价，350ms 静默窗口部分需单独设计。
  6. 所有「需人工融合」项：fork 侧对应文件的既有改动原因需逐 diff 比对（尤其 `SessionPane.tsx`、`ConversationTimeline.tsx`、`conversationProjectionStore.ts`、`useDraftConfigControl.ts`），不能整文件覆盖。
