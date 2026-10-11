---
iteration: desktop-long-session-perf
evidence: cr-ev-server-infra
role: evidence-only（只取证，不下结论、不给评级）
date: 2026-10-06
repo: D:\Dev\worktree\desktop-long-session-perf
base_sha: ba7c240
head_sha: d11a97c
spec: docs/iterations/desktop-long-session-perf/spec.md（r3 送审稿）
scope: 服务端 + 接线 + 度量基建（turnDirectory 全链 / host 四件套 / transport 三件 / perfProbe / shiki LRU / CDP 采样脚本 / @/→相对路径改造）
excluded: shared 契约实现本体（transport.ts schema、previewText.ts）、renderer store/renderUnits/跳转闭环（另有子代理）
---

# 0. 基线事实

```
d11a97c fix(perf): 采样脚本长会话判据改用 totalRowCount 与 maxScrollTop 双判据
7964219 fix(ui): 修 cr-func-B 三条 must-fix
1d18f36 feat(ui): 目录跳转闭环（Step 19）
```

`git diff --stat ba7c240 d11a97c`：48 files changed, 7193 insertions(+), 772 deletions(-)。
本模块范围内共 21 个文件（含 3 个新文件）。

已实跑的验证命令与其结果（只读，未改任何文件）：

| 命令 | 结果 |
|---|---|
| `cd apps/zcode-cli/packages/bootstrap && npx tsx --test scripts/test-turn-directory.mjs` | `# pass 13` / `# fail 0`，末行 `TEST PASS — Step 15 turn directory derivation (T-TD2)` |
| `npx tsx --test packages/ui/test/perfProbe.test.ts packages/ui/test/shikiTokensCacheLru.test.ts` | `# pass 13` / `# fail 0` |

---

# 1. spec 声明 vs 代码现状（逐条）

## 1.1 `getTurnDirectory`（spec C2「服务端」+ Step 15）

位置：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts:510-591`（+110 行，diff 起点 `:492`）

| spec 硬定义 | 代码现状 | 位置 | 判定依据 |
|---|---|---|---|
| 从**全量投影行现算**派生，不在 ProductProjection 维护第二份目录 | `const snapshot = this.projection.getSnapshot()` → 遍历 `visibleRows`。与 `getRowsRange():452` 同一数据源（`getSnapshot()` 是投影**内部**快照，不是 `getWireSnapshot()` 的 tail window；`getPlans():477` 注释亦明写「wire snapshot 只保留 tail window；renderer 扫描可见 rows 会漏掉早期计划」并因此改用 `getSnapshot()`） | `:518-526` | 数据源确为全量行，非 60 行 tail window |
| 单趟现算 | 一次 `for (const row of visibleRows)`，`turns: Map<turnId, {headerState?, assistantTexts[]}>` + `queries: UserInputRow[]`；turn 边界靠 `turnId` 归并、header 只留首个（`turn.headerState ??= row.state`） | `:527-541` | 单趟，无二次遍历 |
| `entries` 按 `queryRowId` **升序**（不照抄 `getPlans` 降序） | `queries.toSorted((l, r) => l.rowId - r.rowId)` | `:557` | 同文件 `:487` 的 `getPlans` 仍是 `right.rowId - left.rowId`，方向确实未串 |
| 游标 `beforeQueryRowId` = 严格更小的更早条目 | `allEntries.filter((e) => e.queryRowId < beforeQueryRowId)`，随后 `.slice(-limit)` 取「游标之前最近 limit 条」 | `:575-579` | 取 `<` 而非 `<=` |
| `hasMore` = 更早方向仍有条目（非「这页正好满 limit」） | `hasMore: eligible.length > page.length` | `:588` | 与 `getRowsRange():468` 同款写法 |
| `realUserQueryTotal` = 全量现算权威总数，**不受游标与 limit 影响** | `realUserQueryTotal: allEntries.length`（`allEntries` 是过滤前全量） | `:584` | 位置在 `eligible/page` 计算之后但取的是 `allEntries` |
| `assistantPreviewKind` 三态（text > running > empty，无 header 兜底 = empty） | `hasAssistantText ? "text" : turn?.headerState === "running" ? "running" : "empty"`；`turn` 由 `turns.get(row.turnId)` 取得，缺 header 即 `undefined` → 落到 `empty` | `:565-575` | 三态分支顺序与 spec 一致 |
| 走 `filterConversationRowsForProfile`（照 `getRowsRange():441-444`） | `:524-527`，`DELIVERY_PROFILES[deliveryProfile]` | `:524` | 该函数当前是 no-op 但 `return [...rows]`（`packages/shared/src/zcode-protocol-v4/profiles.ts:19`）→ 每次目录查询额外一次全量数组拷贝 |
| 摘要口径统一（220 字符 / 2 段，与 renderer rail 同源） | `buildPreviewText({ texts, fallback: "", maxPreviewChars: DEFAULT_MAX_PREVIEW_CHARS, maxPreviewParagraphs: DEFAULT_MAX_PREVIEW_PARAGRAPHS })`，常量从 `@zcode/shared/zcode-protocol-v4` 导入 | `:544-554` + import `:28-38` | 与 `packages/shared/src/zcode-protocol-v4/previewText.ts:34/37` 的 220/2 一致 |
| i18n 文案不下发 | `TURN_DIRECTORY_EMPTY_PREVIEW = ""`（`:77`）；非 text 态 `assistantPreview` 恒 `""` | `:77`、`:568` | 客户端已有 `chat.turnNavigator.emptyAssistant/runningAssistant/userFallback`（en-US.ts:2007-2009 / zh-CN.ts:1883-1885 均为存量） |
| `PROTOCOL_V4_LIMITS.turnDirectoryMaxEntries` 封顶 | `Math.max(1, Math.min(params.limit ?? 限额, 限额))` | `:519-523` | 缺省取满上限；`limit=0/负数` 被夹到 1（测试 D3 覆盖） |

测试覆盖（`apps/zcode-cli/packages/bootstrap/scripts/test-turn-directory.mjs`，523 行，13 例，A1/B1/C1/D1/D2/D3/E1/F1/F2/G1/G2/H1/H2）：query 过滤（B1 origin 家族全集）、升序含乱序窗口（C1）、游标严格小于 + hasMore + 逐页翻完不重不漏（D2 的 `walked` 循环）、三态含无 header（F1）、steer query 各成条共享 turn 级摘要（F2）、`realUserQueryTotal` 不受游标/limit 影响（E1）、与 shared `buildPreviewText` 逐字节一致（G1）。

## 1.2 gateway 三段式与 resultSchema 校验（Step 15）

位置：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:1587-1607`

