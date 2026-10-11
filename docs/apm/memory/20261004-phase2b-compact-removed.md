---
date: 2026-10-04 23:59
title: Phase 2b 压缩移除+UI 面全链完成；magic-context 默认启用（tag phase2b/compact-removed）
keywords: phase2b, compact-removal, D-11 翻 true, sidecar-model-request, MagicContextSettingsSection, T-M9/T-M10/T-M12/T-U1, agent 波次, 残留白名单
abstract: 从 phase2a 记忆恢复后按 spec 连打 S25-S30 六步（S31 Batch2 留待独立排期）：旁路原语去 compact 化更名、原生压缩 ~7400 行全量删除（产生侧/协议侧/TUI/UI/i18n/跨包死链收口）、全量回归后 features.magicContext 翻 true 并打 tag、设置 UI 配置面（T-U1 热生效）与用量面板（D-13）。全程后台派 agent + TaskOutput 阻塞等待的同步纪律执行，S28b 网络闪断一次由 SendMessage 续跑验证了该纪律的韧性。
---

user:
恢复记忆 docs/apm/memory/20261004-phase2a-mvp.md，然后继续按照 spec 开发。使用异步 agent，但是同步获取结果。全程同步处理，方便我查看结果。

assistant:
恢复 2a 记忆（24/35 步、派遣纪律已定型）后从 S25 起每步一个后台 agent + TaskOutput(block=true) 阻塞等、逐步看结果，Phase 2b 六步全部完成：
- S25 `fdbfc3d`：compact-summary-model-request → sidecar-model-request.ts，14 标识符+日志串去 compact 化（`compact_stream_boundary`/`preserveProviderStreamBoundaries` 契约保留）；新单测 6 项证明 boundary 分支真的驱动 commit 判定；historian `true` 传递链 6/6 验证完好。
- S26 `abc5712`：115 文件 +247/−6673、24 整文件删除。执行期细化（已登记偏离）：spec 归 S27 的 TUI/UI 类型耦合消费点必须随 S26 删否则"三套 typecheck 全绿"不可达。8 项偏离：goal-compact.ts 拆分出 goal.ts 保全 sendGoalCommand 族、estimateCurrentModelInputTokens 迁居 turn-model-step-usage.ts、services sessionCompact 连带一级、zcodeTaskTypes 压缩 timeline 类型链等。T-M10 +2 用例。
- S27 `43f8f59`：33 文件 −703 行，TUI timeline 整删/UI 死 prop 链/mention 图标/无消费者 TID；i18n 双语删 33 key（含额外发现的 modelSwitch.contextWindowGuard 5 个）；T-M9 实证（TUI/App 普通文本、CLI Unknown command 全链追到 handler）；T-M12 parity zh-only 0。甄别：compactLogArchive=日志归档保留；formal-proof 压缩相位删；compactBoundary passthrough 删。
- S28 `7cae56c`+`1189755`+`2b3ca7e`：跨包残留收口（steer/hook/usage-source/modelTrajectory 三包+i18n 死链）；全量回归全绿（13 套 213 case、knip 与基线逐字节同、CLI 28.3MB、desktop 6656f/132.9MB、E2E 8 用例、残留 1419 行白名单外 0）；flag 翻 true 真源只有两处（contracts config/index.ts:348 + adapters config/index.ts:297 `?? true`），E2E 双向验证（默认态 §N§ 单调注入+mc 库建成；显式 false 连库不建）；**tag `phase2b/compact-removed`**。
- S29 `e94c895`：设置分区 context + MagicContextSettingsSection（9/11 schema 字段，其余原样带回不抹）+ workspace/read|updateMagicContextConfig RPC 热生效（read 是新增——update 是整域替换，不先读会抹掉用户手写字段）；T-U1 以 packages/ui/dist 真实产物验证 9/9；顺手修"清空 historian 模型静默失效"真 bug。
- S30 `cf1f5df`：snapshot.usage.magicContext additive 字段链（mc.db→bootstrap 摘要→publisher→projection→ChatContextUsage 新段，字段缺席=整段不渲染）+ /ctx-status 分节美化；新测试 14/14。

user:
（过程中的关键事件，供回忆锚点）

assistant:
- **S28b agent 网络闪断一次**：后台派+agentId 在手，SendMessage 续跑同一 agent 成功恢复（纪律韧性再证）。
- **S30 隔离事故**：测试初稿踩中 magic-context 包 `options.db ?? openDefaultDatabase()` 默认开用户真实库的坑，误写一行——已删已复核空库，调用点补 nullish 防护，坑已写入 RULE.md。
- **环境新知（已入 RULE.md）**：apps/zcode-cli 有自己的 oxfmt 且基线红（判据=零新增）；编辑工具写 CRLF 需归一 LF；Windows echo 写 JSON 会坏引号，用 node writeFileSync。
- **待用户决策**：`/ctx-status` 在 off 态也会建 magic-context.db（2a 既有行为）；`time_compacting` 列 TS 层有活读写，彻底清理需 migration。
- **剩余**：S31 Batch2（ctx_note/ctx_search/ctx_memory/nudge/dreamer/embedding 评估，可独立排期）、Phase 3 S32-35 品牌改名（bin omz/~/.omz/marketplace id/发布链路 tag v0.1.0）、build:sea 验证、T-U2 视觉验收。详细状态在 docs/.iteration-state.yaml phase2b 节。
