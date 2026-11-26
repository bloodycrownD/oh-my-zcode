---
date: 2026-11-26
---

# magic-context-trim-integrity 技术规格（SPEC）

> **v3（2026-11-26，评审后同步）**：按 cr-fix-spec（CR-1、CR-4）补记两处「实现已落、spec 未跟上」的内容——边界判定的连带修复（`firstPersistedLiveId` 跳过豁免的 system 段，见问题一「连带修复」段）与 e2e 两处断言口径的改写（T-E1 同会话 V0 对照、T-E2 以存量状态为基线）；并把本轮评审的用例登记进测试策略（T-S8 为既有用例补登记，T-S9、T-T12、T-T13 为新增用例）。问题一的表格行号保留原值并补现行锚点，问题三的行号说明保留原样，实现时以函数名为准。

## 需求来源

用户口述（2026-11-26）：v1.0.37 发布完成后，修复 magic-context-fork-inherit 迭代中用真实数据复现出来的三个既有问题，走 spec → check → dev → cr → e2e 流程。背景见 `docs/iterations/magic-context-fork-inherit/spec.md` 末尾「实现过程中发现的既有问题」。

1. 长会话发给模型的请求里没有 system prompt：裁前缀对头部整体裁，没有豁免。
2. 折叠后的条目再次进入 transform 会打乱工具调用与结果的配对，模型拒收（续写路径会走到）。
3. 长会话多次重启后 tag 的坐标不可靠，`ctx_expand` 取回的原文可能已经不是原来那条。

记忆文件：`docs/apm/memory/20261126-magic-context-trim-integrity.md`。

## 设计目标

- 长会话裁前缀之后，请求仍然以开头的 system prompt 起头，顺序与未裁剪的短会话一致；稳态的每一类 pass（重建、缓存回放）都如此。
- transform 永远拿 canonical 全量历史作为输入；本轮内再次调用（输出续写、切模）不再把上一次的折叠产物喂回去。
- 重启导致前缀长度变化后，tag 不再按位置错绑、不再把别的消息的文本写进旧 tag 的原文、编号尽量保持；`ctx_expand` 取回的是该 tag 自己的原文。
- 三项修复都只防止新的损坏，不自动修复存量库里已经错位的 tag（见「风险与回滚」）。

### 待用户确认的两项选择

复述闸门时向用户提了两个问题，未收到回答，先按推荐项成文：

- **前缀范围**：只豁免 system prompt。附加上下文（当天日期、skills 列表、用户环境信息）保持现状（随前缀裁掉）。若用户选「也保留」，改动集中在同一段 helper 与同一个判据（见 Step 2 的扩展点）。
- **tag 漂移的档位**：本次做「位置命中时校验内容 + 内容认领」；「给条目稳定身份」列为后续迭代，不在本 spec 范围。**v2 追认项**：真实数据证明上面的逐条判据只覆盖 2%–4%，本次范围实际扩大为「先识别窗口整体平移，再按位置找回真身」（问题三的（b′）），仍在包内、仍不做稳定身份、仍不迁移数据。另有一项需要用户知情：**位置裁剪会从工具调用与结果中间切开**是既有缺陷，本次不修、单独立项（见已知限制）；孤立调用会被模型拒收。

## 总体方案

### 问题一：裁前缀丢 system prompt

**根因**：`inject-compartments.ts` 的裁前缀对消息数组头部无条件整体裁。同构的头切片共**五处**，按所在分支组织：

| 编号 | 位置 | 分支 |
|---|---|---|
| S0 | `:456-473`（splice 在 `:473`） | `prepareCompartmentInjection` 的**缓存注入回放分支**：`!isCacheBusting && usableCached` 时用缓存的 `compartmentEndMessageId` 在每轮新投影上重切头部。这是缓存安全的 defer pass（稳态大多数 pass）的常态路径 |
| S1 | `:680-681` | `prepareCompartmentInjection` 的 rebuild 分支主切片（legacy 以最新 compartment 边界、modern 以 baseline 冻结边界为 `trimEndMessageId`，`:619-644`） |
| S2 | `:717-718` | rebuild 分支的 degraded re-anchor 切片 |
| S3 | `:3841-3853` | `trimToPreparedPrefix` 的 findBoundaryIndex 兜底分支（`splice(0, index+1)`） |
| S4 | `:3776-3840` | `trimToPreparedPrefix` 的 source-order 分支 |

> **行号说明（v3，2026-11-26 核验）**：本表行号冻结于实现之前；v1 落地后 `inject-compartments.ts` 因插入豁免与退化判定代码整体下移。现行锚点：`leadingSystemRunLength` 在 `:422`、退化判定 `isDegenerateLeadingSystemTrim` 在 `:442`；S0 缓存回放切片 `:510-545`（splice `:544`）、S1 rebuild 主切片 `:753-784`（splice `:782`）、S2 re-anchor 切片 `:813-843`（splice `:840`）、S3 findBoundaryIndex 兜底 `:3999-4028`（splice `:4021`）、S4 source-order `:3909-3998`（retained 收集 + splice `:3993`）。实现时以函数与分支名为准。

唯一的豁免 `isHostRenderedSystemMessage`（`host-served-rows.ts:104-109`）只认**无 id** 的 system 消息；ZCode 投影给 system 条目也发了 `mc<序号>` id（`host/types.ts:363`），所以豁免够不到。上游宿主把 system prompt 放在消息数组之外（`session_meta.system_prompt_tokens` 列，ZCode 从不写，`storage-meta-shared.ts:324-325`），上游因此没有这个问题。

**方案（包内豁免）**：新增 helper `leadingSystemRunLength(messages)`，返回数组开头连续的 `role === "system"` 且带 id 的消息条数 k（k 可为 0）。五处切片在裁剪时保留这 k 条，并把它们放在裁剪结果的最前。裁剪之后的顺序与今天未裁剪的短会话一致：包内 `injectM0M1`（`:3903-3917`）把 m[0]/m[1] 头 unshift 到最前 → bootstrap 的 `hoistHeadsAfterSystemPrefix`（`magic-context-turn-transform.ts:851-877`）把头挪回 system 段之后 → 最终请求 = `[system..., m0, m1, 末端消息...]`。

**「跳过条数」的语义必须同步改**：S1/S2 产出的 `skippedVisibleMessages` 被下游用于切出「压缩边界之前的消息」——`transform.ts:1954-1955`、`:1972-1983` 用 `messagesBeforeInitialPrepare.slice(0, skippedVisibleMessages)` 得到 `trimmedMessagesAtCompactionBoundary`，`transform-postprocess-phase.ts:2997-3002` 把这些 id 交给 `markTagsCompactedByMessageIds`（`storage-tags.ts:1826-1861`，`status IN ('active','dropped') → 'compacted'`，SQL 无 role 过滤）。豁免后 system 行仍在请求里，若仍落在该切片中，每次 cache-busting + deferred pending 的 pass 都会把仍在服役的 system prompt 的 tag 持久翻成 compacted。处置：

- 新增并行输出 `prefixTrimRemovedMessageIds`（S1/S2 处显式记录被移除的消息 id 列表）。
- `skippedVisibleMessages` 的数值语义改为「实际移出请求的条数」（不含 k 条豁免行）。
- 该变量全仓共三个消费方，逐一处置：
  1. `transform.ts:1975-1978`（`trimmedMessagesAtCompactionBoundary`）：优先由 `prefixTrimRemovedMessageIds` 映射回消息得到；列表缺席时才回退到 `slice(0, skipped)`，回退只在 k = 0 时与显式列表等价。
  2. `transform.ts:1979-1982`（`selectHiddenMessagesAtCompactionSeam(messagesBeforeInitialPrepare, skipped)`，内部 `slice(0, skipped)`，`inject-compartments.ts:404-417`，从后向前找 user 行）：**同样按「前 N 条」切片，必须一并改造**——改为接收显式的被移除消息列表（FORK 注释）。只改数值不改它会错位：切片变成「k 条 system 行 + 被移除集合的前段」，窗口尾部缺 k 行会改变 marker 判定，进而影响 postprocess `:2956-2989` 的占位符中和与 `transform.ts:2088-2091` 的 `messagesForTagging` 门控（直接改变本 pass 的 tag 坐标）。
  3. `transform-postprocess-phase.ts:2885`：纯日志，无需改。

**退化输入**（裁剪点落在 system 段内，即 cutoff < k）：不做裁剪。S0/S1/S2 不切片、照常返回；S3/S4 返回 `PrefixTrimStatus = "refused"`，与既有「裁剪被拒」语义一致——随后 `transform.ts:2689-2708` 的 fail-closed 判定照常生效（超窗即 MC-H04）。现实中不可达（边界是会话行 id，位于前缀之后），属防御；记一条 debug 日志。

**为什么不选另两个方案**：

- 宿主在包外补回（bootstrap）：LKG 重放绑定的是「包输出的字节」（`lkg-replay.ts:173-174`、`transform.ts:2912-2917`），宿主改写后包内记账与线上请求差一个常量段；token fit 估算里 system 计 0，会系统性低估；且每次 pass 头部重插会加剧坐标平移。
- core 补回：core 对 magic-context 零感知，无法知道包是否有意裁掉；包内修复后会出现双 system。

**包内豁免的自洽性**：豁免发生在 transform 自己的消息数组上，输出含 system → LKG 捕获的字节含 system → `foldBustsServedPrefix`（`transform-postprocess-phase.ts:1879-1891`）比较的 m0/m1 字节不受影响；token 估算（`final-wire-token-estimate.ts:234-302`）逐条遍历消息数组，system 行按对话行计入（顺带修掉今天 system 计 0 的低估）；MC-H04 判定作用在裁剪后的数组上。system 条目照常参与打标（它们本来就有 tag，system-prompt-guard 的四道防线管的是 tag 状态，与本改动正交）；但 system 行留在打标窗口里会与问题三的判定链相互作用，专门规则写在问题三的「入站 system 行的专门规则」。另：legacy / 兜底路径下 `renderCompartmentInjection`（`:793-843`）会把 `<session-history>` 块并入 `messages[0]` 的正文，豁免后 `messages[0]` 由「裁剪点后首行」变成 system 行——这与未裁剪的短会话今天的行为同形，属预期，CR / E2E 不要误判。

