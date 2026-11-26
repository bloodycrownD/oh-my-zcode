# CR Fix Spec: magic-context trim-integrity（三项修复的评审收敛）

## 元信息

- repo：D:/Dev/Js/oh-my-zcode
- base_sha / head_sha：30209b79 / a0991b92（分支 fix/magic-context-trim-integrity）
- spec_path：docs/iterations/magic-context-trim-integrity/spec.md（无独立 PRD）
- review_round / dag_version：5 / 5
- 状态：fix-spec-ready（第 5 轮终态认证通过；待用户确认后开工）

说明：第 1 轮评审给出 12 条 must-fix（P0 0、P1 6、P2 6），其中 `system-A-1` 与 `global-spec-1`
是同一件事（spec 未记载边界判定的连带修复），合并为 CR-1；tag 模块评审用了与 system 模块相同的
id 前缀（`system-B-1` 等），下表保留来源 id 以便对照。主代理对两条代码行为问题（CR-3、CR-10）
读了代码核实属实；其余为文档与测试缺口，按评审给出的文件与行号落盘。

通用约束（每条都适用）：只改「文件」栏列出的文件；源码改动带中文 FORK 注释；不放宽既有断言；
改了 magic-context 源码就重新构建包并跑 `test:transform`；不 commit（由编排或人工统一提交）。

## Must-fix（按 P0 → P1 → P2）

### CR-1 [P1] spec 未记载边界判定的连带修复与 T-S8
- 维度：A（spec 与实现不一致）
- 文件：docs/iterations/magic-context-trim-integrity/spec.md（问题一「方案」末尾、变更点 #1、测试策略）
- 问题：提交 3577a02f 让 `firstPersistedLiveId`（inject-compartments.ts:3695-3709）跳过豁免的 system 段，
  否则 `classifyAbsentBoundary` 恒判 refused、超窗被拒发（真实库 e2e 抓到的形态）。spec 全文没有这条，
  测试策略也只列到 T-S7。
- 改法：在问题一「方案」末尾增补一段「连带修复」：豁免让裁剪后的数组头部仍是 system 行，
  `firstPersistedLiveId` 须按 `leadingSystemRunLength` 跳过豁免段再取首个持久行；写明失败形态
  （不跳过则 absent-boundary 分类恒 refused → 请求不裁 → 超窗拒发）。变更点 #1 补记这一处。
  测试策略补 T-S8 条目：落点 bootstrap/scripts/test-magic-context-fork-inherit.mjs，断言 transform
  成功、请求以 system 段起头、日志出现 `prefix trim: boundary … precedes the first remaining message …`
  而不是 `absent from current messages`。同时把本次评审新增的用例也登记进测试策略，免得 spec 矩阵
  再出现同族空洞：T-S9（CR-2，S3/S4 applied 时 system 段保留）、T-T12（CR-3，system 行落到旧 tag 上
  时的解绑）、T-T13（CR-10，空白 user part 不参与平移）。
- 验收/测试：spec 文本与现行代码（inject-compartments.ts:3695-3709）和 T-S8
  （test-magic-context-fork-inherit.mjs 的既有用例）函数名、行为一致；纯文档改动。
- 来源：review-scope-system / system-A-1；review-global / global-spec-1（第 1 轮）

### CR-2 [P1] S3/S4 的 applied 路径没有永久测试
- 维度：G（测试缺口）
- 文件：apps/zcode-cli/packages/magic-context/scripts/test-transform.mjs（只在 T-S7 之后追加一例，不动既有用例）
- 问题：T-S7 只断言 S3/S4 的 refused（退化输入）；「开头 system 段在 S3/S4 applied 时被保留」没有任何
  用例，回归时全套件仍会绿。这条与上轮拒发缺陷同族。
- 改法：新增一例（建议名 T-S9，若与既有编号冲突则顺延）：夹具为 system 段 k=2（mc1、mc2）+
  mc3（摘要边界，非 system）+ mc4，preparedTrimBoundaryId=mc3。①带 capturePrefixTrimSourceOrder：
  断言 `prefixTrimStatus === "applied"`、注入后两条 system 行以同一引用保留在头部、mc3 被裁、mc4 保留；
  ②不带 sourceOrder：对 S3 分支断言同样的形态。评审者已用纯内存探针实证当前行为正确，本条是补护栏，
  不是修行为——实现时若断言不成立，说明发现了真实缺陷，停下并报告，不要改断言迁就。
