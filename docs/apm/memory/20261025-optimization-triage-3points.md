---
date: 2026-10-25 21:50
title: 三个优化方向评估：会话装载窗口化、MC 插件化防腐、三栏布局重排；前两篇 spec 已落盘
keywords: B1, 装载窗口化, 视图运行时解耦, 全序索引, rowId, magic-context, 防腐层, 窄子路径, 零加载, 一键摘除, compartment 悬挂, rebuildEntry, 升级跟随, 三栏布局, 工作量评估
abstract: 三个方向（会话打开慢、MC 插件化一键移除、UI 三栏重排）的评估与落盘决定。会话慢的主因是冷订阅把「看」与「跑」绑在一起（先激活 runtime 再投影），根治方案是把显示窗口/全序索引/运行时历史三件事解绑。回滚树没有 MC 门面（2240 行单体 + 6 处静态 value import），adapters/config/schema 与协议两个 handler 是「关掉仍全量加载」的硬墙。用户拍板：UI 暂缓，先做会话装载与 MC 防腐层；后又追加「都修吧，根治，需要决定的地方按根治思路自行决定」，两篇 spec 已落盘（各七条不变式 IM1~IM7 / IS1~IS7），三项原待拍板全部由 spec 自行裁定。
---

user:
先恢复记忆，然后讨论三个优化点：①之前那个会话加载慢的问题；②magic-context 问题太多，我希望它可以完全插件化、我们把它和主体切割开、重新优化防腐层，未来可以一键去除 magic context；③UI 调整：目前是左侧栏、中间聊天、右侧栏，我希望是右侧栏、左侧栏、中间聊天，并且状态面板应该改到聊天左侧。顺带问这个 UI 调整麻烦吗、工作量如何。

assistant:
先读了两条已存记忆（会话打开慢的 B1 定性、v1.0.20 回滚与 v1.0.27 发版），再派三个只读子代理按当前 HEAD dddb9a20 核实代码现状，结论如下。

①会话加载慢：B1 的定性在当前树上仍成立（传输只发尾巴 60 行 + rows/range 分页，慢在「为显示 60 行先算全部」），但发现一个比原记忆更关键的点——冷订阅把「看」和「跑」绑在一起：ensureColdReadyPublisher 先 ensureResumed（激活 runtime：再全量读一遍 messages、重建完整 messageHistory、eager 初始化 context），之后才做 hydration 投影。所以只做投影窗口化最多拿回三源合并那一档（约 0.8s），要达到 1s 级必须先做视图/运行时解耦（S1）。rowId 是 replay 期自增、不持久化，firstRowId/totalCount 是全序语义，这是窗口化最难绕的钉子（S3 checkpoint 才能彻底稳定）。另：v1.0.20 树没有会话导出功能，旧记忆里「导出仍要全量」这条约束不成立。

②MC 解耦：回滚树里不存在 v1.0.21+ 的 adapter/gate/assembly，bootstrap 侧是一个 1663 行单体（magic-context-turn-transform.ts）。6 处静态 value import，其中 adapters/config/schema.ts 与协议 server 的两个 handler 与开关无关、启动即装载整棵包（270 文件/7.9 万行），所以「关掉 = 零加载」当前不成立。生效口径在 6 处各写一遍。core 侧三端口防腐是干净的。数据面 ~96 条迁移、无自动备份、fail_closed_blocking 默认 true。移除五波：gate 单函数 + adapter 门面（零行为）→ adapters schema 解耦（包加窄子路径或 contracts 侧 opaque）→ 协议 handler 惰性化 → core ctx_* handler 收口 → UI/协议面（4 RPC + 4 命令 + 2 设置分区 + 56 条 i18n）与构建/staging/knip。

