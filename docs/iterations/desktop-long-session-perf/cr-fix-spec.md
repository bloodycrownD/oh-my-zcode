# CR Fix Spec: desktop-long-session-perf（桌面端长会话性能优化）

## 元信息
- repo：D:\Dev\worktree\desktop-long-session-perf（分支 feature/desktop-long-session-perf）
- base_sha：ba7c240（main=v0.1.1） / head_sha：d11a97c（48 文件 +7193/−772，28 commits）
- prd_path：docs/iterations/desktop-long-session-perf/prd.md
- spec_path：docs/iterations/desktop-long-session-perf/spec.md
- review_round：5（code-review-loop r1-r3 + spec-check-loop r1-r3，r4 回填后收敛）
- dag_version：7
- 状态：fix-spec-ready（spec-check-loop 三轮 + r4 回填；deviations #1-#4 待用户拍板，按约定不阻塞 ready）
- **行号基线约定（硬）**：所有 file:line 以 d11a97c 为基线、仅用于定位；执行时以**符号名/唯一锚点**（函数名+邻近注释）定位，行号漂移不视为偏差；每条提交前按符号复核目标仍存在。
- 评审方式：两段式（evidence×4 证据包 cache/cr-ev-*.md → review-full 全局裁决；51 条可疑点 → 22 must-fix / 4 open_questions / 10 否决）

> 执行纪律（沿袭 dev_exec.commit_rule）：每条带 pathspec 提交、中文 commit、UTF-8+LF、**禁止 git reset**（并行节点共用分支）。

## 执行顺序与分组（r2 修订版；波次内严格串行，不得并行）

- **波次 1（core/store 数据层，一个 PR/连续提交）**：**C-1a**（只删 `ConversationProjectionLastMutation.seq` 与 core:260 赋值）→ E-1 同批落地（引用复用依赖 seq 已删；注意 `publish()` 只读路径 conversationProjectionCore.ts:267 显式传 rowsChanged=true）→ C-2 → C-3 → **C-5**（timelineSnapshot 双双上提，SessionPane 投影层口径统一）→ E-2。
- **波次 2（store 目录态重构，顺序固定）**：G-1 先下沉分页循环（签名含 expectedLogEpoch/readCurrentLogEpoch，陈旧以返回值表达；core 不打日志）→ B-2 随后改 catch 清空（失败分支由 stopReason 表达）→ E-3 最后加 truncated（warn 由 store 依 stopReason 打——core 禁 import UI logger；同步改 useConversationProjection.ts:9-17 与 ConversationTimeline 透传）。
- **波次 3（探针与死代码）**：B-5 先接线 stopPerfProbe（App.tsx 的 useEffect cleanup 依赖 stop 存在）→ **C-1b**（删 normalizedPositions+normalize 函数 / classifyTurnNavigatorActiveScope / index.ts 改具名导出——波次内串行即可，二者无符号依赖）。
- **波次 4（rail UI，统一顺序）**：B-4 先补 userFallbackPreview（改 merge 调用行 ConversationTurnNavigator.tsx:110-113）→ **J-2 一次做完**（两个 useMemo 上提 + items/loadedItems 双 prop + turnNavigatorVisible 单一真源含 gutter）→ B-1（registry 容器过滤，Timeline 两读点）→ J-1（jump loading 接线）。
- **波次 5（测试与收口，顺序固定）**：**C-5 与 C-2 的测试先写**（新建 conversationTurnRenderUnits.test.ts；B-1 的 `pickOwnedRowElements` 单测落 **conversationTurnNavigatorHelpers.test.ts**——不新建文件，保持总数不变）→ G-3 补其余测试 → **G-2 最后**（tsconfig.test.json + test:v4-perf 聚合脚本——显式列表须在全部测试文件就位后编写，本期共 **ui 6 + shared 2 = 8 个**，含新建的 renderUnits 测试）→ F-1/F-2/C-4/E-4/D-1/K-1（相互独立）。

## Must-fix（按 P0 → P1 → P2）

