---
date: 2026-10-22
title: 上游 ZCode v3.15.1 → v3.16.2 同步影响面分析（apps/zcode-cli 区域）
scope: apps/zcode-cli 全部（packages/core、bootstrap、adapters、cli、contracts、office-runtime、dynamic-workflow、dynamic-workflow-runtime、tui、i18n、telemetry、debug、各 *-plugin、tools/prompt-trajectory、docs/）
upstream_base: aac47556（v3.15.1）
upstream_target: 3c5b2276（v3.16.2）
fork_head: 14032fea（分支 trace-nm-borrow，omz v1.0.17）
---

# apps/zcode-cli 区域：上游 v3.15.1 → v3.16.2 影响面分析

## 0. 总览与前提事实

### 0.1 规模

| 口径 | 文件数 | +/-行 |
| --- | --- | --- |
| `apps/zcode-cli` 全量 | 838 | +44006 / -12459 |
| 其中测试文件（`tests/`、`*.test.ts`） | 424 | +20544 / -9805 |
| 其中生产源码 | 414 | +23462 / -2654 |

上游是两次 `chore: sync ZCode source` 的大合入（`0a1fc56d` + `3c5b2276`），无细粒度提交历史可追，只能按文件聚类。

按子目录分布：

| 子目录 | 文件数 | +/-行 |
| --- | --- | --- |
| `packages/core` | 286 | +14955 / -3581 |
| `packages/office-runtime`（全新包） | 90 | +13258 / -0 |
| `packages/bootstrap` | 190 | +6940 / -3555 |
| `packages/adapters` | 99 | +4245 / -3612 |
| `docs/` | 32 | +1965 / -37 |
| `packages/cli` | 27 | +677 / -268 |
| `tools/prompt-trajectory` | 9 | +680 / -54 |
| `packages/dynamic-workflow` | 25 | +263 / -312 |
| `packages/contracts` | 29 | +300 / -269 |
| `packages/tui` | 13 | +52 / -163 |
| 4 个文档插件（pdf/documents/presentations/spreadsheets） | 12 | +369 / -28 |
| `packages/visualize-plugin` | 3 | +189 / -77 |
| `packages/debug` / `node-repl-host` / `zcode-cua-plugin` / `bundled-skills` / `i18n` / `telemetry` / `browser-use-plugin` / `dynamic-workflow-runtime` | 17 | +130 / -140 |

### 0.2 omz 工作区与上游的基线差（重要前提）

omz 的 fork 基线是 **上游 v3.14.3 快照**（`c34a9386`），不是 v3.15.1。上游 v3.15.1 的 `apps/zcode-cli` 有 5025 个文件，其中 **3582 个在 omz 侧不存在**（2747 个是测试文件，823 个是生产源码）。生产源码缺口集中在：

- `packages/core/src`：71 个（整块 `compact/`、`runtime/methods/compact-*`、`tool/handlers/guarded/`、`tool/handlers/off-peak.ts`、`tool/handlers/reply-to-channel.ts`、`tool/handlers/fill-workflow-hole.ts`、`runtime/methods/turn-execution-fallback.ts`、`runtime/methods/tool-result-settlement.ts`、`subagent/definitions.ts`、`subagent/listing.ts`、`memory/dream.ts` 等）
- `packages/bootstrap/src`：55 个（`zcode-protocol/mcp-ui/**` 整块、`auth-login*`、`provider-endpoint-routing*`、`zcode-protocol-v4/index.ts`、`telemetry-bootstrap.ts`、`official-mcp-auth-port.ts`、`off-peak-tool-policy.ts` 等）
- `packages/adapters/src`：23 个（`auth/bigmodel-oauth.ts`、`model/request-security*`、`model/off-peak-request-auth.ts`、`model/provider-endpoint-routing-*`、`mcp/official-auth.ts`、`plugins/ui-surfaces.ts`、`plugins/mcp-official-auth.ts`、`storage/session-store/repositories/dwf-journal-*.ts` 等）
- `packages/contracts/src`：11 个（`compact/`、`telemetry/`、`interfaces/off-peak.port.ts`、`interfaces/provider-endpoint-routing.port.ts`、`interfaces/topic-resource.port.ts`、`tools/off-peak.ts`、`tools/fill-workflow-hole.ts` 等）
- `packages/cli/src`：4 个（`login-command.ts`、`tui-auth.ts`、`workflow-mode.ts`、`command-center/login-flow.ts`）
- 整包缺失：`documents-plugin`、`pdf-plugin`、`presentations-plugin`、`spreadsheets-plugin`、`visualize-plugin`、`office-runtime`、`superpowers-plugin`、`zcode-cua-plugin`、`zcode-guide-plugin`、`skill-creator-plugin`、`plugin-creator-plugin`、`image-search-plugin`、`ios-simulator-plugin`、`android-emulator-plugin`、`restore-legacy-sessions-plugin`

**这意味着 v3.16.2 里大量"改动"其实是"首次进入 omz 视野"，不是"在 omz 已有基础上演进"。** 判定移植建议时必须按"omz 是否已有对应能力"而不是"上游改了多少行"来裁。

### 0.3 与上游改动的交集（冲突面）

- 上游改动文件 838 个，fork 改动文件 4625 个，**交集 564 个**。
- 其中生产源码交集：169 个文件"上游动过 + omz 也动过"（需人工融合），42 个文件"上游动过 + omz 未动"（可直接重放）。
- 交集最密集的目录：`bootstrap/tests`(114)、`core/tests`(113)、`adapters/tests`(53)、`bootstrap/src`(47)、`core/src/runtime`(44)、`core/src/tool`(29)、`adapters/src`(25)。
- **测试目录形态根本不同**：上游每个包有 `tests/*.test.ts`（vitest），omz 侧 `apps/zcode-cli` 下**没有任何 `tests/` 目录**，测试全部是包内 `scripts/test-*.mjs`（`node --test` / `tsx --test`）风格，共 75 个脚本（core 22、bootstrap 29、magic-context 12、adapters 8、contracts 2、cli 1、dynamic-workflow 1）。omz 仓库**没有 vitest 依赖**（根 package.json 与所有 apps/zcode-cli/packages 均无）。→ 上游 424 个测试文件、+20544 行测试代码**无法直接重放**，需要按 omz 的 `scripts/test-*.mjs` 风格逐条重写。这是所有"上游带大量测试的新特性"移植成本被严重低估的根因。

### 0.4 四条红线在本区域的命中点

