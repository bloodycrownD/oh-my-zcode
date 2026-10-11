# CR v010 · 证据包 · evidence-protocol-storage（重派）

- head_sha: aba59a9（`aba59a94e5ae42bdc6de506de2560581580e3ee8`）
- base_sha: 1fa2d0e（`1fa2d0e515294b67152598c4e07e1d522b2dc11f`）
- 节点: evidence-protocol-storage（wave-1, 重派实例）
- 范围: `apps/zcode-cli/packages/contracts/**`、`packages/shared/**`、`apps/zcode-cli/packages/adapters/**`（BASE..HEAD）
- 模式: readonly 取证（只写本证据包文件；未修改任何代码/文档）
- 取证方法: `git diff 1fa2d0e..aba59a9 -- <path>` + HEAD 侧 `rg` 定点核实；不对代码下结论，只记录事实与可疑点。

---

## 1. S26 编辑型摘除抽样

### 1.1 contracts/src/interfaces/session-store.port.ts（HEAD 行号）

| 摘除物 | HEAD 落点 | 摘除后自洽性 |
|---|---|---|
| `MessageSemanticsKind \| "compact_summary"` | 联合定义 `:69`（值域现为 `... "timeline_event" \| "shared_context" \| "assistant_response"`） | 与 `packages/shared/src/zcode-protocol-legacy-types.ts:198-206` 的 `zcodeMessageSemanticsSchema` 枚举**同步收窄**（两个独立声明同时删了同一个成员） |
| `interface CompactionPart`（21 字段） | 整接口删除，位置在 `AgentPart`（`:510` 结束）之后、`TimelinePartDisplay` 之前 | `MessagePart`（`:706`）联合成员表同步去掉 `\| CompactionPart` |
| `interface ContextCompactionTimelinePart` | 删除；`TimelinePart`（`:577`）联合首成员 `ContextCompactionTimelinePart` 同步去掉 | union 剩余 3 成员：`GoalVerificationTimelinePart` / `SessionForkTimelinePart` / `ModelChangeTimelinePart` |
| `ToolStateCompleted.time.compacted?: number` | `ToolStateCompleted`（`:667`）的 `time` 只剩 `start`/`end` | 无 in-repo 消费方（全仓 `rg "compacted"` 在 storage/shared 下 0 命中，仅 ui 帮助文案中的英文单词） |
| `UsageQuerySource \| "compact"` | `UsageQuerySource`（`:810`），现为 `main_turn \| session_title \| goal_completion_verification \| subagent` | **⚠ 该联合的实际约束力弱**：唯一使用点是同文件 `:830` `querySource: UsageQuerySource \| string`，`\| string` 把联合放宽为任意字符串；core 侧另有独立本地类型 `ModelUsageQuerySource`（`apps/zcode-cli/packages/core/src/runtime/methods/usage-observability.ts:21`）与本类型无关。全仓 `rg UsageQuerySource` 仅 3 处命中（定义 / `:830` / core 本地类型），删 `"compact"` 对任何真实调用点的类型检查**零影响** |

`session-store.port.ts` 顶部的 `import type { CompactBoundaryPayload, CompactPhase, CompactReason, CompactTimelineDisplay, CompactTimelineStatus, CompactTrigger } from "../compact/index.js"` 整块删除，随之 `contracts/src/compact/index.ts`（353 行）整文件删除、`contracts/package.json:22-25` 的 `"./compact"` export 删除、`contracts/src/index.ts:41-42` 的 `export * from "./compact/index.js"` 删除。四处一起摘，无残留 barrel。

### 1.2 sqlite-session-store.ts 两处

文件 HEAD anchor：`assertForkBundleChildLocal` 在 `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts:115`。两处分支删除：

- 处 A（原 `timelineType === "context_compaction"` → `assertMessage(part.summaryMessageId, "timeline summaryMessageId")`）删除；同行保留的 `if (part.timelineType === "goal_verification") targetIds.add(part.targetId)` 仍在。
- 处 B（`part.type === "compaction"` → 10 条 `assertMessage`，覆盖 `tail_start_id` / `summaryMessageId` / `compactBoundary.{lastSummarizedMessageId,summaryMessageIds,attachmentMessageIds,hookResultMessageIds}` / `compactBoundary.preservedSegment.{head,anchor,tail}MessageId`）整块删除。

自洽性：两处的判别式（`part.type === "compaction"`、`part.timelineType === "context_compaction"`）所依赖的类型成员已在 1.1 表中从联合里删除 → 分支成为不可达代码，删除是**类型层必需**而非可选清理。`part.type === "timeline"` 内的 `assertMessage(part.anchorMessageId, ...)` 与其后的 `tool` 分支保留。

### 1.3 codecs.ts

`partCreatedAt`（`apps/zcode-cli/packages/adapters/src/storage/session-store/codecs.ts:190`）删除 `if (part.type === "compaction") return part.time?.start ?? fallback;` 一行。函数体是 `if (part.type === ...)` 链式 narrow，`compaction` 成员消失后该分支为死代码，删除后剩余 `text`/`reasoning`/`timeline`/`tool` 分支仍构成 `MessagePart` 的完整覆盖。**编解码自洽**。

### 1.4 steering 分支（4 处枚举收窄，全部成对同步）

| 面 | 位置 | BASE → HEAD |
|---|---|---|
| contracts 类型 | `apps/zcode-cli/packages/contracts/src/interfaces/session.port.ts:267` `TurnSteerCommandKind` | `"sendText" \| "sendGoalCommand" \| "compact"` → 去 `compact` |
| shared 协议 zod | `packages/shared/src/zcode-protocol/index.ts:1140` `zcodeTurnSteerCommandKindSchema` | `z.enum([...3])` → `z.enum(["sendText","sendGoalCommand"])`，用于 `:1151` `commandKind` |
| shared 协议 v4 | `packages/shared/src/zcode-protocol-v4/input-intent.ts:44` `conversationInputIntentSchema.kind` | `z.enum([...3])` → 去 `compact`（本对象 `.strict()`，`:66`） |
| shared 任务类型 | `packages/shared/src/zcode-task-types-core.ts:442` `ZCodeTurnSteerCommandKind` | 去 `compact` |

### 1.5 rewind 分支（contracts/src/rewind/index.ts，89 行改动，本范围第二大）

