---
date: 2026-10-19
---

# agent-lang-trace-usage-batch 技术规格（SPEC v2）

## 需求来源

用户口述（2026-10-19，无 prd.md）+ 第一轮反馈修订：

1. **系统提示词语言不匹配**：系统语言=「系统默认」时 Desktop 界面中文，但 agent 系统提示词整体英文。
2. **轨迹查看器重构**（v2 修订）：(a) 展示全部消息噪音大——改为**回合级聚合**：顶层只展示 user↔Assistant 交互回合，点击展开才见具体 wire 消息（类似会话页渲染逻辑）；(b) 系统消息加载不出来（只展示一部分消息）；(c) 关闭「思考过程」开关后轨迹仍显示 reasoning。
3. **上下文占用**（v2 修订）：稳态 20-30% 太保守，无法充分利用长上下文——需要**可调节**，并澄清 65% 语义。

五份探索报告在案（语言链 200 / 轨迹链 175+287 / 占用链 168+104 工具调用）。

## 设计目标

- **A 章**：宿主 UI 语言接入 CLI 冷启动，修复 auto 态分叉。
- **B 章**：轨迹面板 IA 重构——回合聚合（turnId 权威切分）+ head 消息保留（修系统消息丢失）+ reasoning 开关接线 + 回合内空占位过滤与 toolCalls 修复。
- **C 章**：占用澄清与调节指引——历史块预算（已可调）的文案引导 + 诊断字段；**不改默认值、不新增旋钮**（体积触发旋钮暴露已拍板不做，2026-10-19）。

## 总体方案

### A. uiDetectedLocale 接线（env 通道，不改协议、消费端零改动）

（同 v1，不变）根因：`ZCodeAppOptions.uiDetectedLocale` 宿主从未接线（headless/TUI 已接，Desktop→app-server 断着），auto 态回落 `env→Node Intl` 在 GUI 环境解析为 en。

通道：`main currentApplicationLocale` → `HostInitMessage.uiLocale` → host → services `resolveSpawnEnv` 注入 env `ZCODE_UI_LOCALE` → CLI `run.ts` app-server 分支读取 → `RunZCodeProtocolAgentOptions.uiDetectedLocale` → `zcode-protocol-entrypoint.ts` createZCodeApp 闭包 → 既有消费端（`runtime-config.ts:259-263`，优先级：显式 promptLanguage > uiDetectedLocale > env > Intl）。

约束：宿主传具体值（`zh-CN`/`en-US`）；uiLocale 在 InitLocal 时捕获，**下次 Host/窗口创建生效**（同 Host 内新 spawn 仍是旧值）；运行中切换语言由既有 `promptLanguage` 同步链兜底（`useSystemLanguagePromptSync.ts`/`promptLanguageSync.ts`，本 spec 不动）；**范围声明：A 章只覆盖 Desktop 本地 Host 通道，Web server 侧 agent spawn（`packages/zcode-server-cli/src/runtime/agentWiring.ts`）与远端 SSH/WSL 透传不在范围**（远端列 open question）。

### B. 轨迹面板重构（四件事）

#### B-1 回合聚合（IA 重构，核心）

**切分键拍板：`record.turnId`（权威），不用 wire user 消息**。理由：user 角色混有 `<system-reminder>` 注入、mid-turn steer、通知等四类非真实输入，按 user 切会误切回合；而 `turnId` 已由落盘（`runner-debug.ts:149-154`）与服务端映射（`modelTrajectory.ts:144`）暴露，与聊天页 runtime turn 同源，真实数据验证「同一用户轮多 call 共享 turnId」。user 消息启发式（`<system-reminder>`/`<task-notification>`/`<subagent-notification>` 前缀排除，参照 `packages/shared/src/conversation-message-projection-policy.ts:42-46/:242-250` 先例）**只用于两个辅助用途**：回合头部「用户输入」预览提取 + 缺失 turnId 时的 fallback 分组。**回合无真实 user 消息时**（tail 截断/注入开头），预览 fallback 为该回合首条 assistant 文本，仍无则「（无用户输入）」。

已知语义边界（接受）：queue drain 会把同一 runtime turn 在聊天页拆成多产品轮，轨迹按 turnId 合成一轮（少轮但更真实）；sidecar（标题生成）与主轮同 turnId 并入回合。

