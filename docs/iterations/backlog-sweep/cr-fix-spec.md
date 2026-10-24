# CR Fix Spec: backlog-sweep wave-0/wave-1（Step 1-2 / 12-13 / 17-18 / 20-25）

## 元信息

- repo: `D:\Dev\Js\oh-my-zcode`
- base_sha: `6f5ba008`
- head_sha: `09286069`
- prd_path: 未提供
- spec_path: `docs/iterations/backlog-sweep/spec.md`
- review_round: CR 侧 4 轮已收口（r1 首诊 → r4 review-full: yes）；spec-check-loop 轮次见 `.iteration-state.yaml` 的 `spec_check_loop` 段
- dag_version: 5（CR 侧）
- 状态：CR 侧 fix-spec-ready（r4 yes）；spec-check-loop r1 No-Go（2 P0 / 12 P1）→ r2 No-Go（R-A 与 K1 互斥、B-5 漏编辑态第二调用点）→ **r3 Go**（两条阻塞全闭、5 条观察 4 修 1 残留已补，commit 74e15b90 后）
- 本轮结论（**指 CR 对实现的判定，不是本文档状态**）：**not-ready**（P0=0 / P1=2 / P2=24，共 26 条 must-fix；P2 含 r2 新增 `composer/A-1`、`composer/B-6`）

评审来源：`review-scope-svc`、`review-scope-composer`、`review-scope-desktop`、`review-scope-provider`（CR r1 首诊，readonly 非自审）+ `review-full`（CR r2 覆核 + r3/r4 回归）+ `spec-check-loop` r1-r3（对 fix-spec 本身：r1 出 2 P0 / 12 P1 → r2 收敛到 2 条 → r3 Go）。修复轨迹：CR r1 出 24 条 → r2 补 2 条 → r3 修正 `composer/A-1` 依据（气泡侧同为缺陷）+ 收窄 `composer/B-6` → r4 yes → spec-check r1 收口 P0-1（B-5 合成 id 无效，改走 key 回调）与 P0-2（B-1/B-3 文案契约冲突）+ 12 条 P1（验收载体统一为纯函数/形状守卫）→ spec-check r2 补 B-5 编辑态第二调用点 + R-A 条件式 → r3 Go。

---

## Must-fix（P1）

### composer/B-1 [P1] 恢复态载体未进入 `hasDraftToSubmit` / `hasComposerDraftContent`——纯上下文队列项二次撤回丢消息且队列编辑永久卡死

- 维度：B 正确性 / C-orch（「restored 是否算草稿内容」两套口径）
- 文件：`packages/ui/src/v4/ConversationComposer.tsx:1266-1285`、`:2275-2283`（`allowSubmitWhenEmpty`）、`packages/ui/src/LexicalChatInput.tsx:795`（`shouldSubmitLexicalEnter`）、`packages/ui/src/v4/SessionPane.tsx:2655`
- 问题：`submit` 允许「空正文 + 仅四类上下文」发送；该队列项撤回后 `visibleContent === ""`，chip 只存在于 `composerDraft.promptContexts`，live hooks 恒空 → 三个表达式全为 false：`hasDraftToSubmit`、`hasComposerDraftContent`、**`allowSubmitWhenEmpty`**（后者决定 Enter 是否放行）。后果：(a) 发送键不亮且 Enter 被判空；(b) `hasContent=false` 使 SessionPane 撤回冲突门禁放行，`deleteQueueItem` 已 ACK 删除后，Composer 内部 `hasDraftContent`（`:1038-1044`，含 merged 载体）判 true 而拒绝应用 → 队列项已从 Host 删除却永不恢复，`onComposerRestoreApplied` 不触发 → `queueEditOperationRef` 永不清空，该会话此后无法编辑任何队列项。改动前不可达（旧实现把尾块塞进可见正文 → text 非空），属本轮引入的回归。
- 改法：**三处表达式**（`hasDraftToSubmit`、`hasComposerDraftContent`、`allowSubmitWhenEmpty`）的四类判断统一改用已算好的 `mergedCodeCommentContexts / mergedWebElementContexts / mergedPptxElementReferences / mergedConversationSelections`（与发送序列化同源），口径对齐 `ConversationRowView.tsx:1153` 的 `editContextCount`；在 `applyComposerRestoreRequestToComposer` 因 `hasDraftContent` 提前返回处补 `logger.warn`（静默挂起是 B-1 难以察觉的根因）。
- 验收/测试（**不得依赖 jsdom**，同 A-1 口径）：①把三处判定收成一个纯函数 `resolveComposerSubmitAvailability({ text, attachments, contexts })`（`contexts` 传 merged 四类），T-PR2 直接测该函数：纯上下文输入 → `canSubmit === true`、`allowSubmitWhenEmpty === true`；②形状守卫断言三处表达式消费 `merged*` 而非 live hooks（任一改回 live-only 即红）；③`SessionPane.tsx:2655` 门禁由 `editContextCount` 与 merged 载体同源驱动，补一条纯逻辑断言；④状态文件 `P2 hasDraftToSubmit 不含 restored 载体` 随之关闭。
- 来源：review-scope-composer round 1

### desktop/B-1 [P1] 文件应用 id 污染全局「上次选择的编辑器」偏好，工作区头/预览头回落到 Finder/Explorer

- 维度：B 正确性 / H 兼容性（交互回归）
- 文件：`packages/ui/src/OpenSplitButton.tsx:154`、`packages/ui/src/lib/editorPreference.ts:6,31`、读取侧 `packages/ui/src/WorkspaceEditorButtonGroup.tsx:41-43`、`packages/ui/src/PreviewPane.tsx:560`、`packages/shared/src/platform.ts:195-202`、`packages/desktop/src/main/editors.ts:687`
- 问题：U11 之前该 key 只写 IDE/终端/文件管理器 id；现在为 PDF 选 `preview`/`adobe-reader` 也会写入。`WorkspaceEditorButtonGroup` 用无 path 的 `getInstalledEditors()`（不含文件应用），偏好缺失时回落 `availableEditors[0]`，而 `lib/openWithEditors.ts:3,17` 把 `finder`/`explorer` 钉在最前 → 工作区头与 `.ts` 预览头从「VS Code」静默变「Finder/资源管理器」，且无法自愈。上游同形（fork 移植引入的交互回归，非上游已修）。
- 改法：`EditorInfo` 增可选 `fileApplication?: boolean`；`editors.ts:687` 为文件应用条目置 `true`；`OpenSplitButton.tsx:154` 改为 `if (!editor.fileApplication) persistLastSelectedEditorId(editor.id)`（可抽纯函数 `shouldPersistEditorSelection(editor)` 落 `lib/editorPreference.ts`）。**选旗标而非独立 key 的理由是改动面更小**（独立 key 也走得通，但要同步改读取侧三处与已落盘值的兼容）。
- 验收/测试：为 PDF 选 Preview 后 `localStorage["zcode-last-editor-id"]` 不变；重启后工作区头与 `.ts` 预览头仍显示此前选定的 IDE；新增纯函数用例（文件应用不持久化 / IDE 持久化）。
- 来源：review-scope-desktop round 1

