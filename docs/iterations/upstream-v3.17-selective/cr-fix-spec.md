# CR Fix Spec: oh-my-zcode 权限安全 + MCP/适配器修复（工作区未提交改动）

## 元信息

- repo：`D:\Dev\Js\oh-my-zcode`（apps/zcode-cli monorepo，分支 `upgrade/317-p0-security`，HEAD `36bc100f`）
- base_sha：`36bc100f`；head_sha：工作区（`git diff HEAD`，含 staged 的 33 个测试删除）
- prd_path：未提供
- spec_path：`docs/iterations/upstream-v3.17-selective/{BRIEF,PLAN,analysis-*}.md`、`SUMMARY.md`
- review_round：3（CR 循环）+ spec-check 1（用户限定各一轮）
- 状态：execute-ready 待用户确认（spec-check round 1 判 No-Go 的 P0=1/P1=4/P2=9 已全部 doc-fix 闭合，未做第 2 轮验证）
- 评审模式：diff（round 1 三 scope 并行首诊 → round 2 复审校验诊断与可执行性 → round 3 review-full 终局校验 → spec-check round 1 文档可执行性闸门）

评审来源与计数（与正文一致）：

| scope | 文件 | P0 | P1 | P2 |
|---|---|---|---|---|
| SA | permission service + executor 链 + bash 只读策略（10 文件） | 1 | 3 | 10 |
| SB | adapters/runner.ts + core/runtime MCP（4 文件） | 0 | 2 | 8 |
| SC | 12 个测试改动 + 33 个删除 + 脚本/文档 | 0 | 4 | 9 |
| N | 跨 scope 新发现（N1/N2 为 P1，N3/N4/N5 为 P2） | 0 | 2 | 3 |
| 合计 | | **1** | **11** | **30** |

> round 2 调整：SA-A4、SB-B8 由 P2 升 P1；新增 N1（doom-loop 会话豁免死代码）、N2（账号符号残留导致 7 个未删文件无法 import）两条 P1；SA-A9（sed 是否放行带文件参数的替换）移入 Open questions。
> round 3 新增：N3（TUI 不认 `no-always-allow`）、N4（权限新分支缺日志）、N5（`fullAccessSupported` 泄漏进 v3 strict schema）三条 P2；并修正 SC-C2 符号清单、SB-B10 红绿预期、OQ 与 must-fix 重复计。

---

## Must-fix（按 P0 → P1 → P2）

### SA-B1 [P0] hook 改写后重判为 deny 时被降级成可点的确认窗

- 维度：B（兼 D）
- 文件：`apps/zcode-cli/packages/core/src/tool/executor/permission-responder-race.ts:306`、`permission-flow.ts:252-289`
- 问题：`if (recheck.permissionDecision.decision !== "allow")` 把 **deny 和 ask 一起**当成「需要重问」，返回 `rewriteInput`。`permission-flow.ts:277` 以该 deny 决策 `continue` 进下一轮 `runPermissionAskRace`，循环结束后放行判定只看 `resolvedPermission`（326-400），不再回头看 `permissionDecision.decision`；用户点「允许一次」即执行被 deny 的输入。HEAD 在同一分支是 `brokerResult={decision:"deny"}` + `useNormalizedHookModifiedInput=false`（fail-closed），本改动把它打开成可确认。
  **真实可达路径只有 `rule.project.deny` / memory-file deny**（`permission-input-recheck.ts:63-88` 只在 deny / ask 时回传 decision）：Plan 下 `Read` 在 `service.ts:503-509` 直接 allow、`permission-flow.ts:163` 提前返回，不会进 ask 循环；hook 改的是 input 不是工具名，重判仍用 `toolCall.name`。原稿「Plan 下 Read→Write」的复现不成立，已按此修正。
- 改法：`permission-responder-race.ts:306` 改为 `if (recheck.permissionDecision.decision === "ask")` 才返回 `rewriteInput`；`deny` 恢复原分支——`brokerResult={decision:"deny", reason: recheck.permissionDecision.reason ?? ...}`、`useNormalizedHookModifiedInput=false`、**不设** `rewriteInput`。
- 验收/测试：`core/tests/guarded-approval.test.ts` 加一条可用用例（build 模式）：`projectRules.deny:[{toolName:"Bash", ruleContent:"git push:*"}]`（**必须带 ruleContent**，否则 `bash-command-rule-evaluator.ts:14` 因 `!rule.ruleContent` 直接 deny，请求数为 0）；原始命令用 safe 命令 `npm run build`，hook 改写成 `git push origin main` → 断言 `h.requests.length === 1`、`result.success === false`、`error.type === "permission_denied"`、handler 未执行、`saveProjectPermission` 未调用。plan 变体不可构造，删除。
- 来源：review-scope-A / round 1，round 2 修正复现与验收

### SA-B2 [P1] `PermissionRequested` 事件从不携带 `approvalMode`，单次确认在 UI/投影侧渲染出「始终允许 / Full access」

- 维度：B（兼 D）
- 文件：`core/src/tool/executor/permission-flow.ts:238-249`；`core/src/tool/executor/events.ts:150-178`
- 问题：`emitPermissionRequested` 从参数对象读 `approval.approvalMode`，而传入的 `askApproval` 类型是 `ResolvedToolApproval`（`approval-gate.ts:10-14`：只有 `gate/display?/optionsPolicy?`），无该字段 → payload 永远缺 `approvalMode`；`events.ts:174` 的 `approval?.approvalMode !== "user-once"` 恒真，单次确认请求还被加了 `fullAccessSupported:true`。下游 `product-projection.ts:3732/3749`、`session-mapper.ts:916` 据此放出 `allowAlways`/`fullAccessOption`；用户点了，`permission-flow.ts:334` 传 `once=true`，`permission-response.ts:99/103` 判非法应答 → `InvalidInput`，工具失败。broker 侧已正确（`permission-responder-race.ts:218` 已带 approvalMode），缺的只是事件载荷。
- 改法：`onBrokerRegistered` 里改为 `emitPermissionRequested(..., traceContext, { ...askApproval, ...(askDecision.approvalMode ? { approvalMode: askDecision.approvalMode } : {}) })`（闭包读当轮 `askDecision`，语义正确）。
- 验收/测试：`guarded-approval.test.ts` 的「does not let PreToolUse/PermissionRequest auto-allow a dangerous request」追加断言：`PermissionRequested` payload 的 `approvalMode === "user-once"` 且无 `fullAccessSupported`。注意现有 harness（`:92-126`）没传 `sessionModePort`，`fullAccessSupported` 恒不注入、断言会恒真——须给 harness 补 `sessionModePort: { supportsPermissionFullAccess: () => true }`，先断言普通 ask 带 `fullAccessSupported:true`，再断言 user-once ask 不带；bootstrap 侧用真实事件喂 `ProductProjection`，断言 options 只有 allowOnce/deny。
- 来源：review-scope-A / round 1，round 2 确认可执行

### SA-D3 [P1] doom-loop ask 覆盖丢掉 `approvalMode`/`optionsPolicy`/`sideEffectScope`，第 4 次危险命令可由 hook 代答

- 维度：D（兼 B）
- 文件：`core/src/tool/executor/permission-flow.ts:140`；`core/src/tool/executor/doom-loop-gate.ts:144-158`
- 问题：`permissionDecision = doom.askDecision` 用 `buildDoomLoopAskDecision` 的全新对象（只有 allowed/decision/escalated/mode/reason/riskLevel/ruleId）整体覆盖 guarded 决策，`approvalMode`、`optionsPolicy`、`sideEffectScope` 全丢，`riskLevel` 还从 `high` 被降成 `medium`。随后 `resolveToolApproval(..., undefined, false)` 会跑 `prepareApproval`，`hook-flow.ts:62` 的 `user-once` 早退失效 → 第 4 次 `rm -rf` 可被 PermissionRequest/PreToolUse hook 批准；无 `optionsPolicy` 时 `permission-options.ts:76-92` 投放 `allow_project`，点了 `persistProjectPermissionUpdates` 把危险命令永久写进项目规则。
- 改法：`permission-flow.ts:140` 改为合并而非覆盖：`permissionDecision = { ...permissionDecision, ...doom.askDecision, riskLevel: maxRisk(permissionDecision.riskLevel, doom.askDecision.riskLevel), ...(permissionDecision.approvalMode ? { approvalMode: permissionDecision.approvalMode } : {}), ...(permissionDecision.optionsPolicy ? { optionsPolicy: permissionDecision.optionsPolicy } : {}), ...(permissionDecision.sideEffectScope ? { sideEffectScope: permissionDecision.sideEffectScope } : {}) }`（保留 `ruleId:"doom_loop"` 与新 reason）。
  `maxRisk` 落在 `core/src/permission/risk.ts`（新文件），签名 `export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel`，序写死 `low < medium < high < critical`；`RiskLevel` 定义在 `contracts/src/interfaces/session.port.ts:41`。
  **必须与 SA-B2 成对落地**：`approvalMode` 只进 broker 请求不进事件时，UI 侧「始终允许」仍在。
  **与 N1 的边界（必须写进代码注释）**：合并后 `approvalMode` 仍为 `user-once` 的 doom ask，只提供 allow-once / deny，**不适用会话级豁免**——`permission-flow.ts:334` 会以 `once=true` 调 `validatePermissionResponse`，而 `permission-response.ts:101-103` 规定 once 应答夹带 `sessionPermissionUpdates` 即 `InvalidInput`（`SUMMARY.md:188` 已把它定为设计）。因此 `buildDoomLoopReason`（`doom-loop-gate.ts:139-141`）必须按是否携带 `approvalMode` 分叉文案：user-once 路径只写「Allow once / Deny」，不得承诺「always allow this tool in this session」；非 user-once 路径保留会话豁免措辞。
