# CR Fix Spec: bugfix-batch-20261009（六缺陷修复批次 CR）

## 元信息
- repo：D:\Dev\Js\oh-my-zcode\omz；分支 dev/bugfix-batch-20261009
- base_sha / head_sha：0eb7674 / 5a35027（11 commits）
- spec_path：docs/iterations/bugfix-batch-20261009/spec.md（PRD 无，用户口述）
- review_round：4（code-review-loop 2 波；spec-check r1/r2 No-Go→r3 Go；r4 新增 3 项（用户拍板本期）→ **r4 Go**，计数/措辞微修已落）
- dag_version：5
- 状态：execute-ready（待用户确认开工）

## Must-fix（按 P1 → P2；本批无 P0）

### P1（7 条）

#### mc/A-1 ⑤ disabled 事件生产不可达（兼收 mc/C-orch-1 事件单点化）
- 维度：A + C-orch；来源：review-scope-mc r1
- 文件：`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:801-814`、`apps/zcode-cli/packages/bootstrap/src/app/magic-context-turn-transform.ts:914-921`、新增 `apps/zcode-cli/packages/bootstrap/src/app/magic-context-absent-event.ts`
- 问题：`create-app.ts:802` 仅在 `magicContext.enabled === true` 时才动态 import 工厂，flag 关时工厂永不执行，`transform_absent(reason=disabled)` 一次不发——spec Step 1（blocking）要消灭的「静默停机」在 disabled 形态依旧静默；T4 之所以绿是绕开 create-app 直构工厂（测试绿、生产哑）。另三事件发射点分两处、事件名/reason 词表为重复字面量无类型约束。
- 改法：① 新增零依赖 leaf 模块 `magic-context-absent-event.ts`：导出 `MAGIC_CONTEXT_TRANSFORM_ABSENT_EVENT` 常量、`MagicContextTransformAbsentReason` union（disabled|import_failed|db_null:migration_guard|db_null:fence|db_null:pending_or_unclassified，r2 校正——与 :815/:971 真实发射值一致，原枚举漏了 db_null: 前缀）与 `emitMagicContextTransformAbsent(logger, reason, detail)`；② create-app 的 enabled gate 补 else 分支（不 import 工厂模块）**调 leaf 的 `emitMagicContextTransformAbsent(logger, "disabled", detail)`**（leaf 零依赖，import 无启动成本——勿裸写 logger.warn，否则违反验收「生产发射点仅剩 leaf 一处」），import_failed 分支与工厂内 `emitTransformAbsent` 全部改调 leaf 模块；③ 工厂 disabled 分支注释标注「生产由 create-app 侧发射，本分支保留给直构/测试」。
- 验收（r2 口径校正；r3 补测试缝）：**新建 `bootstrap/scripts/test-magic-context-absent-event.mjs`**，机制：子进程驱动 create-app 路径（enabled!==true）+ `module.register` resolve hook 断言 magic-context-turn-transform 模块零加载 + 可控 dataDir 断言无 db 文件 + 子进程回传日志断言捕获 disabled 事件（leaf 的 emit helper 形状可另做进程内直测）；生产发射点（logger event 字段赋值处）仅剩 leaf 模块一处——注释（create-app.ts:796 等）与测试消费侧（test-boot-busy-retry.mjs 多处 eventsOf）的字符串不受此限，勿用全仓字面量计数核验；T1/T4/T5/T6 不回归。
- 对应 deviation：⑤-disabled-open（闭合转 fixed）

#### uix/B-1 ⑥ 截断触发仅覆盖交错竞态——自然退出+超限文件主事故形态零覆盖（r1 修订：并入 N-1 结果面信号）
- 维度：B；来源：review-scope-ui-exec r1 + review-full r1 修订
- 文件：`apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-run.ts:110-114,251-257,333-343,351-352,365-368`、`bash-file-output.ts:200-222`
- 问题（r1 修订措辞）：`outputLimitDetected` 并非死标志——onLimit 在 requestStop 前无条件置位，晚到 stat 在 exit 已派发时被 `watchTimer!==timer` 判废，但「stat 先解析、exit 同一微任务窗口后派发」的交错里标志可达、截断会发生（窄覆盖存在，不得按删死代码处理）。真正缺口：子进程自然退出且无任何 stat 落窗 → 两标志皆 false，超限文件不截断——这正是 ⑥ 的主事故形态。且无论新旧路径，该场景 `outputLimitExceeded` 恒 false → cancelled 不置位、status="completed"、failure 为空：磁盘文件被物理截断后用户毫无感知（N-1；uix/B-1 修复后该路径变主路径、问题放大）。
- 改法：① 截断分支改为收尾状态判定——`else if (outputLimitExceeded || (await isBashOutputOverLimit(file.path, limit)))`（只 stat 比较的轻判定，或让 truncate helper 自判 `size <= limitBytes` 返回 undefined——bash-file-output.ts:56 已有此自判形状可复用）；保留既有交错窗口覆盖语义（r2 注：stat 判定在标志置位场景恒真，保留 `outputLimitDetected ||` 仅为省一次 stat IO 的快路径，实施时注明此意）。② 结果面（N-1）：截断实际生效时在 result 附不改变 status 的可见说明（failure message 或 debug 通道「output file truncated (head/tail kept)」），保持 completed 不谎报 killed、也不静默。
- 验收：T-C1 补两例：a) 子进程自然退出但文件超限 → 仍截断；b) 截断发生时 status 仍 completed 且结果含截断说明。既有 14 例不回归。

