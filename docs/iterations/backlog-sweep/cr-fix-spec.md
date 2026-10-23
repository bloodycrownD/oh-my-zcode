# CR Fix Spec: backlog-sweep wave-0/wave-1（Step 1-2 / 12-13 / 17-18 / 20-25）

## 元信息

- repo: `D:\Dev\Js\oh-my-zcode`
- base_sha: `6f5ba008`
- head_sha: `09286069`
- prd_path: 未提供
- spec_path: `docs/iterations/backlog-sweep/spec.md`
- review_round: 1（首诊，mode=scope，4 个 readonly 节点）
- dag_version: 2
- 状态：draft
- 本轮结论：**not-ready**（P0=0 / P1=2 / P2=19；另 spec_deviations open 若干）

评审来源：`review-scope-svc`、`review-scope-composer`、`review-scope-desktop`、`review-scope-provider`（均 readonly 非自审，各自新鲜读 diff + 上游对照）。

---

## Must-fix（P1）

### composer/B-1 [P1] 恢复态载体未进入 `hasDraftToSubmit` / `hasComposerDraftContent`——纯上下文队列项二次撤回丢消息且队列编辑永久卡死

- 维度：B 正确性 / C-orch（「restored 是否算草稿内容」两套口径）
- 文件：`packages/ui/src/v4/ConversationComposer.tsx:1266-1285`、`packages/ui/src/v4/SessionPane.tsx:2655`
- 问题：`submit` 允许「空正文 + 仅四类上下文」发送；该队列项撤回后 `visibleContent === ""`，chip 只存在于 `composerDraft.promptContexts`，live hooks 恒空 → 两个 has 表达式为 false。后果：(a) 发送键不亮/Enter 不可发；(b) `hasContent=false` 使 SessionPane 撤回冲突门禁放行，`deleteQueueItem` 已 ACK 删除后，Composer 内部 `hasDraftContent`（`:1038-1044`，含 merged 载体）判 true 而拒绝应用 → 队列项已从 Host 删除却永不恢复，`onComposerRestoreApplied` 不触发 → `queueEditOperationRef` 永不清空，该会话此后无法编辑任何队列项。改动前不可达（旧实现把尾块塞进可见正文 → text 非空），属本轮引入的回归。
- 改法：`hasDraftToSubmit` 与 `hasComposerDraftContent` 的四类判断改用已算好的 `mergedCodeCommentContexts / mergedWebElementContexts / mergedPptxElementReferences / mergedConversationSelections`（与发送序列化同源），不再只看 live hooks；在 `applyComposerRestoreRequestToComposer` 因 `hasDraftContent` 提前返回处补 `logger.warn`（静默挂起是 B-1 难以察觉的根因）。
- 验收/测试：①纯上下文队列项撤回后发送键可点、点击后 `promptText` 含四类尾块；②同会话再点另一队列项「编辑」→ 出 `chat.queue.editDraftConflict` toast 且不发生 `deleteQueueItem`；③状态文件 `P2 hasDraftToSubmit 不含 restored 载体` 随之关闭。
- 来源：review-scope-composer round 1

### desktop/B-1 [P1] 文件应用 id 污染全局「上次选择的编辑器」偏好，工作区头/预览头回落到 Finder/Explorer

- 维度：B 正确性 / H 兼容性（交互回归）
- 文件：`packages/ui/src/OpenSplitButton.tsx:154`、`packages/ui/src/lib/editorPreference.ts:6,31`、读取侧 `packages/ui/src/WorkspaceEditorButtonGroup.tsx:41-43`、`packages/ui/src/PreviewPane.tsx:560`、`packages/shared/src/platform.ts:195-202`、`packages/desktop/src/main/editors.ts:687`
- 问题：U11 之前该 key 只写 IDE/终端/文件管理器 id；现在为 PDF 选 `preview`/`adobe-reader` 也会写入。`WorkspaceEditorButtonGroup` 用无 path 的 `getInstalledEditors()`（不含文件应用），偏好缺失时回落 `availableEditors[0]`，而 `lib/openWithEditors.ts:3,17` 把 `finder`/`explorer` 钉在最前 → 工作区头与 `.ts` 预览头从「VS Code」静默变「Finder/资源管理器」，且无法自愈。上游同形（fork 移植引入的交互回归，非上游已修）。
- 改法：`EditorInfo` 增可选 `fileApplication?: boolean`；`editors.ts:687` 为文件应用条目置 `true`；`OpenSplitButton.tsx:154` 改为 `if (!editor.fileApplication) persistLastSelectedEditorId(editor.id)`（可抽纯函数 `shouldPersistEditorSelection(editor)` 落 `lib/editorPreference.ts`）。不采用「换独立 key」方案（UI 侧无法从列表识别文件应用 id）。
- 验收/测试：为 PDF 选 Preview 后 `localStorage["zcode-last-editor-id"]` 不变；重启后工作区头与 `.ts` 预览头仍显示此前选定的 IDE；新增纯函数用例（文件应用不持久化 / IDE 持久化）。
- 来源：review-scope-desktop round 1

