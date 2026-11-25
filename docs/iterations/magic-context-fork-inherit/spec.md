---
date: 2026-11-25
---

# fork 子会话继承 magic-context 折叠状态与摘要（SPEC）

## 背景

会话 fork 出的子会话会超出上下文。现场（fork 会话 1548 条历史、请求估算 185 万 tokens）与源码对照后的根因：

- fork 只复制消息行，子会话没有任何 magic-context 继承状态。包内 `copySessionStateForClone`（`storage-clone.ts`）在本仓库零调用方。
- 子会话首轮 transform 会给全部历史新建 tag，全部 `active`；父会话则是 1572 个 `dropped`、268 个 `active`。裁剪靠的正是 `tags.status = dropped`（`transform.ts:2165` 按 `tag_number` 取 dropped 行，`apply-operations.ts:538-603` 重放成 `[dropped §N§]`），compartment 只负责摘要补位与按边界裁前缀。
- 子会话既无 compartment 也无 dropped tag，命中 unmanaged 首轮判定（`transform.ts:1424-1427`），历史明显超窗时阻塞等 historian 至多 60 秒后抛 `UnmanagedOverWindowError` / `EmergencyFailClosedError`。该错误的注释里写着 "a fork whose parent left nothing to inherit"。historian 只能每 pass 约 2 万 token 地慢慢重建，无法自救。

### 为什么不能原样复制

- live 模式下消息 ID 是 `mc<序号>`，序号是运行时条目数组的位置（含 system prompt 等 context 前缀、附件条目、每个工具结果条目），不是会话库行号。父子条目数组形状不同（前缀长度会变、父会话未落库的附件不在子会话里），同一个 `mc<N>` 在子会话里指向别的条目。
- 裁前缀只认 `end_message_id` 精确匹配（`inject-compartments.ts:3498-3508`）。原样搬过来要么解析不到（不裁，装不下即 MC-H04 拒发），要么落到别的条目上（裁错位置，静默丢上下文，无语义校验）。
- 数值 `end_message` 是父会话序号，超过子会话条目数时首轮入口被 `healUnreachableCompartmentLedger` 整本清掉。
- `tag_number` 是按条目首次出现顺序分配的位置序，system 段也占号，父子对齐没有结构保证。

## 目标与非目标

目标：fork 子会话首轮请求发出前，继承父会话的折叠状态与摘要；子会话的上下文体积与摘要可见性不劣于父会话。

非目标：

- 不修复本功能上线前已经跑过首轮的 fork 会话（它们已有 tag，不满足首轮流条件）。
- 不改 core 的 fork 逻辑、contracts、adapters。
- 不改 historian、裁剪、注入的既有语义。
- 不处理父会话自身重启后的坐标位移（既有已知弱点）。

## 约束：防腐层

- **core 零改动。** fork 不新增端口、不改 `WorkspaceForkResult`。依据 `magic-context-decoupling` 的 IM4：magic-context 的行为只能由 host 侧调用。
- **包的唯一 import 点仍是 bootstrap。** core / adapters 不 import `@zcode/magic-context`。
- **规则知识留在包内。** contentId 构造、`stripTagPrefix`、列名、连续性校验都在包里实现，宿主不抄 SQL、不拼 `CompartmentInput`。先例：`healUnreachableCompartmentLedger`（SQL 在包内，宿主只拿 db 调用）。
- **端口缺席即零行为。** magic-context 关闭时 port 不存在，继承不发生。

## 设计

### 涉及面

| 位置 | 改动 |
| --- | --- |
| `magic-context/src/core/features/magic-context/session-inheritance.ts`（新） | 继承的全部规则：对齐、校验、单事务写入 |
| `magic-context/src/index.ts` | 新增一个带 FORK 注释块的出口 `inheritForkedSessionState` |
| `bootstrap/src/app/session-fork-registry.ts`（新） | 进程内登记"这个会话是 fork 出来的、父是谁"。中性命名，不 import 包 |
| `bootstrap/src/zcode-protocol/server-operations.ts` | `registerForkedSession` 里 `resume()` 之前登记一次 |
| `bootstrap/src/app/magic-context-turn-transform.ts` | turn 入口、heal 之前调用一次继承 |

`registerForkedSession` 是所有 fork 路径（旧版 `session/fork`、V4 稳定 fork、编辑重发分支、selection 侧聊）的唯一宿主收口。子代理会话不经过它，天然被排除。

### 时序

