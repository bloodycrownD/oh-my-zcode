---
date: 2026-10-03
---

# oh-my-zcode（ZCode fork）改造技术规格（SPEC）

## 执行状态与勘误注记（2026-10-05 · spec-check-loop 收敛后追加）

> 本节由 spec-check-loop v0.1.0 轮（cache/speccheck-v010-r1.md，手工审查）追加；正文保持撰写时原样（历史计划文档定位），事实性偏差以本节与行内【勘误/执行注记】承载。

- **步骤完成矩阵**：S1-S30、S32-S35 已完成（34/35）；**S31（Batch 2）推迟待排期**（spec 标记 blocking:no）。tag 链：`baseline/v3.14.3` → `phase1/telemetry-removed` → `phase1/cr-fixed` → `phase2a/magic-context-mvp` → `phase2b/compact-removed` → `v0.1.0`（v0.1.0 曾指向 27b7109，因分发缺包 blocker 重指 aba59a9，已登记）。
- **待执行修复**：CR v0.1.0 全量评审（1fa2d0e→aba59a9）产出 `cr-fix-spec-v0.1.0.md`（33 条：P0×2/P1×8/P2×23），**尚未执行**。其中 MF-01 对应本 spec 契约 8——**代码未实现 `effective = features && enabled`，方向为代码修回 spec，本 spec 该契约不改**。
- **验收矩阵现状**：T-M1..T-M12、T-U1、T-P1 已过（证据在各 phase 报告，cache/）；T-B1/T-B2 与 T-T1..T-T5 已随各阶段门禁执行；T-U2 与 T-P2 的 manual 部分留待实机；T-P2 自动部分（含 CDN 别名）经 CR 发现验收结论失实，随 cr-fix-spec MF-02 修复后复验。
- **行号引用说明**：正文中的 `路径:行号` 为撰写时锚点，实现期多处漂移——**执行/重放一律以符号名为准**（CR 各评审文件含漂移勘误）。
- **已登记偏离**：全部收录在 `docs/.iteration-state.yaml`（phase2a/phase2b/phase3 节），共 30+ 条（含 s16 schema 落位、s18 批次边界、s26 八项、s27 甄别、s32 双轨、s34 MIT 纠正等）。
- **SEA 豁免**：EXEMPT-2a（`--all` 跨平台解包，host-only）与 EXEMPT-2b（SEA 运行时需显式路径加载层——加载点计数以 cr-fix-spec MF-30 登记口径为准：产物实测 5 静态 require + 2 动态 import；建议 v0.1.1）——S35 的 build:sea 验收按此口径理解为"资产面验证"。
- **已收窄确认（fix-spec 执行期）**：①S29 设置页为内联实现（含竞态版本号），功能与 T-U1 等价，不另抽专用 hook；②`/compact` 用户可见命令面移除随 D-7 确认（T-M9 即目标行为）；③`historian.*` 与 `language` 不参与热生效——E 组热更新白名单是 pass 级字段集（阈值/预算类），historian host 属装配期构造，改 historian 配置需重启（cr-fix-spec 评审裁定，非缺陷）。
- **DB 解码事实（MF-16 登记）**：会话库 part 解码不做 schema 校验（`codecs.ts` 约定为宽容回落）——升级用户若按首启提示复制旧 `~/.zcode` 数据，含 compaction part 的旧会话表现为「该 part 不渲染」而非报错，属预期（D-7 无兼容层前提）。

## 需求来源

- **来源**：用户口述（2026-10-03 对话），无标准 `prd.md`。
- **原始诉求**：基于 `.reference/ZCode`（zai-org/ZCode v3.14.3 squash 快照，Apache-2.0）fork 出自己的项目 oh-my-zcode，改造点两个：
  1. **彻底移除所有遥测代码**（删代码，不是加开关）；
  2. **把 magic-context（`.reference/magic-context`，cortexkit）的上下文管理能力改为内置功能**，替换/接管 ZCode 原生压缩逻辑。
- **用户追加诉求（2026-10-03 第二轮）**：
  3. magic-context 既然是内置功能，**原生压缩功能直接移除**（不是 flag 互斥保留）；
  4. **UI 配置面**：magic-context 的可调参数（压缩/执行阈值、保护 token、历史预算、historian 模型等）通过桌面 App 设置 UI 配置；压缩相关的 UI 一并调整。
- **用户追加诉求（2026-10-03 第三轮）**：
  5. **完全魔改定位，不考虑旧数据兼容**——fork 首版无存量会话/配置/协议历史包袱，压缩相关的解析侧代码（schema、事件枚举、marker、读取逻辑）与产生侧**一并全删**，不做兼容层。
- **用户已确认的方向判断**：magic-context 需要的宿主钩子（每请求改写消息数组、隐藏子会话、读全量历史）在 ZCode 插件体系（7 个子进程式 hook）中不可表达，改源码后适配反而简单——探索证据确认该判断成立。
- **探索基础**：三轮共 9 个 readonly 探索子代理报告（架构 4 份 + 实现级 4 份 + UI/配置面 1 份），关键证据均以 `路径:行号` 形式内嵌于本文。

## 设计目标

1. 得到一个可构建、可运行、可发布的 oh-my-zcode CLI，**零遥测代码、零遥测依赖**。
2. magic-context 的核心能力（每请求预算化渲染、compartments 分层摘要、§N§ 惰性丢弃、ctx_* 工具）成为 ZCode **进程内内置功能**，是**唯一的上下文管理机制**（原生压缩产生侧代码移除）。
3. magic-context 参数可在桌面 App 设置 UI 中配置，修改后**热生效**（无需重启 CLI）。
4. 保留 ZCode 官方后端（zcode.z.ai 登录 / Coding Plan / 官方插件市场）可用性。
5. 完全魔改定位：**不做旧数据兼容**——压缩功能的产生侧与解析侧代码、schema、事件枚举全量移除；会话存储与协议面按新语义收敛（fork 首版，无存量承诺）。
6. fork 与上游（`.reference/ZCode`）保持可比较性，支持"按版本快照替换 + 重放改造"的同步模式。
7. 每个 Phase 独立可验证、可回滚（git tag）。

## 总体方案

### 关键决策（已按默认拍板，标注 D-x，可推翻）

| # | 决策 | 默认方案 | 理由 / 推翻后果 |
|---|---|---|---|
| D-1 | fork 范围 | **CLI 优先，全仓遥测清理**。CLI 构建闭包只依赖根 workspace 的 `shared/provider/provider-node/model-option-map/zcode-cua` 5 包；desktop/web/server/ui 不在 CLI 闭包内，但其中存在遥测代码，按"移除所有遥测"要求一并清理；UI 配置面（新诉求）在 `packages/ui` 落地 | 只 fork CLI 子树会导致根 typecheck 断链且违背"全删"诉求 |
| D-2 | 后端去留 | **保留 zcode.z.ai 官方后端**（登录、计费、插件市场 CDN）。`deviceMid` 全部 4 份实现保留 | 推翻 = 需自建或砍掉登录/套餐/市场。端点已集中在 `packages/shared/src/zcodeEndpoint.ts`，未来切换成本低 |
| D-3 | magic-context 实现路线 | **TS 移植**（`packages/plugin/src`），不碰 Rust `crates/` | Rust 侧 9 个 path-dep 指向仓库外不存在的目录，不可编译 |
| D-4 | 新包位置 | `apps/zcode-cli/packages/magic-context` | 自动进 turbo `^build` 闭包；放根 `packages/` 不在任何 turbo pipeline 中且缓存不失效 |
| D-5 | 存储 | **独立库** `~/.zcode/cli/db/magic-context.db`（`node:sqlite`，Node 24.14 满足 `Node >= 24` 硬要求），schema 新起 | magic-context 自带 bun/node:sqlite shim（`shared/sqlite.ts`），零 npm 依赖；并入主库会污染 22 条迁移账本 |
| D-6 | 隔离的 historian 执行 | **旁路模型调用**实现 `HiddenCompletionExecutor`（复用 `runCompactSummaryModelRequest` / `generateLiteExtraction` 范式），不 spawn 子会话 | ZCode core 内可直接调模型；OpenCode 版走 SDK HTTP 子会话是宿主限制所致 |
| D-7 | 原生压缩去留（**第三轮修订**） | **产生侧 + 解析侧全量移除，不做旧数据兼容**。删除：`core/src/compact/*`、`runtime/methods/compact*.ts`、`runtime/helpers/compact*.ts`、`contracts/src/compact/`、`SessionEventType` 压缩事件枚举、`part.type:"compaction"` 全部读写、v4 compact 命令/marker/snapshot 字段（含 `autoCompactThresholdTokens`）、`goal-compact.ts`、`/compact` 命令注册、TUI `app-compact-timeline`、`sessionCompact` 旧协议方法、resume/分享的压缩边界处理、压缩相关 i18n key | 用户明确定位完全魔改、无历史数据——解析侧保留的唯一理由（旧会话可打开）不成立；桌面与 CLI 同仓同版发布，无混版解析风险 |
| D-8 | 通道 D（conversationTelemetryFact） | **保留** v4 notification + schema + host emitter + `turn.started`/`turn.terminal` 事实（`taskActivityTracker` 用它算"运行中任务数"），**只删** UI 侧 supervisor/reporter 与 localTtft | 整删会使运行任务统计静默恒为 0 |
| D-9 | 崩溃采集 | ARMS crash 上报**全删**（`desktopCrashCapture.ts` / `appCrashCaptureBootstrap.ts`） | 属遥测。若需保留本地 dump 调试能力，推翻此项 |
| D-10 | 品牌改名分层 | **L1 必改**（bin 名、npm name、README、数据目录、marketplace id、安装产物名）；**L2 暂不改**（`ZCODE_*` env 前缀、`@zcode/*` scope、`.zcode-plugin/` 目录名）；**L3 永不改**（`zcode-protocol*` 协议标识、`zcode-artifact://` URI、DB schema、类型名） | L2/L3 是内部标识符，改动面 2836 文件且徒增上游同步冲突 |
| D-11 | 默认开关（**修订**） | `features.magicContext` 默认 **false** 直至 MVP 验收（T-M1..T-M8）通过；**与 Step 28（压缩移除全量回归）同一变更内翻为 true**——Step 26/27（删压缩代码）期间保持 false，使压缩移除的回归跑在无 transform 态；翻 true 后 off 仅表示"transform 直通、无预算管理"（用户显式退路） | transform 是每请求热路径，需要验收缓冲期；翻 true 与删压缩收尾绑定，避免出现"两者都无"的裸奔默认态 |
| D-12 | magic-context 配置真源与 UI 面（**新增**） | 配置真源 = **`~/.zcode/cli/config.json` 顶层 `magicContext` 域**（不引入独立 `magic-context.jsonc`）；桌面设置页**新增独立分区**（`settingsPageConfig.ts` 注册 + 新建 `MagicContextSettingsSection.tsx`）；热生效三段式（各锚点独立，**不整体仿任何一个先例**——`workspace/updateInteractionPreferences` 只改内存不写盘不推送，不可作整体范式）：① 写盘仿 `file-config.adapter.ts:222 updateUiLocaleInFileConfig`（atomicWriteJson）新增 `updateMagicContextInFileConfig`；② 内存经新 JSON-RPC `workspace/updateMagicContextConfig` handler 内 `configPort.set(ConfigKey.MagicContext, parsed)`；③ 热生效由 `host/config-bridge.ts` 订阅 `ConfigPort.observe(ConfigKey.MagicContext)` bump generation/digest 后 fan-out 到进程内全部 magic-context 实例（session 与 CLI 同进程，无需跨进程推送；**`ConfigPort.observe()` 此前全仓零消费者，本 fork 是首个使用方**） | 插件 userConfig UI（`PluginConfigControls.tsx`）零使用者、仅 6 种标量 type、无热推送——复用反而更贵；独立 jsonc 会重演 locale 三条落盘路径技术债；`config.json` 无 watcher，不加热生效则改配置必须重启 |
| D-13 | 上下文用量 UI（**新增**） | `ChatContextUsage` 面板数据源扩展为 magic-context 预算状态（通过 v4 快照 `usage` 域扩展或新增只读 query `v4/magicContext/status`）；`autoCompactThresholdTokens` 字段**直接删除**（D-7 全删策略，无旧快照包袱） | 用量显示是 magic-context 可观测性的主面板 |