| 红线 | 本区域命中情况 |
| --- | --- |
| ① 遥测移除 | 上游 `apps/zcode-cli/packages/telemetry` 只有 1 个文件改动（`tests/error-sanitizer.test.ts` 删了一条断言），生产代码零改动。**红线安全**。但 `bootstrap/src/zcode-protocol-v4/conversation-telemetry-facts.ts` 改了（skillName 脱敏 + pluginId 字段）——这个文件在 omz 侧**不存在**（v3.15.1 就有，omz 在"官方端点全清"里删了），无需处理。 |
| ② magic-context 集成 | 上游**没有**任何 `packages/magic-context` 改动（上游根本没这个包）。但上游改动了 fork 适配层会碰的宿主面：`core/src/runtime/methods/turn-loop.ts`（请求组装入口）、`core/src/runtime/helpers/provider-request-messages.ts`（provider 投影）、`core/src/agent/message-history.ts`（历史条目模型）、`core/src/agent/session-history-hydrator.ts`（冷恢复）、`core/src/runtime/helpers/conversation.ts`（用户消息装配）。omz 的适配层正是挂在这些面上（见 §1.3 与 §5.3）。 |
| ③ 原生压缩移除 | 上游 `core/src/compact/**` 与 `core/src/runtime/methods/compact-*` 共 17 文件、+159/-285。但 **omz 侧 `core/src/compact/` 整目录已不存在**（`afb13118 wip(s26-2b/w1): 压缩移除`），`core/src/runtime/methods/compact-active.ts` / `compact-persistence.ts` / `compact.ts` / `compact-summary-model-request.ts` / `compact-active-helpers.ts` / `helpers/compact.ts` 全部不存在。omz 的等价物是 fork 改名产物 `core/src/runtime/methods/sidecar-model-request.ts`（含 `preserveProviderStreamBoundaries` 与 `compact_stream_boundary`，已确认在位）。**压缩面基本无交集，但有 2 处例外需要盯**（见 §5.1）。 |
| ④ 品牌改名 | 上游 CLI 侧新增字面量密集：`docs/usage/**` 14 篇全用 "ZCode CLI"、路径 `~/.zcode/cli/rollout/`；`packages/cli/scripts/sea-official-plugin-assets.mjs` 用 `marketplace: "zcode-plugins-official"`；`packages/i18n` 的 `--toolsearch-mode` 文案。移植时必须改写为 omz 词汇（`~/.omz`、市场 id `oh-my-zcode-official`）。注意：`@zcode/*` 包名 / `ZCODE_*` 环境变量 / `zcode://` scheme 三族不改名。 |

---

## 1. 主题 A：ToolSearch / DeferredToolCall（工具搜索与延迟工具调用）

**规模**：44 个文件、+8171 / -0（其中新增测试 28 个、约 +5600 行）

**涉及文件（核心）**

- 新增 `packages/core/src/tool/search/`：`exposure.ts`(+220)、`search.ts`(+107)、`history.ts`(+143)、`description.ts`(+30)、`local-projection.ts`(+31)
- 新增 `packages/core/src/tool/deferred-call.ts`(+58)、`packages/core/src/tool/handlers/deferred-tool-call.ts`(+56)、`packages/core/src/tool/handlers/tool-search.ts`(+80)
- 新增 `packages/contracts/src/tools/tool-search.ts`(+76)、`deferred-tool-call.ts`
- 新增 `packages/adapters/src/model/tool-search.ts`、`packages/core/src/agent/tool-search-hydration.ts`(+29)
- 改 `core/src/runtime/helpers/provider-request-messages.ts`(+66/-20，新增 `prepareRuntimeProviderRequest` 与 `loadedToolCallIds` 成功提示注入)、`runtime-provider-request-messages.ts`(+52/-19)、`core/src/runtime/methods/turn-loop.ts`(+59/-8，请求准备统一入口)、`turn-model-step.ts`、`streaming-tool-coordinator.ts`(+48)、`core/src/tool/executor/call-runner.ts`(+94/-7)、`result-content-projection.ts`(+84/-2)、`result-serialization.ts`、`core/src/agent/message-history.ts`(+204)、`session-history-hydrator.ts`(+202/-110)、`core/src/runtime/methods/tool-part-metadata.ts`、`tool-part-persistence.ts`、`core/src/runtime/methods/config.ts`、`core/src/runtime/types.ts`、`contracts/src/model/index.ts`（`tool_reference` 内容块 + `deferLoading` + `toolSearchEnabled`）
- 改 `packages/cli/src/arguments.ts`(`--toolsearch-mode`)、`run.ts`(+51/-2)、`packages/i18n/src/locales/*`
- 新增文档 `packages/../docs/design/v2/tool/19-tool-search.md`(+736)

**变更性质**：新功能（大型）。上游引入 Native / Local 两种工具搜索模式：把大部分工具的 schema 延迟到模型搜索后才注入，Native 走 provider 原生 `tool_reference` 协议，Local 走模型内 `<functions>` 文本展开；未加载的工具通过 `DeferredToolCall {name, input}` 包装调用。

**上游动机**：`apps/zcode-cli/docs/design/v2/tool/19-tool-search.md`（736 行完整 spec，含 2026-09-23 macOS Local CLI/PTY E2E 5/5 与 Desktop E2E 报告路径）。动机是 MCP 工具数量爆炸导致 provider context 被撑爆（`compact-active.ts` 里的"止血原因：massive MCP 工具会把 compact summary request 的 provider context 撑爆"注释是同一问题的另一处体现）。

**omz 现状**

- **完全不存在**。`packages/core/src/tool/search/`、`packages/contracts/src/tools/tool-search.ts`、`packages/adapters/src/model/tool-search.ts` 全部缺失；omz 全仓 `toolSearch` / `ToolSearch` 关键字命中 **0 文件**。
- omz 的 `core/src/tool/types.ts` 的 `ToolMetadata` 没有 `shouldDefer` / `alwaysLoad` / `searchHint`；`contracts/src/interfaces/mcp.port.ts` 没有 `alwaysLoad` / `searchHint`；`ModelMessageContentBlock` 没有 `tool_reference`。
- omz 也没有上游的 MCP 工具规模问题（omz 无官方插件市场 CDN、无内置 4 文档插件包、MCP 面向用户自配），**问题动机在 omz 侧基本不成立**。
- **撞 magic-context 适配层**：会。上游把 provider 请求组装从 `buildRuntimeProviderRequestMessages` 改为 `prepareRuntimeProviderRequest`（先做一次工具暴露决策再投影），而 omz 的 `core/src/runtime/methods/turn-loop.ts` 里 magic-context transform 恰好插在"entries → provider 投影"之间（`runMagicContextTurnTransform` 之后才 `buildRuntimeProviderRequestMessages`）。上游改这个入口会直接动到 magic-context 的插入缝。

**移植建议**：**不建议移植**（如需部分能力，建议只取 §5.6 的 `prepareRuntimeProviderRequest` 重构骨架，但那是重构而非新功能，收益低风险高）。

**工作量**：L（>2天，实际 5–10 天，因为测试要按 omz 的 `scripts/test-*.mjs` 风格重写 28 个用例）

**主要风险**：(1) 触碰 magic-context turn-transform 插入缝 → 上下文清扫行为可能整体漂移；(2) 需要给 omz 全部 ToolMetadata 补 `shouldDefer` 分类，omz 有 `ctx_*` 自研工具（`CTX_REDUCE_NAME` 等）与 `guarded/` 系列，分类归属不清；(3) provider 侧 `tool_reference` 是 Anthropic beta 特性，omz 支持的 provider 矩阵不同。

---

## 2. 主题 B：office-runtime（全新包）+ 内置文档插件查看面板

**规模**：90 个新文件、+13258 / -0；另有 4 个插件包 12 文件、+369 / -28；`packages/cli/scripts/sea-official-plugin-assets.mjs` +51/-12；`packages/bootstrap/src/app/official-plugin-definitions.ts` 同步改版本

**涉及文件**：`packages/office-runtime/**` 全新（`src/adapters/parse/{docx,xlsx,pptx,pdf,ooxml,dommatrix}.ts`、`src/domain/{anchor,cjk,model,text}.ts`、`ui/viewers/{Docx,Pdf,Pptx,Xlsx}View.tsx`、`ui/shell/*`、`ui/panel.css` +1301、`scripts/{build,e2e,smoke,kind-filter,licenses}.mjs`、`fixtures/*`），以及 `packages/{pdf,documents,presentations,spreadsheets}-plugin/skills/*-viewer/SKILL.md`。

**变更性质**：新功能（全新共享运行时包 + 4 个插件各升 0.2.0 带来查看面板）。