- 验收/测试：新用例对两分支都断言 applied + system 行引用保留 + 被裁区间正确；
  `test:transform` 全绿。
- 来源：review-scope-system / system-G-1（第 1 轮）

### CR-3 [P1] system 行落到旧的非 system tag 上时缺少无条件解绑
- 维度：B（正确性，与 spec 执行次序图不符）
- 文件：
  - apps/zcode-cli/packages/magic-context/src/core/hooks/magic-context/tag-messages.ts:1396-1405
  - apps/zcode-cli/packages/magic-context/scripts/test-transform.mjs（追加一例）
- 问题：spec.md:195 的次序是「墓碑化 T → unbind(c) → 跳过 resolve → assignTag 新号」，实现只做了墓碑化。
  墓碑化的内存侧只是条件解绑，挡不住 assignTag 的内存快路径（tagger.ts:402-407）。可达场景：
  legacy inert 行的指纹 contentId 恰为 system 行现在的位置键、同位置又命中 role≠system 的旧 tag 时，
  assignTag 直接返回那个旧号，随后 replaceSourceContent 把 system prompt 写进它的原文——
  正是专门规则要防的行为。（主代理已读代码确认该分支确实没有 unbind。）
  可达前提（第 2、3 轮评审纠正）：assignTag 的数据库快路径是按 message_id 精确等值查，inert 行的键带前缀、
  等值永远命不中；真正的入口是**内存快路径**（tagger.ts:402-407）——tagger 的内存里该 contentId 已经
  绑着别的 tag。这个绑定每个 pass 开头就会发生：tag-messages.ts:953-955 把 inert 行的 contentId 绑进内存
  （按入站消息 id 做 inert 重放），空白 assistant 分支 :1319 也会绑定，都早于计划执行（:1365 起）。
  所以**单 pass 和双 pass 都可达**，单 pass（库里直接预置 inert 行 N + 同位置的旧 tag M + 入站该位置
  是 system 行）是更简的复现形态；上一轮说的「必须双 pass」不对。
- 改法：在该分支 `tombstonePositionTag(...)` 之后补 `tagger.unbindTag(sessionId, contentId);`，
  与 :1388 的漂移分支同构；分支注释补一句说明与漂移分支同款的理由。
- 验收/测试：新增用例 T-T12，双 pass、同一个 tagger、同一个库：
  pass 1：预置 inert 行 N（insertTag 后用 markWhitespaceAssistantTagInert，指纹位置 mc1:p0），
  入站 mc1 是一条只有空白 text part 的 assistant 消息，断言 wire 上重放出 §N§（这一步让 tagger
  的内存把 mc1:p0 绑到 N）。
  pass 2：同一 tagger 下再预置一条挂在 mc1:p0、role='user'、号比 N 小的旧 tag M，入站 mc1 换成一条
  role='system' 的非空消息。
  断言：system 行在 wire 上拿到不在 {M, N} 里的新号；M 的 message_id 已变成墓碑键；N 没有
  source_contents 行，entry_fingerprint 与 status 不变。
  **注册位置**：新用例的 `test(...)` 必须注册在既有 b5b 用例区（T-T11 之后），也就是 CR-12 移动后的
  执行循环之前——注册在循环之后的用例不会被执行，正是 b6 从未执行的病根；用例没被执行的话
  「必须先红后绿」就无从验证。
  test-transform.mjs 既有的解构 import 里没有 markWhitespaceAssistantTagInert，夹具要从 storage-tags 的
  解构里补这个名字。也可以先用更简的单 pass 形态（预置 inert 行 N + M@mc1:p0 + 入站 mc1=system）
  在当前实现上确认断言同样红，再补 unbind 看它转绿。
  **区分度要求：这条用例在补 unbind 之前的当前实现上必须红**（system 行拿到 N、N 出现原文行）；
  如果当前实现上也绿，说明夹具没走到内存快路径，停下报告，不要改断言。既有 T-T9/T-T10/T-T11 仍绿。
- 来源：review-scope-tag / system-B-1（第 1 轮）