---

## Must-fix（P2）

### svc/B-1 [P2] 0008 迁移 `UPDATE` 撞 `projects`/`remote_project_entries` 唯一索引 → 启动期约束错误整体回滚

- 维度：B 正确性（失败面=Host 起不来）
- 文件：`packages/services/src/project-storage/migrate-projects.ts:115-124`；索引定义 `packages/services/src/project-storage/schema.ts:16,20`
- 问题：迁移直接 `UPDATE ... SET host_id=<stable> WHERE host_id=<legacy>`。当 legacy 地址派生 host 与 stable `remote:server:<id>` host 各有一行同名未删项目（或同 `remote_project_id` 入口）时，UPDATE 抛 SQLite 约束错误 → runner 整体回滚（`packages/shared/src/sqlite-migrations/runner.ts:109-112`）→ `initialize` 抛出 → Host 起不来。迁移一次性执行，QA 无法复现，只能靠用例守。
- 改法：UPDATE 前按唯一键去重（保留 stable 侧）：projects 侧先把 legacy 侧与 stable 侧同名的未删行软删（`deleted=1, deleted_at=<now>`）；entries 侧先删 legacy 侧与 stable 侧 `remote_project_id` 冲突的行（口径对齐 `remote-projects/index.ts:237-246` `bindHost` 判定）。也可用 `UPDATE OR IGNORE` + 显式删残留，但语义必须显式。
- 验收/测试：`remoteProjectsMigration.test.ts` 新增「两 host 同名项目 + 同 remote_project_id 入口 → 0008 成功、各剩 1 行、账本 0008 在册、无约束错误」。
- 来源：review-scope-svc round 1

### svc/C-1 [P2] `migrationBackupSkipped` 字段全仓零读取方（死状态）

- 维度：C 质量
- 文件：`packages/services/src/session/taskIndexRepo.ts:483-484,545-552`
- 问题：`git grep` 仅这两处；上游在 `node.ts:3203-3205` 消费做 main 提示，omz 无消费方，且 Host 侧实例因早退永不赋值 → 田野双死。
- 改法：删除字段与 `:545` 的 `const migration =` / `:552` 赋值（保留 `await projectStorage.migrate(...)`）；或按上游在 main 提示面接线。二选一，不留死状态。
- 验收/测试：`pnpm typecheck` 绿；knip 该条消失。
- 来源：review-scope-svc round 1

### svc/F-1 [P2] `taskIndexRepo.ts:542-544` 注释与事实相反（Host 主线程必走早退）

- 维度：F 中文注释（错误设计依据）
- 文件：`packages/services/src/session/taskIndexRepo.ts:540-544`；事实见 `packages/desktop/src/host/database-startup/hostDatabaseStartup.ts:58`、`prepared.ts:16-18`
- 问题：注释断言「prepared 仅是进程内 Set，Host 进程不命中」，实际 `hostDatabaseStartup` 在 Host 主线程 `markTasksStoragePrepared()`，同模块同进程 Set → Host 侧 `initialize` 必早退，迁移在生产中**只由 Worker 那条链**执行。注释写反会误导后续把迁移接点挪走。
- 改法：改为「desktop 由 tasksStorageWorker 带 settings 完成 0005/0008；Host 主线程已被 hostDatabaseStartup 标记 prepared，故初始化早退——新增迁移接点必须落在 worker 侧或显式绕过该早退」。
- 验收/测试：注释与代码一致；同批在 `remoteProjectsMigration.test.ts` 补一条 `prepareTasksIndexStorage(path, cb, settings)` 真实入口用例（当前 T-RP5 只驱动 `TaskIndexRepo.initialize`，绕过生产入口）。
- 来源：review-scope-svc round 1

