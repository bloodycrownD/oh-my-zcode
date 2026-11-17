---
date: 2026-11-17
---

# rewind 后存活后台任务的通知丢失（SPEC）

## 背景

会话 `sess_fd608e43-d950-481e-91d5-b1f49fb472c0` 的 workflow run 在完成或升级提问时，模型收不到对应的后台通知。现场日志（`~/.omz/cli/log/zcode-2026-11-17.jsonl`）：

- run `dwfrun-8ea77676-2238-4b0a-afe7-86241df78b1e`：14:09:56 启动；14:38:12 会话 rewind（`branchGeneration` 7 → 8）；15:29:05 完成时只有 `background_task.notification.enqueued`，**没有 `runtime_enqueued` / `batch_started`**。15:07 的 escalation 同样没有入队记录。
- run `dwfrun-1587ae63-a4dc-4bcc-8424-dba84e207b13`：04:32 启动，04:50 rewind，04:58 完成，同样在入队前消失。
- 反例：04:50 之后启动、期间没有 rewind 的 run（`3cfccb52`、`315f6286`、`f50e279d`）全部正常入队并起通知回合。

根因：`registerRuntimeBackgroundTask` 在启动时按当时的 `branchGeneration` 给 registry 条目盖章；rewind 只取消 turnId 落在被裁轮次里的任务（`cancelRemovedBranchBackgroundTasks`），启动轮保留的 run 继续跑，但条目仍带旧代际。`enqueueBackgroundTaskNotification`（`background-notifications.ts`）与 `isStaleBranchRuntimeCommand`（`runtime-command-generation.ts`）都按代际 fence，且丢弃日志是 debug 级——常规日志里完全不可见。completion 与 escalation 共用这条入队函数，因此两条通道一起丢。

## 行为契约

1. **rewind 提交后，启动轮仍保留的任务全部重盖到新 `branchGeneration`**（`rebaseRuntimeTasksOntoBranch`），包括已完成的任务——它的通知可能已经入队、正卡在长回合后面等待出队。
2. **启动轮被裁掉的任务不重盖**（`fencedTurnIds`）：即使因停止失败仍在 running，它的通知也不回到新分支。
3. **没有 turnId 的任务重盖**：无法归因到被裁轮次，宁可让通知到达，也不让它静默失联。
4. **出队 fence 对 `task-notification` 按任务当前代际判定**，而不是命令入队那一刻的代际：长回合期间发生 rewind 时，队列里的通知仍能投递；被裁轮次的任务保持旧代际，仍在出队时被丢弃。
5. **stale-branch 丢弃不再静默**：入队处的丢弃日志升到 info；出队处的 `task-notification` 丢弃升到 info（其余 mode 保持 debug）。

## 非目标

- 不改 `cancelRemovedBranchBackgroundTasks` 的取消语义。
- 不引入 escalation 重提醒 / parked TTL（独立议题）。
- 不改 magic-context 的通知投影与可见性。

## 验证

- 新增 `packages/core/scripts/test-runtime-task-branch-rebase.mjs`：7 条用例覆盖重盖（running / 终态）、fenced turn、无 turnId、已在新代际，以及出队 fence 按任务当前代际判定的两个方向。
- CLI turbo typecheck 27/27、`pnpm architecture:check --changed` 0 violations。
- 真机复现路径：启动一个跨 rewind 的 workflow run，rewind 后等待完成，日志应出现 `rewind.background_tasks.rebased` 且 completion 通知有 `runtime_enqueued` + `batch_started`。