```
const params = v4ConversationTurnDirectoryParamsSchema.parse(rawParams);
const existingReady = this.readyFlights.get(params.sessionId);
const publisher = existingReady ? await existingReady
  : !this.hasLiveConversation(params.sessionId) ? await this.ensureColdReadyPublisher(params.sessionId)
  : await this.hydratePublisher(params.sessionId);
return v4ConversationTurnDirectoryResultSchema.parse(publisher.getTurnDirectory({...}, profile));
```

- 三段式（`readyFlights` → `hasLiveConversation` → `ensureColdReadyPublisher`/`hydratePublisher`）与 `rowsRange():1562-1578` **逐行同构**，冷恢复自动可用、`transcript-hydration` 未改。
- params/result 两侧都过 zod parse；`clientMode` 映射与 `rowsRange():1576` 同口径（`desktop-continuous → continuous`，否则 `replayable`）。
- `server.ts:513-515` 新增独立 case，排在 `conversationRowsRange` 与 `conversationPlans` 之间。

## 1.3 host 四件套（Step 16）

| 件 | 位置 | 要点 |
|---|---|---|
| `zcodeAgent.ts` | `:389-395` 新增 `ZCodeAgentConversationTurnDirectoryParams extends ZCodeAgentSessionTarget`（`beforeQueryRowId?` / `limit?`）；`:777-780` 接口方法 `conversationTurnDirectoryV4` | 基类与 `ZCodeAgentConversationRowsRangeParams`（`:378`）同为 `ZCodeAgentSessionTarget`，形状对齐 |
| `zcodeAgentService.ts` | `:5277-5296` | **跟 rowsRange 支**：`readTrustedZCodeAgentV4Connection(params)` + `getReadOnlyClient(params)`；`clientMode` 取 `trusted.clientMode`（不信调用方自报）；走 `client.request(V4_METHODS.conversationTurnDirectory, {...}, v4ConversationTurnDirectoryResultSchema)`。未跟 `plans` 的裸透传 |
| `zcodeAgentConnectionScope.ts` | `:742-747` | `assertReady()` + `withTrustedConnection(params, forwardedConnection(params))`，与 `:735-741` 的 rowsRange 转发同款 |
| `workspaceConnectionRegistry.ts` | `:28` | Pick 窄面新增 `"conversationTurnDirectoryV4"`（紧跟 `conversationRowsRangeV4`） |

## 1.4 renderer transport 三件

