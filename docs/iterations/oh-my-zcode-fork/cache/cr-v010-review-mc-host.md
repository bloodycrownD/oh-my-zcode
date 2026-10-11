# CR v0.1.0 — review-mc-host（scope 模式）

- 仓库：D:\Dev\Js\oh-my-zcode\omz
- BASE_SHA：1fa2d0e ／ HEAD_SHA：aba59a9
- 维度：A + B + C + C-orch + G（本 scope）
- Spec：D:\Dev\Js\oh-my-zcode\docs\iterations\oh-my-zcode-fork\spec.md
- 证据包：cache/cr-v010-evidence-mc-host-integration.md
- 模式：readonly 评审（未改任何代码/文档；本文件为唯一写入产物）
- 状态：**已完成**

> 裁决纪律：证据包每条结论均按 file:line 回读 HEAD=aba59a9 工作树复核；下面每条 must-fix 都给出具体 file:line 证据。已拍板背景（preserveProviderStreamBoundaries 归属、`/compact` 移除=spec D-7、`/ctx-status` off 态建库=已知登记项、historian 默认 off=设计）已作为防误报前提吸收，见各条「已拍板」标注。

---

## 1. must-fix

### review-mc-host/G-1 — P0 — 用户级二级开关 `magicContext.enabled` 完全未接线（spec 契约 8 失效）

- **维度**：G（配置热生效 / 跨包装配）
- **文件**：
  - `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts:190-193`
  - `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:778-788`
  - `apps/zcode-cli/packages/core/src/runtime/helpers/magic-context-turn-transform.ts:209-211`
  - `apps/zcode-cli/packages/magic-context/src/host/config/schema.ts:240`（唯一读取点，仅用于告警）
  - `apps/zcode-cli/packages/ui/src/settings/magicContextSettingsForm.ts:29/86/126`（UI 暴露并提交）
- **描述**：
  - spec 契约 8（`spec.md:214`）明确定义 `effective = features.magicContext && magicContext.enabled`，并称 `magicContext.enabled` 为「用户级二级开关」，UI 标注「仅停用上下文管理，historian/知识层随之停止」。
  - 但代码里 `runtimeConfig.magicContext.enabled` 只等于 `features.magicContext`（`runtime-config.ts:192`：`options.runtimeConfig?.magicContext?.enabled ?? configResult.config.features.magicContext`），**不含** `config.magicContext.enabled`。
  - 装配门 `create-app.ts:779` 只查 `runtimeConfig.magicContext?.enabled === true`（= features flag）；`createMagicContextTurnTransform({ enabled: true })` 的 `enabled` 是**硬编码 true**（`create-app.ts:788`），与 schema 的 `magicContext.enabled` 无关。
  - `config.enabled` 全仓只被 `findConfigReadinessError`（`schema.ts:240`：`if (config.enabled && !config.historian.model) return ...`）读一次，且仅决定是否打「historian 未配模型」告警——**从不参与任何行为门**。core 第二层门 `magic-context-turn-transform.ts:211` 读的是冻结的 `runtime.config`，注释 `:209` 声称「Step 23 接 ConfigPort 热更新后，运行中改配置必须立刻生效」与实现（读启动期冻结值）不符。
  - 结果：用户在 `config.json` 或 D-12 设置页把 `magicContext.enabled` 置 `false`，transform 照常运行（改写消息、drop、起 historian 旁路请求），只是告警消失。设置页 `MagicContextSettingsForm` 确实把 `enabled` 作为表单字段提交（`magicContextSettingsForm.ts:126`）并经 `updateMagicContextConfig` 写盘+推 ConfigPort，UI 报「保存成功」但行为完全不变——用户被误导。
- **具体改法**：
  1. **最小改动（重启生效）**：在 `runtime-config.ts:190-193` 把 effective 算成 `features.magicContext && (configResult.config.magicContext?.enabled ?? true)`，使装配门与 core 第二层门都认这一位。
  2. **满足 D-12「无需 requiresRestart——热生效」（`spec.md:235`）**：`runtime.config` 是冻结的，需给端口加一个活值谓词（如 `isEnabled(): boolean`）由 `runMagicContextTurnTransform` 现读，或把 `enabled` 接入 `applyConfigToDeps` 并让 helper 读端口的 `getConfig()`。
- **验收/测试要点**：
  - ① `features.magicContext=true` + `magicContext.enabled=false` 冷启动 → turn-loop 不插桩、ctx 工具不注册、historian 不起、无 DB 写（flag off 零差异，T-M8 语义）。
  - ② 设置页切换 `enabled` → 下一 turn 生效（或明确标注需重启）。
  - ③ 负向单测：`enabled=false` 时 `runMagicContextTurnTransform` 逐引用返回入参数组。

