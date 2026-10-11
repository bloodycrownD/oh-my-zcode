# CR v010 Evidence — evidence-mc-host-integration（wave-1 重派）

- head_sha: aba59a9
- base_sha: 1fa2d0e
- 节点: evidence-mc-host-integration
- 范围:
  - `apps/zcode-cli/packages/magic-context/src/host/**`
  - `bootstrap/src/app/magic-context-{historian,scheduler,config-bridge,usage-summary}.ts`
  - core mcTransform 接线（turn-loop.ts 插入段 / magic-context-turn-transform / source.ts magic_context 源）
  - `core/src/runtime/methods/sidecar-model-request.ts`（S25 更名产物）
  - ctx 工具/命令（core tool handlers ctx-*、cli handlers/ctx.ts）
- 参考: spec Steps 17/19b/20/21/22/25、iteration-state phase2a/2b 节、UPSTREAM-SYNC.md
- 状态: 已完成（六节全部落盘）

## 1. 装配链完整性

路径基线（HEAD=aba59a9 实际落点，与节点描述里写的 `bootstrap/src/app/magic-context-scheduler.ts`、`magic-context-config-bridge.ts` **不同名**）：
- 装配层只有 3 个文件：`bootstrap/src/app/magic-context-historian.ts`、`magic-context-turn-transform.ts`、`magic-context-usage-summary.ts`
- config-bridge 在**包内**：`magic-context/src/host/config-bridge.ts`（不在 bootstrap）
- 调度器在**包内**：`magic-context/src/core/features/magic-context/historian-scheduler.ts`（包内另有 `scheduler.ts`，那是 per-session transform scheduler，不是 historian 调度器，见该文件 :1-13 的 FORK-NOTE(S20)）

### 1.1 create-app 的 historian 装配条件

| 位置 | 事实 |
|---|---|
| `bootstrap/src/app/create-app.ts:778-781` | `const magicContextAssembly = runtimeConfig.magicContext?.enabled === true ? await import("./magic-context-turn-transform.js") : undefined;` — **严格 `=== true`** |
| `:782-785` | `magicContextUsageRecorder = magicContextAssembly?.createMagicContextUsageRecorder(sessionId, logger)` |
| `:786-820` | `magicContextTurnTransform = magicContextAssembly ? await …createMagicContextTurnTransform({ enabled: true, configPort: configResult.configPort, configDomain: config.magicContext, sessionId, workingDirectory, sessionStore, logger, onMagicContextUsage?, createSidecarModel, traceContext, usageRecorder? }) : undefined` |
| `:881-886` | `eventSink: composeMagicContextUsageSink(options.eventSink, magicContextUsageRecorder)` |
| `:884-885` | `...(magicContextTurnTransform === undefined ? {} : { magicContextTurnTransform })` — **端口在场即注册**，注释明写「缺席（默认）时 turn-loop 的插入点是纯判空」 |
| `:1106-1110` | `getConfigPort: () => configResult.configPort`（S23/D-12 的内存侧写入入口） |
| `create-app.ts:151-187` | `composeMagicContextUsageSink`：recorder 缺席→原样返回下游 sink；`SessionEventType.ModelComplete && payload.querySource === "main_turn"` 才 `recorder.record({at: new Date(event.timestamp).getTime(), usage})`；整段 try/catch 吞异常 |

历史学家装配本体在 `magic-context-turn-transform.ts:779-794`：`createMagicContextHistorianHost(config, {logger, db, sessionId, workingDirectory, readLiveUsage?, createSidecarModel?, traceContext?})`。

### 1.2 缺省不抛（三条「不装」路径，均只 warn）

- `magic-context-historian.ts:292` — `if (historianModel !== undefined && deps.createSidecarModel !== undefined)`；不成立时 `hiddenCompletionExecutor` 保持 `undefined`
- `:294-310` — 造不出 Model 时只 `deps.logger.warn("… historian model cannot be constructed; historian stays off", {event:"magic_context.historian_model_unavailable"})`，不抛
- `:316` — `runPass` 首行 `if (!hiddenCompletionExecutor) return Promise.resolve("no-op")`
- `:336-337` — `historianScheduler = hiddenCompletionExecutor === undefined ? undefined : createHistorianScheduler({…})`
- `:352` — `/ctx-recomp` runner `if (!hiddenCompletionExecutor) return 0`
- `:362/369` — 返回对象用条件展开（`...(x===undefined?{}:{x})`），字段本身不出现
- `:374` — `shutdown: () => historianScheduler?.shutdown()`
- 上游侧诚实关闭分支：`magic-context-turn-transform.ts:938-941` — `hiddenCompletionExecutor` 缺席则 deps 不带该字段，`historianRunnable: historian.historianRunnable`（false）

### 1.3 turn-loop mcTransform 门控（双层）

- **第一层（装配层）**：`create-app.ts:778` `runtimeConfig.magicContext?.enabled === true`；端口不存在时 core 侧无对象可调
- **第二层（core helper）**：`core/src/runtime/helpers/magic-context-turn-transform.ts:210-211`
  ```
  if (!runtime.magicContextTurnTransform) return input.entries;
  if (runtime.config.magicContext?.enabled === false) return input.entries;
  ```
  第 210 行是端口缺席门（覆盖 flag off），第 211 行是运行中配置热关（Step 23 接 ConfigPort 后的防御）
- **插入点**：`core/src/runtime/methods/turn-loop.ts:112-127`，`const requestEntries = await runMagicContextTurnTransform(this, {entries: providerEntries, model: state.model, sessionId: this.sessionId, workingDirectory: this.workspaceRoot}, traceContextToLogContext(state.turnTraceContext));`
  - 位置在 `providerProjection` / 双投影**之前**（diff 注释：两条投影同源于 requestEntries，必须看到同一份字节）
  - flag off 时返回的就是入参数组本身（逐引用相等）→ Phase 1 行为逐行等价
- 端口字段声明链：`core/src/runtime/types.ts:384`（deps）→ `core/src/runtime/internal.ts:97`（internal deps）→ `core/src/runtime/agent-runtime.ts:169`（private 字段）+ `:296`（`this.magicContextTurnTransform = deps.magicContextTurnTransform`）
- **零包依赖纪律**：`helpers/magic-context-turn-transform.ts` 文件头 `:1-26` + 全文件只有 `import type`（:28-29），不 import `@zcode/magic-context` 任何运行时值
- wire 调试：`MAGIC_CONTEXT_WIRE_DEBUG_ENV = "ZCODE_MAGIC_CONTEXT_DEBUG_WIRE"`（:115），`isMagicContextWireDebugEnabled`（:117），`buildMagicContextWireDebugSnapshot`（:128），`logMagicContextWireSnapshot`（:169）→ `runtime.logger?.info("Magic context wire projection", {event:"magic_context.wire", magicContextOutcome, total, syntheticHeadCount, syntheticHeadPositions, entries})`（:178-189）
- **source.ts magic_context 源**：`core/src/system-reminder/source.ts:57`（`SYSTEM_REMINDER_PER_REQUEST_SOURCES` 内）、`:98`（`NON_MID_CONVERSATION_SYSTEM_SOURCES` 内）、`:186`（`magic_context: descriptor("request_prefix","runtime_local",true,"sr.magic_context")`）；descriptor 注释 :51-56 说明「落点是 attachment 投影，没有登记项会 throw」

### 1.4 fire-and-forget + drain 调度

- **触发点**：`magic-context-turn-transform.ts:832-842` `notifyPassSucceeded(model)`
  - `:835` `historian.noteLiveModel(model)`；`:836` `options.usageRecorder?.noteLiveModel(model)`
  - `:837-839` 注释「fire-and-forget：本行绝不 await」+ `historian.historianScheduler?.notifyTurnSuccess({sessionId})`
  - `:841` `publishUsageSummary()`