- 验收/测试：`guarded-approval.test.ts` harness（`createToolExecutor({...})` 44-126 行）补 `doomLoop: createDoomLoopGateState(), doomLoopCheck:"ask"`；用例：guarded + 同一条 `rm -rf` 连跑 4 次、hook 恒 allow → 第 4 次仍有 broker 请求且 `approvalMode === "user-once"`、`riskLevel` 不降级、handler 未执行、`saveProjectPermission` 未调用。
- 来源：review-scope-A / round 1，round 2 补 riskLevel/sideEffectScope 与成对落地约束

### SA-A4 [P1] 重问轮沿用改写前的 `suggestedPermissionUpdates`，会把危险原文永久写进项目规则

- 维度：A（兼 D）
- 文件：`core/src/tool/executor/permission-flow.ts:92-94、228、276、425-431`
- 问题：`suggestedPermissionUpdates` 只在入口按原始 `executionInput` 算一次，重问轮原样传给 `runPermissionAskRace`；`allow_project` 的 `permissionUpdates` 直接取它（`permission-options.ts:76-91`）。hook 在 build/edit 下改写输入后用户点「始终允许」，落盘的是改写前（可能是被 hook 拦下的危险原文）的命令，属持久授权口径错误。
- 改法：`PermissionHookInputRecheckResult`（`permission-input-recheck.ts:13-15`）增加可选字段 `suggestedPermissionUpdates?: PermissionUpdate[]`，在 `decision === "ask"` 的返回分支用与 `permission-flow.ts:92-94` 同一表达式填充（含 `buildDefaultPermissionUpdates` 兜底）；`permission-flow` 在 `askInput = raced.rewriteInput` 之后**仅当该字段存在时**覆盖，再进下一轮。
- 验收/测试：扩展现有「replaces a hook-approved edited input with a fresh user-only request」（guarded，第二请求是 `user-once`）：只断言第二次 broker 请求的 `suggestedPermissionUpdates.ruleContent` 等于改写后命令——**该用例不能断言落盘规则**，`once=true` 会拒绝任何 `permissionUpdates`。落盘断言另起一条 build 模式用例（`mode:"build"` + `projectRules:{ask:[{toolName:"Bash"}]}` + `permissionHookInput`）：选 allow_project 后落盘规则的 `ruleContent` 匹配改写后命令（当前应红）。
- 来源：review-scope-A / round 1，round 2 升 P1

### SB-B1 [P1] `refreshMcpServers` 仍在 await 之后现读 revision，同一条「晚到 bump 被吞」未修

- 维度：B
- 文件：`core/src/runtime/methods/mcp.ts:305`（对照 176-180）
- 问题：`refreshMcpServers` 是设置页保存 MCP 的入口（`bootstrap/src/zcode-protocol/mcp.ts:199`），先 `await connectConfiguredServers`（245-266）+ `registerMcpTools`（268），最后才读 revision。新 server 走新 pool entry，`entry.connecting` 被 `MCP_CONNECT_DEADLINE_MS = 4_000`（`pool.ts:31、302-307`）race 掉，慢 server 在快照里是空 tools；`pool.snapshot()` 逐 entry `await status()/listTools()`（`pool.ts:365-376`）是真实 IO 窗口，后台连接随后 `toolListRevisionCounter += 1`（`index.ts:1438-1440`）。bump 落在窗口内即被吞，该 server 直到下一次 bump 或手动刷新前一直 no-op。
- 改法：采样点必须在 `await this.initializeMcp(...)`（235-237）**之后**、`connectConfiguredServers`（245）**之前**——放到 235 之前会把 initializeMcp 期间的 bump 一并吃掉。即 `const revisionBeforeConnect = this.mcpPort.toolListRevision?.()`，注册完成后用它当基线。残余代价（initializeMcp 结束到采样之间仍有极小窗口）需在注释写明，根治是端口级「快照自带 revision」。
- 验收/测试：优先写进已有的 `core/scripts/test-mcp-hot-refresh.mjs`（已 stub `initializeMcp` 并直接 `refreshMcpServers.call`，`makeRuntime` 无 `mcpToolListRevision` 字段，赋值即建）；若写进 `core/tests/mcp-runtime.test.ts`，注意该文件里 `refreshMcpServers` 会先触发一次 `initializeMcp`，mock 的 `connectConfiguredServers` 被调用两次、revision bump 两次，断言要按调用序号设计。断言：`connectConfiguredServers` 先写 tools、`revision += 1`、再返回空 tools 快照 → `refreshMcpToolsIfChanged` 后 `mcp__local__lookup` 已注册（当前应红）。
- 来源：review-scope-B / round 1，round 2 修正采样点与用例位置

### SB-B8 [P1] 子代理 borrowed port 冻结工具集，且只补 revision 不足以修复

- 维度：B
- 文件：`core/src/subagent/borrowed-mcp-port.ts:41-69`（关联 `runtime/methods/subagent.ts:681、706-711`）
- 问题：borrowed port 只实现 status/listTools/callTool，`listTools()` 永远返回 subagent 创建时抓的父启动快照（`:63-65`）；子 runtime `startMcpStartup` 采样到 `undefined`，`refreshMcpToolsIfChanged`（`mcp.ts:355-356`）永久 early-return。MCP 后台连接未完成时派生的子代理会把不完整工具集冻结一辈子。**仅委托 `toolListRevision` 无效**：refresh 拿到的仍是冻结列表、签名不变，依旧不重注册。
- 改法：borrowed port 必须同时改三处——`toolListRevision()` 委托 `parentPort.toolListRevision?.()`；`listTools()` 每次向父端口重新取当前快照，**取回后仍套用现有 `isInScope(serverName) && connectedServerNames.has(serverName)` 过滤**（与 `borrowed-mcp-port.ts:17-33` 同一谓词）再返回；`status()` 同样按 `isInScope` 过滤后透传。`registerMcpTools` 只按精确工具名过滤（`core/src/mcp/index.ts:93`），完全不知道 server 作用域，**不能**指望它兜住 `profile.mcpServers` / official CUA 的隔离（那层隔离只存在于 borrowed port 内部，见 `borrowed-mcp-port.ts:17-33、43-48`）。在 port 注释写明「作用域 = 创建时 allowlist，工具集 = 每次实时取并重新过滤」。
- 验收/测试：core 用例：父 port 带 revision 计数 + borrowed access，先以空工具初始化子 runtime，再 bump 并让父 `listTools` 返回新工具，调子 runtime 的 `refreshMcpToolsIfChanged`，断言新工具出现（当前应红）；**追加一条回归**：父端口 bump 后新增 out-of-scope server 与被 deny 的 official CUA server 的工具，断言它们**不出现**（钉住 `subagent-borrowed-mcp-port.test.ts:100-132` 的「hides and blocks denied official servers」契约）。
- 来源：review-scope-B / round 1，round 2 升 P1 并修正改法

### N1 [P1] doom-loop「本会话总是允许」豁免判据与真实类型不匹配，整条豁免是死代码

- 维度：B（兼 G）
- 文件：`core/src/tool/executor/doom-loop-gate.ts:202-214`；`core/src/tool/executor/permission-flow.ts:356-362`（`as never`）；`bootstrap/src/permission-options.ts:111-113`、`bootstrap/src/zcode-protocol/interaction-broker.ts:224-228`
- 问题：`applyDoomLoopSessionUpdates` 要求 `update.ruleId === "doom_loop" && (update.decision === "allow" || update.effect === "allow")`，但入参实际是 `PermissionUpdate[]`（`contracts/src/interfaces/permission.port.ts:35-39`：`{type:"addRules", behavior, rules}`），既无 `ruleId` 也无 `decision/effect`；broker 合成的会话授权是 `buildSessionPermissionUpdates(toolName)`，只有 `{toolName}`。谓词恒 false → `state.exemptTools` 永不被写（全仓唯一写入点 :213）→ 豁免分支（:91）恒不命中。用户在 doom 确认窗点「本会话总是允许」后，第 5、6 次相同调用仍被拦，与文案不符；调用点的 `as never` 把类型不匹配掩盖成能编译。
- 改法：`applyDoomLoopSessionUpdates` 改按 `PermissionUpdate[]` 判定——任一 update 的 `behavior === "allow"` 且 `rules.some(r => r.toolName === 当前工具名)` 即 `exemptTools.add(toolName)`；删掉调用点 `as never`。若确需 `ruleId === "doom_loop"` 的精确豁免，则在 broker 侧新造带标记的会话更新，而不是在消费侧猜字段。
- 验收/测试：**必须用非 user-once 的 doom ask 构造**（guarded 危险命令在 SA-D3 落地后是 user-once，会话豁免在那条路径上不适用）——用 `harness({ mode: "build", projectRules: { ask: [{ toolName: "Bash" }] } })` 或注册一个声明 `askOptions.allowAlways:"session"` 的桩工具，安全命令连跑 4 次触发 ask，broker 回 `{decision:"allow", sessionPermissionUpdates:[{type:"addRules",behavior:"allow",rules:[{toolName:"Bash"}]}]}` → 第 5 次不再产生 broker 请求且 handler 执行；把判据改回 `ruleId === "doom_loop"` 该用例应变红。另加一条反面用例：guarded + `user-once` 的 doom ask 回 `sessionPermissionUpdates` → `InvalidInput`。
- 来源：review round 2 新增

