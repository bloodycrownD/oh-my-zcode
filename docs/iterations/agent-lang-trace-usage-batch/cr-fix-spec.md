# CR Fix Spec: agent-lang-trace-usage-batch

## 元信息
- repo: D:\Dev\Js\oh-my-zcode
- base_sha: 1b181fd4 / head_sha: 76e56701（branch agent-lang-trace-usage-batch）
- spec_path: docs/iterations/agent-lang-trace-usage-batch/spec.md
- review_round: 3（r1 四 scope + r2 review-full + r3 定向复核）+ spec-check r1 Go
- dag_version: 4
- 状态：execute-ready（fix 执行书就绪，待用户确认开工）

轮次结论：r1 四 scope **P0=0 / P1=0 / P2=12**；r2 review-full 新增 **P1=1** + **P2=3** + 4 处修订；r3 定向复核确认 r2 修订全部落地、Tailwind v4 命名组语义实测成立，补 2 处文档级修订后收口——最终 **P0=0 / P1=1 / P2=14**（P2-4 行数问题关闭不计）；spec_deviations none。

---

## Must-fix（P1 → P2，按 scope → 严重度排列）

### turns/B-1 [P1] 回合外壳 group 变体失效——必须用**命名组**修复（裸 group 会污染回合内消息行）
- 维度：B / C（跨文件组合；r2 升级：r1 的裸 `group` 改法本身引入回归）
- 文件：packages/ui/src/ModelTrajectoryTurnGroup.tsx:46（受影响 :75、:109）；受污染方 ModelTrajectoryExpandableMessage.tsx:135-226（11 处裸 group-data-[state=open] 变体）
- 问题：Collapsible 根节点无 `group` 类，:109 chevron `group-data-[state=open]:rotate-90`、:75 assistant 预览 `group-data-[state=open]:hidden` 永不命中——箭头不旋转、lg 宽度下展开后预览与内容重复。**但 r1 裸 `group` 改法有毒**：Tailwind v4 编译为 `&:is(:where(.group)[data-state="open"] *)`，匹配**任意祖先** .group[data-state=open]——回合展开后回合内所有消息行（自身 data-state=closed）也会命中：摘要被隐藏、操作区显示、sr-only 翻转、chevron 旋转，全面 UI 回归。
- 改法：回合根改用**命名组** `group/turn`；TurnGroup 自身两处变体改为 `group-data-[state=open]/turn:hidden`（:75）与 `group-data-[state=open]/turn:rotate-90`（:109）。**禁止裸 `group`**。（备选：group 挂两个 CollapsibleTrigger，Radix Trigger 自带 data-state 天然隔离。）
- 验收：①展开回合：chevron 旋转、assistant 预览隐藏；②**回归项**：展开回合后单独收起的消息行仍显示摘要/收起箭头；消息行自身展开时摘要隐藏/箭头旋转；③任意窗口宽度成立。
- 来源：review-scope-turns r1（P2）→ review-full r2 升级 P1（改法修订）

