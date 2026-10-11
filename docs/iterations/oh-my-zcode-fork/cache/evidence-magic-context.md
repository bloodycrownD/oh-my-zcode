---
轮次: 1
取证域: Phase 2a magic-context 移植与集成（Step 14-24 / 变更点清单 Phase 2a / D-3,D-4,D-5,D-6,D-11,D-12(配置部分) / 移植范围 / ZCode 侧关键插入点 / 不可破坏契约 / R3,R4,R5,R6,R7 / T-M1..T-M8）
被审文档: D:\Dev\Js\oh-my-zcode\docs\iterations\oh-my-zcode-fork\spec.md
代码库 A（宿主）: D:\Dev\Js\oh-my-zcode\.reference\ZCode
  HEAD: 29628c9acdb81b703bbd4080c207a0e7ce5e276e
代码库 B（移植源）: D:\Dev\Js\oh-my-zcode\.reference\magic-context
  HEAD: 55b70ea82b091b4ffb41cd901552b6b7fe5c1e14
日期: 2026-10-03
性质: 只取证，不下结论，不给 Go/No-Go
---

# 证据包：Phase 2a magic-context 移植与集成

判定口径：**一致** = 断言与源码事实相符（含行号漂移 ≤ 2 行）；**不一致** = 事实与断言有实质差异；**无法核实** = 需运行时/构建/manual 验收才能判定。

行号均以各自仓库 HEAD 为准。

---

## 1. ZCode 侧关键插入点断言

