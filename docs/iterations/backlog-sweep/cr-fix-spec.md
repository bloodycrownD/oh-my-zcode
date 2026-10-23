# CR Fix Spec: backlog-sweep wave-0/wave-1（Step 1-2 / 12-13 / 17-18 / 20-25）

## 元信息

- repo: `D:\Dev\Js\oh-my-zcode`
- base_sha: `6f5ba008`
- head_sha: `09286069`
- prd_path: 未提供
- spec_path: `docs/iterations/backlog-sweep/spec.md`
- review_round: 3（r1 首诊 4 scope → r2 末轮覆核 → r3 回归 → r4 回归终审 yes）
- dag_version: 4
- 状态：**fix-spec-ready**
- 本轮结论：**not-ready**（P0=0 / P1=2 / P2=24，共 26 条 must-fix；P2 含 r2 新增 `composer/A-1`、`composer/B-6`）

评审来源：`review-scope-svc`、`review-scope-composer`、`review-scope-desktop`、`review-scope-provider`（r1 首诊，readonly 非自审）+ `review-full`（r2 末轮全局覆核 + r3 回归验证）。修复轨迹：r1 出 24 条 → r2 补 2 条并通过 20 条、指出 2 条改法不足 → r3 回归 6 项，闭合 4 项，修正 `composer/A-1` 依据（气泡侧同为缺陷）、收窄 `composer/B-6` 验收。

---

## Must-fix（P1）

### composer/B-1 [P1] 恢复态载体未进入 `hasDraftToSubmit` / `hasComposerDraftContent`——纯上下文队列项二次撤回丢消息且队列编辑永久卡死

- 维度：B 正确性 / C-orch（「restored 是否算草稿内容」两套口径）
- 文件：`packages/ui/src/v4/ConversationComposer.tsx:1266-1285`、`:2275-2283`（`allowSubmitWhenEmpty`）、`packages/ui/src/LexicalChatInput.tsx:795`（`shouldSubmitLexicalEnter`）、`packages/ui/src/v4/SessionPane.tsx:2655`
- 问题：`submit` 允许「空正文 + 仅四类上下文」发送；该队列项撤回后 `visibleContent === ""`，chip 只存在于 `composerDraft.promptContexts`，live hooks 恒空 → 三个表达式全为 false：`hasDraftToSubmit`、`hasComposerDraftContent`、**`allowSubmitWhenEmpty`**（后者决定 Enter 是否放行）。后果：(a) 发送键不亮且 Enter 被判空；(b) `hasContent=false` 使 SessionPane 撤回冲突门禁放行，`deleteQueueItem` 已 ACK 删除后，Composer 内部 `hasDraftContent`（`:1038-1044`，含 merged 载体）判 true 而拒绝应用 → 队列项已从 Host 删除却永不恢复，`onComposerRestoreApplied` 不触发 → `queueEditOperationRef` 永不清空，该会话此后无法编辑任何队列项。改动前不可达（旧实现把尾块塞进可见正文 → text 非空），属本轮引入的回归。
- 改法：**三处表达式**（`hasDraftToSubmit`、`hasComposerDraftContent`、`allowSubmitWhenEmpty`）的四类判断统一改用已算好的 `mergedCodeCommentContexts / mergedWebElementContexts / mergedPptxElementReferences / mergedConversationSelections`（与发送序列化同源），口径对齐 `ConversationRowView.tsx:1153` 的 `editContextCount`；在 `applyComposerRestoreRequestToComposer` 因 `hasDraftContent` 提前返回处补 `logger.warn`（静默挂起是 B-1 难以察觉的根因）。
- 验收/测试：①纯上下文队列项撤回后**发送键可点且 Enter 可发**（两条入路分别断言），发送后 `promptText` 含四类尾块；②同会话再点另一队列项「编辑」→ 出 `chat.queue.editDraftConflict` toast 且不发生 `deleteQueueItem`；③把三处任一表达式改回 live-only，新用例必须转红；④状态文件 `P2 hasDraftToSubmit 不含 restored 载体` 随之关闭。
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
- 问题：`migrationBackupSkipped` 全仓零读取方（`git grep` 仅这两处）；上游在 `node.ts:3203-3205` 消费做 main 提示，omz 无消费方，且 Host 侧实例因早退永不赋值 → 字段与实际双死。
- 改法：删除字段与 `:545` 的 `const migration =` / `:552` 赋值（保留 `await projectStorage.migrate(...)`）；或按上游在 main 提示面接线。二选一，不留死状态。
- 验收/测试：`pnpm typecheck` 绿；`git grep migrationBackupSkipped` 归零（注：knip 不检查类字段，不能作为验收手段）。
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
  5. 同源退化连带修：`ConversationRowView.tsx:1040/1064/1072` 三处 `setDraft(bodyText)` 与编辑态 `:1150 initialValue={parsedPrompt.visibleContent}` 不同源 —— 编辑态下**不输入任何字符**直接点「重置会话与文件」（`:1137`）/「仅重置会话」（`:1285`）会把含四类尾块的原文再交给 `serializeComposerPromptContexts` 拼一次尾块，**尾块重复污染提交文本**。三处同改 `parsedPrompt.visibleContent`
