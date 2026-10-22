# CR Fix Spec: trace-3fix-v119

## 元信息

- repo: D:\Dev\Js\oh-my-zcode
- base_sha: b952d749（v1.0.18 发布点）
- head_sha: 本文件最新提交（实现基线 95bb4ecb）
- prd_path / spec_path: 未提供（真机反馈三修复，需求=用户拍板三条）
- review_round: 3 / dag_version: 2（CR diff 评审 1 轮 + spec-check r1/r2 doc-fix）
- 状态: draft（待 spec-check r3 复验）

需求基线（用户拍板）：

1. 换模型后面板空白需自愈（形态经追问确认：面板空白；CR 判定真实形态更可能是 **empty**（records:[]）而非 error，两种都要覆盖）
2. trace 中所有内容默认折叠（配对卡收成单行头部；点开回合=单行行列表）
3. 助手思考/长内容与用户消息统一单行截断

## Must-fix（按 P1 → P2）

### P1-1 [P1] 删除死通道，改订阅真实运行时重启信号 onAgentRuntimeRestarted

- 维度：A / C-orch
- 文件：packages/ui/src/hooks/useModelTrajectory.ts（现状 :21-22, :56-70, :115-122）
- 问题：`startModelSwitch` / `updateModelSwitchStage` / `finishModelSwitch` 全仓零调用点（仅类型声明 + 实现，grep 实锤），`modelSwitchStage` 恒 "idle"，"非 idle→idle 转变 refresh" 永不发生。
- 改法：
  1. 移除 modelSwitchStage 订阅 effect 与相关 import（`@/store/zcodeSessionStore.js` 的 `selectWorkspaceZCodeState` / `useZCodeSessionStore`，r2 P2-8 修正模块名）。
  2. 改订阅**活的**运行时换代信号：`zcodeAgentService.onAgentRuntimeRestarted` 事件 → `refresh()`。接线形态参照 `packages/ui/src/hooks/useSkills.ts:54,63-68` 同款用法（事件回调里按 `event.workspaceKey === (workspaceIdentity?.trim() || workspacePath)` 过滤本 workspace）。**service 获取口径写死（r2 P1-4）：`useWorkspaceServices(workspacePath, undefined, workspaceIdentity).zcodeAgentService`——与 useZCodeTaskService（useZCodeTaskService.ts:297-299）同源解析的 workspace 作用域 services；禁止裸 `useServices()`（断连代理下该事件返回空订阅，② 会静默失效，见 useWorkspaceServices.tsx:35-37）**。在 effect cleanup 里退订。
  3. 注释写明自愈机制全景：「恢复路径 = ①empty/error 双路径退避重试（P1-2/P2-3，有界 3×5s）②onAgentRuntimeRestarted → refresh（runtime 重启后代际切换）③手动刷新（refresh 重置预算，P1-3）」。**不得**写「服务换代由 zcodeTaskService 引用变化触发」——`useZCodeTaskService` 走 WeakMap 缓存代理（useZCodeTaskService.ts:304-310），renderer 侧引用稳定，该陈述不成立（r1 P1-D 实证）。
- 边界（如实登记，r2 P1-3 修正）：常规换模型（`dispatchConfigCas("switchModelConfig")`，SessionPane.tsx:2882）不重启运行时、不触发 ②；其空白窗口由 ①③ 覆盖（≤15s 有界退避 + 手动刷新）。`restartWorkspaceProcess` 有**两处**调用：SessionPane.tsx:2951（custom provider 恢复）与 useWorkspaceSessionReload.ts:87（会话重建），两处均重启运行时、均触发 ②。
- 验收：useModelTrajectory.ts 无 store 订阅残留；typecheck 绿；custom provider 换模型（runtime 重启）后面板无需手动刷新即恢复。
- 来源：review r1（agent_ac3b05b0）/ spec-check r1 P1-D（agent_51b522d2）

### P1-2 [P1] empty 态不重试——换模型空白的真实形态未被覆盖

