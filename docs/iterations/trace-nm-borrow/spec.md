---
date: 2026-10-21
---

# trace-nm-borrow 技术规格（SPEC）

> 需求来源：用户口述（2026-10-21 对话拍板）。v1.0.17 发布后用户对轨迹面板观感不满，初判回滚后改拍板**保留现有回合 UI、定向借鉴 novel-master（nm）「查看提示词」的展示层优点**。总原则（用户原话）：「omz 有自己的特点，完全改 UI 成本高还容易出 bug，但是借鉴 nm 的实现完全是可以的」。
>
> nm 侧完整设计取证见探索报告（三层递进：轮摘要卡 → 卡片流 → 全屏原文）；本 spec 只做**四点定向移植**，全部落在 packages/ui 展示层与 UI 纯函数区，**services / head 落盘 / 投影 / turnId 分组数据层零改动**。r1（2 P0 + 8 P1 + 6 P2）、r2（1 P0 + 6 P1 + 10 P2）审查已全量闭合于本版。

## 设计目标

1. **① 工具组卡**：CallCard 的每个工具调用行从「孤立调用行」升级为「调用+结果配对卡」——use/result 两格 + 状态点（ok/error/pending/missing），结果不再错位显示在下一条调用的 Input 区。
2. **② 长文本 clamp**：展开内容从 `max-h-64`（≈13 行）收紧到 6 行（`max-h-[6lh]`，仓库既有范式）；assistant 扁平输入行（路径 B，当前无 clamp 无复制）补 clamp + 「查看全文」入口。
3. **③ 全屏只读 Modal**：新增消息原文全屏层（Esc/遮罩关闭、等宽 pre-wrap、复制），承接 clamp 后的「看全文」终点。
4. **④ 回合头摘要分层**：回合头从单行改两行——行 1 序号+预览、行 2 计数行，失败数与红色图标同源。

不做的（明确排除）：nm 的明度节奏/左 3px 主色条视觉体系、Tab 入口、面板级展开态重构（omz 的 override/version 体系刚修稳不动）、lost 计数进回合头（尾部 pending 语义不稳，只做工具卡 pending 态展示）、tool-name/tool-id 搜索 target 的删除（保留现状索引行为）。

## 总体方案

### ① 工具配对卡（跨记录 join 是硬前提）

探索实锤：工具结果不在当前 record 的 `response` 里（`response.toolResults` 被 services 映射完全丢弃，`modelTrajectory.ts:173-184`），而在**下一条 record 的 `request.messages`**。join 只能做在 UI 纯函数区：

**join 数据形态**：UI 收到的 `ZCodeModelTrajectoryMessage` 只有 `{role, parts}`；id 与错误语义在 part 上。join 扫**全部 records 的 `request.messages`**（完整消息，非 delta 投影——delta 在 messageCount 相等时返回 `[]` 会假丢失）的 `parts` 中 `kind === "tool-result" && part.toolCallId` 非空的条目，建 `Map<string, {message, part}>`（按 **part** 建，一条消息多个 result part 各自成条目，文本互不串联；`toolCallId` 缺失**不入 map**，杜绝 `undefined` 误配对）。

**status 判定**（对每个 `response.toolCalls[i]` 配对）：

```
error   配对 part 的 output 含错误文本（判定 = 既有 trajectoryToolPayloadErrorText(part.output) !== undefined，
        复用 ToolPayload.ts:56-58 既有导出 helper，不新增；trajectoryToolHasError 改为内部复用它——
        其对 tool-call input 的检查分支保留原语义（显示侧红标），status 判定只看 output，两者职责分开）
ok      配对到且无错误
pending 未配对 且 该 call 所属 record 是 records 数组的最后一条 record
missing 未配对 且 非尾部（含被放弃 attempt 的 calls；含 kind:"unknown" 无 id 条目——无 id 不可配对，
        按尾部/非尾部判 pending/missing；UI 文案「未返回结果」非「丢失」）
```

已知限制（services 零改动的代价，写入实现注）：legacy array-content 分支的 tool-result part 不携带 isError（`mapPart` 数组分支不套用消息顶层 isError），此类形态永远判 ok 而非 error；实测 1364 条 tool 消息全部为 string content，该形态未出现过。

**新纯模块 `ModelTrajectoryToolJoin.ts`**（Turns.ts 已近 max-lines 上限，新文件承载；零 React、零 `@/` 别名，可被 `tsx --test` 直测）。**key 单源裁定（r2 P1-2，方案①）**：`trajectoryCallKey` / `trajectoryInputRowKey` 连同新增 `trajectoryToolCallTargetKey` 一并**迁入 ToolJoin.ts**，Turns.ts re-export（全部既有引用点不变，ToolJoin 成为 key 家族唯一来源；Turns 对 ToolJoin 是单向值导入，无环）：

