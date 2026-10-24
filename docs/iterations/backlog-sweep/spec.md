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
- P9-3 设备卡：**「保持一致」＝按上游形态照搬**（用户确认设备卡=远程开发设备管理面）。向导面依赖按组件级单独搬（`RemoteConnectionProgress` 134L+`sourceServerStatusRegistry` 72L），登记为拍板 A 的组件级例外。
- 胶囊反解析：**所见即气泡，但用户手打的除外**——只有系统注入产生的链接形态 canonical 才转回胶囊；inline 裸 token（`@name`/`$slug`/`/cmd`/裸 `#sess_x`）在字符串上无法区分手打与注入，一律保持纯文本（与现逻辑一致）。
- 流程纪律（memory #131）：auto-dev-loop 禁用，用户手操编排；本 spec 落盘后每阶段等用户发令。

基线：main @ e3cba951（v1.0.22，含幽灵消息/并发轮两 P0 修复）；上游参照 `.reference/ZCode`（v3.16.2）。四份探索报告存 `cache/exploration-reports.md`（本目录，含 C11 引用的 4.2 U5-U12 落点表）。

## 数据所有者裁定（P0-3，2026-10-23 定）

P7 末批（拍板 B）遗留的 `packages/desktop/src/host/remoteProjectDirectoryService.ts`（185L，`readDirectory` 返回空、`saveHost`/`removeHost`/`addEntry` 全抛 `remote-project.entry-persistence-unavailable`）与本轮 entries 真链冲突，裁定：

1. **项目入口持久化（hosts/entries）唯一写入者 = SQLite `createRemoteProjectService`**（Step 1-2）。`remoteProjectDirectoryService.ts` 及其注册（`host/index.ts:2743-2755`）与测试（`packages/desktop/test/remoteProjectDirectoryService.test.ts`，在 test:v4-perf desktop 段）**本轮删除**，不降级保留。
2. **设备行与连接态的权威拆开（r5 P2-7）**：设备行=`hosts` 表投影（SQLite，UI `devices` 由 `directory.hosts`/hosts 行映射）；连接态/重连事件来自 `SourceServerDirectory` 与 connection manager 事件（不是 SQLite 字段）。
3. **`membershipId` 语义（P1-2 修正）**：`host_id` 由 `remoteProjectHostIdForProfile`/`remoteProjectHostIdForTarget`（`connection-membership.ts:11-25`）派生；`membership_id` 沿用上游 `randomUUID()` 不透明令牌（`index.ts:176/225`，不改写——它承载 `addEntry` 的 `expectedMembershipId` 陈旧守卫 `:293-298` 与 Picker `key={membershipId}` 换代重挂）；身份换代错误码=`remote-project.source-identity-changed`（`index.ts:202`）。
4. **settings 投影本轮不移植**（`setWorkspaceProjection` 不搬）：远程 workspace 恢复链仍读 settings（`useRemoteWorkspaceHistory.ts:966`），entries 只喂侧栏项目列表。后果登记：settings 与 entries 可能出现短暂不一致（如在新机器添加条目后 settings 未同步），验收口径=T-QA1 真机覆盖「选目录→保存→列表出现→重启后仍在」。后续轮次若要单一权威，移植 `projectWorkspaceSettings`。

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
- **phase-u-backports**：U5（dialog/collapsible/kbd）→ U6（图片失败态+图源）→ U7（端口校验+聚焦跟随挑 hunk+alias 守卫）→ U8（localUsageEvidence+`~/.omz`）→ U9（路由穿越修复+server 测试基建）→ U11（fileApplications）→ U12（角标 max+overlay+tray 红点）→ **U10 side-pane 全屏压轴**（13 文件 1210L 新增+8 大文件逐 hunk 融合）。Step 12-18 中文件名省略目录，实际路径以 `cache/exploration-reports.md` §2.2 与现状 import 为准（dialog/collapsible/kbd 在 `ui/src/components/ui/`、ToolCallBody 在 `ui/src/components/ToolCallBlocks/`、unreadBadge 在 `desktop/src/main/`、remoteConnectionWizard 在 `ui/src/lib/`、RemoteConnectionFields 在 `ui/src/` 根）。
- **phase-pill-restore**：`mentionMarkdown.ts` 新增富反解析（保留 fullMatch 原文+destination+目的地白名单）→ `LexicalChatInput` 富装填 API（吸收 `setTextWithPluginMentions`）→ 替换 5 个 `setText` 调用点 → 队列行胶囊预览+撤回 chip 恢复。
- **phase-provider-ui**：名称弹窗（复用 6 孤儿 i18n 键+前端重名拦截）→ 点击命名（复用既有 blur-save/IME 机器）→ 删除按钮（详情卡标题栏右侧，SubagentsSection 同构）→ 更多菜单+死参数+死 TID 清理。
- **phase-gates**：全门禁+knip 新面登记+i18n verify+CHANGELOG/UPSTREAM-SYNC+QA 附录整理。

## 最终项目结构

新增文件（照搬面按 fork 纪律加头注释，max-lines 超限加豁免头）：

```
packages/services/src/remote-projects/index.ts            # 上游 381L 移植：hosts/entries CRUD+legacy 迁移
packages/services/src/remote-projects/validation.ts        # 上游依赖（index.ts:16-25 re-export）
packages/services/src/remote-projects/connection-membership.ts # 上游依赖（host_id 派生+admission）
packages/services/src/remote-projects/workspace-settings.ts    # 上游依赖（projectWorkspaceSettings）
packages/services/src/onboarding/localUsageEvidence.ts     # U8：164L，品牌路径 ~/.omz
packages/ui/src/project-sidebar/ProjectSidebarNavigation.tsx # omz 化 62L（删 deviceNavigation/isWebRemoteControl）
packages/ui/src/remote-connection-flow/contract.ts         # Picker 真链四参签名类型（上游 contract.ts:28-33 子集）
packages/ui/src/side-pane-full-view/                       # U10：13 文件 1210L
packages/ui/src/remote-connection/EditConnectionProfileDialog.tsx # P9-3 依赖（306L，上游面板 :81 import）
packages/ui/src/remote-connection/RemoteLinkRail.tsx        # P9-3 依赖（上游 28L，2 导出：formatRemoteLinkRailTarget 等）
packages/ui/src/settings/SourceServerManagementPanel.tsx   # P9-3：1740L
packages/ui/src/settings/SourceServerMigrationReportPanel.tsx # 160L
packages/ui/src/settings/SourceServerUpdateActivity.tsx    # 147L
packages/ui/src/remote-connection-flow/ui/RemoteConnectionProgress.tsx # 134L 组件级例外（拍板 A）
packages/ui/src/store/sourceServerStatusRegistry.ts        # P9-3 消费缝数据源（上游 72L）
packages/ui/src/root/sourceServerUpdateNotifications.ts    # P9-4：335L
packages/ui/src/hooks/useSourceServerManagementSnapshot.ts # 93L
packages/ui/src/WorkspaceSidebarFooter.tsx                 # 已存在（251L）→修改：banner 槽（Step 3）
packages/ui/src/lib/sourceServerBoundaryOnboarding.ts      # P9-3/Step 4 边界确认依赖（上游 23L）
packages/ui/src/settings/{sourceServerManagementPresentation,settingsSourceWorkspace}.ts # 33L+113L
packages/ui/src/lib/{sourceServerManagementError,sourceServerUpdatePreferences,sourceServerUpdateAction}.ts # 14/75/53L
packages/desktop/src/host/sourceServerManagementService.ts # 359L
packages/desktop/src/host/sourceServerMigrationCounts.ts   # 120L
packages/desktop/src/main/fileApplications.ts              # U11：321L
packages/server/test/staticRoutePathContainment.test.ts    # U9 + tsconfig.test.json 新建
packages/ui/src/project-sidebar/useProjectFileTree.ts      # Q2 顺手补：100L+project-file-navigation 57L
```

