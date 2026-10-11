---
轮次: 1
取证域: A — Phase 0/1/3（遥测、构建、品牌）
被审文档: docs/iterations/oh-my-zcode-fork/spec.md
对照代码库: D:\Dev\Js\oh-my-zcode\.reference\ZCode
git HEAD: 29628c9acdb81b703bbd4080c207a0e7ce5e276e
日期: 2026-10-03
子代理角色: evidence 取证（不下结论、不给 Go/No-Go）
---

# 取证域 A 证据包：遥测移除 / 构建基线 / 品牌改名

## 0. 计数汇总

| 判定 | 条数 |
|---|---|
| 一致 | 30 |
| 不一致（差异） | 7 |
| 部分一致 / 口径需澄清 | 5 |
| 无法核实 | 3 |

---

## 1. Phase 0 构建基线（Step 1-5）

| # | spec 位置 | 可证伪断言 | 判定 | 证据（路径:行号） |
|---|---|---|---|---|
| A1 | Step 2 | `mise install`（Node 24.14.0 / pnpm 10.33.2） | 一致 | `mise.toml:2-3` `node = "24.14.0"` / `pnpm = "10.33.2"` |
| A2 | Step 1 | `scripts/bootstrap.mjs:161` 是 submodule 行 | 一致 | `scripts/bootstrap.mjs:161` = `runGit(["submodule","update","--init","--recursive","apps/zcode-cli"]);`（全文件唯一 submodule 命中） |
| A3 | Step 1 | `apps/zcode-cli/packages/superpowers-plugin` 是死目录 | 一致 | 目录下仅 `LICENSE` 一个文件，无 package.json / src |
| A4 | Step 1 | `apps/zcode-cli/pnpm-lock.yaml` 是遗留锁文件 | 一致 | 文件存在；生效锁为根 `pnpm-lock.yaml` |
| A5 | Step 4 / R10 | `browser-use-plugin` 残缺且不在 CLI 闭包 | 一致 | `apps/zcode-cli/packages/cli/package.json` 的 workspace 依赖仅 adapters/bootstrap/contracts/core/dynamic-workflow-runtime/i18n/provider-node/shared/shared-types/tui，**不含 browser-use-plugin**；该包 `src/` 仅 1 文件（`browser-client.ts`）、`skills/` 2 个 SKILL.md |
| A6 | Step 3 | 「turbo build（`--filter=!@zcode/cli --force`）」 | **不一致** | 仓库无根 `turbo.json`；turbo 仅在 `apps/zcode-cli/package.json` 中，脚本为 `"build": "turbo run build"`、`"cli:build": "pnpm --filter @zcode/cli build"`。`--filter`/`--force` 是 pnpm 旗标不是 turbo 旗标，仓库内无 `--force` 用法。根 `package.json` 的 `build` 是 `pnpm -r build`（非 turbo） |
| A7 | Step 5 / D-4 | `pnpm build:sea` 存在；新包自动进 turbo `^build` 闭包 | 一致 | 根 `package.json` scripts `build:sea` / `build:sea:all`；`apps/zcode-cli/turbo.json` tasks.build `dependsOn: ["^build"]` |
| A8 | D-1 | CLI 构建闭包只依赖根 workspace `shared/provider/provider-node/model-option-map/zcode-cua` 5 包 | 一致 | workspace 依赖图求闭包：cli→{adapters,bootstrap,contracts,core,dynamic-workflow-runtime,i18n,provider-node,shared,shared-types,tui}→根包 {shared, model-option-map, provider, provider-node, zcode-cua}，恰好 5 个 |
| A9 | D-1 / Step 10 / R1 | desktop 无类型门禁：根 typecheck 只覆盖 `tsconfig.host.json` | 一致 | 根 `package.json` `typecheck` 末位为 `packages/desktop/tsconfig.host.json`；`packages/desktop/tsconfig.host.json` `include: ["src/host"]`；`tsconfig.main.json` / `tsconfig.preload.json` / `tsconfig.renderer.json` / `tsconfig.scheduler.json` 均不在根 typecheck 链上 |
| A10 | Phase 3 | `scripts/check-workspace-freshness.mjs` 存在 | 一致 | 文件存在 |
| A11 | Step 13 / T-T2 | 三套 typecheck + lint + knip 全绿可行 | 无法核实 | 需执行构建，静态不可判定 |

---