- 顶部 `import { isCompactBoundaryItem, parseCompactBoundaryPayload }` 与 `import type { CompactBoundaryPayload, CompactContextItem }` 删除。
- `RewindTargetStatus`（`:36-39`）删成员 `CoveredByCompact: "covered_by_compact"`，现只剩 `ActiveChain` / `Missing`。
- `checkpointCreatedPayloadSchema`（`:43-54`，**`.strict()`**）删 `compactBoundaryId` / `coveredByCompact`。
- `rewindTriggeredPayloadSchema`（`:65`，**`.strict()`**）删 `compactBoundaryId`。
- `CheckpointProjectionInfo`（`:119` 附近）删 `compactBoundaryId` / `coveredByCompact`；`RewindProjectionInfo`（`:129` 附近）删 `compactBoundaryId`。
- `RewindTargetEvaluation`（`:140` 附近）删 `compactBoundary` / `compactBoundaryId`；`EvaluateRewindTargetInput`（`:148` 附近）删 `isBoundary?`。
- 函数体 `evaluateRewindTarget`（`:217`）由「4 分支」塌缩为「3 分支」：`targetIndex < 0` → Missing/Unavailable；scope 不被允许 → Unavailable/**ActiveChain**（原为 CoveredByCompact）；否则 ActiveChain。**`RewindStrategy.FileOnly`（`rewindStrategy:29`）在本函数内已无任何 return 点**（原 `target_covered_by_compact_file_only_available` 分支被删）。
- 自洽性：全仓 `rg "compactBoundaryId|evaluation\?\.compactBoundary|isBoundary"` 在 `apps/`+`packages/`（排除 dist/node_modules/bundled-agents）**0 命中** → 摘除后无悬挂读点。

**衍生事实（跨包，供 CR 判断）**：`RewindStrategy.FileOnly` 虽仍在枚举里（`rewind/index.ts:29`），但：
- 生产者 `evaluateRewindTarget` 已不再返回它；
- 全仓 `rg "RewindStrategy.FileOnly"` 的 4 处**全部是比较而非赋值**：`core/src/runtime/methods/rewind.ts:246,327`、`rewind-message.ts:252,352`；
- 唯一 3 处 `strategy: RewindStrategy.ForkRequired` 赋值（`workspace-fork.ts:283`、`workspace-checkpoints.ts:317`、`session-fork.ts:769,1032`）走的是另一条构造路径，与 `FileOnly` 无关。
即：contracts 侧这次编辑使 core 侧 4 个 `FileOnly` 分支变成不可达。

### 1.6 session-fork 分支 / 事件与 reducer

- `SessionEventType`（`contracts/src/events/session.events.ts`）：`:81` 前删 `SessionCompacted: "session_compacted"`；`:152` 前删 5 个 `CompactStarted`/`CompactCompleted`/`CompactFailed`/`CompactBoundary`/`MicrocompactBoundary`。
- payload 类型删：`SessionCompactedPayload`、`CompactLifecyclePayload`、`MicrocompactBoundaryEventPayload`（均曾挂在 `SessionEventPayload` 联合尾部 `:1152`/`:1206`）。
- `SessionResumedPayload`（`:177`）删 `recoveredCompactTimelineCount?`。
- `SystemMessagePayload`（`:605`）的 `type` 由 `"init" | "compact_boundary" | "interrupted"` 收窄为 `"init" | "interrupted"`，并删 `compactBoundary?`。
- `events/event-reducer-helpers.ts`：`initialSessionProjection`（`:23`）删 `lastCompact`（`:39` 现为 `lastCheckpoint`）；`applyCompactBoundary` 整个函数（29 行）删除，及其两条 import。
- `events/event-reducer.ts`：删 `[EventTypes.SessionCompacted]` handler、删 `[EventTypes.CompactBoundary]` handler、删对应 import；`[EventTypes.CheckpointCreated]`（`:141`）不再写 `compactBoundaryId`/`coveredByCompact`；`[EventTypes.RewindTriggered]`（`:159`）不再写 `compactBoundaryId`。
- `interfaces/session.port.ts` 的 `SessionProjection`（`:98` 附近）删 `lastCompact?: CompactProjectionInfo`。

### 1.7 projection-policy / legacy-types

- `packages/shared/src/conversation-message-projection-policy.ts:85`：判定条件由 `semantics?.kind === "compact_summary" \|\| info.summary !== undefined` 收窄为 `info.summary !== undefined`（**注意：两个条件不同时消失，只去掉 kind 那一半，`info.summary` 分支仍在**）。
- 同文件 `:213` `isTimelineOnlyMessage` 的 `.some()` 谓词由三分支（含 `part.type === "compaction" && (timelineStatus 或 summaryMessageId)`）收窄为 `part.type === "timeline" || hasSessionForkContext(metadata)`。
- `packages/shared/src/zcode-session-visible-content.ts`：删 `isZCodeCompactSummaryMessage`（15 行）；`getZCodeUserVisibleMessages`（`:67`）的过滤条件由 `isZCodeModelOnlySyntheticUserMessage(...) || isZCodeCompactSummaryMessage(...)` 收窄为只剩前者，注释里的枚举文案「…rewind 通知和 compact summary」同步改为「…rewind 通知」。
- `packages/shared/src/zcode-protocol-legacy-types.ts`：
  - `:198-206` `zcodeMessageSemanticsSchema` 删 `"compact_summary"`；
  - `:313` `zcodeTimelinePartSchema.timelineType` 由 4 值 `z.enum` 收窄为 `z.enum(["goal_verification","session_fork","model_change"])`（该字段**必填**，不是 `.optional()`），并删 9 个 compact 专属字段（`trigger`/`phase`/`compactReason`/`boundaryId`/`summaryMessageId`/`pre|post|truePostCompactTokenCount`）；
  - `:346` `zcodeMessagePartSchema`（`z.discriminatedUnion("type", [...])`）删 `type: z.literal("compaction")` 那个 `.strict()` 成员；
  - `:491` `zcodeSessionRuntimeStateSchema.activeTurnKind` 由 `["regular","compact","rewind"]` 收窄为 `["regular","rewind"]`。
- `packages/shared/src/zcode-task-types-core.ts`：删 `ZCodeTimelineTrigger`、`ZCodeContextCompactionTimelinePhase` 两个导出类型与 `ZCodeContextCompactionTimelineMeta` 接口；`:498` `ZCodeTimelineMeta` 由 3 元联合收窄为 2 元（`ZCodeGoalVerificationTimelineMeta | ZCodeSessionForkTimelineMeta`）。
- `packages/shared/src/zcode-protocol-v4/`：
  - `command.ts:144-149` 删 `commandPayloadSchemas.compact`（注释解释它是「输入型维护命令、idle 立即执行、busy 进 FIFO」的键）；
  - `fork.ts:23-27` `StableForkTargetResolution` 的 `reasonCode` 删 `"guard.compactOperationLock"`；
  - `rows.ts:328-338` `timelineMarkerPayloadSchema` 的 `z.union` 删 `type: z.literal("compact")` 成员（原 5 成员 → 4）；`:386` 注释 `assistantWork：assistant 工作活动（compact）` 去掉括号内容；
  - `snapshot.ts:41-52` `stopTargetKindSchema` 删 `"compact"`；`activeWorkSummarySchema.kind` 删 `"compact"`；`:149-157` `sessionActionAvailabilitySchema` 删 `compact` 键（该对象**非 strict**）。
- `packages/shared/src/zcode-protocol/index.ts`：
  - `:1225` 附近 `zcodeMessageUpsertedEventPayloadSchema` 删 `compactBoundary: z.unknown().optional()`（该对象 `.strict()`）；
  - `:1778-1805` 删 `zcodeSessionCompactParamsSchema` / `ZCodeSessionCompactParams` / `zcodeSessionCompactResultSchema` / `ZCodeSessionCompactResult`（4 个导出，30 行）；
  - `:3598` `zcodeProtocolMethods.sessionCompact: "session/compact"` 删除。
- `packages/shared/src/zcode-slash-command-help.ts:37-43` 删 `/compact` 帮助条目（4 字段）；`:194-238` 新增 4 条 `/ctx-*` 条目（见第 4 节）。
- `packages/shared/src/test-ids.ts:243-246` 删 `TID_CHAT_COMPACT_MARKER` / `TID_CHAT_COMPACT_RETRY_BUTTON`；`:479-480` 新增 `TID_CHAT_CONTEXT_USAGE_MAGIC_CONTEXT`。
- `contracts/src/hooks/index.ts:130` `SessionStartHookInput.source` 删 `"compact"`。

**摘除后联合/编解码自洽性结论性观察（仅陈述事实）**：
对 20 个被删符号做全仓 `rg`（排除 `dist` / `node_modules` / `bundled-agents`）：
`TID_CHAT_COMPACT_MARKER`、`TID_CHAT_COMPACT_RETRY_BUTTON`、`isZCodeCompactSummaryMessage`、`zcodeSessionCompactParamsSchema`、`zcodeSessionCompactResultSchema`、`ZCodeSessionCompactParams`、`applyCompactBoundary`、`parseCompactBoundaryPayload`、`isCompactBoundaryItem`、`sessionCompact`、`FeatureCompact`、`SessionCompacted`、`session_compacted`、`covered_by_compact`、`autoCompactThresholdTokens` → **0 命中**。
`CompactionPart` / `ContextCompactionTimelinePart` / `context_compaction` / `contracts/compact` / `CompactBoundaryPayload` / `CompactTimelineDisplay` / `compact_summary` → **仅 2 处注释文字**残留：`apps/zcode-cli/scripts/shadow-replay.mjs:172`（`// compact 续接摘要（info.summary / semantics.kind=compact_summary）`）、`packages/shared/src/zcode-task-types-core.ts:1066`（`/** synthetic divider 元数据（context_compaction / session_fork）…`）。
`features.compact` / `features.compact` 字面量 → 仅 `apps/zcode-cli/packages/adapters/scripts/test-feature-flag.mjs` 的 4 处（注释 + 2 个 T-M10 用例 + `:204` 的 `"FeatureCompact" in ConfigKey === false` 断言）。

### 1.8 dynamic-workflow types.ts 占位保留现状

`apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts` 在 BASE..HEAD **无改动**（不在 62 个变更文件列表内）。
- `:470` 注释：「`compaction` 为长上下文压缩预留——v1 从不发出，仅占位以便将来非破坏地加入。」
- `:654` 保留联合成员 `| { type: "compaction"; actor: ActorRef }`。
- 全包 `rg -l compact`（排除 `libs.generated.ts`）只命中这一个文件。
即：dynamic-workflow 侧的 `RunEvent.compaction` 占位**原样保留**，未被 S26 摘除触及。另 `packages/shared/src/zcode-protocol-v4/telemetry.ts:9` 注释「…（`usage.delta` / `subagent.lifecycle` / `workflow.lifecycle` / `compaction.terminal`）随之删除」与 `workflow-runs-reducer.ts:565` 注释「log / compaction 不是 step」为纯注释残留。

---

## 2. 配置域映射（features.magicContext 七处 / magicContext 参数域）

### 2.1 `features.magicContext` 七处落点（file:line 全部落在 HEAD）

| # | 环节 | file:line | HEAD 内容 |
|---|---|---|---|
| 1 | ConfigKey 枚举 | `apps/zcode-cli/packages/contracts/src/config/index.ts:38` | `FeatureMagicContext: "features.magicContext",` |
| 2 | ConfigValue 条件类型（boolean 分支） | 同文件 `:130` | 追加进 boolean 联合串 `"features.mcp" \| "features.magicContext" \| "skills.enabled" \| ...` |
| 3 | ConfigValue 条件类型（magicContext 域分支） | 同文件 `:170-172` | `: K extends "magicContext" ? unknown : unknown;` |
| 4 | RuntimeConfig 接口 | 同文件 `:248`（`features.magicContext: boolean`）、`:261`（`magicContext?: unknown`） | `features` 新增必填 `magicContext: boolean`；顶层新增可选 `magicContext?: unknown` |
| 4b | RuntimeConfigPatch | 同文件 `:297-298` | `/** FORK… */ magicContext?: unknown;` |
| 5 | schema | `apps/zcode-cli/packages/adapters/src/config/schema.ts:44` | `featuresSchema` 内 `magicContext: z.boolean().optional(),` |
| 6 | merge | `apps/zcode-cli/packages/adapters/src/config/index.ts:128-129` | `if (config.features.magicContext !== undefined) this.set(ConfigKey.FeatureMagicContext, …, scope);` |
| 7a | getAll `?? true` | 同文件 `:298` | `magicContext: this.store.get(ConfigKey.FeatureMagicContext) ?? true,` |
| 7b | getDefaultValue | 同文件 `:418-419` | `case ConfigKey.FeatureMagicContext: return defaults.features.magicContext;` |
| 7c | DefaultRuntimeConfig | `contracts/src/config/index.ts:346-349` | `magicContext: true,`（注释：D-11 收官，step 28 翻默认开） |

补充两处「同 key 的对称删改」（S26）：
- `contracts/src/config/index.ts` 删 `FeatureCompact: "features.compact"`（原 `:33` 附近）、`ConfigValue` 的 `"features.compact"` 成员、`:218` 附近 `RuntimeConfig.features.compact: boolean`、`DefaultRuntimeConfig.features.compact: true`。
- `adapters/src/config/schema.ts:38-45` `featuresSchema` 删 `compact`；`adapters/src/config/index.ts` 删 `if (config.features.compact !== undefined) this.set(ConfigKey.FeatureCompact, …)`、getAll 的 `compact: … ?? true`、getDefaultValue 的 `case ConfigKey.FeatureCompact`。

### 2.2 `magicContext` 参数域（与 flag 分离的第二层）

| 环节 | file:line | HEAD 内容 / 观察 |
|---|---|---|
| ConfigKey | `contracts/src/config/index.ts:44` | `MagicContext: "magicContext",`（顶层键，不带 `features.` 前缀） |
| ConfigValue 承载 | 同文件 `:170-172` | 两臂**都是 `unknown`** —— 显式写出但与 `:153` 的 `unknown` 兜底**类型上完全等价**（详见 6.2） |
| RuntimeConfig / Patch | 同文件 `:261` / `:298` | `magicContext?: unknown` |
| DefaultRuntimeConfig | 同文件 | **未登记** `magicContext`（只有 `features.magicContext: true`）；缺席回落由 adapters 的 `getDefaultValue` 兜 |
| schema 白名单 | `adapters/src/config/schema.ts:65` | `const magicContextDomainSchema = MagicContextConfigSchema.optional();` —— 直接复用 `@zcode/magic-context` 的 schema 对象（`:336` 再原样 re-export） |
| schema 挂载点 | 同文件 `:316` | `magicContext: magicContextDomainSchema,`（挂在 `ZCodeConfigFileSchema`，该对象 `:328` 为 `.passthrough()`） |
| schema → RuntimeConfigPatch | 同文件 `:435` | `if (parsed.magicContext) config.magicContext = parsed.magicContext;`（**注意缩进丢失，见 6.1**） |
| adapters 包依赖 | `apps/zcode-cli/packages/adapters/package.json:109` | 新增 `"@zcode/magic-context": "workspace:*"` |
| ConfigStore.merge | `adapters/src/config/index.ts:137-138` | `if (config.magicContext !== undefined) this.set(ConfigKey.MagicContext, config.magicContext, scope);` —— 整域透传，无逐字段 merge |
| ConfigPortImpl.get 回落 | 同文件 `:427-428` | `case ConfigKey.MagicContext: return DEFAULT_MAGIC_CONTEXT_CONFIG;`（显式登记，理由见 `:422-426` 注释：否则 `:262` 会 `throw Config key not found`） |
| getAll 回落 | 同文件 `:305` | `magicContext: this.store.get(ConfigKey.MagicContext) ?? DEFAULT_MAGIC_CONTEXT_CONFIG,` |
| import | 同文件 `:15` | `import { DEFAULT_MAGIC_CONTEXT_CONFIG } from "./schema.js";` |
| 写盘 | `adapters/src/config/file-config.adapter.ts:269-285` | `updateMagicContextInFileConfig(filePath, config): Promise<MagicContextPatchResult>`；`:276` 用 `isDeepEqualJson` 判幂等；`:280` 仅 `changed` 时 `atomicWriteJson`（`:673`） |
| 写盘结果类型 | 同文件 `:48-52` | `MagicContextPatchResult { path: string; changed: boolean }` —— **刻意不回显域值**（注释解释：十几 KB 快照进 JSON-RPC result 会污染协议日志） |
| 整域替换实现 | 同文件 `:287-295` | `patchMagicContext(parsed, config) => ({ ...parsed, magicContext: config })` |
| 深比较 | 同文件 `:298-312` | `isDeepEqualJson`：键序无关递归比较，非 record 时退回 `JSON.stringify` |
| 协议层 | `packages/shared/src/zcode-protocol/index.ts:2146-2154` / `:2156-2185` | update params/result（见第 4 节） |
| 方法名 | 同文件 `:3615` / `:3618` | `workspace/updateMagicContextConfig` / `workspace/readMagicContextConfig` |

### 2.3 「schema 白名单 11 键」复核

权威 schema 在**范围外**的 `apps/zcode-cli/packages/magic-context/src/host/config/schema.ts`（该文件在 BASE..HEAD 无改动），`MagicContextConfigSchema` 位于 `:146-216`。逐个数下来是 **10 个顶层键**，不是 11：

1. `enabled`（`:147`，`.default(true)`）
2. `execute_threshold_percentage`（`:148-156`）
3. `execute_threshold_tokens`（`:157-165`，`.optional()`）
4. `protected_tokens`（`:166-174`，`.optional()`）
5. `history_budget_percentage`（`:175-182`）
6. `cache_ttl`（`:183-188`）
7. `historian`（`:189-191`，`HistorianConfigSchema.default(() => DEFAULT_HISTORIAN_CONFIG)`）
8. `smart_drops`（`:192-197`，`.default(false)`）
9. `fail_closed_blocking`（`:198-203`，`.default(true)`）
10. `language`（`:204-215`，`.optional()`）

第 11 项疑指 `:232` 的 `export const EXCLUDED_CONFIG_KEYS = ["compaction"] as const;`（唯一被显式登记为「不移植」的键）。该列表注释（`:226-231`）明确：`Not enforced at runtime — z.object strips them`，只由 Step 16 测试断言。

`z.object` 无 `.strict()`/`.passthrough()` → **未知键 strip 而非 reject**。同一语义在两侧被重复声明：`magic-context/src/host/config/schema.ts:139-145` 的文件注释，以及 `adapters/src/config/file-config.adapter.ts:249-250`（「未知键（如参考插件遗留的 `compaction`）随整域替换被清掉」）、`bootstrap/src/zcode-protocol/magic-context-config.ts:118-121`（「措辞上不能把它读成『未知键会被拒』」）。

### 2.4 配置链路上 `magicContext` 的三条入口 + 一条 merge 语义

1. **config.json 装载**：`ZCodeConfigFileSchema`（`schema.ts:307-328`，顶层 `.passthrough()`）→ `parsedConfigFileToRuntimePatch`（`:426-439`）→ `RuntimeConfigPatch.magicContext`。
2. **RPC update**：`bootstrap/src/zcode-protocol/magic-context-config.ts:122` `MagicContextConfigSchema.safeParse(params.config ?? {})` → `:132` 写盘 → `:142-149` 逐 session `configPort.set` → `:159-168` 回 effective 域（`parsed.data`，非 `params.config`）。顺序 ①校验 ②写盘 ③内存的理由写在 `:33-46`。
3. **RPC read**：同文件 `:66-105`，先遍历 `context.sessions` 取 `configPort.get(ConfigKey.MagicContext)`（`:74-86`），无活动 session 才退回 `loadFileConfig` + `MagicContextConfigSchema.parse(loaded.config.magicContext ?? {})`（`:88-96`）。
4. **多来源 merge**：`adapters/src/config/config-merger.ts:26-75` 的 `mergeConfigs` **没有** `magicContext` 分支——它只落在 `:45` 的 `Object.assign(result, config)` 上，即**顶层键整域替换**。这与 `schema.ts:57-64` 注释宣称的一致（`.default()` 补齐后高层整域覆盖不丢低层字段），前提是每一层的值都过 schema。

---

## 3. 防误删清单存活（HEAD 存在性 + 消费者）

本范围内**没有一个防误删项出现在 62 个变更文件里**（即未被 S26/S23 触达）。逐项核实：

### 3.1 `compact_stream_boundary` — 存活

- 定义：`apps/zcode-cli/packages/contracts/src/model/index.ts`，`ModelStreamEvent`（`:726` 起）含 **5 个** `type: "compact_stream_boundary"` 成员，boundary 值域分别为
  `:736` `provider_response_start | inferred_content_block_stop`、
  `:740` `provider_content_block_start`、
  `:747` `provider_content_block_delta`、
  `:753` `provider_content_block_stop`、
  `:759` `provider_stop_reason`。
  `contracts/src/model/index.ts` **不在** BASE..HEAD 变更列表内 → 零改动。
- 生产者：`apps/zcode-cli/packages/adapters/src/model/runner-stream.ts:1090,1099,1107,1114,1122`（五处 `type: "compact_stream_boundary"` 构造）+ `:1137`（tool-call 分支），全部由 `input.preserveProviderStreamBoundaries` 门控（`:1132`）。
- 消费者：`adapters/src/model/runner-stream.ts:1573`（`case "compact_stream_boundary":` 归一化）；`apps/zcode-cli/packages/core/src/runtime/methods/sidecar-model-request.ts:112`（switch case）、`:192`（`Extract<ModelStreamEvent, { type: "compact_stream_boundary" }>`）。
- 断言测试：`apps/zcode-cli/packages/core/scripts/test-sidecar-model-request.mjs:152-291`（`:278` 注释「这条断言是『compact_stream_boundary 的 case 被命中』的直接证据」）。

### 3.2 `preserveProviderStreamBoundaries` 定义面 — 存活且被收紧为必填字面量

| 定义点 | file:line | 形态 |
|---|---|---|
| contracts 侧请求上下文 | `apps/zcode-cli/packages/contracts/src/model/invocation-context.ts:29` | `preserveProviderStreamBoundaries?: boolean;` |
| contracts 侧 ModelRequest | `apps/zcode-cli/packages/contracts/src/model/index.ts:692` | `preserveProviderStreamBoundaries?: boolean;`（注释提到「compact 隐藏流用它保留首个真实 provider event」） |
| core 侧旁路原语 | `apps/zcode-cli/packages/core/src/runtime/methods/sidecar-model-request.ts:30` | 可选 |
| adapters 侧 | `apps/zcode-cli/packages/adapters/src/model/runner-runtime.ts:46` | 可选 |
| **包内硬约束** | `apps/zcode-cli/packages/magic-context/src/host/hidden-completion-executor.ts:81` | `preserveProviderStreamBoundaries: true;` —— `SidecarModelCallOptions` 上的**必填字面量成员**（`:27-33,67` 注释说明这是刻意的编译期栅栏）；实际传参在 `:339` |

传递链消费者（adapters/out-of-scope 包）：`runner-stream.ts:345,402,446,470,479,660,810,970,972,1000,1017,1026,1043,1184,1343,1347,1362,1368,1371,1389,1394,1408,1428,1443`；`runner-options.ts:153`（`includeRawChunks`）；`runner-generate.ts:231`；`bootstrap/src/app/magic-context-historian.ts:207`。
栅栏测试：`apps/zcode-cli/packages/magic-context/scripts/test-historian.mjs:348-395`（断言「falsify 该字段必须编译失败」，`:363` 用 `const falsified: SidecarModelCallOptions = { preserveProviderStreamBoundaries: false };` 做负例）与 `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-historian.mjs:226-286`。

### 3.3 `context-usage-log-compact.ts` — 存活

- 文件存在：`apps/zcode-cli/packages/core/src/runtime/methods/context-usage-log-compact.ts`，107 行。
- 唯一导出 `compactContextUsageSnapshot`（`:3`），是 context-usage 日志快照的**字段白名单投影**（`pickDefined` + `arrayLength`，`:78`/`:101`；`compactCategoryBreakdown` `:24`，top contributor 上限 5 见 `:1`）。
- 消费者：`apps/zcode-cli/packages/core/src/runtime/methods/context-usage.ts:19`（import）、`:55`（`...compactContextUsageSnapshot(snapshot),`）。
- 与 S26 无关（不是对话压缩），在 BASE..HEAD 未变更。

### 3.4 `formatCompactToken*` — 存活（两个不同名字）

| 符号 | file:line | 消费者 |
|---|---|---|
| `formatCompactTokenCount` | `apps/zcode-cli/packages/tui/src/app-input-status.tsx:277`（定义） | 同文件 `:181`（`usedLabel = formatCompactTokenCount(used)`） |
| `formatCompactTokens` | `apps/zcode-cli/packages/magic-context/src/core/shared/window-geometry.ts:718`（定义） | 同文件 `:715`（在 `window ${…} · reserve` 那条几何摘要串里，3 次调用） |

两者均在范围外包（tui / magic-context），BASE..HEAD 无变更。

### 3.5 品牌改名波及面（S32/S33，`.zcode` → `.omz`）

改名集中在**用户级数据根**，工作区级 `.zcode` 约定目录刻意保留（`adapters/src/commands/roots.ts:10-14`、`adapters/src/skills/roots.ts:10-14` 各引入 `USER_ZCODE_DIR = ".omz"` 与 `WORKSPACE_ZCODE_DIR = ".zcode"` 两个常量）。

用户级落点改动（HEAD 值）：

| 落点 | file:line |
|---|---|
| `~/.omz/cli/db/db.sqlite` | `adapters/src/storage/session-store/paths.ts:7` |
| `~/.omz/cli/config.json`（默认 base dir） | `adapters/src/config/file-config.adapter.ts:75` `DEFAULT_BASE_DIR = "~/.omz/cli"`；`adapters/src/storage/workspace-hook-trust-store.ts:135,140` |
| `~/.omz/cli/log` | `adapters/src/logging/index.ts:223` |
| `~/.omz/cli/exec`（storage root 兜底） | `adapters/src/exec/execution-utils.ts:19` |
| `~/.omz/cli/debug` / `rollout` | `adapters/src/model/runner-debug.ts:590` |
| `~/.omz/cli/workflows` | `adapters/src/workflow/index.ts:35` |
| `~/.omz/v2/credentials.json` | `adapters/src/auth/shared-credentials.ts:289` |
| `~/.omz/v2/telemetry-state.json` | `adapters/src/device/cli-device-mid.ts:60` |
| `~/.omz/AGENTS.md` | `adapters/src/context/index.ts:237` |
| `DefaultRuntimeConfig.storage.dir / sessionDbPath` | `contracts/src/config/index.ts:335-336` |
| `ZCODE_AGENT_RUNTIME.nativeConfigDir` | `packages/shared/src/zcode-agent-runtime.ts:32` |

官方 marketplace id 改名 `zcode-plugins-official` → `oh-my-zcode-official`：

| 落点 | file:line |
|---|---|
| contracts 常量 | `contracts/src/plugins/index.ts:7` |
| shared 常量 | `packages/shared/src/plugin-marketplaces.ts:10`（`ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID`）+ `:13-24` 的 `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS` 11 个 id 全量改写 |
| shared CUA id | `packages/shared/src/mcp.ts:10` |
| adapters CUA 常量 | `adapters/src/config/schema.ts:195-196`（`LEGACY_CUA_PLUGIN_ID` / `CANONICAL_CUA_PLUGIN_ID`） |
| **兼容别名** | `adapters/src/plugins/official-marketplace.ts:122-129` — `assertOfficialManifest` 额外接受旧名 `"zcode-plugins-official"`，注释解释 D-2 CDN 端点保留旧名发布 |

---

## 4. S29 / S30 新增 schema

### 4.1 `workspace/updateMagicContextConfig` + `workspace/readMagicContextConfig`（Step 29 / D-12）

方法名登记：`packages/shared/src/zcode-protocol/index.ts:3615`（`"workspace/updateMagicContextConfig"`）、`:3618`（`"workspace/readMagicContextConfig"`）。RPC 派发：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts:85`（import）、`:629-630`（update）、`:633-634`（read）。