**连带修复（absent-boundary 分类跳过豁免段，提交 3577a02f）**：豁免让裁剪后的数组头部仍是 system 行，而 `firstPersistedLiveId`（`inject-compartments.ts:3695-3709`）原本取「数组里第一条带 id 的持久消息」当窗口起点，会把豁免段首行（`mc1`）当成首条持久行。它的消费方 `classifyAbsentBoundary`（`inject-compartments.ts:3796-3838`）在摘要边界不在本轮消息数组里时（S3 兜底的 `:4026` 调用点）用它判定「边界是否排在窗口之前」：排在之前返回 `boundary-precedes-window` 并记日志 `prefix trim: boundary <边界> precedes the first remaining message <首条持久行>; …; nothing to cut`；否则进入 degraded 计数并返回 `refused`，记 `prefix trim: boundary <边界> absent from current messages; …`。失败形态：若不跳过豁免段，`mc1` 恒排在边界之后 → absent-boundary 分类恒 `refused` → 请求不裁 → 超窗时被 fail-closed 判定拒发（MC-H04）——真实库 e2e 抓到的形态。修复：`firstPersistedLiveId` 先经 `leadingSystemRunLength` 取豁免段长度，从豁免段之后起扫描，并沿用原有的 `isHostRenderedSystemMessage` / `isHostCompactionHeadRow` 过滤（`:3705`）；豁免段不参与「窗口从哪里开始」的比较。回归守卫见 T-S8。

### 问题二：折叠后的条目再次进入 transform

**根因**：全仓库唯一的生产者是 core 的输出续写路径。`turn-model-step.ts:574` 在 `outputTokenContinuation !== "none"` 时执行 `state.turnRequestState.entries = options.requestEntries`，把 transform 折叠后的请求条目写回 turn-local 请求状态；`turn-loop.ts:114` 下一迭代以它为 transform 输入。输入位置整体前移后，tag 按位置字符串错位重绑（`tag-id-fallback.ts:92-117`、`tagger.ts:404-433`），`applyFlushedStatuses` 把 dropped 状态打到错误的 part 上，`drop()` 只移除弧的一侧（`tool-drop-target.ts:501-518`），旧摘要边界按字符串精确匹配切在错误位置（`inject-compartments.ts:3496-3504`），模型拒收 `Tool results are missing for tool calls`。

正常的工具循环与请求重试都在 pre-transform 数组上重跑 transform（`turn-model-step.ts:221-232`、`:239-299`、`:644-646`、`turn-tools.ts:357`），位置稳定，不受影响。`state.turnRequestState.entries` 的赋值点全仓只有两处：待删的 `:574` 与切模的 `turn-guide-drain.ts:45`。

**方案（core 不再写回）**：删除 `turn-model-step.ts:574` 这行赋值，以及随之失去用途的 `requestEntries` option（接口 `:88`、调用方 `turn-loop.ts:169`）。`requestEntries` 在 core 里的使用点只有这两处（`turn-loop.ts` 的局部同名变量与 helper 注释不受影响）。删除后 `state.turnRequestState.entries` 始终是 transform 之前的数组；续写的两个追加点（`commitTurnRequestEntries` `:98-106` 与 `appendOutputTokenContinuation` `:139-142`）都落在这个数组上，所以第二次 transform 的输入 = 全量历史 + 新 assistant 条目（模型有非空输出时）+ 续写 user 条目，由 transform 自己重新裁决裁剪。模型部分输出为空且无 reasoning 时 `persistCompletedAssistantStep` 提交失败（`turn-stop.ts:47-59`）、不追加 assistant 条目。

`:571` 的分支同时覆盖 `continue` 与 `exhausted` 两个子分支（`:584-588`、`:590-628`），两者此前都先执行 `:574`；删除后 exhausted 子分支抛错前的 entries 也是 pre-transform + assistant 条目，行为同样正确。

这是通用正确性修复（turn-local 请求状态不应被下游投影改写），core 不需要感知 magic-context，不违反 core 零依赖纪律（`core/src/runtime/helpers/magic-context-turn-transform.ts:1-26`）。

切模路径不需要独立用例：`rebuildContextPrefix`（`turn-guide-drain.ts:45-48`）的输入就是 `state.turnRequestState.entries` 本身，删掉 `:574` 后该数组恒为 pre-transform，切模的输入自动正确；T-C1 / T-C2 守住的正是这个不变量。

**时序（修复前 → 修复后）**：

```
修复前（折叠产物回灌）                              修复后
──────────────────────────────────────────────      ──────────────────────────────────────────
turn-loop    :114  providerEntries = [...entries]    turn-loop    :114  providerEntries = [...entries]
             :119  requestEntries = transform(...)                :119  requestEntries = transform(...)
             :169  runModelBackedTurnStep(..., requestEntries)    :169  runModelBackedTurnStep(...)
model-step   :574  entries = requestEntries  ← 写回   model-step   （删除）entries 不动
             :575  persist assistant → 追加到 entries              :575  persist assistant → 追加到 entries
             :585  append 续写 user → 追加到 entries               :585  append 续写 user → 追加到 entries
下一迭代          transform 输入 = 折叠产物 + 2       下一迭代          transform 输入 = 全量历史 + 2
                  （位置前移 → 错位重绑 → 弧断裂）                      （由 transform 重新裁决裁剪）
```

**行为面（属预期，CR / E2E 不要误判为回归）**，分两种迭代：

- 输出恢复期间的迭代：`turn-loop.ts:43`、`:66-106` 在 `outputTokenRecoveryActive` 时关掉 runtime-command drain 与全部四类提醒，提醒内容不变——由机制保证。
- 恢复结束后的下一个迭代（`turn-model-step.ts:630` 复位后）：mode / todo 提醒判定（`turn-loop.ts:75`、`:87`）与切模 `rebuildContextPrefix`（`turn-guide-drain.ts:45-48`）的输入从今天的「折叠后的数组」变为「pre-transform 全量数组」，判定结果可能不同。这是预期的修正（判定本就应该基于 canonical 历史），不是回归。

`:572-573` 的注释声称写回是为了保留「一次性的 project-memory attachment」。探索结论是 m[0]/m[1] 属 per-request 组、每轮由 transform 重新注入（`core/src/system-reminder/source.ts:51-57`），request-only 的增量条目在 pre-transform 数组里同样保留；该注释的动机是否已过时没有文档定论，因此用测试确认（T-C2）。

### 问题三：tag 坐标重启后漂移

> **行号说明（2026-11-26）**：本节「根因」「现状」描述里的 `tag-messages.ts` 行号冻结于实现之前；v1 落地（提交 2db1848d）后该文件下移约 416 行（例如原文比对与覆盖现在在 `:1296-1325`，`resolver.resolve` 的主流程调用点在 `:1244`，`collectRelevantSourceTagIds` 在 `:350-369`）。承载 v2 动作的锚点（`:1227` 的无条件 unbind、`:1310-1325` 的写点、`tag-id-fallback.ts:92-117`、`tagger.ts:402-407` / `:695-707`）已按现行代码核验。实现时以**函数名**为准，顺手把触碰到的区块刷成现行行号。

**根因**：ZCode 运行时条目没有 id，文本 tag 的身份是位置字符串 `mc<N>:p<下标>`。重启后 context 前缀长度变化 d，整个窗口平移；tagger 命中 contentId 时不比对内容（resolver 精确命中 `tag-id-fallback.ts:92-96`；DB fast path `tagger.ts:545` → `storage-tags.ts:1970-1977`；内存 map `tagger.ts:404-407`）。命中的后果（`tag-messages.ts:923-937`）：位置 N 上的新消息文本被 `replaceSourceContent` 写进旧 tag 的原文，旧编号 `§N§` 盖到新内容上。`ctx_expand` 的 tag 模式不读存的原文，而是按位置 id 读当前条目（`core/tools/ctx-expand/render.ts:285-347` → `raw-message-provider.ts:336-352`），所以直接取到错位的消息。

**约束**：「同一位置换成另一条消息 → 以入站为准、覆盖原文」是编辑重发（rewind 编辑重发）刻意修的行为（`tag-messages.ts:916-922` 的 FORK 注释、`test-transform.mjs:951-995` 的 b5 用例）。位置身份在结构上无法区分「用户改了这条消息」与「重启漂移」，必须用内容信号区分。`tags` 表对 `message_id` 没有唯一约束（`storage-db.ts:1169-1184`，只有 `UNIQUE(session_id, tag_number)`），内存 map 按 contentId 单值（`tagger.ts:695-701`）——任何「把另一个 tag 绑到已被占用的 contentId」的做法都必须先挪走原占用者，否则留下双绑定。

**方案：预扫描出计划，再就地执行**。判定所需的数据全部来自 pass 开始时的静态快照，不依赖 pass 内的处理顺序。

**（a）pass 级预扫描**（惰性：本 pass 第一次遇到文本 part 时构建一次）

- `inbound`：`Map<contentId, X>`，本 pass **参与打标的**（带 contentId 的）全部入站文本 part 的 contentId → 去章文本 X。tagMessages 只给带 message id 的 part 打标（`tag-messages.ts:787`），无 id 的文本 part 不计入——与计划的判定域一致，否则「X 只出现一次」的判定会因口径漂移。
- `sourceIdx`：`Map<content, tagId[]>`，本会话 `source_contents` 全表（一次 `SELECT tag_id, content FROM source_contents WHERE session_id = ?`；`content` 无索引，`storage-db.ts:2032` 只有 session 索引，长会话数千行，按 pass 常驻内存可接受；文本 part 可为 data URL，实现时不复制字符串本体）。
- `tagRows`：本会话 `tags` 行（一次查询，`ORDER BY tag_number ASC`），由调用方建两个索引：
  - `posIdx`：`Map<messageId, row>`，同一个 `message_id` 挂多行时取 `tag_number` 最小的一行，过滤条件与既有的 `getAssignableTagNumberByMessageId` 一致（`storage-tags.ts:787-799`：排除 `status = 'compacted'` 且 `entry_fingerprint` 为 whitespace-inert 前缀的行，因此行数组要带 `entry_fingerprint` 列）——保证确定性；
  - `rowByTag`：`Map<tagNumber, row>`，供按 tag 号反查候选的类型 / status / message_role / message_id（认领判据要用），以及取 S(T)——S(T) 经 `getSourceContents(db, sessionId, [T])` 单查（`storage-source.ts:40-63`；`source_contents.tag_id` 与 `tags.tag_number` 同域）。
- 索引构建的归属：`sourceIdx` 由 `storage-source.ts` 的函数构建（变更点 #7；该文件现在只 import shared）；`posIdx` 与 `rowByTag` 由 `tag-messages.ts` 根据 `storage-tags.ts` 返回的行数组（变更点 #6）自建。两个存储文件之间不互相依赖。

**（b）为每个入站文本 part 制定计划**（纯内存计算；**在（b′）的整体平移不成立、即 d = 0 时生效**，平移成立时由（b′）优先接管）

记该 part 的 contentId 为 c、去章文本为 X；位置候选 T = `posIdx[c]`。