关键修改（现状行数→预期）：`project-sidebar/index.tsx` 300→~380（豁免头预留）、`Root.tsx`+`SSHDialog.tsx`+`useRemoteWorkspaceHistory.ts`+`RemoteProjectPicker.tsx`（Picker 真链契约+host/initialRoots 透传）、`ProjectEditor.tsx` 472→724（+8 props+边界确认链）、`ProjectCreation.tsx` 92→290（降级分支）、`WorkspaceSidebar.tsx` 1677→alias（两行导出：组件+SidebarFileTreeOpenRequest 类型）、`WorkspaceSidebarFooter.tsx` +banner 槽、`WorkspaceShellLayout.tsx`（删双视角；补 onOpenFileManager/fileTreeOpenRequest/activePreviewPath 三 props）、`node.ts`（createProjectService 三参+createRemoteProjectService+remoteProjectConnection 选项）、`remoteWorkspaceServiceCollection.ts` 272→+resolveServerProjectService（两调用点补传参）、`host/index.ts`（resolveHost+connectHost/readConnectionStates 注入+management 注册+directory 服务注册删；deployServer 本轮不动）、`server/src/http.ts`（web 面路由删+死 import 清理+U9 穿越）、`shared/validation.ts`（source-settings scope）、`SettingsPage.tsx`+`settingsPageConfig.ts`+`settingsNavigation.ts`（remoteDevices 段）、`mentionMarkdown.ts`+`LexicalChatInput.tsx`+`ChatPromptEditor.tsx`+`ConversationComposer.tsx`（胶囊，5 个 setText 点）、`model-provider-section/`（ProviderCardSections/ProviderTemplatePicker/InlineEditableProviderCard/ModelProviderSection）、`shared/test-ids.ts`（U10 +14 TID、provider TID 退役+新增 3 TID）、i18n 两 locale（~160 键新增+1 孤儿键清理）。

明确不做（登记政策依据）：`SidebarBottomActivity`/`global-notice/*`/`marketing-touch/*`/`useRewards`（商业面）；`HomeOnlyWorkspaceRows`+`useHomeOnlyWorkspaces`+`WebRemoteControlDeviceHeader`（relay v2 手机面）；`WorkspaceWebRemoteControlTrigger`（relay v1 已清零不复活）；`onAddDevice` 向导壳依赖（拍板 A，disable+登记）；U5 延后两项（dropdown indicator/tooltip alwaysDelay 维持延后）；`ChatRemoteFolderSelection`（远端会话目录选择，另批）。

## 变更点清单

| # | 面 | 变更 | 证据锚 |
|---|---|---|---|
| C1 | P3 服务 | remote-projects CRUD+迁移+node.ts 接线 | 上游 remote-projects/index.ts 381L；omz remoteProjectDirectoryService.ts:117-184 全抛 |
| C2 | P3 路由 | resolveHost+ownerHostId+projectStorageHostId | services/node.ts:2043-2057 注释自陈挂账 |
| C3 | P3 legacy | resolveServerProjectService+单根退回 | legacy-single-root.ts 在库零调用 |
| C4 | 侧栏骨架 | Navigation/Footer/banner 槽/重排/裸调用继承 | 上游 index.tsx:214/231/327-345；R8 |
| C5 | Picker 真链 | Root remoteProjectSelection+SSHDialog onSelectProject 新签名+ChatEmptyState | 上游 Root.tsx:1361/1388-1407/1424 |
| C6 | 默认视角 | ~~readWorkspaceSidebarViewMode 缺省 classic→projects~~ **superseded by Step 5**（用户裁定移除双视角机制，单一 ProjectSidebar） | WorkspaceShellLayout.tsx:195-208 |
| C7 | P9 服务 | management **17 方法 + 2 事件**（onDidChangeState/onDidChangeDirectory）+1 可选事件（onDidAppendOperationLog）+channels+accessor+host 注册 | 上游 sourceServerManagement.ts:23-70 |
| C8 | P9 registry | source-settings scope+detach | shared/validation.ts omz:185-196 缺 |
| C9 | P9 设备卡 | 面板族照搬+remoteDevices 段+跳转+通知 | 上游面板族 ~161 键 vs omz 8 键（键级 diff 插入，预计 ~150×2） |
| C10 | P9 退役 | 删 server 侧 web 面路由（`/api/connect-remote`、`/ws/remote/:id`+`web/main.tsx:203` 消费点）；保模块树+`./remote` 导出；**host 闸门/旧分支/LEGACY 阀本轮保留**（阀=闸门不可拆，登记下轮删） | 上游 http.ts:446-449 同口径 |
| C11 | U5-U12 | 八项落点见 `cache/exploration-reports.md` §2.2（4.2 表） | 报告行号为探索时点基线，以现状文件为准 |
| C12 | 胶囊 | 富反解析+5 setText 点+队列预览+撤回 chip | ChatPromptEditor.tsx:207 等 |
| C13 | 服务商 | 弹窗/点击命名/右删按钮/TID 清理 | ProviderCardSections.tsx:120-174 |

## 详细实现步骤

