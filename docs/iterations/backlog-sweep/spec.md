---
date: 2026-10-23
---

# backlog-sweep 技术规格（SPEC）

## 需求来源

用户口述（无 prd.md），两段指令合并：
1. 「存量都做了」——`docs/iterations/upstream-v316-fullsync/dev-ready.md` §5 挂账全清：zcode 侧栏骨架 6 区块 + P3 挂账（entries 表/resolveHost/legacySingleRoot/RemoteProjectPicker 挂载/ProjectCreation 设备面）+ P9 挂账（management 服务/registry/设置设备卡/设备设置跳转/deployServer 退役拍板）+ U5-U12 合流（`upstream-v3.16-backport` 分支头=1ff8cad9，U5-U12 从未提交，实为在 main 上实施幸存项，探索报告已实测确认）。
2. 四条 UI 优化：①输入框 skill/文件引用胶囊在重新编辑消息/队列撤回后丢胶囊 → 恒保持；②新建服务商无名称弹窗；③重命名改点击名字直接命名、失焦保存；④删「更多」菜单，删除改列表右侧按钮+二次确认。

用户已拍板（2026-10-23）：
- 侧栏与 P3：**整批真链 + 默认视角切 projects**（Picker 真链依赖服务层，不整批就是死 UI）。
- P9-3 设备卡：**「保持一致」＝按上游形态照搬**（用户确认设备卡=远程开发设备管理面）。向导面依赖按组件级单独搬（`RemoteConnectionProgress` 135L），登记为拍板 A 的组件级例外。
- 胶囊反解析：**所见即气泡，但用户手打的除外**——只有系统注入产生的链接形态 canonical 才转回胶囊；inline 裸 token（`@name`/`$slug`/`/cmd`/裸 `#sess_x`）在字符串上无法区分手打与注入，一律保持纯文本（与现逻辑一致）。
- 流程纪律（memory #131）：auto-dev-loop 禁用，用户手操编排；本 spec 落盘后每阶段等用户发令。

基线：main @ e5d465cd（v1.0.21+打包修复）；上游参照 `.reference/ZCode`（v3.16.2）。四份探索报告存 `cache/exploration-reports.md`（本目录）。

## 设计目标

1. 侧栏升级为 zcode v3.16 骨架形态（Navigation/Footer/Picker 真链可达），默认可见；商业/relay-v2 面按政策剔除并登记。
2. P3/P9 挂账全清：remote-projects 服务层落库（entries 表真 CRUD+迁移回填）、resolveHost 路由、legacySingleRoot 接线、management 服务+设备卡面板+跳转、deployServer 接线退役。
3. U5-U12 八项幸存修复全落（含 U10 side-pane 全屏，最后批次）。
4. 胶囊在「编辑历史消息/队列撤回/草稿回退」三入口反解析恢复（仅链接形态），队列撤回上下文 chip 一并恢复。
5. 服务商管理三交互自研（无上游形态）：名称弹窗、点击命名、右侧删除按钮。
6. 全门禁绿 + i18n 对称 + knip 基线联动登记。

## 总体方案

六个 phase 顺序执行，phase 间无硬依赖处已注明可并行；每个 phase 结束即门禁+可独立提交：