### N2 [P1] 账号符号残留使 7 个未删文件无法 import，是 33 个删除的真实诱因

- 维度：G（兼 K）
- 文件：`bootstrap/tests/provider-config-fixtures.ts:5`、`bootstrap/tests/provider-registry-model-runtime.test.ts:10`、`bootstrap/tests/zcode-builtin-model-runtime-integration.test.ts:11`、`adapters/tests/test-provider-config.ts:11`、`packages/services/test/providerConfigFixtures.ts:5`、`packages/services/test/zcodeAgentService.providerRegistry.test.ts:5`、`packages/desktop/test/e2e/helpers/worker-selection-integration.ts:7-8`、`apps/zcode-cli/packages/cli/tests/tui-login-polling.test.ts:20-26`（从 `bootstrap/src/app/standalone-account-provider-runtime.js` 导入 5 个符号，该模块在 HEAD 就不存在，且被 `packages/cli` 的 `test` 脚本显式列出）
- 问题：`ZhipuAccountAccessConfig`、`createAccountProviderConfigSnapshot` 在 `packages/provider/src` 已无定义，`../src/app/standalone-account-provider-runtime.js` 已不存在，但这 8 个文件仍引用；`bootstrap/tests/provider-config-fixtures.ts` 又被 10 个 bootstrap 测试间接引用（`helpers/fault-provider-model.ts`、`helpers/pdf-provider-fixture.ts`、`helpers/registry-backed-test-app.ts`、`provider-registry-*.test.ts`、`script-workflow.test.ts`、`v4-cold-resume.test.ts`、`zcode-protocol.test.ts` 等）。这些**未删除**的用例整片无法 import，也让 SC-C1 的「改红即证明覆盖」失去可比基线。
- 改法：先做一次收口，二选一——(a) 若账号通道要留，在 `packages/provider` 恢复两个符号的最小实现；(b) 按「已删功能」裁剪：`createAccountProviderConfig` 调用点改 `createApiKeyProviderConfig`，删除账号分支，并同批处理 10 个间接引用文件。**注意** `zcodeProviderUpdateAccountConfigParamsSchema` 仍存在于 `packages/shared/src/zcode-protocol/index.ts:2384`，不要当死符号删。
- 验收/测试：`pnpm --dir apps/zcode-cli/packages/bootstrap exec vitest run tests` 能完整启动（无 `Failed to resolve import`）；`git grep -n "ZhipuAccountAccessConfig\|createAccountProviderConfigSnapshot" -- "apps/*" "packages/*"` 每一处都能解析；`git grep -n "standalone-account-provider-runtime"` 必须 0 命中或全部可解析。
- 来源：review round 2 新增

### SC-C1 [P1] 删除 `script-workflow-child-runtime.test.ts` 但被测产品路径仍是 live

- 维度：G
- 文件：`bootstrap/tests/script-workflow-child-runtime.test.ts`（已删）；`bootstrap/src/app/script-workflow-child-runtime.ts`、`create-app.ts:96/712`、`script-workflow-runtime.ts:23/295`
- 问题：整文件删除的唯一硬阻塞是第 **10** 行 `import { createModelTelemetry } from "@zcode/telemetry"`（该包无 package.json，`apps/zcode-cli/node_modules/@zcode/telemetry` 不存在），在 110/367/560/716/1032 五处使用。被测的 `createScriptWorkflowAgentRuntime` 仍在生产装配里；其中「child runtime 里端口在场才注册 escalate/submit 控制工具」这道门与父会话 broker 路由无等价覆盖（driver 层另有 `workflow-escalation.test.ts` 覆盖，不重复计）。
- 改法：恢复该文件，**删掉 import 与 5 处 `agentTelemetry:` 属性**——fork 已移除遥测链路，`script-workflow-child-runtime.ts:41-67` 的 deps 没有该字段，`core/src/runtime/types.ts:383` 也注明端口已移除；对象本就 `as unknown as ScriptWorkflowAgentRuntimeDeps`，删除不影响类型。不要新增 no-op port。
- 验收/测试：`vitest run tests/script-workflow-child-runtime.test.ts` 3 次全绿；移除 child runtime 的 broker 注入后，757/601/783 三条用例应变红。
- 来源：review-scope-C / round 1，round 2 修正改法

### SC-C2 [P1] 删除 `process-provider-registry-runtime.test.ts`（832 行）覆盖 live 启动路径

- 维度：G
- 文件：`bootstrap/tests/process-provider-registry-runtime.test.ts`（已删）；`bootstrap/src/app/process-provider-registry-runtime.ts`、`zcode-protocol-entrypoint.ts:27`、`packages/cli/src/prompt-command.ts:188`、`packages/cli/src/tui-prompt-handler-runtime.ts:57`
- 问题：产品函数是 CLI 协议入口 live 路径。文件中 275/281/307 三条用例（「未注入 Provider Config 时拒绝启动」「Personal 文件损坏保留原文件并以内存空配置启动」「从进程环境启动 Registry 并由调用方持有生命周期」）与账号通道无关，属配置容灾面，可干净剥离。
  实际不可解析的是 **3 个符号 + 1 个模块**：`ZhipuAccountAccessConfig`、`createAccountProviderConfigSnapshot`、`parseProcessAccountProviderConfigSnapshot`（`process-provider-registry-runtime.ts` 现只导出 `ProcessProviderRegistryRuntimeOptions` / `startProcessProviderRegistryRuntime`，该符号全仓含 dist 0 命中）、`../src/app/standalone-account-provider-runtime.js`（已不存在）——账号用法集中在 73/124/174/442-567。
- 改法：拆分而非整删——移除账号相关用例与上述 **3+1** 全部引用，保留三条配置容灾用例。`packages/provider/dist/` 里残留的 `account-provider-resolution.js` 是过期构建产物，不要据此判断「符号还在」；`zcodeProviderUpdateAccountConfigParamsSchema` 仍存在于 `packages/shared/src/zcode-protocol/index.ts:2384`，**不要当死符号删**。本项应在 N2 收口之后做。
- 验收/测试：保留用例独立跑绿；故意让 personal.json 损坏被整文件覆盖时，回退用例应变红。
- 来源：review-scope-C / round 1，round 2 修正引用清单

### SC-C10 [P1] `backup/` 含 sqlite 用户数据且未被 gitignore

- 维度：K
- 文件：`backup/cli-1793891863718-68f071cb-*/{backup.json,tables.sqlite}`、`backup/cli-1793891869724-3a9b4be0-*/{backup.json,tables.sqlite}`（untracked）
- 问题：`git check-ignore -v backup` 无输出，`git add -A --dry-run` 实测列出这 4 个文件。且 `backup/` **就是产品运行时目录**：`adapters/src/storage/session-store/migration-runner.ts:104-106` 以 `<dataRoot>/backup` 作迁移备份目录，`packages/shared/src/sqlite-migrations/backup.ts:11/58` 定义 `tables.sqlite` 与 `backup.json`。所以不是「可选」而是必做。
- 改法：删除本地产物 + `.gitignore` 增加 `/backup/`；另确认本地哪次启动把 dataRoot 指到了仓库根（两份是 2026-11-05 同秒级两次写入），gitignore 只防入库、防不了再生成。
- 验收/测试：`git status --short` 不再列出 backup；`git add -A --dry-run` 输出不含 backup。
- 来源：review-scope-C / round 1，round 2 确认 backup 为产品运行时目录

### SC-C11 [P1] index 与工作树不一致，只提交 index 会得到半套权限修复