| # | spec 位置 | 断言 | 判定 | 证据 |
|---|---|---|---|---|
| Z-01 | 插入点表 L107 | `turn-loop.ts:168-186` 为 `providerEntries` 赋值处、双投影之前 | **一致** | `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts:168` `const providerEntries = [...state.turnRequestState.entries];`；:169 `const requestEntries = providerEntries;`；:172-176 首次投影；:178-186 第二次投影 |
| Z-02 | L107 / 数据流图 L77 | messages 与 recordedMessages 同源于 requestEntries | **一致** | turn-loop.ts:177 `const { messages } = providerProjection;`；:211 `recordedMessages: recordableProjection.messages`；两次投影入参均为 `entries: requestEntries`（:173、:183），记录侧仅经 `filterOutputTokenContinuationEntries` 过滤（:178） |
| Z-03 | 插入点表 L113（隐含） | `buildRuntimeProviderRequestMessages` 签名与转发逻辑 | **一致** | `core/src/runtime/helpers/runtime-provider-request-messages.ts:9-24`：`(runtime: { readonly config: Pick<AgentRuntimeConfig,"midConversationSystem"> }, input: { entries; applyCacheControl?; model })`，计算 `useMidConversationSystem` 后 `return buildProviderRequestMessages({ ...input, useMidConversationSystem })` 转发。共 5 处调用（project-memory-agent.ts:91、compact.ts:202/376、target-completion-verification.ts:133、turn-loop.ts:172/182） |
| Z-04 | 插入点表 L108 | `system-reminder/source.ts` 三组常量 + DESCRIPTORS 结构 | **一致** | `core/src/system-reminder/source.ts:20` PREFIX / `:22` PERSISTED / `:40` PER_REQUEST 三组 `as const`；`:88-164` `SYSTEM_REMINDER_DESCRIPTORS: Record<SystemReminderSource, DescriptorShape>`，DescriptorShape 字段为 channel/lifecycle/isMeta/providerVisibility/evidenceLabel（:62-71） |
| Z-05 | L108 | 需新增 `NON_MID_CONVERSATION_SYSTEM_SOURCES`，否则 attachment 渲染 throw | **一致** | source.ts:76-86 `NON_MID_CONVERSATION_SYSTEM_SOURCES` 存在；:172-174 `MID_CONVERSATION_SYSTEM_SOURCES` 由其反推；未注册 source 时 `getSystemReminderDescriptor` 返回 `{source}` 缺 providerVisibility，:195-196 `throw new Error("... is not provider-visible")` |
| Z-06 | 插入点表 L109 / Phase 2a L200 | 工具注册四层链：contracts tools barrel → builtInTools → registry → runtime-tools 装配 | **一致** | `contracts/src/tools/index.ts`（barrel，45 个工具契约文件）；`core/src/tool/handlers/index.ts:76` `export const builtInTools: ToolEntry[] = [`；`core/src/tool/registry.ts:30` `ToolRegistryImpl` / `:145` `createToolRegistry`；`core/src/runtime/helpers/runtime-tools.ts:50` `registerBuiltInTools(runtime.registry, {...})` |
| Z-07 | L109 | embedded-search-branch 为第二注册入口 | **一致** | `core/src/runtime/methods/embedded-search-branch.ts` 的 `refreshBranchAwareBuiltInTools`（由 `session-shell-environment.ts:16` 引入）；`core/src/runtime/helpers/tool-allowlist.ts:71` 注释原文："（helpers/runtime-tools.ts 的首次装配、methods/embedded-search-branch.ts 的分支刷新）" |
| Z-08 | L109 | `ctx_reduce` 下划线命名有先例（`submit_result`） | **一致** | `contracts/src/tools/submit-result.ts:11` `SUBMIT_RESULT_TOOL_NAME = "submit_result"`；`packages/shared/src/tool-identity.ts:34-36` 注释："wire 名就是 snake_case 的 submit_result（**仓库里唯一一个**）" |
| Z-09 | L109 / R3 缓解 | ctx 工具"不触碰 messageHistory" | **一致（有条件）** | `core/src/tool/types.ts:131-198` `ToolExecutionContext` 字段全列，**无** `messageHistory`、**无** `runtime` 句柄；但 :170 存在 `sessionStore?: SessionStorePort`（ctx 工具若需读历史须经此端口，非 messageHistory） |
| Z-10 | 插入点表 L110 / Phase 2a L201 | slash 命令 5 处落点文件 | **一致** | `packages/shared/src/zcode-slash-command-help.ts`、`apps/zcode-cli/packages/bootstrap/src/slash-command-surface.ts`、`apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts`、`.../command-center/create.ts`（以上 4 为 spec 明列）；第 5 处 Phase 2a L201 另列 `handlers/ctx.ts`（新建）。另核实 `core/src/tool/handlers/submit-result.ts` 等 handler 目录结构存在 |
| Z-11 | 插入点表 L111 / D-6 | `runCompactSummaryModelRequest` 签名与 `:74` 位置 | **一致** | `core/src/runtime/methods/compact-summary-model-request.ts:74` `export async function runCompactSummaryModelRequest(input: RunCompactSummaryModelRequestInput): Promise<RuntimeModelTextResult>`；`RunCompactSummaryModelRequestInput` = `{ logger?, model, request }`（:59-63）；内部消费完整流后一次性返回（:88-108） |
| Z-12 | L111 | `read-session-context.ts:269` 为旁路 LLM 原语 | **一致** | `core/src/tool/handlers/read-session-context.ts:269` `async function generateLiteExtraction(input: {...}): Promise<string>` |
| Z-13 | D-6 L42 / L187 | "复用 `runCompactSummaryModelRequest` / `generateLiteExtraction` 范式"（并列） | **不一致（细节）** | 二者是**两套不同范式**：`generateLiteExtraction` 并**不**调用 `runCompactSummaryModelRequest`，而是 `runWithModelInvocationContext(...)` + `model.generateText({ messages, tools: [], options })`（read-session-context.ts:314-346）。`runCompactSummaryModelRequest` 全仓唯一调用者是 `runtime/methods/compact-active.ts:412`（即 D-7 要删的压缩路径） |
| Z-14 | 插入点表 L112 | `project-memory-{agent,extraction}` 是 fire-and-forget + drain + abort 模板 | **一致** | `core/src/runtime/helpers/project-memory-extraction.ts:32-81` `scheduleProjectMemoryExtraction(...): void`（void 返回即发即忘）；:83-107 `drainMemoryExtractions`（`Promise.race([scheduler.drain(), timeout])`，超时 60s 常量 :20）；:131/:133/:149/:166 abortSignal 检查与 `isAbortError` 处理 |
| Z-15 | L113 / 契约 7 | `borrowReadOnlyRuntimeEntries()` 零拷贝，跨 await 需浅快照；`replaceMessages` 存在 | **一致** | `core/src/agent/message-history.ts:220-222` `borrowReadOnlyRuntimeEntries() { return this.entries; }`（返回内部数组本体，零拷贝）；接口注释 :110-111 "借用当前权威 entries，只允许同步只读；**跨异步边界时由调用方做数组浅快照**"；:113-114 `toRuntimeEntries()` 才做防御性深拷贝；:117 / :228-234 `replaceMessages` 存在并重置 cacheStats |
| Z-16 | 契约 7 / Z-15 | `MessageHistory` entries 进入后禁止原地修改 | **一致** | 同上 message-history.ts:110-114（借用 vs 拷贝的显式二分）；`core/src/runtime/helpers/project-memory-agent.ts:67-70` 消费者侧注释："Extraction 会跨异步边界消费这份成员浅快照；它依赖 RuntimeMessageEntry 进入 MessageHistory 后**保持不可变**。后续只能 append、整体 replace 或 copy-on-write，禁止原地修改" |
| Z-17 | 插入点表 L114 | 配置 5 文件链：contracts/config/index.ts → adapters/config/schema.ts → adapters/config/index.ts(ConfigStore.merge) → bootstrap/app/runtime-config.ts | **一致** | 4 个文件全部存在；`adapters/src/config/index.ts:117-118` merge 写入、` :284` defaults 组装、`:396-397` ConfigKey 反查 defaults，三处均含 `features.compact` |
| Z-18 | L114 / Step 26 | `features.compact` 无消费点（空开关） | **一致** | 全仓 grep `features.compact` 仅 5 处命中，全在 ConfigKey/默认值/merge（contracts/config/index.ts:33、:106；adapters/config/index.ts:117、:284、:396）。`bootstrap/src/app/runtime-config.ts` 只消费 `features.mcp`(:156)、`features.subagent`(:168)、`features.memory`(:178)，**无 compact** |
| Z-19 | 插入点表 L118 / Phase 2a L204 | `core/src/runtime/deps.ts` 再出口机制 | **一致** | `core/src/runtime/deps.ts:41-60+` 为大段 `export { ... } from "@zcode/contracts"` 再出口块；core 内部一律 `from "../deps.js"` 引用（如 turn-loop.ts:2-8） |
| Z-20 | Phase 2a L192 | ZCode 事件出口：`SessionEventType` 经 `appendEvent`/`notifyEventSinks` | **一致** | `core/src/runtime/methods/events.ts:109` `await this.notifyEventSinks(storedEvent, traceContext)`；:528 `export async function notifyEventSinks(`；`core/src/runtime/methods/index.ts:369` `proto.notifyEventSinks = notifyEventSinks;`；接口声明 `core/src/runtime/internal-turn-methods.ts:321` |
| Z-21 | Phase 2a L199 | `buildContextManagementSection` 可增补 ctx 工具指引（`guidanceToolNames` 机制现成） | **不一致（细节）** | `core/src/context/dynamic-sections.ts:102` `export function buildContextManagementSection(): ContextSection {` —— **零参**，正文取自模块常量 `CONTEXT_MANAGEMENT_PROMPTS`，函数内无工具名注入位。`guidanceToolNames` 是**另一套机制**：`core/src/context/types.ts:127` `guidanceToolNames?: readonly string[]`，消费点在 `core/src/context/builder.ts:144` 与 `:226`。二者不在同一路径上 |
| Z-22 | Phase 2a L200 / Step 21 | `tool-allowlist.ts`（workflow child 禁用 ctx 工具）落点存在 | **一致** | `core/src/runtime/helpers/tool-allowlist.ts` 存在，导出 `resolveBuiltInToolAllowlist` / `resolveRuntimeDisallowedTools` / `resolveRuntimeDynamicWorkflowToolsIncluded`（由 runtime-tools.ts:17-21 引入，:81/:85 使用） |

