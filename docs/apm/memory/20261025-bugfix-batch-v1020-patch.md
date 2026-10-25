# 2026-10-25 · bugfix-batch-20261025（v1.0.20 回滚基线补丁）

## 前因

2026-10-25 用户下令把主线整体回滚到 v1.0.20（上游 v3.16.2 全量同步之前最后一版），理由：同步后 omz 无法正常使用。执行：main 硬重置到 `6c84cfcd` 并 force push；回滚前 HEAD `87e4e2e5` 打归档 tag `archive/pre-rollback-v1.0.26`；已发布 v1.0.21~v1.0.26 tag 保留；数据备份在 `~/.omz/backup-20261025-rollback`。

回滚后按用户指示，用 agile-dev 把「与升级无关、v1.0.20 同样存在」的四条老 bug 迁回。

## 类型与命名

- 类型：bug ×4
- 迭代：`bugfix-batch-20261025`（`docs/iterations/bugfix-batch-20261025/prd.md`）
- 敏捷名称：`mc-tag-leak-to-bubble` / `held-queue-input-dropped` / `stale-running-task-status` / `mcp-connect-deadline`
- 分支：`fix/v1020-patch`

## 探索结论（两个 readonly 子代理，均带 file:line）

- 四条缺陷在 v1.0.20 **全部存在**；当年的修复大多可直接套用（§N§ 两提交、队列三文件字节级相同、pool.ts 逐字相同）。
- 对账的 108 行方法可直接搬，挂点从 v1.0.26 的 `project-storage/startup.ts` 换成 v1.0.20 的 `session/tasksDatabase/startup.ts`。
- v1.0.20 没有 `scripts/test-v4-perf.mjs` runner，测试聚合是根 `package.json` 内联命令。

## 实现（5 个 commit）

- `4c001ee0` fix(tasks)：启动 + 首帧对账；**有意的两处偏差**：删掉「已消失」判据（首帧快照是否含 subagent 派生会话无保证）、启动对账包 try/catch（不能让对账失败阻断存储准备）
- `f4054945` fix(mcp)：单 server 4s 连接上限（resolve 成 failed，不 reject）
- `1612ba10` fix(mc-tag)：落库 + 五处消费端剥离；**额外补了 `cancelled-stream-persistence.ts`**（v1.0.26 漏修的中断落库缺口）
- `866c8020` fix(queue)：补 `return;` + held 路由改 enqueue + 立即发送恢复 autoDrain
- `db41442f` fix(queue)：`setQueueAutoDrain` 改可选调用（model-live 夹具无此方法，硬调用导致 T-ML2a/b/d 三例红）

## 验证

- 针对性：`test:magic-context-tag-strip` 10/10、`test:magic-context` 23/23、`test:held-queue-routing` 6/6、`composerHeldQueueGuard` 1/1、`test:task-running-reconcile` 2/2、`test:mcp-connect-deadline` 2/2、model-live 8/8。
- 门禁：`pnpm typecheck` 通过、`pnpm lint` 0 error（170 存量 warning）、`pnpm test:v4-perf` 全绿。
- 顺手处理：`.zcode/e2e/` 本地产物被 oxlint 扫到（触发 max-lines error 挡门禁），已删除并加 `.gitignore`。

## 待办 / 已知限制

- `pool.ts` revalidate 原地重连分支未加 deadline（设置页刷新仍可能 30s），登记为后续。
- 启动对账会刷新 `updated_at`，被收敛任务跳到列表顶部（与 v1.0.26 一致）。
- prd/spec 已落盘，**待用户确认**后收尾并发 v1.0.27 提示。