---

### review-mc-host/C-orch-2 — P1 — historian scheduler 的 shutdown abort 信号在装配层被丢弃

- **维度**：C-orch
- **文件**：
  - `apps/zcode-cli/packages/bootstrap/src/app/magic-context-historian.ts:339`（`runSession: async (sessionId) => runPass(sessionId, false)`，**无 signal 形参**）
  - 同文件 `:315-333`（`runPass(sessionId, forceDrainQuota)`，无 signal）→ `:401-416`（`runOneCompartmentPass` input 无 signal 字段）→ `:475`（`startCompartmentAgent(runnerDeps)`，无处接 abort）
  - `apps/zcode-cli/packages/magic-context/src/core/features/magic-context/historian-scheduler.ts:97`（`runSession(sessionId, signal)` 契约）、`:132`（`await options.runSession(sessionId, shutdownController.signal)`）、`:92-97`（注释 MUST honour signal）
  - `apps/zcode-cli/packages/magic-context/src/host/hidden-completion-executor.ts:295/301/391`（executor 仅有自己的 `slot.controller`，管超时/close，收不到外部 abort）
- **描述**：包侧调度器把 `shutdownController.signal` 传进 `runSession`，但装配实现 `runSession: async (sessionId) => runPass(...)` **第二个参数没有形参**，signal 在装配层就被丢掉，一路到 `startCompartmentAgent` 都没接进去。executor 内部另有自己的 `slot.controller` 负责超时与 close，但那不是 scheduler 的 shutdown signal。**后果**：`shutdown()` 只能停「继续调度」，停不掉已经在飞的 provider 请求——正是包侧文件头 `:32-36` 声称要避免的情况（「a closed session's historian must stop requesting models and stop writing compartments」）。当前因 C-orch-4（无调用方）而潜伏，修好调用方后立即显形。
- **具体改法**：给 `runPass` / `runOneCompartmentPass` input 加 `signal?: AbortSignal`；装配层改为 `runSession: async (sessionId, signal) => runPass(sessionId, false, signal)` 并透传。executor 需提供外部 abort 注入点——最小改法是给 `createHiddenCompletionExecutor` 的 options 加 `externalSignal?: AbortSignal`（或在 `open` 里把外部 signal 转发到 `slot.controller.abort`），使 scheduler 的 abort 能抵达 provider 请求。
- **验收/测试要点**：单测——`notifyTurnSuccess` 后立刻 `shutdown()`，断言 `onError`/日志出现 `aborted`，且 mock sidecar 收到的 `abortSignal` 变为 aborted。

---

### review-mc-host/C-orch-3 — P1 — 调度器 fire-and-forget pass 无 settle 保护，与 S24-fix2 前提冲突

- **维度**：C-orch
- **文件**：
  - `apps/zcode-cli/packages/bootstrap/src/app/magic-context-turn-transform.ts:1132-1157`（顺序：`:1133 await transform` → `:1137 await settleInFlightHistorian` → `:1156 onPassSucceeded` → return）
  - 同文件 `:832-842`（`notifyPassSucceeded` → `:839 historianScheduler.notifyTurnSuccess`）
  - 同文件 `:970-1007`（S24-fix2 注释与 `settleInFlightHistorian`）
  - `apps/zcode-cli/packages/magic-context/src/core/features/magic-context/historian-scheduler.ts:20-22`（fire-and-forget 契约）
- **描述**：执行顺序显示——`settleInFlightHistorian(:1137)` 只等 transform **内部那条** `getActiveCompartmentRun`；`:1156` 的 `onPassSucceeded` 才触发调度器起**另一条** compartment run（`runOneCompartmentPass` → `startCompartmentAgent`），而这条是纯 fire-and-forget、无任何等待。也就是说 turn 成功后 drain 的主路径（调度器那条）恰好落在 `:1137` settle 之后、`return` 之前，进程随即退出。`:970-985` 的 S24-fix2 注释明确说「一进程 = 一轮 prompt，historian 还在飞的那几秒会随进程一起消失（drain 预留泄漏、compartment 不落库）」并为此加了 settle——但调度器这条未被保护，系统性被进程退出截断，与该注释的前提直接矛盾。
- **具体改法**：把对调度器新起 run 的有界等待补上——在 `:1156` 之后（或让 `onPassSucceeded` 返回一个可等待句柄）对调度器 run 再 `await settleInFlightHistorian(sessionId)`，注意避免与 `:1137` 重复等待同一条 run。若决定调度器 pass 就是 best-effort，则必须修正 `:970-985` 与 `historian-scheduler.ts:20-22` 的注释，去掉「已 settle」的误导。
- **验收/测试要点**：集成测试——stub historian 模型，turn 成功后进程立即结束，断言 compartments 已落库且 drain 预留未泄漏（下一轮不出现 `historian skip: internal drain budget spent`）。