---

## 2. magic-context 侧断言

| # | spec 位置 | 断言 | 判定 | 证据 |
|---|---|---|---|---|
| M-01 | L95 / R4 | `shared/sqlite.ts` 变量间接动态 import 手法（防 esbuild 改写 `node:sqlite`） | **一致** | `packages/plugin/src/shared/sqlite.ts:121` `const bunSpec = "bun:" + "sqlite";`、`:122` `const nodeSpec = "node:" + "sqlite";`；:124-130 `importSqliteModule(specifier)` 内 `await import(/* @vite-ignore ... */ specifier)`；:176 `const specifier = runtime === "Bun" ? bunSpec : nodeSpec;`；:107-120 注释完整说明该手法的由来与替代方案 |
| M-02 | L95 | `shared/sqlite.ts` **914 行** | **不一致（行号漂移）** | 实际 **913 行**（`packages/plugin/src/shared/sqlite.ts`）。差 1 行，无实质影响 |
| M-03 | L95 / R4 | node:sqlite 适配：`transaction` / `readOnly` / bind | **一致** | transaction：sqlite.ts:286 `Object.defineProperty(db, "transaction", {...})`（savepoint-aware shim），:237-250 说明原生 Bun transaction 绕过 exec override 的补丁；readOnly：:381-390 `{ readonly }` → `{ readOnly }` 翻译；bind：文件头 :34-37 与 :319-325 的 `prepare()` override 归一化 `.run([a,b])` 位置绑定（node:sqlite 会当具名参数报 `Unknown named parameter '0'`，issue #151） |
| M-04 | L185 / Phase 2a L185 | `RawMessageProvider` 接口在 `read-session-chunk.ts:128` | **一致（精确行号）** | `packages/plugin/src/hooks/magic-context/read-session-chunk.ts:128` `export interface RawMessageProvider {` |
| M-05 | L185 | "实现 `RawMessageProvider`（**12 方法**子集）" | **一致（措辞可再精确）** | 同接口共 **13** 个成员：`readMessages`(必填, :129)、`readMessagePage`、`iterateMessageRange`、`readMessageById`、`readMessagePartsById`、`hasMessageById`、`readMessageOrdinalById`、`readMessageIdOrdinals`、`readMessageIdOrdinalsForRange`、`readMessageOrdinalPage`、`getMessageCount`、`getStoredMessageCount`、`readServedBoundaryId`（:130-157）。即 1 必需 + **12 可选** —— spec 的"12 方法子集"与可选数吻合，但若按"必填+可选=12"理解则少 1 |
| M-06 | L187 / D-6 | `HiddenCompletionExecutor{capabilities,open,attempt,collect,close}` 形状 | **一致** | `packages/plugin/src/hooks/magic-context/compartment-runner-types.ts:116-131`：`readonly capabilities: { tools: boolean; harness: HarnessId }`(:117)、`open(run: HiddenRunIdentity): Promise<HiddenRunHandle>`(:118)、`attempt(handle, request: PromptArgs): Promise<void>`(:119)、`collect(handle, limit: number): Promise<HiddenCompletion>`(:121)、`close(handle|null, settlement): Promise<void>`(:122-130) |
| M-07 | L96 | transform 管线行数：`transform.ts` 3287 / `transform-postprocess-phase.ts` 3955 / `inject-compartments.ts` 4205 / `tag-messages.ts` 1122 | **一致（4/4 精确）** | 实测行数：transform.ts=3287、transform-postprocess-phase.ts=3955、inject-compartments.ts=4205、tag-messages.ts=1122。**逐个数字完全吻合** |
| M-08 | L96（隐含路径） | B 组文件位于 `packages/plugin/src/` 下 | **一致（但 spec 路径描述易误导）** | 4 个文件实际全在 `packages/plugin/src/**hooks/magic-context/**/`，**不在** `features/magic-context/`（spec L93 只说"文件均在 packages/plugin/src/"未细分，尚属成立；但 C/D 组却写成 `features/magic-context/{...}`，读者会误以为 B 组同级） |
| M-09 | L96 / 契约 2 | `buildReplacementContent` 纯函数性 | **一致** | `packages/plugin/src/hooks/magic-context/apply-operations.ts:63-65` `export function buildReplacementContent(tagId: number): string { return \`[dropped §${tagId}§]\`; }`；:52-62 注释显式论证"是 tagId 的**纯函数**……不读任何 message 内容 / role / 窗口状态"，并记录历史上由此引发的 prompt-cache 灾难 |
| M-10 | 契约 2 | `drop_mode` 落库、逐 pass 重放、skeleton 永不降级 | **一致** | apply-operations.ts:41-48 "CACHE SAFETY: the mode is decided once, at drop time (always a cache-busting pass), **persisted in `tags.drop_mode`**, and replayed byte-identically by `applyFlushedStatuses` on every later pass. A skeleton is **NEVER demoted** to a full drop afterwards"；:220-226 `SELECT ... drop_mode AS dropMode ... WHERE drop_mode IN ('truncated','full')`；:518-534 五种 drop_mode 分派；:66-70 `NewToolDropOutcome.mode: "skeleton_real"\|"skeleton_stripped"\|"full"` |
| M-11 | 契约 3 | m[0]/m[1] part 必须 `synthetic:true`，`syntheticHead` 标记槽位，绝不能 `ignored` | **一致** | `packages/plugin/src/hooks/magic-context/inject-compartments.ts:3319-3335`：`messages.unshift({ info: { role:"user", sessionID, syntheticHead: true }, parts: [{ type:"text", text: m0Text…, synthetic: true }, …] }, { info: { …, syntheticHead: true }, parts: [{ …, synthetic: true }] })`；:3303-3314 注释明写"**Must NOT use `ignored` here — that would strip the history injection from the real model call**"，并解释这是 OpenCode 特有的 title-generation gate 行为（issue #129） |
| M-12 | 契约 1 | `cached_m0_bytes` 落库 | **一致** | `packages/plugin/src/features/magic-context/migrations.ts:968`、`:1207` `ensureColumn(db, "session_meta", "cached_m0_bytes", "BLOB")`；:1556 列入 NULL 重置清单 |
| M-13 | 契约 1 | **19 个** `cached_m0_*` 列 | **不一致（计数）** | 实测 distinct 列名 **18 个**：`cached_m0_bytes` / `_last_baseline_end_message_id` / `_materialized_at` / `_max_compartment_seq` / `_max_memory_id` / `_max_memory_mutation_id` / `_max_mutation_id` / `_model_key` / `_mural_data_url` / `_mural_hash` / `_project_docs_hash` / `_project_memory_epoch` / `_project_user_profile_version` / `_session_facts_version` / `_system_hash` / `_tool_set_hash` / `_upgrade_state` / `_workspace_fingerprint`。少 1 |
| M-14 | 契约 1 | `M0SnapshotMarkers` **16 个** durable marker | **不一致（计数漂移）** | `packages/plugin/src/hooks/magic-context/inject-compartments.ts:848-877` 接口实际 **21 个成员**：projectMemoryEpoch / workspaceFingerprint / projectUserProfileVersion / maxCompartmentSeq / maxMemoryId / maxMutationId / maxMemoryMutationId / projectDocsHash / materializedAt / sessionFactsVersion / upgradeState / compartmentRenderEpoch / memoryRenderEpoch / systemHash / toolSetHash / modelKey / projectIdentity? / muralHash? / muralEnabled / renderBudgetIdentity / renderedBudgets?。:863-869 注明 systemHash/toolSetHash/modelKey 属运行时信号非 durable → durable 约 **18**。"16"系较早快照的旧数字 |
| M-15 | 契约 5 / Step 15 | migrations 数量 **94** | **一致** | `packages/plugin/src/features/magic-context/migrations.ts` 中 `version: N,` 条目实测 **94 条，max = 94**；:3205 `];` 收尾，:3213-3216 `LATEST_MIGRATION_VERSION = MIGRATIONS.reduce(...)` |
| M-16 | 契约 5 / T-M7 | `LATEST_SUPPORTED_VERSION` 与 `LATEST_MIGRATION_VERSION` 同步 | **一致（且有自证机制）** | `packages/plugin/src/features/magic-context/storage-db.ts:158` `export const LATEST_SUPPORTED_VERSION = 94;`（等于 :3213 的 reduce 结果）；`migrations.ts:3207-3211` 注释："`LATEST_SUPPORTED_VERSION` in storage-db.ts (the schema-fence ceiling) **MUST equal** this … **A unit test asserts the two stay in lockstep**" |
| M-17 | 契约 5 / R-7 相关 | schema fence：DB 版本比 build 新 → 拒绝 transform | **一致** | `storage-db.ts:101` `lastSchemaFenceRejection`；:419-424 落库并抛出："refusing to open {dbPath}; upstream migration lane v{persistedVersion} is newer than this binary supports (max v{supportedVersion})"；:2625 注释列 **Schema fence** 为 storage fatal 分类之一 |
| M-18 | L100（明确不搬） | `historian-host-runner.ts` 仅 Rust 路线（仅被 rust-mode-transform 引用） | **一致** | 全 `packages/**/src/**` 非测试引用仅 1 处：`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:85` `import { createHistorianHostRunner } from "./historian-host-runner";`。文件本体 877 行 |
| M-19 | L99 / E 组 | `config/schema/magic-context.ts` 字段集（enabled / execute_threshold_percentage 65 / protected_tokens / history_budget_percentage 0.15 / cache_ttl / historian / smart_drops / fail_closed_blocking / language / compaction.*） | **一致（默认值全对）** | `packages/plugin/src/config/schema/magic-context.ts`：`:12 DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65`；`:19 DEFAULT_HISTORY_BUDGET_PERCENTAGE = 0.15`；`:24 PROTECTED_TOKENS_MIN = 4000`；`:18 DEFAULT_HISTORIAN_TIMEOUT_MS = 600_000`；字段定义 `enabled`(:1087, default true)、`execute_threshold_percentage`(:1204, .default(65))、`execute_threshold_tokens`(:1215)、`protected_tokens`(:1224, .min(PROTECTED_TOKENS_MIN))、`history_budget_percentage`(:1245, .default(0.15))、`cache_ttl`(:1170)、`historian`(:665 HistorianConfigSchema)、`smart_drops`(:1424)、`fail_closed_blocking`(:1383)、`language`(:1122, `isValidLanguageCode` refine)、`compaction.*`(:1389-1400) |
| M-20 | L99 / E 组 | **只移植** `config/schema/magic-context.ts` + `live-run-config.ts` + `live-snapshot.ts`，**不移植** jsonc 体系 | **不一致（隐藏依赖）** | 见下"可疑点 Q-1 / Q-2"。三文件均存在，但均无法脱离 jsonc 装载器独立编译 |
| M-21 | L99 / E 组 | "不搬 jsonc 体系（`jsonc-parser/jsonc-edit/raw-loader`）"不会断链 | **部分不一致** | transform/storage 链**确实不依赖** `config/index.ts`：对 `transform.ts` / `inject-compartments.ts` / `transform-postprocess-phase.ts` / `storage.ts` / `storage-db.ts` / `storage-ops.ts` / `storage-tags.ts` grep `config/index\|from "../config"\|from "../../config"` **零命中** —— 任务提出的具体担忧在此为"否"。但断链点出现在 spec 计划"移植"的两个 live 文件上（Q-1），以及 schema 文件的 5 条传递 import（Q-2，其中 2 条落在 spec 明令不搬的 `dreamer/**` 下） |
| M-22 | L99 / Step 16 | `live-run-config.ts` / `live-snapshot.ts` 存在性与职责 | **一致（存在与职责）** | `packages/plugin/src/config/live-run-config.ts`、`live-snapshot.ts` 均存在；后者以 `node:crypto` createHash + `node:fs` readFileSync/statSync 实现内容哈希快照，前者经 `LiveConfigReader` 读取。职责断言（热更新机制）成立 |
| M-23 | L39 / D-3 | Rust 侧 **9 个** 仓库外 path-dep | **一致** | `Cargo.toml:15-18`（cortexkit-cache-core / -store / -store-types / -lease，指向 `../commons/crates/`）+ `:22-26`（subc-protocol / -control / -transport / -client-rs / -core，指向 `../subconscious/crates/`）= **恰好 9 个** `[workspace.dependencies]` 仓库外 path-dep。补充：`crates/mc-module/Cargo.toml:26`（`cortexkit-log`）、`:32`（`subc-os`）另指向仓库外，`Cargo.toml:44` `[patch.crates-io] subc-protocol` 亦然 —— 共 12 处仓库外引用，`9` 只是 workspace 层计数 |

