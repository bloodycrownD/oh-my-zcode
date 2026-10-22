---
date: 2026-10-22
---

# 上游 v3.16 缺陷修复与精选功能 backport 技术规格（SPEC）

> r4（doc-fix 后）：闭合 r3 的 1 P0 + 1 P1 + 7 P2。U10 floating 消费链补全（挑选 hunk 3 处→5 处：+ConversationTimeline 三 prop/dock 布局、+V4WorkspaceChatArea soloPane/hidden，连带 WorkbenchLeafPane.hidden 与 workbenchLayout.FULL_WORKBENCH_RECT，liveTail 函数改述为「2 函数+消费方 hunk」）；knip/测试 typecheck 覆盖口径定死；U12 登记 API 改名与 description 实格式；CHANGELOG 补 U2/U5/U7。

## 需求来源

- 用户口述（2026-10-22）：「你跳出有bug修复以及必要的新功能等类似的进行更新吧，生成spec」→ 范围取自 `docs/iterations/upstream-v3.16-sync/summary.md` 的 A/B 档，经 4 轮实现级探索（CLI / services+desktop / UI×2）+ 2 轮 spec 审查（r1/r2）逐项修正后定案。
- 上游基线：`aac47556`（v3.15.1）→ `3c5b2276`（v3.16.2，2026-10-20 squash，无内部历史，只能 diff 手工重放，cherry-pick 不可用）。
- omz 基线：`main @ b952d749`（v1.0.18 发布提交）。工作分支：`upstream-v3.16-backport`（新迭代分支，从 main 切出）。

## 设计目标

把上游 v3.15.1→v3.16.2 增量中「omz 同款存在的缺陷修复 + 前置件齐备的精选小功能」逐项移植进 omz，**零红线回退**（遥测 / 原生压缩 / magic-context / 品牌），每项独立成 commit 可单独回滚。整体不引入上游 v3.16 的五条大产品线（source-server R3、relay v2、虚拟项目、ToolSearch、office-runtime）。

## 总体方案

12 个移植项（U1–U12），按 8 个 phase 串行推进（foundation / cli-runtime / ui-components / ui-remote / services / ui-panels / desktop / gates）；每项 = 上游 hunk 定位 → omz 落点改写（品牌/测试形态适配）→ 逐项测试。上游同批改动中与本项无关的 hunk（遥测、source-server、highspeed、分享页解耦等）一律不带入——**逐 hunk 挑拣，禁止整文件替换**（上游 `http.ts`/`editors.ts`/`SessionPane.tsx`/`WorkspaceShellLayout.tsx` 等同文件内混有 R3/遥测/其他主题改动）。

**v3.15.1 基线政策（Step 1 记录在案）**：本轮不回补 v3.15.1 基线（用户已拍板按 A/B 档逐项移植）；83 个 merge-file 假 CLEAN 文件不在本轮范围；所有移植基于 4 轮探索的 fork 行号级实证，逐 hunk 适配，不做任何「重放整文件」。

## 变更点清单

### U1（A2）CLI 旧 config.json 导入保留 maxOutputTokens — 缺陷修复

- 上游：`git diff aac47556..3c5b2276 -- apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts`（4 hunk，21+/2-：import `ModelOptionSpecsConfig`；成员投影条件展开；`LegacyCliModelMember.maxOutputTokens`；取值优先级 `limit.output > options.max_tokens > 顶层 maxOutputTokens`）。
- omz 同款 bug 实证：`apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts:112`（只有 contextWindow 的模型整个被跳过）、`:117`（只投影 contextWindow）、`:157-160`（member 无 maxOutputTokens 字段）。omz 与上游 v3.15.1 该文件的唯一差异=两函数缺 `export`（`importLegacyCliPersonalProviderConfig` / `importLegacyCliConfiguredDefault`）→ **干净重放级**。
- 适配要点：①按上游把两函数改为 export（测试需要）；②`options.max_tokens` 在 omz zod 是 `unknown`，经既有 `isPositiveInteger` 收窄；③不改读路径（`getDefaultConfigPath()` = `~/.omz/cli/config.json`，omz 语境下「旧 CLI 文件」即同路径旧格式——不顺手「修」成读 `~/.zcode`，上游本轮也没改）。
- 依赖零新增：`ModelOptionSpecsConfig`/`LimitOptionSpecConfig` 已在 `packages/provider/src/config/model-config.ts:248,80-82`；`legacy-cli-model-config.ts` 与上游 v3.16.2 逐字一致。

### U2（A3）dynamic-workflows skill 跨 provider 提示词加固 — 纯文本

- 上游 5 hunk 中 **3 个有锚点**（`SKILL.md` 的 `CreateWorkflow.subagent_model`、`AmendWorkflow.subagent_model`、Confirmation 段，各加「NEVER set a model under another provider the user did not ask for / ask them first」纪律）；2 个无锚点不迁：§2 Per-subagent model 段（omz facade `agent()` 无 model 参数，`SKILL.md:1023`，照抄=教出不存在的 API）、`patterns.md` #13（omz patterns 只有 §1-§10）。
- omz 落点：`apps/zcode-cli/packages/bundled-skills/skills/dynamic-workflows/SKILL.md:960-963 / :1426-1428 / :1446-1451`。
- 顺手修正 omz 内部矛盾：`:110-119`「there is no per-subagent tool profile or model choice」与 `:960/:1426` 的 run 级 `subagent_model` 自相矛盾 → 改为「模型选择唯一杠杆是 run 级 `subagent_model`」。runtime 已支持 run 级 `subagent_model`（`bootstrap/src/app/workflow-actor-model.ts`、`dynamic-workflow-run-launch.ts:290`），**无需代码配套**。

### U3（B8a）V4 迟到原始流不得覆盖已定稿输入 — 数据完整性守卫