| 情形 | 条件 | 动作 |
|---|---|---|
| 相符 | T 不存在（认领不成立时同样正常分配）；或 T 存在且（S(T) 不存在 或 S(T) === X 或 X 去章后为空白） | 今天的行为：有 T 沿用 T；无 T 走正常分配 |
| 内容认领 | 存在唯一候选 R：`sourceIdx[X]` 恰有一个元素、R ≠ T、R 的 `type = 'message'`、R 的 status 为 `active`、R 的 `message_role` 非 NULL 且 ≠ `'system'`、R 的 `message_id` 不是 inert 前缀（`__mc_whitespace_assistant_inert__:`）、且 X 在 `inbound` 的值里只出现一次（本 part 独有） | 使用 R。若 T 存在（位置命中了别的 tag），对 T 做**墓碑化** |
| 漂移 | T 存在、S(T) 有定义且 ≠ X、X 非空白、认领不成立、且 `sourceIdx[S(T)]` 恰为 `[T]` 并有**另一个**入站 part 的文本等于 S(T) | 不沿用 T：对 T 墓碑化，为 X 分配新 tag，**不覆盖 S(T)** |
| 编辑重发 | T 存在、S(T) ≠ X、非空白，以上都不成立 | 保持 b5：沿用 T、覆盖原文 |

「内容认领」同时覆盖「位置命中了别的 tag」与「位置上没有任何 tag」（窗口末端的消息平移后落在新位置上，必然是后者）两种情况；只在位置命中时才认领会让末端消息每次前缀增长都换新号，并留下一个搁浅的 active 旧号被 sidebar / protected-tail 的 SUM 双计（`tagger.ts:418-431`、`storage-tags.ts:245`、`:606`）。

**（b′）整体平移层——v2 修订，优先于上表**（2026-11-26 真实数据 e2e 后新增）

真实库实测推翻了上表的覆盖率前提：位置绑定的文本 tag 里，上表「漂移」行能识别的只有 2.0%（fork 子会话，未裁剪形态，104 / 5118）与 4.1%（最长会话，裁剪形态，94 / 2306）。原因是两个条件的叠加——`sourceIdx[S(T)]` 恰为 `[T]` 要求原文全库唯一持有，而真实会话里子代理通知、措辞相近的报告大量重复；「S(T) 还活在入站里」在裁剪形态下对窗口外 tag 恒不成立。识别不了的全部落进「编辑重发」桶覆盖原文（实测一次平移改写 92 条）。因此把「编辑重发」当兜底桶不成立，判定改为先识别平移本身：

- **物理模型**：重启后 context 前缀长度变化 d，窗口内每个条目的位置整体平移 d，条目内 part 下标不变。条目 X 在位置 c = `mc<p>:p<i>` 的真身，是「上一代位置 `mc<p−d>:p<i>` 上的 tag」T′，与 X 的文本是否唯一无关。
- **识别 d**（纯内存，预扫描阶段）：
  - 候选集：0，加上对每个满足「`sourceIdx[X]` 恰有一个 `type = 'message'` 持有者 R，且 R 的 `message_id` 是位置键 `mc<q>:p<i>`」的入站文本 part 取 `d = p − q`。不设固定范围，候选由数据给出。
  - 计分：`score(d)` = 窗口内满足「`posIdx[mc<p−d>:p<i>]` 存在且其 S === X」的入站文本 part 个数（按内容在平移后的位置上验证，重复样板只增加真阳性）。
  - 判定：取 score 最大的 d*；当 `score(d*) ≥ 3` 且 `d* ≠ 0` 时**平移成立**，否则视为无平移（d = 0）。score 相同取 |d| 小者，再相同取正者（确定性）。
  - 口径与限制：(i) 候选采集与计分都**排除 `info.role === "system"` 的入站 part**（与下面「system 行不进平移层」同口径；system prompt 有存量原文时会产出垃圾候选）。(ii) 候选集依赖「至少一个唯一持有且以位置键绑定的文本 part」——全样板窗口下候选集只有 0，平移识别不出，按 d = 0 走 v1，写入已知限制；测试夹具必须保留至少两个这样的 part 专供候选集，并接受它们在 v1 下也被判对（它们不是用例的区分点）。(iii) 平移识别是 pass 级的一次性判定，同一 pass 内所有文本 part 共用同一个 d*。
- **平移成立时**，对每个入站文本 part（c、X；位置候选 T = `posIdx[c]`；T′ = `posIdx[mc<p−d*>:p<i>]`）：

| 情形 | 条件 | 动作 |
|---|---|---|
| 平移相符 | T′ 存在、T′ 不是 whitespace-inert 行（`inertWhitespaceTagNumbers` 或 `entry_fingerprint` 的 inert 前缀；inert 行从不写原文，「S 不存在」不能把它当成真身）、且（S(T′) 不存在 或 S(T′) === X） | 绑定到 T′：若 T 存在且 T ≠ T′，先对 T 墓碑化；`rebindTagMessageIdFenced(T′, {预扫描时 T′ 的 message_id, 墓碑键(T′)} → c)`，changes > 0 才 `bindTag(c → T′)`；**不改 status**（dropped 的主人平移后仍是 dropped，未裁剪形态的会话不会因此解折叠） |
| 平移不符 | T′ 存在且（是 whitespace-inert 行 或 S(T′) 有定义且 ≠ X） | T′ 不动；若 T 存在对 T 墓碑化；以 `accept: () => false` 调 resolve 后 `assignTag` 新号；**不覆盖任何原文** |
| 平移落空 | T′ 不存在 | 若 T 存在对 T 墓碑化；与「平移不符」同款，以 `accept: () => false` 调用 resolve 后 `assignTag` 新号（**不要跳过 resolve**：跳过意味着该 contentId 不进 resolver 闭包私有的已认领集合，与本文件对 `claimedContentIds` 的论述矛盾；这样调用零成本，且与「认领围栏未命中」「v1 漂移」两个先例同构） |

  平移层的三个分支都**不写 `source_contents`**：平移相符时原文与 X 恒相等（经预扫描索引判等后跳过 `:927-930` 的幂等写），其余两个分支不沿用任何旧号。
- **平移层的内存操作**（与 v1 的两个分支结构同款，逐项照搬，不可省）：
  - 平移相符 = 结构上的「认领 R」（R = T′）：`bindTag(c → T′)` 之前读 `getTag(c)`，若既不是 T 也不是空则记 warn 后继续（代码同时豁免「 incumbent === T′」的情形，以代码 `tag-messages.ts:876-880` 为准）；对 T′ 的旧键 `mc<p−d*>:p<i>` **仅当 `getTag(旧键) === T′` 时 unbind**（旧键上此刻可能是本 pass 刚绑上去的别的 tag）；`claimedSourceEcho.set(T′, X)` 以跳过幂等写；随后的 resolve 沿用常规路径的 inert 排除 accept。`changes = 0` 时**不 bind**，按「平移不符」同口径降级并记 warn。
  - 平移不符 / 平移落空 = 结构上的「漂移」：墓碑化之后**无条件 `unbindTag(c)`**（v1 漂移分支正是如此，`tag-messages.ts:1227`）。墓碑化的内存侧本身是条件 unbind（仅 `getTag(c) === T` 时），内存与 DB 不一致的防御场景下挡不住 `assignTag` 的内存快路径（`tagger.ts:402-407`）把 c 上残留的旧号送回来、再经 `:1310-1325` 把 X 写进那个号的原文——恰好复活要禁止的改写。
  - 墓碑化 T 时 `changes = 0`（T 已被它自己的主人——位置 `mc<p+d*>:p<i>` 上的 part——重绑走）视为已被处理、不报错，且这正是正确行为：T 已归位，不该再墓碑化。
- **无平移（d = 0）时**：完全按下表（v1）判定——唯一 active 候选的内容认领、「S(T) 还活在入站里」的漂移、编辑重发（b5）保持不变。窗口末端新追加的消息（位置上没有 tag）在两种情形下都按下表的认领规则处理。
- **与 system 行专门规则的关系**：入站 system 行仍走下面的专门规则，不进平移层（system 段在 canonical 头部，跨代位置稳定，不参与整体平移）。
- **认领围栏未命中**（`changes = 0`）：与下文一致，按「屏蔽 scoped fallback 后 `assignTag` 新号」处置并记 warn。
- **为什么不是「分不清就拿新号」**：未裁剪形态的长会话里窗口大半是已折叠消息，status 跟 tag 号走；拿新号等于把数千条已折叠消息解折叠，上下文直接膨胀。平移相符分支让这些消息保号、保 status。

**入站 system 行的专门规则**（问题一的豁免让它可能成为窗口里孤悬在最前的一行，必须单独设防）：问题一之后，system 行留在请求里、照常参与打标，而它后面直到裁剪边界的消息全部被裁。system 段恒在 canonical 头部，跨代位置多数时候稳定在 `mc1..mck`，那时位置命中的就是上一代的 system tag、按下面的沿用分支处理。但在这些情形下，system 行的位置 id 会命中的一个**非 system** 的旧对话 tag：fork 子会话（继承的 tag 经内容对齐落在子坐标上）、system 段条数 k 跨代变化、v10000 之前的 NULL-role 存量行。命中的后果：对它而言认领不成立（候选要求 active 且非 system，system 行的旧 tag 因 role 过滤永远不会被认领）、漂移也不成立（S(T) 不在入站窗口）。若落进「编辑重发」分支，`replaceSourceContent(T, X)` 会把 system prompt 写进那条对话的存量原文，`stampTagMessageRole` 把它的 role 改成 `'system'`，若它本是 dropped，防线三（`apply-operations.ts:552-556`）会在下一 pass 把它自愈回 active。ZCode 投影里不存在「用户编辑重发 system 行」的场景，所以：

- 入站 `role === "system"` 的文本 part（**无论文本是否空白**——空白 system part 走今天的路径也会被 `:908` 无条件把 T 的 role 改成 system），位置命中的 T **只有在 T 自己的 `message_role === 'system'` 时才可沿用**（内容不同也沿用并覆盖——这是 system 槽位换内容的正常情形，例如 system prompt 在版本间变化）。
- 否则视为**没有位置候选**：不沿用 T、不覆盖 S(T)、不改 T 的 role；对 T 墓碑化（只挪位置键，内存条件 unbind）；**跳过 `resolver.resolve` 直接 `assignTag`**（不调用 resolve，scoped fallback 自然无从触发；不要以默认 accept 调用——`mc1:*` 桶里可能挂着上一代 m0/m1 等 synthetic head 的旧 tag，回退匹配会把它重绑到 system 行上）。为该 system 行正常分配新号。
- 代价（写入已知限制）：这种情形下 system 行的旧 tag 不会被认领，它拿新号，旧号以 active 搁浅；数量上限约为「触发次数 × system 段条数」。

认领只取 active 候选：dropped 的 tag 被认领等于把一条活着的消息交给折叠状态（`applyFlushedStatuses` 会把它折成占位符）；compacted 是退役号；system tag 受保护，且 `:908` 的 `stampTagMessageRole` 会把它的 role 改写掉——`message_role` 为 NULL 的存量行（v10000 升级前的行、provider 未给 role 的行）可能是 system prompt 行，同样排除。`type` 必须是 `'message'`：file tag 的原文（`tag-part-guards.ts:41-49`）就是同消息文本 part 的去章拼接，消息 tag 被编辑重发改写后它可能成为唯一候选，被文本 part 认领会让 file part 丢号。fork 继承会为窗口外的消息搬入 `source_contents`，扩大了反查集合，因此这层过滤不可省。

