---
date: 2026-10-23
---

# 上游 v3.16 全量纳入（fullsync）技术规格（SPEC）

## 需求来源

- 用户口述（2026-10-23 对话）+ 锚定 `docs/iterations/upstream-v3.16-sync/{summary,analysis-*}.md`
- 前置迭代：`upstream-v3.16-sync`（U1-U12，wave-1 已随 v1.0.20 发布；U5-U12 继续在该迭代分支推进）——**本迭代与其不重叠**
- 上游参照系：`.reference/ZCode` @ 3c5b2276（v3.16.2），对比基线 aac47556（v3.15.1）
- omz 基线：main @ 1ff8cad9（v1.0.20）

### 用户已拍板政策（不可回退）

1. **includeArchived 历史任务可删**——P0 数据风险降级，但替代语义（archived 列 + membership kind + 专用 API）须完整落地
2. **UI 以 omz 为准**——上游逻辑/后端照搬，UI 骨架保 omz
3. **MC 三端口重接以 MC 测试套件为门禁**——magic-context 是插件（transform/提示词段/工具描述三端口），重接后 MC 测试全绿 = 适配等价

### 本轮默认拍板项（四项，均可翻转，翻转只影响对应 phase 不影响骨架）

| 项                   | 默认                                                                               | 备选                                                              | 依据                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| office-runtime       | **不做**（2026-10-23 用户拍板「暂时不做」）                                        | 轻量（4 viewer SKILL + PreviewPane 增量）/ 全量（引 MCP Apps 栈） | omz 聊天内 office 预览已与上游平价（7 文件 6 个 identical）；全量工作主体是 omz 没有的面板宿主栈                                                                        |
| relay v2（手机远控） | **缓行**（不搬，含契约层；开源场景无服务器）                                       | 纳入（需同时解决外部 Go relay 部署/网关路由/OAuth 白名单）        | 运行前提全在基础设施侧；上游 7 项真机矩阵全部未执行；**另：omz 现存 relay v1 死 UI 应移除（用户拍板，见 phase-relay-v1-cleanup）**                                      |
| ToolSearch           | **纳入**（2026-10-23 用户翻转：工具延迟加载是 MCP 规模的合理优化，与工具多少无关） | —                                                                 | 源码 ~1.6k 行干净可独立（与虚拟项目零耦合实证）；成本大头是上游测试 82% 占比且 vitest 栈 omz 无——改为精简冒烟集；turn-loop 插入缝与 MC transform 顺序等价性重推演为前置 |
| 虚拟项目 UI          | **omz 骨架 + 上游功能组件 omz 化**                                                 | 完全自研薄 UI / 整搬 project-sidebar                              | 政策 2 的落地形态；Remote\* 组件随 source-server 三期再议                                                                                                               |

## 设计目标

把 v3.16 同步轮的排除面中「值得且可行」的部分全量纳入 omz：C1/C2 融合、虚拟项目存储层+UI 适配、source-server R3 三期、office 轻量、i18n 键级合并大头。产出可在 omz 现有产品形态上工作的对应功能，不破坏四红线（遥测/原生压缩/Magic Context/品牌）。

## 总体方案（范围图）

```text
纳入（本 spec 全量实现）
├─ i18n 键级合并（先行机械期，为后续所有功能期供文案弹药）
├─ C1 模型+Think 合并入口（thoughtLevelLabels 外提 → 合并控件，composerOptions 可选 prop）
├─ C2 组包管线统一（buildUserMessageEntries 统一三处装配；MC 挂点零改动）
├─ 虚拟项目（存储层全家照搬 + host 挂载 + tasksDatabase 换代 + includeArchived→membership + B7 两条绑定落地；UI=壳层保 omz + 功能组件 omz 化）
├─ source-server R3 三期（①daemon 地基 → ②连接核心+registry 恢复状态机[B5 吞并] → ③UX/身份/alias）
├─ ToolSearch（deferred 工具清单+按需加载+公告块；精简冒烟测试；MC 缝等价性前置推演）
└─ relay v1 死 UI 清理（omz 现存「移动端远程控制」对话框/触发器/侧栏入口/i18n 15×2 键，无后端永不可用——用户拍板移除）

缓行（登记不实现）：relay v2（开源无服务器前提）、office-runtime（预览已平价）
零基线排除（维持上轮结论）：conversationShare/manualClaimPlan/genUi/pluginUi/marketingTouch/rewards/highspeed/contextCompaction/off-peak
```

## 最终项目结构（新增面）

```text
packages/shared/src/sqlite-migrations/            # 通用迁移框架（12 文件 +906，照搬）
packages/shared/src/source-server/                # R3 契约/错误码/连接日志/兼容性/发布（893 行，一期）
packages/shared/package.json                      # + "./sqlite-migrations"、"./source-server" 子路径导出
packages/services/src/project-storage/            # 25 文件 +2878（照搬，0 依赖 source-server）
packages/services/src/{project,project-catalog,task-facts,task-groups,project-workspace-navigation,window-project-directory}/  # 42 文件 +3302（照搬）
packages/services/src/session/tasksDatabase/      # 迁移换代（+v4/v5 视 scope、删 startup.ts 按融合裁剪）
packages/desktop/src/host/database-startup/       # tasksStorageWorker+storagePreparation（+413，替代 omz hostDatabaseStartup.ts 旧摆放）
packages/desktop/src/host/source-server/          # 二期：serverRemoteConnection/DuplexTransport/ConnectionManager
packages/desktop/src/host/windowRemoteConnectionRegistry.ts  # 恢复状态机+epoch 重写（+~990）
packages/ui/src/chat-input-toolbar/Composer*.tsx  # C1 四组件+CSS+thoughtLevelLabels.ts
apps/zcode-cli/packages/core/src/agent/message-history.ts    # +buildUserMessageEntries（C2）
apps/zcode-cli/packages/core/src/tool/search/     # ToolSearch 全家（P8）
（不带）@radix-ui/react-collapsible@1.1.12 性能 patch —— 前迭代 U5 spec 已拍板「性能 patch 不带」（A1 源码修复已足够），本迭代维持不带入
```

## 变更点清单（按 phase；行号引用探索报告实证）

### phase-i18n（P0 先行）

- `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`：键级挑拣合并。白名单前缀桶：`chat.toolCall/chat.permission/settings.memory/settings.modelProvider/settings.plugins/settings.dynamicWorkflow/sidePane/browser/project.*/archives.*/taskGroup.*/workspaceSidebar.*/preview/fileManager/ssh/docker` 等（exp-3 §2.3 分桶）；目标增量 +400~600 键
- 硬约束：**omz 独有键集合合并后逐键存在（动态全量枚举断言；r1 实测 228，以实施时实测为准）**；`modelTrajectory.*` 18 键绝对保护；159 个双方值不同键逐键仲裁（默认上游新文案，轨迹面板相关保 omz）；**合并白名单桶内品牌键 0 残留（动态断言；上游独有值含 zcode/ZCode 字样实测 33，死桶部分天然不采，合并集内实改写数以实施时实测为准）**；顺手清 14 条 `conversationShare.*` 死键；上游 locale 头 `@/request-security-edition/messages.js` import 不采产品线则剔除
- 工具：node 脚本按 key 挑拣（**禁止三方 merge-file**——zh 双侧各自演化无共同基线，会重演 83 假阳性教训）；产出合并报告（added/kept/changed/dropped 四栏）入库

