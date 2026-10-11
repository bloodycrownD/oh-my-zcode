# Phase 1 修复执行后 E2E 重跑报告（cli/B-3 验收）

- 日期：2026-10-04 · 产物：W1-W4 修复后重建的 `dist/zcode.cjs`（cli/B-1..B-4 收敛后的 call-runner/runner-stream/compact-active 均在调用链上）
- 隔离库：`D:\Dev\Js\oh-my-zcode\.e2e-fix2\db.sqlite`（不复用原 `.e2e` 基线库，保其作 Phase 2b 对照）
- 四步输出与 cache/e2e-report.md 一致：E1 工具调用 → `` `omz-e2e-ok` ``；E2 resume → `omz-e2e-ok`；E3a → `Compacted`；E3b 压缩后追问 → `omz-e2e-ok`

## 数据库结构比对（cr-func-fix 独立实测）

| 项 | 原 .e2e（0e4c58d 产物） | .e2e-fix2（修复后产物） |
|---|---|---|
| session / message | 1 / 9 | 1 / 9 |
| part 总数 / 类型分布 | 23：text8/step-start4/step-finish4/reasoning3/tool1/timeline1/compaction2 | 同左（逐类一致） |
| 本地 usage 表 | model_usage 5 / turn_usage 4 / tool_usage 1 | 同左 |
| boundaryId | compact_c7ba2a6f-…（随机 UUID） | compact_495b277b-…（随机 UUID，预期不同） |

结论：修复（含 cli/B-3 间接层收敛、cli/B-1 空壳删除、cli/B-2 返回值收窄）对压缩/工具/持久化链路**行为零影响**，与原报告逐项同构（仅随机 UUID 不同）。