### full/B-1 [P0] rowElementRegistry 跨 pane 撞号
- 维度：B / C-orch
- 文件：`packages/ui/src/v4/ConversationRowView.tsx:130-156`、`ConversationTimeline.tsx:969-1004`（读点）、`:1368-1376`（scrollToQuery 读点）
- 问题：`rowElements` 模块级单例、仅以 rowId 为键。SessionPane 有 5 处挂载点（V4ChatPane/SelectionSideChatPane/SubagentSessionSidePane/WorkflowActorSessionSidePane/WorkbenchPane），侧 pane 与主 pane 并存是常态；rowId 跨会话重复 → 后挂载者覆盖前者，`clearRowElementRegistry` 的 `isConnected` 剪枝剪不掉别家 pane 的活元素。BASE 用容器内 `querySelectorAll` 无此问题——**本轮引入的回归**。后果：rail active 高亮与跳转滚动落点取到别处坐标。
- 改法（**写死方案 A**）：读取端按容器归属过滤——`syncTurnNavigatorViewport` 与 `scrollToQuery` 的 registry 分支加 `element.contains(el)` 判定，不通过则 fallback `element.querySelector('[data-row-id=...]')`。把过滤抽成 `pickOwnedRowElements(registry, container)` 纯函数便于单测（**Node 无 DOM——用手写容器桩 `{ contains: (el) => boolean }` + Map 测纯函数，落 `conversationTurnNavigatorHelpers.test.ts`**，不引入 DOM 测试基建）。（方案 B「键改 `${scopeKey}:${rowId}`、13 处调用点」仅为 A 被证伪后的回退，非选项：执行时若发现 contains 判定不足以覆盖某场景，先取证回报再议，不得自行切换。）
- 验收/测试：单测「注册表条目不属于本容器时被跳过」；manual_user：主 pane + 侧 pane 打开不同会话各自滚动，active 高亮与跳转落点必须在本 pane。
- 来源：review-full r1 / render S-01；r2 复核（5 处挂载点独立核实）

### full/E-1 [P1] 无行变更帧仍换三层引用 + 每次新建 lastMutation（旗舰指标受损）
- 维度：E
- 文件：`conversationProjectionCore.ts:162-169/254-262`、`conversationProjectionStore.ts:836-873`、`SessionPane.tsx:659-667/691-701`、`ConversationTimeline.tsx:475-483`、**spec.md:203（T-AP3 收窄）**
- 问题：`publishConversationShell` 无条件 `[...window]`+`{...rows}`，纯 `state.updated` 帧也换引用 → 下游 `[rows.window]` useMemo 每帧失效（分组 O(N) + 级联 + rowsById Map）；`lastMutation` 每帧新对象同理。
- 改法：`windowChanged` **写死为 `lastMutation.turnIdByRowId.size > 0`**（row.delta 未命中窗口不进集合，作为「窗口未变」的代理安全，勿自造比较逻辑）；`publishConversationShell(accumulator, rowsChanged)` 在 `rowsChanged===false` 时**复用上一帧的 window/rows 引用**、只换 snapshot 外壳；store 侧 `size===0` 时复用上一个 lastMutation 对象（空集是脏集子集，语义安全）。**执行顺序依赖：本条与 full/C-1a 同批落地且 C-1a 先删 `LastMutation.seq`**（复用旧对象会使 seq 过期，删除后无此问题）；若先于 C-1a 执行，须临时改用「空集 lastMutation（seq=toSeq、map 空）」。**同步收窄 T-AP3（spec.md:203）**：「有行变更帧三层全换」+ 新增「纯 state.updated 帧：snapshot 换、window/rows/lastMutation 不变」。
- 验收：core 测试补两条断言；重跑终验采样确认流式期长任务进一步下降。执行注意：`publishConversationShell` 的第二个调用点 `conversationProjectionCore.ts:267`（`publish()` 只读路径，注释「只读快照不推进状态」）必须**显式传 `rowsChanged=true`**，否则只读发布会意外复用引用。
- 来源：review-full r1 / data S4

