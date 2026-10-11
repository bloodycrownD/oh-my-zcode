---
节点: impl-p1-s6（packages/shared 遥测摘除）
产出: 因本节点删除而断链的**包外**引用清单
日期: 2026-10-03
消费方: impl-p1-s7（CLI 侧）/ impl-p1-s9（desktop）/ impl-p1-s11（UI+services+rpc）
自验: `tsc -p packages/shared/tsconfig.json --noEmit` 零错误；`oxlint` 5 warning 全为基线既有
---

# p1-s6 断链清单（packages/shared → 全仓）

本节点**只改 `packages/shared`**。下列引用在 shared 侧已删除或缩减，属**预期断链**，
由后续波次（s7 / s9 / s11）消费。每条给出「文件 → 符号 → 该波次要做什么」。

## 0. 本节点删除/缩减的符号总表

| 类 | 删除符号 | 所在文件 |
|---|---|---|
| env | `ZCODE_TELEMETRY_ENABLED` / `ZCODE_TELEMETRY_REPORT_ENDPOINT` / `ZCODE_ARMS_RUM_ENDPOINT` / `mapZCodeEnvToArmsRumEnv` / `ArmsRumEnv` | `env.ts` |
| runtimeEnv | `captureZCodeAgentTelemetryEnv` / `readZCodeAgentTelemetryEnv` / `getCapturedZCodeAgentTelemetryEnv` / `resetCapturedZCodeAgentTelemetryEnvForTest` / `isZCodeAgentTelemetryEnvKey` / `capturedZCodeAgentTelemetryEnv` | `runtimeEnv.ts` |
| channel（zcode: 6 个） | `SyncTelemetryContext` / `ReportTelemetryEvent` / `ReportArmsCustomEvent` / `GetRendererActionTraceConfig` / `RendererActionTraceConfigChanged` / `ReportRendererActionTraceBatch` / `ReportLocalTtftBatch` | `channels.ts` |
| channel（方法名式 3 个） | `McpTelemetry` / `SessionCreateTelemetry` / `NetworkTelemetryBatch` | `channels.ts` |
| channel（ARMS E2E 3 个，**清单外**） | `ReadFinalArmsCustomEventsE2E` / `ClearFinalArmsCustomEventsE2E` / `ConfigureFinalArmsCustomEventsE2E` | `channels.ts` |
| platform 方法 | `reportTelemetryEvent` / `reportArmsCustomEvent` / `getRendererActionTraceConfig` / `onRendererActionTraceConfigChanged` / `reportRendererActionTraceBatch` / `reportLocalTtftBatch` | `platform.ts` |
| 整删文件 | `telemetry.ts` / `telemetryRedaction.ts` / `sessionCreateTelemetry.ts` / `rendererActionTrace.ts` / `localTtft.ts` / `remoteUsageTelemetry.ts` | — |
| 旧协议 | `zcodeProtocolNotifications.mcpTelemetry` / `zcodeMcpTelemetryEventSchema` / `ZCodeMcpTelemetryEvent` | `zcode-protocol/index.ts` |
| validation | `hostMcpTelemetryResponseSchema` / `hostSessionCreateTelemetryResponseSchema` / `hostNetworkTelemetryBatchResponseSchema`（+ `networkObservationSchema`）/ `telemetryRendererContextSchema` / `rendererTelemetryEventPayloadSchema` / `armsCustomEventPayloadSchema` | `validation.ts` |
| v4 缩减 | `V4_NOTIFICATIONS.localTtftFacts` / conversation frame `ttft` / `ttftRelated` / `commandEnvelopeSchema.ttft` / `commandsQueryResultSchema.clock` | `zcode-protocol-v4/{transport,command}.ts` |
| v4 缩减 | `conversationTelemetryFactSchema` 联合成员从 10 → 2（只留 `turn.started` / `turn.terminal`） | `zcode-protocol-v4/telemetry.ts` |

## 1. 迁移/保留项（下游**不需要**改）

