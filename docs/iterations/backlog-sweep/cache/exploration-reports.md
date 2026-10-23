# backlog-sweep 探索报告（四份，2026-10-23）

> 来源：本轮 spec 撰写前派发的四个 readonly 探索子代理（E1 侧栏 6 区块 / E2 P9 挂账+U5-U12 / E3 胶囊修复 / E4 服务商 UI）。本文件是落盘浓缩版：范围、关键落点（file:line 为探索时点基线，行号漂移以现状文件为准）、结论与不搬面。C11 引用的「4.2 表」在本文 §4.2。

---

## 1. E1 侧栏 6 区块探索

**范围**：`.reference/ZCode/packages/ui/src/project-sidebar/` 与 `WorkspaceShellLayout` 的差异面。

**结论**：
1. 6 区块中仅 **Navigation + Footer banner 槽** 属低成本可达；`SidebarBottomActivity`/`HomeOnlyWorkspaceRows`+`useHomeOnlyWorkspaces`/`WebRemoteControlDeviceHeader`/`marketing-touch/*` 属商业或 relay-v2 面，按政策剔除。
2. `RemoteProjectPicker` 的真链**不在侧栏内部**（上游侧栏里的挂载是死代码）：真链 = `SSHDialog` 选目录 → `onSelectProject` → `Root.tsx` 的 `remoteProjectSelection` → `RemoteProjectPicker` → `ProjectEditor`，且依赖 P3 服务层（entries 表/resolveHost）——不整批做就是「点了必失败」的死 UI。
3. **关键坑**：omz `WorkspaceShellLayout.tsx:193-208` 默认 `sidebarViewMode="classic"`，骨架搬了用户也看不见。用户裁定（2026-10-23）：上游 zcode 无 classic/projects 切换（`sidebar-view-mode`/`sidebarViewMode` 在 .reference/ZCode 全仓 0 命中，属 omz fork 自创）→ **整个移除切换机制**，`ProjectSidebar` 为唯一侧栏（spec Step 5）。
4. omz 老侧栏 `WorkspaceSidebar.tsx`（1676L）独有面：workspace tab 列表 / `WorkspaceDragOverlay`(:182) 拖拽 / `WorkspaceSidebarCollapsedRail` 折叠栏 / `WorkspaceNewTaskTooltip`(:140)。归宿见 spec Step 5（上游 alias 形态 + 独有面缝位融合）。

**组件落点**：`ProjectSidebarNavigation.tsx`（上游 62L，omz 化删 deviceNavigation/isWebRemoteControl）；`WorkspaceSidebarFooter.tsx` banner 槽留空（SidebarBottomActivity 剔除后无内容注入，拍板遗留 2）。

---

## 2. E2 P9 挂账 + U5-U12 探索

### 2.1 P9 五件套

| 件 | 上游锚 | omz 现状 | 结论 |
|---|---|---|---|
| P9-1 management 服务 | `services/src/source-server-management/sourceServerManagement.ts`（**17 方法 + 2 事件** `onDidChangeState`/`onDidChangeDirectory`）；desktop `host/sourceServerManagementService.ts` 359L + `sourceServerMigrationCounts.ts` 120L；host 注册 上游 `host/index.ts:4028-4056` | 无 | 照搬 |
| P9-2 registry | `shared/validation.ts` 上游 :615-622 有 `source-settings` scope + `remote.sourceServerId`；`windowHostAttachmentRegistry` detach | omz `validation.ts:184-195` 缺两分支 | 补 |
| P9-3 设备卡 | `SourceServerManagementPanel.tsx` 1740L + `SourceServerMigrationReportPanel` 160L + `SourceServerUpdateActivity` 147L + hooks/lib 5 文件；i18n 上游面板族 ~161 键 vs omz 8 键 | 无 | 照搬（用户拍板），**例外范围见 spec Step 9 修订** |
| P9-4 跳转 | `settingsNavigation.ts` remoteDevices 段 + `sourceServerUpdateNotifications.ts` 335L（`:8` import `findSourceServerUpgradeProfileId` from `@/lib/remoteConnectionWizard`——omz 无此导出，须并入 Step 10/14） | 无 | 补 |
| P9-5 退役 | 上游 `http.ts:446-449`「两入口一起不可达」注释 | omz `host/index.ts:1533` LEGACY 阀 + :1553-1661 旧分支 + :2804 `setupRemoteConnection`；`server/src/http.ts:348` `/api/connect-remote`（仓内零调用）+ `:418` `/ws/remote/:id`（`web/src/main.tsx:203` 消费） | **阀=闸门不可拆**：本轮只删 server 侧 web 面路由 + web 消费点；host 闸门/旧分支/阀保留一轮（回滚阀成立，T-QA2 可执行），登记下轮删 |