- `packages/ui/src/v4/transport.ts:65-68`：`ConversationTransport` 新增**必需**方法 `turnDirectory(params: V4ConversationTurnDirectoryParams)`。
- `packages/ui/src/v4/agentConversationTransport.ts:61`（Pick 联合新增）+ `:344-356`（实现，`await ensureHandshake()` 后透传，只带 `sessionId/beforeQueryRowId/limit`）。
- `packages/ui/src/v4/replaceableConversationTransport.ts:136-140`：`return this.current.turnDirectory(params)`。
- 实现者穷举：`createAgentConversationTransport`（返回 `ConversationTransport`）与 `ReplaceableConversationTransport`（`implements ConversationTransport`）均已补齐，全仓无第三个实现者。
- `packages/ui/src/App.tsx:84` 导入 + `:146-150` `useEffect(() => { startPerfProbe(); }, [])`。

## 1.5 perfProbe（Step 1/2）

位置：`packages/ui/src/lib/perfProbe.ts`（新，198 行）+ `packages/ui/src/lib/memoryDiagnostics.ts:38-58`

| spec 要点 | 代码现状 | 位置 |
|---|---|---|
| `import.meta.env.DEV` 门控 | `isPerfProbeEnabled()`：`((import.meta as ...).env ?? {}).DEV === true && typeof window !== "undefined"`；Node 下 env 为 undefined → false | `:141-147` |
| 自持环形缓冲（不用 performance.mark/measure） | `segments: MutableSegment[]`，`maxSegments` 默认 20（`PERF_PROBE_MAX_SEGMENTS`）；单段 `longtask` 默认上限 200；两处均 `splice(0, len - max)` 从头部淘汰，`openSegment()` 保证当前段永不被淘汰 | `:59-60, 81-101, 111-116` |
| `reset()` 清空开新段 | `reset()` = `stampMemory()`（给旧段补内存样本）+ `openSegment()`，**旧段保留** | `:120-123` |
| `dump()` **返回 JSON 字符串** | `JSON.stringify(segments.map(...))`，长任务只投影 `start/duration` | `:124-137` |
| 每段含 `{ startedAt, longtasks, memory }` | 一致；`startedAt` 用 `performance.now()`（与 `PerformanceEntry.startTime` 同基） | `:32-38, 68-70` |
| `sampleMemory()` 走纯读出口，不暴露 `sampleNow()` | `memorySample = options.memorySample ?? collectRendererMemorySample` | `:87` |
| 挂 `window.__zcodePerfProbe` | `startPerfProbe()` 末尾 `(window as PerfProbeDebugWindow).__zcodePerfProbe = probe` | `:186` |
| 幂等 | 模块级 `let started`，重复调用直接返回同一实例 | `:153, 163-166` |
| Step 1：`collectRendererMemorySample(): MemorySample` 纯读、不经写盘门控、`role` 固定 `"renderer"` | `memoryDiagnostics.ts:38-58`：`registry.collect()` + `readHeap()`，`role: "renderer"`，`heapUsedKb`/`heapTotalKb`；`startMemoryDiagnosticsLogger` 的 `sampleNow` 改为**复用**它（`sampleNow` 仍只返回 boolean，门控语义不变） | `memoryDiagnostics.ts:38-58, 84-96` |

T-PA1 覆盖（`packages/ui/test/perfProbe.test.ts`，260 行）：注入长任务 → `dump()` 可解析、`reset()` 开新段、`dump()` 是字符串且每段带 `role=renderer`、环形上限淘汰、`sampleMemory()` 注入出口、非 dev/无 window 时 `startPerfProbe()` no-op。
T-PA2 覆盖：`perfProbe.test.ts:242-254` 经 `collectRendererMemorySample(uiMemoryDiagnosticsRegistry, () => ({...}))` 断言 `role/heapUsedKb/heapTotalKb`（等价断言，非「注入 7 个假 provider」的逐类计数）。

## 1.6 shiki LRU（Step 20 / T-MG1）

位置：`packages/ui/src/lib/shikiHighlighter.ts`（+137）

| spec 要点 | 代码现状 | 位置 |
|---|---|---|
| 上限 500 | `TOKENS_CACHE_MAX_ENTRIES = 500` | `:70` |
| 命中处 `delete` + `set` 刷新序 | 命中分支调 `putTokensCache(tokensCacheKey, cached)`，`putTokensCache` 内 `delete(key)` → `set(key, value)` | `:210-214`, `:95-103` |
| 异步写入点在 set 后重查上限再淘汰（防并发超限竞态） | 命中路径与 `getHighlighter().then()` 的异步写入点 `:249` **都**走 `putTokensCache`，其内部 set 之后立刻 `evictTokensCacheOverflow()` | `:95-103, 249` |
| `subscribers` 一并加护栏、订阅退订对称、计数有界 | `SUBSCRIBERS_MAX_PENDING_KEYS = 500`；`addSubscriber()` 登记时超限从队首丢 key；成功路径 `takeSubscribers()`（读+删同函数）、失败路径 `catch` 也 `takeSubscribers()` | `:78, 105-124, 126-131, 251, 265` |
| T-MG1 经 `uiMemoryDiagnosticsRegistry` 观测 | 注册项 `shiki` 现含 `tokensCache` / `highlighters` / `pendingSubscribers` | `:134-138` |