## 2. Phase 1 遥测移除（Step 6-13 / D-8 / D-9 / R1 / R2 / T-B*/T-T*）

### 2.1 env / runtimeEnv

| # | spec 位置 | 可证伪断言 | 判定 | 证据 |
|---|---|---|---|---|
| A12 | 修改项 `shared/src/env.ts` | 删 `ZCODE_TELEMETRY_ENABLED` 等 5 项、保留 `normalizeZCodeEnv`/`ZCODE_ENV`/`ZCODE_PRODUCT_FLAVOR` | 一致 | `packages/shared/src/env.ts:6` `ArmsRumEnv`、`:50` `ZCODE_TELEMETRY_ENABLED: boolean = true`、`:53-54` `ZCODE_TELEMETRY_REPORT_ENDPOINT`、`:57-58` `ZCODE_ARMS_RUM_ENDPOINT`、`:61-63` `mapZCodeEnvToArmsRumEnv`；`:12-18`/`:25-39` 为保留项。`packages/shared/src/index.ts:33,68-71` 为再出口点（spec 未列 index.ts:68-71 的再出口清理） |
| A13 | Step 6 / 修改项 runtimeEnv | `SANITIZED_RUNTIME_ENV_KEYS` 中 **14** 个遥测键需保留剔除 | **不一致** | `packages/shared/src/runtimeEnv.ts:75-93` 共 **17** 个遥测键：OTEL×9（75-83）+ `ZCODE_MODEL_TELEMETRY_ENABLED`(84) + `ZCODE_TELEMETRY_DEVICE_MID`(85) + `ZCODE_TELEMETRY_*`×6（88-93）。计数口径需修正为 17 |
| A14 | Step 6 / 修改项 runtimeEnv | 删捕获侧 **6 个函数** | **不一致** | 实为 **5 个函数 + 1 个模块级 record**：`captureZCodeAgentTelemetryEnv`(:167)、`readZCodeAgentTelemetryEnv`(:175)、`getCapturedZCodeAgentTelemetryEnv`(:187)、`resetCapturedZCodeAgentTelemetryEnvForTest`(:206)、`isZCodeAgentTelemetryEnvKey`(:278)，加 `const capturedZCodeAgentTelemetryEnv`(:138)。另需处理调用点 `:168, :216, :270` |
| A15 | Step 6 | 捕获侧仅被 telemetry bootstrap 消费 | 一致 | `getCapturedZCodeAgentTelemetryEnv` 无其他消费者；`ZCODE_TELEMETRY_ENABLED` 本身**不在** sanitize 名单中（env.ts:50 硬编码 true，与运行时 env 无关） |

### 2.2 IPC channel / 出口