```ts
export interface TrajectoryToolCallInfo {
  part: ZCodeModelTrajectoryContentPart;   // 原 response.toolCalls[i]，原样引用
  status: "ok" | "error" | "pending" | "missing";
  pairedResultText: string;                // trajectoryToolOutputs 同源口径；未配对为 ""
  pairedResultToolName?: string;           // 配对 result part 的真实工具名（r1 CR D-1 补登记；徽标单源用）
  pairedResultToolId?: string;             // 配对 result part 的真实 call id（同上）
}
export interface TrajectoryToolJoinResult {
  /** 每条 call（key = trajectoryCallKey(requestId, recordIndex)）的配对信息。
   *  关键约束：数组与 record.response.toolCalls 严格同长度同顺序（含 kind:"unknown"
   *  的 malformed 条目），kind 过滤只用于计数，绝不缩数组——否则渲染与搜索 key 漂移。 */
  callToolCalls: Map<string, TrajectoryToolCallInfo[]>;
  /** 先全局建立 callId→result 索引；对每条 record，取该 record 的 request.messages 中
   *  toolCallId ∈ 全局已配对 id 集合 的 result id（r2 P1-4 消歧：是"本 record 的消息里
   *  被**任何 call**（通常在前一条 record）配对掉的 result"，绝非"本 record 的 calls
   *  配到的 result"——后者恒空）。 */
  pairedResultToolCallIds: Map<string, Set<string>>;  // key = trajectoryCallKey
}
export function joinTrajectoryToolResults(
  records: readonly ZCodeModelTrajectoryRecord[],
): TrajectoryToolJoinResult;
/** 剔除谓词（r3 P2-10 形式化）：仅当该行的 tool-result part 全部有 toolCallId 且全部 ∈ pairedIds
 *  时整行剔除；无 id / 行内含 text part / 存在未配对 result part 一律保留。 */
export function filterTrajectoryInputRows(
  rows: TrajectoryWireRow<ZCodeModelTrajectoryMessage>[],  // 泛型实参显式（r2 P2-1）
  pairedIds: ReadonlySet<string>,
): { visibleRows: TrajectoryWireRow<ZCodeModelTrajectoryMessage>[]; pairedRemovedCount: number };
/** 索引/DOM/复制三方共用的拼接文本（r3 P2-2）。 */
export function trajectoryToolCallDisplayText(info: TrajectoryToolCallInfo): string;```

**跨调用数据面**：`resolveTrajectoryTurnGroups` 接线 join 结果——每条 `TrajectoryTurnCall` 新增 `toolCalls: TrajectoryToolCallInfo[]`（下标对齐）与 `pairedResultToolCallIdsInInput: Set<string>`（该 record 的 `request.messages` 中已被全局配对消费的 result id，见上方消歧）。渲染与搜索的剔除**共用 `filterTrajectoryInputRows`**。**prop 透传链（r3 P2-7）**：`TurnGroup → CallCard → ResponseBlock → ToolPairCard` 传 `toolCalls: TrajectoryToolCallInfo[]`；`TurnGroup → CallCard → CallInputSection` 传 `pairedResultToolCallIdsInInput`。

**边界（防回归）**：剔除只发生在分类/渲染/索引产物上，**绝不修改 `inputMessages` 本身**——`resolveTrajectoryInputMessages` 的产出、e2e 的 `visible` 断言与奇偶底色基准不受影响；`CallCard` 的 `hasInput` **仍按 `inputMessages.length > 0` 判定，不按过滤后行数**（r3 P2-4，不引入新谓词；过滤发生在 section 内部的行级渲染）；配对剔除**不计入 placeholderHidden 计数**（tool 行永非 placeholder，hiddenCount 语义不变）；**占位行不参与 Input 区显示判定**——仅占位行的 record 仍渲染 section 与 WireFilterRow「已隐藏 N 条」开关，恢复入口不丢；剔除后该 record 无可见输入行时消息列表为空但 section 与开关保留。

**孤立结果**（有 result 无 call，窗口边界实测存在）→ 不剔除，保留 Input 区原行、原 key，照旧索引。**混合 part 消息**（一条 tool 消息同时含已配对与未配对 result part）→ 整行保留不剔除（实现注：实测 1364/1364 单 part，混合形态按保守处理不丢内容）。

### ② 搜索索引协同（本迭代最大风险面，B-2 同型坑）

**搜索侧数据面（r2 P0-1）**：`TrajectorySearchTimelineItem` 新增 `toolCalls: TrajectoryToolCallInfo[]` 字段（与 `record.response.toolCalls` 下标对齐），由 `resolveTrajectorySearchItems` 从 `call.toolCalls` 复制。`buildSearchTargets` 的 tool-call content target 文本拼接口径**写死**：

```
content 文本 = trajectoryToolCallDisplayText(info)   // 新增纯函数于 ToolJoin.ts：
  = trajectoryToolCallInputs(message).join("\n\n")
    + (pairedResultText 非空 ? "\n\n" + pairedResultText : "")   // 空则不拼、无尾分隔
```