### phase-c1-composer（P1）

- Step A（S 纯重构）：新增 `packages/ui/src/chat-input-toolbar/thoughtLevelLabels.ts`（照上游 35 行）；`thoughtLevelOptions.ts` 改 import+re-export；`getThoughtLevelLabel` 改查外提函数；`isNoThoughtLevel` 参数收窄；消费方 `subagent-model-label.ts`/`list-models.tsx` 靠 re-export 零改动
- Step B（M）：新增 `ComposerModelMenu/ComposerProviderMenu/ComposerEffortHeading/ComposerTriggerTransition.tsx`+`composer-thought-slider.css`+`ControlShortcutBadge.tsx`；`ModelConfigSelect.tsx` 合入 composerOptions 可选分支（触发器三态 :538-593/锁宽 :599-605/pending 冻结 :244-264/选模型不关菜单 :407-412/挂载 :712-735）；`V4ComposerToolbar.tsx` 构造 composerOptions（无 providerMenu——走上游 `options.providerMenu?.groups ?? groups` 浏览回退 :123）并传入 :587
- **不动**：`contextUsage.tsx`（474 行 fork 面板原样）、`magicContextUsageRows.ts`、其余 ModelConfigSelect 消费点（composerOptions 缺席=旧行为）
- 产品决策（cr-func-c1 后精确化）：ThoughtLevelCycleControl **合并入口在场时退场、缺席（模型入口不可见）或档位非 select 时保底**（上游仅锁定态兜底——omz 两态均无；保底防触屏/窄侧栏无档位控件死角，Ctrl+T 循环保留；实现语义见 commit b95d2dd5）
- i18n：`chat.toolbar.combined.{provider,models,effort,selectModel}` 4 键×2 locale
- max-lines：ModelConfigSelect 预计超 400——按 fork 纪律（constraint #112）**拆分**（Composer 分支抽子组件）或沿用上游文件内 disable，spec 默认拆分

### phase-c2-assembly（P2）

- `core/src/agent/message-history.ts`：新增 `UserMessageAttachment` + `buildUserMessageEntries` + 分类谓词（isPastedInlineImageAttachment/promptAttachmentInputForResolvedAttachment/isFailedTextAttachmentPlaceholder，自 conversation.ts 迁入；**不带 D4 字段**——modelCallWrapper/toModelToolCall/compactBoundary/toolSearchAnnouncement metadata 一律不迁）
- `core/src/runtime/helpers/conversation.ts`：删内联装配（:106-158、:220+ 辅助），`buildRuntimeUserEntriesFromTurn` 改薄包装（保留 browserAmbient 前置）；**`buildUserContentFromTurn` 的 video 分支原样保留**（上游同源，防「照上游删」误伤）
- `core/src/agent/session-history-hydrator.ts`：:229-301 内联装配替换为 buildUserMessageEntries 调用 + real_user envelope 恢复规则（上游 :321-383 形态；**只圈「装配替换」子集**，上游 hydrator diff 里 logger 参数等无关改动不跟）
- **hydrator 漂移登记（cr-func-c2 核验定案，恢复向 live 收敛）**：①非媒体附件块正文前→后 ②有 source 的 text 附件同移 ③有 source 的读取失败占位保留→丢弃 ④**空 text 块过滤**（旧 preserveBlocks 保留 synthetic 产生的空 text 块，新路径被 `block.text.length > 0` 过滤=live 语义；cr-func-c2 补登，与①②同族，hasUserContent 判定不变）——①-③有 T-AS2 显式登记用例（test :832/:853/:867），④登记于此（后续可补用例）
- **MC 三端口零改动实证**（exp-1 §2）：transform 挂点 turn-loop.ts:119 不动；提示词段（context.ts:115）与装配解耦；工具描述（runtime-tools.ts:80-90）零改动
- **门禁**：MC 全套（bootstrap test-magic-context-turn-transform / magic-context/scripts/test-transform / historian / absent-event / usage-projection / mc-section-zh / lifecycle / config-rpc / memories-rpc / ui-config / ui-model-picker；core magic-context-section / section-ctx-note / ctx-tool-descriptions / ctx-search-memory / ctx-memory-archive；adapters boundaries/domain；ui magicContextPromptSurfaceOverrides；services magicContextMemoriesDegradation）+ 补 hydrator 装配回归脚本（omz core 无 hydrator 专用测试，实证空缺——新增 scripts/test-session-hydrator-assembly.mjs）

### phase-vproj-storage（P3）

- 照搬存储 7 目录（57 文件 +4243，0 依赖 source-server）+ `shared/sqlite-migrations`（+906）+ shared package.json 子路径导出 + `host/database-startup` 模块（+413，omz `hostDatabaseStartup.ts` 旧摆放迁移）
- tasksDatabase 换代融合：omz 已有自有迁移链；**不得整抄上游 migrations.ts**（async+scope+硬编码 appVersion），只把 0004_project_execution_scopes（executionColumns+`"nullable-text-v1"` checksumInput **逐字节冻结**）与 0006_task_group_admissions（TASK_GROUP_ADMISSIONS_SQL 原文含首尾换行）追加进 omz definitions 数组；编号保持上游原号（controller-remote scope 不带，无撞号实际冲突）；**禁改 0001-0003 checksumInput 常量**；红线纪律维持：不拷 schema-v1.ts/official-glm-selection-v3.ts（当前提交点拷贝虽不改 checksum，冻结纪律仍保留）
- includeArchived→membership 语义（政策 1）：taskIndexRepo `archived` 列 + membership kind 查询（pinned=`pinned=1 AND archived=0` / archived=`archived=1` / timeline=`pinned=0 AND archived=0`）+ `listArchivedTasks/deleteArchivedTask(s)/archive/unarchive` API + `emitWorkspaceTaskListChanged("task_archived"|"task_unarchived")`；协议 v4 `TaskListMembershipKind`；`zcodeSessionListParamsSchema` 删 `includeArchived` 字段；**删除 omz `repairSubagentTaskIndex.ts` 前先迁移其活跃依赖**（omz repair job 现依赖 `includeArchived:true`——改为 membership 查询语义）
- architecture-policy：每个新模块按 omz 规范登记（上游 module.ts 形态不适用，omz `ui/web/services` managed:false——照搬目录须适配 omz 的 architecture-policy.yaml 否则 `pnpm architecture:check` 失败）
- 测试重写：上游 22 个 services 测试（+3183）按 omz 形态重写为 `scripts/test-*.mjs`（精简为关键路径集，非全量）

### phase-vproj-ui（P4）