### turns/B-2 [P2] 搜索索引包含被占位过滤隐藏的行——搜 `dropped` 时「计数前进但画面不动」
- 维度：B（B-4 与 B-7 跨特性集成）
- 文件：ModelTrajectoryPane.tsx:95-103（searchItems memo）、ModelTrajectoryTimeline.tsx:146-159（resolveTrajectorySearchItems 现居处；随 turns/C-1 迁 ModelTrajectoryTurns.ts，行号随之迁位）、ModelTrajectorySearch.ts:36-43（TrajectorySearchTimelineItem 字段定义）、:90-120
- 问题：`resolveTrajectorySearchItems` 用 delta 投影后的全量 inputMessages 建索引；而 CallInputSection 默认 hidePlaceholders=true 把占位行移出 DOM。搜索占位文本（dropped/truncated/cleared/§N§——诊断场景高频查询）时命中隐藏行，getMatchRange 返回 null，高亮与滚动都不动作但 N/M 计数前进。
- 改法（r2 修订：签名+字段去留明确）：
  1. `resolveTrajectorySearchItems(turnGroups, hidePlaceholders: boolean)`（签名显式收开关）；
  2. `TrajectorySearchTimelineItem` 的 `inputMessages` **替换为** `inputRows: { message; messageIndex }[]`——由 `classifyTrajectoryWireRows(call.inputMessages)` 产生，hidePlaceholders 时滤掉 placeholder（避免 inputMessages 变死字段）；buildSearchTargets 用 `trajectoryInputRowKey(item.key, row.messageIndex)` 生成（见 ui/C-1-r2，勿先写裸模板再返工）；**Turns.ts 对 classifyTrajectoryWireRows 用 `./ModelTrajectoryWireFilter.js` 相对导入**（Turns.ts 硬约束零 `@/` 别名；Search/Timeline 侧才用 `@/`）；
  3. Pane 的 searchItems memo 依赖加入 `hidePlaceholderRows`。
  **禁止**过滤后按下标重排（expansionKey 与 DOM target 错位）。
- 验收：载体指定 `packages/ui/test/modelTrajectoryTurns.test.ts` 新增用例：构造含 assistant 占位行的 turnGroups，`resolveTrajectorySearchItems(groups, true)` + buildTrajectorySearchIndex 断言无该行命中；`false` 时命中且 key === 渲染 expansionKey；切换「显示占位行」后索引重建（memo 依赖变更）。原有 turns/wire 测试保持绿。
- 来源：review-scope-turns r1 → review-full r2 修订

### turns/C-1 [P2] TrajectorySearchMatch.callIndex/callKey 死字段 + 注释「= recordIndex」不成立；验收载体须迁纯模块
- 维度：C（死代码/注释漂移）
- 文件：ModelTrajectorySearch.ts:13-22、:90-95；ModelTrajectoryTimeline.tsx:146-159（resolveTrajectorySearchItems）；ModelTrajectoryTurns.ts:163
- 问题：callIndex 旧消费者（scrollToIndex）已改 turnIndex，全仓无读取；callKey 自 base 起无消费者；扁平下标在 turnId 非连续交错时 ≠ recordIndex，注释误导。**r2 补**：该函数现挂 React 组件模块（@/ 别名），`tsx --test` 无法解析——原验收「交错 fixture 断言」跑不起来。
- 改法：①`resolveTrajectorySearchItems` 从 Timeline.tsx **迁入 ModelTrajectoryTurns.ts 纯函数区**（与 B-2 同批落地，迁移后 Timeline 只消费、Pane 的 import 从 Timeline 改指 Turns；Turns.ts 对 `TrajectorySearchTimelineItem` 必须 `import type`——verbatimModuleSyntax 下否则纯测试经 Search.ts 载入 React）；②删除 TrajectorySearchMatch.callIndex、SearchTarget.callIndex、callKey；③ModelTrajectoryTurns.ts:163 注释改「在入参 records 数组中的全局下标，用于 `<requestId>:<recordIndex>` expansionKey 与搜索键」；④`items.flatMap((item, callIndex)` 的 callIndex 形参一并删除（否则 lint 红）。callIndexInTurn 保留（spec B7）。
- 验收：新增交错 fixture（turn-a 位于 record 0/2、turn-b 位于 1）断言 resolveTrajectorySearchItems 的 key 序列**按回合首现、回合内 recordIndex 升序**展开（即 `["reqA:0","reqA:2","reqB:1"]` 形态，非全局 recordIndex 升序——分组按首现顺序）；载体：packages/ui/test/modelTrajectoryTurns.test.ts，迁移后可直测，调用带第二参 hidePlaceholders；typecheck/oxlint 绿。
- 来源：review-scope-turns r1 → review-full r2 修订（载体迁移）

