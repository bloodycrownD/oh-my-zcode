# CR Fix Spec: phase1 遥测移除收口（Phase 0+1 全量改动评审）

## 元信息
- repo: D:\Dev\Js\oh-my-zcode\omz（分支 dev/phase-0）
- base_sha: c34a938（tag baseline/v3.14.3） / head_sha: 0e4c58d（tag phase1/telemetry-removed）
- prd_path: 无（需求内嵌 spec「需求来源」） / spec_path: docs/iterations/oh-my-zcode-fork/spec.md
- review_round: 2→3（轮2 review-full 修正 6 项文档缺陷后） / dag_version: 3 / spec-check: 轮1 修正（执行环境+分组两节、两处验收断言重写）
- 状态: draft（spec-check 收敛中）
- 评审来源：review-scope-{shared,cli,desktop,uiservices,root} ×1 轮（readonly 子代理，5 个并行）
- 评审基线结论：A 维（spec 清单落地/保留面/D-8 链/防误删）五个 scope 全部核验通过；问题集中在**删除后的收尾质量**与 **codemod 拆包破损**（P0 全部源于此）
- **行号基准**：全部以 HEAD=0e4c58d 为准；执行时若偏移 >3 行，先 `git grep` 重新定位再动手。

## 执行环境与前置（执行前必读）
1. Node：`D:\Dev\Js\oh-my-zcode\.tools\node-v24.14.0-win-x64\node.exe`（便携 24.14.0；PATH 前缀方式，勿动全局 nvm）。
2. 通用 PATH 前缀（所有 pnpm/turbo/tsc/oxlint 命令前执行）：`set "PATH=D:\Dev\Js\oh-my-zcode\omz\node_modules\.bin;D:\Dev\Js\oh-my-zcode\.tools\node-v24.14.0-win-x64;%PATH%"`——**turbo 在根 `node_modules\.bin`**，CLI 子仓的 `typecheck`/`build` 不加此前缀会报 `turbo 不是内部或外部命令`。
3. pnpm：全局 11.5.1 经 `packageManager` 自动委托 10.33.2，无需处理。
4. E2E 重跑（uis/B-1、cli/B-3 等验收引用）：先 `pnpm --dir apps/zcode-cli run cli:build` 重建 `dist/zcode.cjs`（产物不进版本控制），并设 `ZCODE_STORAGE_DIR=D:\Dev\Js\oh-my-zcode\.e2e\storage`、`ZCODE_SESSION_DB_PATH=D:\Dev\Js\oh-my-zcode\.e2e\db.sqlite`（隔离存储，复用共享登录）；用例与顺序见 cache/e2e-report.md（**E1→E2→E3a 必须按序**，E2/E3a 用 `-c` 续同一会话，单独跑 E3a 无意义）；`--mode` 默认即 yolo（`cli/src/run.ts:42`），无需额外 flag。
5. licenses 重生（root/B-1 验收）：`node scripts/licenses.mjs notices` 在 Windows 有 EMFILE 坑——若 `pnpm -r ls` 并发炸（注意 pnpm 出错仍 exit 0、错误藏在 stdout JSON 里，勿被误导），按 iteration-state 记录的方案临时串行化跑完后**完全回滚脚本**（不产生提交）。
6. 一切 `git grep` 必须在 `D:\Dev\Js\oh-my-zcode\omz` 仓内执行（父目录非 git 仓会 fatal）；本机 rg 多排除 glob 组合会静默零结果，**禁用 rg 做存在性判定**。
7. 本节为收敛版，原始出处：母 spec「测试策略」节、`docs/.iteration-state.yaml` 工具链与方法论警示条目。

## 执行分组与顺序
- **W1 = P0（uis/B-1..B-4）**：最先执行；uis/B-2 的 8 处中 3 处与 SettingsPage 同文件，同波次内完成。**波次出口（机器可判定，三层全过才进人工层）**：`pnpm typecheck` 0 error + `pnpm lint`（0 error、warning ≤ 基线 71）+ `node scripts/typecheck-desktop-full.mjs` exit 0；之后按「合并后 QA」做 UI 定向冒烟 12 条。
- **W2 = CLI + desktop**：cli/B-1、cli/B-2、cli/B-4、cli/B-3（顺带收敛）、desktop/B-1、desktop/C-1（按 Open#1 默认 b）、desktop/C-orch-1、desktop/C-3。
- **W3 = UI P1**：uis/C-1、uis/C-2、uis/C-3。
- **W4 = P2 批量 + 声明收口**：shared/cli/desktop 其余 P2、root/B-1（licenses 重生）、root/B-2、root/C-1、pkgjson-eol、spec/K-7（修订母 spec Step 10）。
- **并行性声明**：除 **desktop/B-2**（待 Open#2 拍板后单独回填，不阻塞任何波次）外，**其余条目均可立即开工**——Open#1/#3/#4/#5/#9 均有默认答案（b/删全族/保留数组/加/收敛），按默认执行即可，无需等待拍板。