### svc/F-2 [P2] `sourceServerConnectionManager.ts:1123-1126` 注释仍称「omz 无 admitConnection 面，随后续批回补」

- 维度：F 中文注释
- 文件：`packages/desktop/src/host/sourceServerConnectionManager.ts:1123-1126`
- 问题：本批正是「那个批」——`:870-873` 已把 intent 交给 `admitConnection`，`:1160` 已补主路径 commit。注释与实现互相矛盾。
- 改法：改为「recordHandshake 只落 Profile→Source 绑定；成员（hosts 表）由注入的 admitConnection 在 :866-900 登记、:1160 提交」，删「后续批回补」措辞。
- 验收/测试：注释与 `:853-900,1152-1170` 一致。
- 来源：review-scope-svc round 1

### svc/G-1 [P2] T-RP6 未断言「`connect()` 默认 intent `"add"`」——删掉 `?? "add"` 仍全绿

- 维度：G 测试（区分力）
- 文件：`packages/services/test/remoteProjectsService.test.ts:504-548`
- 问题：夹具 `admitConnection: async () => async () => {...}` 丢弃入参，`onCommit` 只证明 commit 被调用，不证明 intent、也不证明走真实 admission。
- 改法：`createConnectedManager` 捕获 admission 入参，断言裸调 `connect()` 时 `intent === "add"`、显式传 `membershipIntent: "retain"` 时为 `"retain"`；另加一条把 `createRemoteProjectConnectionAdmission(真实 service)` 注入，断言连接后 `readDirectory()` 出 `remote:server:<id>` 行（端到端闭环）。
- 验收/测试：把 `?? "add"` 改为 `?? "retain"` 时新用例必须转红。
- 来源：review-scope-svc round 1

### composer/B-2 [P2] `restoredPromptContextsRef` 渲染期镜像 + 写回被 scope guard 丢弃 → 跨 scope 载体串写

- 维度：B 正确性 / C-orch（双写）
- 文件：`packages/ui/src/v4/ConversationComposer.tsx:800-813`、`packages/ui/src/v4/composer/useDraftConfigControl.ts:250-253`
- 问题：发送 ACK 的成功清理在切 scope 后仍用旧闭包执行 → 先写 ref（旧 scope 内容），`updateComposerContent` 被 scope guard 静默丢弃 → ref 与草稿分叉；窗口内若在新 scope 增删 chip，函数式 updater 以旧 scope 载体为基底写进新 scope 草稿（并持久化）。
- 改法：给 `V4ComposerDraftContentUpdate` 增函数形态 `(current) => update`，`updateComposerContent` 在 `updateComposerDraft` 内部（scope guard 之后、读 `stateRef.current.draft`）执行 updater；`updateRestoredPromptContexts` 改纯函数形态，删除渲染期 ref 镜像。
- 验收/测试：构造「撤回 chip → 发送 → ACK 前切 scope → ACK 成功」序列，新 scope 草稿不含旧 scope chip；补模型测试（见 composer/G-1）。
- 来源：review-scope-composer round 1

### composer/B-3 [P2] 协议相对 URL `//host/x` 被误还原成文件 chip

- 维度：B 正确性（R7 口径）
- 文件：`packages/ui/src/mentions/mentionMarkdown.ts:261-265`
- 问题：`destination.startsWith("/")` 无条件命中白名单，`[doc](//cdn.example.com/a.ts)` 被显示成本地文件胶囊。
- 改法：`if (destination.startsWith("/") && !destination.startsWith("//")) return true;`
- 验收/测试：`T-PR1-5` 增 `[proto](//cdn.example.com/x)` 用例（段数 1、无 mention 段）；既有 T-PR1 全绿。
- 来源：review-scope-composer round 1

### composer/B-4 [P2] 恢复出的目录 chip 的 `data.relativePath`/`value` 带尾斜杠，与 file provider 契约不一致