- Step 1 — phase-sidebar-p3 — blocking: yes — qa: auto — 移植 `remote-projects/` 四文件：`index.ts`（上游 380L）+`validation.ts`+`connection-membership.ts`+`workspace-settings.ts`（上游 index.ts:16-25 re-export 的必需依赖，omz 全仓 0 命中）；`migrate-projects` 补 `migrateConnectionHosts()`（上游 :57-91；entries 回填 INSERT 已存在 `migrate-projects.ts:91-98` 无需重做）；**迁移生产链接线（P0-1，四改动点）**：①`ProjectMigrationContext.settings` 扩到上游四键（contract.ts:9-13 收窄注释放宽；`protocol.ts:360-362` 已有两键，注释同步更新）②`prepareTasksIndexStorage(path,onProgress,settings)`+`tasksStorageWorker.ts:12-16` 读 settings 传入 ③`taskIndexRepo.initialize`（:519-534）调 `projectStorage.migrate({settings,hostId,backupDirectories})`（对照上游 :396-402）④新增 blocking 测试「全新库迁移后 hosts/projects/project_roots/remote_project_entries 四表存在」（T-RP5）；`architecture-policy.yaml` publicEntrypoints 增 `index.ts`（期望导出面=index 现有 re-export 全集）；**⑤TaskIndexRepo 构造器对齐上游四参**（`taskIndexRepo.ts:479-483` 两参→上游 :327-332 四参，migrate 用 `migrationSettings/storageHostId`；**`backupDirectories` 来源=上游 taskIndexRepo.ts:396-402 的 `join(getZCodeDataRootDir(),"backup")`（omz 对应 `~/.omz` 数据根），缺省会触发 runner「Migration requires a backup directory」**），全仓 **8 处**调用点清单：`services/src/node.ts:1312`（传 `options?.projectStorageHostId`，对照上游 :1375）、`project-storage/startup.ts:110`（`new TaskIndexRepo(settings, undefined, path, LOCK_WAIT_MS)`，对照上游 :104）、`zcodeAgentService.ts:933`、`zcodeTaskServiceAdapter.ts:268`、4 处测试；②的 worker 侧 settings 用 `createSettingService()`（上游 worker :13-18；本仓 `storage-startup.ts:9` 已导出可直接用）；③ 插在 `initialize` 的 `:531` 早退之后仍覆盖（`tasksDatabase/prepared.ts` 的 prepared 为进程内 Set，Host 进程不命中）；**⑦迁移版本化（P0-2）**：**两段式（r5 P1-1）：0005 的 `apply` 内继续调用 `migrateConnectionHosts`（runner 只校验 `sql` checksum，`apply` 变化不破坏账本，`runner.ts:70-73`），保证全新库 alias 合并顺序（上游 migrate-projects.ts:57-91 返回 `aliases` 供 :100-116 entries 循环用，缺失则同一设备出现两行 host 且 entries 仍挂地址派生行）；另新增独立迁移 `0008_connection_hosts` 只处理存量库：幂等 `INSERT ... ON CONFLICT` + 显式重写 `projects.host_id`/`remote_project_entries.host_id` 到稳定 id 后清理旧 host 行**；T-RP5 增「已应用 0005 的存量库再次启动后 hosts 非空」+「同设备仅一行 host 且 entries.host_id=稳定 id」两用例；**⑧本轮 remote 建任务延后，`getProjectRepository` 硬编码 `"local"`（`taskIndexRepo.ts:595-599`）与 `taskGroupService.resolveTasks` 的 `readTree`（`node.ts:2060-2077`）保持现状，理由登记：hostId 路由随远端建任务批（上游 :349-352/:2188-2191）**；**⑥测试登记统一要求（P0-2）：本 spec 全部新增 T-* 的宿主文件逐条加入 `package.json:32` test:v4-perf 白名单（每个 Step 写明的用例宿主路径即登记名），Step 26 聚合门禁以白名单为准**
- Step 2 — phase-sidebar-p3 — blocking: yes — qa: auto — `node.ts`：`createProjectService({ownerHostId, resolveHost})`+options 增 `projectStorageHostId`/`resolveProjectHostService`/`remoteProjectConnection`（`{connectHost, readConnectionStates}` 选项，上游 node.ts:1256-1259）+**构造三选项写死（P1-3）**：`createRemoteProjectService({database: () => taskIndexRepo.getOrganizationDatabase(), controller, afterChange: publishProjectChange})`（上游 node.ts:2167-2172；`publishProjectChange` 本仓 node.ts:2046-2048 已有；缺 `afterChange` 则 `state:projects` 不广播、`useProjectTree.ts:327-330` 不刷新）+**`services/src/index.ts` 导出面补（r5 P2-4）**：`createRemoteProjectService`/`createRemoteProjectConnectionAdmission`/`remoteProjectHostIdForProfile`/`remoteProjectHostIdForTarget`/`prepareRemoteServerConnection`/`bindRemoteProjectIdentities`（现仅 `IRemoteProjectService` 与类型在 :129/:134）+**成员登记链接线（P0-1）**：`SourceServerConnectionManagerOptions` 加 `admitConnection`（上游 :826-843+复用路径 :848），`host/index.ts:1256-1269` 注入 `createRemoteProjectConnectionAdmission(lazyGet(IRemoteProjectService))`；**首连 intent 默认值（r5 P0-2）**：`connect()` 入参 `membershipIntent: options.membershipIntent ?? "add"`（上游 :348；本仓 :359-363 原样透传、renderer/protocol 全链无此字段，不补默认则首连落 `?? "retain"`→admission 对空 hosts 抛 `remote-project.host-removed`）；重连/恢复路径显式 `retain`（上游 :455、`host/index.ts:3006/:3779`）；**admission 主路径 commit（r5 P1-4）**：上游 `:1085-1095` 的 `effectiveProfile`+publish 前 `await commitMembership?.(sourceServerId)`（含 `:1088`），缺此段则 `saveHost` 后永不 `bindHost`、稳定 `remote:server:<id>` host 永不生成；`...options?.remoteProjectConnection` 展开与 `controller: !projectStorageHostId || projectStorageHostId === "local"`（上游 :2167-2172），注入点=`createLocalServices`（`host/index.ts:2700`）；`onProjectChange: notifyProjectChange`（`sourceServerConnectionManager.ts:159` 选项已存在但全仓未接；**`notifyProjectChange` 落地位置=`ensureSourceServerConnectionManager` 旁，实现=上游 host/index.ts:1758-1763 的 3 行 `state:projects` 广播**）；desktop `host/index.ts`：**connectHost 分两段落地（P0-1 修订，解阶段倒挂）——本步先搬 directory 版**（复用现有 `remoteProjectDirectoryService.ts:120-155` 的 `resolveSilentConnectionTarget`+`manager.connect` 链，不依赖 management；**`kind:"server"` 分支不移植（r5 P0-1 裁定）：omz `RemoteTarget = SSH|WSL|Docker`（`shared/remoteTarget.ts:28`）、`RemoteTargetSnapshot` 同（`protocol.ts:153-156`）、WS 直连 `serverRemoteConnection.ts:47-52` 零消费方、`remote-workspace-identity.ts:17-18` 明示「ServerConnectOptions 不随本期」——上游 `connection-membership.ts:34` 的 `Extract<…,{kind:"server"}>` 在本仓=never；URL Server 经 LEGACY deployServer 旧链，`RemoteLinkRail` 的 `case "server"` 一并删除**），`readConnectionStates` 由 directory 事件投影；**Step 7 再把 connectHost/readConnectionStates 整切为上游 `:3774-3863` management 版并在本步可执行落地（Step 7 已列该替换动作）**；`resolveProjectHostService`（上游 :3864-3905）注入 `createLocalServices`（:2700）；**删除 `remoteProjectDirectoryService.ts` 注册（:2748-2754）、文件与测试 `packages/desktop/test/remoteProjectDirectoryService.test.ts`（数据所有者裁定 §1），同步从 `package.json:32` test:v4-perf 末段摘除该路径，并改写 `projectSidebarRemoteBackfill.test.ts:112-135`（directory 注册断言）**；**（r5 P1-5 裁定：daemon 能力声明本轮不动——`packages/zcode-server-cli/src/server-core/http.ts:167` 未下发 `virtualProjects`（上游 :232 为 true），故真实连接恒走 legacy 分支，远端 workspace 内项目组织操作只读（`legacy-single-root.ts:160-163` 全抛 `project.legacy-read-only`），T-RP4 的 virtual 分支仅由 stub 覆盖）**；`remoteWorkspaceServiceCollection.ts` 增 `resolveServerProjectService`+virtualProjects 两分支（上游 :122-174/:249-271），**调用点补传参**：`host/index.ts:1374-1393` 与 `:1594-1614` 传 `serverId`/`virtualProjects`
- Step 3 — phase-sidebar-p3 — blocking: yes — qa: auto — UI 骨架：新建 `ProjectSidebarNavigation.tsx`（omz 化子集 62L）；`WorkspaceSidebarFooter.tsx` +banner 槽；`index.tsx` 重排为上游序（nav→task-list-region→scroll→footer），保留既有 tripwire 行原文（P41 :191-204 / RemoteBackfill :52-65 / RemoteSeams :66-67 / VirtualProject :35-36），`start()` 改裸调用+分组继承（上游 :131-155；**DTO 落地+消费链**：`CreateTaskOptions`（app-shell/types.ts:57-76）增可选 `hostId`——本机 owner 缺省 local 可省；`ProjectSidebarNode.tsx:120-124` 对象展开已天然透传；`index.tsx:230` `start(undefined, groupId)` 随三参签名改序为 `start(undefined, undefined, groupId)`；分组继承取 `useZCodeSessionStore.draftTaskGroupId`/`groups.parents`；**hostId 消费分支（P1-4）**：`useRootWorkspaceActions.ts:233-264` 增分支——hostId 非 local 时拒绝并 toast（`project.remote-host-create-unsupported` 登记，上游 :298-383 的完整远端路由留下一轮），本地路径行为不变），max-lines 豁免头
- Step 4 — phase-sidebar-p3 — blocking: yes — qa: auto — Picker 真链（P0-3/P1-6/P1-8 修订）：①`remote-connection-flow/contract.ts`（新建）定义 `onSelectProject(sessionId, path, localWorkspacePath?, workspacePurpose?: "project" | "conversation")`——**purpose 来源（P1-2 方案 a）**：`SSHDialog` 增 `workspacePurpose` **prop**，由两个挂载点显式传值：`Root.tsx:638-652` 传 `"project"`，`ChatEmptyState.tsx:407-417` 传 `"conversation"`（保持其"打开远程会话 tab"行为不变）；未传时按 `"conversation"` 兜底（旧行为）；②`SSHDialog.tsx:48/:372` 透传四参+workspacePurpose prop；③真实 owner=`useRemoteWorkspaceHistory.ts`：`:461` `selectRemoteWorkspaceProjectFromDialog` 在 **bind 前 return**（workspacePurpose==="project" 时不做 addTab/activateTabByPath，也不跑 `bindRemoteWorkspaceSessionContext`/`commitRemoteWorkspaceSessionMutation`（:570-600），改为把 `{sessionId,path,hostId}` 交给 Root 的 selection 回调；`"conversation"` 保持旧链——ChatEmptyState 入口行为零变化），`:993-1034` onSelectProject 实现同步透传 purpose；④`Root.tsx` 挂 `RemoteProjectPicker`+selection state+stale-intent 守卫（omz 等价物：`requestId` 自增比对+**onClose 释放 attachment：`requestId++` 使旧 intent 失效并清 selection（上游 Root.tsx:1397-1404 的 epoch++/handleCancelRemoteProject 等价形态），P2-9**）；**hostId 派生规则**：由 `buildServerRemoteWorkspaceIdentity`+`remoteHostIdFromWorkspaceIdentity`（上游 Root.tsx:1290-1300）从 selection 推导，写入 ProjectEditor 的 `host`；⑤`RemoteProjectPicker.tsx:12-23` **必须改造**：`renderCreate` 补传 `host`/`initialRoots`（上游 :13-20；不传则 `RemoteProjectList.tsx:63` 不进创建态、`ProjectEditor.tsx:221-222` 保存不带 hostId，服务端按 local 路由）；⑥`ProjectEditor.tsx` 472→724，**真正缺的 props**（上游 :92-135）：`host`/`devices`/`defaultDeviceId`/`remoteService`/`onConnectDevice`/`onAddDevice`/`onBrowseExisting`/`onPrepareExisting`（`fixedFolder`/`onBeforeSave`/`initialRoots`/`isCurrent` 本仓已有）+**边界确认依赖链（P1-6）**：`useRemoteBoundaryAcknowledgement`（hook 在 `RemoteConnectionDialogContent.tsx:58`）+setting 键 `remoteBoundaryIntroAcknowledgedVersion`+`ensureSourceServerBoundaryAcknowledged`，三者本仓 0 命中须随本步落地；**`onLegacyCapability` 并入本步（P1-10：上游 ProjectEditor.tsx:423 传给 RemoteProjectList，Step 6 前必须存在）**；`ProjectCreation.tsx` 92→290（设备面降级分支=数据所有者裁定 §2 的 directory.hosts 映射）；`onAddDevice` disable 登记拍板 A；**⑧用户可见语义切换登记（P1-6）**：Root 的「打开远程工作区」入口语义由「连上即开 tab」切换为「进入项目创建」（`useRemoteWorkspaceHistory.ts:570-600` 旧链在 project 分支跳过）；本轮远端建任务路由未做（Step 3 拒绝分支），故远端项目暂不可直接起任务——进 CHANGELOG 与 QA 附录（T-QA1 验收口径同此）；⑦**测试**：新建 `packages/ui/test/remoteProjectPickerChain.test.ts`（T-SB4；`remoteWorkspaceReconnected.test.ts` 不覆盖 onSelectProject 链，不改它）
- Step 5 — phase-sidebar-p3 — blocking: yes — qa: auto — **移除 classic/projects 双视角机制**（用户裁定 2026-10-23：上游 zcode 无此切换——`sidebar-view-mode`/`sidebarViewMode` 在 .reference/ZCode 全仓 0 命中，属 omz fork 自创，「没有就不做」）：删 `WorkspaceShellLayout` 的 `sidebarViewMode` 状态+持久化键+两个切换钮+**`WorkspaceShellLayout.tsx:1662/:1664` 向 WorkspaceSidebar 传的 `reconnectingRemoteWorkspaceKeys`/`reconnectingRemoteWorkspaceLogsByWorkspaceKey` 两 prop 及上游 AppProps 链**（`app-shell/types.ts:90`、`App.tsx:94/1065`、`RootWorkspaceContent.tsx:35/69/128`；重连日志面由 `RemoteProjectConnectionDetails` 承接）；**`WorkspaceSidebar.tsx`（1677L）采用上游 alias 形态（两行导出：`export { ProjectSidebar as WorkspaceSidebar }` + `export type { SidebarFileTreeOpenRequest }`，`WorkspaceShellLayout.tsx:51` 正从该文件导入该类型）**；**独有面可核对清单（P1-1 修订）**：①workspace tab 列表（`:364`/`:1490-1550` DnD/Sortable 整段）→ 显式裁决：**由项目树取代，登记废弃**（tab 排序/拖拽语义由项目树分组拖拽承接）②`WorkspaceDragOverlay`(:182) 拖拽 → 融入骨架拖拽层 ③`WorkspaceSidebarCollapsedRail`（`:156` re-export 外全仓零消费，本就死导出）→ 随 alias 退役 ④`WorkspaceNewTaskTooltip`(:140) → 骨架新建入口复用；**死文件簇清单（alias 后仅自引用，逐项删除或 knip 豁免）：`SortableWorkspaceSidebar.tsx`(135L)、`WorkspaceSidebarItem.tsx`(1204L)、`WorkspaceSidebar/ReconnectingRemoteWorkspaceLogTooltip.tsx`、`lib/workspaceSidebarDrag.ts`、`WorkspaceSidebar/taskGroupTogglePresentation.ts`、`WorkspaceSidebar/workspaceSidebarSelection.ts`**；T-SB3 判据=「alias 后零功能残留 + ①②④ 落点在骨架可断言 + `sidebarViewMode`/`sidebar-view-mode-toggle`/持久化键/`workspaceSidebar.classicSidebarView`（zh:1344/en:1431）/`workspaceSidebar.projectTreeView`（zh:1343/en:1430）全仓 0 残留（含 i18n）」；**同步改 `projectSidebarVirtualProject.test.ts:48-54`（双视角断言与"经典侧栏必须保留"注释随裁定改写）**；`useProjectFileTree`+`project-file-navigation` 顺手补+`onViewFiles` 接通（WorkspaceShellLayout 补 `onOpenFileManager`——**P2-6：`fileTreeOpenRequest`/`activePreviewPath` 本仓 :1645/:1650 已在传，实际只缺此项**）
- Step 6 — phase-sidebar-p3 — blocking: yes — qa: auto — `RemoteProjectList.tsx` legacySingleRoot 分支回填；phase 门禁（tsc/lint/oxfmt/T-VS+T-SB 套件+knip 新文件登记）
- Step 7 — phase-p9-management — blocking: yes — qa: auto — P9-1：**services 侧契约面扩展（P1-5）**：`packages/services/src/source-server-management/sourceServerManagement.ts` 15L→~73L（补 `ISourceServerManagementService` 接口+`channelName` descriptor，上游同文件，**17 方法 + 2 事件 + 1 可选事件 `onDidAppendOperationLog`（P2-3：Step 9 的 `useSourceServerOperationLogs.ts:53` 靠它触发重读，必须落）**）；`channels.ts` 增 SourceServerManagement+client getter+accessor 字段+`sourceServerManagementService.ts`(358L)+`sourceServerMigrationCounts.ts`(119L)+host 注册（上游 host/index.ts:4028-4056）；**connectHost/readConnectionStates 替换为上游 `:3774-3863` management 版（profile 分支守卫 `sourceServerManagementService`，P1-4 落地动作）**
- Step 8 — phase-p9-management — blocking: yes — qa: auto — P9-2：`shared/validation.ts` scope 加 source-settings+remote.sourceServerId；`windowHostAttachmentRegistry.ts` +detach+守卫；host 删前回调接线（上游 :4038-4054）
- Step 9 — phase-p9-management — blocking: yes — qa: auto — P9-3：面板族照搬（1740L 面板+160L 迁移报告+147L 更新活动+5 hooks/lib+**`EditConnectionProfileDialog.tsx` 307L（P0-4：面板 :81 import、:1726 渲染，omz 无此文件）**）+**依赖 hunk 随本步落地**（`isInvalidPort`（上游 remoteConnectionWizard.ts:141，`collectRemoteFormFieldErrors`:163 直接调用——**P1-1：与 collect 同批并入本步**）+`collectRemoteFormFieldErrors`（EditConnectionProfileDialog:19 用；Step 14 不再重复落）+`findSourceServerUpgradeProfileId`（Step 10 用）+`RemoteConnectionFields.tsx` 补 `fieldErrors`/`focusField`/`autoFocusHost`/`focusCredentials` prop 族（上游 :332-402；密码占位 `ssh.passwordPlaceholder` 本仓 :418 已有不算新增）+`useRemoteConnectionForm.ts` 补 `preserveDraftOnOpen`/`savedSshConfigAlias` 两参数（:40-45））+**例外真实范围**=`RemoteConnectionProgress.tsx`(134L)+`remote-connection-flow/contract.ts` 类型+`remote-connection/RemoteLinkRail.tsx` 新建（上游 28L、2 导出：`formatRemoteLinkRailTarget` 等，**P2-10：两文件皆无，须新建**）+`resolveRemoteConnectionPhases` 最小实现（落 `remote-connection/RemoteConnectionConnectingStep.tsx` 导出，`SourceServerManagementPanel` 三个导出适配（`useRemoteConnectionProgress`+`RemoteConnectionMinimizedProgress` 等，面板仅 :187 一处调用）；本地底座 `remote-connection/remoteOperationProgress.ts:7-33` 的 PHASES/normalizer 可复用但需导出）+形状守卫 T-MG3；**消费缝切换（P1-2/P1-7）**：`useSourceServerStatuses.ts:15-29` 恒空 stub 切真实 management 数据源（依赖新增 `packages/ui/src/store/sourceServerStatusRegistry.ts` 72L，上游同文件；**加入新增文件清单**）+`RemoteConnectionProgressSection.tsx:55` `managementEnabled` 翻转为真+`:61` `useSourceServerOperationLogs(undefined, [])` 改接 `logsByProfileId[profileId]`（`:69` 注释承诺）+`:70` `resolveRemoteOperationProgress` 接真实日志投影+**同步改 `projectSidebarRemoteBackfill.test.ts:145-148`（managementEnabled=false 断言）与 `:139-143`（useSourceServerStatuses stub 注释断言改真实接线形状）**；`settingsPageConfig` remoteDevices 段+`SettingsPage` 接线+i18n 键级插入（C9 口径：上游面板族 ~161 键 diff，预计 ~150×2，en/zh 同批）
- Step 10 — phase-p9-management — blocking: yes — qa: auto — P9-4：`settingsNavigation.ts` remoteDevices 段+intent 键+`ProjectSidebarNode.tsx:74` action 注入+`Root.tsx`+`sourceServerUpdateNotifications.ts`(335L)；**前置符号 `findSourceServerUpgradeProfileId` 在本步落地**（并入 `lib/remoteConnectionWizard.ts`，上游 remoteConnectionWizard.ts:363；Step 14 不再重复）
- Step 11 — phase-p9-management — blocking: no — qa: auto — P9-5（P0-2 修订，阀=闸门不可拆）：删 server 侧 **web 面**路由 `/api/connect-remote`（`server/src/http.ts:348`，仓内零调用）+`/ws/remote/:id`（:418）+`web/src/main.tsx:203` 消费点+**死 import 清理**（`http.ts:41 connectRemote/RemoteConnection`、`:128 remoteConnections`、`:130 generateId`、`:33 remoteTargetSchema`、**`:22-25` 的 `IFileService`/`IGitService`/`ISystemService`/`ITerminalService` 四 token（P1-5：删 `/ws/remote/:id` 后仅剩该路由 :437-440 使用）**；`createRemoteBackend` 仍被 `source-server/transportAdapter.ts` 使用须保留）；保留 `server/src/remote/**` 模块树与 `./remote` 导出；**host 闸门（:1533）/旧分支（:1553-1661）/`setupRemoteConnection`（:2804-2836）/LEGACY 阀本轮全部保留**（=R5 回滚阀与 T-QA2 冒烟对象，登记下轮删，CHANGELOG 分开表述 web 入口与 desktop 旧链）
- Step 12 — phase-u-backports — blocking: yes — qa: auto — U5：dialog.tsx DialogCloseText（155→165L）；collapsible.tsx 去组名改 `data-[state=open]:[&>div]:animate-in`（fork 注释融合）；kbd.tsx 复用 ControlShortcutBadge
- Step 13 — phase-u-backports — blocking: yes — qa: auto — U6：ToolCallBody.tsx:135-158 失败态 try/catch+path 变更清态（omz 口径：previewFailed 主路径，previewUnavailable 不可达登记）；cuaScreenshotDetails.ts:67 +sharedImageSrc；nodeReplImageGrid.tsx:27 +image.src 优先
- Step 14 — phase-u-backports — blocking: yes — qa: auto — U7：`remoteConnectionWizard.ts` `isInvalidPort`/`collectRemoteFormFieldErrors`/`findSourceServerUpgradeProfileId` 已随 Step 9/10 落地（本步不重复）；RemoteConnectionFields.tsx 只挑 autoFocusHost/focusCredentials hunk（`fieldErrors`/`focusField` 已随 Step 9 落地；上游重写版不整搬）；`useRemoteConnectionForm.ts` 上游 hunk 为 :240-261 的 loaded&&!error 守卫（spec 旧行号 211-221 已漂移；`preserveDraftOnOpen`/`savedSshConfigAlias`（上游 :46-56）已随 Step 9 落地）
- Step 15 — phase-u-backports — blocking: yes — qa: auto — U8：localUsageEvidence.ts(164L,`~/.omz`)+**消费方接线（P1-8）**：`node.ts` 导入（**上游 :42 导入，本仓对应 import 区**）并切 `createHasExistingLocalTask({listIndexTasks: () => taskIndexRepo.listTaskMetas({includeDeleted:true}), hasAgentSessionRow, resolveLegacyTaskSessionsDir})`（对照上游 :1387-1388；omz 现为 `node.ts:1314-1316` 的 `listTaskMetas({}).length>0` 内联判断，替换后模块为真实消费）
- Step 16 — phase-u-backports — blocking: yes — qa: auto — U9：http.ts:246-249 +isAbsolute 判定+isPathDriveQualified+盘符前置 404；新建 packages/server/test/+tsconfig.test.json+根 typecheck 工程表+test:v4-perf 登记
- Step 17 — phase-u-backports — blocking: yes — qa: auto — U11：fileApplications.ts(321L) 整件+`editors.ts`/`openInEditor.ts`/platform 链接线（上游无 `openWithFileApplication.ts` 独立件，探索报告该名有误，以 fileApplications 321L 为准）+OpenSplitButton path+PreviewPane 序号守卫；纯逻辑选择器用例 T-UF6（平台差异按 omz 三平台口径，GUI 拉起真机归 T-QA6 观测）；**CR 轮实现细节（终态）**：①平台登记表 `getEditorDefsForPlatform(platform)` 抽到**新文件** `packages/desktop/src/main/editorDefinitions.ts`（不 import electron，否则 node 测试无法注入三平台），`editors.ts` 只剩薄包装 `getEditorDefsForCurrentPlatform()`；②`partitionEditorDefs(defs)`（按 `"fileExtensions" in def` 分段）落 `fileApplications.ts`，`getBaseInstalledEditors` 复用；③文件应用条目带 `fileApplication: true`（`platform.ts` 的 `EditorInfo` 可选字段），`OpenSplitButton` 只对非文件应用持久化「上次选择的编辑器」（`lib/editorPreference.ts:shouldPersistEditorSelection`），否则 PDF 的 preview 会污染工作区头/预览头的 IDE 显示；④`GetInstalledEditors` 平台契约放宽为 request `string | undefined`（S23）；⑤`getEditorDefsForCurrentPlatform()` 语义扩大为 `[...IDE, ...getFileApplicationDefs()]`，**文件应用只经 filePath 附加**、基座过滤在函数外（S26）；**测试登记**：`packages/desktop/test/fileApplicationsSelector.test.ts`（T-UF6）+ `editorSelectionPersist.test.ts` + `inlineImageResult.test.ts`（desktop/B-2）均在 test:v4-perf 白名单
- Step 18 — phase-u-backports — blocking: yes — qa: auto — U12：unreadBadge.ts sum→max+overlay（36→~330L）+desktopWindowLifecycle 多窗口+desktopTray 红点+chromeState 常量导出；T-UF4 锁 sum→max 语义；**CR 轮终局裁定（S8 / desktop/C-1，2026-10-23）**：数字徽章渲染器 `renderTaskbarBadgePixels` **生产零调用，仅上游测试兼容，接线待产品确认**——段首注释已写明，删除会连带删掉已通过的像素用例；生产面一律走纯红圆点（`renderTaskbarStatusDotPixels` / `renderAntialiasedStatusDotPixels`），若产品决定恢复数字角标，接线点是 `createWindowsTaskbarOverlayApplier` 的 `createBadgeImage`（当前只喂红点）；**同批其它终态**：任务栏角标描述走 locale（`taskbar.unreadTasks` 键 zh/en 对称，`formatDesktopMenuMessage(locale, id, values)` 由两个调用点各自传 locale，`description` 为**必填**入参）+徽章图缓存收敛**单槽**（同 label 只建一次、换 label 复用同一实例，原先按 label 存 10 张等价图）；托盘红点仅 Windows（S21）
- Step 19 — phase-u-backports — blocking: yes — qa: auto — U10 side-pane 全屏压轴：side-pane-full-view 13 文件+8 大文件逐 hunk 融合（SessionPane/WorkspaceShellLayout/ConversationTimeline/V4WorkspaceChatArea/WorkbenchPane/AnimatedSidePanePanel/App/types）+useComposerToolbarFit 叠加在 P1 已落分支之上+conversationTimelineLiveTail+47+shortcutCommands+1+test-ids+14+i18n +1 键（toggleSidePaneFullView）
- Step 20 — phase-pill-restore — blocking: yes — qa: auto — `mentionMarkdown.ts` 富反解析：产出 {category,label,value,markdown(=fullMatch 原文),data}；目的地白名单 plugin:///#sess_/./..// /盘符；inline 裸 token 不转（用户拍板）；代码块 fence 跳过策略
- Step 21 — phase-pill-restore — blocking: yes — qa: auto — `LexicalChatInput` 富装填 API（**`setTextWithPluginMentions` 保留为富 API 的薄包装，`ConversationComposer.tsx:271` 调用面不动——P2-7**；对齐 replaceEditorText 段落切分+selectEnd）；替换 **5 个** setText 点：ChatPromptEditor.tsx:207（编辑历史）、ConversationComposer.tsx:330（队列撤回）、:222（草稿 editorState 回退）、:273（外部预填）、:1176（发送失败回滚正文——纳入，正文恢复同样需保胶囊）
- Step 22 — phase-pill-restore — blocking: yes — qa: auto — 队列行胶囊预览（ConversationQueueRow.tsx:119-124 改富解析渲染）+队列撤回上下文 chip 恢复（restore 链接 parseComposerPromptContexts，与编辑历史路径对称）；tripwire 同步更新（composerHeldQueueGuard.test.ts:42-54——该断言在 Step 21 落地即红，故本 Step 为 blocking，R10 已明示联动）
- Step 23 — phase-provider-ui — blocking: yes — qa: auto — 新建名称弹窗（owner/挂载点：`ModelProviderSection.tsx` 持弹窗状态，`ProviderTemplatePicker` 选择回调改为 `onPicked(template)` → Section 开 Dialog（`Dialog` 复用既有 ui 组件）→ 提交调既有 ProviderDraftSave 链）→ 前端必填+重名拦截（文案与重命名一致）→ 创建；复用 6 孤儿键（zh:2554-2559/en:2735-2741）；失败复用 templateCreateFailed 横幅；**新 TID**：`TID_MODEL_PROVIDER_NAME_DIALOG`/`TID_MODEL_PROVIDER_NAME_DIALOG_INPUT`/`TID_MODEL_PROVIDER_NAME_DIALOG_CONFIRM`（shared/test-ids.ts）
- Step 24 — phase-provider-ui — blocking: yes — qa: auto — 点击命名：名字改 button 可点进入命名态（复用 handleStartEditName/handleNameBlur/resolveProviderNameEditKeyAction IME 机器）；单次 onClick 语义防双击；nameConfirmed 闸门不动；测试并入 T-PV1（形状：名字为 button+触发名态；提交归一化纯逻辑）
- Step 25 — phase-provider-ui — blocking: yes — qa: auto — 删除按钮：详情卡标题栏右侧 Trash2 icon-sm（SubagentsSection.tsx:567-580 同构，留在卡片子树保 deleteRequestedRef 守卫）+confirmVariant destructive+仅 onDelete 存在时渲染+family 死守卫清理；更多菜单整删+DropdownMenu/Pencil/MoreHorizontal import+actionsVisible/secondaryActionsVisible 死参数+TID_MODEL_PROVIDER_NAME_EDIT_BUTTON 退役+新 TID（名称触发/删除按钮/弹窗）
- Step 26 — phase-gates — blocking: yes — qa: auto — 全门禁：root typecheck（+server test 工程）/lint 零新增/oxfmt 触碰面/knip 终态基线联动（新文件消费方登记）/i18n --verify 对称/test:v4-perf 全量/cli-backport
- Step 27 — phase-gates — blocking: yes — qa: manual_user — CHANGELOG 未发布段+UPSTREAM-SYNC 基线注记+QA 附录成文（见测试策略）