### 架构总览

```
oh-my-zcode/
├─ apps/zcode-cli/packages/
│  ├─ contracts/     # +ctx 工具契约 +magicContext 配置域；-telemetry；-compact（含解析侧 schema 全删）
│  ├─ core/          # turn-loop 插入 transform；-agentTelemetry；-compact 产生侧；+ctx 工具
│  ├─ bootstrap/     # -telemetry 接线；+magic-context 装配 +updateMagicContextConfig handler
│  ├─ adapters/      # -mcp/telemetry 出口；+config schema magicContext 域 + patch 函数
│  ├─ cli/           # +/ctx-* 命令；-/compact 解析
│  ├─ tui/           # -app-compact-timeline；/ctx-status 展示
│  ├─ telemetry/     # 【删除】
│  └─ magic-context/ # 【新建】移植包（core + host 适配层）
├─ packages/
│  ├─ ui/            # +MagicContextSettingsSection；压缩 UI 产生侧清理；用量面板扩展
│  ├─ desktop/ services/ shared/ rpc/ …  # 遥测清理面（同前）
└─ scripts/          # build-zcode/installer 品牌适配
```

**magic-context 内置化数据流**（Phase 2 核心）：

```
turn-loop.ts（每 model step）
  └─ [features.magicContext] mcTransform(requestEntries)   ← 插入点（投影前）
       ├─ 输入: RuntimeMessageEntry[] → 适配层转 MessageLike（{info, parts}）
       ├─ §N§ 标签注入 / pending drop 回放 / heuristics / m[0]/m[1] 注入
       ├─ 输出: 重写后的 entries → 双投影（messages + recordedMessages）自然一致
       └─ 失败分级: fail-closed 重抛 / LKG replay / fail-open 放行
  └─ [Step 26 后] 原 microcompact/autoCompact 调用点已删除
historian（后台，旁路 LLM）
  └─ HiddenCompletionExecutor(ZCode 版) → compartments 落 magic-context.db
ctx_reduce/ctx_expand（内置工具）
  └─ 读写 magic-context.db 的 tags/pending ops → 下一 pass 落地
配置流（D-12）
  设置页 MagicContextSettingsSection
    → zcodeAgentService.updateMagicContextConfig（JSON-RPC）
    → bootstrap handler: updateMagicContextInFileConfig(atomicWrite) + 内存 ConfigPort
       + ConfigPort.observe 订阅 → generation/digest bump（ConfigSnapshot 语义）fan-out 进程内实例
```

### 移植范围（Phase 2 第一批次）

按探索报告的分组（文件均在 `.reference/magic-context/packages/plugin/src/`）：

- **A 组 存储与基础设施（几乎逐字搬）**：`shared/sqlite.ts`（913 行，变量间接动态 import 手法必须保留，防 esbuild 改写 `node:sqlite`）、`shared/data-path.ts`、`shared/{sqlite-helpers,logger,record-type-guard,error-message,stable-json,xml-unescape,format-bytes,storage-permissions,write-transaction-timing,exit-abort-registry,bounded-session-map}.ts`、`features/magic-context/migrations.ts`（新库起，跳过 v85/v87 relabel）、`storage-db.ts`、`storage*.ts`（~30 个，除 `storage-meta-session.ts` 的 opencode.db 分支）、`migration-worker{,-client,-protocol}.ts`。
- **B 组 transform 核心**：`transform.ts`（3287 行）、`transform-postprocess-phase.ts`（3955 行）、`transform-compartment-phase.ts`、`inject-compartments.ts`（4205 行，m[0]/m[1] 全套）、`tag-messages.ts`（§N§ 分配）、`apply-operations.ts`（`[dropped §N§]` 承重，纯函数不可改）、`heuristic-cleanup/emergency-drop/strip-*/reasoning-removal`、`protected-tail-boundary.ts`、`compartment-*` 家族、`lkg-*`、`derive-budgets/decay-*`、`read-session-{chunk,raw,formatting,true-raw-tokens}.ts`、失败分类族。
- **C 组 historian**：`compartment-runner{,-incremental,-historian,-types,-mapping,-partial-recomp,-recomp,-validation,-drop-queue}.ts`（保留 `HiddenCompletionExecutor` 接口、替换实现）、`historian-prompt*`、`agents/historian*.ts`、`features/magic-context/{compartment-storage,compartment-events,compartment-lease,protection-window,reclaim-protection,scheduler,session-cache-ttl}.ts`。
- **D 组 工具（第一批 2 个）**：`tools/ctx-reduce/**`、`tools/ctx-expand/**`（**剥离** `@opencode-ai/plugin` 的 `tool()`/`ToolDefinition` 运行时值导入与 `plugin/rust-tool-backends` 的类型导入，改由 `host/tool-registry.ts` 适配 ZCode `ToolEntry`）；连同其未列依赖一并搬：`tools/unwrap-imitated-reduced-args.ts`、`features/magic-context/{protection-window.ts,storage-tags.ts,tag-input.ts}`（`tag-input.ts` 仅 16 行纯函数、唯一消费者 `ctx-expand/mode.ts:13/:62`，可整函数内联）、`shared/user-facing-codes.ts`、`features/magic-context/range-parser.ts`。
- **E 组 配置（按 D-12 缩减）**：**不整文件移植** `config/schema/magic-context.ts`（源文件 ≥1600 行且内嵌 dreamer/mural/memory/rust/profiles 等不搬子树）——按字段白名单**新写**缩减版 zod schema（放 `adapters/src/config/schema.ts`，zod v4），只从源文件搬运白名单字段的校验器与默认值：`enabled`、`execute_threshold_percentage`(默认 65)/`execute_threshold_tokens`、`protected_tokens`、`history_budget_percentage`(0.15)、`cache_ttl`、`historian.*`、`smart_drops`、`fail_closed_blocking`、`language`（其 refine 依赖源 `agents/language-directive.ts` 的 `isValidLanguageCode`，整函数内联）；**显式排除 `compaction.*`**（fork 已无原生压缩，该字段等价于无人管理窗口）。`config/live-run-config.ts` 与 `live-snapshot.ts` **不移植实现，只移植语义契约**（`ConfigSnapshot{generation,digest,adoptedAt,effective}`、`changedKeys` 差分、`reloadFailure` 上报）——源实现是 `.cortexkit/` 双层文件轮询（poll 型），与 D-12 的 ConfigPort 订阅（push 型）方向相反；ZCode 侧在 `host/config-bridge.ts` 以 `ConfigPort.observe` 订阅重写。**不移植** jsonc 体系（`jsonc-parser/jsonc-edit/raw-loader`）与 `.cortexkit/` 路径体系。
- **明确不搬**：`tui/`、`tui-compiled/`、`v2/`、`plugin/rpc-handlers.ts`（1883 行 TUI RPC）、`hooks/auto-update-checker/`、`historian-host-runner.ts`（仅 Rust 路线）、`rust-*/module-*`、`plugin/rust-tool-backends.ts`（type-only 亦不搬）、`compaction-marker*`（由 D-7 的移除逻辑替代）、`opencode2-relabel/tool-owner-backfill`、`dreamer/**`、`memory/embedding-*`、`mural/smart-notes/user-memory/git-commits`（Batch 2 增量）、jsonc 配置族（D-12）、`live-run-config.ts`/`live-snapshot.ts` 的实现（只搬语义契约，见 E 组）、**`/ctx-status` 与 `/ctx-recomp` 的源实现 5 文件**（`hooks/magic-context/execute-status.ts`、`shared/status-view.ts`、`shared/status-view-check.ts`、`shared/format-threshold.ts`、`hooks/magic-context/recomp-orchestrator.ts`，合计约 2137 行且深度耦合 OpenCode RPC/TUI——fork 里由 Step 22 按 TUI/CLI 文本快照**重写**，见下）。
- **依赖处理**：`zod` 使用 workspace 版，**注意仓库存在两个 zod 根**——`packages/shared`/`adapters`/`bootstrap` = 4.6.5，`contracts` = 3.25.76（`^3.24.0` 声明）；`cli/scripts/build.mjs:51` 的 `assertZodVersion` **只对 v4 生效、v3 有意放行**，不构成"单一 zod 根"约束。因此：magic-context 的 zod v4 代码只允许落在 `adapters/src/config/schema.ts`（4.6.5）与新包 `magic-context`；`contracts`（v3）内只写纯 TS 类型（`ConfigKey`/`ConfigValue`/`RuntimeConfig`），ctx 工具契约的 schema 走 zod v3 或手写 JSON Schema。`ai-tokenizer` 保留；不引入 `solid-js`/`@opentui/*`/`onnxruntime*`/`sharp`/`@cortexkit/subc-client`/quickjs/`jsonc-parser`/`comment-json`/`@opencode-ai/{plugin,sdk}`。

