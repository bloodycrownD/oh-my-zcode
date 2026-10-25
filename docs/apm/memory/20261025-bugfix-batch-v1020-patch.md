---
date: 2026-10-25 21:40
title: 回滚到 v1.0.20 并迁回四条老 bug，发 v1.0.27；第五条「编辑重发仍发旧消息」出 spec
keywords: 回滚, v1.0.20, bugfix-batch-20261025, v1.0.27, 上游同步失败, 老bug迁回, editUserQuery, 编辑重发, rewind, auto-drain
abstract: 上游 v3.16.2 全量同步后 omz 已不可用，用户下令整体回滚到 v1.0.20；随后用 agile-dev 把「与升级无关、v1.0.20 本身就存在」的四条老 bug 迁回，全门禁绿后发 v1.0.27。之后用户又报第五条（终止后编辑重发仍是旧消息），定位为三个叠加缺陷（编辑器种子竞态 / rewind 期间 auto-drain 抢跑 / stop hold 覆盖不全），已出 spec 待确认。
---

user:
我服了，也别修什么东西了。整个分支回滚吧，回滚到 v1.0.20，v1.0.20 是不是进行 omz 升级前的最后一个版本？我发现你这次合并非常的失败，整个 omz 已经无法使用了。

assistant:
核实了 tag 时间线：v1.0.20（10-22）是上游 v3.16.2 全量同步（v1.0.21，10-23）之前的最后一版，两者之间 93 个提交，HEAD 相对 v1.0.20 是 710 文件 / +116,088 / −18,773。按「先保数据、再保历史、最后动 main」执行：备份 `~/.omz` 到 `~/.omz/backup-20261025-rollback/`；归档 HEAD 为 tag `archive/pre-rollback-v1.0.26`；main 硬重置到 `6c84cfcd` 并 force push；已发布的 v1.0.21~v1.0.26 tag 全部保留。同时提示降级风险：两个库已被新版本迁移过，若旧版读新库报 schema 错，用备份恢复。

user:
这次升级中间发现很多 bug，你也修复了一些对吧？这些能迁移到新基线吗？还是说那些 bug 是升级后才有，20 版本没有？

assistant:
用 git 逐条核过，分成两类。升级后才有的（回滚即消失，不用迁）：老项目打不开 project.host-mismatch、打包启动即崩 `Cannot find package 'sqlite'`、幽灵消息嫁接（v1.0.20 的 MC 里没有 rebuildEntry）、设备/source-settings/虚拟项目等整套新 UI。v1.0.20 本来就有的（值得迁）：§N§ 标签上屏（`stripPersistedAssistantText` 零调用点）、中断后队列吞输入（误删 `return;` 的 `24af3955` 是 20 版祖先）、崩溃遗留的假运行状态（脏数据是 10-13 的）、死链 MCP 拖慢启动（20 版有同构 pool）。

user:
B 中的几条工作量大吗？git 历史中的代码能复用吗？

assistant:
核过目标文件在 v1.0.20 是否存在：§N§ 两提交 `git apply --check` 全绿、队列三文件字节级相同、`pool.ts` 与修复前逐字一致；对账 108 行方法依赖的私有成员一个不缺，只是挂点要换成 20 版的 `session/tasksDatabase/startup.ts`。合计约半天，不是重写。三个会卡的地方：20 版测试聚合是根 package.json 内联命令（易撞 Windows 8191 上限）、package.json 必冲突、MCP 收益只有存在死链才看得见。

user:
（点名 agile-dev）做吧。

assistant:
按 agile-dev 走完：两个只读探索子代理并行返回（均带 file:line）；两个实现子代理并行落地，四个逻辑提交 `4c001ee0`（假运行对账）、`f4054945`（MCP 4s 上限）、`1612ba10`（§N§ 剥离，额外补了 v1.0.26 漏修的中断落库路径）、`866c8020`（队列 held→enqueue + 恢复 autoDrain）。门禁首轮红了一次：model-live 的 record.app 夹具没有 setQueueAutoDrain，硬调用让 T-ML2a/b/d 三例 TypeError，改成可选调用（`db41442f`）后 8/8。另删掉被 oxlint 扫到的 `.zcode/e2e/` 临时 profile 并加忽略（`fa031473`）。最终：根 tsc 通过、lint 0 error/170 存量 warning、test:v4-perf 全绿、打包后真启动冒烟通过。

