---
date: 2026-11-25 21:15
title: fork 不继承 magic-context 记忆导致子会话超窗：探索结论与防腐层接缝选型
keywords: fork, magic-context, compartment, copySessionStateForClone, 防腐层, registerForkedSession, 子会话, 超出上下文, 消息ID映射
abstract: 用户报 fork 出的会话超出上下文，根因是 fork 只复制消息、不复制 magic-context 的会话级记忆（compartment/tags/session_meta），子会话首轮把全量原始前缀发给模型。用户要求方案必须走防腐层。三路探索确认：包内现成的 copySessionStateForClone 无人调用；子会话消息 ID 全是新 ID 必须映射；core 内没有所有 fork 路径共用的落库点，bootstrap 的 registerForkedSession 才是唯一收口，接缝放这里可做到 core 零改动。
---

user:
最近发现一个新 bug，fork 不会复制 magic context 的记忆，导致 fork 的会话会超出上下文。

assistant:
从源码确认了原因：core 的 fork 实现（session-fork.ts、workspace-checkpoints.ts）只复制消息与 goal，完全没有 magic-context 处理。magic-context 包里有一个现成的 copySessionStateForClone（storage-clone.ts），会复制 compartments、tags、source_contents、pending_ops 和 session_meta，但整个源码树里没有任何调用方。子会话没有 compartment，transform 无东西可注入，而 historian 只在一轮成功之后异步触发，所以首轮必然全量。

user:
你继续探索下吧，另外我希望你设计的时候考虑下防腐层，现在 magic context 基本都有防腐层，我不希望耦合逻辑。

assistant:
梳理了现有防腐层的形态：core 只声明端口类型、零运行时依赖，bootstrap 是唯一 import 包的地方并通过 create-app 注入，功能关闭时端口不存在。当时初步设想是在 core 加一个端口、在子会话提交后调用。

user:
（调用 spec-generate）

assistant:
派三路只读探索后，两条结论修正了上面的初步设想。其一，fork 子会话的消息 ID 全部是新 ID（原子路径用 createForkIdentityMap，旧路径用 copySessionMessagesForFork 逐条生成），复制记忆时必须做父到子的消息 ID 映射。其二，core 内四条 fork 路径分散在三处提交点，没有共用的"子会话已落库"位置；而 bootstrap 的 registerForkedSession 是所有路径的唯一收口，且就在子会话 resume() 之前。既有文档（magic-context-decoupling 的 IM4）也规定 magic-context 的行为只能由 host 侧调用，所以接缝放在 bootstrap 可以做到 core 零改动，比在 core 加端口更符合"不耦合"。

user:
（继续，等 spec）

assistant:
又补派两轮聚焦探索，结论是"原样复制"这条路不安全，落笔前需要用户拍板方向。关键事实：compartment 与 tag 的边界 id 是 `mc<N>`，N 是父会话运行时条目数组里的位置（含 system prompt 等 context 前缀、附件条目、每个工具结果各占一槽），不是会话库行号；子会话恢复时重建的条目数组形状不同（前缀长度会变、父会话的临时附件不在库里），同一个 N 在子会话里可能指向更靠后的消息，于是会把没被摘要过的消息当成已折叠丢掉，属于静默丢失上下文。另外父→子的消息 ID 映射只存在于 core 的 fork 过程内存，子会话的条目位置要到它首轮入口才知道。给出的三条路线：按身份重写（推荐，需要 core 把消息 ID 映射带进 fork 结果并在子会话首轮入口换算坐标）、原样复制加尾部截断（改动最小但坐标不可靠，不推荐）、不继承改为首轮前预热 historian。spec 尚未落盘。

user:
贴来另一位助手在另一台机器上的手工排查记录：fork 会话 1744 个 tag 全 active、父会话 1572 dropped / 268 active；对方认为 fork 复制了 source_contents、裁剪靠 tags.status、tag_number 父子对齐，并按 tag_number 手工把子会话的 1572 个 tag 改成 dropped；还提到后台压缩器因输入超限被取消。