### ZCode 侧关键插入点（探索确认）

| 能力 | 位置 | 说明 |
|---|---|---|
| 每请求 transform | `core/src/runtime/methods/turn-loop.ts:168-186` | `providerEntries` 赋值处、双投影之前；messages 与 recordedMessages 同源于 requestEntries，transform 前置即可保证一致 |
| 注入源白名单 | `core/src/system-reminder/source.ts` | 新增 `magic_context` source（三组常量 + DESCRIPTORS + NON_MID_CONVERSATION_SYSTEM_SOURCES），否则 attachment 渲染 throw |
| 工具注册 | `contracts/src/tools/`（契约+barrel）→ `core/src/tool/handlers/index.ts` `builtInTools` → `core/src/runtime/helpers/runtime-tools.ts` | `ctx_reduce` 下划线命名有先例（`submit_result`）；ctx 工具只读写 magic-context.db 返回文本，不触碰 messageHistory |
| slash 命令 | `packages/shared/src/zcode-slash-command-help.ts` + `bootstrap/src/slash-command-surface.ts` + `cli/src/command-center/{slash-commands,create}.ts` | 本地控制命令走 `command-center/handlers/ctx.ts`；必须替换 magic-context 的 Effect 204 sentinel |
| 旁路 LLM | `core/src/runtime/methods/compact-summary-model-request.ts:74`、`core/src/tool/handlers/read-session-context.ts:269` | historian 的模型调用原语（注：`compact-summary-model-request` 随 D-7 移除压缩时**保留并更名**为通用旁路请求原语，historian 依赖它） |
| 后台调度范式 | `core/src/runtime/helpers/project-memory-{agent,extraction}.ts` | historian fire-and-forget + drain + abort 的模板 |
| 历史读取 | `messageHistory.borrowReadOnlyRuntimeEntries()`（零拷贝，跨 await 需浅快照）+ adapters 的 SQLite session store | 实现 `RawMessageProvider`（`read-session-chunk.ts:128`） |
| 配置链路 | `contracts/src/config/index.ts` → `adapters/src/config/schema.ts` → `adapters/src/config/index.ts`（ConfigStore.merge）→ `bootstrap/src/app/runtime-config.ts` | `features.compact` 是无消费点的空开关，不能照抄类比；`magicContext` 域需走完整手写映射（schema → ConfigKey → merge → getAll → patch 函数） |
| UI 设置面 | `packages/ui/src/settings/settingsPageConfig.ts`（分区注册表）→ `packages/ui/src/SettingsPage.tsx:1649-1950`（if/else 渲染链）→ 新建 `MagicContextSettingsSection.tsx` | 复用 `SettingsResourceGroup`/`SettingsFormActions` 组件范式；数据流走 `zcodeAgentService` JSON-RPC（不新增 IPC channel——renderer↔host 走 MessagePort service） |
| 配置热生效 | 三段式（见 D-12）：写盘锚点 `file-config.adapter.ts:222 updateUiLocaleInFileConfig`/`:598 atomicWriteJson`；分发锚点 `zcode-protocol/index.ts:3604 workspaceUpdateInteractionPreferences` + `server.ts:628` case + `zcodeAgentService.ts:1468`（RPC 调用侧）；订阅锚点 `adapters/src/config/index.ts:348 ConfigPortImpl.observe()`（**当前零消费者，本 fork 首用**） | 新方法 `workspace/updateMagicContextConfig`：写盘 + `configPort.set` + observe 订阅 fan-out；`interaction-preferences.ts` 不写盘不推送，仅作 RPC 方法名/分发参考 |
| 用量显示 | `packages/ui/src/chat-input-toolbar/contextUsage.tsx` + `v4/composer/V4ComposerToolbar.tsx:951` + `bootstrap/src/zcode-protocol-v4/product-projection.ts`（`snapshot.usage.contextWindow`） | 数据源扩展 magic-context 预算/compartments 状态 |
| 新方法挂载 | `core/src/runtime/methods/index.ts` + `internal-methods.ts` + `core/src/runtime/deps.ts` | core 只经 deps.ts 拿 contracts 符号，漏加会静默拿不到 |

## 最终项目结构

新增/删除后的结构（`▲` 新建、`✕` 删除、`△` 修改）：

```
apps/zcode-cli/packages/
  magic-context/            ▲ 新包
    src/
      core/                 ▲ A/B/C/E 组移植代码（目录结构随源，保持可 diff 对照）
      host/                 ▲ ZCode 适配层（见"变更点清单"）
      index.ts              ▲
    package.json            ▲ deps: zod(workspace)+ai-tokenizer
  telemetry/                ✕ 整包删除
  contracts/                △ -src/telemetry/；+src/tools/ctx-context.ts；+config magicContext 域；
                              compact 解析侧 schema 保留、触发枚举清理
  core/
    compact/                ✕ 产生侧删除（policy/prompt/manual/microcompact/rounds）
    runtime/methods/        △ compact*.ts 触发侧删除（compact-summary-model-request 更名保留）；
                              turn-loop 插入 transform；-agentTelemetry
  bootstrap/                △ -telemetry 接线；-goal-compact.ts；+magic-context 装配
                              +workspace/updateMagicContextConfig handler
  adapters/                 △ -mcp/telemetry 出口；+magicContext schema/patch 函数
  cli/                      △ +handlers/ctx.ts；-/compact 解析与帮助
  tui/                      ✕ app-compact-timeline.ts 整删；△ 事件消费清理；+ctx 状态展示
packages/
  ui/src/settings/          ▲ MagicContextSettingsSection.tsx
  ui/                       △ 压缩产生侧 UI 清理（死 prop、队列分支、mention 图标等）；
                              ChatContextUsage 扩展 magic-context 数据源
  services/ desktop/ shared/ rpc/   △ 遥测清理面（同前版）
patches/@arms__rum-electron@0.0.3.patch  ✕
```

## 变更点清单

### Phase 1 遥测移除（文件级，源自探索报告三张表）

**整删（CLI 侧）**：`apps/zcode-cli/packages/telemetry/`（整包）；`bootstrap/src/telemetry-bootstrap.ts`；`bootstrap/src/zcode-protocol-v4/{local-ttft,conversation-telemetry-workflow-facts}.ts`；`core/src/hooks/workspace-hook-telemetry.ts`；`core/src/runtime/methods/target-completion-verification-telemetry.ts`；`core/src/telemetry/runtime-telemetry.ts`（或降级为无 port 空壳）；`contracts/src/telemetry/{agent-execution,index}.ts`。

**整删（根 workspace，重点）**：`services/src/telemetry/`、`services/src/conversation-telemetry/`、`services/src/zcode-agent/agentTelemetryEnv.ts`；`desktop/src/main/` 下 ARMS 族 ~30 文件（**保留** `processResourceRoleClassifier.ts`、`resourceManagerHostSampling.ts`——本地资源管理器共用）、OTLP/trace 族（`localTtft*`：desktop/main 3 文件 + renderer/shared 若干，随通道 C/D 清单一并处理；`rendererActionTrace*` 4 文件）；`desktop/src/shared/armsRum*` 6 个文件（.ts + checked-in 的 `.js/.js.map/.d.ts/.d.ts.map`）；`desktop/scripts/ttft-otlp-receiver.mjs`；`ui/src/lib/*Telemetry*` ~14 文件与 `ui/src/v4/telemetry/` **全目录**（含 `ConversationTelemetryAttachment.tsx` 装配层）——同步清理 5 个消费文件的 React 接线：`Root.tsx:83-85/:180/:597`、`root/RootWorkspaceContent.tsx:10/:124/:178`、`v4/V4ConversationContext.tsx:43/:352/:356`、`v4/ConversationComposer.tsx:167/:542` 及约 9 处 `conversationTelemetry?.*` 调用、`v4/SessionPane.tsx:217-218/:568/:573/:588/:1021/:1487-1582/:3682/:3685/:4407` 及约 10 处调用（D-8 保留的是 **server 侧** emitter + turn 事实通道，与 UI 侧 reporter/supervisor/attachment 删除不冲突）；`shared/src/{telemetry,telemetryRedaction,remoteUsageTelemetry,sessionCreateTelemetry,rendererActionTrace,localTtft}.ts`（`remoteUsageTelemetry.ts` 需拆分：`RemoteWorkspaceConnectTrigger` 被 platform.ts 业务引用，保留该类型）；`rpc/src/network-telemetry-middleware.ts`；`patches/@arms__rum-electron@0.0.3.patch`。

