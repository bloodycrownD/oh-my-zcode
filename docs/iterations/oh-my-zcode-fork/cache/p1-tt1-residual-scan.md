# P1 · T-T1 遥测残留扫描（verify-p1 / Step 13）

- 仓库：`D:\Dev\Js\oh-my-zcode\omz`
- 分支：`dev/phase-0`　HEAD：`5d69063 phase1(s12): 重生成 THIRD-PARTY-NOTICES 与 inventory，收口遥测声明残留`
- 执行节点：verify-p1（只读验证，未修改任何源码）
- 扫描工具：`E:\App\Others\ZCode\resources\tools\ripgrep\rg.exe`（ripgrep 14.1.1）
- 原始日志：
  - `cache/s13-tt1-scan-raw.log`（任务书给定的 `(?i)` 复合模式，含假阳性）
  - `cache/s13-tt1-scan-clean.log`（大小写修正后的 `telemetry/Telemetry/TELEMETRY` 权威扫描）
  - `cache/s13-tt1-s7-names.log`（`ModelApiErrorPhase` / `ModelFailureExceptionKind`）
  - `cache/s13-tt1-xdevicemid.log`、`cache/s13-tt1-telemetrystate.log`

## 0. 扫描范围与统计口径

扫描目录：`packages/`、`apps/zcode-cli/packages/`、`scripts/`

排除 glob：`node_modules/**`、`**/dist/**`、`**/bundled-agents/**`、`**/.turbo/**`、`out/**`、`**/mock-cdn/**`、`**/dist-types/**`

| 轮次 | 模式 | 命中行 | 命中文件 | 备注 |
|---|---|---|---|---|
| R1（任务书原始） | `(?i)telemetry\|armsrum\|@arms\|opentelemetry\|otlp\|posthog\|sentry` | 792 | 91 | **含假阳性**，见下 |
| R2（大小写修正） | `telemetry\|Telemetry\|TELEMETRY` | 324 | 68 | T-T1 权威口径 |
| R3（vendor 专项） | `armsRum\|@arms\|ARMS\|opentelemetry\|OpenTelemetry\|OTEL\|OTLP\|otlp\|posthog\|PostHog\|sentry\|Sentry\|rrweb`（大小写敏感） | 32 | 10 | 见 §2 |
| R4（文件名） | 文件/目录名含 telemetry/arms/otlp/sentry/posthog/rrweb | 9 + 2 | — | 见 §3 |

**R1 假阳性说明**：`-i` 让 `sentry` 命中了 `…sEntry`（如 `isProcessEntry`、`PendingCommandEntry`、`GitStatusEntry`、`OffPeakTicketStatusEntry`），牵连 `packages/services/src/git/**`、`packages/ui/src/settings/AutomationEditView.tsx`、`packages/ui/src/store/automationManagementStore.ts` 等约 23 个文件。R2/R3 改用大小写敏感模式后这批全部消失，**不构成残留**。

---

## 1. 白名单（预期保留）

> 全部命中均在任务书预先声明的白名单范围内。**无任何白名单外的代码级命中。**

### A1 deviceMid 设备身份链 + `telemetry-state.json` 磁盘文件名

| 文件 | 行数 | 命中要点 |
|---|---|---|
| `apps/zcode-cli/packages/adapters/src/device/cli-device-mid.ts` | 20 | `TelemetryState` / `telemetry-state.json` / `telemetry-state.lock` 读写与锁 |
| `packages/services/src/device/deviceMid.ts` | 5 | 设备身份文件路径解析（文件名沿用 `telemetry-state.json`） |
| `packages/desktop/src/main/desktopDeviceMid.ts` | 4 | 同上（desktop 侧同步取值） |
| `packages/services/src/providers/sourceHeaders.ts` | 2 | 复用既有 deviceMid，不生成新身份 |
| `packages/server/src/entry-stdio.ts` | 1 | 注释：远端无 desktop main |
| `packages/services/src/onboarding/onboardingRecordService.ts` | 1 | 注释：与 `telemetry-state.json` 路径口径一致 |

`X-Device-Mid` 请求头（billing / feedback / onboarding / manifest-update 链路，共 10 处）：