| # | spec 位置 | 可证伪断言 | 判定 | 证据 |
|---|---|---|---|---|
| A16 | 修改项 channels/platform | 删 **9** 个遥测 IPC channel，**保留 `GetDeviceId`** | **不一致** | `GetDeviceId` 确认：`packages/shared/src/channels.ts:428`。遥测 channel 实为 **11** 个：`zcode:` 前缀 8 个（`:318 SyncTelemetryContext`、`:320 ReportTelemetryEvent`、`:322 ReportArmsCustomEvent`、`:324 GetRendererActionTraceConfig`、`:326 RendererActionTraceConfigChanged`、`:328 ReportRendererActionTraceBatch`、`:330 ReportRendererHeapSample`、`:331 ReportLocalTtftBatch`）+ 3 个方法名式（`:596 McpTelemetry`、`:600 SessionCreateTelemetry`、`:658 NetworkTelemetryBatch`）。计数需修正 |
| A17 | D-8 / 防误删清单 | `conversationTelemetryFact` v4 notification + schema + host emitter + `turn.started`/`turn.terminal` 事实保留 | 一致 | schema：`packages/shared/src/zcode-protocol-v4/telemetry.ts:263,310-322`；transport 方法名 `:411` `"v4/telemetry/event"`；host emitter：`bootstrap/src/zcode-protocol-v4/v4-gateway.ts:229,623,794` + `zcode-protocol/v4-bridge.ts:1487-1489`；services 转发：`zcodeAgentService.ts:1136,1579-1584,2014-2017,5483-5484` |
| A18 | D-8 / R2 / T-T5 | `taskActivityTracker` 用 turn 事实算「运行中任务数」，整删会静默恒 0 | 一致 | `packages/zcode-server-cli/src/server-core/taskActivityTracker.ts:58` `turn.started`→add、`:60` `turn.terminal`→delete、`:77` 订阅 `onDynamicConversationTelemetryFact`；`:39` 用 `activeSessionIds.size` 求和 |
| A19 | Phase 1 整删（根） | `services/src/conversation-telemetry/` 可整删而不破坏 D-8 | 一致 | 全仓仅 `packages/services/src/index.ts:55` 再出口，无业务消费者；`taskActivityTracker` 走 `services.getOptional(IZCodeAgentService)`（`zcode-server-cli/src/server-core/core.ts:44`）而非该目录 |
| A20 | Step 11 | UI supervisor 族与 ~80 调用点（fire-and-forget 已核实） | **不一致** | `reportAppTelemetryEvent` 定义于 `packages/ui/src/lib/appTelemetry.ts:36`，返回 `Promise` 并 `await platform.reportTelemetryEvent`（`:63`）。调用点中 **`void` fire-and-forget 仅 6 处**（`useOAuth.ts:94`、`codingPlanFunnelTelemetry.ts:175`、`useOnboardingTelemetry.ts:66,109`、`useRootOAuthEffects.ts:78`、`useRootWorkspaceActions.ts:315`、`ConversationRowView.tsx:1380`），另 **5 处 await / return**（`automationTelemetry.ts:112,142`、`offPeakTelemetry.ts:74`、`promptTemplateTelemetry.ts:33`、`sessionCreateTelemetry.ts:34`、`oauthActions.ts:11`）。「fire-and-forget 已核实」不成立 |
| A21 | Step 11 / T-M9 | `ui/src/v4/telemetry/` 可整体视为「supervisor 族」删除 | **不一致** | `packages/ui/src/v4/telemetry/ConversationTelemetryAttachment.tsx` 是**业务接线层**（React Context provider），被 5 个业务文件消费：`Root.tsx:83-85,180,597`（`disposeConversationTelemetrySupervisors` / `reconcileConversationTelemetryWorkspaceScopes`）、`root/RootWorkspaceContent.tsx:10,124,178`、`v4/V4ConversationContext.tsx:43,352,356`、`v4/ConversationComposer.tsx:167,542`（`useScopedConversationTelemetrySupervisor`）、`v4/SessionPane.tsx:216-218,568,573`（supervisor + foregroundEnabled）。整目录删除会打断 UI 装配链，与 D-8 保留事实通道自相矛盾 |
| A22 | D-2 | 数仓出网唯一出口是 `telemetryCore` | 一致 | `ZCODE_TELEMETRY_REPORT_ENDPOINT` 全仓唯一消费者是 `packages/services/src/telemetry/telemetryCore.ts:7,368,410-411`（HTTP 实现为 `packages/desktop/src/main/desktopTelemetryFetch.ts`）；`createTelemetryCore` 唯一实例化 `packages/desktop/src/main/index.ts:728` |
| A23 | Phase 1 整删（根） | `services/src/telemetry/`、`services/src/zcode-agent/agentTelemetryEnv.ts` 整删 | 一致 | `packages/services/src/telemetry/` 仅 `telemetryCore.ts`；`agentTelemetryEnv.ts` 存在，仅被 `packages/services/src/node.ts:347` 导入（`buildAgentTelemetrySpawnEnv`） |

### 2.3 core / bootstrap 接线