---

## Must-fix（P2）

### svc/B-1 [P2] 0008 迁移 `UPDATE` 撞 `projects`/`remote_project_entries` 唯一索引 → 启动期约束错误整体回滚

- 维度：B 正确性（失败面=Host 起不来）
- 文件：`packages/services/src/project-storage/migrate-projects.ts:115-124`；索引定义 `packages/services/src/project-storage/schema.ts:16,20`
- 问题：迁移直接 `UPDATE ... SET host_id=<stable> WHERE host_id=<legacy>`。当 legacy 地址派生 host 与 stable `remote:server:<id>` host 各有一行同名未删项目（或同 `remote_project_id` 入口）时，UPDATE 抛 SQLite 约束错误 → runner 整体回滚（`packages/shared/src/sqlite-migrations/runner.ts:109-112`）→ `initialize` 抛出 → Host 起不来。迁移一次性执行，QA 无法复现，只能靠用例守。
- 改法：UPDATE 前按唯一键去重（保留 stable 侧）：projects 侧先把 legacy 侧与 stable 侧同名的未删行软删（`deleted=1, deleted_at=<now>`）；entries 侧先删 legacy 侧与 stable 侧 `remote_project_id` 冲突的行（口径对齐 `remote-projects/index.ts:237-246` `bindHost` 判定）。也可用 `UPDATE OR IGNORE` + 显式删残留，但语义必须显式。
- 验收/测试：`remoteProjectsMigration.test.ts` 新增「两 host 同名项目 + 同 remote_project_id 入口 → 0008 成功、各剩 1 行、账本 0008 在册、无约束错误」；**并断言软删 legacy 项目后其任务仍可见**（`tasks.project_id` 不改指，与既有 `deleteProject` 同形 —— 只要 `readTasks`/项目树不因 host 迁移丢任务即可）。
- 来源：review-scope-svc round 1

### svc/C-1 [P2] `migrationBackupSkipped` 字段全仓零读取方（死状态）

- 维度：C 质量
- 文件：`packages/services/src/session/taskIndexRepo.ts:483-484,545-552`
- 问题：`migrationBackupSkipped` 全仓零读取方（`git grep` 仅这两处）；上游在 `node.ts:3203-3205` 消费做 main 提示，omz 无消费方，且 Host 侧实例因早退永不赋值 → 字段与实际双死。
- 改法：删除字段与 `:545` 的 `const migration =` / `:552` 赋值（保留 `await projectStorage.migrate(...)`）；或按上游在 main 提示面接线。二选一，不留死状态。
- 验收/测试：`pnpm typecheck` 绿；`git grep migrationBackupSkipped -- packages apps` 归零（fix-spec/spec 文档内允许出现该串；knip 不检查类字段，不能作为验收手段）。
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
- 文件：`packages/services/test/remoteProjectsService.test.ts:504-548`（`createConnectedManager` 夹具）、`:251,285`（T-RP6 用例本体）、`:570,599`（既有 manager 用例）
- 问题：夹具 `admitConnection: async () => async () => {...}` 丢弃入参，`onCommit` 只证明 commit 被调用，不证明 intent、也不证明走真实 admission。
- 改法：`createConnectedManager` 捕获 admission 入参，断言裸调 `connect()` 时 `intent === "add"`、显式传 `membershipIntent: "retain"` 时为 `"retain"`（两处断言分别加到 T-RP6（`:251,285`）与既有 manager 用例（`:570,599`））；另加一条把 `createRemoteProjectConnectionAdmission(真实 service)` 注入，断言连接后 `readDirectory()` 出 `remote:server:<id>` 行（端到端闭环）。
- 验收/测试：把 `?? "add"` 改为 `?? "retain"` 时新用例必须转红。
- 来源：review-scope-svc round 1

### composer/B-2 [P2] `restoredPromptContextsRef` 渲染期镜像 + 写回被 scope guard 丢弃 → 跨 scope 载体串写

- 维度：B 正确性 / C-orch（双写）
- 文件：`packages/ui/src/v4/ConversationComposer.tsx:800-813`、`packages/ui/src/v4/composer/useDraftConfigControl.ts:250-253`
- 问题：发送 ACK 的成功清理在切 scope 后仍用旧闭包执行 → 先写 ref（旧 scope 内容），`updateComposerContent` 被 scope guard 静默丢弃 → ref 与草稿分叉；窗口内若在新 scope 增删 chip，函数式 updater 以旧 scope 载体为基底写进新 scope 草稿（并持久化）。
- 改法：给 `V4ComposerDraftContentUpdate` 增函数形态 `(current) => update`，`updateComposerContent` 在 `updateComposerDraft` 内部（scope guard 之后、读 `stateRef.current.draft`）执行 updater；`updateRestoredPromptContexts` 改纯函数形态，删除渲染期 ref 镜像。**落地时抽成纯函数** `applyScopedDraftContentUpdate({ scopeKey, currentScopeKey, draft, update })`（放 `v4/composer/`），组件只做转发。
- 验收/测试：纯逻辑用例 ①scopeKey 不同 → 返回原草稿且 `dropped === true`；②同 scope → 应用 updater 且基于传入 `draft`（不是组件 ref）；③函数形态 updater 在同 tick 连续两次调用累积正确。时序场景「ACK 前切 scope」不写组件测试（无 jsdom），由该纯函数的 ①② 覆盖语义。
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
- 问题：`./src/lib/` → `relativePath: "src/lib/"`，而 provider 产出无尾斜杠（尾斜杠只在 markdown）。**且绝对路径分支同样带尾斜杠**（`data.path`/`value` 取 `relativePath || path`），`T-PR1-4` 现在把 `/workspace/src/`、`D:\work\lib/` 的带斜杠 data 钉成期望。
- 改法：`data.relativePath`、`data.path`、`value` **三条都去尾斜杠**（目录语义由 `data.kind` 承载），仅 `markdown` 保留斜杠；`mapWorkspaceFileToMentionItem`（`fileMentionProvider.ts:9`，当前未导出）**导出**以便同形对照；同步改 `T-PR1-4` 三类期望（相对目录 / 绝对目录 / 仓库根）。
- 验收/测试：T-PR1-4 断言**四类**（相对目录 / POSIX 绝对目录 / Windows 绝对目录 / **仓库根（新增例，`buildFileMentionMarkdown("", "root", "directory")` → `[root](/)`，走绝对分支）**）的**可推导字段一致**——相对目录对照 `kind/relativePath/value`，绝对目录与仓库根对照 `kind/path/value`（markdown 侧相对分支本就没有绝对 `path`，不做全字段等值）；**不得用仓库根替换现有 Windows 绝对目录例**（会丢 Windows 覆盖）；往返恒等不破。
- 来源：review-scope-composer round 1