`trajectoryToolCallDisplayText` 是索引拼接、配对卡 DOM 字段、复制按钮**三方共用的单一实现**（r3 P2-2：复制文本不再无条件加分隔符）。与配对卡 DOM 字段文本（契约 7）逐字同源。`resolveTrajectorySearchItems` 的 `inputRows` 先过 `filterTrajectoryInputRows`（与渲染同源），已配对 result 行从索引剔除；孤立 result 行照旧走 input row key。

- target key：新增 `trajectoryToolCallTargetKey` helper（ToolJoin.ts，key 家族单源），`ModelTrajectoryPaneParts.tsx` 与 `ModelTrajectorySearch.ts` 现有两段手拼模板**均改用该 helper**（逐字同值；r2 P2-3 修正：现状本无共享 helper，本迭代补齐）。
- 既有 B-2 用例（占位过滤）**不需要改动**（其 fixture 无 tool 行）；T-N2 为新增独立断言。tool-name/tool-id 两类 target **保留现状不删**（改索引即改搜索行为，明确不做）。

**配对卡 DOM / 搜索 / 展开契约（N-2 实现必须逐条满足）**：

1. target key 逐字 = `trajectoryToolCallTargetKey(...)`（渲染 DOM 与搜索索引共用，单源）。
2. 卡根必须是 Radix `Collapsible`（高亮判定读 `data-state`，`ModelTrajectorySearchHighlight.ts:84-99`）；展开内容外层包 `data-trajectory-message-expanded` 包装层。
3. 卡内必须保留 `data-trajectory-search-field="tool-name"` 与 `"tool-id"` 元素（徽标文本单源 = `trajectoryToolCallBadgeText(info)`（ToolJoin 导出，result 侧真名优先、`||` 空串回退 call 侧），与索引同源——r2 P1-3 + r1 CR D-6 措辞统一，取代早期「取自 trajectoryToolMetadata」的表述；否则搜工具名计数前进画面不动）；use 格与 result 格各挂 `data-trajectory-search-field="content"`，**use 在 result 之前**（与索引拼接顺序一致；unknown 回退 raw `<pre>` 同样挂 content 字段——r1 CR 修复批补齐，否则索引命中 DOM 无高亮位）。
4. 展开状态走 `useTrajectoryExpansion({ key, commandKind: "tool-call" })`——**不新增 `TRAJECTORY_EXPANSION_KINDS` 条目**，沿用 `"tool-call"` 命令槽与视觉角色（新增 kind 会联动 `ModelTrajectoryRoleStyles.ts`、`ModelTrajectoryExpansionMenu.tsx:48`，本迭代明确不做）；命令默认展开语义不变（非 turn 命令初始 open=true）。
5. 搜索 reveal 链复用：命中 result 文本 → 该卡 key 被强制展开（现有 searchRevealed 机制）。
6. 上述 DOM 断言列入 manual 清单（T-N4，无 DOM 测试基建）。
7. **两格内容**（r2 P1-1）：use 格 = `trajectoryToolCallInputs(message)` 以 `<pre>` 等宽渲染、result 格 = `pairedResultText` 同款；两格各自 `max-h-[6lh]` clamp，`searchRevealed` 时跳过 clamp；missing 时 result 格渲染 `modelTrajectory.toolResultMissing` 灰化占位、pending 时渲染 `modelTrajectory.toolResultPending` 灰化占位（尾部在途常态，r3 P2-3），两者均不参与索引；`kind:"unknown"` 条目**回退渲染**：raw `<pre>` 原文、无状态点、复制走 displayText（r3 P2-5）。
8. **卡级交互**：复制按钮保留（复制文本 = `trajectoryToolCallDisplayText(info)`，与索引口径逐字一致）；全屏入口（打开 Modal，见③；**Step 3 渲染 disabled、Step 5 接线**，同路径 A/B 范式）；状态点 aria-label 用 `modelTrajectory.toolStatus.{ok,error,pending,missing}`（unknown 无状态点）；卡头徽标文本（tool-name/tool-id 字段）**优先取配对 result part 的 toolName/toolId，回退 call part**（call 侧映射有 `?? "tool"` 兜底，结果侧才是真实名——r3 P2-11）。
9. **门禁口径**：Step 3 的 auto 门禁（T-N2）只锁索引层；内容层视觉/交互验收归 T-N4 manual（`qa` 标注与此对齐；T-N4 覆盖契约 1–8）。

### ③ clamp 与 Modal