## Must-fix（按 P0 → P1 → P2）

### uis/B-1 [P0] ConversationComposer 输入链断裂：发送键永久禁用、草稿丢失
- 维度：B（codemod 过删）
- 文件：`packages/ui/src/v4/ConversationComposer.tsx:1356-1364`（`handleEditorChange` 全函数，deps 在 :1363）
- 问题：拆包时把 `updateText(value)` 与遥测调用一起删了。`updateText` 是打字路径唯一驱动 `textRef`/`contentRevisionRef`/`setText`/`onTextChange` 的入口。后果：`text` 恒空 → `canSend` 恒 false（发送键死）；`snapshotDraftOfEditor` 返回空 → 切 pane 草稿被清空；乐观清空/回滚判定失效。
- 改法：恢复 `updateText(value);`（保留 `updateComposerContent({ text: value }); scheduleDraftPersist();`），deps 恢复含 `updateText`。
- 验收：纯文本输入发送键变亮；200 字切 pane 再回正文完整；发送中补打不被覆盖；Enter 与按钮一致。
- 来源：review-scope-uiservices r1

### uis/B-2 [P0] 8 处回调被改成 thunk，实际永不执行
- 维度：B/C-orch（codemod 产物错误形态）
- 文件（8 处）：`ConversationComposer.tsx:1857-1861`（onSelectModel，模型选择器点不动）、`EmbeddedBrowserPaneParts.tsx:75`（地址栏回车）、`settings/McpServerList.tsx:148`（MCP 授权按钮）、`settings/MemorySettingsSection.tsx:184`（scope 切换）、`v4/ConversationQueuePanel.tsx:217`（队列立即发送）、`SettingsPage.tsx:1598/:1601`（通知/声音开关）、`SettingsPage.tsx:1671`（UI 字号）
- 问题：`(x) => () => f(x)` 形态——外层返回函数被当语句调用丢弃，`f` 永不执行。
- 改法：8 处全部改为直接调用（如 `onClick={() => onOpenAuthorization?.(server)}`、`(e) => setNotificationEnabled(e)`）。
- 验收：8 个交互逐个手动触发生效；`git grep -n "=> () =>" -- packages/ui/src` 仅剩 unsubscribe/useEffect 清理函数两类合法形态。
- 来源：review-scope-uiservices r1

### uis/B-3 [P0] `injectAuthRef.current(null)` 绕过默认参数，重试按钮失效
- 维度：B
- 文件：`packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx:463`
- 问题：`injectAuth` 默认参 `= webviewRef.current` 被显式 `null` 短路，`if (!webview) return`。
- 改法：`onClick={() => void injectAuth()}`。
- 验收：制造鉴权失败态 → 重试 → webview 凭据重新注入。
- 来源：review-scope-uiservices r1

### uis/B-4 [P0] `await refreshCatalog;` 漏调用括号，记忆刷新空转
- 维度：B
- 文件：`packages/ui/src/settings/MemorySettingsSection.tsx:145`
- 改法：`await refreshCatalog();`。
- 验收：记忆设置点刷新 → 列表真的重新拉取。
- 来源：review-scope-uiservices r1

### cli/B-1 [P1] call-runner 两处空 if/else 壳
- 维度：B（摘 span 后控制流残留）
- 文件：`apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts:290-292`、`:588-590`
- 改法：两处空分支整块删除，收敛为直接 `return result;`（第二处保留 `finally` 中 `unlinkParentAbort()`）。
- 验收：oxlint `no-empty` 0 error；permission-denied 与 handler-throw 路径返回值与基线一致。
- 来源：review-scope-cli r1

### cli/B-2 [P1] `observeVisibleStreamEvent` 返回值半死
- 维度：C
- 文件：`apps/zcode-cli/packages/adapters/src/model/runner-stream.ts:1561-1590`（调用点 :383/:409/:417）
- 改法：返回类型收为 `boolean`（只保留 outputCommitted 语义），删 `contentMs`/`textMs`/`elapsed` 形参与三处 `Date.now()-startedAt` 实参。
- 验收：typecheck 绿；`git grep "contentMs\|textMs" apps/zcode-cli/packages/adapters` 零命中。
- 来源：review-scope-cli r1