**只参与计划的 part**：带正文的文本 part。whitespace-only 的 assistant part（`tag-messages.ts:791-876` 有专属的 rank 重放 / inert 处置，且从不写 `source_contents`）与 file part（contentId 形如 `mcN:fileK`）不参与计划，照旧走各自分支。例外见下面「入站 system 行的专门规则」——入站 system 行无论文本是否空白都适用。

**（c）就地执行**（主循环走到该 part 时按计划执行）

**pass 内的判定与执行次序**：

```
tagMessages(session, messages)
│
├─ 预扫描（本 pass 首个带 contentId 的文本 part 触发，只做一次）
│    inbound  ← 全部带 contentId 的文本 part（contentId → 去章文本）
│    sourceIdx ← storage-source：本会话 source_contents
│    tagRows → posIdx / rowByTag ← storage-tags：本会话 tags 行
│    计划：每个文本 part → 相符 | 认领(R) | 漂移 | 编辑重发 | system 规则
│    （v2：先识别整体平移 d*；d* ≠ 0 时改为 → 平移相符(T′) | 平移不符 | 平移落空）
│         平移相符：墓碑化 T → rebind T′（changes>0）→ 内存同认领 → 默认 resolve（精确命中 T′）
│         平移不符 / 落空：墓碑化 T → 无条件 unbind → resolve(accept: () => false) → assignTag 新号
│
└─ 主循环，逐 part：
     part 在计划里是 认领 / 漂移 / system 规则？
       ├─ 是 → 先执行计划（必须早于 resolver.resolve）
       │        认领：墓碑化 T → rebind R（changes>0）→ bindTag(c→R) → 默认 resolve（精确命中 R）
       │        漂移：墓碑化 T → unbind(c) → resolve(accept: () => false) → assignTag 新号
       │        认领 changes=0：同漂移
       │        system：墓碑化 T → unbind(c) → 跳过 resolve → assignTag 新号
       └─ 否 → 既有流程不动：resolve → （未命中）assignTag → 原文比对 → prependTag
```

**执行次序是硬契约**：计划必须在该 part 进入 `resolver.resolve`（`tag-messages.ts:865`）**之前**执行。resolver 的精确命中只按位置、`accept` 只挡 inert（`tag-id-fallback.ts:92-96`）；若先 resolve 再执行计划，T 已被当成 `existingTagId` 捕获，后面的墓碑化与内存重绑全部白做，流程继续走 `:927-930` 用 X 覆盖 S(T)——恰好复现本方案要禁止的行为。

- **认领分支**：先墓碑化 T、再重绑 R 并 `bindTag(c → R)`，随后照常调用 resolve——此时精确命中的就是 R。
- **漂移分支**：墓碑化 T 并 `unbindTag(c)` 之后，**必须屏蔽 scoped fallback** 再 resolve：对该 part 以 `accept: () => false` 调用——`accept` 恒为 false 使精确命中与 fallback 都不放行，resolve 必然返回 undefined，随后直接 `assignTag`。（`claimedContentIds` 是 `createExistingTagResolver` 的闭包私有变量，`ExistingTagResolver` 接口只有 `resolve`，外部无法在 resolve 前登记，所以不走「先登记」这条路。）不屏蔽的话，c 在同消息的桶里让出的空位会让 `getScopedAssignments().get(messageId)[type][textOrdinal]` 落到同消息下一个 text part 的旧 tag 上（`tag-id-fallback.ts:98-117`；`claimedContentIds` 只挡本 pass 已 resolve 过的 part，`mc1:p1` 在 `mc1:p0` 之后才 resolve，挡不住），当前 part 抢到兄弟的号并用 X 覆盖兄弟的原文。屏蔽之后走 `assignTag`，DB 与内存两层对 c 都已查不到 T，正常分配。

- **墓碑化 T**：`tombstoneTagMessageId(db, sessionId, T, expectedKeys)`，把 `tags.message_id` 改成 `__mc_drifted__:<T>`，**只改位置键、不改 status**（WHERE 围栏：`message_id IN (expectedKeys)`；expectedKeys = {c}；changes = 0 时视为已被本 pass 的其他步骤处理，不报错）。内存：仅当 `tagger.getTag(c) === T` 时 `unbindTag(c)`。status 不变是硬要求——被主人认领回去的 tag 的 dropped 状态要原样重放；动了 status 会让平移后的消息从 dropped 变回 active，上下文膨胀。
- **认领 R**：`rebindTagMessageIdFenced(db, sessionId, R, fromKeys, toMessageId = c)`，WHERE 围栏 `message_id IN fromKeys`，fromKeys = {预扫描时 R 的 message_id, `__mc_drifted__:<R>`}，返回 `changes > 0`。接受墓碑键作为旧值是必要的：均匀平移的链里，位置 N 的 part 先把 T 墓碑化，位置 N+d 的 part（T 的主人）随后要把 T 认领回去。内存：`bindTag(c → R)` 之前先读 `getTag(c)`——`bindTag` 是无条件 set（`tagger.ts:695-697`），若 c 上现存绑定既不是 T 也不是空（内存与 DB 不一致的防御场景），记一条 warn 日志后继续 bind；对 R 的旧 contentId **不做无条件 unbind**——旧键上此刻可能是本 pass 刚绑上去的别的 tag，仅当 `getTag(旧键) === R` 时才 unbind。`changes = 0`（围栏未命中，例如并发改键）时**跳过内存 bind**，该 part 按漂移分支同口径处置（以 `accept: () => false` 调用 resolve 后走 `assignTag` 拿新号；T 此前已墓碑化），并记一条 warn 日志。
- **认领后的原文**：被认领的 R 其原文与 X 恒相等（认领的前提就是 `sourceIdx[X]` 含 R）。但 pass 级的 `sourceContents` map 由 `collectRelevantSourceTagIds`（`tag-messages.ts:342-361`）按「预扫描时 assignments ∩ 当前消息 id」裁剪，窗口外的被认领 tag 不在 map 里，`:927-930` 会照常做一次 `replaceSourceContent(R, X)`——写入值相同、幂等无害。实现应经预扫描索引判等后跳过这次写。
- **新分配**（漂移分支）：墓碑化之后走 `assignTag`，DB 与内存两层对 c 都已查不到 T，正常分配。

**墓碑键的安全性**（已逐一核对消费方）：`tags.message_id` 的读取方里，pending ops 按 tag_number（`storage-tags.ts:2254-2286`）；fork 继承按内容对齐 + `/^mc(\d+)/`（`session-inheritance.ts:351`）天然跳过；`getMinMessageTagNumberForRawId` 的区间扫描不受影响；`deleteTagsByMessageId` / `markTagsCompactedByMessageIds` 的 LIKE 模式匹配不到墓碑键（见已知限制）。`getAssignableTagNumberByMessageId` 是精确等值查询（`:787-799`），墓碑键不可能等于合法 contentId；实现时仍显式排除 inert / 墓碑前缀，作为防御。

**失败形态**：

- T 的原文所属消息已不在入站窗口（被裁掉）：单看该 part 的漂移判据不成立；只要窗口整体仍有平移（d ≠ 0），由（b′）按「位置 − d」找回真身，**不会**进编辑重发桶。窗口里能验证平移的 part 不足 3 个时（极短窗口）视为无平移 → 编辑重发桶 → 与今天行为一致（入站 system 行除外，见上面的专门规则）。
- 样板文本多候选：`sourceIdx[X]` 不唯一或 X 在入站里出现多次 → v1 不认领；平移成立时由（b′）按位置找回真身，样板不影响（计分在平移后的位置上做内容验证）。无平移时 → 退化为现状（不抛错、确定性、不重复分配）。
- T 没有存量原文：无法判定 → 现状（d = 0 时；平移成立时由（b′）按位置处理，T′ 无原文走「平移相符」）。
- 认领的围栏未命中（`changes = 0`，例如并发改键）：T 此前已被墓碑化，「沿用 T」在该 part 上已不可达，所以**不是**退化为现状，而是按漂移分支同款处置（屏蔽 scoped fallback 后 `assignTag` 拿新号）。

**为什么不是「一律不符即新分配」**：tag 计数器只增不减（`tagger.ts:443-446`），每次重启平移都会让整个窗口换新号；滞留 active 的旧号被双计，也稀释 dropped 水位与 ctx_search 的命中密度。编号稳定主要靠（b′）的平移相符（按位置找回、不依赖文本唯一），内容认领负责 d = 0 时的零散情形，两者都不成立才换号。

**tool tag**：不适用内容校验——`source_contents` 不存工具输出，`tool_name` 在 once-write 下不构成信息（`tag-messages.ts:980-991`）。漂移下 tool tag 的现状是「同一输出得到第二个编号」（`tagger.ts:644-658`），本次不动，写入已知限制。

**`ctx_expand` 改读存量原文**：`renderItemByTag`（`core/tools/ctx-expand/render.ts:285-347`）的文本分支先 `getSourceContents(db, sessionId, [number])`（`storage-source.ts:40-63`，`CtxExpandToolDeps` 本来就是 `{ db }`，`core/tools/ctx-expand/tools.ts:23-25`），命中则把存量原文交给 `renderPartFull`（`:172-177`）按现有格式输出，未命中回落现有的位置读。输出形态与今天一致（`  [text]\n<原文>`，不带 `§N§`）。file 分支与 mc-text-v1 内容寻址分支不动。与 system-prompt-guard 的 queue 硬拒（`core/tools/ctx-reduce/tools.ts:198-211`，写侧）不冲突。

**顺带确认的既有事实**（不在本次范围）：落库剥章已在主代码修复（`turn-model-step.ts:492-503`、`cancelled-stream-persistence.ts:49`、`@zcode/shared` 的 `stripMagicContextTagNotation`，提交 `1612ba10`）；用户库里带 `§N§` 的持久行是那次修复之前的存量。

## 最终项目结构

```
apps/zcode-cli/packages/magic-context/src/core/hooks/magic-context/
  inject-compartments.ts            改：leadingSystemRunLength、五处切片豁免、prefixTrimRemovedMessageIds（FORK 注释）
  transform.ts                      改：压缩边界切片优先用显式 id 列表（FORK 注释）
  tag-messages.ts                   改：预扫描、计划、就地执行的内容校验（FORK 注释）
apps/zcode-cli/packages/magic-context/src/core/features/magic-context/
  storage-tags.ts                   改：墓碑化、带围栏的 message_id 重绑、按会话读 tags 的位置索引（FORK 注释）
  storage-source.ts                 改：按会话批量读原文（FORK 注释）
apps/zcode-cli/packages/magic-context/src/core/tools/ctx-expand/
  render.ts                         改：tag 模式优先返回存量原文（FORK 注释）
apps/zcode-cli/packages/magic-context/scripts/
  test-transform.mjs                改：新增 b5b 系列用例
apps/zcode-cli/packages/core/src/runtime/methods/
  turn-model-step.ts                改：删除折叠条目写回
  turn-loop.ts                      改：不再传 requestEntries
apps/zcode-cli/packages/core/scripts/
  test-output-token-continuation-state.mjs   新增
apps/zcode-cli/packages/bootstrap/scripts/
  test-magic-context-fork-inherit.mjs          改：裁前缀用例的夹具与断言
  test-magic-context-continuation-input.mjs   新增
docs/iterations/magic-context-trim-integrity/
  spec.md                           本文件
  e2e/e2e-trim-integrity.mjs        新增：真实库只读拷贝验证
docs/apm/memory/20261126-magic-context-trim-integrity.md
```