- 维度：K
- 文件：git index；`core/package.json:30-31` 与两个 untracked 脚本
- 问题：staged 集合 = 33 个删除 + `service.ts` + `approval-gate.ts`（27/1）+ `bash-readonly-policy-callbacks.ts`（98）+ `bash-readonly-policy-flags-text.ts`（21）+ `permission-flow.ts` 的一小块（8/1）；而 `permission-flow.ts` 工作树还有 193/83、`permission-responder-race.ts`（119 行）、`hook-flow.ts`、`permission-capability.ts`、`permission-input-recheck.ts`、`mcp.ts` 全未 staged。只提交 index 会得到「判定侧收紧、executor 接线没进去」的不一致快照。另 `package.json` 引用两个 untracked 脚本，漏 add 会 ENOENT。
- 改法：先剔除 `backup/`（SC-C10），再明确二选一——**单提交**：`git add -A` 一次提交（接受大 diff）；**多提交**：先 `git reset` 清空 index，再按「权限安全 / sed / adapter / MCP / 测试清理 / 文档」逐块 `git add -p` 重组。src + 测试 + 脚本 + package.json 必须同提交。
- 验收/测试：`git diff --cached` 与 `git diff` 无同文件双份；`git ls-files` 含两个新脚本；多提交时 `git show <commit>:permission-flow.ts` 与 `git show <commit>:permission-responder-race.ts` 同时含新重入逻辑（快照一致性）。
- 来源：review-scope-C / round 1，round 2 修正为二选一

---

### N3 [P2] `no-always-allow` 只裁展示不裁应答，TUI 仍可把「始终允许」落成项目规则

- 维度：J（兼 D）
- 文件：`packages/tui/src/app-approval.ts:14-16、127-149`；`bootstrap/src/permission-options.ts:61-92`；`core/src/tool/executor/permission-flow.ts:425-431`
- 问题：本次给 Plan+MCP 的 ask 新增 `optionsPolicy:"no-always-allow"`（`service.ts:520-528`）。v4 投影与 v3 `buildProtocolPermissionOptions` 都按它裁选项，但 TUI 的 `decisionsForApproval` 只看 `request.approvalMode`，仍给出 `allow_project`；`createApprovalResult` 照常返回 `permissionUpdates`，`permission-flow` 也不看 `optionsPolicy` 直接 `persistProjectPermissionUpdates`。核心判定「这次不提供始终允许」，TUI 仍可把规则永久写进项目规则，且按 service 注释该规则在 Plan 下本就不生效——用户点了却继续被问。
- 改法：`decisionsForApproval` 在 `request.approvalMode === "user-once" || request.optionsPolicy === "no-always-allow"` 时只返回 `["allow_once","deny"]`，`createApprovalResult` 同步拒 `allow_project`；防御面把 `validatePermissionResponse` 签名扩为 `validatePermissionResponse(response, once, options?: { noAlwaysAllow?: boolean })`，`noAlwaysAllow` 取**合并后的 `askApproval.optionsPolicy`**（`permission-flow.ts:192` 已算好，含工具声明的 `askOptions.allowAlways:false` 经 `narrowOptionsPolicy` 的收敛）与 `permissionDecision.optionsPolicy` 的**更严者**——只看 `permissionDecision.optionsPolicy` 会漏掉工具级 `no-always-allow`（该字段只有 Plan-MCP 一处赋值）。`isSingleUseDecision(decision)` 放同文件 `permission-flow.ts` 底部并导出供测试复用。
- 验收/测试：`tui-approval-panel.test.ts` 加一条 `optionsPolicy:"no-always-allow"` 请求，断言决策集只有 allow_once/deny 且 `createApprovalResult("allow_project")` 得 deny；core 侧加一条「非 guarded + `no-always-allow` + broker 回 `permissionUpdates`」→ `InvalidInput` 且 `saveProjectPermission` 未调用。
- 来源：review-full round 3 新增

### N4 [P2] 权限新分支缺日志，三类新路径出问题无法从日志定位

- 维度：I
- 文件：`core/src/tool/executor/permission-flow.ts:142-161、218-324`；`permission-responder-race.ts:262-270`；`core/src/runtime/methods/mcp.ts:160-188、349-365`
- 问题：① `tool.permission.evaluated` 不记 `approvalMode`/`optionsPolicy`，「为什么这次没有始终允许」只能靠 ruleId 猜；② hook 改写触发的重问无任何日志，只有一条合成 `PermissionResolved(deny)`，「hook 改写等于当前输入 → 主动退赛」分支完全静默；③ catch 把 broker 故障转成 `ToolExecutionFailed` 时无 `logger.warn`，基础设施故障与用户拒绝在权限层日志里不可区分；④ `mcp.tools.registered`/`registration.timing` 不含 `revisionAtStart`/`revisionNow`，sess_6b69c667 那类「基线被吞」再发生时无日志可证。
- 改法：evaluated 日志补 `approvalMode`/`optionsPolicy`；rewrite 分支加 `tool.permission.reentry`（requestId/newRequestId/ruleId）；`isSamePermissionInput` 命中处加 debug `tool.permission.hook_rewrite_ignored`；catch 加 `tool.permission.request_failed`（errorMessage/requestId/toolName）；MCP 两处 info 补 revision 数值，`refreshMcpToolsIfChanged` 在 revision 变化但签名不变时补 debug。
- 验收/测试：在 guarded-approval / mcp-runtime 现有用例里断日志字段（`deps.logger` 已有 spy 惯例）；人工核对一次 rewrite 重问的日志能看到两条 requestId。
- 来源：review-full round 3 新增

### N5 [P2] `fullAccessSupported` 泄漏进 v3 strict schema，legacy 端整条丢弃 `permission.requested`

- 维度：H
- 文件：`core/src/tool/executor/events.ts:174-177`；`bootstrap/src/zcode-protocol/session-mapper.ts:906-925`；`packages/shared/src/zcode-protocol/index.ts:1646-1661`；`packages/services/src/zcode-agent/zcodeAgentService.ts:1777-1799`
- 问题：基线（`events.ts` 不在本 diff 内）在 `supportsPermissionFullAccess()` 为真时给每个非 user-once ask 注入 `fullAccessSupported:true`（生产为真）。`mapPermissionRequestedPayload` 只解构剔除 `display`/`optionsPolicy`，`fullAccessSupported` 随 `...record` 进入 **strict** 的 `zcodePermissionRequestedEventPayloadSchema`（有 `approvalMode`、无 `fullAccessSupported`），v3 客户端 `safeParse` 失败后整条事件被丢弃。影响：SA-B2 修好 `approvalMode` 后，v3 侧普通 ask 仍不弹窗，而 SA-B2 的验收只喂 v4 `ProductProjection`，测不到这条。
- 改法：按 mapper 自己的注释规则在 `mapPermissionRequestedPayload` 里同样剔除 `fullAccessSupported`（或把它以 optional 补进 v3 schema，二者择一并写明版本偏斜理由）；SA-B2 的验收追加一条 v3 envelope 断言。
- 验收/测试：写进 `bootstrap/tests/session-mapper-permission.test.ts`（已有 `safeParse(...).success` 惯例，第 72/103/123 行）；其 `basePayload`（33-40 行）不含 `fullAccessSupported`，须显式加两条 fixture——「普通 ask + `fullAccessSupported:true`」与「guarded user-once ask」——各自断言 `zcodePermissionRequestedEventPayloadSchema.safeParse(mapSessionEvent(真实事件).payload).success === true`；不剔除时第一条应红。
- 来源：review-full round 3 新增

---

### SA-B5 [P2] 取消/登记失败时只有 `PermissionResolved` 没有 `PermissionRequested`

- 维度：B
- 文件：`permission-flow.ts:238-249、252-263、305-315`；`permission-responder-race.ts:87-90、238-241`
- 问题：事件发布改到「broker 登记后」之后，入口即 aborted 或 `await registered` 被拒时 `emitPermissionRequested` 从未发出，但 catch 无条件 `emitPermissionResolved(deny)` → 孤立 resolve（成立）。改写路径的合成 `PermissionResolved(deny)` 在 contracts reducer（`event-reducer.ts:528-545`）里会把 `activeToolCalls` 置 `denied`；v4 桌面实际渲染的 product-projection 在下一条 `PermissionRequested` 会改回 `pendingApproval`（`product-projection.ts:3622-3631、3793-3799`），故「工具行显示已拒绝」只对 contracts 投影成立。
- 改法：catch 与改写分支用 `let requestedEmitted = false`（`onBrokerRegistered` 置 true）决定是否发 Resolved；contracts reducer 侧在 `PermissionRequested` 分支把同 `toolCallId` 的 `activeToolCalls.status` 复位为 `"pending"`（`ToolCallStatus` 只有 `pending|running|completed|failed|denied`，见 `contracts/src/interfaces/session.port.ts:161-168`，**没有 `waiting`**）。
- 验收/测试：入口即 abort → 事件序列无孤立 `PermissionResolved`；hook 改写触发重问 → 第二个 `PermissionRequested` 之后 contracts 投影的 `activeToolCalls[0].status === "pending"`。
- 来源：review-scope-A / round 1，round 2 收窄 UI 结论

### SA-C6 [P2] `MAX_PERMISSION_REENTRIES` 上限不可达，重入最多只有一轮