- `packages/shared/src/zcode-source-headers.ts:57`
- `packages/services/src/feedback/feedbackService.ts:93`
- `packages/services/src/feedback/feedbackHttpClient.ts:329,424`
- `packages/desktop/src/main/manifestUpdateProvider.ts:222`
- `packages/services/src/device/deviceMid.ts:191`（注释）
- `packages/server/src/stdioDeviceMid.ts:14,29`（注释）
- `packages/server/src/entry-stdio.ts:55`（注释）

### A2 D-8 `conversationTelemetryFact` 通道（已缩为 turn 事实）

| 文件 | 行数 | 链路角色 |
|---|---|---|
| `packages/shared/src/zcode-protocol-v4/telemetry.ts` | 10 | schema 本体，仅 `turn.started` / `turn.terminal` |
| `packages/shared/src/zcode-protocol-v4/transport.ts:405` | 1 | `conversationTelemetryFact: "v4/telemetry/event"` |
| `packages/shared/src/zcode-protocol-v4/index.ts:50` | 1 | `export * from "./telemetry.js"` |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-telemetry-facts.ts` | 7 | `ConversationTelemetryFactNormalizer` |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts` | 22 | 去重 + 归一 + `host.emitConversationTelemetryFact` |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts:1485-1487` | 2 | 经 `V4_NOTIFICATIONS.conversationTelemetryFact` 上送 |
| `packages/services/src/zcode-agent/zcodeAgentService.ts` | 15 | emitter map / get…Emitter / 分发 / 释放 / 对外 Event |
| `packages/services/src/zcode-agent/zcodeAgent.ts:74,809-811` | 3 | 接口声明 |
| `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts:857-877` | 2 | trusted-desktop 门禁覆写 |

### A3 `taskActivityTracker`（D-8 下游消费者）

- `packages/zcode-server-cli/src/server-core/taskActivityTracker.ts`（9 行）
- `git log --oneline -- packages/zcode-server-cli/src/server-core/taskActivityTracker.ts` → 仅 `c34a938 baseline: import ZCode v3.14.3 snapshot`，**Phase 1 无任何提交，一行未动**。

### A4 `SANITIZED_RUNTIME_ENV_KEYS` / OTEL 前缀防泄漏剔除名单

- `packages/shared/src/runtimeEnv.ts`（12 行 + vendor 专项 13 行）：
  - `:75-83` `OTEL_EXPORTER_OTLP_*` / `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` 等键进入 `SANITIZED_RUNTIME_ENV_KEYS`
  - `:251-257` `isAgentTelemetryEnvKey()` —— 按前缀整体拒绝 `OTEL_` / `ZCODE_TELEMETRY_` / `ZCODE_MODEL_TELEMETRY_ENABLED`
  - `:246-249` 设计说明注释（防泄漏安全边界，与上游是否仍产生这些键无关）
- `packages/desktop/src/main/desktopRuntimeEnv.ts:498`（注释）
- `packages/desktop/tsup.config.ts:169`（注释）

### A5 s7 偏离1 迁移符号 `ModelApiErrorPhase` / `ModelFailureExceptionKind`

| 文件 | 命中数 |
|---|---|
| `apps/zcode-cli/packages/adapters/src/model/runner-telemetry.ts` | 15 |
| `apps/zcode-cli/packages/contracts/src/model/index.ts` | 5 |
| `apps/zcode-cli/packages/core/src/errors/error-payload.ts` | 4 |
| `apps/zcode-cli/packages/contracts/src/events/session.events.ts` | 3 |
| `packages/desktop/bundled-agents/win32-x64/glm/zcode.cjs` | 1（构建产物，按范围排除） |

### A6 s7 白名单 `ToolExecutionTelemetry` / `SkillTelemetryMetadata`（本地 tool perf 归因）

| 文件 | 行数 |
|---|---|
| `apps/zcode-cli/packages/contracts/src/tools/performance.ts` | 17 |
| `apps/zcode-cli/packages/core/src/tool/handlers/tool-perf.ts` | 15 |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash-output.ts` | 14 |
| `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts` | 8 |
| `apps/zcode-cli/packages/contracts/src/events/session.events.ts` | 8 |
| `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts` | 7 |
| `apps/zcode-cli/packages/core/src/tool/handlers/write.ts` | 6 |
| `apps/zcode-cli/packages/core/src/tool/executor/events.ts` | 5 |
| `apps/zcode-cli/packages/core/src/tool/types.ts` | 5 |
| `apps/zcode-cli/packages/contracts/src/tools/{bash,edit,write}.ts` | 各 2 |
| `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts` | 2 |
| `apps/zcode-cli/packages/contracts/src/skills/index.ts` | 1（`SkillTelemetryMetadata` 定义） |
| `apps/zcode-cli/packages/core/src/tool/handlers/skill.ts` | 1 |
| `apps/zcode-cli/packages/core/src/tool/handlers/generated/bash-command-registry.ts` | 1 |
| `packages/shared/src/zcode-task-types-core.ts` | 2（注释） |

