---
round: r1
date: 2026-10-05
scope: phase-perf-probe / phase-baseline / phase-render-hot 取证
repo: D:\Dev\Js\oh-my-zcode\omz
docs:
  - docs/iterations/desktop-long-session-perf/prd.md
  - docs/iterations/desktop-long-session-perf/spec.md
files_read:
  # 度量
  - packages/ui/src/lib/memoryDiagnostics.ts
  - packages/shared/src/memoryDiagnostics.ts
  - packages/ui/src/App.tsx (:110-180)
  - packages/desktop/src/renderer/src/performanceTimelineCleanup.ts
  - packages/desktop/src/renderer/src/main.tsx (grep startPerformanceTimelineCleanup)
  - packages/ui/src/v4/commandAckObservability.ts
  - packages/ui/src/chat-input-toolbar/contextUsage.tsx (:795-820)
  - packages/ui/src/test-actions.ts
  - packages/ui/src/lib/shikiHighlighter.ts (:20-100)
  - packages/ui/src/v4/conversationProjectionStore.ts (:265-295, registry register)
  # CDP 脚本
  - .cu-shots/cdp-lib.mjs
  - .cu-shots/cdp-verify-historian.mjs
  - .cu-shots/acceptance-ctx-probe.mjs
  - .cu-shots/acceptance-prep.mjs
  - omz/.vscode/start-electron.mjs
  - omz/.vscode/vite-dev.mjs
  - omz/.vscode/tasks.json
  - omz/scripts/dev-desktop-env.mjs
  - omz/packages/desktop/scripts/dev.mjs
  - omz/packages/desktop/package.json
  - omz/package.json
  - omz/packages/desktop/src/main/index.ts (:175-215, :700-712, :1330-1425, :1705-1745)
  - omz/packages/desktop/src/main/desktopSecondInstanceDeepLink.ts
  - omz/packages/desktop/src/main/desktopDeepLinkUrl.ts
  - omz/packages/desktop/src/main/desktopRuntimeEnv.ts (:40-80)
  - omz/packages/desktop/src/renderer/index.html (<title>)
  # 脚本落位
  - omz/knip.json
  - omz/scripts/dev/zcode-stdio-tap.mjs (:1-30)
  - omz/AGENTS.md
  - omz/.oxlintrc.json
  - omz/tsconfig.base.json
  - omz/packages/ui/tsconfig.json
  - omz/packages/shared/tsconfig.json
  - omz/packages/services/tsconfig.json
  - omz/packages/shared/package.json
  - omz/packages/ui/package.json
  # render-hot 落点
  - omz/packages/ui/src/v4/ConversationTimeline.tsx (:1-12, :380-500, :540-690, :690-760, :1030-1050, :1150-1215, :1270-1350, :1690-1740, :1820-1880)
  - omz/packages/ui/src/v4/ConversationTurnRow.tsx (全文)
  - omz/packages/ui/src/v4/ConversationTurnGroup.tsx (:1-5, :91-160, :165-310, :550-620, :690-770, :1210-1225, :1460-1465)
  - omz/packages/ui/src/v4/ConversationTurnNavigator.tsx (全文)
  - omz/packages/ui/src/v4/conversationTurnNavigatorHelpers.ts (全文)
  - omz/packages/ui/src/v4/conversationTurnRenderUnits.ts (:55-80, :260-360, :385-440)
  - omz/packages/ui/src/v4/conversationTurnWorkSegments.ts (全文)
  - omz/packages/ui/src/v4/conversationWorkDuration.ts (全文)
  - omz/packages/ui/src/v4/ConversationRowView.tsx (:125-165, :1660-1710, RowShell 用点)
  - omz/packages/ui/src/v4/ConversationAgentToolCallRow.tsx (:55-90)
  - omz/packages/ui/src/v4/timelineRowHeightCache.ts (grep DEFAULT_ROW_HEIGHT_ESTIMATE_PX)
  - omz/packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx (grep durationMs / workStatus)
  - omz/packages/ui/src/v4/SessionPane.tsx (:3440-3470)
  - omz/packages/ui/test/nonCliAcpRetirement.test.ts
  - omz/packages/services/test/providerConfigMigration.test.ts
  - omz/packages/ui/src/i18n/locales/zh-CN.ts (grep workingFor / turnNavigator)
  - omz/packages/ui/src/i18n/locales/en-US.ts (grep)
---

# SPEC phase-perf-probe / phase-baseline / phase-render-hot 取证包（r1）

只陈述代码事实，不下结论、不给 Go/No-Go。

---

## 1）SPEC 该章节写了什么（逐条摘要 + 章节定位）

### 1.1 总体方案 A（spec.md:23-37）

| # | SPEC 断言 | 定位 |
|---|---|---|
| A-1 | 不用 CDP Tracing domain；页面内 `PerformanceObserver('longtask')` 已聚合好，evaluate 取回即可 | spec.md:25 |
| A-2 | 新增 `packages/ui/src/lib/perfProbe.ts`，dev-only，`import.meta.env.DEV` 门控 | spec.md:27 |
| A-3 | longtask 用**自持环形缓冲**，不用 performance.mark/measure——理由是 dev 下每 10s 被 `performanceTimelineCleanup` 清空 | spec.md:28 |
| A-4 | `sampleMemory()` 调新增的 `collectRendererMemorySample()`（纯读出口：`uiMemoryDiagnosticsRegistry.collect()` + `performance.memory`）；**注意不能暴露 `sampleNow()`——它只返回 boolean** | spec.md:29 |
| A-5 | `reset()/dump()` 输出分段报告（longtask 次数/总耗时/最大值 + 内存计数快照） | spec.md:30 |
| A-6 | 挂 `window.__zcodePerfProbe`（仿 `commandAckObservability.ts` 的 window 调试面范式）；`App.tsx:141` 附近加一行 `useEffect(() => startPerfProbe(), [])` | spec.md:31 |
| A-7 | 新增 `scripts/dev/long-session-perf-sample.mjs`，骨架抄 `.cu-shots/cdp-verify-historian.mjs` 的 `call/pending/sleep` 封装——`.cu-shots` 在仓库外不入库 | spec.md:32 |
| A-8 | 启动/复用 dev 实例（spawn `.vscode/start-electron.mjs` + `--open-workspace <path>`；**先探测 9229 处理 single-instance 锁**——已有实例时 spawn 的进程会静默 `app.quit()`） | spec.md:33 |
| A-9 | 轮询 `http://127.0.0.1:9229/json/list` 找 `title === "ZCode"` 的 renderer target | spec.md:34 |
| A-10 | 驱动流式窗口 + 滚动窗口（`Input.dispatchMouseEvent` 或 evaluate 派发 scroll） | spec.md:35 |
| A-11 | `Runtime.evaluate` 调 `__zcodePerfProbe.reset()/sampleMemory()/dump()` 分段取数 → JSON 报告到 workspace docs | spec.md:36 |
| A-12 | 基线用真实长会话（参数化 workspace + sessionId + 行数断言），改动前采集 `baseline-before.json` 并回填 PRD 阈值 | spec.md:37 |

### 1.2 总体方案 B（spec.md:39-44）

| # | SPEC 断言 | 定位 |
|---|---|---|
| B-1 | liveNowMs 解耦：`ConversationTimeline.tsx:408-416` 的 `renderUnits` useMemo deps 去掉 `liveNowMs`；「工作中 N 秒」文案改为 `ConversationTurnGroup` 内部局部 tick（独立 state + ref，只重渲染计时文本所在小组件） | spec.md:41 |
| B-2 | 滚动 O(N) 消除：`conversationTurnNavigatorHelpers.ts:227` 的 `new Map(items.map(...))` 提到组件侧 `useMemo([items])` 构造后传入（items 已按 unitIndex 有序，也可二分） | spec.md:42 |
| B-3 | `activeUnitIndex`（`ConversationTurnNavigator.tsx:76-85`）不再依赖逐帧 `scrollOffsetPx`，改为按行高量化（`Math.floor(scrollOffsetPx / 10)` 变化才重算） | spec.md:42 |
| B-4 | reflow 消除：`syncTurnNavigatorViewport`（`ConversationTimeline.tsx:906-937`）的 `querySelectorAll("[data-row-id]")` + `getBoundingClientRect()` 改为 rowId → element 的 ref 注册 Map（`ConversationTurnRow` 挂载注册/卸载注销） | spec.md:43 |
| B-5 | 摘要截断前置：`buildPreviewText`（`conversationTurnNavigatorHelpers.ts:119-135`）先 `slice` 到上限再分段清洗，避免长回复全文正则扫描 | spec.md:44 |

### 1.3 详细实现步骤 Step 1-8（spec.md:136-143）