**上游动机**：`docs/plugins/2026-10-15-office-viewer-builtin-panels-spec.md`（背景：文档插件查看面板不能从插件仓库单独发布——运行时先加载内置副本、同 ID 市场安装被判重复忽略——必须随内置插件升级；构建产物路径的唯一定义是 `office-runtime/contract.ts` 的 `OFFICE_RUNTIME_OUTPUTS`）。配套 `packages/office-runtime/CONTRACT.md` 声明不变量（插件名取自 `.zcode-plugin/plugin.json`、产物自包含、查看器只读）。

**omz 现状**

- **整包缺失，且不是"能补上"的状态**：omz 侧 `packages/{pdf,documents,presentations,spreadsheets,visualize,office-runtime}` 六个包全部不存在（v3.14.3 基线里就没有；v3.15.1 才引入）。
- omz 的 `bootstrap/src/app/official-plugin-definitions.ts` 里仍保留着 `documents/pdf/presentations/spreadsheets` 四条 definition（版本 0.1.7、`requiredSeedPaths: ["agents/visual-judge.md", "skills/<x>/SKILL.md"]`），但 `rootCandidates` 指向 `packages/<name>-plugin`——**这些目录在 omz 仓库里不存在**，说明 omz 靠市场 CDN 下载，仓内只有 definition 清单。
- omz 已在"官方端点全清"迭代里删除了 marketplace CDN 拉取（`docs/iterations/official-endpoints-removal/spec.md`），marketplace 结构留空壳。
- **这直接撞 omz 的产品边界**：移植 office-runtime 等于重新引入 4 个内置文档插件包 + 一整套 MCP server + 查看面板 UI + SEA 资产校验，而 omz 的产品定位是"独立开源通用 agent，唯一出网点 = 用户自配 provider 端点"。

**移植建议**：**不建议移植**。

**工作量**：L（>2天，实际 >10 天）

**主要风险**：与 omz 的"官方端点全清"决策正面冲突（marketplace CDN、官方插件内置资产）；SEA 打包链要改 4 处必需资产清单；Apache-2.0 / MIT 许可混用需要单独过法务（上游自己为此写了 `dist/THIRD_PARTY_NOTICES.txt` 与 `licenses.mjs`）。

---

## 3. 主题 C：Off-Peak 闲时任务（后台生命周期 + Selection 职责拆分）

**规模**：core 内 12 文件、+1711 / -15；连带 bootstrap / contracts / adapters / runtime-task 约 30 文件

**涉及文件（核心）**：新增 `packages/core/src/runtime/off-peak/{runtime.ts +283, lifecycle.ts +242, model-binding.ts +156, turn.ts}`；改 `core/src/runtime/methods/subagent.ts`(+404/-366，但忽略空白后仅 **+39/-1**，实质是"整段 try 包裹 + 子代理继承闲时选择"的结构重排)、`turn.ts`(+292/-60)、`turn-model.ts`、`prompt-admission.ts`、`core/src/runtime/methods/residency.ts`、`core/src/runtime/methods/title-generation-sidecar.ts`、`core/src/runtime-task/registry.ts`(+42)、`core/src/runtime/types.ts`、`contracts/src/events/session.events.ts`(+36/-1)、`bootstrap/src/app/cli-default-selection.ts`(新)、`bootstrap/src/runtime-subagents/**`（新）、`bootstrap/src/session-execution/**`（新）。

**变更性质**：新功能（大）+ 重构。上游把"闲时任务"从"一次后台执行"升级为"整项任务的生命周期"：票据（ticket）与任务生命周期分离、主轮自然结束后仍由后台回复/完成通知继续驱动主代理、用户消息可接管。

**上游动机**：`docs/off-peak-task/background-lifecycle-plan.md`（含 Selection 职责表 + 状态图 + mermaid 时序）与 `docs/off-peak-task/spec.md`（D51/D52 被取代）。同时 `docs/working-memory/provider-refactor/steps/todo-161-cli-legacy-output-token-migration.md` 等 provider-refactor 系列文档给出了 Selection 单一事实源的拆法。

**omz 现状**

- **Off-Peak 整条线在 omz 不存在**：`docs/iterations/official-endpoints-removal/spec.md` 明确把"闲时任务 server"列入删除清单。omz 全仓 `OffPeak` 命中 0 文件，`offPeak` 仅 1 处（`core/src/tool/handlers/unattended-turn-guard.ts` 的无关提及）。
- omz 也没有 `contracts/src/interfaces/off-peak.port.ts` / `contracts/src/tools/off-peak.ts` / `bootstrap/src/zcode-protocol/offpeak-port.ts` / `adapters/src/model/off-peak-request-auth.ts`。
- 上游 `subagent.ts` 那 +404/-366 里 90% 是缩进重排（`-w` 后只剩 +39/-1），真正的语义改动是"子代理继承闲时选择 + 允许 background: allow"。omz 的 `core/src/runtime/methods/subagent.ts` 已被 fork 大改（fork 侧 ±38/-90），且 omz 的子代理已经有自己的 magic-context 继承逻辑（v1.0.12 修过"Magic Context 对子代理不生效"）。
- `bootstrap/src/runtime-subagents/**` 与 `bootstrap/src/session-execution/**` 是**上游新的"契约模块化"目录**（`CONTRACT.md` + `contract.ts` + `contract.example.ts` + `module.ts`），属于 §7 主题，不是 off-peak 本身。

**移植建议**：**不建议移植**（off-peak 依赖官方端点/服务端票据，omz 已在产品层删除）。

**其中可独立提取的子块**：`bootstrap/src/app/cli-default-selection.ts`（+58）——"CLI 会话默认值"与"Session 续跑选择"分离，是一个纯本地、无外部依赖的小重构，能顺手修掉"CLI 用户消息缺少 modelSelection 时靠 Session 活值兜底"的竞态。可作为 §5.4 的一部分单独评估。

**工作量**：L（>2天）

**主要风险**：若只摘 Selection 拆分而不带 off-peak，会引入"只有拆分没有执行体"的半截状态（上游 `turn.ts` 的 `prepareOffPeakTurn` 与 `executionSelection` 是配套的）。

---

## 4. 主题 D：workflow blocked reminder（主代理空闲但 run 还欠着决定时的提醒钟）

**规模**：4 文件、+1341 / -0（新增 3 个生产文件 + 1 个大测试文件 557 行）

**涉及文件**：新增 `packages/core/src/runtime-task/workflow-blocked-reminder.ts`(+211)、`packages/core/src/runtime/methods/dynamic-workflow-blocked-reminder.ts`(+166)、`packages/core/src/runtime/methods/runtime-reminder-persistence.ts`(+120)、`packages/core/tests/dynamic-workflow-blocked-reminder.test.ts`(+557)、`packages/core/tests/workflow-blocked-reminder-clock.test.ts`(+407)。

**变更性质**：新功能（缺陷修复性质的行为补齐：通知"送到了没有"不可靠，改成"量空闲时长"）。

**上游动机**：`packages/core/src/runtime-task/workflow-blocked-reminder.ts` 文件头引 `docs/dynamic-workflow/transcript-and-notifications.md`「Reminding an idle main agent」：升级问题与留白各发一条通知唤起一轮，那一轮可能白跑（请求失败/应用退出/模型没作答），而停驻分支没有超时——所以不看"通知送到了没有"，只看状态：会话空闲着 + 某个 run 还开着决定 → 到点再提醒一次。每 run 至多 2 次（15 分钟 / 30 分钟），入队即计数。

**omz 现状**