### CR-4 [P1] e2e 两处断言口径的改动没有写回 spec
- 维度：A（spec 与实现不一致）
- 文件：docs/iterations/magic-context-trim-integrity/spec.md（Step 13 的 T-E1、T-E2）
- 问题：(a) T-E2 字面是「system 条目的 tag 没有被置为 compacted」的绝对断言，实现（提交 f71cd2d0，
  e2e-trim-integrity.mjs 的 E2.4）改为以跑任何 pass 之前的 system tag 状态为基线、断言没有新增
  compacted；(b) T-E1 写「条数相对 fork-inherit e2e 记录的基线只多出 system 段的条数」，实现
  改为同会话 V0（k=0）对照。
- 改法：T-E1 改为「条数与对话序列取同会话 V0 对照，V1 = 边缘条目（≤1）+ V0 + system 段」；
  T-E2 改为「以存量状态为基线，断言没有任何 system tag 新被置为 compacted」，并注明绝对断言在
  含存量损坏的真实库拷贝上不可满足，与「只防新损坏、不修存量」的设计目标一致。
- 验收/测试：spec 的 T-E1 / T-E2 与 e2e-trim-integrity.mjs 的 E1.3 / E2.4 实际断言逐句一致；纯文档改动。
- 来源：review-global / global-spec-2（第 1 轮）

### CR-5 [P1] spec 承诺的 CHANGELOG 已知问题缺失
- 维度：A（spec 风险表的处置列未兑现）
- 文件：CHANGELOG.md
- 问题：spec 风险表「存量已损坏的会话」一行要求「在 CHANGELOG 已知问题里说明」，本分支没有改 CHANGELOG。
- 改法：在当前未发布版本段落（没有就新建 Unreleased 段）补「已知问题」条目：存量库里已错位的
  `tags.message_id` 与已被覆盖的 `source_contents` 不会自愈；同时写明位置裁剪可能劈开工具调用与结果
  （孤立调用会被模型拒收）与「裁前缀只保留 system prompt、日期与 skills 列表等附加上下文仍会被裁」
  两项已知限制，内容以 spec「已知限制」一节为准。
- 验收/测试：CHANGELOG.md 出现上述条目，表述与 spec 已知限制一致；纯文档改动。
- 来源：review-global / global-spec-3（第 1 轮）

### CR-6 [P2] T-S5 的日志断言没有按会话过滤
- 维度：G（脆弱断言）
- 文件：apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-fork-inherit.mjs:568-574
- 问题：`!logText.includes('cached boundary')` 读全量日志，任何更早的用例触发同样的日志就会误失败。
- 问题补充（第 3 轮）：该用例读日志前也没有等一个 flush 周期，而包内日志是缓冲写
  （logger.ts:10，每 500ms 落盘）；同文件 T-S8 在读之前等了 600ms。不等的话负断言在缺陷回归时
  可能因为日志还没落盘而假绿。
- 改法：仿同文件 T-S8 的做法：读日志前先等 600ms，再按该用例的会话 id 过滤行，做 cache_hit 正断言
  与 cached boundary 负断言。
- 验收/测试：与同文件 T-S8 同构（先等 flush、按会话过滤、两条断言语义不变），fork-inherit 套件全绿。
- 来源：review-scope-system / system-G-2（第 1 轮）

### CR-7 [P2] T-S8 的注释与自身断言差一
- 维度：G（误导性注释）
- 文件：apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-fork-inherit.mjs:752
- 问题：注释写「边界 mc51 之前的对话（1..50）被裁掉」，用例实际断言边界是 mc52（对话 51 随裁）。
- 改法：改为「裁剪边界 mc52（对话 51）随裁：对话 1..51 被裁掉，52..150 是继承的 dropped 占位符」。
- 验收/测试：注释与同用例的断言一致；不影响测试结果。
- 来源：review-scope-system / system-G-3（第 1 轮）

### CR-8 [P2] 断言辅助函数用 label 字符串推断追加条数
- 维度：C（可维护性）
- 文件：apps/zcode-cli/packages/core/scripts/test-output-token-continuation-state.mjs:170-171
- 问题：`assertPrefixByReference` 里 `label === "T-C5" ? 1 : 2` 让错误消息标签承担分支语义，
  新用例换 label 会按错误条数断言。
