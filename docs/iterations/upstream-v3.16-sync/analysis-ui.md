# 上游 v3.15.1 → v3.16.2 同步分析（packages/ui/src 与 packages/web/src）

- 分析范围：`packages/ui/src`、`packages/web/src`（测试目录 `packages/ui/test`、`packages/web/test` 只统计规模与类型）
- 基准：`aac47556`（上游 v3.15.1）→ `3c5b2276`（上游 v3.16.2，2026-10-20）
- omz 现状：本仓库工作区 HEAD（分支 `trace-nm-borrow`，HEAD `14032fea`）
- 本报告为只读分析，除本文件外未修改任何文件

---

## 0. 三个决定全局的前提

### 0.1 本次 diff 是「上游内部增量」，不是「omz 与上游的差距」

```
git merge-base HEAD aac47556  →  空（exit 1）
```

`aac47556` 只是被 fetch 进本地对象库的上游提交，**不是** omz 的同步基线。omz 自己的上游同步产物在 `upstream-v3.15.1-backport` 分支（已 backport 26 项）。

因此本报告中的「上游新增文件」对 omz 一律是**零基线**：omz 侧没有同名文件、没有半成品、没有已就位的接线点。移植成本 = 上游实现成本 ×（1 + omz 适配系数），不是「打个补丁」。

### 0.2 上游 v3.16.2 是单次 squash 提交，无法按上游提交粒度 cherry-pick

```
git log --oneline --no-merges aac47556..3c5b2276 → 1 条：0a1fc56d chore: sync ZCode source
```

主题聚类只能靠文件内容 + 上游 docs 佐证。回滚粒度必须由**我们自己切出的主题**保证。

### 0.3 omz 在本区域已删掉 519 个上游文件——「上游有」≠「omz 缺」

`git diff --name-status aac47556..HEAD -- packages/ui/src packages/web/src`：**M 630 / D 519 / A 30**。

omz 主动删除的上游整块能力（按目录）：

| 被删能力 | 代表文件 | 说明 |
| --- | --- | --- |
| plugin-ui 全模块 | `packages/ui/src/plugin-ui/**`（29 文件） | 插件 UI 托管运行时整体移除 |
| gen-ui 全模块 | `packages/ui/src/gen-ui/**`（14 文件） | 生成式 UI 卡片移除 |
| feedback 全模块 | `packages/ui/src/feedback/**`（25 文件） | 反馈中心移除 |
| highspeed 全模块 | `packages/ui/src/highspeed/**`（17 文件） | 高速模式移除 |
| marketing-touch | `packages/ui/src/components/marketing-touch/**`（11 文件） | 运营弹窗移除 |
| Web 远控（web 端） | `packages/web/src/{auth,webRemoteControl*}`（15 文件） | **整个 packages/web 只剩 share + main.tsx** |
| Web 远控（ui 端） | `packages/ui/src/{WebRemoteControl*,lib/webRemoteControl*}`（13 文件） | 远控弹窗仅保留 Bot 版 |
| conversation-share 全链 | `packages/ui/src/v4/ConversationShare*`（14 文件）+ `packages/web/src/share/*`（5 文件） | 分享能力整体移除，只留 `shareHeaderLayout.ts` |
| telemetry 全链 | `packages/ui/src/lib/*Telemetry.ts`（17 文件）+ `packages/ui/src/v4/telemetry/**`（9 文件） | **红线 1：已整删** |
| compact | `packages/ui/src/lib/contextCompactionRuntime.ts` | **红线 3：已整删** |
| OAuth / 登录 / CodingPlan / OffPeak / Rewards / 快捷命令面板 等 | 约 120 文件 | 商业化与登录相关界面移除 |

**直接结论**：上游 diff 中凡是「给已删模块做适配」的改动（plugin-ui、gen-ui、feedback、highspeed、marketing-touch、conversation-share、web-remote-control、telemetry）对 omz **一律是死代码**，不应移植。

### 0.4 规模分布（我负责区域）

| 维度 | 数值 |
| --- | --- |
| 变更文件总数（src） | **748**（A 256 / M 398 / D 61 / R 33） |
| 代码行 | **+55432 / −35876** |
| 变更行构成 | 91308 行 diff 中，**16852 行（18.5%）是 import 块改写**；**80 个文件的全部改动都只是 import 块** |
| 其中纯 import 改写的主因 | `@zcode/shared` → `@zcode/shared/test-ids` 子路径导出迁移，**涉及 120 个文件**（其中 66 个文件除 import 外零改动） |
| 新增「契约化模块」骨架 | **13 个新模块目录**，每个含 `CONTRACT.md` + `contract.ts` + `contract.example.ts` + `contract.test.ts` + `module.ts`（39 个脚手架文件） |
| omz 侧分叉度量 | 上游 M 的 492 个文件中：**164 个 omz 未动过（byte-identical，零冲突）**，**328 个 omz 已分叉** |

### 0.5 上游这次在 ui/web 引入了新的架构约定（必须先对齐，否则移植即违规）

上游 v3.16.2 把 `architecture-policy.yaml` 从 8 个模块扩到 30+ 个，新增大量 `managed: true` 模块，每个模块必须提供 `module.ts`（模块清单）+ `contract.ts`（纯类型契约）+ `CONTRACT.md`。ui 侧新增 12 个 managed 模块（project-sidebar、side-pane-full-view、remote-connection-flow、conversation-workspace-target、workspace-config-catalog、workspace-plugin-preview、composer-toolbar-layout、marketing-touch-contract、project-workflow、web-remote-control、mobile-ui），web 侧新增 1 个。

omz 的 `architecture-policy.yaml` 里 `ui` 与 `web` 仍是 `managed: false`，`global.managedOnly: true`。**上游任何带 `module.ts` 的新模块若要进入 omz，必须同时登记到 omz 的 architecture-policy.yaml，否则 `pnpm architecture:check` 直接失败**（上游 `module.ts` 注释里明写「修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）」）。

### 0.6 品牌红线在本区域的实际命中面

| 命中形式 | 命中文件数 | 例子 |
| --- | --- | --- |
| `ZCode` 品牌文案（注释/UI 文案/aria-label/title） | 45 | `WelcomeScreen.tsx` `aria-label="ZCode"`；`app-shell/WorkspaceShellLayout.tsx` `title={\`ZCode / ${...}\`}`；`WorkspaceSidebarFooter.tsx` `return "ZCode"` |
| `~/.zcode/` 路径 | 6 | `onboarding/OnboardingDialog.tsx` `"~/.zcode/AGENTS.md"`；`store/mcpStore.ts` `"~/.zcode/cli/config.json"` |
| `zcode://` scheme | 1 | `packages/web/src/share/conversationSharePreviewClient.ts` → `zcode://share/import?code=…` |
| `ZCODE_*` 环境变量 | 34（多数是 `@zcode/shared` 常量名，非 env） | `ZCODE_PRODUCT_DOCS_URL` 等 |
| `@zcode/*` 包名 | 400（包名本身，**不改**） | `@zcode/shared`、`@zcode/ui` |

**红线 4 的处理**：包名 `@zcode/*` 不动；但 `ZCode` 文案、`~/.zcode`、`zcode://` 必须改成 omz 形态。omz 已有先例：`packages/web/src/main.tsx` 里定义了 `OMZ_WEB_BRAND_NAME = "omz"`。

### 0.7 红线 1 / 3 在本区域的实际命中面