- 维度：B 正确性（一致性）
- 文件：`packages/ui/src/mentions/mentionMarkdown.ts:267-280`；对照 `packages/ui/src/mentions/providers/fileMentionProvider.ts:10-26`
- 问题：`./src/lib/` → `relativePath: "src/lib/"`，而 provider 产出无尾斜杠（尾斜杠只在 markdown）。`prependMentionIfMissing` / `removeMentionById` 这类按 id/value 比对的路径对恢复节点失配。
- 改法：`data.relativePath` / `value` 去尾斜杠，目录语义继续由 `data.kind` 承载，仅 `markdown` 保留斜杠；同步修 `T-PR1-4` 期望值。
- 验收/测试：T-PR1-4 断言 `data` 与 `fileMentionProvider` 同形，往返恒等不破。
- 来源：review-scope-composer round 1

### composer/B-5 [P2] 恢复出的「会话选区」chip 无单条删除按钮（`onRemove` 不可达）

- 维度：B 正确性（功能缺口）
- 文件：`packages/ui/src/v4/ConversationComposer.tsx:346-349`；`packages/ui/src/.../ConversationSelectionReferenceChip.tsx:51-91`；`packages/ui/src/lib/conversationSelectionReference.ts:164-170`
- 问题：`parsePromptConversationSelections` 对现代 `# userselect:` 块产出 `{path?, text}` 无 id，chip 只在 `isConversationSelectionReference(reference)` 时渲染删除按钮 → 恢复项无法单删，只能「全部清除」。
- 改法：写入载体时补稳定 id（如 `restored-userselect-${index}`，保证与 live 去重键不冲突）；或让 chip 对无 id 引用也渲染删除按钮并以 `conversationSelectionContextKey` 回调。
- 验收/测试：撤回带 userselect 块的队列项后 chip 有单条删除按钮，删除后切 scope 再回来不复现。
- 来源：review-scope-composer round 1

### composer/C-1 [P2] 链接正则常量重复定义

- 维度：C 质量（DRY）
- 文件：`packages/ui/src/mentions/mentionMarkdown.ts:3-4` 与 `:253-254`
- 问题：两处逐字相同；展示/装填**语义**分叉有意且已注释，但正则本身无分叉理由。
- 改法：删 `RICH_MENTION_LINK_PATTERN`，两处共用 `LINK_MENTION_MARKDOWN_PATTERN`（matchAll 克隆正则，`lastIndex` 无副作用）。
- 验收/测试：T-PR1 全绿；`git grep RICH_MENTION_LINK_PATTERN` 为 0。
- 来源：review-scope-composer round 1

### composer/G-1 [P2] 撤回→发送状态机只有源码正则形状守卫，无行为测试

- 维度：G 测试（缺口）
- 文件：`packages/ui/test/composerMentionPillFill.test.ts` 的 T-PR2-1..4
- 问题：`assert.match` 源码 + `countOccurrences === 2` 无法发现 B-1 这类「表达式写错来源」，也不覆盖失败回滚/等待期语义。
- 改法：把 `mergeContextList`、`resolveRestoredComposerContent` 与「claim→成功清空→失败回滚」抽成 `v4/composer/` 纯函数；按 `chatPromptEditorSubmitValue.test.ts` 的「忠实模型」写法补 T-PR2-7/8：①restored+live 同 id 去重；②失败回滚保留四类 chip；③等待期新增 chip 不被旧 ACK 清掉。
- 验收/测试：把 `hasDraftToSubmit` 改回旧表达式时新用例转红。
- 来源：review-scope-composer round 1

### desktop/B-2 [P2] ToolCallBody 读成功但 `dataBase64` 为空时仍永久 Loading

- 维度：B 正确性（本次要收口的形态只堵了 reject 路径）
- 文件：`packages/ui/src/ToolCallBlocks/ToolCallBody.tsx:150-153,174-184`
- 问题：`FileMediaPreview.dataBase64` 必填 `string`（`packages/shared/src/protocol.ts:49-54`），0 字节图片解析出 `""` → `current` 非空但 `!current.src`，`failed` 未置位 → 永远 `chat.toolCall.loading`。
- 改法：`const src = mediaPreview?.dataBase64 || undefined; setResult({ path: preview.path, src, failed: !src });`
- 验收/测试：0 字节图片显示 `chat.toolCall.previewFailed`；形状用例补 `failed: !` 断言，或抽 `resolveInlineImageResult(mediaPreview)` 纯函数做行为用例。
- 来源：review-scope-desktop round 1