| Step | SPEC 断言 | 定位 |
|---|---|---|
| 1 | `memoryDiagnostics.ts` 抽出 `collectRendererMemorySample(): MemorySample` 纯读函数（复用 `uiMemoryDiagnosticsRegistry.collect()` + `readRendererHeapSnapshot`，不经写盘门控），qa: auto | spec.md:136 |
| 2 | 新增 `perfProbe.ts`（longtask 自持环形缓冲 + `sampleMemory()` + `reset()/dump()` 分段报告），挂 `window.__zcodePerfProbe`，`App.tsx` 一行接入，`import.meta.env.DEV` 门控，qa: auto | spec.md:137 |
| 3 | 新增 `scripts/dev/long-session-perf-sample.mjs`（CDP 骨架复用、single-instance 探测、流式/滚动窗口驱动、JSON 报告输出）；knip 登记如需，qa: manual_user | spec.md:138 |
| 4 | 真实长会话采集改动前基线 → `baseline-before.json`，回填 PRD 阈值判定线，qa: manual_user | spec.md:139 |
| 5 | liveNowMs 解耦（renderUnits deps 去除 + 计时文案局部 tick），qa: auto | spec.md:140 |
| 6 | 滚动 O(N) 消除（Map 索引 useMemo 化 + active 行高量化），qa: auto | spec.md:141 |
| 7 | reflow 消除（rowId→element ref 注册替代 querySelectorAll），qa: auto | spec.md:142 |
| 8 | P1 后中期采样对比（验证单项收益），blocking: no，qa: manual_user | spec.md:143 |

### 1.4 T-PA1 / T-PA2（spec.md:163-164）

| # | SPEC 断言 | 定位 |
|---|---|---|
| T-PA1 | blocking: yes — perfProbe：注入长任务（同步 busy loop）后 `dump()` 能捕获 longtask 条目；`reset()` 清空（→ Step 2） | spec.md:163 |
| T-PA2 | blocking: yes — `collectRendererMemorySample()` 返回**全部 7 类已注册计数器** + heap 字段（→ Step 1） | spec.md:164 |

### 1.5 最终项目结构相关行（spec.md:83-88, 95-96, 99-103, 111）

| # | SPEC 断言 | 定位 |
|---|---|---|
| F-1 | 新增 `packages/ui/src/lib/perfProbe.ts`、`packages/ui/test/perfProbe.test.ts`（"可选"探针单测，`*.test.ts` 豁免 max-lines） | spec.md:83-84 |
| F-2 | 新增 `scripts/dev/long-session-perf-sample.mjs`（先例 `scripts/dev/zcode-stdio-tap.mjs`） | spec.md:87 |
| F-3 | 修改 `packages/ui/src/App.tsx` +1 行接入 `startPerfProbe` | spec.md:95 |
| F-4 | 修改 `packages/ui/src/lib/memoryDiagnostics.ts` 抽出 `collectRendererMemorySample()` | spec.md:96 |
| F-5 | 修改 `ConversationTimeline.tsx`（liveNowMs 解耦 + …+ ref 注册） | spec.md:99 |
| F-6 | 修改 `ConversationTurnGroup.tsx`（计时文案局部 tick） | spec.md:100 |
| F-7 | 修改 `ConversationTurnRow.tsx`（rowId→element 注册） | spec.md:101 |
| F-8 | 修改 `ConversationTurnNavigator.tsx`（items 合并数据源 + active 量化） | spec.md:102 |
| F-9 | 修改 `conversationTurnNavigatorHelpers.ts`（Map 索引提出 + 截断前置 + 目录项类型） | spec.md:103 |
| F-10 | 修改 `knip.json` —— "scripts/dev 新脚本如报警需登记 entry" | spec.md:111 |

### 1.6 风险表相关行（spec.md:185-187）

| # | SPEC 断言 | 定位 |
|---|---|---|
| R-1 | max-lines 门禁实际口径不明（transport.ts 等已超 400），中风险，靠 Step 0 前置验证 | spec.md:185 |
| R-2 | 基线采集受 single-instance 锁 / 9229 端口冲突干扰，低风险，靠脚本前置探测 + 文档写明独占 dev 实例 | spec.md:186 |
| R-3 | 生产包无法采指标，已接受（基线与验收均在 dev build 下采） | spec.md:187 |

---

## 2）代码对应事实

### 2.1 度量基建（对应 A-2..A-6、Step 1-2、T-PA1/T-PA2）

| SPEC 断言 | 代码事实（文件:行 · 符号） | 判定 |
|---|---|---|
| A-4 / Step 1：`uiMemoryDiagnosticsRegistry.collect()` 存在 | **存在**。`packages/shared/src/memoryDiagnostics.ts:168` `collect(): Record<string, number>` 在 `MemoryDiagnosticsRegistry` 接口上；实现在 `:184-198` `createMemoryDiagnosticsRegistry()` 的 `collect()`。逐个调用 provider，键以 `<name>.` 为前缀，单 provider 抛错只跳过自己 | ✅ 断言成立（非硬伤） |
| A-4：`sampleNow()` 只返回 boolean | **成立**。`packages/ui/src/lib/memoryDiagnostics.ts:45` `sampleNow(): boolean`；`:58-82` 实现里 `gate.evaluate(...)` 为 null 时 `return false`，写盘后 `return true`，catch 里 `return false` | ✅ 断言成立 |
| Step 1：`readRendererHeapSnapshot` 可复用 | **是模块私有函数，未导出**。`packages/ui/src/lib/memoryDiagnostics.ts:25-34` `function readRendererHeapSnapshot()`（无 `export`）。同文件内抽取 `collectRendererMemorySample()` 可直接用，无需导出 | ✅ 可行（同文件内） |
| Step 1：返回类型 `MemorySample` | **字段确认**：`packages/shared/src/memoryDiagnostics.ts:20-24` `MemorySample extends MemorySampleFields`（`rssKb/heapUsedKb/heapTotalKb/externalKb/arrayBuffersKb` 可选）+ `role: MemorySampleRole` + `counters: Record<string, number>`。注意 `role` 是**必填**，renderer 侧现有写法固定为 `"renderer"`（`memoryDiagnostics.ts:63`） | ✅ 类型存在，但 `role` 必填这一约束 SPEC 未提 |
| T-PA2：「全部 **7 类**已注册计数器」 | **实测恰好 7 个 register 调用**（`packages/ui` 内）：<br>1. `packages/ui/src/hooks/useZCodeTaskService.ts:36` `"taskSnapshotCache"`<br>2. `packages/ui/src/lib/shikiHighlighter.ts:64` `"shiki"`<br>3. `packages/ui/src/store/taskQueryCacheStore.ts:1014` `"taskQueryCache"`<br>4. `packages/ui/src/store/zcodeSessionStore.ts:51` `"sessionStore"`<br>5. `packages/ui/src/terminal/sidePaneTerminalSessionRegistry.ts:57` `"xterm"`<br>6. `packages/ui/src/ToolCallBlocks/ToolLayout.tsx:18` `"toolLayout"`<br>7. `packages/ui/src/v4/conversationProjectionStore.ts:272` `"projection"` | ✅ 数量对得上，但见 §3 疑点 P-2（可测性） |
| A-6：`App.tsx:141` 附近是接入点 | **确认**。`packages/ui/src/App.tsx:139-144`：注释「进程内存本地诊断日志：每窗口一个 60s 采样器」+ `useEffect(() => { const memoryDiagnosticsLogger = startMemoryDiagnosticsLogger(); return () => memoryDiagnosticsLogger.stop(); }, [])`。`:141` 正是 `useEffect(` 那一行 | ✅ 行号精确 |
| A-6：window 调试面范式（`commandAckObservability.ts`） | **存在**。`packages/ui/src/v4/commandAckObservability.ts:16-18` `type V4AckDebugWindow = Window & { __zcodeV4CommandAcksE2E?: V4CommandAckSummary[] }`，`:22` `host.__zcodeV4CommandAcksE2E ??= []`，`:25-27` 超过 `MAX_ACK_ENTRIES = 50` 用 `splice` 裁剪（环形缓冲先例）。另一处 window 桥先例：`packages/ui/src/test-actions.ts:45-49` `declare global { interface Window { __testActions?: TestActions } }` + `:59` 赋值 | ✅ 范式存在（两种写法都有） |
| A-3：dev 下 performance timeline 每 10s 被清空 | **完全成立**。`packages/desktop/src/renderer/src/performanceTimelineCleanup.ts:1` `PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS = 10_000`；`:6` `if (!import.meta.env.DEV || cleanupTimer != null) return;`；`:13-16` `setInterval(() => { window.performance.clearMeasures(); window.performance.clearMarks(); }, 10_000)`。调用点：`packages/desktop/src/renderer/src/main.tsx:30` import、`:42` `startPerformanceTimelineCleanup()` | ✅ 断言成立（10s / DEV 门控 / marks+measures 都对上） |
| A-2：`import.meta.env.DEV` 在 `packages/ui` 的先例 | **只有 1 处**：`packages/ui/src/chat-input-toolbar/contextUsage.tsx:811` `showBelowThreshold: import.meta.env.DEV`（用作 UI 展示开关，不是模块门控）。<br>**模块级 DEV 门控的真正先例在 desktop 包**：`performanceTimelineCleanup.ts:6`。ui 包内的门控范式另有 `import.meta.env.PROD`：`packages/ui/src/test-actions.ts:58` `if (import.meta.env.PROD && !shouldExposeE2EStoreBridge()) return;`<br>类型声明来源：`packages/ui/src/test-actions.ts:8-12` `declare global { interface ImportMeta { env: { PROD: boolean; DEV: boolean; [key: string]: unknown } } }` —— **这条 declare 只存在于 `test-actions.ts` 一个文件**，`perfProbe.ts` 若要用需依赖该全局声明已被项目包含（ui tsconfig `include: ["src/**/*.ts", ...]` 覆盖 `test-actions.ts`，所以全局声明在编译期可见） | ✅ 可行，但 ui 包内无「模块级 DEV 门控」先例（详见 §3 疑点 P-3） |
| A-5：`reset()/dump()` 分段报告 | 无既有先例可对照（纯新增） | — |