- **调用该回调的唯一位置**：`magic-context-turn-transform.ts:1156` `if (port.onPassSucceeded !== undefined) port.onPassSucceeded(input.model);` —— 位于 try 块成功之后、`projectMagicContextEntries` 之后、`return` 之前；`fail_open`（passthrough）与 `lkg_replayed` 走 `handleTransformFailure`（:1139）直接 return，**不会**触发
- **端口注册条件**：`magic-context-turn-transform.ts:843-851` `...(historian.historianScheduler === undefined && options.usageRecorder === undefined ? {} : { onPassSucceeded: notifyPassSucceeded })` —— 两者都不在时挂不上（Step 19b 单测走这条）
- **调度器语义**（`magic-context/src/core/features/magic-context/historian-scheduler.ts`）
  - `:169-191` `notifyTurnSuccess`：`shuttingDown`→noteNoFire("shutdown")；`inFlight.has`→noteNoFire("in_flight") 同步回报；`request.noFireCause`→noteNoFire(cause)；`running` 存在→`pending = acquisition`（最新覆盖未启动的）；否则 `running = run(acquisition)`
  - `:152-166` `run` 循环：process 后 `current = pending; pending = undefined`
  - `:122-150` `process`：in-flight 重复→`noteNoFire("in_flight")`；`await options.runSession(sessionId, shutdownController.signal)`；catch 里 `lastStatus.set(sessionId, shuttingDown ? "aborted" : "error")`，`onError` 再包一层 try/catch（:141-146）
  - `:193-199` `drain()`：`while (running) await running;`
  - `:205-212` `shutdown()`：置 `shuttingDown`、`pending = undefined`、`shutdownController.abort(new Error("historian scheduler shut down"))`
  - `:235-255` `drainHistorianSchedulerWithTimeout(scheduler, timeoutMs = 60_000)`：`null` 时无界等；否则 `Promise.race([drain(), setTimeout])`，timer `unref?.()`，finally clearTimeout
  - `:264-279` `waitForRequestOrShutdown`：`Promise.race([acquisition, abort→undefined])`；文件注释 :257-263 说明 finally 的作用（避免 dangling `.then` 变 unhandled rejection）
- **S24-fix2 的「有界等待」补偿**：`magic-context-turn-transform.ts:986-1007` `HISTORIAN_SETTLE_TIMEOUT_MS = 60_000` + `settleInFlightHistorian(sessionId)`（`Promise.race([active.promise, expired])`，timer `unref`），调用点 `:1137` `await settleInFlightHistorian(sessionId);`（在 transform 成功后、反投影之前）。注释 :970-985 解释「一进程 = 一轮 prompt」导致 fire-and-forget 会随进程消失
- **`/ctx-recomp` runner**：`magic-context-historian.ts:351-358` `setMagicContextRecompRunner(async ({db, sessionId}) => {…await runPass(sessionId, true); return Math.max(0, countCompartments(db, sessionId) - before);})`；`countCompartments`（:383-389）try/catch 返回 0
- **`runOneCompartmentPass`**：`magic-context-historian.ts:401-484` — `:417` `if (getActiveCompartmentRun(input.sessionId)) return "no-op"`；`:424-432` `resolveOpenCodeProtectedTailBoundary({…usage: input.liveUsage})` → `hasRunnableCompartmentWindow` 否决即 `"no-op"`；`:444-473` runnerDeps（含 `:460` `refreshBoundarySnapshot: () => resolveBoundary()`、`forceDrainQuota` 条件展开）；`:475-483` `startCompartmentAgent(runnerDeps)` → `getActiveCompartmentRun` → `await active.promise`，`published ? "success" : "no-op"`，catch→`"error"`

## 2. sidecar 原语链（S25）

### 2.1 更名与产物

`git diff --numstat 1fa2d0e aba59a9`：`48	48	apps/zcode-cli/packages/core/src/runtime/methods/{compact-summary-model-request.ts => sidecar-model-request.ts}` —— git 识别为 rename，内容净变化 0 增 0 删（48 增 48 删 = 纯标识符替换）。

导出面：`core/src/index.ts:186` `export { runSidecarModelRequest } from "./runtime/methods/sidecar-model-request.js";`

### 2.2 `runSidecarModelRequest` 调用方全集

| 位置 | 性质 |
|---|---|
| `core/src/runtime/methods/sidecar-model-request.ts:73` | 定义 |
| `core/src/index.ts:186` | 重新导出 |
| `bootstrap/src/app/magic-context-historian.ts:47` | `import { runSidecarModelRequest } from "@zcode/core";` |
| `bootstrap/src/app/magic-context-historian.ts:199` | **全仓唯一的生产调用点** |
| `core/scripts/test-sidecar-model-request.mjs:67, 199` | Step 25 单测 |
| `bootstrap/scripts/test-magic-context-historian.mjs:97` | 仅注释提及 |
| `magic-context/src/host/hidden-completion-executor.ts:8, 127` | 仅注释提及（不 import core，方向是 core→包） |

即：core 侧 `sidecar-model-request.ts` 里 `compact_stream_boundary` 的消费点唯一（`applySidecarStreamEvent` :112-114 → `applySidecarProviderBoundary` :190-246），包侧不直接依赖 core。

### 2.3 `preserveProviderStreamBoundaries` 全链

| # | 位置 | 形态 |
|---|---|---|
| 1 | `magic-context/src/host/hidden-completion-executor.ts:81` | `SidecarModelCallOptions.preserveProviderStreamBoundaries: true` —— **字面量类型 `true`**（必填成员，文件头 :25-52 说明这是编译期硬约束；理由：S25/26 后上游 `compact-active.ts:401` 已删，仓库里没有第二个 `true` 生产者） |
| 2 | 同上 `:331-339` | 唯一产出点：`slot.attempt = call({run, prompt, abortSignal: slot.controller.signal}, { preserveProviderStreamBoundaries: true })` |
| 3 | 同上 `:130-133` | `SidecarModelCall = (request, options: SidecarModelCallOptions) => Promise<…>`，`options` 非可选 |
| 4 | `bootstrap/src/app/magic-context-historian.ts:207` | `preserveProviderStreamBoundaries: options.preserveProviderStreamBoundaries,` —— 放在 `request` 对象内（`runSidecarModelRequest({logger, model, request: {...}})`），注释 :205-206「硬约束的转手点：包内 executor 传进来的字面量 `true` 原样递给原语」 |
| 5 | `core/src/runtime/methods/sidecar-model-request.ts:30` | `SidecarModelRequest.preserveProviderStreamBoundaries?: boolean` |
| 6 | 同上 `:300-309` | `invocationContext(request)` 返回 `{metadata, modelRequestSessionType, statusSink, traceContext, preserveProviderStreamBoundaries: request.preserveProviderStreamBoundaries, refreshRuntimeHeadersBeforeAttempt}` |
| 7 | 同上 `:275-277` / `:284-286` | `runWithModelInvocationContext(invocationContext(...), () => model.generateText(cleanRequest(...)))`（fallback 路径）与 `…(() => model.streamText(cleanRequest(request)))`（流式路径）**两条都经同一个 `invocationContext`** |
| 8 | `contracts/src/model/invocation-context.ts:29` / `contracts/src/model/index.ts:692` | 契约声明 |
| 9 | `adapters/src/model/runner-runtime.ts:46` | runner 侧 request 字段 |
| 10 | `adapters/src/model/runner-options.ts:153` | `includeRawChunks: input.request.preserveProviderStreamBoundaries ? true : undefined` |
| 11 | `adapters/src/model/runner-stream.ts:345, 402, 446, 470, 479, 660, 810, 970-972, 1000, 1017, 1043, 1132, 1184, 1343-1443` | stream 全链消费 |
| 12 | `adapters/src/model/runner-generate.ts:231` | generate 路径 |

注意第 4 步的类型落差：包侧是字面量 `true`，`sidecar-model-request.ts:30` 声明为 `boolean | undefined`，即**跨包边界处丢失了字面量约束**（`options.preserveProviderStreamBoundaries` 直接赋给可选 boolean 字段）。类型上仍安全（bootstrap 的参数类型来自 `SidecarModelCallOptions`），但 core 侧调用者可以传 `false` 而不报错。

### 2.4 更名后残留检查

`git grep -nE "compact-summary-model-request|compactSummaryModelRequest|CompactSummaryModelRequest"` 全仓命中 **1 处**：
- `apps/zcode-cli/packages/core/scripts/test-sidecar-model-request.mjs:6` —— 注释「本步是一次**纯机械更名**（`compact-summary-model-request.ts` → …）」，是变更说明文本，非代码引用。