---

## 3. 不可破坏契约 7 条

| # | 契约 | 判定 | 证据 |
|---|---|---|---|
| K-1 | 1. m[0]/m[1] 逐字节可重放（`cached_m0_bytes` + `cached_m0_*` 列 + M0SnapshotMarkers；非 cache-busting pass 必须命中缓存字节） | **不一致（计数部分）** | 机制成立：`cached_m0_bytes` 见 M-12；M0SnapshotMarkers 定义见 M-14。但两处计数均与 HEAD 不符（列 18≠19、marker 21/18≠16）。缓存命中判定逻辑见 `inject-compartments.ts:1551-1690`（`readCurrentM0SnapshotMarkersUncached` / `snapshotMarkersFromCachedM0` / `markersFromCachedRow`），非 cache-busting 命中缓存的分支存在 |
| K-2 | 2. drop 占位符是 tagId 的纯函数；drop_mode 落库、逐 pass 重放、skeleton 永不降级 | **一致** | M-09 + M-10 全部命中 |
| K-3 | 3. m[0]/m[1] part 必须 `synthetic:true` 绝不能 `ignored`；`syntheticHead` 标记槽位 | **一致** | M-11 |
| K-4 | 4. 失败分级不可压平（fail-closed / LKG / fail-open 三档；应急带下拒绝 LKG replay） | **一致** | `packages/plugin/src/plugin/messages-transform.ts:218-257` 分级表原文：① `FailClosedBlockingError`/`EmergencyFailClosedError`/`RawFallbackContextLimitError`/`AssistantTerminalRetryError` → 重抛；② `SQLITE_BUSY`/`SQLITE_LOCKED` → "Replay LKG or refuse; **never retry the mutating transform**"；③ `UnresolvedHistoryBoundaryError`/`UnmanagedOverWindowError`/`DegradedPassRefusalError` → "Replay LKG or refuse"；④ 其他 → 记 `session_meta.last_transform_error` 后**原样放行**。应急带拒绝 replay：`:440-459`（`emergencyFailClosed(...)` / `isEmergencyRecoveryArmed(sessionId)` / `needsEmergencyRecovery` → `replayBlocked = true`，日志 `lkg_emergency_band_refused` / `lkg_emergency_armed`） |
| K-5 | 5. schema fence；`LATEST_SUPPORTED_VERSION` 与 `LATEST_MIGRATION_VERSION` 同步 | **一致** | M-16 + M-17 |
| K-6 | 6. user 终止尾部的因果性（`preserveUserTerminatedTail`） | **一致** | `packages/plugin/src/plugin/messages-transform.ts:177` `function preserveUserTerminatedTail(`；:642 调用点 `preserveUserTerminatedTail(output.messages, inputMessages);`（紧邻 :215 的 `moveUserToTail` 同属尾部因果修正族） |
| K-7 | 7. `MessageHistory` entries 进入后禁止原地修改；跨 await 浅快照 | **一致** | Z-15 + Z-16 |