### 2.2 U5-U12 落点表（C11 引用的 4.2 表）

基线：`upstream-v3.16-backport` 分支头=1ff8cad9（U5-U12 从未提交，实为在 main 上实施幸存项）。omz 现状行号为探索时点值。

| 项 | 上游落点 | omz 落点（现状） | 挑哪些 hunk / 不搬 |
|---|---|---|---|
| **U5** | `ui/src/components/ui/dialog.tsx` 155→165L `DialogCloseText`；`collapsible.tsx` 动画改 `data-[state=open]:[&>div]:animate-in`（去组名）；`kbd.tsx` 复用 `ControlShortcutBadge` | `dialog.tsx` 154L 无 DialogCloseText；`collapsible.tsx` 组名形态；`kbd.tsx` 独立实现 | 全挑；collapsible 融合 fork 注释；dropdown indicator/tooltip alwaysDelay 两项**不搬**（维持延后） |
| **U6** | `ToolCallBody.tsx:135-158` 失败态 try/catch + path 变更清态；`cuaScreenshotDetails.ts:67` +sharedImageSrc；`nodeReplImageGrid.tsx:27` +image.src 优先 | `ToolCallBody.tsx:135-158` 无 catch | 全挑（omz 口径：previewFailed 主路径，previewUnavailable 不可达登记） |
| **U7** | `remoteConnectionWizard.ts` `isInvalidPort`+`collectRemoteFormFieldErrors`；`RemoteConnectionFields.tsx` autoFocus/focusCredentials/focusField；`useRemoteConnectionForm.ts` 上游 :240-261 loaded&&!error 守卫（spec 旧行号 211-221 已漂移） | 同文件族在库，缺上述 hunk | 只挑函数/hunk，**上游重写版不整搬**；`findSourceServerUpgradeProfileId` 在此并入 |
| **U8** | `onboarding/localUsageEvidence.ts` 164L（品牌路径 `~/.zcode`→`~/.omz`）；`node.ts` includeDeleted:true | 无该文件；`node.ts:1316` 为 `listTaskMetas({})` | 全挑+品牌改写 |
| **U9** | `server/src/http.ts:245-248` `isInsideDirectory` → isAbsolute+isPathDriveQualified+盘符前置 404；上游 `packages/server/test/` 基建 | `http.ts:245-248` 为 `isInsideDirectory`；无 server test 工程 | 全挑+新建 tsconfig.test.json+根 typecheck 工程表+test:v4-perf 登记 |
| **U11** | `desktop/src/main/fileApplications.ts` 322L（omz 无）+ `openWithFileApplication.ts` 拆件 + `editors.ts`/`openInEditor.ts`/platform 链 + `OpenSplitButton` path + `PreviewPane` 序号守卫 | 无 fileApplications.ts | 全挑；平台差异按 omz 三平台口径 |
| **U12** | `unreadBadge.ts` sum→max（上游 overlay 36→~330L）+ `desktopWindowLifecycle` 多窗口 + `desktopTray` 红点 + `chromeState` 常量导出 | `unreadBadge.ts` 35L 确为 sum；tray 为红点渲染器（数字渲染器无生产调用） | 全挑；T-D4 锁 sum→max 语义 |
| **U10** | `ui/src/side-pane-full-view/` 13 文件 1223L + 8 大文件逐 hunk（SessionPane/WorkspaceShellLayout/ConversationTimeline/V4WorkspaceChatArea/WorkbenchPane/AnimatedSidePanePanel/App/types）+ `useComposerToolbarFit` 叠加 + conversationTimelineLiveTail+47 + shortcutCommands+1 + test-ids+14 + i18n+1 | 无 side-pane-full-view；`useComposerToolbarFit` 已于 C1（v1.0.21）落地 | 全挑，**压轴批次**（最大融合面，独立 commit 链） |

---

## 3. E3 胶囊修复探索

**问题**：编辑历史消息/队列撤回/草稿回退后，输入框里系统注入的 skill/文件引用胶囊退化为纯文本。