### cli/B-3 [P1→P2 顺带收敛] 基线既有的 `*Impl`/`execute` 间接层（Phase 1 仅删参；轮2 定性修正）
- 维度：C-orch
- 文件：`core/src/tool/executor/call-runner.ts:62-70`、`core/src/runtime/methods/{turn-model-step:87-102, target-completion-verification:52-87, title-generation-sidecar:53-60, workspace-generate-text:102-109, compact-active:100-112}.ts`
- 问题（轮2 修正）：`git show c34a938:` 证实这 6 处 `Xxx/XxxImpl` 与 `execute` 闭包**全部是基线既有结构**（原为 telemetry 包装而设），Phase 1 只摘掉了实参，hop 结构原封未动。属"顺带收敛"而非 Phase 1 残留——执行者不应误以为在收 Phase 1 的尾；`call-runner` 是工具执行热路径，收敛时须谨慎。
- 改法（拆两步；sc 轮1 修正 `.call` 归属）：① 5 处 `XxxImpl`（`call-runner.ts:72`、`compact-active.ts:112`、`turn-model-step.ts:104`、`title-generation-sidecar.ts:63`、`workspace-generate-text.ts:112`）函数体上提合并回导出函数，删 `executeToolCallImpl(...)` 等中转调用（注意 `call-runner.ts:69` 本就是直调 `return executeToolCallImpl(...)`，无 `.call`）；② 2 处 `execute` 闭包内联——`target-completion-verification.ts:51-84` 的 `verifyTargetCompletion.call(this, …)` 改直调、`compact-active.ts:103` 同理。若评估热路径风险后选择不动，在 Open questions #9 登记理由即可。
- 验收（sc 轮1 改为可复制三步）：① `pnpm --dir apps/zcode-cli run cli:build` 成功；② 设执行环境节的 E2E 隔离变量后，按 **E1→E2→E3a** 顺序重跑（命令见 cache/e2e-report.md），输出与该报告一致；③ 三套 typecheck 绿。
- 来源：review-scope-cli r1 + review-full r2（定性修正）

### cli/B-4 [P1] 2 处幽灵 `modelCall` 载荷（契约字段已删、运行时静默丢弃）
- 维度：B+C（typecheck 被 const 中转绕过）
- 文件：`core/src/runtime/methods/compact-active.ts:360-367`、`target-completion-verification.ts:326-328`
- 改法：删除两处 `modelCall` 对象字面量；顺带改写 `runner-attribution.ts:48` 注释措辞。
- 验收（sc 轮1 修正：词边界 + 限定 core，避开 i18n 的 `modelCalling` 文案）：`git grep -nE "\bmodelCall\b" -- apps/zcode-cli/packages/core` 零命中（三处目标 compact-active.ts:360、target-completion-verification.ts:326、runner-attribution.ts:48 注释均在 core；`\b` 不匹配 `modelCalling`）；E3a `/compact` 重跑通过。
- 来源：review-scope-cli r1

### desktop/B-1 [P1] 门禁"再生产物"段：未定位的真实 emit + 注释口径矛盾（轮2 修正）
- 维度：B
- 文件：`scripts/typecheck-desktop-full.mjs:3`、`:55-69`
- 问题（轮2 依据 `cache/s13-typecheck-desktop-full.log` 修正）：① 副作用段**确实触发过**——s13 日志记录了 4 条 `?? packages/desktop/src/scheduler/schedulerProtocol.*`（untracked 再生）。四套 tsconfig 名义上 outDir 全在 `out/`，无法解释 emit 落进 `src/scheduler/`，**根因未定位**；② 危害修正：untracked 文件 `git restore` 清不掉，真实危害是 `git status` 永久脏 + 提示文案 "restore manually" 不可执行；③ `:3` 注释"216 个既有错误"与快照实际口径（首次采集 705 条已知态 = 上游噪音 + 当时 s6 断链；随清理 removed 递增；**快照无需重生成**）矛盾。
- 改法（分步，先定位后处置；sc 轮1 展开为可执行三步）：a) 在 HEAD 复跑 `node scripts/typecheck-desktop-full.mjs` 确认 `schedulerProtocol.*` 再生是否复现；b) **复现** → ① `git grep -n "\"outDir\"\|\"composite\"\|\"declarationDir\"\|\"noEmit\"" -- packages/desktop/tsconfig.main.json packages/desktop/tsconfig.preload.json packages/desktop/tsconfig.renderer.json packages/desktop/tsconfig.scheduler.json` 列出四套现状；② 若 scheduler（或其余）工程缺 `outDir` → 补 `"outDir": "out/scheduler"` 式显式输出目录后复跑验证再生产物消失；③ 若四套均已声明 `outDir` 而 emit 仍落 `src/` → 记为"配置无异常的未解现象"走 c) 分支；修复生效后删除 `:55-69` 提示段（**勿用 noEmit 方案——复合工程不支持**）；c) **不复现** → 删提示段并在本条目回填"已不复现 + 复现条件"记录；d) `:3` 注释改为"基线快照为首次采集时已知态，随清理 removed 递增，勿在注释复制会漂移的数字"。
- 验收：复跑门禁后 `git status --porcelain packages/desktop/src` 干净；人为引入类型错 → exit 1 + NEW ERRORS；撤销 → exit 0；注释与快照口径一致。
- 来源：review-scope-desktop r1 + review-full r2（前提修正）