user:
发新版本吧。

assistant:
写 CHANGELOG 1.0.27 段（含两条已知限制）、bump 版本、`7af6d91d` 提交；main 从 `6c84cfcd` 快进合并、推送、打 tag `v1.0.27` 推送。工作树干净，只剩 `.reference/` `.tools/` `.zcode/` 三个未跟踪目录。

user:
【别改代码，又发现个bug，我编辑消息后再发送，消息不更新，其实我之前补了一个【可以先写spec】的命令，但是你看不到】这个bug这么严重吗？
（补充原话）发送消息后，后悔了，终止，然后重新编辑并发送，结果实际发送的是旧消息，而不是最新消息。

assistant:
先说一条事故：user 那条带【…】的消息**从未到达主代理上下文**（同内容在后续消息里被引用后才首次可见），导致上一轮按手里的 magic-context 线索答偏。后续遇到「用户说我看不到」时，直接要原文，不要靠推断。

按 spec-generate 走：4 个只读探索子代理并行（命令准入/rewind 投影/持久化与重发/测试与历史），第 2 轮再补派 3 个聚焦子代理验证「终止→编辑→重发」这条具体时序。结论：

- **先排除**：原生链路上 `newText` 从未被改写成旧值。`command.ts:131-134` 的 newText 必填；`input-intent.ts:84,87` 用本次 admission 的新 queueItemId + 新 text，旧 id 只折进 `provenance.queueItemId`（:101-109）；`v4-bridge.ts:366-369` 的 `?? canonical.intent.text` 因 schema 必填不可达。模型实际收到的文本是 `executeTurnCommand(command.input)`（`runtime-command-queue.ts:205-206`），展示/落库才是 `displayInput`，`intent.text` 只是元数据。
- **真根因是三个叠加缺陷**：①D1 编辑器种子竞态——`ChatPromptEditor.tsx:180-201` 的 initialValue effect 不判断用户是否已改动就 `setText(initialValue)`，而播种值正是该行旧正文（`ConversationRowView.tsx:1062-1070,1144`）；②D2 rewind 钩子抢跑——`fork-edit-retry.ts:114` 的 `afterLegacyStateMutation("session_rewound")` 会走 `v4-bridge.ts:593-666` 的 auto-drain，且在 `startCanonicalIntent`（:216）**之前** await，旧队首被 `queue.ts:363-374` 以 `queueItem.text`（旧文本）提升成活跃轮，新文本落 queue 且 `prompt-turn.ts:148-164` 静默；③D3 stop 的 hold 覆盖不全——`session-flow.ts:343-358` 只在 `kind==="stopped" && queueLength>0` 时置 autoDrain=false，noop（:335-342）与 idle/unsupported 兼容分支（:366-377）都不置位。
- 严重度：不是「显示不刷新」。D2/D3 会让旧轮抢跑且新文本滞留队列，会话 resume 时被 `discarded(session_resumed)` 永久丢弃；D1 则是「改了我却发出旧的」最字面的一幕。
- 同族关系：本条是 `held-queue-input-dropped`（同批，拍板 held 期间输入照常入队 + 立即发送恢复 autoDrain）的镜像副作用，两条 spec 不可互斥。
- 落盘：`docs/iterations/bugfix-batch-20261025/bugs/edit-resend-stale-text/spec.md`。先按「最小闭环」写了一版，用户否决：「我不懂什么最小，我只在乎根治……这个问题修了好多轮，却现在都没修好，最小修毫无意义，重要的是一次性修好，根治。」已整篇重写为根治版：以六条不变式（I1 执行文本只读账本 / I2 截断级联作废输入 / I3 意图单点解析 / I4 rewind→start 事务化 / I5 ACK 带投递态 / I6 编辑器种子代次）为验收，主体是 RC1「执行侧从投影读文本」（`queue.ts:296` → `v4-gateway.ts:2593-2597` → `content: queueItem.text`）与 RC2「截断不级联清理输入队列」两条架构缺陷；15 步、T-IA/T-RW/T-RT/T-DA/T-ES 五组用例、按阶段独立提交可单独 revert。**未改任何代码**，等用户确认 spec。
- 方法论教训：前四次修复全在修「触发器」（文本覆盖 → intent.text → 模型选择 → 抢占判据），无人建立不变式，所以每次只堵一条路径。判据应写成「任意时序下不变式成立」，而非「某条路径不复现」。