- 验收/测试：**不得依赖 jsdom**（本仓 ui 测试只有 `renderToStaticMarkup`，而 QueueRow 依赖 `useSortable`，无法 SSR）——改为纯逻辑用例：①`resolveQueuePreview` 对「仅 code comment 尾块」输入产出 `previewText === ""`、`contextCount === 1`；②带正文+尾块输入产出可见正文（不含 `# `块首）；③给 `ConversationRowView` 抽同源纯函数（或直接断言 `:1006` 消费 `parsedPrompt.visibleContent` 的形状守卫 + `parseComposerPromptContexts` 的 visibleContent 行为用例）；④既有 `data-v4-queue-item-preview` 断言迁移到新 prop 后仍绿；⑤编辑态空改直接重置 → 提交文本的尾块只出现一次。
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
  - 行为用例：`prependMentionIfMissing` 对同一技能（恢复 chip + live chip）不再重复插入
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

### provider/B-3 [P2] 重名文案跨包字面量复制，注释声称同源且对创建路径不成立；且 en-US 界面显示中文

- 维度：C 质量（DRY）/ F 注释 / J i18n 对称
- 文件：`packages/ui/src/settings/model-provider-section/createProviderNameDialog.ts:8-13`；`packages/provider/src/config-service.ts:600`
- 问题：两件独立缺陷——(1) UI 常量是复制而非引用，服务层改文案即静默漂移；注释暗示「创建失败会抛重名错」，实际 `createPersonalProvider` 走 `nextPersonalProviderLabel` 自动加序号（`config-service.ts:232-238,734-747`）。(2) 弹窗与重命名侧都直接渲染该中文常量 → **en-US 用户看到中文**，违反 AGENTS.md i18n 对称。只统一常量定义并不能解决 (2)。
- 改法：(1) 在 `@zcode/provider` 导出文案前缀常量，服务层与 UI 共用（UI 只需前缀匹配）；注释改为「对齐重命名路径报错文案；创建路径服务层自动加序号，前端拦截更严格」。(2) 前端展示改走 i18n：新增对称键 `settings.modelProvider.nameExists`（zh「Provider 名称已存在」/ en「Provider name already exists」），UI 用该键渲染，服务层错误串仅用于**判定**（按导出前缀匹配）不用于展示；若重命名侧也存在同样问题，同批改到同一键。
- 验收/测试：文案单一定义处（服务层常量 + i18n 键各一处）；`i18n-key-merge --verify` 绿；en-US 下重名提示为英文（断言 `nameExists` 两语言齐备）；一条断言保证 UI 展示值来自 i18n 键而非服务层原始串。
- 来源：review-scope-provider round 1

### provider/G-1 [P2] 创建在途互斥、清错时机、横幅分支缺少守卫