### A7 MCP 进程 / Bash 本地资源采样链

| 文件 | 行数 |
|---|---|
| `apps/zcode-cli/packages/adapters/src/mcp/telemetry.ts` | 27 |
| `apps/zcode-cli/packages/adapters/src/mcp/index.ts` | 11 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` | 8 |
| `apps/zcode-cli/packages/adapters/src/mcp/pool.ts` | 7 |
| `packages/shared/src/zcode-protocol/index.ts` | 7 |
| `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-run.ts` | 4 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/runtime-cleanup.ts` | 3 |
| `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-process.ts` | 3 |
| `apps/zcode-cli/packages/adapters/src/mcp/resource-telemetry.ts` | 2 |
| `apps/zcode-cli/packages/adapters/src/exec/bash-resource-telemetry.ts` | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts` | 2 |
| `packages/shared/src/validation.ts` | 4（`PROCESS_RESOURCE_CLI_LANES` / `resourceTelemetryEnvironmentKeySchema`） |
| `packages/shared/src/node.ts:23` | 1（`nodeSelfResourceTelemetry` re-export） |
| `packages/shared/src/processResourceTelemetry.ts` | 1（vendor 专项另见 §2 B1-B4） |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts:677` | 1 |

### A8 `compactContextTelemetry`（Phase 2b 随删）

- `apps/zcode-cli/packages/core/src/runtime/methods/compact.ts:264,417`（2）
- `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts:82,119`（2）
- `apps/zcode-cli/packages/core/src/runtime/internal-turn-methods.ts:204`（1）

### A9 `runner-telemetry.ts`（本地 model failure 归因，非上报通道）

- `apps/zcode-cli/packages/adapters/src/model/runner-generate.ts:56`
- `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts:85`
- `apps/zcode-cli/packages/adapters/src/model/runner-retry.ts:13`
- `apps/zcode-cli/packages/adapters/src/model/runner-status.ts:144`（注释）

### A10 注释 / 文案 / 日志前缀里的词

| 文件 | 行数 | 性质 |
|---|---|---|
| `packages/shared/src/runtimeEnv.ts` | 12 | 见 A4 |
| `packages/desktop/src/main/exportLogs.ts:1064,1103` | 2 | 注释（log 轮转竞态） |
| `packages/shared/src/official-glm-model-id.ts:1,28` | 2 | 注释 |
| `apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-review-mutation.ts:43,81` | 2 | 注释（脱敏说明） |
| `packages/services/src/node.ts:1445` | 1 | 注释 |
| `packages/services/src/providers/api/nodeApiNetwork.ts:100` | 1 | 注释 |
| `packages/services/src/zcode-agent/zcodeStdioTransport.ts:251` | 1 | 注释 |
| `packages/shared/src/platform.ts:44` | 1 | 注释（提及 `remoteUsageTelemetry.ts` 已整删） |
| `packages/shared/src/task-realtime-core.ts:12` | 1 | 注释 |
| `packages/shared/src/automation-types.ts:113` | 1 | 注释 |
| `apps/zcode-cli/packages/core/src/errors/error-payload.ts:62` | 1 | 注释 |
| `apps/zcode-cli/packages/core/src/tool/handlers/read-pdf.ts:278` | 1 | 注释 |
| `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts:346` | 1 | 注释 |
| `apps/zcode-cli/packages/contracts/src/events/event-reducer.ts:333` | 1 | 注释 |
| `packages/ui/src/hooks/useCodingPlanEntryPlanList.ts:121` | 1 | `logger.debug("[purchaseTelemetry] …")` 日志前缀 |
| `scripts/typecheck-desktop-full.mjs:55` | 1 | 注释（提 `armsRumShared.*`） |
| `packages/rpc/tsconfig.json:16` | 1 | 注释（提 rrweb 传递依赖） |