| # | spec 位置 | 可证伪断言 | 判定 | 证据 |
|---|---|---|---|---|
| A24 | 整删（CLI 侧） | `core/src/telemetry/runtime-telemetry.ts`、`contracts/src/telemetry/{agent-execution,index}.ts` | 一致 | 路径确认。`contracts/src/telemetry/agent-execution.ts:277-285` 定义 `AgentExecutionTelemetryPort`；`:1` 还从 `../compact/index.js` 导入 `CompactPhase`/`CompactTrigger`（遥测↔压缩交叉依赖，D-7 与 D-1 需同批处理） |
| A25 | 关键插入点 / D-8 | `RuntimeTelemetryFacade` 默认降级为 NOOP | 一致 | `core/src/telemetry/runtime-telemetry.ts:46` `options.port ?? NOOP_AGENT_EXECUTION_TELEMETRY`，`:220-240` NOOP 实现 |
| A26 | 修改项 core | `agentTelemetry?` 三处可选字段：runtime/types.ts:310、tool/executor/types.ts:76,182 | 一致 | 逐行命中。相邻还有 `agentTelemetryCausation`/`agentTelemetryCausationMode`（runtime/types.ts:311-312）与 `agentTelemetryActorKind`（executor/types.ts:77,183），spec 未列 |
| A27 | 修改项 create-app | 删 `createModelTelemetry`（:27/:192-195）、4 处 `agentTelemetry`（:558/:628/:727/:825）、`statusSink`（:536/:539-540） | 一致 | `bootstrap/src/app/create-app.ts:27` import、`:192` 调用、`:536`、`:539-540`、`:558`、`:628`、`:727`、`:825` 全部精确命中 |
| A28 | 修改项 core | 「12 个 methods 文件的 `this.agentTelemetry.*` 调用删除」 | **不一致** | `runtime/methods/` 内含 `this.agentTelemetry` 的文件为 **9 个**（compact-active.ts、goal-summary-title.ts、model.ts、session-title.ts、subagent.ts、title-generation-sidecar.ts、turn-model-step.ts、turn.ts、workspace-generate-text.ts）；加 `runtime/agent-runtime.ts` 共 10。`runtime/methods/target-completion-verification-telemetry.ts` 整删。计数需修正 |
| A29 | 修改项 bootstrap | `workflow-facade.ts` / `script-workflow-child-runtime.ts` 删必填 `agentTelemetry` | 一致 | 两文件均在 `git grep -l agentTelemetry` 命中列表内 |
| A30 | 修改项 adapters | `adapters/src/model/runner*.ts` 删 `publishModelTelemetryMilestone` | 无法核实 | 未逐文件确认符号存在性 |
| A31 | 修改项 adapters | `adapters/src/mcp/telemetry.ts` 保留 tracker/`listProcesses`/`sampleNow`，删 `onEvent`/`emit` | 一致 | `mcp/telemetry.ts:69 listProcesses`、`:70/:291 sampleNow`、`:79 onEvent`、`:112 emit` |

### 2.4 desktop（Step 9 / D-9 / R1）