```
fork 提交 → registerForkedSession(parentId, childId)
              → 登记表.set(childId, parentId)
              → child.resume()
子会话首轮 turn 入口（bootstrap port）
  1. take 登记项；没有 → 结束
  2. 子会话 tags 与 compartments 都为空？否则 → 结束
  3. projectRuntimeEntries → childMessages
  4. inheritForkedSessionState(db, parent, child, childMessages, parentToolOutputs)
       读父 dropped tag + 父 compartments
       内容等值 + 单调对齐
       生成 tags + compartments，事务内自检
       单事务写入
  5. healUnreachableCompartmentLedger（既有）
  6. transform（既有；tagger 重绑预置行，按 dropped 重放）
```

继承在 heal 之前：heal 随后校验的就是最终状态；若实现写出越界数值，heal 充当安全网。

### 内容对齐

父侧序列：父会话全部 tag 按 `tag_number` 升序（dropped 与 active 都参与，active 用来锚定位置）。子侧序列：`childMessages` 的各 part 按条目序、part 下标序。

- message 类：父 `source_contents.content` 与子 text part 的 `stripTagPrefix` 文本严格相等。
- file 类：父 content 是该消息全部 text part 去前缀后 `\n` join 再 trim（`tag-part-guards.ts:41-49`），子侧按同一规则构造后比较。
- tool 类：父 `source_contents` 不存工具输出。由宿主传入 `parentToolOutputs`（callID → 工具名 + 输出文本），按工具名 + 输出文本严格相等匹配。旧版 fork 的 callID 未改写，可同时用 callID 佐证；V4 稳定 fork 改写了 callID，只能靠文本。
- 顺序对齐（按类别分别进行，patience diff 的思路）：先取两边各只出现一次内容作为锚点直接配对，并取其中保持顺序的最长子序列；相邻锚点之间的区间内再按顺序贪心匹配。

  最初实现的是全局贪心（父 tag 依次从游标起找第一个相等），真实数据上失效：会话里有大量一字不差的样板（todo 提醒、输出相同的工具结果），父会话在某处多出几份重复（回滚掉的分支、没落库的临时附件）就会提前消耗子会话靠后的同名候选，游标跳过去之后中间的内容全部落在游标之前。实测父 tag 命中 830、落在游标之后 8416；换成锚点对齐后命中 2063 / 2078。回归脚本里有一个按这个形态构造的用例。
- 命中的 dropped 父 tag → 为子 part 预置一行 `status='dropped'` 的 tag，`message_id` 用子的 contentId（`mc<M>:p<下标>`），tool 类的 `tool_owner_message_id` 用子会话里发起该调用的 assistant 条目的 `mc<M>`；`drop_mode`、`byte_size`、`message_role`、`tool_name` 照抄父行；`token_count` 留空由首轮回填。`tag_number` 取父行的号。
- 不预置 `message_role = system` 的行（既有防线会把它改回 active，显式跳过更干净）。
- 预置行会被 tagger 既有路径重绑：`initFromDb` 不过滤 status（`tagger.ts:180-187`），DB fast path 接受 dropped 行（`storage-tags.ts:784-804`）。counter 与 tags_version 由既有机制维护，不手工写。

对齐不可信的判定（整体放弃，不写任何行）：首个与末个命中之间，text 类或 tool 类候选的命中率低于 90%（见"对齐可信度"）。子会话是全新会话，`tag_number` 直接取父行的号，不存在冲突。

### 摘要块与裁前缀

父会话的常态是**裁前缀**：它在自己的摘要边界处把之前的条目整体裁掉，只发摘要头与末端未折叠的消息。真实长会话实测：

| 父会话 | 条目总数 | 父会话自己发出的请求 |
| --- | --- | --- |
| Webview迁移RN（最大） | 12877 | 389 条 / 23 万字符 |
| 审查 signal-abort-scope | 8983 | 853 条 / 78 万字符 |
| （生产日志）审查 signal-abort-scope | ≈9000 | 669 条消息 |

子会话必须同形才装得进窗口。所以子会话也裁前缀，裁在哪按下面来。

**末端长度照搬父会话。** 末端 = 父会话最大 tag 序号 − 父会话摘要边界（验算：12868 − 12489 = 379，父会话实际发 389 条）。子会话从末尾数「末端 + 安全余量 100」条不裁，其余裁掉。余量盖住父会话末端没打标的条目——估算偏小会多裁，所以宁可多发送。父会话末端不足 300 条时不裁：那时未裁的请求本来就小，而固定余量会盖过整个末端、把最近几轮裁掉，那是最不能丢的部分。fork 点不在父会话末尾时这个算法只会让子会话裁得更少，同样是安全方向。

**为什么不是别的算法：**