- 路径 A（折叠行）：`ModelTrajectoryExpandedContent.tsx` 的 `max-h-64` → `max-h-[6lh]`（先例：`ElicitationDialog.tsx:863` 等 `max-h-[5lh]`）。
- **全屏入口可见性（r2 P1-6，与胶囊分离）**：入口条件用持久态 `overflowEver`（首次 `isOverflowing` 测得 true 后置位、永不回退），不受 `searchRevealed` 展开后 `isOverflowing` 回落影响；溢出胶囊维持现状条件 `isOverflowing && !searchRevealed`。图标用 `ExpandIcon` + aria-label=`modelTrajectory.viewFullContent`（胶囊已占 `Maximize2Icon` 表「展开」，避免同形相邻——r2 P2-5）。**Step 4 只渲染入口按钮（disabled），接线（打开 Modal）归 Step 5**（r2 P2-6 顺序修正）。
- 路径 B（assistant 扁平行）：`ModelTrajectoryCallInput.tsx` 的 **MessageBlock 扁平分支**（覆盖所有非 system/user/tool 角色及 tool 空 parts，r3 P2-15）包新组件 `TrajectoryClampedPreview`（`max-h-[6lh]` + 溢出检测 + 底部「查看全文」入口，**按钮渲染归 Step 4、接线归 Step 5**；不做行内展开）。**搜索命中跳过 clamp**：ClampedPreview 读该行 expansionKey 的 searchRevealed 上下文，命中时跳过 clamp（与路径 A 同范式），否则高亮落在被裁区域。
- 溢出判定纯逻辑抽到新纯模块 `ModelTrajectoryClamp.ts`（`isClampOverflow({scrollHeight, clientHeight, tolerance})` 等，零 React 可直测）；hook 部分留组件文件。
- Modal：新文件 `ModelTrajectoryMessageDialog.tsx`，底座 `components/ui/dialog.tsx`（Radix，Portal 默认 body、Esc/遮罩/焦点圈定开箱即用——Esc 与聊天页停止生成的冲突由 `shouldIgnoreEscapeForStopGeneration` 的 path 判定天然免疫，**不新增任何 window Esc 监听**）。sr-only 标题 + `aria-describedby={undefined}`（先例 `image-preview-dialog.tsx:396`）。
- **循环导入规避**：新中性模块 `ModelTrajectoryMessageView.ts`（零 JSX 的 .ts）承载——`TrajectoryMessageViewRequest` 描述类型、`TrajectoryMessageViewContext`（createContext）、`messageClipboardText`（**从 ExpandableMessage 迁移至此**，其依赖仅 ToolPayload，纯函数可迁；旧处改 re-export 或直接改引用点）。Dialog 组件只接 props 不回流；Pane 提供 context 值。
- **Pane max-lines 防触线（r3 P2-13）**：Provider + Dialog 挂载收进独立 host 组件 `ModelTrajectoryMessageViewHost.tsx`（新文件，内聚 context Provider + viewingMessage state + Dialog 渲染），Pane 只挂一行 `<ModelTrajectoryMessageViewHost>`（Pane 现实测 376/400 行，直接加会触 max-lines 400）。

### ④ 回合头两行 + TrajectoryTurnCounts

- 新纯模块 `ModelTrajectoryTurnCounts.ts`（Turns.ts 不加行，避 max-lines；零 React）：

```ts
export interface TrajectoryTurnCounts {
  toolCallCount: number;    // Σ toolCalls 中 kind==="tool-call" 的条数（计数过滤，不动数组）
  charCount: number;        // 输出侧：Σ (response.text?.length ?? 0) + (reasoningText?.length ?? 0)
                            //        + 全部 use 段一次 join("\n\n") 后的长度（分隔符计入，见实现注 11；
                            //        只覆盖 use 段不含结果正文——与 OQ1 口径一致）
  failureCount: number;     // modelErrorCount + toolErrorCount
  modelErrorCount: number;  // record.error 真值条数
  toolErrorCount: number;   // 配对 status === "error" 条数（按 callId 天然去重、归属发起回合）
}
export function resolveTrajectoryTurnCounts(group: TrajectoryTurnGroup): TrajectoryTurnCounts;
// 段序列（T-N6 逐字锁定数组形态）：
// [ {id:"modelTrajectory.summaryCalls", values:{count}},
//   {id:"modelTrajectory.turn.toolCalls", values:{count}}?,        // toolCallCount=0 省略
//   {id:"modelTrajectory.turn.charCount", values:{count}},
//   {id:"modelTrajectory.turn.failureCount", values:{count}}?,     // =0 省略且整段红色
//   duration: string（formatTrajectoryDuration 原样产出，非 i18n 段）?,   // durationMs=0 省略
//   ...sourceKinds.map(kind => ({id: `modelTrajectory.source.${kind}`})), // 每来源一段（r2 P2-4）
// ] 分隔符 · 由组件层插入
export function formatTurnCounts(
  stats: TrajectoryTurnStats, counts: TrajectoryTurnCounts,
): Array<{ id: string; values?: Record<string, string | number> } | string>;
```