### full/B-2 [P1] 目录查询失败静默陈旧且无自恢复
- 维度：B
- 文件：`conversationProjectionStore.ts:1475-1487`
- 问题：catch 只 warn + `retryable-failure`，目录态保留旧值而 revision 已前进 → 配合 loaded 门控出现「旧目录+新 revision」，流式期 assistantText 不触发失效 → rail 可无限期停在旧条目。
- 改法（写死方案 a，随波次 2 在 G-1 后执行）：catch 的「清空目录态 + 返回 retryable-failure」判定**随 G-1 下沉 core 可测**（失败分支由 accumulateTurnDirectoryPages 的 stopReason 表达），store 侧 catch 到失败即 `setState({turnDirectory: EMPTY_TURN_DIRECTORY_STATE})` + `logger.warn`。**行为如实描述（修正原「回落 canLoadOlder」错误表述）**：清空后 loaded=false → rail 隐藏；组件 effect 的退避阶梯（ConversationTimeline.tsx:686-729）重试 3 次（250/1000ms），耗尽后 attempt=terminal 挡住重查——**目录在 revision 下次变化前保持隐藏，这是本方案的已知取舍**（revision 由 append/upsert/removed 帧驱动，流式期 assistantText 不触发，见 core:55-63）。
- 验收（分层，r2 修正）：**core 层**——`fetchPage` 抛错 → `stopReason` 表达失败（可单测，G-1 下沉后）；**store 层**——目录态清空降级 manual_user（失败注入后 rail 隐藏、无陈旧条目残留；store 因 `@/logger` 依赖不可在 Node 下实例化）。
- 来源：review-full r1 / data S10；spec-check r1 修正；**r2 修正（core 不持有目录态，清空断言拆到 store/manual 层）**

### full/G-1 [P1] 目录分页/陈旧读/游标推进逻辑零测试
- 维度：G
- 文件：`conversationProjectionStore.ts:1340-1488`、`conversationProjectionCore.ts`
- 问题：atLogEpoch 丢弃、跨页 atRevision pin、游标未推进 guard、50 页上限、`<2` 首屏终态、终态分离全部无用例（回归后果=rail 静默漏条目）。
- 改法：把纯逻辑下沉 core：`accumulateTurnDirectoryPages({ fetchPage, sessionId, limit, maxPages, expectedLogEpoch, readCurrentLogEpoch? })` → `{ entries, realUserQueryTotal, atSeq, pinnedRevision, hasMore, stopReason }`——**expectedLogEpoch 由调用方传入、活纪元经 readCurrentLogEpoch 回调查询**（store 传 `() => this.state.snapshot.logEpoch`），使 epoch 弃/跨页 revision pin 落在 core 可测路径；core 不打日志（零 @/ 约束），陈旧以 stopReason/返回值表达，由 store 决定日志与 setState；store 只留 closed 判定/setState/终态写入。新增测试 ≥6 例（两页/单页够/跨 revision 弃/epoch 弃/游标未推进/页数上限截断）。执行顺序见「执行顺序与分组」波次 2（G-1 最先）。
- 验收：`npx tsx --test packages/ui/test/conversationProjectionCore.test.ts` 全绿（含 epoch/revision 弃用例——签名设计已保证可测）。
- 来源：review-full r1 / data S12；spec-check r1 修正（原签名无法承载 store 循环内的 closed/epoch/revision 三依赖致验收不可测）

### full/G-2 [P1] 新增 blocking 测试无自动化执行入口且不在 typecheck 内
- 维度：G / K
- 文件：`packages/shared/tsconfig.json`、`packages/ui/tsconfig.json`、`apps/zcode-cli/packages/bootstrap/{tsconfig.json,package.json}`、根 `package.json`
- 改法：(1) 新增 `packages/shared/tsconfig.test.json` 与 `packages/ui/tsconfig.test.json`（extends 本包配置、include ["src","test"]、noEmit、types:["node"]、**`rootDir` 覆盖为包根（如 `"."`）**——不覆盖则继承 `rootDir:"src"` 对测试文件报 TS6059，实测必红；composite 继承无碍）；**根 `package.json` 的 `typecheck` 脚本 `tsc -b …` 工程列表尾部追加这两个 tsconfig.test.json**；(2) 根 package.json 增 `"test:v4-perf": "tsx --test <显式文件列表：本期 **ui 6 + shared 2 = 8 个**测试文件——含波次 5 新建的 conversationTurnRenderUnits.test.ts；显式列举避免拉入存量红测；**须在全部测试文件就位后编写，排波次 5 最后**>`；(3) bootstrap 的 `test:turn-directory` 并入聚合脚本。
- 验收：`pnpm typecheck` 覆盖测试文件（含 rootDir 修正后零 TS6059）；`pnpm test:v4-perf` 单命令全绿。
- 来源：review-full r1 / shared S08 + server S10；spec-check r1 修正（原方案实测 TS6059 必红）