结构：
- 顶层=回合列表（虚拟化单位从 call 改为 turn）：回合外壳默认**收起**，头部=回合序号 + user 预览 + assistant 预览 + stats（N 次调用 · 时长 · 来源）。
- 展开=该回合的 CallCard 列表（现有 CallCard/MessageBlock 逻辑保留进回合内部）。
- 预览截断复用 `@zcode/shared/zcode-protocol-v4` 子路径导出的 `buildPreviewText`（`packages/shared/src/zcode-protocol-v4/previewText.ts:184`，与聊天页口径一致）；`Collapsible` 原语复用；聊天页的 `ConversationTurnGroup` 深耦合 row 渲染上下文，**不复用代码只借范式**。
- 搜索适配：索引按 turn 展平构造，命中需「先展开回合→再定位消息」，`TrajectorySearchRevealContext` 扩展回合键。
- 展开状态：抽取 `useTrajectoryExpansion(key, defaultOpen)` hook（从 `packages/ui/src/ModelTrajectoryExpandableMessage.tsx:53-104` 的 command/override/searchReveal 计算抽出，**落点 `ModelTrajectoryExpansion.ts` 同文件导出**），message 行与 turn 外壳共用；回合级 key 独立命名空间：**`turn:<turnId>`；无 turnId 的 fallback 分组用 `turn:fallback:<首条 requestId>`**（key 唯一且刷新稳定，T-T3 断言）。若以新增 expansion kind 表达回合级，需同步扩 `TRAJECTORY_EXPANSION_KINDS`（`ModelTrajectoryExpansion.ts:11-18`）、`ModelTrajectoryRoleStyles.ts` 角色样式与 i18n label 三处（见 B8 清单）。
- DOM 契约：保留既有 `data-trajectory-*` 锚点（外部 E2E 可能依赖），新增 `data-trajectory-turn`/`data-trajectory-turn-id`。

#### B-2 head 消息保留（修「系统消息加载不出来」）

根因实锤：写入侧 `MAX_ROLLOUT_BASELINE_MESSAGES=64`（`runner-debug.ts:41`）tail 窗口 + 压缩状态仅进程内（重启即丢）+ magic-context 改写历史前缀致 delta 指纹（首尾+25/50/75% 采样）漂移——**delta 几乎永不成立，offset 之前的内容磁盘上不存在**（真实样本 offset=75，系统段在 0-74）。且主会话「系统消息」多为 user 包裹的 `<system-reminder>`（role:system 计数 0），**按「前 K 条」保留而非按角色**。

方案（契约细化，防重复/防覆盖）：
- 写入侧：tail 组装点对 **canonical `request.messages` 专用键 `messagesHead`** 附加前 K 条（K=12，覆盖 3 条 system 段+首轮 session-history/skills/project-memory 等注入）。**只在 `request.messages` 的组装点挂**，不在通用 `compactMessageCollection`（:723-761）内做——该函数同时服务 `request.messages`/`request.sdkMessages`/`request.body.messages` 三份集合、共用 `target=request`，通用挂载会互相覆盖。`sdkMessages`/`body.messages` **不写 head**（UI 不消费）。`messageCount` 契约不变（仍为全量长度）。
- **head 字节预算 64KB，以整条消息为截断单位**（不砍消息内文本——砍文本恰好破坏 head 保系统段的目的）；**首条豁免**（首条超限时允许突破 64KB）；记录 `headMessageCount`（实际保留条数）与 `messagesHeadTruncated`（是否截断）——**落盘键与读取映射字段同名 `headMessageCount`，全链路统一命名**。
- **读取侧输出缺口元数据（UI 契约）**：`ZCodeModelTrajectoryRecord.request` 新增并映射 `messageCount`/`messageOffset`/`messagesKind`/`headMessageCount`/`croppedCount`。展开时统一计算 **`croppedCount = messageCount − 展开后可见条数`**（tail 与 delta 都算；不用 `offset−K`——delta 展开保留前序窗口时该公式失真，实测偏差可达数百条）。UI「中间已裁剪 N 条」直接显示 `croppedCount`；head 截断导致条数不足 offset 的缺口同样并入 `croppedCount`。**兜底：`messageCount ?? messages.length`**（full-retention 全量直写分支无压缩元数据；旧记录无 `messagesHead`/`headMessageCount` 时跳过 head 合并，防 NaN）。
- 读取合并规则**按 kind 拆开**：**tail 记录** = `[...head.slice(0, min(headMessageCount, offset)), ...tail]`（`offset < headMessageCount` 时 head 截到 offset，防与 tail 窗口头部重复、防污染后续 delta 还原）——**head 合并以 `metadataSource === target`（canonical 集合）为门**：`expandMessageCollection` 也被 `body.messages` 复用（`modelTrajectory.ts:262-273`，collectionKey 同为 `"messages"`），按 collectionKey 判定会把 body 误拼 head；**delta 记录** = 沿用 `previousMessages.slice(0, offset) + deltaMessages`（`modelTrajectory.ts:293-303` 现状，delta 记录无 `messagesHead`，套 head 公式会丢前序上下文）；full = 原样。
- 成本：head≤64KB/条 × 200 ≈ ≤12.8MB/session 上界，常态远低。**旧文件已裁掉的内容不可恢复，仅新记录生效**。