### composer/B-5 [P2] 恢复出的「会话选区」chip 无单条删除按钮（`onRemove` 不可达）

- 维度：B 正确性（功能缺口）
- 文件：`packages/ui/src/v4/ConversationComposer.tsx:346-349,870-871,1503,2014`；`packages/ui/src/v4/composer/ConversationSelectionReferenceChip.tsx:19,80-91`；`packages/ui/src/v4/ConversationRowView.tsx:1225-1241`（**第二个 onRemove 调用点，编辑态**）；`packages/ui/src/lib/conversationSelectionReference.ts:9-28,164-170`
- 问题：`parsePromptConversationSelections` 对现代 `# userselect:` 块产出 `{path?, text}` **无 id**；chip 的删除按钮渲染条件 `isConversationSelectionReference(reference)`（`:80`）要求 `id` + `contentType` + `sourceSessionId` + 数字 `sourceRowId`（markdown 型还需 `sourceKey/sourceTitle`，`conversationSelectionReference.ts:14-28`）→ 恢复项永不满足守卫，`onRemove` 对该类不可达，只能「全部清除」。
- 改法（**不合成 id**——r1 已判定无效且会破坏去重）：
  1. `conversationSelectionContextKey`（`ConversationComposer.tsx:346-349`）**上移到 `lib/conversationSelectionReference.ts` 并导出**（两处调用点都要用）
  2. 删除 chip 的条件守卫：`{onRemove ? (<Button ... onClick={() => onRemove(reference)} />) : null}`；`onRemove` 签名 `(id: string)` → `(reference: ConversationSelectionDisplayReference)`
  3. **两个调用点同批改**：Composer 侧 `onRemove={(reference) => removeMergedConversationSelectionReference(conversationSelectionContextKey(reference))}`（`:1503` 已是 key 形态）；**编辑态 `ConversationRowView.tsx:1227-1234` 的 `(item) => !("id" in item) || item.id !== id` 对无 id 项恒真**，守卫一删就会留下「点了没反应的死按钮」——必须改为 `(item) => conversationSelectionContextKey(item) !== conversationSelectionContextKey(reference)`
  4. `conversationSelectionContextKey` 已对无 id 项用 `${path}\0${text}` 兜底，去重（`mergeContextList` `:331-340`）与删除（`:866-877`）都走它 —— **不要给恢复项塞合成 id**，否则 live/restored 永不相等，同一选区会出两枚 chip
- 验收/测试：纯逻辑用例 ①无 id 选区的 key 稳定（同 path/同 text → 同 key）②live 与 restored 同选区去重后只 1 条 ③删除按 key 精确移除、其他条目不受影响 ④**编辑态无 id 选区可单删、其余条目不受影响**（`filter` 谓词用同一 key 函数）；形状守卫：chip 内不存在 `isConversationSelectionReference(reference) ? <Button` 分支，且两处 `onRemove` 均以 reference/key 形态传入。
- 来源：review-scope-composer round 1（提出）+ spec-check round 1（P0-1 修正改法）+ spec-check round 2（补第二调用点与 key 上移）

### composer/C-1 [P2] 链接正则常量重复定义

- 维度：C 质量（DRY）
- 文件：`packages/ui/src/mentions/mentionMarkdown.ts:3-4` 与 `:253-254`
- 问题：两处逐字相同；展示/装填**语义**分叉有意且已注释，但正则本身无分叉理由。
- 改法：删 `RICH_MENTION_LINK_PATTERN`，两处共用 `LINK_MENTION_MARKDOWN_PATTERN`（matchAll 克隆正则，`lastIndex` 无副作用）。
- 验收/测试：T-PR1 全绿；`git grep RICH_MENTION_LINK_PATTERN` 为 0。
- 来源：review-scope-composer round 1

### composer/G-1 [P2] 撤回→发送状态机只有源码正则形状守卫，无行为测试

- 维度：G 测试（缺口）
- 文件：`packages/ui/test/composerMentionPillFill.test.ts:63-120,184-249`；实现 `packages/ui/src/v4/ConversationComposer.tsx:1362-1412,1491-1512`
- 问题：`assert.match` 源码 + `countOccurrences === 2` 无法发现 B-1 这类「表达式写错来源」，也不覆盖失败回滚/等待期语义。
- 改法（抽取契约写死，避免「抽成纯函数」空转）：
  1. `resolveComposerSubmitAvailability({ text, attachments, contexts }) => { canSubmit, allowSubmitWhenEmpty, hasContent }` —— **与 B-1 共用同一函数**（B-1 负责接线，本条负责测试）
  2. `mergeContextList(restored, live, keyOf)`（已存在 `ConversationComposer.tsx:331-340`，**参数顺序 restored 在前**、语义是 live 覆盖 restored，直接导出，勿倒序）
  3. claim/rollback/finalize 抽成显式 reducer：`composerSubmitMachine.reduce(state, action)`，`state = { phase: "idle"|"claimed"|"failed", frozenContexts, liveContexts }`，`action = { type: "claim" | "succeed" | "fail" }`
- 验收/测试：T-PR2-7/8/9 —— ①restored+live 同 key 去重；②`fail` 后四类 chip 全保留；③`claimed` 期间新增 chip 不被 `succeed` 清除；④纯上下文输入 `canSubmit/allowSubmitWhenEmpty` 均为 true。**红判据**：把 `resolveComposerSubmitAvailability` 的 contexts 入参改成 live-only 时 ④ 必红（该函数是唯一判据，组件只转发）。
- 来源：review-scope-composer round 1（提出）+ spec-check round 1（P1-5 修正契约与红判据）

### composer/A-1 [P2] 上下文尾块在**气泡与队列行两处**都未剥离 —— 「同口径」注释在现状下反而成立，真实缺陷是双端都露内部块

- 维度：A 需求符合性 / B 正确性（r2 提出、r3 修正依据，主代理已亲验裁决）
- 文件：
  - 气泡侧（根因）：`packages/ui/src/v4/ConversationRowView.tsx:1006` `const visibleText = bodyText;` → 应在 `:1360,1362` 消费 `parsedPrompt.visibleContent`
  - 队列侧：`packages/ui/src/v4/ConversationQueueRow.tsx:129`
  - 面板透传缺口：`packages/ui/src/v4/ConversationQueuePanel.tsx:19-40` 无 `workspacePath`/`workspaceIdentity` prop