**修改（关键项）**：
- `shared/src/env.ts`：删 `ZCODE_TELEMETRY_ENABLED` / `ZCODE_TELEMETRY_REPORT_ENDPOINT` / `ZCODE_ARMS_RUM_ENDPOINT` / `mapZCodeEnvToArmsRumEnv` / `ArmsRumEnv`；**保留** `normalizeZCodeEnv`/`ZCODE_ENV`/`ZCODE_PRODUCT_FLAVOR`。
- `shared/src/runtimeEnv.ts`：**保留** `SANITIZED_RUNTIME_ENV_KEYS` 中 17 个遥测键的剔除（:75-93，OTEL×9 + `ZCODE_MODEL_TELEMETRY_ENABLED`/`DEVICE_MID` + `ZCODE_TELEMETRY_*`×6；防泄漏安全边界）；删捕获侧 5 个函数 + 1 个模块级 record（`captureZCodeAgentTelemetryEnv`/`readZCodeAgentTelemetryEnv`/`getCapturedZCodeAgentTelemetryEnv`/`resetCapturedZCodeAgentTelemetryEnvForTest`/`isZCodeAgentTelemetryEnvKey`/`capturedZCodeAgentTelemetryEnv`）及其 `:168/:216/:270` 调用点。
- `shared/src/channels.ts` / `platform.ts`：删 11 个遥测 IPC channel 与出口（`zcode:` 前缀 8 个 + 方法名式 3 个：`McpTelemetry`/`SessionCreateTelemetry`/`NetworkTelemetryBatch`）；**保留 `GetDeviceId`**。
- `shared/src/zcode-protocol-v4/`：保留 `conversationTelemetryFact` 的 transport/schema/emitter 与 `turn.started`/`turn.terminal`（D-8）；删 `localTtftFacts`。
- `bootstrap/src/app/create-app.ts`：删 `createModelTelemetry`（:27/:192-195）、4 处 `agentTelemetry` 传入（:558/:628/:727/:825）、`statusSink` 接线（:536/:539-540，模型事件在 core 有默认出口）。
- `core`：`runtime/types.ts:310` 与 `tool/executor/types.ts:76,182` 删 `agentTelemetry?`（相邻的 `agentTelemetryCausation*`/`agentTelemetryActorKind` 一并删）；9 个 methods 文件加 `runtime/agent-runtime.ts` 共 10 处 `this.agentTelemetry.*` 调用删除。
- `bootstrap/src/app/{workflow-facade,script-workflow-child-runtime}.ts`：删必填 `agentTelemetry` 字段。
- `adapters/src/model/runner*.ts`：删 `publishModelTelemetryMilestone`；`adapters/src/mcp/telemetry.ts`：保留 tracker/`listProcesses`/`sampleNow`，删 `onEvent`/`emit`。
- `cli/src/{cli-types,prompt-command,tui-prompt-handler-runtime}.ts`：删 telemetry 分支。
- `desktop/src/main/index.ts`：删 telemetry/ARMS/trace 全部装配块（:728-752、:809-834、:1023-1028、:1049-1053、:2161-2200、:2203-2249、:1721-1729）。
- `desktop/package.json`：删 7 条依赖（`@arms/rum-electron` + 6 `@opentelemetry/*`）；`electron-builder.config.js:112-120` 与 `scripts/bundle.mjs:91-97` 删闭包项；`tsconfig.preload.json:8` 删 include。
- `zcodeAgentService.ts` / `zcodeAgent.ts` / `zcodeAgentConnectionScope.ts`：保留 `onDynamicConversationTelemetryFact` 链路（D-8），删 localTtftFacts 分支。
- 声明文件：root `package.json` 删 patch；`third-party/npm-overrides.json` 删 3 条 `@arms/rum-*`；重生成 `THIRD-PARTY-NOTICES.md` + `inventory.json`（命令：`node scripts/licenses.mjs notices`——`generate-third-party-notices.mjs` 无 CLI 参数，唯一调用入口在 `scripts/licenses.mjs:26-30`，未挂 npm script）；`NOTICE.md` **仅改 `:62`** 的崩溃记录描述（随 D-9 崩溃采集删除；`:37/:40` 描述的设备标识与 `:49` 的自动更新属"必须保留"能力，**不改**——全文本无独立遥测章节）；`.architecture-baseline.json` 漂移后 `pnpm architecture:baseline:update`。

**必须保留（防误删清单）**：`deviceMid` 4 份实现及 `telemetry-state.json` 文件名（改名=重置设备身份）；session DB 的 `model_usage/turn_usage/tool_usage` 表；`ModelStatusSink`；`GetDeviceId` IPC；本地资源管理器共用文件。

### Phase 2a magic-context 移植与集成

**新建 `apps/zcode-cli/packages/magic-context/src/host/` 适配层**：

| 文件 | 职责 | 实现依据 |
|---|---|---|
| `types.ts` | 替代 `PluginContext` | — |
| `messages-transform.ts` | `RuntimeMessageEntry[] ↔ MessageLike` 转换 + LKG/分级错误/尾部门闸（移植 `plugin/messages-transform.ts` 的分级表：fail-closed 重抛 / SQLITE_BUSY 走 LKG 不重试 / 其他 fail-open） | ZCode transform 抛错语义需在集成 Step 验证 |
| `raw-message-provider.ts` | 实现 `RawMessageProvider`（12 方法子集），经 `setRawMessageProvider` 注册 | 源接口：`read-session-chunk.ts:128`；数据源：`borrowReadOnlyRuntimeEntries` + session store 分页 |
| `session-history.ts` | 替换 `read-session-db.ts` 的 opencode.db 查询（`assistantAwaitingTools`/`getMessageTimes`/`findLastAssistantModel`/`latestPersistedMessageForRecovery`/`hasNewerRealUserMessage`） | ZCode 表：`message`/`part`（`part.data` 为 TEXT JSON） |
| `hidden-completion-executor.ts` | `HiddenCompletionExecutor{capabilities,open,attempt,collect,close}` 的旁路实现（D-6） | 接口：`compartment-runner-types.ts`；参照 `generateLiteExtraction` |
| `tool-registry.ts` | ctx 工具门控（enabled/memory 等开关），`ToolDefinition` → ZCode ToolEntry | 移植 `plugin/tool-registry.ts` 门控逻辑 |
| `commands.ts` | `/ctx-*` 声明 + handler；重写 Effect 204 sentinel 为 ZCode 本地命令消费语义 | 源：`command-handler.ts:198-227`（注释+`throwSentinel` 函数整体，纯 OpenCode 技巧，不可照搬）；`ctx-status`/`ctx-recomp` 实现体见"明确不搬"，fork 重写 |
| `storage-dir.ts` | 存储目录：`~/.zcode/cli/db/magic-context.db`；保留"绝对路径强制 + 测试隔离优先级" | 改 `shared/data-path.ts:214` |
| `config-bridge.ts` | 从 ZCode `ConfigPort` 读 `magicContext` 域 → 转 magic-context 内部 config 形状；`ConfigPort.observe` 订阅 → generation/digest bump（ConfigSnapshot 语义，见 E 组）fan-out | 替代原 jsonc 装载器与 `LiveConfigReader` 轮询 |
| `hooks.ts` | 生命周期接线（session start/end、turn 后 drain、tool after 等价事件） | ZCode 事件：SessionEventType 经 `appendEvent`/`notifyEventSinks` |
| `harness.ts` | `HarnessId` 加 `"zcode"`；`setHarness()` 在任何 DB 写之前调用并锁定 | 防跨 harness 行泄漏 |
| `notify.ts` | 通知/空闲查询（Channel-2 nudge 用，Batch 2） | ZCode `steerTurn({delivery:"guide"})` |

**core/cli 侧改动**：
- `turn-loop.ts`：投影前插入 `mcTransform`（feature 门控）。
- `system-reminder/source.ts`：新增 `magic_context` 注入源。
- `context/dynamic-sections.ts`：`buildContextManagementSection` 增补 ctx 工具使用指引（`guidanceToolNames` 机制现成）。
- 工具契约 `contracts/src/tools/ctx-context.ts` + barrel + `core/src/tool/handlers/ctx-{reduce,expand}.ts` + `builtInTools` + `core/src/runtime/helpers/tool-allowlist.ts`（workflow child 禁用 ctx 工具）。
- 命令：`slash-command-help.ts` + `slash-command-surface.ts` + `cli/src/command-center/slash-commands.ts` + `handlers/ctx.ts`（先做 `ctx-status`/`ctx-recomp`）。
- 配置域：`contracts/src/config/index.ts`（`ConfigKey.MagicContext` + ConfigValue 映射）+ `adapters/src/config/schema.ts`（`magicContextSchema`——直接内嵌移植的 zod schema，字段白名单化）+ `ConfigStore.merge`/`getAll` + 新 patch 函数 `updateMagicContextInFileConfig`（仿 `updateUiLocaleInFileConfig` 的 atomicWriteJson）+ `features.magicContext` 开关 5 文件链。
- JSON-RPC：`packages/shared/src/zcode-protocol/index.ts` 加 `workspace/updateMagicContextConfig` 方法名 + params/result schema；`bootstrap/src/zcode-protocol/` 加 handler（写盘 + `configPort.set` → observe 订阅侧自动 fan-out）；`packages/services/src/zcode-agent/zcodeAgentService.ts` 加客户端方法。
- `core/src/runtime/deps.ts`：新契约符号再出口。

**不可破坏契约**（移植时逐条照搬）：
1. m[0]/m[1] 逐字节可重放（`cached_m0_bytes`/18 个 distinct `cached_m0_*` 列 + `M0SnapshotMarkers` 21 个成员（扣 3 个运行时信号后约 18 个 durable）；非 cache-busting pass 必须命中缓存字节）。
2. drop 占位符是 tagId 的纯函数（`buildReplacementContent`）；drop_mode 落库、逐 pass 重放、skeleton 永不降级。
3. m[0]/m[1] 消息 part 必须 `synthetic:true` 绝不能 `ignored`；`syntheticHead` 标记槽位。**集成早期必须 wire-level 验证**（T-M4）。
4. 失败分级不可压平（fail-closed / LKG / fail-open 三档；应急带下拒绝 LKG replay）。
5. schema fence：DB 版本比 build 新 → 拒绝 transform；`LATEST_SUPPORTED_VERSION` 与 `LATEST_MIGRATION_VERSION` 同步。
6. user 终止尾部的因果性（`preserveUserTerminatedTail`）。
7. `MessageHistory` entries 进入后禁止原地修改；跨 await 浅快照。
8. **门控唯一真源 = `features.magicContext`**（进程级，MVP 验收前 false）；`magicContext.enabled` 为用户级二级开关，`effective = features.magicContext && magicContext.enabled`（UI 上标注"仅停用上下文管理，historian/知识层随之停止"）；**不提供** `compaction.enabled` 三级开关（D-7 已删原生压缩，该字段等价于无人管理窗口）。热生效契约仅覆盖 pass 级字段（E 组白名单）。