- **红线 1（遥测移除）**：上游 diff 在 ui/web 只有 2 个遥测文件（`lib/messageTelemetry.ts`、`v4/telemetry/conversationTelemetrySupervisor.ts`），**两者在 omz 已被删除**。→ 无移植面，不需任何动作。
- **红线 3（原生压缩移除）**：上游 ui/web diff 中 **0 个** compact 相关文件。→ 无命中。
- **红线 2（magic-context）**：上游 diff 完全不涉及（omz 的 `chat-input-toolbar/magicContextUsageRows.ts`、`lib/promptLanguageSync.ts`、`hooks/useSystemLanguagePromptSync.ts` 上游都不存在）。→ 上游改动**不得覆盖**这些 fork 独有文件。

---

## 1. 主题逐条分析

> 规模口径：文件数 / ±行数（来自 `git diff --numstat aac47556..3c5b2276 -- packages/ui/src packages/web/src`）。
> 「性质」区分：新功能 / 缺陷修复 / 重构 / 依赖。

### T01 · project-sidebar：虚拟项目侧栏（上游本区域最大主题）

**规模**：73 文件，**+10765 / −207**（71 新增 + 2 删除 + 17 个 rename）。其中 `packages/ui/src/project-sidebar/` 全新目录 45 文件，`workspace-grouped-tasks/` 整体 rename 进 `project-sidebar/grouped/`。

**关键事实**：上游把 `WorkspaceSidebar.tsx`（1963 行）**整体删掉**，换成 4 行的转发：

```ts
export { ProjectSidebar as WorkspaceSidebar } from "@/project-sidebar/index.js";
```

同时删掉 `WorkspaceSidebarItem.tsx`（1210）、`WorkspaceGroupedTasksSection.tsx`（1946）、`WorkspaceTimelineTasksSection.tsx`（1058）、`WorkspacePinnedTasksSection.tsx`（769）、`WorkspaceArchivedTasksFlatSection.tsx`（345）、`SortableWorkspaceSidebar.tsx`（141），另删 `lib/workspacePurpose.ts`、`lib/workspaceRemovalSafety.ts`、`lib/workspaceTaskPagination.ts`、`lib/taskTimelineGroups.ts`、`lib/unreadTaskCount.ts`、`hooks/useWorkspaceTaskLists.ts`、`hooks/useGroupedTaskView.ts`、`store/remotePinnedTaskStore.ts`、`store/remoteTimelineTaskStore.ts` 等 26 个支撑文件。

**变更性质**：新功能（虚拟项目数据模型落地）+ 大规模重构。

**上游动机**（docs）：
- `docs/superpowers/specs/2026-09-09-virtual-project-design.md`（+1900 行，核心裁决：Group 与 Project 合并，Project 不再等同 Folder Path）
- `docs/superpowers/specs/2026-09-11-archive-management.md`（归档管理页）
- `docs/superpowers/specs/2026-09-11-project-sidebar-width-stability.md`（宽度稳定性）
- `docs/ui/task-grouped-view.md`、`docs/ui/sidebar-task-view-switcher.md`、`docs/ui/task-unread-state.md`、`docs/ui/task-title-authority.md`、`docs/ui/workspace-sidebar-navigation.md`
- `docs/project-drag-insertion-indicator.md`、`docs/project-primary-root-availability.md`

**omz 现状**：
- `packages/ui/src/project-sidebar/` **不存在**；`workspace-grouped-tasks/` 存在但仍是旧结构（未 rename）。
- omz 侧 `WorkspaceSidebar.tsx` **1675 行**（上游 v3.15.1 是 1964 行，omz 已删掉约 290 行），分叉度中等。
- **致命依赖缺口**：上游 project-sidebar 依赖 `packages/services/src/{project,project-storage,project-workspace-navigation,task-facts}`（上游新增 4 个包共 +4242 行）、`packages/shared/src/sqlite-migrations/`（+906）、`packages/shared/src/source-server/`（+893）。**omz 的 `packages/services/src` 下这 6 个目录全部不存在**，`packages/shared/src` 也无 `sqlite-migrations` / `source-server`。
- 上游 52 个 ui 文件引用 `sourceServerId`，18 个引用 `parseRemoteWorkspaceIdentity`，11 个引用 `ConnectionProfile` —— omz 的 `packages/shared/src/index.ts` 里**这些符号一个都没有**。

**移植建议**：**不建议移植（需用户拍板）**。
理由：这是一个「服务端 + 协议 + 存储 + UI」四层联动的架构级迁移，单靠 ui 层无法成立；且 omz 侧已经删除 conversation-share / 远控 / project 相关的一整套历史，语义前提不同。上游自己的 `docs/superpowers/specs/2026-09-09-virtual-project-design.md` 状态仍是「实施中」，且文中记录了 2026-10-19 的同机多持库 owner 遗留问题（明确写「遗留问题（未修复）」）。**在 omz 引入虚拟项目模型 = 引入一个新产品线**，应作为独立迭代立项，不应混进 v3.16 同步。

**工作量**：**L > 2 天**（按 omz 需自建 services 层计，实际是「引入产品」级）。
**主要风险**：数据模型迁移不可逆；omz 已有 trajectory 面板挂在旧 sidebar 结构上，迁移会连带影响轨迹面板宿主；上游自身该模型尚未收敛。

---

### T02 · remote-connection：SSH 远程连接三屏向导

**规模**：30 文件，**+7009 / −1601**（20 新增）。核心是新增 `packages/ui/src/remote-connection-flow/`（9 文件：contract + index + module + requestRemoteProjectConnection + ui/RemoteConnectionProgress）+ `packages/ui/src/remote-connection/` 下 9 个新组件（RemoteConnectionSelection / RemotePasswordInput / RemoteLinkRail / RemoteConnectionTags / RemoteConnectionStateIcon / RemoteConnectionNavigationDot / RemoteTaskDeviceLabel / EditConnectionProfileDialog）。`SSHDialog.tsx` 被**瘦身 662 → 130 行**（−578/+46），改为纯 `useRemoteConnectionFlow` 编排壳。`RemoteConnectionFields.tsx` +860/−499（拆出密码输入、别名 chip、类型磁贴）。

**变更性质**：新功能（交互重构）+ 重构。

**上游动机**：
- `docs/issues/remote-connection-ux/01-remote-connection-ux-optimization.md`（父票，12 张子票）
- `docs/issues/remote-connection-ux/10-three-screen-wizard-and-selection.md`（**三屏向导具体规格**：选择 → 连接中 → 选目录，去掉左侧步骤栏，统一列表含 SSH config Host / WSL / Docker）
- `docs/issues/remote-connection-ux/04-wizard-p0-fixes-and-flow-controller.md`、`08-disconnect-experience-and-in-place-reconnect.md`
- `docs/architecture/remote-device-connection-ux-spec.md`、`docs/ui/ssh-config-alias.md`