### 2.2 CDP 采样脚本（对应 A-7..A-12、Step 3-4）

| SPEC 断言 | 代码事实 | 判定 |
|---|---|---|
| A-7：骨架可抄 `cdp-verify-historian.mjs` 的 `call/pending/sleep` | **成立**。`D:\Dev\Js\oh-my-zcode\.cu-shots\cdp-verify-historian.mjs:6-19`：<br>`:6` `fetch("http://127.0.0.1:9229/json/list")` → `:7` `list.find((t) => t.title === "ZCode")`<br>`:11-13` `let id = 0; const pending = new Map();` + `ws.onmessage` 按 `m.id` 取 resolve<br>`:17-18` `const call = (method, params) => new Promise(...)` 用 `++id` + `pending.set` + `ws.send`<br>`:19` `const sleep = (ms) => new Promise((r) => setTimeout(r, ms))`<br>另 `cdp-lib.mjs:1-30` 是**单步**版（`node cdp-step.mjs '<expr>'`，15s 硬超时 `setTimeout(...,15000)`，退出码 0/2/3/4），`acceptance-ctx-probe.mjs:2-14` 是同一 call/pending 形状的另一个副本 | ✅ 骨架可复用（三份同形状脚本，形状一致） |
| A-7：`.cu-shots` 在仓库外不入库 | **成立**。omz 的 git 顶层是 `D:/Dev/Js/oh-my-zcode/omz`（`git rev-parse --show-toplevel`）；`D:\Dev\Js\oh-my-zcode` 本身 **不是 git 仓库**（同命令 fatal）。`.cu-shots` 与 `docs/` 都在 omz 之外 | ✅ 断言成立 |
| A-9：`title === "ZCode"` 能定位 renderer target | **有条件成立**。`packages/desktop/src/renderer/index.html:6` `<title>ZCode</title>` —— 这是**页面 title**，主窗口 `BrowserWindow` 未显式设 title（`packages/desktop/src/main/index.ts` 内 `title:` 只出现在 `:1169` 退出确认框与 `:1412` 更新状态窗 `title: ""`），主窗口 title 由页面 title 决定，故 CDP target title 为 `"ZCode"`。<br>但注意 dev 运行时 **app name 不是 ZCode**：`packages/desktop/src/main/desktopRuntimeEnv.ts:58-60` `runtimeApplicationName = ... (isLocalDevelopmentRuntime ? "ZCode Dev" : ...)`，`index.ts:197` `app.setName(runtimeApplicationName)` —— app name 影响 userData 目录（`desktopRuntimeEnv.ts:69-72` `join(getElectronAppPath("appData"), runtimeApplicationName)`），**不影响 CDP page target title** | ✅ target title 匹配可行 |
| A-8：`spawn .vscode/start-electron.mjs` + `--open-workspace <path>` | **脚本不接受位置参数**。`omz/.vscode/start-electron.mjs` 全文 55 行：`:7` 只读 `process.argv.includes("--host-inspect")`；`:29` `spawn(electronExecutable, ["--inspect-brk=9231", "."], {...})` —— **spawn 参数硬编码，不透传任何额外 argv**。传 `--open-workspace <path>` 给它会被完全忽略 | ❌ 见 §3 疑点 S-1（硬伤） |
| A-8：`ELECTRON_RENDERER_URL` | `start-electron.mjs:36` 硬编码 `ELECTRON_RENDERER_URL: "http://localhost:5174"`（注释解释必须走 localhost 而非 127.0.0.1）。**且该脚本不启动 vite/tsup** —— `.vscode/tasks.json` 显示它 `dependsOn: ["zcode: prepare desktop debug"]`（= `tsup watch` + `vite dev` 两个后台任务，`:zcode: vite dev` 实为 `.vscode/vite-dev.mjs`，其内部 spawn `pnpm --filter @zcode/desktop exec vite dev`） | ⚠️ 见 §3 疑点 S-2 |
| A-8：另一条更完整的 dev 启动路径存在 | `omz/packages/desktop/scripts/dev.mjs`：`:64-113` `waitForReady()` 等三个 tsup ready marker（`out/.main-build-ready` 等）+ 探测 vite（`localhost/127.0.0.1/[::1]:5174` 三地址轮询）；`:129` `spawn(electronCommand, ["."], { cwd: root, env: {...process.env, ELECTRON_RENDERER_URL: rendererUrl} })`。同样**只传 `["."]`，不透传 argv**。<br>而 `pnpm dev:desktop` → `pnpm dev:desktop:prod` → `scripts/dev-desktop-env.mjs production` → `pnpm --filter @zcode/desktop dev:runtime` = `concurrently tsup --watch / vite dev / node scripts/dev.mjs`。**注意 `dev:desktop` 走的是 `production` 分支**（`ZCODE_ENV=production`） | ⚠️ 见 §3 疑点 S-2（口径） |
| A-8：single-instance 锁「已有实例时 spawn 的进程会静默 `app.quit()`」 | **完全成立**。`packages/desktop/src/main/index.ts:1707` `const gotTheLock = app.requestSingleInstanceLock(createDeepLinkSingleInstanceData(process.argv));`、`:1708-1710` `if (!gotTheLock) { app.quit(); }`。注意 `app.quit()` 后**没有 return**，`:1711` 仍注册 `second-instance` 监听、`:1747` 仍 `app.whenReady().then(...)` | ✅ 断言成立（且无提前 return，行为更复杂） |
| A-8：`--open-workspace` 深链 | **成立**。`packages/desktop/src/main/desktopDeepLinkUrl.ts:9` `const OPEN_WORKSPACE_ARG = "--open-workspace";`、`:224-249` `extractOpenWorkspacePathFromArgs()` 同时支持 `--open-workspace <path>` 与 `--open-workspace=<path>` 两种形态；`index.ts:701` `const startupOpenWorkspaceArgPath = extractOpenWorkspacePathFromArgs(process.argv);`、`:708-709` 作为 startup workspace 来源。second-instance 路径：`packages/desktop/src/main/desktopSecondInstanceDeepLink.ts:59-72` 优先读 `additionalData`（`createDeepLinkSingleInstanceData` 打包，`:251-258`），回退 argv，再走 `handleOpenWorkspacePath`（`index.ts:1719-1726`，带 `allowWithoutReadyWindow: true`） | ✅ 深链机制成立（两种 argv 形态 + additionalData 双通道） |
| 9229 开关 | **成立**。`packages/desktop/src/main/index.ts:190-195`：注释解释 e2e 由 Chromedriver 接管端口，`if (!app.isPackaged && process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT !== "1") { app.commandLine.appendSwitch("remote-debugging-port", "9229"); }` | ✅ 断言成立（dev 未打包 → 默认开；可用 env 关） |
| A-10：`Input.dispatchMouseEvent` 滚轮 | 三份参考脚本均未使用 `Input` domain，只用 `Runtime.evaluate` 派发 `PointerEvent` / `click()`（`cdp-verify-historian.mjs:26-27, 47-48`）。`Input.dispatchMouseEvent` 无先例但属标准 CDP domain | ⚠️ 无先例 |
| A-12：`baseline-*.json` 落 workspace docs | 成立（`docs/` 在 omz 仓库外，见 §2.2 第 2 条） | ✅ |