| # | spec 位置 | 可证伪断言 | 判定 | 证据 |
|---|---|---|---|---|
| A32 | 整删（根） | `desktop/src/main/` 下 ARMS 族 ~30 文件 | 部分一致 | 以 arms/rum/telemetry/trace/crash/heap/ttft/otlp 为模式匹配 `packages/desktop/src/main/` 得 **25** 个文件（含 index.ts、processResource* 共用文件、desktopRemoteSessions/desktopMainIpcRemote 等非 ARMS 文件）。真实纯遥测文件约 18 个；「~30」与「共用文件已剔除后」两个口径都不精确 |
| A33 | 整删（根） | `desktop/src/shared/armsRum*` **5** 个文件 | **不一致** | 实为 **6** 个：`armsRumBridgeForward.ts`、`armsRumShared.ts`、`armsRumShared.d.ts`、`armsRumShared.d.ts.map`、`armsRumShared.js`、`armsRumShared.js.map` |
| A34 | 修改项 | desktop `package.json` 删 **7** 条依赖 | 一致 | `@arms/rum-electron ^0.0.3` + `@opentelemetry/api`、`exporter-metrics-otlp-proto`、`exporter-trace-otlp-proto`、`resources`、`sdk-metrics`、`sdk-trace-base` = 7 |
| A35 | 修改项 | `electron-builder.config.js:112-120` 与 `scripts/bundle.mjs:91-97` 删闭包项 | 部分一致 | builder 闭包 OTel 项在 `:112 @opentelemetry/api-logs`、`:116 sdk-metrics`、`:119/:120` 两个 otlp-proto exporter（落在 112-120 内 ✓）。**但 `bundle.mjs:101 "@babel/runtime"` 专为 `@arms/rum-core`（见 :97-100 注释）注入，位于 spec 标称的 91-97 之外，未被覆盖**；同时 `desktop/package.json:31` 也直接依赖 `@babel/runtime`，需单独判定去留 |
| A36 | 修改项 | `desktop/tsconfig.preload.json:8` 删 include | 一致 | `:8 "include": ["src/preload", "src/shared/armsRumBridgeForward.ts"]` |
| A37 | 修改项 desktop/src/main/index.ts | 删装配块 :728-752、:809-834、:1023-1028、:1049-1053、:2161-2200、:2203-2249、:1721-1729 | 一致 | 逐块核对：`:728-734 createTelemetryCore`、`:735-738 appTelemetryRuntime`、`:740-752 reportRemoteUsageEventForRenderer`；`:809-836 rendererActionTraceRollout/localTtftExporter/ReportLocalTtftBatch/rendererActionTraceBroker/armsUserIdentitySync`；`:1023-1028 stop*Telemetry/dispose*`；`:1050-1054 flush/shutdown`；`:1721-1729 report*ToArms + appTelemetryCore.reportEvent`；`:2161-2166 registerRendererActionTraceIpc`、`:2168-2176 registerRemoteIpcHandlers 传 appTelemetryRuntime/appTelemetryCore/armsCustomContext`；`:2203-2249` ARMS/trace 注册块 |
| A38 | Step 12 / T-T3 | `third-party/npm-overrides.json` 删 3 条 `@arms/rum-*`；root `package.json` 删 patch | 一致 | overrides 3 条：`@arms/rum-browser@0.1.8`(:488)、`@arms/rum-core@0.1.4`(:496)、`@arms/rum-electron@0.0.3`(:504)；`patches/@arms__rum-electron@0.0.3.patch` 存在 |
| A39 | Step 12 | `generate-third-party-notices.mjs` 无 CLI 参数，导出 `generateThirdPartyNotices(root)` | 一致 | `scripts/generate-third-party-notices.mjs:10` 唯一导出，脚本内无 `process.argv` 解析。**实际调用入口是 `node scripts/licenses.mjs notices`**（`scripts/licenses.mjs:26-30`）；该脚本未挂进任何 `package.json` scripts（根/子包均无 `licenses` 脚本），需手工执行 |
| A40 | Step 12 / Step 34 | `NOTICE.md` 改写 :37/:40/:49/:62 | 部分一致 | 四行均存在。`:37`「提供设备标识、账号标识」、`:40`「帮助配置请求还可携带设备标识」、`:49`「携带平台、渠道、设备等信息」——这三处绑定的是 **deviceMid**，而 spec 把 deviceMid 列入「必须保留」清单（不改）；真正对应 D-9 崩溃采集全删的只有 `:62`（日志与崩溃记录）。改写范围与 D-2/D-9 存在冲突 |
| A41 | 防误删清单 | `deviceMid` 4 份实现 + `telemetry-state.json` 文件名保留 | 一致 | 4 份实现：`adapters/src/device/cli-device-mid.ts`（:60 路径）、`packages/desktop/src/main/desktopDeviceMid.ts`（:34）、`packages/server/src/stdioDeviceMid.ts`、`packages/services/src/device/deviceMid.ts`（:25/:27）。`telemetry-state.json` 另有 `packages/services/src/telemetry/telemetryCore.ts:130,132`、`packages/services/src/providers/sourceHeaders.ts:42`、`apps/zcode-cli/packages/telemetry/src/bootstrap.ts:227-228`（随整删消失） |
| A42 | Phase 3 | bin 名在 `apps/zcode-cli/packages/cli/package.json` | 一致 | `:7 "zcode": "./dist/zcode.cjs"`（`bin` 单键） |
| A43 | Phase 3 | `DEFAULT_BASE_DIR` = `~/.zcode/cli`；`getDefaultSessionDbPath` 存在 | 一致 | `adapters/src/config/file-config.adapter.ts:62` `const DEFAULT_BASE_DIR = "~/.zcode/cli"`（:81、:444 使用）；`adapters/src/storage/session-store/paths.ts:6` 定义，`:sqlite-session-store.ts:239` 默认值，`:1022` 再出口 |
| A44 | Phase 3 / D-10 | marketplace 两份硬编码清单 `shared/src/plugin-marketplaces.ts:13-30` 与 `bootstrap/src/app/official-plugin-definitions.ts:89-364` | 一致 | 逐行命中；两份清单的机械对照约束写在 `plugin-marketplaces.ts:28-29` 与 `official-plugin-definitions.ts:333`。另有 `shared/src/plugin-marketplaces.ts:10` `ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "zcode-plugins-official"`、`:37` CDN source |

---

## 3. Phase 3 品牌（D-10）