core 只改 `turn-model-step.ts` 与 `turn-loop.ts` 两处，不新增对 magic-context 的任何 import。

## 变更点清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `magic-context/.../hooks/magic-context/inject-compartments.ts` | 新增 `leadingSystemRunLength(messages)`；S0/S1/S2/S3 切片后把开头 system 段放回最前；S4 source-order 分支对豁免行 `retained.push + continue`、不参与 position 检查；退化输入不裁剪（S3/S4 返回 refused）；S1/S2 产出 `prefixTrimRemovedMessageIds`，`skippedVisibleMessages` 改为实际移出条数；五处 FORK 注释。**连带修复（提交 3577a02f）**：`firstPersistedLiveId`（`:3695-3709`）按 `leadingSystemRunLength` 跳过豁免段再取首个持久行——豁免让裁剪后的数组头部仍是 system 行，不跳过则 absent-boundary 分类恒 refused、请求不裁、超窗被拒发（T-S8 守卫） |
| 2 | `magic-context/.../hooks/magic-context/transform.ts`、`inject-compartments.ts`（`selectHiddenMessagesAtCompactionSeam`） | `transform.ts:1975-1978` 与 `:1979-1982` 两个按「前 N 条」切片的消费方都改为用 `prefixTrimRemovedMessageIds`；`selectHiddenMessagesAtCompactionSeam` 改为接收显式的被移除消息列表；postprocess `:2885` 的日志消费方不改（FORK 注释） |
| 3 | `core/.../methods/turn-model-step.ts` | 删除 `:574` 写回与 `:572-573` 注释；`runModelBackedTurnStep` options 去掉 `requestEntries`（`:88`）；留一句约束注释 |
| 4 | `core/.../methods/turn-loop.ts` | `:169` 不再传 `requestEntries` |
| 5 | `magic-context/.../hooks/magic-context/tag-messages.ts` | 文本分支的预扫描、计划、就地执行；带 FORK 注释。**v2**：预扫描里增加整体平移识别（候选 d、计分、判定），平移成立时按（b′）的三个分支出计划，d = 0 时按 v1 的表出计划；执行机制（墓碑化、围栏重绑、屏蔽 scoped fallback 后 `assignTag`）不变 |
| 6 | `magic-context/.../features/magic-context/storage-tags.ts` | 新增 `listTagRowsBySession(db, sessionId)`（返回本会话 tags 行数组：tag_number、message_id、status、message_role、type、entry_fingerprint；`ORDER BY tag_number ASC`；调用方据此建 `posIdx` 与 `rowByTag`）、`rebindTagMessageIdFenced(db, sessionId, tagId, fromKeys, toMessageId)`（返回 changes）、`tombstoneTagMessageId(db, sessionId, tagId, expectedKeys)`；墓碑键 `__mc_drifted__:<tag>`；FORK 注释。本文件内 `tagId` 实值即 `tag_number`（与 `getTagById` / `updateTagMessageId` 的既有约定一致） |
| 7 | `magic-context/.../features/magic-context/storage-source.ts` | 新增 `getSourceContentIndexBySession(db, sessionId)`（`Map<content, tagId[]>`，一次读全会的 `source_contents`）；FORK 注释 |
| 8 | `magic-context/.../core/tools/ctx-expand/render.ts` | `renderItemByTag` 文本分支优先返回存量原文（经 `renderPartFull`）；FORK 注释 |
| 9 | `bootstrap/scripts/test-magic-context-fork-inherit.mjs` | 裁前缀夹具头部（裁剪边界之前）补一条 attachment 条目；所有依赖 mc 序号的断言值随之前移 1（`:455` 的 boundaryOrdinal、`:458` 的 `"mc52"`、`:462` 正则里的 150、`:468` 的条数算式；fork 继承的边界由内容对齐自动后移，继承逻辑不改，只更新断言值）；条数断言 +k；新增顺序、S0 切片、system tag 未被 compacted 的断言 |
| 10 | `core/scripts/test-output-token-continuation-state.mjs` | 新增 |
| 11 | `bootstrap/scripts/test-magic-context-continuation-input.mjs` | 新增 |
| 12 | `magic-context/scripts/test-transform.mjs` | 新增 b5b 系列（v1：T-T1、T-T3、T-T4a、T-T4b、T-T6、T-T7、T-T8、T-T9、T-T10，均已落地并通过；**v2**：按修订后的夹具调整 T-T8——原文为 P 的 part 从 `mc3` 挪到 `mc5`（保留在入站、只挪出平移对齐位），使其留在 d = 0 的漂移分支；新增 T-T11 整体平移层）。既有 b5（T-T2）不改 |
| 13 | `docs/iterations/magic-context-trim-integrity/e2e/e2e-trim-integrity.mjs` | 新增 |

`capturePrefixTrimSourceOrder`（`:3723-3760`）不需要改：ZCode system 行有 id，照常进 `messageIds`。S4 分支里豁免行跳过 `lastSourcePosition` 更新是安全的——开头段在 source order 最前，其后第一个保留行的 position 必然大于它，不会触发 `:3822-3824` 的「violates immutable source order」；与 `isHostRenderedSystemMessage` 的既有先例（`:3804-3809`）同构。

## 详细实现步骤

- Step 1 — phase-trim-system-guard — blocking: yes — qa: auto：在 `inject-compartments.ts` 新增 `leadingSystemRunLength(messages)`；对「开头 system 段与裁剪点重叠」的退化输入（cutoff < k）按上文处置（S0/S1/S2 不切片照常返回；S3/S4 返回 refused；debug 日志）。
- Step 2 — phase-trim-system-guard — blocking: yes — qa: auto：改五处切片点 S0 ~ S4，保留开头 system 段于最前；每处带 FORK 注释（上游语义 + ZCode 差异 + 理由，格式仿 `apply-operations.ts:552-556`）。S2（degraded re-anchor，`:717-718`）的触发条件苛刻（边界连续不可见达阈值且 cache-busting），不单独构造夹具：它与 S0/S1 同构、经同一个 helper 豁免，由代码审查覆盖。扩展点：若用户选择也保留附加上下文，helper 的判据扩为「开头连续的 system 段 + 紧随其后的 `syntheticHead` user 附件段」。
- Step 3 — phase-trim-system-guard — blocking: yes — qa: auto：`skippedVisibleMessages` 改为实际移出条数并产出 `prefixTrimRemovedMessageIds`；`transform.ts:1975-1978` 与 `:1979-1982` 两个消费方都改用显式列表（后者需要改 `selectHiddenMessagesAtCompactionSeam` 的入参形态）。
- Step 4 — phase-trim-system-guard — blocking: yes — qa: auto：更新 `test-magic-context-fork-inherit.mjs`：夹具头部补 attachment 条目、同步序号断言；新增 T-S1 ~ T-S6 的断言。在 `test-transform.mjs` 新增 T-S7（经导出的 `injectM0M1` 的 preparedPrefix 路径驱动，`inject-compartments.ts:3905-3917`，其返回值含 `prefixTrimStatus`；不为测试新增导出）。
- Step 5 — phase-continuation-input — blocking: yes — qa: auto：删除 `turn-model-step.ts:574` 的写回及注释；去掉 `requestEntries` option 与 `turn-loop.ts:169` 的实参；在原处留注释说明「续写的请求状态必须保持在 transform 之前的数组上，折叠产物不得回灌」。
- Step 6 — phase-continuation-input — blocking: yes — qa: auto：新增 `core/scripts/test-output-token-continuation-state.mjs`（`npx tsx --test`，直接 import `../src/runtime/methods/turn-model-step.ts`，仿 `test-lazy-history.mjs` 的写法）：用最小 fake runtime 驱动 `runModelBackedTurnStep` 的续写分支，断言 T-C1、T-C2、T-C5。fake 面约 12-20 个成员（`config`、`sessionId`、`logModelRequestSteeringContext`、`persistAssistantMessage` / `persistPart`、`createEvent` / `appendEvent`、`runModelTextRequest`、`extractToolCallsFromResult`、`messageHistory.addEntries`、锚点属性 `latestAssistantMessageId` / `latestAssistantTurnId` / `latestConversationMessageId`；`logger` 可选链可省）+ 真 `TurnMachineImpl`；续写分支 0 工具调用使 streaming coordinator 惰性。夹具须知：(a) `runModelBackedTurnStep` 不经过 turn-loop 的 `startModelRequest`，而 `receiveModelResponse` 要求状态机处于 `AwaitingModelResponse`（`turn-state.ts:230-259`），夹具必须先把 `new TurnMachineImpl(...)` 预驱动到该阶段，否则撞 `InvalidTurnPhase`；(b) `config.taskType` 取 `"workflow_child"`，绕开 `mainTurnCacheHitAggregate` 与 `currentTurnFileChanges` 两个无关分支；(c) 不提供 `sessionStore`（undefined），短路 usage 观测，并让 T-C5 的空提交走 `if (runtime.sessionStore)` 守卫（`turn-stop.ts:61`）；(d) `options.messages` 用与原 entries 不相交的哨兵对象构造，用于 T-C1 的「entries 里没有来自 messages 的对象」断言——生产里 transform 对未改动条目复用原对象（`magic-context-turn-transform.ts:889-893`），元素级复用是合法的，T-C1 因此不以「messages 与 entries 无共同对象」为断言，只断言 entries 的前缀、尾部形态与「不含 messages 哨兵」。若实现时发现 fake runtime 不可行，必须在宣告完成前把原因写进本节「实现注」并回到审查，不得静默降级。
- Step 7 — phase-continuation-input — blocking: yes — qa: auto：新增 `bootstrap/scripts/test-magic-context-continuation-input.mjs`：真实端口（仿 `test-magic-context-fork-inherit.mjs:180-204` 的 `makePort` / `runPort`，`MAGIC_CONTEXT_DB_DIR` 指向临时目录的真库），断言 T-C3、T-C4。夹具需要新组合一个单会话场景：工具弧必须落在第二次输出的保留窗口内（否则「0 / 0」空洞成立）；T-C4 还需要平移恰好把一条弧劈在折叠边界两侧。T-C4 反复构造不出「劈弧」形态时，把断言放宽为「对照输出与正确输入的输出在工具弧成对性上存在差异」并在用例注释里记录，不得悄悄删除断言。
- Step 8 — phase-tag-content-verify — blocking: yes — qa: auto：`storage-source.ts` / `storage-tags.ts` 新增四个函数（变更点 #6、#7）；FORK 注释。
- Step 9 — phase-tag-content-verify — blocking: yes — qa: auto：`tag-messages.ts` 文本分支实现预扫描、计划、就地执行；计划先于 `resolver.resolve` 执行，漂移分支屏蔽 scoped fallback；带 FORK 注释。**v2 增补**：在预扫描里实现（b′）的整体平移识别与三个分支的计划；`posIdx` 之外需要一个「位置键 → 行」的查询能按 `mc<p−d*>:p<i>` 取 T′（直接复用 `posIdx`）；从位置键解析 p 的正则必须要求 `:p<数字>` 分隔（形如 `^mc(\d+):p(\d+)$`）——file 键（`mc9:file0`）不是位置键，fork 继承用的 `/^mc(\d+)/` 会把 file 键也匹配进来，不能直接照搬（T-T7 的 type_file 场景依赖此口径）。**在 T-T11 与真实数据 e2e 通过之前，这一步不算闭合**——v1 的实现已经通过了全部单测，却在真实库上只识别出 2%–4% 的漂移。
- Step 10 — phase-tag-content-verify — blocking: yes — qa: auto：`test-transform.mjs` 新增 b5b 系列用例（T-T1、T-T3、T-T4a、T-T4b、T-T6、T-T7、T-T8、T-T9、T-T10；**v2** 再加 T-T11）；确认既有 b5 用例（T-T2）不变仍绿。**v2 增补——v1 用例逐条按（b′）重核**：实现者必须对每个 v1 用例手算候选集与 score，分两类处置并在用例注释里写明是哪一类：(a) 夹具里 `argmax = 0`（或最高分 < 3）——留在 v1 分支，断言不变（T-T8 按修订后的夹具属于此类）；(b) 夹具本身就是均匀平移且验证点 ≥ 3——(b′) 会接管，只有当 v2 路径下的结果与原断言逐项相容时才保留原断言并注明「双路径相容」（T-T1 的 pass 2 预期如此：三个 part 全部平移相符，号与原文不变），不相容的按 v2 语义更新断言（T-T7 的「R 的 message_id 不变」若其夹具触发平移相符则会被重绑打破，此时应改夹具使 `argmax = 0`，保住它「不认领不合格候选」的测试目的）。
- Step 11 — phase-ctx-expand-source — blocking: no — qa: auto：`ctx-expand/render.ts` 的 tag 模式优先返回存量原文（T-T5）。
- Step 12 — phase-verify — blocking: yes — qa: auto：`pnpm typecheck`、cli 子树 turbo typecheck、`pnpm lint`（0 error）、`pnpm architecture:check --changed`（0 违规）；复跑既有 magic-context 脚本（transform、session-isolation 2、turn-transform 23、absent-event 4、historian 12、fork-inherit）。
- Step 13 — phase-verify — blocking: yes — qa: auto：新增 e2e `e2e-trim-integrity.mjs`，在真实库只读拷贝上跑两个最长的裁剪形态会话（T-E1 ~ T-E4），并记录续写重复投影的耗时作为基线。会话选择按「基线边界非空」过滤后再按 tags 总数取前两个（v2 修订，见 T-E1）。**T-E3 的「存量原文零改写」是本步的硬闸门**：v1 实现在这里是 1 / 1445 与 92 / 662，不能以「比修复前好」放过。**已入库的脚本必须按 v2 同步改写后本步才算执行**：选会话按裁剪形态过滤；零改写的断言范围从「文本唯一的 tag」扩大到全部有存量原文的文本 tag（去掉 `if (!uniqueA.has(tagId)) continue` 这一过滤）；P3/P4 的工具弧成对从硬断言降为观察项，V1 的弧改为「相对 V0 无新增孤立调用」；观察项补上识别出的 d*、平移相符 / 不符 / 落空的 part 计数、保号占比。旧脚本在 v1 代码上跑出的结果不构成闭合证据。
- Step 14 — phase-verify — blocking: no — qa: manual_user：Electron 真机：长会话发一条消息，首轮请求以 system prompt 起头且一次成功；可选地把输出 token 上限调到很小以触发续写，观察第二次请求不含折叠产物、工具弧成对。

