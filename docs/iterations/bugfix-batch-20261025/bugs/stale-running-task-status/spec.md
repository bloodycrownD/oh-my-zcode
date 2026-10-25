---
date: 2026-10-25
agile_trace: true
---

# stale-running-task-status 实现规格（SPEC）

## 根因 / 方案摘要

崩溃遗留的 `running` 没有任何收敛路径；读路径优先 `meta_json.status` 导致「改列不改 meta」的修复无效。方案：新增两个对账入口（启动期全量 + 首帧按 workspace），并把「列 + meta_json」写在一起。

## 变更点清单

| 文件 | 改动 |
|---|---|
| `packages/services/src/session/taskIndexRepo.ts` | 新增 `reconcileStaleRunningTasks`（只认终态）、`markAllRunningTasksCompleted`（启动期全量，列或 meta 任一为 running 即收）、`completeRunningRows`（同时改写 `task_status` 与 `meta_json.status`） |
| `packages/services/src/session/tasksDatabase/startup.ts` | `prepareTasksIndexStorage` 的 `ensureReady()` 之后对 `instanceof TaskIndexRepo` 调一次全量对账；**内层 try/catch + logger.warn，绝不 rethrow** |
| `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts` | 首帧基线补齐后按 workspace 二次对账（同一批 `candidates` 生成 `terminalTaskIds`），同样 try/catch |
| `packages/services/test/taskRunningReconcile.test.ts` | 新增 2 例（终态收敛不误伤活跃轮 / 启动全量纠偏幂等） |

## 详细改动说明

- **与 v1.0.26 原实现的差异（有意的两处）**：
  1. 按 workspace 对账**删掉「任务已不在 summary 集合里」这条判据**。v1.0.20 的 sessions-index 首帧快照是否包含 subagent 派生会话无代码保证，按「已消失」收敛可能误伤正在跑的任务；历史脏数据由启动期全量对账兜住。
  2. 启动对账包 try/catch。v1.0.26 是直接抛，异常会让 `prepareTasksIndexStorage` 失败进而应用起不来；这里降级为一条 warn。
- 全量对账会刷新 `updated_at`，被收敛的任务会跳到列表顶部（与 v1.0.26 一致，属可接受副作用）。
- 多实例场景：另一实例若真在跑某任务，其后续事件写入会把状态写回 running；本实现在启动期不会误杀活跃会话（启动时本进程没有任何活跃轮）。

## 测试策略

### 测试用例

- `test:task-running-reconcile` 第 1 例：`terminalTaskIds=["terminal"]` → 只收敛该条，`still-live` 保持 running。
- 第 2 例：全量纠偏把两条 running 收为 completed，第三次调用返回 0（幂等）。
- 手工验证：真实库 `running` 15 → 0（列与 `meta_json` 双视角）。

## 风险与回滚方案

- 风险：`IN (?,...)` 绑定量受 SQLite 变量上限约束（默认 32766），异常已被 try/catch 兜成 warn。
- 风险：启动期全量收敛对「另一实例正在跑的任务」有极短窗口的误显示，靠后续写入自愈。
- 回滚：revert `4c001ee0` 即可回到无对账状态（旧行为）。