### Phase 2b 原生压缩移除（D-7）+ UI 调整（D-12/D-13）

【执行注记 2026-10-05 · 范围澄清】压缩移除**含用户可见 `/compact` 命令面**（CLI 解析/路由、help 条目、TUI 提交路径、`/help` 目录项）——T-M9 的「按普通文本处理或报命令不存在」即目标行为，非回归。

**全量删除清单（产生侧 + 解析侧，无历史数据包袱）**：
- core：`core/src/compact/` 整目录删（policy/prompt/manual/microcompact/rounds）；`runtime/methods/{compact,compact-active,compact-active-helpers,compact-persistence,compact-log-context,microcompact}.ts` 整文件删（`compact-log-context` 唯一消费者是 `compact.ts:34`）；**`runtime/methods/context-usage-log-compact.ts` 必须保留**（其 `compactContextUsageSnapshot` 是"/context 用量快照裁剪"，消费者 `context-usage.ts:19/:55` 属 D-13 保留面，与上下文压缩无关——列入防误删清单）；`runtime/helpers/{compact-selection,compact-preservation,compact-post-reminders,compact-media,compact}.ts` 删；`turn-loop.ts:67-103` **整段删**（`microcompactIfNeeded`/`autoCompactIfNeeded` 调用、`compactPhase` 变量、`evaluateRapidRefill`、`recordCompactSuccess`/`recordCompactHistoryRound`、`createCompactRapidRefillError`/`MAX_CONSECUTIVE_RAPID_REFILLS` 及 `CompactPhase`/`CompactReason` import）；`runtime/methods/turn-loop-state.ts` 删 `CompactLoopTracking`/`CompactAttemptOutcome` 及 rapid-refill 状态（:50/:55/:89/:102/:174-195）；`runtime/internal-turn-methods.ts` 删全部 compact 方法声明（约 20 处）；`turn.ts:240` compactInstructions 分支；`turn-model-step.ts:742` reactive 恢复路径；`runtime/helpers/conversation.ts:31` 与 `core/src/agent/{session-history-hydrator:205/:226/:253,read-file-state-hydrator:36}` 与 `runtime/methods/{rewind-message:714,resume}` 的 `includeCompactPreservedSegment` 字段（定义与 4 个消费点同步删）。
- **例外保留并更名**：`compact-summary-model-request.ts` 的 `runCompactSummaryModelRequest` 是 historian 的旁路模型请求原语——文件移入通用位置（如 `runtime/methods/sidecar-model-request.ts`）并更名，去 compact 语义。
- bootstrap：`zcode-protocol-v4/commands/handlers/goal-compact.ts`（整文件，含 `compactOperationLock`/`startManualCompact`）；v4 `compact` 命令从 `CommandPayloadMap` **连 schema 一并删除**；`zcode-protocol/server.ts` 的 deprecated `sessionCompact` handler 与 wire schema 删除（连带 `zcode-protocol/index.ts:1831-1855` 的 params/result schema、legacy-types、transport bypass 名单）；`slash-command-surface.ts`/`builtin-prompt-command.ts` 的 compact 项删除。
- cli：`command-center/slash-commands.ts:27` 的 compact 解析、`slash-command-types.ts:4`、`create.ts` compact 分支、`selections.ts` 相关项。
- TUI：`app-compact-timeline.ts` 整删；`app-events.ts` 的 4 个 Compact SessionEventType 消费（L80-82/L179-203）；`app-submit.ts:146-273` 的 `/compact` 提交路径；`app-keyboard.ts:236-243` 重放；`app-transcript-components.tsx` 的 `CompactTimelineRow`；`app-model.ts:41`。
- UI（packages/ui，产生侧/死代码）：`contextUsage.tsx` 的 `getContextCompressionCommand`(:224) 与死 prop `onSendCompressionCommand`/`compressionDisabled`(:254-255)；`display.tsx:46-50` re-export；`V4ComposerToolbar.tsx:1020-1021`；`ConversationComposer.tsx` 透传（L446/525/2061/2119）；`SessionPane.tsx` 的 compact 分支与 3 个 toast（L2453-2511、L3537-3546）；`slashCommands.ts` 的 `kind:"compact"` 解析（L1-5/L79-81）；`ConversationQueuePanel.tsx` compact 队列分支（L135/203/207/232/235）；`promptMentionDecoration.ts:98` + `mentionIconDom.ts:57` 图标；`test-ids.ts` 两个无消费者 TID（L244/246）；`pendingCommandRegistry.ts`/`pendingCommandReplay.ts` compact 特判。
- i18n：压缩相关 key **全删**（zh-CN 实测：`chat.contextCompaction.*` 8 个、`chat.contextOptimization.*` 5 个、`chat.compact.*` 3 个，en-US 同步核对；TUI `status.compact*` 3 个与 `transcript.compact.*`），所有引用处同步删净；无旧会话渲染需求。

**同步删除清单（原"解析侧"，D-7 第三轮修订后一并删）**：`contracts/src/events/session.events.ts` 的压缩事件枚举（`SessionCompacted`/`CompactStarted`/`CompactCompleted`/`CompactFailed`/`CompactBoundary`/`MicrocompactBoundary`）及其 payload 联合成员；`contracts/src/compact/` 整目录（含 `getItemsAfterLastCompactBoundary` 等）；`packages/shared/src/zcode-protocol-v4/rows.ts` compact marker schema（L332-340）；`snapshot.ts` 的 `stopTargetKind`/`activeWorkSummary.kind` 中 `"compact"`、`sessionActionAvailability.compact`（L44/57/153）与 `autoCompactThresholdTokens`（L194）；`command.ts` 的 `compact` payload（L150）；`input-intent.ts` kind 枚举（L44-45）；`fork.ts:27` `"guard.compactOperationLock"`；`zcode-session-visible-content.ts:67` `isZCodeCompactSummaryMessage` 与 `part.type:"compaction"` 读取；`ConversationRowView.tsx` 的 compact marker 渲染 case（L1743-1892）；`ConversationShareReadonlyTimeline.tsx:142`；resume 侧 `recoverInterruptedCompactTimelines`（`resume.ts:148`）、`compact-session.ts`、`session-history-hydrator.ts` 的压缩边界裁剪；`zcodeTaskUsageFallback.ts` 的 `/compact` 归一化；`event-normalizer.ts`/`cold-event-merge.ts`/`local-ttft-compaction.ts`/`transcript-hydration.ts`/`projection-rows.ts`（v4 投影层五个文件）的压缩分支；`contracts/src/rewind/` 中压缩关联引用；`cli/src/command-center/types.ts` 的 compact 类型。

**编辑型改动（从类型联合/编解码中摘除，非整删）**：`contracts/src/interfaces/session-store.port.ts`（`CompactionPart`（`:522-551`）/`ContextCompactionTimelinePart`（`:590-600`，且 TimelinePart 联合的成员声明在 `:634`）/`../compact/index.js` 类型 import（`:14-21`）/`compacted?: number` 计数（`:733`）/part union（`:769`）/`UsageQuerySource` 的 `"compact"` 枚举值（`:871`，【勘误 2026-10-05】原文判断"删除会牵动 usage_stats 查询源"不成立——唯一使用点带 `| string` 兜底，实测零影响））；`adapters/src/storage/session-store/sqlite-session-store.ts:166-173`（**注意 `timelineType:"context_compaction"` 与 `type:"compaction"` 是两处**）；`adapters/src/storage/session-store/codecs.ts:192`；`dynamic-workflow/src/engine/types.ts:654`（该 union 成员是**保留占位**——v1 从不发出，为避免动 workflow 引擎契约，保留成员定义、仅确认 fork 不产生它）；`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:3514/:3680`；`core/src/session-context/parts.ts:45`；`bootstrap/src/zcode-protocol/{session-mapper:743-745,message-mapper:114/:138}.ts`；`core/src/runtime/helpers/{steering,rewind}.ts` 与 `core/src/runtime/methods/session-fork.ts` 的 compaction part 处理分支；`packages/shared/src/{conversation-message-projection-policy.ts,zcode-protocol-legacy-types.ts}`。

**防误删清单（D-7 执行期）**：`formatCompactTokenNumber`/`formatCompactTokenCount`（数字缩写，6 文件含 `settings/usage-stats`、`StartPlanCard`）；`density="compact"`/`variant="compact"`（布局词）；`core/src/runtime/methods/context-usage-log-compact.ts`（用量快照裁剪）；**`compact_stream_boundary`**（`contracts/src/model/index.ts:725-748` 的 `ModelStreamEvent` 成员）与 **`preserveProviderStreamBoundaries`**（字段定义在 `contracts/src/model/index.ts:681` 与 `contracts/src/model/invocation-context.ts:31`）——两者是通用 raw provider 流边界保真机制（`runner-stream.ts:1144-1191` 发出、sidecar 原语 `compact-summary-model-request.ts:122/210-255` 消费），**不得因 D-7 删除；且其 `true` 生产者（现为 `compact-active.ts:401`，随 Step 26 删除）必须由 historian 调用点接替**（Step 25 硬约束）。

**UI 配置面（D-12）**：
- `packages/ui/src/settings/settingsPageConfig.ts`：新增分区 `{id:"context", icon, titleId, groupId:"agentCapabilities"}`；`packages/ui/src/lib/settingsNavigation.ts` 的 `SettingsSectionId` 联合与 `isSettingsSectionEnabled` 白名单同步。
- 新建 `packages/ui/src/settings/MagicContextSettingsSection.tsx`：首版字段——上下文管理开关（`enabled`，二级开关，语义见契约 8）、执行阈值（percentage 数字输入 + tokens 覆盖）、protected_tokens、history_budget_percentage、cache_ttl、historian 模型（下拉，数据源复用模型选择）、smart_drops/fail_closed_blocking 开关；复用 `SettingsResourceGroup`/`SettingsFormActions`；保存走 `zcodeAgentService.updateMagicContextConfig`，`runSettingsActionAsync` 包裹（无需 requiresRestart——热生效）。
- `packages/ui/src/hooks/useSettingService.ts` 或专用 hook：调用点接入新 JSON-RPC。
- i18n：新增 `settings.context.*` 文案（zh-CN/en-US）。