- 改法：把期望追加条数改成显式参数。该辅助函数只有两个调用点（:197 的 T-C1、:272 的 T-C5），
  分别传 2 和 1；T-C2 不调用这个辅助函数（自己写了逐项引用断言），不要动。
  （第 1 轮评审写的「三个调用点」有误，第 2 轮两个评审独立纠正；主代理 grep 确认只有两处调用。）
- 验收/测试：在 apps/zcode-cli/packages/core 下跑
  `pnpm --filter @zcode/core exec tsx --test scripts/test-output-token-continuation-state.mjs` 仍 3/3 通过
  （要在 cmd 或 PowerShell 里跑，bash 转 cmd 时 `@zcode/core` 会被拆坏）；源码里不再出现 `label === "T-C5"` 这种由标签推断条数的分支。
- 来源：review-scope-core / core-G-1（第 1 轮）；第 2 轮 core-G-2、global-G-1 纠正改法

### CR-9 [P2] T-T11 的注释手算与公式不符
- 维度：G（注释错误）
- 文件：apps/zcode-cli/packages/magic-context/scripts/test-transform.mjs:2019-2021
- 问题：注释称 score(0)=3、score(+1)=1 并声称纠正了 spec 手稿；按公式复核 posIdx 无 mc16:p1 键、
  mc17:p0 是 tag8 的原文，score(0)=1、score(+1)=1，spec 手稿本来正确。
- 改法：注释改为 score(0)=1、score(+1)=1，并写明依据；删除「以公式复核为准」的纠正表述。
  实现时自己按公式重算一遍，以重算结果为准；若与评审结论不同，停下并报告。
- 验收/测试：注释与重算一致，T-T11 断言不变仍绿。
- 来源：review-scope-tag / system-G-2（第 1 轮）

### CR-10 [P2] user 消息里的空白文本 part 没有豁免出平移层
- 维度：B（v1/v2 口径不一致）
- 文件：
  - apps/zcode-cli/packages/magic-context/src/core/hooks/magic-context/tag-messages.ts:663-712
  - apps/zcode-cli/packages/magic-context/scripts/test-transform.mjs（追加一例）
- 问题：计划循环里空白判断（:709）排在平移分支（:663）之后，而主循环的空白豁免只对 assistant 生效，
  user 消息的空白 part 会消费平移计划，平移成立时被判成认领或漂移。:664-665 的注释说空白 part
  不消费计划，只对 assistant 成立。（主代理已读代码确认顺序如此。）
- 改法：把空白判断挪到 system 规则之后、平移分支之前（system 规则必须保持最先，spec 要求 system 行
  无论是否空白都走专门规则），并把 :664-665 的注释改成与实际一致。
- 验收/测试：新增**独立**用例 T-T13，同样注册在 b5b 用例区、CR-12 移动后的执行循环之前
  （不要往 T-T11 的夹具里加东西——它的手算注释和
  slice(1, 9) 断言写死了 part 数量）：自建一个平移成立的夹具（至少 3 个能验证平移的 part）+ 一条带
  空白 text part 的 user 消息。断言：空白 part 沿用其位置命中的既有号（位置无命中时新分配）、
  其位置上的旧 tag 没有被墓碑化。T-T1、T-T11 原样仍绿。
- 来源：review-scope-tag / system-A-3（第 1 轮）

### CR-11 [P2] 预扫描里每个 tag 单独点查原文
- 维度：E（可消除的重复查询）
- 文件：apps/zcode-cli/packages/magic-context/src/core/hooks/magic-context/tag-messages.ts:544-552
- 问题：`sourceOfTag` 每次未命中都调一次 `getSourceContents`（该函数每次 db.prepare，没有语句缓存）；
  计分对每个候选 × 每个位置命中都会调用它（同一 tag 号有 per-tag 缓存，实际点查数等于计分触达的
  不同 tag 数），而同一批数据已由
  `getSourceContentIndexBySession` 一次性载入内存。
- 改法：在 `buildTagContentPlans` 里用已载入的行建一张「tag 号 → 原文」的 Map 供 `sourceOfTag`
  使用（source_contents 对 (session_id, tag_id) 唯一，反转良定义），去掉逐 tag 点查。
- 验收/测试：全部 T-T* 用例不变仍绿；`buildTagContentPlans` 不再调用 `getSourceContents`。
- 来源：review-scope-tag / system-E-4（第 1 轮）