测试覆盖（`packages/ui/test/shikiTokensCacheLru.test.ts`，101 行，4 例）：>500 注入压到 500 且最新留最旧删、命中刷新序（touch 存活 / 未 touch 被淘汰）、反复命中同一条不挤掉其它热条目、订阅计数回到 0。

## 1.7 CDP 采样脚本（Step 3）

位置：`scripts/dev/long-session-perf-sample.mjs`（新，782 行；`git diff --stat` 显示 782 insertions）

| spec「dev 实例启动契约」 | 代码现状 | 位置 |
|---|---|---|
| ① 探测 `http://localhost:5174`，不通则报错并提示先起 vite dev；脚本不负责起构建 | `probeHttpUrl()`（不解析 body，`res.ok \|\| res.status < 500`）；不可达 → `fail(..., EXIT.DEV_SERVER)` 并提示 `.vscode/tasks.json` 的 `zcode: prepare desktop debug` / `pnpm dev:local-cli` | `:184-192, 599-611` |
| ② 9229 单实例锁探测：可达则不 spawn，改为转发 `--open-workspace` 深链；不可达且 spawn 后秒退按失败 | `fetchJson(cdpBase/json/version)`；可达 → `reuse-skip-launch`（不 spawn）或 `reuse-forward-deep-link`（spawn 转发进程，`waitChildExit(FORWARDER_EXIT_TIMEOUT_MS=20s)`）；不可达且 `--skip-launch` → `fail(EXIT.LAUNCH)`；`launch` 模式下 `waitForZCodeTarget` 每轮检查 `child.exitedAt != null` 即 `fail(EXIT.LAUNCH)` 并给出单实例锁 / 未构建 / `ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT` 三条排查 | `:613-650, 435-471` |
| spawn `electron [".", "--open-workspace", ws]`，`cwd=packages/desktop`，`ELECTRON_RENDERER_URL`，**不带 `--inspect-brk`** | `spawnElectron()` 完全一致，注释明写「刻意不带 --inspect-brk」；`--open-workspace <path>` 空格形态 | `:403-422` |
| ③ 就绪判定：轮询 9229 `/json/list` 直到出现 `title === "ZCode"` 的 page target | `waitForZCodeTarget()`，`--ready-timeout-ms` 默认 90s，500ms 轮询；超时后打印全部 target 的 `type:title@url` | `:435-488` |
| ④ 调用序列 `reset()` → 驱动动作 → `dump()` 分段收集 | `sampleSegment()`：`PROBE_RESET_EXPR` → （可选）`SCROLL_DRIVER_EXPR` → `sleep(durationMs)` → `SCROLL_STOP_EXPR` → `PROBE_DUMP_EXPR` → `RENDERER_ENV_EXPR`；两段 = `stream`（不驱动，提示手动触发长输出）+ `scroll`（脚本驱动来回滚动） | `:509-581, 686-694` |
| 探针未挂载时明确报错并非零退出 | `PROBE_CHECK_EXPR` → `mounted !== true` → `fail(EXIT.PROBE)`，含「若是复用既有实例需重启」提示 | `:668-679` |
| 报告 JSON 落到 `docs/iterations/desktop-long-session-perf/` | `schema: "zcode-desktop-long-session-perf-sample/v1"`，含 `repo.head/branch`（`execFileSync git`）、`params`（workspacePath/durationMs/selector/devServerUrl/cdpPort/skipLaunch/mode/spawnedPid/childExitInfo/childStillRunning/electronExecutable）、`target`、`segments[]`；缺省路径 `baseline-<ISO 时间戳>.json`，`mkdirSync(recursive)` | `:699-737, 744-761` |