- **phase-sidebar-p3**：先服务层后 UI。`remote-projects/index.ts`（上游 381L 移植）→ `migrate-projects` 补 `migrateConnectionHosts`+entries 回填 → `node.ts` 接 `ownerHostId/resolveHost/createRemoteProjectService` → desktop host `resolveProjectHostService` + `remoteWorkspaceServiceCollection.resolveServerProjectService` + virtualProjects 分支 → UI 侧栏骨架重排（Navigation omz 化 + Footer banner 槽 + Picker 真链 Root/SSHDialog 契约改造）→ 默认视角切 projects。ProjectCreation 设备面先落 management 缺席降级分支（`directory.hosts` 生成 devices），P9 落地后自动升级。
- **phase-p9-management**：P9-1 服务骨架（channels/client getter/accessor/host 注册+359L+120L 移植）→ P9-2 registry（validation `source-settings` scope+detach 接线）→ P9-3 设备卡照搬（面板族 ~2400L+`RemoteConnectionProgress` 组件级搬运+i18n ~153×2）→ P9-4 跳转（settingsNavigation `remoteDevices` 段+SidebarNode action+`sourceServerUpdateNotifications` 335L）→ P9-5 deployServer 退役（只删接线保模块树；**desktop LEGACY 阀本轮保留一轮**，登记下轮删）。
- **phase-u-backports**：U5（dialog/collapsible/kbd）→ U6（图片失败态+图源）→ U7（端口校验+聚焦跟随挑 hunk+alias 守卫）→ U8（localUsageEvidence+`~/.omz`）→ U9（路由穿越修复+server 测试基建）→ U11（fileApplications）→ U12（角标 max+overlay+tray 红点）→ **U10 side-pane 全屏压轴**（13 文件 1223L 新增+8 大文件逐 hunk 融合）。
- **phase-pill-restore**：`mentionMarkdown.ts` 新增富反解析（保留 fullMatch 原文+destination+目的地白名单）→ `LexicalChatInput` 富装填 API（吸收 `setTextWithPluginMentions`）→ 替换 4 个 `setText` 调用点 → 队列行胶囊预览+撤回 chip 恢复。
- **phase-provider-ui**：名称弹窗（复用 6 孤儿 i18n 键+前端重名拦截）→ 点击命名（复用既有 blur-save/IME 机器）→ 删除按钮（详情卡标题栏右侧，SubagentsSection 同构）→ 更多菜单+死参数+死 TID 清理。
- **phase-gates**：全门禁+knip 新面登记+i18n verify+CHANGELOG/UPSTREAM-SYNC+QA 附录整理。

## 最终项目结构

新增文件（照搬面按 fork 纪律加头注释，max-lines 超限加豁免头）：

```
packages/services/src/remote-projects/index.ts            # 上游 381L 移植：hosts/entries CRUD+legacy 迁移
packages/services/src/onboarding/localUsageEvidence.ts     # U8：164L，品牌路径 ~/.omz
packages/ui/src/project-sidebar/ProjectSidebarNavigation.tsx # omz 化 ~50L（删 deviceNavigation/isWebRemoteControl）
packages/ui/src/side-pane-full-view/                       # U10：13 文件 1223L
packages/ui/src/settings/SourceServerManagementPanel.tsx   # P9-3：1740L
packages/ui/src/settings/SourceServerMigrationReportPanel.tsx # 160L
packages/ui/src/settings/SourceServerUpdateActivity.tsx    # 147L
packages/ui/src/remote-connection-flow/ui/RemoteConnectionProgress.tsx # 135L 组件级例外（拍板 A）
packages/ui/src/root/sourceServerUpdateNotifications.ts    # P9-4：335L
packages/ui/src/hooks/useSourceServerManagementSnapshot.ts # 93L
packages/ui/src/settings/{sourceServerManagementPresentation,settingsSourceWorkspace}.ts # 33L+113L
packages/ui/src/lib/{sourceServerManagementError,sourceServerUpdatePreferences,sourceServerUpdateAction}.ts # 14/75/53L
packages/desktop/src/host/sourceServerManagementService.ts # 359L
packages/desktop/src/host/sourceServerMigrationCounts.ts   # 120L
packages/desktop/src/main/fileApplications.ts              # U11：322L
packages/server/test/staticRoutePathContainment.test.ts    # U9 + tsconfig.test.json 新建
packages/ui/src/project-sidebar/useProjectFileTree.ts      # Q2 顺手补：100L+project-file-navigation 57L
```

