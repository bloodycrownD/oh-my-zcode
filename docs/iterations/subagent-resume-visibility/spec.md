---
date: 2026-10-12
---

# 失败/停止子 agent 的续跑可见性（subagent-resume-visibility）技术规格（SPEC）

## 需求来源

- 非标准 PRD 输入：用户口述（2026-10-12 会话）拍板 A 方案。
- 调查记忆：`docs/apm/memory/20261012-subagent-agentid-resume-gap.md`（含 A/B/C 三档方案与完整证据链）。
- 需求一句话：**失败/停止的子 agent 在收口输出中透出 agentId，并告知父模型可用 SendMessage 续跑**——运行时 resume 机制本就覆盖全部终态（`resumeTerminalAgentInBackground` 对 failed/stopped/killed 一律可续），缺的只是模型侧句柄可见性。

## 设计目标

1. 前台同步失败的 Agent 工具结果中，父模型能看到 agentId 与「SendMessage 可续跑」指引。
2. 后台失败/停止的 `<task-notification>` 中，追加与 workflow `workflowDeliveryGuidance` 同范式的续跑指引（`<task-id>` 即 agentId，现状已有，缺指引句）。
3. SendMessage / Agent 工具描述与实际运行时能力对齐：终态（completed/failed/stopped）均可续跑（现描述只说 completed）。
4. 为「终态 SendMessage resume」这一完全无覆盖的行为补回归网。
5. 显式声明决策反转：推翻 `docs/.iteration-state.yaml` phase2a 登记的旧方法论「同步 agent 失败不回 agentId（无法 SendMessage 续）→ 长任务一律后台派」——本迭代让同步失败也可续，后续 CR 不得按 regression 上报。

### 明确不做（防 scope creep）

- **不动 `AgentOutputSchema` union**（不加 failed 形态 = B 方案范畴）：`test-subagent-sync-dispatch.mjs` T-D1c 断言 `branches.length === 2`，保持成立。
- **不动 `SendMessageOutputSchema`**（不加 resumable 字段）：schema 是 `.strict()`，动则 contracts + handler + UI display 三处连锁；`delivery: "resumed_background"` 已够用。
- **不动 UI renderer**（`result-display.ts` / `send-message.tsx`）：纯通知/错误文案追加，UI 无需感知。
- **不做 registry 持久化**（C 方案）：跨重启续跑仍不可用，指引文案以「本会话内」限定，SendMessage 失败兜底句提示句柄的会话边界。
- **不覆盖「用户中断 turn」的模型可见性**：turn 被中断后 tool result 不入 transcript（`call-runner.ts:132-138` 入口取消早退），该场景句柄只到 registry/`SubagentStopped` 事件（UI 可见）为止，列为已知边界。
- **不覆盖早期 setup 失败**（`registry.remove` 路径，runner.ts:290/556）：child session 未建立，无 resume 语义。

## 总体方案

三条透出通道 + 一层测试网：

| 通道 | 现状 | 改法 |
|---|---|---|
| ① 前台失败 tool result | 父模型吃 provider 根因原文（`modelContentForToolResult`：modelContent 优先、否则 stringify output；CoreError 的 message 通道经 `selectPrimaryErrorFrame` 投影后选中 provider 根因帧，context.agentId 被 `formatContextDetail` 白名单丢弃） | **Agent handler 层 catch 后 rethrow 增强版 CoreError**：命中识别条件（见下）时构造新 CoreError——message/cause 保持原错误链（provider 根因仍为 primary frame），`context` 追加 `toolHandlerFailure: { result: false, errorCode: <number>, message: <agentId + 续跑指引句> }` 并标 `ErrorPayloadRole.Wrapper`；executor 的 `createErrorResult` 会把 `toolHandlerFailure.message` 包成 `<tool_use_error>` 信封作为 modelContent 投给父模型。辅：`formatContextDetail` 白名单加 `agentId`（条件投影，context 有才显示），让 detail（UI hover/日志）也带句柄 |
| ② 后台终态通知 | `<task-id>` = agentId 已在，无续跑指引 | `runtime-task/notification.ts` 的 `formatLocalAgentTaskNotification` 新增 `localAgentResumeGuidance`（仿 `workflowDeliveryGuidance`：放在 XML 之后、`truncateTaskNotification` 截断顺序上最后追加=先被斩），仅 failed/stopped 生效，completed 反向不出现；summary 前缀不动（UI Agent 卡「子智能体输出」来源，`completion-notification.ts:48-49` 注释锁定） |
| ③ 工具描述面 | SendMessage 描述只说 resume completed agent；Agent 描述缺上游 bullet（"Use SendMessage with the agent's ID to continue a previously spawned agent…"——`.reference/ZCode` agent.ts:107 有，fork 漂移丢失） | 两处描述补齐 + `runner.ts:981` "No active local_agent task found" 兜底句加会话边界提示 |