- 壳层保 omz：`WorkspaceShellLayout.tsx`（omz 1960 行 vs 上游 +2388/−2538 冲突块 57）逐文件三方比对人工融合——**禁止 merge-file 机械重放**；U10（前迭代）已落文件的融合基线按政策 6「先落地方为准，后到方融合」执行——双 spec 双改同一文件不冲突；`useAppPanels.ts`（上游 30 hunk=side-pane tab 作用域化+折叠记忆+office mode，0 个 project 符号）按 hunk 挑拣融合；`tabStore.ts` 侧栏面板编排适配
- 功能组件 omz 化：`ProjectNode/ProjectNodeContent/ProjectEditor(723L)/ProjectComposerMenu(630L)/TaskGroupedView(507L)` 等搬入 `packages/ui/src/project-sidebar/`，接入点改 omz 壳层、主题/尺寸链 omz 化；**Remote\* 7 组件 + useProjectRemoteSync 剔除**（随 phase-remote-ux 再议）；`Archive*` 2 组件随 membership 语义纳入
- 消费链：UI 经 `useBaseWorkspaceServices` → `IProjectService`（ServiceChannels.Project）——不碰 DB（上游实证 useProjectTree.ts:11）
- workbench：上游 v3.16 增量极小（+46/−407，删指针拖拽三件套）但 omz 12 文件全分叉——**本 phase 只做冲突消解不做上游化**：omz 已删/持有的文件维持 omz 现状，仅消除类型/编译面冲突；指针拖拽三件套去留=omz 产品现状优先（默认保留）
- 旧侧栏退役：omz WorkspaceSidebar 12 文件（−8.3k）中与新 project-sidebar 功能重叠部分按「omz 设计保留优先」原则逐个拍板去留（spec 默认：保留 omz 时间线/置顶视角组件，新增项目树/归档入口并存）

### phase-remote-daemon（P5=R3 一期，≈3300 行）

- shared `source-server/{contracts,errorCodes,connectionLog,compatibility,release}`（893）+ server `source-server/*`（861）+ desktop `serverRemoteDuplexTransport`（164）+ `serverRemoteConnection`（全文件 424 行：**一期仅取 duplex 形态 `connectServerRemoteOverDuplex` :359-424，同文件裁剪；WS 形态 :311-358 随二期**）+ zcode-server-cli packaging 发布描述（上游 packaging/ 8 文件 1255 行，按发布描述子集取）+ daemon `serve --daemon` 命令链
- **排除面（r1 补）**：cli.ts:8 `import { SourceServerWorkspaceAliasRepo } from "@zcode/services/node"` 与 :152-162 migrate retry 分支**不随一期**（该 2355 行 repo 属三期 Step 18；serve 主链不消费）——一期只移植 serve/status/stop/restart/update/uninstall + proxy-stdio
- 产出「远端常驻 daemon + 安装/升级 + 隧道握手」，**无 UX、不动 deployServer 旧主链**（共存政策：一期并行、二三期切换、终态退役 deployServer——退役计划写入 Step）
- Transport Adapter 接口（probe/installOrUpdate/ensureDaemon/openChannel/exec/createFileTransfer）照搬；SSH 走 ssh2 forwardOut、WSL/Docker 走 `zcode server proxy-stdio`
- 品牌面：`zcode server` 命令名/SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME/`~/.zcode` 路径→omz 成套改写；`serverRemoteInfoOutputSchema.parse` 强校验值同步改
- **品牌拍板（cr-func-r3a 回写）**：命令名/bin/zcode/归档名 zcode-server-<target>.tar.gz/ZCODE*\* env/\_\_ZCODE_PROBE*/com.zhipu.zcode.server 服务名与「ZCode Server」文案**成套保留**（远端机器侧 daemon CLI 侧存量生态，代码注释三处声明）；改写面=RELEASE_DESCRIPTOR（omz-server-release.json）/serverId fallback（omz-server）/数据根 ~/.omz/server 三处成套。上游 schema 本无品牌字面量，强校验改写自然满足
- **T-RM1 缩小形态登记（cr-func-r3a）**：T-RD 载体覆盖=命令注册/预算常量/裁剪守卫/单 Duplex 合同（agent 层）；connectServerRemoteOverDuplex 三请求同隧道端到端用例与 daemon 生命周期执行流并入 T-RM3 真机 SSH 验收（fake-duplex 端到端冒烟随二期 ConnectionManager 接线补）
- 验证：`verify-remote-ssh.mjs` 类脚本（真机 SSH 到测试机）

### phase-remote-core（P6=R3 二期）

- `SourceServerConnectionManager`（1460 行，可先裁 Directory/迁移/别名依赖做薄 owner 层——薄层需自定义「无 Directory 的 sourceServerId 稳定性」来源，install.json installationId 握手+重启对回设计写入 Step）+ registry 恢复状态机与 epoch（≈+990：closePhase 三态/transitionEpoch 捕获-校验/begin/complete/failRecovery promise 屏障/replaceDisconnectedSessions 换代/rollbackRecoveryReplacements）+ remoteWorkspacePreparation
- **B5 吞并**（政策：R3 采纳→B5 并入，不再单独做最小形态）：omz connect() 竞态实锤（registry :525-531 await 后无条件 online）由本 phase 恢复状态机整体解决；同时覆盖 cancelConnect 的 wsl/docker 路径迟到 completion 防护
- omz 自研 `replaceDisconnectedSource` 手动替换流（host/index:2047-2092）与上游 replaceDisconnectedSessions 语义重叠——本 phase 冲突消解，以上游状态机为准替换
- host/index.ts 事件接线（onDidChangeState/onDidReconnect/onDidInvalidateConnection → 重建 services 集合 + reconnectListeners）
- **实施拍板（Step 17 落地回写）**：①sourceServerId 稳定性来源=远端 install.json installationId（omz daemon 侧 installationOwnership 原子发布+resolveCoreServerId 每次启动复读，同一安装生命周期恒定；上游无此机制，靠三期 Directory.recordHandshake 持久化对回）——薄层身份对回=profile.sourceServerId 与握手 serverId 内存比对，漂移即 identity-change-pending 等待 confirmIdentityChange，应用重启后首连接受当前身份为基准（与上游新 Profile 首连同语义），跨控制端重启持久对回随三期 Directory；②薄层裁剪面=options.directory（recordHandshake/recordLastOnline/markSourceUninstalled）+admitConnection/commitMembership+effectiveProfile/alias 合并，profile 用轻量 SourceServerConnectProfile（profileId=connection key 派生稳定值），三期 Directory 接入时切回 shared ConnectionProfile；③WS 形态（上游 connectServerRemote :311-358）不回填，duplex-only 定案——其唯一消费方是 target.kind=server 直连分支，omz RemoteTarget 无该 kind（deployServer 旧链承载，退役见 Step 19），T-RD3 改为终局缺席守卫；④主链共存（一期政策延续）：本期 Renderer 主链仍走 deployServer 旧链（packages/ui 零触碰），daemon 分支经 connectManagedSourceServerHandle 在场、由 registry.connectSource/existingSourceServerId 触发，三期 remote-connection-flow 切换后成为主链，deployServer 链断线=terminal close（无自动恢复），B5 epoch 裁决与 cancelConnect 防护已覆盖该链；⑤workspaceIdentity 不做 remote:server:\* 强制归一（applyStableWorkspaceIdentity 收敛为 omz 键规则），identity 改写随 P7 契约评审，Source owner 收敛面照搬在场；⑥Controller replaceDisconnectedSource 升级 transaction 形态（canCommit/rollbackOnFailure+beforeCommit+discardSource），omz 手动替换流退役删除，换代由 registry onSessionReconnected 唯一承载，RemoteWorkspaceReconnected 协议行随三期 UX。