---

### review-mc-host/C-orch-4 — P1 — shutdown/drain/dispose 全部无调用方，且 spec 的会话生命周期 drain 接线缺失

- **维度**：C-orch / G
- **文件**：
  - `apps/zcode-cli/packages/bootstrap/src/app/magic-context-historian.ts:374`（`shutdown: () => historianScheduler?.shutdown()`）
  - `apps/zcode-cli/packages/magic-context/src/core/features/magic-context/historian-scheduler.ts:235-255`（`drainHistorianSchedulerWithTimeout`，`index.ts:214` 导出）
  - `apps/zcode-cli/packages/bootstrap/src/app/magic-context-turn-transform.ts:731`（建 bridge）、`:821`（`bridge.onChange`）、`:882`（`configPort.observe().subscribe`）
  - spec host 适配表 `spec.md:192`（列出 `hooks.ts` 承担「session start/end、turn 后 drain」）
- **描述**：`git grep` 全仓确认——
  - `drainHistorianSchedulerWithTimeout` 除定义与包 barrel 外**无生产调用方**（仅 `magic-context/scripts/test-historian.mjs` 覆盖）。
  - `MagicContextHistorianHost.shutdown` 被 `createMagicContextTurnTransform`（`:779`）持有后，**无会话关闭/App 退出钩子调用**。
  - `config-bridge.dispose()`（`config-bridge.ts:131-134`）**无调用方**，`configPort.observe().subscribe`（`:882`）的订阅在 App 生命周期内不解除。
  - spec 明确列出的 host 侧 `hooks.ts`（session start/end、turn 后 drain 生命周期接线）在 HEAD 的 `magic-context/src/host/` **不存在**（该目录 11 文件，无 hooks.ts）。
  - 后果：会话关闭后 historian 仍可能在飞并继续写库；配置订阅泄漏；与 `app/types.ts:114` 注释「关闭时终止在飞的 historian」存在落差。
- **具体改法**：新增 host 侧生命周期接线（或直接在 bootstrap 装配层）：会话结束/App 退出时先 `await drainHistorianSchedulerWithTimeout(historianScheduler)` 再 `historianScheduler.shutdown()`，并 `bridge.dispose()`。给 `createMagicContextTurnTransform` 返回值加可选 `dispose?(): Promise<void>`，由 create-app 在 app close 钩子调用。**本项是解锁项**——修好后 C-orch-2（abort）与 C-orch-3（settle）的保护才真正生效，当前二者均被「无调用方」掩盖。
- **验收/测试要点**：单测——创建 transform → 触发 pass → 调 `dispose` → 断言 scheduler 已 inert（`hasPendingWork()` 假、`notifyTurnSuccess` 变 no-op）且 drain 在 timeout 内返回；configPort 订阅计数归零。

---

### review-mc-host/G-5 — P1 — `/ctx-*` 命令面不认 effective flag：off 态仍开库，且 `/ctx-reduce` 以 `harness="opencode"` 错写

- **维度**：C-orch / G
- **文件**：
  - `apps/zcode-cli/packages/cli/src/command-center/handlers/ctx.ts:72-75`（缺席判定**只看** `import()` 是否失败）、`:39-42`（自述意图：off 时不该拉模块图）
  - 同文件 `:217-226`（`reduce` 自建 `createCtxReduceTools({ db })`，**绕过** runtime 工具注册门 `runtime-tools.ts:89`）
  - `apps/zcode-cli/packages/magic-context/src/core/features/magic-context/storage-ops.ts:94`（`queuePendingOp` 写 `getHarness()`）
  - `apps/zcode-cli/packages/magic-context/src/host/harness.ts:57-77`（`initializeMagicContextHost` 唯一定义 harness="zcode"，`:5-10` 自称跨 harness 归因是 "correctness bug"）
  - `apps/zcode-cli/packages/magic-context/src/core/shared/harness.ts:34`（默认 `currentHarness="opencode"`）
  - `apps/zcode-cli/packages/magic-context/src/host/ctx-status.ts:191-197`（`openDefaultDatabase` 无 try/catch）
