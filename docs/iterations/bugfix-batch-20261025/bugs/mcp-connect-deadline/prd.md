---
date: 2026-10-25
dependency: iterations/bugfix-batch-20261025/prd.md
---

# mcp-connect-deadline Bug PRD

## 背景

会话冷启动时要等待已配置的 MCP server 连接就绪。v1.0.20 的 pool 层用裸 `Promise.all` 并发连接所有 server，没有任何聚合上限；单 server 的超时是 `config.timeoutMs ?? 30s`。家里网段里有不可达的 endpoint（实测 `192.168.1.144:8765/8766`），加上 `npx -y @z_ai/mcp-server` 首次拉包，实际把 MCP startup 拖到 9.4s，会话首屏打开被明显拖慢。

## 现象描述

- 打开会话/新建会话时长时间等待，日志里 `MCP startup completed` 出现在 9s 之后。
- 移除死链或手动禁用后恢复正常。

## 复现步骤

1. 配置里保留一个不可达的 http/sse MCP server（例如指向不存在的内网 IP）。
2. 冷启动应用并打开会话。
3. 观察 CLI 日志 `MCP startup completed` 的时间戳，与首个会话首帧时间对比。

## 预期行为

单个 server 连接最多等待 4 秒；超时的 server 记为 failed（工具不注册），后台连接继续，日后连上自动恢复。

## 实际行为

无上限，等待最慢的 server 完成（可达 30s 或 9s+）。

## 影响范围

仅影响 MCP 连接就绪等待；不影响已连接 server 的工具能力。

## 验收标准

1. 死链场景下 `MCP startup` 从 9s+ 降到 ~4s 级。
2. 超时 server 状态为 failed，其它 server 正常连接且工具可用。
3. `test:mcp-connect-deadline` 2/2 通过。

## 回归测试要点

- 超时实现必须 resolve 成 failed 状态而不是 reject（`Promise.all` 不能整批失败）。
- revalidate 重连分支未覆盖（已知限制，见 spec）。