文案统一英文（provider 面），句式对齐既有惯例：`use SendMessage with to: '<agentId>' to continue this agent`（`formatAgentOutputForModel` 已用同款，agent.ts:174/182）。

### 通道① 的关键实现约束（第 1 轮审查核正后的 executor 契约）

- 模型可见内容 = `modelContentForToolResult(result)`（`runtime/helpers/tool-result.ts:62-65`）= `result.modelContent ?? stringifyToolResultOutput(result)`。**只改 CoreError message 不进模型**——那是 error.message 通道，经 `selectPrimaryErrorFrame` 选中 provider 根因帧（"Explore subagent failed" 被标 `ErrorPayloadRole.Wrapper`，刻意让 provider 原文当 primary，这个语义保留）。
- **executor 出口契约（硬约束，第 1 轮审查核正）**：handler 返回值只有两条路——(a) `ToolHandlerFailure` 形（`{ result: false, errorCode: <number>, message: string }`）被 `call-runner.ts:407-411` 转为 throw，由 `createErrorResult`（`tool/executor/errors.ts:14-22, 63-87`）把 `message` 包成 `<tool_use_error>` 信封当 modelContent；(b) 其它返回值过 `validateOutput`（`tool/executor/validation.ts:9-40`，Agent 的 `runtimeOutputSchema` 是 `AgentOutputSchema` 严格 union）——handler **无法**直接返回自定义 `{ error, modelContent }` 形状（会被校验吞掉）。
- 因此通道① 落地机制为 **rethrow 增强版 CoreError**：handler catch 后构造 `createCoreError(ToolExecutionFailed, <沿用原 message>, { cause: 原 error, context: withErrorPayloadRole({ ...原 context, toolHandlerFailure: { result: false, errorCode: <number>, message: <guidance 文案> } }, ErrorPayloadRole.Wrapper) })` 再 throw——投影层 primary frame 落到 cause 链（provider 根因仍是 `error.message`），`createErrorResult` 从 `context.toolHandlerFailure.message` 铸 `<tool_use_error>` 信封进 modelContent。
- **errorCode 必须是 number**（先例 `EditErrorCode`，`contracts/src/tools/edit.ts:179-190`；Agent 契约现有 `agent_child_runtime_failed` 是字符串、不能直接用）：本迭代落 core 侧常量（`tool/handlers/agent.ts` 局部，取值避开既有域），不动 contracts schema。
- **识别条件（第 2 轮审查核正）**：`isCoreError(error)` 且 `error.context?.agentId` 存在，**且** handler 可达的 registry（`call-runner.ts:373` 注入 `context.runtimeTaskRegistry`，optional 字段需可空判）中 `get(agentId)` 返回非 undefined——接口方法为 `get(id): RuntimeTaskSnapshot | undefined`（`runtime-task/registry.ts:70-94`），**无 `getRuntimeTask`、无按 parent 反查接口**。在册校验把 setup 窗口取消（`runner.ts:290/556` `registry.remove`，无 resume 语义，指引必空头）排除；failed/killed 终态 task 保留在册，指引有效。未命中原样 rethrow（不影响其它错误路径）。
- **主场景句柄来源（第 2 轮审查发现的缺口，必须闭合）**：child 模型/provider 失败到达 handler 的 CoreError **不带 agentId**——child turn 错误经 `createTurnFailureError` 产出（`runtime/methods/turn.ts:659-739`、`runtime/helpers/turn-errors.ts:88-126`，context 无 agentId），`runner.ts:458-460` 对 CoreError 原样 rethrow，`runner.ts:462-476` 的带 agentId wrapper 仅在**非 CoreError** 分支构造。而 agentId 由 `registry.register` 在 launch 内部生成，handler 侧无句柄来源、registry 无反查接口——识别条件要命中主场景，**必须在 runner 侧补一处**（见 C8）：`run()` catch 的 CoreError 原样 rethrow 分支（`runner.ts:458-460`）rethrow 前把 `agentId`（连同 `agentType`/`parentToolCallId`）合并进 CoreError 的 context（**不改动其 errorPayloadRole**，投影 wrapper 结构不变；CoreError 是 interface、`context` 为 optional 可变属性——`contracts/src/errors/index.ts:63`）。此为「失败 agent 透出 agentId」主场景的唯一闭环路径（第 2 轮审查方案 2；其方案 1 的「registry 反查」在接口上不成立）。**合并方式钉死（第 3 轮审查 P1-1）**：`error.context = { ...error.context, agentId, agentType, parentToolCallId }` 浅拷贝替换（兼容 `turn-errors.ts:95-99/113-117` 产出的 context 为 undefined 的 CoreError，防二次 TypeError 吞掉原始 provider 错误），**禁止原地 mutation**。
- **code 表面变化（第 2 轮审查 P2-4 登记）**：命中 toolHandlerFailure 后 `createErrorResult` 用 `String(handlerFailure.errorCode)` 覆盖 projected code（`tool/executor/errors.ts:47-51`）——前台失败的 `error.code` 从 `agent_child_runtime_failed` 漂移为数值字符串（UI hover/遥测读者可感知的对外表面变化）。接受此变化，T-RV1 加 code 断言锁住新值。**双轨说明（第 3 轮审查 P2-1）**：detail 面经 C2 白名单投影的 `code` 仍来自原 context（`agent_child_runtime_failed`，非 CoreError 场景 runner wrapper 所带），即 `error.code`（数值串）与 detail.code（原字符串）双轨并存——接受，不加断言强锁。
- `ToolCancelled` 路径：turn 已取消时 result 可能被丢弃（`call-runner.ts:132-138` 入口取消早退），构造它无害且有备无患（transcript 若能写入则句柄可见）。
- modelContent 受 Agent 工具 `maxModelBytes: 120_000` 与 provider-visible-order 截断约束——追加单句指引远低于阈值，无实质风险。
- **不动 `call-runner.ts` / `errors.ts` 的公共 catch 链**：那是全工具共用面；只在 agent handler 收口，影响面最小。

