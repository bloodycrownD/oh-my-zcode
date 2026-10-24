# CR Fix Spec: magic-context-system-prompt-guard

## 元信息
- repo：D:\Dev\Js\oh-my-zcode；分支 magic-context-system-prompt-guard
- base_sha：eeb881a0（main）／reviewed_head：93237be5（must-fix 锚点对应此版）／fixed_head：3c51dff1（fix-cr 405ac6a7 → fix-oq 6841f996+3c51dff1）
- prd_path：无（并入 spec「需求来源」）；spec_path：docs/iterations/magic-context-system-prompt-guard/spec.md（v4，**已冻结**——CR 发现一律落本文件，不回写 spec）
- review_round：3（r1 三 scope → r2 review-full → r3 review-diff-fix）＋ spec-check 旁路（r4 发现 11 条 → doc-fix → r5 复查 **Go**）＋ oqfix 批次（用户「修复」指令 → fix-oq → review-diff-oq **fix-oq-ready: yes**）
- 状态：已执行（fix-cr 3110c085+405ac6a7；fix-oq 6841f996+3c51dff1；两轮 diff 复审均 ready；待发布）

## Must-fix（按 P0 → P1 → P2）

### schema/B-1 [P2] effective head 日志取数组尾元素，上游追加后会报错版本
- 维度：B（正确性/可观测性）
- 文件：apps/zcode-cli/packages/magic-context/src/core/features/magic-context/migrations.ts:3440-3446
- 问题：日志用 `MIGRATIONS[MIGRATIONS.length - 1].version` 表示 effective head。当前尾部恰是 v10000 所以正确，但 spec R3b 预期上游后续 v95/v96 会 append 到数组尾部——届时尾元素 v95，日志报错版本（数组顺序 ≠ 版本顺序的首次体现）。
- 改法：插值改 `v${LATEST_MIGRATION_VERSION}`（同文件 :3211 已定义，值即全量 MAX）；同步改写 :3441-3443 FORK 注释（「head 取 LATEST_MIGRATION_VERSION=max(version)，不依赖数组尾序」）。
- 验收（round 2 修订，full/A-1）：源码级人工核对——`rg -n "effective migration head" -A2` 确认插值引用 `LATEST_MIGRATION_VERSION`；smoke 仅作回归门（其断言不捕获日志，未修也绿，不可作为修复证据）。
- 来源：review-scope-schema / round 1；验收修订 review-full / round 2

### schema/G-1 [P2] T-G15 存在「注入未发生也全绿」的空转路径
- 维度：G（测试有效性）
- 文件：apps/zcode-cli/packages/magic-context/scripts/smoke-storage.mjs:318-337（Proxy 注入）、:360-372（断言）
- 问题：注入依赖 `sql.includes("INSERT INTO schema_migrations")` 字符串匹配。记账 INSERT 被改写（换行/大小写/列重排）时注入静默失效，三条断言仍全绿，sibling-conflict 回归锁退化为空转。
- 改法：① Proxy 外声明 `let conflictInjected = false;`，伪造语句 run() 内先置 true 再 throw；② runMigrations 后新增 `check("T-G15: crafted sibling PK conflict was injected", conflictInjected, true)`；③ fixture 的 `DELETE FROM schema_migrations WHERE version=10000` 之后、runMigrations 之前补 `check("T-G15 fixture: v10000 row absent before run", ...get() == null, true)`。
- 验收：改后 smoke 绿；人为改坏注入 SQL 匹配时新断言必须红（一次性本地验证，不入库）。
- 来源：review-scope-schema / round 1

### guards/B-1 [P2] executeFlush 全 system 队列时确认文案畸形
- 维度：B
- 文件：apps/zcode-cli/packages/magic-context/src/core/hooks/magic-context/execute-flush.ts:40-43
- 问题：新守卫使 dropped 可保持 0，此时 parts 为空 → 返回 `Flushed: . Changes take effect on next message.`（守卫前不可达路径）。T-G14 只覆盖「1 system + 1 普通」，未覆盖「只有 system」。
- 改法：`if (dropped > 0) parts.push(...)` 改为无条件 `parts.push(\`${dropped} dropped\`)`（与 T-G14 现有断言文案兼容）；test-transform T-G14 追加子用例：队列只放 system op → 断言 `Flushed: 0 dropped. Changes take effect on next message.`、status 保持 active、op 仍在队。
- 验收：新子用例绿；原 T-G14 不红。
- 来源：review-scope-guards / round 2