其余标识符已统一为 sidecar 语义：类型 `SidecarModelRequest`/`SidecarFinish`/`SidecarStreamState`/`RunSidecarModelRequestInput`（`sidecar-model-request.ts:24, 37, 43, 58`）、函数 `applySidecarStreamEvent`/`applySidecarProviderBoundary`/`handleSidecarStreamFailure`/`sidecarModelStream`/`sidecarStreamResult`/`commitNormalizedContentBlock`/`hasSidecarStopReason`、常量 `SIDECAR_SETUP_ERROR_CODES`（:64）、日志 `event: "sidecar.stream_to_non_stream_fallback"`（:269）。未见 `compact_summary` / `compactSummary` 形式的日志串或 metric 名残留。

## 3. ctx 命令/工具面

### 3.1 ToolEntry

契约面：`contracts/src/tools/ctx-context.ts`（新增 95 行）——`:24` `CTX_REDUCE_TOOL_NAME = "ctx_reduce"`、`:25` `CTX_EXPAND_TOOL_NAME = "ctx_expand"`；文件头 `:2-23` 说明 ctx_reduce 写 `pending_ops` 但属用户显式控制、ctx_expand 纯读。`contracts/src/tools/index.ts:32` 注释提示漏掉 re-export 消费方拿不到常量与 zod 面。

实现面：`core/src/tool/handlers/ctx-context.ts`（新增 278 行）

| 工具 | 行 | permission | risk | sideEffect | concurrentSafe | needsApproval | readOnly | bytes |
|---|---|---|---|---|---|---|---|---|
| `ctx_reduce` | `:122-188` | `"magicContext.reduce"`（`:150`） | low | session | **false**（`:135`） | false | false | 4_000（`CTX_REDUCE_MODEL_BYTES` `:41`） |
| `ctx_expand` | `:198-268` | `"magicContext.expand"`（`:231`） | low | none | true | false | **true**（`:215`） | 60_000（`CTX_EXPAND_MODEL_BYTES` `:39`） |

- 两者 `timeoutMs = CTX_TOOL_TIMEOUT_MS = 30_000`（`:42`），`timeout.kind = "timed"`, `defaultMs = maxMs = 30_000`, `allowCallOverride: false`
- `permission.patternSources`：reduce 是 `["toolName","input"]` + `alwaysAllowPatternSources: ["toolName"]`（`:156-159`，注释解释按 input 记规则等于永久记不住）；expand 是 `["toolName"]`（`:237`）
- 两者 `denyPriority: "beforeAsk"`
- `cancellation.supported: true` / `cleanup: "none"`，各有 `userVisibleMessage`
- `formatCtxToolTextModelContent`（`:274-278`）——输出就是给模型读的文本本身，不再包一层
- **动态 import 包**：`loadMagicContext()` `:54-60` try/catch 返回 null；`openMagicContextDatabase` `:63-71` try/catch 返回 null；两个 handler 在缺席时都返回 `CTX_MAGIC_CONTEXT_UNAVAILABLE`（`:45-46`）而不是抛
- `toCtxToolContext` `:73-79` 投影 `callID/directory/sessionID`
- `ctx_reduce` handler `:81-94`：不传 protectedSet，注释 `:89-90` 说明包内走自己的 `getProtectionWindowForSession`

### 3.2 注册门与 workflow child 禁用

- 注册门：`core/src/runtime/helpers/runtime-tools.ts:89` `includeMagicContextTools: runtime.config.magicContext?.enabled === true`（注释 :86-88：门同时决定「模型看得见工具吗」与「模块图进不进内存」）
- workflow child 禁用：
  - `runtime-tools.ts:28-33` `MAGIC_CONTEXT_WORKFLOW_CHILD_DISALLOWED_TOOLS = [CTX_REDUCE_TOOL_NAME, CTX_EXPAND_TOOL_NAME]`
  - `:99-100` `disallowedTools: resolveRuntimeDisallowedToolsWithMagicContext(runtime.config)` 取代原来的 `resolveRuntimeDisallowedTools(runtime.config)`
  - `:114-126` `resolveRuntimeDisallowedToolsWithMagicContext`：`config.taskType !== "workflow_child"` 时原样返回 base；否则 `new Set(base ?? [])` 加两个工具名后展开
  - `:102-113` 根因注释：child 的工具交互事件只在 subagent 路径镜像到父会话，child 盖掉的 §N§ 标记父会话与用户都看不到 → 属于「用户失去否决机会」的结构性禁用；ctx_expand 一并禁是因为它读到的是同一个 store
  - `:113` 说明为何追加留在本文件而非 `tool-allowlist.ts`
- 工具注册面过滤：`core/src/tool/handlers/index.ts:8-9`（import 两个常量）、`:195`（`includeMagicContextTools` 参数文档）、`:286-287`（按 `entry.metadata.name === CTX_REDUCE_TOOL_NAME || …CTX_EXPAND_TOOL_NAME` 过滤）

### 3.3 ctx_reduce 幂等

- 幂等语义在**包内**：`ctx-context.ts:19-20` 注释「`ctx_reduce` 的 `commandIdLedger`，键推导逐字照搬上游：同一条 toolCallId 重复调用不会二次入队 pending_ops」
- 命令侧的幂等键：`cli/src/command-center/handlers/ctx.ts:221-226` `callID: \`slash:${drop}\`` + 注释「同一条命令文本重复敲两次得到同一个 id，于是第二次由幂等账本回放上一次的确认文本」
  - 注意：这里 `callID` 只用 `drop` 串，**不含命令名**，与 help 文案 `zcode-slash-command-help.ts:212`（「The same invocation repeated with the same command id …」）一致；`/ctx-expand` 同样用 `slash:${raw}`（`ctx.ts:253`）
- `ctx_reduce` 选 `concurrentSafe: false` 的理由写在 `ctx-context.ts:117-121`：账本按 commandId(=toolCallId) 记，同会话两次并发调用各有独立 toolCallId，本就不该互相看见 → 串行组保证模型视野里顺序确定

### 3.4 CLI 命令面

- 解析：`cli/src/command-center/slash-commands.ts` —— `parseSlashCommand` 新增四名分支（`ctx-status`/`ctx-reduce`/`ctx-expand`/`ctx-recomp`），返回 `{args, name: rawName, rawName, type: "known"}`；注释说明不需要上游 Effect 204 sentinel，因为命令在 command-center 就被消费
- 类型：`cli/src/command-center/slash-command-types.ts` 的 `SlashCommand` 变体 `name` 由 `"compact"` 换成 `"ctx-status" | "ctx-reduce" | "ctx-expand" | "ctx-recomp"`
- 路由：`cli/src/command-center/create.ts:203-212` 四名统一 `return handleCtxCommand(command.name as CtxCommandName, command.args, deps);`（**不走** `submitPrompt`）
- 实现：`cli/src/command-center/handlers/ctx.ts`（新增 423 行）
  - `:48` `CtxCommandName` 四名联合；`:50-55` `USAGE`
  - `:57-58` `MAGIC_CONTEXT_UNAVAILABLE = "Magic Context is not available in this session; enable features.magicContext to use /ctx-* commands."`
  - `:61-91` `handleCtxCommand`：`ctx-reduce` 空参直接回 USAGE（`:68-70`）→ `loadMagicContext()`（`:96-102` try/catch）→ 缺席回 UNAVAILABLE（`:73-75`）→ 四分支分发，整段包在 try/catch 里转 `describeFailure`（`:88-90`, `:416-419`）
  - `:105-112` `resolveSessionId`：`deps.getApp().sessionId`，失败返回 null → 各子命令回 UNAVAILABLE
  - `:114-122` `openStore`：try/catch 的 `openDatabase(getMagicContextDatabasePath())`
  - `:105` 注释「命令只作用于当前会话，模型无权指定别的 sessionId」
  - `:160-188` `formatCtxStatus`（Step 30 / D-13 渲染器，标 `@lintignore`，导出仅供测试断言）；`:191-201` `section`/`tagBucket`；`:204-207` `formatNumber`（非有限数 → `-`）
  - `:332-388` `parseExpandArgs`（`tag=`/`message=`/`start=`/`end=`/`N-M`/裸 N/尾随 `verbose`；裸数字先按 ordinal）
  - `:401-414` `parseRecompArgs`（`""`/`full`/`--upgrade` → full；`N-M` → partial，`start<1`/`end<start` 报错）
  - `:421-423` `respond` → `{mode: deps.getMode?.(), response}`
