# CR Fix Spec: trace-3fix-v119

## 元信息

- repo: D:\Dev\Js\oh-my-zcode
- base_sha: b952d749（v1.0.18 发布点）
- head_sha: 95bb4ecb（分支 trace-3fix-v119）
- prd_path / spec_path: 未提供（真机反馈三修复，需求=用户拍板三条）
- review_round: 1 / dag_version: 1
- 状态: fix-spec-ready

需求基线（用户拍板）：
1. 换模型后面板空白需自愈（形态经追问确认：面板空白；CR 判定真实形态更可能是 **empty**（records:[]）而非 error，两种都要覆盖）
2. trace 中所有内容默认折叠（配对卡收成单行头部；点开回合=单行行列表）
3. 助手思考/长内容与用户消息统一单行截断

## Must-fix（按 P1 → P2）

### P1-1 [P1] 删除死通道：modelSwitchStage 订阅永不触发
- 维度：A / C-orch
- 文件：packages/ui/src/hooks/useModelTrajectory.ts
- 问题：`startModelSwitch` / `updateModelSwitchStage` / `finishModelSwitch` 全仓零调用点（仅类型声明 + 实现，grep 实锤），`modelSwitchStage` 恒 "idle"，"非 idle→idle 转变 refresh" 永不发生。fork 真实换模型路径是 SessionPane `dispatchConfigCas("switchModelConfig")` + `restartWorkspaceProcess`，不写该字段。
- 改法：移除 modelSwitchStage 订阅 effect 与相关 import（selectWorkspaceZCodeState/useZCodeSessionStore），注释改为「自愈=empty/error 双路径退避重试（P1-2/P1-3）；服务换代由 zcodeTaskService 引用变化自然触发 effect 重跑」。
- 验收：useModelTrajectory.ts 无 store 订阅残留；typecheck 绿。
- 来源：review r1（agent_ac3b05b0）/ 主代理 grep 复核实锤

### P1-2 [P1] empty 态不重试——换模型空白的真实形态未被覆盖
- 维度：A
- 文件：packages/ui/src/hooks/useModelTrajectory.ts；参照 packages/services/src/zcode-agent/modelTrajectory.ts:60-88
- 问题：`readModelTrajectory` 对目录不存在/读文件错误 catch 后 continue、对 `sessionId !== taskId` 过滤——这些"读不到"路径返回 `records: []` 而非 reject。重试只挂在 `.catch`，empty 态永不重试，钉死在 EmptyState。这正是"换模型后面板空白"的主形态。
- 改法：`.then` 分支增加 empty 重试：`data.records.length === 0` 且重试预算未耗尽时，与 error 同路径排 5s 退避重试（不落 empty 终态，保持 loading）。预算耗尽后正常落 empty/error 终态。合法空 task（真零调用）会经历至多 3×5s loading 后停在 empty——可接受（新 task 极少打开轨迹面板）。
- 验收：单测（见 P2-4 抽取的纯函数）覆盖「error 重试 / empty 重试 / 预算耗尽落终态」三态；真机换模型后空白自动恢复。
- 来源：review r1

### P1-3 [P1] 重试预算耗尽后手动刷新不再重试
- 维度：B
- 文件：packages/ui/src/hooks/useModelTrajectory.ts
- 问题：`retryCountRef` 仅在成功/`!taskId` 时归零；3 次失败后任何后续失败（含手动刷新）都不再排重试。
- 改法：`refresh()`（外部刷新入口）内先 `retryCountRef.current = 0` 再 bump reloadToken；自动重试路径不走 `refresh()`（直接 `setReloadToken`），避免自我重置造成无限重试。
- 验收：制造 3 连败 → 手动刷新失败 → 仍有自动重试（计数从 0 重开）。
- 来源：review r1

### P1-4 [P1] 「全部展开/收起」语义破损：只开回合壳，行内容仍收起
- 维度：A
- 文件：packages/ui/src/ModelTrajectoryPane.tsx:126-148（toggleTurnExpansion / willExpandAll）
- 问题：v1.0.18 行默认展开时「全部展开」实际呈现全部内容；默认收起后只写 turn 槽 → 回合开、行收起，与 i18n「全部展开」文案及用户预期直接冲突。
- 改法（OQ-1 拍板：全部展开=展开所有内容）：`toggleTurnExpansion` 展开时同步把全部非 turn 命令槽写为 `{expanded:true, version: 同一 version}`；收起时同理全 false。保持现有「turn override 清理」逻辑不变（Pane 只重置 turn: 命名空间的 override）。已展开回合内的 per-row override 仍优先（命令 version 机制天然处理）。
- 验收：点「全部展开」→ 所有回合内消息行与配对卡均展开（DOM 可见 content）；点「全部收起」全收起；之后单独收起某行再点「全部展开」仍能展开（version 递增覆盖）。
- 来源：review r1 / OQ-1 拍板 a 方案