四个 zod 形状（全部 `.strict()` 信封 + `config: z.unknown()` 载荷）：

```
// index.ts:2146-2154  params
z.object({ workspace: zcodeWorkspaceRefSchema, config: z.unknown() }).strict()

// index.ts:2156-2185  result
z.object({
  workspace: zcodeWorkspaceRefSchema,
  path: nonEmptyString,          // 写盘目标（用户级 config.json）
  changed: z.boolean(),          // 幂等重写为 false
  applied: z.literal(true),      // ConfigPort 已接受
  config: z.unknown(),           // **effective 域**（schema 规范化后、写盘的那一份）
}).strict()

// index.ts:2194-2198  read params
z.object({ workspace: zcodeWorkspaceRefSchema }).strict()

// index.ts:2201-2215  read result
z.object({ workspace: zcodeWorkspaceRefSchema, path: nonEmptyString, config: z.unknown() }).strict()
```

**⚠ 协议层零字段声明**：`config` 两侧都是 `z.unknown()`，不校验 `isJsonValue`。四条注释（`:2133-2145`、`:2159-2177`、`:2187-2193`、`:2202-2214`）给出的理由一致：权威结构只有 `@zcode/magic-context` 的 `MagicContextConfigSchema` 一份，`@zcode/shared` 是包的下游，复制字段表=第二份真相。字段级校验落在 CLI 侧 handler（`bootstrap/src/zcode-protocol/magic-context-config.ts:122-129`，失败抛 `-32602 ProtocolRequestError`）。