关键修改（现状行数→预期）：`project-sidebar/index.tsx` 300→~380（豁免头预留）、`Root.tsx`+`SSHDialog.tsx`（Picker 真链契约）、`ProjectEditor.tsx` 472→+devices、`ProjectCreation.tsx` 100→~200（降级分支）、`WorkspaceSidebarFooter.tsx` +banner 槽、`WorkspaceShellLayout.tsx`（默认视角+onViewFiles props）、`node.ts`（createProjectService 三参+createRemoteProjectService）、`remoteWorkspaceServiceCollection.ts` 272→+resolveServerProjectService、`host/index.ts`（resolveHost 注入+management 注册+deployServer 接线删）、`server/src/http.ts`（路由删+U9 穿越）、`shared/validation.ts`（source-settings scope）、`SettingsPage.tsx`+`settingsPageConfig.ts`+`settingsNavigation.ts`（remoteDevices 段）、`mentionMarkdown.ts`+`LexicalChatInput.tsx`+`ChatPromptEditor.tsx`+`ConversationComposer.tsx`（胶囊）、`model-provider-section/`（ProviderCardSections/ProviderTemplatePicker/InlineEditableProviderCard/ModelProviderSection）、`shared/test-ids.ts`（U10 +14 TID、provider TID 退役+新增）、i18n 两 locale（~160 键新增）。

明确不做（登记政策依据）：`SidebarBottomActivity`/`global-notice/*`/`marketing-touch/*`/`useRewards`（商业面）；`HomeOnlyWorkspaceRows`+`useHomeOnlyWorkspaces`+`WebRemoteControlDeviceHeader`（relay v2 手机面）；`WorkspaceWebRemoteControlTrigger`（relay v1 已清零不复活）；`onAddDevice` 向导壳依赖（拍板 A，disable+登记）；U5 延后两项（dropdown indicator/tooltip alwaysDelay 维持延后）；`ChatRemoteFolderSelection`（远端会话目录选择，另批）。

## 变更点清单

| # | 面 | 变更 | 证据锚 |
|---|---|---|---|
| C1 | P3 服务 | remote-projects CRUD+迁移+node.ts 接线 | 上游 remote-projects/index.ts 381L；omz remoteProjectDirectoryService.ts:117-184 全抛 |
| C2 | P3 路由 | resolveHost+ownerHostId+projectStorageHostId | services/node.ts:2043-2057 注释自陈挂账 |
| C3 | P3 legacy | resolveServerProjectService+单根退回 | legacy-single-root.ts 在库零调用 |
| C4 | 侧栏骨架 | Navigation/Footer/banner 槽/重排/裸调用继承 | 上游 index.tsx:214/231/327-345；R8 |
| C5 | Picker 真链 | Root remoteProjectSelection+SSHDialog onSelectProject 新签名+ChatEmptyState | 上游 Root.tsx:1361/1388-1407/1424 |
| C6 | 默认视角 | readWorkspaceSidebarViewMode 缺省 classic→projects | WorkspaceShellLayout.tsx:195-208 |
| C7 | P9 服务 | management 16 方法+channels+accessor+host 注册 | 上游 sourceServerManagement.ts 3155B |
| C8 | P9 registry | source-settings scope+detach | shared/validation.ts omz:185-196 缺 |
| C9 | P9 设备卡 | 面板族照搬+remoteDevices 段+跳转+通知 | 上游 161 键 vs omz 8 键 |
| C10 | P9 退役 | 删 host/index.ts:1533/1553-1661/2804-2836+http.ts 路由；保模块树+阀一轮 | 上游 http.ts:450-451 同口径 |
| C11 | U5-U12 | 八项落点见探索报告 4.2 表 | spec 行号已全漂移，按报告现状行号 |
| C12 | 胶囊 | 富反解析+4 setText 点+队列预览+撤回 chip | ChatPromptEditor.tsx:207 等 |
| C13 | 服务商 | 弹窗/点击命名/右删按钮/TID 清理 | ProviderCardSections.tsx:120-174 |

## 详细实现步骤