- 维度：A
- 文件：packages/ui/src/hooks/useModelTrajectory.ts；参照 packages/services/src/zcode-agent/modelTrajectory.ts:46-99
- 问题：`readModelTrajectory` 对目录不存在（:49-53）、读文件错误（:70-73）catch 后 continue、对 `sessionId !== taskId` 过滤（:88）——这些"读不到"路径返回 `records: []` 而非 reject。重试只挂在 `.catch`，empty 态永不重试，钉死在 EmptyState。这正是"换模型后面板空白"的主形态。
- 改法（预算语义必须按此执行，r1 P1-B：现码 `.then` 顶部无条件 `retryCountRef.current = 0`，照旧写法=空响应无限重试死循环）：
  1. `.then` 分支：`retryCountRef.current = 0` **只在 `records.length > 0` 的成功分支执行**；`records.length === 0` 视同 error 路径——不重置预算、消耗一次预算并排 5s 退避重试、预算未耗尽时不落 empty 终态（保持 loading，见 P2-3）。**empty/error 的自动重试一律经 `setReloadToken` 触发，禁止经 `refresh()`**（r2 P2-1：refresh 按 P1-3 会重置预算，经它重试=无限循环）。
  2. 预算耗尽后正常落 empty/error 终态。
  3. 判定逻辑全部走 P2-4 抽取的纯函数（success/empty/error 三分支统一入口），禁止在 hook 里二次实现预算判定。
- 合法空 task（真零调用）会经历至多 3×5s loading 后停在 empty——可接受（新 task 极少打开轨迹面板）。
- 验收：单测（P2-4）覆盖「error 重试 / empty 重试 / **连续 empty 不重置预算、第 4 次空读落 empty 终态** / 成功归零」矩阵；真机换模型后空白自动恢复。
- 来源：review r1 / spec-check r1 P1-B

### P1-3 [P1] 重试预算耗尽后手动刷新不再重试

- 维度：B
- 文件：packages/ui/src/hooks/useModelTrajectory.ts
- 问题：`retryCountRef` 仅在成功/`!taskId` 时归零；3 次失败后任何后续失败（含手动刷新）都不再排重试。
- 改法：`refresh()`（外部刷新入口）内先 `retryCountRef.current = 0` 再 bump reloadToken；自动重试路径不走 `refresh()`（直接 `setReloadToken`），避免自我重置造成无限重试。
- 验收：制造 3 连败 → 手动刷新失败 → 仍有自动重试（计数从 0 重开）。
- 来源：review r1

### P1-4 [P1] 「全部展开/收起」语义破损：只开回合壳，行内容仍收起

- 维度：A / C-orch
- 文件：packages/ui/src/ModelTrajectoryPane.tsx:126-148（toggleTurnExpansion / willExpandAll）+ :130-132 注释 + :149-165（handleToggleExpansionKind）
- 问题：v1.0.18 行默认展开时「全部展开」实际呈现全部内容；默认收起后只写 turn 槽 → 回合开、行收起，与 i18n「全部展开」文案及用户预期直接冲突。
- 改法（OQ-1 拍板：全部展开=展开所有内容；r1 P1-C：`toggleTurnExpansion` 是「工具栏按钮 + 菜单回合项」**两入口共用**写路径（Pane:130-132 注释明示），批量写全部槽必须先拆入口，否则菜单「回合」开关会连带翻转用户逐类设置）：
  1. **拆入口**：工具栏「全部展开/收起」按钮（经 `toggleTurnExpansion`）批量写**全部**命令槽（turn + 6 个非 turn）。**目标态定义（r2 P1-1）：7 槽是否全展开的取反**——全展开 → 收起；任一槽未展开 → 展开；7 槽写同一 `{expanded: 目标态, version: 同一递增 version}`。**按钮 label/图标口径同步改为按全部槽聚合判定**（`willExpandAll` 从单看 `turn.expanded` 改为 7 槽全展开才显示「全部收起」）。菜单「回合」项（`handleToggleExpansionKind("turn")` 路径）保持**只写 turn 槽**（回合级语义）。同步修正 Pane:130-132「唯一写入口」注释为「工具栏全量入口 + 菜单按类入口」双写者表述。
  2. 版本覆盖机制（r1 P2-B：Expansion.ts:88-89 JSDoc 把优先级写反了，实现以 :114-117 为准）：**命令 version 新于 per-row override 记录的 commandVersion 时以命令为准**——批量 toggle 后再单独收起某行（写 override、commandVersion=当前），下次全量 toggle 因 version 递增而重新覆盖。
  3. 「turn override 清理」逻辑不变（Pane 只重置 `turn:` 命名空间的 override，非 turn 行 override 不动）。