**用量显示（D-13）**：`product-projection.ts` 的 `snapshot.usage` 扩展 magic-context 预算摘要（预算总量、已用、compartments 数、dropped 标签数、cache 命中）——`sessionUsageStateSchema` additive 加可选字段；`ChatContextUsage` 面板加 magic-context 段；`autoCompactThresholdTokens` 停止填充。

### Phase 3 品牌与后端

【执行注记 2026-10-05 · S32 品牌面四个既成事实】①**双轨数据目录**——用户级 HOME 下改 `~/.omz`（新起+首启提示，不迁移），工作区级 `<cwd>/.zcode` **刻意保留**（随仓库走，改名会破坏存量仓库）；②marketplace id 过渡期对旧 CDN 名 `zcode-plugins-official` 做别名容忍（CDN 重新发布新名后摘除；cr-fix-spec MF-02 落地）；③electron 桌面身份（`dev.zcode.app`/`ZCode.app`/linux 可执行名）不属 L1，未改；④`.zcodeignore` 文件名与 locale 产品名 `ZCode` 属 D-10 分层外未分配范围，默认不动（CR 待拍板 #5）。

- **L1 改名**：CLI bin 名 → `omz`；npm name `zcode`→`oh-my-zcode`；数据目录 `~/.zcode` → `~/.omz`（新起 + 首启提示，不自动迁移）；marketplace id → 自有 id（两份硬编码清单同步：`shared/src/plugin-marketplaces.ts:13-30` 与 `bootstrap/src/app/official-plugin-definitions.ts:89-364`）；`latest.json` name、tarball 名、README。【执行注记】实际落地 id 为 `oh-my-zcode-official`，全仓 20 文件 109 处（非仅两份清单——id 字面量散布引用，只改清单会错配；计数为 v0.1.0 终测口径）。
- **L2/L3 不动**（D-10）。
- **端点**：保留（D-2）；`zcodeEndpoint.ts` 已集中。
- **上游同步**：`.reference/ZCode` 按版本快照更新 → diff → 重放改造；`scripts/check-workspace-freshness.mjs` 与 `bootstrap.mjs:161` submodule 行在 fork 中删除/适配。
- **合规**：保留 Apache-2.0 LICENSE（ZCode）；【勘误 2026-10-05】magic-context 上游实为 **MIT**（@cortexkit/opencode-magic-context 0.44.4，Copyright (c) 2025 Ufuk Altinok）——本句撰写时误判为"均是 Apache-2.0"，S34 已按 MIT 实际处理（LICENSE.magic-context + 33 个头注释订正）；NOTICE.md 标注 fork 与修改；依赖变更后重跑第三方声明生成。

## 详细实现步骤

**Phase 0 — phase-baseline**

- Step 1 — phase-baseline — blocking: yes — qa: auto：建立 fork 工作仓：复制 `.reference/ZCode` 全量到 `D:\Dev\Js\oh-my-zcode\omz`（新 git 仓，首提交打 tag `baseline/v3.14.3`）；删 `scripts/bootstrap.mjs:161` 的 submodule 行；删死目录 `apps/zcode-cli/packages/superpowers-plugin`；删遗留 `apps/zcode-cli/pnpm-lock.yaml`（根 lockfile 实际生效）。
- Step 2 — phase-baseline — blocking: yes — qa: auto：工具链与依赖：`mise install`（Node 24.14.0 / pnpm 10.33.2）→ 根 `pnpm install`。
- Step 3 — phase-baseline — blocking: yes — qa: manual_user：CLI 基线构建与冒烟：`pnpm --dir apps/zcode-cli build`（turbo run build，仓库无根 turbo.json）→ `pnpm --dir apps/zcode-cli run cli:build` → `cli:dev` 真实对话（登录、一次工具调用、`/compact` 验证原生压缩工作——为 Phase 2b 留对照）。
- Step 4 — phase-baseline — blocking: yes — qa: auto：校验基线：根 typecheck、CLI typecheck、lint、fmt、architecture:check（记录零基线）；确认 `browser-use-plugin` 残缺不影响 CLI 闭包。
- Step 5 — phase-baseline — blocking: no — qa: auto：SEA 构建验证：`pnpm build:sea`（收集 browser-use-plugin/bundled-skills 资产，缺件在此暴露）；失败则记录豁免方案。

**Phase 1 — phase-telemetry-removal**