- Step 1 — phase-sidebar-p3 — blocking: yes — qa: auto — 移植 `remote-projects/index.ts`（381L）+ `migrate-projects` 补 `migrateConnectionHosts()`（上游 :57-91）与 entries 回填 INSERT（上游 :126-133）+ `architecture-policy.yaml` publicEntrypoints 增 `index.ts`
- Step 2 — phase-sidebar-p3 — blocking: yes — qa: auto — `node.ts`：`createProjectService({ownerHostId, resolveHost})`+options 增 `projectStorageHostId`/`resolveProjectHostService`+`createRemoteProjectService`；desktop `host/index.ts` 提供 `resolveProjectHostService`（上游 :3864-3905）注入；`remoteWorkspaceServiceCollection.ts` 增 `resolveServerProjectService`+virtualProjects 两分支注册（上游 :122-174/:249-271）
- Step 3 — phase-sidebar-p3 — blocking: yes — qa: auto — UI 骨架：新建 `ProjectSidebarNavigation.tsx`（omz 化子集）；`WorkspaceSidebarFooter.tsx` +banner 槽；`index.tsx` 重排为上游序（nav→task-list-region→scroll→footer），保留既有 tripwire 行原文（P41 :191-204 / RemoteBackfill :52-65 / RemoteSeams :66-67 / VirtualProject :35-36），`start()` 改裸调用+分组继承（上游 :131-155），max-lines 豁免头
- Step 4 — phase-sidebar-p3 — blocking: yes — qa: auto — Picker 真链：`Root.tsx` 增 `remoteProjectSelection` 状态+挂载（上游 :1388-1407）；`SSHDialog.tsx` onSelectProject 契约换新签名（:48/:372）；`RemoteProjectPicker.tsx` 回填 host/initialRoots 透传；`ProjectEditor.tsx` +devices/deviceLabel；`ProjectCreation.tsx` 设备面降级分支（上游 :98-114）+`onAddDevice` disable 登记拍板 A
- Step 5 — phase-sidebar-p3 — blocking: yes — qa: auto — **移除 classic/projects 双视角机制**（用户裁定 2026-10-23：上游 zcode 无此切换——`sidebar-view-mode`/`sidebarViewMode` 在 .reference/ZCode 全仓 0 命中，属 omz fork 自创，「没有就不做」）：删 `WorkspaceShellLayout` 的 `sidebarViewMode` 状态+持久化键+两个切换钮，上游骨架 `ProjectSidebar` 成为唯一侧栏；omz 老侧栏 `WorkspaceSidebar.tsx`（1626L）从壳层摘除前先盘点其独有功能面（对照清单落入实现批），零独有则整 retire，有独有则按缝位融进骨架；`useProjectFileTree`+`project-file-navigation` 顺手补+`onViewFiles` 接通（WorkspaceShellLayout 补 onOpenFileManager/fileTreeOpenRequest/activePreviewPath 三 props）
- Step 6 — phase-sidebar-p3 — blocking: yes — qa: auto — `RemoteProjectList.tsx` legacySingleRoot 分支回填；phase 门禁（tsc/lint/oxfmt/T-VS+T-SB 套件+knip 新文件登记）
- Step 7 — phase-p9-management — blocking: yes — qa: auto — P9-1：`channels.ts` 增 SourceServerManagement+client getter+accessor 字段+`sourceServerManagementService.ts`(359L)+`sourceServerMigrationCounts.ts`(120L)+host 注册（上游 host/index.ts:4028-4056）
- Step 8 — phase-p9-management — blocking: yes — qa: auto — P9-2：`shared/validation.ts` scope 加 source-settings+remote.sourceServerId；`windowHostAttachmentRegistry.ts` +detach+守卫；host 删前回调接线（上游 :4038-4054）
- Step 9 — phase-p9-management — blocking: yes — qa: auto — P9-3：面板族 9 文件照搬+`RemoteConnectionProgress.tsx` 组件级搬运（登记拍板 A 例外）+`settingsPageConfig` remoteDevices 段+`SettingsPage` 接线+i18n ~153×2（键级插入 en/zh 同批）
- Step 10 — phase-p9-management — blocking: yes — qa: auto — P9-4：`settingsNavigation.ts` remoteDevices 段+intent 键+`ProjectSidebarNode.tsx:74` action 注入+`Root.tsx`+`sourceServerUpdateNotifications.ts`(335L)
- Step 11 — phase-p9-management — blocking: no — qa: auto — P9-5：删 host/index.ts 闸门+旧分支+setupRemoteConnection+server/http.ts 路由接线；保留 `server/src/remote/**` 模块树与 `./remote` 导出；**LEGACY 阀保留一轮**（登记下轮删，CHANGELOG 标注）
- Step 12 — phase-u-backports — blocking: yes — qa: auto — U5：dialog.tsx DialogCloseText（155→165L）；collapsible.tsx 去组名改 `data-[state=open]:[&>div]:animate-in`（fork 注释融合）；kbd.tsx 复用 ControlShortcutBadge
- Step 13 — phase-u-backports — blocking: yes — qa: auto — U6：ToolCallBody.tsx:135-158 失败态 try/catch+path 变更清态（omz 口径：previewFailed 主路径，previewUnavailable 不可达登记）；cuaScreenshotDetails.ts:67 +sharedImageSrc；nodeReplImageGrid.tsx:27 +image.src 优先
- Step 14 — phase-u-backports — blocking: yes — qa: auto — U7：remoteConnectionWizard.ts 挑 isInvalidPort+collectRemoteFormFieldErrors hunk；RemoteConnectionFields.tsx 只挑 autoFocus/focusCredentials/focusField hunk（上游重写版不整搬）；useRemoteConnectionForm.ts:211-221 +loaded&&!error 守卫
- Step 15 — phase-u-backports — blocking: yes — qa: auto — U8：localUsageEvidence.ts(164L,`~/.omz`)+node.ts:1310-1320 改 includeDeleted:true（行号已漂移自 spec 旧值）
- Step 16 — phase-u-backports — blocking: yes — qa: auto — U9：http.ts:246-249 +isAbsolute 判定+isPathDriveQualified+盘符前置 404；新建 packages/server/test/+tsconfig.test.json+根 typecheck 工程表+test:v4-perf 登记
- Step 17 — phase-u-backports — blocking: yes — qa: auto — U11：fileApplications.ts(322L)+openWithFileApplication.ts 拆件+editors.ts/openInEditor.ts/platform 链+OpenSplitButton path+PreviewPane 序号守卫
- Step 18 — phase-u-backports — blocking: yes — qa: auto — U12：unreadBadge.ts sum→max+overlay（36→~330L）+desktopWindowLifecycle 多窗口+desktopTray 红点+chromeState 常量导出；T-D4 锁 sum→max 语义
- Step 19 — phase-u-backports — blocking: yes — qa: auto — U10 side-pane 全屏压轴：side-pane-full-view 13 文件+8 大文件逐 hunk 融合（SessionPane/WorkspaceShellLayout/ConversationTimeline/V4WorkspaceChatArea/WorkbenchPane/AnimatedSidePanePanel/App/types）+useComposerToolbarFit 叠加在 P1 已落分支之上+conversationTimelineLiveTail+47+shortcutCommands+1+test-ids+14+i18n +1 键（toggleSidePaneFullView）
- Step 20 — phase-pill-restore — blocking: yes — qa: auto — `mentionMarkdown.ts` 富反解析：产出 {category,label,value,markdown(=fullMatch 原文),data}；目的地白名单 plugin:///#sess_/./..// /盘符；inline 裸 token 不转（用户拍板）；代码块 fence 跳过策略
- Step 21 — phase-pill-restore — blocking: yes — qa: auto — `LexicalChatInput` 富装填 API（吸收 replaceEditorTextWithPluginMentions，对齐 replaceEditorText 段落切分+selectEnd）；替换 4 个 setText 点：ChatPromptEditor.tsx:207（编辑历史）、ConversationComposer.tsx:330（队列撤回）、:222（草稿 editorState 回退）、:273（外部预填）
- Step 22 — phase-pill-restore — blocking: no — qa: auto — 队列行胶囊预览（ConversationQueueRow.tsx:119-124 改富解析渲染）+队列撤回上下文 chip 恢复（restore 链接 parseComposerPromptContexts，与编辑历史路径对称）；tripwire 同步更新（composerHeldQueueGuard.test.ts:42-54）
- Step 23 — phase-provider-ui — blocking: yes — qa: auto — 新建名称弹窗：选择模板/自定义→弹窗（预填模板名/「新供应商」）→前端必填+重名拦截（文案与重命名一致）→创建；复用 6 孤儿键（zh:2554-2559/en:2735-2741）；失败复用 templateCreateFailed 横幅
- Step 24 — phase-provider-ui — blocking: yes — qa: auto — 点击命名：名字改 button 可点进入命名态（复用 handleStartEditName/handleNameBlur/resolveProviderNameEditKeyAction IME 机器）；单次 onClick 语义防双击；nameConfirmed 闸门不动
- Step 25 — phase-provider-ui — blocking: yes — qa: auto — 删除按钮：详情卡标题栏右侧 Trash2 icon-sm（SubagentsSection.tsx:567-580 同构，留在卡片子树保 deleteRequestedRef 守卫）+confirmVariant destructive+仅 onDelete 存在时渲染+family 死守卫清理；更多菜单整删+DropdownMenu/Pencil/MoreHorizontal import+actionsVisible/secondaryActionsVisible 死参数+TID_MODEL_PROVIDER_NAME_EDIT_BUTTON 退役+新 TID（名称触发/删除按钮/弹窗）
- Step 26 — phase-gates — blocking: yes — qa: auto — 全门禁：root typecheck（+server test 工程）/lint 零新增/oxfmt 触碰面/knip 终态基线联动（新文件消费方登记）/i18n --verify 对称/test:v4-perf 全量/cli-backport
- Step 27 — phase-gates — blocking: yes — qa: manual_user — CHANGELOG 未发布段+UPSTREAM-SYNC 基线注记+QA 附录成文（见测试策略）