| 符号 | 原位置 | 现位置 | 说明 |
|---|---|---|---|
| `RemoteWorkspaceConnectTrigger` | `remoteUsageTelemetry.ts`（已删） | **`platform.ts` 新增导出**，并由 `index.ts` barrel 再出口 | 值域不变（`"new" \| "reconnect" \| "restore"`）。`platform.ts:460/:589` 两处 `connectTrigger?` 已改直接引用 |
| `SANITIZED_RUNTIME_ENV_KEYS` 17 个遥测键 | `runtimeEnv.ts` | 原样保留 | 防泄漏安全边界，只剔除不捕获 |
| `PlatformChannels.GetDeviceId` / `getDeviceId()` | `channels.ts` / `platform.ts` | 原样保留 | spec 防误删清单 |
| `V4_NOTIFICATIONS.conversationTelemetryFact`（`"v4/telemetry/event"`） | `transport.ts` | 原样保留 | D-8 |
| `conversationTelemetryFactSchema` / `ConversationTelemetryFact` | `v4/telemetry.ts` | 缩减保留 | 只留 turn 事实 |
| `processResourceTelemetry.ts` / `rendererHeapSampleSchema` / `RendererHeapSample` / `PlatformChannels.ReportRendererHeapSample` / `reportRendererHeapSample` | — | **保留（偏离 spec 清单，见 §4）** | 本地资源管理器 |

---

## 2. 断链明细（按波次）

### 2.1 s7 — CLI 侧（`apps/zcode-cli`）

| 文件 | 断链符号 |
|---|---|
| `packages/bootstrap/src/telemetry-bootstrap.ts:1,17` | `getCapturedZCodeAgentTelemetryEnv`（整文件待删） |
| `packages/bootstrap/src/zcode-protocol-v4/local-ttft.ts`（26 处） | `localTtft*` 全族（整文件待删） |
| `packages/bootstrap/src/zcode-protocol-v4/local-ttft-clock.ts` | `localTtftClockSchema` |
| `packages/bootstrap/src/zcode-protocol-v4/local-ttft-compaction.ts` | `localTtft*` |
| `packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:2,612,3382,3393` | `localTtftFactsSchema` / `localTtftNow`；`frame.ttftRelated` 写入 |
| `packages/bootstrap/src/zcode-protocol/v4-bridge.ts:1486` | `V4_NOTIFICATIONS.localTtftFacts` |
| `packages/bootstrap/src/zcode-protocol-entrypoint.ts:13,131,326-335` | `ZCodeMcpTelemetryEvent` + `zcodeProtocolNotifications.mcpTelemetry` |
| `packages/bootstrap/src/zcode-protocol/{server,server-types,runtime-cleanup}.ts` | `mcpTelemetry` tracker 字段（保留 tracker 本体，只删 sink 分支） |
| `packages/adapters/src/mcp/telemetry.ts:3,14-20,76-109` | `ZCodeMcpTelemetryEvent`（`arch`/`platform` 索引访问点需改写，见 §4.2） |
| `packages/adapters/src/mcp/{index,pool}.ts` | 上述 tracker 引用 |
| `packages/contracts/src/index.ts:104` | `export type { LocalTtftDetail } from "@zcode/shared"` |
| `packages/contracts/src/tracing/local-turn-preparation.ts` | `LocalTtft*` |
| `packages/core/src/runtime/methods/turn.ts` | `LocalTtft*` |

### 2.2 s9 — desktop 侧