- 验收：①点「全部展开」→ 所有回合内消息行与配对卡均展开（DOM 可见 content）；点「全部收起」全收起；混合态用例：菜单单独开「回合」后（非 turn 槽仍收起）点工具栏 → 目标态为展开其余 6 槽、turn 保持展开；②先点「全部展开」，再收起某行 → 工具栏连点两次（收起→展开），末态该行展开（version 递增覆盖 per-row override）；③「自定义展开」菜单「回合」项只翻转回合级、不连带改其它类开关。
- 来源：review r1 / spec-check r1 P1-C、P2-B、P2-C；spec-check r2 P1-1、P2-6 / OQ-1 拍板 a 方案

### P1-5 [P1] 搜索多命中：非 active 命中正文不在 DOM → 无高亮、计数与可见高亮不一致

- 维度：A / G
- 文件：packages/ui/src/ModelTrajectoryPane.tsx:361-366（reveal 上下文单键）；ModelTrajectorySearch.ts:75,82（两个 RevealContext 类型声明处，r2 P2-4 补）；ModelTrajectoryExpansion.ts:77-83（useTrajectorySearchRevealed 单键比对）；ModelTrajectorySearchHighlight.ts:38-46, 78-99（getMatchRange 选段）；ModelTrajectoryExpandableMessage.tsx:146（折叠预览 content 字段）
- 问题（两层，r1 P1-A：只改 reveal 集合不够，高亮**选段**还会落在隐藏预览上）：
  1. reveal 层：默认收起后仅 active 命中被强制展开，其余命中行收起 → content 搜索字段不在 DOM → 无高亮；搜索计数来自索引不受影响 → "命中 N 处只见 1 处高亮"。
  2. 选段层：非 active 命中走 `getMatchRange(root, query, match, /* preferExpanded */ false)`，fields 按 DOM 顺序收集——折叠预览 span（ExpandableMessage:146，展开时被 `group-data-[state=open]:hidden` 隐藏）排在展开内容前，预览文本含查询词时 `ranges[0]` 命中**隐藏**预览 → 高亮不可见且 fieldMatchIndex 跨两段文本错位。active 命中正常只因它单独传了 `preferExpanded=true`。
- 改法（OQ-3 拍板：全部命中同时展开高亮）：
  1. reveal 上下文从单 activeKey 扩展为**命中 key 集合**（`TrajectorySearchRevealContext: string` → `ReadonlySet<string>`，回合级 `TrajectorySearchRevealTurnContext` 同理）；`useTrajectorySearchRevealed` 改集合判定（`set.has(key)`），消息键与回合键两命名空间保持不重叠。消费方已列全：Pane:361-366（提供）与 Expansion.ts:79-83（消费）两处，ClampedPreview.tsx:45 经 hook 间接消费。
  2. **选段层配套**：`getMatchRange` 的 `preferExpanded` 从「仅 active 命中」放宽为「行已展开即优先」——非 active 命中在其所在行已被 reveal 展开（open）时，同样优先取 `[data-trajectory-message-expanded]` 内的字段，跳过被 `group-data-[state=open]:hidden` 隐藏的折叠预览 span。
  3. active 命中的视觉强调沿用现有通道（SearchHighlight 的 ACTIVE_HIGHLIGHT_NAME + Timeline 滚动，均由 activeSearchMatch 派生）不变。
- 验收：搜索命中 ≥2 处时全部命中行展开且**非 active 命中的高亮可见**（不落在折叠预览行）；next/prev 时 active 强调跟随移动。
- 来源：review r1 / spec-check r1 P1-A / OQ-3 拍板 a 方案

### P2-1 [P2] 注释漂移：仍写「6 行封顶」+ Expansion JSDoc 优先级写反

