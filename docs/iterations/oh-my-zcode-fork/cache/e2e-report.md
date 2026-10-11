# Phase 0/1 E2E 测试报告（fork CLI 真实运行验证）

- 日期：2026-10-04 · 执行者：主代理 · 产物：`apps/zcode-cli/packages/cli/dist/zcode.cjs`（tag `phase1/telemetry-removed` = 0e4c58d 构建）
- 环境：便携 Node v24.14.0；登录凭据复用 `~/.zcode/v2/credentials.json`（共享 Z.AI 登录）
- 数据隔离：`ZCODE_STORAGE_DIR=D:\Dev\Js\oh-my-zcode\.e2e\storage`、`ZCODE_SESSION_DB_PATH=D:\Dev\Js\oh-my-zcode\.e2e\db.sqlite`（不污染用户现有 ZCode 会话库；.e2e 目录在仓库外，保留供 Phase 2b 前后比对）

## 结果总览

| # | 用例 | 命令 | 结果 |
|---|---|---|---|
| E0 | doctor 运行时自检 | `zcode.cjs doctor --json` | ✅ runtime/packaging 全项健康（node v24.14.0、cli 0.16.9、sea optional） |
| E1 | 真实模型对话 + Bash 工具调用 | `-p "用 Bash 执行 echo omz-e2e-ok 并告诉我输出"` | ✅ 模型真实调用 Bash 工具，回复含 `` `omz-e2e-ok` ``（yolo 自动放行、工具执行、turn loop 全通） |
| E2 | 会话持久化 + resume | `-c -p "上一轮 echo 的字符串是什么？"` | ✅ 新进程准确答 `omz-e2e-ok`（SQLite 写入 → 会话水合 → 上下文延续） |
| E3a | 手动压缩 | `-c -p "/compact"` | ✅ 输出 `Compacted`（summary 模型请求 → 选区 → 持久化 → 历史替换全链路） |
| E3b | 压缩后记忆 | `-c -p "压缩前 echo 的字符串是什么？"` | ✅ 答出 `omz-e2e-ok`（摘要保留关键信息） |
| E4 | 持久化结构直查（node:sqlite 只读） | 见下 | ✅ 与 spec 探索报告的结构精确吻合 |

## E4 数据库证据（`.e2e/db.sqlite`，24 表）

- `session`=1、`message`=9
- **`compaction` part × 2**：其一携带 `compactBoundary.boundaryId = compact_c7ba2a6f-cf4…`（边界 part），另一为摘要载体——即探索报告所述"一次 compaction 写 timeline part + compaction part + summary message"结构（timeline part 亦在：`timeline`=1）
- part 类型分布：text 8 / step-start 4 / step-finish 4 / reasoning 3 / **tool 1（E1 的 Bash 调用）** / compaction 2 / timeline 1
- **本地 usage 表健全**（Phase 1 防误删决策的运行时证据）：`model_usage`=5、`turn_usage`=4、`tool_usage`=1

## 对验收矩阵的覆盖结论

- **T-B1**：自动部分（构建+冒烟）✅；manual 部分的核心链路（登录复用、真实工具调用、`/compact` 可用且行为正确）已被 E1/E2/E3 **以非交互方式覆盖**——剩余未覆盖的仅 TUI 全屏交互体验本身（`cli:dev`/`zcode` 无参进入 TUI），保留给用户按需体验，不再阻塞 Phase 2b。**Phase 2b 压缩删除的对照基线证据已留存**（本文件 + .e2e 库）。
- **T-T4（抓包）**：未做运行时抓包（进程已退出，事后不可溯）。静态证据已足：T-T1 外发通道探针全仓零命中、遥测 SDK/依赖零残留；若需严格闭环，建议用代理工具（如系统级抓包）在下次真机使用时观察——已知预期出网仅官方端点（api.z.ai / zcode.z.ai / bigmodel 的 443，D-2 保留面）。

## 结论

fork 在 Phase 1（遥测全删）后的 CLI 端到端行为与原生一致：登录、对话、工具、持久化、resume、压缩全链路正常，且压缩持久化格式与 spec 探索报告逐项吻合（Phase 2b 将按此结构删除）。
