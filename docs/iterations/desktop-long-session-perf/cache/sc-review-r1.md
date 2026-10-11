---
round: r1
role: judge (readonly)
date: 2026-10-05
prd: docs/iterations/desktop-long-session-perf/prd.md
spec: docs/iterations/desktop-long-session-perf/spec.md
verdict: No-Go
counts: { P0: 10, P1: 16, P2: 9 }
---

# SPEC 检查报告 r1（judge / readonly）

结论前置：**No-Go**。10 条 P0 分布在全部四个工作面（度量基建 / 渲染热点 / 数据层 / turn 目录），
且 `blocking_steps` 全部包含这四个工作面 → 按现 SPEC 编码必然在 Step 3~7、10~11、13~18 返工。

去重口径：三个证据包的可疑点合并同类项后为 25 条（delta-apply 13 + turn-directory 14 + perf/render 19，去重后 25 条独立问题），judge 另补 5 条。定级时区分「行号/数字漂移但实质成立」→ 多降为 P1/P2；「方案与代码事实冲突 / 契约缺失 / 必打架的歧义」→ P0。

判为 P0 的每条均已由 judge 亲自回读代码核实（标注 ✔ 已核实）。

---

## 一、P0（10 条，must-fix）

### P0-1 dev 实例启动路径不存在 —— Step 3/4（blocking）无法执行
- **问题**：SPEC A（spec.md:33）要求 CDP 脚本 `spawn .vscode/start-electron.mjs` 并传 `--open-workspace <path>`。该脚本不接受也不透传任何位置参数，`--inspect-brk=9231` 还会在没有调试器时挂起首行。
- **证据**（✔ 已核实）：`omz/.vscode/start-electron.mjs:7`（只解析 `--host-inspect`）、`:29` `spawn(electronExecutable, ["--inspect-brk=9231", "."], …)` 参数硬编码、`:36` `ELECTRON_RENDERER_URL` 硬编码 `http://localhost:5174`、且不起 vite/tsup（依赖 `.vscode/tasks.json` 的 `dependsOn`）。另一条路径 `packages/desktop/scripts/dev.mjs:64-113,129` 自己等 tsup marker，但同样只 `spawn(electronCommand, ["."])`。spec.md 未指定用哪条。→ 无法参数化 workspace，`baseline-before.json` 的「参数化 workspace + sessionId」采集方式落空。
- **修改建议**：改 SPEC「A. 度量基建」第 3 条与 Step 3，新增「dev 实例启动契约」小节，写死：(1) 统一走 `pnpm --filter @zcode/desktop dev:runtime`（`scripts/dev.mjs`）或直接改用「spawn electron + `ELECTRON_RENDERER_URL` + 自行等 tsup/vite ready」的专用 spawn，**不使用 `--inspect-brk`**；(2) workspace 参数改由 `--open-workspace` 直传给 electron 可执行文件（`desktopDeepLinkUrl.ts:224-249` 已支持两种 argv 形态），或改用 CDP 侧 `Runtime.evaluate` 调用既有 deep-link 处理；(3) 明确「单实例锁探测」的具体判据（9229 `/json/version` 可达即复用）。
- **合并来源**：证据 S-1 + S-2。

### P0-2 active 定位量化单位错配 —— Step 6（blocking）
- **问题**：SPEC B-3（spec.md:42）要求把 `activeUnitIndex` 改为按 `Math.floor(scrollOffsetPx / 10)` 量化。但 `scrollOffsetPx` 来自**主时间线** virtualizer（行高估计 72px + 实测动态测高），`10` 是**右侧 rail 自己的** `estimateSize`/DOM 高度。量化步长只有主行高的 ~1/7，重算频率与行边界无关 → 比现状更慢，不是更快。
- **证据**（✔ 已核实）：`packages/ui/src/v4/ConversationTurnNavigator.tsx:110-116` `useVirtualizer({ …, estimateSize: () => 10, … })`；`ConversationTimeline.tsx:1705` `scrollOffsetPx={virtualizer.scrollOffset ?? …}`、`:737-753` `turnNavigatorVirtualItems` 由主 `virtualRows` 映射、`timelineRowHeightCache.ts:11` `DEFAULT_ROW_HEIGHT_ESTIMATE_PX = 72`、`ConversationTimeline.tsx:693-712`（`estimateSize` + `measureElement`）。
- **修改建议**：改 SPEC B-3 为「量化步长取主时间线行高的量级（如 `Math.floor(scrollOffsetPx / DEFAULT_ROW_HEIGHT_ESTIMATE_PX)`）或直接按 `virtualRows` 的 `start` 边界变化触发」；同时在 Step 6 明确该 useMemo 的 deps 组成（Map 提出属函数体、量化属 deps，二者同处一个 useMemo，不能拆成两句话）。
- **合并来源**：证据 R-3 + R-8。