### turns/C-orch-1 [P2] 回合展开两条入口：override 清理与取值方式不一致（stale closure 双击不翻转）
- 维度：C-orch/C
- 文件：ModelTrajectoryPane.tsx:123-144
- 问题：handleToggleAll（:123-136）与 handleToggleExpansionKind("turn")（:137-144）写同一 expansionCommands.turn；前者清 turn: override+闭包取值，后者保留 override+函数式更新。同一 tick 双击时前者不翻转。
- 改法（r3 修订：统一函数式更新为必选）：抽 `toggleTurnExpansion()` **统一为函数式更新 + 清 `turn:` override**，两入口（handleToggleAll 与 handleToggleExpansionKind("turn")）共用；不采用「委托 handleToggleAll」选项（保留闭包取值，不修双击丢翻转）。
- 验收：仓库 ui 测试均为纯函数 node:test（无组件基建），双击行为归合并后 QA 手工项（见 QA 清单）；代码级验收=两入口都走同一函数式路径（代码审查确认无闭包取值残留）、消息行 override 两路径都不清。
- 来源：review-scope-turns r1 → review-full r3 修订（改法必选化+验收措辞）→ spec-check r1 载体修正

### ui/C-1-r2 [P2] `requestId:recordIndex` 与 `:input:messageIndex` 两段 key 契约五处独立模板（B-2 验收依赖项）
- 维度：C（DRY）
- 文件：ModelTrajectoryTurnGroup.tsx:144、:127（Fragment key 同模板）、ModelTrajectoryTimeline.tsx:151（随 C-1 迁位）、ModelTrajectorySearch.ts:100、ModelTrajectoryCallInput.tsx:90
- 问题：B-2 验收要求搜索 expansionKey「与渲染完全一致」，但该契约是五处独立字符串模板无单一来源；任一处漂移让搜索命中静默丢定位（正是 B-2 要修的失效形态）。
- 改法：在 ModelTrajectoryTurns.ts（零 React/别名）导出 `trajectoryCallKey(requestId, recordIndex)` 与 `trajectoryInputRowKey(prefix, messageIndex)`，五处（含 TurnGroup:127 Fragment key）改用；与 B-2/C-1 同批提交。
- 验收：`packages/ui/src` 范围 grep `<requestId>:<recordIndex>` 字面模板与 `:input:${` 仅命中 helper（范围外如 magic-context 的 `${callId}:input:${ordinal}` 无关命名空间不计）；turns/wire 测试绿。
- 来源：review-full r2 → r3 修订（第五处+验收范围）

### ui/C-2-r2 [P2] `filterTrajectoryWireMessages` / `TrajectoryWireFilterResult` 生产零消费（双轨回流诱导）
- 维度：C（死代码）
- 文件：packages/ui/src/ModelTrajectoryWireFilter.ts:65-83；测试 packages/ui/test/modelTrajectoryWireFilter.test.ts:13、:112-155
- 问题：cr-func P2-3 后 UI 唯一入口已是 classifyTrajectoryWireRows；filterTrajectoryWireMessages 只剩测试在用，且返回丢原下标的 visible 数组——保留会诱导刚消除的双轨用法回流。
- 改法：删除函数与 TrajectoryWireFilterResult 类型；测试改 `const { rows, hiddenCount } = classifyTrajectoryWireRows(...)` 自行聚合断言（visible = rows.filter(r=>!r.placeholder).map(r=>r.message)）。
- 验收：grep 无残留；WireFilter 8 用例仍绿；typecheck/oxlint 绿。
- 来源：review-full r2

### svc/F-1-r2 [P2] 新增测试缝导出 expandModelIODeltaRecords / expandMessageCollection 缺中文文档注释
- 维度：F/C
- 文件：packages/services/src/zcode-agent/modelTrajectory.ts:222（expandModelIODeltaRecords）、:285（expandMessageCollection）
- 问题：二者是 spec B2 明文要求的新增导出，无文档注释；expandMessageCollection 会**原地修改 target**、head 合并有双条件门——签名上看不出契约，文件外无法安全复用。
- 改法：各补 1-2 行中文文档注释（入口/会 mutate target/head 双条件门/不改 previous）。
- 验收：零行为变化；typecheck 绿。
- 来源：review-full r2