## 测试策略

形态沿用现状两种：纯逻辑/源码形状守卫（projectSidebarP42 同款）挂 `test:v4-perf` tsx 段；desktop 面用既有 node --test。新增 server 测试工程（U9）。真机交互一律 manual_user 合并后用户验收，不阻塞自动门禁。

### 测试用例

- T-RP1 — blocking: yes — remote-projects CRUD 单测：hosts/entries 增删改查+legacy single-root 迁移判重+initial_position（Step 1）
- T-RP2 — blocking: yes — migrateConnectionHosts 回填：legacy connectionProfiles→hosts 行+entries INSERT（Step 1）
- T-RP3 — blocking: yes — resolveHost 路由：hostId 不符时 resolveHost 在/不在的两态（project.host-offline 抛出）（Step 2）
- T-SB1 — blocking: yes — 骨架形状守卫：nav/footer/banner 槽在位+relay v1 零残留+无 HomeOnly/SidebarBottom 引用（Step 3）
- T-SB2 — blocking: yes — 既有 5 个侧栏 tripwire 套件全绿（P41/P42/RemoteBackfill/RemoteSeams/VirtualProject）（Step 3-6）
- T-SB3 — blocking: yes — 双视角移除守卫：`sidebarViewMode`/切换钮/持久化键全仓 0 残留+WorkspaceSidebar 摘除后零悬空引用（Step 5）
- T-SB4 — blocking: yes — Picker 真链纯逻辑：SSHDialog onSelectProject→remoteProjectSelection→picker props 装配（源码形状）（Step 4）
- T-MG1 — blocking: yes — management 服务单测：16 方法注册+删前回调 detach 时序（Step 7-8）
- T-MG2 — blocking: yes — validation scope：source-settings schema 两分支+remote.sourceServerId（Step 8）
- T-UF1 — blocking: yes — U5/U6/U7 定点：collapsible 动画类形状+失败态分支存在+isInvalidPort 边界（含 0/65536/NaN）（Step 12-14）
- T-UF2 — blocking: yes — U8 品牌：localUsageEvidence 路径断言 `~/.omz`+includeDeleted 生效（Step 15）
- T-UF3 — blocking: yes — U9 穿越：相对路径/盘符/绝对路径逃逸 404 用例（新 server 测试工程首用例）（Step 16）
- T-UF4 — blocking: yes — U12 sum→max：多窗口同值不翻倍（Step 18）
- T-UF5 — blocking: yes — U10 全屏：isFloatingPresentation/fullViewSlot 双投影纯逻辑+shortcutCommands 注册（Step 19）
- T-PR1 — blocking: yes — 反解析纯函数：链接形态全类往返恒等（getMarkdown()==输入子串）+转义+目录尾斜杠+白名单外 URL 不转+代码块跳过+inline 裸 token 不转（Step 20）
- T-PR2 — blocking: yes — 4 个 setText 点形状守卫：富 API 调用在位+旧 setText 不再用于装填路径（Step 21）
- T-PR3 — blocking: yes — tripwire 同步：composerHeldQueueGuard 更新后绿（Step 22）
- T-PV1 — blocking: yes — resolveCreateProviderName 校验：空/空白/重名拦截+模板预填（Step 23）
- T-PV2 — blocking: yes — canDeleteProvider+名称提交归一化纯逻辑+更多菜单零残形状守卫（Step 25）
- T-GT1 — blocking: yes — 全门禁聚合绿（Step 26）
- T-QA1 — blocking: no — qa: manual_user — 侧栏真机：默认 projects 视角/项目树/分组拖拽/未读/SSH 选目录→Picker→保存→列表出现/onViewFiles
- T-QA2 — blocking: no — qa: manual_user — 设备卡真机：remoteDevices 段渲染/管理删除迁移报告/侧栏节点跳转/LEGACY 阀=1 回旧链冒烟
- T-QA3 — blocking: no — qa: manual_user — 胶囊真机：编辑历史消息胶囊保持+重发字节不变/队列撤回胶囊+chip 恢复/刷新草稿保胶囊/手打 @xxx 保持文本
- T-QA4 — blocking: no — qa: manual_user — U10 真机：全屏快捷键/floating 链/轨迹 tab 不受 visible 闸门影响（omz 特有坑）
- T-QA5 — blocking: no — qa: manual_user — 服务商真机：三交互+重名提示+删除确认+窄栏折叠
- T-QA6 — blocking: no — qa: manual_user — U5/U6/U12 观感：嵌套淡出/图片失败态/角标不翻倍+tray 红点