| 文件 | 断链符号 |
|---|---|
| `src/main/appARMSBootstrap.ts:7-10,145,173,268` | `ZCODE_ARMS_RUM_ENDPOINT` / `ZCODE_TELEMETRY_ENABLED` / `mapZCodeEnvToArmsRumEnv` |
| `src/main/desktopArmsCustomEvent.ts:3-6,13-171` | `FinalArmsCustomEventPayload` / `FinalArmsCustomEventE2EEntry` / `ConfigureFinalArmsCustomEventE2ERequest`（整文件待删） |
| `src/main/desktopMainIpcRemote.ts:5-16,28-35,159-475` | `armsCustomEventPayloadSchema` / `rendererTelemetryEventPayloadSchema` / `classifyRemoteUsageError` / `RemoteUsage*` / `TelemetryEventPayload`；3 个 ARMS E2E channel + `SyncTelemetryContext` / `ReportTelemetryEvent` / `ReportArmsCustomEvent` |
| `src/main/desktopMcpTelemetry.ts:2,17,47,91` | `ZCodeMcpTelemetryEvent`（整文件待删） |
| `src/main/desktopNetworkTelemetry.ts:3,26` | `mapZCodeEnvToArmsRumEnv` |
| `src/main/desktopRemoteUsageArmsTelemetry.ts:3-205` | `RemoteUsage*` / `FinalArmsCustomEventPayload`（整文件待删） |
| `src/main/desktopRemoteSessions.ts:23,36,57,369,407,496,675-782` | `remoteUsageTelemetryEligible` 生命周期（整块删） |
| `src/main/desktopResourceTelemetry.ts:6,17,90,150` | `mapZCodeEnvToArmsRumEnv` / `getSharedFinalArmsCustomEventE2EController` |
| `src/main/desktopStabilityTelemetry.ts:6,96` | `mapZCodeEnvToArmsRumEnv` |
| `src/main/desktopZCodeDataSizeTelemetry.ts:2,95,101` | `ArmsRumEnv` / `FinalArmsCustomEventPayload`（整文件待删） |
| `src/main/databaseStartupTelemetry.ts:8,23` | `buildFinalArmsCustomEventPayload` |
| `src/main/armsEventRedaction.ts:1,53,61` | `redactTelemetryText` / `redactTelemetryUrl` |
| `src/main/appTelemetryRuntime.ts` | 9 处（`TelemetryEventPayload` / `RendererTelemetryEventPayload` 等） |
| `src/main/desktopHostProcess.ts:21-22,180-181,321,366-367` | `HostMcpTelemetryResponse` / `HostSessionCreateTelemetryResponse` / `HostResponseTypes.{McpTelemetry,SessionCreateTelemetry,NetworkTelemetryBatch}` |
| `src/main/localTtftExporter.ts` / `localTtftSpans.ts` / `localTtftExportDedupe.ts` | `localTtft*` + `rendererActionTrace*`（整批删） |
| `src/main/rendererActionTraceBroker.ts` / `rendererActionTraceExporter.ts` / `rendererActionTraceIpc.ts` / `rendererActionTraceRollout.ts` | `RENDERER_ACTION_TRACE_*` / `rendererActionTrace*Schema`（整批删；`rendererActionTraceIpc.ts:120` 的 `ZCODE_RENDERER_ACTION_TRACE_ENABLED` 一并走） |
| `src/main/index.ts`（41 处） | 上述全部 + `ReportLocalTtftBatch:818` + `mapZCodeEnvToArmsRumEnv:240,2180,2208-2236` |
| `src/main/desktopRuntimeEnv.ts:24,505` | `readZCodeAgentTelemetryEnv` |
| `src/host/hostMcpTelemetry.ts` / `hostSessionCreateTelemetry.ts` / `hostNetworkTelemetry.ts` / `hostServiceResourceTelemetry.ts` / `host/index.ts:29` | 三个 host channel + `AutomationSessionCreateTelemetry` |
| `src/preload/index.ts`（27 处） | 6 个 platform 方法 + 3 个 E2E channel + `LocalTtftBatch` + `RendererActionTrace*V1` + `ConfigureFinalArmsCustomEventE2ERequest` / `FinalArmsCustomEventE2EEntry` |
| `src/renderer/appTelemetryBridge.ts` / `src/renderer/src/{desktopPlatform,main,localTtftBootstrap,userActionTraceBootstrap}.tsx|ts` | `collectTelemetryRendererContext` / `reportTelemetryEvent` / `reportArmsCustomEvent` / `reportLocalTtftBatch` / `reportRendererActionTraceBatch` / `getRendererActionTraceConfig` / `DISABLED_RENDERER_ACTION_TRACE_CONFIG` / `RENDERER_ACTION_TRACE_SERVICE_NAME` |
| `src/shared/armsRumShared.{ts,d.ts,js,js.map}` | `mapZCodeEnvToArmsRumEnv` / `ZCODE_ARMS_RUM_ENDPOINT`（**含 checked-in 产物**，整文件待删） |
| `packages/client/src/globals.d.ts:215-225,40` | `reportTelemetryEvent` / `getRendererActionTraceConfig` / `onRendererActionTraceConfigChanged` / `reportRendererActionTraceBatch`（`RendererHeapSample` 保留） |

### 2.3 s11 — UI / services / rpc 侧