- 维度：C
- 文件：`permission-flow.ts:48、235、265-275`
- 问题：`skipHooks: reentries > 0` 让第 2 轮 hook 必然退赛，而 `rewriteInput` 只能由 hook 胜出产生，因此第 2 轮必然 `break`；`++reentries > 3` 永不成立，注释描述的 A→B→A 场景在实现上不存在。
- 改法：**默认按 ①「最多一次重问」执行**——删 `MAX_PERMISSION_REENTRIES` 与 265-275 分支，注释写明「hook 改写后只重问一次，重问轮不再问 hook」；若用户选择 ② 保留多轮，则 `skipHooks` 改按 `isSamePermissionInput` 判断「同一改写才退赛」并保留上限。
- 验收/测试：加「hook 每轮返回不同改写」用例（B→C→D）：方案① 请求数恒为 2；方案② 第 4 次返回 `permission_denied` 且 `PermissionResolved` 数 = 请求数。
- 来源：review-scope-A / round 1

### SA-A7 [P2] guarded+Plan 的 `guardedSingleUseAsk` 分支不可达；回归用例用生产不存在的能力组合

- 维度：A（兼 G）
- 文件：`core/src/permission/service.ts:139-141、206-214`；`core/scripts/test-permission-plan-gate.mjs:84-104`
- 问题：全仓仅 `resolveBashPermissionCapability`（`bash.ts:114-121`）设置 `userApprovalRule`，而它给出该规则时 `readOnly:false`（`bash.ts:388`），plan 分支先在 `checkPlanMode` 走到 `mode.plan.nonReadOnly` deny 并 return，212-214 永远进不去。真实行为是 deny（更严，安全无问题），但 SUMMARY 6.1 与代码不符；测试传的 `readOnly:true + needsApproval:true + userApprovalRule` 组合生产不存在。
- 改法：按「deny 优先」定论——删 `service.ts:212-214`，把 SUMMARY 6.1 与测试期望改为「Plan 下危险命令直接 deny（审批不能解除 Plan 限制）」；测试改用真实 `bashToolEntry.resolvePermissionCapability` + 真实 metadata 断言 deny。
- 验收/测试：`test-permission-plan-gate.mjs` 用真实 bash capability 跑 `checkPermission({mode:"guarded", planEnabled:true},{command:"rm -rf /tmp/x"})` 断言 `decision === "deny"`；`guarded-approval.test.ts` 加端到端用例证明 plan+guarded 下 `rm -rf` 不执行。
- 来源：review-scope-A / round 1

### SA-D8 [P2] `CronPauseSelf` 免确认分支：fork 无该工具，且条件不校验「无模型可控 id」

- 维度：D（兼 C）
- 文件：`core/src/permission/service.ts:245-262`
- 问题：`CronPauseSelf`/`automation.pause` 全仓仅命中本文件与 docs（`analysis-cli.md:121` 明确要求删除）；信任根是「工具名字符串 + 通用旗标」，任何同名工具声明 `permission:"automation.pause"`、`sideEffectScope:"workspace"`、`riskLevel:"low"`、`needsApproval:false` 即可白拿放行。
- 改法：删除 245-262；若保留，必须校验内置 tool entry 身份 + 入参只允许本轮注入 id。
- 验收/测试：删除后 `permission-service.test.ts` 无遗漏；保留则加反向用例（同名但入参含 `automationId` 的桩工具仍需审批）。
- 来源：review-scope-A / round 1

### SA-C10 [P2] 「登记后发布」与应答解释逻辑与既有模块重复，后者仍是死代码

- 维度：C-orch
- 文件：`permission-responder-race.ts:238-241`；`permission-request.ts:91、122-132`；`permission-response.ts:29`
- 问题：`requestPermissionResponse` 与 `interpretPermissionResponse` 全仓均无调用方，本次又在 `requestBroker` 里重写一份登记后发布逻辑，两份必然漂移；`(pending as { registered?: Promise<unknown> }).registered` 是多余 cast（端口已声明 `readonly registered?: Promise<void>`，`permission.port.ts:112`）。
- 改法：删 `permission-request.ts` 或让 `runPermissionAskRace` 复用它；`interpretPermissionResponse` 无人用则删除、`validatePermissionResponse` 单独成文件；`registered` 直接读 `pending.registered`。
- 验收/测试：`git grep` 确认无引用后删除；`permission-responder-race.test.ts` 全绿。
- 来源：review-scope-A / round 1

### SA-F11 [P2] 文件头注释与实现直接矛盾（`inputAdjustments` 说「永远是 undefined」）

- 维度：F
- 文件：`permission-flow.ts:50、54-58、62-66`（对照 506-520）
- 问题：注释仍写「本 fork 尚未应用调整，因此永远是 undefined」、TODO 仍说未并入 while-reentry，实际已调用 `applyPermissionInputAdjustments` 并回填；`:50` 另有 `=  | {` 双空格。
- 改法：删「永远是 undefined」段与已落地 TODO，注释改为「确认窗调整实际生效的部分」；`=  | {` 改回单空格。
- 验收/测试：`pnpm --dir apps/zcode-cli run format:check` 通过；人工核对注释与 506-520 一致。
- 来源：review-scope-A / round 1

### SA-B12 [P2] `resolveRuntimePermissionContext` 丢掉 `deps.bashShellSelection` 兜底，guarded 可能按 POSIX 文法判定

- 维度：B（兼 D）
- 文件：`permission-capability.ts:49`；`call-runner.ts:358、370-376`；`impl.ts:73-74`
- 问题：`call-runner` 已算好 `deps.getBashShellSelection?.() ?? deps.bashShellSelection` 并放进 `preparedContext`，但判权仍走 `resolveRuntimePermissionContext(deps)`，那里只写 `deps.getBashShellSelection?.()`。只声明静态 `bashShellSelection`（`executor/types.ts:122` 公开选项）的 `createToolExecutor` 用法在 guarded 下会退回 `GUARDED_DEFAULT_DIALECT="posix"`，Windows 的 `rd /S /Q`、`del /Q` 匹配不到危险规则 → 直接放行。生产两个构造点都传 getter，故是 API 缺口而非现网漏洞。
- 改法：`permission-capability.ts:49` 改为 `deps.getBashShellSelection?.() ?? deps.bashShellSelection`；`permission-flow` 优先使用 `preparedContext`，保证「首次判权/重判/事件」三处同源。
- 验收/测试：新增用例：`createToolExecutor({mode:"guarded", bashShellSelection:{dialect:"cmd"}, getMode:()=>"guarded"})`（不传 getter）执行 `rd /S /Q target`，断言出现 `approvalMode:"user-once"` 的 broker 请求（当前应红）。
- 来源：review-scope-A / round 1

### SA-B13 [P2] `await registered` 无超时也不参与 abort 竞速

- 维度：B
- 文件：`permission-responder-race.ts:238-241`
- 问题：`if (registered) await registered;` 既无 `permissionTimeoutMs` 兜底，也没和 `brokerSignal` race；`timeoutMs`/abort 只收口 `pending`（`core/src/permission/broker.ts:108-128`），`registered` 是独立 promise。第三方 broker 返回永不结算的 `registered` 会让 `requestBroker` 永不 settle（仓库内 broker 均未提供 `registered`，故是契约缺口）。
- 改法：`await Promise.race([registered, abortPromise, timeoutPromise])`，超时按 `PermissionTimeout` 收口。
- 验收/测试：单测一个 `requestPermission` 返回 `Object.assign(new Promise(()=>{}), { registered: new Promise(()=>{}) })` 的 broker，断言 `permissionTimeoutMs` 内得到 `permission_timeout` 而非挂起。
- 来源：review-scope-A / round 1

### SA-B14 [P2] 应答形状校验只按 `mode === "guarded"` 触发，不认 `approvalMode`

- 维度：B（防御性）
- 文件：`permission-flow.ts:332-334`；`permission-response.ts:92-110`
- 问题：`validatePermissionResponse` 唯一入口包在 `if (mode === "guarded")` 里，而它真正的保护对象是「单次确认不得夹带规则」（第二参 `once`）。将来任何非 guarded 路径产出 `approvalMode:"user-once"`，`once=true` 都不会传入。
- 改法：改为 `if (mode === "guarded" || permissionDecision.approvalMode === "user-once")`，`once` 判据抽成 `isSingleUseDecision(decision)`。
- 验收/测试：纯函数用例 `validatePermissionResponse({decision:"allow", permissionUpdates:[...]}, true)` 抛 `InvalidInput`；集成用例：非 guarded 但 `approvalMode:"user-once"` 的决策被拒。
- 来源：review-scope-A / round 1

### SA-G15 [P2] 回归证据与脚本内容不符，三条新路径无测试

