# CR Fix Spec: bugfix-batch-20261015（MCP 热刷新 + 六项 bug 修复）

## 元信息
- repo: D:\Dev\Js\oh-my-zcode（分支 fix/mcp-hot-refresh）
- base_sha: a8cf076c / head_sha: 分支 HEAD（6 commits: 8f8975b8, cc41a25e, 41147205, df1d9038, fb38080a, 7759f4a2）
- prd_path / spec_path: 未提供（bugfix 批，语义=commit messages + CHANGELOG Unreleased）
- review_round: 1 / dag_version: 2（spec-check round 1 已闭合：B-2 harness 提示/验收措辞/门闩位置、B-1 验收落点、B-4 用例 6 语义、B-5 并入 onMcpSynced）
- 状态: fix-spec-ready（spec-check-loop round 1 Go，P1/P2 精度项已全部 doc-fix 闭合）

## Fix-Spec Closure
| 项 | 状态 |
|---|---|
| fix-spec-ready | yes（spec-check round 1 Go + doc-fix 闭合） |
| fix_spec_path | docs/iterations/bugfix-batch-20261015/cr-fix-spec.md |
| dag_version / review_round | 2 / 1（cr）+ 1（spec-check） |
| P0 / P1 / P2（已写入 fix-spec） | 2 / 2 / 1 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none |
| C-orch | ✅（mcp 链五层无旁路；queue 间隙转交为必要 hop） |
| C 类合并后 QA | 见「合并后 QA」节 |

## 评审结论总览
- review-scope-bugs（五项 bug 修复 + toast + 日志）：**scope-ready yes**，P0=P1=P2=0
- review-scope-mcp（MCP 热刷新全链）：**scope-ready no**，2 P0 + 2 P1 + 1 P2 → 全部落入本 fix-spec

## Must-fix（按 P0 → P1 → P2）

### mcp/B-1 [P0] refreshMcpSessions 遍历无容错
- 维度：B
- 文件：apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp.ts:193-202
- 问题：`await record.app.runtime.refreshMcpServers(servers)` 无 try/catch；某 session runtime 关闭中/mcpPort 已 dispose 时抛错中断整个循环，后续 session 全部不刷新。
- 改法：循环体内 try/catch，catch 中 `context.logger?.warn`（含 sessionId）后 continue（logger 惯用法同 :203 的 info）。
- 验收：新增 bootstrap/scripts/test-mcp-refresh-sessions.mjs（mock context.sessions：第一个 runtime.refreshMcpServers 抛错，断言第二个仍被调用且方法返回成功）；若不建单测则明确标注「仅手测」。
- 来源：review-scope-mcp / round 1；spec-check round 1 补验收落点

### mcp/B-2 [P0] initializeMcp 与 refreshMcpServers 竞态覆盖
- 维度：B
- 文件：apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts:190-255（refresh）与 :122-169（initialize）
- 问题：refresh 不检查 `mcpToolsRegistered` 门闩。session 刚创建、turn-loop 的 initializeMcp 正在 await startup 时，UI 保存触发 refresh 先完成 diff 并置 `mcpToolsRegistered=true`；随后 initializeMcp await 完成用旧 snapshot.tools 注册旧工具并覆盖 `mcpRegisteredToolNames` → 旧工具残留 + diff 基线错误。
- 改法：refreshMcpServers 在 **`effectiveTrace` 赋值之后、`config.mcp.servers` 替换之前** 加 `if (!this.mcpToolsRegistered) { await this.initializeMcp(effectiveTrace); }`（initializeMcp 签名 internal-methods.ts:282 已核实匹配；其自身幂等有门闩、不回调 refresh，无重入）。**同步改测试 harness**：`test-mcp-hot-refresh.mjs` 的 `makeRuntime` 需补 `initializeMcp` 异步 stub（注册旧工具集并置 `mcpToolsRegistered=true`），否则既有 4 用例抛 `this.initializeMcp is not a function`。
- 验收：单测——initializeMcp 慢完成期间 refresh 不抢先 diff（门闩等待）；最终注册工具=新配置且无旧工具、`mcpRegisteredToolNames` 基线正确。
- 来源：review-scope-mcp / round 1；spec-check round 1 修正验收措辞（原「refresh 先返回」与修复后行为相反）+ 补 harness 提示