**d11a97c 的 `totalRowCount` 双判据改**：
- 常量 `TIMELINE_SELECTOR = '[data-testid="v4-timeline"]'`（`:41`）、`LONG_SESSION_MIN_TOTAL_ROWS = 200`（`:39`）、`LONG_SESSION_MIN_MAX_SCROLL_TOP = 1_000`（`:40`）。
- `RENDERER_ENV_EXPR` 从同元素上读 `data-total-row-count` / `data-window-row-count` / `scrollHeight-clientHeight`（`:305-325`）。
- 判据 `longSessionOk = totalRowCount >= 200 || maxScrollTop >= 1000`，不达标只 `console.error` 警告、**不改变退出码也不阻断报告写出**（`:550-560`）。
- 选择器有效性已核对：`packages/shared/src/test-ids.ts:517` `TID_V4_TIMELINE = "v4-timeline"`，`ConversationTimeline.tsx:1905-1914` 同一个 `<div ref={scrollRef} data-testid={TID_V4_TIMELINE} … data-window-row-count={rows.length} data-total-row-count={totalCount}>` 且 className 含 `overflow-y-auto`（自身即滚动容器）→ 选择器与两个属性口径都对得上。
- `data-total-row-count` 的语义已核对：`ConversationTimeline.tsx:285` 注释「投影全序行数（rows.totalCount；窗口截断后大于 rows.length，仅用于滚动条估计/诊断）」。
- 实跑证据：`baseline-before.json:43/106` 与 `baseline-after.json:43/554` 的 `totalRowCount=1719`、`windowRowCount=1719`、`maxScrollTop` 34759/71264 → 改后判据在基线会话上确实通过。

---

# 2. diff 变更点清单（本模块范围）

**服务端**
1. `conversation-topic-publisher.ts` +110：import 补 `TurnDirectoryEntry/UserInputRow/V4ConversationTurnDirectoryResult` 与 `DEFAULT_MAX_PREVIEW_*`/`buildPreviewText`；新增 `TURN_DIRECTORY_EMPTY_PREVIEW = ""`；新增 `getTurnDirectory()`。
2. `v4-gateway.ts` +32：类型/schema import + `turnDirectory()` handler（三段式 + resultSchema.parse）。
3. `server.ts` +3：`case V4_METHODS.conversationTurnDirectory`。
4. `apps/zcode-cli/packages/bootstrap/package.json` +1：`"test:turn-directory": "tsx --test scripts/test-turn-directory.mjs"`（同目录其余 4 个 magic-context 脚本仍是 `node --test`，此处因 publisher 传递依赖 `@zcode/model-option-map`（exports 直指 `src/*.ts`）必须走 tsx——脚本头 `:33-38` 已写明理由）。
5. `scripts/test-turn-directory.mjs` 新 523 行。

**host / 接线**
6. `zcodeAgent.ts` +16（params interface + service 方法声明）。
7. `zcodeAgentService.ts` +23（trusted connection + getReadOnlyClient + resultSchema）。
8. `zcodeAgentConnectionScope.ts` +6（scope 转发）。
9. `ui/src/v4/transport.ts` +6（`ConversationTransport.turnDirectory`）。
10. `ui/src/v4/agentConversationTransport.ts` +16（Pick 联合 + 实现）。
11. `ui/src/v4/replaceableConversationTransport.ts` +6（透传）。
12. `ui/src/v4/workspaceConnectionRegistry.ts` +1（Pick）。
13. `ui/src/App.tsx` +6（import + `useEffect(startPerfProbe)`）。

**度量 / 内存护栏**
14. `ui/src/lib/perfProbe.ts` 新 198 行。
15. `ui/src/lib/memoryDiagnostics.ts` +42/-…：抽出 `collectRendererMemorySample()`，`sampleNow` 复用之。
16. `ui/src/lib/shikiHighlighter.ts` +137：LRU 常量与 5 个护栏函数、命中刷新、异步写入统一入口、订阅对称、诊断注册项加 `pendingSubscribers`、6 个 `__*ForTest` seam。

**可测性（`@/` → 相对路径）**
17. `memoryDiagnostics.ts:9` `@/logger.js` → `../logger.js`。
18. `shikiHighlighter.ts:3-5` `@/logger.js` / `@/lib/memoryDiagnostics.js` → `../logger.js` / `./memoryDiagnostics.js`。
19. `lib/toolCallTree.ts`、`lib/toolError.ts`、`v4/toolCallRowAdapter.ts`、`v4/conversationCuaGroups.ts`、`v4/conversationTurnFlowItems.ts` 各 2-8 行同款替换。

**采样脚本**
20. `scripts/dev/long-session-perf-sample.mjs` 新 782 行。
21. `ui/test/perfProbe.test.ts` 新 260 / `ui/test/shikiTokensCacheLru.test.ts` 新 101。

---

# 3. 可疑点（file:line + 事实；不含结论/评级）

## S-1 gateway 错误路径：`hydratePublisher` 抛错时的行为与 `rowsRange` 完全同构，无额外收敛
`v4-gateway.ts:1589-1594`。`existingReady` / `ensureColdReadyPublisher` / `hydratePublisher` 三条 await 全部无 try/catch，与 `rowsRange():1564-1569` 逐行一致。事实：`readyFlights` 的 rejected promise 若被缓存，后续同 sessionId 的 `turnDirectory` 会持续复用同一个 rejected flight（同样适用于 rowsRange）；spec 风险表未登记此项，且**未验证** `readyFlights` 在 reject 时是否被删除。需 reviewer 判断这是否属「与 rowsRange 同族即接受」的范围。