- 维度：G
- 文件：`core/scripts/test-bash-sed-readonly-policy.mjs:19-54`；`SUMMARY.md:171`；`core/tests/permission-responder-race.test.ts:175-194`
- 问题：SUMMARY 写「17 项，含端到端只读探针」，实际 3 个 `test()`、15 条 assert，无端到端探针；abort 兜底（broker 不理 signal 时补 `ToolCancelled`）确无用例（现有用例的 broker 会自行 reject）；事件 `approvalMode` 与重判 deny 两条新路径也无测试。
- 改法：修正 SUMMARY 计数、去掉「端到端」或真补一个临时目录跑真实 sed 的探针；补 abort 兜底单测；②③ 按 SA-B2/SA-B1 的验收补。
- 验收/测试：两个 node:test 脚本与 core 对应 vitest 全绿，脚本用例数与文档一致。
- 来源：review-scope-A / round 1

### SB-B2 [P2] 采样点前移使首回合必多一次 `listTools`（可接受，需写明）

- 维度：E
- 文件：`core/src/runtime/methods/mcp.ts:50、180、356-365`
- 问题：新 lease 的 revision 求和为 0（`pool.ts:520-523`），任一 server 首连成功必 bump（`index.ts:1430-1440`），第一回合必然进 `listTools()`。该轮不会重复注册（363 行在签名比较前推进基线），收敛成立；成本是一次额外 `listTools`。
- 改法：180 行注释写明「baseline 故意取启动点，代价是首回合多一次 listTools」；或按 SB-B1 的端口级方案消除。
- 验收/测试：新增收敛断言——`initializeMcp` 后连续两次 `refreshMcpToolsIfChanged`，mock 的 `listTools` 计数应为 1。
- 来源：review-scope-B / round 1

### SB-B3 [P2] `addStatusSink` 合成 sink 丢掉 `publishFailure`

- 维度：B
- 文件：`adapters/src/model/runner.ts:133-144`
- 问题：`ModelStatusSink` 有可选 `publishFailure(event, error)`（`contracts/src/model/index.ts:321-328`），`publishModelStatus` 有 `failureError` 时优先走它（`runner-status.ts:169-174`）；合成对象只实现 `publish`，两级 sink 时 `publishFailure` 静默降级、原始异常丢失；`results.find` 只抛第一个 rejection。
- 改法：合成对象补 `publishFailure(event, error)`，逐 sink `sink.publishFailure ? sink.publishFailure(event, error) : sink.publish(event)`，`allSettled` 隔离；全失败用 `AggregateError` 汇总。
- 验收/测试：adapters 新增用例：`publish` 是必填成员，故 sink A 的 `publish` 写成 no-op（只断言 `publishFailure` 收到原始 error）、sink B 只实现 `publish`；合并后投递 `model_request_failed`+failureError，断言 A 的 `publishFailure` 收到原始 error、B 的 `publish` 收到事件，A 抛错不影响 B。
- 来源：review-scope-B / round 1

### SB-B4 [P2] `addStatusSink` 只按链头去重，同实例重复添加会双投

- 维度：B
- 文件：`adapters/src/model/runner.ts:127-145`（关联 `runner-status.ts:166`）
- 问题：`current === sink` 只挡「与当前合成对象相同」；同一 sink 加两次得到嵌套合成对象，事件双投，`requestStatusSink !== statusSink` 也看不穿。
- 改法：改为持有叶子集合（`ModelStatusSink[]` + Set 身份去重），仅在新叶子时重建无状态 fan-out publisher。
- 验收/测试：同一 sink 连加 3 次只收 1 次；A→B→A 各收 1 次；A 同时作为 adapter 选项与 request sink 只投递一次。
- 来源：review-scope-B / round 1

### SB-B5 [P2] statusSink/addStatusSink 是半截接线：生产侧无入口

- 维度：C
- 文件：`adapters/src/model/runner.ts:127`（无生产调用）；`bootstrap/src/model-factory.ts:11-17、30-38`；`create-app.ts:636-643`；`bootstrap/tests/helpers/fault-provider-model.ts:113`
- 问题：`addStatusSink` 零生产调用，`CreateModelAdapterBaseOptions` 无 `statusSink`，进程级 sink 注入不进来；但 fault-matrix 的 statusEvents 断言只能由 adapter 级 sink 喂满。
- 改法：**默认按 (a) 只为测试恢复执行**——保留 adapter 的 `statusSink` 选项与两处转发，不恢复 `addStatusSink` 的生产入口，在 `fault-provider-model.ts` 处注明「进程级出口仅测试需要，生产遥测已按 119113f2 移除」；若用户选择 (b) 恢复生产遥测，则 `CreateModelAdapterBaseOptions` 加 `statusSink` 并透传、`create-app.ts` 装配 `ModelApiTelemetryStatusSink`，并同步更新 119113f2 的删除理由。
- 验收/测试：方案 b 下 `git grep -n "addStatusSink(" -- apps/*/packages/*/src packages/*/src` 必须 ≥1（不加 `-- src` 会被 4 处测试桩命中而假绿：`registry-backed-test-app.ts:160`、`provider-registry-app-runtime.test.ts:196/454`、`script-workflow.test.ts:365`），或直接断言 `create-app.ts` 装配处构造了 `ModelApiTelemetryStatusSink`；两种方案都要让 fault-matrix 的 statusEvents 断言实际跑一次。
- 来源：review-scope-B / round 1

### SB-B6 [P2] `?? mcpPort.toolListRevision?.()` 兜底不可达

- 维度：C
- 文件：`core/src/runtime/methods/mcp.ts:135、180`
- 问题：到 180 行时 `mcpPort` 必然在场（135 行提前 return），右操作数只可能在端口未实现时同为 undefined，纯死分支；将来若字段被重置/端口后注入，会静默退回 await 后现读。
- 改法：直接 `this.mcpToolListRevision = this.mcpStartupRevisionAtStart;`，注释钉住不变量；若保留兜底则抽具名 helper 并写明为何安全。
- 验收/测试：typecheck；补一条「端口不实现 toolListRevision 时不刷新」的用例。
- 来源：review-scope-B / round 1

### SB-B7 [P2] 新字段两处声明无类型联动

- 维度：C
- 文件：`core/src/runtime/agent-runtime.ts:234-238`、`core/src/runtime/internal.ts:139`；`agent-runtime.ts:294`（`as unknown as AgentRuntimeInternal`）
- 问题：私有字段与 interface 公共成员无编译期约束，任一侧改类型/可空性都不报错；`undefined` 承载「没采到 → 现读」语义，写成 `= 0` 会静默变义；解释现有三份。
- 改法：单一来源——保留 interface 声明、类侧 `declare private mcpStartupRevisionAtStart?: number`（或反之），用 `satisfies Pick<AgentRuntimeInternal, ...>` 钉住；在 `mcpInitialized`/`mcpToolsRegistered` 同处重置；解释只留一份。
- 验收/测试：typecheck；加一条仅类型层断言（类字段类型 = 接口成员类型）防后续改成 `= 0`。
- 来源：review-scope-B / round 1

### SB-B9 [P2] `addStatusSink` 零测试

- 维度：G
- 文件：`adapters/src/model/runner.ts:117、127-145`
- 问题：adapter 级 `statusSink` 选项已有用例覆盖（`adapters/tests/provider-config-model-creation.test.ts:79-82、102-117`，该用例在 `119113f2` 删掉选项后一直红，本次恢复后应转绿）；`addStatusSink` 本身仍零用例，故 SB-B3/B4 两个契约缺口无法被发现。
- 改法：新增 `adapters/tests/runner-adapter-status-sink.test.ts`：① 双 sink 合并都收齐、A 抛错 B 仍收到；② publishFailure（SB-B3）；③ 重复添加（SB-B4）。同时确认 `provider-config-model-creation.test.ts` 转绿。
- 验收/测试：新文件全绿且旧用例转绿；临时删 `statusSink: this.statusSink` 转发，用例应红。
- 来源：review-scope-B / round 1，round 2 收窄（选项已有覆盖）

### SB-B10 [P2] MCP 回归测试只覆盖 initializeMcp 的窄时序

- 维度：G
- 文件：`core/tests/mcp-runtime.test.ts:411-466`
- 问题：只钉住「快照比采样早」一种时序；缺收敛断言（首回合刷新后基线推进、第二回合不再 listTools）、缺「initializeMcp 返回之后才 bump」变体、缺 refreshMcpServers 同类用例（SB-B1）。
- 改法：同 describe 补三条用例（见 SB-B2、SB-B1 的验收）。
- 验收/测试：三条的红绿预期分别是——**收敛断言**（连续两次 refresh，`listTools` 计数）：HEAD 下为 0（`refreshMcpToolsIfChanged` 早退，因为 HEAD 基线是在 `await` 之后现读、等于 current，不是 revision 为 undefined），修复后为 1；**bump-after-init**（`initializeMcp` 返回后才 bump）：HEAD 下**绿**（旧读法在 await 之后现读，本来就能看见晚到的 bump），它的作用是防止后续把采样点再挪回 `await` 之后；**refreshMcpServers 版本**：HEAD 下红，修复后绿。
- 来源：review-scope-B / round 1，round 2 修正红绿预期

