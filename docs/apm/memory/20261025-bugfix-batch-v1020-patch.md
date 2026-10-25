---
date: 2026-10-25 13:10
title: 回滚到 v1.0.20 并迁回四条老 bug，发 v1.0.27
keywords: 回滚, v1.0.20, bugfix-batch-20261025, v1.0.27, 上游同步失败, 老bug迁回
abstract: 上游 v3.16.2 全量同步后 omz 已不可用，用户下令整体回滚到 v1.0.20；随后用 agile-dev 把「与升级无关、v1.0.20 本身就存在」的四条老 bug 迁回，全门禁绿后发 v1.0.27。
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