---

## 4. D-12 配置断言

| # | spec 位置 | 断言 | 判定 | 证据 |
|---|---|---|---|---|
| D-01 | L48 / L351 / T-M10 | `ZCodeConfigFileSchema.passthrough` 容忍旧键 | **一致** | `apps/zcode-cli/packages/adapters/src/config/schema.ts:286-306`：`z.object({ $schema, modelStream, permission, storage, network, features, memory, mcp, plugins, skills, skill, command, logging, ui, toolConcurrency, modelAnomalyGuard, hooks }).passthrough()`（:306） |
| D-02 | L48 / L114 / L202 | `parsedConfigFileToRuntimePatch` 为手写逐域映射 | **一致** | `adapters/src/config/schema.ts:398-424`：逐个 `if (parsed.X) config.X = ...`（modelStream / permission / storage / network / features / memory / mcp / plugins(经 normalizePluginConfig) / skills(经 parseSkillsRuntimeConfig) / skill(mergeSkillCommandOverrides) / command / logging / ui / toolConcurrency / modelAnomalyGuard / hooks）。新增 `magicContext` 域须在此加一行 —— 与 spec"需走完整手写映射"一致 |
| D-03 | L101 / R5 | "CLI bundle 的 `createZodDedupePlugin` + `assertZodBundleIdentity` **强制单一 zod 根 4.6.5**" | **不一致** | 见下"可疑点 Q-3"。`assertZodVersion` 只对 `version.startsWith("4.")` 生效，v3 被**有意放行**；且 `apps/zcode-cli/packages/contracts` 实际解析到 **zod@3.25.76**（第二个 zod 根），恰是 spec 计划放 `ConfigKey.MagicContext` 与 ctx 工具契约的包 |