**读写不对称（有意，记录在案）**：
- update 的 result 有 `changed` + `applied: z.literal(true)`，read 的 result **没有** `applied`；
- update 回 `parsed.data`（effective 域，`magic-context-config.ts:167`），read 的 ConfigPort 路径（`:83`）**不回 schema parse**，直接把 `configPort.get(ConfigKey.MagicContext)` 的原值塞进 `config: z.unknown()`；只有文件兜底路径（`:95`）才 `MagicContextConfigSchema.parse(...)`。两条路径在 `config` 的形状保证上不等价（一个过 schema、一个不过）。
- handler 自己声明的读侧前提（`magic-context-config.ts:77-79` 注释）：「ConfigPort 的 MagicContext 域**恒有值**（注册时就把 `.default()` 解析结果钉进去了），所以这里不需要再兜一层 undefined」。**该前提经核实成立**：`ConfigPortImpl.get`（`adapters/src/config/index.ts:254-263`）在 store miss 时查 `getDefaultValue`，而 `case ConfigKey.MagicContext: return DEFAULT_MAGIC_CONTEXT_CONFIG;`（`:427-428`）已登记 → 不抛 `Config key not found`。
- `readMagicContextConfig` 的「ConfigPort 优先、文件兜底」顺序注释在 `:57-64`；「无活动 session ⇒ 读文件 = 下次 createConfig 会读到的同一份」。