### phase-remote-ux（P7=R3 三期，≈+5k）

- `sourceServerDirectory`（1487）+ `aliasRepo`（2355）+ controllerRemoteIdentityMigration（318）+ entriesBySourceServerId 归属模型（实际承载=Directory settings 的 remoteConversationWorkspaceBySourceServerId+RemoteProjectDirectory{hosts,entries}，⑧已登记——cr-func-r3cde 勘误） + ui `remote-connection-flow`（index 2185 行）+ `remoteWorkspaceController` intent 模型 + `RemoteConnectionDialogContent/Fields` 重写
- **UI 以 omz 为准**：上游 project-sidebar Remote\* 7 组件此期回填（omz 化）；workspaceIdentity 冲突评审（上游 `remote:server:<sourceServerId>:<path>` 强制改写 vs omz `workspaceIdentity?.trim() || workspacePath` 键规则）——过 Workspace Identity 契约评审后拍板
- schema 迁移两支（230 行，controller-remote/source-server scope）随本期采纳（omz sqlite-migrations 框架三期后已具备）
- 测试用例别名注记（cr-func-r3b）：二期 T-RC 载体（windowRemoteConnectionRegistryRecovery.test.ts 8 用例）=本表 T-RM2 的自动化部分；T-RM3/T-RM4 真机矩阵不变
- 三期承接核对（cr-func-r3b P2-2）：replaceDisconnectedSource 旧手动流退役带走的 attachment 租约清理（detachRemoteSessionAttachments）与 Renderer 旧 sessionId 失效通知（RemoteWorkspaceClosed(reason:disposed)/RemoteWorkspaceReconnected postMessage）——remote-connection-flow 切换主链时显式核对，防换代后悬空
- 真机验收：SSH/WSL/Docker 三通道 × 断连恢复/换代/升级矩阵
- **实施拍板（Step 18/19a 落地回写，2026-10-24）**：
  - ①Step 18 存储与目录已落（570c0f3e）：`sourceServerDirectory`+`connectSourceServerTarget` helper+`aliasRepo`+`controllerRemoteIdentityMigration`+`offPeakWorkspaceIdentityMigration`（上游 35 行，OFF_PEAK_TERMINAL_STATUSES 内联冻结字面量——D6 off-peak 家族不随本期）+migrations scope 三分（base/controller-remote/source-server，omz 同步 runner 保留）。两支 schema 文件（controller-remote-schema-v4/source-server-schema-v5）与上游**逐字节一致**，冻结基准 sha256(JSON.stringify(checksumInput))：0004_controller_remote_identity=`16dc0d2c…c09a`、0005_source_server_workspace_schema=`f9b295f5…ed8c`（T-RU1 断言）。品牌口径：数据目录 `.zcode`→`.omz`、审计表 `zcode_database_identity`→`omz_database_identity`（沿 P3 legacy 口径）。aliasRepo 一期排除面解禁：zcode-server-cli `migrate retry` 分支+`workspaceAliasRepo` 注入口回接。`UpdateConnectionProfileInput` 契约出口落 `source-server-management/`（ISourceServerManagementService 频道面随 P9 设置页批挂账）；`sourceServerMigrationCounts`（管理统计投影）随 P9。
  - ②**server 直连传输不随本期**：上游 RemoteTarget `kind:"server"`（ServerConnectOptions 直连 URL）在 24 文件深植，omz RemoteTarget 维持 ssh/wsl/docker 三形态；sourceServerDirectory routeKey/legacy 排除面的 server 分支按 omz 裁剪并留注释（server 传输批回补时连同上游语义恢复）；shared identity 层仍落全 `remote:server:` 构造/解析（身份形态与传输形态解耦）。
  - ③**workspaceIdentity 契约拍板**：本机键规则不变（`workspaceIdentity?.trim() || workspacePath`）；daemon 远端 workspace 用上游 `remote:server:<sourceServerId>:<path>` 形态 identity，经既有 workspaceIdentity 字段参与 omz 键规则——两契约可调和，无强制改写冲突。依据：①omz 键规则只定义「有 identity 用 identity、无 identity 用 path」，上游 remote:server: 形态恰是 daemon workspace 的 identity 值，不要求改写本机键；②tabStore P4.2 已支持 identity 键（resolveWorkspaceKey 读旧写新无迁移）；③deployServer 旧链继续用 `remote:ssh/wsl/docker:` route identity，两链并行键面不交叉；④`buildServerRemoteWorkspaceIdentity`/`parseRemoteWorkspaceIdentity(kind=server)`/`remoteHostIdFromWorkspaceIdentity`+`buildRemoteHostWorkspaceIdentity` 统一工具已落 shared（P4 死导出 `projectSourceServerId` 的消费工具就位，接通随 Remote\* 回填批）。
  - ④Step 19a 阶段落（5df39270+165dec1b）：UI 纯逻辑层（`remote/remoteWorkspaceController`+`useRemoteWorkspaceController`、`remote/remoteWorkspaceProjection`、`lib/remoteConnectionPresentation{,Types,Errors}`+`remoteConnectionEntryBehavior`）+ i18n `remote.status.*/remote.error.*/remote.action.*/remote.conversation.sendUnavailable/settings.source.error.*` 117 键×zh/en 成对落键；**恢复换代通知链闭合**（cr-func-r3b 承接核对①-2）：HostResponseTypes.RemoteWorkspaceReconnected+schema+PlatformChannels.RemoteSessionReconnected+RemoteSessionReconnectedEvent 全协议行 → host onSessionReconnected commit 后 postMessage → main handleReconnected（路由换代重登记+Provisioning lane 按 Environment 重上线+attachRendererPort(source-server-reconnected)+广播；webRemoteControlManager.replaceRemoteSession 随 relay v2 挂账 P9）→ preload/renderer `onRemoteSessionReconnected` → useRemoteWorkspaceHistory 换绑 tab+清重连中标记+session registry 重绑。承接核对①-1（attachment 租约清理）核对结论：omz onSessionClosed 在失效源头统一 detach（host/index onSessionClosed→detachRemoteSessionAttachments），换代路径旧 close 事件先于 commit，无需 connect 时补 detach——无悬空。
  - ⑤挂账回补核对：daemon services 通道核对结论=legacy 19 通道断言（assertLegacyRemoteWorkspaceRpcContract）在 createRemoteWorkspaceServiceCollection 入口对 daemon 分支同样生效（同 collector），上游 daemon 38 通道全集不采纳（omz 窄面政策），`ISourceServerWorkspaceService` 通道（resolveWorkspace/bindWorkspaceIdentity 回执）随 identity 绑定回执批；composer 正文草稿 taskGroupId 面=composerDraftStore 深度重写（omz 213L→上游 429L，分组草稿继承），非独立字段可回补——随 TaskGroupedView 草稿行批挂账；remote-viewing 状态回填（observeRemoteViewing 缝）属主=relay v2 手机查看态，挂账 P9 relay 批。
  - ⑥剩余挂账（Step 19a 后续批）：remote-connection-flow 向导壳（WizardChrome/app-shell preference/目录选择流）、RemoteConnectionDialogContent/Fields 重写、Remote\* 7 组件+useProjectRemoteSync 回填、useProjectTree 三缝（remoteService/isRemoteViewing/sourceServerId）真接通、主链切换（deployServer→connectSourceServerTarget，Directory 实例化+membershipIntent 消费）、identity 绑定回执（prepareWorkspaceIdentity 第三参）、`projectSourceServerId`/`view.ts` 消费接线、remoteConversationWorkspaceBySourceServerId 消费。deployServer 旧链共存退役拍板留 P9/发布轮（Step 19）。