## S-2 服务端现算 O(N) 的输入规模上界无界，且每次查询额外一次全量数组拷贝
`conversation-topic-publisher.ts:518-527`。`getSnapshot().rows.window` 是投影**全量行**（无上限），单趟扫描 O(N) + `filterConversationRowsForProfile` 的 `return [...rows]`（`profiles.ts:19`）再做一次 O(N) 拷贝。客户端 250ms trailing 去抖 + 每次 revision 变更都会重发（`conversationProjectionStore.ts:1497-1505`）。基线会话 N=1719（`baseline-after.json:43`），但 spec 未给 N 的上界估计，风险表（spec:219）只写「CLI 持全量，成本已接受」。

## S-3 `turnDirectoryMaxEntries = 500` 与翻页的交互：多页路径在 >500 条 realUser query 时才进入，且跨 revision 会整批丢弃
- 服务端缺省返回**最新** 500 条（`eligible.slice(-limit)`，`:577`），`hasMore` 指示更早方向（`:588`）。
- 客户端 `conversationProjectionStore.ts:1378-1452`：每页 `limit = turnDirectoryMaxEntries`，循环条件 `!hasMore || entries.length >= realUserQueryTotal`，页数上限 `TURN_DIRECTORY_MAX_PAGES = 50`（`:195`）→ 理论上限 25,000 条；到顶时直接 `break` 并把 `hasMore` 重算为 `entries.length < realUserQueryTotal`（`:1433-1435, 1451`），**不记日志、不告警**。
- 跨 revision 保护：第二页起 `result.atRevision !== pinnedRevision` 即整批丢弃并返回 `retryable-failure`（`:1395-1402`）。`snapshot.revision` 在结构性 delta 时 +1（`product-projection.ts:1347-1356`）。事实：>500 条 realUser query 的会话在活跃输出期间多页走查可能反复失败。
- spec 未对「500 条上限下 rail 只显示最近 500 条、未取到的更早条目如何呈现」作硬定义；`mergeTurnNavigatorItems` 只消费已取到的 `entries`（`conversationTurnNavigatorDirectory.ts:110-147`）。

## S-4 fault 码 `fault.conversation.turnDirectoryConnectionUntrusted` 是裸字符串，未登记在任何 fault 码注册表，也无 i18n
`zcodeAgentService.ts:5282`。事实：共享侧有 `packages/shared/src/zcode-protocol-v4/attachment-faults.ts`（`ZCODE_ATTACHMENT_FAULT_CODES`）与 `wire-fault.ts`，均不含该码；`packages/ui/src` 全量 grep 无 fault→i18n 映射。参照物：`fault.conversation.rowsRangeConnectionUntrusted`（`zcodeAgentService.ts:5263`）同样未登记 → 与既有先例一致，但 `conversationShareService.ts:194` 存在对 rowsRange 码的**显式白名单**（用于区分故障），新增码未加入任何类似白名单，若将来有「按 fault 码分支」的逻辑需同步。

## S-5 `stopPerfProbe` 零消费者 + HMR 下模块级 `started` 重置导致 observer 泄漏
`perfProbe.ts:153-154, 160-188, 191-198`。事实：
- 全仓 grep `stopPerfProbe` 只有定义处一处命中——生产代码未接线，两个新测试也未调用。
- `App.tsx:146-150` 的 `useEffect` 无 cleanup 返回；StrictMode 双调用由 `started` 幂等吸收，但 Vite HMR 会**重新求值模块**，`let started` 归零 → 旧的 `PerformanceObserver`（`observer` 变量同样归零，句柄丢失）无法 `disconnect`，新探针再挂一个；长任务被两个 observer 同时记录。
- `segments` 缓冲（20 段 × 200 条）随探针实例存活，disconnect 路径（`:192`）零覆盖。
- 仅 dev 生效（`isPerfProbeEnabled`），生产无影响。

## S-6 shiki LRU 对高亮行为的语义影响面：命中路径现在会 `delete`+`set`
`shikiHighlighter.ts:210-214`。事实：`putTokensCache` 在命中时先 `delete` 再 `set`，等价于把同一条目挪到队尾；返回值仍是同一个 `cached` 对象引用（未拷贝），缓存命中时的 `queueMicrotask(() => callback(cached))` 路径不变（`:218-220`）。淘汰只影响未来是否重算，已渲染的 DOM 持有旧引用不受影响。**未验证**：命中时的 `delete`+`set` 在 `tokensCache` 处于满载（size == 500）时不会触发淘汰（delete 后 size=499，set 回 500），与 `evictTokensCacheOverflow` 的 `while` 语义一致——此项**逻辑上无缺口，但无测试直接覆盖「满载 + 命中」组合**。