### desktop/C-1 [P2] 数字徽章渲染器整段生产零调用（被测试锁死的死代码）

- 维度：C 质量 / A 需求符合性（与上一迭代裁决相反）
- 文件：`packages/desktop/src/main/unreadBadge.ts:61,76-180`；唯一引用 `packages/desktop/test/unreadBadgeMaxSemantics.test.ts`
- 问题：上一迭代已裁决「生产零调用不迁」（`docs/iterations/upstream-v3.16-sync/spec.md:123`），本轮整件移植带回；knip 因测试引用不报红。
- 改法：二选一并落 spec_deviations —— (a) 删除该段 + 同步删测试「数字徽章像素」用例；(b) 保留但段首注明「生产零调用，仅上游测试兼容，接线待产品确认」。
- 验收/测试：删除方案下 `rg renderTaskbarBadgePixels packages/*/src` 零命中；保留方案下注释在位且 T-UF4 全绿。
- 来源：review-scope-desktop round 1

### desktop/H-1 [P2] 任务栏 overlay 无障碍描述硬编码英文

- 维度：H 兼容性 / J UI / I 可观测性
- 文件：`packages/desktop/src/main/unreadBadge.ts:304`
- 问题：`${options.label} unread tasks` 是 Windows 任务栏 tooltip/读屏描述，zh-CN 用户见英文；主进程其余原生文案均走 `formatDesktopMenuMessage`（`packages/shared/src/desktopMenu.ts:144-164`，已支持 `{count}`），只有这里绕过。
- 改法：`desktopMenuMessageIds` 增 `taskbarUnreadTasks`，`desktopMenuMessages` 增 zh/en 两语；`applyTaskbarOverlayToWindows` 的 options 改收已格式化 `description`（或注入 formatter），由 `syncApplicationUnreadBadge` 用 `currentApplicationLocale` 走 `formatDesktopMenuMessage`。
- 验收/测试：zh-CN 描述为中文、en-US 不变；T-UF4 的 description 断言改从注入 formatter 取值。
- 来源：review-scope-desktop round 1

### desktop/F-1 [P2] 两处注释声明了本仓不存在的生产者

- 维度：F 中文注释
- 文件：`packages/ui/src/ToolCallBlocks/renderers/cuaScreenshotDetails.ts:67-68`、`packages/ui/src/lib/nodeReplToolDisplay.ts:7,294,314`
- 问题：全仓 `sharedImageSrc` 只有消费点与测试（上游生产者 `ConversationShareReadonlyTimeline.tsx:371` 未移植）；node_repl display 生产者 `apps/zcode-cli/packages/core/src/tool/executor/result-display.ts:355,383` 只产出 `{base64,mimeType}`。两处均为「预埋兼容」而非当前链路修复。
- 改法：注释改为「上游共享只读时间线/display 资源链接形态；本仓暂无生产者，保留兼容」。
- 验收/测试：注释与 `rg` 事实一致；无代码改动。
- 来源：review-scope-desktop round 1

### desktop/G-1 [P2] U11 归并/过滤只有源码字符串断言

- 维度：G 测试（缺口）
- 文件：`packages/desktop/test/fileApplicationsSelector.test.ts:190-228`；被断言对象 `packages/desktop/src/main/editors.ts:651-657,676-702`
- 问题：「文件应用只按扩展名出、基座列表拒文件应用」的核心归并语义只能靠 `includes("...")` 兜住，改坏 filter 仍可能通过。
- 改法：把分区谓词抽到 `fileApplications.ts`（如 `partitionEditorDefs(defs) => { base, fileApplications }`），`editors.ts` 复用；测试用 `getFileApplicationDefs("darwin"|"win32"|"linux")` 断言分区结果。
- 验收/测试：三平台 `base` 不含任何带 `fileExtensions` 的 def、`fileApplications` 全含、`.pdf` 命中集合与首选项一致。
- 来源：review-scope-desktop round 1

### desktop/B-3 [P2] 托盘/overlay 徽章缓存冗余（按 label 存多份等价图）