- omz 的 dynamic-workflow 引擎在（`packages/dynamic-workflow`，650 文件，含 graph/causality 引擎），但**没有 blocked reminder**。
- omz 侧 `core/src/runtime-task/` 只有 `registry.ts` 和 `workflow-notification-copy.ts`；上游本轮把 `workflow-notification-copy.ts` 改了 +159/-15（其中 fork 侧已删 63 行）。
- omz 的 `core/src/runtime/methods/` 里**没有** `dynamic-workflow-blocked-reminder.ts`、`runtime-reminder-persistence.ts`；`runtime-reminder-persistence.ts` 是上游本轮**新抽出的公共隐藏提醒落盘函数**（普通收集 + compact 共用），这是**独立可摘的价值点**。
- omz 的 `contracts/src/events/session.events.ts` fork 侧已改 +205 行（有 `workflowNotification` 等），上游新增的 `WorkflowBlockedMeta` 需要在该文件上叠加。

**移植建议**：**需用户拍板**——(a) 只摘 `runtime-reminder-persistence.ts`（公共隐藏提醒落盘，把"普通收集与 compact 共用"抽成一处）：**建议移植**，低风险，触及 `core/src/runtime/methods/` 与 `contracts`；(b) 连同 blocked reminder 整套：**可选**，取决于 omz 是否想解决"升级问题后主代理睡着"的问题。

**工作量**：(a) S（<半天）；(b) M（<2天）

**主要风险**：`runtime-reminder-persistence` 会把隐藏提醒写到 session 持久层，与 omz 的 magic-context 存储层（`storage-*.ts` 大量文件）职责相邻，需确认不重复造"第二份历史"。

---

## 5. 主题 E：核心运行时缺陷修复与小重构（**可移植密度最高的一块**）

下面按子项拆分，都是上游 v3.16.2 里相对独立的缺陷修复。

### 5.1 模型创建失败 / 执行退回（turn-execution-fallback）

**规模**：6 文件、+379 / -9（含 `turn-execution-fallback.ts` 新增、`cli-default-selection.ts` 新增、`prompt-admission.ts`、`turn.ts`、`turn-model.ts`、`contracts/src/events/session.events.ts`）

- `core/src/runtime/methods/turn.ts` +292/-60：普通轮模型创建失败不再"只写日志"，改为保留已接纳输入、走 `appendTurnOutcomeEvent` 落库收尾；新增"创建期退回声明命中但所有候选都无法创建"→ `creationFallbackUnavailable` 归因（Renderer 据此作废匹配卡）。
- `contracts/src/events/session.events.ts`：`TurnExecutionModelFallbackReason` 增 `highspeed_selection_unavailable`；`ErrorAttribution` 增 `highspeedCardId` / `highspeedFallbackUnavailable`；`ToolCallResultPayload` / `ToolCallErrorPayload` 增 `pluginId`（执行时 ToolEntry 的插件归属，不从工具名推断）。
- `core/src/runtime/methods/prompt-admission.ts`：admission 后 `acceptSubmissionModelSelection` 投影（输入被串行接纳后才更新 Session 选择，Loop 开始后不再倒写旧选择）。

**omz 现状**：omz 的 `core/src/runtime/methods/turn.ts` fork 侧已改（+8/-123），`contracts/src/events/session.events.ts` fork 侧 +205 行。**omz 没有 highspeed / selectionFallback / off-peak 这套概念**（`selectionFallback` 在 omz 全仓命中 0），所以 `highspeed_*` 分支在 omz 无对应物。

**建议**：**部分移植**——"模型创建失败也要有终态 + 已接纳输入不能丢"这一条对 omz 独立成立（omz 同样有 `createTurnModel` 失败路径）；`highspeed_*` 相关字段与 `selectionFallback` 整体**不移植**。

**工作量**：M（<2天）

**风险**：`turn.ts` 是 omz magic-context 的下游（transform 在 turn-loop 里，turn.ts 在其上层），改动需确认不破坏已接纳输入的持久化顺序。

### 5.2 消息历史与冷恢复的统一装配（buildUserMessageEntries）

**规模**：8 文件、+444 / -346

- `core/src/agent/message-history.ts` +204/-7：新增 `buildUserMessageEntries`（首发 / 队列消费 / 恢复三处曾分别组装附件，导致正文、PDF、路径引用顺序与文本附件语义漂移 → 统一在消息历史边界组装）；新增 `toModelToolCall` 与 `modelCallWrapper` 字段；新增 `compactBoundary` / `toolSearchAnnouncement` metadata 及其深拷贝。
- `core/src/agent/session-history-hydrator.ts` +202/-110：冷恢复改用同一装配函数；新增 `logger` 参数。
- `core/src/runtime/helpers/conversation.ts` +150/-140：附件分类逻辑从 conversation 层搬到 message-history 层（净删除）。
- `core/src/runtime/methods/tool-part-metadata.ts` / `tool-part-persistence.ts`：工具结果的 `modelContent` 与包装标记落盘。

**omz 现状**：`core/src/agent/message-history.ts` fork 侧 +32/-7、`session-history-hydrator.ts` fork 侧 +8/-81、`core/src/runtime/helpers/conversation.ts` 在 fork 改动面内。上游这组改动**主体是"把散落逻辑收敛到一个边界"**，逻辑本身 omz 大概率已有（omz 的 `core/src/runtime/helpers/attachments.ts` 也在做类似事）。

**建议**：**需用户拍板**——先读 omz 现状是否已解决"三处组装漂移"这个具体 bug。若未解决，值得单独移植（`buildUserMessageEntries` + hydrator 对齐）。

**工作量**：M

**风险**：**直接命中 magic-context 适配层**——omz 的 `bootstrap/src/app/magic-context-turn-transform.ts`（87KB）做 ZCode `RuntimeMessageEntry[]` ↔ magic-context `MessageLike[]` 的双向投影，`rebuildEntry` 依赖 RuntimeMessageEntry 的具体形态。`buildUserMessageEntries` 改了 attachment/user entry 的构造方式，omz 的反投影可能失配（ZCode 用 `kind:"attachment"` + 独立 `role:"tool"` entry，magic-context 把 tool 结果挂在 user part 上）。**必须人工适配，不能逐字重放**。

### 5.3 会话软删除语义修正（time.deleted 取代 time.archived）

**规模**：1 文件、+4/-1（`core/src/runtime/methods/resume.ts`）

上游把"归档已归 Host 组织态，CLI 不再有归档列"的旧判断从 `time.archived !== undefined` 改为 `time.deleted !== undefined`。

**omz 现状**：`resume.ts` 仍用 `time.archived`（确认存在），且 omz 的 `contracts/src/interfaces/session-store.port.ts` fork 侧 +110 行。omz 是否真有软删除列需要核对（`packages/shared/src/sqlite-migrations` 在 omz 侧**不存在**，omz 的 session 表结构在 `packages/shared` 下另一套）。

**建议**：**需用户拍板**（取决于 omz 的 session 表是否还有 `time_archived` 列；若 omz 从未实现归档，这行是无害残留，可不动）。

**工作量**：S

### 5.4 CLI 旧配置首次导入保留输出上限（provider-refactor todo-161）

**规模**：2 文件、+69 / -71

`bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts`：旧 `config.json` 里的模型输出上限（`limit.output` → `options.max_tokens` → 顶层 `maxOutputTokens`）此前在导入时**丢失**（成员投影只保留 `contextWindow`，且创建模型规则会跳过没有 context 的成员）。

**omz 现状**：`legacy-cli-personal-provider-config-importer.ts` 存在（7220 字节），确认**不含 `maxOutputTokens`**——omz 有同一个 bug。上游这是评测团队的刚需修复。

