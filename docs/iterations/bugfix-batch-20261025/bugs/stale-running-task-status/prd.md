---
date: 2026-10-25
dependency: iterations/bugfix-batch-20261025/prd.md
---

# stale-running-task-status Bug PRD

## 背景

任务索引库（`~/.omz/v2/tasks-index.sqlite`）里每条任务有持久 `status`。进程被强杀或崩溃时，最后一次写入停在 `running`；而 sessions-index 同步器刻意不回放历史终态（`processSummary` 的 `becameTerminal` 要求本轮先见到非 running），于是这些任务永远显示「运行中」，实际没有任何轮在跑。这条缺陷早在 10 月中旬的任务里就已产生（脏数据行 `updated_at` 为 10-13），与上游 v3.16.2 同步无关，v1.0.20 同样存在。

## 现象描述

- 打开老会话，界面显示运行中/停止态，但没有任何生成在进行。
- 对该状态点「停止」没有效果（运行时里并没有对应的活跃轮）。
- 本地库实测：82 条任务里 15 条停在 `running`，最早的是几天前。

## 复现步骤

1. 在会话生成过程中强制结束进程（任务管理器杀进程）。
2. 重新启动应用，打开该会话。
3. 观察状态：仍显示运行中，且停止无效。

## 预期行为

崩溃遗留的 `running` 应在启动时收敛为终态（completed），不再出现假运行。

## 实际行为

无任何对账机制；且读取路径优先 `meta_json.status`（`taskIndexRepo.ts` 的 `rowToMeta`），只改 `task_status` 列不生效——这是本次实现中实际踩到的坑。

## 影响范围

任务列表状态与随之出现的停止入口；不影响真实会话内容与历史。

## 验收标准

1. 启动应用后，库里不再有 `running` 状态的历史任务（列与 `meta_json` 双视角均为 0）。
2. 仍在运行的任务不被误伤。
3. `test:task-running-reconcile` 2/2 通过。

## 回归测试要点

- 启动对账失败绝不能阻断存储准备（否则应用起不来），必须 try/catch + warn。
- 按 workspace 的二次对账只收敛「summary 已终态」，避免把派生会话误判为已消失。