**omz 现状**：
- omz 侧 `packages/ui/src/remote-connection/` 存在但只有 3 个文件（`RemoteConnectionConnectingStep.tsx`、`RemoteConnectionHistoryInput.tsx`），`remote-connection-flow/` **不存在**。
- omz 的 `SSHDialog.tsx` **630 行**（上游 v3.15.1 是 662 行）—— omz 仍保留旧的「单体弹窗」形态，与上游 v3.16 的「flow 编排壳」形态差距就是本主题的全部分量。
- omz 的 `hooks/useRemoteConnectionForm.ts`、`hooks/useRemoteConnectionLogs.ts`、`lib/remoteConnectionWizard.ts`、`lib/remoteConnectionDialogState.ts`、`root/useReconnectingRemoteWorkspaceLogs.ts` **都存在**（上游对应文件也改），这是少数「omz 已铺好前置」的主题。
- **依赖缺口**：`remote-connection-flow/index.ts` 引用 `getSourceServerUpdateTarget`、`isSameSourceServerUpdateTarget`、`ConnectionProfile`、`SourceServerRunningTask`、`useSourceServerManagementSnapshot`、`useSourceServerOperationLogs` —— omz 的 shared/services **全部没有**。上游这批能力属于 source-server R3 主链（`packages/shared/src/source-server/` + `packages/services/src/source-server-management/`），而 omz 的远程模型还是老的 `remote:ssh:<host>:<port>:<user>:<path>` identity 字符串（见 `packages/shared/src/remote-workspace-identity.ts`）。
- 另注：上游的「三屏向导」进度条要落在侧栏（`project-sidebar/RemoteConnectionProgressSection.tsx`），依赖 T01。

**移植建议**：**需用户拍板**（分两档）。
- 档 A（推荐先做）：只做**纯 UI 层**的三屏向导骨架与缺陷修复，不引入 source-server：`SSH Config Alias` 选择（`docs/ui/ssh-config-alias.md`，依赖 `packages/services/src/system/sshConfigAlias.ts`，omz 无 → 需一并实现）、Docker/WSL 可用性提示二分、端口数字校验、聚焦随屏切换、macOS 不显示 WSL。**S < 半天**。
- 档 B：`remote-connection-flow` 全量（含 source-server 管理、更新通知、进度行）→ 依赖 T01 + source-server 链，**L > 2 天**。
- 明确**不建议**盲放的是 `RemoteConnectionFields.tsx` 的 +860 行——它整段依赖 `REMOTE_KIND_PRESENTATION` / source-server 分支，omz 无对应领域。

**工作量**：档 A **S**；档 B **L**。
**主要风险**：omz 的 remote identity 模型与上游 R3 不同，硬套 UI 会产生「界面有设备概念、底层无设备实体」的悬空态。

---

### T03 · side-pane-full-view：右侧面板完整视图

**规模**：13 文件，**+1210 / −0**（全新目录 `packages/ui/src/side-pane-full-view/`，含 CONTRACT.md + contract.ts + module.ts + contract.example.ts + contract.test.ts + ConversationHost.tsx / ConversationTab.tsx / ToggleButton.tsx / useSidePaneFullView.ts / conversationPanePresentation.ts / anchorPreference.ts / model.ts / index.ts）。

**变更性质**：新功能。

**上游动机**：`docs/ui/side-pane-full-view.md`（7929 字符，2026-10-16 实现 / 10-17 E2E 转正）。右面板临时占满除左侧任务列表外的全部区域，对话变成面板第一个 tab，浮窗可收起/最小化，快捷键 `⇧⌘F` / `Ctrl+Shift+F`，仅桌面 Electron 提供。

**omz 现状**：
- 目录 **不存在**；但 omz 的前置件**齐备**：`lib/workspaceSidePane.ts`、`hooks/useAppPanels.ts`、`store/tabStore.ts`、`v4/splitPaneEntryContext.tsx`、`v4/conversationTimelineLiveTail.ts`、`lib/taskSidePaneMemory.ts`、`components/ui/resizable.tsx` 全部存在。
- 上游改动面：`app-shell/WorkspaceShellLayout.tsx`（+3995 行真实变更，omz 已分叉 4057 行）、`v4/SessionPane.tsx`（omz 3743 行 vs 上游 5983 行）、`v4/ConversationTimeline.tsx`、`hooks/useAppPanels.ts`（341 行真实变更）。
- **依赖缺口**：上游的 `useSidePaneFullView` 与 `ConversationHost` 依赖 `project-sidebar` 的 `ProjectDirectoryProvider`（工作区目录 owner）与 `v4` 的会话投影；omz 无 project-sidebar。

**移植建议**：**建议移植（但需先解耦）**。
这是本区域**最值得单独摘出来的新功能**：交互价值明确、文档完备、E2E 已转正、前置件 omz 齐备。移植前需把「会话宿主」从 `project-sidebar` 解耦（上游 `ConversationHost.tsx` 609 行真实变更中会 import `@/project-sidebar/index.js`）。
**工作量**：**M < 2 天**（解耦 + 接线 + i18n + E2E）。
**主要风险**：`WorkspaceShellLayout.tsx` 是 omz 分叉最深的文件之一（4057 行），接线冲突面大；浮窗与虚拟化列表的 owner 生命周期（参考 fork 侧轨迹面板 `ModelTrajectoryMessageViewHost` 的教训）需重新验证。

---

### T04 · conversation-share：会话分享交互链

**规模**：32 文件，**+2433 / −1373**（新增 `packages/ui/src/conversation-share-interaction/` 5 文件 + `v4/conversationShareItems.ts` + `v4/ConversationShareContent.tsx` + `v4/ConversationShareWorkflow.tsx`；删除 `v4/ConversationShareSelection{Dock,ReopenTab,Scrim}.tsx`、`useConversationShareSelectionOutsideDismiss.ts`）。

**变更性质**：新功能（分享选择交互重构）+ 重构。

**上游动机**：`docs/conversation-share-v1.md`、`docs/ui/conversation-selection-side-chat.md`、`docs/web-remote-control/web-remote-control-architecture.md` 中的只读分享时间线。

**omz 现状**：**整条分享能力已被 fork 删除**。omz 的 `packages/ui/src` 下 **0 个** `ConversationShare*` 文件，`packages/ui/src/v4` 下 0 个，`packages/web/src/share/` 只剩 `shareHeaderLayout.ts`（一个纯布局测量模块）。全仓仅剩 `i18n/locales/*.ts` 里 20+ 条 `conversationShare.*` 死键。

**移植建议**：**不建议移植**。
分享是 omz 主动砍掉的产品能力，上游的分享交互（选择 dock、只读时间线、preflight、分享导入引导）整体无宿主。且上游分享导入落点是 `zcode://share/import` scheme —— 引入即触碰红线 4。
**工作量**：L（若强行做）+ 无产品价值。
**主要风险**：无（不做即零风险）。**但应顺手清理 omz locales 里的 20+ 条 `conversationShare.*` 死键**（S）。

---

### T05 · web-remote-control（web 端 relay v2）

**规模**：`packages/web/src` 侧 **37 文件，+3136 / −1363**（27 新增）。新增 `packages/web/src/web-remote-control/`（27 文件，含 CONTRACT.md + contract.ts + module.ts + adapters/ 8 + app/ 9 + contracts/ + domain/ + ui/ 7），删除 `webRemoteControlTransport.ts`（1110 行）、`webRemoteControlRelayAuthProvider.ts`、`webRemoteControlWorkspaceBridgeSession.ts`、`webRemoteControlFailureScreen.tsx`（改名为 `domain/webRemoteControlScreenCopy.ts`）、`packages/web/src/auth/` 全目录 8 文件。

**变更性质**：新功能（Relay V2 鉴权模型重构）+ 依赖。