- **口径统一**：counts 全字段基于 **primaryCalls**（排除 sidecar；全 sidecar 时回退全部，与预览口径一致）。`resolveTrajectoryTurns` 所在的 primaryCalls 派生逻辑**导出为共享函数 `resolveTrajectoryPrimaryCalls(group)`**（Turns.ts 导出，TurnCounts 复用，不双写——r3 P2-8）；`summaryCalls` 段的 count 取 `stats.callCount`（含 sidecar，与现状面板头一致，注明）。行为变化写明：图标判定从 `stats.errorCount`（含 sidecar）改为 `counts.failureCount > 0`（不含 sidecar）——sidecar（标题生成等辅助调用）失败不再点亮回合错误图标；`stats` 本身不动，行 2 的「N 次调用/时长/来源」仍取 stats。
- charCount 细节：`length` 不 trim；undefined → 0；reasoningText 计入且**随 reasoning 开关投影变化**（关闭思考过程后字数相应减小——所见即所得，接受为设计行为，实现注写明）。
- 头部结构：行 1 = 序号+回合+userPreview+assistantPreview（现状不动）；行 2 = `data-trajectory-turn-meta` 计数行（col-span-full 嵌在现有 CollapsibleTrigger 内改两行容器，**保持一个回合一个 Collapsible 一个 key**）；红色图标判定 `counts.failureCount > 0`（图标与数字同源）。
- `estimateSize: 44 → 64`（两行表头，`ModelTrajectoryTimeline.tsx:35`）。

## 最终项目结构

```
packages/ui/src/
  ModelTrajectoryToolJoin.ts          # 新：join 纯模块 + key 家族单源（trajectoryCallKey/InputRowKey/ToolCallTargetKey 迁入/新增）+ filterTrajectoryInputRows
  ModelTrajectoryTurnCounts.ts        # 新：counts + formatTurnCounts 纯模块
  ModelTrajectoryClamp.ts             # 新：溢出判定纯逻辑
  ModelTrajectoryMessageView.ts       # 新：view context + messageClipboardText（迁入）
  ModelTrajectoryMessageViewHost.tsx  # 新：context Provider + viewingMessage state + Dialog 挂载（Pane 只挂一行，防 Pane max-lines 触线）
  ModelTrajectoryToolPairCard.tsx     # 新：配对卡（契约 1–8）
  ModelTrajectoryClampedPreview.tsx   # 新：路径 B clamp+查看全文（含溢出 hook）
  ModelTrajectoryMessageDialog.tsx    # 新：全屏只读 Modal
  ModelTrajectoryTurns.ts             # +接线 join（toolCalls/pairedResultToolCallIdsInInput 进 TrajectoryTurnCall）；key helpers 改 re-export 自 ToolJoin
  ModelTrajectoryToolPayload.ts       # trajectoryToolHasError 改为复用既有 trajectoryToolPayloadErrorText（input 分支语义保留）
  ModelTrajectoryPaneParts.tsx        # toolCall 行 → 引用 ToolPairCard；手拼 key 改 ToolCallTargetKey
  ModelTrajectoryCallInput.tsx        # 剔除已配对行（filterTrajectoryInputRows）；assistant 扁平行 clamp
  ModelTrajectoryExpandedContent.tsx  # max-h-[6lh] + overflowEver 全屏入口（ExpandIcon）
  ModelTrajectoryExpandableMessage.tsx# messageClipboardText 迁出；引用点改 MessageView
  ModelTrajectoryPane.tsx             # 挂 ViewHost 一行（context/Dialog 不直接进 Pane）
  ModelTrajectoryTurnGroup.tsx        # 头部两行 + formatTurnCounts 渲染 + 图标口径 + CallCard props 透传（pairedResultToolCallIdsInInput）
  ModelTrajectorySearch.ts            # TrajectorySearchTimelineItem.toolCalls 新字段 + content target 拼接口径 + 手拼 key 改 helper
  ModelTrajectoryTimeline.tsx         # estimateSize 64
  i18n/locales/{zh-CN,en-US}.ts       # 新键（全带 modelTrajectory. 前缀，两侧同步）
packages/ui/test/
  modelTrajectoryToolJoin.test.ts     # 新（T-N1）
  modelTrajectoryTurnCounts.test.ts   # 新（T-N5/T-N6）
  modelTrajectoryTurns.test.ts        # fixture 扩展（record() 支持 toolCalls / tool result 消息）+ T-N2
  modelTrajectoryClamp.test.ts        # 新（T-N3）
package.json                          # test:v4-perf 登记 3 个新测试文件
```

services / adapters / shared / bootstrap：**零改动**。`TRAJECTORY_EXPANSION_KINDS` / RoleStyles / ExpansionMenu：**零改动**（配对卡沿用 tool-call 槽）。

## 变更点清单