### 2.3 脚本落位与 knip（对应 F-2、F-10、R-1）

| SPEC 断言 | 代码事实 | 判定 |
|---|---|---|
| F-2：先例 `scripts/dev/zcode-stdio-tap.mjs` | **文件存在**：`omz/scripts/dev/zcode-stdio-tap.mjs`（含 `#!/usr/bin/env node`，`parseArgs` 用 `--` 分隔）。`dir /b scripts\dev` 只有这一个文件 | ✅ 先例存在 |
| F-10 / Step 3：`knip.json` 需登记 `scripts/dev` 新脚本 entry | **当前 `scripts/dev/zcode-stdio-tap.mjs` 就是 knip 报的未使用文件**。实测 `npx knip --reporter symbols` 输出 `Unused files (34)`，第 8 行即 `scripts/dev/zcode-stdio-tap.mjs`。`knip.json:6-11` 根 workspace `entry` 只列了 `.release-it.mjs`、`.vscode/*.mjs`、`scripts/check-workspace-freshness.mjs`、`scripts/mise-run.mjs` —— **`scripts/dev/**` 没有任何 entry 也没有 ignore**。<br>另：`package.json` 无任何 `scripts/dev` 引用（只有 `scripts/dev-desktop-env.mjs` 等根级脚本） | ✅ 断言成立（新增脚本必被 knip 报 unused，除非登记 entry） |
| R-1 / Step 0：max-lines 400 实际口径不明 | **已可判定：口径是「文件顶部 disable 注释豁免」**。<br>`.oxlintrc.json` 顶层 `rules: { "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }] }`，`overrides` 里 `**/*.test.ts(x)` / `**/*.spec.ts(x)` 与 `**/i18n/locales/*.ts` 关掉 max-lines。<br>实测行数 vs 首行 disable：<br>• `packages/shared/src/zcode-protocol-v4/transport.ts` = **1145 行**，首行 `/* eslint-disable max-lines -- ... */`<br>• `packages/ui/src/v4/conversationProjectionStore.ts` = **1383 行**，首行 `/* eslint-disable max-lines -- ... */`<br>• `packages/ui/src/v4/ConversationTurnGroup.tsx` = **1465 行**，首行 `/* eslint-disable max-lines -- ... */`<br>• `packages/ui/src/v4/ConversationTimeline.tsx` = **1956 行**，首行 `/* oxlint-disable eslint(max-lines) -- ... */`（注意前缀是 `oxlint-disable` 而非 `eslint-disable`）<br>• `packages/ui/src/App.tsx` = 1277 行，首行 `/* eslint-disable max-lines -- ... */`<br>实测 `npx oxlint packages/ui/src/v4/ConversationTimeline.tsx --deny-warnings` → `Found 0 warnings and 0 errors`（**已超 400 行但当前通过**）<br>**未豁免且接近上限**：`packages/ui/src/v4/conversationTurnNavigatorHelpers.ts` = **332 行**、`:ConversationTurnNavigator.tsx` = 255 行 | ✅ Step 0 的疑问现在有答案（见 §3 疑点 R-1a） |
| architecture:check 基线是否干净 | 实测 `node scripts/architecture/architecture-check.mjs check --changed` → `architecture: OK / violations: 0 / baseline: 0 / new: 0` | ✅ 当前干净 |
| SPEC 测试策略「`packages/ui/test/`、`packages/services/test/` 按 node:test 先例」 | `packages/ui/test/` 只有 `nonCliAcpRetirement.test.ts`（`import assert from "node:assert/strict"; import test from "node:test"`）；`packages/services/test/` 有 3 个同形状文件。<br>**但实测 `npx tsx --test packages/ui/test/nonCliAcpRetirement.test.ts` 直接失败**：`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@/lib' imported from .../packages/ui/src/lib/toolIdentity.ts`（`# pass 0 / # fail 1`）。<br>对照组：`npx tsx --test packages/services/test/providerConfigMigration.test.ts` → `# pass 3 / # fail 0`（services 那批只 import 相对路径 + `@zcode/*` 包名，不碰 `@/` 别名） | ⚠️ 见 §3 疑点 P-1（ui 侧 node:test 现状即红） |

### 2.4 render-hot 落点（对应 B-1..B-5、Step 5-8、F-5..F-9）