assistant:
逐条对照本仓库代码核实的结果：
- "裁剪靠 tags.status"属实。transform 按 tag_number 取 dropped 行并重放成 `[dropped §N§]` 占位，compartment 只负责摘要补位与按边界裁前缀，两者在父会话里是同一事务成对产出的。
- "fork 复制了 source_contents"不属实：全仓没有任何复制代码，tags 与 source_contents 都是子会话首轮 transform 自己给全部历史新建的（全 active）。
- "tag_number 父子稳定对齐"没有结构保证：tag_number 是按条目首次出现顺序分配的位置序，context 前缀里的 system 段也会被打标并消耗编号，父子前缀长度一变就整体错位；抽查三个编号不能证明全序对齐。
- "压缩器因输入超限被取消"不准确：historian 输入会被硬截断，没有这条路径；真正卡住的是主 transform 的 unmanaged over-window 拒发（无 compartment 且无 dropped tag 时，阻塞等 historian 至多 60 秒后抛 UnmanagedOverWindowError 或 EmergencyFailClosedError），该错误的注释里直接写着"a fork whose parent left nothing to inherit"。
- live 模式下所有条目的 ID 统一是 `mc<序号>`，tag 身份因此也是位置而非消息行 ID。

据此把方案收敛为：core 零改动，在 bootstrap 首轮入口做继承；匹配键用内容等值加单调对齐而不用 tag_number；建议分两期，第一期只继承丢弃状态（足以解除拒发并回收字节），第二期再继承摘要块。等用户确认是否分期后再写 spec。

user:
那你调研 2 期。

assistant:
两路只读调研了"把父会话摘要块（compartments）继承给子会话"。结论：原样搬摘要块行不可行，但在一期之上可行，做法是"只把末端边界换算到子会话坐标"。

- 不能原样搬的原因有三：裁前缀只认 end_message_id（父会话的 mc<序号>），在子会话里要么找不到（摘要注入但不裁，装不下就 MC-H04 拒发），要么恰好落到别的条目上（裁错位置，静默丢上下文，代码里没有语义校验）；数值 end_message 是父会话的序号，超过子会话条目数时首轮入口就被 heal 整本清掉；序号不连续会让 historian 每次校验失败。
- 摘要正文本身与坐标无关，356 个摘要块的标题、正文、p1~p4、importance 可以原样复制，m[0] 的衰减分级渲染照常工作。
- 可行的做法：一期按内容对齐时，本来就得到了"子会话里哪些条目是继承来的已折叠内容"，其中最后一个的子会话序号就是摘要覆盖范围的末端。把末端边界的 id 与数值写成子会话坐标，其余各舱的边界 id 置为不可解析的哨兵、数值按原顺序压进 1..末端，末端之后 historian 从子会话自己的坐标继续。对齐必须全序成立，任何一处对不上就只保留一期结果。
- 这个方案让子会话"不比父会话更差"：子会话重启后同样会位移，与父会话重启后是同一个已知的弱点。
- 另一条零新增代码的基线：一期做完后子会话能发出去，它的 historian 会从序号 1 起在后台自己重建摘要，但每个 pass 只处理约 2 万 token，上百万 token 的历史要几十个 pass，等于把父会话的 historian 成本重付一遍。
- 实现前还要核实三点：裁前缀时 system prompt 等 context 前缀如何被保护；heal 在 bootstrap 传入的是 live 快照长度而非两侧取大；工具结果条目与父会话未落库的附件条目在内容对齐里如何处理。

user:
怎么变成三期了？我让你调研 2 期是希望一次性做完。

assistant:
是表达失误，没有三期，那三点是二期实现前的核实项。按一次性方案补了两路核实后写了 spec：docs/iterations/magic-context-fork-inherit/spec.md。要点：
- core 零改动。bootstrap 的 registerForkedSession 往一个进程内登记表记下"子会话的父是谁"（中性命名，不 import 包）；子会话首轮 turn 入口在 heal 之前调用包内新函数 inheritForkedSessionState。子代理会话不经过 registerForkedSession，天然排除。
- 继承状态用"预置 dropped 的 tag 行、让 tagger 既有路径重绑"落地，而不是 transform 之后 UPDATE，这样首轮请求发出前内容就已折叠。message 类按 source_contents 与子条目文本严格相等匹配；tool 类在 source_contents 里没有原文，要由宿主从父会话消息行取工具输出传入。
- 摘要块：正文原样复制，只有末舱边界写成子会话坐标 mc<M>，其余舱的边界 id 用空字符串（NULL 会让 getCompartments 整行丢弃，禁止），数值区间压成 1..M 的连续区间。M 之内的对话条目必须全部带继承的 dropped tag，否则只继承 tags 不写摘要，保证裁前缀不会裁掉父会话里没折叠的内容。
- 两条核实修正了早先的判断：裁前缀对头部是全裁，system 前缀是否留在请求里没有当场定论，写成了 spec 的第一条实现前核实项与硬性验收项；heal 传 live 快照长度是既有口径差，末端 M 取自同一份快照所以不会误清账，本次不改。