### full/C-1 [P1] 死代码清理（生产零消费；r2 拆为 C-1a/C-1b 两个执行单元）
- 维度：C
- 文件：`conversationProjectionCore.ts:178-183/260`（**C-1a**，波次 1）；`conversationTurnNavigatorHelpers.ts:66-69/315-345`、`conversationTurnNavigatorDirectory.ts:170`、`packages/shared/src/zcode-protocol-v4/index.ts:35`（**C-1b**，波次 3）
- 改法：**C-1a（波次 1，E-1 前置）**：删 `ConversationProjectionLastMutation.seq` 字段与 core:260 赋值。**C-1b（波次 3，B-5 之后）**：删 `normalizedPositions` 选项与 `normalizeConversationTurnNavigatorQueryPositions`（含对应测试用例）；**删 `classifyTurnNavigatorActiveScope`（含测试用例）**；`index.ts` 由 `export *` 改具名导出（只导 `buildPreviewText`/`DEFAULT_MAX_PREVIEW_*`/`PREVIEW_MIN_MAX_CHARS`），诊断函数留在 previewText.ts 供测试按路径导入。`stopPerfProbe` 的接线与 `perfProbe.ts:191-198` 归 full/B-5 条目（不属 C-1）。
- 验收：三个测试文件全绿；`pnpm lint` 零新增；**grep 范围限定 `packages/ui/src` 与 `packages/shared/src`**（排除 node_modules——pnpm workspace 软链镜像同物理文件会假命中）无 `normalizedPositions`/`normalizeConversationTurnNavigatorQueryPositions`/`classifyTurnNavigatorActiveScope`/`LastMutation.seq` 残留。
- 来源：review-full r1 / shared S05 + data S6 + render S08；spec-check r2 拆分（原条目跨波次劈半与编排对撞）

### full/B-5 [P1] perfProbe 资源释放缺失 + HMR 重复 observer（采样数据翻倍失真）
- 维度：B / K
- 文件：`packages/ui/src/lib/perfProbe.ts:153-198`、`App.tsx:146-150`
- 问题：observer 是模块级变量，Vite HMR 重求值后句柄丢失、新探针再挂一个 → longtask 双记，**直接污染基线/终验可信度**（仅 dev）。
- 改法：observer 收进 `createPerfProbe()` 闭包，接口加 `stop()`（disconnect+清缓冲）；`startPerfProbe()` 开头先 `__zcodePerfProbe?.stop()`；App.tsx 的 useEffect 返回 cleanup。补单测：stop 后 recordLongTask 不进 dump。
- 验收：dev 下触发 HMR 后 dump 条目数不翻倍。
- 来源：review-full r1 / server-infra S5

### full/B-4 [P1] 目录降级项 userPreview 不套 fallback（与已加载侧文案不一致）
- 维度：B / J
- 文件：`conversationTurnNavigatorDirectory.ts:84/:58-63`、`ConversationTurnNavigator.tsx:110-113`
- 改法：`MergeTurnNavigatorItemsOptions` 增 `userFallbackPreview?`；fallback item 用 `entry.queryPreview || (options.userFallbackPreview ?? "")`；组件传入既有 `userFallbackPreview` 并进 deps。
- 验收：directory 测试加「queryPreview:"" 的目录项 → userPreview=fallback 文本」。
- 来源：review-full r1 / server-infra S11

### full/J-1 [P1] 跳转 loading 态无消费方 + stale 分支不清零
- 维度：J / A
- 文件：`ConversationTimeline.tsx:572/:1403/:1504-1506/:1532-1542/:1917`
- 改法（spec-check r1 修正版——消除内部矛盾；r2 补 aria-busy 合并式）：`turnNavigatorJumpLoading` **并入 rail 既有 `aria-busy`（ConversationTurnNavigator.tsx:209，合并式 `isHydratingDirectory || turnNavigatorJumpLoading`）**，并在 rail item 上加补拉期间点击禁用（`pointer-events:none` + `data-jump-loading` 属性保留作观测）；**`sessionKey` effect 体内（非 cleanup）补 `setTurnNavigatorJumpLoading(false)`**（覆盖切会话场景）；**`finally` 保持现有 `if (!isStaleJump())` 守卫不变**——「被新跳转取代」的 stale 不得清零（否则前一跳的 finally 会抹掉后一跳刚置位的 loading，与「只有最新一次跳转负责清零」的既有纪律冲突，见 :1400-1402 注释）。
- 验收（manual_user，DOM 行为）：跳转补拉期间 rail 有可见反馈（aria-busy/禁点）；补拉在途切会话后不残留 true；快速连点两个目录项时 loading 不闪断。
- 来源：review-full r1 / render S03+S05；spec-check r1 修正；r2 补 aria-busy 合并式与禁用落点