## 最终项目结构

```
apps/zcode-cli/packages/
  contracts/src/tools/
    send-message.ts                      # 不动（schema 不变）
    agent.ts                             # 不动（AgentOutput union 不变）
  core/src/
    subagent/runner.ts                   # :981 兜底句；run() catch CoreError rethrow 前附 agentId context（C8）
    subagent/completion-notification.ts  # 传终态信号给格式化层（status 已在 input，实际只需确认透传）
    runtime-task/notification.ts         # formatLocalAgentTaskNotification + localAgentResumeGuidance
    errors/error-payload.ts              # formatContextDetail 白名单 + agentId（条件投影）
    tool/handlers/agent.ts               # execute 包 catch：modelContent 透出；AGENT_PROVIDER_DESCRIPTION 补 bullet
    tool/handlers/send-message.ts        # SEND_MESSAGE_PROVIDER_DESCRIPTION 扩终态语义
  core/scripts/
    test-subagent-notification-resume-hint.mjs   # 新增
    test-error-payload-agentid-projection.mjs    # 新增
    test-send-message-terminal-resume.mjs        # 新增
    test-subagent-sync-dispatch.mjs              # 扩充（前台失败 modelContent 用例）
  core/package.json                      # +3 个 test:<name>
package.json                             # test:v4-perf 串入 3 个新入口
CHANGELOG.md                             # Unreleased ### 修复 +1~2 条
docs/iterations/subagent-resume-visibility/     # 本 spec
```

## 变更点清单