- 维度：G 测试（缺口）
- 文件：`packages/ui/test/modelProviderNameDialog.test.ts`（缺项）；`packages/ui/src/settings/ModelProviderSection.tsx:290,844-849`
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
| S8 | 数字徽章渲染段带入（生产零调用） | `unreadBadge.ts:61,76-180` | **终局：取 (b) 注释保留**——删除会连带删掉已通过的像素用例，且该段是上游测试兼容面；段首注明「生产零调用，仅上游测试兼容，接线待产品确认」，spec Step 18 同步写明 |
| S15 | `TaskIndexRepo` 调用点 11 处 / 9 文件（spec 记 8 处），3/4 参签名全兼容 | `taskIndexRepo.ts:487-492` 等 | 接受；Step 26 回写 spec 计数 |
| S16 | T-RP3/T-RP4 宿主落 `services/test` 却 import `desktop/src/host/*`（services 无 test 工程） | `remoteProjectsService.test.ts:38,41` | 接受（登记 D5）；Step 26 评估补 services test 工程或拆纯函数 |
| S17 | 0008 用 `ensureHost(INSERT OR IGNORE)+UPDATE` 而非 spec 字面 `ON CONFLICT`（语义等价，T-RP5 覆盖） | `migrate-projects.ts:88-99,115-124` | 接受；spec 措辞改为「幂等 upsert」 |
| S18 | 队列行预览复用 `ConversationUserInputContent`（与 composer/A-1 同源） | `ConversationQueueRow.tsx:129` | 接受实现路径，但须按 composer/A-1 补尾块剥离 |
| S19 | admission 20 host 上限进入真实连接路径；`remote-project.host-limit` 全仓无 i18n/错误码映射（第 21 台设备见裸错误码） | `remote-projects/index.ts:41-50` | spec 风险表 + CHANGELOG 登记；建议与 open Q3 同批补键 |
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

## 风险登记（须写入 spec 风险表 + CHANGELOG，r3 要求先落行再放行）

| 风险 | 触发条件 | 后果 | 登记落点（逐字写入） |
|---|---|---|---|
| R-A 空 settings 抢烧迁移账本 | 升级后**先**启动 web/server 入口（`packages/server/src/entry-http.ts:17` / `stdioServices.ts:38`），再启桌面端 | 0005 以空 settings 应用并记账 → desktop Worker 跳过 → 旧项目/连接入口**永久不迁移** | spec 风险表 + CHANGELOG 发版说明：「升级后请先启动一次桌面端，再启动 web/服务器入口；否则旧项目与远端入口不会自动迁移（后续版本提供补跑）」 |
| R-B 未读角标双源 | 关闭通知后未读数变化 | 角标被另一路重新点亮，与门控语义矛盾 | spec 风险表：「未读角标当前有两个写入源（Root 无门控 / 项目树带 notificationEnabled 门控），U12 后于任务栏/托盘可见；单一 owner 待产品裁定」 |
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

1. spec 回写：S1-S26 全部落 `docs/iterations/backlog-sweep/spec.md`（Step 2/13/17/18/21/22/23/25/26 + 风险表 + 用例→宿主映射），其中**「风险登记」表的 R-A/R-B/R-C 三行须逐字进 spec 风险表，且 R-A 与 R-C 两行同时逐字进 CHANGELOG**（R-A 进发版说明、R-C 进已知问题）；open Q1 的最终方案待用户拍板，但风险行现在就要落
2. CHANGELOG：`setTextWithPluginMentions` 语义扩大（含草稿恢复入口 S25）、草稿 schema 新增载体、DROP_KEYS 工具链、`GetInstalledEditors` 契约放宽、unreadBadge 导出面变化
3. `host/index.ts:1701` 注释仍引「spec Step 19」（本轮 Step 19 = U10，deployServer 退役属 Step 11）→ 顺手改正（上一轮遗留）
4. `test:v4-perf` 分组一致性：纯 node 测试（modelProviderNameDialog/CardActions）挂在带 `setup-ui-component-test.mjs` 的 UI 批末组，语义上更接近 `tsx --test` 批
5. 调试残留已清（`+m.length+`/`Close'))hits.push(p)` 等工程垃圾已删）；`.reference/`、`.tools/` 属工具目录，保持 untracked