- 维度：C 质量 / E 性能
- 文件：`packages/desktop/src/main/desktopTray.ts:132-136,167-190`、`packages/desktop/src/main/unreadBadge.ts:317-337`
- 问题：`composeTrayBadgeRepresentation(label, ...)` 的 `label` 形参未使用；按 label 缓存 10 张视觉相同图；`createBadgeImage(cachedLabel)` 忽略 label 同样按 label 存 10 份等价 `nativeImage`。
- 改法：托盘去 `label` 形参改单槽缓存；`createBadgeImage` 改零参 + 单槽缓存，label 仅用于 description。
- 验收/测试：同一未读数变化不产生多份等价图像；T-UF4 缓存断言改为「同 label 只建一次」不变式。
- 来源：review-scope-desktop round 1

### provider/B-1 [P2] 重名与创建失败共用横幅导致错配

- 维度：B 正确性
- 文件：`packages/ui/src/settings/model-provider-section/ProviderCreateNameDialog.tsx:76,160-179`
- 问题：`blockingMessage = duplicateMessage ?? errorMessage` 用重名掩盖 create 错误，但重试按钮（:168）与 `data-provider-create-error`（:164）仍按 `errorMessage` 判定 → 「Provider 名称已存在」+ 禁用的「重试」按钮 + 属性标成 `create`。
- 改法：提纯 `resolveCreateProviderBanner({ resolution, errorMessage }) => { kind: "duplicate"|"create"|"empty"|null, message, showRetry }`，`showRetry` 仅 `kind === "create"` 为真，`data-provider-create-error` 直接取 `kind`。
- 验收/测试：duplicate+error 并存只出重名、无重试、属性为 `duplicate`；纯函数单测覆盖 4 分支。
- 来源：review-scope-provider round 1

### provider/B-2 [P2] 空名/纯空白零反馈（静默拦截）

- 维度：B 正确性 / J UI
- 文件：`packages/ui/src/settings/model-provider-section/ProviderCreateNameDialog.tsx:74-77,160`
- 问题：`status === "empty"` 时两 message 均 null → 不渲染 `role=alert`，用户只见确认按钮变灰。
- 改法：`kind === "empty"` 渲染必填提示，新增对称键 `settings.modelProvider.nameRequired`（zh「请输入供应商名称」/ en「Enter a provider name」）；或产品明确「禁用即拦截」并写入 spec。
- 验收/测试：清空输入出 role=alert 必填文案，zh/en 双在位；`i18n-key-merge --verify` 仍绿。
- 来源：review-scope-provider round 1

### provider/A-1 [P2] 模板路径复用了「完全自定义」描述文案

- 维度：A 需求符合性 / J UI
- 文件：`packages/ui/src/settings/model-provider-section/ProviderCreateNameDialog.tsx:114-116`；locales 中 `addProviderDescription`
- 问题：从供应商目录选模板时，弹窗描述仍称要配「完全自定义 API 端点」；模板路径实际由模板基线提供端点与模型。不能直接删 Description（Radix 会告警缺 description），应换文案。
- 改法：按 `pick?.templateId` 选描述键，新增对称键 `settings.modelProvider.addProviderFromCatalogDescription`（如「从供应商目录模板创建，创建后可继续调整连接与模型。」）。
- 验收/测试：两种 pick 的弹窗描述分别正确，两语言对称。
- 来源：review-scope-provider round 1

### provider/B-3 [P2] 重名文案跨包字面量复制，注释声称同源且对创建路径不成立

- 维度：C 质量（DRY）/ F 注释
- 文件：`packages/ui/src/settings/model-provider-section/createProviderNameDialog.ts:8-13`；`packages/provider/src/config-service.ts:600`
- 问题：UI 常量是复制而非引用；且注释暗示「创建失败会抛重名错」，实际 `createPersonalProvider` 走 `nextPersonalProviderLabel` 自动加序号（`config-service.ts:232-238,734-747`）。
- 改法：在 `@zcode/provider` 导出文案前缀常量两侧共用；注释改为「对齐重命名路径报错文案；创建路径服务层自动加序号，前端拦截更严格」。
- 验收/测试：文案单一定义处；一条断言保证 UI 展示值包含该常量。
- 来源：review-scope-provider round 1

### provider/G-1 [P2] 创建在途互斥、清错时机、横幅分支缺少守卫