### desktop/C-1 [P1] `mainMemoryDiagnosticsRegistry` 整块死代码（默认方案 b：删除）
- 维度：C
- 文件：`packages/desktop/src/main/mainMemoryDiagnostics.ts`、`main/index.ts:186`+`:476-486`、连带 `taskRealtimeBus.ts:354`/`broadcastHub.ts:46`/`browserView/browserGuestManager.ts:4228` 的 `collectMemoryDiagnostics()`
- 问题：唯一 collect 出口随 `desktopResourceTelemetry` 删除，注册表无读者。
- 改法（默认 b，可选 a 见 Open questions #1）：删 `mainMemoryDiagnostics.ts`、index 的 import 与注册块、三处 `collectMemoryDiagnostics()` 实现。
- 验收：`git grep -n "collectMemoryDiagnostics" -- packages/desktop` 零残留（选 a 则改为：触发后主日志出现 `[memory]` 行）；门禁 exit 0。
- 来源：review-scope-desktop r1

### desktop/C-orch-1 [P1] scheduler 协议悬空消息臂
- 维度：C-orch
- 文件：`packages/desktop/src/scheduler/schedulerProtocol.ts:47`
- 改法：删 `"scheduler-resource-sample"` 变体及其专属字段/import。
- 验收：`git grep -n "scheduler-resource-sample" -- packages` 零结果；门禁 main/scheduler 工程无新增错。
- 来源：review-scope-desktop r1

### uis/C-1 [P1] `SessionPane.handleDraftSessionCreated` 丢 `onSessionCreated` 依赖（stale closure）
- 维度：B
- 文件：`packages/ui/src/v4/SessionPane.tsx:1244-1250`
- 改法：deps 数组补回 `onSessionCreated`。
- 验收：新建会话自动选中任务；先切语言再建会话仍能选中；分屏 `bindPaneSession` 生效。
- 来源：review-scope-uiservices r1

### uis/C-2 [P1] 18 处无意义 IIFE（codemod 垃圾形态；轮2 行号实测修正）
- 维度：C
- 文件与行（共 **18** 处 = 14 处单行形态【12 处 `))();` + 2 处 `void (() => Promise.resolve(...))`】+ 4 处块形形态；路径以实测为准）：`ChatEmptyState.tsx:282/:398`（**第三形态** `void (() => Promise.resolve(onSelectConversationWorkspace()))`，内联为 `void onSelectConversationWorkspace()`）、`ChatEmptyState.tsx:357/:387`（单行）、`GitActionMenu.tsx:1286-1292`（块形，收尾 `:1292`）、`SettingsPage.tsx:1249/:1253/:1267`（单行）、`SettingsPage.tsx:1357/:1421`（块形收尾行）、`TaskListItem.tsx:250/:309/:321`（根目录，单行）、`settings/PluginStoreCard.tsx:212`、`v4/ConversationAgentToolCallRow.tsx:54`、`v4/ConversationRowView.tsx:1377`、`v4/V4UserInputDialog.tsx:23`、`v4/WorkspaceHookPendingBanner.tsx:116-120`（块形，收尾 `:120`）
- 改法：以上 18 处内联为裸调用语句（4 处块形连同外层包裹一起内联）。**禁止以 `\}\)\(\);` 模式做判据**——该形态在 `packages/ui/src` 有 47 处合法自执行（`useEffect`/`useMemo` 副作用与模块级 IIFE，如 `Root.tsx:389`、`SSHDialog.tsx:575/609`、`terminalTheme.ts:21`），按它归零会误删约 43 处合法代码。
- 验收（三条互不干扰的精确断言）：① 单行 `))();` 归零：`git grep -nE "\)\)\(\);" -- packages/ui/src`（现状 12 处）→ 0；② 第三形态归零：`git grep -n "(() => Promise.resolve(" -- packages/ui/src`（现状 2 处）→ 0；③ 块形 4 处不用 grep 判定，按上方行级定点清单逐条核对 diff（内联后为裸调用语句）。18 处逐一行为不变。
- 来源：review-scope-uiservices r1 + review-full r2（行号/计数/验收修正）