### P1-5 [P1] 搜索多命中：非 active 命中正文不在 DOM → 无高亮、计数与可见高亮不一致
- 维度：A / G
- 文件：packages/ui/src/ModelTrajectoryPane.tsx:361-366（reveal 上下文单键）；ModelTrajectoryExpansion.ts:77-83（useTrajectorySearchRevealed 单键比对）
- 问题：默认收起后仅 active 命中被强制展开，其余命中行收起 → content 搜索字段不在 DOM → 无高亮；搜索计数来自索引不受影响 → "命中 N 处只见 1 处高亮"。
- 改法（OQ-3 拍板：全部命中同时展开高亮）：reveal 上下文从单 activeKey 扩展为**命中 key 集合**（`TrajectorySearchRevealContext: string` → `ReadonlySet<string>`，回合级同理）；`useTrajectorySearchRevealed` 改集合判定（`set.has(key)`），消息键与回合键两命名空间保持不重叠。active 命中的视觉强调（高亮底色差异）沿用现有 activeKey 通道不变。
- 验收：搜索命中 ≥2 处时全部命中行展开且高亮；next/prev 时 active 强调跟随移动。
- 来源：review r1 / OQ-3 拍板 a 方案

### P2-1 [P2] 注释漂移：CallInput 仍写「6 行封顶」
- 维度：F / C
- 文件：packages/ui/src/ModelTrajectoryCallInput.tsx:232-234
- 问题：注释仍描述 6lh clamp，实现已改 1lh。
- 改法：改为「单行截断（max-h-[1lh]）+ 搜索命中解除 clamp」。
- 验收：注释与 ClampedPreview 实现一致。
- 来源：review r1

### P2-2 [P2] useTrajectoryExpansion 默认 defaultOpen=true 成反向陷阱
- 维度：C
- 文件：packages/ui/src/ModelTrajectoryExpansion.ts:97,102
- 问题：三个调用点已显式传 false，默认值 true 意味着新增调用点漏传即回到默认展开，与新默认相反。
- 改法：`defaultOpen = false`；同步修正 ：102 注释（「默认收起，与面板整体默认折叠一致」）。
- 验收：typecheck 绿；TurnGroup 显式传 false 行为不变。
- 来源：review r1

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
- 改法：抽 `shouldRetryAfterResult({ recordCount, errorMessage, retryCount, limit })` 纯函数（覆盖 P1-2/P2-3 判定矩阵：error 重试 / empty 重试 / 预算耗尽落终态 / 成功归零），测试登记进根 package.json `test:v4-perf` 聚合（参照 ModelTrajectoryClamp.ts + 既有测试登记形态）。
- 验收：测试用例 ≥6 通过并进聚合。
- 来源：review r1

## Spec deviations

- none。`docs/iterations/trace-nm-borrow/spec.md:101`（非 turn 命令初始 open=true）与 `:189`（N-2 默认展开）已被本批用户拍板显式推翻——按 K 节加失效标注，不属 deviation。

## Open questions / 待拍板

- OQ-2（已由设计吸收）：空白形态 error vs empty → 按 P1-2/P2-3 双路径覆盖，无需真机预确认。
- OQ-1/OQ-3 已拍板（P1-4 a / P1-5 a）。

## 已豁免（用户确认不修）

- 无。

## 合并后 QA（manual_user）

1. 换模型后轨迹面板自动恢复（不手动点刷新）。
2. 轨迹默认全折叠：回合收起；点开回合=单行行列表（消息行单行预览、配对卡单行头部）；点行/卡展开。
3. 助手思考/长内容单行截断；「查看全文」与全屏可用。
4. 「全部展开/收起」展开所有内容（非仅回合壳）。
5. 搜索多命中：全部命中行展开且高亮；计数与可见高亮一致。
6. 真机 manual T-N4 既有清单（v1.0.18 挂账）同步执行。

## K 节建议（下游执行时闭合）

1. CHANGELOG v1.0.19：三条用户可见变化 + 显式行为变更标注（消息行/配对卡此前默认展开）。
2. `docs/iterations/trace-nm-borrow/spec.md:101/:189` 加失效标注（「v1.0.19 起默认收起，用户拍板」）。
3. 门禁：根 typecheck、lint、fmt:check、test:v4-perf（455+新增全绿）、architecture:check --changed。
4. DOM 级 e2e 不新增（本批 DOM 态靠 manual 清单 1-5 覆盖，登记留痕）。

## Fix-Spec Closure

| 项 | 状态 |
| fix-spec-ready | yes |
| fix_spec_path | docs/iterations/trace-3fix-v119/cr-fix-spec.md |
| dag_version / review_round | 1 / 1（diff 单轮模式） |
| P0 / P1 / P2（已写入） | 0 / 5 / 4 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none |
| C-orch | ✅（P1-1 死通道收敛） |
| C 类合并后 QA | manual 1-6 |