**建议**：**建议移植**（独立、低风险、无外部依赖、omz 侧同样存在该缺陷）。

**工作量**：S（<半天）

**风险**：omz 侧该 importer 可能已因"官方端点全清"改动过形状，需先 diff 再重放；对应的 `bootstrap/tests/legacy-cli-personal-provider-config-importer.test.ts` 在 omz 侧不存在（上游有 232 个 bootstrap 测试文件 omz 都没有），测试要按 omz 风格重写。

### 5.5 Bash 输出临时目录隔离 + 文本编码边界

**规模**：5 文件、+237 / -40（`adapters/src/exec/node-execution-adapter-run.ts` +147/-12、`execution-adapter-lifecycle.ts`、`execution-adapter-types.ts`、`fs/text-metadata.ts`、`fs/text-range-reader.ts`）

上游把 Bash 合并输出文件从"数据根目录"隔离到临时父目录（`mkdtemp`），失败时降级回旧路径——动机是"搜索数据目录会把正在写入的输出再次读回"，Windows 原生搜索会自引用。

**omz 现状**：`node-execution-adapter-run.ts` fork 侧 +73/-6，omz **没有 `bashOutputTempDir` 概念**。omz 的 Bash 输出走 `bash-read-file-state.ts` / `bash-output.ts` 等自研路径。

**建议**：**需用户拍板**——omz 是否有同类"输出文件被搜索索引回读"的问题（omz 的 `core/src/tool/handlers/bash-read-file-state.ts` 存在，说明 omz 也有 Bash 读文件状态机制）。

**工作量**：M

### 5.6 Provider 端点路由的 header 注入（readZCodeJwt）

**规模**：6 文件、+125 / -36

`ProviderEndpointRoutingDecision` 增 `headers`；routing fetch 在改写 URL 后把 decision 的 header 覆盖进请求；bootstrap 侧注入 `readZCodeJwt: () => credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken)`。

**omz 现状**：**上游 v3.15.1 引入的 provider-endpoint-routing 机制在 omz 侧完全不存在**——`packages/adapters/src/model/provider-endpoint-routing-{fetch,options}.ts`、`packages/bootstrap/src/provider-endpoint-routing.ts`、`packages/contracts/src/interfaces/provider-endpoint-routing.port.ts` 全部缺失。omz 已在"官方端点全清"里删掉官方端点注入。

**建议**：**不移植**（前提不存在，且 JWT 属官方账号体系）。

**工作量**：S（无意义）

### 5.7 MCP alwaysLoad / searchHint / waitForAppConnection

**规模**：9 文件、+232 / -197（`adapters/src/mcp/{index,pool,descriptor}.ts`、`adapters/src/plugins/mcp.ts`、`contracts/src/interfaces/mcp.port.ts`、`adapters/src/config/schema.ts`）

MCP server 配置增 `alwaysLoad`（该 server 的工具永远常驻，不进搜索目录）；工具描述增 `searchHint`；`McpPort` 增 `waitForAppConnection`。**主体是 ToolSearch 的配套**（见主题 A）。

**omz 现状**：omz 的 `contracts/src/interfaces/mcp.port.ts` fork 侧 +280 行，`adapters/src/mcp/index.ts` fork 侧 +994 行（重分叉）。

**建议**：**不移植**（配套 ToolSearch；`alwaysLoad` 单独摘出来意义不大）。

### 5.8 其他低价值改动（格式化/断言删除）

- `packages/i18n`（+2/-14）：只加了一行 `--toolsearch-mode` 文案、删了两条测试断言。
- `packages/tui`（+52/-163）：`tui.tsx` 改动 +53/-20，其余全是测试断言删除。**omz 的 TUI 是自研 ink 实现，零交集。**
- `packages/debug`（+38/-28）、`packages/node-repl-host`（+21/-36）、`packages/dynamic-workflow-runtime`（-8）：删测试断言为主。
- `packages/telemetry`（-16）：删一条脱敏断言。**红线 ① 命中，丢弃。**
- `packages/visualize-plugin`（+189/-77）：整个包在 omz 不存在。
- `packages/zcode-cua-plugin`（+5/-31）：包在 omz 不存在。
- `packages/bundled-skills/skills/dynamic-workflows/{SKILL.md,patterns.md}`（+22/-6）：**纯提示词加固**——"绝不擅自把子代理换到另一个 provider 的模型上（那是另一张账单），要换先问用户"。这是有价值的 prompt 纪律加固，omz 有同样的 `dynamic-workflows` skill 文件（fork 侧 SKILL.md 已改 1447 行）。

**建议**：`bundled-skills` 那两条提示词**建议移植**（纯文本，零代码风险，omz 同样面临"跨 provider 换模型"的账单问题）；其余格式化/断言删除类**不移植**。

---

## 6. 主题 F：V4 协议层与投影层改动

**规模**：34 文件、+1358 / -409（`bootstrap/src/zcode-protocol-v4/**` 17 文件 +787/-124、`bootstrap/src/zcode-protocol/**` 15 文件 +391/-178）

**核心改动**

- `v4-gateway.ts` +286/-18：`CommandInbox` 增 `prepareDecision`（历史行 rename/delete 也要先冷恢复）、增 `guard`（runtime 未 ready 时拒绝新执行）、`historyOpenings` 管理、`emitPluginUiToolResult` 宿主钩子、`reconcileSessions` sessions-index 对账、`loadPersistedMessages` / `retainSessionRuntime` 新宿主能力。
- `product-projection.ts` +50/-2（本轮净改动很小，fork 侧却已改 +163/-657）：新增 `StreamingToolLedgerUpdated` 分支 → 断流恢复时用 Core 已闭合的调用补齐 DeferredToolCall 包装行的目标身份；`toolCallScheduled` 写入 `toolName`；"迟到原始流不得覆盖已定稿输入"的守卫（`if (existing?.input !== undefined) return []`）。
- `commands/handlers/canonical-intent-replay.ts` +93/-24、`fork-edit-retry.ts` +46/-19、`queue.ts` +40/-20、`prompt-turn.ts` +90/-8、`commands/input-admission.ts`、`product-projection` 相关。
- `zcode-protocol/server-operations.ts` +166/-78、`v4-bridge.ts` +97/-20、`session-residency.ts`、`transport.ts`。

**变更性质**：新功能 + 缺陷修复混合（历史优先加载、runtime 就绪门禁、插件 UI 结果通知、sessions-index 对账）。

**omz 现状**

- omz 有 `bootstrap/src/zcode-protocol-v4/` 目录，但**内容与上游差距大**：上游 v3.15.1 该目录有 71 个文件，omz 缺 `index.ts`、`local-ttft*.ts`、`mcp-elicitation.ts`、`conversation-telemetry-workflow-facts.ts`、`highspeed-metrics-persistence.ts`、`commands/handlers/{canonical-intent-replay,goal-compact,highspeed-metrics}.ts`、`commands/input-admission.ts`。
- omz 侧的 `product-projection.ts` fork 侧 +163/-657、`v4-gateway.ts` fork 侧 +131/-202 —— **双向高强度分叉**，逐字重放必炸。
- 上游 `bootstrap/src/zcode-protocol/mcp-ui/**`（19 文件）在 omz 整块缺失。
- omz 的 V4 协议面同时承载 magic-context 的投影/反投影与轨迹面板的数据面（`packages/ui` 的轨迹功能依赖 V4 row 投影）。