- help/surface：
  - `packages/shared/src/zcode-slash-command-help.ts:194-236` 四条 `BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES`（ctx-status :198-207、ctx-reduce :208-217、ctx-expand :218-227、ctx-recomp :228-236），带 details/usage/summary
  - `bootstrap/src/slash-command-surface.ts:38-43` `MAGIC_CONTEXT_LOCAL_SLASH_COMMAND_NAMES` 四名，`:45-56` 并入 `EXTRA_RESERVED_SLASH_COMMAND_NAMES` → `RESERVED_SLASH_COMMAND_NAMES`，防用户在 `.zcode/commands/` 写同名自定义命令抢走名字（`:24-37` 注释）；`:8-12` 明确四名**刻意不进** `APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES`（App `/` 面板无服务端派发路径）

### 3.5 `/ctx-status` 读 db 形状与 off 态行为

读路径：`ctx.ts:125-135` `readStatus` → `magicContext.readMagicContextStatusSnapshot({ sessionId })`（**不传 db**，`ctx.ts:131-132` 注释：包自己按 host 存储解析打开，与 transform 同源）→ `formatCtxStatus(snapshot)`。

包侧实现：`magic-context/src/host/ctx-status.ts:87-112` `readMagicContextStatusSnapshot({sessionId, db?})`
- `:91` `const db = options.db ?? (await openDefaultDatabase())`；`:92` `if (!db) return null`
- `:94` `getOrCreateSessionMeta(db, sessionId)` —— **有写副作用**（行不存在时建一行），文件头 `:78-85` 明写这是沿用 A 组既有语义的理由
- `:95-96` `getCompartments` / `getLastCompartmentEndMessage`
- 返回字段（`:49-69` interface）：`sessionId`、`protectedTokensFloor: number|null`、`contextPercentage: number`、`lastInputTokens: number`、`compartmentCount`、`lastCompartmentEndMessage`（-1 = 无）、`pendingOps: number|null`、`tags.{active,dropped,compacted}: {count,tokens}`
- `:154-164` `readProtectedTokensFloor`：`SELECT protected_tokens_effective FROM session_meta WHERE session_id = ?`，catch → null
- `:166-184` `readTagBucket`：`SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(token_count,0)),0) AS tokens FROM tags WHERE session_id = ? AND status = ?`，catch → `{count:0,tokens:0}`
- `:191-197` `openDefaultDatabase()`：`Promise.all([import("./storage-dir.js"), import("../core/features/magic-context/storage-db.js")])` 后 `openDatabase(getMagicContextDatabasePath())` —— **无 try/catch**

off 态行为（重要取证点）：
- `/ctx-status` 的缺席判定**只看 `import()` 是否失败**（`ctx.ts:96-102`），**不查 `features.magicContext`**。包已安装时 import 恒成功 → 走 `readMagicContextStatusSnapshot` → `openDefaultDatabase()` → `getMagicContextDatabasePath()`（`host/storage-dir.ts:115-117` → `:94-112`，只读 env `MAGIC_CONTEXT_DB_PATH`/`MAGIC_CONTEXT_DB_DIR`，**无 flag 判断**）→ `openDatabase(path)`（`core/features/magic-context/storage-db.ts:2623`）
- 因此 flag off 时敲 `/ctx-status` 仍会打开（并可能创建/迁移）`magic-context.db`，与该文件头 `:186-190` 的意图（「barrel 被 CLI 加载时（flag off 的默认态）不该因为一个诊断面就打开数据库」）**只在模块图层面成立，DB 打开层面不成立**
- `openDatabase` 抛（schema fence / 迁移未完成）时，`readStatus` 的异常冒泡到 `handleCtxCommand` 的 try/catch（`ctx.ts:88-90`）→ `Magic Context command failed: …`，而不是包侧注释 `:83-85` 承诺的「返回 null，由调用方决定呈现什么」
- `initializeMagicContextHost()`（`host/harness.ts:57-77`）**不在** `/ctx-*` 路径上被调用（只由 `createMagicContextTurnTransform` → 装配层调用），所以 ctx 命令面读库时 harness 仍可能是 `"opencode"` 默认值；`ctx-status.ts` 走 `session_meta`/`tags` 查询未按 `harness` 列过滤（`:157, :174` 只按 `session_id`），故 status 视角不受影响
- 包侧 `formatMagicContextStatusSnapshot`（`ctx-status.ts:122-147`）在 HEAD 已无生产调用方，只剩 `cli/scripts/test-ctx-commands.mjs:125, :146` 断言 —— `magic-context/src/index.ts:386` 仍导出

## 4. 配置热更新链

### 4.1 ConfigPort → 包内 source 的桥（push）

装配：`bootstrap/src/app/magic-context-turn-transform.ts`
- `:731-740` `const bridge = createConfigBridge(createConfigSource(options), { onReloadFailure: (failure) => options.logger.warn("Magic context config reload rejected; keeping last known good", {event: "magic_context.config_reload_failed", detail: failure.error}) })`
- `:741` `const config = bridge.getSnapshot().effective ?? DEFAULT_MAGIC_CONTEXT_CONFIG`
- `:743-752` `findConfigReadinessError(config)` —— 只 warn（`event: "magic_context.config_readiness"`），**不拒绝装配**（注释 :745-746 解释 S19b 只记诊断）
- `:818-829` **push 重写的落点**：`bridge.onChange((event) => { applyConfigToDeps(deps, event.snapshot.effective); options.logger.info("Magic context config reloaded", {event: "magic_context.config_reloaded", generation, changedKeys}); })`；注释 :818-820 明写「下一个 turn 的第一次 pass 就读到新值——这就是 spec Step 16 的验收判据（不重启）」
- `:844` 端口侧 `getConfig: () => bridge.getSnapshot().effective ?? DEFAULT_MAGIC_CONTEXT_CONFIG` —— 失败分级时现读（注释 :1014-1016）

`createConfigSource`（`:867-884`）：
- `:872-878` 无 `configPort` 时降级静态源：`read: () => options.configDomain ?? {}` + `subscribe: () => () => {}`
- `:880` `read: () => configPort.get(ConfigKey.MagicContext)`
- `:881-882` `subscribe: (listener) => configPort.observe().subscribe(ConfigKey.MagicContext, () => listener())` —— 注释 :856-866 说明两处签名细节：`observe()` 不接受 key（key 在 `.subscribe` 上）；handler 签名 `(value, prev) => void` 被包成 `() => void`，不把回调参数当新值透传

包内 bridge：`magic-context/src/host/config-bridge.ts`
- `:39-42` `MagicContextConfigSource { read(): unknown; subscribe(listener: () => void): () => void }`（刻意对本地接口声明，不依赖 `@zcode/contracts`）
- `:74-136` `createConfigBridge`：`:81` 初值 `createInitialSnapshot(DEFAULT_MAGIC_CONTEXT_CONFIG)`（generation 0）；`:92-117` `refresh()`：`safeParse(raw ?? {})` → 失败则记 `ConfigReloadFailure` 并**保留 last-known-good**（`:96-100`）；`:106` `if (adopted && digest === snapshot.digest) return`（首个合法值即使等于默认也采纳）；`:110-115` generation+1、digest、adoptedAt、effective；`:116` `emit()`
- `:119-120` 构造期同步 `refresh()` 一次 + `source.subscribe(refresh)`
- `:86-90` `emit` 先 `Array.from(listeners)` 拷贝再遍历（允许 listener 在回调里退订）
- `:131-134` `dispose()` 退订 + 清 listener

快照语义：`magic-context/src/host/config/snapshot.ts`
- `:21-29` `ConfigSnapshot {generation, digest, adoptedAt, effective}`
- `:46-48` `computeConfigDigest` = sha256(`stableStringify(config)`)（码点序排序）
- `:59-72` `diffConfigKeys` 递归点路径差集，数组整体比较，排序返回
- `:75-77` `createInitialSnapshot` generation 0 / adoptedAt 0