- 问题：`parseComposerPromptContexts` 已算出 `visibleContent`（`composerPromptContexts.ts:68-79`），但 `ConversationRowView.tsx:1006` 用的是 `bodyText`（原文，含四类尾块），只有编辑态 `:1150` 才用 `visibleContent`。`git log -S "const visibleText = bodyText;"` 指向 `f0da6e1d`（拆 share 链时把 `parsedShareContext.visibleContent` 退化回来），属基线既有缺陷。队列行 `:129` 直接把 `item.text` 交给 `ConversationUserInputContent`，同样不剥离 → **两处都显示 `# Code comments:` / `# userselect:` 等内部块**，纯上下文项预览更是只剩块。r2 认为「气泡已剥离」有误，r3 的判断经代码与 git 史核实成立。
- 改法：
  1. 气泡：`ConversationRowView.tsx:1006` 改为 `const visibleText = parsedPrompt.visibleContent;`（`parsedPrompt` 同作用域已有，`:1007-1010` 正在用；`:1150` 已是同口径）
  2. 队列：`QueueRow` 增 `previewText?: string` / `contextCount?: number` prop，由面板用 `parseComposerPromptContexts(item.text, { workspacePath, workspaceIdentity }).visibleContent` 计算传入，`title` 同用可见正文
  3. 面板：`ConversationQueuePanel` 补 `workspacePath` / `workspaceIdentity` prop，从**全仓唯一挂载点** `packages/ui/src/v4/SessionPane.tsx:3570` 透传（`ConversationComposer` 不挂该面板）—— 无 `workspacePath` 时 code-comments 段解析不出来（`composerPromptContexts.ts:64-77`）
  4. 可测性：把「队列项 → {预览正文, 上下文条数}」抽纯函数 `resolveQueuePreview(item, workspace)`，UI 只做渲染
  5. 状态同源一致性：`ConversationRowView.tsx:1040/1064/1072` 三处 `setDraft(bodyText)` 与编辑态 `:1150 initialValue={parsedPrompt.visibleContent}` 不同源，统一改为 `parsedPrompt.visibleContent`。（**注意**：r1 已否证「不改字直接重置会尾块重复」——`ChatPromptEditor` 首帧会 `setTextWithMentions(initialValue)` 回填可见正文、Lexical listener 不过滤 tag 会把 `draft` 改回可见正文，故该因果不成立；本条只是状态同源的一致性修复，**不写「尾块重复」验收**）
- 验收/测试：**不得依赖 jsdom**（本仓 ui 测试只有 `renderToStaticMarkup`，而 QueueRow 依赖 `useSortable`，无法 SSR）——改为纯逻辑用例：①`resolveQueuePreview` 对「仅 code comment 尾块」输入产出 `previewText === ""`、`contextCount === 1`；②带正文+尾块输入产出可见正文（不含 `# `块首）；③形状守卫断言 `ConversationRowView.tsx:1006` 消费 `parsedPrompt.visibleContent` + `parseComposerPromptContexts` 的 visibleContent 行为用例；④既有 `data-v4-queue-item-preview` 断言迁移到新 prop 后仍绿。
- 来源：review-full round 2（提出）+ review-full round 3（依据修正）+ 主代理亲验（`ConversationRowView.tsx:1006`、`git log -S`）

### composer/B-6 [P2] 恢复出的 skill chip 的 `value`/`data` 与 provider 契约不一致

- 维度：B 正确性（一致性；与 composer/B-4 同类，r2 新增）
- 文件：`packages/ui/src/mentions/mentionMarkdown.ts:313-315`；对照 `packages/ui/src/mentions/providers/skillsMentionProvider.ts:44-55`；消费点 `packages/ui/src/LexicalChatInput.tsx:221-226,312-313`
- 问题：富反解析 skills 分支产出 `value: destination`（技能**路径**）且不产 `data`；provider 口径是 `value: skill.name`、`data: { path, scope }`。`prependMentionIfMissing` 按 `category+value` 去重 → 恢复出的技能 chip 与同技能 live/prefill chip 无法互识，会重复插入；`richMentionNodeId` 随之给出 `skill:<path>` 而非 `skill:<name>`。发送字节不受影响（序列化用 `markdown`），属一致性缺陷。
- 改法：skills 分支改 `value: label.slice(1)`（技能名，与 provider 一致）并补 `data: { path: destination }`；同步改 `composerMentionPillParse.test.ts` T-PR1-2 的 skill 期望值（当前断言 `value === "./skills/cr.md"`）。若产品要求路径入 value，则须在 `prependMentionIfMissing` 的 key 里对 skills 特判，二选一并在注释写明。
- 验收/测试（r3 收窄，`id` 同形不可达）：
  - 断言 ①`value === 技能名`（label 去 `$`）、②`data.path === destination`、③`label` 与 provider `label` 一致
  - **不**断言 id 同形：provider id 是 `skill:${skill.id}`，`skill.id` 来自 `buildSkillId(provider/scope/name/path)`（`packages/services/src/skills/skillsService.ts:954-959`），markdown 只有 name/path 推不出；恢复态 id 只能到 `skill:<name>`，注释写明该限制
  - `data.scope` 恢复态不可知（markdown 无 scope 信息），`data` 只保证 `{ path }`，与 provider 全形不同 —— 注释写明
  - 行为用例：抽纯函数 `isMentionAlreadyPresent(existing, candidate)`（去重键 = `category + value`，供 `prependEditorMentionIfMissing` 复用），单测：同一技能（name 相同、path 不同）→ 已存在；不同技能 → 不存在。**不要**要求真实 Lexical editor harness（全仓 `packages/ui/test` 无 `createHeadlessEditor` 先例）
- 来源：review-full round 2（提出）+ review-full round 3（验收收窄）

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
- 改法：**取 (b) 注释保留**（与 S8 终局一致，r3 已对齐）——删除会连带删掉已通过的像素用例，且该段是上游测试兼容面；段首注明「生产零调用，仅上游测试兼容，接线待产品确认」，spec Step 18 同步写明。
- 验收/测试：`rg renderTaskbarBadgePixels packages/*/src` 仍仅命中该文件本体（形状守卫即可）；T-UF4 全绿。
- 来源：review-scope-desktop round 1

### desktop/H-1 [P2] 任务栏 overlay 无障碍描述硬编码英文

