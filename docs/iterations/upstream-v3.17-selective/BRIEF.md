---
date: 2026-11-04
title: 上游 ZCode v3.16.2 → v3.17.2 选择性同步（仅缺陷修复与性能优化）分析基线
upstream_base: 3c5b2276（v3.16.2，2026-10-20）
upstream_target: v3.17.2（a9fe401e，2026-11-03）
fork_head: main @ 36bc100f（omz v1.1.3，2026-11-03）
---

# 分析基线

## 目标

上游发布频率高，fork 不做整版本跟随。本轮**只甄别缺陷修复（bugfix）与性能优化（perf）**，新功能、新产品线、纯重构、纯测试、纯文档一律不进候选。

## 判定标准

一个改动算「缺陷修复」必须能回答：**修复前哪个用户可感知行为是错的？** 证据可以来自：

- 上游 `docs/issues/**`、`docs/plans/**`、`docs/desktop/**` 等工单/设计文档；
- 代码里的注释、错误信息、校验分支、回归测试名；
- diff 本身能读出的「旧行为 vs 新行为」对照。

一个改动算「性能优化」必须能回答：**优化前后的量级/路径差异是什么？** 例如去掉重复扫描、减少一次同步 IO、避免整表重建、去掉 N+1。

以下不算候选：

- 新增能力/新面板/新协议字段/新产品线（即使顺带修了 bug）；
- 为了新功能而做的类型/接口/目录重构；
- 只改测试、文档、锁文件、快照、i18n 文案（文案错译可算 bug，需单独说明）；
- 上游删除测试文件（这是开源导出裁剪，不是缺陷修复）。

## fork 现状（判定「是否已有 / 是否已修」的前提）

fork 四条红线（同步时不得回退）：

1. 遥测/崩溃上报全链已移除（`packages/shared/src/conversation-telemetry`、`packages/ui/src/v4/telemetry` 等不存在）。
2. magic-context 集成（`apps/zcode-cli/packages/magic-context`，`src/core/**` 为移植件，`src/host/**` 为适配层）。
3. ZCode 原生压缩已移除（`core/src/compact`、`compact-*` 不存在；等价物是 `sidecar-model-request.ts`）。
4. 品牌改名（`omz` / `oh-my-zcode` / `~/.omz` / `oh-my-zcode-official`）。

fork 已下线的产品面（遇到依赖它们的改动一律跳过）：

- 官方端点 / 账号 / 自动更新 / 闲时任务 / 会话分享；
- source-server R3 远程架构、web-remote relay v2、data-sync；
- 官方 MCP 鉴权、coding-plan、插件市场官方通道。

注意：fork 树里可能残留「已复制但未接线」的上游包（如 `apps/zcode-cli/packages/office-runtime`、`core/src/tool/search`）。判断能力是否存在要看是否被 import/注册，不要只看文件在不在。

## 交集判定

对每个候选文件执行：

```
git diff --name-only 3c5b2276 main -- <path>
```

非空 = fork 也改过该文件（移植需人工融合）；空 = fork 未动过（可直接重放，但仍需过红线）。

## 输出格式

每个区域一份 `analysis-<area>.md`：

1. 区域规模（文件数/行数，区分源码与测试）；
2. **候选表**：ID / 类型（bugfix|perf）/ 一句话问题 / 上游文件 / fork 是否改过 / 红线 / 成本 S/M/L / 建议（取|适配后取|跳过）；
3. 每个候选一节：旧行为、新行为、证据（文件:行 或工单链接）、移植要点与风险；
4. 「看起来像修复但排除」清单，逐条给排除理由。

用中文写。不要修改产品代码，只写报告文件。