#### uix/B-2 ⑥ 截断窗口预算未扣除 marker，1MiB 下限场景贴边
- 维度：B；来源：review-scope-ui-exec r1
- 文件：`apps/zcode-cli/packages/adapters/src/exec/bash-file-output.ts:47-80`、`node-execution-adapter-run.ts:336-342`
- 问题：`BASH_OUTPUT_TRUNCATE_MARKER_MAX_BYTES` 已定义未使用（死常量）；头尾窗口收缩未预留 marker 预算，env=1MiB 时截断后体积恰等于 limitBytes+marker，靠 256B slack 侥幸通过，marker 文案一变即越界。
- 改法：`const budget = Math.max(0, limitBytes - BASH_OUTPUT_TRUNCATE_MARKER_MAX_BYTES); headKeep = min(headKeepBytes, floor(budget/2)); tailKeep = min(tailKeepBytes, budget - headKeep);` doc 注释对齐。
- 验收：T-C1-3a 增加 `finalBytes <= limitBytes` 硬断言（不含 slack）；1MiB 用例双跑。

#### uix/A-1 ② guard 释放信号竞态——measurementsCache 非响应式快照可致误释放且不可恢复
- 维度：A+B；来源：review-scope-ui-exec r1
- 文件：`packages/ui/src/v4/timelineRowHeightCache.ts:138-170`、`packages/ui/src/v4/ConversationTimeline.tsx:1701-1760`
- 问题：释放信号读 tanstack-virtual 内部 `measurementsCache`（非组件拥有的观测），同 commit 内陈旧 key 可让 `tryRelease` 在首次真实测高前误释放；guard 一次性（armed 不可恢复），误判=本会话永久回退跳顶形态，且两个既有 effect 已让位无兜底。
- 改法（r2 补契约：tracker 必须 per-arm 代际）：释放判据改为组件自有信号——measuredKeys tracker 提取为可测纯模块（写点 = ConversationTimeline.tsx:794-806 measureElement 与 :1188-1201 cacheHeight 两处），释放 effect 判 `isArmedFor(sessionKey) && measuredKeys.has(首个 unit key)`。**tracker 在 arm()（切会话武装）时清零（或 generation 计数按当前 arm 过滤），只收本 arm 周期内两写点新写入的键；分区仅防跨会话串键，不得跨 arm 保留**——heights 缓存（timelineRowHeightCache）是跨会话持久 LRU 且切会话刻意不清（clearSession/clear 注释明令切会话路径禁调），若 tracker 与缓存同源持久，A→B→A 重访会在首个 commit 用旧键误释放（跳顶回归借 tracker 复活）。
- 验收（r2 补 d）：node:test 对 tracker 写例：a) 空 tracker + armed → 不释放；b) 首个 key 写入后恰好释放一次；c) 跨分区键不串；d) **A→B→A 重访：arm 后首个 commit 不释放（仅旧键在册不算数），本会话新测高写入后才恰好释放一次**。既有 21 例不回归；组件两写点接线人工核对。