UI 侧 `computeDeltaMessages` 按长度差算增量（长度相等返回 []）的问题在回合化后**依然存在**（真实事故会话 12 条记录全是 tail、合并后长度恒定，长度差恒 0）——把 `resolveTrajectoryInputMessages`/`computeDeltaMessages` **迁入 `ModelTrajectoryTurns.ts` 纯函数区并导出**（Timeline 改导入；Timeline.tsx 依赖 React 与 `@/` 别名，不能直接进零 `@/` 测试载体），重写为 **`messageCount` 差值三分支**：
- `currCount > prevCount`（正常追加）→ `messages.slice(-(currCount − prevCount))`
- `currCount === prevCount`（同上下文重试，真实样本存在连续相等）→ `[]`
- `currCount < prevCount`（回合边界/上下文重置，真实样本 turn 边界 234→182）→ 整段 `messages` 展示并将 `prevCount` 重置为该值
**保留并迁移 `shouldUseConversationDelta` 判据（`ModelTrajectoryTimeline.tsx:176-198` 迁入 `ModelTrajectoryTurns.ts` 导出）——注意现语义：仅 `callSource.kind === "sidecar"`（标题生成等）完整展示 `request.messages`；`subagent` 与 `main` 一样走 delta（子代理会话内部共享历史，本机样本 cnt 可达 193，完整展开是退化）**。断言矩阵 main→delta / subagent→delta / sidecar→full（T-T8/T-T9 锁定）。**full-retention 记录兜底**：`modelIoFullRetentionEnabled=true` 时落盘无 `messageCount`/`messagesKind`（全量直写分支跳过压缩元数据，`runner-debug.ts:487-493`）——`messageCount ?? messages.length`、`croppedCount` 归 0、增量按全量处理。

#### B-3 reasoning 开关接线（修 bug）

根因实锤：轨迹面板从未读取全局 `messageStreamShowReasoning`（`settingsPageHelpers.tsx:693-707` 定义、setting.json 持久化、聊天页 `SessionPane.tsx:868-874` 消费），reasoning 行/part 无条件渲染。面板虽未被自己的 ServiceProvider 包裹（`AnimatedSidePanePanel.tsx:1248-1255`，对比 DeveloperToolsPane :1257-1264 有包裹），但位于 `Root.tsx:97` 的**根级 Provider** 之下，`useSettings()` 可用且与设置页同源实时刷新。

方案：`ModelTrajectoryPane` 读开关，关闭时对 records 做「去 reasoning 投影」（`response.reasoningText` 删除、`request.messages[].parts` 过滤 `kind==="reasoning"`，**只过滤 part 不删 message**，保住按消息数的增量语义）；搜索索引/复制文本随之自然剔除；面板「自定义展开」菜单的 reasoning 项同步禁用。**拍板：关闭=全隐藏**（轨迹是诊断视图，不对齐聊天页「每轮首条保留」语义）。

#### B-4 回合内空占位过滤 + toolCalls 修复（v1 B 章保留项，降级为回合内特性）

- wire 上的空占位行（`[dropped §N§]`/`[dropped]`/`[truncated §N§]`/`[cleared]`/marker-only/全空 parts）在展开的回合内默认隐藏（**开关=Pane 局部 state，默认隐藏、不持久化、不进设置页，唯一所有者为 Pane**），隐藏计数显示「已隐藏 N 条」；system/user 角色**永不隐藏**（`<system-reminder>` 注入是 user 角色，天然被覆盖，无需单独子句）。
- 服务端 `mapMessages`（`modelTrajectory.ts:306-325`）补映射顶层 `message.toolCalls` → `tool-call` parts（修复 554 条空 assistant 行）。

### C. 占用调节与澄清（不改默认值）