**上游动机**：`docs/issues/web-remote-control-relay-v2/01-relay-v2-login-pairing.md`（**核心动机：V1 安全模型是「拿到二维码 URL 的人就能控制电脑」，pass_hash 明文在 URL 中且与用户身份无关；改为 JWT 注册设备 + 一次性连接 token**）、`05-mobile-login-and-qr-direct-connect.md`、`docs/web-remote-control/relay-v2-pairing.md`、`docs/web-remote-control/web-remote-login.md`。

**omz 现状**：**整个 packages/web 只剩 4 个文件**（`env.d.ts`、`main.tsx`、`share/shareHeaderLayout.ts`、`webThemeSeed.ts`）。omz 的 `packages/web/src/main.tsx` 只有 308 行（上游 v3.16.2 是 2107 行）。omz **没有远控 web 端**，也没有 `packages/web/src/auth/`（无 OAuth 登录）。

**移植建议**：**不建议移植**。
远控是 fork 主动砍掉的能力；且 relay v2 依赖服务端 `zcode-server` 的 `/api/v1/remote/ws2`（`packages/shared/src/web-remote-relay/` 上游新增 330 行，omz 无）与手机端 App 生态（omz 无 `packages/android`）。这属于「引入新产品」而非「同步」。
**工作量**：L > 2 天，且价值为负。
**主要风险**：无（不做即零风险）。

---

### T06 · settings 设置页大改

**规模**：75 文件，**+5650 / −2703**（6 新增）。新增 `settings/SettingsMachine.tsx`（设置页机器作用域上下文）、`settings/settingsSourceWorkspace.ts`、`settings/SourceServerManagementPanel.tsx`（**1739 行，单文件最大**）、`settings/SourceServerMigrationReportPanel.tsx`、`settings/SourceServerUpdateActivity.tsx`、`settings/sourceServerManagementPresentation.ts`。重写 `settingsPageConfig.ts`（新增 `remoteDevices` 与 `archives` 两个分区）。

**变更性质**：新功能（远程设备分区、归档管理入口）+ 重构。

**上游动机**：`docs/issues/remote-connection-ux/13-settings-device-cards-and-updates.md`、`docs/superpowers/specs/2026-09-11-archive-management.md`、`docs/ui/settings-header-breadcrumb.md`、`docs/ui/project-memory-settings-navigation.md`。

**omz 现状**：
- omz 的 `packages/ui/src/settings/` 存在，**文件数远少于上游**（omz 缺 `SourceServerManagementPanel` 等 6 个新文件；omz 独有 `MagicContextSettingsSection.tsx`、`MagicContextSettingsFields.tsx`、`MemoryManagementSection.tsx` 等 fork 特有页）。
- omz `settingsPageConfig.ts` 存在但**无** `remoteDevices` / `archives` 分区。
- **依赖缺口**：SourceServerManagementPanel 依赖 `SourceServerRecord` / `ConnectionProfile` / source-server 服务（omz 全无）；归档管理依赖 project-sidebar 的 `ArchiveManagement`（omz 无）。

**移植建议**：**分档**。
- **建议移植（低风险子集，S < 半天）**：
  - `SettingsMachine.tsx` 的「设置作用域（local/remote）标签」思路本身可摘，但 omz 无 remote 设备概念 → **暂不移植**。
  - `settingsPageConfig.ts` 的 `archives` 分区 → 依赖 T01，不做。
  - `ShortcutSearchBar` / `SettingsSearchInput` / `ShortcutBindingRow` 的小改（合计 ~150 行，omz 对应文件分叉小）→ **可作为「设置页体验优化」单独摘**，S。
- **不建议移植**：SourceServer* 三件套（依赖 source-server 主链）。
- **建议清理**：omz `settings/` 目录里的 `useCodingPlanProducts.ts` 等文件在 omz 已被删（属 CodingPlan），上游仍在改 → 不要把上游版本搬回来。

**工作量**：低风险子集 **S**；其余 **L**。
**主要风险**：上游 settings 目录与 omz 差异大（omz 有 Magic Context / MemoryManagement 特有页），整体覆盖会**抹掉 fork 自研页面**。

---

### T07 · i18n locales（中英双语）

**规模**：3 文件，**+1756 / −395**（`en-US.ts` +911/−202、`zh-CN.ts` +844/−192、`LocaleSwitcher.tsx` +1/−1）。

**变更性质**：新功能文案（随其它主题）+ 依赖。

**关键量化**（本次实测）：

| 口径 | en-US | zh-CN |
| --- | --- | --- |
| 上游 v3.16.2 词条数 | 7993 | 6981 |
| omz HEAD 词条数 | 6820 | 5936 |
| 上游有、omz 无 | — | **1273** |
| **omz 有、上游无（fork 独有）** | — | **228** |

omz 独有的 228 条里包含：`conversationShare.*`（分享已删的死键）、`modelTrajectory.*`（轨迹面板自研键，如 `modelTrajectory.turn.showPlaceholderRows`、`modelTrajectory.reasoningDisabled`）、`confirmDialog.projectRemoveTitle` 等。

上游新增的 1273 条以 `preview.image.*`、`archives.*`、`project.*`、`settings.remoteDevices*` 为主。

**omz 现状**：omz 的 zh-CN 是**自维护**的翻译（fork 自己补的 UI 中文化），与上游 zh-CN 已分叉（`git diff aac47556..HEAD -- packages/ui/src/i18n/locales/zh-CN.ts` = +1045/−…）。

**移植建议**：**建议移植，但必须「合并而非覆盖」**（红线 4 明确要求）。
- 具体做法：以 omz 当前 zh-CN 为基底，**逐条**补入上游新增的 1273 条中**与已移植功能相关**的部分；不要整文件替换。
- 特别保护：228 条 fork 独有键一条不能丢（其中 `modelTrajectory.*` 是轨迹面板 v1.0.18 的依赖）。
- `conversationShare.*` 死键（20+ 条）**顺手清理**。
- **工作量**：**M < 2 天**（键级合并 + 回归）。
- **主要风险**：整文件覆盖会**静默丢掉轨迹面板的中文文案**（fork 记忆 #104/#110 明确记录过 `modelTrajectory.copyContent` 这类死键复用问题）；locale 是全 UI 的最后一道防线，覆盖后回滚成本高。

---

### T08 · ToolCallBlocks：工具调用展示与「宿主能力」解耦

**规模**：25 文件，**+700 / −460**（4 新增：`ToolCallBlocks/ToolPresentation.tsx` 98 行、`ToolCallBlocks/presentationCapabilities.tsx` 29 行、`hooks/useToolPresentationHostCapabilities.ts`、`renderers/web-fetch.tsx`）。

**变更性质**：新功能 + 重构（架构解耦）。

**实质**（读 diff 确认，非文件名猜测）：
1. 引入 `ToolPresentationCapabilities` Context（`readMediaPreview` / `getApplicationIcon` / `agentColor` / `modelProviderName` / `normalizeOutputText` / `resourceUrl` / `readonly`），让 **renderer 不再直接依赖 `useServices()`**，公开页面（分享只读时间线）可在无服务宿主下渲染工具卡。
2. `resolveRenderer.ts` 新增 `ToolSearch` 分流（复用搜索卡片但不改 search family）、`web-fetch` 新 renderer。
3. `ToolCallBody.tsx` 的内嵌图片读取加了终态收口（原代码失败时永久 loading + 未处理 rejection）。