## 风险与回滚方案

| 风险 | 缓解 | 回滚 |
|---|---|---|
| R1 侧栏 tripwire 碎（5 套字面量断言） | 重排保持断言行原文，只外围插入 | phase 独立 commit revert |
| R2 Picker 真链点必败（服务层缺） | Step 1-2 先行服务层，Step 4 才挂 UI | 分步提交天然回滚 |
| R3 max-lines：index 380/400 | 豁免头预留（fork 先例） | — |
| R4 P9-3 上游面板依赖向导面 | 仅搬 RemoteConnectionProgress 135L 组件（登记例外）；面板不搬 wizard 壳 | 组件独立可 revert |
| R5 deployServer 删接线断 daemon | 只删 host 旧分支+server 路由；transportAdapter 等 daemon 复用模块零触碰；T-QA2 LEGACY 阀冒烟 | LEGACY 阀本轮保留即回滚阀 |
| R6 U10 大文件融合（8 文件 2-6k 行） | 压轴独立批次+逐 hunk+T-UF5+T-QA4 | 独立 commit revert |
| R7 胶囊误伤正文链接/代码块 | 白名单+fence 跳过+T-PR1 边界用例 | 富 API 独立函数可降级回 setText |
| R8 provider 交互与上游同构文件成为同步热点 | 登记为 fork 差异点（交互载体非业务逻辑） | — |
| R9 i18n 键重复插入破坏 --verify | 键级插入脚本幂等；P9 153 键先 diff 上游再插 | — |
| R10 队列/编辑双链改动碰 v1.0.21 bug A/B 修复面 | T-PR2/T-PR3 tripwire + routing 套件复跑 | 分步 revert |

回滚总案：每 phase 独立 commit 链（预计 30-40 commits），单 phase 可 revert；发版按用户指令走 omz-publish，含打包启动冒烟门禁（smoke:desktop+verify:bundle-imports 为 v1.0.21 后常驻）。

## 拍板遗留（默认已定，可推翻）

1. deployServer desktop LEGACY 阀：本轮保留一轮，下轮删（探索报告建议；用户未显式拍）。
2. 上游 footer banner 槽留空（SidebarBottomActivity 剔除后无内容注入）。
3. nav 与 ProjectSections 新建入口并存（上游形态保持）。
4. 队列行胶囊预览纳入本轮（Step 22，探索报告标可选）。