- 用例表补登（cr-func-r3cde P3-1）：T-RU6 composer 分组草稿（13 例，composerDraftTaskGroup）/T-RU7 主链切换路由（10 例，connectMainChainSwitch）/T-RU8 三缝形状（5 例，projectSidebarRemoteSeams）/T-RU9 host 投影真单元（6 例，remoteProjectDirectoryService）/T-RU10 回填守卫（13 例，projectSidebarRemoteSeams 与回填清单）——均已挂 test:v4-perf；T-RU4 换代通知链（4 例，remoteWorkspaceReconnected）
  - ⑦**r3d 续批落地回写（2026-10-24，919cc8c9+e65a7fa8+a7676061）**：⑥挂账三项闭合——**composer 分组草稿批**（composerDraftStore 深度重写 429L 形态：ComposerScope 三元分 key+taskGroupId/projectId 组织意图继承+PendingTaskDraft 家族+legacyClaimed；useDraftConfigControl/useRootWorkspaceActions/TaskGroupedView 接通，查看会话渲染分组内草稿行；omz 自研字段与空白删除语义保留；T-RU6）；**主链切换**（createWindowRemoteConnectionHandle 主链 early-return 走 daemon 分支，Profile 经 Directory.ensureProfile/connectSourceServerTarget 产出、薄层内存键废除；ZCODE_REMOTE_DEPLOY_SERVER_LEGACY=1 环境开关保留旧链回滚预案，deployServer 体零删除共存；Directory 单例实例化+Manager options.directory 窄接口 recordHandshake 落盘+持久 identityChanged 判定；membershipIntent 全链透传，membership repo 的 admitConnection 面挂账 IRemoteProjectService 批）；**identity 绑定回执链**（services/source-server-workspace 三件照搬+createServerHostServices 换装 daemon serve+SourceServerWorkspace 通道+client getter+窗口集合条件注册（legacy 断言保持 19 通道旧链兼容）+capabilities.bindWorkspaceIdentity（legacyRouteHint→resolveWorkspace，旧 Source 缺席降级）+recordWorkspaceOpen+zcode-cli http 包 identity wire seam；topicResourceRelayChannel/projectStorageHostId omz 裁量挂账）；**三缝数据面**（useProjectTree remoteService 接 base accessor+directory 投影 state 化+observeSources 照搬+scopes remote identity 参与订阅；view.projectSourceServerId 恢复 server kind 解析；accessor 增可选 remoteProjectService；T-RU8）。**剩余挂账（Step 19a 三批）**：host 侧 IRemoteProjectService omz 实现（sourceServerDirectory 数据面投影）+Local Host 注册+RemoteServiceAccess getter、Remote\* 7 组件+useProjectRemoteSync 回填（上游 13 文件 ≈1.9kL，omz 化照搬含 i18n 键核对）、RemoteConnectionDialogContent/Fields 重写（790L/1169L）、remote-connection-flow 向导壳（2185L）+壳层接入（参照 P4 挂载模式）、remoteConversationWorkspaceBySourceServerId 消费接线。remote-viewing 缝位注释确认在位（属主 relay v2/P9，未动）。
  - ⑧**r3e 末批落地回写（2026-10-24，1acbeba7+50f8af7e+a2f4e7f7）**：⑦剩余挂账主链闭合，两条主代理拍板落地——**拍板 A（向导壳不搬，按 UI 保 omz 政策关闭）**：remote-connection-flow 向导壳（2185L）+RemoteConnectionDialogContent/Fields 重写（790L/1169L）不迁移，omz 现有 RemoteConnectionDialog/SSHDialog 链即连接入口 UI（已走 daemon 主链）；连带挂账面=remote-project-connection.ts（requestRetainedRemoteProjectConnection 向导交接）、remoteConnectionWizard 的 buildRemoteTargetFromProfile/findPreferredSourceConnectionProfile 导出、app-shell RemoteConnectionOpenPreference 类型、Root 的 RemoteProjectPresentationProvider 挂载、onOpenRemoteWorkspace preference 形态（omz 恒 () => void）——随向导壳批（如启用）或 P9 一并裁决。**拍板 B 落地（host 侧）**：`createDirectoryRemoteProjectService`（packages/desktop/src/host/remoteProjectDirectoryService.ts）——omz 有意漂移三条：①entries 恒空集（上游 hosts/remote_project_entries SQLite 表不建，远端权威项目入口缓存随 P3 vproj-storage 开放，侧栏不凭空出现离线行）；②membershipId=sourceServerId（同设备即同成员，换代判定归 Directory.recordHandshake 权威）；③saveHost/removeHost/addEntry 写面显式错误挂账（上游消费方在向导壳/设备卡/设置页），connectHost 真连（Directory.resolveSilentConnectionTarget 复用启动重连凭据链+Manager.connect retain 意图），bindHost 返回投影/迟到 null，refreshEntry 恒 false，removeEntry 幂等 no-op。**注册链**：Local Host initializeServices 内 services.register（先于 base attachment expose，惰性取用 ensureSourceServerDirectory/ensureSourceServerConnectionManager 单例）→client RemoteServiceAccess remoteProjectService getter→accessor 可选缝（r3d 已落）即通；daemon/远端 workspace 集合不注册（控制端本机目录服务，omz 窄面政策）。**admitConnection 裁量（⑦挂账核对结论）**：上游 createRemoteProjectConnectionAdmission 的落点=saveHost/bindHost 持久化（hosts 表）；omz 无表可写且握手对回已由 Manager recordHandshake 窄接口完成——**不补 admitConnection 完整面，维持 r3d recordHandshake 窄接口**（connection-membership.ts 不搬）。**拍板 B 落地（UI 侧，19 文件）**：Remote* 7 组件（RemoteProjectList/Menu/Picker/HostSection/IdentityHoverCard/ConnectionProgressSection/ConversationDisconnected）+useProjectRemoteSync+useRemoteProjectConnectionPresentation+remote-navigation（attachRemoteProjectWorkspace）+OfflineRemoteProjectRows+依赖层（RemoteConnectionStateIcon/RemoteConnectionTags/RemoteProjectConnectionDetails/remoteOperationProgress/sourceIdentity/useSourceServerStatuses/RemoteProjectPresentationContext/useSourceServerOperationLogs）+useProjectConnectionDiagnostics；**占位拆除**：index remoteActions 恒空/useProjectTaskNavigation attach 占位/ProjectNodeContent HoverCardSlot 直通包装/ProjectDirectoryProvider deviceNames 恒空表全部退役，ProjectSidebarNode connect 动作（Plug）+onRemoveEntry+onCreate hostId 透传接真，remoteSync.dialog 挂载。**omz 化漂移登记**：omz RemoteTarget 无 server kind（拍板②）→sourceIdentity 守卫分支/remoteHostLabel server case 随传输批回补；RemoteWorkspaceSession 无 workspaceIdentity 字段→useProjectRemoteSync/useProjectTaskNavigation 等价改读 sessionIdByWorkspaceIdentity 索引；shouldShowRemoteSyncActions 维持 omz ssh/wsl 口径；RemoteConnectionProgressSection management 缝（sourceServerManagementService）恒降级 connecting 进度段（P9）；useSourceServerStatuses 恒空投影（registry 随 P9）；RemoteProjectList 裁 legacySingleRoot（P3）；RemoteProjectMenu 设备数据源改 ProjectDevice 投影；ProjectCreation 维持 P4 本机形态（三依赖全挂账，不扩设备选择面）；remotePicker 触发面不挂载（readTree hostId 路由 resolveHost 面随 P3）。**主题/i18n**：remote token 四主题段（progress/remote-muted/destructive-surface/ssh/wsl/docker 色板）并入 omz styles.css；16 键×zh/en 成对（remote.progress.*/remote.conversation._（除已 sendUnavailable）/remote.phase._/settings.source.\*）；TID_VIRTUAL_PROJECT_ADD 入 shared test-ids。**测试 T-RU9/T-RU10**：host 投影真单元 6 用例（fake Directory/Manager：投影三态/identity 往返/connectHost retain+凭据缺席/写面挂账边界/local 拒绝）+回填形状守卫 13 用例（清单/接线/占位拆除/host 注册链/挂账注释/纯逻辑 sourceIdentity+remoteOperationProgress+remoteHostLabel/i18n 成对/token 四段），挂 test:v4-perf。**剩余挂账（P7 收口后）**：remote-connection-flow 向导壳族（拍板 A 关闭面，含 RemoteProjectMenu 设备子菜单 preference 形态）、remoteConversationWorkspaceBySourceServerId 消费、P3 持久化批（entries 表+resolveHost 路由+legacySingleRoot+RemoteProjectPicker 挂载）、P9（management 服务+registry+设置设备卡+设备设置跳转+ProjectCreation 设备选择面）。deployServer 旧链共存退役拍板留 P9/发布轮（Step 19）。