### CR-12 [P2] test-transform 的执行循环排在 b6 用例注册之前，b6 四条用例从未执行
- 维度：G（既有测试基础设施缺陷，影响本说明书多条的「全绿」口径）
- 文件：apps/zcode-cli/packages/magic-context/scripts/test-transform.mjs:2271-2282
- 问题：`for (const [name, fn] of cases)` 执行循环带顶层 await，位于 b6 系列四条用例的注册
  （:2343、:2372、:2401、:2430）之前；模块在循环处暂停，b6 在循环结束后才 push 进 cases，永不执行。
  末尾打印的用例数把 b6 算了进去，「PASS — N cases」失真。**不是本分支引入**（BASE 30209b79 上
  同样是 :1574 的循环在 :1643 的 b6 之前），b6「source_contents 恒 pristine」的护栏自加入起就没生效。
  主代理已核对行号与 BASE。
- 改法：把执行循环（含 failures 计数声明）移到 b6 四条用例注册之后、**两行 bestEffortRmSync 清理
  （:2476-2477）之前**、结果打印之前——即插在 :2474 与 :2476 之间。不能放在清理之后：用例都直接读写
  b4Db 这个临时库，清理先跑的话用例执行时库已被删（Windows 上常因文件被占用而删不掉才碰巧能跑）。
  其余用例零改动。
- 验收/测试：修复后跑 `test:transform`，实际执行的用例数等于 cases.length、输出里出现四条 b6 用例名，
  且两行 bestEffortRmSync 位于执行循环之后。
  **保险丝**：b6 四条若首跑就红，视为既有缺陷显形，停下报告，不得改断言迁就。
  CR-2、CR-3、CR-10、CR-11 的「test:transform 全绿」均以修复后的执行循环为准。
- 来源：review-scope-system / system-G-3（第 2 轮新证据，评审用同构探针实证）

## Spec deviations

- none（评审未报 open 的偏离；CR-1、CR-4 是「实现已变、spec 未跟上」，收敛后即闭合）

## Open questions / 待拍板

- `apps/zcode-cli/packages/core/src/runtime/methods/turn-output-token-continuation.ts:78-88` 的
  `preserveCanonicalContextPrefix` 疑似死代码（全仓无调用方）。不在本次 diff 内，不进 must-fix；
  是否另行清理请拍板。
- v2 的 d* 与三分支计数在包内没有可读出口，e2e 仍以 0 占位；是否值得加一个只读出口请拍板。

## 已豁免（用户确认不修）

- 无

## 合并后 QA（manual_user，不阻塞）

- 在界面上对一个长会话点分叉、发一条消息：子会话首轮应成功，上下文用量与父会话同量级（spec Step 14）。
- 长会话续写（输出被截断后自动续写）一轮，确认第二次请求不被模型以「缺少工具结果」拒收。

## K 节建议（下游执行时闭合）

- 源码改动提交前跑：magic-context `test:all`、core 与 bootstrap 的相关脚本、根目录 lint、
  architecture:check、根目录 typecheck、cli 子树 turbo typecheck。
- CR-1、CR-4 改完 spec 后，在 spec 开头的说明处标注「v3：评审后同步」并保留原有行号说明。

## Fix-Spec Closure

| 项 | 状态 |
|---|---|
| fix-spec-ready | yes（终态认证在最后一次修订之后完成） |
| fix_spec_path | docs/iterations/magic-context-trim-integrity/cr-fix-spec.md |
| dag_version / review_round | 5 / 5 |
| review-global 每轮参与 | yes |
| 末轮 review-final | 通过（未写入的开放 must-fix 为 0） |

执行后记（2026-11-26）：12 条已执行并提交（cdfa3ca0、5699a783、394f4066、f8fe1bc4）。全量检查与换人功能小检通过；小检只带回两条行号漂移的 nit（spec 里 classifyAbsentBoundary 的起始行、本文件 CR-3 引用的漂移分支行号），前者已顺手改正，后者是本文件落盘时点的行号、保留不改。先红后绿由主代理回退 tag-messages.ts 实测：71 cases / 2 failures。
| P0 / P1 / P2（已写入 fix-spec） | 0 / 5 / 7 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none |
| C-orch | ✅（第 4 轮跨切面评审：无平行入口、无模块间契约断裂；全局参与每轮） |
| C 类合并后 QA | 见上 |