### guards/A-1 [P2] constants.ts 的禁盖句未登记 FORK 注释
- 维度：A / C
- 文件：apps/zcode-cli/packages/magic-context/src/core/tools/ctx-reduce/constants.ts:11
- 问题：spec §四 变更点 7 末尾明写「FORK 注释」；host full 与 light 均已登记，唯独 constants 直接改原文且全文件无任何 FORK 标注——后续上游同步会静默覆盖该句。
- 改法：常量行前（或文件头）加 `FORK（magic-context-system-prompt-guard）` 注释块：上游无 role 概念；fork 在 Keep 行后加 system 段禁盖句；与宿主 full/light 三落点同步；本常量当前无模型可见消费方（两调用方只 .execute），保留同步仅为与上游 diff 最小。
- 验收：人工核对注释存在且四要素（源位置/上游语义/ZCode 差异/改动面）齐全。
- 来源：review-scope-guards / round 2

### guards/G-1 [P2] light 描述的禁盖句无测试锁定
- 维度：G
- 文件：apps/zcode-cli/packages/magic-context/scripts/test-prompt-surface.mjs（已导入 LIGHT_TOOL_DESCRIPTIONS）
- 问题：light 描述是 light preset 的模型实际视野，但只有宿主 full 有 T-CTX-4 锁定；light 文案被改坏（尤其丢 "never archivable"/"refused" 语义）时全仓无测试变红。
- 改法：light catalog 区块加一条用例：对 `LIGHT_TOOL_DESCRIPTIONS.ctx_reduce` 断言 `/Never stamp a system prompt segment/`、`/never archivable/`、`/refused/`（语义断言，不要求与宿主逐字同句）。
- 验收：build + test:prompt-surface 绿；人为删 light 句时该断言红。
- 来源：review-scope-guards / round 2

### promptdoc/B-1 [P2] FORK 头注「除本注与下方 FORK 登记以外零改动」与事实不符
- 维度：B（事实一致性/可维护性）
- 文件：apps/zcode-cli/packages/magic-context/src/core/agents/magic-context-prompt.ts:23-29
- 问题：该句字面声称正文相对上游零改动（除注释外），但本次实际改写了四个模板字符串（:96/:147/:175/:182）。上游同步者按此句理解会整段覆盖正文，四处禁句有静默丢失风险。
- 改法（round 2 修订，full/B-1——两处头注同批改）：`:23` 与 `:20-21`（「本文件作为逐字移植区保持上游原文」）都改为精确口径——「除本注与下方 FORK 登记及登记所述四处系统提示词禁句外，本文件保持上游原文」；FORK 块首句写明「正文改动仅限这四个变体各一句」。
- 验收：人工核对 `:20-29` 全段无未加例外限定的旧口径；`git diff eeb881a0..HEAD -- magic-context-prompt.ts` 含头注共 4 个 hunk、正文 3 个 hunk（末个 hunk 覆盖相邻两个变体）。
- 来源：review-scope-prompt-doc / round 1；改法修订 review-full / round 2

### promptdoc/G-1 [P2] zh 断言只锁「至少一次」，与注释声称「各出现一次」不符
- 维度：G（断言真锁死）
- 文件：apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-section-zh.mjs:173-216
- 问题：四个正向用例用 `assert.match`（子串存在即可）；同变体重复插入禁句测试仍绿，与头注/块注释「各出现一次」声明不一致。当前实现实测每变体恰 1 次、no-reduce 各 0 次，属测试加固非现网缺陷。
- 改法（round 2 修订，full/G-1——禁用 matchAll：现有 GUARD 无 `g` 时 matchAll 抛 TypeError，加 `g` 又与 assert.match 的 lastIndex 残留冲突，已实测）：保留无 `g` 的 GUARD；新增 `const GUARD_TEXT = "绝不给系统提示词段盖章——system（提示词）消息上的标签受保护、永不归档。"; const countOf = (s) => s.split(GUARD_TEXT).length - 1;`。zh 四变体断言 `countOf(zh) === 1`，no-reduce 两例 `=== 0`；promptdoc/G-2 的 EN 四正两反**复用同一 countOf**（EN 侧用英文整句字面量另建一个常量），不新增全局正则。
- 验收：`pnpm --dir apps/zcode-cli/packages/bootstrap run test:mc-section-zh` 绿；把任一变体禁句复制成两次须变红（一次性本地验证，不入库）。
- 来源：review-scope-prompt-doc / round 1；实现修订 review-full / round 2