## S-7 subscribers 护栏的测试只覆盖早退路径，超限淘汰与对称退订未被断言
`shikiTokensCacheLru.test.ts:87-101`。事实：第 4 例走的是 `highlightCode("plain log line", "log", …)` 的 `createRawCodeTokens` 早退分支（`shikiHighlighter.ts:199-204`），断言的是「本来就没有订阅者」的 0；`addSubscriber` 的 `SUBSCRIBERS_MAX_PENDING_KEYS` 超限淘汰分支（`:112-118`）与成功/失败路径的 `takeSubscribers` 对称性（`:126-131, 251, 265`）**无任何断言**（真实高亮需加载 shiki 语言包/wasm，单测跑不动——文件头 `:3-6` 已声明该限制）。

## S-8 采样脚本：失败路径的进程回收在 Windows 上不完整 + 报告字段可能二次 fail
`long-session-perf-sample.mjs`：
- `killStrayChild():96-105` 只 `child.kill()`（Windows 上是 TerminateProcess，**不杀进程树**）；electron 主进程被强杀时其 renderer/gpu 子进程与已开的 9229 端口可能残留。
- 成功路径刻意**不杀**子进程（`:738-740` 有日志说明），但 `:715` 在写报告时再次调用 `resolveElectronExecutable(options.electron)`；若此时 electron 二进制被移除，该函数会 `fail(EXIT.LAUNCH)`——即「采样已成功但报告写不出来」，且此时已进入 `finally` 之外、`killStrayChild` 不会被调用（`main()` 的抛出在顶层 catch 中被 `PerfError` 分支接住并 `killStrayChild()`，故实际仍会回收；顺序上 `child` 变量在闭包内可达）。
- `stdio: "inherit"`（`:405`）让 electron 与脚本共用 stdio；脚本末尾 `process.exit(exitCode)`（`:782`）在 `finally` 里 `await sleep(200)` 后执行——注释已说明是为避开 Windows uv 断言。
- `probeHttpUrl` 的 `res.status < 500` 判定（`:188`）会把 4xx 也算「可达」；对 vite dev 无实际影响（事实陈述）。

## S-9 `@/` → 相对路径改造是「按测试闭包做的外科手术」，同一模块现在两种写法并存
- 已核对闭包：`memoryDiagnostics.ts`（仅 `../logger.js`）、`shikiHighlighter.ts`、`lib/toolCallTree.ts`、`lib/toolError.ts`、`v4/toolCallRowAdapter.ts`、`v4/conversationCuaGroups.ts`、`v4/conversationTurnFlowItems.ts`、`lib/taskChatMessageTypes.ts` 均已 **0 处 `@/`**（`findstr /c:"@/"` 返回无匹配）。
- 但并存事实：`lib/toolDisplay.ts:11` 仍写 `import { getToolCallErrorText } from "@/lib/toolError.js";`，而 `v4/toolCallRowAdapter.ts:6` 已改成 `"../lib/toolError.js"`；`lib/codeViewer.ts:4` 仍写 `"@/lib/taskChatMessageTypes.js"`。同一文件在 Vite 下解析到同一绝对路径（非双实例），但 spec 的「被测模块传递依赖链零 `@/`」是**测试闭包约束**，不是全仓约束——无漏网，只是范围需要 reviewer 确认与 spec Step 5 的表述一致。

## S-10 新增测试文件全部落在 typecheck / lint 覆盖之外
- `packages/ui/tsconfig.json` `"include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.d.ts", "src/**/*.json"]`，`rootDir: "src"` → `packages/ui/test/*.test.ts`（含本次新增 260 + 101 行）**不被 `pnpm typecheck` 检查**。
- `apps/zcode-cli/packages/bootstrap/tsconfig.json` `"include": ["src/**/*"]`、`package.json` `"lint": "oxlint src"` → `scripts/test-turn-directory.mjs`（523 行）**既不 typecheck 也不 lint**。
- `scripts/dev/long-session-perf-sample.mjs` 由仓库根 lint 覆盖与否未在本轮核对（spec 测试策略段称 knip 不在 pre-push 门禁、`scripts/dev` 新文件是否登记 `knip.json` 为可选项非阻塞）。
- `tsx` 只在根 `package.json:72` 的 devDependencies（`^4.19.4`），**未**登记进 `apps/zcode-cli/packages/bootstrap` 的 devDependencies（`package.json:48-53`）→ 依赖 pnpm 把根 `.bin` 注入 workspace 脚本 PATH 才能解析到。