### P0-3 reflow 消除的落点组件里没有挂载点 —— Step 7（blocking）
- **问题**：SPEC B-4（spec.md:43）要求「`ConversationTurnRow` 挂载注册/卸载注销」rowId → element。但该组件不渲染任何 DOM、无 ref、不持有 `data-row-id`。
- **证据**（✔ 已核实）：`packages/ui/src/v4/ConversationTurnRow.tsx` 全文 104 行，`:43-81` 只把 props 透传给 `:62 <ConversationRowView …>`；`:83-103` 是纯函数。`data-row-id` 的真实产地为 `ConversationRowView.tsx:141`（`RowShell`，14 个调用点）与其余 3 个文件共约 20 处挂载点。
- **修改建议**：改 SPEC B-4 与 Step 7：把注册点改指 `ConversationRowView.tsx` 的 `RowShell`（或改为在 `ConversationTimeline` 用 `MutationObserver`/容器级 `getBoundingClientRect` 一次性替代逐 row 查询），并写明 ref Map 的宿主组件与跨 `ConversationTurnGroup → ConversationRowView` 的透传方式（context 或 prop）。
- **合并来源**：证据 R-4。

### P0-4 「工作中 N 秒」局部 tick 缺数据来源 —— Step 5（blocking）会引入功能回归
- **问题**：SPEC B-1 要求 renderUnits 的 deps 去掉 `liveNowMs`，同时把文案改为组件内局部 tick。但 `durationMs` 是**构建期烘焙进 `workSegments[].workStatus` 的数字**，局部 tick 只能重渲染、拿不到新值；且 `ConversationTurnWorkSegment` 接口**没有 `startedAt`/`header` 字段**。SPEC 未给出数据来源路径 → 「工作中 N 秒」会冻结在最后一次 renderUnits 重建的值。
- **证据**（✔ 已核实）：`ConversationTurnGroup.tsx:565-582` `AssistantHistoryStatus` 读 `segment.workStatus?.durationMs`；`conversationTurnWorkSegments.ts:19-28` 接口仅 `workStatus?: { state, durationMs? }`；`:113-114` `if (fact && options.segmentRunning && options.nowMs !== undefined) return Math.max(0, options.nowMs - fact.startedAt)`（`startedAt` 只存在于 `header.workSegments[]`，未透出）。另 `ConversationShareReadonlyTimeline.tsx:789` 是第二个消费点（不传 `nowMs`，不受影响）。
- **修改建议**：SPEC B-1 补一条硬约束：「局部 tick 组件必须能取到 segment 的 `startedAt`（扩展 `ConversationTurnWorkSegment` 增加 `startedAt?: number`，由 `buildConversationTurnWorkSegments` 从 `header.workSegments[].startedAt` 填充）」，并把 `AssistantHistoryStatus` 的落点写死（建议新抽 `memo` 化的 `WorkingDurationText` 子组件 + `useEffect`+`setInterval`，仅在 `state === "running"` 时起 tick）。
- **合并来源**：证据 S-02 + R-2 + N-5。

### P0-5 「摘要截断前置」与 T-TD1「逐字节一致」及 PRD 非功能需求互斥
- **问题**：SPEC B-5（spec.md:44）要求 `buildPreviewText` 先 `slice` 到上限再分段清洗。但现状是「先分段清洗 → 取前 2 段 → 连接 → 截断 220」；改成先截断会在段落边界处改变输出（第 1 段占满 220 时第 2 段的归属/内容变化），因此 (a) T-TD1（spec.md:169，blocking:yes）「与原 renderer 实现逐字节一致」会红；(b) 违反 PRD「非功能需求：不改变用户可见的消息流交互与视觉」（hover 摘要即用户可见文本）。
- **证据**（✔ 已核实）：`conversationTurnNavigatorHelpers.ts:102-117`（`normalizePreviewParagraphs` 先分段+折叠+取前 2 段，`truncatePreview` 后截断）、`:119-135` `buildPreviewText` 顺序为 `:130` 先 normalize、`:134` 后 truncate；`:99-100` 220/2 常量。
- **修改建议**：二选一并写死到 SPEC：(1) 保持 T-TD1 口径 → B-5 改为「先按空行分段、对每段只清洗其前 `maxChars` 长度的前缀」的分段内截断（语义等价、复杂度有界）；或 (2) 接受行为变化 → T-TD1 改为「对给定语料新旧输出一致率的显式阈值 + PRD 非功能需求加例外说明」。推荐 (1)。
- **合并来源**：证据 R-5。