Schema：`magic-context/src/host/config/schema.ts`（242 行新增）
- `:146-216` `MagicContextConfigSchema`：`enabled`(default true) / `execute_threshold_percentage`(:148-156, 20–90 联合 per-model) / `execute_threshold_tokens`(:157-165) / `protected_tokens`(:166-174, 4_000–1_000_000) / `history_budget_percentage`(:175-182, .05–.5, 默认 .15) / `cache_ttl`(:183-188, 字符串或 per-model) / `historian`(:189-191) / `smart_drops`(:192-197, 默认 false) / `fail_closed_blocking`(:198-203, 默认 true) / `language`(:204-215)
- `:232` `EXCLUDED_CONFIG_KEYS = ["compaction"]`（文件头 :9-11：D-7 已删除原生压缩）
- `:239-241` `findConfigReadinessError`：`config.enabled && !config.historian.model` → `HISTORIAN_MODEL_REQUIRED_MESSAGE`（`:58-59`，中文文案；`scripts/test-config.mjs:192-197` 断言其无全角空格）

### 4.2 S23 参数域 7 处映射

`magic-context-turn-transform.ts:893-909` `applyConfigToDeps(deps, config)` 原地改写 7 个字段：

| # | 行 | 目标 | 源 |
|---|---|---|---|
| 1 | `:894` | `deps.cacheTtlConfig` | `config.cache_ttl` |
| 2 | `:895-899` | `deps.protectedTokens`（undefined 时 `delete`） | `config.protected_tokens` |
| 3 | `:900` | `deps.smartDrops` | `config.smart_drops` |
| 4 | `:901` | `deps.historyBudgetPercentage` | `config.history_budget_percentage` |
| 5 | `:902` | `deps.executeThresholdPercentage` | `config.execute_threshold_percentage` |
| 6 | `:903-907` | `deps.executeThresholdTokens`（undefined 时 `delete`） | `config.execute_threshold_tokens` |
| 7 | `:908` | `deps.scheduler = createZCodeScheduler(config)` | 整个 config 重新闭包 |

- 「同一活对象」纪律写在 `:771-778`（包内 transform 每 pass 重读 `deps.*` 字段；重建 deps 会让已持有的 transform 看旧闭包）
- 初始同 7 项在 `buildTransformDeps` `:950-955`（scheduler 在 `:922`）
- 未进 7 项映射的 schema 字段：`enabled`、`fail_closed_blocking`、`historian.*`、`language`
  - `fail_closed_blocking` 走另一条热读路径：`handleTransformFailure(error, …, port.getConfig(), …)`（`:1144`）→ `config.fail_closed_blocking !== false`（`:1178`）→ 现读 `bridge.getSnapshot().effective`
  - `historian.*` 与 `enabled` 无热路径（见 §5）

### 4.3 S29 read/update RPC

`bootstrap/src/zcode-protocol/magic-context-config.ts`（新增 175 行）

`readMagicContextConfig`（Step 29 / D-12）：`:66-105`
- `:71` `parseParams(zcodeWorkspaceReadMagicContextConfigParamsSchema, rawParams)`；`:72` 路径固定 `dependencies.configPath ?? getDefaultConfigPath()`
- `:74-86` **ConfigPort 优先**：遍历 `context.sessions.values()`，`record.app?.getConfigPort?.()`，命中即用 `configPort.get(ConfigKey.MagicContext)` 组装并 return；`:77-79` 注释说明该域注册时已钉住 `.default()`，不需要再兜 undefined
- `:88-96` 无活跃 session 时读文件兜底：`MagicContextConfigSchema.parse(loaded.config.magicContext ?? {})`（让 schema 补齐成完整默认域）
- `:97-103` `context.logger?.info("magicContext config read", {event: "zcode_protocol.magic_context.config_read", configPath, fromConfigPort: false, workspaceKey})` —— **注意 `fromConfigPort` 硬编码 `false`**；ConfigPort 命中分支（`:80-86`）直接 return，**不打这条日志**（见 §5）

`updateMagicContextConfig`（S23 / D-12）：`:107-169`
- ① 校验 `:122-129`：`MagicContextConfigSchema.safeParse(params.config ?? {})` 失败 → `ProtocolRequestError(-32602, "Invalid params — magicContext: …")`；`:118-121` 注释强调未知键是 **strip 而非 reject**
- ② 写盘 `:132-135`：`updateMagicContextInFileConfig(configPath, parsed.data)`（`atomicWriteJson`，顶层域）
- ③ 内存 + 推送 `:141-149`：逐个 resident session `configPort.set(ConfigKey.MagicContext, parsed.data)`，`updatedSessionCount += 1`；`:143-144` 注释「一个 record 缺能力不能让它后面的 workspace 收不到配置」
- `:34-46` 三段顺序不可调换的论证（先写盘后 set：最坏是「磁盘已改但本次进程未生效」，反之会内存与磁盘永久分叉）
- `:150-157` `event: "zcode_protocol.magic_context.config_updated"` 日志
- `:159-168` 返回 `parsed.data`（effective 回显）而非 `params.config`
- App 侧能力：`bootstrap/src/app/types.ts:622-634` `getConfigPort?(): ConfigPort`（可选，注释说明测试/轻量 embedder 可不实现）；`create-app.ts:1106-1110` 实现为 `() => configResult.configPort`

### 4.4 S30 usage publish closure

`bootstrap/src/app/magic-context-turn-transform.ts:800-815`
- `:806-814` `const publishUsageSummary = (): void => { const sink = options.onMagicContextUsage; if (!sink) return; void readMagicContextUsageSummary(db, options.sessionId).then((summary) => sink(summary.usage)).catch(() => { /* 注释 */ }); }`
- `:815` `options.usageRecorder?.onUsageRecorded(publishUsageSummary)` —— **触发点 ①**：recorder 在 `record()` 落库后调 `notifyRecorded()`（`:374-375`）
- `:841` `publishUsageSummary()` 出现在 `notifyPassSucceeded` 内 —— **触发点 ②**：transform 成功那一 pass
- `:800-805` 注释解释两个时机（① pass 成功定 compartments/dropped/缓存命中；② provider usage 落库定 usedTokens/usedPercent）
- sink 来源：`create-app.ts:801-806` 条件展开 `onMagicContextUsage`（缺席 = CLI/TUI 不推送）；`bootstrap/src/app/types.ts:182-190` `onMagicContextUsage?: (usage: SessionMagicContextUsage | null) => void`，注释说明「缺席 = 不推送；传 null = 投影层删掉该键」

读面：`bootstrap/src/app/magic-context-usage-summary.ts`
- `:50-77` `readMagicContextUsageSummary(db, sessionId)`：`:59` **显式 nullish 守卫**（注释 :54-58：包侧 `options.db ?? …` 在 db 为 null 时会回退去打开默认存储）；`:61` 复用包侧 `readMagicContextStatusSnapshot`；`:64-72` 映射 `budgetTokens/usedTokens/usedPercent/compartmentCount/droppedTagCount/droppedTagTokens/cache`；`:74-76` catch → `{usage:null}`（永不抛）
- `:86-101` `readInjectedBlockCache`：`SELECT cached_m0_bytes AS m0, cached_m1_bytes AS m1 FROM session_meta WHERE session_id = ?`；`:96` 读不到 → null（「不知道」≠「都没命中」）
- `:104-109` `isCachedBlock`：null/undefined→false；Uint8Array→`byteLength>0`；number→`>0`
- `:111-117` `nonNegative` / `finite` 归一

事件面（生产 usage 的唯一来源）：`create-app.ts:151-187` `composeMagicContextUsageSink` —— `SessionEventType.ModelComplete` 且 `payload.querySource === "main_turn"` 时 `recorder.record({at: new Date(event.timestamp).getTime(), usage})`；`:172-178` 整段 try/catch（注释「诊断面绝不能把一次已处理的事件变成一次失败投递」）；recorder 缺席时原样返回下游 sink