#### agent/G-1 ① sendText 主路径 pin 零测试覆盖
- 维度：G（兼 A 覆盖声明准确性）；来源：review-scope-agent-chain r1
- 文件：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts:200-203`；测试 `bootstrap/scripts/test-edit-retry-model.mjs`
- 问题：pin 全集声称五路径，T-E1 只测四条；sendText 的置 pin 行两个静默失效方向（恒 true→旧 bug 复活；恒 false→显式选择永不落库）当前无测试会红（全仓无 sendText handler 测试）。
- 改法：test-edit-retry-model.mjs 增 E 组两例驱动 `sessionFlowHandlers.sendText`（桩：getInputRoutingMode→null、ensureModelReady、queue 系、app.sendInput 捕获 intent）：E1 显式携带→pinned true+写回三连；E2 缺省→pinned false+不写回。
- 验收：12+2 例全绿；变异验证（E2 断言临时改 true 必须红）。

#### sub/G-1 ④ schema 双改防线可绕过——runtimeOutputSchema 同一性无断言
- 维度：B+G；来源：review-scope-subagent r1
- 文件：`apps/zcode-cli/packages/core/scripts/test-subagent-sync-dispatch.mjs:170-178`（被测 `core/src/tool/handlers/agent.ts:269`）
- 问题：测试只 safeParse contracts schema，未断言 handler 的 `runtimeOutputSchema` 与契约同一对象——换成不含 childSessionId 的本地副本时三条断言仍全绿而运行时校验当场失效。
- 改法（r2 补细节）：测试脚本 :62-64 的 import 增加 `taskToolEntry`（现只解构 agentToolEntry）；T-D1b 内增 `assert.equal(agentToolEntry.runtimeOutputSchema, AgentOutputSchema)` 与 `assert.equal(taskToolEntry.runtimeOutputSchema, AgentOutputSchema)`（同一引用，锁住 Task 别名浅拷贝）；可选增强：变异验证时顺带断言 `createAgentToolEntry().runtimeOutputSchema === AgentOutputSchema` 与 `createTaskToolEntry()` 同引用（工厂链 index.ts:303-316 靠 spread 间接同引用，防未来工厂层覆盖不被发现）。
- 验收（r2 口径校正）：**5 例全绿（断言并入 T-D1b，不新增 test()）**；变异验证（临时换 :269 为本地 schema 必须红）。

#### mc/BG-1 ⑤+ transform pass 内联阻塞前台——预压缩/后台化（r4 新增，用户拍板本期）
- 维度：B+I；来源：用户报告 2026-10-10（「感觉现在会阻塞前台」）+ 主代理调查
- 文件：`core/src/runtime/helpers/magic-context-turn-transform.ts:215-235`（turn-loop 内联 await）、`bootstrap/src/app/magic-context-turn-transform.ts:1046-1056`（notifyPassSucceeded；historian fire-and-forget 先例）、`magic-context/src/index.ts:146-148`（replayLkg 公共面）
- 问题：transform pass 是 turn-loop 插入点内的 `await`（发 wire 前必须完成投影，设计使然）——阈值命中时的大 pass（长会话全量投影）直接计入用户首 token 延迟；没有「后台预计算、前台 LKG 回放」层。historian 重 DB 写已是后台 fire-and-forget（同文件 :1051-1052 注释），范式先例在。
- 改法（调查形，两步）：① 调查包内底子——`replayLkg`（包公共导出）与 transform 内部 deferred materialization 能否支撑「turn 成功后后台触发一次投影 pass 并落 LKG，下一 turn 内联走 lkg_replayed 快路径」；触发点放 `notifyPassSucceeded` 同位置（与 historian 同范式 fire-and-forget，可提前于阈值如 percentage≥70% 即准备）。② 最小落地**或降级**：包内支持 → 后台预压缩落地；不支持无 wire 输入的 pass → 降级登记不可行原因 + 落 mc/OQ-1R + 按 profile 结论优化 pass 内 SQLite 读热点。宿主侧（bootstrap/core）改动为主；若需动 `magic-context/src/core/**` 上游逐字区按 FORK 登记。
- 验收（r4 微修）：长会话（≥1500 消息）阈值命中 turn 的 pass 计时不再计入首 token 延迟——`magic_context.wire` 事件现无计时字段（r4 judge 核实：core helper :190-201 只有 outcome/total/entries），**实施时先给该事件补 pass 耗时字段**再对照 turn 首包时间；或降级路径的等价收益/结论登记（登记不可行原因，与 mc/OQ-1R 同 mc 性能域 commit 收口）；既有 T 系列不回归。

### P2（14 条 + e2e 后续 3 条）
> 计数脚注（r3；r4 校正）：「14 条」= 12（11 独立 + mc/C-orch-1 由 mc/A-1 兼收）+ r4 新增 mc/OQ-1R、mc/T-1；Closure 的「17」= 14 + e2e/R-1..R-3 三条（r4 judge 点数：16 个标题 + 1 兼收 = 17）。

#### mc/C-1 ⑤ migration_guard 细分判定与包内口径分歧
- 维度：C；来源：review-scope-mc r1
- 文件：`bootstrap/src/app/magic-context-turn-transform.ts:814-837`
- 问题：包内要求 `migration && (blockingProcesses>0 || unreadableFile)` 才判 migration_guard，bootstrap 版 `if (refusal)` 即判；unreadable+空 pids 时两处结论不同。
- 改法：补同形守卫 `if (refusal && ((refusal.blockingProcesses?.length ?? refusal.serverPids.length) > 0 || refusal.unreadableFile))`；注释改为「优先级与包内一致，守卫见 storage-unavailable-reason.ts:24」。
- 验收（r3 注明测试缝）：`describeStorageUnavailability` 在 bootstrap 模块为私有（:814 未导出）——表驱动用例先 `export` 该 helper（仅测试缝，不扩运行时面）再直测；用例：refusal 无 blockers → 不误判 migration_guard；T5/T6 不回归。

#### mc/G-1 ⑤ T1 时序耦合 flaky
- 维度：G；来源：review-scope-mc r1
- 文件：`magic-context/scripts/test-boot-busy-retry.mjs:250-288`
- 问题：`retryEvents >= 3` 与持锁 5s≡busy_timeout 等量耦合（实测余量仅 ~0.6s），慢机即 flake；计数断言非 spec 要求。
- 改法（r2 补全）：持锁 5s→~9s；断言改 `>=1` + `attempt===1` + `retryInMs===1000`；**同步删除 :282 的 `retryEvents[1].context?.attempt === 2` 索引断言**（>=1 时第二个事件可能不存在，慢机 TypeError）；更新 :253-254 时序注释为「持锁 9s：尝试时刻约 0/1/3/7s 均撞锁，15s 成功，重试事件 ≥1 即可，不再依赖精确计数」；「恰好 N 次」计数只留在 T2 注入 delaysMs 的确定性缝。
- 验收：连跑 3 次无 flake。

#### mc/K-1 ⑤ storage_unavailable 事件改名无登记
- 维度：C/K；来源：review-scope-mc r1
- 文件：`magic-context-turn-transform.ts:975-979`
- 改法：事件处补注释「旧名 storage_unavailable → storage_unavailability，与 transform_absent 成对；已检索零消费者」。验收：注释落地。

#### agent/G-2 ① pin 不跨持久化/queue 提升两条不变式无回归测试
- 维度：G；来源：review-scope-agent-chain r1
- 文件：`core/src/runtime/methods/input-intent-persistence.ts:32-35`、`bootstrap/src/zcode-protocol-v4/commands/input-intent.ts:118-119`
- 改法：test-edit-retry-model.mjs 增 F 组两例：持久化输出与 queueItem→intent 输出均不含 `modelSelectionPinned` 键，且喂回执行态不写回。
- 验收：变异验证（持久化对象加 pinned:true 必须红）。

#### agent/B-1 ① mapper 过滤零观测
- 维度：B；来源：review-scope-agent-chain r1
- 文件：`bootstrap/src/zcode-protocol/session-mapper.ts:146-151`
- 问题：被丢 part 不记数不记日志；上游已定位为 `message-mapper.ts:63-158` switch 无 default（未知 type → undefined）。
- 改法：过滤时统计丢弃数，`buildSessionSnapshot` 加可选 logger（server-operations.ts:3411 传 context.logger），warn 含 messageId/dropped/partTypes；上游根治另立 e2e/R-3。
- 验收：mapper 用例（未知 type part → 快照无 undefined 且 warn 发射）。

#### agent/C-1 ① 默认模型回落式三处重复
- 维度：C；来源：review-scope-agent-chain r1
- 文件：`bootstrap/src/app/create-app.ts:576-580`、`runtime-config.ts:285-289`、`session-facade.ts:505-507`
- 改法：抽导出纯函数 `resolveConfiguredDefaultModelSelectionOf(options)`，三处改调用；test-default-model-live 补三例（accessor 优先/仅静态/都无→undefined）。
- 验收：8+3 例全绿。

#### sub/C-orch-1 ③ 重复 childSessionId 下回退语义与注释不一致（r2 修订：改法适配真实数据流）
- 维度：C-orch；来源：review-scope-subagent r1 + spec-check r1 judge P1
- 文件：`packages/ui/src/v4/conversationStatusPanelModel.ts:323-359`、`packages/shared/src/zcode-protocol-v4/snapshot.ts:411-442`
- 数据流约束（r2，judge 实测）：`RunningSubagentSummary` **无 cancellable 字段**（snapshot.ts:433-442），cancellable 只在 `BackgroundWorkSummary`（:424 optional）；重复 childSessionId 时 map（:327-331）整体置 null 丢弃组信息，:348-352 回退分支手上只有 subagent——「直接读上游 cancellable」无值可读；null 哨兵共 3 处消费（:338 投影分支、:363-364 补齐循环）。
- 改法（r2）：① 选 (b) 契约保留：注释改为「重复身份仍回退 agentId——回退目标是任务自身 id，非按标题/时间猜测，无误停风险」。② 为保留重复组信息：`subagentControlByChildSessionId` 改为 `Map<string, BackgroundWorkSummary[] | null>`（或等价富哨兵）——唯一命中存单元素数组；重复命中置 null 时**仍把该组全部 work 存入副表**。③ :348-352 从副表取该组，聚合规则=**组内任一条 `cancellable === false` 则行不可停**（缺省/未声明仍视为可停，与 :354-358 `!== false` 判据一致）；map 值数组化后**全部读取点同步适配**：:338 投影分支、:348-352 回退分支、:356-357 字段访问、:363-376 补齐循环（workId/title/blocked/startedAt/cancellable 六处字段访问）——null 哨兵消费共 :338 / :348-352 / :363-376 三处，副表查询一并判空（TS 类型报错可兜底，但以本清单为准）。
- 验收（r2 明确聚合语义；r3 明确口径）：T-S2 为**单个新增 test() 内含三组断言**（故 5+1 例）：a) 两条 work 同 childSessionId → 仍回退 agentId；b) **仅其中一条** `cancellable: false` → 行 cancellable 必须为 false（任一 false → 不可停）；c) 两条均缺省 → 可停。

#### uix/G-1 ⑥ toolOutputs cleanability 展示面升格（spec deviation 收口）
- 维度：G+C-orch；来源：review-scope-ui-exec r1
- 文件：`packages/services/src/storage/domain/storageCatalog.ts:29-32`、`usageAggregate.ts:73`、`ui/src/resource-manager/storage/StorageCategoryList.tsx:37`
- 问题：类别级 cleanability none→safe 使 UI 整组显示可清理但实际只删 cli/exec，界面数字与结果不符。
- 改法（r2 闭环修订——r1 四闸门只覆盖 service 侧，UI 三处门控与 aggregate 展示契约缺失，照 r1 字面执行会「服务可清但 UI 无入口」，与 QA 验收自相矛盾）：service 三闸门统一以 `hasStorageCleanPathOverride(categoryId)` 优先于 none 门放行（函数已存在，cleanPlan.ts:62 在用）——① `storageCatalog.ts:259` getStorageCleanScopes 枚举门（override 分支 :262-265 须 override 判定前置）；② `storageService.ts:84` clean 的 "not cleanable" throw；③ `cleanPlan.ts:45` planStorageClean 空 targets。④（r2 展开；r3 补传播点）展示契约：`CLEANABILITY.toolOutputs` 回 "none"，`usageAggregate.ts:73` 为 override 类别新增 `cleanScope?: "paths"` 字段（aggregate 侧按 hasStorageCleanPathOverride(id) 判定）；**UI 侧传播点：`storageCategoryPresentation.ts:59-64` `sumCategoriesAcrossRoots` 构造 `StorageCategoryTotal` 时同步透传 cleanScope（跨根合并取任一非空；字段由 categoryId 派生确定性一致）——optional 字段漏传无编译错误，漏传即三处门控恒 undefined、入口静默消失**；**UI 三处门控**统一改为「cleanability !== "none"（既有路径）或（cleanScope === "paths" 且 bytes > 0）」——`StorageCategoryList.tsx:37`（类别行按钮）、`StorageCategoryDetail.tsx:72`（详情页）、`StorageSection.tsx:114`（requestClean 守卫）；toolOutputs 行徽标/入口文案收敛为「仅 cli/exec」（i18n 锚点：`storageCategoryDescriptionId` 对应 toolOutputs 的 messages 条目）。
- 验收（r2）：T-C2-4a 改写（既有 `packages/services/test/storageExecOutputClean.test.ts:175` `assert.notEqual(..., "none")` 锁旧行为，须改为 `assert.equal(..., "none")` + `cleanScope === "paths"` 断言；:177-180 none 家族其余断言不动）；T-C2 补 aggregate 展示语义断言（cleanScope 输出）与三处门控放行逻辑单测（可单测则单测）；10+ 例全绿；资源管理器实机：类别行仍有清理入口、徽标/文案标明「仅 cli/exec」、清理只删 cli/exec（manual_user）。

#### uix/G-2 ⑥ 在飞保护时钟基准
- 维度：G；来源：review-scope-ui-exec r1
- 文件：`packages/services/src/storage/domain/cleanPlan.ts:62-103`
- 改法（r2 校正——现判据 `now - mtimeMs > 24h` 对未来 mtime 天然为 false，前置过滤行为上是 no-op）：前置 `mtimeMs <= now` 卫语句**仅作可读性/防御（可选）**；必交付物=两例 fake clock 测试（时钟回拨→不删、mtime 未来→不删）锁定现有算术语义。文件域校正：函数在 cleanPlan.ts:100-105（:62-66 是调用点）。
- 验收：两例 fake clock 测试绿，既有 10 例不回归。

#### uix/G-3 ②⑥ 测试缺口四项
- 维度：G；来源：review-scope-ui-exec r1
- 文件：`adapters/scripts/test-bash-output-limit.mjs`、`packages/ui/test/timelineRowHeightCache.test.ts`
- 改法：a) `truncateBashOutputAfterKill` 直测 4 例（settled 截断/未 settle 跳过/killCompletion undefined/IO 失败吞错）；b) guard 竞态 2 例（并入 uix/A-1 验收）；c) LRU 跨分区竞争 1 例（A 灌满 4000 挤掉 B）；d) POSIX kill 链在 CI 矩阵文档登记「仅类型+人工验收」。
- 验收：a/c 例绿；文档登记落地。

#### uix/C-1 ⑥ 截断 5s 逃逸无降级信号
- 维度：C；来源：review-scope-ui-exec r1
- 文件：`adapters/src/exec/execution-utils.ts:23,29,110`（FORCE_EXIT_AFTER_KILL_MS :23 / BASH_OUTPUT_TRUNCATE_WAIT_MS :29，r1 行号校正；:110 waitForPromise unref）、`node-execution-adapter-run.ts:336-344`
- 改法：`BASH_OUTPUT_TRUNCATE_WAIT_MS` 显式大于 kill 上界（如 7s）并注释二者锚点关系；逃逸分支在结果 message 附「输出未截断」可见信号。waitForPromise unref（:110）核对**以注释交付**：核对结论（截断等待期 unref timer 是否可能被事件循环提前丢弃）写入 execution-utils.ts 相应位置注释；若确认存在风险则顺手改为该路径持活（非 unref）并加 T-C1 用例，否则仅注释说明（r3 降级：不过度承诺改码）。
- 验收：T-C1 逃逸路径用例断言 message 附注；unref 核对注释落地。

#### e2e/R-1 ④ 异步派遣渲染补 sessionId 行（e2e 实测发现）
- 维度：B；来源：e2e 实机（模型自述「工具结果里未单独列出 sessionId 字段」）
- 文件：`core/src/tool/handlers/agent.ts` formatAgentOutputForModel 异步渲染分支（:180-198；同步 sessionId 行在 :175 —— r1 行号校正）
- 改法（r2 补落点）：sessionId 行加在 `launchLines`（:180-184）agentId 行之后——一次覆盖异步分支两个 return（:187-193 canReadOutputFile 路、:195-198 兜底路）；`data.childSessionId` 必填可取（AgentBackgroundedOutput）。
- 验收（r2 口径）：并入现有 T-D1c（:184-213）构造 async_launched 输出（isAsync/backgroundTaskId/outputFile/canReadOutputFile 字段需齐，schema strict）断言 format 输出含 sessionId 行——维持 5 例全绿。

#### e2e/R-2 ⑤ unknown provider usage→percentage=0 适配（e2e 实测发现）
- 维度：B；来源：e2e 实机（`transform: unknown provider usage; using wire estimate`，scheduler 恒 defer）
- **根因输入（用户提供，2026-10-10）**：用户实证「未设置历史/默认模型」即触发不压缩、设置后正常——与代码吻合：record() 守卫（magic-context-turn-transform.ts:387）`contextWindow === undefined` 即 skip，contextWindow 来自模型元数据，未配置模型时每轮 skip → contextUsageMap 永不更新 → wire estimate percentage=0 → 恒 defer。调查重点因此从「usage 字段形状」转向 **contextWindow 侧模型元数据缺席**（getModelUsageContextTokens 本身对 usage 形状宽容：inputTokens ?? cacheRead+cacheWrite ?? totalTokens 三层兜底，contracts/src/model/index.ts:540-552）。对照实验：日志 `magic_context.usage_skipped` 的字段 `contextWindow: null`（vs `inputTokens: null`）可区分两道门。
- 文件：`magic-context` tokenizer-calibration / 宿主 recorder usage 提取（调查后定位）
- 改法（两步；r2 补调查锚点；r3 定首选方向=用户拍板「模型继承」）：**首选适配（用户设计，2026-10-10 拍板）：contextWindow 绑定提前到 turn 开始**——现状 `noteLiveModel`（contextWindow 唯一来源）仅在 pass 成功后的 `notifyPassSucceeded`（:1046-1050）调用，存在鸡生蛋死结（percentage 需 contextWindow → contextWindow 需成功 pass → pass 需 percentage）。改为 turn 开始拿到**实际执行模型**即绑定 recorder：模型取会话生效模型（显式选择 ?? 活默认，复用 ①f 的 `resolveConfiguredDefaultModelSelectionOf` 同源 accessor——与子代理默认模型继承同范式，无会话/未设置模型也必然有值）；保留 `lastObservedModelKey` 语义（S24-fix 换模型失效判据，提前绑定只会更准）。**二层兜底**：继承模型在 catalog 缺 `properties.contextWindow` 时，用保守默认窗口/env 覆盖继续算 percentage（wire-estimate 降级通道保留为 backstop）。① 调查确认（锚点：`magic-context-turn-transform.ts:383-405` recorder、`:1046-1050` 唯一绑定点、`getModelUsageContextTokens` `contracts/src/model/index.ts:540`；日志 `usage_skipped` 字段 `contextWindow: null` vs `inputTokens: null` 区分两道门）；② 若调查发现 usage 提取另有形状问题再按实际结论补。若涉及上游逐字区按 FORK 登记。
- 验收：真实会话一轮后 mc 日志 `transform scheduler: percentage=` 非零（本机复验）；**对照组：未设置历史/默认模型的新会话同样非零并正常触发压缩**（用户复现条件）。
- 注：此项含调查成分，实施时若发现需产品决策（如 wire estimate 是否可信进 scheduler），升级 open_questions。

#### e2e/R-3 ① undefined part 上游根治（e2e 发现的既有 bug 防御后根治）
- 维度：B；来源：e2e 实机 + review-scope-agent-chain 定位
- 文件：`bootstrap/src/zcode-protocol/message-mapper.ts:63-158`
- 改法（r3 补根因核验）：`mapMessagePart` switch 补 default 分支（未知 type 返回占位 part 或 null 并由调用侧过滤——与 agent/B-1 的 warn 观测合并），消除「未知 type → undefined 混入 parts」源头。**实施前先核验根因两说**：session-mapper.ts:146-148 现注释将 undefined part 归因「编辑 rewind rehydrate 遗留物」而非未知 type——若 rewind 路径才是真源头（未知 type 实际不存在），default 分支仍作防御落地，但「编辑重发不再产生丢弃 warn」的理想态降级为登记项（以实际捕获的 part.type 分布为准）。
- 验收：表驱动用例（未知 type → 不产生 undefined）；与 agent/B-1 联测；e2e 编辑重发路径的丢弃 warn 情况**按核验结论如实登记**（理想态=不再产生，若根因为 rewind 遗留则注明）。

#### mc/OQ-1R ⑤ 重试链 × busy_timeout 叠加（原 Open question 转正；r4 用户拍板本期处理）
- 维度：C+I；来源：OQ-1 → 用户 2026-10-10 拍板
- 文件：`bootstrap/src/app/magic-context-turn-transform.ts`（openMagicContextStorageWithBusyRetry 的 open 调用处）、`magic-context/src/core/features/magic-context/storage-db.ts:249`（OpenDatabaseOptions.busyTimeoutMs 已支持）、`:1144-1149`（BOOT_SQLITE_BUSY_TIMEOUT_MS 默认与 resolveBootBusyTimeoutMs）
- 问题：重试链 [1s,2s,4s,8s] 每次尝试叠加内建 busy_timeout 5s，最坏 ~40s vs 15s boot 预算；boot 装配期 `await` 工厂（create-app.ts:823）整段阻塞前台。
- 改法（r4 澄清）：重试路径的 open 显式传 `busyTimeoutMs: 1000`（选项已支持，storage-db.ts:249；openDatabase 有 options 重载 :2665-2667，1000 经 resolveBootBusyTimeoutMs（:256-260，BOOT_SQLITE_BUSY_TIMEOUT_MS=5000 在 :177）钳制原样通过）——单次尝试上界压到 1s，最坏链长收敛进 boot 预算；**重试链外的生产 open（run-ctx-command.ts:222、ctx-context.ts:67、host/ctx-status.ts:196）不传该参、天然保持默认 5s**。注释写明两档语义（非重试路径容忍长等待、重试档快速让出配合退避）。
- 验收（r4 钉测试缝）：test-boot-busy-retry 补一例——断言机制二选一按实施定：E2E 用例 + `registerHooks` 模块钩子 wrap-and-delegate spy open 参数（既有范式 :42-76/:82/:102），或断言 `onBootBusyTimeout` 诊断含 `timeout=1000ms`，或把 busyTimeoutMs 提为 retry helper 可注入参数后直测；T1/T2 不回归；boot 预算相关注释更新。

#### mc/T-1 ⑤+ ctx 工具 prompt 曝光缺失（r4 新增，用户拍板本期）
- 维度：C+G；来源：用户报告 2026-10-10（「agent 不怎么用」）+ 主代理调查（prompt 面 grep 零命中）
- 文件：`core/src/tool/handlers/ctx-context.ts`（工具描述区=模型可见面）；tools prompt-section 通道写入侧（存在性证据：`core/src/runtime/methods/context-usage.ts:141` `source === "tools"` 的 prompt 分区——实施时定位其写入者）
- 问题：ctx_reduce/ctx_expand 已默认注册（runtime-tools.ts:85，门=mc enabled），但零 prompt 引导——模型只能从 schema 描述自悟；§N§ 标签出现后模型不知道可用 `ctx_expand message=N` 找回全文（且 percentage=0 期间 §N§ 从未出现，「不用」大半是 R-2 的下游症状）。
- 改法（r4 修正前提）：**默认走 ①**——增强两工具描述中的主动使用时机句（「上下文出现 §N§ 标签 → ctx_expand message=N 找回全文」「ctx_reduce=显式声明后续不再需要」；现描述已有 [dropped §N§]/tag=N 字样但缺主动时机引导）。② 降级为可选：`source === "tools"` 的 prompt-section 写入侧**当前不存在**（r4 judge 核实：ContextBuilder.setToolRegistry builder.ts:47-52 是显式 no-op，工具说明由 model request 的 tools 字段承载；context-usage.ts:141 只是消费侧过滤）——如需 prompt 注入须新建 tools section 通道，超出本条最小面则不做。
- 验收：mc enabled 会话的工具描述含引导句（快照/单测断言，既有 magic-context/scripts/test-ctx-tools.mjs 不回归）；disabled 会话工具不注册（既有门天然满足）。

## Spec deviations
- open → 本 spec 闭合：⑤ disabled 生产不可达（mc/A-1）
- open → 待用户拍板：① T-E2 候选(a) 复现方法收窄为「机制论证+源码形状守卫」（e2e 实机已实证：编辑重发经抢占修复+mapper 防御后全链路通；jsdom 基建缺失，CDP 脚本价值有限）。建议：确认按现状收窄 → fixed。
- 注记（实现选型说明，无动作）：3c 目录页新建 handler（无主 pane 上下文，范式一致）；3a 独立测试文件；6b 用 terminateProcessTree 返回值替代 pendingBashProcessTreeKills 读法；6a 前台 pipe/模型文案两处静态文案未动态化（spec 字面只点两处）。

## Open questions / 待拍板
1. agent/OQ-1：hasActiveTurn 使编辑会抢占「后台通知 model-only turn」（原为排队）——产品接受度。
2. agent/OQ-4：registry「静态字段+活读 getter」双真相；CLI prompt-command 是否下轮收敛走 accessor。
3. uix/OQ-2：adapter env 解析实例级记忆化——桌面长驻进程改 env 需重启，是否加 debug 说明。
4. uix/OQ-5：timelineRowHeightCache `clear()/clearSession()` 现生产零调用——保留还是删。
（原 OQ-1 busy_timeout 叠加已由用户拍板转正为 mc/OQ-1R 本期处理，r4。）

## 已豁免（用户确认不修）
（无）

## 实现注记（dev 批次收口，cr-func-all 终检后登记）
1. **uix/G-1 谓词**：实现定为 `bytes > 0 && (cleanability !== "none" || cleanScope === "paths")`——保留两处 UI 门控原有的 bytes>0 铁门（spec 字面公式会放松它造成零占用类别出清理入口的回归），requestClean 附带收紧；已就地注释于 storageCategoryModel.ts 并有门控用例锁定。
2. **mc/T-1 验收断言已补**：core/scripts/test-ctx-tool-descriptions.mjs（3 例：两引导句在位 + 既有机制句回归护栏），挂入根 test:v4-perf 链（cr-func 时为 open 项，已闭合）。
3. **uix/G-3d 登记落点**：仓内无 CI 矩阵文档，POSIX kill 链「仅类型+人工验收」登记于 test-bash-output-limit.mjs 文件头注释。
4. **mc/BG-1 走降级分支**（spec 许可）：四条不可行原因登记于 bootstrap/src/app/magic-context-turn-transform.ts 文件头「已知缺口」；补偿收益 `magic_context.wire` 事件 passDurationMs 计时字段已落地（后续重开前提：先接线 LKG hydration backend 扩 barrel）。
5. **e2e/R-2 以 5 例单测锁定 + 登记替代实机复验**（需 provider 出网，留合并后 QA）：绑定链路 turn-loop state.model → onTurnStart → bindLiveModel；窗口三源（properties → 会话生效模型 accessor → 保守默认 128k/env）。
6. **e2e/R-3 根因核验结论**：未知 type 说成立（mapMessagePart 无 default → undefined 混入），rewind rehydrate 归因不成立（崩点位置机械对比）；理想态「编辑重发不再产生丢弃 warn」可达，未降级。
7. **uix/C-1 unref 风险被 T-C1-6b 实证**（非理论）：按 spec 条件条款，waitForPromise 增加 keepAlive 选项（默认行为不变），截断等待路径持活。
8. **sub/G-1 附带修复**：@zcode/contracts dist/src 双实例问题（测试按源码 URL 取契约与包入口 dist 产物是两个 schema 实例）——按 registerHooks 范式加契约单实例钩子。

## 合并后 QA（manual_user）
- ③ 状态面板/目录页真机点停止 → 终态「已取消」（CDP testid v4-background-work-cancel-<agentId>）
- ② 长会话切换录屏复核首帧
- ⑥ 资源管理器清理入口实机（uix/G-1 修复后验证徽标与清理范围一致）
- ① 编辑重发+切模型实机复核（e2e 已过，合并后抽验）
- ⑤ mc/BG-1：长会话阈值命中时前台首包不卡抽验 + ctx_expand 在 §N§ 出现后可被模型主动使用抽验（mc/T-1）

## K 节建议（下游执行时闭合）
- 跑全套门禁：根 typecheck/lint、cli turbo typecheck、magic-context test:all、test:v4-perf、desktop 差分、oxfmt 零新增（改动文件）。
- commit 建议（review-full r1；r4 增补）：⑥ 截断三修（uix/B-1/B-2/C-1）+ N-1 结果面信号合并为同一 commit 域（同文件 run.ts:333-352 避免二次冲突），共用 T-C1 增例；uix/G-1 展示链修列为 ⑥ 域开工前置（r2 扩为 service 三闸门+aggregate cleanScope+UI 三门控，先改测试锁再动实现）；其余按域 commit（mc 可观测性收口 / ②guard 信号 / ①④测试防线+渲染）；e2e/R-2 单独 commit（含调查）；**r4 新增：mc/BG-1+mc/OQ-1R 同 mc 性能域 commit（BG-1 含调查步），mc/T-1 随 mc/agent 域并入**。

## Fix-Spec Closure
| 项 | 状态 |
|---|---|
| fix-spec-ready | **yes（r4 Go）**；历轮：cr-loop wave1+full → spec-check r1 No-Go→r2 No-Go→r3 Go→r4 新增 3 项复检 Go（计数 17+措辞微修已落） |
| fix_spec_path | docs/iterations/bugfix-batch-20261009/cr-fix-spec.md |
| dag_version / review_round | 5 / 4 |
| P0 / P1 / P2（已写入） | 0 / 7 / 17（P2=14+e2e/R-1..R-3；N-1/N-2 并入既有；r4 新增 BG-1/OQ-1R/T-1） |
| 未写入的开放 must-fix | 0（wave-1 22/22 + full 复扫 + spec-check 三轮全部处理） |
| spec_deviations | open: 1（T-E2(a) 收窄待拍板）；1 由 mc/A-1 闭合 |
| C-orch | ✅（mc/C-orch-1、sub/C-orch-1+N-2 r2 数据流版、uix/G-1 r2 UI 闭环版+r3 传播点） |