## 测试策略

形态沿用现状两种：纯逻辑/源码形状守卫（projectSidebarP42 同款）挂 `test:v4-perf` tsx 段；desktop 面用既有 node --test。新增 server 测试工程（U9）。真机交互一律 manual_user 合并后用户验收，不阻塞自动门禁。T-VS = 既有虚拟项目存储套件（upstream-v316-fullsync 15 用例，已在 test:v4-perf 段，Step 6 复跑）。

### 测试用例

- T-RP1 — blocking: yes — remote-projects CRUD 单测：hosts/entries 增删改查+legacy single-root 迁移判重+initial_position（Step 1）
- T-RP2 — blocking: yes — migrateConnectionHosts 回填：legacy connectionProfiles→hosts 行（entries INSERT 已存在，验证其幂等）（Step 1）
- T-RP5 — blocking: yes — 迁移生产链接线：全新库经 `TaskIndexRepo.initialize` 后 hosts/projects/project_roots/remote_project_entries 四表存在+迁移账本 0005_projects 在册（Step 1，抓「迁移只在测试里被调」的缺口）
- T-RP3 — blocking: yes — resolveHost 路由：hostId 不符时 resolveHost 在/不在的两态（project.host-offline 抛出）（Step 2）
- T-RP4 — blocking: yes — `resolveServerProjectService` 两分支（virtualProjects/legacy 单根退回）（Step 2）
- T-RP6 — blocking: yes — 空 hosts 库首连：`connect()` 默认 intent `"add"` → saveHost → bindHost → admission 主路径 commit → readDirectory 稳定 host（Step 2，抓「首连不建 host 行 / membership 不 submit」缺项）
- T-SB1 — blocking: yes — 骨架形状守卫：nav/footer/banner 槽在位 + `WorkspaceSidebar` alias 在位 + **独有面逐项有归宿（r5 P1-3 判据）：tab 列表=由项目树取代且 0 残留、拖拽层=骨架内可断言、CollapsedRail=已删除（全仓 0 命中）、tooltip=骨架新建入口复用**（Step 3/5）
- T-SB2 — blocking: yes — 既有 5 个侧栏 tripwire 套件全绿（P41/P42/RemoteBackfill/RemoteSeams/VirtualProject）（Step 3-6）
- T-SB3 — blocking: yes — 双视角移除守卫：`sidebarViewMode`/切换钮/持久化键全仓 0 残留（含 i18n 两键 classicSidebarView/projectTreeView）+ alias 后零功能残留（独有面逐项归宿：tab 列表 0 残留/拖拽层在位/rail 已删/tooltip 复用；死文件簇处置到 knip 基线）（Step 5）
- T-SB4 — blocking: yes — Picker 真链纯逻辑（新文件 `packages/ui/test/remoteProjectPickerChain.test.ts`）：SSHDialog onSelectProject 四参→useRemoteWorkspaceHistory purpose==="project" 在 bind 前 return→Root selection 装配→Picker 向 Editor 透传 host/initialRoots 形状（Step 4）
- T-SM1 — blocking: yes — management 服务单测：**17 方法 + 2 事件**（onDidChangeState/onDidChangeDirectory）**+可选 onDidAppendOperationLog** 注册+删前回调 detach 时序（Step 7-8；ID 由 T-MG1 改名，避开既有 shikiTokensCacheLru.test.ts 的 T-MG1 重名）
- T-MG2 — blocking: yes — validation scope：source-settings schema 两分支+remote.sourceServerId（Step 8）
- T-MG3 — blocking: yes — P9-3 面板形状守卫：面板段注册/设备卡渲染分支/例外组件（RemoteConnectionProgress+两函数）形状（Step 9）
- T-MG4 — blocking: yes — P9-4 纯逻辑：settingsNavigation remoteDevices 段+sourceServerUpdateNotifications 控制器（Step 10）
- T-UF1 — blocking: yes — U5/U6/U7 定点：collapsible 动画类形状+失败态分支存在+isInvalidPort 边界（含 0/65536/NaN）（Step 12-14）
- T-UF2 — blocking: yes — U8 品牌：localUsageEvidence 路径断言 `~/.omz`+includeDeleted 生效（Step 15）
- T-UF3 — blocking: yes — U9 穿越：相对路径/盘符/绝对路径逃逸 404 用例（新 server 测试工程首用例）（Step 16）
- T-UF4 — blocking: yes — U12 sum→max：多窗口同值不翻倍（Step 18）
- T-UF5 — blocking: yes — U10 全屏：isFloatingPresentation/fullViewSlot 双投影纯逻辑+shortcutCommands 注册（Step 19）
- T-UF6 — blocking: yes — U11 fileApplications 选择器纯逻辑：应用列表归并/首选判定/路径匹配（Step 17）
- T-PR1 — blocking: yes — 反解析纯函数：链接形态全类往返恒等（getMarkdown()==输入子串）+转义+目录尾斜杠+白名单外 URL 不转+代码块跳过+inline 裸 token 不转（Step 20）
- T-PR2 — blocking: yes — 5 个 setText 点形状守卫：富 API 调用在位+旧 setText 不再用于装填路径（Step 21）
- T-PR3 — blocking: yes — tripwire 同步：composerHeldQueueGuard 更新后绿（Step 22）
- T-PV1 — blocking: yes — resolveCreateProviderName 校验：空/空白/重名拦截+模板预填+弹窗挂载点形状（Section 持状态+TID 在位）+点击命名 button 形状（Step 23-24）
- T-PV2 — blocking: yes — canDeleteProvider+名称提交归一化纯逻辑+更多菜单零残形状守卫+i18n 孤儿键 `settings.modelProvider.renameProvider`（zh:3095/en:3320）随更多菜单删除清理（Step 25）
- T-GT1 — blocking: yes — 全门禁聚合绿（Step 26）
- T-QA1 — blocking: no — qa: manual_user — 侧栏真机：默认 projects 视角/项目树/分组拖拽/未读/SSH 选目录→Picker→保存→列表出现/onViewFiles
- T-QA2 — blocking: no — qa: manual_user — 设备卡真机：remoteDevices 段渲染/管理删除迁移报告/侧栏节点跳转/LEGACY 阀=1 回旧链冒烟
- T-QA3 — blocking: no — qa: manual_user — 胶囊真机：编辑历史消息胶囊保持+重发字节不变/队列撤回胶囊+chip 恢复/刷新草稿保胶囊/手打 @xxx 保持文本
- T-QA4 — blocking: no — qa: manual_user — U10 真机：全屏快捷键/floating 链/轨迹 tab 不受 visible 闸门影响（omz 特有坑）
- T-QA5 — blocking: no — qa: manual_user — 服务商真机：三交互+重名提示+删除确认+窄栏折叠
- T-QA6 — blocking: no — qa: manual_user — U5/U6/U12 观感：嵌套淡出/图片失败态/角标不翻倍+tray 红点