| SPEC 断言 | 代码事实 | 判定 |
|---|---|---|
| B-1：`ConversationTimeline.tsx:408-416` 是 liveNowMs + renderUnits deps | **行号精确命中**。`:408` `const [liveNowMs, setLiveNowMs] = useState(() => Date.now());`；`:409-416` `const renderUnits = useMemo(() => buildConversationTurnRenderUnits(rows, { nowMs: liveNowMs, sessionPhase }), [liveNowMs, rows, sessionPhase]);` | ✅ 行号精确 |
| B-1：`RUNNING_WORK_DURATION_TICK_MS` 值与用途 | `packages/ui/src/v4/ConversationTimeline.tsx:97` `const RUNNING_WORK_DURATION_TICK_MS = 1000;` —— **1 秒**。用途唯一：`:562-575` 的 `useEffect`，deps `[hasRunningUnit]`；`:569` 先立即 `setLiveNowMs(Date.now())`，`:570-572` `window.setInterval(() => setLiveNowMs(Date.now()), RUNNING_WORK_DURATION_TICK_MS)`；有 running unit 时才起 | ✅ 值与用途确认（1000ms，唯一消费点） |
| B-1：liveNowMs 除 renderUnits 外还有哪些消费者 | **零个其他消费者**。全仓 grep `liveNowMs` 只有 3 处，全在 `ConversationTimeline.tsx`：`:408`（state 声明）、`:412`（`nowMs: liveNowMs`）、`:415`（deps）。<br>`setLiveNowMs` 也只有 `:569`、`:571` 两处调用 | ✅ 确认：除 renderUnits 外无其他消费者，解耦不会漏改 |
| B-1：「工作中 N 秒」文案的真实消费组件 | **不是 `ConversationTurnGroup` 顶层，而是其内部的 `AssistantHistoryStatus` 子组件**。链路：<br>`liveNowMs` → `buildConversationTurnRenderUnits(rows, {nowMs})` → `conversationTurnRenderUnits.ts:323` `nowMs: options.nowMs` 传给 `buildConversationTurnWorkSegments` → `conversationTurnWorkSegments.ts:182` → `resolveSegmentDurationMs({..., nowMs})`（`:96-132`，running 分支 `:113-114`/`:128-129` 用 `nowMs - startedAt`）→ `segment.workStatus.durationMs` → **渲染点 `packages/ui/src/v4/ConversationTurnGroup.tsx:565-610` `function AssistantHistoryStatus({segment, open})`**，`:573-577` `formatConversationWorkDuration(segment.workStatus?.durationMs, intl, locale)`，`:581-582` running 时 `intl.formatMessage({ id: "chat.history.workingFor" }, { duration: durationLabel ?? "" })`，`:596` `<span className="truncate">{label}</span>`。<br>调用点两处：`ConversationTurnGroup.tsx:757` 与 `:763`（都在 `ConversationWorkSegmentFlow` 内）。<br>i18n key 存在：`packages/ui/src/i18n/locales/zh-CN.ts:4358` `"chat.history.workingFor": "工作中 {duration}"`；`en-US.ts:4656` `"Working for {duration}"`。<br>格式化函数：`packages/ui/src/v4/conversationWorkDuration.ts:16-39` `formatConversationWorkDuration`（秒→天/时/分/秒，`:38` `parts.slice(0, 2)` 只取两段） | ⚠️ 见 §3 疑点 R-2（SPEC 说的落点组件对，但 SPEC 未提 `AssistantHistoryStatus` 是 `ConversationTurnGroup` 的**内部**函数组件，非独立文件组件） |
| B-1：另一处 durationMs 消费（share 只读面） | `packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx:789` `formatConversationWorkDuration(segment.workStatus?.durationMs, intl, locale)` + `:791-793` 同样的 `workingFor` 分支。该文件 `:1084` 调 `buildConversationTurnRenderUnits(rows)` **不传 nowMs**，`:642`（`SessionPane.tsx`）同样不传 | ✅ 不受影响（无 nowMs 输入） |
| B-1：`AssistantHistoryStatus` 是否已是 memo 边界 | **不是**。`packages/ui/src/v4/ConversationTurnGroup.tsx:565` 是裸 `function`，无 `memo`；其外层 `ConversationTurnGroup` 在 `:1465` `export const ConversationTurnGroup = memo(ConversationTurnGroupImpl)`。SPEC 说「只重渲染计时文本所在小组件」—— 需要把 tick state 放进 `AssistantHistoryStatus`（或新抽一个 memo 计时组件）才能成立 | ⚠️ 见 §3 疑点 R-2 |
| B-2：`conversationTurnNavigatorHelpers.ts:227` 是 `new Map(items.map(...))` | **行号精确命中**。`:227` `const itemByUnitIndex = new Map(items.map((item) => [item.unitIndex, item]));`，位于 `resolveConversationTurnNavigatorActiveUnitIndex`（`:217-268`）内部 | ✅ 行号精确 |
| B-2：「items 已按 unitIndex 有序」 | **成立**。`buildConversationTurnNavigatorItems`（`:169-211`）用 `units.flatMap((unit, unitIndex) => ...)`（`:179`）并把 `unitIndex` 直接写进 item（`:196` `unitIndex`），所以输出按 `units` 顺序单调不减 | ✅ 断言成立 |
| B-3：`ConversationTurnNavigator.tsx:76-85` 是 `activeUnitIndex` useMemo 及其 deps | **行号精确命中**。`:76-85`：<br>`:76-78` `const activeUnitIndex = useMemo(() => resolveConversationTurnNavigatorActiveUnitIndex({ items, scrollOffsetPx, viewportHeightPx, virtualItems }),`<br>`:84` `    [items, scrollOffsetPx, viewportHeightPx, virtualItems],`<br>`:85` `  );` | ✅ 行号精确 |
| B-3：`Math.floor(scrollOffsetPx / 10)` 的「行高 10」假设从哪来 | **10 是 rail（导航条）自己的行高，不是主时间线的行高**。<br>`ConversationTurnNavigator.tsx:110-116` `useVirtualizer({ count: items.length, estimateSize: () => 10, getItemKey, getScrollElement, overscan: 6 })` —— 这是**右侧 rail 的 virtualizer**，`:168` 渲染 `className="absolute left-0 top-0 h-2.5 w-9"`（`h-2.5` = 10px），一致。<br>而传进 `resolveConversationTurnNavigatorActiveUnitIndex` 的 `virtualItems` 来自**主时间线**：`ConversationTimeline.tsx:737-753` `turnNavigatorVirtualItems = useMemo(...)`，`:738-742` 直接由主 `virtualRows`（`:735 virtualizer.getVirtualItems()`）映射 `{index, size, start}`；`:744-752` live tail 用 `size: Number.MAX_SAFE_INTEGER - totalSize`。主时间线的行高估计是 `packages/ui/src/v4/timelineRowHeightCache.ts:11` `DEFAULT_ROW_HEIGHT_ESTIMATE_PX = 72`（且 `ConversationTimeline.tsx:693-700` 走 `heightCacheRef` 实测高度 + `:703-712` `measureElement` 动态测高）。<br>`scrollOffsetPx` 也来自主 virtualizer：`ConversationTimeline.tsx:1705` `scrollOffsetPx={virtualizer.scrollOffset ?? turnNavigatorViewport.scrollOffsetPx}` | ❌ 见 §3 疑点 R-3（硬伤：单位不匹配） |
| B-4：`syncTurnNavigatorViewport` 在 `ConversationTimeline.tsx:906-937` | **行号基本命中（结束行是 940 而非 937）**。`:906-907` `const syncTurnNavigatorViewport = useCallback((element: HTMLDivElement) => {`；`:909` `const viewportRect = element.getBoundingClientRect();`；`:910` `const queryPositions: ConversationTurnNavigatorQueryPosition[] = [];`；**`:911` `for (const rowElement of element.querySelectorAll<HTMLElement>("[data-row-id]")) {`**；`:912` `const rowId = Number(rowElement.dataset.rowId);`；`:913` `if (!Number.isSafeInteger(rowId) \|\| !turnNavigatorQueryRowIdsRef.current.has(rowId)) { continue; }`；`:916` `const rowRect = rowElement.getBoundingClientRect();`；`:925-929` `resolveConversationTurnNavigatorActiveQueryRowId({positions, scrollOffsetPx, viewportHeightPx})`；`:931-937` `setTurnNavigatorViewport(...)` 带三元去重；`:938-940` 收尾 `}, [syncMessageLayerMask]);` | ✅ 基本准确（SPEC 写 937，实际函数体到 937、闭包到 940） |
| B-4：`turnNavigatorQueryRowIdsRef` 过滤逻辑 | **成立**。`ConversationTimeline.tsx:422-430` `turnNavigatorQueryRowIds = useMemo(() => new Set(renderUnits.flatMap((unit) => unit.visibleUserInputs.filter((row) => row.origin === "realUser").map((row) => row.rowId))), [renderUnits])`；`:431-432` `const turnNavigatorQueryRowIdsRef = useRef(...); turnNavigatorQueryRowIdsRef.current = turnNavigatorQueryRowIds;`；消费点唯一是 `:913` | ✅ 成立（**该 Set 本身也依赖 renderUnits**，所以 renderUnits 每秒重建 → 该 Set 每秒重建 → 但 Set 只在 ref 里不触发渲染） |
| B-4：`ConversationTurnRow` 有无「现成的 rowId/ref 挂载点」可注册 | **`ConversationTurnRow.tsx` 里没有任何 DOM、没有 ref、没有 data-row-id**。全文 104 行：`:43-81` `ConversationTurnRow` 只是把 props 透传给 `:62 <ConversationRowView row={row} context={context} ... />`；另一个导出 `:83-103 resolveAssistantCopyText(unit)` 是纯函数。<br>`data-row-id` 的真实产地有 4 处：<br>1. `packages/ui/src/v4/ConversationRowView.tsx:130-148` `function RowShell({rowId, children, className})` → `:141 data-row-id={rowId}`（+ `:142 data-testid`）。`RowShell` 在 `ConversationRowView.tsx` 内被调用 **14 次**：`:152`、`:1040/:1182`、`:1187/:1298`、`:1490/:1561`、`:1583`、`:1602`、`:1862`、`:1903`、`:1925/:2007`、`:2021`<br>2. `ConversationRowView.tsx:1678` 与 `:1693`（timelineMarker button / div 两形态）<br>3. `packages/ui/src/v4/ConversationTurnGroup.tsx:181`（`ConversationExploreGroupRow`）、`:240`（`ConversationToolGroupRow`）、`:298`（`ConversationCuaGroupRow`）<br>4. `packages/ui/src/v4/ConversationAgentToolCallRow.tsx:71`<br>另有消费者 `packages/ui/src/v4/ConversationSelectionTooltip.tsx:36` `element?.closest<HTMLElement>("[data-row-id]")` | ❌ 见 §3 疑点 R-4（硬伤：SPEC 指名的落点组件里没有挂载点） |
| B-4：`querySelectorAll` 的实际扫描范围 | `element` 是滚动容器（`scrollRef.current`），而 `data-row-id` 元素**大量嵌套在未挂载的虚拟行内**（主 virtualizer 只渲染窗口 + overscan）。所以每次 `syncTurnNavigatorViewport` 的 `querySelectorAll` 是 O(已挂载 DOM 节点数)，不是 O(N rows)；但 `getBoundingClientRect` 每个命中 row 一次 = O(可见 query 数) 强制 reflow。调用点 7 处：`:1038`（贴底 effect）、`:1163`（restoreScrollMemory）、`:1198`（`handleScroll`，**每次 scroll 事件**）、`:1297`（scrollToQuery 内）、`:1387`、`:1594`、`:1652` | ✅ 事实清楚（见 §3 疑点 R-4b） |
| B-5：`buildPreviewText` 在 `conversationTurnNavigatorHelpers.ts:119-135` | **行号精确命中**。`:119-135` 整个 `function buildPreviewText({texts, fallback, maxPreviewChars, maxPreviewParagraphs})`：`:130` `const paragraphs = normalizePreviewParagraphs(texts.join("\n\n"), maxPreviewParagraphs);` → `:134` `return truncatePreview(paragraphs.join("\n"), maxPreviewChars);`<br>上游：`:102-109` `normalizePreviewParagraphs`（`text.trim().split(/\n\s*\n/u).map(p => p.replace(/\s+/gu, " ").trim()).filter(Boolean).slice(0, Math.max(1, maxParagraphs))`）；`:111-117` `truncatePreview`（`:116` `${text.slice(0, normalizedMaxChars - 3).trimEnd()}...`）<br>口径常量：`:99` `DEFAULT_MAX_PREVIEW_CHARS = 220`、`:100` `DEFAULT_MAX_PREVIEW_PARAGRAPHS = 2` —— 与 SPEC 说的「220 字符 / 2 段落」一致 | ✅ 行号精确 |
| B-5：「先 slice 再清洗」不会改变输出吗 | **不成立（语义会变）**。当前顺序是「先按空行切段 → 每段折叠所有空白为单空格 → 取前 2 段 → 用 `\n` 连接 → 截断到 220」。若改成「先对全文 slice(0, N) 再清洗」，第 2 段是否还在取决于 N 与第 1 段长度的关系——原文第 1 段若占满 220 字符，现状仍会输出 2 段（各段独立清洗后再拼），改后只剩 1 段。SPEC 的 T-TD1「逐字节一致」（spec.md:169）与 B-5 的改法互相矛盾 | ❌ 见 §3 疑点 R-5 |
| B-5：`buildPreviewText` 的两个调用点 | `conversationTurnNavigatorHelpers.ts:146`（assistant，texts = `unit.assistantTextRows.map(r => r.text)`）与 `:198`（user，texts = `[row.text]`） | ✅ |
| B-2/B-3 相关的 `ConversationTurnNavigator` 其余结构 | `:22` `renderUnits: readonly ConversationTurnRenderUnit[]`；`:23-26` `scrollOffsetPx/viewportHeightPx/virtualItems/activeQueryRowId`；`:60-74` `items = useMemo(() => buildConversationTurnNavigatorItems(renderUnits, {...intl 文案...}), [intl, renderUnits])`；`:86-96` `itemIndexes = useMemo(...)`（`byRowId` / `firstByUnitIndex` 两个 Map，deps `[items]`，**已是 useMemo 化**）；`:97-102` `activeItemIndex` 三级 fallback；`:133-135` `if (items.length < 2) return null;`；`:255` `export const ConversationTurnNavigator = memo(ConversationTurnNavigatorImpl);` | ✅ 事实记录 |