recorder 实现：`magic-context-turn-transform.ts:268-379`
- `:272-276` 内存态 `contextUsageMap` / `recordedListeners` / `contextWindow` / `modelKey` / `db`
- `:286-294` `notifyRecorded` 逐 listener try/catch 吞异常
- `:300-319` `prime(db)`：装配期从 `session_meta` 读回上次读数（`:311` `hasUsageTokens: true` 快路径）；失败只 info
- `:320-328` `noteLiveModel`：`properties.contextWindow > 0` 才更新分母；`modelKey = resolveModelKey(providerId, modelId)`（`:323-327` 注释：`last_observed_model_key` 是 transform 换模型失效判据的唯一输入）
- `:329-376` `record({at, usage})`：`inputTokens === undefined || contextWindow === undefined || contextWindow <= 0` → **不写**并 `note("info", "magic_context.usage_skipped")`（`:333-341`，注释解释 0% 会让 scheduler 永远 defer）；写内存 `:344-351`；`!db` 时仍 `notifyRecorded()` 后 return（`:352-355`）；落库 `:356-367` `updateSessionMeta(db, sessionId, {lastContextPercentage, lastInputTokens, lastResponseTime, ...(modelKey===null?{}:{lastObservedModelKey: modelKey}), lastUsageContextLimit: contextWindow})`；失败 info 后仍 notify
- `:377` `readUsage: () => contextUsageMap.get(sessionId)?.usage ?? null`

## 5. 可疑点清单

> 只列取证到的事实与「为什么可能有问题」，不下结论。

### 5.1 fire-and-forget 异常去向 / 调度器 abort 断链（P1 候选）

- **信号被丢弃**：`magic-context/src/core/features/magic-context/historian-scheduler.ts:132` `await options.runSession(sessionId, shutdownController.signal)`；`:92-97` 的接口文档明写「Implementations MUST honour `signal` — it is the only thing that makes `shutdown()` more than "stop waiting"」（`:36` 亦称 abort 会「reach the provider request through `HiddenCompletionExecutor`」）。
  但装配实现 `bootstrap/src/app/magic-context-historian.ts:338-339` 是 `runSession: async (sessionId) => runPass(sessionId, false)` —— **第二个参数没有形参**。`runPass`（`:315-333`）签名 `(sessionId, forceDrainQuota)`，`runOneCompartmentPass` 的 input 类型（`:401-416`）也**没有 signal 字段**，一路到 `:475` `startCompartmentAgent(runnerDeps)` 都没有把 scheduler 的 abort 接进去。executor 内部另有自己的 `slot.controller`（`hidden-completion-executor.ts:391`）负责超时/close，但那不是 scheduler 的 shutdown signal。
  → 结果：`shutdown()` 只能停「继续调度」，停不掉已经在飞的 provider 请求。

### 5.2 drain / 关停资源释放（P1 候选）

- `historian.shutdown()` 在 HEAD **没有任何调用方**：`MagicContextHistorianHost.shutdown`（`magic-context-historian.ts:114-115, 374`）返回后仅在 `createMagicContextTurnTransform` 里被持有（`magic-context-turn-transform.ts:779`），而 `:779-852` 之后没有任何会话关闭/App 退出钩子调它。
- `drainHistorianSchedulerWithTimeout`（`historian-scheduler.ts:235-255`，包 `index.ts:214` 导出）同样**没有生产调用方**，只有 `magic-context/scripts/test-historian.mjs` 覆盖。
- `config-bridge.dispose()`（`config-bridge.ts:131-134`）也没有调用方：`bootstrap/src/app/magic-context-turn-transform.ts:731` 创建 bridge，`:821` 注册 `onChange`，此后无 `dispose()`。于是 `configPort.observe().subscribe(...)`（`:882`）的订阅在 App 生命周期内不会被解除。
- 与 `bootstrap/src/app/types.ts:114` 注释「关闭时终止在飞的 historian（会话关闭 / App 退出）」的意图存在落差。

### 5.3 「turn 成功后调度」与「一进程 = 一轮」竞态（P1 候选）

端口返回体的顺序（`magic-context-turn-transform.ts`）：

```
:1133  await transform({}, { messages: projected });
:1137  await settleInFlightHistorian(sessionId);   // 有界等 60s
...
:1156  if (port.onPassSucceeded !== undefined) port.onPassSucceeded(input.model);  // 里面才 notifyTurnSuccess
```

即 `settleInFlightHistorian`（`:988-1007`）等的是 **transform 自己那条 compartment 路径**起的 historian（`getActiveCompartmentRun`），而 `notifyPassSucceeded`（`:832-842`）在它**之后**才 `historianScheduler.notifyTurnSuccess(...)`（`:839`）。调度器那条 pass 是纯 fire-and-forget，无任何 settle 等待。

而同文件 `:970-985` 的注释明确说：ZCode CLI「一进程 = 一轮 prompt」，transform 一返回这轮就结束，historian 还在飞的那几秒会随进程一起消失（drain 预留泄漏、compartment 不落库）。调度器那条正好落在这个缺口里。

### 5.4 `/compact` 命令面整体消失（需确认是否有意）

- `cli/src/command-center/slash-commands.ts`：BASE 的 `if (rawName === "compact")` 分支在 HEAD 被 ctx-* 四分支整体替换。
- `cli/src/command-center/create.ts:203-212`：BASE 的 `if (command.name === "compact") { … app.submitPrompt("/compact …") }` 被删除。
- `packages/shared/src/zcode-slash-command-help.ts`：BASE 有 `{details:["Runs the core manual compaction path…"], name:"compact", usage:"/compact [instructions]"}`，HEAD 没有（HEAD 该文件 44/7，四条 ctx 条目替换了 compact 条目）。
- core 侧 compaction 也已全量删除：`core/src/runtime/methods/turn-loop.ts` 删掉 `microcompactIfNeeded` / `autoCompactIfNeeded` / rapid-refill 整块（diff `16 52`）；`turn-loop-state.ts` 删掉 `CompactLoopTracking`/`RapidRefillDecision`/`evaluateRapidRefill`/`recordCompactSuccess` 等（`1 78`）；`core/src/runtime/types.ts` 删掉 `AutoCompactPolicyConfig`、`CompactTimelineContext`、`ActiveTurnKind` 的 `"compact"`（`19 22`）；`app/types.ts` 的 `commandKind` 也去掉 `"compact"`。
  → 与 D-7「删除原生压缩」一致，看起来是有意；但 diff 面上 `/compact` 用户可见命令被移除这件事值得在 spec 侧确认。

### 5.5 `publishUsageSummary` 的 catch 与注释不符（P2）

`magic-context-turn-transform.ts:806-814`：

```
void readMagicContextUsageSummary(db, options.sessionId)
  .then((summary) => sink(summary.usage))
  .catch(() => {
    // 读不出来就推 null：投影层据此删掉该键，面板整段收起。诊断面不抛。
  });
```

catch 体是**空的** —— 注释承诺「推 null」，代码没有调 `sink(null)`。虽然 `readMagicContextUsageSummary` 自己几乎总返回 `{usage:null}`（`:74-76` catch → null），但 `:61` 的 `readMagicContextStatusSnapshot` 若抛异常路径不同则依赖这里的 catch；此刻失败会留下上一帧的旧值而不是收起面板。与 `app/types.ts:186-188`「传 `null` 表示『这次读不到』，投影层据此删掉该键」的契约不一致。

### 5.6 `/ctx-*` 不看 feature flag，flag off 也会开库（P2）

- `cli/…/handlers/ctx.ts:96-102` 的缺席判定只看 `import()` 是否失败，**不查 `features.magicContext`**。
- 包内 `host/ctx-status.ts:191-197` `openDefaultDatabase()` 无 try/catch；`host/storage-dir.ts:115-117` / `:94-112` 只读 env，不看 flag。
- 于是 flag off 时敲 `/ctx-status`（或 `/ctx-reduce`、`/ctx-recomp`）仍会 `openDatabase(getMagicContextDatabasePath())`，可能创建/迁移 `magic-context.db`。这与 `ctx-status.ts:186-190` 的意图（「flag off 的默认态不该因为一个诊断面就打开数据库」）只在模块图层面成立。
- `openDatabase` 抛错时，异常冒到 `handleCtxCommand` 的 try/catch（`ctx.ts:88-90`）→ 用户看到 `Magic Context command failed: …`，而不是 `ctx-status.ts:83-85` 承诺的「返回 null，由调用方决定呈现什么」。