- 「子会话里最后一个已折叠条目」当末端：父会话边界之后到最后一个折叠条目之间的内容，父会话是以占位符或原文发送的，按后者裁会把它们多裁掉（实测相差约 500 个条目）。
- 按 tag 上的 `mc<N>` 把边界逐条换算到子会话：长会话经历多次重启后前缀长度变过，tag 的序号混着不同时期的坐标系（实测父子序号差散成 71 / 43 / 89 / −4 等若干簇），不存在可用的整体平移。
- 不裁、只留占位符：子会话请求仍是父会话的 3～5 倍，真机上直接 `model_context_window_exceeded`。

**行的写法：**`title`、`content`、`p1`~`p4`、`importance`、`episode_type` 原样复制，`legacy` 由是否带 p1 推导，`sequence` 为 1..k；数值区间压成 `1..M` 的连续区间（M = 裁剪位置，historian 的增量起点、连续性校验、heal、unmanaged 判定都只读数值）。边界 id 只有末舱在允许裁前缀时写子会话坐标 `mc<M>`，其余一律空串——空串是 schema 默认值，所有边界读者都把它当「无 id」，NULL 会让 `getCompartments` 的行守卫整行丢弃。

**退路：**父会话没有摘要块、末端不足 300 条、或算出的裁剪位置没有盖过第一个折叠条目时，边界留空、不裁，折叠内容以占位符呈现。

**原文随 tag 带过来。** 裁掉的条目不进入子会话的打标流程，不会有 `source_contents`。继承时按 tag 编号把父会话的原文搬过来，否则这些 tag 日后 `ctx_expand` 取不回。

### heal 用进程内观测到的最大条目数

bootstrap turn 入口的 heal 以「边界 > 全量原始消息数」判账本是否自洽，原先传入的是**这一次调用**看到的条目数。同一轮里 transform 可能被再次调用（续写、重试路径），拿到的已经是折叠后的请求条目，长会话从近万条缩到几百条，一份自洽的账本就被清掉了（真机实测：fork 子会话 8890 → 3787 条，1175 个摘要块被清空；父会话自己也能复现）。canonical 历史在一个进程内只增不减，所以改用本进程内观测到的最大值。

### 对齐可信度

- 对齐之后检查子会话侧的命中率：同类候选中首个与末个命中之间至少 90% 被命中，否则整体放弃（`alignment-not-trusted`）。
- 父会话里 dropped 但在子会话找不到对应内容的 tag 直接跳过，只是那一部分不折叠，不会丢内容。

### 失败与幂等

- `inheritForkedSessionState` 不抛错，返回 `{ kind: "inherited" | "tags-only" | "skipped", ... }`；`inherited` 带 `trims` 与边界的换算依据。
- 登记项在首轮入口被取走后即删除，每个进程对每个子会话至多尝试一次。进程在 fork 与首轮之间退出则登记丢失，该子会话退回今天的行为。
- 继承只做一次：成功后子会话已有 tags，不再满足「tags 与 compartments 都为空」。

## 行为契约

| 情形 | 行为 |
| --- | --- |
| fork 子会话，父会话末端足够长，对齐可信 | 首轮请求与父会话同形、同量级：摘要头 + 末端未折叠的消息；historian 从末端之后续跑；无 unmanaged 拒发 |
| 父会话末端不足 300 条，或没有摘要块，或裁剪位置算不出 | 只继承 dropped 状态与摘要（边界留空）：条目全部保留，折叠的换成占位符 |
| 对齐不可信 | 不写任何行，行为与今天一致，记一条 warn |
| 子会话不是 fork、或已有 tags、或 magic-context 关闭 | 不触发 |
| 包调用抛错 | 捕获，记 warn，本轮继续（等同未继承） |
| 同一轮里再次进入 transform | heal 不清账 |

## 已知限制

- `<compartment start= end=>` 与 `## start-end` 展示的是压缩后的子会话序号，仅展示。
- `compartment_events` 不复制。父会话 fork 点之后新发布的 compartment 不在继承范围。
- 子会话的裁剪位置比父会话的实际边界靠前最多约 100 条（安全余量），即比父会话多发送这一小段。
- fork 出的子会话在界面上没有选中模型（发送按钮禁用，需手动选一次）。这段逻辑本次没有改动，原因未查。

## 验证

**单元回归** `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-fork-inherit.mjs`，9 个用例全过：