- 上游：`packages/…/zcode-protocol-v4/product-projection.ts` 两个守卫 hunk + `onToolCallScheduled` 补 `toolName`。
- omz 同款缺口实证：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts:2835`（`appendStreamingToolInput` 缺守卫）、`:2878-2879`（`finalizeStreamingToolInput` 无条件覆盖 `input`/`inputText`）、`:2937-2947`（existing-upsert 不写 `toolName`）。
- 价值：轨迹面板工具配对卡「调用参数」格的数据源就是该 row 的 `input`/`inputText`；omz 的 `tool_call`（带 input）drain 即发而 `tool_input_delta` 排队滞后 + 断流恢复可二次投递同 id → 乱序覆盖窗口真实存在。
- **三处必须一起移植**（守卫会让迟到的 toolName 也不再更新，需靠 scheduled upsert 补写）。已验证 `openToolRow`（:2816）只写 `inputText:""` 不写 `input` → 守卫不会误吞正常 delta 流。
- omz 既有常量 `ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS` 保留不改名；`runtimeInitialization`（B8b 面）在 omz 不存在，排除无副作用。

### U4（B3）模型创建失败保留已接纳输入 + 终态 — 缺陷修复（行为变化）

- 上游语义（v3.16.2 相对 v3.15.1 的真实变化）：创建失败不再立即终止，而是记 `creationFailure` → 继续主链（跳过 context 初始化与 session_start_hooks）→ 发 TurnStarted + **用户消息落库** → 在进入执行前 throw 创建错误 → 外层 catch 统一写终态（`turnPhase:"model_creation"`）。
- omz 落点（`apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`，**原地 6 处**；omz 无上游 `prepareAgentDefinitions` 符号，定位按 omz 结构）：①`:163-189` catch 改记 creationFailure；②`:190-213`（context 初始化与 session_start_hooks）包 `if (!creationFailure)`；③`:225` `beginActiveTurn(..., creationFailure===undefined, ...)`；④`:241-248` 跳过 executionState/sessionTarget（submissionModel/startedTarget）；⑤用户消息落库 `persistUserPrompt`（:465）之后、loopState 构建（:508）之前——现 :504-507 的 `loopModel` generic throw 改为 `if (creationFailure) throw creationFailure.error;`，非创建失败路径保留 generic throw 兜底（creationFailure 分支下 `loopModel` 恒 undefined）；⑥`:661` 外层 catch 加 `reportedCreationFailure` 分支——落库失败只 warn 不覆盖创建错误。
- **剔除全部 highspeed/selectionFallback 面**（omz 0 命中实证）：`turn-model.ts`/`prompt-admission.ts`/`session.events.ts` 的 highspeed hunk、`turn-execution-fallback.ts` 整文件、`cli-default-selection.ts` 一律不动。`pluginId`（ToolCall payload）与 `ModelNetworkStatus` 用量计数是独立议题，不塞进本项。
- MC 无交点：throw 位置在 turn-loop（`runMagicContextTurnTransform`，turn-loop.ts:119）之前。
- turn.ts 已 809 行超 400 上限（fork 既有），**只原地改不拆文件**（不加剧）。

### U5（A1）UI 基础组件修复 — 3 项必做 / 2 项延后

omz 这 5 个组件文件与上游 v3.15.1 **逐字节相同**（零分叉，可直接落；r1 审查已逐一比对确认）：

| 子项 | 上游 hunk | omz 落点 | 必做/延后 |
|---|---|---|---|
| dialog "Close" 硬编码 | `components/ui/dialog.tsx`（+14/-2，`DialogCloseText` + `common.close`） | `dialog.tsx:78,110`；`common.close` en/zh 已存在 | 必做 |
| collapsible 嵌套 group 淡出 | `components/ui/collapsible.tsx`（+13/-10，去 `group/collapsible-content` 组名，改 `data-[state=*]:[&>div]:animate-*`） | `collapsible.tsx:23,32-33`；受影响使用点：轨迹面板三重嵌套（`ModelTrajectoryTurnGroup.tsx:165`→`ModelTrajectoryExpandableMessage.tsx:236`→`ModelTrajectoryToolPairCard.tsx:187`）、`ToolCallBlocks/ToolLayout.tsx:347`、`v4/ConversationTurnGroup.tsx:389,651`、ai-elements 9 文件、Workflow 权限块等 | 必做（轨迹面板正在踩此 bug） |
| kbd 未定义 muted token | `components/ui/kbd.tsx` 改用新增 `packages/ui/src/ControlShortcutBadge.tsx`（27 行，`bg-tooltip-tag`） | `kbd.tsx:13` 用 `bg-muted`——omz 主题**无 `--color-muted*` token**（styles.css 0 命中），属继承性空 class；新建 `ControlShortcutBadge.tsx` + `ControlHintTooltip.tsx:39-40` 同批复用去重复类名 | 必做 |
| dropdown sub-trigger indicator 插槽 | `dropdown-menu.tsx`（+4/-2，向后兼容可选 prop） | omz 有消费方（`ModelConfigSelect.tsx`、`WorkspaceSidebarFooter.tsx` 用 `DropdownMenuSubTrigger`）但无需 indicator 定制，prop 落了无收益 | 延后（有消费方、零收益，待出现定制需求再迁） |
| tooltip alwaysDelay | `tooltip.tsx`（+55/-13） | omz 无 project-sidebar 消费方 | 延后 |

已知边界：修复 kbd 只解决设置页键帽；`text-muted-foreground` 空 class 全仓（排 `.reference`）约 99 处（`packages/ui/src` 68 处）属继承缺陷，**不在本轮扩散**（补 token 会一次性改变全 UI 观感，独立变更）。

### U6（B4）ToolCallBlocks 缺陷子集 — 3 项

| 缺陷 | 上游 | omz 落点 |
|---|---|---|
| 内嵌图片读取永久 loading | `ToolCallBody.tsx` InlineImageContent：`readMediaPreview` catch→`chat.toolCall.previewFailed`、无 reader→`previewUnavailable`、路径/reader 变更清旧结果 | `ToolCallBody.tsx:135-157`（同款：无 try/catch、无失败态） |
| CUA 截图图源 | `renderers/cuaScreenshotDetails.ts`（+6）：优先 `toolCall.raw.sharedImageSrc` 回落 data URL | omz 仅 `findImageDataUrl(output) ?? findImageDataUrl(raw)` |
| Node REPL 图格 | `renderers/nodeReplImageGrid.tsx:27`：`image.src ?? data:…base64` 优先 | omz 硬编 base64 同在 `:27` |

排除（分享页解耦/新能力，不迁）：`ToolPresentation.tsx`、`presentationCapabilities.tsx`、`resolveRenderer.ts` 分流、`web-fetch.tsx`、agent/cua 系 renderer 的 capabilities 改造、`@zcode/shared/test-ids` import 迁移。i18n 增量：`chat.toolCall.previewFailed` / `chat.toolCall.previewUnavailable`（en+zh）。**omz 适配口径**（上游 previewUnavailable 依赖 `useToolPresentationCapabilities`，omz 无该层——`fileService.readMediaPreview` 恒有 reader）：读取失败/异常→`previewFailed`；无图源或无 reader→`previewUnavailable`；**path/reader 变更时显式清空旧预览态**（omz 现状 `setImagePreview` 不随 path 变化重置，需按上游 `current` 比对形态补）。

### U7（B9 档A收窄）SSH 对话框缺陷修复 — 2 项 + 1 守卫

探索修正后真实缺口（Docker/WSL 提示二分与 macOS 不显示 WSL **omz 已具备**，不迁；上游 inputMode 二分属 T02 档B 重构，不迁；「编辑已存连接保留 savedSshConfigAlias」的参数来源 `EditConnectionProfileDialog` 在 omz **不存在**，落了=无消费方死代码，**移出本轮**，登记后续）：

1. **端口校验**：omz `packages/ui/src/lib/remoteConnectionWizard.ts:66-88` 只校验 host/username/密码/私钥，port 仅 `Number(port)` → 按上游加 `collectRemoteFormFieldErrors` + `isInvalidPort`（1–65535），locale 加 `ssh.validation.port`（en+zh）。**接线**：omz 现有校验入口 `buildRemoteTarget` 消费 `collectRemoteFormFieldErrors` 第一条错误作为错因（上游消费方 `remote-connection-flow`/`EditConnectionProfileDialog` omz 均无，不落则导出无消费方）。
2. **聚焦跟随（收窄为静态 props）**：omz `RemoteConnectionFields.tsx`（715 行）无任何 focus 控制 → 加 `autoFocusHost` / `focusCredentials` / `focusField` 三个静态 prop（上游同名 prop 的受控形态）；**不带** `focusFirstEmptyToken`（其递增触发源=上游 remote-connection-flow 的粘贴/导入 Host 流程，omz 无该流程）；复用 omz 既有 `TID_SSH_HOST_INPUT/USERNAME/PASSWORD/PRIVATE_KEY` 定位输入。
3. **alias 清除守卫**（小改）：omz 已有 alias 全链路（`services/src/system/sshConfigAlias.ts` 709 行 + `platform.listSSHConfigAliases` + UI Popover 含滚轮修复 `RemoteConnectionFields.tsx:155`）→ `hooks/useRemoteConnectionForm.ts` alias 相关段（:212-221/:270-292）加「仅当 aliasesLoaded && !error 才清除已选别名」守卫。`TID_SSH_CONFIG_*` 不新增（避免无消费死常量）。

三项均为纯 UI/hook，**不依赖** remote-connection-flow 重构与 SourceServerRecord。

### U8（A6）localUsageEvidence 三证据源 — 引导误弹修复

- 上游：`packages/services/src/onboarding/localUsageEvidence.ts`（+163）+ `node.ts:1387-1406` 接线 + 测试。
- omz 同款 bug：`packages/services/src/node.ts:1275-1278` 只查 tasks-index 且未传 `includeDeleted`（清空过任务列表的存量用户失去资格）；触发链完整（`useOnboardingTrigger.ts:45-50` UI 挂载即判）。
- **品牌适配（最隐蔽坑）**：路径常量必须 `~/.omz/cli/config.json`、`~/.omz/cli/db/db.sqlite`（漏改=证据源 2 永远 miss、静默失效）；env 键 `ZCODE_SESSION_DB_PATH`/`ZCODE_SESSION_DB` **保留**（omz 实际前缀，`adapters/src/config/env-config.adapter.ts:9,29`）；旧版快照目录用 omz `getAppConfigDir()`（`packages/services/src/paths.ts`，=`{dataBaseDir}/.omz/v2`）下的 `sessions`；`listTaskMetas({ includeDeleted: true })`（omz 已支持，`taskIndexRepo.ts:1572-1579`）；`session` 表名一致可直用 SQL。
- 安全语义照上游：只有 ENOENT 视为「无证据」，其他异常上抛→UI 保守不弹；omz 无 project 体系，上游「project 级配置覆盖=未知」限制可省略。

### U9（A5）server 静态路由路径穿越修复 + 测试 — 安全修复

- omz **确认为漏洞态**：`packages/server/src/http.ts:246-262` 的 `isInsideDirectory` 与上游 v3.15.1 逐字相同（Windows 跨盘 `relative` 返回绝对路径被误判「在根内」），`resolveStaticFile` 无盘符前置拦截；静态路由（:448-463 `app.get("*")`）不在 `isTokenProtectedPath`（:238-240 只保护 `/ws` 与 `/api/`）保护范围。
- 移植：①`isPathDriveQualified`（export，识别 `Z:/x`、`Z:\x`、`Z:x` 及 `%3A` 解码形态）；②`isInsideDirectory` 改 export + 注入 `pathApi`（类型 `Pick<typeof nodePath,"relative"|"isAbsolute"|"sep">`）+ `pathApi.isAbsolute(diff)→false` 判定——**连带把 `node:path` 导入改为 `import * as nodePath` + 具名并存**（上游形态；omz 现为具名导入，`http.ts:4`）；③`resolveStaticFile` 在 `resolve()` 之前拦截盘符路径直接 404（不进 SPA fallback）。
- 上游同文件混有 R3 改动（`/api/connect-remote` 删除等）**不带入**（omz 仍需 :420-446）。测试：`packages/server/test/staticRoutePathContainment.test.ts`（node:test 转写上游 3 组 describe），`packages/server/package.json` 加 test 脚本（`tsx --test test/*.test.ts`，tsx 已在 devDependencies），根 `package.json` 的 `test:v4-perf` 文件清单登记；新建 `packages/server/tsconfig.test.json`（先例 `packages/shared/tsconfig.test.json`）**并在根 `package.json` 的 `typecheck` 显式工程列表加入**（否则不进 root typecheck）。`http.ts` 首行已有 max-lines 豁免，无行数压力。

### U10（B1）side-pane-full-view 面板全屏视图 — 新功能（本轮最大项）

- 上游新目录 13 文件 1223 行：`ConversationHost.tsx`（610）/ `model.ts`（203）/ `useSidePaneFullView.ts`（108）/ `conversationPanePresentation.ts`（21，`ConversationPanePresentationContext`——SessionPane 的 `isFloatingPresentation` 来源）/ contract 系 / `ConversationTab` / `ToggleButton` / `anchorPreference` / `index` / `module` / `CONTRACT.md`。**不依赖 project-sidebar**（全目录 0 引用）。
- omz 前置缺口（Step 1/13 处理）：①`packages/shared/package.json` exports **无 `./test-ids` 子路径** → 补 `"./test-ids": "./src/test-ids.ts"`；②`packages/ui/src/v4/conversationTimelineLiveTail.ts` 缺 `ConversationLatestTurnSummary` **接口（export interface，SessionPane :201 需 import）** + `resolveConversationLatestTurnSummary()` / `isSameConversationLatestTurnSummary()` → **补接口 + 2 函数 + 消费方 hunk**（上游消费方=ConversationTimeline.tsx:485/501，只补函数不补消费方=死导出、knip 必红；上游另有 `conversationLatestTurnSummary.test.ts` 一并参考转写）；③`shortcutCommands.ts` 加 `toggleSidePaneFullView`（channel window，默认 `CmdOrCtrl+Shift+F`）。
- **接线面 = 上游 `-G"sidePaneFullView|SidePaneFullView"` 提取的 8 处既有文件 + 本 fork 必需的 5 处 floating-presentation 线挑选 hunk**（上游 CONTRACT.md 自列三个消费方 SessionPane / ConversationTimeline / V4WorkspaceChatArea；后五者属 floating-presentation 线，`-G` 提取不到，但 full-view 没有它们不完整）：
  - 【8 处】`app-shell/WorkspaceShellLayout.tsx`（**真正的挂载宿主**：上游在 shell 层渲染 `SidePaneFullViewConversationHost`，omz 1960 行 fork 手工融合，勿整搬）；`app-shell/types.ts`（新增 `toggleSidePaneFullViewShortcutLabel` / `sidePaneFullView` prop，App→Shell→Panel 传递链）；`app-shell/AnimatedSidePanePanel.tsx`（角色=提供 `fullViewSlotRef` 插槽 + `SidePaneFullViewToggleButton` + `SidePaneFullViewConversationTab`，**不是宿主本体**；**omz 特有——轨迹面板分支 :1248-1255 不吃 `visible`/`focused` 闸门，必须显式补隐藏条件**，否则全屏时轨迹面板与对话宿主重叠）；`App.tsx`（处理器表加 `toggleSidePaneFullView`，仅 desktop；面板关闭先展开再全屏）；`lib/taskSidePaneMemory.ts`（**新增状态字段** `sidePaneFullViewByOwner` + `peekTaskSidePaneFullView` / `saveTaskSidePaneFullView`，按会话持久化 full-view 态；omz 有文件但**无此字段**，非「已有依赖」）；`settings/ShortcutSettingsSection.tsx`（非 desktop 不展示改键入口）；`shared/shortcutCommands.ts`（上述 ③）；`shared/test-ids.ts`（+14 个 `TID_SIDE_PANE_FULL_VIEW_*`）。
  - 【5 处挑选 hunk】`v4/SessionPane.tsx`（omz 无 `isFloatingPresentation` 概念——来源=消费新模块的 `useConversationPanePresentation()`，context 由 ConversationHost 提供；透传 `layout={isFloatingPresentation ? "inline" : "stacked"}`；上游 :5930-5941 还向 ConversationTimeline 透传 floating 三 prop）；`v4/ConversationTimeline.tsx`（上游 :338-345 新增 `floatingComposerDock`/`onComposerDockHeightChange`/`onLatestTurnSummaryChange` 三 prop，:485/501 消费 liveTail 两函数，:604/1038 dock 布局——不补则 SessionPane 透传无处接、liveTail 函数成死导出）；`v4/V4WorkspaceChatArea.tsx`（上游 :244-247 `soloPaneId`、:526-533 `hidden`+`FULL_WORKBENCH_RECT`——floating 时折叠多 pane；**连带 omz 落点 `v4/WorkbenchPane.tsx`（WorkbenchLeafPane 增 `hidden` prop）与 `v4/workbenchLayout.ts`（增 `FULL_WORKBENCH_RECT`）**）；`prompt-editor/ChatPromptEditor.tsx`（新增 `layout?: "stacked"|"inline"`）；`prompt-editor/useComposerToolbarFit.ts`（omz :47 无 `iconOnly`——移植子集界定：**取** `iconOnly` 与其依赖的 `toolbarOverflow` 抽取段，**剔除** C1 的 `[data-composer-combined-model]` 分支与 observer 早退优化段（后者是普通 composer 的行为变化，有回归面，不随本轮带））。
  - locales：+12 key（`sidePane.fullView.*` **11** + `settings.shortcuts.command.toggleSidePaneFullView` 1，en+zh；上游实数，勿多造）。
- 不迁：上游 `useAppPanels.ts`/`tabStore.ts` 的 v3.16 改动（属 T01 虚拟项目，full-view 0 引用）；`contract.test.ts` 按 omz 形态转写 node:test；`CONTRACT.md` 保留文件但 omz `architecture-policy.yaml` 对 ui 是 `managed:false`，不入受管门禁。
- 行数：`ConversationHost.tsx` 610 行超 oxlint max-lines 400 → 文件头 `/* eslint-disable max-lines */` + 理由注释（逐字移植件保持可 diff，先例 `packages/server/src/http.ts`）；不拆文件（拆分=制造与上游的假分叉）。

### U11（A7）fileApplications「用应用打开」— 新功能

- 上游 `packages/desktop/src/main/fileApplications.ts`（+321，纯 Node 内置模块零第三方依赖，零品牌字面量）：三平台候选表 + `matchesFileApplication` + `resolveFileApplicationPath`（access 探测→Linux PATH→Windows `App Paths` 注册表→WPS 版本目录扫描）。
- omz 落点：`editors.ts`（`getEditorDefsForCurrentPlatform` 合并 + `getInstalledEditors(filePath?)` 拆 base/文件应用，`cachedFileApps` 失败即 evict）；打开逻辑抽独立文件 `packages/desktop/src/main/openWithFileApplication.ts`（`openInEditor.ts` 412 行已近 400 上限，+53 必超）——校验「本机绝对路径 + 异步 stat 真实文件 + 非远端 + 非目录 + 扩展名匹配」后 macOS `open -a` / Win+Linux `spawn detached + unref`。
- 协议链（**5 包 6 落点**）：`shared/platform.ts:843` `getInstalledEditors(filePath?: string)` → `client/globals.d.ts:243` → `desktop/preload/index.ts:581` → `renderer/desktopPlatform.ts:106` → `desktopMainIpcPlatform.ts:332` IPC 透传 → `web/main.tsx:173` 保持返回 `[]`（签名兼容）。
- UI：`OpenSplitButton.tsx:109`（聊天预览卡，`target.type==="file"` 时传 `target.path`）+ `PreviewPane.tsx:671`（**加序号守卫防「切换预览文件时旧查询覆盖新列表」竞态**）；工作区编辑器列表 3 处调用点（`message.tsx:1154`/`WorkspaceEditorButtonGroup.tsx:49`/`workspace-file-tree/useInstalledFileTreeEditors.ts:15`）保持无参（语义不变）。

### U12（B10）Windows 任务栏未读角标 — 新功能（r3 按实物核实重写）

- 上游渲染形态（主代理 `git show`+`git grep` 亲自核实，裁决 r1/r2 审查矛盾）：**任务栏 overlay=红点**（`desktopWindowLifecycle.ts:351,357` 用 `renderTaskbarStatusDotPixels` 1x/2x，忽略数字；Win10 右下锚定 / Win11 画布居中）；**托盘=红点**（`desktopTray.ts:173` 用 `renderAntialiasedStatusDotPixels` 经 `blendBadgeIntoBitmap` 合成，上游注释：16px 显示尺寸下数字不可读只画圆）；**数字只进无障碍 description**（`resolveBadgeOverlayLabel`，unreadBadge.ts:34）。数字渲染器 `renderTaskbarBadgePixels`（unreadBadge.ts:105）在上游 src 生产路径零调用（仅测试引用），**不迁**（已核实 `renderAntialiasedStatusDotPixels` 不依赖它）。上游文件：`unreadBadge.ts`（+320；**迁移导出面**=`maxWindowUnreadCounts`:13 / `supportsWindowOverlayBadge`:29 / `resolveBadgeOverlayLabel`:34 / `blendBadgeIntoBitmap`:182（desktopTray.ts:13 必 import，漏则托盘编译断）/ `renderAntialiasedStatusDotPixels`:236 / `renderTaskbarStatusDotPixels`:277 / `applyTaskbarOverlayToWindows`:300 / `createWindowsTaskbarOverlayApplier`:319，及类型 `TASKBAR_BADGE_IMAGE_SIZE`:61 / `BadgePixelOptions`:89 / `AntialiasedDotOptions`:227 / `TaskbarOverlayLayout`:275 / `TaskbarOverlayWindow`:295）+ `desktopWindowLifecycle.ts`（+60）+ `desktopTray.ts`（+119）。
- omz 落点：`unreadBadge.ts`（现 36 行仅 darwin/linux，与上游 v3.15.1 仅差一个 `export`——上游 `supportsAppUnreadBadge` 已导出、omz `:21` 未导出）扩 Windows overlay 红点分支——**按上游登记 API 演进**：`syncAppUnreadBadge` 改名 `syncUnreadBadgeForPlatform`（新增 `applyOverlay` 回调注入）+ 新增导出 `supportsWindowOverlayBadge`；`desktopWindowLifecycle.ts:302-310` 接线扩多窗口 overlay；`desktopTray.ts` 加红点合成。Win11 判定复用 omz `desktopWindowChromeState.ts`（常量 `WINDOWS_11_FIRST_BUILD` 在 **:4**，`supportsNativeWindowsRoundedCorners` 函数在 **:19 且未导出**——按上游补 export 后由 lifecycle 复用）。
- **计数口径**：omz 每窗口上报同一全局未读任务总数（`Root.tsx:331` → `useRootPlatformEffects.ts:273` → `syncWindowUnreadCount`）→ 聚合**按上游取 max**（omz `unreadBadge.ts:11` 现为 `sumWindowUnreadCounts`，**连带改为 max**，多窗口同值 sum 会翻倍）。数据源语义即「未读任务」，无需 renderer 重算。
- **overlay 无障碍 description**：沿用上游固定格式 **`${label} unread tasks`**（`label` 为 `resolveBadgeOverlayLabel` 产物，≥10 时为 `"9+"`；上游 `unreadBadge.ts:306` 实格式；主进程无 i18n 管线；IPC 载荷保持纯数字 `number`，`shared/channels.ts:655-658` 不改）。中文文案如需，登记为后续独立项。

## 横切约束

1. **品牌映射**（本批涉及）：`~/.zcode/cli/*` → `~/.omz/cli/*`（仅 U8 路径常量）；`ZCODE_SESSION_DB_PATH`/`ZCODE_SESSION_DB`/`ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS`/`@zcode/*`/`zcode-protocol-v4` 模块名 **保留不改**；本批不新增 `zcode://` 引用。
2. **i18n 键级合并**：所有 locale 改动=逐 key 插入 en+zh 两文件，**禁止整文件覆盖**（omz 有 228 个自有 key 含轨迹面板文案）。本批增量 **15 key**：`sidePane.fullView.*` 11 + `settings.shortcuts.command.toggleSidePaneFullView` 1 + `ssh.validation.port` 1 + `chat.toolCall.previewFailed`/`previewUnavailable` 2（各 ×2 locale 文件；上游实数，实施时以上游 locale diff 为准逐条对照）。
3. **测试形态与登记**（每个用例=文件路径 + runner + 聚合，r3 全量落定）：

| 用例 | 文件路径 | runner | 聚合 |
|---|---|---|---|
| T-C1 | `apps/zcode-cli/packages/bootstrap/scripts/test-legacy-cli-provider-config-import.mjs` | node --test（import dist，前置 `pnpm --filter` 对应包 build） | `test:cli-backport` |
| T-C2 | `apps/zcode-cli/packages/bootstrap/scripts/test-dynamic-workflows-skill.mjs`（node:fs 读 `bundled-skills/.../SKILL.md` 文本断言；bundled-skills 非 workspace 包，脚本挂 bootstrap） | node --test | `test:cli-backport` |
| T-C3 | `apps/zcode-cli/packages/bootstrap/scripts/test-late-tool-input-guard.mjs` | node --test | `test:cli-backport` |
| T-C4 | `apps/zcode-cli/packages/core/scripts/test-model-creation-failure.mjs` | node --test | `test:cli-backport` |
| T-U1/T-U2/T-U3 | `packages/ui/test/{dialog-close-i18n,toolcall-inline-image,remote-connection-validation}.test.ts` | `npx tsx --test`（ui `tsconfig.test.json` 已存在，进 root typecheck） | `test:ui-backport`（新建根脚本） |
| T-S1/T-S2 | `packages/server/test/staticRoutePathContainment.test.ts`、`packages/services/test/localUsageEvidence.test.ts` | `npx tsx --test` | 根 `test:v4-perf` 既有清单登记 |
| T-D1/T-D1b | `packages/ui/test/{side-pane-full-view-contract,side-pane-full-view-wiring}.test.ts` | `npx tsx --test` | `test:ui-backport` |
| T-D2 | `packages/desktop/test/file-applications.test.ts`（**新建目录** packages/desktop/test/） | `npx tsx --test` | `test:desktop-backport`（新建根脚本） |
| T-D3 | `packages/ui/test/preview-pane-apps-guard.test.ts`（协议链兼容由 Step 18 全量 typecheck 覆盖） | `npx tsx --test` | `test:ui-backport` |
| T-D4 | `packages/desktop/test/unread-badge.test.ts` | `npx tsx --test` | `test:desktop-backport` |

   全部新测试登记进交付物 **`docs/iterations/upstream-v3.16-sync/cache/test-wiring-map.md`**（v3.15.1 先例），Step 18 门禁含「登记表与实际脚本一致」。

4. **max-lines 400 不放宽**；新组件独立文件（U10 ConversationHost 例外见上）；`packages/ui/src/components/ui` 在 oxlint ignorePatterns 内。
5. **门禁口径**（Step 18 执行）：根 `pnpm typecheck` 0 err（**含根 `package.json` typecheck 显式清单加入 `packages/server/tsconfig.test.json`（Step 11）与 `packages/desktop/tsconfig.test.json`（Step 15 新建，先例同 server——desktop 现有 tsconfig.main.json 仅 include src/main，test 文件无工程覆盖）**）；`cd apps\zcode-cli && pnpm typecheck` turbo successful；`node scripts/typecheck-desktop-full.mjs` 差分零新增；`pnpm test:v4-perf` + `pnpm test:cli-backport` + `pnpm test:ui-backport` + `pnpm test:desktop-backport` 四聚合全绿；lint：**0 error 硬门禁**，warning 口径=`npx oxlint` 全量回到 **74w** 基线（现 170w=自有 74 + `.reference` 96，因 `.oxlintrc.json` 现有 `.reference/**` 写法实测不生效——Step 1 改为目录形式 `.reference` 后复核 74w/0e），新增改动**零 warning 增量**；**knip 口径：本轮实施前重新采集基线存 `docs/iterations/upstream-v3.16-sync/cache/gate-knip.json`，Step 18 对比「零新增 issue」；并在 `knip.json` ignore 补 `packages/desktop/test/**` 与 4 个新 CLI 脚本（`apps/zcode-cli/packages/bootstrap/scripts/test-legacy-cli-provider-config-import.mjs`、`test-dynamic-workflows-skill.mjs`、`test-late-tool-input-guard.mjs`、`apps/zcode-cli/packages/core/scripts/test-model-creation-failure.mjs`——形态同既有 ignore 先例 `test-attachment-preview-text-plain.mjs`，不 ignore 即新增 unused-file issue）**；`apps/zcode-cli` 包内 oxfmt 改动文件零新增不合规（CRLF 归一 LF）。
6. **逐项独立 commit**（带 pathspec），任何一项可单独 revert。

## 详细实现步骤

- Step 1 — phase-foundation — blocking: yes — qa: auto：切分支 `upstream-v3.16-backport`；`packages/shared/package.json` exports 补 `"./test-ids": "./src/test-ids.ts"`（additive）；`.oxlintrc.json` 的 ignorePatterns `.reference/**` **改为 `.reference`**（目录形式才生效），复核 `npx oxlint` 从 170w 回到 74w/0e；spec 头部记录 v3.15.1 基线政策（见§总体方案）；提交本迭代文档。
- Step 2 — phase-cli-runtime — blocking: yes — qa: auto：U1 importer 四 hunk 重放 + 两函数 export。
- Step 3 — phase-cli-runtime — blocking: yes — qa: auto：T-C1（U1 五用例：内置套餐丢弃只留 Key / 显式 Provider 投影含 `optionSpecs:{maxOutputTokens:{max:16000}}` 断言 / 只选 model 不迁 Provider / ZAPI 不迁 / 旧 options 任意字段忽略）。
- Step 4 — phase-cli-runtime — blocking: yes — qa: auto：U2 SKILL.md 3 处 hunk + `:110-119` 措辞统一；T-C2 同步落。
- Step 5 — phase-cli-runtime — blocking: yes — qa: auto：U3 product-projection.ts 三处守卫；T-C3 同步落。
- Step 6 — phase-cli-runtime — blocking: yes — qa: auto：U4 turn.ts 六处改造。
- Step 7 — phase-cli-runtime — blocking: yes — qa: auto：T-C4（创建失败四断言：TurnStarted 已发 / 用户消息已落库 / `turnPhase==="model_creation"` / 终态错误=创建错误而非落库错误）。
- Step 7b — phase-cli-runtime — blocking: yes — qa: auto：根 `package.json` 加 `test:cli-backport`（node --test T-C1/T-C2/T-C3/T-C4 四路径）+ `test:ui-backport`/`test:desktop-backport`（tsx --test 占位清单，随后续 Step 充实）。
- Step 8 — phase-ui-components — blocking: yes — qa: auto：U5 dialog/collapsible/kbd 三修复 + 新建 `ControlShortcutBadge.tsx` + `ControlHintTooltip.tsx` 复用；T-U1 落。
- Step 9 — phase-ui-components — blocking: yes — qa: auto：U6 三缺陷 + 两 i18n key；T-U2 落。
- Step 10 — phase-ui-remote — blocking: yes — qa: auto：U7 端口校验（含 buildRemoteTarget 接线）+ 聚焦跟随三静态 props + alias 清除守卫；T-U3 落（含聚焦断言）。
- Step 11 — phase-services — blocking: yes — qa: auto：U9 http.ts 三处修复（含 nodePath 导入形态）+ T-S1 + `packages/server/tsconfig.test.json` + 根 typecheck 清单登记 + server test 脚本 + `test:v4-perf` 登记。
- Step 12 — phase-services — blocking: yes — qa: auto：U8 localUsageEvidence.ts（路径 `~/.omz`）+ `node.ts` 接线 + T-S2 + `test:v4-perf` 登记。
- Step 13 — phase-ui-panels — blocking: yes — qa: auto：U10 新目录 13 文件移植（含 `conversationPanePresentation.ts`）+ T-D1（contract/model/anchorPreference 转写）+ `shortcutCommands`/`test-ids`/locales 增量（12 key）+ `conversationTimelineLiveTail` 补 2 函数 + `taskSidePaneMemory` 加状态字段与 peek/save。
- Step 14 — phase-ui-panels — blocking: yes — qa: auto：U10 接线：8 处既有文件（App/types/WorkspaceShellLayout 宿主/AnimatedSidePanePanel 插槽与轨迹闸门/ShortcutSettingsSection 等）+ 5 处 floating-presentation 挑选 hunk（SessionPane context 消费与 layout 透传 / ConversationTimeline 三 prop+dock 布局 / V4WorkspaceChatArea soloPane+hidden（连带 WorkbenchPane.hidden、workbenchLayout.FULL_WORKBENCH_RECT）/ ChatPromptEditor layout / useComposerToolbarFit iconOnly 子集）；T-D1b 接线契约断言落。
- Step 15 — phase-desktop — blocking: yes — qa: auto：U11 `fileApplications.ts` + `openWithFileApplication.ts` + `editors.ts` 合并与缓存策略；T-D2 落（新建 `packages/desktop/test/` 目录 + `packages/desktop/tsconfig.test.json` 并登记根 typecheck 清单）。
- Step 16 — phase-desktop — blocking: yes — qa: auto：U11 协议链 5 包 6 落点签名透传 + `OpenSplitButton` 传 path + `PreviewPane` 序号守卫；T-D3 落。
- Step 17 — phase-desktop — blocking: yes — qa: auto：U12 `unreadBadge.ts` Windows overlay 红点 + sum→max + `desktopWindowChromeState` 补 export + lifecycle 多窗口接线 + tray 红点合成 + 英文 description；T-D4 落。
- Step 18 — phase-gates — blocking: yes — qa: auto：全量门禁（§横切 5，四测试聚合 + knip 基线对比）+ `cache/test-wiring-map.md` 登记核验 + CHANGELOG 条目（修复类 U1/U3/U4/U5/U6/U7/U8/U9、新增类 U2 提示词加固/U10/U11/U12、U4/U3 行为变化注明）。
- Step 19 — phase-gates — blocking: no — qa: manual_user：真机验收清单执行（T-M1/T-M2/T-M3），合并后用户执行，不阻塞门禁。

## 测试策略与测试用例

自动化（路径/runner/聚合见 §横切 3 表）：

- T-C1 — blocking: yes — Step 3：U1 五用例。
- T-C2 — blocking: yes — Step 4：U2 文本断言（3 处关键句存在 + `:110-119` 区无「no per-subagent model choice」矛盾句）。
- T-C3 — blocking: yes — Step 5：U3 守卫三断言（scheduled 带输入后迟到 `tool_call` 不覆盖 `input/inputText`；finalize 后 delta 丢弃；existing-upsert 写 `toolName`）。
- T-C4 — blocking: yes — Step 7：U4 创建失败终态四断言。
- T-U1 — blocking: yes — Step 8：dialog 关闭按钮 aria-label/text 取 `common.close`；kbd 使用 `bg-tooltip-tag`。
- T-U2 — blocking: yes — Step 9：InlineImageContent 失败态（previewFailed/previewUnavailable）+ 路径变更清旧结果；cua/nodeRepl src 优先断言。
- T-U3 — blocking: yes — Step 10：端口边界（空/0/65536/65535/非数字）；alias 清除守卫 hook 级；聚焦跟随（`focusField` 指定字段获得 focus 的组件级断言）。
- T-S1 — blocking: yes — Step 11：路径穿越（`Z:/x`、`Z:\x`、`Z:x`、`%3A` 解码态、`../` 穿越、合法相对路径 6 组）。
- T-S2 — blocking: yes — Step 12：三证据源（临时目录 fixture：tasks-index 空但 session 表有行→存量；旧快照目录含 `.deleted.json`→存量；config 指定 db 路径生效；ENOENT=新用户；非 ENOENT 异常上抛）。
- T-D1 — blocking: yes — Step 13：full-view contract/model/anchorPreference 纯函数测试（node:test 转写）+ `ConversationLatestTurnSummary`/`resolveConversationLatestTurnSummary`/`isSameConversationLatestTurnSummary` 两函数单测（参考上游 `conversationLatestTurnSummary.test.ts` 转写）。
- T-D1b — blocking: yes — Step 14：**接线契约断言**：`shortcutCommands` 表含 `toggleSidePaneFullView` + 14 个 TID 常量存在 + 12 个 locale key 存在于 en/zh 双文件 + 源码静态断言（`WorkspaceShellLayout.tsx` 含 `SidePaneFullViewConversationHost`、`AnimatedSidePanePanel.tsx` 含 `fullViewSlotRef`、`taskSidePaneMemory.ts` 导出 `peek/saveTaskSidePaneFullView`、`SessionPane.tsx` 含 `useConversationPanePresentation`、`ChatPromptEditor.tsx` 含 `layout`、`ConversationTimeline.tsx` 含 `floatingComposerDock`、`V4WorkspaceChatArea.tsx` 含 `soloPaneId`、`workbenchLayout.ts` 含 `FULL_WORKBENCH_RECT`）；其余行为面（真实全屏交互/浮窗/轨迹隐藏）由 T-M1 真机兜底。
- T-D2 — blocking: yes — Step 15：`matchesFileApplication` 扩展名匹配（大小写/反斜杠）；`resolveFileApplicationPath` 候选探测（可注入 fs/path）。
- T-D3 — blocking: yes — Step 16：`PreviewPane` 序号守卫（旧查询结果不覆盖新文件列表）；协议链签名兼容由 Step 18 全量 typecheck 覆盖。
- T-D4 — blocking: yes — Step 17：`resolveBadgeOverlayLabel` 边界 0/1/99/999；`maxWindowUnreadCounts` 多窗口同值不翻倍。

真机（manual_user，合并后验收）：

- T-M1 — Step 14/19：full-view 真机（快捷键进出全屏、浮窗收起/恢复、轨迹面板 tab 在全屏下的隐藏与恢复、⇧⌘F 与浏览器搜索冲突核对）。
- T-M2 — Step 17/19：Windows 真机角标（任务栏**红点**出现/消失、Win10 vs Win11 锚定、**托盘红点**出现/消失、清零全部消失）。
- T-M3 — Step 8/19：collapsible 全 UI 观感回归（轨迹面板三重嵌套、工具卡详情、设置页折叠区）。

## 风险与回滚方案

| 风险 | 等级 | 缓解 / 回滚 |
|---|---|---|
| v3.15.1 基线缺失下手工重放出「四不像」 | 高 | 基线政策已记录（§总体方案）：逐 hunk + fork 行号级实证（4 轮探索）+ 每 hunk 落点三查（fork 现状/上游形态/差异理由）；83 假 CLEAN 文件本轮不碰 |
| U4 落库顺序（TurnStarted 已发但落库失败→孤儿轮） | 高 | `reportedCreationFailure` 分支完整移植（落库错误只 warn 不覆盖创建错误、终态必写）；T-C4 断言 4；单项 revert |
| U3 守卫吞正常 delta | 中 | 已验证 `openToolRow` 不写 `input` → 不会误吞；T-C3 锁定 |
| U10 接线面在 fork 分叉文件上手工融合（WorkspaceShellLayout 1960 行/SessionPane/ConversationTimeline/V4WorkspaceChatArea） | 高 | 接线=8 处 -G 提取 + 5 处挑选 hunk 双清单；T-D1b 契约断言（8 条源码静态断言）+ T-M1 真机 |
| U10 ConversationHost 610 行 vs max-lines 400 | 中 | 文件头 disable + 理由注释（先例 http.ts）；不拆分保持与上游可 diff |
| U11 协议链 5 包签名变更 + PreviewPane 竞态 | 中 | 可选参数向后兼容（无参调用不变）；序号守卫 + T-D3；web stub 返回 [] 不变 |
| U12 角标口径 | 低 | 已核实=全局未读任务总数，聚合取 max（上游同款）；T-D4 单测锁 |
| U5 collapsible 观感全 UI 面变化 | 中 | T-M3 真机回归三区域；单项 revert 只回滚组件文件 |
| i18n key 漏翻/覆盖/多造 | 低 | 键级插入 + en/zh 同批 commit；T-D1b 断言 12 key 实数；knip 扫死键 |
| 上游 hunk 混入 R3/遥测面 | 高 | 逐 hunk 挑拣纪律（§总体方案）；code-review 阶段逐项核对 |

回滚总则：12 项各自独立 commit（带 pathspec），任一出问题 `git revert <项 commit>` 不牵连他人。

## 已知限制 / 实现注

1. U1 不改「旧 CLI 文件」读路径（`~/.omz/cli/config.json` 即 omz 语境的旧格式文件；跨品牌迁移 `~/.zcode→~/.omz` 是另一议题）。
2. U5 的 muted token 全局缺失（约 99 处空 class）不在本轮修；dropdown indicator（有消费方但零收益）/ tooltip alwaysDelay 两子项延后。
3. U7 不做 Docker/WSL inputMode 二分重构；聚焦跟随收窄为三静态 props（无 `focusFirstEmptyToken`，omz 无粘贴/导入触发流）；「编辑已存连接保留 alias」因 `EditConnectionProfileDialog` 在 omz 不存在而移出，待 omz 出现连接编辑入口再迁。
4. U10 的 `CONTRACT.md` 保留但不受 omz architecture 受管门禁（ui `managed:false`）；上游 `useAppPanels`/`tabStore` 的 v3.16 改动属 T01 不迁。
5. U11 工作区编辑器列表三调用点保持无参。
6. U12 渲染形态=红点（任务栏+托盘），数字仅 description（上游实物如此；若未来要数字托盘=超出上游的产品增强，需另立设计）；description 沿用上游英文（主进程无 i18n 管线，IPC 载荷保持 number）；中文文案登记后续。`@radix-ui/react-collapsible@1.1.12` 性能 patch **不带**（U5 源码修复独立）。
7. 测试聚合四轨：`test:v4-perf`（services/server 既有清单）+ `test:cli-backport`（新）+ `test:ui-backport`（新）+ `test:desktop-backport`（新）；全部登记 `cache/test-wiring-map.md`。`packages/desktop/test/` 为本轮新建目录。
8. **悬空文档引用处理**：上游代码注释指向 `docs/desktop/windows-taskbar-unread-badge.md`（unreadBadge.ts:23,33）、`docs/ui/side-pane-full-view.md`（conversationPanePresentation.ts:2 / CONTRACT.md）等 omz 不存在的文档——逐字移植时**删去或改写这些注释引用**（不留悬空路径），上游动机文档仅存 `.reference/ZCode` 供查阅。

## 排除项登记（本轮不做，附理由）

| 项 | 理由 |
|---|---|
| B6 autoUpdater 两缺陷点+冒烟 | omz 桌面端**无自动更新链路**（autoUpdater.ts 整文件删除、无 electron-updater 依赖；先前「−1924 行重写」口径有误）；引入自更新=产品立项非同步项 |
| B7 DB 迁移 4 条 | 服务未移植功能=死 schema；omz 账本（3 列 `time_applied`）与 checksum 算法与上游兼容，无需动作。**红线：不得顺手搬上游 `schema-v1.ts`/`official-glm-selection-v3.ts`**——会改 0001/0003 checksumInput → 既有库启动即 `checksum_mismatch` 抛错 |
| B8b runtimeInitialization 就绪门禁 | 五层新建（shared schema+publisher+projection+gateway+UI）非移植；omz V4 两主文件双向重分叉（product-projection +163/−657） |
| B8 其余三项（provider/refreshRegistry、sessionsIndexReconcile、lastOutcome） | 各自依赖 provider 注册表/v4-gateway 的 v3.16 重构面（omz 双向分叉），逐项单独评估，不随本批 |
| B5 windowRemoteConnectionRegistry transitionEpoch 竞态修复 | omz 远程连接为「一断即死」无自动重连/换代状态机（上游 epoch 守卫的主要载体 omz 不存在）；最小守卫版（connect() await 后复核 entry.state/epoch）确有同型竞态价值，但改动 SSH/WSL/Docker 三路径竞态语义需专门回归，排后续单独批次 |
| A4 thoughtLevelLabels 外提 | 无 C1（合并入口）则无消费方，随 C1 搁置 |
| B2 整体 i18n 合并 | 改为逐项 key 级（本批 15 key）；上游 +1273 key 多数服务未移植功能=死键；`conversationShare.*` 20+ 死键清理列为可选后续 |
| C1 chat-input 模型+Think 合并入口 / C2 buildUserMessageEntries 装配统一 | 撞 magic-context 自研面（contextUsage.tsx 474 行 / turn-transform 87KB），需单独拍板 |
| U7 子项「编辑已存连接保留 savedSshConfigAlias」 | omz 无 `EditConnectionProfileDialog`/连接编辑入口，参数无消费方（死代码+撞 knip 零新增），登记后续 |
| U12 数字托盘徽章 | 上游生产路径未使用（`renderTaskbarBadgePixels` 仅测试引用）；如做属超上游产品增强 |
| D 档全部（R3/relay v2/虚拟项目/ToolSearch/office-runtime/off-peak/share/includeArchived 移除/telemetry/max-lines 800/settings SourceServer 分区/test-ids 子路径全量迁移） | 见 `summary.md` D 档表；其中 includeArchived 移除是 P0 数据风险（omz `repairSubagentTaskIndex.ts` 活跃依赖） |

## 验证矩阵（Step × T 用例）

| Step | 自动用例 | 真机 |
|---|---|---|
| 1 | ignorePatterns 修法后 `npx oxlint` 复核 74w/0e（门禁前置自检） | — |
| 2-3 | T-C1 | — |
| 4 | T-C2 | — |
| 5 | T-C3 | — |
| 6-7 | T-C4 | — |
| 7b | 四聚合脚本接线（占位清单跑通） | — |
| 8 | T-U1 | T-M3 |
| 9 | T-U2 | — |
| 10 | T-U3 | — |
| 11 | T-S1 | — |
| 12 | T-S2 | — |
| 13 | T-D1 | — |
| 14 | T-D1b | T-M1 |
| 15 | T-D2 | — |
| 16 | T-D3 | — |
| 17 | T-D4 | T-M2 |
| 18 | 全门禁（四测试聚合）+ 登记表核验 | — |
| 19 | — | T-M1/T-M2/T-M3 执行 |