### P0-6 renderUnits 增量重建的 dirty 集合定义不完整 —— Step 11（blocking）
- **问题**：SPEC C1-f 只说「store 通知时附带本次变更的 turnId/rowId 集合，只对 dirty turn 重算」。但 `materializeDraftUnit` / `normalizeRenderUnitPosition` 都按 `index/total` 重算 `isLastTurn`，并改写**最后一个 workSegment 的 `assistantHistoryDefaultOpen`**：新 turn 追加（或某 turn 被 `shouldKeepRenderUnit` 过滤）时，前一个原末轮不在 dirty 集合里却必须重算。另外 `sessionPhase`（`resolveTurnRunning`）与 `nowMs`（duration 计算）也参与结果，缓存键未包含；`row.delta` 不带 turnId，需 store 另行解析。
- **证据**（✔ 已核实）：`conversationTurnRenderUnits.ts:279` `const isLastTurn = index === total - 1;`；`:388-436` `normalizeRenderUnitPosition`（`:394` 再次按 index/total，`:408-421` 改写末段 `assistantHistoryDefaultOpen`，`:422-429` 无变化时返回原 unit）；`:374-386` `shouldKeepRenderUnit`；`:199-220` `resolveTurnRunning` 读 `options.sessionPhase`；`conversationTurnWorkSegments.ts:59-60,113-114,128-129` 读 `nowMs`；`delta.ts` 的 `row.delta` 仅 `rowId/path/append`。
- **修改建议**：SPEC C1-f 补写失效键定义：`dirtyTurns = 本帧变更 row 的 turnId ∪ { 上一帧的最后一个 unit 的 turnId（因 isLastTurn 可能翻转）}`，缓存键 = `turnKey + "|" + isLastTurn + "|" + sessionPhase`（`nowMs` 不入键，改由局部 tick 承担，见 P0-4），并在 Step 11 与 T-AP4 的等价性测试里把「追加新 turn」「末位 turn 被过滤」「sessionPhase 迁移」列为必测场景。
- **合并来源**：证据 S-01 + S-04 + S-12。

### P0-7 renderer 侧第二份全量 renderUnits 未纳入方案 —— PRD 旗舰指标不可达
- **问题**：SPEC C1-g（spec.md:60）把「renderUnits 增量化」定为渐近收益主力，但 `SessionPane` 里还有一份**每帧全量** `buildConversationTurnRenderUnits(snapshot.rows.window)`，不在修改清单也不在「不动」清单。保持原样则每条 delta 帧仍有一遍 O(N) 分组 + `materializeDraftUnit`（内含约 8 次 filter + 2 次 Set），PRD 成功指标 2「下降一个数量级」无法由本 SPEC 达成 → 终验必返工。
- **证据**（✔ 已核实）：`packages/ui/src/v4/SessionPane.tsx:641-644` `shareRenderUnits = useMemo(() => buildConversationTurnRenderUnits(snapshot?.rows.window ?? []), [snapshot?.rows.window])`（hook 无条件执行，非分享态也每帧全量构建）；另有 `:670/:678/:746/:754/:1690-1697/:3756-3757` 多处 `[snapshot?.rows.window]` 依赖的每帧 O(N) 计算。
- **修改建议**：SPEC C1 补一条子项：「把增量构建器抽成共享纯函数（放 `conversationTurnRenderUnits.ts` 或新文件），`ConversationTimeline` 与 `SessionPane` 共用；`SessionPane` 的 `shareRenderUnits` 改走同一增量缓存或按 `shareActive` 条件短路」，并在「最终项目结构 → 修改」清单中补 `SessionPane.tsx`；Step 11 追加落点。
- **合并来源**：证据 S-07。