| # | 文件 | 变更 | 依据（探索证据） |
|---|---|---|---|
| C1 | `core/src/tool/handlers/agent.ts` | execute 外包 try/catch：命中识别条件（CoreError + `context.agentId` + registry `get(id)` 在册）→ rethrow 增强版 CoreError（`context.toolHandlerFailure = { result: false, errorCode: <number>, message: "agentId: '<id>' (use SendMessage with to: '<id>' to continue this agent in this session)" }`，Wrapper role，cause 保持原错误链）；AGENT_PROVIDER_DESCRIPTION 补回上游 SendMessage bullet | 报告一 §2.3/§4；报告二 §2.3（.reference bullet）；第 1 轮审查 P0-2/P1-2；第 2 轮审查 P0-1/P1 |
| C2 | `core/src/errors/error-payload.ts` | `formatContextDetail` 白名单加 `agentId`（条件投影） | 报告一 §2.3（304-321 现八项白名单） |
| C3 | `core/src/runtime-task/notification.ts` | `localAgentResumeGuidance(status, taskId)`：failed/stopped 两支英文指引，XML 后追加（join 前 push，与 workflow 同款截断次序）；completed 无 | 报告二 §2.1（144-158 现形状 + 235-331 范式） |
| C4 | `core/src/subagent/completion-notification.ts` + `runner.ts` finalize 侧 | 确认 status 信号贯通（finalizeBackgroundFailure/Stopped → 格式化层）；summary 前缀不动 | 报告二 §2.1；风险 1 |
| C5 | `core/src/tool/handlers/send-message.ts` | 描述：resume 语义扩为**泛化终态**（"an agent that has finished or was stopped"——运行时对 `TERMINAL_STATUSES` 全集均可续，`registry.ts:103-110`）+ "within the current session" 限定 | 报告二 §2.3；第 1 轮审查 P2-1 |
| C6 | `core/src/subagent/runner.ts` | :981 失败兜底句追加「句柄仅本进程会话有效，重启后无法续跑」提示 | 报告三 §5.5 |
| C8 | `core/src/subagent/runner.ts`（`run()` catch，`458-460` CoreError 原样 rethrow 分支） | rethrow 前以 `error.context = { ...error.context, agentId, agentType, parentToolCallId }` **浅拷贝替换**（兼容 undefined context，禁止原地 mutation——第 3 轮审查 P1-1），**不动 errorPayloadRole**（投影 wrapper 结构不变）——主场景（child provider/模型失败）句柄的唯一来源；此前 spec 声明「runner 其余不动」由本条显式取代 | 第 2 轮审查 P0-1（`turn.ts:659-739`/`turn-errors.ts:88-126` 错误产出源核验）；第 3 轮审查 P1-1 |
| C7 | 测试四件 + 三处接线（core package.json、根 package.json:32 test:v4-perf、CHANGELOG） | 见测试策略 | 报告三 §4 |

## 详细实现步骤

- Step 1 — phase-fg-failure-handle — blocking: yes — qa: auto — C1+C2+C8：runner `run()` catch 的 CoreError rethrow 前附 agentId context（主场景句柄来源）；Agent handler 收口 rethrow 增强（`toolHandlerFailure` 通道 + numeric errorCode 常量 + registry `get(id)` 在册校验）；`formatContextDetail` 白名单加 agentId。验收：前台失败（注入 reject 的 `runExploreAgent`，**CoreError 与非 CoreError 两种形态各一组**）时投影后的 modelContent（`<tool_use_error>` 信封内）含 agentId 与 SendMessage 指引句；`error.message` 仍为 provider 根因原文（投影语义不变）；`error.code` 切为数值字符串（表面变化锁行为）；未带 agentId context 或 registry 不在册（如 setup 窗口取消）的异常原样 rethrow 不吞。
- Step 2 — phase-bg-notification-guidance — blocking: yes — qa: auto — C3+C4：`localAgentResumeGuidance` + finalize 侧贯通 + 截断次序（指引在 `</task-notification>` 之后、120k 截断先斩指引）。验收：failed/stopped 通知含指引句（含 `<task-id>` 引用），completed 通知不含；summary 前缀逐字节不变。
- Step 3 — phase-tool-descriptions — blocking: yes — qa: auto — C5+C6：两处工具描述 + runner 兜底句。验收：描述文本含终态续跑语义与会话限定。
- Step 4 — phase-test-coverage — blocking: yes — qa: auto — C7：三个新测试脚本 + `test-subagent-sync-dispatch.mjs` 扩充 + core/根 package.json 接线。注意：tsx `--test`（测源码）；涉 `SendMessageOutputSchema` 的用例复用 `registerHooks` 契约单实例钩子；夹具 `mkdtempSync` 临时 `outputRootDir`（E2E 隔离红线）；新入口排在 test:v4-perf 第 3 段 bootstrap 构建之前不受影响（跑源码无需 dist）。
- Step 5 — phase-docs-changelog — blocking: no — qa: auto — CHANGELOG Unreleased `### 修复` 1~2 条（「失败的子智能体结果现在携带 agentId 并支持 SendMessage 续跑」/「停止的后台子智能体通知增加续跑指引」）；`docs/.iteration-state.yaml` 手工登记决策反转条目（该文件非合法 YAML，**只人工追加、勿机器解析改写**）；APM memory 追加进展轮次。