### SC-C3 [P2] `conversation-telemetry-identity` / `-workflow-facts` 测的是仍在协议上发布的 normalizer

- 维度：G
- 文件：`bootstrap/tests/conversation-telemetry-identity.test.ts`、`conversation-telemetry-workflow-facts.test.ts`（已删）；`src/zcode-protocol-v4/conversation-telemetry-facts.ts:51`、`v4-gateway.ts:1167/1370`、`v4-bridge.ts:1954-1958`、`packages/services/src/zcode-agent/zcodeAgentService.ts:1811-1812`
- 问题：`ConversationTelemetryFactNormalizer` 是 v4-gateway 成员，每个 session event 都走 `normalize`，结果经 v4-bridge 以 `conversationTelemetryFact` 通知发往客户端且服务端有消费者；两文件 import 全部可解析，删除是纯覆盖损失。
- 改法：**拆两条执行**——`conversation-telemetry-workflow-facts.test.ts` 只引用 contracts + normalizer，可立即恢复；`conversation-telemetry-identity.test.ts` 第 11-18 行 import `../../adapters/tests/test-provider-config.js`，而后者第 11 行从 `@zcode/provider` 导入 `ZhipuAccountAccessConfig`（正是 N2 列出的无解引用），因此**必须在 N2 收口后**才能恢复。若确认该 notification 已无消费者，则改为在同一改动里删除 gateway/bridge 发射路径并同步协议契约。
- 验收/测试：workflow-facts 恢复后即绿；identity 在 N2 完成后恢复并绿（顺序依赖写进提交说明）。
- 来源：review-scope-C / round 1

### SC-C4 [P2] 另有 4 个删除文件是「部分用例依赖已删功能」，可裁剪却整删

- 维度：G
- 文件：`bootstrap/tests/formal-proof-consistency.test.ts`、`core/tests/tool-search-local-runtime.test.ts`、`core/tests/tool-search-persistence.test.ts`、`bootstrap/tests/offpeak-prompt-turn-disallowlist.test.ts`
- 问题：formal-proof 的 `sendText/setGoal → inputRouting` 对账仍对应 live `computeAvailability`（`product-projection.ts:4397/5571`）；tool-search 两文件测 live ToolSearch 的 sqlite 冷恢复/fork/streaming 集成，只是某步用已删 `compactActiveConversation`；offpeak-prompt-turn 前 4 条测 live `buildTurnToolDisallowlist`（`prompt-turn.ts:180、294` 每轮调用），仅因未 export + `resolveTurnOffPeakTaskId` 已删导致整文件 import 失败。
- 改法：分别裁剪——去掉 compact 段、off-peak 段；`buildTurnToolDisallowlist` 导出后单独测或通过 `startPromptTurn` 行为测。
- 验收/测试：裁剪后各文件跑绿；去掉 `buildTurnToolDisallowlist` 对 CronCreate 的隐藏时断言应变红。
- 来源：review-scope-C / round 1

### SC-C5 [P2] bash-handler 的失败侧断言被删，标题承诺未被验证

- 维度：G
- 文件：`core/tests/bash-handler.test.ts:224-262`
- 问题：旧断言同时覆盖成功侧与失败侧（`failed:spawn`）；改写后 spawn_error 只断 `status/stderr`，无「失败被标记」的消费面断言，且正向用例手填 `success:true`（`:242`）绕开 executor 的真实 success 决策。
- 改法：给 spawn_error 补真实消费面断言（`bash-semantics.ts:242` 的 `interpretBashReturnCode` → 「Command failed to start」进入 modelContent/display，或 session event 失败标记）；不要用固定 `success:true` 代替 executor 决策。
- 验收/测试：把 spawn_error 结果改成 completed，新增断言应红。
- 来源：review-scope-C / round 1

### SC-C6 [P2] MCP 预热延迟（1s timer）完全没有测试

- 维度：G
- 文件：`core/tests/mcp-runtime.test.ts:56-95`；`core/src/runtime/agent-runtime.ts:402-406`
- 问题：用例名写「defers configured MCP server startup until the warmup trigger」，但两个用例都手动 `await runtime.startMcpStartup(...)`，全文件无 fake timers；把 `MCP_WARMUP_DELAY_MS` 改 60s 或删 timer 套件仍绿。
- 改法：用 fake timers `vi.advanceTimersByTime(1000)` 断言 `connectCalls` 0→1；补 `shuttingDown` 时定时器不拉起 spawn 的用例。
- 验收/测试：把 `MCP_WARMUP_DELAY_MS` 改 60_000 或删 timer，用例应变红。
- 来源：review-scope-C / round 1

### SC-C7 [P2] SUMMARY 两处与事实不符

- 维度：A
- 文件：`docs/iterations/upstream-v3.17-selective/SUMMARY.md:171、232`
- 问题：① 第 171 行「17 项，含端到端只读探针」与实际 3 test/15 assert 不符；② 第 232 行「`@zcode/shared`/`@zcode/provider`/`@zcode/provider-node` 三包在 fork 里不存在」不实——三包都在根 `packages/`（`package.json:2` 已核对），bootstrap 以 `workspace:*` 声明（`bootstrap/package.json:78-80`）并已链接。
- 改法：改成实际计数并去掉「端到端」表述；§7.3 改为按「缺失符号/缺失模块」逐项列证据（与 N2 的清单一致）。
- 验收/测试：文档数字与 `grep -c '^test('` 一致；§7.3 每条理由能对应到 0 命中的具体符号。
- 来源：review-scope-C / round 1

### SC-C8 [P2] `UPSTREAM-SYNC.md` 新增的 `vendor/zcode` 路径在工作树不存在

- 维度：A
- 文件：`UPSTREAM-SYNC.md:16`
- 问题：路径列写 `vendor/zcode`（本地分支），但仓库无该目录、`git worktree list` 也无；只有分支 `vendor/zcode`（HEAD `a9fe401e`）。该行竖线也未与相邻行对齐。
- 改法：路径列写「分支 vendor/zcode（未 checkout）」，或补 `git worktree add vendor/zcode vendor/zcode`；顺手对齐表格。
- 验收/测试：`git worktree list` 与文档一致。
- 来源：review-scope-C / round 1

### SC-C9 [P2] 新脚本用源码正则充当「接线守卫」

- 维度：C
- 文件：`core/scripts/test-permission-plan-gate.mjs:160-171`
- 问题：靠 `/resolveToolApproval\([\s\S]{0,400}?permissionDecision\.optionsPolicy/` 文本匹配证明接线，格式化/改参数名会误红，把调用挪进不可达分支仍可能通过。
- 改法：用 `createToolExecutor` + 假 PermissionService/registry 跑一次 ask，断言 broker 收到的 `PermissionBrokerRequest.optionsPolicy === "no-always-allow"`；顺带覆盖 user-once 应答夹带规则被拒。
- 验收/测试：删掉 `permission-flow` 里 `permissionDecision.optionsPolicy` 传参，行为用例必须红。
- 来源：review-scope-C / round 1

### SC-C12 [P2] 新回归脚本没有任何门禁会执行

- 维度：K
- 文件：`core/package.json:30-31、51`；根 `package.json:19、34`；`.github/workflows/release-desktop.yml:112-113`
- 问题：core 的 `"test": "vitest tests"` 不跑 `scripts/*.mjs`；根 `test:v4-perf` 没加这两条；`verify:pre-push` 只有 lint + architecture；release-desktop 只跑 typecheck。两条新脚本除自身定义外 0 引用。
- 改法：把两条脚本加入根 `test:v4-perf`，或新增 `test:security` 并接入 CI/发版清单。
- 验收/测试：干净 clone 上 `pnpm test:v4-perf` 输出里能看到这两个 node:test 文件。
- 来源：review-scope-C / round 1

### SC-C13 [P2] 测试残留死代码与未格式化 import

- 维度：K
- 文件：`core/tests/bash-handler.test.ts:14、2667-2668`；`core/tests/runtime-tool-loop.test.ts:2`
- 问题：`recordingBashTelemetry` 已无引用，其 `CommandExecutionSpanWriter` 导入成死代码（`telemetry?: ToolExecutionSpanWriter` 仍在用，别误删）；`runtime-tool-loop.test.ts:2` 把两条 import 挤成一行，`format:check` 会红。
- 改法：删 `recordingBashTelemetry` 与对应导入；第 2 行拆回两条 import。
- 验收/测试：`pnpm --dir apps/zcode-cli run format:check` 通过；`grep recordingBashTelemetry` 无命中。
- 来源：review-scope-C / round 1

---

## Spec deviations

无业务 PRD/spec 可对照，以 `docs/iterations/upstream-v3.17-selective/` 内 BRIEF/PLAN/analysis 为事实基准。本波次相对该基线的 7 项偏离如下，cr-func 复审判定**全部可接受**（第 5 项留待后续批次补做）：