### P0-8 turnDirectory 契约不完备：排序方向 / 游标语义 / turnKey 口径缺定义
- **问题**：SPEC A2（spec.md:66）只给 `params {…, limit?, beforeTurnKey? }` 与 `result { entries, …, hasMore }`，**未规定 `entries` 是升序还是降序**，也未定义 `beforeTurnKey` 的游标方向与 `hasMore` 的含义。而同族两方法方向相反（`getRowsRange` 升序、`getPlans` 降序）。T-TD2（blocking:yes）要求「顺序…正确」却无唯一解 → 服务端实现、客户端分页、测试三方必然打架。`turnKey` 取值口径同样未定义：row 基座同时存在 `turnId` 与 `productTurnId`，且 `turnKey` 未在任何 schema 中出现。
- **证据**（✔ 已核实）：`apps/zcode-cli/.../conversation-topic-publisher.ts:449` `eligible.slice(-limit)` + `:431` 注释「rowId 升序返回」；`:474` `getPlans` `.toSorted((left, right) => right.rowId - left.rowId)`（降序）；`packages/shared/src/zcode-protocol-v4/rows.ts:10-16` `rowBaseFields` 含 `turnId` 与 `productTurnId`（注释「productTurnId 是产品轮次，不得由 UI 重猜」）。
- **修改建议**：SPEC C2 契约段补三句硬定义：entries **按 rowId 升序**（与 rail 自上而下的时间序一致）；`beforeTurnKey` 语义 = 「返回 `queryRowId < beforeTurnKey 对应 queryRowId` 的更早条目」；`hasMore = 更早条目仍存在`；并定义 `turnKey` 的取值与稳定性来源（建议：`${turnId}:${queryRowId}` 或直接用 `queryRowId` 作游标，删掉 `turnKey` 以免与 `turnId`/`productTurnId` 三义）。
- **合并来源**：证据 S2 + S3。

### P0-9 「`realUserQueryCount < 2` 由目录结果天然承接」不可推导
- **问题**：现实现是对**已实际拉取的行**逐行 reduce，并依赖「探测到分支起点（`hasMore` 变 false）」才敢下结论；且该分支还驱动 `turnNavigatorHydrationTerminal` 与 rail 隐藏。目录 result 只有 `entries + hasMore`，没有权威 query 总数字段，配合 P0-8 未定义的排序/游标口径，无法判定 `< 2`，也无法区分「真的只有 1 条 query」与「还有更早页没拉」。
- **证据**（✔ 已核实）：`packages/ui/src/v4/conversationProjectionStore.ts:1118-1122` reduce 判定、`:1138-1140` 注释「宽屏必须探测到分支起点；确认不足两条后不合并探测页」、`:1147-1153` 返回 `not-enough-queries` 并写 `turnNavigatorHydrationTerminal`。
- **修改建议**：SPEC C2「store 拆双路径」补写判定规则：「目录查询需按 `beforeTurnKey` 翻页至 `hasMore === false`；累计 realUser 条数 `< 2` 时返回 `not-enough-queries` 终态（与现状语义等价），翻页上限与超时显式给出；或在 result 中新增 `realUserQueryTotal` 字段由服务端现算直接给出」——二选一写死，并同步 Step 16 与 T-TD2。
- **合并来源**：证据 S5。

