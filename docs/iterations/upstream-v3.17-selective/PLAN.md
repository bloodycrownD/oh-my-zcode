---
date: 2026-11-05
title: 上游 v3.17.x 选择性升级：vendor 基线与批次计划
upstream_base: 3c5b2276（v3.16.2）
upstream_target: a9fe401e（v3.17.2）
---

# 分批升级计划

## 原则

1. **vendor 基线只做 fast-forward**。本地分支 `vendor/zcode` 跟踪 `upstream/main`，只存放上游原始树，不含任何 fork 改动。上游发版时只更新这条分支，不产生合并冲突。
2. **main 每次只摘一小批**。每批只含一组主题相关的候选 hunk，独立分支、独立 commit、独立回滚。
3. **每批必须能单独发版**。批次完成后跑最小门禁，版本号 +1，CHANGELOG 记录上游 commit 与候选 ID；全量门禁只在发版前跑。
4. **不做整树 merge**。上游新增的产品线（telemetry / data-sync / site-plugin 等）与删除的单测不能跟着进来；一律按候选 hunk 摘取。

## 基线

| 名称 | 指向 | 用途 |
| --- | --- | --- |
| `vendor/zcode` | `a9fe401e`（v3.17.2） | 上游原始树，只读 |
| `3c5b2276` | v3.16.2 | fork 当前已合入的上游基线 |
| `main` | fork v1.1.3 | 产品分支 |

取文件：`git checkout vendor/zcode -- <path>`；取 diff：`git diff 3c5b2276 vendor/zcode -- <path>`。

## 批次

| 批次 | 分支 | 候选 | 目标 | 状态 |
| --- | --- | --- | --- | --- |
| B1 | `upgrade/317-p0-security` | CLI-01、CLI-02 | sed 只读白名单、Plan 权限闸门收紧 | 已应用，待评审 |
| B2 | 待建 | CLI-03、CLI-04、CLI-05 | Explore/子代理权限继承与模型句柄 | 待开始 |
| B3 | 待建 | SVC-B01、CLI-06/07、CLI-08 | 配置写入加固、Read 状态、MEMORY.md 公告 | 待开始 |
| B4 | 待建 | SVC-B02、SVC-B08、SVC-B10、SVC-B11、CLI-22 | 挂起/崩溃/静默失败/无限重试 | 待开始 |
| B5 | 待建 | SVC-P01、SVC-P02、PF-03、PF-04 | RPC 序列化与查找性能 | 待开始 |
| B6 | 待建 | BF-01、BF-02、BF-04、BF-13 | 发送结算、终端 PTY、插件批量更新 | 待开始 |
| B7 | 待建 | CLI-06/08 融合、PF-01、PF-06 | 需要与 fork 改动逐 hunk 融合的大项 | 待开始 |

## 每批门禁

1. 受影响包的 `typecheck`（CLI 包用 `tsc --noEmit`，根包用 `pnpm typecheck`）。
2. 该批新增/相关的回归脚本（`apps/zcode-cli/packages/*/scripts/test-*.mjs` 或 `packages/*/test/*.test.ts`）。
3. 涉及 UI/桌面的批次补跑对应 E2E spec。
4. 发版前：`pnpm typecheck`、`pnpm lint`、`pnpm test:v4-perf`、相关 E2E。

## B1 记录（执行后回填）

> 本节为落地后的实际状态回填：计划阶段写的「保留 `CronPauseSelf` 以减少分叉」「3 组/4 组、合计 7/7」「guarded + Plan 单次确认」均与执行结果不符，已按 SA-D8 / SA-A7 及实际脚本计数纠正。

- 上游来源：`3c5b2276..v3.17.2` 的 `core/src/tool/handlers/bash-readonly-policy-*`、`core/src/permission/service.ts`。
- fork 差异：三个文件在 `3c5b2276..main` 均无改动，直接取上游版本。
- `permission/service.ts` 里的 `CronPauseSelf` / `automation.pause` 免确认分支已按 SA-D8 整段删除：fork 无该工具，且原判据只信「工具名字符串 + 通用旗标」，任何同名工具声明对应 permission 即可白拿放行。后续若采纳该工具，需先补内置 tool entry 身份校验与「入参只允许本轮注入 id」，不能直接恢复原分支。
- 回归：`apps/zcode-cli/packages/core/scripts/test-bash-sed-readonly-policy.mjs`（4 组用例：纯打印 / 脚本执行与写文件 / 选项集合 / 真实 sed 端到端探针）、`test-permission-plan-gate.mjs`（7 组用例：Plan 不比 build 宽、免审批只读仍放行、MCP 改询问且 no-always-allow、guarded + Plan 危险命令直接 deny、Plan 选项策略收窄、判定选项策略真的到达 broker、user-once 应答夹带规则被拒）。
- 验证：`tsc --noEmit -p apps/zcode-cli/packages/core/tsconfig.json` 通过；两个回归脚本合计 11/11 通过。