### uis/C-3 [P1] `sessionDataLayer` 误删本地诊断 lifecycle 日志（超授权边界）
- 维度：A/C
- 文件：`packages/ui/src/v4/sessionDataLayer.ts`（轮3 锚点终校：在 `void store.connect({...})`（**:88**）之后、`let released = false;`（:91）之前重新插入）
- 改法：恢复 `logger.lifecycle.info("v4 session data lease acquired", …)`（去掉已删类型的 `openKind` 字段）。
- 验收：开关会话时本地日志出现 lease acquire 记录。
- 来源：review-scope-uiservices r1 + review-full r2（锚点修正）

### clock-1 [P2] `commandsQuery` 时钟探针协议半截残留（跨包，合并 shared/C-1 + cli open#1）
- 维度：C-orch
- 文件：`packages/shared/src/zcode-protocol-v4/command.ts:454-463`（params `clock` 字段 + `.refine`）、`packages/services/src/zcode-agent/zcodeAgentService.ts:5076`（转发）、`zcodeAgentConnectionScope.ts:722`（clock 分支）
- 改法：删 params 的 `clock` 字段与 refine；删 services 转发与 scope 分支（`.strict()` 使旧发送方报错属预期，同仓同版无混版）。
- 验收：`commandsQueryParamsSchema.safeParse({commands:[...],clock:true})` 失败；UI 现有调用（`usePendingCommandRecovery.ts:45`）仍通过。
- 来源：review-scope-shared r1（C-1）

### shared/C-2 [P2] `commandAckSchema.ttftExcluded` 死字段
- 文件：`packages/shared/src/zcode-protocol-v4/command.ts:431`
- 改法：删该行（非 strict schema strip 语义，零破坏）。
- 来源：review-scope-shared r1

### shared/C-3 [P2] shared 死导出 4 处
- 文件：`packages/shared/src/processResourceTelemetry.ts:9/:47/:54`（`resolveCliProcessResourceRole`、`ProcessResourceRuntimeSurface`、`PROCESS_RESOURCE_ROLES` 数组值——**注意**：数组去留见 Open questions #4，默认保留数组删前两者）；`zcode-protocol/index.ts:395-404`（`zcodeMcpProcessTelemetryBaseShape` 收窄为只留 `mcpId` 或内联进 `zcodeMcpResourceSampleSchema`——**轮2 标注：本子项以 Open questions #3 拍板为准，若选"删全族"则本子项免执行**）
- 验收：`processResourceCliLaneSchema` 与 `mcpId` 正则不变；git grep 无新孤儿。
- 来源：review-scope-shared r1 + review-full r2（互斥标注）

### shared/C-4 [P2] `platform.ts:696-697` 成员缩进丢失
- 改法：`showTaskNotification` 及 JSDoc 回缩进 2 空格。验收：oxlint/oxfmt 该文件通过。
- 来源：review-scope-shared r1

### shared/C-5 + cli/C-5 [P2] 4 个文件缺尾换行
- 文件：`shared/src/zcode-protocol-v4/telemetry.ts`、`adapters/src/mcp/telemetry.ts`、`bootstrap/src/zcode-protocol-v4/conversation-telemetry-facts.ts`、`core/src/hooks/workspace-hook-digest.ts`
- 改法：各补尾 `\n`。验收：oxfmt --check 这些文件 0 报错。
- 来源：review-scope-shared/cli r1

### cli/C-1 [P2] contracts 孤儿注释挂错类型
- 文件：`contracts/src/model/index.ts:284-288`
- 改法：删注释块或改写为"里程碑事件已随遥测移除"。
- 来源：review-scope-cli r1

### cli/C-2 [P2] `recordProcessCrashed` 死参数
- 文件：`adapters/src/mcp/telemetry.ts:44-48/:142-146`、`adapters/src/mcp/index.ts:1147-1150`
- 改法：接口收为 `{ connectionId: string }`；删调用处 `exitCode`/`signal` 实参。
- 来源：review-scope-cli r1

### cli/C-3 [P2] `addStatusSink`/`statusSink` 工厂选项死出口（含两处注释一并改写，与 cli/C-6 后半合并）
- 文件：`adapters/src/model/runner.ts:116-136`、`bootstrap/src/model-factory.ts:16/:34`；注释：`bootstrap/src/app/create-app.ts:536`、`bootstrap/src/app/workflow-concurrency-governor.ts:12`
- 改法：删 `addStatusSink` 方法与 `CreateModelAdapterBaseOptions.statusSink` 及透传；**同步改写两处残留注释**（`create-app.ts:536` 与 `workflow-concurrency-governor.ts:12` 的 addStatusSink 措辞改为只描述治理器 observer 语义——注释本身不含 `addStatusSink(` 调用形态，不改也不影响下方验收判定，改写属口径清理）。
- 验收（轮2 修正）：`git grep -n "addStatusSink(" -- apps packages` 零命中（方法调用/定义归零）。
- 来源：review-scope-cli r1 + review-full r2（验收修正）