user:
可以。

assistant:
按一次性方案实现完成，未提交。改动面：magic-context 包新增 session-inheritance.ts（继承规则本体）并从 barrel 导出 inheritForkedSessionState，compartment-storage.ts 增加一个事务内写摘要块的出口；bootstrap 新增 session-fork-registry.ts（中性的 fork 登记表，不 import 包）与 magic-context-fork-inherit.ts（宿主胶水），registerForkedSession 在 resume 前登记，turn 入口在 heal 之前调用。core、contracts、adapters 零改动。

实现中用真实 port 做父子对照，推翻了 spec 里"末舱边界写成子会话坐标"的设计：
- 父会话的常态不裁前缀。折叠内容以 [dropped §N§] 占位符留在请求里，system prompt 与 context 前缀一直在，因为 cached_m0_last_baseline_end_message_id 为 null 时裁剪被抑制。
- 只有"没有缓存 m[0] 却已有 compartment"的冷重建才裁前缀，而裁剪对头部整体裁掉，system prompt 一起消失，基线固化后每轮都没有 system prompt。
- fork 子会话是全新会话，首轮正是冷重建。若给它可解析的边界，每个 fork 子会话从第一轮起永久丢失 system prompt。所以改为所有舱的边界 id 一律留空（包括末舱），只保留数值末端给 historian 续跑；子会话与父会话常态同形。原先"边界之前必须全部折叠"的检查随之删除。

另外两条实测的既有问题（不在本次范围）：一是冷重建会丢 system prompt，与 magic-context-system-prompt-guard spec 第 179 行的说法不符；二是只写 content 不写 p1 的旧格式 compartment 渲染出来只有标题没有正文。

四项实现前核实的结论：system 前缀见上；父会话工具输出从消息行的 tool part 按 callID 取；bootstrap 没有任何写入 isSubagent 的代码，fork 子会话默认不是 subagent；已折叠消息的 reasoning 在父子会话的请求里都不存在。

验证：新增 test-magic-context-fork-inherit.mjs 7 个用例全过；既有三个 magic-context 脚本复跑全绿（2、23、4）；pnpm typecheck、pnpm lint（175 条既有 warning、0 error）、pnpm architecture:check --changed、turbo 跑 cli 子树 typecheck（27/27）均通过。未做真机 fork 验证，也没有用例驱动真实的 historian pass。

其它探索要点：项目级记忆按项目存放、fork 子会话天然共享，缺的只是会话级这一层；copySessionStateForClone 不复制 session_meta 的账本列（prior_boundary_ordinal、cached_m0_*），全新子会话拿到的是默认初值，不会悬空；但它原样照搬 compartment 的序号，如果复制时中段丢行会留下序号空洞，子会话的 historian 会每次都校验失败，所以过滤器必须保证结果是连续块；它还没有从包的 barrel 出口导出，需要新增。

user:
你 e2e 测试下吧。

assistant:
照 system-prompt-guard 的 e2e 约定写了 docs/iterations/magic-context-fork-inherit/e2e/e2e-fork-inherit.mjs：真实 magic-context 库与会话库只读拷贝到临时目录，真实 sqlite session store 读父会话消息行、真实 hydrator 还原运行时条目、真实 port 跑子会话首轮；基线（不登记 fork）与继承（登记 fork）各跑一个子会话对照。

首跑暴露了合成数据测不出的问题：继承被判定为对齐不可信、一行没写（安全退回今天的行为）。原因是全局贪心的单调匹配在真实数据上失效——会话里有大量一字不差的样板（TodoWrite 提醒、输出相同的工具结果），父会话多出的重复副本提前消耗子会话靠后的同名候选，游标跳过去之后中间内容全部落在游标之前（实测父 tag 命中 830、落在游标后 8416）。改成 patience diff 的思路：两边各只出现一次的内容作为锚点直接配对并取保持顺序的最长子序列，相邻锚点之间再按顺序贪心。改后命中 2063/2078。补了一个按真实失效形态构造的回归用例（旧算法下会红）。

另外两个事实：从持久行还原的 assistant 文本带着 §N§ 盖章前缀（落库时没剥），与 source_contents 的原文比对必须先 stripTagPrefix；父会话的 reminder tag 有 active、compacted、dropped 三种状态，子会话里留着的 active 提醒与父会话一致，不是泄漏。