### promptdoc/G-2 [P2] EN 四变体禁句无任何测试锁定（只有 zh 被锁）
- 维度：G（主路径覆盖）
- 文件：apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-section-zh.mjs（载体拍板：该文件，已 import EN builder 且已入根 test:v4-perf 门禁链——review open question Q2 的两个候选中取改动最小者）
- 问题：全仓仅 zh 禁句有存在性断言；EN 四变体无任何 `assert.match("Never stamp a system prompt segment")`（全仓 git grep 确认）；zh 测试的 en 路径字节相等比较是同源对比，EN 禁句被删时两边同步变化仍绿。上游同步覆盖 magic-context-prompt.ts 时非中文会话教育层可静默消失。
- 改法：在 test-magic-context-section-zh.mjs 的 3b 块追加 EN 正向 4 例 + no-reduce 反向 2 例（对 EN 四变体输出断言禁句存在一次、no-reduce 零次）。
- 验收：test:mc-section-zh 绿；从 EN 文件临时删一句禁句该断言必须红（验证后还原）。
- 来源：review-scope-prompt-doc / round 1

## Spec deviations
- none（review-scope-schema 认定）。两处实现选择记录备查（T-G15 兄弟行在事务 catch 内注入而非启动前预插——预插会被 pending 选择直接跳过，与 spec「冲突行存在」语义一致；smoke `bodiesBeforeNewerFence` 就近取基准——新增 fixture 推进全局 body 计数的机械调整，语义未变）。

## Open questions / 待拍板
1. **upstream-lane 文案面残留**（storage-db.ts:418-424 doc 注释、:452 fence 拒绝日志、fail-closed-block.ts:233 用户可见报错）：spec 只登记了 boot log 一处为已知偏差。本迭代顺手改 vs 沿用 spec 口径仅登记——待拍板（不阻塞）。
2. **storage-clone 的 message_role 复制无测试**：spec 已判「潜在路径无调用方」，实现 18 列已核对正确；若出现调用方再补契约断言。
3. **insert/stamp 跨进程窗口**（insertTag autocommit 与 stampTagMessageRole 独立 UPDATE 之间他进程可读到 NULL）：spec R5 已接受升级过渡期口径；steady-state 新分配 tag 的窗口（queue 判据可能漏一拍，apply 层有 target 兜底）按现状接受与否——待拍板（不阻塞）。
4. **caveman 深度分布重排**（guards）：eligibility 过滤 system tag 后 `computeTargetDepth(index, eligible.length)` 的档位分布小幅变化（一次性 cache bust，仅 experimental 开启时）——是否接受现状（不阻塞，spec 口径补充）。
5. **droppedCount 口径**（guards）：transform-postprocess-phase.ts:2230-2231 混合批 `droppedCount += pendingOps.length` 会把被拒 system op 计入；该计数对 already_reduced/protected 本就宽松（既有行为），改按实际落 dropped 需先定决策日志口径（不阻塞）。
6. **system_protected 新 diagnostics reason** 是否有外部日志/看板解析依赖；仓内未发现消费方（不阻塞）。
7. **T-G12 可选加固**：未断言 system 行 cavemanDepth 不变（三入口均不改 depth，当前无风险）。
8. **spec T-G14 措辞歧义**：「status 不变 dropped」实际语义是「不落 dropped、保持 active」；spec 冻结不改，下轮修订时顺句。
9. **light 档禁句与 full 逐字同句**（promptdoc）：安全文案同句利于遵循与审计，维持现状；若产品要求 light 缩短属新决策（非缺陷）。
10. **spec 行号锚点漂移**（promptdoc）：spec 变更点 14 写 :90/:141/:169/:176 与 zh :71/:115/:138/:145；dev 完成时为 EN :96/:147/:175/:182、zh :76/:120/:143/:150；3110c085 头注修订再加 2 行后 **HEAD 当前为 EN :98/:149/:177/:184**（zh 不变）。变体选择按名字正确，冻结 spec 不改，后续引用以本条当前值为准（快照 fixed_head 405ac6a7）。
11. **防线三自愈完全静默、防线二混合批不落日志**（review-diff 采纳并入）：防线二 `system_protected` 仅整批 no-op 时打印 reasons（apply-operations.ts:511-519），混合批有其它 op 落盘时不打印；防线三修 active 无任何日志。如需审计可加 debug 级 sessionLog——合并后拍板。**已由 oqfix/2 修复（6841f996）**。
12. **范围外同族文案残留**（review-diff-oq/O1）：fail-closed-block.ts:225（migration_guard 用户可见消息）、storage-db.ts:958/:1029（migration_guard fatal 日志）仍写 "upstream migration v..."——guard 仅在 persisted<10000 触发、此时源版本确为上游游标，语义风险低；后续清理批次收口。

## 已豁免（用户确认不修）
- （空）

## 合并后 QA（manual_user）
- （空）