- Step 6 — phase-telemetry-removal — blocking: yes — qa: auto：共享包摘除（`packages/shared`）：env.ts 遥测常量、`telemetry*.ts` 整删、index re-export、channels/platform 遥测出口（保留 GetDeviceId）、runtimeEnv 捕获侧（保留 sanitize 剔除名单）、v4 telemetry.ts 缩为 turn 事实、`remoteUsageTelemetry.ts` 拆分保留 `RemoteWorkspaceConnectTrigger`。
- Step 7 — phase-telemetry-removal — blocking: yes — qa: auto：CLI 侧 OTLP 摘除：删 telemetry 整包、`telemetry-bootstrap.ts`、`contracts/src/telemetry/`、create-app 接线、core `agentTelemetry` 字段与 12 文件调用、adapters 出口、cli 三文件分支、依赖与构建登记；CLI typecheck 全绿。
- Step 8 — phase-telemetry-removal — blocking: yes — qa: auto：通道 D 处理：fact 缩为 `turn.started`/`turn.terminal`；删 workflow-facts 与 localTtft；保留 emitter 与 taskActivityTracker 全链路。
- Step 9 — phase-telemetry-removal — blocking: yes — qa: auto：desktop ARMS/trace 摘除：~60 文件按清单删；装配块、preload patch、闭包项、7 依赖删除；共用文件只摘 ARMS 出口；崩溃采集按 D-9 全删。
- Step 10 — phase-telemetry-removal — blocking: yes — qa: auto：desktop 类型门禁补齐：临时 `typecheck:desktop-full`（接入 main/preload/renderer/**scheduler 四套** tsconfig，与 `scripts/typecheck-desktop-full.mjs` 的 projects 数组一致——严格加强）作为回归网。
- Step 11 — phase-telemetry-removal — blocking: yes — qa: auto：UI/服务侧机械清理：services/node.ts、conversation-telemetry、`ui/src/v4/telemetry/` 全目录 + 5 个消费文件接线（见"整删（根 workspace）"条目）、`appTelemetry.ts` 出口删除后的调用点清理（注意其中 5 处 await/return 调用点需改为直接移除而非 void 包装——`automationTelemetry`/`offPeakTelemetry`/`promptTemplateTelemetry`/`sessionCreateTelemetry`/`oauthActions`）、rpc middleware、offPeakTelemetry。
- Step 12 — phase-telemetry-removal — blocking: yes — qa: auto：依赖与声明收口：patch 删除 → `pnpm install` 重锁 → npm-overrides 3 条删 → `node scripts/licenses.mjs notices` 重生成 THIRD-PARTY-NOTICES → NOTICE.md 仅改 `:62` 崩溃记录描述（见声明文件条目）→ architecture baseline 更新 → bundled-agents 重跑构建。
- Step 13 — phase-telemetry-removal — blocking: yes — qa: manual_user：Phase 1 全量回归：lint + typecheck×3 + knip + 构建×2 + 冒烟 + 遥测残留扫描（白名单：sanitize 名单、turn 事实链、telemetry-state.json/deviceMid、注释提及）+ 抓包确认零出网。tag `phase1/telemetry-removed`。

**Phase 2a — phase-magic-context（移植与集成）**

- Step 14 — phase-magic-context — blocking: yes — qa: auto：新包脚手架 `apps/zcode-cli/packages/magic-context`（package.json/tsconfig/空 index），接入 workspace 与 turbo，验证闭包。
- Step 15 — phase-magic-context — blocking: yes — qa: auto：A 组存储移植：sqlite chokepoint（保留变量间接 import）、data-path 接 ZCode 目录、migrations 新库起、storage-db fence、storage* 模块、logger；冒烟脚本打开 `magic-context.db` 跑迁移并断言 fence 版本同步。
- Step 16 — phase-magic-context — blocking: yes — qa: auto：E 组配置移植（缩减版）：zod schema 重写 import 后内嵌为 config.json `magicContext` 域 schema（字段白名单见 E 组，**排除 `compaction.*`**）；热更新按 E 组语义在 `host/config-bridge.ts` 以 ConfigPort 订阅**重写**（push 型，不搬 `LiveConfigReader` 轮询实现）；判据：改 ConfigPort 后下一 turn 读到新值，无需重启；`historian.model` 缺省时给出明确报错文案。
- Step 17 — phase-magic-context — blocking: yes — qa: auto：host 适配层（非 LLM 部分）：types、`raw-message-provider`（messageHistory + session store 分页）、`session-history`、`storage-dir`、`harness`；用既有会话 DB 做只读查询冒烟。
- Step 18 — phase-magic-context — blocking: yes — qa: auto：B 组 transform 核心移植（4 个子提交：b1 tag/apply-operations/失败分类；b2 预算/decay/LKG；b3 inject-compartments；b4 主编排 + postprocess）；剥离 rust/module 分支；`host*` seam 填 ZCode 实现。
- Step 19a — phase-magic-context — blocking: yes — qa: auto：**最小门控链路前移**（先建 kill switch 再接 transform）。以 `features.compact` 为模板实测共 **7 处**手写映射：`contracts` 的 `ConfigKey.FeatureMagicContext`（`:33` 附近）+ **`ConfigValue<K>` 条件类型**（`:105-114`，漏写会静默落进 `:151` 的 `unknown` 兜底）+ **`RuntimeConfig["features"]` 接口**（`:221-228`）+ `adapters/src/config/schema.ts` 的 `featuresSchema.magicContext`（`:33-40`）+ `adapters/src/config/index.ts` 的 `merge()`（`:116-129`）与 `getAll()`（`:283-290`）+ `getDefaultValue()` switch（`:396-407`）+ `DefaultRuntimeConfig`（`:308-315`）。**陷阱：`getAll()` 的 features 块是逐字段硬编码 `?? true`——`magicContext` 必须写 `?? false`，照抄邻居会默认 true 直接违反 D-11**；空补丁单测：off 时 `turn-loop` 行为与 Phase 1 逐行等价。
- Step 19b — phase-magic-context — blocking: yes — qa: auto：core 集成：`source.ts` 加 `magic_context` 源；`turn-loop.ts` 插入 `mcTransform`（Step 19a 门控 + 双投影一致）；**wire-level 验证**：debug 确认 m[0]/m[1] 进入 provider 请求且 synthetic 语义正确、cacheControl 落点正确。
- Step 20 — phase-magic-context — blocking: yes — qa: auto：historian：`hidden-completion-executor.ts` 旁路实现（attempt/collect/close + 超时预算 + refusal 码；**硬约束：首次落地即必须显式传 `preserveProviderStreamBoundaries: true`**——见 Step 25 与防误删清单，否则 `compact_stream_boundary` 不发、tool-call 提交判定静默失准）+ C 组 runner + 后台调度（参照 project-memory-extraction 的 fire-and-forget + drain，挂 turn 成功后）；真实会话后断言 compartments 落库。
- Step 21 — phase-magic-context — blocking: yes — qa: auto：ctx 工具：contracts 契约 + barrel + ToolEntry（低风险只读类 permission）+ builtInTools + allowlist（workflow child 禁用）；`ctx_reduce` 幂等 commandId 语义保留。
- Step 22 — phase-magic-context — blocking: yes — qa: auto：/ctx-* 命令（CLI 侧，**重写而非移植**）：help 表 + surface + 解析 + `handlers/ctx.ts`（本地命令语义，替代 Effect 204 sentinel，源锚点 `command-handler.ts:203-221`）；`ctx-status` 在 fork 降级为 TUI/CLI 文本快照（预算/compartments/dropped 统计，直接读 magic-context.db，不搬 source 的 2137 行 status-view/RPC 校验栈，见"明确不搬"）；`ctx-recomp` 首版可只做"触发一次 compartment 重算"的简化语义并在帮助文案注明（Effect sentinel 源锚点 `command-handler.ts:198-227`）。
- Step 23 — phase-magic-context — blocking: yes — qa: auto：`magicContext` 参数域：完整手写映射（对照 Step 19a 的 7 处范式：`adapters/schema.ts` 白名单 + `RuntimeConfig.magicContext` 接口字段 + `ConfigValue<"magicContext">` 条件类型分支 + `ConfigStore.merge`/`getAll` + `getDefaultValue()` 登记——若默认值全靠 zod `.default()` 则显式声明不登记 + 新 patch 函数 `updateMagicContextInFileConfig`）+ `host/config-bridge.ts` 热更新接线；门控链路已在 Step 19a 落地，此处只做参数域；门控验证（off 时全链路零差异，T-M8）。
- Step 24 — phase-magic-context — blocking: yes — qa: manual_user：MVP 验收（T-M1..T-M8：§N§ 注入、drop 落地与字节重放、expand 恢复、wire 验证、cache 命中、historian 产出、fence/fail-closed、flag off 零差异）+ 不变量单测（node:test：drop 占位符纯函数、M0 字节重放、fence 同步）。tag `phase2a/magic-context-mvp`。

**Phase 2b — phase-compact-removal-ui（原生压缩移除 + UI 面）**

- Step 25 — phase-compact-removal-ui — blocking: yes — qa: auto：旁路原语保全：`compact-summary-model-request.ts` 更名迁移为通用 sidecar 模型请求模块（`CompactSummaryModelRequest` 类型名与 `COMPACT_SUMMARY_SETUP_ERROR_CODES` 等内部标识一并去 compact 化），historian 与调用方改引用；**硬约束：historian 调用 sidecar 原语时必须显式传 `preserveProviderStreamBoundaries: true`**——全仓唯一现存 `true` 生产点是 `compact-active.ts:401`（随 Step 26 删除），不接替则 adapter 停发 `compact_stream_boundary` 且 historian 的 tool-call 提交判定**静默失准**（`:122` 的 case 永不命中，不报错）；加单测断言该事件分支被命中；**保留** `compact_stream_boundary` 事件名（跨包契约，见防误删清单）；更名后全仓引用一致。
- Step 26 — phase-compact-removal-ui — blocking: yes — qa: auto：压缩移除（core/bootstrap/cli + 协议解析侧）：按"全量删除清单"删 core 全部压缩路径、`contracts/src/compact/`、SessionEventType 压缩枚举、v4 compact 命令/marker/snapshot 字段、旧协议 `sessionCompact`、`goal-compact.ts`、`/compact` 解析与帮助、resume/分享的压缩边界处理；`features.compact` 配置键与 schema 字段删除（含 `ConfigKey.FeatureCompact`，已确认无消费点）；`queueItemSchema` 继承链与 `expectedHeldQueueItemIds` 互斥逐项核对；三套 typecheck + lint 全绿。
- Step 27 — phase-compact-removal-ui — blocking: yes — qa: auto：压缩移除（TUI/UI）：`app-compact-timeline.ts` 整删与 5 个消费点；UI 死 prop/队列分支/mention 图标/无消费者 TID/特判/marker 渲染 case 清理；i18n 压缩 key 全删（18 桌面 + TUI 若干）并同步删净引用；`formatCompactTokenNumber` 与布局词 "compact" 甄别保留。
- Step 28 — phase-compact-removal-ui — blocking: yes — qa: manual_user：压缩移除全量回归：三套 typecheck + lint + knip + CLI/desktop 构建 + 真机冒烟（新会话创建/工具调用/多轮对话/`--resume` 新格式会话）；全仓 `compact` 残留扫描（白名单：布局词、数字缩写、`context-usage-log-compact`、`compact_stream_boundary`/`preserveProviderStreamBoundaries`、magic-context 语境、【执行注记 2026-10-05】**dynamic-workflow 引擎契约占位**——`dynamic-workflow/src/engine/types.ts` 的 union 成员按编辑型改动清单要求保留，勿因扫描误删）；`features.magicContext` 默认翻 **true**（D-11，与移除同一变更）；**tag `phase2b/compact-removed`**（flag 翻转点即快照点）。
- Step 29 — phase-compact-removal-ui — blocking: yes — qa: auto：UI 配置面（D-12）：设置分区注册 + `MagicContextSettingsSection.tsx`（首版字段集）+ `zcodeAgentService.updateMagicContextConfig` + `workspace/updateMagicContextConfig` JSON-RPC（写盘 + `configPort.set` → observe fan-out 热生效）+ i18n 文案；验证 UI 修改 → config.json 落盘 → 不重启生效（T-U1）。【执行注记 2026-10-05】三个复用/结构锚点按实况收窄：①`runSettingsActionAsync` 已被遥测移除掏空为恒等函数（SettingsPage 本地未导出），包裹语义自动满足；②表单外壳实为 `SettingsGroupCard`（全仓无裸 `SettingsResourceGroup`），`SettingsFormActions` 确有复用；③"专用 hook"以内联实现（含竞态版本号）等价交付。T-U1 已按 RPC 级验证通过（cache/ 证据）。
- Step 30 — phase-compact-removal-ui — blocking: no — qa: manual_user：用量显示（D-13）：`product-projection.ts` 的 usage 扩展 magic-context 预算摘要（additive 可选字段）+ `ChatContextUsage` 面板新段（`autoCompactThresholdTokens` 字段已在 Step 26 随 schema 删除，此处无对象）；TUI `/ctx-status` 输出美化（成果落在 Step 28 的 `phase2b/compact-removed` tag 之后）。
- Step 31 — phase-compact-removal-ui — blocking: no — qa: manual_user：Batch 2 增量（可独立排期）：ctx_note/ctx_search/ctx_memory、Channel-2 nudge（`steerTurn`）、dreamer、embedding 语义检索（评估 onnxruntime 对 SEA 打包冲击后再定）。

**Phase 3 — phase-brand-backend**

- Step 32 — phase-brand-backend — blocking: yes — qa: auto：L1 品牌改名：bin `omz`、npm name、数据目录 `~/.omz`（新起 + 首启提示）、marketplace id 双清单同步、安装产物与 latest.json、README；全量构建 + 冒烟回归（T-P1）。
- Step 33 — phase-brand-backend — blocking: no — qa: manual_user：后端验证：登录、Coding Plan、插件市场在改名后仍可用（T-P2）；如推翻 D-2，此处变为端点切换实施位。
- Step 34 — phase-brand-backend — blocking: yes — qa: auto：合规与同步机制：NOTICE.md fork 声明、magic-context 版权头保留、THIRD-PARTY-NOTICES 重生成；落盘《上游同步 SOP》。tag `v0.1.0`。
- Step 35 — phase-brand-backend — blocking: no — qa: manual_user：发布链路：`build:zcode`/`build:sea` 品牌适配产出验证、install.sh 本地 file 源安装演练。

## 测试策略

**门禁体系**（全仓无既有测试，AGENTS.md 明示"不假定存在统一单测/E2E"）：
- 自动门禁 = `pnpm lint`（0 error、warning 不高于基线 71）+ 根 typecheck（0 error）+ CLI typecheck（`pnpm --dir apps/zcode-cli typecheck`，turbo 管道；跑前须把根 `node_modules\.bin` 置于 PATH）+ `typecheck:desktop-full`（Step 10 差分门禁，no new errors）+ knip（issue 不高于基线快照 `cache/p1-knip-baseline.txt` 且无 Phase 1 新引入项——上游基线即 720+ 条既有 issue）+ fmt（**改动文件零新增不合规**——root `oxfmt --check` 全量在基线即红 ~2650 文件，上游 verify:pre-push 从不含 fmt；全量格式化列为独立专项，不夹带在功能波次）+ 构建冒烟 + `--version`/`--help`。
- 新增单测仅限 magic-context 不变量与压缩移除回归（node:test，Node 24 内建，零新依赖），放 `apps/zcode-cli/packages/magic-context/test/`。
- 真机验收（qa: manual_user）按步骤标注，合并后用户执行，不阻塞自动门禁。

### 测试用例

- T-B1 — blocking: yes — Step 3/4：基线 CLI 构建成功且冒烟会话可完成一次工具调用，`/compact` 原生压缩可用（留对照）。
- T-B2 — blocking: no — Step 5：SEA 单文件构建成功（或豁免记录）。
- T-T1 — blocking: yes — Step 13：遥测残留扫描清零（白名单外无命中）。
- T-T2 — blocking: yes — Step 7/9/13：三套 typecheck（根 0 error / CLI 全任务 / desktop 门禁 no-new-errors）+ lint（0 error、warning ≤ 基线）+ knip（≤ 基线快照 `cache/p1-knip-baseline.txt` 且零新引入——上游基线即 720+ 既有 issue，"knip 全绿"不可达，口径已按现实收敛）。
- T-T3 — blocking: yes — Step 12：THIRD-PARTY-NOTICES 与 inventory 无 `@arms/*`、`rrweb`、`@babel/runtime`、`@opentelemetry/*` **exporter/SDK/OTLP collector** 条目（`@opentelemetry/api@1.9.0` 豁免：`ai` SDK 的传递依赖、纯 API 门面无 SDK/exporter/collector、源码零 import、不出网）。
- T-T4 — blocking: yes — Step 13：真机运行 30 分钟抓包，零遥测端点出网请求（manual）。
- T-T5 — blocking: yes — Step 8：server 侧运行任务数统计（taskActivityTracker）行为不回归。
- T-M1 — blocking: yes — Step 24：长会话中 §N§ 标签按策略注入（manual）。
- T-M2 — blocking: yes — Step 24：`ctx_reduce` 后下一 pass 出现 `[dropped §N§]` 且连续 pass 字节级一致（单测 + manual）。
- T-M3 — blocking: no — Step 24：`ctx_expand` 能恢复被 drop 的原始内容（manual）。
- T-M4 — blocking: yes — Step 19b/24：wire-level 验证 m[0]/m[1] 进入 provider 请求且 synthetic 语义正确。
- T-M5 — blocking: yes — Step 24：prompt cache 命中（重复 pass 前缀 token 命中数稳定，不因 transform 抖动）。
- T-M6 — blocking: yes — Step 20/24：historian 后台产出 compartments 并在 m[0] 渲染中生效（manual）。
- T-M7 — blocking: yes — Step 15/24：schema fence 拒绝旧/新版本库；fail-closed 路径行为正确。
- T-M8 — blocking: yes — Step 19a/23：`features.magicContext:false` 时全链路与 Phase 1 基线零差异。
- T-M9 — blocking: yes — Step 26/27：压缩移除后：`/compact` 输入按普通文本处理或明确报"命令不存在"；v4 `compact` 命令已从 `CommandPayloadMap` 移除（`parseCommandEnvelope` 拒绝该 type 属预期，无发送方）；TUI/UI 无任何压缩 timeline 代码路径与文案 key。
- T-M10 — blocking: yes — Step 26：`features.compact` 配置键从 schema/ConfigKey 移除后，含旧键的历史 config.json 被安全剥离（`.passthrough()` 容忍）不报错。
- T-M11 — blocking: yes — Step 21/22：`ctx_reduce` 幂等 commandId 单测（同 invocation 重复调用不重复入队 pending ops）；`/ctx-status` 命令输出预算与 compartments 状态快照。
- T-M12 — blocking: yes — Step 27：i18n 压缩相关 key 全删后无缺失 key 告警（所有引用同步删净，含 TUI 状态文案与 timeline 文案）。
- T-U1 — blocking: yes — Step 29：设置 UI 修改 `execute_threshold_percentage` → `config.json` 原子落盘 → **不重启**在下一 turn 生效（ConfigPort.observe → ConfigSnapshot generation bump 热生效验证）。
- T-U2 — blocking: no — Step 30：`ChatContextUsage` 面板显示 magic-context 预算/compartments/dropped 状态（manual）。
- T-P1 — blocking: yes — Step 32：改名后安装、运行、数据目录、插件市场加载正常。
- T-P2 — blocking: no — Step 33：登录与 Coding Plan 可用（manual）。

## 风险与回滚方案

| # | 风险 | 概率/影响 | 缓解 | 回滚 |
|---|---|---|---|---|
| R1 | desktop 删除面大且无类型门禁，断链只能在运行时暴露 | 高/高 | Step 10 先补 `typecheck:desktop-full` 再删；knip 抓悬空导出 | tag 回退 |
| R2 | `conversationTelemetryFact` 误删导致任务统计静默归零 | 中/中 | D-8 方案 + T-T5 专项（断言点在 server 侧 `taskActivityTracker.ts`，与 UI 侧 supervisor/attachment 删除解耦） | 恢复 emitter 三文件 |
| R3 | ZCode 投影层对 synthetic/attachment 语义与 OpenCode 不同，m[0]/m[1] 被剔除或产生幻影 user 轮 | 中/高 | Step 19b 强制 wire-level 验证（T-M4）；`source.ts` 新源显式声明 providerVisibility | flag off |
| R4 | esbuild 把 `node:sqlite` 改写为 `require("sqlite")` 致构建/运行失败 | 中/高 | 保留变量间接动态 import 手法；构建产物 grep 验证 | 改 createRequire 形态 |
| R5 | zod 双根（shared/adapters/bootstrap=4.6.5，contracts=3.25.76）下 magic-context v4 schema 放错包导致 bundle 校验失败或双实例 | 中/中 | 决策已定：v4 代码只进 `adapters/src/config/schema.ts` 与新包；contracts 只写纯 TS 类型；ctx 工具契约 schema 走 v3 或手写 JSON Schema（见"依赖处理"） | 调整依赖或迁 schema 位置 |
| R6 | transform 热路径抖动导致 cache 命中率塌方且难定位 | 中/高 | 不可破坏契约 1/2 逐条照搬；T-M2/T-M5 字节级断言；LKG 保留 | flag off |
| R7 | `RawMessageProvider` 分页能力与 historian 分块需求不匹配 | 中/中 | Step 17 先全方法冒烟；不足则扩接口（改源码优势） | — |
| R8 | SEA 打包对新包资产/依赖收集遗漏 | 低/中 | Step 5 建 SEA 基线；新包零 native/wasm 依赖 | 关闭 SEA 用 tar 分发 |
| R9 | 上游快照同步与本仓改造冲突 | 中/中 | 改动收敛可枚举文件集；上游 SOP；L2/L3 不改 | 文件级 cherry-pick 重放 |
| R10 | `browser-use-plugin`/`bundled-skills` 资产残缺影响打包 | 中/低 | Step 4/5 专项核查；不在 CLI 闭包内 | 从官方 release 补资产 |
| R11 | 压缩移除触碰 v4 协议与持久化契约（compact 命令/marker/事件枚举/`part.type:"compaction"`）导致 UI 类型收窄错误或队列互斥逻辑漏改 | 中/中 | 无混版场景（桌面与 CLI 同仓同版发布），schema 直接删；`queueItemSchema` 继承 `conversationInputIntentSchema` 的 kind 收窄、`expectedHeldQueueItemIds` 互斥、`ConversationQueuePanel` 分支逐项核对；T-M9/T-M10 | tag 回退 |
| R12 | 配置热推送链路新增 strict schema 字段破坏旧 renderer 或漏改四处映射（schema/ConfigKey/merge/patch） | 中/中 | 仿 `app-runtime-preferences` 的 additive 演进；T-U1 端到端断言 | 设置页降级 requiresRestart 模式 |
| R13 | "compact" 一词误删：`formatCompactTokenNumber` 数字缩写、`density="compact"` 布局词、`context-usage-log-compact.ts` 用量快照裁剪、`compact_stream_boundary`/`preserveProviderStreamBoundaries` 流边界机制（historian 依赖） | 中/中 | 防误删清单已列入 Phase 2b 变更点；Step 28 残留扫描白名单同步；T-M12 缺失 key 告警 | 恢复 key/文件 |

**回滚总策略**：每 Phase 完成即 git tag（`baseline/v3.14.3` → `phase1/*` → `phase2a/*` → `phase2b/*` → `v0.1.0`）；Phase 2a 期间任何时刻 `features.magicContext:false` 回到原生行为；Phase 2b 之后回滚需回退到 `phase2a` tag（压缩已删，flag off = 无压缩直通）。

## 兼容性与迁移说明

- **定位（D-7 第三轮修订）**：完全魔改、无历史数据——压缩功能的产生侧与解析侧（schema、事件枚举、marker、`part.type:"compaction"`、resume 边界处理、i18n 渲染文案）全量删除，**不提供任何旧会话兼容层**；Phase 2b 之前的过渡期产生的会话（含压缩 part）在 Phase 2b 后不保证可 resume，属预期。
- **配置兼容**：`~/.zcode/cli/config.json` 的 `.passthrough()` 顶层容忍旧键（`features.compact` 移除后旧配置被安全剥离，属顺带鲁棒性而非迁移承诺）；新增 `features.magicContext`（Step 28 起默认 true）与 `magicContext` 参数域；不引入独立 `magic-context.jsonc`（D-12，配置真源唯一）。
- **协议面**：桌面与 CLI 同仓同版发布、无混版场景——v4 compact 命令/marker/snapshot 字段直接删除（非 additive 降级）；`conversationTelemetryFact` 保留是因 taskActivityTracker 的**实时业务**依赖（D-8），与旧数据无关；usage 扩展字段为 additive 可选。
- **Phase 3 数据目录**：`~/.zcode → ~/.omz` 新起，不做检测与迁移提示（无存量承诺）。
- **上游合规**：【勘误 2026-10-05】上游许可实为 ZCode=Apache-2.0、magic-context=**MIT**（撰写时误判为"双方 Apache-2.0"，S34 已按实际处理）：保留各自 LICENSE 与版权声明、NOTICE 标注修改、第三方声明重生成（详见 `omz/NOTICE.md` 与 `apps/zcode-cli/packages/magic-context/LICENSE.magic-context`）。