---

## 5. 可疑点清单（spec 未提及或与代码有出入）

### Q-1（高）E 组"移植 live-run-config / live-snapshot"与"不搬 jsonc 体系"自相矛盾

- `packages/plugin/src/config/live-run-config.ts:2` `import { loadPluginConfigDetailed, type MagicContextPluginConfig } from "./index";` —— 直接依赖 jsonc 装载器 `config/index.ts`。
- `packages/plugin/src/config/live-snapshot.ts:4` `import { detectConfigFile, parseJsoncRecovering } from "../shared/jsonc-parser";` —— 直接依赖 jsonc 解析器。
- `packages/plugin/src/shared/jsonc-parser.ts`、`jsonc-edit.ts` 确实存在（`config/raw-loader.ts` 亦在 jsonc 链上）。
- 判定：spec L99 把 `live-run-config.ts`/`live-snapshot.ts` 列为"移植"对象，同时 L99 末与 L100 末把 jsonc 族列为"不移植"。D-12 下这两个文件不是"移植"，是**必须重写**（`loadPluginConfigDetailed` → ZCode `ConfigPort` 读 `magicContext` 域；`detectConfigFile`+`parseJsoncRecovering` → 由宿主推送 live-snapshot，宿主侧不做文件轮询）。Step 16 的"qa: auto"若照字面执行会在类型检查处断链。