### cli/C-4 [P2] 归一化逻辑重复
- 文件：`adapters/src/model/runner-attribution.ts:35-37` vs `:45-51`
- 改法：header 处改用 `resolveModelRequestSessionType(...)`。
- 来源：review-scope-cli r1

### cli/C-6 [P2] 2 处过期注释
- 文件：`cli/src/tui-prompt-handler-runtime.ts:15-16`、`bootstrap/src/app/create-app.ts:533-537`
- 改法：改写为与现状一致的表述（随 cli/C-3 一并处理后者）。
- 来源：review-scope-cli r1

### desktop/C-2 [P2] `RemoteAttachmentRoute.connectFinalized` 只写字段
- 文件：`packages/desktop/src/main/desktopRemoteSessions.ts:48/:334-336/:361`
- 改法：删字段声明、初始化与 if 块。
- 来源：review-scope-desktop r1

### desktop/B-2 [P2→待拍板] 打包态 `.env` 读取语义（轮2 撤销默认改法，转 Open questions #2）
- 文件：`packages/desktop/src/main/desktopRuntimeEnv.ts:151`
- 问题（轮2 修正）：基线被删短路的**原文守卫理由是遥测专属**——"安装包不内嵌 OTLP 端点或鉴权，避免 CI 凭据随产物公开"。OTLP 已全删，该理由消失；此时恢复 `return {}` 会让打包态不再读 workspace `.env`，属**与遥测无关的新策略决策**（对照 `:158`"自行加载相同的 .env 以保持 OAuth 配置一致"）。
- 改法：见 Open questions #2，由用户拍板后回填本条；两种终态：(i) 恢复短路 `if (isElectronAppPackaged()) return {};`（打包态不读文件）；(ii) 维持现状并改写函数头注释显式声明"打包态也读取安装目录旁 .env，凭据仅限用户本机"。
- 来源：review-scope-desktop r1 + review-full r2（定性修正）

### pkgjson-eol [P2] 根 package.json 整文件 LF→CRLF（合并 desktop/A-1 + root/A-1）
- 文件：根 `package.json`（93/93 行重写，真实变更仅 2 行）
- 改法：`git checkout baseline/v3.14.3 -- package.json` 后以 LF 只重放两处真实改动（删 patch 条目 + 加 typecheck:desktop-full）；可选 `.gitattributes` 加 `*.json text eol=lf`（见 Open questions #5）。
- 验收：`git diff --numstat c34a938 HEAD -- package.json` 为个位数；`inventory.inputs['package.json']` 哈希校验仍绿（评审已证 LF 归一化哈希一致）；licenses 重生成不被阻断。
- 来源：review-scope-desktop/root r1

### desktop/C-3 [P2] 门禁 `--snapshot` 无护栏
- 文件：`scripts/typecheck-desktop-full.mjs:41-45`
- 改法：写快照前计算 added/removed 并打印；`added > 0` 需 `--snapshot --accept-new` 才落盘否则 exit 1。
- 验收：HEAD 上 `--snapshot` 输出 added 0 且文件不变；人为引入错误后不带 `--accept-new` 时 exit 1 且快照不变。
- 来源：review-scope-desktop r1

### uis/C-4 [P2] 死签名/死 dep 4 处
- 文件：`SessionPane.tsx:1224/:2535`（`_createSource` 死参+实参）、`ConversationDraftSuggestedPromptsContainer.tsx:701/:707`（死 deps）、`OccupationOnboarding.tsx:94`（`intl` 死 dep）、`ChatErrorBanner.tsx:71`（`resolveChatErrorBannerDisplayMessage` 去 export）
- 来源：review-scope-uiservices r1

### uis/C-5 [P2] `runSettingsActionAsync` 包装返回语义降级
- 文件：`SettingsPage.tsx:106-121`（包装本体）；轮2 补锚点：`handleCodePreviewSettingsChange` 实际在 `SettingsPage.tsx:1272-1280`
- 改法：`return setCodePreviewSettings(patch);` 恢复透传。
- 来源：review-scope-uiservices r1 + review-full r2（锚点补充）