**结论**：
1. 上游同样有此缺口，**无可搬形态**——须自研 markdown→胶囊反解析。
2. 修复面 = 4 个 `setText` 入口：`ChatPromptEditor.tsx:207`（编辑历史）、`ConversationComposer.tsx:330`（队列撤回）、`:222`（草稿 editorState 回退）、`:273`（外部预填）。不动协议。
3. 用户拍板（2026-10-23）：**所见即气泡，但用户手打的除外**——只有系统注入的链接形态 canonical（`plugin://`/`#sess_`/`./`/`../`/`/`/盘符）转回胶囊；inline 裸 token（`@name`/`$slug`/`/cmd`/裸 `#sess_x`）字符串上无法区分手打与注入，一律保持纯文本（与现逻辑一致）。
4. 队列行预览 `ConversationQueueRow.tsx:119-124` 一并改富解析渲染；撤回上下文 chip 恢复（`parseComposerPromptContexts` 对称）。

---

## 4. E4 服务商 UI 探索

**结论**：三条交互在 omz 与上游 `ProviderCardSections.tsx`/`ProviderTemplatePicker.tsx` **逐字相同（仅 import 路径差）——无上游可搬形态，须自研**。

| 交互 | 现状 | 改造 |
|---|---|---|
| 新建名称弹窗 | `ProviderTemplatePicker` custom 路径固定传「新供应商」、模板路径传模板名，无名称输入 | 选择后弹窗（预填模板名/「新供应商」）→ 必填+重名拦截（文案与重命名一致）→ 创建；复用 6 孤儿 i18n 键（zh:2554-2559 / en:2735-2741，src 内零引用）；`TID_MODEL_PROVIDER_NAME_EDIT_BUTTON`(test-ids.ts:463) 退役+新 TID |
| 点击命名 | 重命名在「更多」菜单 → `handleStartEditName`/`handleNameBlur`/IME 机器 | 名字改 button 可点进入命名态（复用既有 blur-save/IME 机器），单次 onClick 防双击 |
| 删除按钮 | 「更多」菜单内 | 详情卡标题栏右侧 Trash2 icon-sm（`SubagentsSection.tsx:567-580` 同构，留卡片子树保 `deleteRequestedRef` 守卫）+confirmVariant destructive+仅 onDelete 存在时渲染；更多菜单整删+死参数清理 |

服务层支撑已核验：`createPersonalProvider` 支持 providerName 入参、重名抛「Provider 名称已存在」、`nextPersonalProviderLabel` 自动加序号（services 层无需改）。

---

## 5. 已验证锚点（首轮审查 2026-10-23 逐条落到代码，供后续轮免重查）

- `services/node.ts:2043-2057` 挂账注释原文在位；`createProjectService` 已支持 `ownerHostId`/`resolveHost`（`services/src/project/index.ts:78-87`）；上游 `node.ts:2167-2182` 接法可照搬；`getOrganizationDatabase()` 在 `taskIndexRepo.ts:590` 已有。
- `legacy-single-root.ts` 在库零调用（仅 `project/index.ts:9` 导出）。
- `WorkspaceShellLayout.tsx:193-208` 默认 `"classic"`；上游 `WorkspaceSidebar.tsx` 仅 3 行 alias。
- `shared/validation.ts:184-195` 缺 `source-settings` 分支；上游 :615-622 有。
- `host/index.ts` 2836L，:1533 阀、:2804 `setupRemoteConnection` 对得上；上游 `http.ts:446-449` 注释在位。
- `ProviderCardSections.tsx:120-174`、`SubagentsSection.tsx:567-578`、`TID_MODEL_PROVIDER_NAME_EDIT_BUTTON`(test-ids.ts:463)、6 孤儿键 zh:2554-2559/en:2735-2741 全命中。
- `dialog.tsx` 154L 无 `DialogCloseText`；`ToolCallBody.tsx:135-158` 无 catch；`server/src/http.ts:245-248` 为 `isInsideDirectory`；`unreadBadge.ts` 35L 确为 sum；`node.ts:1316` 确为 `listTaskMetas({})`；`side-pane-full-view` 上游 13 文件 1223L；`fileApplications.ts` 上游 321L 且 omz 无。
- `ChatPromptEditor.tsx:207`、`ConversationComposer.tsx:222/273/330`、`ConversationQueueRow.tsx:119-124`、`composerHeldQueueGuard.test.ts:42-54` 全部命中。
- `test:v4-perf` 在根 package.json；`.oxlintrc.json` `ignorePatterns` 含 `apps/zcode-cli`（根 lint 门禁不含 apps，apps 格式化用工作区自身 oxfmt）。