| # | spec 位置 | 可证伪断言 | 判定 | 证据 |
|---|---|---|---|---|
| A45 | D-10 L2 不改 | `ZCODE_*` env 前缀 / `.zcode-plugin/` 目录名保留 | 一致 | `packages/shared/src/env.ts` 全量 `ZCODE_*` 常量；`apps/zcode-cli/packages/browser-use-plugin/.zcode-plugin/plugin.json` 存在 |
| A46 | D-2 | 端点集中在 `packages/shared/src/zcodeEndpoint.ts` | 一致 | 文件存在；`telemetryCore.ts:411` 通过 `resolveZCodeEndpointOrigin` 取端点 |
| A47 | Step 12 | `.architecture-baseline.json` + `pnpm architecture:baseline:update` 存在 | 一致 | 根目录 `.architecture-baseline.json`；根 scripts `architecture:baseline:update` |
| A48 | Phase 3 | 数据目录 `~/.zcode` → `~/.omz` 需新起不迁移 | 一致 | 磁盘路径硬编码点：`adapters/src/device/cli-device-mid.ts:60`、`packages/services/src/device/deviceMid.ts:25,27`、`packages/services/src/telemetry/telemetryCore.ts:130`、`adapters/src/config/file-config.adapter.ts:62`、`mise.toml` 的 `ZCODE_DATA_BASE_DIR` |

---

## 4. 可疑点清单（域 A）

1. **`ui/src/v4/telemetry/ConversationTelemetryAttachment.tsx` 不是 reporter**（高）。它是 React Context 装配层，被 `Root.tsx`、`RootWorkspaceContent.tsx`、`V4ConversationContext.tsx`、`ConversationComposer.tsx`、`SessionPane.tsx` 五个业务文件消费。spec Step 11 的「删 UI supervisor 族」若按目录执行，会打断 D-8 要求保留的事实通道装配。需明确「保留 attachment 层 + 删 supervisor 本体」的切法。
2. **`bundle.mjs:101 "@babel/runtime"` 挂在 `@arms/rum-core` 专属注脚下**（高）。落在 spec 标称闭包区间 91-97 之外；`desktop/package.json:31` 也把它列为直接依赖。删除 ARMS 后是否保留此依赖与闭包项，spec 未决。
3. **`NOTICE.md` 改写范围与 deviceMid 保留冲突**（中）。:37/:40/:49 描述的是设备标识，而 deviceMid 在「必须保留」清单内。
4. **`licenses.mjs` 无 npm script 入口**（中）。Step 12 的「重生成 THIRD-PARTY-NOTICES」缺可执行命令；T-T3 的验证点依赖手工执行 `node scripts/licenses.mjs notices`。
5. **`reportAppTelemetryEvent` 并非全 fire-and-forget**（中）。5 处 await / return 会把 IPC 失败传播给调用方，Step 11 的「fire-and-forget 已核实」结论不成立。
6. **`shared/src/index.ts:33,68-71` 的再出口**（低）。spec 只列 env.ts 侧的删除，未列 shared barrel 的再出口清理。
7. **`packages/desktop/src/main/` 还有 spec 未列的遥测文件**（中）：`appTelemetryRuntime.ts`、`desktopTelemetryFetch.ts`、`startupTelemetryDelivery.ts`、`crashDumpAnnotations.ts`、`processResourceMcpTelemetrySource.ts`、`zcodeDataSizeTelemetryState.ts`、`localTtftExportDedupe.ts`（+ `renderer/src/localTtftBootstrap.ts`）。
8. **`localTtft*` 计数口径不明**（低）。`packages/desktop/src/main/` 内 3 个，全仓 8 个（含 shared/ui/renderer），spec 写「5 文件」与两种口径都不吻合。
9. **`contracts/src/telemetry/agent-execution.ts:1` 反向依赖 `../compact/index.js`**（中）。遥测整删与压缩整删必须同批，否则留下悬空类型引用。

## 5. 未核实项（域 A）

- A11 / T-T2：三套 typecheck + lint + knip 实际是否可全绿（需执行）。
- A30：`adapters/src/model/runner*.ts` 中 `publishModelTelemetryMilestone` 的确切分布（未逐文件核对）。
- T-T4「真机抓包零遥测出网」：静态不可判定；另需注意 D-2 保留的官方端点（登录/计费/市场 CDN）与 `deviceMid` 相关的 `Anthropic-Compat` 请求头会持续出网，白名单需在 Step 13 明确。
- `desktop/src/main/index.ts` 各装配块删除后的**运行时**断链（无类型门禁，需 Step 10 补 `typecheck:desktop-full` 后实测）。