- 维度：H 兼容性 / J UI / I 可观测性
- 文件：`packages/desktop/src/main/unreadBadge.ts:304`
- 问题：`${options.label} unread tasks` 是 Windows 任务栏 tooltip/读屏描述，zh-CN 用户见英文；主进程其余原生文案均走 `formatDesktopMenuMessage`（`packages/shared/src/desktopMenu.ts:144-164`，已支持 `{count}`），只有这里绕过。
- 改法（**定案一条路**）：`desktopMenuMessageIds` 增 `taskbarUnreadTasks`，`desktopMenuMessages` 增 zh/en 两语；`applyTaskbarOverlayToWindows` 的 options 改收**已格式化 `description`**（不做 formatter 注入）。locale 源为 `desktopMainIpcPlatform.ts:70`（`currentApplicationLocale`），链路 `:245-250` → `handleWindowUnreadCountSync` → `syncApplicationUnreadBadge`（`desktopWindowLifecycle.ts:339`，当前只收 `windowUnreadCountMap`）→ **应把 `description` 设为必填入参**，让 typecheck 强制覆盖两个调用点：①`desktopMainIpcPlatform` 同步路径 ②`index.ts:1446`（关窗清理时重算 max）。文案由 **caller 侧**生成：`formatDesktopMenuMessage(locale, "taskbarUnreadTasks", { count })`（签名是 `(locale, id, values)`，勿倒序）。前提说明：主进程现有文案走 `getDesktopMenuMessage`（`desktopApplicationMenu.ts:28`/`desktopTray.ts:58`/`desktopWindowChrome.ts:320`），`formatDesktopMenuMessage` 目前零生产调用，本条首次接线。
- 验收/测试：`formatDesktopMenuMessage("zh-CN", "taskbarUnreadTasks", { count: 3 })` 产出中文、`"en-US"` 产出 `"3 unread tasks"`（纯逻辑用例）；T-UF4 的 description 断言改为从注入的 description 取值；typecheck 必须因必填入参而强制两个调用点都传值。
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
- 改法：把分区谓词抽到 `fileApplications.ts`（如 `partitionEditorDefs(defs) => { base, fileApplications }`），`editors.ts` 复用；**同时把 `getEditorDefsForCurrentPlatform()` 拆成 `getEditorDefsForPlatform(platform)`（`CurrentPlatform` 变薄包装）**——否则一进程只能断言当前平台（`process.platform` 不可注入）。
- 验收/测试：用 `getEditorDefsForPlatform("darwin"|"win32"|"linux")` + `getFileApplicationDefs(platform)` 断言三平台：`base` 不含任何带 `fileExtensions` 的 def、`fileApplications` 全含、`.pdf` 命中集合与首选项一致。
- 来源：review-scope-desktop round 1

### desktop/B-3 [P2] 托盘/overlay 徽章缓存冗余（按 label 存多份等价图）

- 维度：C 质量 / E 性能
- 文件：`packages/desktop/src/main/desktopTray.ts:132-136,167-190`、`packages/desktop/src/main/unreadBadge.ts:317-337`
- 问题：`composeTrayBadgeRepresentation(label, ...)` 的 `label` 形参未使用；按 label 缓存 10 张视觉相同图；`createBadgeImage(cachedLabel)` 忽略 label 同样按 label 存 10 份等价 `nativeImage`。
- 改法：托盘去 `label` 形参改单槽缓存；`createBadgeImage` 改零参 + 单槽缓存，label 仅用于 description。
- 验收/测试：**连续两次同 label 只建一次 + 换 label 复用同一槽**（单槽语义下不同 label 也只建一次，别再写「按 label 各建一次」）；T-UF4 断言改为 `createBadgeImage` 调用次数不变式。
- 来源：review-scope-desktop round 1

### provider/B-1 [P2] 重名与创建失败共用横幅导致错配

- 维度：B 正确性
- 文件：`packages/ui/src/settings/model-provider-section/ProviderCreateNameDialog.tsx:76,160-179`
- 问题：`blockingMessage = duplicateMessage ?? errorMessage` 用重名掩盖 create 错误，但重试按钮（:168）与 `data-provider-create-error`（:164）仍按 `errorMessage` 判定 → 「Provider 名称已存在」+ 禁用的「重试」按钮 + 属性标成 `create`。
- 改法：提纯 `resolveCreateProviderBanner({ resolution, errorMessage }) => { kind, showRetry }` —— **不返回展示串**（展示文案统一由 `kind` 映射到 i18n 键，见 provider/B-3，避免两处文案来源打架）：`kind ∈ "duplicate" | "create" | "empty" | null`，优先级 **`duplicate > empty > create`**（`empty` 指 trim 后为空，优先于任何服务端错误；`create` 仅在有 `errorMessage` 时成立），`showRetry = kind === "create"`；组件按 `kind` 渲染：`duplicate → settings.modelProvider.nameExists`、`create → settings.modelProvider.templateCreateFailed`、`empty → forms.validation.nameRequired`；`data-provider-create-error` 直接取 `kind`。
- 验收/测试：纯函数单测覆盖 4 分支 + 两个组合：①duplicate+error 并存 → `kind === "duplicate"`、`showRetry === false`；②empty+error 并存 → `kind === "empty"`、`showRetry === false`；③仅 error → `kind === "create"`、`showRetry === true`；④全空 → `kind === null`。属性断言：`data-provider-create-error` 取 `kind`。
- 来源：review-scope-provider round 1

### provider/B-2 [P2] 空名/纯空白零反馈（静默拦截）

- 维度：B 正确性 / J UI
- 文件：`packages/ui/src/settings/model-provider-section/ProviderCreateNameDialog.tsx:74-77,160`
- 问题：`status === "empty"` 时两 message 均 null → 不渲染 `role=alert`，用户只见确认按钮变灰。
- 改法（**定案，不留二选一**）：必填提示必须给 —— `kind === "empty"` 时渲染 `role=alert` 提示，**复用已对称存在的键** `forms.validation.nameRequired`（`zh-CN.ts:5869` / `en-US.ts:6274`），不新增键。
- 验收/测试：形状守卫（无 jsdom）—— ①源码含 `forms.validation.nameRequired` 且在 `kind === "empty"` 分支内；②`resolveCreateProviderBanner` 对空名/纯空白返回 `kind === "empty"`（纯函数用例）；③`i18n-key-merge --verify` 仍绿（未新增键）。
- 来源：review-scope-provider round 1

### provider/A-1 [P2] 模板路径复用了「完全自定义」描述文案

- 维度：A 需求符合性 / J UI
- 文件：`packages/ui/src/settings/model-provider-section/ProviderCreateNameDialog.tsx:114-116`；locales 中 `addProviderDescription`
- 问题：从供应商目录选模板时，弹窗描述仍称要配「完全自定义 API 端点」；模板路径实际由模板基线提供端点与模型。不能直接删 Description（Radix 会告警缺 description），应换文案。
- 改法：按 `pick?.templateId` 选描述键，新增对称键 `settings.modelProvider.addProviderFromCatalogDescription`（如「从供应商目录模板创建，创建后可继续调整连接与模型。」）。
- 验收/测试：两种 pick 的弹窗描述分别正确，两语言对称。
- 来源：review-scope-provider round 1