### A11 lockfile 传递依赖

- `@opentelemetry/api@1.9.0`：见 §4 T-T3。

---

## 2. vendor 专项扫描明细（R3，32 行 / 10 文件）

| 文件 | 行数 | 性质 | 归类 |
|---|---|---|---|
| `packages/shared/src/runtimeEnv.ts` | 13 | 9 条 `OTEL_EXPORTER_OTLP_*` 剔除键 + 3 条注释 + 1 处 `key.startsWith("OTEL_")` | 白名单 A4 |
| `scripts/desktop-typecheck-baseline.txt` | 8 | 历史 tsc 错误文本（`appARMSBootstrap.ts` / `armsRumShared.ts` / `ZCODE_ARMS_RUM_ENDPOINT`） | 白名单（门禁基线文本，非代码） |
| `packages/shared/src/processResourceTelemetry.ts` | 3 | **1 注释 + 1 常量声明 + 1 常量使用** | **疑似残留 B1** |
| `packages/desktop/src/main/desktopDeviceMid.ts` | 2 | 注释 | **疑似残留 B5** |
| `packages/desktop/src/main/desktopRuntimeEnv.ts` | 1 | 注释 | **疑似残留 B6** |
| `packages/desktop/tsup.config.ts` | 1 | 注释 | **疑似残留 B6** |
| `scripts/typecheck-desktop-full.mjs` | 1 | 注释 | **疑似残留 B6** |
| `packages/shared/src/zcode-protocol/index.ts` | 1 | 注释 | **疑似残留 B7** |
| `packages/shared/src/mcp.ts` | 1 | 注释 `// Sentry specific fields` | **疑似残留 B8** |
| `packages/rpc/tsconfig.json` | 1 | 注释（提 rrweb 传递依赖，该依赖已不在 lockfile） | **疑似残留 B9** |

**外发通道探针**：额外用 `sendTelemetry|reportTelemetry|uploadTelemetry|telemetryReport|telemetrySend|flushTelemetry|telemetryUrl|telemetryEndpoint|telemetryClient|telemetrySdk|armsRum|RumClient|initArms|startTelemetry` 扫全范围，**除 `scripts/typecheck-desktop-full.mjs:55` 一条注释外 0 命中**。即：仓库内**不存在任何遥测上报入口 / SDK 初始化 / 端点配置**。

---

## 3. 文件名扫描（R4）