- 维度：F / C
- 文件：packages/ui/src/ModelTrajectoryCallInput.tsx:232-234；packages/ui/src/ModelTrajectoryClampedPreview.tsx:71（r1 P2-A：同文件 :98/:101 已是 1lh，:71 仍写「6lh 钳住的盒子」）；packages/ui/src/ModelTrajectoryExpansion.ts:88-90（r2 P2-3：JSDoc 优先级「面板 override > 命令版本 > 局部状态」与实现 :114-117 相反，一并修正为「命令 version 新于 override 的 commandVersion 时以命令为准」）
- 问题：注释仍描述 6lh clamp（实现已改 1lh）；Expansion 优先级注释与实现相反。
- 改法：前两处改为「单行截断（max-h-[1lh]）+ 搜索命中解除 clamp」口径；第三处按实现改写优先级表述。
- 验收：本次涉及文件（CallInput.tsx、ClampedPreview.tsx）内无 6lh 残留表述；路径 A 与配对卡两格的 6lh 属既有设计、不在本次范围（r2 P2-2 限定）；Expansion JSDoc 与 :114-117 实现一致。
- 来源：review r1 / spec-check r1 P2-A、r2 P2-2、P2-3

### P2-2 [P2] useTrajectoryExpansion 默认 defaultOpen=true 成反向陷阱

- 维度：C
- 文件：packages/ui/src/ModelTrajectoryExpansion.ts:97（默认值）、:101（JSDoc，r1 P2-J 修正锚点）
- 问题：三个调用点已显式传 false，默认值 true 意味着新增调用点漏传即回到默认展开，与新默认相反。
- 改法：`defaultOpen = false`；同步修正 :101 JSDoc（「默认收起，与面板整体默认折叠一致」）。
- 验收：typecheck 绿；TurnGroup 显式传 false 行为不变。
- 来源：review r1 / spec-check r1 P2-J

### P2-3 [P2] 重试期间先闪 error 终态再变 loading

- 维度：H
- 文件：packages/ui/src/hooks/useModelTrajectory.ts:106-113
- 问题：首次失败即 setState error，5s 后重试又变 loading——用户先看红色报错再转圈。
- 改法：预算未耗尽时不落 error/empty 终态：失败/空时若仍有预算，保持 `loading:true`（data:null），仅预算耗尽才 setState 终态。
- 验收：3 连败期间面板始终 loading，耗尽后一次性落 error（无中间闪烁）。
- 来源：review r1

### P2-4 [P2] 重试判定抽纯函数 + 单测（G 缺口闭合）

- 维度：G
- 文件：新建 packages/ui/src/ModelTrajectoryRetry.ts（零 `@/` 别名）+ packages/ui/test/modelTrajectoryRetry.test.ts
- 问题：本批唯一逻辑变更（自愈重试）无自动化覆盖；useModelTrajectory.ts 含 React 依赖不可 node:test 直测。
- 改法：抽纯函数，签名与返回**显式定义**（r1 P2-I）：
  ```ts
  export interface TrajectoryRetryInput {
    kind: "success" | "empty" | "error";
    retryCount: number; // 当前已消耗预算
    limit: number; // ERROR_RETRY_LIMIT
  }
  export interface TrajectoryRetryDecision {
    resetBudget: boolean; // 仅 success（非空成功）为 true
    retry: boolean; // 本次是否排退避重试
    terminal: boolean; // 本次是否落终态（empty/error 终态）
  }
  export function decideTrajectoryRetry(input: TrajectoryRetryInput): TrajectoryRetryDecision;
  ```
  （r2 P2-5：两个 interface 均 export，测试侧构造入参。）
  语义：success → `{resetBudget:true, retry:false, terminal:false}`；empty/error 且 retryCount < limit → `{resetBudget:false, retry:true, terminal:false}`（保持 loading）；retryCount ≥ limit → `{resetBudget:false, retry:false, terminal:true}`。hook 的 success/empty/error **三分支都走它**，禁止 hook 内二次实现预算判定（这是 P1-2 死循环的结构性防线）。
  测试用例 ≥6：矩阵全覆盖（含「连续 empty 不重置预算、第 limit+1 次空读落 empty 终态」），登记进根 package.json `test:v4-perf` 聚合（参照 ModelTrajectoryClamp.ts + 既有测试登记形态）。