### root/B-1 [P2] copied-components scope 文案与事实相反
- 文件：`third-party/copied-components.json:240` + `inventory.json:28651`
- 改法：scope 改为"实现与随附 LICENSE 文件均已移除，上游许可仅以 URL 引用"；重跑 `node scripts/licenses.mjs notices` 同步——**该命令会同时重写 `THIRD-PARTY-NOTICES.md` 与 `third-party/inventory.json`（`generate-third-party-notices.mjs:204-205`），改 scope 后必须重跑，否则验收 grep（覆盖 `third-party/` 全目录）会在 inventory.json:28651 误判失败**。
- 验收：`git grep -n "retained license" third-party/` 零命中；readVerifiedNotices 通过。
- 来源：review-scope-root r1

### root/C-1 [P2] bootstrap.mjs 死代码
- 文件：`scripts/bootstrap.mjs:12/:91-96`
- 改法：删 `gitCommand` 与 `runGit`（本轮 71 条 lint warning 中唯一新增项）。
- 验收：`oxlint scripts/bootstrap.mjs` 0 warning。
- 来源：review-scope-root r1

### root/B-2 [P2] 5 个孤儿 upstream 声明文件
- 文件：`third-party/upstream/{2c976d32…,328eb786…,38b6f63a…,6f7e6eae…,e49e6239…}.txt`（@arms×3/keyv/rrweb）
- 改法：`git rm` 这 5 个文件。
- 验收：upstream 文件数 == inventory.inputs 中 third-party/upstream 键数。
- 来源：review-scope-root r1

