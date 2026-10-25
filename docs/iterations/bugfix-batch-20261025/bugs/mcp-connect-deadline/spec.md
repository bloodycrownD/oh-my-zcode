---
date: 2026-10-25
agile_trace: true
---

# mcp-connect-deadline 实现规格（SPEC）

## 根因 / 方案摘要

pool 层连接没有聚合上限，冷启动被最慢的 server 拖住。方案：在 pool 里给单 server 的连接加 4 秒 deadline，超时即记为 failed（resolve 语义），不取消后台连接。

## 变更点清单

| 文件 | 改动 |
|---|---|
| `apps/zcode-cli/packages/adapters/src/mcp/pool.ts` | 新增 `MCP_CONNECT_DEADLINE_MS = 4_000` 与 `withConnectDeadline()`；新建 entry 的 `adapter.connectServer(...)` 包一层 |
| `apps/zcode-cli/packages/adapters/scripts/test-mcp-connect-deadline.mjs` | 新增回归脚本：注入永不 resolve 的假 adapter，断言 ~4s 内记 failed 且不阻塞其它 server |

## 详细改动说明

- `withConnectDeadline` 用 `Promise.race` 但**只 resolve 不 reject**：超时返回 `{status:"failed", error:"connect deadline exceeded"}` 形态，保证 `Promise.all` 不会整批失败，也保证 `revalidateEntry` 的 `connected` 判定语义不变。
- 超时不取消底层连接：adapter 仍会继续 connect；`status()` 读 `adapter.status()`，后台连上后 UI 自然翻回 connected。
- 与 v1.0.26 原实现逐字节一致（`git diff --no-index` 空）。
- **已知限制**：`pool.ts` 的 revalidate 原地重连分支未覆盖，设置页 `mcp/list` 的 `revalidate:true` 路径仍可能被单 server 拖到 30s；该项超出本次钦定范围，登记为后续待办。

## 测试策略

### 测试用例

- `test:mcp-connect-deadline`：2 例。①永不 resolve 的 server 在 ~4.0s 被判 failed（实测 4010ms）；②与一个立即成功的 server 并发时，成功者不被拖住。
- 手工验证：真实死链配置下比对 `MCP startup completed` 时间戳（需本机存在不可达 endpoint）。

## 风险与回滚方案

- 风险：4s 上限会压过 `config.timeoutMs > 4s` 的显式配置，慢速 npx 首装会被判 failed，需要在设置页手动重连。
- 风险：超时后后台仍在下载/起进程，资源不回收（既有 idle 机制兜底）。
- 回滚：revert `f4054945`（pool.ts 单文件 + 脚本）。
