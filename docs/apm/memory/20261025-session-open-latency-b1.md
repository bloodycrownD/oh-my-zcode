---
date: 2026-10-25 21:50
title: 会话打开慢的根治：显示窗口/全序索引/运行时历史三件事解绑（spec 已落盘）
keywords: 会话打开慢, 冷启动, 分页, 投影全量, B1, 切换会话延迟, 全序索引, view-only, historyMode, selectActiveConversationBranch, 幽灵runtime
abstract: 实测冷开慢不在传输（尾 60 行 + rows/range 游标已就绪），而在「为显示 60 行先算全部 2593 条」且冷订阅把「看」与「跑」绑死。根治 spec 定为把显示窗口、全序索引（只读 id 列）、运行时历史（发送时才全量）三件事解绑；revert 裁断必须全序（尾窗近似会复活已回滚分支或清空历史），totalCount 不许估算，rowId 不要求跨进程稳定。
---

user:
之前那个会话加载慢的问题还记得吗？

assistant:
记得，且有实测数据。在 v1.0.26 树上量的一次冷开 7.6s：点任务→CLI 起好 +1.4s，`session.resume_completed`（历史回放）+2.7s，三源合并 +0.8s，首屏可见（快照编码→传输→前端重建行）+2.8s；同会话 CLI 已热时重开只要 0.4~0.7s。

user:
（当时的追问）现在是全量加载吗？这不合理吧？前端 UI 自己都是虚拟列表，后端还全量加载？经典做法不是分页吗？

assistant:
先纠正自己的说法：**不是全量下发**。传输本来就窗口化——尾巴 60 行 + `rows/range` 游标，前端 `loadOlder()` 已接。慢的是**计算**：为了显示 60 行，CLI 先把 2593 条消息全部读进来、三源合并、建完整投影，再切 60 行发出去。所以问题不是「没分页」，是「算全量、发窗口」。

user:
（当时拍板）那就按 B1 做，切换会话也要快。

assistant:
方案定为 B1 装载窗口化：`resume` 只读尾部窗口（约 400 条 + parts），更早的行按需通过 `rows/range` 回填。B3（首帧不等全量）被排除——它只省等待、不省 CPU，也覆盖不到中途切换；B2（预热进程）用户明确永久删除。预估：冷开 7.6s → 1s 级，切换 → 800ms 级。代价是动核心语义：跨窗口轮分组、tool_use/tool_result 配对、firstRowId/totalCount、导出仍要全量、MC 记忆边界。

user:
（2026-10-25 现状追问）现在基线变了，还能照旧做吗？

assistant:
不能直接套：那组毫秒数是在 v1.0.26 树上量的，现在基线是 v1.0.20（回滚后），hydrate/投影那批新架构改动不在树里。建议顺序：先在同一条基线上实测 v1.0.27 的冷开与切换耗时（只读不改码），再出一份 B1 技术方案（含验收指标 ≤1s / ≤800ms 与回滚阀）给用户审，点头后才动核心。

user:
都修吧，根治。如果需要决定的地方，通通按照根治的思路做决定。

assistant:
spec 已落盘 `docs/iterations/session-open-latency/spec.md`（六阶段 / 七条不变式 IS1~IS7）。根治思路不是「给投影加 limit」，而是把三件事解绑：**显示窗口**（尾 60 行正文）、**全序索引**（只要 id/role/time，不要正文）、**运行时历史**（发送时才需要）。

关键裁定（原本留给用户的三个问题，按根治原则自行定）：①`session.revert` 裁断**必须全序**——只喂尾窗时 `selectActiveConversationBranch`（contracts/src/rewind/index.ts:165-204）会因 targetIndex<0 **复活已回滚分支**、因 cutIndex<0 **整段清空历史**，而全序 id 索引很便宜，没有近似的理由；②`totalCount` **不许改成估算**，但改由索引给精确值（UI 同时用它估滚动条与判 totalCount>rows.length，估算会让两者矛盾）；③`rowId` **不要求跨进程稳定**（不落 checkpoint 表），但 `firstRowId`/`totalCount` 必须有独立于投影自增的权威来源。

顺序是硬的：order-index 先行（IS2/IS5 的唯一合法来源）→ tail-window → view/runtime 拆分 → 懒历史。两处勘误也写进 spec：`readSessionContextUsage` 并**不**重复读 messages（`persistedMessages ?? ...` 已复用）；「hydratePublisher 是 projection-only」不成立——`loadPersistedEvents` 无 record 时直接返回空事件，仓内根本没有「看不跑」的分支。

最高风险：`hasLiveConversation` 变三态（live/viewOnly/absent）后任何残留二态判定都会重演 `v4-gateway.ts:1951-1957` 记录的幽灵 runtime 事故（二次 resume → 重复 SessionResumed → 双写账本 → transcript 定格），所以三态化必须收成单函数 + 源码守卫。