### 用例宿主（K1 要求：T-* → 宿主文件 → 登记批次）

| 用例 | 宿主文件 | 批次 |
|---|---|---|
| T-RP1/T-RP2/T-RP5/T-RP7 | `packages/services/test/remoteProjectsMigration.test.ts` | `node --import tsx --test` |
| T-RP3/T-RP4/T-RP6 | `packages/services/test/remoteProjectsService.test.ts`（跨包 import `desktop/src/host/*`，S16 定案：拆纯函数不补 services test 工程） | 同上 |
| T-SB1/T-SB2/T-SB3/T-SB4 | `packages/ui/test/projectSidebarP42.test.ts`、六个侧栏 tripwire 套件、`remoteProjectPickerChain.test.ts` | `tsx --test`（ui tsconfig） |
| T-SM1/T-MG2 | `packages/services/test/sourceServerManagement.test.ts` 等 | `node --import tsx --test` |
| T-MG3/T-MG4 | `packages/ui/test/sourceServerPanelShape.test.ts` 等 | `tsx --test` |
| T-UF1 | `packages/ui/test/u5u6SurvivorsShape.test.ts`（`isInvalidPort` 断言在 Step 14 宿主，S22） | `tsx --test` |
| T-UF2 | `packages/ui/test/localUsageEvidence.test.ts` | `tsx --test` |
| T-UF3 | `packages/server/test/pathTraversal.test.ts`（新工程） | 根 typecheck 工程表 + `test:v4-perf` |
| T-UF4 | `packages/desktop/test/unreadBadgeMaxSemantics.test.ts` | `node --import tsx --test` |
| T-UF5 | `packages/ui/test/sidePaneFullView.test.ts` | `tsx --test` |
| T-UF6 | `packages/desktop/test/fileApplicationsSelector.test.ts`（CR 轮新增 `editorSelectionPersist.test.ts`、`inlineImageResult.test.ts` 同批） | `node --import tsx --test` |
| T-PR1/T-PR2/T-PR3 | `packages/ui/test/composerMentionPillParse.test.ts`、`composerMentionPillFill.test.ts`、`composerHeldQueueGuard.test.ts` | `node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test` |
| T-PV1/T-PV2 | `packages/ui/test/modelProviderNameDialog.test.ts`、`modelProviderCardActions.test.ts`（S10：名称归一化纯逻辑宿主在 PV1 文件） | 同上（tsx 段不可用：`@/lib` 别名在 `tsx --test` 下解析失败，K4 因此不迁批次） |
| T-GT1 | Step 26 聚合门禁（无独立宿主） | — |