### mcp/B-3 [P1] services 实现处缺中文 JSDoc
- 维度：F
- 文件：packages/services/src/zcode-agent/zcodeAgentService.ts:3150-3177
- 问题：公开方法 refreshMcpSessions 实现处无方法级中文注释（接口处有）。
- 改法：补 JSDoc——下发全量 mcpServers 到 resident sessions、旧 CLI method-not-found 降级静默、UI 触发语义。
- 验收：注释存在且语义准确。
- 来源：review-scope-mcp / round 1

### mcp/B-4 [P1] 单测缺两个核心场景
- 维度：G
- 文件：apps/zcode-cli/packages/core/scripts/test-mcp-hot-refresh.mjs
- 问题：缺「同名服务器改配置致工具名变化」与「invalidate 幂等性」验证。
- 改法：补用例 5（同名 server 工具名变化，如 get_forecast→get_prediction，用 snapshotsByCall 造）；用例 6 改为「连续两次 refresh 均调用 invalidateToolCache（幂等语义）」——原「busy 会话」语义属 runtime/turn 层，core harness 无此概念（refreshMcpServers 不读 activeTurn，:240 无条件 invalidate，用例 1/2 已断言 invalidateCalls）。
- 验收：4→6 用例全过。
- 来源：review-scope-mcp / round 1；spec-check round 1 修正用例 6 语义

### mcp/B-5 [P2] 导入/远端同步 MCP 配置后不触发热刷新
- 维度：A（行为一致性）
- 文件：packages/ui/src/settings/McpSettingsSection.tsx:1589-1591（onImported）与 :1607-1615（onMcpSynced，同类缺口）
- 问题：`onImported` 与 `onMcpSynced` 均只加载配置不调 `refreshRuntimeMcpTools`，与保存/删除/启停语义不一致。
- 改法：两处均在 `loadMcpFromUserDirectory` 之后加 `void refreshRuntimeMcpTools()`（与 :1293/:1316 保存/删除同款调用）。
- 验收：导入配置、远端同步后已开会话工具面即时更新。
- 来源：review-scope-mcp / round 1；spec-check round 1 并入 onMcpSynced 同类缺口

## Spec deviations
- none（两 scope 均确认 CHANGELOG 与实现一致、五层链完整无旁路）

## Open questions / 待拍板
- OQ-mcp-1：UI catch 静默范围过宽（吞 runtime 不可用/超时等非 method-not-found）是否要 toast？→ 建议：暂不（设置页保存本身有成功反馈，刷新是尽力而为）
- OQ-mcp-2：两个 server 同名工具后者覆盖前者，是否加 warn 日志？→ 建议：加（一行日志成本低）
- OQ-mcp-3：invalidateToolCache 无条件调用（无变化也失效）是否收窄为 diff 后才失效？→ 建议：暂不（invalidate 是幂等廉价操作）
- OQ-mcp-4：initializeMcp 与 refresh 并发调 connectConfiguredServers，mcpPort 是否内部串行化？→ B-2 修复后同入口串行，风险消除，可不复查
- OQ-bugs-1：keyCode 229 兜底在 Firefox/WebView 语义未实测 → manual_user 验收覆盖
- OQ-bugs-2：explore 子代理继承压缩 transform 的上下文长度影响属设计选择 → 暂接受，观察
- OQ-bugs-3：五项 bug 修复无新增单测 → manual_user 验收覆盖（与 mcp/B-4 同性质，bugfix 批以真机验收为主）

## 已豁免（用户确认不修）
- Bug1 分组关闭（用户确认归档行为正常）
- Bug5 分组排序（用户拍板暂不动）

## 合并后 QA（manual_user）
- IME：中文输入法确认候选词 Enter 不发送、Shift+Enter 换行（Chromium；Firefox 可选）
- 引导间隙：上一轮结束、新轮未开始时点「引导」→ 消息立即执行
- intent.text：编辑后重启会话，agent 回复基于编辑后新文本
- toast：CLI 拒绝编辑重发时 UI 弹 warning toast
- magic-context：general-purpose 子代理可见记忆摘要与 ctx_* 工具
- mac icon：Dock 图标无白边框（需 mac 实机）
- MCP 热刷新：设置页新建/禁用/删除/改名/导入 → 已开会话工具面即时变化

## K 节建议（下游执行时闭合）
- 修完 must-fix 后跑：core/bootstrap/services/ui 四包 typecheck + 改动文件 oxlint + test-mcp-hot-refresh 6 用例
- CHANGELOG 在 mcp/B-5 落地后补「导入也热刷新」半句