| 文件 | 断链符号 |
|---|---|
| `packages/services/src/telemetry/telemetryCore.ts:6-7,10,368,392,410-411` | `ZCODE_TELEMETRY_ENABLED` / `ZCODE_TELEMETRY_REPORT_ENDPOINT` / `sanitizeTelemetryEventDetail`（整目录待删） |
| `packages/services/src/node.ts:520,2208` | `getCapturedZCodeAgentTelemetryEnv` |
| `packages/services/src/zcode-agent/zcodeAgent.ts:21,718` | `ZCodeMcpTelemetryEvent` / `onDynamicMcpTelemetry` |
| `packages/services/src/zcode-agent/zcodeAgentService.ts:3,76,110,1128,1920-1923,2005-2008,3202,3217,5080,5479,5610` | `localTtftFactsSchema` / `LocalTtftFacts` / `zcodeMcpTelemetryEventSchema` / `ZCodeMcpTelemetryEvent` / `zcodeProtocolNotifications.mcpTelemetry` / `V4_NOTIFICATIONS.localTtftFacts` / `envelope.ttft`；**`onDynamicConversationTelemetryFact`（turn 事实链）必须保留** |
| `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts` | `localTtft*` |
| `packages/ui/src/index.ts:107` | `LocalTtftObserver` / `setLocalTtftObserver`（UI 侧自有文件，文件名保留但整目录随 Step 11 删） |
| `packages/ui/src/lib/appTelemetry.ts:4-7,34,52-63` | `collectTelemetryRendererContext` / `sanitizeTelemetryEventDetail` / `reportTelemetryEvent` |
| `packages/ui/src/lib/automationTelemetry.ts:4,15,69` | `sanitizeTelemetryErrorMessage` / `reportTelemetryEvent` |
| `packages/ui/src/lib/chatErrorBannerTelemetry.ts:2-3,129,162,173,185` | `resolveTelemetryModelId` / `resolveTelemetryProviderScope` / `reportArmsCustomEvent` |
| `packages/ui/src/lib/planUsageArmsTelemetry.ts` / `reactErrorArmsTelemetry.ts` / `uiPerfArmsTelemetry.ts` / `sendFunnelArmsTelemetry.ts` / `sessionOpenArmsTelemetry.ts` | `sanitizeTelemetryModelValue` / `resolveTelemetry*` / `redactTelemetryText` / `reportArmsCustomEvent` |
| `packages/ui/src/lib/promptTemplateTelemetry.ts:30` / `offPeakTelemetry.ts:21` / `codingPlanFunnelTelemetry.ts:46` / `sessionCreateTelemetry.ts:22` | `reportTelemetryEvent`（注意 spec Step 11 的 5 处 await/return） |
| `packages/ui/src/lib/userActionTelemetry.ts:9-261` | `RENDERER_ACTION_TRACE_MAX_BATCH_BYTES` / `RENDERER_ACTION_TRACE_MAX_BATCH_SPANS` |
| `packages/ui/src/hooks/useOAuth.ts:12,102` | `resolveSafeTelemetryHostname` |
| `packages/ui/src/v4/agentConversationTransport.ts:3,100-148,536-609` | `calibrateLocalTtftClock` / `localTtftNow` / `frame.ttft` / `frame.ttftRelated` / `result.clock` / `onDynamicLocalTtftFacts` |
| `packages/ui/src/v4/ConversationComposer.tsx` / `SessionPane.tsx` | `LocalTtft*`（16 + 11 处） |
| `packages/ui/src/v4/telemetry/{localTtftFacts,localTtftObserver,localTtftRecord,conversationTelemetrySupervisor}.ts` | 整批删 |
| `packages/ui/src/v4/workspaceConnectionRegistry.ts` | `localTtft*` |
| `packages/ui/src/{onboarding/useOnboardingTelemetry.ts, root/useRootOAuthEffects.ts, Root.tsx}` | `reportTelemetryEvent` / `reportArmsCustomEvent` |
| `packages/web/src/main.tsx:264-265` | `reportTelemetryEvent` / `reportArmsCustomEvent` 空实现（web 无 typecheck 门禁，需手工删） |
| `packages/rpc/src/network-telemetry-middleware.ts` | 整删（`NetworkObservation` / `NetworkTelemetrySink` / `emitNetworkTelemetryObservation`） |

---

## 3. 下游必须保留的链路（D-8，防误删）

| 链路 | 位置 |
|---|---|
| `conversationTelemetryFact` transport 名 `"v4/telemetry/event"` | `shared/src/zcode-protocol-v4/transport.ts` |
| host emitter → services 转发 → `onDynamicConversationTelemetryFact` | `bootstrap/src/zcode-protocol-v4/v4-gateway.ts`、`bootstrap/src/zcode-protocol/v4-bridge.ts`、`services/src/zcode-agent/zcodeAgentService.ts` |
| `taskActivityTracker`（用 `turn.started` / `turn.terminal` 算运行中任务数） | `zcode-server-cli/src/server-core/taskActivityTracker.ts` |