- 维度：G 测试（缺口）
- 文件：`packages/ui/test/modelProviderNameDialog.test.ts`（缺项）；`packages/ui/src/settings/ModelProviderSection.tsx:278,844-849`
- 问题：`createProviderInFlightRef` 双击互斥、提交前 `setCreateProviderError(null)`、B-1/B-2 的横幅分支都是本轮新行为，T-PV1 只覆盖纯校验与挂载点形状（AGENTS.md 要求行为改动补测）。
- 改法：B-1 纯函数落单测；形状守卫补三条：`createProviderInFlightRef.current` 在 await 前同步置位、`setCreateProviderError(null)` 在 await 之前、弹窗禁用在途关闭（`if (!next && !creating)`）。
- 验收/测试：抽掉互斥或清错任一处，对应用例红灯。
- 来源：review-scope-provider round 1

---

## Spec deviations

> `open` 项须用户确认（或由 Step 26 回写 spec 后转 `fixed`）；本 skill 不自行视同接受。

| # | 内容 | 证据 | 建议处置 |
|---|---|---|---|
| S1 | 草稿 schema 新增 `promptContexts` 载体，`readDraft` 由「必须有非空正文」放宽为「正文或载体至少一样」，`promoteComposerDraft` 显式剥离载体 | `composerDraftStore.ts:38-46,284-325,448-463`；`useDraftConfigControl.ts:348-369` | 视为 fix-pill 根修的必要扩展；Step 26 写入 spec（含「旧客户端读纯上下文草稿会丢弃」的兼容说明） |
| S2 | `setTextWithPluginMentions` 由「plugin 专用」变为富装填别名，外部预填 plugin 分支语义随之扩大（现在也把同批 file/skill/session 链接转 chip） | `ConversationComposer.tsx:277-279` | 接受；CHANGELOG 与 spec Step 21 补一句 |
| S3 | `updateComposerContent` 签名收窄为 `V4ComposerDraftContentUpdate`，「无条件清 editorStateJson/mention」改为「仅正文写入时清」（影响所有既有调用点） | `useDraftConfigControl.ts:324-335` | 接受；spec Step 21 补「公共契约变更」 |
| S4 | T-PR2-1/2 用 `countOccurrences === 2` 锁源码字面量次数，纯格式化即红 | `composerMentionPillFill.test.ts` | 降级为 `>= 1` + 负向断言（并入 composer/G-1 同批） |
| S5 | `services` 六值导出落 `node.ts` 而非 spec 写的 `index.ts`（renderer barrel 不得引 `node:crypto`） | `services/src/index.ts:128-132` 禁令注释 | 接受；Step 26 回写 spec 正文 |
| S6 | 0008 的「幂等」仅行级成立，`membership_id` 每次重跑换新 UUID | `migrate-projects.ts:91-99` | 记入 spec 风险表，不作「完全幂等」引用 |
| S7 | `migrateConnectionHostsOnUpgrade` 不动 `tasks.host_id`（上游同形） | `migrate-projects.ts` 全文 | 接受；spec 明确「收敛范围=projects/entries」 |
| S8 | 数字徽章渲染段带入（生产零调用） | `unreadBadge.ts:61,76-180` | 与 desktop/C-1 同批决定（删 or 注释保留） |
| S9 | `sharedImageSrc` / `image.src` 在本仓无生产者，属预埋兼容 | `cuaScreenshotDetails.ts`、`nodeReplToolDisplay.ts` | 接受；与 desktop/F-1 注释同批 |
| S10 | T-PV2 的「名称提交归一化」纯逻辑实际落在 T-PV1 宿主 | `modelProviderNameDialog.test.ts:150-183` | 修正 spec 用例→宿主映射 |
| S11 | 新增 `DROP_KEYS` i18n 工具链机制未在 spec/CHANGELOG 登记 | `scripts/i18n-key-merge/config.mjs:38-43,65-67`；`merge.mjs:25,43` | Step 26 补 spec i18n 段落 + CHANGELOG |
| S12 | `trash` 删除按钮取 `icon-sm`（Step 25 文本与 SubagentsSection 实际 `icon-md` 内部矛盾） | `ProviderCardSections.tsx:135` vs `SubagentsSection.tsx:572` | 接受现状；spec 改口径 |
| S13 | 创建失败横幅落弹窗内 `role=alert` + 重试（详情栏横幅被模态遮住） | `ProviderCreateNameDialog.tsx:160-179` | 接受（功能更优）；spec Step 23 改口径 |
| S14 | Step 23 提交直调 `createPersonalProvider`（`ProviderDraftSave` 无创建入口） | `ModelProviderSection.tsx:851` | 接受；spec 措辞改正 |