### P0-10 blocking 测试无运行入口 + 模块不可测
- **问题**：T-PA1/T-PA2/T-AP2/T-AP3/T-AP4/T-MG1 均标 `blocking: yes`，但：(a) `packages/ui` 与 `packages/shared` 的 `package.json` 只有 `lint`/`lint:fix`，仓库根也无 `test` 脚本；(b) ui 侧唯一先例 `packages/ui/test/nonCliAcpRetirement.test.ts` 在 `npx tsx --test` 下**当前就是红的**（`@/` 别名无法在 Node 解析）；(c) T-AP2/T-AP3 需要的 `mergeOlderRows` 未导出、`ConversationProjectionStore` 构造依赖 `@/logger.js`/`@/lib/memoryDiagnostics.js`；(d) T-MG1 的 `tokensCache` 未导出。
- **证据**（✔ 已核实）：实测 `npx tsx --test packages/ui/test/nonCliAcpRetirement.test.ts` → `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`（`# pass 0 # fail 1`）；`packages/ui/package.json:16-19`、`packages/shared/package.json:26-29` 无 `test` 脚本；`packages/ui/tsconfig.json` 的 `paths` 只在编译期生效。
- **修改建议**：SPEC「测试策略」章节新增「可测性前置」小节并插入 Step 0 之后作为新 blocking step：(1) 明确测试运行方式（`npx tsx --test <file>` + 只允许相对路径/`@zcode/*` 导入；或引入 loader 解析 `@/`）；(2) 为需要被测的对象提供导出 seam（`mergeOlderRows`、LRU 淘汰钩子、增量构建纯函数）；(3) 把纯逻辑下沉到无 `@/` 依赖的模块（如 `previewText.ts`、`apply.ts` 同级），测试只覆盖下沉后的纯函数；同步把 T-PA2 断言改为「registry 注入 7 个假 provider 后 `collect()` 返回全部 7 类」。
- **合并来源**：证据 S-08 + P-1 + P-2 + P-3 + P-4。

---

## 二、P1（16 条，应修）