**核心事实（对用户问题的直接回答）**：`history_budget_percentage` **已是设置页可调项**（`MagicContextSettingsFields.tsx:172-185`，输入框 data-testid="magic-context-history-budget"；config.json `magicContext.history_budget_percentage`，0.05–0.5）——这是让稳态占用升高的**正确旋钮**：默认 0.15 对应稳态约 30%，调高历史块预算稳态占用随之上升（定性：0.30 约四成、0.50 逼近五成；精确值受 m0 基线/decay 分级/保护尾夹取影响，实测为准）。可选联动 `execute_threshold_percentage`（20-90）抬 usable。**体积触发（tail_size 倍数 3、commit_clusters 3）是硬编码**，是「没到压力线也折叠」的元凶——暴露需 9 处接线，**已拍板不做**（历史块预算够用，2026-10-19）。注：`ABS_CAP=96k`/`MAX_USABLE_RATIO=0.4`（`protected-tail-boundary.ts:205-210`）夹的是保护尾 N，`resolveHistoryBudgetTokens`（`transform.ts:3139-3186`）不受此二夹取。

C 章交付：
1. **文案澄清**（必须）：设置页执行阈值/历史块预算描述 + ContextContent 占用面板说明行——「执行阈值≠压缩起点；体积触发的折叠在低占用也会发生；稳态占用由历史块预算主导」——消除「65% 才压缩」误读，并指路历史块预算旋钮。
2. **诊断字段**：ctx-status 快照加 `lastUsageContextLimit`（最近一次占用读数使用的 context limit——通常为模型原始窗口，即百分比分母；floor 拒绝路径可能写 usableSoft；0 视为未观测映射 null）。**不做 usableSoft/usableHard/触发 reason**——三者均无现成数据源：`usableSoft`（window-geometry 语义，≠原始窗口）需 `last_observed_model_key`+geometry 重解析；`usableHard` 还需当前 execute_threshold，而 ctx-status 调用链（`CtxCommandHost`→`readStatus`→`readMagicContextStatusSnapshot`，`run-ctx-command.ts:116-238`）**无配置句柄**，加透传链超本迭代范围；reason 的 `transform_decisions` 列存在但 durable writer 已移除（`transform-decision-log.ts:12-20`），恢复 writer 超范围。三者列 open question。
3. ~~可选暴露体积旋钮~~ **已拍板不做**（2026-10-19，用户：历史块预算够用）。
4. 65% 语义论证（写入本文档供验收对照）：稳态 u ≈ M + 0.15U + 0.3U(1−u) → 25-32% 与窗口无关，环形指示是真实 API usage（input+output ÷ raw window）非估算——20-30% 是设计稳态非 bug。

## 最终项目结构（新增文件）

```
packages/ui/src/ModelTrajectoryTurns.ts            # B-1 回合分组纯函数（零 @/ 导入）
packages/ui/src/ModelTrajectoryTurnGroup.tsx       # B-1 回合外壳组件
packages/ui/src/ModelTrajectoryWireFilter.ts       # B-4 占位分类器（纯逻辑）
packages/ui/test/modelTrajectoryTurns.test.ts      # node:test（T-T3/T-T4/T-T5/T-T8/T-T9）
packages/ui/test/modelTrajectoryWireFilter.test.ts # node:test（T-T6 半边）
packages/services/test/modelTrajectoryHead.test.ts # tsx --test（T-T2/T-T6 toolCalls 半边；载体=B2 导出纯函数）
apps/zcode-cli/packages/adapters/scripts/test-runner-debug-head.mjs # T-T1（debugDir 注入缝）
apps/zcode-cli/packages/cli/test/runUiLocale.test.ts      # T-L4（run.ts deps 注入捕获）
magic-context/scripts/test-ctx-status-diagnostics.mjs # T-U1
docs/iterations/agent-lang-trace-usage-batch/
```

## 变更点清单

### A 章（9 文件）

A1 `shared/runtimeEnv.ts` 增 `ZCODE_UI_LOCALE` 常量（**只加常量，不入 `SANITIZED_RUNTIME_ENV_KEYS`/passthrough 名单**——`cli/src/env.ts:28-48` 会在 run.ts 读取前删名单内变量）；A2 `shared/validation.ts:147-162` schema 加 `uiLocale`；A3 `desktopHostProcess.ts:59-78` HostInitMessage 加字段；A4 `desktopWindowLifecycle.ts:164-181` 填 `currentApplicationLocale()`；A5 `desktop/host/index.ts:2308-2345` 透传 createLocalServices；A6 `services/node.ts` options+resolveSpawnEnv 注入（**抽出纯函数 `buildUiLocaleSpawnEnv(uiLocale)` 供测试**，resolveSpawnEnv 是 createLocalServices 内部闭包不可直测）；A7 `cli/run.ts:235-286` env 读取→runProtocolAgent（**`string | undefined`，缺失不传键**——传 null 会破坏 `runtime-config.ts:259` 的 `!== undefined` 判定走 env 回落）；A8 `bootstrap/app/types.ts:810-825`+`zcode-protocol-entrypoint.ts:186-224` options+闭包透传。