| # | 变更 | 文件 | 风险 |
|---|---|---|---|
| N-1 | callId→result join 纯模块 + status + key 家族单源迁移 + filterTrajectoryInputRows | ToolJoin 新文件、Turns（re-export）、ToolPayload | 中（裁剪/重试边界） |
| N-2 | 工具配对卡（契约 1–8：key 单源/搜索字段含 tool-name、tool-id/两格 6lh/复制/全屏入口/missing 占位/默认展开） | ToolPairCard 新文件、PaneParts、TurnGroup（props 透传） | **高**（B-2 同型） |
| N-3 | Input 区已配对行剔除（渲染+索引共用纯函数，不动 inputMessages，hasInput 判定不变，占位开关保留） | CallInput、Turns(searchItems)、PaneParts（ResponseBlock 剔配对） | **高**（B-2 同型） |
| N-4 | 搜索侧数据面：TimelineItem.toolCalls 字段 + content target 拼接口径（displayText 单源）+ key helper 接入 | Search.ts、Turns | 中 |
| N-5 | clamp：路径 A 6lh + overflowEver 全屏入口（ExpandIcon）；路径 B ClampedPreview（命中跳过 clamp） | ExpandedContent、ClampedPreview/Clamp 新文件、CallInput | 低 |
| N-6 | 全屏 Modal（MessageView 中性模块+ViewHost+Radix Dialog+复制）+ **三入口**接线（路径 A/B/配对卡） | MessageView/ViewHost/MessageDialog 新文件、Pane | 中（Collapsible×Dialog 首例组合） |
| N-7 | counts+formatTurnCounts 纯模块 + 回合头两行 + 图标口径 + estimateSize 64 | TurnCounts 新文件、TurnGroup、Timeline | 中（虚拟化估算/图标行为） |
| N-8 | i18n 新键（全带前缀）：`modelTrajectory.toolStatus.{ok,error,missing,pending}`、`modelTrajectory.turn.{toolCalls,charCount,failureCount}`、`modelTrajectory.viewFullContent`、`modelTrajectory.fullContentTitle`、`modelTrajectory.toolResultMissing`、`modelTrajectory.toolResultPending`；复用死键 `modelTrajectory.copyContent` 为 Modal 复制文案 | zh-CN/en-US | 低 |
| N-9 | messageClipboardText 迁移至 MessageView.ts（纯模块），引用点改向 | MessageView 新文件、ExpandableMessage | 低 |
| N-10 | test:v4-perf 登记 3 个新测试文件 | package.json | 低 |

## 详细实现步骤

- Step 1 — phase-tool-join — blocking: yes — qa: auto：N-1 join 纯模块 + key 家族迁移（Turns re-export，引用点零改）+ Turns 接线（下标对齐、pairedResultToolCallIdsInInput 全局索引消歧）+ ToolPayload 复用改造 + fixture 扩展 + T-N1。边界锁定：pending 仅限最后一条 record 的 calls；被放弃 attempt 未配对=missing；孤立 result 不入 map；混合 part 消息整行保留；delta 空数组不参与；legacy array-content 不判 error（实现注）。
- Step 2 — phase-turn-counts — blocking: yes — qa: auto：N-7 前半 TurnCounts 纯模块（primaryCalls 口径全字段）+ T-N5（含 sidecar 排除与全 sidecar 回退、kind 过滤计数不动数组、charCount 同源口径）+ T-N6（段序列数组形态逐字锁定，含 duration string 段与每来源一段）。
- Step 3 — phase-tool-card — blocking: yes — qa: auto（仅索引层，见契约 9）：N-2 配对卡（契约 1–8，含**全屏入口按钮 disabled**——接线归 Step 5，同 Step 4 范式，r3 P2-1）+ N-3 渲染/索引双剔（共用 filterTrajectoryInputRows；hasInput 判定不变）+ N-4 搜索侧数据面与拼接口径 + N-8 i18n + T-N2（断言：result 词命中 key 集合**恰为** `[trajectoryToolCallTargetKey]`（不含任何 input row key）；孤立 result 词仍命中 input row key；hiddenCount 经 classifyTrajectoryWireRows 断言不变；fixture 显式构造 call 在 record N、result 在 record N+1，并断言 record N+1 的 pairedResultToolCallIdsInInput 含该结果 id（跨记录消歧锁定，r3 P2-9）；B-2 用例不动）。
- Step 4 — phase-clamp — blocking: yes — qa: auto：N-5 Clamp 纯模块 + 路径 A 6lh + overflowEver 入口按钮（disabled，接线归 Step 5）+ ClampedPreview 骨架（按钮 disabled 同）+ T-N3（溢出阈值判定）。
- Step 5 — phase-fullscreen — blocking: yes — qa: manual_user：N-6 + N-9 MessageView/ViewHost/MessageDialog + **三入口接线**（路径 A/B/配对卡，r3 P2-1）；真机验收（T-N4 项：配对卡契约 1–8、Esc/遮罩/复制、切 tab 行为）。
- Step 6 — phase-turn-header — blocking: yes — qa: auto：N-7 后半回合头两行 + 图标口径（counts.failureCount，sidecar 行为实现注）+ estimateSize 64。
- Step 7 — phase-verify — blocking: yes — qa: auto：N-10 登记 + 根 typecheck + lint + test:v4-perf + `node scripts/check-i18n-parity.mjs` 全绿。
- Step 8 — phase-e2e-manual — blocking: no — qa: manual_user：e2e 脚本扩展 join 层数据断言（真实库 fixture：115 条 isError 样本特征）；真机 manual 清单（见测试策略）。

## 测试策略

### 测试用例