| # | 问题 | 证据 | 修改建议 |
|---|---|---|---|
| P1-1 | copy-on-notify 的**理由**写错：SPEC 称直接发布会违反 `useSyncExternalStore` getSnapshot 稳定契约；实际 `setState` 每帧都换 `state` 外壳，真正会坏的是 `snapshot.rows.window` 引用不变导致全仓约 15 处 `[snapshot?.rows.window]` memo 不失效 → 静默不更新 | `conversationProjectionStore.ts:387-390`（每帧换 `this.state`）；消费点 `SessionPane.tsx:643/678/740/754/962/1132/1691/1697/3757`、`useTreemappingConversationMessage.ts:97` | C1-b 把理由改为「换 window 数组引用是让下游 memo 失效的必要条件」，并保留三层换引用为硬约束（结论不变） |
| P1-2 | 变更文件清单缺 `packages/shared/src/zcode-protocol-v4/index.ts`（`@zcode/shared` 是桶导出，新增 `previewText.ts` 必须再导出，否则 renderer 引用不到）；「13 文件」与清单条目对不上 | `packages/shared/src/zcode-protocol-v4/index.ts:33-34` 桶导出；`packages/shared/package.json` exports 映射；spec.md:100-112,126 | 「最终项目结构 → 修改」补 `index.ts`；变更点 7 的文件数按清单实际条目改写 |
| P1-3 | `assistantPreviewKind` 三态缺判定规则：`running`/`empty` 依什么信号判定未写（T-TD2 为 blocking 验收项） | `rows.ts:156-166` `assistantTextRowSchema`（`state: streaming/complete/interrupted/failed`）、`rows.ts:77` `turnHeader.state`、`conversationTurnNavigatorHelpers.ts:137-167` 现状判定顺序（`assistantTextRows.length>0 → text`；`unit.isRunning → running`；否则 empty） | C2 契约补「三态判定 = 目录 turn 内存在 assistantText 行 → text；否则 turnHeader.state === "running" → running；否则 empty」，与 renderer 现状对齐 |
| P1-4 | 目录派生未与 delivery profile 对齐：`getRowsRange` 会按 `clientMode` 过滤，`getPlans` 不过滤；目录若不过滤，`replayable` 档位可能看到本应隐藏的行 | `conversation-topic-publisher.ts:441-444`（`filterConversationRowsForProfile`）vs `:464-474`；`transport.ts:507` `clientMode` | C2 服务端段明确目录**是否**走 profile 过滤；若走，需在 params 加 `clientMode` 并照 `rowsRange():1559` 的 profile 传参 |
| P1-5 | host 四件套未指定跟哪一支：`conversationPlansV4` 不调 `readTrustedZCodeAgentV4Connection`，且 `zcodeAgentConnectionScope` 无 `plans` 转发 | `zcodeAgentService.ts:5259-5273`（rowsRange 走 trusted）vs `:5275-5279`（plans 透传注释）；`zcodeAgentConnectionScope.ts:730-742` | C2 写死「turnDirectory 跟 `plans` 支（只读目录、沿 workspace attachment 透传、不建新 runtime）」或「跟 `rowsRange` 支」，并同步 Step 15 |
| P1-6 | wire 侧 `atRevision` 与 store 侧 `turnNavigatorDirectoryRevision` 是两套代际，关系未说明 | `conversation-topic-publisher.ts:453` vs `:475-479`（`getPlans` 无 `atRevision`）；`conversationProjectionStore.ts:131` | C2 补一句「客户端以 `atRevision` 做陈旧丢弃、以 store `turnNavigatorDirectoryRevision` 做重查触发，二者不互相替代」 |
| P1-7 | 宽屏触发函数 `shouldHydrateConversationTurnNavigatorDirectory` 的签名/阈值（864px）与 `loadingOlder` 语义在「拆双路径」后未定义，且该文件未进修改清单 | `conversationTurnNavigatorHelpers.ts:69,77-89`；`ConversationTimeline.tsx:607-677` | C2 补该函数为修改项，并写死目录查询的 loading 态字段名与 rail 隐藏条件 |
| P1-8 | 跳转闭环缺页数上限数值、失败终态、是否合并探测页；与「不为不显示的 rail 常驻全量历史」的既有内存权衡相冲突 | spec.md:71；`conversationProjectionStore.ts:1138-1140`；`core.ts:76` `rowsRangeMaxLimit: 200` | C2 补：单页 limit（建议 200）、最大页数、到达上限仍未命中时的 UI 终态、探测页是否合并（建议不合并，与现状一致） |
| P1-9 | 目录「全量行现算 + revision 失效重查」的服务端 O(N) 成本与重查节流未评估 | spec.md:67,70；`shouldInvalidateTurnNavigatorDirectory` 触发点在 `conversationProjectionStore.ts:747-751` | C2 补一句成本口径与去抖（如 revision 变更后 rAF/短延时合并一次查询），并在风险表加一行 |
| P1-10 | `reset()/dump()` 的分段语义（reset 开新段 vs 清空）与返回通道（`Runtime.evaluate` 需 `returnByValue`/字符串）未钉死，CDP 调用序列无唯一解 | spec.md:30,36；`.cu-shots/cdp-verify-historian.mjs:19,67-68` | A 节补「`dump()` 返回 JSON 字符串；`reset()` 清空当前段并开启新段」，Step 3 补对应调用序列 |
| P1-11 | `apply.test.ts` 放 `packages/shared/src/` 会被 `tsc -b` 编译并 emit 进 `dist/`，与「测试一律在 `packages/<pkg>/test/`」的既有先例冲突 | `packages/shared/tsconfig.json:9` `include: ["src"]`；现有测试均在 `packages/*/test/` | 最终项目结构把等价性测试改到 `packages/shared/test/apply.test.ts`（或明确接受 emit 并写进风险表） |
| P1-12 | accumulator 正确性依赖「`state.updated` 的 patch 键集合封闭且不含 `rows`/`seq`/`logEpoch`」这一隐含不变量，SPEC 未固化、风险表无对应条目 | `delta.ts:39-61` `statePatchSchema`；`apply.ts:200` `Object.assign(snapshot, delta.patch)` | C1 补「Object.assign 不得覆盖 rows/seq；断言 statePatchSchema 不含这三个键」，风险表加一行（与 R-1 同级） |
| P1-13 | `tokensCache` LRU 只写了「上限 500、命中刷新」，未指明插入点（命中处需 `delete`+`set`）、未提相邻的无界 `subscribers` Map、Map 未导出导致 T-MG1 只能靠 registry 观测 | `shikiHighlighter.ts:60`（未导出）、`:139-148`（命中不重排）、`:176`（异步写入）、`:61` `subscribers` | D 节补落点行号与 `subscribers` 是否一并护栏；T-MG1 断言方式改为「注入 N 条后 registry 计数 ≤ 500 且最近命中项仍在」 |
| P1-14 | T-TD3 只写 `row.removed` 触发 revision 自增，实际判据函数覆盖 append/upsert/removed 三类 | `conversationProjectionStore.ts:124-131`（JSDoc）、`:745-751` `shouldInvalidateTurnNavigatorDirectory(frame)` | T-TD3 改为「`shouldInvalidateTurnNavigatorDirectory` 命中的三类帧各一例」 |
| P1-15 | B-2「Map 索引提到组件侧 useMemo 后传入」会改动纯函数公开签名，同文件其余 `resolveXxx` 均无 React 依赖，兼容策略未写 | `conversationTurnNavigatorHelpers.ts:217-268`（签名）vs `:77/:91/:270/:307/:328` | B-2 补「新增可选参数 `itemByUnitIndex?`，缺省时函数内自建，保持向后兼容与可单测」 |
| P1-16 | T-TD4/active 降级只描述了一条分支语义：`resolveConversationTurnNavigatorActiveUnitIndex` 对 `virtualItems` 有主循环与 `topVirtualIndex` 兜底**两条**依赖，混合态（部分目录项已加载）下的分工未定 | `conversationTurnNavigatorHelpers.ts:233-248`（主循环）、`:254-267`（兜底链） | C2「active 定位降级」补：两条路径各自的降级规则与优先级，并列入 T-TD4 混合态用例 |