---

## 4. 与 spec 清单的偏差（**需 s13 回归时确认**）

### 4.1 `ReportRendererHeapSample` **保留**（spec Step 6 的「11 个 channel」清单要求删）

- spec 变更点清单（`spec.md:163`）把 `ReportRendererHeapSample` 算进 11 个遥测 channel。
- 实际链路：`renderer` 每 60s 读 `performance.memory` → preload 单向 send → main 的
  `processResourceRendererHeapSource.ts` 暂存 → `processResourceSampleSourceRegistry.ts:12,21`
  注册为本地资源管理器采样源，产出 `renderer_main` 角色的 `heap_used_kb_mean/peak`。
  **落点是本机资源管理器，不出网。**
- 判据：spec「必须保留（防误删清单）」含「本地资源管理器共用文件」，且 `shared/src/processResourceTelemetry.ts`
  本就不在删除清单内；`HostResourceSample` 同理保留。
- 处置：保留 channel / `RendererHeapSample` / `rendererHeapSampleSchema` / `reportRendererHeapSample`，
  并在代码里就地注释了理由。若 Step 13 判定必须删，s9 需连带删
  `processResourceRendererHeapSource.ts` 并从 registry 摘除。

### 4.2 `zcodeMcpTelemetry*Schema` **部分保留**

- `zcodeMcpTelemetryPlatformSchema` / `zcodeMcpTelemetryArchSchema` / `zcodeMcpProcessTelemetryBaseShape`
  被**保留**的资源 schema 复用（`zcodeMcpResourceSampleSchema:460,469-470`、
  `zcodeToolExecResourceSchema:487`），删除会连带打断资源采样链。
- 仅删除：`zcodeMcpTelemetryBaseSchema`、`zcodeMcpTelemetryEventSchema`、`ZCodeMcpTelemetryEvent`、
  通知名 `zcodeProtocolNotifications.mcpTelemetry`。
- 下游 `adapters/src/mcp/telemetry.ts:76,80,107,109` 的 `ZCodeMcpTelemetryEvent["arch"|"platform"]`
  索引访问点**不会自动报红**（类型变成 `any`/未解析），s7 需改为直接用 `NodeJS.Architecture` /
  `NodeJS.Platform` 或本地枚举，**别只靠 typecheck 兜底**。

### 4.3 清单外补充删除（因 `telemetry.ts` 整删而被迫连带）

| 符号 | 理由 |
|---|---|
| `ReadFinalArmsCustomEventsE2E` / `ClearFinalArmsCustomEventsE2E` / `ConfigureFinalArmsCustomEventsE2E` | payload 类型定义在已删的 `telemetry.ts` |
| `validation.ts` 的 `telemetryRendererContextSchema` / `rendererTelemetryEventPayloadSchema` / `armsCustomEventPayloadSchema` | 唯一消费者是 `desktopMainIpcRemote.ts` 的已删 IPC handler；无 shared 内消费者 |
| `validation.ts` 的 `networkObservationSchema` | 唯一消费者是已删的 `hostNetworkTelemetryBatchResponseSchema` |
| `commandEnvelopeSchema.ttft` / `commandsQueryResultSchema.clock` | schema 定义在已删的 `localTtft.ts`（`command.ts:324/:479`） |
| `conversationTopicFrameSchema.ttft` / `.ttftRelated` | 同上（`transport.ts:196-197`） |

> ⚠ `commandsQueryResultSchema` 是 `.strict()`：删 `clock` 后，**仍在返回 `clock` 的旧 host 会被整条拒掉**。
> s7 改 host 侧产出时必须同批，否则 `v4/commands/query` 结果解析失败。

---

## 5. 复现命令

```bat
set "PATH=D:\Dev\Js\oh-my-zcode\omz\node_modules\.bin;D:\Dev\Js\oh-my-zcode\.tools\node-v24.14.0-win-x64;%PATH%"
cd /d D:\Dev\Js\oh-my-zcode\omz
tsc -p packages/shared/tsconfig.json --noEmit
```

`packages/shared` 自身零错误；全仓红是**预期**（后续波次范围）。