### 4.2 `sessionUsageStateSchema.magicContext`（Step 30 / D-13，additive）

`packages/shared/src/zcode-protocol-v4/snapshot.ts`：

```
:194  sessionMagicContextCacheSchema = z.object({ m0: z.boolean(), m1: z.boolean() })   // 非 strict
:217  sessionMagicContextUsageSchema = z.object({
        budgetTokens:       z.number().int().nonnegative().nullable(),
        usedTokens:         z.number().int().nonnegative(),
        usedPercent:        z.number(),
        compartmentCount:   z.number().int().nonnegative(),
        droppedTagCount:    z.number().int().nonnegative(),
        droppedTagTokens:   z.number().int().nonnegative(),
        cache:               sessionMagicContextCacheSchema.nullable(),
      })                                                                              // 非 strict
:228  sessionUsageStateSchema = z.object({ ... })
:245    magicContext: sessionMagicContextUsageSchema.optional(),   // ← 唯一新增键
```

同一对象内的**同期删除**：`sessionUsageStateSchema.contextWindow` 删 `autoCompactThresholdTokens: z.number().nullable()`（原 `:186` 附近）。全仓 `rg autoCompactThresholdTokens`（排除 dist/node_modules/bundled-agents）→ **0 命中**，删除无悬挂读点。

语义注释要点（`snapshot.ts:186-244`）：
- `cached_m0_bytes`/`cached_m1_bytes` 是「逐块布尔」，不是命中率（包侧无累计计数器）。
- `budgetTokens` 的 `null` = 这条会话从未冻结底线；`usedTokens`/`usedPercent` 与 `contextWindow` 是**两把尺子**（前者量 MC 预算，后者量 provider 窗口）。
- `cache: null` = 读不到该行。
- 缺席（`usage.magicContext === undefined`）= 关着 / 没读数，**不是**全零；UI 遇到缺席必须整段不渲染。

**additive 的镜像语义落在 delta.ts**（该文件 BASE..HEAD **未变更**，语义天然继承）：

```
packages/shared/src/zcode-protocol-v4/delta.ts:38
  // StatePatch：键级整体替换（Object.assign），键集合封闭。键内绝不深合并。
packages/shared/src/zcode-protocol-v4/delta.ts:48
  usage: sessionUsageStateSchema.optional(),
```

即 `usage` 是一个**整键替换**的封闭槽：`usage` 一旦出现在 patch 里，其内部**所有**键（含 `magicContext`）以本 patch 的 `usage` 对象为准，接收端做 `Object.assign(currentUsage, patch.usage)`。因此：

- **省略即删除**。投影层为此专门绕路：`bootstrap/src/zcode-protocol-v4/product-projection.ts:404-408` `magicContextUsageField()` 用 `usage === undefined ? {} : { magicContext: usage }` 做显式 spread（注释 `:398-403`：`magicContext: undefined` 在 JSON 序列化后同样消失，但**在内存里会让 `usage.magicContext !== undefined` 判据说谎**）。
- **移除语义**：`product-projection.ts:743-755` `applyMagicContextUsage(null | undefined)` → `const { magicContext: _dropped, ...rest } = this.snapshot.usage; return [{ op: "state.updated", patch: { usage: rest } }]`（注释 `:737` 明确「缺席语义 = **移除**键，而不是写一份全零对象」）。
- **两条冷恢复种子路径**：`product-projection.ts:699` 与 `:723` 各有一行 `...magicContextUsageField(current.magicContext)`，注释分别为 `:698`（「冷恢复种子只管 token 水位，不得顺手抹掉已经下发的 magic-context 摘要」）与 `:722`。
- **conflation**：`product-projection.ts:410-411` `sameMagicContextUsage` 逐字段相等（含 `cache` 的两个布尔）才视为「没变」；`:751` 命中即 `return []` 不发空 patch（注释 `:740-741` 理由：`usage` 是本投影最高频的键之一）。

### 4.3 Step 21 ctx 工具声明面 + Step 22 `/ctx-*` 帮助条目

`apps/zcode-cli/packages/contracts/src/tools/ctx-context.ts`（新增，95 行），经 `contracts/src/tools/index.ts:30-33` 的 barrel 转出（带 3 行「漏掉这行消费方拿不到…」的注释）：