- **描述**：两处同源（flag 门缺失）：
  - ① **off 态开库**：flag off 时 `import("@zcode/magic-context")` 恒成功（包已安装）→ `/ctx-status` 等仍走 `openDatabase(getMagicContextDatabasePath())`，可能创建/迁移 db，与 `ctx.ts:39-42` 与 `ctx-status.ts:186-190` 自述意图（off 态不该因诊断面开库）只在模块图层面成立、DB 层面不成立。`openDefaultDatabase` 无 try/catch，异常冒到 `ctx.ts:88-90` 显示 `Magic Context command failed`，而非 `ctx-status.ts:83-85` 承诺的「返回 null 由调用方决定」。
  - ② **harness 错写**：`initializeMagicContextHost()` 只在 `createMagicContextTurnTransform` 里被调（受 flag 门保护）；flag off 时 harness 仍是 core 默认 `"opencode"`。而 `/ctx-reduce` 绕开 runtime 工具注册门自建工具 → `queuePendingOp` 写入 `pending_ops.harness="opencode"`，即包内 `harness.ts:5-10` 自称的跨 harness 归因 bug。flag on 时（`createMagicContextTurnTransform` 已跑）harness="zcode"，故错写仅发生在 flag off 路径。（读面 `getPendingOps`/`ctx-status` 按 `session_id` 查、不带 harness 过滤，`storage-ops.ts:27/105`、`ctx-status.ts:157/174`，故 `/ctx-status` 数字不受影响，错写只污染归因列。）
- **具体改法**：
  1. 在 `handleCtxCommand` 里、`loadMagicContext()`/开库**之前**先取 effective flag（`features.magicContext && magicContext.enabled`），为 false 直接返回 `MAGIC_CONTEXT_UNAVAILABLE`（与 `:57-58` 文案一致），不 import、不开库、不写。该 flag 需从 app 能力暴露——参照 `app/types.ts:622-634` 的 `getConfigPort?()` 可选能力模式，在 `CommandCenterApp`（`cli/…/types.ts:185`）上加 `isMagicContextEnabled?(): boolean`，由 create-app 用与 runtimeConfig 同一 effective 值填充。
  2. （退路，若只做 ②）至少在 `reduce`/`recomp` 写库前调 `initializeMagicContextHost()` 保证 harness 正确。
- **验收/测试要点**：① flag off 敲四条命令 → 全部回 UNAVAILABLE，不新建/迁移 magic-context.db；② flag on 敲 `/ctx-reduce` → `SELECT harness FROM pending_ops` 为 `"zcode"`；③ flag off 敲 `/ctx-reduce` → 不写库。

---

### review-mc-host/G-6 — P2 — `publishUsageSummary` catch 空实现与注释/契约不符

- **维度**：G
- **文件**：`apps/zcode-cli/packages/bootstrap/src/app/magic-context-turn-transform.ts:806-814`
- **描述**：注释承诺「读不出来就推 null：投影层据此删掉该键，面板整段收起」，但 `.catch(() => { /* 注释 */ })` 是**空体**，未调 `sink(null)`；与 `app/types.ts:186-188`「传 null = 投影层删掉该键」的契约不一致。失败时 UI 保留上一帧旧值而非收起面板。虽 `readMagicContextUsageSummary` 自带 catch（`usage-summary.ts:74-76` 返 `{usage:null}`）使外层 catch 极少触发，但 `readMagicContextStatusSnapshot` 若走未捕获路径会落到这里。
- **具体改法**：`.catch(() => { sink(null); })`（或 `.catch(() => sink(null))`）。
- **验收/测试要点**：单测——mock `readMagicContextUsageSummary` 抛异常，断言 sink 收到 `null`。

---

## 2. open_questions

1. **preserveProviderStreamBoundaries 跨包字面量弱化（证据包 5.10）——我的裁决：已接受设计，非问题**。
   - 字面量硬约束活在包内 host 层 `SidecarModelCallOptions`（`hidden-completion-executor.ts:71-82`），这是 historian 契约的正确归属。
   - 装配层 `createZCodeSidecarModelCall` 的 `options` 参数类型即该接口（`magic-context-historian.ts:174` 签名 `(request, options: SidecarModelCallOptions)`），故 `options.preserveProviderStreamBoundaries`（`:207`）**静态就是 `true`**，bootstrap→core 这一跳类型上无法传 `false`。
   - core 原语 `sidecar-model-request.ts:30` 放宽成 `boolean|undefined` 不削弱生产路径（core 是通用 sidecar 门面），且有运行期测试钉住转交（`bootstrap/scripts/test-magic-context-historian.mjs:246-270`）与包侧负向 typecheck（`magic-context/scripts/test-historian.mjs:348-395`）。
   - 保留为 open_question 的理由：「core 原语是否应保持通用 vs. 也用字面量 `true`」是设计取舍，交 owner 拍板；若要求更严，可给 `SidecarRequest.preserveProviderStreamBoundaries` 也用字面量，但那是接口洁癖、非缺陷。