**omz 现状**：
- omz 的 `ToolCallBlocks/` 存在，结构与上游 v3.15.1 基本一致（omz 删了 `ExecuteCommand.tsx`、`createWorkflowHoleInput.ts`、`offpeak-create.tsx`、`workflow-fill-row.tsx`、`ToolCallProgressIndicator.tsx` —— 这些是 fork 砍掉的能力）。
- omz 的 `resolveRenderer.ts` **已无 plugin-ui 分支**（上游 v3.15.1 有，v3.16.2 删掉了；omz 是自己提前删的）。
- omz **没有** `ToolPresentation.tsx` / `presentationCapabilities.tsx` / `useToolPresentationHostCapabilities.ts`。
- omz 有自研的 `ModelTrajectoryToolPayload.ts` / `ModelTrajectoryToolJoin.ts` / `ModelTrajectoryToolPairCard.tsx`（轨迹面板的工具配对卡，v1.0.18 候选），**与本主题无直接文件冲突，但语义相邻**（都在工具卡渲染层）。

**移植建议**：**建议移植（低价值但零风险子集）**。
- 值得摘的：`ToolCallBody` 内嵌图片读取的终态收口（缺陷修复，omz 同样存在永久 loading 风险，S）；`web-fetch` renderer（若 omz 有 web_fetch 工具，omz 需先确认工具集）；`ToolSearch` 分流（若 omz 有 ToolSearch 工具）。
- `ToolPresentation` + `presentationCapabilities` 解耦：**暂不建议**——它的直接动机是「分享只读时间线」页面，而 omz 已删除分享能力；omz 唯一可能的消费者是轨迹面板，但轨迹面板走自己的 `ModelTrajectory*` 链。

**工作量**：缺陷修复子集 **S**；解耦全量 **M**。
**主要风险**：低。唯一需注意的是 `resolveRenderer` 的分流顺序（上游把 `ToolSearch` 放在 family 判定之前），omz 若照搬会改变现有工具卡的 family 归类。

---

### T09 · chat-input-toolbar：Composer 模型 + 思考档位合并入口

**规模**：10 文件，**+844 / −46**（6 新增：`ComposerModelMenu.tsx`、`ComposerProviderMenu.tsx` 209 行、`ComposerEffortHeading.tsx`、`ComposerTriggerTransition.tsx`、`thoughtLevelLabels.ts`、`composer-thought-slider.css`）。另 `thoughtLevelOptions.ts` 把 `THOUGHT_LEVEL_LABEL_IDS` 表**外提**到 `thoughtLevelLabels.ts`。

**变更性质**：新功能（交互重构）+ 重构。

**上游动机**：`docs/composer-model-thinking.md`（22100 字符，规格极细：入口不显示 Provider 前缀、菜单分 Models 分区、思考档位绿条、展开时宽度锁定 ≥8rem、展开态隐藏模型/档位改显示「选择模型」、Tooltip 文案、胶囊式 Think 滑杆）。

**omz 现状**：
- omz 的 `chat-input-toolbar/` 有 10 个文件（上游 v3.16.2 有 24 个）。omz **缺**全部 6 个新文件，也缺上游的 `ChatCodingPlanMcpUsageMeter` / `ChatModeSwitchControl` / `CodingPlanContextUsage` / `StartPlanContextBalance` / `contextQuotaMeterGrid` / `codingPlanQuotaReset*`（**这些是 fork 已删的 CodingPlan / OffPeak 能力，omz 不该补回**）。
- **红线 2 冲突点**：omz 的 `chat-input-toolbar/contextUsage.tsx` 是 **fork 自研**的（474 行，聚合 Context windows + Magic Context 两段，含 `magicContextUsageRows.ts` 与 `TID_CHAT_CONTEXT_USAGE_MAGIC_CONTEXT`）；上游同文件 200 行左右，且**上游 diff 里它只改了 import 路径**（`TID_CHAT_CONTEXT_USAGE_TRIGGER` 挪到 `@zcode/shared/test-ids`）。→ 合并时**只取 import 迁移，保留 omz 全部 Magic Context 逻辑**。
- omz 的 `ModelConfigSelect.tsx` 664 行（上游 823 行），`display.tsx` / `thoughtLevelOptions.ts` 均存在。

**移植建议**：**建议移植（分两步）**。
- 步骤 1（**S**）：先做 `thoughtLevelLabels.ts` 外提 —— 这是纯粹的重构，目的是让「工具条」与「工作流子代理模型」两处查同一张档位表（上游注释明写这一点）。omz 的 `thoughtLevelOptions.ts` 结构相同，**改动小、收益明确、无 fork 冲突**。
- 步骤 2（**M**）：Composer 模型/档位合并入口 UI。需重做 `ModelConfigSelect.tsx`（omz 已分叉 335 行），并注意 omz 有 ProviderPlaceholderCards / Magic Context 等自研 UI 元素要保留。

**工作量**：步骤 1 **S**；步骤 2 **M**。
**主要风险**：`contextUsage.tsx` 若整文件替换会**摧毁 omz 的 Magic Context 上下文面板**（fork 记忆 #103 记录过该面板的用户反馈与「不要额外加说明文案」的教训）。**必须逐行合并。**

---

### T10 · v4 会话区重构

**规模**：65 文件，**+3166 / −2099**（2 新增：`v4/conversationShareItems.ts`、`v4/RemoteConversationAvailability.tsx`；5 删除）。

**变更性质**：重构 + 依赖（新功能跟随其它主题）。

**上游动机**：`docs/v4-refactor/06-ui.md`、`docs/v4-refactor/m5-composer-parity.md`、`docs/v4-refactor/17-cold-resume-runtime-activation.md`、`docs/ui/v4-chat-turn-render-units.md`、`docs/ui/conversation-turn-navigator.md`。

**omz 现状**：
- omz `packages/ui/src/v4/` 存在且**分叉严重**：`v4/SessionPane.tsx` omz 3743 行 vs 上游 5983 行（omz 分叉 2967 行）；`v4/ConversationTimeline.tsx` 分叉 915 行；`v4/ConversationTurnGroup.tsx` 分叉 583 行；`v4/conversationProjectionStore.ts` 分叉 553 行。
- omz 的 `v4/` 有 fork 独有文件：`ConversationQueueRow.tsx`、`conversationProjectionCore.ts`、`conversationTurnNavigatorDirectory.ts`、`conversationTurnRenderUnitsDraft.ts`、`useQueueItemDeliveryToggle.ts`。
- 上游 v4 侧的关键新依赖：`@/project-sidebar/index.js`（`useOptionalProjectDirectory`）、`@/side-pane-full-view/index.js`、`@/conversation-share-interaction/*`、`@/remote/useRemoteWorkspaceController.js`、`@/hooks/RemoteProjectPresentationContext.js` —— **omz 这 4 个模块都不存在**。

**移植建议**：**不建议整体移植**。
v4 的改动几乎全是其它主题的**下游消费者**（project-sidebar / side-pane-full-view / conversation-share / remote-controller）。正确做法是：**先定 T03（side-pane-full-view）与 T01 的去留，再反向挑 v4 的必要接线**，而不是整体搬。
**工作量**：随宿主主题而定；单独做 **M** 但收益低。
**主要风险**：omz 的 `SessionPane.tsx` 是分叉最深的大文件之一，机械移植会覆盖 fork 的队列行 / 轨迹面板接线。

---

### T11 · 基础 UI 组件缺陷修复（dialog / collapsible / kbd / tooltip / toast / hover-card / dropdown-menu）

**规模**：16 文件，**+251 / −135**（`packages/ui/src/components/`）。