| 导出 | 行 | 形态 |
|---|---|---|
| `CTX_REDUCE_TOOL_NAME = "ctx_reduce"` / `CTX_EXPAND_TOOL_NAME = "ctx_expand"` | `:24-25` | 字符串常量 |
| `CTX_REDUCE_DROP_PATTERN` | `:28` | 描述用示例串 |
| `CtxReduceInputSchema` | `:30-38` | `z.object({ drop: z.string().optional() }).strict()` —— **声明层刻意 optional**（注释 `:31-33`：缺失时工具回 `Error: 'drop' must be provided.`，让模型自我纠正，而不是被 provider schema 拒绝后「丢掉这次调用、模型看不到自己错在哪」） |
| `CtxReduceInputJsonSchema` | `:41` | `toToolJsonSchema(...)` |
| `CtxExpandInputSchema` | `:43-79` | `z.object({ tag: z.union([z.number(), z.string()]).optional(), start, end, verbose, message }).strict()`；`tag`/`start`/`end`/`message` 的 describe 反复强调「tag 数每条文本与工具结果、ordinal 数整条消息，二者永不可互换」 |
| `CtxToolTextOutputSchema` | `:87-90` | `z.object({ text: z.string() }).strict()` |

`packages/shared/src/zcode-slash-command-help.ts:194-238` 新增 4 条：`ctx-status`（`:200-211`，只读快照）、`ctx-reduce`（`:212-223`）、`ctx-expand`（`:224-236`）、`ctx-recomp`（`:229-237`），并删掉 `/compact`（原 `:37-43`）。注释（`:195-199`）声明这 4 条是**本地命令**：就地执行、**不发模型提示**，因此不进 App 的 `/` 面板。

`packages/shared/src/test-ids.ts:479-480` 新增 `TID_CHAT_CONTEXT_USAGE_MAGIC_CONTEXT = "chat-context-usage-magic-context"`（注释：字段缺席时该段不渲染，e2e 据此断言）。

---

## 5. queueItemSchema / expectedHeldQueueItemIds —— S26「仅 kind 枚举耦合」复核

### 5.1 复核结论：**成立**（且比原结论更弱一层，见 5.3）

### 5.2 继承链与耦合点

`queueItemSchema`（`packages/shared/src/zcode-protocol-v4/snapshot.ts:250-255`）：

```
export const queueItemSchema = conversationInputIntentSchema.extend({
  dispatch: conversationInputDispatchSchema.extend({
    state: z.enum(["queued", "reserved", "promoting"]),   // 收窄自 intent 的 5 值
  }),
  toolDisallowlist: z.array(z.string().min(1)).optional(),
});
```

唯一的上游耦合点是 `packages/shared/src/zcode-protocol-v4/input-intent.ts:44` 的 `kind: z.enum(["sendText","sendGoalCommand"])`（BASE 时为 3 值含 `"compact"`）。`queueItemSchema` 自身**没有任何 compact 专属字段**。

`conversationInputIntentSchema`（`input-intent.ts:39-66`）的 13 个字段逐条核对：`sourceCommandId`/`queueItemId`/`clientId`/`kind`/`text`/`attachments`/`modelSelection`/`mode`/`planEnabled`/`sharedContextRefs`/`delivery`/`order`/`steer`/`dispatch`/`admittedAt`/`provenance` —— **无一条与 compact 有关**。因此 `queueItemSchema` 的 S26 影响面 = 「旧快照里 `kind: "compact"` 的队列项在 HEAD 下无法通过 schema」这一条，且因 `.strict()`（`input-intent.ts:66`）+ `z.enum` 的组合，走的是 **reject 而非 strip**（详见 6.4）。

`expectedHeldQueueItemIds` 与 compact **零耦合**，可复核为「从来就没有过」：

- 声明两处，均在 `packages/shared/src/zcode-protocol-v4/command.ts`：`sendText`（`:94`）与 `sendGoalCommand`（`:141`），形态同为 `z.array(z.string().min(1)).optional()`。**这两个 `z.object` 都没有 `.strict()`**（对比 `input-intent.ts:66` 有），但也不含任何 compact 分支。
- 消费侧 5 处（全部在范围外 bootstrap）：`commands/handlers/session-flow.ts:231,248`、`commands/handlers/goal.ts:108,122,134`。`goal.ts:129-135` 的 `applyHeldQueueDisposition(host, record, heldQueueDisposition, expectedHeldQueueItemIds)` 注释明写「held choice 裁决（同 sendText；sendGoalCommand）」——**同一套裁决同时服务两个命令，从设计上就没把 compact 算进去**。
- BASE..HEAD diff 里 `command.ts` 只动了 `:144-149` 删 `compact: z.object({})` 一个键，`expectedHeldQueueItemIds` 两行**未出现在 diff 中**。

**「互斥现状」**：`command.ts:112-133` 的 `sendText` `.superRefine` 里三条互斥/依赖约束分别是 `automationId ⊥ offPeakTaskId`、`offPeakRunType → offPeakTaskId`、`modelExecution → modelSelection` —— **无一条与 compact 有关**。原 BASE 版本里也不存在 compact 相关的 superRefine 条目（diff 未触及该块）。即：**删掉 `compact` 命令键没有引发任何互斥关系需要重新表述**。

### 5.3 一处比原结论更弱的观察

`queueItemSchema` 的 `dispatch` 子对象把 state 收窄为 `["queued","reserved","promoting"]`，而 `conversationInputDispatchSchema`（`input-intent.ts:32-37`）是 `["admitted","queued","reserved","promoting","drained"]`。这个收窄与 compact 无关，但意味着：**一个 BASE 时期 `kind: "compact"` 的队列项在 HEAD 下有两处独立的失败点**（`kind` 枚举不含 `compact`；`dispatch.state` 若为 `admitted`/`drained` 也不被 `queueItemSchema` 接受），而 `queueItemSchema` 只在 `snapshot.ts:259` 的 `queueStateSchema.items` 一处被消费；`conversationSnapshotSchema:532` 里 `queue: queueStateSchema` 是**必填**（对比 `meta` 用 `.default(...)`、`sharedContextImport` 用 `.optional()`，见 `snapshot.ts:525,527`）。

---

## 6. 可疑点清单（只登记，不下结论）

### 6.1 【格式破损】adapters/src/config/schema.ts:434-436 缩进丢失

```
433   if (parsed.features) config.features = parsed.features;
434 if (parsed.memory) config.memory = parsed.memory;         ← 顶格
435 if (parsed.magicContext) config.magicContext = parsed.magicContext;  ← 顶格（本次新增）
436 if (parsed.mcp) config.mcp = parsed.mcp;                 ← 顶格
437   if (parsed.plugins) config.plugins = normalizePluginConfig(parsed.plugins);
```

可疑原因：`:433` 与 `:437` 保持 2 空格缩进，中间三行被压到列 0。这不是 prettier/oxlint 会产出的形态，说明该 hunk 是手工编辑或格式化被跳过。纯观感问题，但同 hunk 正是 `magicContext` 的接入点，值得确认是否还有别的行被同样处理而未被本次 diff 暴露。

### 6.2 【死代码 / 误导】contracts/src/config/index.ts:170-172 的条件分支两臂相同

```
170  : K extends "magicContext"
171    ? unknown
172    : unknown;
```

`ConfigValue<"magicContext">` 因此**类型上完全等价于** `:172` 的兜底 `unknown`。代码注释（`:94-110`）自陈这是**为了可 grep** 而刻意写的冗余分支。可疑点：
- 代价是条件类型链末尾出现两臂恒等的分支，任何未来在此之后新增分支的人都要先判断这一段是不是「装饰」；
- 它没有兑现注释里说的「让承载类型是刻意的选择」——类型系统看不出区别，只有 grep 看得出。

### 6.3 【类型缺口】`unknown` 一路透传到 UI 才收窄

链路：`RuntimeConfig.magicContext?: unknown`（contracts `config/index.ts:261`）→ `RuntimeConfigPatch.magicContext?: unknown`（`:298`）→ `ConfigPort.get(ConfigKey.MagicContext): unknown`（`ConfigValue<"magicContext">` = `unknown`）→ 协议 `config: z.unknown()`（shared `index.ts:2149,2179,2211`）→ UI `packages/ui/src/settings/MagicContextSettingsSection.tsx:75` `const [baseConfig, setBaseConfig] = useState<unknown>(null)`。

UI 侧的收窄是**运行时的手写守卫**，不是类型：`packages/ui/src/settings/magicContextSettingsForm.ts:115-145` `buildMagicContextConfigFromForm(base: unknown, form)` 用 `isRecord(base) ? { ...base } : {}` + 逐字段覆写，最终返回 `JsonRecord`。可疑原因：
- 该函数**手写了一遍字段表**（`enabled`/`execute_threshold_percentage`/`history_budget_percentage`/`cache_ttl`/`smart_drops`/`fail_closed_blocking`/`execute_threshold_tokens` 共 7 个键），与 `MagicContextConfigSchema` 的 10 键白名单是**两份独立清单**；schema 加字段时 UI 侧不会报错，只会静默沿用 `{...previous}` 保留旧值——而 update 是整域覆盖语义（见 6.5），保留旧值恰好是想要的，但这靠的是「previous 里有它」这个巧合，不是显式声明。
- 该文件在 BASE..HEAD 未变更，不属本次范围，但它消费的是本次新增的协议面。