2. **historian.\* / language 不热生效（证据包 5.9）——不算偏离，但需澄清 Step 16 判据**。
   - spec:214 明说「热生效契约仅覆盖 pass 级字段（E 组白名单）」；`historian.*` 属装配期闭包值（`magic-context-historian.ts:279-311`），不在白名单内，故不构成偏离。
   - 但 Step 16 行文（`spec.md:274`「改 ConfigPort 后下一个 turn 读到新值，无需重启」）字面上像是覆盖全部字段。请 owner 明确 Step 16 验收判据是否限定 E 组白名单；若不限定，则 `historian.model` 从空改有值需重启与行文有张力。

3. **`/ctx-status` 双渲染并存（证据包 5.11）——P3，待定**。包侧 `formatMagicContextStatusSnapshot`（`ctx-status.ts:122-147`）HEAD 已无生产调用方（只剩 `cli/scripts/test-ctx-commands.mjs` 断言），且排版与 CLI 侧 `formatCtxStatus` 不同（pending 位置）。是清理还是保留待 owner 定。

4. **`readMagicContextConfig` 的 `fromConfigPort` 死字段（证据包 5.8）——P3**。`magic-context-config.ts:80-86` 命中 ConfigPort 直接 return 不打日志，`:97-103` 日志里 `fromConfigPort:false` 硬编码，该字段永远只能 false。建议顺手修正但不阻塞。

---

## 3. spec_deviations

| id | 状态 | 说明 |
|---|---|---|
| SD-1 | **open** | spec 契约 8（`spec.md:214`）`effective = features.magicContext && magicContext.enabled` 未实现——装配门只看 features flag，用户级 `enabled` 无任何行为效果，UI 暴露却无效。对应 must-fix **G-1 / P0**。 |
| SD-2 | **open** | spec host 适配表（`spec.md:192`）列出的 `hooks.ts`（session start/end、turn 后 drain 生命周期接线）缺失，导致 shutdown/drain/dispose 零调用方。对应 must-fix **C-orch-4 / P1**。 |
| SD-3 | **fixed（已拍板，非偏离）** | `/compact` 命令面移除——spec D-7 全量删除清单（`spec.md:43`、`:221-222`）明确含「cli：`command-center/slash-commands.ts` 的 compact 解析、`slash-command-types.ts`、`create.ts` compact 分支」与「`/compact` 命令注册」，与 HEAD 改动一致。裁决：**符合 spec，不是偏离**，close。 |
| — | 已吸收 | `/ctx-status` off 态建库 → 并入 must-fix G-5。historian 默认 off（需配 model）→ 符合 `findConfigReadinessError` + D-6/S16 设计，不列偏离。 |

---

## 4. 结论

**scope-ready: no**

理由：
- 存在 1 条 **P0**（G-1：`magicContext.enabled` 用户级二级开关完全失效——spec 明文契约失效，且 D-12 设置页暴露该开关却无行为效果，用户被误导）。
- 存在 4 条 **P1**，集中在两处：
  - historian 生命周期的装配/时序（C-orch-2 abort 丢弃、C-orch-3 settle 缺口、C-orch-4 零调用方）。C-orch-4 是**解锁项**：它修好后 C-orch-2/3 的保护才真正生效，当前二者被「无调用方」掩盖。
  - ctx 命令面 flag/harness 门缺失（G-5）。
- 1 条 **P2**（G-6）。

建议：先按 must-fix 逐条产出 fix-spec（G-1 优先，其为 P0 且改动面最小——`runtime-config.ts` 一处），再处理 C-orch 组（建议 C-orch-4 与 C-orch-2/3 一并设计，C-orch-4 提供调用点、C-orch-2/3 提供 abort/settle 语义），最后 G-5/G-6。preserveProviderStreamBoundaries 一条经复核判为已接受设计，无需改动。

---

*评审完成（readonly）。所有 file:line 均基于 HEAD=aba59a9 工作树回读复核。本文件为本次评审唯一写入产物，未改动任何代码/文档。*