**建议**：**不整体移植**。若要取单点价值：
- `product-projection` 的"迟到原始流不得覆盖已定稿输入"守卫（`existing?.input !== undefined` 就 return）——**建议单独评估**，它对应 omz 轨迹面板也可能遇到的"工具行 input 被迟到 chunk 改写"问题。
- `v4-gateway` 的 `guard`（runtime 未 ready 拒绝新执行）与 `prepareDecision`——**建议单独评估**，属健壮性修复。

**工作量**：整体 L；单点 S–M

**主要风险**：V4 投影层是 omz 轨迹面板 + magic-context 双下游的数据源，任何 row 语义变化会同时打到两处。

---

## 7. 主题 G：契约模块化（CONTRACT.md + contract.ts + module.ts 目录）

**规模**：42 文件、+776 / -7（含 6 个新模块目录）

**新增模块目录**：
- `packages/core/src/tool/channel-reply/`（4 文件）
- `packages/core/src/tool/workflow-entrypoints/`（4 文件）
- `packages/core/src/runtime/tool-result-settlement/`（4 文件）
- `packages/bootstrap/src/session-execution/`（7 文件）
- `packages/bootstrap/src/runtime-subagents/`（5 文件）
- `packages/cli/src/argument-parsing/`（5 文件）
- `packages/office-runtime/`（含自身 CONTRACT.md + src/CONTRACT.md）

每个目录形如 `CONTRACT.md` + `contract.ts` + `contract.example.ts` + `module.ts`（+ `contract.test.ts`）。同时上游在 `.agents/skills/architecture-governance/SKILL.md` 里加了 `unmanaged-new-file` 规则与 `pnpm architecture:adopt <module-id>` 命令，并明确分层 `contract < domain < app < adapters < ui`。

**变更性质**：架构治理（把既有功能"登记"成受管模块，行为不变）。

**上游动机**：上游 architecture-governance skill 的演进（"Every new source file under packages/ or apps/ must belong to a managed module"）。

**omz 现状**

- omz **有同名 skill**（`.agents/skills/architecture-governance/`），但 omz 的 `architecture-policy.yaml` 里 `apps/zcode-cli` 是 `managed: false`，且 `global.managedOnly: true` —— 也就是说 omz 明确把 CLI 排除在受管模块体系之外。
- omz 全仓只有 **1 个 `CONTRACT.md`**（在 `.agents/skills/architecture-governance/references/golden-module/` 里当示例）。
- omz 的 `architecture-policy.yaml` 全局约束 `maxFileLines: 400`（上游 AGENTS.md 本轮把 CLI 源文件上限从 400 提到 800）——**这是两条不同的规矩**，omz 更严。
- omz 的 `apps/zcode-cli` 全量源码 **1826 个 tracked 文件、只有 2 个 `.test.ts`**、测试全在 `scripts/test-*.mjs`。上游的 `contract.test.ts` 惯例在 omz 无对应载体。

**建议**：**不建议按上游形态移植**（给 CLI 引入受管模块目录会与 omz 的 `managed: false` 决策冲突，且 omz 已有自己的 `architecture-governance` skill + `architecture-policy.yaml`，形态不必跟上游一致）。若要借鉴，只取其**思路**（把跨模块公共面收敛到显式 contract），在 omz 现有的 `packages/*/src` 约定内做，不新建目录形态。

**工作量**：不移植 = 0；部分借鉴 = S

---

## 8. 主题 H：prompt-trajectory 工具（与 omz 轨迹面板主题相关）

**规模**：9 文件、+680 / -54

**改动**：
- 新增 `tools/prompt-trajectory/src/tool-search-comparison.ts`(+108)：离线比较视图——忽略 ToolSearch 造成的引用增删、公告 system-reminder、派生 "Tool loaded." 提示。
- `derive.ts` / `model-io.ts` / `message-continuity.ts` / `types.ts`：新增 `TrajectoryDerivationOptions`（`ignoreToolSearchChanges`），CLI 加 `--ignore-tool-search-changes`。
- `README.md` +36/-6：**新增「Current limitations」段**，明确记录 2026-10-14 验证发现的两个既有失败（`record:prompt` 报 `createModelAdapter requires executionConfig`；`model-io` 拒绝当前默认 CLI 日志因 `request.body.messages` 被裁剪）；并把输入路径从 `~/.zcode/cli/debug/` 改为 `~/.zcode/cli/rollout/`。
- 新增 2 个测试（+427）。

**上游动机**：`apps/zcode-cli/docs/plan/trajectory/model-io-to-anthropic-trajectory-tool.md` 新增「ToolSearch 合成模式」章节。

**omz 现状**

- omz 有 `tools/prompt-trajectory/`（274 文件），`src/` 结构与上游同构（cli/derive/fixture/message-continuity/message-ledger/model-io/openai-provider-proxy/openai-response-assembler/prompt/record/types）。
- omz 侧 `derive.ts` 12758 字节 vs 上游 13026；`message-continuity.ts` omz 1724 vs 上游 3345 —— **omz 的 message-continuity 明显更短**（上游本轮 +1619）。
- omz 侧 `model-io.ts` fork 侧 +6/-4，与上游本轮改动几乎零重叠。
- omz 的 `trace-nm-borrow` 分支正在做**桌面端轨迹面板**（`packages/ui` 侧），而 `tools/prompt-trajectory` 是**CLI 侧离线轨迹合成工具**——两者是上下游但不是同一物。轨迹面板是"看本机这次会话发生了什么"，prompt-trajectory 是"把 model-io 日志转成 Anthropic/OpenAI 请求体做训练数据"。
- omz **没有 ToolSearch**，所以 `tool-search-comparison.ts` 无用武之地。

**建议**：
- `tool-search-comparison.ts` + `ignoreToolSearchChanges`：**不移植**（无 ToolSearch）。
- README 的「Current limitations」段落所记的两个既有失败：**建议核对**——omz 的 prompt-trajectory 是否有同款问题（README 记录的是上游自己的失败，不是 bug 修复）。
- `model-io.ts` 的 `completeAssistantMessage` 从 model-io 移到 message-continuity（纯位置调整）：**不移植**（无功能差异）。
- 轨迹面板相关的**上游动机**（ToolSearch 会让模型请求在"引用增删"处分段，从而打断轨迹连续性）值得记一笔给 omz 轨迹面板设计参考——**若 omz 未来引入工具级分页/裁剪，轨迹分段规则要按"非引用变化"归一**。

**工作量**：不移植 = 0

---

## 9. 主题 I：上游 docs/ 与 README 重写

**规模**：32 文件、+1965 / -37

- 新增 `apps/zcode-cli/docs/usage/` 14 篇（README + 01-quickstart 到 13-automation），面向"从开源仓库构建 CLI 的使用者"，是**面向用户的完整使用指南**（快速开始 / CLI 参考 / 配置 / 工具与评测 / 权限 / 会话 / MCP / Skills / Hooks / 插件 / 记忆 / 排障 / 批量任务与轨迹导出）。
- 改 `apps/zcode-cli/docs/design/v2/` 17 篇（其中 `tool/00-tool-change-chain.md` +210/-2、`tool/19-tool-search.md` 新增 736、`model/provider-endpoint-routing.md` +79/-26）。
- `apps/zcode-cli/README.md` **+16/-317**：整篇重写——删掉"TypeScript + Node.js CLI starter / npm run bootstrap / npm test"这套 npm 单包叙述，换成"ZCode's Agent CLI 是本 pnpm workspace 的一部分"。
- `apps/zcode-cli/AGENTS.md`：源文件行数上限 **400 → 800**。
- `apps/zcode-cli/package.json` +4/-3、`turbo.json` +1、` .gitignore` +3。

**omz 现状**