### phase-toolsearch（P8；依赖 phase-c2-assembly 完成后再动 message-history/turn-loop 面）

- 搬入 `core/src/tool/search/`（5 文件 531 行）+ deferred 2 文件（tool/deferred-call.ts 59L + handlers/deferred-tool-call.ts 57L）+ contracts（94）+ adapters model/tool-search.ts（31）+ hydration（29）+ `handlers/tool-search.ts`（81）
- **前置推演（blocking）**：turn-loop 插入缝等价性——上游把请求组装换成 `prepareRuntimeProviderRequest`（工具暴露决策内化）；omz 缝序为 turn-loop.ts:119 `runMagicContextTurnTransform` → :131/:141 投影。落地顺序定为「MC transform → 工具暴露决策 → 投影」，写等价性证明进迭代文档；推演不通即停该 phase（回滚=不并入）
- contracts `model/index.ts` 增 tool_reference/deferLoading/toolSearchEnabled 三字段（+17）；MCP descriptor/pool 集成点照搬
- omz 自研工具 defer 政策：内置核心工具（含 ctx\_\*/guarded/ 全部自研面）**默认不 defer**，MCP 工具默认 defer——写成显式分类表（shouldDefer 判定入口）
- D4 持久层渗入最小化：message-history 的 modelCallWrapper/toModelToolCall/compactBoundary/toolSearchAnnouncement metadata 落盘字段**不迁**；公告块只在投影层生成不进 message-history
- 上游 turn-loop diff 混入物隔离：refreshOffPeakTurnAfterTakeover/persistRuntimeReminderMessage/buildProjectionAnchor 一律不迁
- UI 侧：settings.toolSearch 4 键设置面 + T08 resolveRenderer 分流按 omz 现状最小接入
- 测试：精简冒烟集 5-8 条（defer 决策纯函数/按需 hydration/公告块投影/tool_reference 卡渲染/MC 全套仍绿），不重写上游 28 用例
- **D4 口径登记（cr-func-ts-relay）**：RuntimeMessageMetadata 增内存可选 toolSearchAnnouncement 字段作为公告载体（持久层/hydrator 0 触碰，落盘字段仍不迁）——「公告块只在投影层生成不进 message-history」以「内存元数据载体」口径实现；另清两死函数（skipAdjacentUserMessageMerge/prepareRuntimeProviderRequest）

### phase-relay-v1-cleanup（P9，独立小项可先行）

- 删 `packages/ui/src/WebRemoteControlDialog.tsx`（「移动端远程控制」对话框）+ `WorkspaceWebRemoteControlTrigger.tsx`（触发器）
- `WorkspaceSidebarFooter.tsx` 移除入口接线
- i18n 删 `webRemoteControl.*` 15 键 ×2 locale（zh :1630-1644 一带 + en 对应段）；Bot Channels（微信/飞书/Lark/Telegram）死链核验——若「去 Bot Channels 配置」指向不存在的设置页，死链引用面一并清理
- 断言：清理后全仓 webRemoteControl/WebRemoteControl 0 命中（docs/ 历史文档除外）；knip/lint/typecheck 绿

### phase-gates（P10 收口）

- 全门禁：root typecheck / cli turbo / typecheck:desktop-full / lint（**实施前重采基线，终态零新增警告**）/ knip（**终态一次采集基线**；中间态 phase 门禁跳过 knip——一期 serverRemoteConnection、存储层等中间态无消费方属预期，终态才有消费方）/ oxfmt / v4-perf / cli-backport / ui/services/desktop 三聚合 + 本迭代新增测试聚合脚本
- CHANGELOG（下版本）+ UPSTREAM-SYNC.md 基线表更新到「v3.16.2 全量纳入（除缓行/排除面）」

## 详细实现步骤