## 测试策略

### 测试用例

问题一（裁前缀保留 system）

- T-S1 — blocking: yes — 父会话末端足够长、子会话冷重建裁前缀时（rebuild 分支）：请求的前 k 条是输入里的 system 条目，其后依次是 m[0]、m[1]，再其后是裁剪点之后的消息；条数 = k + 2 +（裁剪点之后的条数）。断言在 bootstrap 层的 `result.entries` 上做：位置、role、内容相等为必须；引用相等依赖 `isUnchanged` 复用（`magic-context-turn-transform.ts:889-893`），成立则一并断言，不成立时以位置 + role + 内容为准并在用例注释里写明。
- T-S2 — blocking: yes — 同一场景下，夹具头部（裁剪边界之前）的一条 attachment 条目不随请求发出（与现状一致）。
- T-S3 — blocking: yes — 不触发裁前缀的会话（末端不足 300 条的退路、基线边界为 null 的占位符形态）行为不变。
- T-S4 — blocking: yes — 输入开头没有 system 段（k = 0）时，裁剪结果与修复前逐条相同。
- T-S5 — blocking: yes — 缓存回放分支 S0 的切片本身：T-S1 之后用**全量** `childEntries`（而不是第一遍的 `result.entries`）再次调用端口，使缓存边界可解析、`inject-compartments.ts:473` 的 splice 真正执行。断言：请求仍以 system 段起头，其后是 m[0]、m[1]。前提是该 pass 不是 cache-busting（否则走 rebuild 分支而不是 S0）；实现时实测确认，若为 cache-busting 则调整夹具使之落入 S0。夹具里 `:494` 现有的第二次 `runPort` 喂的是折叠产物、缓存边界不在数组里，走的是 `:474-484` 不切片的子分支，不能作为 T-S5。
- T-S6 — blocking: yes — 跑完 T-S1 / T-S5 后查临时库：先断言 system 条目对应的 tag **存在**（否则「不是 compacted」恒真、空转通过），再断言它的 status 不是 `compacted`。
- T-S7 — blocking: yes — 退化输入（裁剪点落在 system 段内）：包内单测，经导出的 `injectM0M1` 的 preparedPrefix 路径驱动；断言不裁剪、`prefixTrimStatus === "refused"`。
- T-S8 — blocking: yes — **回归守卫：`firstPersistedLiveId`（`inject-compartments.ts:3695-3709`）在 absent-boundary 分类里必须跳过豁免的开头 system 段**（本轮登记进 spec；用例已在 fork-inherit 套件里，守住提交 3577a02f 修复的缺陷）。bootstrap 层真实端口（`test-magic-context-fork-inherit.mjs`，`test("T-S8 裁前缀后的 absent-boundary 分类跳过开头 system 段（firstPersistedLiveId 回归）", …)`）：600 条对话，父会话折叠到第 150 条对话（`foldParentThrough(db, parentId, 1, 151)`），fork 出的子会话夹具以带 id 的 system 行起头（mc1 = system、mc(i+1) = 对话 i），裁剪边界 mc52（对话 51 随裁），边界行被本轮 S1 切片裁掉，随后的 delivery 正是 absent-boundary 场景。断言：transform 成功返回（缺陷形态下 prefix trim 被 `refused`，超窗会抛 MC-H04）；请求以 system 段起头、条数 = k + 2 +（边界 mc52 之后的条数）；日志先等一个 flush 周期（包内 logger 为缓冲写，500ms 落盘）再按会话 id 过滤行，出现 `prefix trim: boundary mc52 precedes the first remaining message mc53`，且不出现 `prefix trim: boundary mc52 absent from current messages`。
- T-S9 — blocking: yes — **S3/S4 的 applied 路径保留开头 system 段**（评审新增；与上轮拒发缺陷同族的护栏——「开头 system 段在 S3/S4 applied 时被保留」此前无用例，回归时全套件仍会绿）。包内单测（`test-transform.mjs`，T-S7 之后追加一例），驱动方式与 T-S7 相同（导出的 `injectM0M1` + `preparedPrefix`，不为测试新增导出）。夹具：system 段 k = 2（mc1、mc2）+ mc3（摘要边界，非 system）+ mc4，`preparedTrimBoundaryId = mc3`。①带 `capturePrefixTrimSourceOrder`（S4 source-order 分支）：断言 `prefixTrimStatus === "applied"`、两条 system 行以同一引用保留在结果头部、mc3 被裁、mc4 保留；②不带 `prefixTrimSourceOrder`（S3 findBoundaryIndex 兜底分支）：同样的形态。

问题二（续写输入）

- T-C1 — blocking: yes — core 层：驱动续写分支后，三句断言——`state.turnRequestState.entries` 的前 N 项与调用前的 entries 逐项引用相等；末尾恰为 assistant 条目（夹具带非空部分输出）+ 续写 user 条目；entries 里没有任何对象来自 `options.messages`（夹具把 `options.messages` 构造成与 entries 不相交的哨兵对象——生产中它就是折叠产物的 provider 投影，`turn-loop.ts:119-169`；这一句是防「写回」复活的护栏）。`requestEntries` option 已删除（变更点 #3），折叠产物不再有任何入口进入该函数，所以不存在「传入的折叠产物数组」可比。
- T-C2 — blocking: yes — core 层：调用前 entries 里的每个条目（夹具里放一个带独特标记的 request-only 附件条目）在调用后的 entries 里逐项引用相等——用于确认 `:572-573` 注释声称的「一次性附件」不会因删除写回而丢失。
- T-C3 — blocking: yes — bootstrap 层（真实端口）：把「全量历史 + 追加条目」作为第二次输入交给端口，输出里每个工具调用都有结果、每个结果都有调用（0 / 0）；摘要块数与第一次相比不减少。前提：夹具的工具弧落在第二次输出的保留窗口内。
- T-C4 — blocking: no — bootstrap 层对照：把第一次的输出（折叠产物）直接再喂一次端口，会出现不成对的工具弧——证明 T-C3 的对照确实覆盖了缺陷形态。需要夹具里平移恰好把一条弧劈在折叠边界两侧；构造不出时按 Step 7 的处置放宽断言并记录。
- T-C5 — blocking: no — core 层：模型部分输出为空且无 reasoning 时，第二次的 entries = 调用前的 entries + 续写 user 条目（无 assistant 条目）。

问题三（tag 内容校验）