### 2.5 交叉事实（影响本轮章节但在其他 section）

| 事实 | 位置 |
|---|---|
| `hasRunningUnit` 依赖 renderUnits | `ConversationTimeline.tsx:421` `useMemo(() => renderUnits.some((unit) => unit.isRunning), [renderUnits])` —— Step 5 解耦后仍随 rows 变化重算，但不再每秒变 |
| `virtualizedUnits/liveUnit/liveUnitIndex` 依赖 renderUnits | `ConversationTimeline.tsx:417-420` `useMemo(() => splitConversationTimelineLiveTail(renderUnits), [renderUnits])` |
| `unitsRef` / `virtualizedUnitsRef` 每渲染赋值 | `ConversationTimeline.tsx:438-441` |
| 宽屏自动补拉 effect（`loadAllOlder`）行号 | `ConversationTimeline.tsx:607-677`（deps 数组 `:666-677`）—— SPEC C2 引用的 `:607-677` 精确 |
| 阈值常量 | `conversationTurnNavigatorHelpers.ts:69` `CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX = 864`；判定函数 `:77-89` `shouldHydrateConversationTurnNavigatorDirectory`（`canLoadOlder && !loadingOlder && hasLoadHandler && containerWidthPx >= 864`）—— 与 PRD「宽屏 ≥864px」一致 |
| 分享模式依赖全量正文 | `packages/ui/src/v4/SessionPane.tsx:3456-3465` `useEffect` → `if (shareActive && sessionId && hasOlderRows(snapshot)) ... void handleLoadAllOlder()` —— SPEC C2 引用的 `:3456-3465` 精确 |
| `scrollToQuery` 行号 | `ConversationTimeline.tsx:1275-1344`（SPEC C2 引 `:1275-1303` 是其 `scrollMountedQuery` 内部 `:1284-1304` 区段，`:1306-1341` 是未挂载回退：`:1320` `virtualizer.scrollToIndex` + `:1326` `remainingAttempts = 12` 的 rAF 重试） |
| `performance.memory` 可用性 | `packages/ui/src/lib/memoryDiagnostics.ts:29` `(performance as Performance & { memory?: RendererHeapSnapshot }).memory`，`:30-32` 无 `usedJSHeapSize` 数字则返回 undefined —— Chromium 专有，dev build 下有 |

---

## 3）可疑点清单

### 3.1 硬伤（SPEC 断言与代码不符 / API 不存在）

| ID | 类别 | 描述 | 证据 |
|---|---|---|---|
| **S-1** | CDP 脚本 | **`.vscode/start-electron.mjs` 不透传任何 argv**，A-8/Step 3 的「spawn 该脚本 + `--open-workspace <path>`」在代码层不成立。该脚本 `:29` `spawn(electronExecutable, ["--inspect-brk=9231", "."], {...})` 参数硬编码；`:7` 只解析 `--host-inspect`。传 `--open-workspace` 会被静默丢弃 → 深链打不开 → 无法参数化 workspace | `.vscode/start-electron.mjs:7,29`；对照 `desktopDeepLinkUrl.ts:224-249` 确实在等 argv 里的 `--open-workspace`，但没人传 |
| **S-2** | CDP 脚本 | **dev 实例有两条互不等价的启动路径，SPEC 未指定用哪条**：<br>① `.vscode/start-electron.mjs` —— 不起 vite/tsup，要求外部已就绪；`ELECTRON_RENDERER_URL` 硬编码 `localhost:5174`；带 `--inspect-brk=9231`（**brk = 断点在首行，会挂起等调试器**）；<br>② `pnpm dev:desktop` → `scripts/dev-desktop-env.mjs production` → `packages/desktop/scripts/dev.mjs` —— 自己等 tsup marker + 探测 vite，`spawn(electronCommand, ["."])`，**无 `--inspect-brk`**；但走的是 `ZCODE_ENV=production` 分支。<br>另：`--inspect-brk=9231` 若不接调试器会阻塞启动，脚本化采集不能带 | `.vscode/start-electron.mjs:29,36`；`packages/desktop/scripts/dev.mjs:64-113,129`；`packages/desktop/package.json` `dev`/`dev:runtime`；根 `package.json:9` `dev:desktop` |
| **R-3** | render-hot | **B-3 的 `Math.floor(scrollOffsetPx / 10)` 单位错配（硬伤）**：`scrollOffsetPx` 与 `virtualItems` 都来自**主时间线 virtualizer**（行高估计 72px + 实测动态测高），而 `10` 是**右侧 rail 自己的** `estimateSize`/DOM 高度（`h-2.5`）。用 10 去量化主时间线的 scrollOffsetPx，得到的重算频率与行边界无关（量化步长只有主行高的 ~1/7），active 判定会在行内多次重算 —— 比现状（scrollOffsetPx 变一次算一次）更慢，不是更快 | `ConversationTurnNavigator.tsx:112` `estimateSize: () => 10` + `:168` `h-2.5`；`ConversationTimeline.tsx:737-753`（virtualItems 来自主 virtualRows）、`:1705`（scrollOffsetPx 来自主 virtualizer.scrollOffset）、`timelineRowHeightCache.ts:11` `DEFAULT_ROW_HEIGHT_ESTIMATE_PX = 72`、`:693-712`（estimateSize + measureElement） |
| **R-4** | render-hot | **B-4/Step 7 指名的落点 `ConversationTurnRow.tsx` 里没有任何 DOM/ref/data-row-id 可注册**。该文件 104 行只有 props 透传（`:62 <ConversationRowView .../>`）和一个纯函数。`data-row-id` 的真实产地是 `ConversationRowView.tsx:141`（`RowShell`，14 个调用点）+ `:1678/:1693`（timelineMarker）、`ConversationTurnGroup.tsx:181/:240/:298`、`ConversationAgentToolCallRow.tsx:71` —— 共 **4 个文件、20 个挂载点**。SPEC 的「ConversationTurnRow 挂载注册/卸载注销」需要重新指定落点；且 ref 注册 Map 若放在 `ConversationTimeline`，需要跨 `ConversationTurnGroup → ConversationRowView` 透传 context/props（这两个文件都被 max-lines 豁免且已 1465/2000+ 行） | `packages/ui/src/v4/ConversationTurnRow.tsx:43-81`（无 DOM）；`ConversationRowView.tsx:130-148` + grep `RowShell` 命中行；`ConversationTurnGroup.tsx:181,240,298`；`ConversationAgentToolCallRow.tsx:71` |
| **R-5** | render-hot | **B-5「先 slice 再清洗」与 T-TD1「逐字节一致」互相矛盾**。现状语义：按空行分段 → 每段 `replace(/\s+/gu," ")` → 取前 2 段 → `\n` 连接 → 截断 220。改成先 `slice(0, 220)` 再清洗，会在「第 1 段本身就接近/超过 220」时丢掉第 2 段（现状会保留第 2 段的前缀）。若为了「一致」而保留段语义，则「先 slice」必须切在**段边界**上而非固定字符数 —— 那就不再是「先 slice 到上限」的省事写法 | `conversationTurnNavigatorHelpers.ts:102-117`（normalizePreviewParagraphs + truncatePreview）、`:119-135`（buildPreviewText）、`:99-100`（220/2 常量）；spec.md:44 vs spec.md:169 |
| **R-6** | render-hot | **B-4 引用的行号 `906-937` 与实际 `906-940` 有 3 行偏差**（`:938-940` 是 useCallback 收尾 + deps）。本身不致命，但同批引用的 `408-416`/`227`/`119-135`/`76-85` 全部精确命中，说明这处偏差可能是抄写而非结构差异；Step 7 改这段代码时按 906-937 定位会漏掉 deps 数组 | `ConversationTimeline.tsx:906-940` |