| # | 偏离 | 现状 | 理由 | 判定 |
|---|---|---|---|---|
| 1 | borrowed port 的 `callTool` 连接性判定改用「最近一次实时观测集合」 | `core/src/subagent/borrowed-mcp-port.ts:60-70、78-86`：`connectedServerNames` 由每次 `status()` / `listTools()` 经 `observeStatuses` 刷新，`callTool` 的前置判定读它，不再读创建时的启动快照 | 工具只有在一次实时 `listTools()` 之后才会被注册，而那次调用必然已刷新本集合；若 `callTool` 仍按启动快照判定，刷新后新出现的工具会「注册成功但一调用就报 outside visible scope」。作用域仍冻结在创建时 allowlist + official CUA denylist | 可接受 |
| 2 | 额外整删 3 个文件（原计划只删账号相关引用） | 删除 `apps/zcode-cli/packages/cli/tests/tui-login-polling.test.ts`、`packages/desktop/test/e2e/helpers/worker-selection-integration.ts`，以及 helper 的唯一消费者 `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-worker-effective-selection.test.ts` | 三者都依赖已删账号通道：`tui-login-polling` 从 HEAD 就不存在的 `standalone-account-provider-runtime.js` 导入 5 个符号；helper 从 `@zcode/provider` 导入 `ZhipuAccountAccessConfig` / `createAccountProviderConfigSnapshot` / `MutableAccountProviderConfigSource`，并依赖 `NodeProviderRegistryRuntime` 的 `accountSource` 面。N2 按方案 (b) 裁剪后没有可解析实现，保留只能整文件 import 失败；被测的「独立 Host + 真实 stdio Worker 账号套餐切换」产品面在 fork 已不存在 | 可接受（覆盖损失限定在已删功能） |
| 3 | `permission-request.ts` 整删、`permission-response.ts` 裁到只剩 `validatePermissionResponse` | `core/src/tool/executor/permission-request.ts` 已删（`requestPermissionResponse` 全仓无调用方）；`permission-response.ts` 删除 `interpretPermissionResponse`，仅保留 `validatePermissionResponse` | 落实 SA-C10：`requestBroker` 已重写「登记后发布」逻辑，第二份 `requestPermissionResponse` 必然与之漂移；`interpretPermissionResponse` 无调用方，是死代码 | 可接受 |
| 4 | N2 采用方案 (b)（裁剪而非恢复符号） | `git grep "ZhipuAccountAccessConfig\|createAccountProviderConfigSnapshot\|standalone-account-provider-runtime" -- "apps/*" "packages/*"` 0 命中；账号分支调用点改 `createApiKeyProviderConfig` 口径，账户相关 fixture / 测试按无账号通道重建；`zcodeProviderUpdateAccountConfigParamsSchema` 保留（仍在 `packages/shared` 协议里） | 方案 (a) 要在 `packages/provider` 恢复两个符号的最小实现，等于为已下线账号通道续命；fork 产品面已无账号登录/套餐选择 | 可接受（账号通道整族下线） |
| 5 | `packages/formal-proof/src/model.ts` 的 held-queue 规则未同步产品新语义，只在测试登记为已知差异 | `packages/formal-proof/src/model.ts:495-516` 仍保留 `heldQueueInputRequiresChoice`；`apps/zcode-cli/packages/bootstrap/tests/formal-proof-consistency.test.ts`（`HELD_QUEUE_RULE_ID` 注释与 `heldQueueRows > 0` 防呆）显式登记：正式模型裁决仍是 `choice`，而 fork 投影实际为 `enqueue` + `heldQueuePausesButAcceptsInput` | 2026-10-23 bug B 拍板「暂停队列期间输入照常入队」，投放侧 `computeInputRouting` 已改；formal-proof 裁决表属模型侧独立工作面，本波次不扩面，差异不静默跳过 | 可接受；**后续批次补做**（同步 formal-proof 规则并移除测试内差异登记） |
| 6 | SC-C12 接入根 `test:v4-perf` 而非新增 `test:security` | 根 `package.json:34`（`test:v4-perf`）第二条 `tsx --test` 命令已包含 `apps/zcode-cli/packages/core/scripts/test-permission-plan-gate.mjs` 与 `test-bash-sed-readonly-policy.mjs`；未新增 `test:security` | `test:v4-perf` 已是本地/发版前统一的长尾脚本入口；新增独立 script 没有 CI 调用点，反而更容易漏跑 | 可接受（门禁可达性等价） |
| 7 | `provider-config-model-creation.test.ts` 的 `modelCall` 断言按字段已删改写 | `apps/zcode-cli/packages/adapters/tests/provider-config-model-creation.test.ts:101-108`：不再断言 `statusEvents[].modelCall.reasoning`，改为断言 adapter 级 `statusSink` 收到 2 条 `model_request_started` 与 2 条 `model_request_completed` | `modelCall` 观测字段已随遥测链路从 contracts 移除（d6fc8e61 删除 `ModelNetworkStatusBase.modelCall`），reasoning 控制信息不再进状态事件；旧断言只能永远红 | 可接受（断言口径随契约收窄，仍钉住 sink 转发） |

## Open questions / 待拍板

1. **sed 白名单是否放行带文件参数的替换**（原 SA-A9，评审认定「过度拒绝」但属产品决策，未计入 must-fix）：`files.length > 0` 使 `sed 's/a/b/' file`、`sed 's/a/b/g' file` 一律要确认；`-e` 移出安全集合后 `sed -e 's/a/b/' file` 也不放行。放行只需去掉 `files.length > 0` 并把 `-e/--expression` 以 `"string"` 放回、显式遍历其脚本；不放行则维持现状并在 SUMMARY 6.4 写明「带文件参数的替换一律确认」。

> 原 OQ2（statusSink 目标形态）与 OQ3（重入语义）已在 must-fix 里给出默认选项（SB-B5 默认 (a) 只为测试恢复；SA-C6 默认 ① 最多一次重问），不再重复计；用户若要推翻，按对应条目里的备选执行。

## 已豁免（用户确认不修）

- 无

## 合并后 QA（manual_user）

- guarded 下真实执行 `rm -rf <tmp>`、`git clean -f`：确认弹出单次确认窗、只有「允许一次 / 拒绝」、点允许后执行、拒绝后不执行。
- Plan 下 `WebFetch` 任意 URL、MCP 写工具：确认弹窗且无「始终允许」。
- guarded + Plan 下危险命令：确认表现为 deny（SA-A7 定论）。
- 新会话首轮 MCP 工具可用性：确认 `mcp__*` 出现在工具表（SB-B1/SA 修复面）。
- 对声明 `askOptions.allowAlways:"session"` 的工具，在 doom 确认窗点「本会话总是允许」后确认第 5 次相同调用放行（N1 修复面）；guarded 危险命令的 doom 窗应只有「允许一次 / 拒绝」（SA-D3 边界）。

## K 节建议（下游执行时闭合）

1. 提交前先处理 `backup/`（SC-C10），再按 SC-C11 二选一决定提交策略；src + 测试 + 脚本 + package.json 同提交。
2. `pnpm --dir apps/zcode-cli run format:check`、`pnpm lint`、对应包 `tsc -b`、`test:v4-perf`（含新脚本，SC-C12）。
3. 提交后确认 `approval-gate.ts`/`hook-flow.ts`/`permission-capability.ts` 的 CRLF 已被 `.gitattributes` 归一，diff 无整文件 churn。

---

## Fix-Spec Closure

| 项 | 状态 |
|---|---|
| execute-ready（文档闸门） | yes，待用户确认（spec-check round 1 的 P0=1/P1=4/P2=9 已 doc-fix 闭合；用户限定一轮，未做第 2 轮验证） |
| fix_spec_path | `docs/iterations/upstream-v3.17-selective/cr-fix-spec.md` |
| dag_version / review_round | 4 / 3 + spec-check 1 |
| P0 / P1 / P2（已写入 fix-spec） | 1 / 11 / 30 |
| 未写入的开放 must-fix | 0 |
| spec-check 闭合记录 | P0-1（SA-D3↔N1 会话豁免矛盾：user-once 路径不给会话豁免、文案分叉、N1 验收改用 build 模式 + 反面用例）；P1-1（SB-B8 保留 isInScope 过滤 + 反回归断言）；P1-2（SC-C3 拆两条、identity 依赖 N2）；P1-3（SA-A4 落盘断言移到 build 模式）；P1-4（SA-B5 `waiting`→`pending`）；P2×9（maxRisk 落点、recheck 返回契约、N3 守卫取值源与签名、SA-B2 harness 补 sessionModePort、SB-B3 publish 必填、SB-B10 红绿归因、N2 补第 8 个坏文件、N5 测试落点、SB-B5 验收命令） |
| spec_deviations | 7 项，见上「Spec deviations」；cr-func 判定全部可接受，第 5 项标「后续批次补做」 |
| C-orch | ✅（SA-C10、SB-B7 已列为收敛目标） |
| C 类合并后 QA | 5 条，见「合并后 QA（manual_user）」，不阻塞 |
| Open questions | 1 条（sed 是否放行带文件参数的替换），不阻塞 |