### full/F-1 [P2] previewText 文档注释与扫描量契约三处不准确
- 维度：F（文档注释）/ G
- 文件：`previewText.ts:74-82/:13-24/:43-50`、`previewText.test.ts:195-201`、**spec.md:53 与 spec.md:205（T-TD1）**
- 问题：注释「唯一的无界情形」清单不准确（长空白串后有内容同样无界，实测最高 16667×）；等价性声明缺「有限非负整数」限定；测试扫描量断言未覆盖含长空白串语料；spec 两处措辞同样过度承诺。
- 改法：契约改写为「扫描量以遇到第一个非空白码元或 emit 预算用尽为界；含长空白串的输入扫描量可达输入全长——逐字节等价的必要代价」（删「唯一」措辞）；等价性说明加「有限非负整数」限定；测试拆两条断言（无长空白串 ≤2*maxChars+64 / 含长空白串 ≤输入长度）；**同步收窄 spec.md:53 与 T-TD1（spec.md:205）两处措辞为同一口径**（deviation #1 的落盘动作）。
- 验收：`npx tsx --test packages/shared/test/previewText.test.ts` 全绿；spec.md 两处措辞与实现注释一致。
- 来源：review-full r1 / shared S01+S09+S10；r2 补 spec 同步（deviation #1 落盘）

### full/F-2 [P2] 注释与实现不符（3 处）
- 文件：`conversationProjectionCore.ts:132-136/:151-156/:239-243`、`conversationProjectionStore.ts:857-859`
- 改法：mergeOlderRows 注释改「结果=fetched 原序在前+window 原序在后；全局升序依赖调用方 rowsRange 升序契约」；「约 15 处 memo」行号清单改模块级描述；`core:239-243` 注释改「仅 rebuild 后未 apply 的中间窗口，store 不会读到」。（r3 核实：store:858 已是「无失效依据→下游全量重建」措辞，原第 3 小项为空动作，移除。）
- 来源：review-full r1 / data S7+S5

### full/C-2 [P2] keepByPhase 走裸 .set 绕过有界函数
- 文件：`conversationTurnRenderUnits.ts:212`（对照 :239）
- 改法：改走 `setBoundedPartition(...)`；**新建 `packages/ui/test/conversationTurnRenderUnits.test.ts`** 加「同一 turnId 多 phase 注入后 size ≤ MAX_PARTITIONS_PER_TURN」（波次 5 先写测试，见编排）。
- 来源：review-full r1 / data S1

### full/C-3 [P2] row.upserted 改挂 turnId 时旧轮不进脏集（防御性缺口，当前不可达）
- 文件：`conversationProjectionCore.ts:198-202`、`SessionPane.tsx:664`、`ConversationTimeline.tsx:480`
- 改法（**W1 执行期修正——原「同时 set 旧 turnId」写法实测为 no-op**：turnIdByRowId 是 rowId→turnId 的 Map，旧值 set 会被同键新值立即覆盖，脏集从 values() 派生永远取不到旧 turnId）：`ConversationProjectionLastMutation` 增 **`detachedTurnIds?: ReadonlySet<string>`**（collectMutationTurnIds 在改挂时收集旧 turnId）；两个 UI 调用点把它并进脏集。补 1 条 core 测试（同 rowId 改挂 → 旧 turnId 出现在 detachedTurnIds）。
- 来源：review-full r1 / data S2；W1 执行期换方案 A

### full/C-4 [P2] 目录降级项 unitIndex 是排序前插入序
- 文件：`conversationTurnNavigatorDirectory.ts:134/:146`
- 改法：sort 之后对降级项统一重编号；补交错 push 语料测试（降级项 unitIndex 严格等于最终下标）。
- 来源：review-full r1 / render S04