- 验收：测试用例 ≥6 通过并进聚合。
- 来源：review r1 / spec-check r1 P1-B、P2-I

## Spec deviations

- none。`docs/iterations/trace-nm-borrow/spec.md:101`（非 turn 命令初始 open=true）与 `:189`（N-2 默认展开）已被本批用户拍板显式推翻——按 K 节加失效标注，不属 deviation。

## Open questions / 待拍板

- OQ-2（已由设计吸收）：空白形态 error vs empty → 按 P1-2/P2-3 双路径覆盖，无需真机预确认。
- OQ-1/OQ-3 已拍板（P1-4 a / P1-5 a）。
- 文档归属（r1 P2-E 已处置）：本文件即本迭代**唯一规格文档**（本迭代无独立 spec.md；需求基线三条内嵌于开头，CR r1 原始评审结论已逐条并入各 must-fix 的「来源」栏，不再单独立档）。

## 已豁免（用户确认不修）

- 无。

## 合并后 QA（manual_user）

1. 换模型后轨迹面板自动恢复（不手动点刷新）。custom provider 换模型（runtime 重启，SessionPane 路径）与会话重建（useWorkspaceSessionReload 路径）均即时恢复；常规换模型的读取窗口由 ≤15s 有界退避覆盖，窗口外可手动刷新恢复（边界见 P1-1）。
2. 轨迹默认全折叠：回合收起；点开回合=单行行列表（消息行单行预览、配对卡单行头部）；点行/卡展开。
3. 助手思考/长内容单行截断；「查看全文」与全屏可用。
4. 「全部展开/收起」展开所有内容（非仅回合壳）；「自定义展开」菜单「回合」项只翻转回合级、不连带其它类（P1-4 验收③）。
5. 搜索多命中：全部命中行展开且高亮可见（不落折叠预览行）；计数与可见高亮一致。
6. 重试预算耗尽后的终态表现（error/empty 文案）+ 手动刷新后重新进入自动重试（P1-3 真机形态）。
7. 真机 manual T-N4 既有清单（v1.0.18 挂账）同步执行。

## K 节建议（下游执行时闭合）

1. CHANGELOG v1.0.19：三条用户可见变化 + 显式行为变更标注（消息行/配对卡此前默认展开）。
2. `docs/iterations/trace-nm-borrow/spec.md` 失效标注——**失效锚点集合（r2 P1-2 修正，r1 版把仍成立的标了）**：`:101`（非 turn 命令初始 open=true）、`:112`（路径 B TrajectoryClampedPreview 6lh→1lh）、`:14` 的「收紧到 6 行」口径部分、`:189` 中「默认展开」部分、`:192` 中路径 B clamp 部分。**保留不标**：`:104`（配对卡两格 6lh——ToolPairCard.tsx:356 仍成立）、`:110`（路径 A 6lh——ExpandedContent.tsx:144 仍成立）。
3. 门禁：根 typecheck、lint、fmt:check、test:v4-perf（455+新增全绿）、architecture:check --changed。Pane.tsx 现约 380/400 行（oxlint max-lines 400），P1-4 拆入口若触线，把批量写逻辑下沉到 `ModelTrajectoryExpansion.ts`（r2 P2-9）。
4. DOM 级 e2e 不新增（本批 DOM 态靠 manual 清单 1-7 覆盖，登记留痕）。

## Fix-Spec Closure

| 项 | 状态 |
| fix-spec-ready | yes（r2 doc-fix 后，待 r3 复验） |
| fix_spec_path | docs/iterations/trace-3fix-v119/cr-fix-spec.md |
| dag_version / review_round | 2 / 2（diff 评审 1 轮 + spec-check 2 轮） |
| P0 / P1 / P2（已写入） | 0 / 5 / 4（r1 全并入；r1/r2 审查追加项已并入各条改法与验收） |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none |
| C-orch | ✅（P1-1 死通道收敛 + P1-4 拆入口） |
| C 类合并后 QA | manual 1-7 |