1. 不裁的退路：继承到同样多的 dropped tag、三舱摘要、边界全空；请求保留全部条目并带摘要与占位符，system prompt 在。
2. 重复的样板文本不会把对齐带偏（父会话每条消息前两份提醒、子会话一份；全局贪心会级联失效）。
3. 父会话末端足够长时子会话像父会话一样裁前缀：裁剪位置、末舱边界、请求条数、原文不在、摘要头在；system prompt 的去留与父会话一致；被裁掉的继承 tag 带着原文；再次进入 transform 不清账。
4. 稳定 fork 改写了 callID：工具 tag 按工具名 + 输出文本继承。
5. 父会话里没折叠的消息在子会话里原样保留。
6. 没有 fork 登记的会话不触发。7. 只继承一次。8. 已折叠消息的 reasoning 与父会话同去向。9. 包调用抛错时本轮照常完成。

**真实数据 e2e** `docs/iterations/magic-context-fork-inherit/e2e/e2e-fork-inherit.mjs`（真实库只读拷贝；真实 store + hydrator + port；两个真实会话各 15/15）：

| 父会话 | 不继承（今天的行为） | 继承后 | 父会话自己 |
| --- | --- | --- | --- |
| Webview迁移RN（9396 tag，1735 摘要块） | 12879 条 / 664 万字符 | 454 条 / 25.6 万字符 | 389 条 / 23.2 万字符 |
| 审查 signal-abort-scope（6290 tag，1175 摘要块） | 8985 条 / 877 万字符 | 716 条 / 59.5 万字符 | 853 条 / 77.9 万字符 |

断言覆盖：继承成功；新问题在；有占位符；父会话里独一份的已折叠原文不在请求里；远小于基线；摘要块全部继承且区间从 1 起无缝；heal 没清账；system prompt 的去留与父会话一致；条数与字符量都不超过父会话的 1.5 倍；工具调用与结果成对。

**Electron 真机**（开发实例，真实环境；经界面「分叉」→ 发消息）：

- 父会话「审查 signal-abort-scope 规格问题」界面显示上下文已用 337,462。
- 继承结果 `inherited，tags 3943，compartments 1175，boundaryOrdinal 8036，trims: true`。
- 子会话第一次模型请求 722 条消息，第一次尝试即成功（`end_turn`），整轮 27 秒，模型回复 OK；界面显示上下文已用 316,207。
- 这一轮之后子会话自己的 historian 新发布了 1 个摘要块（1176 个，末端 `mc8094`）——续跑路径得到验证。

**其余：**既有脚本 `test-magic-context-session-isolation.mjs`（2）、`test-magic-context-turn-transform.mjs`（23）、`test-magic-context-absent-event.mjs`（4）、`test-magic-context-historian.mjs`（12）全绿；`pnpm typecheck`、`pnpm lint`（177 条既有 warning，0 error）、`pnpm architecture:check --changed`（0 违规）、`pnpm exec turbo --cwd apps/zcode-cli run typecheck`（27/27）。改动只落在 magic-context 包与 bootstrap。

## 实现过程中发现的既有问题（不在本次范围）

1. **长会话的请求里没有 system prompt。** 父会话常态下裁前缀，而裁剪对头部整体裁、没有任何 system 豁免，system prompt 与 context 前缀一起被裁掉。真实数据复现：父会话自己的请求 `system在=false`；生产日志里该会话的真实请求只有 669 条消息。`magic-context-system-prompt-guard` 的 spec 第 179 行认为「system 段在 served tail 恒定存在，宿主 trim 集合够不到」，与此不符。fork 子会话与父会话行为一致，所以本次没有让它变差，但这个问题本身值得单独立项。
2. **折叠后的条目再次进入 transform 会打乱工具弧并误清账。** 续写、重试路径会把上一次的请求条目再交给 transform：位置整体前移后 tag 被错位重绑，出现「有调用没结果」与「有结果没调用」，模型拒收（`Tool results are missing for tool calls`）。父会话自己也能复现（3 / 7）。误清账那一半本次已修（heal 用进程内最大条目数），工具弧错位没有修。
3. **长会话多次重启后 tag 的坐标不可靠。** 重启后前缀长度变化，`mc<N>` 精确命中会落到别的条目上，tag 绑定的内容随之漂移。表现为父子序号差散成若干簇。本次的继承算法不依赖 tag 坐标，所以不受影响，但这意味着这些会话里 `ctx_expand` 取回的原文可能已经不是原来的那条。
4. **只写 `content` 不写 `p1` 的旧格式摘要块，渲染出来只有标题没有正文。** 本机真实数据里的摘要块都是带 `p1` 的新格式，不受影响。
5. **fork 出的子会话在界面上没有选中模型。** 原因未查。