### Q-2（中）`config/schema/magic-context.ts` 有 5 条 spec 未列的传递 import，其中 2 条落在"明确不搬"的 dreamer 下

`packages/plugin/src/config/schema/magic-context.ts:1-10`：
```
:1 node:os (homedir)
:3 ../../agents/language-directive            (isValidLanguageCode)
:4  ../../features/magic-context/dreamer/cron        (isValidCron)     ← spec L100 明确不搬 dreamer/**
:5-8 ../../features/magic-context/dreamer/task-registry (类型)          ← spec L100 明确不搬 dreamer/**
:9  ../../shared/prompt-surface              (isValidPromptSurfaceModelKey)
:10 ./agent-overrides                        (AgentOverrideConfigSchema)
```
spec E 组只写"只移植 `config/schema/magic-context.ts`"，字段白名单化能砍掉大部分 schema 分支，但**模块级 import 无法靠字段白名单裁掉**。这是 E 组缩减后最直接的断链点。

### Q-3（高）zod 双根：spec 的 R5 缓解措施描述与实际校验逻辑不符

- `apps/zcode-cli/packages/contracts/package.json:99` 声明 `"zod": "^3.24.0"`；`pnpm-lock.yaml:349-351` 解析为 **`zod@3.25.76`**（仓库同时存在 `zod@3.25.76` 与 `zod@4.6.5` 两个根，lockfile :9913/:9916/:19229/:19231）。
- `apps/zcode-cli/packages/cli/scripts/build.mjs:51-55` `assertZodVersion` 只在 `pkg.version.startsWith("4.")` 时比对；:41 注释原文："**不能把 v3 alias 成 v4**"；:66-69 重复检测按 version 分组，v3 与 v4 不同版本不判重。
- `readZodBuildVersion`（build.mjs:16-25）从 `packages/shared/package.json` 读 `"zod"`，要求严格 `^4\.\d+\.\d+$` → expectedV4Version = `4.6.5`。**只锁 v4 侧**。
- 交叉证据：`adapters/src/config/schema.ts:228-233` 注释自陈："两个 pnpm workspace 解析出**物理不同的 zod 实例**（adapters 4.4.3 / shared 4.3.6）……会让 dts 引用 foreign zod 内部类型（TS2742）"。
- 影响面：magic-context 用 **zod ^4.1.8**（`packages/plugin/package.json:69`）。spec Phase 2a 要把 zod v4 schema 内嵌进 `contracts`（v3.25.76）与 `adapters`（4.6.5）两处。spec L101"zod 改用 workspace 版"在 contracts 侧不成立。

### Q-4（中）ctx 工具的 OpenCode/Rust 依赖未列入"不搬"清单