### 3.2 实施打架 / 歧义

| ID | 类别 | 描述 | 证据 |
|---|---|---|---|
| **R-2** | render-hot | **「计时文案局部 tick」的组件边界未钉死，且现状不是 memo 边界**。SPEC 说改到「`ConversationTurnGroup` 内部局部 tick…只重渲染计时文本所在小组件」，但真正渲染文案的是 `ConversationTurnGroup.tsx:565` 的裸函数 `AssistantHistoryStatus`（无 `memo`），它嵌在 `ConversationWorkSegmentFlow`（`:612`）内、`ConversationTurnGroup`（`:1465` 才 `memo`）之下。若把 tick state 放在 `AssistantHistoryStatus` 里，行为成立；但 SPEC 未说明是「就地加 state」还是「新抽一个 memo 计时组件」。另：`segment.workStatus.durationMs` 是**已算好的数字**（由 `conversationTurnWorkSegments.ts:96-132` 用 `nowMs - startedAt` 算出），局部 tick 组件要自己重算就得能拿到 `startedAt` —— `ConversationTurnWorkSegment` 接口（`conversationTurnWorkSegments.ts:19-28`）**只有 `workStatus`，没有 `startedAt`/`header`**，需扩字段或改传参 | `ConversationTurnGroup.tsx:565-610`（裸 function）、`:612`、`:1465`；`conversationTurnWorkSegments.ts:19-28`（接口字段）、`:96-132`（resolveSegmentDurationMs）、`:182` |
| **R-7** | render-hot | **B-2「提到组件侧 useMemo 后传入」会改动纯函数的公开签名**。`resolveConversationTurnNavigatorActiveUnitIndex`（`conversationTurnNavigatorHelpers.ts:217`）当前签名 `{items, virtualItems, scrollOffsetPx, viewportHeightPx}` 是纯函数、无 React 依赖（与同文件其他 `resolveXxx` 一致）。传预建 Map 需要加一个可选参数（如 `itemByUnitIndex`），否则要么在函数内保留 Map 构建（B-2 白做），要么破坏纯函数风格。SPEC 未说明兼容性策略 | `conversationTurnNavigatorHelpers.ts:217-268`（签名与实现），对比同文件 `:77`/`:91`/`:270`/`:307`/`:328` 全是无 React 依赖纯函数 |
| **R-8** | render-hot | **B-2 与 B-3 是同一个 `useMemo`，SPEC 把它们拆成两个 Step（6 里一句话）但改动耦合**。`ConversationTurnNavigator.tsx:76-85` 一个 useMemo 同时吃 `items`/`scrollOffsetPx`/`viewportHeightPx`/`virtualItems`。「Map 提出」属该 useMemo 的**函数体**，「行高量化」属它的**deps**。SPEC Step 6 把两者并列但 Step 5/6/7 分界模糊，且 R-3 已表明「量化」这半边本身有单位错配问题 | `ConversationTurnNavigator.tsx:76-85` |
| **R-9** | 度量 | **`reset()/dump()` 的返回通道未钉死**。A-11 说通过 `Runtime.evaluate` 调 `__zcodePerfProbe.dump()` 取 JSON，但 `Runtime.evaluate` 默认 `returnByValue: false` 时复杂对象拿不到；参考脚本统一用 `awaitPromise: true` + `res.result?.result?.value ?? JSON.stringify(res.result ?? res)`（`cdp-verify-historian.mjs:19,67-68`），意味着 `dump()` 最好返回**字符串**而非对象。SPEC 未规定返回类型 | `cdp-verify-historian.mjs:19,67-68`；`.cu-shots/cdp-lib.mjs:19,26` |
| **R-10** | 度量 | **探针挂在哪个 window 未核对**：`App.tsx` 是 `@zcode/ui` 的组件，被 desktop renderer **和** web（`packages/web`）共同使用。`performance.memory` 与 `PerformanceObserver('longtask')` 在普通浏览器都可用，所以挂 `window.__zcodePerfProbe` 无害；但 SPEC 未说明是否需要防止 web 侧也挂（`import.meta.env.DEV` 在 web dev 下同样为 true） | `packages/ui/src/App.tsx`（ui 公共包）；根 `package.json:8` `dev:web` |
| **R-11** | 度量 | **长任务环形缓冲的「分段」语义与 liveNowMs tick 的关系未定**。`dump()` 要输出「每段 = 采样窗口」的 longtask 次数/总耗时/最大值；但 A-5 只说 `reset()/dump()`，没说是「reset 开启新段、dump 收尾并返回全部段」还是「reset 清空、dump 返回当前段」。两种语义下 CDP 脚本的调用序列完全不同（前者 `reset→等→dump→reset→等→dump`，后者 `dump→reset→等→dump`） | spec.md:30, 36 |
| **R-1a** | 门禁 | **Step 0 的疑问现在有答案，且方向与 SPEC 的担忧不同**：不是「口径不明」，而是「口径明确 = 文件顶部 disable 注释豁免」。这意味着 Step 0 若照原文「确认是否真实通过 lint」去做，只能得到「通过」；真正需要决策的是：新增/修改的文件（如 `perfProbe.ts`、`previewText.ts`、改后的 `conversationTurnNavigatorHelpers.ts` 332 行）**不在豁免名单内**，受 400 行硬约束；而 `ConversationTimeline.tsx` / `ConversationTurnGroup.tsx` 已豁免，可放心加代码 | `.oxlintrc.json`（顶层 max-lines 400 + overrides）；各文件首行 disable 注释；`conversationTurnNavigatorHelpers.ts` = 332 行 |
| **R-12** | 门禁 | **`knip` 不在 `verify:pre-push` 里**，但 F-10/Step 3 仍写「knip 登记如需」。`package.json:20` `"verify:pre-push": "pnpm run lint && pnpm run architecture:check -- --changed"` —— 只有 oxlint + architecture:check，**没有 knip**；knip 是独立脚本 `"knip": "knip"`（`package.json:34`）。`AGENTS.md:24` 把 `pnpm knip` 列为「未使用依赖与导出」查询手段而非门禁。所以 knip entry 登记是「保持 knip 输出不新增噪音」的可选动作，不是阻断项 —— SPEC 用「如需」措辞是准确的，但把它列进「修改（关键落点）」清单（spec.md:111）略微夸大 | `package.json:20,34`；`AGENTS.md:21-24` |

### 3.3 测试不可测 / 可测性