## 测试策略

门禁口径（第 1 轮审查核正）：`pnpm --dir apps/zcode-cli typecheck`（turbo 聚合 CLI 侧 tsconfig——本迭代改动**全部**位于 `apps/zcode-cli/packages/{core,contracts}`，根 `pnpm typecheck` 的工程清单不含 `apps/zcode-cli`，用它则类型检查零覆盖）+ `pnpm test:v4-perf`（全绿）+ `pnpm lint`（根口径，不劣于现状）+ `pnpm knip`（零新增命中）。注意根 lint `ignorePatterns` 与根 typecheck 均不覆盖 `apps/zcode-cli` 子树——CLI 侧类型安全靠 `pnpm --dir apps/zcode-cli typecheck` 把关。

### 测试用例

- T-RV1 — blocking: yes — 前台失败收口（**双形态夹具**）：`makePort()` 注入 reject 的 `runExploreAgent` 各两组——(a) reject CoreError（模拟 child 模型/provider 失败，主场景，依赖 C8 附注句柄；其中一组用 **context 为 undefined** 的 CoreError，锁浅拷贝合并不炸，第 3 轮 P1-1）；(b) reject 非 CoreError（走 runner 462-476 wrapper 分支）。两组均断言：handler 抛出的 CoreError `context.toolHandlerFailure.message` 含 `AGENT_ID` 与 `use SendMessage with to:` 句；再对 handler 抛错经导出的 `createErrorResult`（`tool/executor/errors.ts`）做投影，断言 `modelContent` 的 `<tool_use_error>` 信封内含同句、`error.message` 为注入的根因原文、`error.code` 为数值字符串（P2-4 表面变化锁行为）。负例（第 3 轮 P2-2 钉死）：handler 直调——构造带 `context.agentId` 的 CoreError + **不含该 id 的 registry** → 原样 rethrow 不产生 toolHandlerFailure（setup 取消路径为「无 agentId + 不在册」双条件同时失败的实例，不必单独夹具化）。观测点说明：modelContent 由 executor 层铸造，port/handler 直调看不到，须组合 `createErrorResult` 断言（不引入 `executeToolCall` 全量 deps 夹具）。（映射 Step 1；扩充进 `test-subagent-sync-dispatch.mjs`）
- T-RV2 — blocking: yes — 投影白名单：构造带 `context.agentId` 的 wrapper CoreError → `projectExecutionErrorPayload().detail` 含 `agentId=<id>`；无 agentId 的错误 detail 不多字段。（Step 1；`test-error-payload-agentid-projection.mjs`）
- T-RV3 — blocking: yes — 通知指引三态：failed/stopped 通知文本含续跑指引句且 `<task-id>`=agentId；completed 通知**不含**指引（反向锁）；summary 前缀与现状逐字节一致；另构造超长 `<result>`（>120k）断言指引先于正文被斩（截断次序，第 3 轮 P2-3 补）。（Step 2；`test-subagent-notification-resume-hint.mjs`）
- T-RV4 — blocking: yes — 终态 SendMessage resume（当前全仓零覆盖的行为契约）：registry 置 failed 与 killed 两态 task → `sendMessage` → 输出过 `SendMessageOutputSchema.safeParse` + `delivery === "resumed_background"` + `message` 含 `was stopped (<status>)` + `agentId`。夹具事实（第 1 轮审查补）：snapshot 必带 `childSessionId`（否则 `createSubagentLifecycleFromTask` 返回 undefined 走 failure 分支，`runner.ts:918`）；注入的假 `runExploreAgent` 须调 `request.onSessionReady?.()` 放行 readyGate（`runner.ts:1089-1115`；范式见 `test-subagent-sync-dispatch.mjs:284-301` 的 `makeGatedChild`）；profile 无虞（`normalizeAgentProfiles` 恒含 general-purpose 内置，`subagent/profile.ts:97-108`）。（Step 4；`test-send-message-terminal-resume.mjs`）
- T-RV5 — blocking: yes — 描述面：`SEND_MESSAGE_PROVIDER_DESCRIPTION` 含终态续跑语义（泛化措辞：finished or was stopped，覆盖 `TERMINAL_STATUSES` 全集 completed/failed/cancelled/killed/stopped/lost，`registry.ts:103-110`——不按三终态窄写）；`AGENT_PROVIDER_DESCRIPTION` 含 continue-a-previously-spawned-agent bullet。落点钉死：并入 `test-subagent-sync-dispatch.mjs` 扩充（与 T-RV1 同脚本，避免跨 Step 改同文件）；两个描述 const 均**未 export**——Agent 侧经 `agentToolEntry.metadata.description`（`agent.ts:152/259`）、SendMessage 侧经 `sendMessageToolEntry.metadata.description`（`send-message.ts:25/89`）断言。（Step 3/4）
- T-RV6 — blocking: yes — 不回归：T-D1c `branches.length === 2` 与 `AgentOutputSchema` 断言保持绿（A 方案不动 union 的守门断言）。（Step 4）