### B 章（约 12 文件）

| # | 文件 | 改动 |
|---|---|---|
| B1 | `adapters/src/model/runner-debug.ts`（tail 组装点，非通用 `compactMessageCollection` :723-761） | canonical `request.messages` 专用键 `messagesHead`（前 12 条、64KB 预算按整条消息截断+首条豁免、记 `headMessageCount`/`messagesHeadTruncated`）；sdkMessages/body 不写；FORK 注释 |
| B2 | `services/src/zcode-agent/modelTrajectory.ts:130-357` + `packages/services/src/session/zcodeTaskService.ts:104-137`（`ZCodeModelTrajectoryRecord` 类型实际位置） | tail 合并 `[...head.slice(0, min(headMessageCount, offset)), ...tail]`、delta 沿用 previous 展开不套 head、full 原样；**计算并映射 `croppedCount = messageCount − 展开后可见条数`**（`messageCount ?? messages.length` 兜底）；`request` 新增五字段映射；**导出 `expandModelIODeltaRecords`/`expandMessageCollection`/`mapTrajectoryRecord`/`mapTrajectoryMessages` 四个纯函数供测试**（mapRecord/mapMessages 现为私有，T-T2/T-T6 断言无法触达）；`:306-325` mapMessages 补 toolCalls 映射 |
| B3 | `packages/ui/src/ModelTrajectoryTurns.ts`（新） | `resolveTrajectoryTurnGroups`（turnId 分组+fallback）、`isTrajectoryRealUserMessage`、`stripTrajectoryReasoning`、预览（buildPreviewText）、**`shouldUseConversationDelta`/`resolveTrajectoryInputMessages`/`computeDeltaMessages` 自 Timeline 迁入并导出**（纯函数区，Timeline 依赖 React 与 @/ 别名不能直测） |
| B4 | `packages/ui/src/ModelTrajectoryTurnGroup.tsx`（新） | 回合外壳（Collapsible 默认收起、头部 stats、内容=CallCard 列表） |
| B5 | `packages/ui/src/ModelTrajectoryTimeline.tsx` | 虚拟化单位 call→turn；增量逻辑改用 B3 迁入的 `resolveTrajectoryInputMessages`（messageCount 差值三分支；**保留 index>0 过滤 assistant 的现行为 :184-188**）；「中间已裁剪 croppedCount 条」提示行渲染（**文案注明是「该次调用的上下文缺口」，行内 delta 切片不参与计数**）；保留 data 锚点；**连带：Pane 的 re-export（`ModelTrajectoryPane.tsx:335-338` 的 resolveTrajectoryInputMessages 等）改指 Turns.ts 或删除** |
| B6 | `packages/ui/src/ModelTrajectoryPane.tsx` | turn groups 构建；expand/collapse-all 语义改回合级；reasoning 开关接线（useSettings+投影） |
| B7 | `packages/ui/src/ModelTrajectorySearch.ts` + `SearchHighlight.ts` | 索引/定位适配 turnIndex+callIndexInTurn；命中自动展开回合 |
| B8 | `packages/ui/src/ModelTrajectoryExpansion.ts` + `ModelTrajectoryExpansionMenu.tsx` + `ModelTrajectoryRoleStyles.ts` | 回合级展开通道（`turn:` key 前缀；新增 kind 时同步扩 RoleStyles 与 i18n label）；reasoning 项随开关禁用 |
| B9 | `packages/ui/src/ModelTrajectoryExpandableMessage.tsx` + `ModelTrajectoryExpansion.ts` | 抽取 `useTrajectoryExpansion` hook（落点 Expansion.ts 导出）共用 |
| B10 | `packages/ui/src/ModelTrajectoryWireFilter.ts`（新）+ `ModelTrajectoryPaneParts.tsx` | 占位分类器；回合内默认隐藏+计数；**开关归属拍板：Pane 局部 state（默认隐藏、不持久化、不进设置页）**，唯一所有者是 Pane；i18n |
| B11 | `packages/ui/src/i18n/locales/zh-CN.ts` + `en-US.ts` | turn*/隐藏计数/reasoning 禁用文案双写 |
| B12 | 根 `package.json` + 各 package `test:*` 聚合 | 登记全部新测试（ui 两个进 `test:v4-perf`；adapters/services/magic-context 载体进各自聚合或根清单） |