---

## Open questions（不阻塞 fix-spec-ready，需用户/后续节点拍板）

1. **（最高价值）非桌面入口用空 settings 抢先烧掉 0005/0008 账本**：`TaskIndexRepo.initialize` 无条件跑 `projectStorage.migrate`，`createLocalServices` 固定传 `undefined` settings（`node.ts:1338`）；若升级后先起 web/server 入口（`packages/server/src/entry-http.ts:17`、`stdioServices.ts:38`，共用同一 `~/.omz/tasks-index.sqlite`），会以空 settings 应用 0005 并记账 → desktop Worker 跳过后**旧项目与入口永久不迁移**。上游同形（继承风险）。可选：非桌面入口自带 settings，或 0005 seed 改成「账本在但 seed 空时补跑」。
2. 未读信号双源（`root/useRootPlatformEffects.ts:270-274` 无门控 vs `project-sidebar/ProjectDirectoryProvider.tsx:72-74` 带 `notificationEnabled` 门控）→ 关闭通知后计数变化仍点亮角标；U12 让其在任务栏/托盘可见。需产品拍板单一 owner。
3. 文件应用打开失败无可见反馈（`OpenSplitButton.tsx:161-171`、`PreviewPane.tsx:1502-1510` 仅 warn；omz 缺 `chat.previewCards.openFileFailed` 键）→ 是否补键。
4. `chatPromptEditorSubmitValue.test.ts:29/53/107` 注释仍称 `setText(initialValue)` 回填，与实现脱节；`LexicalChatInputHandle.setText` 已零内部消费点 → 是否退役。
5. 托盘合成在高 DPI/多表示 `.ico` 下的 `toBitmap()` 尺寸契约（不符时 warn + 静默不出现，fail-closed）→ T-QA6 真机（150%/200%）。
6. fence 判定为简化近似（等长关闭标记；CommonMark 允许更长关闭 fence）→ 是否登记已知近似。
7. `readDraftPromptContexts` 只校验「四键都是对象数组」，坏条目可带残缺字段直达 chip 渲染 → 是否加逐类关键字段校验/错误边界。
8. 失败回滚用发送前冻结载体整体覆盖，等待期用户删掉的恢复 chip 会复活 → 是否接受（live chip 无此问题）。
9. 同模板二次创建时预填即重名（旧行为是服务层自动加「X 2」）→ 是否让预填复用 `nextPersonalProviderLabel`。
10. 名称输入无 `maxLength` → 是否约定上限。

---

## 已豁免（用户确认不修）

（暂无）

---

## 合并后 QA（manual_user）

- T-QA3 胶囊：**纯上下文队列项**撤回→重发、撤回后切会话再回来、选区 chip 单删
- T-QA5 服务商：名称弹窗（必填/重名/在途双击）、点击改名、右上删除 + 确认
- T-QA6 文件应用：PDF/Office 拉起、`last-editor` 偏好不被污染、任务栏/托盘红点（含 150%/200% 缩放）、macOS `open -a --args`
- T-QA1 远端：空 hosts 库首连、迁移动账（含两 host 同名项目的数据形状）

---

## K 节建议（下游执行时闭合）

1. spec 回写：S1-S14 全部落 `docs/iterations/backlog-sweep/spec.md`（Step 2/21/22/23/25/26 + 风险表 + 用例→宿主映射）
2. CHANGELOG：`setTextWithPluginMentions` 语义扩大、草稿 schema 新增载体、DROP_KEYS 工具链
3. `test:v4-perf` 分组一致性：纯 node 测试（modelProviderNameDialog/CardActions）挂在带 `setup-ui-component-test.mjs` 的 UI 批末组，语义上更接近 `tsx --test` 批
4. 调试残留已清（`+m.length+`/`Close'))hits.push(p)` 等工程垃圾已删；`.reference/`、`.tools/` 属工具目录，保持 untracked