- `packages/plugin/src/tools/ctx-reduce/tools.ts:2` 与 `tools/ctx-expand/tools.ts:1` 均 `import { type ToolDefinition, tool } from "@opencode-ai/plugin";` —— `@opencode-ai/plugin` 未出现在 spec L101 的依赖处理清单（既不在"引入"也不在"不引入"）。
- `tools/ctx-reduce/tools.ts:16` `import type { RustToolBackends } from "../../plugin/rust-tool-backends";` —— spec Step 18 只说"剥离 rust/module 分支"，未点名此文件。
- `tools/ctx-reduce/tools.ts:21` 与 `tools/ctx-expand/tools.ts:5` 均依赖 `../unwrap-imitated-reduced-args` —— 该文件在 `packages/plugin/src/tools/` 根下，**不在** spec D 组列举的 `tools/ctx-reduce/**` + `tools/ctx-expand/**` + `features/magic-context/range-parser.ts` 之内。

### Q-5（低）spec 目录描述易误导：transform 管线不在 `features/magic-context/`

B 组 4 大文件全在 `hooks/magic-context/`，而 C/D 组用 `features/magic-context/{...}` 前缀书写。读者按 C/D 组格式推断 B 组会找错目录。

### Q-6（低）`shared/sqlite.ts` 有 spec 未列的 better-sqlite3 类型依赖

`packages/plugin/src/shared/sqlite.ts:48` `import type BetterSqlite3 from "better-sqlite3";`。虽为 `import type`（构建期擦除），但 tsconfig/`@types/better-sqlite3` 需在位；spec L131 的新包 `package.json` 只列 `zod(workspace)+ai-tokenizer`。

### Q-7（低）`HiddenCompletionExecutor` 的 attempt/collect 两段式与 ZCode 现有旁路原语语义不同

`compartment-runner-types.ts:119-121` 把"投喂 prompt"（`attempt`）与"取回结果"（`collect`）显式分离，注释："Kept separate from prompt settlement so read failures never resend a historian prompt"。而 `runCompactSummaryModelRequest`（compact-summary-model-request.ts:74-109）是"投喂+流式消费+一次性返回"的单段式。接口形状（5 个方法）与 spec L187 描述一致，但 D-6 L42"复用 runCompactSummaryModelRequest 范式"在 `attempt`/`collect` 这一层不成立，需要新的分段原语而非直接复用。

---

## 6. 未核实项

| # | 项 | 原因 |
|---|---|---|
| U-1 | T-M1（§N§ 注入）、T-M2（drop 落地与字节重放）、T-M3（expand 恢复）、T-M4（wire-level m[0]/m[1] synthetic 语义）、T-M5（prompt cache 命中）、T-M6（historian 产出）、T-M7（fence/fail-closed）、T-M8（flag off 零差异） | 全部是 `qa: manual_user` / 运行时验收项，静态取证无法判定 |
| U-2 | R3 的实际风险敞口（ZCode 投影层对 synthetic/attachment 的真实处理） | M-11 注释证明该行为是 OpenCode `toModelMessagesEffect` + `ensureTitle` **特有**；ZCode 侧是否有等价过滤需在 Step 19 wire-level 才能暴露。静态侧只能确认 `ToolExecutionContext` 无 messageHistory（Z-09）、`source.ts` 未注册源会 throw（Z-05） |
| U-3 | R5 的构建期真实行为（esbuild 去重后是否真为单一 zod 实例） | 需实际执行 `cli:build`；且 Q-3 已表明断言前提本身有误 |
| U-4 | R6（transform 热路径抖动导致 cache 命中率塌方）的实际量级 | 需真机长会话 + token 命中统计 |
| U-5 | R7（`RawMessageProvider` 分页能力与 historian 分块需求是否匹配） | M-04/M-05 只能确认接口形状；匹配性需 Step 17 全方法冒烟 |
| U-6 | Step 15/16 冒烟脚本"断言 fence 版本同步"的可行性 | `migrations.ts:3211` 称有单测断言两常量同步，但该单测文件未在 spec 移植清单内 |
| U-7 | D-11（Step 28 默认翻 true）与 T-M8 的交互时序 | 属流程断言，非源码事实 |

---

## 7. 计数汇总

| 判定 | 条数 |
|---|---|
| 一致 | 46 |
| 不一致 | 8（Z-13、M-02、M-13、M-14、K-1 的计数部分、D-03、Q-1、Q-2、Q-3 中计入 D-03） |
| 部分不一致 | 2（M-21、Z-21） |
| 无法核实 | 7 |

关键不一致条目（按影响排序）：**D-03/Q-3（zod 双根，contracts 实为 3.25.76）** > **Q-1（E 组 live-* 文件与"不搬 jsonc"矛盾）** > **M-13/M-14/K-1（cached_m0 列 18≠19、M0SnapshotMarkers 21/18≠16）**。