- **omz 侧 `apps/zcode-cli/docs/` 整目录不存在**（上游 v3.15.1 有 `docs/design/`、`docs/plan/` 等，omz 一个都没导）。omz 的文档体系走根 `docs/`（`docs/iterations/`、`docs/apm/`、`docs/specs/`）+ 根 `README.md`。
- omz 的 `apps/zcode-cli/README.md` 是**自己写的**（"zcode-cli / TypeScript + Node.js 24.14.0 CLI starter / 插件开发 / `~/.omz/cli/plugins`"），已经把品牌改成了 omz。**上游这次 README 重写会大面积覆盖 omz 的品牌化内容**——直接重放会破坏红线 ④。
- omz 的行数上限是 **400**（`architecture-policy.yaml: global.maxFileLines: 400`），与上游新规（800）冲突——omz 更严，且 omz 的 `trace-nm-borrow` 分支刚落地的一批新文件是按 400 写的。

**建议**：
- `docs/usage/**` 14 篇：**不移植**（omz 已有自己的文档体系与品牌）。可作为**写作素材**参考——尤其 `13-automation.md`（批量任务与运行记录、轨迹导出）在概念上与 omz 的 prompt-trajectory / 轨迹面板接近，值得读一眼。
- `docs/design/v2/**`：**不移植**（omz 没有这套 design 文档树）。
- `README.md` 重写：**不移植**（红线 ④，omz 版本已品牌化）。
- `AGENTS.md` 行数 400→800：**不建议**（omz 自己的 `architecture-policy.yaml` 是 400，更严是刻意选择）。
- `.gitignore` 新增 `!packages/dynamic-workflow/tests/lowering/expected/*.js`：**不适用**（omz 无 vitest 测试树）。

**工作量**：0（不移植）

---

## 10. 主题 J：dynamic-workflow 包测试快照与文档

**规模**：12 文件改、13 文件新增（快照）、+263 / -312

- `tests/lowering/expected/*.js` 新增 13 个"人工可审查契约快照"（chained-inline-ask / channel-future / files-read-glob / git-and-grep / glob-fanout / helper-asks / holes / log-only / no-facade / phase-markers / planner-reviewer / report-and-log / user-defined-ask）。
- `tests/facade-dts.test.ts` -111：删掉 createHash 相关的自检。
- `docs/execution-engine.md` +2/-2：通知种类补 `hole-reached`，并新增对空闲提醒钟的描述。

**omz 现状**：omz 有 `packages/dynamic-workflow`（650 文件），但**没有 `tests/` 目录**（上游 v3.15.1 的 1928 个 dynamic-workflow 测试文件 omz 一个都没有）。

**建议**：**不移植**（形态不兼容：上游 vitest 快照 vs omz `scripts/test-*.mjs`；且 omz 的 dynamic-workflow 已 fork 改过）。`docs/execution-engine.md` 那段"空闲提醒钟"描述与主题 D 绑定，一起处理。

**工作量**：0

---

## 11. 主题 K：存储迁移基础设施（shared/sqlite-migrations + schema.baseline.sql）

**规模**：`packages/shared/src/sqlite-migrations/**` 新增 13 文件、+1016 / -6；`apps/zcode-cli/packages/adapters/src/storage/session-store/` 8 文件、+817/-360（含新增 `schema.baseline.sql` +548）

**上游改动**：`migration-runner.ts` 从"同步 generator + AsyncIterator"重写为 async/await 循环，迁移执行下沉到 `@zcode/shared/sqlite-migrations`（新增 `runner.ts` / `legacy.ts` / `backup.ts` / `restore.ts` / `table-snapshot.ts` / `backup-volumes.ts` / `contract.ts`）；新增 `schema.baseline.sql`（把完整 DDL 作为基线快照，用于校验既有库结构）；CLI 新增 `zcode storage-migrate` 子命令（`packages/cli/src/run.ts` +51）。

**omz 现状**

- omz **没有 `packages/shared/src/sqlite-migrations/`**，共享包 exports 少 7 个（`./sqlite-migrations`、`./mcp-apps`、`./gen-ui`、`./request-security`、`./web-remote-relay`、`./test-ids`、`./testing/fake-relay-v2`）。
- omz 的 `adapters/src/storage/session-store/` 与上游同构（同名文件：codecs/errors/json/migration-runner/migrations/migrations.ts/options/paths/repositories/rows/sqlite-session-store），**fork 侧 `migrations.ts` 仅 +1/-1**，`migration-runner.ts` fork 侧未改 —— 属"上游动过 + omz 未动"的可重放区。
- omz 的 session DB 迁移体系是自研的（`packages/shared/src/sqlite-migrations` 缺席说明 omz 另有实现或还没做）。

**建议**：**不建议整体移植**（迁移执行器重构 + 基线 SQL 快照是一整套存储层变更，风险高、与 omz 现有 DB 形态耦合）。若 omz 有"大版本升级后数据库结构核对"的需求，值得**单独读上游 `schema.baseline.sql` 的思路**（把 DDL 快照当契约基线）——这是一个值得借鉴的设计，不是必须移植的代码。

**工作量**：整体 L；借鉴思路 = S

**主要风险**：迁移是数据不可逆面；上游 `migration-runner` 重写同时改了 WAL 重试与 busy_timeout 策略，omz 若有 Windows 多进程并发场景（omz 有 `packages/shared/src/sqlite-helpers.ts`），行为差异需真机验证。

---

## 12. 主题 L：omz 特有上下文——Additional Directories（附加目录）

**规模**：上游散在 6 处、约 +60 行（不是独立包，但构成一条完整链路）

链路：`adapters/src/commands/roots.ts`（+15/-1，`resolveDefaultCustomCommandRoots` 接受 `additionalDirectories`，并给自定义命令加 `namespace: basename(dir)`）→ `adapters/src/commands/index.ts`（+19，命令名拼 namespace）→ `core/src/runtime/types.ts`（`AgentRuntimeConfig.additionalDirectories`）→ `core/src/context/builder.ts`（+7）→ `core/src/context/sections/env-info.ts`（+26，Environment 段新增 "Additional directories" 列表）。

**上游动机**：附加目录此前只进入能力发现，模型看不到目录范围；现在既进 prompt 又进命令根。

**omz 现状**：omz 全仓 `additionalDirectories` 命中 **0 文件**。

**建议**：**需用户拍板**——omz 有没有"多工作区/附加目录"的产品需求（omz 的 workspace 概念在 `packages/services/src/project-workspace-navigation` 一侧，CLI 侧 `core/src/runtime/types.ts` 有 `workingDirectory` 但无附加目录）。若没有需求，不移植。

**工作量**：M

---

## 13. 主题总表