### full/C-5 [P2] 共享缓存不变量仅靠注释 + lastMutation 口径不对称
- 维度：C（一致性）/ G
- 文件：`SessionPane.tsx:4592` vs `:664`、`conversationProjectionCore.ts:29-38`、`conversationTurnRenderUnits.ts:176-186/:244-246`
- 问题：`timelineSnapshot===null` 时 Timeline 侧传 `lastMutation: undefined`（退化全量重建并回写共享缓存），shareRenderUnits 侧无条件传 → 两个 build 以不同 dirty 集交替写同一缓存；且清理循环 `if (!draftByTurnId.has(turnId)) cacheByTurnId.delete(turnId)` 在 rows 为空时清空整表。scopeKey/phase 同源不变量无运行时断言。
- 改法：(1) **写死「双双上提」方案（r3 修正——r2 的「上提到 :990」仍在消费点 :659 之后照样 TDZ；正解是声明必须在全部消费点之前）**：把 `sessionLeaseReady`（SessionPane.tsx:989，全局仅 :3578 一处消费，可安全上提）与 `timelineSnapshot` 声明（:3577-3580 四行）**一起上提到 :654 注释块之前（即 :659 的 shareRenderUnits 之前）**——依赖 isDraft(:589)/lease(:585)/snapshot(:587)/sessionLeaseReady/sessionId 届时全部就绪；`shareRenderUnits` 等区块的 **4 个 useMemo（:659/:668/:683/:687）结构不动**，仅两处随改：shareRenderUnits 的 rows 改 `timelineSnapshot?.rows.window ?? []` 且 **deps 同步把 `snapshot?.rows.window` 换成该表达式**，`timelineSnapshot===null` 时**短路不调用 build（shareItems 直接取空数组）**。**语义变更登记**：①切会话窗口内 shareRenderUnits build 空集、`:694` syncAvailableTurns 在 shareActive 时同步空集合（消除「旧 lease rows 进缓存再被清」的必要取舍）；②`:693/:763/:777/:1008` 等仍读 `snapshot?.rows.window` 的残留读点与 `:654-658`「同一份 rows.window」注释——随本条把注释改写为「share 侧走 timelineSnapshot 受闸口径（可为 null），其余派生仍读 snapshot 原口径」，避免不变量失真。(2) **空 rows 跳过清理但保持锚点语义**：清理循环前判 `rows.length === 0` 时跳过缓存删除**并显式置 `lastUnitTurnId = null`**（与空 rows 的现行语义一致——只跳过清理循环，不跳过 :247 的锚点更新，避免锚点保留陈旧值多标脏轮）。(3) 缓存句柄加 `assertScopeInvariant(scopeKey, sessionPhase)`——DEV 下与缓存内值不等时 `console.warn` 一次。**执行波次：归波次 1**（与 C-2/C-3 同批的投影层改动）。
- 验收：**新建 `packages/ui/test/conversationTurnRenderUnits.test.ts`**（波次 5 最先写）断言「空 rows 的 build 不清空 scopeKey 下既有条目」（配合改法(2)成立）+「传入与缓存内不同的 scopeKey/sessionPhase 时 assertScopeInvariant 告警一次」。
- 来源：review-full r1 / data S16+S17；r2 修正；spec-check r1/r2 两轮 TDZ 修正未果；**r3 修正（声明上提至消费点 :659 之前 + 残留读点登记 + 波次归属）**

### full/E-2 [P2] row.removed 对整窗线性扫描
- 文件：`conversationProjectionCore.ts:209-217`
- 改法：按 rowId 升序二分下界后只扫后缀；补等价性断言。
- 来源：review-full r1 / data S3

### full/E-3 [P2] 目录翻页到 50 页上限静默截断
- 文件：`conversationProjectionStore.ts:1451/:1433-1435`、`conversationProjectionCore.ts`（G-1 下沉后 stopReason 所在）、`SessionPane.tsx:3496-3511`、`useConversationProjection.ts:9-17`（CLOSED_TURN_DIRECTORY 常量）、`ConversationTimeline.tsx`（truncated 透传到 rail props）、`ConversationTurnNavigator.tsx`、i18n 两 locale
- 改法：break 前 `logger.warn`（pages/entryCount/realUserQueryTotal）；目录态增 `truncated` 并透传；rail 在 truncated 时顶部渲染提示（新 i18n key `chat.turnNavigator.olderEntriesNotLoaded`，双语参数化）。
- 验收：server 13 例不退化；i18n 双语对称；manual_user >25000 query 会话确认提示出现。
- 来源：review-full r1 / server-infra S3（配合 spec 偏差 #4 最小方案）