### provider/B-3 [P2] 重名文案跨包字面量复制 + en-US 界面显示中文（重命名侧则静默吞错）

- 维度：C 质量（DRY）/ F 注释 / J i18n 对称
- 文件：`packages/ui/src/settings/model-provider-section/createProviderNameDialog.ts:8-13`；`packages/ui/src/settings/model-provider-section/ProviderCreateNameDialog.tsx:75,167`；`packages/provider/src/config-service.ts:600`；`packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx:523-537`；`packages/ui/test/modelProviderNameDialog.test.ts:72,191`
- 问题：三件独立缺陷——(1) UI 常量是复制而非引用，服务层改文案即静默漂移；注释暗示「创建失败会抛重名错」，实际 `createPersonalProvider` 走 `nextPersonalProviderLabel` 自动加序号（`config-service.ts:232-238,734-747`）。(2) 弹窗 `:75/:167` 直接渲染中文常量 → **en-US 用户看到中文**。(3) 重命名侧并不渲染该常量——`handleNameBlur` 走 `commitPendingDraft(...).catch(() => undefined)`（`InlineEditableProviderCard.tsx:531`）**静默吞错**，用户改名撞重名时零反馈（独立缺陷，登记为 open observation，不在本条修）。
- 改法：(1) 在 `@zcode/provider` 导出文案前缀常量，服务层与 UI 共用（UI 只做前缀匹配判定）；注释改为「对齐重命名路径报错文案；创建路径服务层自动加序号，前端拦截更严格」。(2) 展示改走 provider/B-1 的 `kind → i18n 键` 映射（`duplicate → settings.modelProvider.nameExists`，新增对称键 zh「Provider 名称已存在」/ en「Provider name already exists」），服务层原始串不再上屏。(3) **同批更新测试**：`modelProviderNameDialog.test.ts:72`（断言常量等值）、`:191`（断言 dialog 源码含 `PROVIDER_NAME_EXISTS_MESSAGE`）在此改动后必红，须一并改为断 `nameExists` 键。
- 验收/测试：文案单一定义处（服务层导出前缀 + i18n 键各一处）；`i18n-key-merge --verify` 绿；`modelProviderNameDialog.test.ts` 两处断言已改且绿；形状守卫断言 dialog 不存在直接渲染 `PROVIDER_NAME_EXISTS_MESSAGE` 的分支。
- 来源：review-scope-provider round 1（提出）+ spec-check round 1（P1-9 前提修正与测试清单）

### provider/G-1 [P2] 创建在途互斥、清错时机、横幅分支缺少守卫

- 维度：G 测试（缺口）
- 文件：`packages/ui/test/modelProviderNameDialog.test.ts`（缺项）；`packages/ui/src/settings/ModelProviderSection.tsx:290,844-849`
- 问题：`createProviderInFlightRef` 双击互斥、提交前 `setCreateProviderError(null)`、B-1/B-2 的横幅分支都是本轮新行为，T-PV1 只覆盖纯校验与挂载点形状（AGENTS.md 要求行为改动补测）。
- 改法：B-1 纯函数落单测；形状守卫补三条：`createProviderInFlightRef.current` 在 await 前同步置位、`setCreateProviderError(null)` 在 await 之前、弹窗禁用在途关闭（`if (!next && !creating)`）。
- 验收/测试：抽掉互斥或清错任一处，对应用例红灯。
- 来源：review-scope-provider round 1

---

## Spec deviations

> 状态汇总（**终态，无 open**）：S1-S7 / S9-S12 / S14-S18 / S20-S26 = `accepted`（按行内处置回写 spec 或注释口径）；S8 = `fixed`（终局取 (b) 注释保留，与 desktop/C-1 同源）；S13 = `fixed`（弹窗内 role=alert 为最终形态）；S19 = `accepted`（风险已登记 R-C，`remote-project.host-limit` 的 i18n 键留后续批）；**S27-S29 = 执行期新增并已闭合**（见文末「执行记录」）。
> 已登记 deviation 均不阻塞本 fix-spec 执行；「待用户确认」的只有 open questions 里的产品向问题（Q1/Q2/Q3）。