### 6.4 【strip vs reject 不一致】同一份 config.json 有三种键处理策略

| 层级 | file:line | 策略 |
|---|---|---|
| 顶层 `ZCodeConfigFileSchema` | `adapters/src/config/schema.ts:307,328` | **`.passthrough()`** —— 未知顶层键**保留**（写回时原样带回） |
| `features` / `memory` / `magicContext` 子对象 | 同文件 `:38` / `:47` / `:65`（`MagicContextConfigSchema.optional()`） | 普通 `z.object` → 未知键 **strip** |
| `mcp`（`mcpServerBaseSchema`）与 `hooks` | 同文件 `:83` / `:305` 等 10 处 `.strict()` | **reject**（未知键直接报错，见 `:66` 注释「配置入口漏掉该字段会因 strict 校验丢弃整个 server」） |

可疑原因：同一个文件、同一次装载里三种策略并存，且 `magicContext` 走的是 strip 一档。这意味着**一个写错位置的 magicContext 字段会被静默丢弃**，而同样的笔误若落在 `mcp.servers.*` 上会硬报错。S16 测试（`adapters/scripts/test-magic-context-domain.mjs:146`「fork-excluded keys are stripped rather than carried to runtime」）确认 strip 是**刻意**选择，但「刻意」只覆盖了 magicContext 一处，与文件其余部分的策略张力仍在。

### 6.5 【向后兼容缺口 A】协议层 `config: z.unknown()` 无形状约束 + 整域覆盖 = 缺字段即清空

`workspace/updateMagicContextConfig` 的语义是**整域替换**（shared `index.ts:2143-2145` 注释、handler `magic-context-config.ts:164-167`）。但：
- `config: z.unknown()`（`index.ts:2149`）**允许 `undefined`**（zod 的 `z.unknown()` 隐含 optional），因此 `{ workspace }` 不带 `config` 也是合法 params；
- handler 的兜底是 `params.config ?? {}`（`magic-context-config.ts:122`），`MagicContextConfigSchema.safeParse({})` 走 `.default()` 产出**全默认域**；
- 于是：**一次漏传 `config` 的调用会把用户整份 magic-context 配置静默重置为默认值**，并写盘（`:132`）、推送（`:147`）、返回 `changed: true` + `applied: true`。

handler 侧对此**没有任何防护**（无「params.config 必须存在」的前置检查）。协议注释承认了「调用方漏传一个可选字段就等于把它重置成默认值」的风险（`index.ts:2170-2177`）但只针对**域内可选字段**，未覆盖**整个 `config` 缺席**这一情形。

### 6.6 【向后兼容缺口 B】`.strict()` + 枚举收窄 ⇒ 旧快照/旧事件被 reject 而非 strip

S26 在多处删的是 **`.strict()` 对象里的可选键或枚举成员**，这走的是 zod 的 reject 分支：

| schema | file:line | strict？ | 旧数据后果 |
|---|---|---|---|
| `zcodeMessagePartSchema`（`z.discriminatedUnion("type", …)`） | `packages/shared/src/zcode-protocol-legacy-types.ts:346` | 每个成员 `.strict()`（`:355,362,371,380,383,392,393,400,411,412,419`；timeline 成员 `:401` 引用的 `zcodeTimelinePartSchema` 自身在 `:345` 也是 `.strict()`） | BASE 快照里的 `{ type: "compaction", … }` part **无法匹配任何成员 → 整条 parse 失败** |
| `zcodeTimelinePartSchema.timelineType` | 同文件 `:313`（对象 `:310-345`，末尾 `.strict()`） | `.strict()` | `timelineType: "context_compaction"` 被 enum **reject**（该字段必填，不是 optional）；同时被删的 9 个 compact 字段在旧数据里成为多余键 → 也被 strict 拒绝 |
| `zcodeSessionRuntimeStateSchema.activeTurnKind` | 同文件 `:491` | — | `"compact"` 被 enum reject |
| `checkpointCreatedPayloadSchema` | `contracts/src/rewind/index.ts:43,54` | `.strict()` | 旧 payload 带 `compactBoundaryId`/`coveredByCompact` → **reject** |
| `rewindTriggeredPayloadSchema` | 同文件 `:65,83` | `.strict()` | 旧 payload 带 `compactBoundaryId` → **reject** |
| `zcodeSessionStateSnapshotSchema` / `zcodeMessageUpsertedEventPayloadSchema` | `packages/shared/src/zcode-protocol/index.ts:978-979` / `:1225-1229` | 内层 `.strict()` | 同上 |

对照：同一次改动里 `sessionActionAvailabilitySchema`（`snapshot.ts:149-157`）删 `compact` 键但**不 strict** → 旧快照的该键被 strip，安全。这说明作者对「删键」的风险有意识，但在 strict 对象上做的同一件事就是硬拒绝。BASE..HEAD 的 diff 中**没有出现任何 `.catch()`/`.or()`/迁移 shim** 来承接这些旧值。

### 6.7 【向后兼容缺口 C】品牌改名无迁移路径，两处单向别名

- marketplace：`contracts/src/plugins/index.ts:7` 改为 `"oh-my-zcode-official"`，`packages/shared/src/plugin-marketplaces.ts:10,13-24` 的 `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS` 11 个 id 全量改写。仅有的兼容是 `adapters/src/plugins/official-marketplace.ts:122-129` **接受旧 manifest 名**（单向：只放宽校验，不做 id 重写）。可疑点：用户 `config.json` 里 `plugins.enabledPlugins` 存的旧 id（`…@zcode-plugins-official`）没有对应的 canonicalize 逻辑——`adapters/src/config/schema.ts:198` 的 `canonicalizePluginId` **只覆盖 CUA 一对**（`zcode-cua@zcode-plugins-official` → `computer-use@oh-my-zcode-official`）。
- 缓存目录：`packages/shared/src/node/officialPluginCache.ts:13` 的文档改为 `<plugins storage>/cache/oh-my-zcode-official/<name>/<version>/`，但**扫描代码未在本 diff 内**（该文件只改了注释，1 行）。已有用户磁盘上的 `cache/zcode-plugins-official/` 是否仍被扫到，无法从本 diff 判定——文档与代码行为可能已经不一致。
- 数据目录：`~/.zcode` → `~/.omz` 是**新起不迁移**（`adapters/src/commands/roots.ts:10-11` 注释明写）。对已有用户 = 凭据、db、日志、telemetry、credentials 全部「消失」。这条是设计决策而非缺陷，但**没有任何 in-repo 提示/迁移代码**被本 diff 触及。

### 6.8 【一致性】workflow 目录常量与文档注释三处不一致

同一语义（saved-workflow 的 project scope 落点）在 HEAD 有三个不同答案：

| 位置 | 说的落点 |
|---|---|
| `contracts/src/tools/saved-workflow.ts:19` `SAVED_WORKFLOW_PROJECT_DIR` | `".zcode/workflows"`（**代码，本次未改**） |
| 同文件 `:43-46` 注释 | 「项目档落在项目的 `.omz/workflows/`」（**本次改了**） |
| `packages/shared/src/zcode-protocol/index.ts:2729` 注释 | 「项目档落 `<cwd>/.omz/workflows/`」（**本次改了**） |

可疑原因：本次 diff 只改了 `SAVED_WORKFLOW_GLOBAL_DIR`（`:31` → `".omz/workflows"`），把两处注释也一并改成 `.omz`，却漏掉 `SAVED_WORKFLOW_PROJECT_DIR` 与 `WORKFLOW_DRAFTS_DIR`（`:25`，仍 `".zcode/workflow-drafts"`）。若 project scope 应当跟随仓库约定目录（对照 `adapters/src/commands/roots.ts:12-14` 明确把 `WORKSPACE_ZCODE_DIR = ".zcode"` 留在工作区级），则**注释是错的**；若应当统一到 `.omz`，则**常量是错的**。当前状态无法自证。

### 6.9 【不一致】read 路径不过 schema，update 路径过