### CR 轮回写（S1-S29 终态，2026-10-23 收口）

CR `code-review-loop` 判决 `fix-spec-ready` 后由 code-dev-loop 执行，26 条 must-fix（2 P1 + 24 P2）全部落地并经 verify（4 路 pass）+ cr-func（4 路 `func-ready: yes`）。deviations 终态：

- **S1**（草稿 schema 新增 `promptContexts` 载体、`readDraft` 放宽为「正文或载体至少一样」、`promoteComposerDraft` 显式剥离）：accepted。旧客户端读纯上下文草稿会丢弃载体，随 Step 21 已在 CHANGELOG 待登记。
- **S2 + S25**（`setTextWithPluginMentions` 由 plugin 专用变富装填别名；草稿恢复入口 `restorePersistedComposerDraftIntoInput` 同切富 API）：accepted，Step 21 的装填点计为 **5 个 setText + 1 个草稿恢复入口**。
- **S3**（`updateComposerContent` 终态为「值 or 函数」双形态，跨 scope 写回由 `applyScopedDraftContentUpdate` 丢弃）：accepted，「签名收窄」措辞作废。
- **S4**（T-PR2 源码字面量次数断言降级为 `>= 1` + 负向断言）：fixed。
- **S5**（services 六值导出落 `node.ts` 而非 `index.ts`）：accepted。
- **S6**（0008 幂等仅行级成立、`membership_id` 每次重跑换 UUID）：accepted，本 spec R6 不称「完全幂等」。
- **S7**（`migrateConnectionHostsOnUpgrade` 不动 `tasks.host_id`）：accepted，收敛范围=projects/entries；**CR 轮补**：新增去重只软删「稳定侧已有同名未删项目」的 legacy 项目（保留行与任务可读），entries 侧硬删 legacy 重复行后改绑。
- **S8**（数字徽章段生产零调用）：fixed（取注释保留），Step 18 已写。
- **S9**（`sharedImageSrc`/`image.src` 无生产者，预埋兼容）：accepted，注释口径已与事实对齐。
- **S10-S14**：accepted/fixed（见 cr-fix-spec 表）。
- **S15**（`TaskIndexRepo` 调用点 11 处/9 文件）：accepted，spec 计数以 11 处为准。
- **S16**（services 无 test 工程，desktop 测试跨包 import）：定案拆纯函数。
- **S17**（0008 用 `ensureHost(INSERT OR IGNORE)+UPDATE`）：accepted，「幂等 upsert」。
- **S18**（队列行复用气泡渲染器 + `previewText` prop）：fixed。
- **S19**（host 上限裸错误码）：accepted，见 R-C。
- **S20**（Step 13 额外改 `nodeReplToolDisplay.ts`）：accepted。
- **S21**（托盘红点仅 Windows）：accepted。
- **S22**（`isInvalidPort` 断言归 Step 14 宿主）：accepted。
- **S23**（`GetInstalledEditors` 契约放宽）：accepted，Step 17 已写。
- **S24**（`unreadBadge` 公共面改名/转导出）：accepted，与 knip 基线联动登记。
- **S26**（`getEditorDefsForCurrentPlatform()` 语义扩大）：accepted，Step 17 已写。
- **S27（CR 轮新增）**：会话选区 chip 的**跨来源去重**必须用内容键——恢复项（`parsePromptConversationSelections` 产出）没有 id，live 项一定有 id，只按身份键判重时「撤回后再选同一段」会同时出两枚 chip。终态：`conversationSelectionContextKey`（id 优先，身份/删除用）+ `conversationSelectionContentKey`（`path\0text`，跨来源判重用），`mergeContextList` 增加可选 `contentKeyOf`，仅会话选区传内容键（其余三类 id 两侧都稳定）。
- **S28（CR 轮新增）**：`editorDefinitions.ts`（272L）为 G-1 抽出的 electron-free 平台登记表，fix-spec 只写「拆成 `getEditorDefsForPlatform`」，新文件为「可注入三平台断言」的必要依赖，Step 17 已登记。
- **S29（CR 轮新增）**：`composerSubmitMachine` 的 `claim` 在组件里有真实消费（冻结提交面），`succeed` 只做「live 减 frozen」——组件侧该减法恒为 0（拿不到 ACK 时刻的 live），故组件**不再用 succeed 做分支**，成功清载体只由 revision 快照 + 逐项移除保护；reducer 的 subtract/union 语义仍由 T-PR2-8/9 单测锁死。