| # | 内容 | 证据 | 建议处置 |
|---|---|---|---|
| S1 | 草稿 schema 新增 `promptContexts` 载体，`readDraft` 由「必须有非空正文」放宽为「正文或载体至少一样」，`promoteComposerDraft` 显式剥离载体 | `composerDraftStore.ts:38-46,284-325,448-463`；`useDraftConfigControl.ts:348-369` | 视为 fix-pill 根修的必要扩展；Step 26 写入 spec（含「旧客户端读纯上下文草稿会丢弃」的兼容说明） |
| S2 | `setTextWithPluginMentions` 由「plugin 专用」变为富装填别名，外部预填 plugin 分支语义随之扩大（现在也把同批 file/skill/session 链接转 chip） | `ConversationComposer.tsx:277-279` | 接受；CHANGELOG 与 spec Step 21 补一句 |
| S3 | `updateComposerContent` 签名收窄为 `V4ComposerDraftContentUpdate`，「无条件清 editorStateJson/mention」改为「仅正文写入时清」（影响所有既有调用点） | `useDraftConfigControl.ts:324-335` | **终态**：签名保留并**扩展为「值 or 函数」双形态**（与 composer/B-2 一致，「收窄」措辞作废）；回写 spec 写终态 |
| S4 | T-PR2-1/2 用 `countOccurrences === 2` 锁源码字面量次数，纯格式化即红 | `composerMentionPillFill.test.ts` | 降级为 `>= 1` + 负向断言（并入 composer/G-1 同批） |
| S5 | `services` 六值导出落 `node.ts` 而非 spec 写的 `index.ts`（renderer barrel 不得引 `node:crypto`） | `services/src/index.ts:128-132` 禁令注释 | 接受；Step 26 回写 spec 正文 |
| S6 | 0008 的「幂等」仅行级成立，`membership_id` 每次重跑换新 UUID | `migrate-projects.ts:91-99` | 记入 spec 风险表，不作「完全幂等」引用 |
| S7 | `migrateConnectionHostsOnUpgrade` 不动 `tasks.host_id`（上游同形） | `migrate-projects.ts` 全文 | 接受；spec 明确「收敛范围=projects/entries」 |
| S8 | 数字徽章渲染段带入（生产零调用） | `unreadBadge.ts:61,76-180` | **终局：取 (b) 注释保留**——删除会连带删掉已通过的像素用例，且该段是上游测试兼容面；段首注明「生产零调用，仅上游测试兼容，接线待产品确认」，spec Step 18 同步写明 |
| S15 | `TaskIndexRepo` 调用点 11 处 / 9 文件（spec 记 8 处），3/4 参签名全兼容 | `taskIndexRepo.ts:487-492` 等 | 接受；Step 26 回写 spec 计数 |
| S16 | T-RP3/T-RP4 宿主落 `services/test` 却 import `desktop/src/host/*`（services 无 test 工程） | `remoteProjectsService.test.ts:38,41` | **定案：拆纯函数**（不补 services test 工程）；Step 26 按此回写 |
| S17 | 0008 用 `ensureHost(INSERT OR IGNORE)+UPDATE` 而非 spec 字面 `ON CONFLICT`（语义等价，T-RP5 覆盖） | `migrate-projects.ts:88-99,115-124` | 接受；spec 措辞改为「幂等 upsert」 |
| S18 | 队列行预览复用 `ConversationUserInputContent`（与 composer/A-1 同源） | `ConversationQueueRow.tsx:129` | `fixed`：实现路径不变，但按 composer/A-1 增 `previewText` prop 传入已剥离正文 |
| S19 | admission 20 host 上限进入真实连接路径；`remote-project.host-limit` 全仓无 i18n/错误码映射（第 21 台设备见裸错误码） | `remote-projects/index.ts:41-50` | **定案：只登记风险（R-C），i18n 键留后续批**；spec 风险表 + CHANGELOG 已知问题逐字（见 R-C 行） |
| S20 | Step 13 额外改 `packages/ui/src/lib/nodeReplToolDisplay.ts`（spec 只列 3 文件） | 该文件 | 接受（必要依赖，已登记 D18）；spec Step 13 补文件 |
| S21 | 托盘红点仅 Windows（fork 平台范围） | `desktopTray.ts` | 接受（D19）；spec Step 18 补平台范围 |
| S22 | T-UF1 的 `isInvalidPort` 断言跨节点归 Step 14 | `u5u6SurvivorsShape.test.ts` | 接受（D20）；Step 26 补映射说明 |
| S23 | `GetInstalledEditors` IPC 契约放宽：request 由 `void` 变 `string \| undefined`，全链改签名（window/preload/renderer/main/client） | `channels.ts:926`、`preload/index.ts:589`、`desktopMainIpcPlatform.ts:332`、`platform.ts:857`、`client/src/globals.d.ts:243` | 向后兼容（可选参）；Step 17 补「平台契约变更」 |
| S24 | `unreadBadge` 公共面改名/转导出（`syncAppUnreadBadge→syncUnreadBadgeForPlatform`、`sumWindowUnreadCounts→maxWindowUnreadCounts`，另 3 个函数私有转导出 → knip 面变化） | `unreadBadge.ts` | 接受；Step 18 与 D4 knip 基线一并登记 |
| S25 | 草稿恢复第 6 处富装填（`restorePersistedComposerDraftIntoInput` 也切到 `setTextWithMentions`，刷新后恢复的草稿也会转 chip） | `ConversationComposer.tsx:229-231` | 并入 S2 证据；spec Step 21 的「5 个 setText 点」改为「5 个 setText 点 + 1 个草稿恢复入口」 |
| S26 | `getEditorDefsForCurrentPlatform()` 语义扩大为 `[...IDE, ...getFileApplicationDefs()]`（Linux 只返回文件应用），基座过滤改在函数外 | `editors.ts:676-702` | 接受；spec Step 17 注明「文件应用只经 filePath 附加」 |
| S9 | `sharedImageSrc` / `image.src` 在本仓无生产者，属预埋兼容 | `cuaScreenshotDetails.ts`、`nodeReplToolDisplay.ts` | 接受；与 desktop/F-1 注释同批 |
| S10 | T-PV2 的「名称提交归一化」纯逻辑实际落在 T-PV1 宿主 | `modelProviderNameDialog.test.ts:150-183` | 修正 spec 用例→宿主映射 |
| S11 | 新增 `DROP_KEYS` i18n 工具链机制未在 spec/CHANGELOG 登记 | `scripts/i18n-key-merge/config.mjs:38-43,65-67`；`merge.mjs:25,43` | Step 26 补 spec i18n 段落 + CHANGELOG |
| S12 | `trash` 删除按钮取 `icon-sm`（Step 25 文本与 SubagentsSection 实际 `icon-md` 内部矛盾） | `ProviderCardSections.tsx:135` vs `SubagentsSection.tsx:572` | 接受现状；spec 改口径 |
| S13 | 创建失败横幅落弹窗内 `role=alert` + 重试（详情栏横幅被模态遮住） | `ProviderCreateNameDialog.tsx:160-179` | 接受（功能更优）；spec Step 23 改口径 |
| S14 | Step 23 提交直调 `createPersonalProvider`（`ProviderDraftSave` 无创建入口） | `ModelProviderSection.tsx:851` | 接受；spec 措辞改正 |

---

## Open questions（不阻塞 fix-spec-ready，需用户/后续节点拍板）

1. **（最高价值，r2 复评为 P1 级静默数据丢失）非桌面入口用空 settings 抢先烧掉 0005/0008 账本**：`TaskIndexRepo.initialize` 无条件跑 `projectStorage.migrate`，`createLocalServices` 固定传 `undefined` settings（`node.ts:1338`）；若升级后先起 web/server 入口（`packages/server/src/entry-http.ts:17`、`stdioServices.ts:38`，共用同一 `~/.omz/tasks-index.sqlite`），会以空 settings 应用 0005 并记账 → desktop Worker 跳过后**旧项目与入口永久不迁移**。上游同形（继承风险）。三选一需拍板：①非桌面入口自带 settings（上游 `createServerHostServices` 形态）；②0005 seed 改成「账本在但 seed 空时补跑」；③接受现状但**必须在 spec 风险表 + CHANGELOG 明写「升级后必须先启动一次桌面端」**。
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

## 风险登记（按↓行内落点执行：R-A/R-B/R-C 均进 spec 风险表；CHANGELOG 见各行条件）

| 风险 | 触发条件 | 后果 | 登记落点（逐字写入） |
|---|---|---|---|
| R-A 空 settings 抢烧迁移账本 | 升级后**先**启动 web/server 入口（`packages/server/src/entry-http.ts:17` / `stdioServices.ts:38`），再启桌面端 | 0005 以空 settings 应用并记账 → desktop Worker 跳过 → 旧项目/连接入口**永久不迁移** | spec 风险表必写；CHANGELOG **条件式**：仅当 open Q1 取③（接受现状）时逐字写入发版说明「升级后请先启动一次桌面端，再启动 web/服务器入口；否则旧项目与远端入口不会自动迁移（后续版本提供补跑）」；Q1 未拍板前**只落 spec 风险表、不发版说明**（取①/②时该句是错误承诺） |
| R-B 未读角标双源 | 关闭通知后未读数变化 | 角标被另一路重新点亮，与门控语义矛盾 | spec 风险表（**仅 spec，不进 CHANGELOG**）：「未读角标当前有两个写入源（Root 无门控 / 项目树带 notificationEnabled 门控），U12 后于任务栏/托盘可见；单一 owner 待产品裁定」 |
| R-C host 上限裸错误码 | 接入第 21 台设备 | 用户看到 `remote-project.host-limit` 原文 | spec 风险表：「远端设备成员上限 20，超限时错误码 `remote-project.host-limit` 尚无 i18n 映射，UI 以原文串展示」；CHANGELOG 已知问题逐字：「接入第 21 台远端设备时会显示 `remote-project.host-limit` 原始错误码（暂未本地化）」 |

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