- Step 1 — phase-i18n — blocking: yes — qa: auto — 写键级挑拣脚本（输入双侧 locale，输出合并文件+四栏报告）；跑白名单桶合并；omz 独有键全量硬断言（r1 实测 228，动态枚举）；合并集内品牌键 0 残留（上游含品牌值实测 33）；159 值冲突仲裁表落盘 docs/iterations/upstream-v316-fullsync/i18n-arbitration.md
- Step 2 — phase-i18n — blocking: yes — qa: auto — check-i18n-parity（若 omz 有该脚本）过 + 轨迹面板 key 抽查真机文案；合并报告入库
- Step 3 — phase-c1-composer — blocking: yes — qa: auto — thoughtLevelLabels.ts 外提 + thoughtLevelOptions.ts re-export 化（纯重构，消费方零改动验证）
- Step 4 — phase-c1-composer — blocking: yes — qa: auto — 新增 4 Composer 组件 + CSS + ControlShortcutBadge（若前迭代 U5 已落则复用）；ModelConfigSelect 合入 composerOptions 分支（拆分控 max-lines）；`useComposerToolbarFit` 在 U10 落地结果上追加 `[data-composer-combined-model]` 分支（上游 :47-59——合并入口末级折叠时保绿条、跳过 provider-prefix/thought 图标压缩段；omz 现文件无此分支；政策 6 后到方融合）
- Step 5 — phase-c1-composer — blocking: yes — qa: manual_user — V4ComposerToolbar 接线（composerOptions 构造+传入；ThoughtLevelCycleControl 合并入口在场退场/缺席保底）；真机验收合并入口交互（选模型不关菜单/滑杆调档/窄屏 back 模式/触屏）
- Step 6 — phase-c2-assembly — blocking: yes — qa: auto — message-history.ts 增 buildUserMessageEntries+谓词（不带 D4 字段）；conversation.ts 内联装配删除改薄包装（video 分支保留）
- Step 7 — phase-c2-assembly — blocking: yes — qa: auto — hydrator :229-301 装配替换（只圈装配子集）；新增 scripts/test-session-hydrator-assembly.mjs
- Step 8 — phase-c2-assembly — blocking: yes — qa: auto — **MC 全套门禁跑绿**（§phase-c2-assembly 清单）；core typecheck
- Step 9 — phase-vproj-storage — blocking: yes — qa: auto — shared/sqlite-migrations 照搬+子路径导出；omz architecture-policy.yaml 登记新模块
- Step 10 — phase-vproj-storage — blocking: yes — qa: auto — 存储 7 目录照搬+host/database-startup 挂载（hostDatabaseStartup.ts 旧摆放迁移）；services 测试关键路径重写 scripts/test-\*.mjs
- Step 11 — phase-vproj-storage — blocking: yes — qa: auto — tasksDatabase：0004/0006 追加（checksumInput 逐字节冻结）+ 全链迁移冒烟（老库升级不 checksum_mismatch）
- Step 12 — phase-vproj-storage — blocking: yes — qa: auto — includeArchived→membership：archived 列+kind 查询+专用 API+事件+协议 v4 类型+schema 删字段；**消费面全量清单（r1 实测 9 文件）**：shared zcode-protocol/index.ts（zcodeSessionListParamsSchema）、services zcode-agent/{zcodeAgent,zcodeAgentService}.ts、services zcode-session/zcodeSession.ts、adapters storage session-store/repositories/sessions.ts、bootstrap zcode-protocol/{server-operations,v4-bridge}.ts、contracts interfaces/session-store.port.ts、services zcode-agent/repairSubagentTaskIndex.ts:27（includeArchived:true，消费方 zcodeTaskIndexSyncer.ts）——以上游同批 diff 文件集为准逐个适配，typecheck 收敛后删除 repairSubagentTaskIndex
- Step 13 — phase-vproj-ui — blocking: yes — qa: manual_user — WorkspaceShellLayout/useAppPanels/tabStore 壳层三方融合（逐 hunk，禁 merge-file）
- Step 14 — phase-vproj-ui — blocking: yes — qa: manual_user — project-sidebar 功能组件 omz 化接入（Remote* 剔除/Archive* 纳入/旧侧栏去留逐个拍板执行）；真机验收项目树/归档/分组
- Step 15 — phase-vproj-ui — blocking: yes — qa: auto — workbench 冲突消解（只消解不上游化；指针拖拽三件套默认保留）
- Step 16 — phase-remote-daemon — blocking: yes — qa: manual_user — shared/server source-server 契约+duplex+serverRemoteConnection+packaging+daemon 命令链；品牌面成套改写；verify-remote-ssh.mjs 真机 SSH 验证
- Step 17 — phase-remote-core — blocking: yes — qa: manual_user — ConnectionManager 薄 owner 层（sourceServerId 稳定性设计落地）+registry 恢复状态机/epoch（B5 吞并，含 wsl/docker 迟到 completion）+host 事件接线+replaceDisconnectedSource 冲突消解；真机断连恢复矩阵
- Step 18 — phase-remote-ux — blocking: yes — qa: manual_user — Directory+aliasRepo+identityMigration+remote-connection-flow+Remote\* 组件回填+workspaceIdentity 契约评审；三通道真机验收
- Step 19 — phase-remote-ux — blocking: no — qa: manual_user — deployServer 旧主链退役（二三期切换完成后的终态；退役清单+回滚预案）
- Step 20a — phase-toolsearch — blocking: yes — qa: auto — turn-loop 缝等价性推演文档（MC transform→暴露决策→投影）先行落盘；不通即停
- Step 20b — phase-toolsearch — blocking: yes — qa: auto — tool/search 全家搬入+contracts 三字段+MCP 集成+defer 分类表（内置不 defer/MCP defer）+D4 渗入隔离；精简冒烟集 5-8 条 + MC 全套仍绿
- Step 20c — phase-relay-v1-cleanup — blocking: yes — qa: auto — 删 WebRemoteControlDialog/Trigger+侧栏入口+i18n 15×2 键+Bot Channels 死链核验；0 残留断言
- Step 21 — phase-gates — blocking: yes — qa: auto — 全门禁聚合+CHANGELOG+UPSTREAM-SYNC.md 基线表+迭代收口（cr-func-fullsync）

## 测试策略

形态纪律：omz 无 vitest——全部 CLI/services 测试= `scripts/test-*.mjs`（node:test）；UI=`packages/ui/test/*.test.ts`（node test）；真机项=manual_user 合并后用户验收。

### 测试用例