**变更性质**：**缺陷修复为主**（低风险高价值）。

**逐条实质**（读 diff 确认）：

| 文件 | 变更实质 | omz 现状 |
| --- | --- | --- |
| `components/ui/dialog.tsx` | 关闭按钮的 `sr-only` 文案「Close」改为走 i18n `common.close` | omz **仍是硬编码 "Close"**；omz 的 en-US 有 `common.close` 键 → **可直接移植** |
| `components/ui/collapsible.tsx` | 去掉 `group/collapsible-content` 嵌套 group，动画改由当前 content 的 `data-state` 直接驱动。**修复**：嵌套 collapsible 时同名 group 会匹配祖先 open，覆盖当前 closed 的淡出 | omz **仍是旧 group 写法** → 存在同一 bug（轨迹面板用 Collapsible） |
| `components/ui/kbd.tsx` | 键帽从 `bg-muted` 改为复用 `ControlShortcutBadge`。**修复**：旧键帽用了未定义的 `muted` 色彩 token，**实际渲染透明** | omz **仍是 `bg-muted`** → 存在同一 bug（快捷键提示不可见） |
| `ControlShortcutBadge.tsx`（新 27 行） | 全应用统一快捷键徽标（含 Apple 平台字体） | omz 无此文件；`lib/keyboardShortcuts.ts` 的 `isAppleKeyboardPlatform` 已有 |
| `components/ui/tooltip.tsx` | 新增 `alwaysDelay` prop + `TooltipHoverDelayContext`（父子浮层继承延迟） | omz 无 → 可移植 |
| `components/ui/dropdown-menu.tsx` | `DropdownMenuSubTrigger` 新增 `indicator` 插槽（替换硬编码 ChevronRight） | omz 无 → 可移植；是 T09 ComposerProviderMenu 的前置 |
| `components/ui/toast.tsx` | 新增 `source-server-update` variant | omz **不需要**（无 source-server）→ 不移植 |
| `components/ui/hover-card.tsx` | 自定义锚点时 Portal 与 Content 共享 Root scope | omz 可移植（低优先） |
| `components/ui/resizable.tsx` | 导出 `WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME` 常量 | omz 可移植（为 T03 服务） |

**移植建议**：**建议移植（这是本区域性价比最高的主题）**。
- 优先摘：`dialog.tsx` 的 i18n 关闭文案 + `collapsible.tsx` 动画修复 + `kbd.tsx`/`ControlShortcutBadge` 键帽可见性修复 + `dropdown-menu` indicator 插槽 + `tooltip` alwaysDelay。
- 这五条**零 fork 冲突**（omz 对应文件未被上游大改），且都是**用户可感知的缺陷修复**。
- **工作量**：**S < 半天**（5 个文件 + i18n 键 + 视觉回归）。
- **主要风险**：`collapsible.tsx` 的动画改法会改变所有折叠面板的过渡观感（轨迹面板、设置页折叠区都受影响），需视觉回归。

---

### T12 · mentions / prompt-editor：文件 mention 改用项目根路径

**规模**：8 文件，**+368 / −318**（mentions 4 + prompt-editor 2 + 其他 2）。

**变更性质**：重构（语义切换）+ 依赖。

**上游实质**（读 diff 确认）：文件 mention 的 id 从 `file:${relativePath}` 改为 `file:${path}`；新增 `ProjectFileEntry`（带 `rootPath` / `rootName` / `mentionPath`）；`fileMentionProvider` 从 `useServices()` 改为 `useWorkspaceServicesResolution()`，并按 `sessionId` / `projectId` 调 `projectService.resolveSessionDirectories()` 取多根目录；mention 分组从扁平列表改为 `groups`（每组带 title）。

**omz 现状**：
- omz 的 `mentions/` 与 `prompt-editor/` 都存在，文件数与上游 v3.15.1 相同（上游 v3.16.2 新增 `mentions/components/ContextMentionOptionContent.tsx`）。
- **依赖缺口**：`projectService.resolveSessionDirectories` 属于上游新增的 `packages/services/src/project/`（+1274），omz 无。omz 的 mention 仍用单 workspace 根。
- omz `prompt-editor/ChatPromptEditor.tsx` 分叉 116 行。

**移植建议**：**不建议移植**（除非要引入虚拟项目）。
多根目录 mention 是 project-sidebar 的下游能力；omz 无 project 模型时，`mentionPath` / `rootName` / `groups` 三个新字段都没有意义。
**工作量**：**L**（依赖 T01）。
**主要风险**：`file:${path}` id 变更会影响草稿持久化里已存的 mention id（omz `composerDraftStore` 存的是序列化正文 + 引用 chip）——**改 id 会导致老草稿的引用 chip 失效**。这是一个真实的数据兼容风险点。

---

### T13 · plugin-ui 后台执行与推荐

**规模**：28 文件，**+883 / −77**（6 新增，含 `adapters/PluginUiBackgroundHost.tsx`、`adapters/pluginUiBackground.ts`、`adapters/useMarketPluginUi.ts`、`adapters/useRecommendedUiPlugins.ts`、`adapters/useUiPluginRecommendations.ts`、`adapters/pluginUiStateKey.ts`）。

**变更性质**：新功能。

**上游动机**：`docs/plugin-ui-background-execution.md`（4128 字符：协议握手早于编辑器初始化完成、session 停止不代表插件没有内部工作，宿主不能从这两个状态推断插件何时可以停帧）。

**omz 现状**：**plugin-ui 整模块已被 fork 删除**（29 文件）。

**移植建议**：**不建议移植**（红线：能力已被砍）。
**工作量**：L（且无价值）。
**主要风险**：无。

---

### T14 · marketing-touch / gen-ui / feedback / highspeed 残留改动

**规模**：合计 23 文件（marketing-touch-contract 6 新增 +47/−3；onboarding/feedback/gen-ui/highspeed/login 12 文件 +198/−55）。

**变更性质**：新功能（marketing-touch-contract）/ 重构。

**omz 现状**：这四块能力**全部已被 fork 删除**（marketing-touch 11 文件、gen-ui 14 文件、feedback 25 文件、highspeed 17 文件）。上游新增的 `marketing-touch-contract/`（契约化骨架，5 文件）是为已删模块服务的。

**移植建议**：**不建议移植**（全部）。
**工作量**：—。
**主要风险**：无。

---

### T15 · web/src 主体重构（main.tsx）

**规模**：2 文件，**+506 / −915**（`packages/web/src/main.tsx` +502/−915；新增 `packages/web/src/styles.css` 4 行）。其中绝大部分是 T05 relay v2 的路由/登录/设备列表拆分。

**omz 现状**：omz 的 `packages/web/src/main.tsx` **308 行**（上游 v3.16.2 是 2107 行，上游 v3.15.1 是 ~700 行）。omz 的 web 端是一个「薄壳」：所有远程能力都返回 `not supported in Web mode yet`，没有登录、没有远控、没有分享落地页。

**移植建议**：**不建议移植**（除非要重做 Web 端产品）。
唯一可摘的是 `packages/web/src/styles.css`（4 行）与 `imports: { "#src/*": "./src/*" }` 的 package.json 字段（Node 子路径导入，供 `web-remote-control` 内部使用）——后者和 T05 绑定，一并不做。
**工作量**：L。
**主要风险**：omz web 端 `main.tsx` 里大量 `// TODO(web-remote-workspace)` 说明远端 Web 是**已知未完成**状态，整体重做会牵扯 web 端产品定位。