- T-T1 — blocking: yes — 漂移保号：三个 pass 共用同一 tagger 与临时库。pass 1 给 `mc1..mc3`（文本 A、B、C 各不相同）打标；pass 2 同样三条消息平移到 `mc2..mc4`。断言：三条消息的 tag 号与 pass 1 相同（含落在没有位置命中的 `mc4` 上的第三条），`source_contents` 逐条仍为 A、B、C，wire 文本的 `§N§` 与 pass 1 相同；pass 3 重复 pass 2，结果逐字节相同（幂等）。
- T-T2 — blocking: yes — 既有 b5 用例（编辑重发：同位置换内容、旧原文不在入站、新文本反查无命中）不变仍绿：沿用原 tag 号、原文被覆盖、wire 文本是新内容。
- T-T3 — blocking: yes — 漂移且原文的主人被裁出窗口之外的其他 part 以内容命中：夹具预置 T（原文 P，status = dropped），pass 2 里位置命中 T 的 part 文本是 X（≠ P，反查无唯一候选），另有一个入站 part 的文本恰为 P（它自己位置命中的是别的 tag）。断言：X 所在 part 拿到新 tag 号；S(T) 未被覆盖；T 的 `message_id` 已变为 `__mc_drifted__:<T>`；T 的 status 仍是 dropped。
- T-T4a — blocking: yes — 真·退化为现状：位置命中 T（原文 P），入站文本 X ≠ P，P 不在入站里，X 反查无候选 → 编辑重发桶：沿用 T、覆盖原文（与 b5 同形，夹具用非 mc1 的位置）。
- T-T4b — blocking: yes — 样板多候选：库里 tag1 @`mc1:p0`、tag2 @`mc2:p0` 原文同为 P，另有 tag3、tag4 原文同为 S；入站三条消息各一个文本 part：`mc1` = S、`mc2` = S、`mc3` = P（`mc3` 上没有任何 tag）。两个 S part 各自位置命中原文为 P 的 tag。断言：不抛错；S 的两个 part 都不被认领（`sourceIdx[S]` 有两个候选）；它们既未获新号、也未走漂移（`sourceIdx[P]` 不唯一）——落入编辑重发桶；`mc3` 的 P part 认领不成立（多候选）而正常分配新号；整段结果确定（跑两遍逐字节相同）。
- T-T5 — blocking: no — `ctx_expand`：tag 有存量原文时按现有包装格式返回该原文；没有时回落位置读。
- T-T6 — blocking: yes — tag 没有存量原文时无法判定，行为与修复前一致。
- T-T7 — blocking: yes — 唯一候选 R 不满足认领条件时不认领，逐项覆盖：status 为 dropped；status 为 compacted；`message_role = 'system'`；`message_role` 为 NULL；`type = 'file'`。位置命中的 part 按其余规则处置，R 的 message_id、status、原文均不变。
- T-T8 — blocking: yes — 同消息双文本片段（d = 0 时漂移分支屏蔽 scoped fallback）：一条 assistant 消息有两个 text part（`mc1:p0`、`mc1:p1`，各自有 tag1、tag2，原文分别为 X0、X1）；平移后该消息落在 `mc2`，且 `mc2:p0` 位置命中的 tag3 原文为 P（≠ X0，X0 反查无候选）；入站里文本为 P 的 part 放在 **`mc5:p0`**（v2 修订：v1 夹具把它放在 `mc3`，恰好让平移计分凑到阈值 3，用例被扳进平移相符分支；但也不能删掉它——P 不在入站的话 v1 漂移判据不成立、`p0` 会落编辑重发桶收编 tag3 并覆盖 P。挪到 `mc5` 后候选集 {0, +1, +3}，`score(+1) = 2`（X0、X1）、`score(+3) = 1`（P 对齐 tag3）、`score(0) = 0`，最高分 2 < 3 → d = 0，留在 v1 分支）。断言：`p0` 判为漂移并拿到新 tag 号；**兄弟 `p1` 的 tag 号与原文 X1 不变**（没有被 `p0` 经 scoped fallback 抢占）；tag3 被 `mc5:p0` 经含墓碑键的围栏认领回去，P 未被覆盖；再跑一遍逐字节相同。平移相符分支对同消息双片段的覆盖由 T-T11 承担（其夹具含一条带两个 text part 的消息）。
- T-T9 — blocking: yes — 入站 system 行落在被裁区域的旧 tag 上：夹具预置 T（status = dropped，`message_role = 'user'`，原文 P）@`mc1:p0`；入站 `mc1` 是 role = system 的消息（文本 X = system prompt，P 不在入站里）。断言：T 的原文仍是 P、status 仍是 dropped、`message_role` 仍是 `'user'`、`message_id` 已变为墓碑键；system 行拿到新 tag 号且其 `message_role = 'system'`。对照组：T 的 `message_role = 'system'` 时沿用 T 并覆盖原文。
- T-T10 — blocking: yes — 入站 system 行位置命中的是 `message_role` 为 NULL 的存量 tag（v10000 之前的行）：同 T-T9 的断言（墓碑化、system 行拿新号且 `message_role = 'system'`、存量原文未被改写成 system prompt）。
- T-T11 — blocking: yes — **整体平移层**（v2）。真实数据上原文被改写的机制是「位置命中的是一条主人已被裁出窗口的老 tag + 认领失败（样板）→ 落编辑重发桶」，纯均匀平移的夹具里位置命中的永远是相邻活消息的 tag、v1 的漂移判据会全部兜住，所以夹具**必须含主人不在入站的老 tag 与重复样板**。预置 10 个文本 tag（全部 `type = 'message'`、`message_role = 'user'`）：

  | tag | message_id | 原文 | status |
  |---|---|---|---|
  | 1 | `mc10:p0` | U | active（主人已被裁出窗口，U 不在入站） |
  | 2 | `mc11:p0` | P | active（样板） |
  | 3 | `mc12:p0` | B | active（唯一文本，供候选集） |
  | 4 | `mc13:p0` | P | dropped（样板 + dropped） |
  | 5 | `mc14:p0` | C | active（唯一文本） |
  | 6 | `mc15:p0` | S | active（样板） |
  | 7 | `mc16:p0` | S | dropped（样板 + dropped） |
  | 8 | `mc17:p0` | D | active（唯一文本；同消息双片段的 p0） |
  | 9 | `mc17:p1` | D2 | active（唯一文本；同消息双片段的 p1） |
  | 10 | `mc18:p0` | E | active（唯一文本） |

  入站：`mc1` = system（文本 SYS，无存量原文）；对话 `mc10` 到 `mc18` 依次为 P、B、P、C、S、S、{D, D2}（一条消息两个 text part）、E、NEW（新追加）。整体平移 d = −1（上一代在 `mc<p+1>`）。手算：候选集 {0, −1}（B、C、D、D2、E 给出 −1），`score(−1) = 9`（`mc10`–`mc17` 的 9 个 part 在 `mc11`–`mc18` 上逐一原文相等）、`score(0) = 1`、`score(+1) = 1` → d* = −1。断言：(1) 预置的 10 行 `source_contents` 逐字节不变——尤其是 tag1 的 U（v1 在同一夹具上会把它改写成 P）；新增的行只允许是 SYS 与 NEW 两个新号各一行；(2) `mc10`–`mc17` 的 9 个 part 的 tag 号与真身逐一相同：P、S 四个样板 part 按位置而非唯一性找回 tag2/4/6/7，tag4、tag7 仍是 dropped，双片段的两个 part 都回到 8、9；(3) `mc18` 的 NEW 平移落空（`posIdx[mc19:p0]` 为空），拿到不在 {1..10} 里的新号；(4) 再跑一遍同样输入，结果逐字节相同。区分度说明：B、C、D、D2、E 在 v1 下也会被内容认领判对，它们不是区分点；区分点是 U 与四个样板 part。
- T-T12 — blocking: yes — **system 行落到旧的非 system tag 上时的无条件解绑**（评审新增；与执行次序图「system：墓碑化 T → unbind(c) → 跳过 resolve → assignTag 新号」对齐的护栏）。可达入口是 `assignTag` 的**内存快路径**（`tagger.ts:402-407`）：tag-messages 在 pass 开头就把 inert 行的 contentId 绑进内存（按入站消息 id 做 inert 重放），墓碑化的内存侧只是条件 unbind，挡不住这条快路径把 c 上残留的旧号送回来、再经 replaceSourceContent 把 system prompt 写进那个号的原文。夹具（双 pass、同一个 tagger、同一个临时库）：pass 1 预置 whitespace-inert 行 N（`insertTag` 后 `markWhitespaceAssistantTagInert`，指纹位置 mc1:p0），入站 mc1 是一条只有空白 text part 的 assistant 消息，断言 wire 上重放出 §N§（这一步让 tagger 的内存把 mc1:p0 绑到 N）；pass 2 在同一 tagger 下再预置一条挂在 mc1:p0、`message_role = 'user'`、号比 N 小的旧 tag M，入站 mc1 换成一条 `role = 'system'` 的非空消息。断言：system 行在 wire 上拿到不在 {M, N} 里的新号；M 的 `message_id` 已变成墓碑键；N 没有 `source_contents` 行，`entry_fingerprint` 与 status 不变。**注册位置**：`test(...)` 必须注册在既有 b5b 用例区（T-T11 之后）、执行循环之前——注册在执行循环之后的用例不会被执行；`test-transform.mjs` 既有的解构 import 里没有 `markWhitespaceAssistantTagInert`，夹具要从 storage-tags 的解构里补这个名字。**区分度要求**：在补无条件 `tagger.unbindTag(sessionId, contentId)` 之前的当前实现上这条用例必须红（system 行拿到 N、N 出现原文行）；当前实现上也绿说明夹具没走到内存快路径，停下报告，不得改断言迁就。既有 T-T9 / T-T10 / T-T11 仍绿。
- T-T13 — blocking: yes — **user 消息的空白 text part 豁免出平移层**（评审新增；v1/v2 口径不一致——计划循环里空白判断原本排在平移分支之后，而主循环的空白豁免只对 assistant 生效，user 消息的空白 part 会消费平移计划，平移成立时被判成认领或漂移；现行实现已把空白判断挪到 system 规则之后、平移分支之前，`tag-messages.ts:670-673`，system 规则保持最先）。**独立**用例：不要往 T-T11 的夹具里加东西——它的手算注释和 `slice(1, 9)` 断言写死了 part 数量；同样注册在既有 b5b 用例区、执行循环之前。夹具：自建一个平移成立的场景（至少 3 个能验证平移的 part）+ 一条带空白 text part 的 user 消息。断言：空白 part 沿用其位置命中的既有号（位置无命中时新分配）；其位置上的旧 tag 没有被墓碑化。T-T1、T-T11 原样仍绿。

问题四（真实数据）