| ID | 类别 | 描述 | 证据 |
|---|---|---|---|
| **P-1** | 测试 | **`packages/ui/test/` 的唯一先例当前就是红的，T-PA1/T-PA2 若照它写会继承同一失败**。实测 `npx tsx --test packages/ui/test/nonCliAcpRetirement.test.ts` → `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`，`# pass 0 / # fail 1`。原因：`packages/ui/tsconfig.json` 有 `paths: { "@/*": ["./src/*"] }`，但 tsx 运行时不读 tsconfig paths。对照 `packages/services/test/providerConfigMigration.test.ts` → `# pass 3 / # fail 0`（只 import 相对路径 + `@zcode/*` 包名）。<br>推论：T-PA2（`collectRendererMemorySample`）本身只依赖 `@zcode/shared` + `@/logger.js`（`packages/ui/src/lib/memoryDiagnostics.ts:1-9`），会被 `@/` 别名卡住；T-PA1（`perfProbe.ts`）会同时被 `@/` 别名与 `import.meta.env`（Node 下 `import.meta.env` 为 `undefined`，实测 `TypeError: Cannot read properties of undefined (reading 'DEV')`）双重卡住 | 实测命令输出；`packages/ui/tsconfig.json` `paths`；`packages/ui/src/lib/memoryDiagnostics.ts:9` `import { logMemoryDiagnostics } from "@/logger.js";`；Node `--input-type=module` 实测 `import.meta.env` = undefined |
| **P-2** | 测试 | **T-PA2「返回全部 7 类已注册计数器」在单测里不可达**。7 个 `register(...)` 分散在 7 个不同模块的**模块顶层**（`useZCodeTaskService.ts:36`、`shikiHighlighter.ts:64`、`taskQueryCacheStore.ts:1014`、`zcodeSessionStore.ts:51`、`sidePaneTerminalSessionRegistry.ts:57`、`ToolLayout.tsx:18`、`conversationProjectionStore.ts:272`）。单测若只 import `memoryDiagnostics.ts`，registry 里 providers Map 为空，`collect()` 返回 `{}`。要让 7 类齐全，必须 import 全部 7 个宿主模块（会拉进 React / zustand / shiki / xterm / v4 store 整条链），在 node:test 环境下不现实 | `packages/ui/src/lib/memoryDiagnostics.ts:16-17`（`createMemoryDiagnosticsRegistry()` 空注册表）；7 处 register 的宿主模块各自的重依赖；`packages/shared/src/memoryDiagnostics.ts:172` `const providers = new Map<string, MemoryDiagnosticsProvider>()` |
| **P-3** | 测试 | **Node 环境支持 `longtask` PerformanceObserver 但不会有条目**。实测 `new PerformanceObserver(...).observe({entryTypes:['longtask']})` 在 Node 22 下不抛错（`longtask OK`），但 Node 的 longtask 只在真实长任务后经 libuv 报告，T-PA1「注入同步 busy loop 后 dump() 能捕获 longtask 条目」在 node:test 里**不保证可观测**（阈值 50ms 由浏览器实现决定，Node 未实现 longtask 采集） | 实测 `node -e` 输出 `longtask OK`；无条目产出证据 |
| **P-4** | 测试 | **T-PA1/T-PA2 的 `qa: auto`（Step 1-2）与 T-PA2 的 blocking: yes 组合，在 P-1/P-2/P-3 未解决前无可运行的验证手段**。Step 1/2 标 `qa: auto`，但仓库无统一 test 入口（`AGENTS.md:27`「测试入口以目标包当前的 package.json 和实际测试文件为准」），`packages/ui/package.json` 与 `packages/shared/package.json` 的 scripts **只有 `lint`/`lint:fix`**，没有 `test` | `AGENTS.md:27`；`packages/ui/package.json` scripts；`packages/shared/package.json` scripts |

### 3.4 其他事实性提醒（非缺陷，但与 SPEC 表述有偏差）

| ID | 描述 | 证据 |
|---|---|---|
| N-1 | A-4 说「不经写盘门控的纯读出口」——准确。但 Step 1 的返回类型标注为 `MemorySample`（`:136`），而 `MemorySample` 的 `role` 是必填联合类型（`"main" | "renderer" | "utility_host" | "agent_node"`，`packages/shared/src/memoryDiagnostics.ts:8`）。renderer 侧必须显式填 `"renderer"`，SPEC 未提 | `packages/shared/src/memoryDiagnostics.ts:8,20-24`；`packages/ui/src/lib/memoryDiagnostics.ts:63` |
| N-2 | A-3 说「dev 下每 10s 被 `performanceTimelineCleanup` 清空」——完全准确，且该清理**只清 marks/measures**，不动 `PerformanceObserver` 回调已收到的条目。所以 A-3 的推理链（自持缓冲而非 mark/measure）成立 | `performanceTimelineCleanup.ts:14-15` |
| N-3 | A-6「仿 `commandAckObservability.ts` 的 window 调试面范式」——该文件用 `type X = Window & {...}` 局部类型 + `??=` + `splice` 裁剪；`test-actions.ts` 用 `declare global { interface Window {...} }`。两种范式并存，SPEC 未指明用哪种 | `commandAckObservability.ts:14-28`；`test-actions.ts:45-49,59` |
| N-4 | B-2 说「items 已按 unitIndex 有序，也可二分」——有序成立（`flatMap` 保序）；但 `resolveConversationTurnNavigatorActiveUnitIndex` 的语义是「找 viewport 内**已挂载**的 virtualItem 对应的最小 distance」，二分需要额外的 `virtualItems` 参与，「也可二分」这句在当前算法结构下没有直接落点 | `conversationTurnNavigatorHelpers.ts:179,196,217-268` |
| N-5 | B-1 说「renderUnits useMemo deps 去掉 `liveNowMs`」——但 `liveNowMs` 的**唯一**作用就是喂给 `buildConversationTurnRenderUnits` 的 `nowMs`，而 `nowMs` 在 builder 内部只流向 `buildConversationTurnWorkSegments`（`conversationTurnRenderUnits.ts:323`）。所以去掉 deps 后，running turn 的 `workStatus.durationMs` 会**冻结在最后一次 renderUnits 重建的值**，必须由新的局部 tick 补上 —— 与 R-2 是同一件事的两面 | `ConversationTimeline.tsx:409-416`；`conversationTurnRenderUnits.ts:298,323`；`conversationTurnWorkSegments.ts:182` |
| N-6 | R-2（风险表）「生产包无法采指标」与 `import.meta.env.DEV` 门控一致：dev build 下 `packages/desktop/src/renderer/src/performanceTimelineCleanup.ts:6` 的 DEV 判定也成立（两处门控同一口径），但注意 `pnpm dev:desktop` 走 `ZCODE_ENV=production` 分支（`scripts/dev-desktop-env.mjs` 的 `production` 参数）—— **Vite 的 `import.meta.env.DEV` 由 vite dev server 决定，与 `ZCODE_ENV` 无关**，所以 renderer 侧 DEV 仍为 true。两者命名易混淆 | `scripts/dev-desktop-env.mjs:9-13`；`packages/desktop/src/renderer/src/performanceTimelineCleanup.ts:6` |
| N-7 | A-9 的 `title === "ZCode"` 在 dev 下成立（页面 title 来自 `packages/desktop/src/renderer/index.html:6`），但 dev 的 **app name 是 `"ZCode Dev"`**（`desktopRuntimeEnv.ts:58-60`），影响 userData 目录（`:69-72`）与单实例锁身份。若 SPEC 后续要在文档里写「独占 dev 实例」（R-2 缓解措施），需要区分「app name = ZCode Dev（单实例锁域）」与「page title = ZCode（CDP 匹配键）」 | `desktopRuntimeEnv.ts:58-60,69-72`；`index.ts:197`；`renderer/index.html:6` |

---

## 4）无法核实项

| # | 项 | 原因 |
|---|---|---|
| U-1 | 长会话造数可行性：SPEC A-12 假设「参数化 workspace + sessionId + 行数断言」能打开一个数千行消息的既有会话 | 需要实机环境与具体 session 数据；仓库内无法确认是否存在这样的会话样本、其 row 量级、以及 `--open-workspace` + 后续 session 定位的完整链路（本次只确认了 `--open-workspace` 的 argv 解析存在，未确认从 workspace 打开到指定 sessionId 的 UI/CDP 路径） |
| U-2 | `PerformanceObserver('longtask')` 在 Electron renderer 里的实际条目行为（阈值、是否在 `setInterval` 驱动的 React 更新中报告） | 需实机；Node 侧只能证明 API 不抛错 |
| U-3 | `[memory]` 日志在 dev build 是否真的落盘（SPEC R-3 依赖「基线与验收均在 dev build 下采」） | `packages/ui/src/logger.ts` 的生产 no-op 行为未逐行核实；`logMemoryDiagnostics` 的实际 sink 需实机日志确认 |
| U-4 | 9229 在「已有 dev 实例占用」时的实际行为（端口冲突的具体表现） | 需实机；代码层只能确认 `app.commandLine.appendSwitch("remote-debugging-port","9229")` 在 `!app.isPackaged` 时无条件执行（`index.ts:193-195`），冲突时的 Electron 行为未验证 |
| U-5 | Step 4/Step 8 的「采样对比」是否真能区分「流式窗口」与「滚动窗口」两类指标 | 需实机；`scripts/dev/long-session-perf-sample.mjs` 尚不存在，其「驱动流式输出」的可行性（打开一个正在输出的会话 / 手动触发长输出）未验证 |
| U-6 | `packages/ui/src/v4/` 下 200+ 文件零测试这一 PRD 前提（PRD:20） | 本次只统计了 `packages/ui/test/`（1 个文件）与 `packages/services/test/`（3 个文件）；未全量清点 v4 目录下的 `*.test.*` |
| U-7 | `import.meta.env` 全局类型声明的可见性是否覆盖 `packages/ui/src/lib/perfProbe.ts` | `packages/ui/tsconfig.json` 的 `include: ["src/**/*.ts", ...]` 包含 `src/test-actions.ts`（声明处），编译期应可见；但未实际跑 `pnpm typecheck` 验证（新文件尚不存在） |