### C 章（5 文件）

| # | 文件 | 改动 |
|---|---|---|
| C1 | `magic-context/src/host/ctx-status.ts` + `bootstrap/ctx-commands/format-ctx-status.ts` | 诊断字段：**仅 `lastUsageContextLimit`**（=session_meta.last_usage_context_limit 持久值；语义=**最近一次占用读数使用的 context limit——通常为模型原始窗口（bootstrap usage recorder 写 contextWindow，`magic-context-turn-transform.ts:562-572`），floor 拒绝路径可能写 usableSoft（`event-resolvers.ts:95-101`）**；列 NOT NULL DEFAULT 0，**0 视为未观测映射 null**）。**不做 usableSoft/usableHard/触发 reason**，均无现成数据源（见 open question） |
| C2 | `packages/ui/src/i18n/locales/zh-CN.ts:2020-2033` + `en-US.ts` + `packages/ui/src/chat-input-toolbar/contextUsage.tsx` | 设置页/占用文案澄清（阈值语义+稳态说明+旋钮指路）；落点=**ContextContent 面板内新增说明行+新 i18n key**（ControlHintTooltip 的 title 现为 null，不可挂） |

**已拍板不做（用户 2026-10-19）**：体积触发旋钮暴露（tail_size_trigger_multiplier / proactive_trigger_offset 的 9 处接线）——历史块预算（已可调）足以调节稳态占用，无需新增手柄。

## 详细实现步骤

- Step 1 — phase-lang-shared — blocking: yes — qa: auto — A1+A2（env 常量+schema）；验收含「schema 解析携带 uiLocale 的 init-local 载荷成功」（A2 漏写会被 hostMessagePortGuard zod strip 静默丢字段）
- Step 2 — phase-lang-desktop — blocking: yes — qa: auto — A3+A4+A5（main 填值→host 透传）
- Step 3 — phase-lang-services — blocking: yes — qa: auto — A6（resolveSpawnEnv 注入+buildUiLocaleSpawnEnv+spawn 断言）
- Step 4 — phase-lang-cli — blocking: yes — qa: manual_user — A7+A8（读取+透传）+ rpc 回归 + T-L4；**手工验收**：系统语言=默认且系统中文 → 新建会话（新窗口/Host）首轮系统提示词为中文（覆盖 main→host→services→CLI 全链，desktop 无测试基建）
- Step 5 — phase-trace-head — blocking: yes — qa: auto — B1+B2（messagesHead 落盘+读取合并+toolCalls 映射；**门槛含 T-T1 与 T-T6 的 services 半边**；合成 fixture 断言：覆盖 offset≥K 与 offset<K 两态；真实样本仅手工复核——rollout 轮转 MAX_ROLLOUT_FILES=3 使真实文件不可依赖）
- Step 6 — phase-trace-turns-core — blocking: yes — qa: auto — B3（Turns 纯函数+单测：分组/fallback+key/预览/reminder 排除/reasoning 投影/shouldUseConversationDelta 迁入+T-T8 矩阵/T-T9 增量）
- Step 7 — phase-trace-turns-ui — blocking: yes — qa: manual_user — B4+B5+B6+B7+B8+B9+B11（回合外壳+虚拟化+搜索+展开 hook+i18n）；真机观感用户验收
- Step 8 — phase-trace-reasoning — blocking: yes — qa: manual_user — B6 的 useSettings 接线+投影+菜单禁用（并入 Step 7 实现时一并交付，独立验收）
- Step 9 — phase-trace-filter — blocking: no — qa: auto — B10+B12（占位过滤+计数——**只含 wire-filter 半边**；测试登记）
- Step 10 — phase-usage-clarity — blocking: no — qa: auto — C1+C2（诊断字段 **lastUsageContextLimit**（仅此一个）+ 文案澄清 + i18n parity）

（原可选 Step 11「体积触发旋钮暴露」已拍板不做，2026-10-19。）

## 测试策略

### 测试用例