---

### T16 · `test-ids` 子路径导出迁移（横切机制，影响 120 文件）

**规模**：横切 ui/web 120 文件（其中 66 文件除 import 外零改动）。配套：`packages/shared/src/test-ids.ts` +60/−20、`packages/shared/src/test-ids-workflow.ts` +4；`packages/shared/package.json` 新增 `"./test-ids": "./src/test-ids.ts"`。

**变更性质**：架构机制（把 testid 常量从 shared 主入口拆到子路径，避免 UI 引入整个 shared barrel）。

**上游动机**：`packages/shared/package.json` exports 拆分；上游同时新增 `"./sqlite-migrations"`、`"./mcp-apps"`、`"./gen-ui"`、`"./request-security"`、`"./web-remote-relay"` 等子路径。

**omz 现状**：
- omz 的 `packages/shared/package.json` **没有** `"./test-ids"` 导出（现有 18 个 exports 无此项）。
- omz 的 `packages/shared/src/test-ids.ts` 731 行，与上游 v3.15.1 已分叉（fork Δ+55/−83，omz 删掉了 `TID_BROWSER_PERMISSION_*`、`TID_REMOTE_KIND_SERVER`、`TID_SERVER_*`、`TID_CHAT_COMPACT_*`（红线 3）、`TID_SETTINGS_MEMORY_SWITCH` 等，并新增了自己的）。
- 上游 v3.16.2 的 test-ids.ts **删掉了** `TID_WORKSPACE_OPEN_BUTTON` / `TID_WORKSPACE_LIST` / `TID_WORKSPACE_ITEM` / `TID_WORKSPACE_CLOSE` / `TID_CONVERSATION_NEW_TASK` / `TID_PROJECT_ADD`（旧侧栏），换成 `TID_VIRTUAL_PROJECT_ADD` / `TID_VIRTUAL_PROJECT_NEW_TASK` 等 —— **这是 T01 的下游，omz 不该跟**。

**移植建议**：**建议移植机制（可独立做）**，但**必须只搬 import 路径，不搬常量内容**。
- 具体做法：① 在 omz `packages/shared/package.json` 加 `"./test-ids": "./src/test-ids.ts"`；② 把 omz 自己的 `test-ids.ts` 保留不变，仅在 ui/web 里把 `import { TID_xxx, testId } from "@zcode/shared"` 改成 `from "@zcode/shared/test-ids"`。
- **绝对不做**：把上游的 test-ids.ts 内容覆盖到 omz（会丢掉 fork 自己的 `TID_CHAT_CONTEXT_USAGE_MAGIC_CONTEXT` 等）。
- **工作量**：**M < 2 天**（120 文件机械改 import + 跑 typecheck/lint/parity）。
- **主要风险**：
  1. 收益仅是「架构洁癖」，**功能价值为零** —— 建议**排在功能主题之后**，优先级低。
  2. omz 的 `packages/shared/src/index.ts` 是 barrel，若只加子路径导出而不动 index，`@zcode/shared` 仍可全量导入 → **迁移是半截**，要么做要么不做。
  3. 机械改 import 会产生巨大的 review 噪音（120 文件），与功能改动混在同一批提交里会让后续 bisect 变难。

---

### T17 · 其余低价值主题（速览，不建议单独动）

| 主题 | 规模 | 实质 | 建议 |
| --- | --- | --- | --- |
| project-workflow（工作流存档槽） | 5 文件 +109 | 从 `app-shell/` + `components/workflow-timeline/` + `hooks/` 三处搬进新模块 `project-workflow/` | **不建议**：omz 已删 `WorkflowRunPaneSaveSlots` 等；纯搬移 |
| components/mobile-ui（移动端品牌/底弹层） | 9 文件 +234 | `ZCodeAppLogo` / `DevicePlatformIcon` / `bottom-sheet`（Radix Dialog 封装） | **不建议**：唯一消费者是 relay v2 手机端（T05 已不做）；且 `ZCodeAppLogo` 命中红线 4 |
| remote/（Source Server 边界对话框） | 4 文件 +453 | `SourceServerBoundaryDialogContent` + `remoteWorkspaceController` + `remoteWorkspaceProjection` | **不建议**：依赖 source-server 主链 |
| conversation-workspace-target / workspace-config-catalog / workspace-plugin-preview | 25 文件 +700 | 三个契约化模块（把散在 ui 根的解析器收进 managed 模块） | **不建议**：依赖 T01；但**契约化模式本身值得在 omz 后续新模块中沿用** |
| composer-toolbar-layout | 4 文件 +35 | 把 `useComposerToolbarFit` 收成契约 | **可选**：低成本，omz 已有 `prompt-editor/useComposerToolbarFit.ts`，收成 module 契约可提升架构一致性（S） |
| workspace-file-tree | 4 文件 +195/−220 | 主要是格式化 + `FileManagerPane` 容器 | **不建议**：FileManagerPane 依赖 project-sidebar |
| browser-use | 7 文件 +26/−49 | 小改 | **不建议**（收益极低） |
| command-center / quickpick | 1 文件 +46/−38 | `CommandCenterDialog` 加远程错误格式化 + 分隔符查询 | **可选**（S）：与 T02 远程错误呈现相关，可搭车 |
| resource-manager | 6 文件 +13/−10 | 纯 import 路径改写 | **不单独动**（搭 T16 车） |
| onboarding / login | 3 文件 +5/−5 | `LoginApiKeyForm` 极小改 | **不移植**（omz 无该文件） |

---

## 2. 主题总表