### full/E-4 [P2] 采样脚本 Windows 进程回收不完整 + 报告期二次解析可失败
- 维度：B（资源释放）/ K
- 文件：`scripts/dev/long-session-perf-sample.mjs:96-105/:403-422/:715`
- 问题：win32 下 `child.kill()` 杀不干净 electron 进程树；报告构造阶段再次调用 `resolveElectronExecutable` 可能失败（采样成功但报告写不出）。
- 改法：win32 用 `taskkill /pid <pid> /T /F`；electronExecutable 透传到报告构造阶段。
- 验收：manual——win32 中断场景（--skip-launch + 强制失败路径）后无残留 `electron.exe`；成功路径报告 JSON 正常写出且含 electronExecutable 信息。
- 来源：review-full r1 / server-infra S8

### full/D-1 [P2] 新 schema 数值约束松紧不一 + strict 意图未固化
- 文件：`packages/shared/src/zcode-protocol-v4/transport.ts:534/:559/:574`
- 改法：atSeq/queryRowId/beforeQueryRowId/limit 统一 `.int().nonnegative()`（limit 保留 min/max）；三个新 schema 头部补 JSDoc「有意不 .strict()：老客户端剥键而非解析失败，取舍同 rowsRange」。补 2 条边界断言。
- 来源：review-full r1 / shared S07

### full/J-2 [P2] gutter 占用条件与 rail 渲染条件不同源
- 维度：J（UI）/ C-orch
- 文件：`ConversationTimeline.tsx:1865-1866`（对照 `:1890` 渲染条件）
- 问题：`turnNavigatorOccupiesLeftGutter` 的条件与 rail 实际渲染条件不同源——rail 在 `items.length < 2` 时 `return null`、在 `hideTurnNavigator||turnNavigatorRailHidden` 时不渲染，而 gutter 条件不感知这两者（`Boolean(turnDirectory)` 恒真）→ rail 不存在时 48px 白占、rail 存在时可能不占位。
- 改法（r3 修正版·完整）：把 `ConversationTurnNavigator.tsx:100-121` 的**两个 useMemo（loadedItems 构建 + merge）都上提到 ConversationTimeline**；子组件 props 增 **`items` 与 `loadedItems` 两项**（后者供 `:125-128` 的 loadedItemByUnitIndex 与 `:134-145` 的已加载侧 active 判定使用——不传则子组件要么重复 O(N) 派生要么编译不过）；子组件删除 `:202` 的独立 `items.length < 2` 判定（保留 `:189` 的 effect 守卫）；父组件先算 `const turnNavigatorVisible = !hideTurnNavigator && !turnNavigatorRailHidden && items.length >= 2`（完整渲染条件，单一真源），`:1865` gutter 与 `:1890` 渲染**共用 `turnNavigatorVisible`**。**不得在父或子组件另算第二份 merge/build**。执行顺序：B-4 先（波次 4），其改动随块上移。
- 文件：`ConversationTimeline.tsx:1865-1890`、`ConversationTurnNavigator.tsx:100-121/:125-145/:202`
- 验收：manual_user：窄条目会话与分享选择态下 markdown 表格左 inset 均无 48px 空档；rail 可见时 gutter 恒占位；目录+已加载合并行为不回归（directory 测试仍绿）。
- 来源：review-full r1 / render S06+S09；r2 修正同源性；r3 补 merge 上提；**spec-check r1 修正（接口补 loadedItems，原接口照写要么重复 O(N) 要么编译不过）**

### full/G-3 [P2] 测试补强（6 项）
- 改法：apply.test 加 PATCH_BUILDERS 键集合守卫断言 + workflowRun 两 op 纳入生成器；core 测试加物化计数护栏（`__materializeCountForTest` seam，断言 ≤ 脏轮数+常数）；shiki 加满载命中用例 + subscribers 分支断言或文件头标注人工核验；directory 测试加三态字面量==协议枚举断言。
- 来源：review-full r1 / shared S02+S03、data S13、server S6+S7