- T-L1 — blocking: yes — 冷启动 uiDetectedLocale 优先于 env 探测。载体：bootstrap `test-prompt-language-rpc.mjs` **改用 `resolveAppRuntimeConfig`**（先例 `test-default-model-live.mjs:311`）构造 `options: { uiDetectedLocale: "zh-CN", env: { LANG: "en_US" } }` 断言 `runtimeConfig.language === "zh-CN"`——现有 `resolvePromptLanguage`/`resolveEffectiveLocale` 断言测的是既有行为，无法区分 A7/A8 接线存在与否（假覆盖）
- T-L2 — blocking: yes — services spawn env 注入断言。载体：`packages/services/test/` 新增（tsx --test，非 vitest），断言 A6 抽出的纯函数 `buildUiLocaleSpawnEnv("zh-CN")` 产出子进程 env 含 `ZCODE_UI_LOCALE=zh-CN`（resolveSpawnEnv 为内部闭包不可直测；**buildUiLocaleSpawnEnv 正确≠resolveSpawnEnv 调用了它，调用点由 Step 4 手工验收覆盖**）；**反向断言 `buildUiLocaleSpawnEnv(undefined)` 产出不含 `ZCODE_UI_LOCALE` 键**（防 A7 null/undefined 误传破坏 env 回落）
- T-L3 — blocking: yes — 显式 promptLanguage 优先于 uiDetectedLocale（防接线越权）。载体：同 T-L1（`promptLanguage: "en-US"` 胜出断言）
- T-L4 — blocking: yes — A7 转发断言（T-L1 只锁定消费端优先级，A7/A8 接线须独立证明）：`run()` 以 `deps.env={ZCODE_UI_LOCALE:"zh-CN"}` + mock `deps.runZCodeProtocolAgent` 捕获 `options.uiDetectedLocale === "zh-CN"`；env 缺失时不传该键。载体：**`apps/zcode-cli/packages/cli/test/runUiLocale.test.ts`**（同包先例 `provider-runtime-env.test.ts`，tsx --test 直跑；`run.ts:265-276` deps.runZCodeProtocolAgent 可注入、env :243 就绪）
- T-T1 — blocking: yes — messagesHead 落盘：tail 记录含专用键（前 12 条、**序列化 head ≤64KB 或首条豁免**、`headMessageCount`/`messagesHeadTruncated` 正确）；sdkMessages/body 无 head；messageCount 契约不变。载体：**`apps/zcode-cli/packages/adapters/scripts/test-runner-debug-head.mjs`**（`recordStreamTextDebug` 的 debugDir 注入缝，`runner-debug.ts:174-260`；adapters build 后运行或 tsx 直吃 src）
- T-T2 — blocking: yes — 读取侧合并与缺口：tail = `[...head.slice(0, min(headMessageCount, offset)), ...tail]`、delta 不套 head、full 原样；**合成 fixture 覆盖 offset≥K（`croppedCount = messageCount − 展开后可见条数` 正确、head 截断不足 offset 时缺口并入 croppedCount）与 offset<K（head 截断、无重复、后续 delta 不污染）两态**；`request` 五个新字段（messageCount/messageOffset/messagesKind/headMessageCount/croppedCount）映射就位；**旧记录无 head 跳过合并（防 NaN）；full-retention 记录（无 messageCount）croppedCount=0**。载体：services 单测（B2 导出的 `expandMessageCollection`/`mapTrajectoryRecord` 纯函数；真实 rollout 样本受 MAX_ROLLOUT_FILES=3 轮转不可依赖，仅手工复核）
- T-T3 — blocking: yes — turn 分组：turnId 稳定分组/fallback（无 turnId）/同轮多 call 合并/sidecar 并入/**fallback key `turn:fallback:<首条 requestId>` 唯一且刷新稳定**。载体：`packages/ui/test/modelTrajectoryTurns.test.ts`（node:test，零 @/ 导入）
- T-T4 — blocking: yes — 真实用户预览：system-reminder/task-notification/subagent-notification 前缀排除、`§N§` 前缀剥离、buildPreviewText 截断、无真实 user 时 fallback；**另加实际注入形态 fixture：`<session-history>`/`<project-memory>`/`<new-compartment…>` 包裹消息不取为预览**。载体：同 T-T3
- T-T5 — blocking: yes — reasoning 投影：关闭后 records 无 reasoningText/reasoning part、消息条数不变。载体：同 T-T3
- T-T6 — blocking: yes — 占位分类：marker-only/空 parts → hidden；system/user 强制 visible。载体：`packages/ui/test/modelTrajectoryWireFilter.test.ts`；toolCalls 映射后空 assistant 非空——载体：services 单测（B2 导出的 `mapTrajectoryMessages`）
- T-T7 — blocking: no — 搜索命中回合自动展开+定位（组件级，manual 辅助）
- T-T8 — blocking: yes — delta 判据矩阵（锁定 `shouldUseConversationDelta` 迁入 Turns.ts 后语义）：**main→delta / subagent→delta / sidecar→full**（代码现状只排除 sidecar，`ModelTrajectoryTimeline.tsx:195-198`；subagent 完整展开是退化，本机样本 cnt 可达 193）。载体：同 T-T3（迁移后为纯函数，零 @/ 约束满足）
- T-T9 — blocking: yes — **调用序列增量（全局 prevCount 链，跨回合不重置）**：合成 fixture 覆盖 ① 连续 tail 正向平移——**条数断言打在 `computeDeltaMessages` 导出纯函数（恰为 `currCount − prevCount` 条）；`resolveTrajectoryInputMessages` 另断言增量去 assistant 后 = N−1（现 Timeline :184-188 对 index>0 过滤 assistant，B5 保留该过滤）；首条记录展示磁盘上全部可见消息（head+tail），croppedCount 仍报缺口** ② 同计数重试（增量 `[]`）③ 回合边界计数下降（整段 messages 展示+prevCount 重置，真实样本 234→182）④ full-retention 记录（无 messageCount 时按 messages.length 走全量分支；**croppedCount=0 断言在 T-T2 services 侧**）。载体：同 T-T3（`resolveTrajectoryInputMessages`/`computeDeltaMessages` 已迁入 Turns.ts 纯函数区）
- T-U1 — blocking: no — ctx-status 诊断字段（仅 lastUsageContextLimit；列 NOT NULL DEFAULT 0，**0 视为未观测映射 null**）。载体：magic-context 新增脚本（登记进 test:* 聚合）
- T-U2 — blocking: no — i18n parity 门禁（`scripts/check-i18n-parity.mjs`）

### 门槛

根 typecheck + **`pnpm lint`（AGENTS.md 强制）**；CLI typecheck + bootstrap `test:prompt-language-rpc` 回归（T-L1/T-L3 并入该脚本）；services 新测试以 `tsx --test` 运行（services 无 vitest）；`test:v4-perf`（登记 ui 两测试）；**B12 扩为登记全部新测试**（adapters/services/magic-context 新载体逐个挂进对应 package 的 test:* 聚合或根清单；adapters 测试需 build 后运行或 tsx 直吃 src，先例 `test-magic-context-boundaries.mjs:30-31`）；`scripts/check-i18n-parity.mjs`。desktop 无测试基建，A 章 main→host 段（A3/A4/A5）靠 Step 4 手工验收跨边界覆盖（`hostMessagePortGuard.ts:23-26` 以 zod strip 未知键，A2 漏写会静默丢字段——验收清单必查）；B 章 UI 交互真机验收（qa: manual_user）。

## 风险与回滚方案

- **A 章**：env 通道零 schema 风险；uiLocale 缺席回落现状。回滚=还原 9 文件。
- **B 章（最大风险面）**：回合化是 IA 级重构——虚拟化/搜索/展开状态三处耦合需整体适配；分 Step 交付（Step 5/6 纯逻辑先行、Step 7 UI 收口），每步独立可验；DOM 锚点保留防外部 E2E 断裂；head 保留只影响新落盘记录（旧文件不可恢复，验收注明）。回滚=还原 ui 包文件（Timeline/Pane/Turns/TurnGroup/Expansion/ExpansionMenu/RoleStyles/WireFilter/PaneParts/i18n 两文件）+ runner-debug/modelTrajectory/**session/zcodeTaskService.ts（类型）**+根 package.json 测试登记。
- **C 章**：纯文案+只读诊断，无行为变更（默认值不变；体积旋钮暴露已拍板不做）。
- **共同回滚**：单分支 `agent-lang-trace-usage-batch`，revert 即回滚；发版 v1.0.17。

## Open Questions（不阻塞）

1. 远端 SSH/WSL workspace 的本地 locale 透传（remote/connect.ts envParts）。
2. 64MiB 落盘重置语义（整份轨迹清零为单条 baseline）——是否改为保留旧文件（`.1` 后缀）。
3. 32MiB 读取上限≈120 条早于 limit 200 生效（长会话最早若干调用整条消失）——读取上限是否调大。
4. 回合化后与聊天页轮数的对齐策略（queue drain 产品轮 vs runtime turn）——现拍板按 turnId 合并，如需对齐再议。
5. ctx-status 诊断增强（usableSoft/usableHard/最近触发 reason）——分别需 geometry 重解析、`CtxCommandHost` 配置透传链、恢复 `transform_decisions` durable writer，均超本迭代范围；本迭代只做 lastUsageContextLimit。

（原「体积触发旋钮是否启用」条目已拍板关闭：不做，历史块预算（设置页可调）够用，2026-10-19。）