## S-11 目录态与已加载侧的 `userPreview` fallback 不对称（接缝）
`conversationTurnNavigatorDirectory.ts:84` 的 `userPreview: entry.queryPreview` **不套 fallback**；而已加载侧 `buildConversationTurnNavigatorItems` 会把 `userFallbackPreview`（`chat.turnNavigator.userFallback`）作为 `buildPreviewText` 的 `fallback` 传进去（`conversationTurnNavigatorHelpers.ts:246`，文案来源 `ConversationTurnNavigator.tsx:94-95` / `SessionPane.tsx:677-678`）。服务端对纯空白 query 下发 `queryPreview: ""`（`conversation-topic-publisher.ts:551` + `:562`，G2 用例已钉死）。事实：同一条空白 query，落在**未加载区**时 rail 的 `userPreview` 为空串，落在**已加载区**时显示「用户输入」。

---

# 4. 接缝核对（shared 契约 / store 目录态消费一致性）

| 接缝 | 核对结果 |
|---|---|
| `V4_METHODS.conversationTurnDirectory` 命名 | `shared/src/zcode-protocol-v4/transport.ts:336-339` 定义 `"v4/conversation/turnDirectory"`；`server.ts:513`、`zcodeAgentService.ts:5286` 两处引用一致 |
| params 形状 | schema（`transport.ts:539-546`）= `{ sessionId, clientMode?, beforeQueryRowId?, limit? }`；host 层下发的 `{ sessionId, clientMode: trusted.clientMode, beforeQueryRowId?, limit? }`（`zcodeAgentService.ts:5286-5293`）与之逐字段对齐；`renderer` 侧刻意不带 `clientMode`（`agentConversationTransport.ts:348-353` 只传 sessionId/before/limit），与 `rowsRange` 同款（schema 注释「Host attachment injects this trusted value; renderer callers omit it」） |
| result 形状 | schema（`transport.ts:562-573`）= `{ entries, realUserQueryTotal, atSeq, atRevision, atLogEpoch, hasMore }`；publisher 返回体（`:579-589`）逐字段一致；`test-turn-directory.mjs:252/514/522` 用 resultSchema.parse 双向验证 |
| `limit` 双侧夹取 | schema `.min(1).max(turnDirectoryMaxEntries)` + publisher `Math.max(1, Math.min(…, 限额))` → 客户端即便自报越界值也不会越界 |
| i18n 三键 | `chat.turnNavigator.emptyAssistant` / `runningAssistant` / `userFallback` 在 en-US 与 zh-CN 均为存量键，本次 diff 只新增了 `chat.turnNavigator.jumpTargetUnavailable`（en-US.ts:2010 / zh-CN.ts:1886，各 +1 行），三态文案有承接 |
| store 目录态字段 | `ConversationTurnDirectoryState`（`conversationProjectionStore.ts:169-182`）= `{ entries, realUserQueryTotal, atRevision, atSeq, atLogEpoch, hasMore, loaded }`，与服务端 result 一一对应 + 1 个本地 `loaded` |
| store 消费点 | `SessionPane.tsx:3496-3509` 组 `turnDirectoryView`（`entryCount = entries.length`、`realUserQueryTotal`/`hasMore` 仅在 `loaded` 时透传）；`:4606-4608` 传 `turnDirectoryView` + `state.turnDirectory.entries` 给 `ConversationTimeline`；`useConversationProjection.ts:30` 闭店态给 `CLOSED_TURN_DIRECTORY` |
| 只读三要素 | 无状态：publisher 纯函数式读 `getSnapshot()`，两次调用逐字节一致（`test-turn-directory.mjs:251` `assert.deepEqual`）；超时重发安全 = 同上；带 `atLogEpoch + atRevision` = `:586-587` |
| `assistantPreviewKind` 枚举 | 服务端 `:568-573` 三态；schema `z.enum(["empty","running","text"])`（`transport.ts:566`）；客户端 `ConversationTurnNavigatorAssistantPreviewKind`（`conversationTurnNavigatorDirectory.ts:26`）同名字面量联合，且**刻意不 import 协议类型**（该模块零导入以保 Node 可测）——两处字面量靠人工同步，无类型联动 |

---

# 5. 未取证 / 越界声明

- 未运行 `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed`（属 Step 21 门禁，不在本次取证范围）。
- 未实机跑过 CDP 采样脚本（Step 3 qa: manual_user）；脚本行为仅静态核对，进程泄漏结论未实测。
- `previewText.ts`、`conversationTurnNavigatorHelpers.ts`、`conversationProjectionStore.ts`、`ConversationTimeline.tsx` 的内部逻辑不在本包范围，仅在与本模块的接缝处被引用。