**K 节执行状态**：K1（本 spec 回写 + R-A/R-B/R-C 入风险表 + 用例宿主表）= 已闭合；K2（CHANGELOG 逐条语句）= **待 Step 27 落笔**（R-C 已知问题句无条件写、R-A 发版说明只在 open Q1 取③时写）；K3（`host/index.ts:1701` 注释「spec Step 19」改 Step 11）= 已闭合；K4（`modelProviderNameDialog`/`modelProviderCardActions` 迁回 `tsx --test` 批）= **不可行**（`@/lib` 别名在 `tsx --test` 下解析失败，见 provider 实测），保持现批，登记为本仓测试基建限制；K5（调试残渣）= 已清（含根目录 `+m.length+`、`+x[2])`）。

## 风险与回滚方案

| 风险 | 缓解 | 回滚 |
|---|---|---|
| R1 侧栏 tripwire 碎（5 套字面量断言） | 重排保持断言行原文，只外围插入；**同步修改清单已写死**：projectSidebarVirtualProject.test.ts:48-54（Step 5 双视角裁定改写）、projectSidebarRemoteBackfill.test.ts:112-135（Step 2 directory 注册断言）+:139-143（Step 9 stub 注释断言）+:145-148（Step 9 managementEnabled 翻转）+:149-152（Step 4 Picker 注释断言）、package.json:32 test:v4-perf 摘除 directory 测试路径（Step 2） | phase 独立 commit revert |
| R2 Picker 真链点必败（服务层缺） | Step 1-2 先行服务层，Step 4 才挂 UI；**connectHost 分两段：Step 2 directory 版（不依赖 management）→ Step 7 切上游 management 版（替换时点已登记）** | 分步提交天然回滚 |
| R3 max-lines：index 380/400 | 豁免头预留（fork 先例） | — |
| R4 P9-3 上游面板依赖向导面 | 例外真实范围=RemoteConnectionProgress 134L+contract 类型+两函数最小实现+sourceServerStatusRegistry 72L（Step 9 写死）；面板不搬 wizard 壳 | 组件独立可 revert |
| R5 deployServer 删接线断 daemon | **阀=闸门不可拆**：本轮只删 server 侧 web 面路由+web 消费点；host 闸门/旧分支/阀保留即回滚阀；T-QA2 阀冒烟对象在 | LEGACY 阀本轮保留即回滚阀（下轮删时再评估） |
| R6 U10 大文件融合（8 文件 2-6k 行） | 压轴独立批次+逐 hunk+T-UF5+T-QA4 | 独立 commit revert |
| R7 胶囊误伤正文链接/代码块 | 白名单+fence 跳过+T-PR1 边界用例 | 富 API 独立函数可降级回 setText |
| R8 provider 交互与上游同构文件成为同步热点 | 登记为 fork 差异点（交互载体非业务逻辑） | — |
| R9 i18n 键重复插入破坏 --verify | 键级插入脚本幂等；P9 153 键先 diff 上游再插 | — |
| R10 队列/编辑双链改动碰 v1.0.21 bug A/B 修复面 | T-PR2/T-PR3 tripwire + routing 套件复跑；Step 21 落地即红 composerHeldQueueGuard:42-54 → Step 22 blocking 联动 | 分步 revert |
| R-A 空 settings 抢烧迁移账本 | 升级后**先**启动 web/server 入口（`packages/server/src/entry-http.ts:17` / `stdioServices.ts:38`），再启桌面端：0005 以空 settings 应用并记账 → desktop Worker 跳过 → 旧项目/连接入口**永久不迁移** | 三种解法（①非桌面入口自带 settings ②0005 seed 在「账本在但 seed 空」时补跑 ③接受并写发版说明）待拍板，本轮取默认①+风险登记；发版说明只在取③时写（见 CHANGELOG 条件句） | 不改迁移语义，可独立补丁 |
| R-B 未读角标双源 | 关闭通知后未读数变化：`root/useRootPlatformEffects.ts:270-274`（无门控）与 `project-sidebar/ProjectDirectoryProvider.tsx:72-74`（带 `notificationEnabled` 门控）并存，U12 后角标在任务栏/托盘可见，与门控语义矛盾 | 单一 owner 待产品裁定；本轮只在 spec 登记，不进 CHANGELOG | — |
| R-C host 上限裸错误码 | 接入第 21 台远端设备：`remote-projects/index.ts:41-50` 抛 `remote-project.host-limit`，全仓无 i18n 映射，UI 以原文串展示 | 后续批补 i18n 键；CHANGELOG 已知问题逐字登记 | — |

回滚总案：每 phase 独立 commit 链（预计 30-40 commits），单 phase 可 revert；发版按用户指令走 omz-publish，含打包启动冒烟门禁（smoke:desktop+verify:bundle-imports 为 v1.0.21 后常驻）。

## 拍板遗留（默认已定，可推翻）

1. deployServer desktop LEGACY 阀：本轮保留一轮（阀=闸门，删旧分支=删阀，故 host 面全留），下轮删（与 C10/R5 一致；用户未显式拍）。
2. 上游 footer banner 槽留空（SidebarBottomActivity 剔除后无内容注入）。
3. nav 与 ProjectSections 新建入口并存（上游形态保持）。
4. 队列行胶囊预览纳入本轮（Step 22，探索报告标可选）。
