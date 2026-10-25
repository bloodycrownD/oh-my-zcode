---
date: 2026-10-25
dependency: []
---

# bugfix-batch-20261025 迭代 PRD

## 背景

上游 v3.16.2 全量同步（v1.0.21~v1.0.26）后主线已回滚到 v1.0.20（tag v1.0.20，commit 6c84cfcd）。回滚保留历史与已发布 tag，但升级期间定位到的若干**老 bug** 在 v1.0.20 中同样存在，需要单独迁回。

## 范围

只做与升级无关、v1.0.20 已复现的四条缺陷，不引入任何新架构（虚拟项目存储、远程开发、设备管理、source-settings 一律不碰）：

1. `mc-tag-leak-to-bubble`：MC 自标注 `§N§` 上屏（v1.0.20 的 `stripPersistedAssistantText` 零调用）
2. `held-queue-input-dropped`：中断暂停后输入不入队 / 停止关不掉（`24af3955` 误删 `return;`）
3. `stale-running-task-status`：崩溃遗留 `task_status=running` 无对账，老会话假显示运行中
4. `mcp-connect-deadline`：死链 MCP 拖慢冷启动（无连接上限）

## 不做

- 不恢复 v1.0.21+ 的任何代码树内容
- 不改 UI 骨架、不加设备/远程/虚拟项目能力
- 不做数据回填（历史 1.0.22+ 已修的脏数据用启动对账自然收敛）

## 验收标准

- 四条各自有可复现的验证点（改前红 / 改后绿）
- 针对性测试 + 聚合回归 + 构建通过
- 不改变 v1.0.20 之外的既有行为