- T-E1 — blocking: yes — 两个最长的**处于裁剪形态**的真实会话（`session_meta.cached_m0_last_baseline_end_message_id` 非 null；v2 修订：初版按 tags 总数选会话，选中了状态已知的 fork 子会话，未裁剪形态的对照没有意义）。**同会话跑两个 pass 对照**（v3 同步 e2e E1.0 ~ E1.3 的实际断言；初版写的「相对 fork-inherit e2e 记录的基线只多出 system 段条数」已改为同会话 V0 对照，跨会话的旧基线只作打印参照）：V0（k = 0，不带 system 条目，修复前形态的当时代理）与 V1（豁免生效）。断言：V0、V1 都成功发出、不抛 MC-H04 / 超窗；V1 请求以 system prompt 起头（首条 message `role = 'system'` 且正文含 system marker，`system在=true`）；**条数与对话序列都取同会话 V0 对照**——裁点按绝对位置切（compartments 边界 / cached baseline 的位置串），头部插入 system 段会把至多 1 条边缘对话条目拖进保留窗口（既有位置语义，非本次引入），所以裁剪形态断言「V1 相对 V0 的对话条目差 = 拖入的边缘条数 L∈{0,1}」且「V1 对话序列 = 边缘条目（≤1）+ V0 对话序列逐条相等」（对照键剥掉 `§N§` 前缀与 `[dropped §N§]` 占位符号、归一化空白 text part 与 content 形态后逐条比对），钉死修复的增量恰为 system 段、没有任何别的差异；两轮折叠投影形态不一致时（dropped 占位符计数不等，合成全量重放的固有噪声）逐条对照会被投影噪声淹没，退回条数断言「V1 条数 = V0 条数 + system 段条数（k = 1，±0）」。不裁剪形态（无裁点可解析）没有边缘条目拖入，同样走这条条数断言。
- T-E2 — blocking: yes — 同上两个会话：摘要块数不变；heal 没有清账（初始无摘要块时无账可清）；system 条目的 tag **先断言存在**（`message_role = 'system'` 的行至少 1 行，否则「不是 compacted」恒真、空转通过），再断言**没有任何 system tag 新被置为 compacted**——以跑任何 pass 之前采集的 system tag 状态为基线（v3 同步 e2e E2.3 / E2.4 的实际断言；初版的绝对断言「system 条目的 tag 没有被置为 compacted」在含存量损坏的真实库拷贝上不可满足：拷贝源里已有被旧缺陷翻成 compacted 的行，本次修复只防新损坏、不修存量，与之同口径）；工具弧成对性与**同一会话的 V0 对照**（k = 0，修复前形态）相比不出现新的孤立调用（V0 自身可能因位置裁剪劈弧而有孤立结果或孤立调用，见已知限制——这是既有的，不算本次引入）。
- T-E3 — blocking: yes — 模拟重启平移：在输入的 system 段之后、第一条对话条目之前多插入一条 role = user 的 context 附件条目（与真实的前缀重建同形；system 段仍是开头的连续段），之后连续跑两个 pass。断言：第二个 pass 之后，**有任何存量原文的文本 tag**中被改写的数量为 0（比对 pass 前后的 `source_contents` 快照；v2 把范围从「文本唯一的 tag」扩大到全部有原文的文本 tag——初版把重复样板排除在外，恰好漏掉了真实数据上主要的失效面）；没有任何存量原文被改写成 system prompt 的文本。观察项（不作断言，打印数值）：平移被识别出的 d、平移相符 / 不符 / 落空三个分支各自的 part 数、平移后窗口内保号的 part 占比、请求里工具弧的成对情况（孤立调用 / 孤立结果各几个，与 V0 对照并列）。顺带记录 system 行因平移拿到新号的个数、以及搁浅的旧 system tag 数。
- T-E4 — blocking: yes — 抽样至多 30 个有存量原文的 dropped tag（不足则全采；为 0 时跳过并记录），`ctx_expand` 的 tag 模式返回的内容解析掉 `[text]` 包装后与该 tag 的存量原文相等。

### 测试落点

- T-S1 ~ T-S6、T-S8：`apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-fork-inherit.mjs`（复用其裁前缀夹具与真实端口；运行方式见该脚本头注）。T-S7、T-S9：包内单测，落在 `test-transform.mjs`（同属 `pnpm test:transform`；T-S9 在 T-S7 之后追加一例）。
- T-C1、T-C2、T-C5：`apps/zcode-cli/packages/core/scripts/test-output-token-continuation-state.mjs`（`npx tsx --test`，直接 import src）。T-C3、T-C4：`apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-continuation-input.mjs`（真实端口）。
- T-T*：`apps/zcode-cli/packages/magic-context/scripts/test-transform.mjs`（沿用 `load("hooks/magic-context/tag-messages.js")` 与 `b4Db` 临时库；`insertTag` / `updateTagStatus` / `saveSourceContent` / `stampTagMessageRole` 已在该脚本 import，`test-transform.mjs:1012-1014`——`insertTag` 不写 `message_role`，T-T7 的 role 用 `stampTagMessageRole` 写入；不登记新的 SUBJECT）。
- T-E*：`docs/iterations/magic-context-trim-integrity/e2e/e2e-trim-integrity.mjs`（真实库只读拷贝到临时目录，含 WAL；真实 store + hydrator + port；做法与约束仿 `docs/iterations/magic-context-fork-inherit/e2e/e2e-fork-inherit.mjs`）。

所有测试不碰用户真实库。

## 风险与回滚方案

| 风险 | 说明 | 处置 |
|---|---|---|
| system 段回到请求里增加 token | 长会话每轮多出 system prompt 的 token；窗口已接近上限的会话可能从「刚好装下」变成超窗 | 包内的超窗判定与 fail-closed 逻辑作用在包含 system 段的数组上，自洽；e2e 记录两个最长会话的条数与字符量作为基线 |
| 附加上下文仍然丢失 | 日期、skills 列表在长会话里不可见，与现状相同 | 已列为待用户确认的选择；若选择保留，按 Step 2 的扩展点实施并补用例 |
| 删除写回后注释声称的动机成立 | 若确实存在只出现在请求里的条目，续写请求会少掉它 | T-C2 逐项断言；若失败则改为写回 pre-transform 数组（`providerEntries`）而非删除，并回到审查 |
| core 层用例的 fake runtime 构造不出来 | Step 6 依赖一个尚不存在的最小 fake runtime | 规定不得静默降级；不可行时写实现注并回审查，由 bootstrap 层模拟 + typecheck + 审查 + 真机兜底 |
| 续写重复投影的性能 | 每次续写都从全量重新投影并重折叠（最多 3 次） | 行为正确；e2e 记录耗时基线 |
| 内容认领的误判 | 唯一性由「本会话内同文本恰有一个 active 候选」+「X 在入站里只出现一次」共同保证；样板文本走退化路径 | T-T4b、T-T7；失败形态单调退化为现状 |
| 墓碑化的副作用 | 墓碑行不被 `message.removed` 的清理路径覆盖（`deleteTagsByMessageId` 的 LIKE 模式匹配不到），会随会话留存；drop 队列按当前 raw id 匹配不到它（本来也匹配不到）；status 不变，dropped 水位与 SUM 不受影响 | T-T3 断言 status 不变；写入已知限制 |
| 反查成本 | `content` 无索引，首次遇到文本 part 时按会话扫一次 `source_contents` 与 `tags` | pass 级惰性、同 pass 复用；e2e 记录耗时 |
| 存量已损坏的会话 | 已错绑的 `tags.message_id`、已被覆盖的 `source_contents` 不会自愈 | 不在本次范围；在 CHANGELOG 已知问题里说明；是否做一次性修复脚本单独立项 |
| tool tag 漂移 | 同一输出得到第二个编号的现状不变 | 写入已知限制 |
| 平移误判 | 某个错误 d′ 的 score 严格大于 score(0) 才会误判（候选集含 0、取 argmax），需要「同位置大面积对不上 + 至少 3 个样板恰好在某个错位上对上」——只出现在多簇坐标或已损坏账本的会话 | 阈值 3 + argmax 含 0；T-E3 观察项打印识别出的 d 与三分支计数；误判的后果限于号漂与拿新号，**不覆盖任何原文** |
| 平移相符保留 status 把活消息折叠 | 需要「保留尾的活消息挂着 stale 的 dropped tag」——正常会话保留尾的 tag 是 active；风险集中在 heal 清账后 dropped 未复位的形态。该路径在 v1 的「相符沿用」下今天就存在，v2 只是扩大作用面 | T-T11 断言 dropped 保 status、新追加消息拿新号；T-E3 观察项打印保号占比；写入已知限制 |
| 行为面变化被误判 | 提醒判定与切模重建改看 pre-transform 数组 | 已在问题二的行为面写明属预期 |

**回滚**：三项修复互相独立，各自可单独 revert。问题一与问题三完全在 magic-context 包内；问题二是 core 的两处删除。均无 schema 迁移、无数据写入格式变更（墓碑键是 `tags.message_id` 的一个新取值，旧代码读到它只是查不到，不会报错）。

## 已知限制

- 附加上下文（日期、skills 列表、用户环境信息）在裁前缀后仍然不随请求发送。
- tool tag 在重启平移后仍会得到第二个编号。
- 存量库里已经错位的 tag 不自动修复。
- 内容校验只覆盖有存量原文的文本 tag；原文已被裁掉或折叠时删除的 tag 无法判定（v1 的限制；（b′）的整体平移层不依赖原文是否在窗口里，但依赖窗口内至少 3 个 part 能在平移后的位置上验证内容）。
- **位置裁剪会从一对工具调用与结果中间切开**（v2 实测，既有行为，非本次引入）：裁点按绝对位置取，落在调用与结果之间时请求里出现孤立调用或孤立结果；真实库对照基线（修复前形态）本身即「孤立结果 1」。孤立调用会被模型拒收，而裁点在同一会话里每轮相同。三项修复都不处理它，单独立项「裁剪边界的工具弧完整性」；T-E3 中「平移后请求工具弧成对」的断言据此改为观察项（见 T-E3）。
- 内容回到窗口、但它原来的 tag 已是 dropped / compacted 时，不认领旧号，会拿到新号——这是有意的取舍（认领 dropped 会把活消息折成占位符）。
- system 行在位置命中「非 system 的旧 tag」时不参与内容认领，会拿新号，旧 system tag 以 active 搁浅并被 SUM 双计。触发条件（fork 子会话、system 段条数变化、NULL-role 存量行）不是每次重启都成立，数量上界约为「触发次数 × system 段条数」。
- whitespace-only 的 assistant part 与 file part 不参与内容认领；file tag 在重启平移后的行为不变。
- 整体平移层识别不出平移的情形：窗口里没有任何「唯一持有且以位置键绑定」的文本 part（全样板窗口），或能在平移后位置上验证内容的 part 不足 3 个（极短窗口）——此时按 d = 0 走 v1，原文仍可能被改写（与修复前一致）。
- 墓碑行不会被既有的 `message.removed` 清理路径回收；`ctx_expand` 对没有存量原文的墓碑 tag 回落位置读时会得到「no longer in stored history」文案。
- `ctx_expand` 的 file 分支现状不变。
- 「给条目稳定身份」（上游 Pi 的内容寻址 contentId `mc-text-v1` 是现成先例，读侧已支持）列为后续迭代。