- T-N1 — blocking: yes — join：配对成功/四态判定（error 经既有 errorText、ok、pending 仅尾部、missing 含放弃 attempt 与 unknown 无 id）/孤立 result 保留/混合 part 消息整行保留/croppedCount 边界/delta 空数组不误判/多 result part 不串文本/id 缺失不入 map/key 家族单源（trajectoryCallKey 迁移后逐字同值）/displayText 拼接（空结果不拼分隔）。fixture：T-N1 自带最小构造（toolCalls 非空即创建 response，r3 P2-14；Turns 测试 fixture 扩展仅服务 T-N2）。
- T-N2 — blocking: yes — 搜索协同：result 词→tool-call key（trajectoryToolCallTargetKey 逐字）；孤立→input row key；hiddenCount 不变；配对行不出现在 visibleRows；fixture 构造 call 在 record N、result 在 record N+1（Step 3）。
- T-N3 — blocking: yes — 溢出判定纯逻辑（tolerance 边界；**默认容差 2px，判定为 `overflowPx > 2`**——r1 CR P2-6 数值锚点，防止 1↔2 静默回归）（Step 4）。
- T-N5 — blocking: yes — counts：toolCallCount 求和（kind 过滤计数）含 response undefined 调用/charCount 输出侧公式（不 trim、undefined→0、use 段 join 同源分隔符、reasoning 随投影变化）/failureCount 拆分合计/sidecar 排除与全 sidecar 回退（Step 2）。
- T-N6 — blocking: yes — formatTurnCounts 段序列数组形态（summaryCalls/toolCalls?/charCount/failureCount?/duration string 段?/每来源一段；省略规则）（Step 2）。
- T-N4 — blocking: no — manual_user：配对卡契约 1–8 DOM 断言（含 tool-name/tool-id 字段可搜可高亮、两格 6lh、pending/missing 占位、复制文本、卡片全屏入口、状态点 aria、unknown 回退——r3 P2-1）+ Modal Esc/遮罩/复制/切 tab + 6 行 clamp 视觉 + 搜索命中配对卡自动展开定位 + overflowEver 入口在 searchRevealed 时保持可见 + 窄侧栏（<lg）布局 + **窄侧栏下回合失败标识仍可见**（D-P1-1 防裁回归）+ 回合头两行对齐与 chevron（Step 5/8 真机清单）。

### 既有契约回归

T-T3 stats deepEqual 不动（counts 独立模块）；T-T9 增量三分支不动（join 只用完整 messages）；B-2 占位过滤用例**不动**；e2e 37+53 断言不回归（inputMessages 不动、只增数据不删字段）。

## 风险与回滚方案

| 风险 | 缓解 | 回滚 |
|---|---|---|
| N-3 搜索坐标错位（B-2 同型） | target key 不变方案 + 契约 1–8 + T-N2 锁定 + T-N4 manual | Step 3 单独 revert，配对卡回退纯展示（不剔行不并文本） |
| join 误判（重试/裁剪） | 只用完整 messages；pending 仅尾部；文案「未返回结果」 | status 只影响展示不删数据 |
| key 家族迁移引入行为漂移 | 迁移即逐字同值（T-N1 断言），引用点零改 | re-export 反转即回 |
| Collapsible×Dialog 首例组合 | Dialog 默认 Portal body 隔离；T-N4 manual 项 | Step 5 revert 即回到行内展开 |
| 头部两行虚拟化跳动 | estimateSize 同步 64；measureElement 兜底 | Step 6 revert |
| Pane max-lines 触线（实测 376/400） | Provider+Dialog 收 ViewHost 独立组件，Pane 只挂一行 | ViewHost 内聚，可整体外移 |
| 字数口径争议 | OQ1 留档，口径集中在 TurnCounts 单点 | 改口径单点改 |
| 循环导入 | MessageView 中性模块单向依赖；key 家族单源在 ToolJoin（最底层） | — |

## 实现注（已知限制）