最终 e2e（本机最大会话：9396 个 tag、7725 个 dropped、1735 个摘要块、12875 个条目）13/13 通过：
- 基线：首轮请求 12879 条、664 万字符（≈221 万 tokens），复现了事故的量级。
- 继承后：3625 条、80 万字符（≈27 万 tokens），dropped tag 6966，摘要块 1735 且区间 1..12469 连续无缝，system prompt 与新问题都在，独一份的已折叠原文零泄漏。与另一台机器上手工修复后的"约 26 万 token"吻合。
- 覆盖：文本 1849/1992、工具 5117/5733。

全量复跑：回归脚本 8 个用例、既有四个 magic-context 脚本（2、23、4、12）全绿；cli typecheck 27/27、lint 0 error、architecture:check 0 违规。仍未覆盖：经产品界面真实 fork（e2e 直接调 noteForkedSession，没经过 registerForkedSession）、子会话 historian 从末端之后真实发布新舱。

user:
electron启动e2e

assistant:
用仓库的 Electron（带新构建的 agent）手工复刻 dev.mjs 启动开发实例，经 CDP（应用固定用 9229）和 npx agent-browser 操作界面。过程中三次纠正：
- 隔离失效：以为 ZCODE_HOME 能隔离，实际会话数据根由 ZCODE_DATA_BASE_DIR 决定，第一次 fork 写进了用户真实库。已停止并向用户说明；用户同意直接在真实环境继续。
- 第二次启动的开发实例和 Vite 没关干净（只结束了第一次的），后来按端口找进程树才关掉。
- fork 子会话在界面上没有选中模型，需手动选 GLM-5.3（原因未查，非本次改动）。

真机第一次验证（用户同意后）失败并暴露了三件事：
1. 继承写入成功（tags 3943、compartments 1175），但子会话首轮请求仍有 3786 条、超出模型窗口（model_context_window_exceeded）。用 e2e 加「父会话自身请求」参照后找到根因：父会话的常态是裁前缀、只发 853 条（最大会话 389 条），而合成数据里基线边界为 null、不裁——我之前「父会话常态不裁、所以子会话也不该裁」的设计依据是错的。项目记忆里那条错误结论已归档更正。
2. 超窗口触发续写，把折叠后的条目再次交给 transform：heal 拿它当全量清掉了全部摘要块；位置前移导致工具弧错位，模型拒收。两者在父会话自己身上也能复现，是既有缺陷。
3. 长会话多次重启后 tag 的 mc 坐标混着不同时期，不能用来换算边界（序号差散成若干簇）；也不能用「最后一个折叠条目」当末端（会比父会话多裁约 500 条）。

修正：
- 子会话像父会话一样裁前缀，末端长度照搬父会话（最大 tag 序号 − 摘要边界）再加 100 条余量；末端不足 300 条或算不出时不裁、退回占位符形态。
- bootstrap 的 heal 改用进程内观测到的最大条目数。
- 继承时把父会话的 source_contents 按 tag 编号带过来（被裁掉的条目不会进入子会话的打标流程）。
- 对齐算法在上一轮已改为唯一锚点；回归脚本补了「父会话末端足够长时裁前缀」「再次进入不清账」。

最终结果：回归脚本 9/9；真实数据 e2e 两个会话各 15/15（子会话 454 条 / 25.6 万字符 vs 父 389 / 23.2 万；716 条 / 59.5 万 vs 父 853 / 77.9 万）；Electron 真机经界面分叉并发消息，第一次请求 722 条、一次成功、回复 OK，界面上下文 316,207（父 337,462），子会话 historian 随后新发布 1 个摘要块。typecheck / lint / 架构检查全过。

向用户报告的既有问题：长会话的请求里没有 system prompt（裁前缀连前缀一起裁，生产请求条数吻合）；折叠后的条目再次进入 transform 会打乱工具弧（未修）；tag 坐标重启后漂移、ctx_expand 原文可能错位；旧格式摘要块只渲染标题；fork 子会话界面未选中模型。

对用户真实数据的影响：真实库里多出三个 fork 会话（「Fork of 清理已合并的 worktree」一个、「Fork of 审查 signal-abort-scope 规格问题」两个），其中最后一个跑了一轮并产生了正常的 magic-context 状态；另有一次失败的轮次留在第二个 fork 会话里。代码未提交。