| # | 主题 | 文件数 | ±行数 | 变更性质 | 上游动机（docs） | omz 现状 | 撞红线 | 移植建议 | 工作量 | 主要风险 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | project-sidebar 虚拟项目侧栏 | 73 | +10765/−207 | 新功能+重构 | `docs/superpowers/specs/2026-09-09-virtual-project-design.md`、`2026-09-11-archive-management.md`、`docs/ui/task-grouped-view.md` | 目录不存在；依赖 services 层 6 个新包（omz 全无） | — | **不建议**（需拍板，等于引入产品） | **L** | 数据模型不可逆；上游自身未收敛（10-19 遗留问题） |
| T02 | remote-connection 三屏向导 | 30 | +7009/−1601 | 新功能+重构 | `docs/issues/remote-connection-ux/{01,04,10}.md`、`docs/ui/ssh-config-alias.md` | 旧单体弹窗形态（SSHDialog 630 行）；flow 目录不存在；依赖 source-server | — | **需拍板**（档A UI 层缺陷修复可做 / 档B 全量） | S / **L** | omz 远程 identity 模型不同，硬套产生悬空态 |
| T03 | side-pane-full-view 面板全屏 | 13 | +1210/−0 | 新功能 | `docs/ui/side-pane-full-view.md` | 目录不存在；前置件齐备（sidePane/useAppPanels/tabStore/resizable） | — | **建议移植**（需先解耦 project-sidebar） | **M** | WorkspaceShellLayout omz 分叉 4057 行，接线冲突大 |
| T04 | conversation-share 分享交互 | 32 | +2433/−1373 | 新功能+重构 | `docs/conversation-share-v1.md` | 整条分享能力已删（v4/web 侧 0 文件） | 红线4（`zcode://share/import`） | **不建议** | L | 无（建议清理 20+ 死键） |
| T05 | web-remote-control relay v2 | 37 | +3136/−1363 | 新功能+依赖 | `docs/issues/web-remote-control-relay-v2/01-relay-v2-login-pairing.md` | packages/web 只剩 4 文件；无 auth、无 relay 服务端 | — | **不建议** | L | 无 |
| T06 | settings 设置页大改 | 75 | +5650/−2703 | 新功能+重构 | `docs/issues/remote-connection-ux/13-*.md`、`2026-09-11-archive-management.md` | 缺 6 个新文件；独有 MagicContext/MemoryManagement 页 | — | **分档**：小改可摘，SourceServer*/archives 不做 | S / L | 整体覆盖会抹掉 fork 自研页 |
| T07 | i18n locales | 3 | +1756/−395 | 文案 | 随主题 | omz zh 自维护；上游多 1273 键，omz 多 228 键 | 红线4（文案需去 ZCode） | **建议移植（合并而非覆盖）** | **M** | 整文件覆盖会丢轨迹面板中文文案 |
| T08 | ToolCallBlocks 工具展示解耦 | 25 | +700/−460 | 新功能+重构 | `docs/ui/tool-display-rendering.md` | 目录存在；无 ToolPresentation/presentationCapabilities | — | **建议移植**（缺陷修复子集） | S / M | resolveRenderer 分流顺序改变工具卡 family 归类 |
| T09 | chat-input-toolbar 模型+档位合并 | 10 | +844/−46 | 新功能+重构 | `docs/composer-model-thinking.md` | 缺 6 新文件；contextUsage 是 fork 自研含 Magic Context | **红线2（contextUsage 禁覆盖）** | **建议移植**（先做档位表外提） | S / **M** | contextUsage 整文件替换会摧毁 Magic Context 面板 |
| T10 | v4 会话区重构 | 65 | +3166/−2099 | 重构+依赖 | `docs/v4-refactor/06-ui.md`、`m5-composer-parity.md` | 分叉严重（SessionPane 2967 行）；依赖 T01/T03/T04 | — | **不建议整体移植**（随宿主主题反向挑） | M | 机械移植覆盖 fork 队列行/轨迹接线 |
| T11 | 基础 UI 组件缺陷修复 | 16 | +251/−135 | **缺陷修复** | —（代码内注释说明原因） | 5 个具体 bug 均仍在 omz | — | **建议移植（性价比最高）** | **S** | collapsible 动画改法影响所有折叠区观感 |
| T12 | mentions/prompt-editor 多根 mention | 8 | +368/−318 | 重构+依赖 | `docs/ui/mention-*.md` | 仍是单 workspace 根；无 projectService | — | **不建议**（除非引入虚拟项目） | L | mention id 变更 → 老草稿引用 chip 失效 |
| T13 | plugin-ui 后台执行 | 28 | +883/−77 | 新功能 | `docs/plugin-ui-background-execution.md` | **整模块已删**（29 文件） | — | **不建议** | L | 无 |
| T14 | marketing-touch / gen-ui / feedback / highspeed | 23 | +245/−58 | 新功能/重构 | `docs/marketing-touch-actions.md`、`docs/specs/gen-ui-styles.md` | **四块全部已删** | — | **不建议** | — | 无 |
| T15 | web/src main.tsx 重构 | 2 | +506/−915 | 重构+依赖 | relay v2 系列 | omz web main.tsx 308 行（薄壳，远端明确未完成） | — | **不建议** | L | 牵扯 web 端产品定位 |
| T16 | `test-ids` 子路径导出迁移 | 120（横切） | 主要为 import 改写 | 架构机制 | `packages/shared/package.json` exports 拆分 | shared 无 `./test-ids` 导出；test-ids.ts 已分叉 | 红线1/3（omz 已删的 TID 不能补回） | **建议移植机制**（功能价值为零，低优先级） | **M** | review 噪音；半截迁移；绝不能覆盖 omz test-ids.ts 内容 |
| T17 | 其余 9 个小主题 | ~40 | +500/−400 | 混合 | — | 多数依赖已删模块 | — | 见各条 | S–L | 低 |

---

## 3. 建议的落地顺序（若用户决定做一部分）

按「独立可验证 → 依赖链自下而上 → 机械清理」排序：

**第一梯队（S，风险最低，收益最直接）**
1. **T11 基础 UI 组件缺陷修复**（dialog i18n / collapsible 动画 / kbd 键帽 / dropdown indicator / tooltip alwaysDelay）—— 5 文件，零 fork 冲突，全是用户可感知的 bug。
2. **T09-步骤1 档位表外提**（`thoughtLevelLabels.ts`）—— 纯重构，omz 结构相同。
3. **T08 缺陷修复子集**（ToolCallBody 内嵌图片终态收口）—— omz 同样存在永久 loading 风险。
4. **T07 顺带清理** 20+ 条 `conversationShare.*` 死键 + omz locale 中残留的 `ZCode` 文案（红线 4）。

**第二梯队（M，依赖可控）**

5. **T03 side-pane-full-view**（需先解耦 project-sidebar 依赖）。
6. **T02-档A** SSH 三屏向导的纯 UI 缺陷修复（不含 source-server）。
7. **T09-步骤2** Composer 模型/档位合并入口。
8. **T07 locales 合并**（跟随上述主题逐条补 key）。

**第三梯队（M/L，需用户拍板或立项）**

9. **T16 test-ids 机制迁移**（功能价值为零，放最后，且单独成批）。
10. **T01 虚拟项目侧栏** —— 建议**独立立项**（含 services 层 project/project-storage/task-facts + shared sqlite-migrations + 协议），不混进 v3.16 同步。
11. **T02-档B / T06 SourceServer\* / T05 relay v2** —— 均依赖 source-server 主链，**统一需拍板**。

**明确不做**：T04（分享）、T05（web relay v2）、T13（plugin-ui）、T14（marketing/gen-ui/feedback/highspeed）、T15（web main.tsx）、T12（多根 mention，除非做 T01）。

---

## 4. 给上游同步管线的三条硬提示

1. **不要按「文件不存在 = 需要移植」做批量同步**。本区域上游 748 个变更文件里，至少 **256 个新增文件中有相当比例服务于 omz 已删能力**（plugin-ui / gen-ui / feedback / highspeed / marketing-touch / conversation-share / web-remote-control / telemetry）。整包搬运会立刻触发 import 解析失败与 knip 未使用导出告警。

2. **不要整文件覆盖 `packages/ui/src/i18n/locales/*.ts`**。上游多 1273 键、omz 多 228 键，且 omz 多出来的正是 fork 自研面板（轨迹面板 Magic Context、模型轨迹）的文案。必须键级合并，且合并时把上游文案里的 `ZCode` 改成 omz 形态。

3. **`packages/shared/package.json` 的 exports 是 ui/web 大部分改动的隐形前置**。上游把 `@zcode/shared` 拆成 15 个子路径（含 `./test-ids`、`./sqlite-migrations`、`./mcp-apps`、`./web-remote-relay`）。omz 若要跟任何用到这些子路径的上游改动，必须先在 omz 的 shared 里建对应子路径导出；否则这些文件在 omz 一行都跑不起来。本报告量化过依赖面：`sourceServerId`（52 文件）、`parseRemoteWorkspaceIdentity`（18）、`mcp-apps`（12）、`ConnectionProfile`（11）、`web-remote-relay`（9）、`gen-ui`（7）、`SourceServerRecord`（5）—— **这些符号 omz 的 shared 一个都没有**。