1. legacy array-content tool-result 不判 error（services 零改动代价；实测未出现该形态）。
2. 图标口径变化（两条，均需进 CHANGELOG）：sidecar error 不再点亮回合错误图标（counts 基于 primaryCalls）；**工具失败（配对 status==="error"）新增点亮图标与失败计数**（旧实现仅 record.error 亮）。
3. charCount 随 reasoning 开关投影变化（所见即所得）。
4. 被放弃 attempt 的未配对 calls 显示 missing（「未返回结果」）。
5. records 最后一条为 sidecar 时，其前主调用的尾部 pending 判 missing（sidecar 请求通常无 toolCalls 且主调用在前，实际影响极小）。
6. 混合 part（已配对+未配对 result 同消息）整行保留不剔（保守不丢内容；实测 1364/1364 单 part）。
7. `trajectoryToolHasError` 的 tool-call input 检查分支保留（显示侧红标）；status 判定只看 output。配对卡 use 格经 `trajectoryToolHasError({role:"assistant",parts:[info.part]})` 接同款红标（r1 CR B-P1-1 修复后两侧语义对齐）。
8. 跨分隔符查询（use 末词 + result 首词的组合）在索引命中但 DOM 无连续 Range，高亮回落 `ranges[0]`——**ranges 非空但该序号越界时会误高亮到第一处**（r1 CR B-P1-2 措辞补全：`ModelTrajectorySearch.ts:158-177` 空白折叠 + `SearchHighlight.ts:88-99` fieldMatchIndex 机制的固有限制，接受；ranges 为空时不误高亮）。
9. 配对结果行被剔除后其 input 侧 tool-name/tool-id 索引项随之消失；卡片徽标优先取 result part 的真实名（r3 P2-11），call 侧兜底名只在无结果时出现（badgeText 用 `||`：result 侧空串也回退；call 侧 `|| "tool"` 双兜底覆盖服务层 `??` 只兜 undefined 的缝隙——r1 CR A-P2-1）。
10. `trajectoryToolCallDisplayText` 空 use 段不拼前导分隔符（spec 早期公式的字面值会产出前导 `\n\n`；实现与 r3 P2-2「不无条件加分隔符」一致——r1 CR D-2 登记）。unknown 条目 displayText 并入 raw 原文（r1 CR A-P2-6 修复），复制/全屏不再空白。
11. charCount 的 use 段口径：同一 record 的全部 tool-call part 合并后**一次** `join("\n\n")` 取长（跨调用的分隔符 `2×(n-1)` 字符计入；spec 早期「逐 part join 再求和」表述作废——r1 CR D-3/D-P2-2 登记，已被单测锁定）。
12. 配对卡「查看全文」入口**恒渲染**（配对卡是主要内容区，恒有全屏入口是既定口径）；路径 A/B 的入口维持 `overflowEver` 门控——两条口径并存是有意设计（r1 CR B-P2-6 裁定）。
13. unknown（malformed）条目的展开命令槽沿用 `"tool-call"`（契约 4 不新增 kind 的副作用；旧行为按 visualRole 归 `assistant` 槽）——「全部展开/收起」对 unknown 行的作用对象变化，实测 unknown 罕见，接受（r1 CR B-P2-5 登记）。
14. `stats.errorCount` 已无生产消费者（图标口径迁至 `counts.failureCount`，不含 sidecar）；字段保留仅为 T-T3 deepEqual 契约与上迭代 e2e 脚本兼容（r1 CR A-P2-5/D-P2-1 登记，Turns.ts 字段注释同款说明）。
15. 失败段**渲染前置**（r1 CR D-P1-1 修复的副作用）：组件层把 failureCount 段提取为 truncate 容器前的 shrink-0 前缀（窄侧栏可见性优先），渲染序「失败 · 调用数 · …」与纯函数数组序「调用数 · … · 失败 · …」不同；T-N6 锁的是纯函数数组形态，不受影响。
16. clamp 内容变化的重测由 layout effect 承担（r1 CR P1-1 修复）：渲染期复位溢出态后，RO 观察的是被 6lh 钳住的盒子（外框高度不变、RO 不触发），`measuredText` 必须进 layout effect deps 重测，否则入口被永久抹掉。路径 A 外层留白 `pb-2` 无条件 + `pb-12` 溢出时（短内容也有底部留白——r1 CR P2-2）；Modal 宽屏下收窄至 max-w-3xl/48rem（窄视口不贴边——r1 CR P2-7/观察）。
17. `useTrajectoryMessageView` 的 Provider 是硬前置（缺 Host 直接 throw，fail-fast 优于静默失效——r1 CR C-P2-11 登记）；焦点归位 capture 排除 `document.body`（程序化打开时 activeElement 常在 body，归位到 body 会重置滚动——r1 CR P2-4）；归位实际由 Dialog 的 `useEffect([open])` 完成（context close 包装为将来程序化关闭保留——r1 CR P2-5）。
18. 徽标 result 侧空串档位（r1 CR P2-1）：badgeText 用 `||`，result 侧 toolName 为空串时回退 **call 侧名**——两者本就是同一工具调用的名字，语义无损且保住「搜工具名」可达；显示口径即 call 侧名。全屏入口判空用剪贴板口径文本（`messageClipboardText`），「剪贴板空白但可见非空」的极端组合入口会隐藏（概率极低，接受——r1 CR 观察）。路径 A 正文盒 `text-ui-sm` 为 6lh 行高口径连带（较旧字号 -2px，真机观感确认项）。

## 开放问题（不阻塞）

1. **OQ1 字数口径**：当前拍板输出侧（不含工具结果正文）；若要 nm 同款「含结果」口径，改 TurnCounts 单点。
2. **OQ2 Modal 跨 tab 存留**：forceMount+Portal 下切 tab/关侧栏 Modal 不自动关；v1 接受为已知行为，后续可接 Tabs active 信号关闭。
3. **OQ3 pending 态刷新**：面板手动刷新模型下尾部 pending 直到手动刷新才更新；与面板整体取数节奏一致，不单独解决。
4. **OQ4 重试 attempt 重复计数**：同 requestId 多 attempt 的 toolCalls 重复计入 toolCallCount/failureCount；与 stats.callCount 口径一致，留待后续统一。