1. spec 回写：S1-S26 按「状态汇总」的终态回写 `docs/iterations/backlog-sweep/spec.md`，涉及章节 **Step 1、2、13、14、17、18、21、22、23、25、26 + 风险表**；「用例→宿主映射」的落点写死在 spec 的**测试策略小节下新增「用例宿主」列/表**（现有 spec 只有 T-* 用例清单，没有宿主列）
   - **风险登记三行**（R-A/R-B/R-C）逐字进 spec 风险表
   - **CHANGELOG 是条件式**：R-A 的发版说明「升级后请先启动一次桌面端…」**只在 open Q1 取③时写入**；若取①/②，该句会变成错误承诺，故 Q1 未拍板前只登记 spec 风险表、不发版说明。R-C 的已知问题句可无条件写入
2. CHANGELOG：`setTextWithPluginMentions` 语义扩大（含草稿恢复入口 S25）、草稿 schema 新增载体、DROP_KEYS 工具链、`GetInstalledEditors` 契约放宽、unreadBadge 导出面变化
3. `host/index.ts:1701` 注释仍引「spec Step 19」（本轮 Step 19 = U10，deployServer 退役属 Step 11）→ 顺手改正（上一轮遗留）
4. `test:v4-perf` 分组一致性：纯 node 测试（modelProviderNameDialog/CardActions）挂在带 `setup-ui-component-test.mjs` 的 UI 批末组，语义上更接近 `tsx --test` 批
5. 调试残留已清（`+m.length+`/`Close'))hits.push(p)` 等工程垃圾已删）；`.reference/`、`.tools/` 属工具目录，保持 untracked

---

## 执行记录（code-dev-loop，2026-10-23）

**判决 → 执行 → 复验**：本 fix-spec 经 spec-check-loop 三轮（r3 Go）后由 code-dev-loop 执行。DAG：`impl-composer / impl-desktop / impl-provider / impl-svc` 四路并行 → `register-tests`（主代理）→ `verify-{composer,desktop,provider,svc}` 四路独立复验 → `cr-func-{…}` 四路 readonly 功能小检 → `gates-and-spec-writeback`（主代理）。

- **26 条 must-fix 全部落地**（2 P1 + 24 P2），24 个提交：`c5e20bcd 156e0ac1 93568113 9e84851d fbb95320 a49ba4fe 23e583c7 6f93b1b1 5fb16992 3c923a9f 6e371dbd 22021db5 65cbcb67 af91ee4a 5f6ca731 2fd266dc 93db869f 707d4d25 1e232046 845cf893 87c99fba 14731c7c`
- **verify 四路全 pass**；**cr-func 四路 `func-ready: yes`**，开放 must-fix = 0
- **门禁**：root typecheck 0 错；desktop typecheck 169 = 基线零新增；lint 149w/0e（=基线，全在 `.reference/` 与既有文件）；oxfmt 触碰面 51 文件 clean；`test:v4-perf` 47 批 / **743 pass / 0 fail**（基线 712 + 本轮新增 31）

### 执行期新增 deviations（已闭合，同步进 spec）

| # | 内容 | 处置 |
|---|---|---|
| S27 | 会话选区 chip 跨来源去重必须用**内容键**：恢复项（`parsePromptConversationSelections` 产出）没有 id，live 项一定有 id，只按身份键判重时「撤回后再选同一段」会同时出两枚 chip | `conversationSelectionContextKey`（id 优先，身份/删除用）+ 新增 `conversationSelectionContentKey`（`path\0text`，跨来源判重用）；`mergeContextList` 增可选 `contentKeyOf`，仅会话选区传内容键；用例补真实形态（live 带 id、restored 无 id）与「只给身份键时保持旧行为」双向断言 |
| S28 | `editorDefinitions.ts`（272L）为 G-1 抽出的 electron-free 平台登记表（新文件，spec 未列） | 不拆则 `getEditorDefsForPlatform(platform)` 无法在 node 测试注入三平台；Step 17 已登记 |
| S29 | `composerSubmitMachine` 的 `succeed` 组件侧恒为「live 减 frozen（=冻结面克隆）」= 0，是无保护力的死判定 | 删除该判定、注释改为真实保护（逐项移除 + live chip 从不写进载体 + revision 只覆盖正文），reducer subtract/union 语义仍由 T-PR2-8/9 锁死；claim/fail 仍真实接线 |

### cr-func 复检项收口（P2 全清）

- B-5 验收②「同选区只 1 条」原用例用两条**无 id**项代餐，对命名场景恒绿 → 已由 S27 根修 + 真实形态用例替换
- `ConversationComposer` succeed 注释宣称「revision 保护 chip 新增」（revision 只在改正文时自增）→ 注释改真实口径
- `desktopTray` 单槽缓存注释称「数量进无障碍/Tooltip 文案」（托盘侧只当布尔闸）→ 已改
- `unreadBadge` 段首注释称「下面的字形常量」（实际在上方且配色与圆点渲染器共用）→ 已改
- `createProviderNameDialog` 注释称「必填优先于任何服务端错误」（实际 `duplicate > empty > create`）→ 已改
- `taskIndexRepo` 注释「每次启动都跑版本化迁移」→ 限定为「走到这里的业务连接（prepared 早退除外）」
- svc 去重子查询缺 `host_id=stable` 限定也能全绿 → 非冲突用例补 `deleted=0` 断言
- provider G-1 缺 `creating={creatingProvider}`/`setCreatingProvider` 接线断言 → 补用例

### K 节状态

K1（spec 回写 + R-A/R-B/R-C 入风险表 + 用例宿主表）= **已闭合**；K2（CHANGELOG 逐条语句）= **待 Step 27 落笔**（R-C 已知问题句无条件写；R-A 发版说明只在 open Q1 取③时写，Q1 仍未拍板）；K3（`host/index.ts:1701`/`:1464`、`serverRemoteConnection.ts:51` 的「spec Step 19」→ Step 11）= 已闭合；K4（两个 provider 测试迁回 `tsx --test` 批）= **不可行**（`@/lib` 别名在 `tsx --test` 下解析失败），保持现批并登记；K5（调试残渣）= 已清。