`magic-context-config.ts:83` 的 ConfigPort 分支把 `configPort.get(ConfigKey.MagicContext)` 直接塞进 `config: z.unknown()`（**零校验**），而 `:95` 的文件兜底分支做了 `MagicContextConfigSchema.parse(...)`。注释 `:77-79` 只论证了「不会 undefined」，未论证「形状一定对」。可疑原因：形状保证在两条路径上不等价；若某处 `configPort.set(ConfigKey.MagicContext, …)` 绕过 schema（`ConfigPort.set` 是公开 API，`adapters/src/config/index.ts` 无任何运行时校验），read 就会把未规范化对象回给 UI。update 路径靠 handler 主动 `safeParse` 兜住，read 路径没有任何等价兜底。

### 6.10 【z.unknown 滥用面统计】

`packages/shared/src/zcode-protocol/index.ts` 中 `z.unknown()` 共 **27 处**（`:85,290,299,308,320,883,959,1092,1186,1225,1226,1279,1343,1358,1359,1375,1442,1968,1995,2077,2149,2179,2211,2297,2374,2376,2708,2881`）。其中 **3 处是本次新增**（`:2149` update params、`:2179` update result、`:2211` read result 的 `config`）。其余 24 处是 BASE 既有（多为 tool input/output 的开放 JSON）。

可疑点：这三个 `config: z.unknown()` 是**唯一被 UI 当作结构化对象消费**的 `z.unknown()`（其余多为 tool payload，UI 只透传给模型）。也就是说，在一个已经因为 `z.unknown()` 而没有静态类型的面上，又叠加了「整域覆盖」的破坏性写语义（6.5）。

### 6.11 【测试覆盖缺口】

新增的两个测试脚本（`adapters/scripts/test-feature-flag.mjs` 14 个 test、`adapters/scripts/test-magic-context-domain.mjs` 17 个 test）覆盖面很密，但：
- `test-magic-context-domain.mjs` 的 17 个用例全部围绕 schema/写盘/ConfigPort 可见性，**没有一个覆盖「调用方漏传 `config`」**（6.5 的场景）；
- `:329`「a malformed domain keeps last-known-good instead of disabling the feature」测的是 **config bridge 的 reload 失败**路径，不是 RPC update 的 `safeParse` 失败路径（后者抛 `-32602`，是拒绝而非 last-known-good）；
- `test-feature-flag.mjs:203`「the retired features.compact key is absent from every config surface」断言 `"FeatureCompact" in ConfigKey === false`，但**没有**断言 `features.compact` 在 `getAll()` 输出、文件回写、或 `RuntimeConfig` 类型上的消失面。

### 6.12 【死分支 / 悬空常量】`RewindStrategy.FileOnly` 及其 4 个消费点

见 1.5 末尾。补充：删掉 `target_covered_by_compact_file_only_available` 分支后，`rewind/index.ts:29` 的 `FileOnly` 成员**在本文件内已无任何产生点**（全仓唯一产生点是 core 的 `ForkRequired` 三处，与之无关）。4 个比较点（`core/.../rewind.ts:246,327`、`rewind-message.ts:252,352`）因此成为恒假条件。可疑原因：`RewindTargetStatus` 被同步收窄为 2 值（`rewind/index.ts:36-39`），说明作者**打算**清理枚举，但 `RewindStrategy` 没有一起收。

---

## 7. diff 统计（本范围）

`git diff --shortstat 1fa2d0e..aba59a9 -- apps/zcode-cli/packages/contracts packages/shared apps/zcode-cli/packages/adapters`

```
62 files changed, 1129 insertions(+), 830 deletions(-)
```

按根分：

| 根 | files | + | − |
|---|---|---|---|
| `apps/zcode-cli/packages/contracts` | 15 | 156 | 595 |
| `packages/shared` | 23 | 220 | 176 |
| `apps/zcode-cli/packages/adapters` | 24 | 753 | 59 |

改动量排序（`+`/`−`，改动行数 = 两者之和，降序，取前 22）：

| # | file | + | − | 归类 |
|---|---|---|---|---|
| 1 | `adapters/scripts/test-magic-context-domain.mjs` **(A)** | 358 | 0 | S23 新测试 |
| 2 | `contracts/src/compact/index.ts` **(D)** | 0 | 353 | S26 全量删除 |
| 3 | `adapters/scripts/test-feature-flag.mjs` **(A)** | 207 | 0 | S28/S26 新测试 |
| 4 | `packages/shared/src/zcode-protocol/index.ts` | 94 | 31 | S26 删 session/compact + S29 加 2 组 schema |
| 5 | `adapters/src/config/file-config.adapter.ts` | 76 | 1 | S23 写盘 |
| 6 | `contracts/src/interfaces/session-store.port.ts` | 0 | 60 | S26 编辑型 |
| 7 | `packages/shared/src/zcode-protocol-v4/snapshot.ts` | 45 | 4 | S30 additive + S26 删 4 处 |
| 8 | `packages/shared/src/zcode-slash-command-help.ts` | 44 | 7 | S22 加 4 条 / 删 /compact |
| 9 | `contracts/src/config/index.ts` | 42 | 7 | S26 删 compact + S23 加 magicContext |
| 10 | `packages/shared/src/zcode-task-types-core.ts` | 2 | 40 | S26 编辑型 |
| 11 | `adapters/src/config/schema.ts` | 34 | 5 | S23 + S26 |
| 12 | `adapters/src/config/index.ts` | 33 | 6 | S23 + S26 |
| 13 | `packages/shared/src/zcode-session-visible-content.ts` | 2 | 17 | S26 |
| 14 | `contracts/src/events/event-reducer.ts` | 0 | 14 | S26 |
| 15 | `contracts/src/events/event-reducer-helpers.ts` | 0 | 32 | S26 |
| 16 | `contracts/src/rewind/index.ts` | 6 | 83 | S26（本范围第二大删除） |
| 17 | `contracts/src/tools/ctx-context.ts` **(A)** | 95 | 0 | S21 新声明面 |
| 18 | `packages/shared/src/zcode-protocol-legacy-types.ts` | 2 | 25 | S26 |
| 19 | `packages/shared/src/plugin-marketplaces.ts` | 11 | 11 | S32 改名 |
| 20 | `packages/shared/src/zcode-protocol-v4/rows.ts` | 1 | 10 | S26 |
| 21 | `adapters/src/storage/session-store/sqlite-session-store.ts` | 0 | 21 | S26 两处分支 |
| 22 | `contracts/src/events/session.events.ts` | 2 | 30 | S26 |
| — | `contracts/package.json` | 0 | 4 | 删 `./compact` export |
| — | `contracts/src/index.ts` | 0 | 3 | 删 barrel |
| — | `contracts/src/tools/index.ts` | 4 | 0 | 加 barrel |
| — | `adapters/package.json` | 2 | 0 | 加 `@zcode/magic-context` 依赖 + test script |
| — | `packages/shared/src/test-ids.ts` | 2 | 4 | 删 2 个 compact tid + 加 1 个 mc tid |
| — | `packages/shared/src/zcode-protocol-v4/{command,fork,input-intent}.ts` | 5 | 7 | S26 |
| — | `contracts/src/{hooks,plugins,session.port,saved-workflow}.ts` | 7 | 9 | S26 + S32 |

其中变更行数 ≤ 4 的「纯路径/注释改名」文件共 **17 个**（`adapters/src/{auth/shared-credentials,context/index,device/cli-device-mid,exec/execution-utils,logging/index,mcp/network,skills/index,skills/scan,storage/session-store/paths,storage/workspace-hook-trust-store,workflow/index}.ts`、`contracts/src/{hooks/index,plugins/index}.ts`、`packages/shared/src/{channels,mcp,node/officialPluginCache,onboardingRecord,platform,protocol,runtimeEnv,skill-scan-policy,skills-types,zcode-agent-runtime}.ts` 中的 1–4 行项，以及 `config-factory.ts` 的 2 处注释），全部属于 S32 品牌改名（`.zcode` → `.omz` / `zcode-plugins-official` → `oh-my-zcode-official`），无一涉及行为面。

---

## 附：本节点覆盖度自述

- **已逐文件过**：62 个变更文件中，31 个被展开到逐行 diff（上表前 22 + 尾部 7 组），其余 17 个确认为纯改名/注释行并给出归类。
- **只取证未改码**：本次仅写本文件；未对 `omz` 工作树做任何写操作（所有核实命令为 `git diff` / `rg` / 只读 `Read`）。
- **跨包追踪**：对范围外文件（`bootstrap`、`core`、`tui`、`magic-context`、`ui`、`packages/services`）只做**只读引用追踪**，用于判断本范围改动是否留下悬挂消费方；这些文件本身不在 CR 评估面内。