③UI：布局顺序由 DOM + react-resizable-panels 的 panel 成员关系决定，不是 order/grid。根是 flex 的 [sidebar][把手][#content]，右栏是 #content 内 RRP group 的第二个 panel（id=browser），纯 CSS 无法把它提到 sidebar 之前。字面需求（右栏|左栏|聊天）要把它提到外壳根重划顶层 group，连带 Windows 自绘窗控位置、mac 红绿灯安全区（DesktopTopOverlay 绝对定位 left-0、宽度=侧栏宽）、Win10 圆角、toggle 图标方向、RRP 持久化 key 变化（宽度会一次性重置）。状态面板 = ConversationStatusPanel，绝对定位 right-4，左移只需改方向与 translate，但要避让左侧 turn navigator 竖轨（48px）。量级：右栏搬最左 2-4 天（含四平台真机验收），状态面板左移 0.5 天；若可接受「左栏 | 右栏 | 聊天」，组内换序约 10 行即可。

user:
UI 变动先放一边，记录下调研记录，先把会话装载与 MC 防腐层这两个做了。补充：MC 防腐层还有一个作用是方便跟随 ZCode 升级——从记忆与 git 历史能看到 MC 非常影响 omz 升级。

assistant:
按拍板执行：调研记录落 `docs/iterations/optimization-triage-20261025/research.md`（含三方向结论、耦合清单、五波改造、证据索引），UI 段标注暂缓并保留三种顺序的成本与风险。升级跟随的证据核过：MC 是移植件（`UPSTREAM-SYNC.md:62` 要求 src/core 逐字重放、src/host 逐个判定），`src/core` 255 文件里 83 个带 FORK 标记（294 处）、`src/host` 14 文件里 12 个带标记（75 处），同步区间 217 提交中 12 条 MC 相关提交，加上幽灵消息事故与整体回滚，说明升级成本大头是宿主侧耦合散点而非 MC 包本身。

user:
（待办）两项开工顺序已定为 MC 第一波（gate 单函数 + adapter 门面，零行为）优先；仍待拍板：首屏是否接受不激活 runtime、firstRowId/totalCount 是否可改语义、rowId 是否必须跨进程稳定。

assistant:
（2026-10-25 晚）用户把三个方向一起拍成「都修吧，根治，需要决定的地方按根治思路自行决定」，据此把两篇 spec 落盘，原先三项待拍板全部由 spec 自行裁定（不再回问）：

1. `docs/iterations/magic-context-decoupling/spec.md` — 八阶段（baseline → effective-single → facade → zero-load → identity-guard → compartment-rewind → unplug → upgrade-surface → gates），七条不变式 IM1~IM7。关键裁定：W1 走**包内窄子路径**而非宿主 opaque 化（保字段级校验）；`host/config/schema` 的子路径闭包（4 文件）接受，但把 `isValidPromptSurfaceModelKey` 抽成零依赖叶子压到 2 文件；C1 悬挂摘要**host 清缓存 + core refused 不注入双保险**（core 改动按 #135 登记 FORK 与 rebase 点）；冷/热两套真值保留但同函数计算；**包缺失不致命**（`absent(package_missing)`，不再 throw，否则「删包=启动失败」与一键摘除冲突）。附带更正 research.md 三处勘误：单体 1663→**2240 行**、迁移 96→**93 条**、FORK 计数需先定语法（大写口径 core 120/68、host 41/5）。
2. `docs/iterations/session-open-latency/spec.md` — 六阶段，七条不变式 IS1~IS7。根治思路=把**显示窗口 / 全序索引 / 运行时历史**三件事解绑：先用只读 id 列的轻量索引（`listSessionMessageIndex`）承接 revert 裁断、turnDirectory、totalCount、firstRowId、realUserQueryTotal，再窗口化正文，最后拆「看/跑」与懒历史。三项原待拍板据此裁定：**revert 裁断必须全序**（只喂尾窗会复活已回滚分支或清空历史）、**totalCount 不许估算**（改由索引给精确值）、**rowId 不要求跨进程稳定但 firstRowId/totalCount 必须有独立权威来源**。另更正 research 一处：`readSessionContextUsage` **不**重复读 messages；并指出「hydratePublisher 是 projection-only」不成立（无 record 时直接返回空事件，仓内不存在「看不跑」分支）。