### spec/K-7 [P2] 修订母 spec Step 10（deviation open-1 升格为条目，sc 轮1）
- 文件：`docs/iterations/oh-my-zcode-fork/spec.md`（Step 10 段落）
- 改法：「接入 main/preload/renderer 三 tsconfig」→「接入 main/preload/renderer/**scheduler** 四套 tsconfig（严格加强，与 `scripts/typecheck-desktop-full.mjs` 的 projects 数组一致）」。
- 验收：spec 文本含 scheduler 且与门禁脚本 projects 数组（4 项）一致。
- 来源：spec-check r1（自 deviation open-1 升格，避免执行者按 Must-fix 清单推进时漏做）

## Spec deviations
- **open-1**：spec Step 10 写"接入 main/preload/renderer 三套"，实现为四套（+scheduler，严格加强）。→ fix-spec 增加收尾步骤：修订 spec Step 10 文字补 scheduler（下游执行时同步）。
- **open-2**：`sessionDataLayer` lifecycle 日志删除（未申报）→ uis/C-3 修复即闭合。
- **fixed/已接受**：npm-overrides 删 9 条（Stale 校验所迫）、copied-components roots 删（ENOENT 所迫）、architecture baseline no-op（实测 violations 0，无需更新）、`@opentelemetry/api@1.9.0` 豁免（ai SDK 传递依赖）。
- **codemod 破损（uis/B-1..B-4）**：不属偏离，属缺陷，见 P0。

## Open questions / 待拍板
1. `mainMemoryDiagnostics`：默认按 desktop/C-1 方案 b（删除）；若想保留本地内存诊断能力选 a（补 collect 出口挂 debug 触发点）。
2. 打包态 `.env` 语义（desktop/B-2，轮2 修正后**必须拍板**）：原守卫理由（防 CI OTLP 凭据随产物公开）已随遥测删除而消失——(i) 恢复短路=新增"打包态不读 .env"策略；(ii) 维持现状=打包态可读安装目录旁 .env（凭据仅限用户本机），需显式注释声明。无默认答案。
3. ~~`zcodeMcpResourceSampleSchema` 全族是否删~~（**执行期结案：保留，"零消费"前提不成立**——W4 复核发现 services 侧活跃消费链：`validation.ts:15/:667` 用 `zcodeMcpResourceSamplesSchema` 解析 wire 通知、`zcodeAgentService.ts:74/:1908` fire emitter、CLI adapters 三文件消费 `ZCodeMcpResourceSample` 类型；且 `zcodeMcpTelemetryPlatformSchema` 被保留面 `zcodeToolExecResourceSchema:438` 引用。轮1 评审员"desktop/services 零消费"结论对 services 不成立。未来若要删，需先评估 `onDynamicMcpResourceSamples` 事件出口的 UI 订阅面，另行立项）。
4. `PROCESS_RESOURCE_ROLES` 数组值：默认保留（角色枚举唯一真源、satisfies 约束仍用），只删函数/类型。
5. `.gitattributes` 是否加 `*.json text eol=lf` 防复发？默认：加。
6. `zcode-server-cli/packaging/stage.ts:287` superpowers 死过滤为**上游既有**（基线就失效）——默认留给 Phase 3。
7. ~~fmt 口径复核~~（轮2 已结案）：`cache/s13-fmt-check.log` 实证 `Format issues found in above 2639 files ... exit code 1`——**spec 的"全量基线即红 ~2650"口径正确**，root 评审员"实测 exit 0"系其 cwd/参数差异所致误报。以 spec 口径（改动文件零新增不合规）为准，不下传。
8. desktop 门禁的 ui/services 错误溢出（705 基线中 355 条来自 ui）：默认接受（拦截面更广），可选在门禁输出加按包分组。
9. cli/B-3 的 6 处基线既有间接层是否本轮收敛（热路径风险评估）——默认收敛（改法已给出），选择不动则在此登记理由。

## Informational（无需动作，供后续 diff 复查）
- `packages/desktop/src/main/desktopRuntimeEnv.ts:41` 的 `export const` → `const`（commit 89e1fd7）：全仓无外部 importer，属安全死导出清理；非问题，登记免复查（review-full r2）。
- `modelCalling`（`i18n/types.ts:214`、`i18n/locales/en-US.ts:273`、`zh-CN.ts:270`、`tui/app-events.ts:101`）：TUI 状态文案键，与 `modelCall` 契约字段无关，**保留**——cli/B-4 验收的词边界即为此设计（spec-check r1）。

## 已豁免（用户确认不修）
- 无（本轮无用户豁免项）。

## 合并后 QA（manual_user）
UI 定向冒烟清单（P0 修复验收必跑）：① composer 打字/发送键/草稿/乐观回滚（uis/B-1）；② 模型选择器、内置浏览器地址栏、MCP 授权、记忆 scope 与刷新、队列立即发送、通知/声音开关、字号、Coding Plan 重试（uis/B-2/B-3/B-4）；③ 新建会话自动选中（含切语言后）（uis/C-1）；④ 设置页开关矩阵与 Git 面板、任务列表、子会话侧栏（回归面）。desktop：dev 态 OAuth 登录、资源管理器三 tab 有数据、安装包启动无 `Cannot find module`（desktop G#3/#7/#8）。T-T4 抓包（沿用）。

## K 节建议（下游执行时闭合）
1. shared 契约单测 6 项（shared 评审 G 节：strict 双端/params clock/runtimeEnv 17 键剔除往返/D-8 fact schema 判别/hostResponse 判别/PlatformChannels 快照）。
2. `compact_stream_boundary` 单测提前落（Phase 2b 前回归网，cli G#3）。
3. Step 13 残留扫描增补两条静态断言：`git grep -n "=> () =>" -- packages/ui/src` 与 `await <ident>;` 模式扫描（防 codemod 破损复发）。
4. knip 配置治理（`scripts/*.mjs` 显式 entry）。
5. licenses 脚本 Windows EMFILE 串行化修复（固化并发上限；**W4 执行期更新**：有效方案是"逐 workspace 包从根 `pnpm --filter <name> ls` 串行"而非限并发——`-r ls` 的 EMFILE 源于 pnpm 递归扇出；必须含根项目 `zcode` 且排除根的 unsavedDependencies，否则 `parse-bmfont-ascii` 触发 Stale override；勿用 `pnpm config set workspace-concurrency --location project`，会重写 pnpm-workspace.yaml）。
6. `runUserAction` 类 codemod 的验收规约写入 spec「测试策略」：凡结构性重写，产物需按"返回值语义"逐点人工复核或静态断言（**根因回指：uis/B-1..B-4 即本规约缺失的实例**）。（K#7 已升格为 Must-fix 条目 spec/K-7）

## Fix-Spec Closure
| 项 | 状态 |
|---|---|
| fix-spec-ready | yes（sc 轮2 Go：11/11 闭合、验收命令实测数字全对、N1/N2 数字订正已落实） |
| fix_spec_path | docs/iterations/oh-my-zcode-fork/cr-fix-spec.md |
| dag_version / review_round | cr:3 / sc:1→2 |
| P0 / P1 / P2（已写入 fix-spec） | 4 / 9（cli/B-3 降 P2）/ 21（spec/K-7 自 deviation 升格；desktop/B-2 转待拍板计入 Open#2） |
| 未写入的开放 must-fix | 0（多轮覆盖度核验：无漏合并/漏登记） |
| spec_deviations | open×1（sessionDataLayer 日志，随 uis/C-3 修复闭合；open-1 已升格 spec/K-7）+ 已接受×4 |
| C-orch | ✅（clock 半截/scheduler 臂/间接层/双端方法面均成条目） |
| H / I / J | 无条目——轮1 五 scope 未报 + 未复核，属"本轮删除类改动不触及"面；执行中如涉及再补查 |
| 执行环境与分组 | ✅（sc 轮1 新增两节：环境前置 7 项 / W1-W4 波次与并行性声明） |
| C 类合并后 QA | 见「合并后 QA」（uis 12 条冒烟 + desktop 3 项） |