---

## 三、P2（9 条，可选）

| # | 问题 | 证据 | 修改建议 |
|---|---|---|---|
| P2-1 | C1-d 称 `hasOlderRows` 依赖 `totalCount/firstRowId`，实际只读 `window[0].rowId` 与 `firstRowId`；`totalCount` 的消费者是滚动条估计与 debug 日志 | `conversationProjectionStore.ts:227-232`；`ConversationTimeline.tsx:4524` | 措辞改为「`firstRowId` 进 rows 对象；`totalCount` 另行同步（滚动条依赖）」，避免实施时漏同步 |
| P2-2 | Step 0 的前提数字与提问方式已被现有事实回答（两文件首行均带 `eslint-disable max-lines`；口径为非空非注释行） | `transport.ts:1`、`conversationProjectionStore.ts:1`、`.oxlintrc.json:6,12-15`；实测 1145/980、1383/1321 行 | Step 0 缩范围为「确认**未豁免**文件（`conversationTurnNavigatorHelpers.ts` 332 行等）在新增代码后不超 400」 |
| P2-3 | `knip.json` 登记被列入「修改（关键落点）」，但 knip 不在 `verify:pre-push`（只有 lint + architecture:check） | `package.json:20,34`；`AGENTS.md:21-24` | 降为备注或移入 Step 3 的可选项 |
| P2-4 | B-4 行号写 `906-937`，实际函数体到 937、useCallback 收尾到 940 | `ConversationTimeline.tsx:906-940` | 改为 `906-940`（其余同批行号均精确，属抄写漂移） |
| P2-5 | `collectRendererMemorySample(): MemorySample` 未提 `role` 为必填联合类型 | `packages/shared/src/memoryDiagnostics.ts:8,20-24`；`packages/ui/src/lib/memoryDiagnostics.ts:63` | Step 1 补「`role` 固定填 `"renderer"`」 |
| P2-6 | 探针挂在 `App.tsx`，`packages/web` dev 下同样会挂（`import.meta.env.DEV` 为 true） | `packages/ui/src/App.tsx`；根 `package.json:8` `dev:web` | 加一句「web dev 下挂载无害，或按需加 renderer 判定」 |
| P2-7 | 变更点 4「摘要截断前置」映射到 PRD 核心需求 6（内存护栏），实际属渲染层 | spec.md:124 vs prd.md:67 | 映射改为核心需求 4/5 或在 PRD 增补一条 |
| P2-8 | 摘要工具提取后原 `conversationTurnNavigatorHelpers.ts` 三函数「删除 / re-export / 保留副本」未写；`buildAssistantPreview` 依赖 UI 类型不在可提取范围 | `conversationTurnNavigatorHelpers.ts:102-140` | C2 补一句「原三函数删除并改为从 `@zcode/shared` 引入，`buildAssistantPreview` 留在 renderer」 |
| P2-9 | 分享链路另有 Pick 面引用 `conversationRowsRangeV4`（非阻塞，但清单未提） | `packages/services/src/conversation-share/conversationShareService.ts:182,2391`；`packages/desktop/src/host/conversationShareAttachmentService.ts:7` | 在「不动」清单里点名，避免后续误改 |

---

## 四、Go / No-Go

**No-Go**：10 条 P0 覆盖全部四个 blocking 工作面（度量启动路径、两处渲染热点硬伤、计时文案数据源缺失、增量重建定义不完整、旗舰指标覆盖面、目录契约与判据、blocking 测试不可执行），按现 SPEC 编码在 Step 3~7 / 10~11 / 13~18 均会返工；修完 P0 + P1 后建议进 r2 复审。