| # | 主题 | 上游规模（文件/±行） | 性质 | omz 现状 | 撞红线 | 波及 magic-context | 建议 | 工作量 | 主要风险 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | ToolSearch / DeferredToolCall | 44 / +8171 / -0 | 新功能（大型） | 完全不存在（0 命中） | 否 | **是**（turn-loop 请求组装入口） | 不建议移植 | L (5–10d) | 动 magic-context transform 插入缝；ToolMetadata 需全量补 shouldDefer；provider beta 特性差异 |
| B | office-runtime + 文档插件面板 | 90 / +13258 / -0（+ 插件 12 文件） | 新功能（全新包） | 整包缺失；omz 官方端点全清已删 CDN 链 | **是**（撞 omz 产品边界） | 否 | 不建议移植 | L (>10d) | 与"唯一出网点=自配端点"决策冲突；许可混用；SEA 资产清单四处同改 |
| C | Off-Peak 闲时任务 + Selection 拆分 | 12 / +1711 / -15（core）+ 约 30 连带 | 新功能 + 重构 | 整条线不存在（官方端点全清已删） | **是**（产品边界） | 轻度（subagent 继承路径） | 不建议移植 | L | 只摘 Selection 拆分会造成"有拆分无执行体"的半截态 |
| D | workflow blocked reminder + reminder 落盘公共化 | 4 / +1341 / -0 | 新功能（补行为缺口） | 不存在；`runtime-reminder-persistence` 可单独摘 | 否 | 轻度（隐藏提醒落盘 vs MC 存储层） | **部分建议移植**（只摘落盘公共化） | S / M | 隐藏提醒持久层与 MC storage 职责相邻 |
| E1 | 模型创建失败 / 执行退回 | 6 / +379 / -9 | 缺陷修复 | 缺 highspeed/selectionFallback 体系 | 否 | 中（turn.ts 落库顺序） | **部分建议移植**（去掉 highspeed 分支） | M | 已接纳输入的持久化顺序；错误归因字段污染 |
| E2 | buildUserMessageEntries 装配统一 | 8 / +444 / -346 | 重构 + 缺陷修复 | 三处组装逻辑仍在；fork 侧有改 | 否 | **是**（MC 投影/反投影依赖 entry 形态） | 需用户拍板 | M | MC 反投影失配（attachment / tool entry 形态） |
| E3 | 会话软删除语义 | 1 / +4 / -1 | 缺陷修复 | 仍用 time.archived | 否 | 否 | 需用户拍板 | S | 表结构是否真有该列 |
| E4 | CLI 旧配置输出上限迁移 | 2 / +69 / -71 | 缺陷修复 | **同款 bug 存在**（无 maxOutputTokens） | 否 | 否 | **建议移植** | S | importer 形状需先 diff；测试需按 omz 风格重写 |
| E5 | Bash 输出临时目录隔离 | 5 / +237 / -40 | 缺陷修复 | 无 bashOutputTempDir 概念 | 否 | 否 | 需用户拍板 | M | omz Bash 读文件状态机制是否同问题 |
| E6 | provider-endpoint-routing header | 6 / +125 / -36 | 新功能 | 前提不存在（整机制无） | **是**（官方端点已清） | 否 | 不移植 | — | — |
| E7 | MCP alwaysLoad / searchHint | 9 / +232 / -197 | ToolSearch 配套 | 字段不存在 | 否 | 否 | 不移植（随 A） | — | — |
| E8 | bundled-skills 跨 provider 换模型提示词 | 2 / +22 / -6 | 提示词加固 | 同类 skill 已存在 | 否 | 否 | **建议移植** | S | 纯文本，零代码风险 |
| E8b | i18n / tui / debug / node-repl / telemetry 等 | ~50 / +240 / -290 | 格式化 + 断言删除 | 零交集 | **是**（telemetry） | 否 | 不移植 | — | — |
| F | V4 协议层与投影层 | 34 / +1358 / -409 | 新功能 + 缺陷修复 | 上游 71 文件中缺 8；两主文件双向重分叉 | 否 | **是**（轨迹面板 + MC 双下游） | 不整体移植；单点评估"迟到流不覆盖已定稿输入"与"runtime guard" | S–M 单点 | row 语义变化同时打到轨迹面板与 MC |
| G | 契约模块化（CONTRACT.md 目录） | 42 / +776 / -7 | 架构治理 | omz 把 CLI 标为 `managed: false`，全仓 1 个 CONTRACT.md | 否 | 否 | 不按上游形态移植；只借鉴思路 | 0 / S | 与 omz 架构治理形态冲突 |
| H | prompt-trajectory ToolSearch 比较模式 | 9 / +680 / -54 | 新功能（配套 A） | 无 ToolSearch；message-continuity 明显更短 | 否 | 否 | 不移植；README「Current limitations」可核对 | 0 | 无 |
| I | 上游 docs/usage 14 篇 + README 重写 + AGENTS 行数 | 32 / +1965 / -37 | 文档 | omz 无 `apps/zcode-cli/docs/`；README 已品牌化 | **是**（品牌） | 否 | 不移植（可作写作素材） | 0 | 重放会破坏 omz 品牌与 400 行上限 |
| J | dynamic-workflow 快照测试 | 12 改 + 13 新 / +263 / -312 | 测试基建 | omz 无 tests/ 目录 | 否 | 否 | 不移植 | 0 | vitest vs `scripts/test-*.mjs` 形态不兼容 |
| K | sqlite-migrations 共享包 + schema.baseline.sql | 13(shared) + 8(adapters) / +1016 / -6 + +817 / -360 | 存储层重构 | shared 包缺失；adapters 侧 migration-runner fork 未动（可重放区） | 否 | 否 | 不整体移植；借鉴"DDL 基线快照"思路 | L / S | 迁移不可逆；WAL/busy_timeout 策略变化 |
| L | Additional Directories 全链路 | 6 / ~+60 | 新功能 | 0 命中 | 否 | 否 | 需用户拍板 | M | 若与 MC 的 workspace 概念重叠会双份目录来源 |

---

## 14. 给同步决策的三条结论

1. **本区域整体移植价值低**。v3.16.2 在 `apps/zcode-cli` 的新增几乎全是**上游专属产品形态**（ToolSearch、office-runtime、off-peak、官方 marketplace/账号体系），而 omz 在"官方端点全清"里已经把同一批产品面删掉了。把 v3.16.2 整体搬过来等于把 omz 重新变成 ZCode。

2. **真正值得移植的是 5 个小而独立的缺陷修复**，且都在 omz 侧同样存在：
   - E4 CLI 旧配置输出上限迁移（omz 同款 bug，评测刚需）
   - E8 bundled-skills 跨 provider 换模型提示词（纯文本，账单纪律）
   - E1 的"模型创建失败要有终态、已接纳输入不能丢"部分（去掉 highspeed 分支）
   - D 的 `runtime-reminder-persistence` 公共化（隐藏提醒落盘单点收敛）
   - E3 会话软删除语义（先核对 omz 表结构是否真有该列）

   合计约 S × 3 + M × 1 ≈ **2–3 天**，且不碰 magic-context 的 transform 插入缝。

3. **移植前必须先解决"测试载体"问题**。上游 424 个测试文件、+20544 行测试代码，在 omz 侧**没有 vitest 依赖、没有 `tests/` 目录**，全部测试是包内 `scripts/test-*.mjs`。任何"带测试一起搬"的方案，工作量估算都要按"逐条重写为 `scripts/test-*.mjs`"计——上游 28 个 ToolSearch 测试文件重写成 omz 风格，实际成本约等于重写一遍特性本身。这一条应当在下一轮 spec 里作为前置决策项单列。

### 附：本报告的核对方法（可复现）

```cmd
git -c core.quotepath=false diff --numstat aac47556..3c5b2276 -- apps/zcode-cli
git -c core.quotepath=false diff --name-status aac47556..3c5b2276 -- apps/zcode-cli
git -c core.quotepath=false ls-tree -r --name-only aac47556 -- apps/zcode-cli
git -c core.quotepath=false ls-tree -r --name-only c34a9386 -- apps/zcode-cli
git -c core.quotepath=false diff --numstat aac47556..HEAD -- apps/zcode-cli
git -c core.quotepath=false show 3c5b2276:<path>            :: 读上游完整文件
node -e "<读 .reference/ZCode 磁盘快照>"
```

shell 为 cmd，无 grep/head/tail/awk；统计与筛选一律用 `node -e` 处理 `execSync` 输出。