## K 节建议（下游执行时闭合）
| 项 | 状态 |
|---|---|
| K-1 `$null` 误产物清理（仓库根 + magic-context 包下，显式 pathspec 勿 `-A`） | **已完成**——两文件已删除，`git status` 无残留 |
| K-2 full/K-1 e2e 脚本 oxfmt 不合规（review-full / round 2） | **已完成**（405ac6a7）——纯排版：两版断言编号序列完全一致（31/31）+ oxfmt 重排后 `fc /b` 字节一致；`--check` 退出 0 + e2e 重跑 37/37 |
| K-3 `cr-fix-spec.md` / `.iteration-state.yaml` untracked 留痕 | **待入库**——留痕策略待拍板；入库时显式 pathspec add |

基线漂移登记：test-magic-context-memories-rpc.mjs / test-ctx-tools.mjs 为基线既有漂移（base blob 同样不合规、本次新增行无差异），无需重排。

## review-diff（round 3）非阻塞观察

fix-cr 执行后的 diff 复审（review-diff-fix）结论：**cr-func-ready: yes——无新 must-fix（P0/P1/P2=0）**。4 条非阻塞观察（fixdiff/O-*，均不改判、不要求修复）：

- fixdiff/O-1：`execute-flush.ts:43` 数组字面量初始化与「无条件 push」语义等价（parts 此前为空且无其他 push）；`string[]` 注解略显多余，可简化但无缺陷，不值得再开一轮。
- fixdiff/O-2：`magic-context-prompt.ts:27-28` FORK 块断行把「四个含 stamping 指引的变体」与枚举列表拆开，纯排版可读性小瑕疵（该文件不走 oxfmt）。
- fixdiff/O-3：EN_GUARD_TEXT 采用源码实际字面量（含 `tags on` 前缀与 em dash 细节）是正确选择——断言是字节计数必须与源码逐字一致。
- fixdiff/O-4：405ac6a7 纯排版声明经字节级验证成立（3110c085 版本经 oxfmt 重排后 `fc /b` 完全一致），无任何逻辑变化。

## Fix-Spec Closure

| 项 | 状态 |
|---|---|
| fix-spec-ready | yes（review-full 判定：8 条全真、无 P0/P1、4 处文本缺口已闭合——round 2 修订后无需再派复审） |
| **执行状态** | **已执行**：fix-cr（3110c085 闭合 8 P2，8 文件 +118/−11）+ K 节（405ac6a7 e2e oxfmt 纯排版）；EN_GUARD_TEXT 按源码实际字面量（任务文字的有意偏差，正确） |
| fix 后复审 | review-diff-fix：cr-func-ready: yes（8 P2+K 逐条闭合核验、验收实跑全绿、无新 must-fix、4 条非阻塞观察见上） |
| fix_spec_path | docs/iterations/magic-context-system-prompt-guard/cr-fix-spec.md |
| dag_version / review_round | 3 / 3（CR DAG：r1 三 scope → r2 review-full → r3 review-diff-fix；顶层 .iteration-state 的 dag_version=2 属开发 DAG，互不冲突；spec-check 旁路 r4→doc-fix→r5 Go） |
| P0 / P1 / P2（已写入 fix-spec） | 0 / 0 / 8（全部 P2：schema×2、guards×3、promptdoc×3，其中 3 条含 round 2 修订） |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none（review-full 终判：reviewed at 93237be5 时 diff 28 文件 = spec §三 26 实现文件 + spec.md + e2e 脚本；fix 后 HEAD 405ac6a7 为 29——新增 test-prompt-surface.mjs 系 guards/G-1 的测试载体，属 CR 补充非偏离） |
| C-orch | N/A（review-full 全查：模型可见描述仅宿主 full + 包内 light 两落点，无第四落点；constants 无模型可见消费方） |
| C 类合并后 QA | open questions #5（droppedCount 混合批口径）与 #11（防线三静默自愈/防线二混合批无日志，可加 debug 级 sessionLog）——合并后拍板 |
| K 节 | K-1 已完成 / K-2 已完成（405ac6a7）/ K-3 待入库 |

## Open questions 拍板修复批次（用户指令「修复」2026-10-19，fix-oq 节点）——**已执行完毕**

**执行记录**：fix-oq（commits 6841f996 文案+日志 +24/−6、3c51dff1 测试加固 +124）→ review-diff-oq 复审 **fix-oq-ready: yes**（4 条逐条核验通过、无越界改动、smoke 56/56、transform 51/51 复跑 ×2、ctx-tools 23/23、tsc 干净）。防线日志实测输出（T-G4/5/6）：`pending operations rejected system tags: source=pending total=1 rejected=1 tags=1 reason=system_protected` 与 `applyFlushedStatuses healed system tag 1 back to active`。