### full/K-1 [P2] 收尾步骤（下游执行时闭合）
- 改法：(1) 全量门禁：`pnpm typecheck`（含 G-2 新增 tsconfig.test.json）/ `pnpm lint`（零新增）/ `pnpm architecture:check --changed` / **`pnpm test:v4-perf`（G-2 落地后必跑，含全部本期 blocking 测试）**；(2) ConversationTurnNavigator deps 数组格式统一；(3) Draft 文件 397/400 行余量登记风险；(4) refreshPlans 与 loadTurnDirectory 的平行状态机互加交叉注释（差异点+刻意不合并理由）；(5) full/F-1 后重算扫描量魔数；(6) 登记存量项：分享只读面 running 空 duration（BASE 同款非本轮引入）。
- 来源：review-full r1

## Spec deviations（处置建议，待用户确认后转 fixed）

| # | 偏差 | 状态 | 建议 |
|---|---|---|---|
| 1 | 摘要扫描量：spec「O(maxChars+段数)」在含长空白串输入不成立（实测最高 16667×） | open（收窄动作已落 full/F-1） | **收窄措辞**：「无长空白串输入 O(maxChars+段数)；含长空白串可达输入长度（逐字节等价必要代价）」——等价性是硬约束，不建议牺牲 |
| 2 | copy-on-notify「每通知帧三层换引用」→ full/E-1 收窄为「有行变更帧才换 window/rows」 | open（动作已落 full/E-1） | **确认收窄**（下游 memo 不更新是因内容未变，不违立意）；T-AP3 同步收窄 |
| 3 | Step 19 loading 态：实现仅无人消费的 DOM 属性 | open（动作已落 full/J-1） | **走补齐**（接线到 rail aria-busy+点击禁用），spec 不收窄 |
| 4 | >500 条 query 的 rail 呈现 | open（动作已落 full/E-3） | **最小方案**（truncated+提示）；「目录可继续上拉」为范围外扩展 |
| 5 | S9 未做（中期采样） | open（维持登记） | 终验已覆盖对比价值 |
| 6 | 单页目录无发起时 revision 比对闸 | open（维持登记） | 缓解链经 r1 复核完整，不升级 |
| 7 | renderUnits「上一末轮被 keep 过滤」理论残留 | **fixed**（r1 复核关闭） | 锚点实际取保留末轮，T-AP4 场景二覆盖 |
| 8 | timelineSnapshot===null 帧缓存清空 | open（已升级并入 full/C-5） | 按改法三件套落地 |

## Open questions / 待拍板
1. apply 等价性测试以被测对象自身为 oracle（两版同错盲区）——建议接受并在测试头标注盲区边界（独立模型成本高）。
2. scrollToQuery 跨 await 切会话的 lease 关闭时机——证据未认定，建议 fix 执行时顺手取证（若旧 store 未先 close 则补 must-fix）。
3. 组件/DOM 层零自动化覆盖（8 项行为仅 manual_user）——建议下轮单独立项引入 DOM 测试基建，本轮不做。

## 已豁免（用户确认不修）
- 无。

## 合并后 QA（manual_user，不阻塞）
- full/B-1：主 pane+侧 pane 不同会话各自滚动，active/跳转落点在本 pane。
- full/E-3：>25000 query 会话确认 truncated 提示出现。
- full/J-2：窄条目会话与分享选择态无 48px 空档。
- full/E-1：重跑终验采样对比（流式期长任务进一步下降）。

## Fix-Spec Closure

| 项 | 状态 |
|---|---|
| fix-spec-ready | **yes**（r3 定点复核预置条件全部满足：B-1/E-1/C-5/F-1/J-2/deviations/E-4 七点闭合） |
| fix_spec_path | docs/iterations/desktop-long-session-perf/cr-fix-spec.md |
| dag_version / review_round | 7 / 5（spec-check-loop r3 + r4 回填后） |
| P0 / P1 / P2（已写入 fix-spec） | 1 / 8 / 13（共 22 条，全部含文件+改法；验收或独立成行或内嵌于改法/归入 K-1 收尾） |
| 未写入的开放 must-fix | 0 |
| spec_deviations | open×7（#1-#4 待用户拍板、#5/#6 维持登记、#8 已并入 C-5）/ fixed×1（#7） |
| C-orch | ✅（B-1 读取端过滤=必要 hop 修正；J-2 单一真源；E-1 引用复用消除下游重复计算） |
| C 类合并后 QA | B-1 双 pane 滚动 / E-3 truncated 提示 / J-2 无 48px 空档 / E-1 终验采样复跑 |