### 5.7 `initializeMagicContextHost()` 不在 ctx 命令路径上 → harness 可能仍是 `"opencode"`（P2）

- `initializeMagicContextHost()` 只在 `magic-context-turn-transform.ts:729` 被调用，而那在 `createMagicContextTurnTransform` 里、受 `:724 if (!options.enabled) return undefined;` 保护。
- `magic-context/src/core/shared/harness.ts:34` 默认 `currentHarness = "opencode"`。
- 而 `/ctx-reduce` 会写库：`magic-context/src/core/features/magic-context/storage-ops.ts:94` `getQueuePendingOpStatement(db).run(sessionId, tagId, operation, queuedAt, getHarness())`。
- ⇒ flag off 的会话里敲 `/ctx-reduce`，`pending_ops.harness` 会被写成 `"opencode"`。`host/harness.ts:2-11` 把这种跨 harness 归因称为「a correctness bug, not a feature」。
- （`/ctx-status` 只按 `session_id` 查 `session_meta` / `tags`，不带 harness 过滤（`ctx-status.ts:157, 174`），故读面不受影响。）

### 5.8 `readMagicContextConfig` 的 ConfigPort 分支不打日志（死字段，P3）

`bootstrap/src/zcode-protocol/magic-context-config.ts:80-86` 命中 ConfigPort 后直接 `return result`，没走 `:97-103` 的日志；那条日志里的 `fromConfigPort: false` 是硬编码字面量。因此 `fromConfigPort` 这个字段在 HEAD 永远只能是 `false`，且「从 ConfigPort 读到」这条路径在日志里完全不可见。

### 5.9 `historian.*` 与 `enabled` 不参与热生效（P2）

- `applyConfigToDeps`（`magic-context-turn-transform.ts:893-909`）只映射 7 个字段，不含 `historian.*` / `enabled` / `language`。
- historian host 只在装配期构造一次（`:779` `createMagicContextHistorianHost(config, …)`），其 `historianModel` / `fallbackModels` / `historianTwoPass` / `historianMaxOutputTokens` / `hiddenCompletionExecutor` 都是那一次的闭包值（`magic-context-historian.ts:279-311`）。
- ⇒ 运行中把 `magicContext.historian.model` 从空改成有值（或反之），本进程内不生效；下一个进程才生效。
- 同理 `language`（`schema.ts:204-215`）也不热生效。
- core 第二层门 `runtime.config.magicContext?.enabled === false`（`core/src/runtime/helpers/magic-context-turn-transform.ts:211`）读的是 `AgentRuntimeConfig`，由 `resolveAppRuntimeConfig`（`bootstrap/src/app/runtime-config.ts:186-193`）在构造期算成布尔值后冻结。注释 `:208-210` 写「Step 23 接 ConfigPort 热更新后，运行中改配置必须立刻生效」——实际热**关**有效（端口已存在时），热**开**无效（端口在装配期就没建）。在「一进程 = 一轮」的 CLI 里这条差异不可观察，但注释与实现的语义不等价。

### 5.10 跨包边界的字面量硬约束被削弱（P2）

- 包侧 `SidecarModelCallOptions.preserveProviderStreamBoundaries: true` 是编译期字面量（`hidden-completion-executor.ts:81`），文件头 `:43-48` 明写「失败是 SILENT… 到了 Step 25/26 全仓唯一的 `true` 生产者（`compact-active.ts:401`）已经没了，接错线没有第二个生产者兜底」。
- 但 core 侧 `core/src/runtime/methods/sidecar-model-request.ts:30` 把它放宽成 `preserveProviderStreamBoundaries?: boolean`，`:306` 直接转发。core 侧的其它调用者因此可以传 `false` 而不被类型系统拦下。
- 现有保护只有运行时测试：`bootstrap/scripts/test-magic-context-historian.mjs:246-270` 断言字面量被原样转交；`magic-context/scripts/test-historian.mjs:348-395` 用负向 typecheck 钉住包侧那一层。

### 5.11 死代码 / 未消费导出（P3）

- `magic-context/src/host/ctx-status.ts:122-147` `formatMagicContextStatusSnapshot` 在 HEAD 无生产调用方，只剩 `cli/scripts/test-ctx-commands.mjs:125, :146` 断言；`magic-context/src/index.ts:386` 仍导出。
- 两套 `/ctx-status` 渲染并存的语义差异：包侧把 `pending operations` 放在 `Tags` 段末（`ctx-status.ts:144`），CLI 侧 `formatCtxStatus` 把它放进 `COMPARTMENTS` 段（`cli/…/handlers/ctx.ts:176`）。
- `magic-context-historian.ts:110-112` / `MagicContextHistorianHost.noteLiveModel` 有唯一调用方（`magic-context-turn-transform.ts:835`），正常；但 `MagicContextHistorianHost.shutdown`（`:114-115`）无调用方（见 5.2）。
- `magic-context/src/host/hidden-completion-executor.ts:39-51` `SETUP_ERROR_CODES`（含 `model_request_auth_missing`）与 core `sidecar-model-request.ts:64-71` `SIDECAR_SETUP_ERROR_CODES`（**不含** `model_request_auth_missing`）不是同一组码；`hidden-completion-executor.ts:137-140` 注释称「These are the same codes the sidecar primitive treats as SETUP failures」，但第 7 个码在 core 侧不存在。

### 5.12 其它观察（P3）

- `readMagicContextConfig` 注释 `:77-79` 声称 ConfigPort 的 `MagicContext` 域「注册时就把 `.default()` 解析结果钉进去了」；`adapters/src/config/index.ts:288-302` 确实 `magicContext: this.store.get(ConfigKey.MagicContext) ?? DEFAULT_MAGIC_CONTEXT_CONFIG`，并在 `:415-424` `getDefaultValue` 登记（注释解释不登记会让 `ConfigPortImpl.get` 抛 `Config key not found`）。一致。
- `updateMagicContextInFileConfig`（`adapters/src/config/file-config.adapter.ts:269-285`）在 `changed === false` 时不写盘（幂等短路），但 `updateMagicContextConfig` 仍执行 `configPort.set`（`magic-context-config.ts:141-149`）。因 bridge 有 digest 去重（`config-bridge.ts:106`）不会重复 `applyConfigToDeps`，无实际副作用。
- `createMagicContextUsageRecorder.record` 在 `!db` 时仍 `notifyRecorded()`（`magic-context-turn-transform.ts:352-355`），此时 `readMagicContextUsageSummary(db, …)` 会因 `db` falsy 命中 `:59` 守卫返回 `{usage:null}` → 推 null。行为自洽。
- `magic-context-turn-transform.ts:1057-1075` 的 raw-message provider 在端口闭包内**注册一次、之后只换内容**（`currentSnapshot` / `currentRows` / `providerRegistered`），注释 :1057-1072 说明「一进程 = 一轮」下为何不能把注册绑在 transform 上；`:1073-1074` 的 holder 在同一 turn 内被多个 pass 覆盖，与 `:1037` 的 `cachedRows` 缓存键 `liveLength` 一致。
- `turn-loop.ts` 在插入 transform 的同时删除了 compact 相关 import（diff 首段），`deps.ts` 由 `1 32`、`rewind.ts` `2 32` 等多处删除 compact 门面导出——超出本节点范围，仅记录。

## 6. diff 统计（本范围 BASE..HEAD）

命令：`git diff --numstat 1fa2d0e aba59a9 -- <scope>`（BASE=1fa2d0e，HEAD=aba59a9）。`A/D` = 增/删行。

### 6.1 一级范围（节点点名的文件）