### lang/C-1 [P2] runtimeEnv.ts 注释把 NON_TOOL_PASSTHROUGH 名单语义写错
- 维度：C（注释准确性——该注释是载荷键唯一契约文档）
- 文件：packages/shared/src/runtimeEnv.ts（ZCODE_UI_LOCALE_ENV_KEY 注释）
- 问题：注释称两个名单都「从子进程 env 剔除」；实际仅 SANITIZED_RUNTIME_ENV_KEYS 删键，NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS 只排除 tool env passthrough 恢复集合（本键本不在采集范围，列入无效果）。误导后续维护者。
- 改法：按实际语义改写——SANITIZED 名单会删键（列了会丢）；NON_TOOL_PASSTHROUGH 不删键、本键不在采集范围，列入无实际效果但同样不应列入以免误导。
- 验收：纯注释；lint/typecheck 不回归。
- 来源：review-scope-lang r1

### lang/C-2 [P2] test-prompt-language-rpc.mjs 头段依赖清单缺 provider build
- 维度：G（载体可运行性/文档同步）
- 文件：apps/zcode-cli/packages/bootstrap/scripts/test-prompt-language-rpc.mjs（文件头）
- 问题：E 组用例经 dist 的 runtime-config.js 静态导入 @zcode/provider（exports 指向 src/*.ts，裸 node 无法加载），脚本已把 provider 固定进 dist 解析，但头段依赖清单未列 provider——干净环境按文档跑直接 fatal。
- 改法：头段依赖命令改为 `pnpm --dir apps/zcode-cli --filter "@zcode/bootstrap..." build`（带 ... 一并构建依赖），或显式列出 `--filter @zcode/provider build`。
- 验收：清空 packages/provider/dist 后按头段命令构建，脚本 E1/E2 通过。
- 来源：review-scope-lang r1

### head/C-1 [P2] tail 合并注释把双条件门写成单条件——误导未来维护者删掉 collectionKey 判断
- 维度：C
- 文件：packages/services/src/zcode-agent/modelTrajectory.ts:301-302
- 问题：注释称门是 metadataSource===target；但 sdkMessages 的 metadataSource 默认就是 target，真正拦它的是 collectionKey==="messages"。信注释删 collectionKey 判断会把 head 拼进 sdkMessages（回归 spec 禁止的互覆形态）。
- 改法：注释改双条件门表述：metadataSource===target 排除 body；collectionKey==="messages" 排除 sdkMessages（与 canonical 共用 target，只能靠集合键排除）；head/tailMessages 取值同出 canonical 集合。
- 验收：无行为变化；T-T2 门用例仍绿。
- 来源：review-scope-head r1

### head/C-2 [P2] B2 提交夹带 6 处与需求无关的花括号删除（FORK 移植件风格纪律）
- 维度：C（diff 卫生）
- 文件：packages/services/src/zcode-agent/modelTrajectory.ts:78、:85、:90、:117、:379、:389（共 **6 处**）
- 问题：`if (!trimmed) continue;` 等原带花括号控制流被改为单行无括号，与文件其余代码及 FORK「不重排不改风格」纪律相悖，放大对账 diff 噪声。
- 改法（r2 修订：还原为强制项）：仅还原 6 处格式 hunk 为原花括号形式，零逻辑变化。r2 实测本机 oxfmt 对「还原花括号」副本 `--check` 通过（oxfmt 无删花括号规则），无「工具主导豁免」分支。
- 验收：还原后 `git diff 1b181fd4..HEAD -- <file>` 无纯格式 hunk；T-T2 全绿；`npx oxfmt --check <file>` 通过。
- 来源：review-scope-head r1 → review-full r2 修订（处数 6、删豁免分支）

### head/G-1 [P2] T-T1 对 sdkMessages 的 head 负断言恒真（`in` 检查数组对象属性）
- 维度：G
- 文件：apps/zcode-cli/packages/adapters/scripts/test-runner-debug-head.mjs:150（:151/:152/:153 为同型风格项；:152 实为单键 `"sdkMessagesHead" in request` 检查）
- 问题：`assert.equal("messagesHead" in request.sdkMessages, false)` 对数组做 in 检查恒 false，是无效证据（真实保护来自 :147 的 deepEqual）。
- 改法（r2 修订：原提议 filter 三键等价恒真式，覆盖不了 sdkMessagesHead/bodyMessagesHead）：删除 :150 该行；补 `assert.deepEqual(Object.keys(request).filter((k) => /head/i.test(k)).sort(), ["headMessageCount","messagesHead","messagesHeadTruncated"])`（正则键集合比对，顶层 head* 键漂移都能红）；:151/:152/:153 的 in 统一改 Object.hasOwn（:152 的 in 本身有效，一并风格统一）。**执行修正（cr-func-fix 实证）**：request 落盘含真实字段 `headers`（值 {}），字面 /head/i 必命中致断言必红——断言加 `&& key !== "headers"` 排除（cr-func 判定：保住原语义「任何 head* 键漂移即红」）。
- 验收：T-T1 四用例仍绿；人为把 attachMessagesHeadForTail 挂到 canonical body 或新增顶层 head* 键时断言能红（sdk 侧数组属性经 JSON 序列化本就丢弃，防线是 :147 deepEqual——验收不要求「挂到 sdk 能红」）。
- 来源：review-scope-head r1 → review-full r2 修订（断言重写）→ spec-check r1 措辞修正

### usage/G-1 [P2] test-ctx-commands 固定行号断言脆（BUDGET 段行增删即假红）
- 维度：G/C
- 文件：apps/zcode-cli/packages/cli/scripts/test-ctx-commands.mjs:147-153
- 问题：lines[3]/[9]/[13] 硬行号断言段序；同文件 formatCtxStatus 测试已用 titles+空行唯一性做段序——固定行号是重复且更脆的覆盖。
- 改法：删三条行号断言，改相对顺序断言（indexOf("Budget") > 0 && < indexOf("Compartments") && < indexOf("Tags")），保留 lines[0]/[1] 与逐行 includes。
- 验收：test:ctx-commands 通过；临时增删 BUDGET 行不再因行号失败（验证后还原）。
- 来源：review-scope-usage r1

### usage/G-2 [P2] e2e 对环境硬假设：wal/shm 必在 + mtime 严格相等与脚本自身提示矛盾
- 维度：G
- 文件：docs/iterations/agent-lang-trace-usage-batch/e2e/e2e-agent-lang-trace-usage.mjs:660-674、:818-826
- 问题：C-0-2 要求源库必有 -wal/-shm（干净关闭后 SQLite 可删）；C-0-4/C-3-1 用 mtime/大小严格相等证「未写源库」，但真实 CLI 并发写入改变二者（:827-829 自己承认）。
- 改法（spec-check r1 收口二选一）：C-0-2 改「主库必拷+源库实际存在的 wal/shm 必在 copiedParts，缺失打提示不失败」；C-0-4/C-3-1 **只做提示 + 断言源库仍存在**（不做大小比较——并发 VACUUM 仍可能假红）；「未写源库」硬证据保持 C-1-1 隔离路径+copy-only 设计。
- 验收：有/无 wal 两种源库状态均不假红；并发写入时只输出提示。
- 来源：review-scope-usage r1 → spec-check r1 收口

### usage/G-3 [P2] e2e 硬编码 schema 10000（下次 migration 即假红）
- 维度：G
- 文件：docs/iterations/agent-lang-trace-usage-batch/e2e/e2e-agent-lang-trace-usage.mjs:756
- 问题：C-2-2 期望值硬编码 `10000`——下一次 migration 落库后 e2e 必假红；该常量已由 storage-db.ts:170 导出且 `mcStorageDb` 已在 :680 导入，无理由硬编码。
- 改法（spec-check r1 收口二选一）：C-2-2 期望改用 `mcStorageDb.LATEST_SUPPORTED_VERSION`（已 import、常量变化自动跟随；勿用「>=10000+注释」分支）。
- 验收：改后 C-2-2 通过；常量变化时断言自动跟随。
- 来源：review-scope-usage r1 → spec-check r1 收口

---

## Spec deviations
- none（r1 四 scope 复核：既有 6 条裁定全部成立；B3-B11/C1-C2/A1-A8 逐条落地）

## Open questions / 待拍板（附录，不阻塞）
1. [lang] A4 捕获时机：首次安装+英文系统下 Host 若早于 renderer 回写捕获，首轮可能 zh-CN（既有 useSystemLanguagePromptSync 兜底纠正）。建议 Step4 真机英文系统对照观察。
2. [lang] run.ts 不校验 ZCODE_UI_LOCALE 合法域（非空即转发；坏值压掉 env 回落）。spec 契约宿主传具体值，未认定缺陷；如需防御用 isSupportedLocale（勿用 isUiLocale——误收 "auto"）。
3. [lang] test:prompt-language-rpc 未挂根 test:v4-perf（BASE 同样，非本次引入）。
4. [lang] desktopHostProcess.ts HostInitMessage 手写复制 zod schema 无编译期联动（既有一贯做法，后续重构议题）。
5. [head] messagesHeadTruncated 只落盘不映射（croppedCount 已覆盖 UI 需求）——维持现状+补注释？
6. [head] messageOffset 不可解析时回退 headMessageCount 可能与未知 offset tail 重复——维持现状（仅畸形记录触发）。
7. [head] head 完整性展示口径（新派生字段 vs croppedCount>0）——产品口径。
8. [head] FORK 标记粒度三种写法不统一（不阻塞，顺带统一可并入任一 fix 提交）。
9. [turns] 回合预览 full-context 分支取「最旧」真实 user 消息（T-T4 钉死「取第一个」；改「首条调用内最后一个」需同步改测试语义）——拍板。
10. [turns] CollapsibleContent overflow-hidden 使 CallCard sticky 表头在回合内可能不吸顶——Step7 真机观感验收项。
11. [turns] callIndexInTurn 无消费者（spec B7 要求携带；定位靠 turnIndex+文本 range）——注释写明元数据即可？
12. [turns] fallback key 追加 #recordIndex 跨刷新稳定性（200 滑窗前移即变，仅影响无 turnId+重复 requestId 极端记录）——拍板。
13. [usage] .tools/ 是否进 .gitignore（lint ignore 已解决门禁；git status 仍显 ?? .tools/）。
14. [usage] e2e 依赖本机真实库（可 MC_E2E_REAL_DB_DIR 覆盖）+copyFileSync 非事务快照——是否接受。
15. [usage] C2 说明行仅在 magicContextRows.length>0 时渲染+无组件级渲染断言——按 T-U2 口径接受？
16. [turns] 占位判定尾随空白口径：ModelTrajectoryTurns.ts:58 只 trimStart() 测 `^\[...\]$`，WireFilter.ts:30-31 全量 trim()——`[dropped §7§]` 带尾随空白时回合预览会当真实用户输入（与 B-4 占位语义分叉）。是否统一 trim()？
17. ~~[turns] resolveTrajectorySearchItems 归属~~（已关闭：被 turns/C-1 改法吸收）。

## 已豁免（用户确认不修）
- （空）

## 合并后 QA（manual_user）
- Step4 语言链真机：系统语言=默认+中文 → 新窗口新会话首轮系统提示词中文（+英文系统对照观察 OQ1）。
- Step7/8 轨迹观感：回合默认收起/头部预览与 stats/展开 CallCard/croppedHint/搜索命中展开定位/占位隐藏 toggle/全部展开收回合级/旧 DOM 锚点/per-turn 列对齐差异（OQ10 sticky 吸顶一并观察）。
- **turns/B-1 回归项**：展开回合后，单独收起的消息行仍显示摘要/收起箭头；消息行自身展开时摘要隐藏/箭头旋转（任意窗口宽度）。
- **turns/C-orch-1 手工项**：连续两次快速点「全部展开/收起」或「turn」菜单项——两次点击各生效一次（最终回到原状态，不丢翻转）；消息行自定义展开状态不被回合级操作清除。

## K 节建议（下游执行时闭合）
- 全量门禁复跑：根 typecheck（含 tsconfig.test.json）+ pnpm lint + test:v4-perf + 受影响包脚本 + i18n parity + desktop-full + architecture。
- e2e 复跑（53/53 为基线，usage/G-2/G-3 改动后断言数可能 ±）。
- ~~`pnpm knip` 抽查新增测试缝导出无未用残留~~（保留：配合 ui/C-2-r2 删除死导出后执行）。
- ~~更新 .iteration-state.yaml 的 dev_ready.head_sha~~（已闭合：76e56701，r2 期间主代理顺手改）。
- 提交信息沿用「fix(cr): …」前缀，注明 fix-spec 条目 id。

## Open questions 追加（r2；已并入上方主清单 #16/#17）

---

## Fix-Spec Closure

| 项 | 状态 |
|---|---|
| fix-spec-ready | yes（待用户确认） |
| fix_spec_path | docs/iterations/agent-lang-trace-usage-batch/cr-fix-spec.md |
| dag_version / review_round | 3 / 3 |
| P0 / P1 / P2（已写入 fix-spec） | 0 / 1 / 14 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none |
| C-orch | ✅（turns/C-orch-1 已列；A 章链路 r1 判定通道单一无平行路径） |
| C 类合并后 QA | Step4 语言链真机 + Step7/8 轨迹观感（含 sticky 吸顶 OQ10） |
| 审查轮次 | r1 四 scope（12 P2）→ r2 review-full（1 P1 + 3 P2 + 4 修订）→ r3 定向复核（2 文档级修订 + 勘误）→ spec-check r1 **Go**（10 P2 文档精化已 doc-fix 闭合：二选一收口/验收载体指定/交错 fixture 期望写死/相对导入约束/QA 手工项补齐/T-T4 勘误/OQ 归并） |

## 执行记录（fix-cr，2026-10-20）

- 执行 commits（76e56701 → c224ece0，4 commits / 15 文件 +343/−134）：
  - `d545f5f7` fix-turns〔turns/B-1,B-2,C-1,C-orch-1,ui/C-1-r2,ui/C-2-r2〕——测试 38→22+8 用例（含交错 fixture 与隐藏零命中新用例）
  - `1e920e04` fix-head-svc〔head/C-1,C-2,G-1,svc/F-1-r2〕——T-T2 8/8、T-T1 4/4、oxfmt 绿
  - `4f49e3a9` fix-usage〔usage/G-1,G-2,G-3〕——13/13、e2e 53/53
  - `c224ece0` fix-lang〔lang/C-1,lang/C-2〕——干净 dist 构建 E1/E2 12/12
- verify：根 typecheck / lint / test:v4-perf 三绿
- cr-func-fix：**func-ready yes**（15/15 矩阵落地、0 must-fix、0 spec_deviations）
- 执行偏差入档（cr-func 判定均可接受）：
  1. head/G-1 断言排除 `headers` 真实字段（字面 /head/i 必红；排除后仍保「head* 键漂移即红」语义）
  2. `modelTrajectory.ts` 加 `oxlint-disable max-lines` 豁免（还原花括号后 398→410 行超 400；仓库有 snapshot.ts/UsageHeatmap.tsx 两处同类先例；风险=该文件后续增行不再告警，属仓库规则级偏离）
  3. `ModelTrajectorySearch.ts` 两条包内导入 @/→相对路径（根 tsx --test 载体必需；Search→Turns→WireFilter 运行时无环、Turns→Search 仅 import type）
  4. e2e C-0-2「无 wal 分支」未实测（本机有 wal），代码审查判定无假红路径