- T-I1 — blocking: yes — 合并后 zh/en 键集合断言：omz 独有键全在（动态全量枚举，r1 实测 228）、白名单桶键全进、死桶键 0 进入（→Step 1/2）
- T-I2 — blocking: yes — 合并集内键值 0 处 zcode/ZCode 字样残留（动态全量断言；参考：上游独有含品牌值 33，死桶部分天然不进）（→Step 1）
- T-CP1 — blocking: yes — thoughtLevelLabels 外提后三消费方（工具条/workflow 子代理/list-models）标签等价（→Step 3）
- T-CP2 — blocking: yes — composerOptions 缺席时 ModelConfigSelect 旧行为快照等价（零破坏断言）（→Step 4）
- T-CP3 — blocking: no — 合并入口交互（选模型不关菜单/Effort 滑杆/pending 冻结/窄屏 back）真机 manual（→Step 5）
- T-AS1 — blocking: yes — buildUserMessageEntries 四分类（粘贴图入正文/text 附件独立条目/读取失败丢弃/其余入正文）单测（→Step 6）
- T-AS2 — blocking: yes — hydrator 装配回归（real_user envelope 恢复规则）新脚本（→Step 7）
- T-AS3 — blocking: yes — **MC 全套绿**（12+ 引用套件，§phase-c2-assembly 清单）（→Step 8）
- T-VS1 — blocking: yes — sqlite-migrations runner：备份/恢复/legacy 探测（→Step 9）
- T-VS2 — blocking: yes — ProjectRepository CRUD+ProjectTree 装配关键路径（重写自上游 22 测试的精简集）（→Step 10）
- T-VS3 — blocking: yes — 老库升级冒烟：0001-0003 checksum 不变+0004/0006 应用成功（→Step 11）
- T-VS4 — blocking: yes — membership 查询三分支+archive/unarchive 事件+includeArchived 字段删除后协议面编译断（→Step 12）
- T-VU1 — blocking: yes — useProjectTree 经 useBaseWorkspaceServices 消费 IProjectService 冒烟（→Step 14）
- T-VU2 — blocking: no — 项目树/归档/分组真机 manual（→Step 14）
- T-RM1 — blocking: yes — daemon 生命周期（serve/status/stop/restart/update）+握手三请求复用同 Duplex 单测（→Step 16）
- T-RM2 — blocking: yes — registry 状态机：closePhase 三态流转/epoch 违例抛 StaleError/recovery 屏障/换代回滚单测（→Step 17）
- T-RM3 — blocking: no — SSH 真机：安装→连接→断连→自动恢复→换代（→Step 16/17/18 各自真机节）
- T-RM4 — blocking: no — WSL/Docker 通道真机+cancelConnect 迟到 completion 防护（→Step 17）
- T-RU1 — blocking: yes — 两支专属 scope 迁移 checksum 冻结基准（0004c/0005s）+scope 三分互斥（base 链无专属迁移）+落表断言（→Step 18）
- T-RU2 — blocking: yes — controller-remote 身份迁移改写（workspace_key/identity/meta_json/审计账本）+remote:server identity 形态构造/解析/hostId 往返+aliasRepo 空目录解析与失败统计（→Step 18）
- T-RU3 — blocking: yes — remoteWorkspaceController intent 分发/拒绝 + projection 设备×历史×attachment 联接（identity 隔离/本地 tab 不冒充）+presentation 错误分类矩阵与状态机（→Step 19a）
- T-RU4 — blocking: yes — 恢复换代通知链五层形状守卫（协议行/host commit 后必发/main 重挂+回收/renderer 换绑）（→Step 19a）
- T-RU5 — blocking: no — remote-connection-flow 向导+Remote\* 7 组件回填+主链切换后真机 manual（并入 T-RM3/T-RM4 真机矩阵）（→Step 19a 后续批）
- T-TS0 — blocking: yes — 缝等价性推演文档评审通过（MC transform→暴露决策→投影，含反例分析）（→Step 20a）
- T-TS1 — blocking: yes — defer 决策纯函数（内置不 defer/MCP defer 分类表）+按需 hydration 单测（→Step 20b）
- T-TS2 — blocking: yes — 公告块投影+tool_reference 卡冒烟 + MC 全套仍绿（顺序等价门禁）（→Step 20b）
- T-RV1 — blocking: yes — relay v1 清理后全仓 0 残留断言（src+i18n；docs 历史文档除外）+knip/lint/typecheck 绿（→Step 20c）
- T-G1 — blocking: yes — 全门禁聚合（→Step 21）

### 验收矩阵

| Step    | T 用例                            | 自动/真机   |
| ------- | --------------------------------- | ----------- |
| 1-2     | T-I1/T-I2                         | auto        |
| 3-5     | T-CP1/T-CP2/T-CP3                 | auto+manual |
| 6-8     | T-AS1/T-AS2/T-AS3                 | auto        |
| 9-12    | T-VS1-4                           | auto        |
| 13-14   | T-VU1/T-VU2                       | auto+manual |
| 15      | 并入 T-G1（typecheck/门禁面验证） | auto        |
| 16-19   | T-RM1-4                           | auto+manual |
| 18-19   | T-RU1-4（T-RU5 真机并入 T-RM3/4） | auto+manual |
| 20a-20c | T-TS0/TS1/TS2、T-RV1              | auto        |
| 21      | T-G1                              | auto        |

## 风险与回滚方案

| 风险                                                                         | 等级 | 缓解/回滚                                                                                                                              |
| ---------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 壳层融合冲突（WorkspaceShellLayout 57 冲突块/useAppPanels 30 hunk/tabStore） | 高   | phase 隔离：vproj-ui 独立分支点；逐 hunk 三方比对留痕；回滚=该 phase 单独 revert，存储层不受影响                                       |
| DB 迁移 checksum_mismatch（老库启动即炸）                                    | 高   | 逐字节冻结纪律+T-VS3 老库冒烟；回滚=迁移定义 revert（ledger 已应用记录不动，新增条目跳过幂等）                                         |
| MC 行为漂移（C2 装配统一后）                                                 | 中   | T-AS3 全套门禁；漂移即停 C2 发布，C1/C2 独立提交可单独 revert                                                                          |
| R3 二期薄 owner 层的 sourceServerId 稳定性设计缺陷                           | 中   | install.json installationId 握手+重启对回设计先行评审（Step 17 内嵌评审点）；不可行则回退带 Directory 依赖的完整 Manager               |
| 两套主链并存期（deployServer vs daemon）                                     | 中   | Step 16 只加不删；退役在 Step 19 且带回滚预案                                                                                          |
| 虚拟项目 UI omz 化工作量超估（组件主题/尺寸链适配）                          | 中   | Step 14 拆分提交；组件逐个接入，卡住的单组件降级为「仅存储层+最小入口」                                                                |
| 真机矩阵覆盖不足（SSH/WSL/Docker×恢复/换代/升级）                            | 中   | T-RM3/4 真机清单显式化；上游 24 条 open issues 中 registry 恢复相关项（005/006/011/020/021/023/024）作为已知风险登记，不视为本迭代必修 |
| office 轻量后用户反馈要面板形态                                              | 低   | 翻转默认拍板→新开 phase-office-full（MCP Apps 栈评估轮）                                                                               |

## 基线政策与红线（横切）

1. **四红线不可回退**：遥测（@arms/rum-electron 禁带；7 组遥测 import 成对面清单见 exp-4 §4C，移植涉及文件时逐对剔除）、原生压缩、Magic Context（三端口接线不动）、品牌（ZCODE\_\* 键名保留；`~/.zcode`→`~/.omz` 路径成套改写；27 i18n 品牌键改写）
2. **禁 merge-file 机械重放**：所有交集文件（壳层/useAppPanels/ModelConfigSelect/message-history/hydrator/migrations）逐 hunk 三方比对
3. **D4 字段隔离（ToolSearch 纳入后重定义）**：C2 阶段（Step 6-8）message-history 不带任何 D4 字段；phase-toolsearch 阶段公告块只在投影层生成、D4 持久层渗入字段（modelCallWrapper/toModelToolCall/compactBoundary/toolSearchAnnouncement metadata 落盘）不迁；上游 turn-loop diff 混入物（refreshOffPeakTurnAfterTakeover/persistRuntimeReminderMessage/buildProjectionAnchor）一律不迁
4. **office/relay 相关遥测与 plugin-ui 面**自然不引（栈不搬）
5. **max-lines 400** 维持（constraint #112）；新文件超限拆分
6. **U5-U12 边界**：前迭代 spec 继续；本迭代不动其 12 项范围；共享文件（如 PreviewPane——前迭代 U11 fileApplications 也碰）以先落地方为准，后到方融合

## 待拍板项（默认可翻转）

- ~~office~~（已拍板：不做，2026-10-23）
- ~~relay v2~~（已拍板：缓行；v1 死 UI 移除已入 spec）
- ~~ToolSearch~~（已拍板：纳入，2026-10-23 翻转）
- 虚拟项目 UI 三选一（默认 omz 骨架+功能组件 omz 化）
- ThoughtLevelCycleControl 双入口 vs 上游单入口（默认双入口保留）
- workbench 指针拖拽三件套去留（默认保留 omz 现状）
- B7 编号保持上游原号 vs 重编号（默认保持原号）
- ToolSearch defer 政策：内置不 defer/MCP defer（默认；可调整为按工具元数据逐个分类）