| 路径 | 归类 |
|---|---|
| `packages/shared/src/zcode-protocol-v4/telemetry.ts` | 白名单 A2（D-8 turn 事实） |
| `packages/shared/src/processResourceTelemetry.ts` | 白名单 A7 + 残留 B1-B4 |
| `packages/shared/src/node/nodeSelfResourceTelemetry.ts` | 白名单 A7 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-telemetry-facts.ts` | 白名单 A2 |
| `apps/zcode-cli/packages/adapters/src/exec/bash-resource-telemetry.ts` | 白名单 A7 |
| `apps/zcode-cli/packages/adapters/src/mcp/telemetry.ts` | 白名单 A7 |
| `apps/zcode-cli/packages/adapters/src/mcp/resource-telemetry.ts` | 白名单 A7 |
| `apps/zcode-cli/packages/adapters/src/model/runner-telemetry.ts` | 白名单 A9 |
| `packages/desktop/src/renderer/public/material-icons/sentry.svg` | **白名单（vendored 静态图标资源，非 SDK）** |
| `packages/web/public/material-icons/sentry.svg` | 同上 |

`sentry.svg` 已核实为 Google Material Icons 图标集内的 Sentry 品牌图标（单条 `<path fill="#f06292">`），随图标字体一并 vendored，与 Sentry 服务无任何代码耦合。

---

## 4. T-T3 第三方声明复证（同一节点顺带复跑）

扫描对象：`THIRD-PARTY-NOTICES.md`、`third-party/inventory.json`、`third-party/copied-components.json`、`third-party/embedded-components.json`、`third-party/npm-overrides.json`

| 目标 | 命中 | 结论 |
|---|---|---|
| `@arms/` | 0 | ✅ |
| `armsrum` | 0 | ✅ |
| `rrweb` | 0 | ✅ |
| `@babel/runtime` | 0 | ✅ |
| OTLP exporter 族（`@opentelemetry/*exporter*`、`otel-*`、`*-exporter`） | 0 | ✅ |
| `posthog` | 0 | ✅ |
| `@opentelemetry/api` | 1（inventory.json:5079）+ 4（NOTICE:359 / 2408 / 4929 / 4938 / 4940-4943 链接定义） | 见下 |

`@opentelemetry/api@1.9.0` 单独说明：
- `pnpm-lock.yaml:13424 / 13432` 显示其**唯一依赖方是 `ai@6.0.159` 与 `ai@6.0.193`**（Vercel AI SDK）的传递依赖；
- 该包只是 OTel **API 门面**（无 SDK / 无 exporter / 无 collector 端点 / 不自行出网）；
- 本 fork 源码内 `@opentelemetry` 的 import / 调用 **0 命中**（R3 仅命中 NOTICE 与 inventory 文本）；
- 结论：**符合「ai SDK 传递依赖」豁免，非残留**。

`inventory.json:1239 / 2508 / 23248 / 27832` 的 `sentry.svg` 为 §3 已核实的图标资源条目。

---

## 5. T-T5 静态链路复证（D-8 保留链完整性）

| 检查项 | 结果 |
|---|---|
| `packages/services/src/zcode-agent/zcodeAgentService.ts:1130` `conversationTelemetryFactEmitters` Map | ✅ |
| 同文件 `:1573-1580` `getConversationTelemetryFactEmitter` | ✅ |
| 同文件 `:1984-1990` `V4_NOTIFICATIONS.conversationTelemetryFact` 分发 + `safeParse` + 无效告警 | ✅ |
| 同文件 `:3182-3185` emitter 释放 | ✅ |
| 同文件 `:5436-5438` `onDynamicConversationTelemetryFact` 对外 Event | ✅ |
| `packages/services/src/zcode-agent/zcodeAgent.ts:74,809-811` 接口声明 | ✅ |
| `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts:857-877` trusted-desktop 门禁覆写 | ✅ |
| `packages/services/src/zcode-agent/zcodeAgent.ts` / `zcodeAgentConnectionScope.ts` 覆写存在 | ✅ |
| `packages/zcode-server-cli/src/server-core/taskActivityTracker.ts` Phase 1 零提交 | ✅ |
| `packages/shared/src/zcode-protocol-v4/telemetry.ts` schema 含 `turn.started` + `turn.terminal`（均 `.strict()`，其余 kind 已删） | ✅ |
| `packages/shared/src/zcode-protocol-v4/transport.ts:405` `v4/telemetry/event` 路由 | ✅ |

---

## 6. 疑似残留清单（需处理 / 待决策，**不阻塞 Step 13**）

> 全部落在白名单文件**内部**，没有一条是「白名单外的代码级命中」。逐条如下：

| # | 位置 | 内容 | 判断 | 建议 |
|---|---|---|---|---|
| B1 | `packages/shared/src/processResourceTelemetry.ts:65-66,170` | `export const ARMS_CUSTOM_EVENT_PROPERTY_LIMIT = 20`，全仓库唯一消费点是同文件 line 170，**无任何外部 import** | 唯一一条**代码级 vendor 命名残留**（导出但已无跨模块消费者） | Phase 2 或后续清理节点：重命名/降为模块私有常量；因无外部消费者，风险为零 |
| B2 | `packages/shared/src/processResourceTelemetry.ts:72` | 全局属性键字面量 `"arms_env"` | vendor 维度名残留 | 同 B1 一并处理 |
| B3 | `packages/shared/src/processResourceTelemetry.ts:56-136` | `PROCESS_RESOURCE_EVENT_NAMES`（`perf_process_window` / `perf_system_window` / `perf_tool_exec_resource`）与 `PERF_*_PROPERTY_KEYS` 三张属性表 —— 经查**仅在文件内自引用** + `packages/shared/src/index.ts:263` 的 `export *`，无实际采集/上报链消费 | 整块成为孤儿常量（与 Phase 0 时的「本地资源管理器链」已脱钩） | 与 B1/B2/B4 打包成一个 follow-up 议题；knip 未报（被 `index.ts` re-export 掩盖） |
| B4 | `packages/shared/src/processResourceTelemetry.ts:117` | 属性键字面量 `"telemetry_self_ms"` | vendor 命名残留 | 同 B1 |
| B5 | `packages/desktop/src/main/desktopDeviceMid.ts:17-18,23` | 注释仍写「与数仓上报（telemetryCore）共用…使 **ARMS** 与数仓两套 device_mid 统一」「避免冲掉 telemetryCore 写的」 | 注释指向**已删除的上报体**，语义已过期（与 s12 已做的 NOTICE.md 描述改写同类） | 建议与 s12 的 NOTICE 改写一并做注释收口；纯文案，零运行时影响 |
| B6 | `packages/desktop/src/main/desktopRuntimeEnv.ts:498`、`packages/desktop/tsup.config.ts:169`、`scripts/typecheck-desktop-full.mjs:55` | 注释分别提「外部环境里的 OTLP 凭据」「OTLP 端点与鉴权只在运行时读取」「再生编译产物（`armsRumShared.*`、`schedulerProtocol.*`）」 | 注释指向已删配置/已删产物（`armsRumShared.*` 已不存在，门禁现在只会再生 `schedulerProtocol.*`） | 文案过期，`typecheck-desktop-full.mjs:55` 的括号内容已与实际不符，建议改 |
| B7 | `packages/shared/src/zcode-protocol/index.ts:503` | 注释「…不进 **ARMS** 属性…」 | vendor 命名残留 | 文案，随 B5 一并 |
| B8 | `packages/shared/src/mcp.ts:41` | 注释 `// Sentry specific fields` | vendor 命名残留 | 文案，随 B5 一并 |
| B9 | `packages/rpc/tsconfig.json:16` | 注释「rrweb 传递依赖的旧 @types/css-font-loading-module…」 | 依赖已从 lockfile 移除，注释失效 | 文案，随 B5 一并；若该 tsconfig workaround 已无必要可一并复核 |

### 无残留确认项

- **0 个白名单外的代码级命中**：无第三方遥测 SDK 的 import / 实例化 / 调用 / schema。
- **0 个遥测外发入口**：`sendTelemetry|flushTelemetry|telemetryUrl|…|initArms|startTelemetry` 全范围 0 命中。
- **0 个 ARMS / Sentry / PostHog / rrweb / OTLP exporter 代码依赖**（package.json 与 lockfile 均无）。

---

## 7. 落盘物

| 文件 | 说明 |
|---|---|
| `docs/iterations/oh-my-zcode-fork/cache/p1-tt1-residual-scan.md` | 本文件 |
| `docs/iterations/oh-my-zcode-fork/cache/s13-tt1-scan-raw.log` | R1 原始扫描（含假阳性） |
| `docs/iterations/oh-my-zcode-fork/cache/s13-tt1-scan-clean.log` | R2 权威扫描 |
| `docs/iterations/oh-my-zcode-fork/cache/s13-tt1-s7-names.log` | s7 迁移符号扫描 |
| `docs/iterations/oh-my-zcode-fork/cache/s13-tt1-xdevicemid.log` | `X-Device-Mid` 扫描 |
| `docs/iterations/oh-my-zcode-fork/cache/s13-tt1-telemetrystate.log` | `telemetry-state.json` 扫描 |