复审登记（review-diff-oq 非阻塞观察）：O1 范围外同族文案残留（fail-closed-block.ts:225 migration_guard 消息、storage-db.ts:958/:1029 fatal 日志仍写 "upstream migration v..."）——guard 仅 persisted<10000 触发、语义风险低，见 open questions #12；O2 全 system 队列两行日志并存属刻意设计；O3 T-G12 eligibility 段 depth=0 断言较弱（仍可捕获回归）；O4 格式/类型全过。

用户对遗留 open questions 下达修复指令。按技术正确性升格 4 项为修复条目；**不动**：#3（spec R5 已接受）、#4（experimental 行为 spec 口径）、#5（决策日志口径待产品定）、#6（无消费方）、#8/#9/#10（已记录/维持现状）。

### oqfix/1（升格自 OQ#1）[P2] upstream-lane 文案面残留 3 处
- 文件：apps/zcode-cli/packages/magic-context/src/core/features/magic-context/storage-db.ts:418-424（formatSchemaFenceBootLog doc 注释）、:452（fence 拒绝日志）、fail-closed-block.ts:233（用户可见报错）
- 问题：读侧已改全量 MAX，三处仍称 upstream-lane——文案与语义不符（boot log 一处 spec 已登记偏差，顺手一并改齐）。
- 改法：三处文案改为准确口径（如「ledger head（全量 max(version))」/「schema 由更高版本写入」语义），保留既有中文注释风格；不改变量名/函数名（避免涟漪）。
- 验收：rg 三处无 upstream 残留（或仅剩 spec 登记的历史偏差说明）；magic-context build + smoke 绿。
- 来源：spec-check r4 采纳项 / 用户修复指令

### oqfix/2（升格自 OQ#11）[P2] 防线二混合批与防线三自愈的可观测性
- 文件：apps/zcode-cli/packages/magic-context/src/core/hooks/magic-context/apply-operations.ts（:511-519 附近与防线三分支）
- 问题：防线二 system_protected 仅整批 no-op 时打印；混合批有其它 op 落盘时不打印；防线三修 active 完全静默——事故复盘时无法从日志确认防线生效。
- 改法：防线二：被拒 op 处累积 rejected reasons，循环结束后若 rejected>0 打一条汇总（复用现有 log 风格，含 tag 号与 system_protected）；防线三：heal 分支打印一条（tag 号 + 修回 active）。**不引入新依赖，不加 sessionLog 基建**（用现有 console/log 通道——先读该文件现有日志模式再对齐）。
- 验收：build 绿；test-transform 50/50 回归不红（日志不影响断言）；T-G4/T-G5/T-G6 用例复跑绿。
- 来源：spec-check r4 采纳项 / 用户修复指令

### oqfix/3（升格自 OQ#7）[P2] T-G12 补 cavemanDepth 不变断言
- 文件：apps/zcode-cli/packages/magic-context/scripts/test-transform.mjs（T-G12 用例内）
- 改法：三入口豁免分支各补断言：system tag 行的 caveman_depth 修复前后不变。
- 验收：test-transform 50/50 → 仍全绿（含新断言）。
- 来源：guards scope 遗留 / 用户修复指令

### oqfix/4（升格自 OQ#2）[P2] storage-clone 的 message_role 契约断言
- 文件：apps/zcode-cli/packages/magic-context/scripts/test-transform.mjs（或 smoke-storage.mjs——选既有 clone 相关断言所在脚本；若无先例则落 test-transform）
- 改法：构造含 message_role='system' 的 tag 行 → 调 storage-clone 导出函数 → 断言克隆行 18 列含 message_role 且值一致。
- 验收：所在脚本全绿。
- 来源：schema scope 遗留 / 用户修复指令

## 待续
- **fix-spec-ready 已达成**（round 3 闭合）。三个 scope + review-full 全部返回：schema ✅（2 P2）/ guards ✅（3 P2）/ prompt-doc ✅（3 P2）/ review-full ✅（4 处文本修订已并入）——共 8 条 P2 全部落盘；无 P0/P1；spec_deviations none。
- 下游：**已执行完毕**（fix-cr 节点 commits 3110c085+405ac6a7；review-diff-fix 复审判定 cr-func-ready: yes——无新 must-fix、4 条非阻塞观察见 review-diff 区块）。迭代待发布链：合并 main → CHANGELOG v1.0.16 定稿 → **根 package.json bump 1.0.16 → 提交** → tag v1.0.16 → push tag（触发 Release Desktop）→ push main——每步动 main 前需用户确认（omz-publish 纪律）。