## 风险与回滚方案

| 风险 | 评估 | 缓解 |
|---|---|---|
| handler catch 吞错改变现有错误路径 | 识别条件窄（`isCoreError` + `context.agentId` + **registry `get(id)` 在册**），其它异常原样 rethrow；setup 窗口取消（已 remove）被在册校验排除，不做清单自洽 | T-RV1 四断言（toolHandlerFailure 有句 / 信封 modelContent 有句 / error.message 原文不变 / code 数值串 + 不在册不吞） |
| C8 改 runner 收口行 | 单点 context 合并、不动 errorPayloadRole；CoreError 原投影 wrapper 结构不变 | T-RV1(a) 组即主场景回归；detail 断言（T-RV2）覆盖 agentId 投影 |
| 参考仓 `.reference/ZCode` vitest 断言会红（subagent-background.test.ts 精确 XML 断言等） | `.reference` 未跟踪、不进 CI，无实际影响 | spec 明示；未来若回导套件需同步订正断言 |
| 指引文案跨重启是「空头支票」 | registry 纯内存，重启后 SendMessage 必失败 | 指引句带 in-this-session 限定 + C6 兜底句；根治属 C 方案 |
| `formatContextDetail` 白名单是跨工具共用面 | agentId 为条件投影（context 有才显示），当前仅 subagent 链路使用该 key | T-RV2 正反向断言 |
| 120k 截断挤压通知正文 | 指引排最后=先被斩，与 workflow 同款取舍 | T-RV3 含截断顺序断言（构造超长 result 验证指引先斩） |
| 决策反转被 CR 误报 regression | `.iteration-state.yaml` 有旧方法论登记 | Step 5 显式登记反转；spec 设计目标 #5 声明 |
| 回滚 | 每 Step 独立 commit，revert 单 commit 即回退；无 schema/持久化变更，无数据迁移 | — |

## 验收矩阵

| 用例 | Step | 门禁 |
|---|---|---|
| T-RV1/T-RV2 | Step 1 | test:v4-perf 新入口 |
| T-RV3 | Step 2 | test:v4-perf 新入口 |
| T-RV5 | Step 3 | test:v4-perf |
| T-RV4/T-RV6 | Step 4 | test:v4-perf（T-RV4 为本迭代核心新增覆盖） |
| CHANGELOG/state 登记 | Step 5 | 人工 review |