| 增 | 删 | 路径 |
|---|---|---|
| 127 | 2 | `bootstrap/src/app/create-app.ts` |
| 484 | 0 | `bootstrap/src/app/magic-context-historian.ts` ★新增 |
| 1262 | 0 | `bootstrap/src/app/magic-context-turn-transform.ts` ★新增 |
| 117 | 0 | `bootstrap/src/app/magic-context-usage-summary.ts` ★新增 |
| 175 | 0 | `bootstrap/src/zcode-protocol/magic-context-config.ts` ★新增 |
| 218 | 0 | `core/src/runtime/helpers/magic-context-turn-transform.ts` ★新增 |
| 48 | 48 | `core/src/runtime/methods/{compact-summary-model-request.ts ⇒ sidecar-model-request.ts}` **rename**（净 0/0） |
| 278 | 0 | `core/src/tool/handlers/ctx-context.ts` ★新增 |
| 423 | 0 | `cli/src/command-center/handlers/ctx.ts` ★新增 |

`magic-context/src/host/**`（13 个文件，全部新增）：

| 增 | 路径 |
|---|---|
| 504 | `src/host/types.ts` |
| 695 | `src/host/session-history.ts` |
| 438 | `src/host/raw-message-provider.ts` |
| 421 | `src/host/hidden-completion-executor.ts` |
| 242 | `src/host/config/schema.ts` |
| 197 | `src/host/ctx-status.ts` |
| 193 | `src/host/storage-dir.ts` |
| 144 | `src/host/config-bridge.ts` |
| 122 | `src/host/typecheck-seams.ts` |
| 116 | `src/host/ctx-recomp.ts` |
| 110 | `src/host/harness.ts` |
| 77 | `src/host/config/snapshot.ts` |
| 53 | `src/host/config/language.ts` |

`host/**` 合计 **3310** 行新增、0 删除。

### 6.2 本范围的接线改动（节点未点名但同 diff）

| 增 | 删 | 路径 | 与本节点的关系 |
|---|---|---|---|
| 16 | 52 | `core/src/runtime/methods/turn-loop.ts` | mcTransform 插入段（+ 删 compact 块） |
| 1 | 78 | `core/src/runtime/methods/turn-loop-state.ts` | 删 rapid-refill/compact 状态 |
| 19 | 22 | `core/src/runtime/types.ts` | `magicContext` config + `magicContextTurnTransform` deps；删 `AutoCompactPolicyConfig` / `CompactTimelineContext` / `ActiveTurnKind:"compact"` |
| 3 | 1 | `core/src/runtime/internal.ts` | internal deps 加端口 |
| 6 | 1 | `core/src/runtime/agent-runtime.ts` | `private magicContextTurnTransform` + 赋值 |
| 23 | 0 | `core/src/system-reminder/source.ts` | `magic_context` per-request 源 + NON_MID 排除 + descriptor |
| 27 | 0 | `core/src/tool/handlers/index.ts` | `includeMagicContextTools` 过滤 |
| 41 | 2 | `core/src/runtime/helpers/runtime-tools.ts` | ctx 工具注册门 + workflow child 禁用 |
| 8 | 0 | `bootstrap/src/app/runtime-config.ts` | `features.magicContext` 投影 |
| 23 | 2 | `bootstrap/src/app/types.ts` | `onMagicContextUsage` / `getConfigPort`；删 `commandKind:"compact"` |
| 11 | 4 | `cli/src/command-center/create.ts` | ctx 四命令路由；删 `/compact` 路由 |
| 13 | 2 | `cli/src/command-center/slash-commands.ts` | `parseSlashCommand` ctx 四名；删 `compact` |
| 1 | 1 | `cli/src/command-center/slash-command-types.ts` | `SlashCommand.name` 联合 |
| 44 | 7 | `packages/shared/src/zcode-slash-command-help.ts` | 四条 help 条目；删 `compact` 条目 |
| 26 | 2 | `bootstrap/src/slash-command-surface.ts` | ctx 四名进保留名（不进 App 面板） |
| 2 | 2 | `adapters/src/config/config-factory.ts` | 仅注释 `~/.zcode` → `~/.omz` |
| 33 | 6 | `adapters/src/config/index.ts` | `ConfigKey.FeatureMagicContext` / `ConfigKey.MagicContext` 注册 + 默认值；删 `FeatureCompact` |
| 76 | 1 | `adapters/src/config/file-config.adapter.ts` | `updateMagicContextInFileConfig` |
| 34 | 5 | `adapters/src/config/schema.ts` | 转发包内 schema |
| 95 | 0 | `contracts/src/tools/ctx-context.ts` ★新增 | ctx 工具契约 + zod 面 |
| 344 | 0 | `core/scripts/test-sidecar-model-request.mjs` ★新增 | Step 25 单测 |
| 290 | 0 | `bootstrap/scripts/test-magic-context-historian.mjs` ★新增 | S24 historian 单测 |
| 346 | 0 | `bootstrap/scripts/test-magic-context-turn-transform.mjs` ★新增 | Step 19b 单测 |
| 293 | 0 | `bootstrap/scripts/test-magic-context-config-rpc.mjs` ★新增 | S23/S29 单测 |
| 405 | 0 | `bootstrap/scripts/test-magic-context-ui-config.mjs` ★新增 | S29/UI 单测 |
| 330 | 0 | `bootstrap/scripts/test-magic-context-usage-projection.mjs` ★新增 | D-13 单测 |
| 358 | 0 | `adapters/scripts/test-magic-context-domain.mjs` ★新增 | ConfigPort × bridge 单测 |
| 322 | 0 | `cli/scripts/test-ctx-commands.mjs` ★新增 | S22/S30 单测 |
| 320 | 0 | `magic-context/scripts/test-config.mjs` ★新增 | Step 16 schema/bridge 单测 |
| 986 | 0 | `magic-context/scripts/test-host.mjs` ★新增 | Step 17 host 适配器单测 |
| 399 | 0 | `magic-context/scripts/test-historian.mjs` ★新增 | S20 historian/executor 单测 |
| 388 | 0 | `magic-context/scripts/test-ctx-tools.mjs` ★新增 | Step 21 ctx 工具单测 |
| 913 | 0 | `magic-context/scripts/test-transform.mjs` ★新增 | transform 单测 |
| 279 | 0 | `magic-context/scripts/smoke-storage.mjs` ★新增 | storage smoke |
| 112 | 0 | `packages/ui/src/chat-input-toolbar/magicContextUsageRows.ts` ★新增 | D-13 UI |
| 252 | 0 | `packages/ui/src/settings/MagicContextSettingsFields.tsx` ★新增 | S23 UI |
| 263 | 0 | `packages/ui/src/settings/MagicContextSettingsSection.tsx` ★新增 | S23 UI |
| 232 | 0 | `packages/ui/src/settings/magicContextSettingsForm.ts` ★新增 | S23 UI |
| 435 | 0 | `magic-context/src/index.ts` ★新增 | 包 barrel |
| 36 | 0 | `magic-context/package.json` / `17 0 tsconfig.json` / `49 0 LICENSE.magic-context` | 包骨架 |
| 36 | 0 | `packages/magic-context/src/core/plugin/*`、`src/core/shared/*` 等包内 core 目录 | 包内上游代码（新增，非本节点范围） |

### 6.3 本范围合计（一级范围 + §6.2）

- 纯新增（0 删）：`magic-context/src/host/**` 13 文件 3310 行；3 个 bootstrap app 文件 1863 行；`bootstrap/src/zcode-protocol/magic-context-config.ts` 175；`core/src/runtime/helpers/magic-context-turn-transform.ts` 218；`core/src/tool/handlers/ctx-context.ts` 278；`cli/src/command-center/handlers/ctx.ts` 423；`contracts/src/tools/ctx-context.ts` 95 → **一级范围新增约 6362 行，删除 0**
- rename：1 处（`compact-summary-model-request.ts` ⇒ `sidecar-model-request.ts`，48/48）
- 有删除的接线改动：`turn-loop.ts`(16/52)、`turn-loop-state.ts`(1/78)、`core/runtime/types.ts`(19/22)、`create-app.ts`(127/2)、`runtime-tools.ts`(41/2)、`adapters/config/index.ts`(33/6)、`cli/command-center/create.ts`(11/4)、`slash-commands.ts`(13/2)、`zcode-slash-command-help.ts`(44/7)、`slash-command-surface.ts`(26/2)、`app/types.ts`(23/2)

---

*取证完成（readonly；本文件为唯一写入产物）。所有 file:line 均基于 HEAD=aba59a9 工作树。*