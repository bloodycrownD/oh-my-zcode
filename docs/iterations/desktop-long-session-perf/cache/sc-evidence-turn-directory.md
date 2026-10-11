# 取证包：SPEC phase-turn-directory（C2）对照代码事实

> 角色：evidence 子代理。**只取证，不下结论，不给 Go/No-Go。**
> 仓库：`D:\Dev\Js\oh-my-zcode\omz`
> 取证时间：2026-10-05
> 阅读范围：严格按指派清单的 15 个文件区段（±30 行内），未展开调用链追踪、未全仓搜索。

---

## 1）SPEC C2 写了什么（逐条断言）

来源：`docs/iterations/desktop-long-session-perf/spec.md` L62-72（总体方案 C2）、L100-112（最终项目结构）、L126-129（变更点 7-9）、L135/L147-153（Step 0、Step 12-18）、L169-172（T-TD1..T-TD4）。
PRD 侧：`prd.md` L64（核心需求 3）、L68（核心需求 7）、L74-76（验收标准-数据层）、L88-89（约束）。

| # | SPEC 断言（原文要点） |
|---|---|
| A1 | 新增**独立**只读 v4 方法 `v4/conversation/turnDirectory`，理由是「同族方法形状一致是既有约定」，**照 `rowsRange`/`plans` 样板**（spec.md:64） |
| A2 | 契约落 `packages/shared/src/zcode-protocol-v4/transport.ts`：params `{ 会话定位, limit?, beforeTurnKey? }`；result `{ entries: TurnDirectoryEntry[], atSeq, atRevision, atLogEpoch, hasMore }`；`TurnDirectoryEntry = { turnKey, queryRowId, queryPreview, assistantPreview, assistantPreviewKind: "empty"\|"running"\|"text" }`；**i18n 文案不下发**（spec.md:66） |
| A3 | `PROTOCOL_V4_LIMITS` 新增 `turnDirectoryMaxEntries`（spec.md:66，文件清单 :105） |
| A4 | 服务端 `conversation-topic-publisher.ts` 新增 `getTurnDirectory()`，**照 `getPlans():464` 形状**（spec.md:67） |
| A5 | 目录**现算派生**（不在 ProductProjection 维护第二份结构）：`turnHeaderRowSchema` 定边界 + `kind === "userInput" && origin === "realUser"` 挑 query + `kind === "assistantText"` 出概要（spec.md:67） |
| A6 | gateway handler **照 `rowsRange():1559` 三段式**（`readyFlights` → `hasLiveConversation` → `ensureColdReadyPublisher`/`hydratePublisher`）；冷恢复自动可用，transcript-hydration 不改（spec.md:67） |
| A7 | 只读三要素：无状态、超时重发安全、带 `atLogEpoch + atRevision`（spec.md:67） |
| A8 | 摘要口径统一：把 renderer 的 `buildPreviewText`/`normalizePreviewParagraphs`/`truncatePreview`（220 字符/2 段落）提取到 `@zcode/shared`（`previewText.ts`）供两端复用；sessions-index 的 120 字符口径不动（spec.md:68、:85） |
| A9 | host 四件套 + renderer transport 三件：`zcodeAgent.ts`（接口+params 类型）、`zcodeAgentService.ts`（`readTrustedZCodeAgentV4Connection` + `getReadOnlyClient`）、`zcodeAgentConnectionScope.ts`（转发）、`workspaceConnectionRegistry.ts` Pick 窄面；`transport.ts`/`agentConversationTransport.ts`/`replaceableConversationTransport.ts`（spec.md:69） |
| A10 | store 拆双路径：宽屏自动触发（`shouldHydrateConversationTurnNavigatorDirectory`，`ConversationTimeline.tsx:607-677`）改为目录查询；`loadAllOlder` 保留为「正文补齐」路径（**分享模式 `SessionPane.tsx:3456-3465` 依赖全量正文语义，不能删**）（spec.md:70） |
| A11 | 失效挂现有 `turnNavigatorDirectoryRevision`（snapshot 整体替换 `:670` 与 realUser query 增删 `:747-751` 自增）（spec.md:70） |
| A12 | `realUserQueryCount < 2` 判据**由目录结果天然承接**（spec.md:70） |
| A13 | 跳转闭环：`scrollToQuery`（`ConversationTimeline.tsx:1275-1303`）目标不在已加载窗口时循环 `rowsRange`（游标 `beforeRowId`）拉到包含 anchor rowId 为止（loading 态 + 页数上限）（spec.md:71） |
| A14 | active 定位降级：`resolveConversationTurnNavigatorActiveUnitIndex` 不再依赖 `virtualItems` 测高——目录项携带 queryRowId，已加载区间用现有逻辑，未加载区间按 rowId 比较降级判定（spec.md:72） |
| A15 | Step 0 前提数字：`transport.ts`（**~860 行**）与 `conversationProjectionStore.ts`（**~1300 行**）当前是否真实通过 `pnpm lint`（max-lines 400 实际生效口径）（spec.md:135） |
| A16 | 变更点 7「v4 turnDirectory 方法全链（**13 文件**）」（spec.md:126） |

---

## 2）代码对应事实

### 2.1 契约层：transport.ts（shared）

| 项 | 事实 |
|---|---|
| 文件位置/规模 | `packages/shared/src/zcode-protocol-v4/transport.ts`，**总行数 1145**；非空非注释行 **980**（`[System.IO.File]::ReadAllLines` vs `Measure-Object`） |
| 顶部 disable 注释 | **有**，`transport.ts:1`：`/* eslint-disable max-lines -- 三个 topic 的 logical/physical/candidate schema 必须共享同一通用传输声明，避免跨文件分叉。 */` |
| `V4_METHODS as const` | **命中**，`transport.ts:326-378`。形状 = 纯对象字面量 + 尾行 `} as const;`（:378）+ `:379 export type V4Method = ...`。条目带中文注释分组（如 `:334-337` rowsRange/plans 同组注释） |
| `rowsRange` schema | **命中**，`transport.ts:504-511` params（`z.object` 非 strict：`sessionId: z.string()`、`clientMode` optional 枚举、`beforeRowId` optional、`limit: z.number().min(1).max(PROTOCOL_V4_LIMITS.rowsRangeMaxLimit)`）；`:514-523` result（`rows: z.array(conversationRowSchema)`、`atSeq`、`atRevision: z.number().int().nonnegative()`、`atLogEpoch: z.string()`、`hasMore: z.boolean()`）；`:512/:524` 两个 `z.infer` type 别名 |
| `plans` schema | **命中**，`transport.ts:528-533` params 为 `z.object({...}).strict()`，紧邻 `:526` 注释「目录来自 CLI 完整有效 projection，不能用 renderer 的有界 tail window 推导」 |
| 结论性事实 | A1/A2 的「照此形状」成立：**同族方法的既有形状 = params `z.object`（rowsRange 非 strict / plans strict）+ result 带 `atSeq/atRevision/atLogEpoch/hasMore` + 紧邻 schema 前一行中文分节注释** |

### 2.2 限额：core.ts（shared）

- **命中**，`core.ts:64-100` `export const PROTOCOL_V4_LIMITS = { ... } as const;`
- 现有分页类限额只有 `rowsRangeMaxLimit: 200`（`:76`），以及 `conversationQueryTimeoutMs: 10_000`（`:83`）。
- 文件总行数约 101（末尾 `:100 } as const;`）。
- 限额对象内注释风格为「踩坑记录式」（`:87-90` 详述 `attachmentStatMaxBytes` 的分类降级事故），新增项可沿用。

### 2.3 服务端 publisher

| 项 | 事实 |
|---|---|
| `getRowsRange` | **命中**，`conversation-topic-publisher.ts:435-457`。签名 `getRowsRange(params: { beforeRowId?: number; limit: number }, deliveryProfile: DeliveryProfileName = "replayable")`。数据源 = `this.projection.getSnapshot()` → `snapshot.rows.window`，经 `filterConversationRowsForProfile(snapshot.rows.window, DELIVERY_PROFILES[deliveryProfile])`（`:441-444`）；游标过滤 `row.rowId < beforeRowId`（`:448`）；`slice(-limit)`（`:449`）；返回 `atSeq/atRevision/atLogEpoch/hasMore`，`hasMore = eligible.length > rows.length`（`:455`）。上方 `:430-434` 注释明确「数据源 = 投影全量行」 |
| `getPlans` | **命中**，`:464-480`。形状差异：**无 params 入参**（`getPlans(): V4ConversationPlansResult`）、**result 只有 `{ plans, atSeq, atLogEpoch }`——无 `atRevision`、无 `hasMore`**（`:475-479`）。`:459-463` 注释说明为何不能用 renderer 有界 tail window |
| 邻近事实 | `:482-484` `getMessageIdForRow(rowId): string \| null` 委托 projection |
| 排序口径 | `getPlans` 用 `toSorted((l, r) => r.rowId - l.rowId)`（**降序**，`:474`）；`getRowsRange` 返回**升序**（`:449` 的 `slice(-limit)` + `:515` 注释）——**同族两方法方向相反** |

### 2.4 gateway handler 三段式

- **命中**，`v4-gateway.ts:1559-1575` `async rowsRange(rawParams: unknown)`：`:1560` schema parse → `:1561` `this.readyFlights.get(params.sessionId)` → `:1562-1566` 三元 `existingReady ? await existingReady : (!this.hasLiveConversation(sessionId) ? await this.ensureColdReadyPublisher(sessionId) : await this.hydratePublisher(sessionId))` → `:1567` 委托 publisher，`:1572-1573` 传 `clientMode === "desktop-continuous" ? "continuous" : "replayable"`。
- **`plans` 是同一三段式的第 2 个实例**，`v4-gateway.ts:1578-1587`（同样 `readyFlights` → `hasLiveConversation` → `ensureColdReadyPublisher`/`hydratePublisher`），`:1577` 注释「冷会话复用订阅 hydration」。
- A6 成立：三段式是**已复制两次的既有模板**，新增 handler 照抄无结构性风险。

### 2.5 server.ts switch case

- **命中**，`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts:510-520`：`// ── 行分页 query（独立分支…）──` 分节注释下，`case V4_METHODS.conversationRowsRange: return await this.requireV4Gateway().rowsRange(request.params);`（`:511-512`）、`case V4_METHODS.conversationPlans:`（`:513-514`）、`case V4_METHODS.backgroundBashOutput:`（`:515-516`）等。
- 每 case 两行、无块体，直接 `return await this.requireV4Gateway().<method>(request.params)`。文件总行数 859。

### 2.6 host 四件套

| 项 | 事实 |
|---|---|
| `zcodeAgent.ts` params 类型 | **命中**，`:376-382` `ZCodeAgentConversationRowsRangeParams extends ZCodeAgentSessionTarget { beforeRowId?; limit }`（JSDoc `:380` 明写「1..rowsRangeMaxLimit（200）」）；`:384-385` `ZCodeAgentConversationPlansParams = ZCodeAgentSessionTarget`（**类型别名，非 interface**） |
| `zcodeAgent.ts` 接口方法 | **命中**，`:761-767` `conversationRowsRangeV4(...): Promise<V4ConversationRowsRangeResult>` + `conversationPlansV4(...): Promise<V4ConversationPlansResult>` |
| `zcodeAgentService.ts` 实现 | **命中**，`:5259-5273` `conversationRowsRangeV4`：`readTrustedZCodeAgentV4Connection(params)`（`:5260`）→ 失败抛 `fault.conversation.rowsRangeConnectionUntrusted`（`:5261`）→ `getReadOnlyClient(params)`（`:5262`）→ `client.request(V4_METHODS.conversationRowsRange, {...}, v4ConversationRowsRangeResultSchema)` |
| 重要差异 | **`conversationPlansV4`（`:5276-`）不调用 `readTrustedZCodeAgentV4Connection`**，`:5275` 注释「只读计划目录沿现有 workspace attachment 透传，不建立新 runtime」。即 SPEC A9 说的 `readTrustedZCodeAgentV4Connection` **不是同族方法的统一既有约定**，只有 rowsRange 有 |
| `zcodeAgentConnectionScope.ts` 转发 | **命中**，`:736-741` `conversationRowsRangeV4(params) { assertReady(); return base.conversationRowsRangeV4(withTrustedConnection(params, forwardedConnection(params))); }`。**`conversationPlansV4` 在该文件 730-742 区间内不存在转发**（该区间只有 `backgroundBashOutputV4` 与 `conversationRowsRangeV4`） |

### 2.7 renderer transport 三件

| 项 | 事实 |
|---|---|
| `transport.ts`（ui）接口 | **命中**，`packages/ui/src/v4/transport.ts:61-64`：`rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult>`、`plans(params: V4ConversationPlansParams): Promise<V4ConversationPlansResult>`，每个方法一条 JSDoc 单行注释，参数类型直接从 shared 导入 |
| `agentConversationTransport.ts` Pick 联合 | **命中**，`:52-74` `type ConversationV4AgentService = Pick<IZCodeAgentService, "subscribeConversationV4" \| ... \| "conversationRowsRangeV4"（:61） \| "conversationPlansV4"（:62） \| ...>` |
| `agentConversationTransport.ts` rowsRange 实现 | **命中**，`:332-340` `async rowsRange(params) { await ensureHandshake(); return agentService.conversationRowsRangeV4({ ...workspace, sessionId, ...(beforeRowId!==undefined?{beforeRowId}:{}) , limit }); }`；`:341-347` plans 同形。`:348` 注释记录了「workflowRun* 因 max-lines 边界拆到 `agentConversationTransportWorkflowRuns.ts`」的既有先例 |
| `replaceableConversationTransport.ts` | **命中**，`:130-134` `rowsRange(params: Parameters<ConversationTransport["rowsRange"]>[0]): ReturnType<...> { return this.current.rowsRange(params); }`；`:136-140` plans 同形。`:142-144` 注释记录了历史遗漏（workflowRunEvents 漏转发）的教训 |

### 2.8 目录派生所需字段（rows.ts）

- **命中** `packages/shared/src/zcode-protocol-v4/rows.ts:10-30` `rowBaseFields = { rowId: z.number(), turnId: z.string(), entityId?, productTurnId?, visibility?, createdAt, createdAtSeq, actions? } as const`。**`turnId` 与 `rowId` 均在 rowBase 上**（`:11-12`）→ 目录项 `turnKey`（可映射 `turnId` 或 `productTurnId`）与 `queryRowId` 的数据来源齐备；文件总行数 345。
- **命中** `rows.ts:58-96` `turnHeaderRowSchema`：`kind: z.literal("turnHeader")`（`:60`）、`origin` 闭集枚举（`:64-70`：`userInput`/`backgroundResult`/`goalContinuation`/`editRerun`/`workflowLaunch`）、`state: z.enum(["running","completedSuccess","completedInterrupted","failed"])`（`:77`）、`activeMs?`（`:81`）。可作 A5「定边界」。`:62-63` 注明闭集加值的旧客户端偏斜。
- **命中** `rows.ts:100-120` `userInputRowSchema`：`kind: z.literal("userInput")`（`:102`）、`text: z.string()`（`:103`）、`epilogueStart?`（`:106`）、`origin` 闭集枚举（`:110-117`）**首项即 `"realUser"`（`:111`）**。A5 的 `origin === "realUser"` 判据在 schema 层可判定。

### 2.9 store 失效代际（conversationProjectionStore.ts）

| 项 | 事实 |
|---|---|
| 字段定义 | **命中**，`:131` `turnNavigatorDirectoryRevision: number;`（`ConversationStoreState` 内），`:124-130` JSDoc 明写「real-user query 增删（`row.appended`/`row.upserted` 命中 realUser userInput，或 `row.removed` 截断分支）与 snapshot 整体替换时递增此 revision，使**终态缓存**失效」 |
| 自增点 1 | **命中**，`:666-671` snapshot 整体替换分支内 `turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1`（`:670`），与 `planDirectoryRevision`（`:668`）并列；`:669` 注释「snapshot 整体替换后 real-user query 集合可能已变，终态缓存必须失效」 |
| 自增点 2 | **命中**，`:747-751` 条件展开 `...(shouldInvalidateTurnNavigatorDirectory(frame) ? { turnNavigatorDirectoryRevision: ... + 1 } : {})`，`:745-746` 注释同上 |
| `realUserQueryCount < 2` 判据 | **命中**，`:1118-1122`：`const realUserQueryCount = [...olderRows, ...current.rows.window].reduce((count, row) => (row.kind === "userInput" && row.origin === "realUser" ? count + 1 : count), 0); if (realUserQueryCount < 2) { … status: "not-enough-queries" … this.turnNavigatorHydrationTerminal = result; return result; }`（`:1147-1153`） |
| 关键性质 | 该计数**当前是对「已实际拉取到的行」逐行 reduce**（`olderRows` = 循环 rowsRange 得到的探测页 + 当前窗口），**不是服务端下发的权威计数** |
| 文件规模 | 总行数 **1383**；非空非注释 **1321**；`:1` 有 `/* eslint-disable max-lines -- projection/base/recovery/optimistic 必须共享一个原子 store 状态机… */` |

### 2.10 分享模式依赖（SessionPane.tsx）

- **命中**，`SessionPane.tsx:3447-3454` `handleLoadAllOlder = useCallback(() => lease ? lease.store.loadAllOlder() : Promise.resolve({ status: "stale", logEpoch: snapshot?.logEpoch ?? "unknown" }), [lease, snapshot?.logEpoch])`。
- **命中**，`:3456-3465` 分享模式 effect：`useEffect(() => { if (!shareActive || !sessionId || !hasOlderRows(snapshot)) return; const key = \`${sessionId}:${snapshot?.logEpoch ?? "unknown"}\`; if (shareHydratedSessionRef.current === key) return; shareHydratedSessionRef.current = key; void handleLoadAllOlder().catch(...) }, [handleLoadAllOlder, sessionId, shareActive, snapshot])`，`:3462` 日志 tag `[conversation-share] 补齐分享目录失败`。文件总行数 4271。
- A10「不能删」成立：分享路径确实直接依赖 `loadAllOlder()` 的全量正文语义。

### 2.11 hydration effect 与 scrollToQuery（ConversationTimeline.tsx）

- **命中** `ConversationTimeline.tsx:607-677` hydration effect：`:609` 调 `shouldHydrateConversationTurnNavigatorDirectory({ canLoadOlder, containerWidthPx: turnNavigatorContainerWidthPx, hasLoadHandler: Boolean(onLoadAllOlder), loadingOlder })`；`:618-620` 注释「terminal key 必须与 store `turnNavigatorDirectoryRevision` 同步…否则组件层 terminal 永久拦截」；`:621` `hydrationKey = \`${sessionKey}:${rowContext.logEpoch ?? "unknown"}:${turnNavigatorDirectoryRevision}\``；`:640` `void onLoadAllOlder().then(result => …)`，`:642` 对 `"hydrated" | "not-enough-queries"` 置 `terminal`，`:646` 对 `"stale"` 置回 `idle`，`:650-664` 退避重试（`:651` `resolveConversationTurnNavigatorHydrationRetryDelayMs`，退避 250ms/1000ms/终态，见 helpers `:93-97`）。依赖数组 `:666-677` 含 `turnNavigatorDirectoryRevision`。文件总行数 1737。
- **命中** `ConversationTimeline.tsx:1275-1303` `scrollToQuery = useCallback((target: { unitIndex: number; rowId: number }, behavior: ScrollBehavior = "auto") => …`，其中 `:1285` `element.querySelector<HTMLElement>(\`[data-row-id="${target.rowId}"]\`)`，`:1286 if (!rowElement) return false;`，`:1306-1307` `const element = scrollRef.current; if (!element || scrollMountedQuery(element)) return;`。A13 的「未挂载则失败返回」入口确实存在（未读完 `scrollToQuery` 尾部 `:1307` 之后的失败分支）。

### 2.12 摘要工具可提取性（conversationTurnNavigatorHelpers.ts）

- **命中** `packages/ui/src/v4/conversationTurnNavigatorHelpers.ts:99-135`：`DEFAULT_MAX_PREVIEW_CHARS = 220`（`:99`）、`DEFAULT_MAX_PREVIEW_PARAGRAPHS = 2`（`:100`）、`normalizePreviewParagraphs(text, maxParagraphs)`（`:102-109`，`/\n\s*\n/u` 分段 + `/\s+/gu` 折叠 + `slice(0, Math.max(1, maxParagraphs))`）、`truncatePreview(text, maxChars)`（`:111-117`，`Math.max(8, maxChars)` + `slice(0, n-3).trimEnd()` + `...`）、`buildPreviewText({texts, fallback, maxPreviewChars, maxPreviewParagraphs})`（`:119-135`）。
- **可提取性证据**：`:102-135` 全部为**纯字符串函数，零外部标识符引用**（无 i18n、无组件、无 React、无 store、无类型导入依赖）→ A8 的「提取到 `@zcode/shared`」在函数体层面无阻碍。
- 但三者**均未 `export`**（`:102/:111/:119` 均为裸 `function`）→ 提取/复用需新增导出或搬迁；同文件 `:137-140` 的 `buildAssistantPreview(unit: ConversationTurnRenderUnit, …)` 依赖 UI 类型，**不在可提取范围**。
- 文件总行数 332（非空 293）→ 新增 `previewText.ts` 后原文件仍低于 400。

### 2.13 active 定位对 virtualItems 的依赖

- **命中** `conversationTurnNavigatorHelpers.ts:217-268` `resolveConversationTurnNavigatorActiveUnitIndex({ items, virtualItems, scrollOffsetPx, viewportHeightPx })`：
  - `:227` `new Map(items.map(item => [item.unitIndex, item]))`；
  - `:233-248` **主循环完全遍历 `virtualItems`**，`virtualItem.start/size` 做视口相交与「距视口顶距离最小」择优；
  - `:254-267` 兜底：`virtualItems.find(...)` 取 `topVirtualIndex` → `items.find(unitIndex >= top)` → `items.findLast(unitIndex <= top)` → `items[0]`。
- A14 成立：`virtualItems` 是该函数**两处**（主循环 + 兜底）的硬依赖，降级判定必须同时覆盖这两条路径。

### 2.14 服务端 import `@zcode/shared` 先例

- **先例 1**：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:1-5` `import { backgroundBashOutputResultSchema, v4BackgroundBashOutputParamsSchema, type BackgroundBashOutputResult } from "@zcode/shared/zcode-protocol-v4";`
- **先例 2**：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts:13-22` `import { Buffer } from "node:buffer";` + `import { SessionEventType, type SessionEvent } from "@zcode/contracts";` + `import type { CommandEnvelope, ConversationDelta, ConversationRowTarget, ConversationSnapshot, ConversationTopicFrame, DeliveryProfile, DeliveryProfileName, … } from "@zcode/shared/zcode-protocol-v4"`（多行 type 导入，跨过读入窗口）。
- 结论：shared 包被服务端（CLI bootstrap）引用**已有既例**，A15 成立。

### 2.15 `@zcode/shared` 导出面（额外取证，因 A8 直接依赖）

- `packages/shared/package.json` 的 `exports` 是**桶映射**：`"./zcode-protocol-v4": "./src/zcode-protocol-v4/index.ts"`（与 `"./mcp"`、`"./model-config"` 等同形）。
- 含义：新增 `packages/shared/src/zcode-protocol-v4/previewText.ts` **不需要改 package.json**，但**必须由 `index.ts` 再导出**才能被 `@zcode/shared/zcode-protocol-v4` 引用。
- `packages/shared/package.json` 的 lint 脚本是 `"lint": "oxlint"`（**非 eslint**）；`transport.ts:1` 的 `/* eslint-disable max-lines */` 注释在 oxlint 下按兼容指令解析。

### 2.16 lint 规则实际口径

- 根 `omz/.oxlintrc.json:6`：`"max-lines": ["error", { "max": 400, "skipBlankLines": true, "skipComments": true }]` → **400 生效，但空行与注释行跳过**。
- `omz/.oxlintrc.json:12-15`：`**/*.test.ts|.test.tsx|.spec.ts|.spec.tsx` 的 `max-lines` 置 `"off"`（SPEC :84 「*.test.ts 豁免 max-lines」成立）。
- `:18-21`：`i18n/locales/*.ts` 同样 off。
- 因此判定口径应使用「非空非注释行数」，即 `transport.ts` **980**（非 1145）、`conversationProjectionStore.ts` **1321**（非 1383）。

---

## 3）可疑点清单（每条附证据；不含结论与 Go/No-Go）

**S1 — Step 0 的行数前提数字与代码不符（两个都偏低/偏高方向不一）。**
SPEC:135 写 `transport.ts` **~860 行**；实测 **1145 总行 / 980 有效行**（`ReadAllLines` 与 `Measure-Object` 双测）。SPEC 同句的 `conversationProjectionStore.ts` **~1300 行**实测 **1383 总行 / 1321 有效行**（PRD:89 的「1300+ 行」与之相符）。两文件 `:1` 均**已带 `eslint-disable max-lines`** 且 `.oxlintrc.json:6` 的口径为 400 且 skipBlank/skipComment——即 Step 0 要回答的「是否真实通过 lint」在**新增代码之前就已由 disable 注释回答**，Step 0 的前提数字与提问方式都需与代码对齐。
证据：`transport.ts:1`、`conversationProjectionStore.ts:1`、`omz/.oxlintrc.json:6,12-15`。

**S2 — 契约缺「排序方向」与游标语义定义，`beforeTurnKey?` + `hasMore` 无法判定。**
A2 的 result 只给 `entries[] + hasMore`，params 只给 `beforeTurnKey?`，**未规定 entries 是升序还是降序**。而同族两方法方向相反且各自有注释：`getRowsRange` 升序（`conversation-topic-publisher.ts:449` + `transport.ts:515`），`getPlans` **降序**（`:474` `toSorted((l, r) => r.rowId - l.rowId)`）。目录是要「按轮次时间顺序展示」的列表，游标方向不定则 `hasMore`/`beforeTurnKey` 的实现与测试（T-TD2 要求「顺序…正确」）都无唯一解。
证据：`conversation-topic-publisher.ts:449,474`、`transport.ts:515`、`spec.md:66`。

**S3 — `turnKey` 的取值口径未定义，且与既有字段存在歧义。**
A2 写 `turnKey`，代码里 `rowBaseFields` 同时存在 **`turnId`（`rows.ts:12`）与 `productTurnId`（`rows.ts:16`，注释「productTurnId 是产品轮次，不得由 UI 重猜」）**。目录项的 turn 身份到底取哪个未写明；`turnKey` 也未在 `rows.ts` 任何 schema 中作为字段名出现（是派生名还是新字段名不明）。
证据：`rows.ts:10-16`、`spec.md:66`。

**S4 — `assistantPreviewKind` 的三态在数据源上没有判定依据。**
A2 定义 `"empty" | "running" | "text"` 三态，A5 说概要来自 `kind === "assistantText"`。但已读的 `rows.ts:58-96` / `:100-120` 区段**未见 `assistantText` 这一 kind 的 schema**（本轮按纪律未展开读该 kind 定义处），且 `running` 态在何种行级信号上判定（是 `turnHeader.state === "running"`（`rows.ts:77`）还是存在 toolCall 未终态）SPEC 未指明。T-TD2 把「三态」列为验收项，但判定规则缺环。
证据：`rows.ts:56-120`、`spec.md:66,170`。

**S5 — `realUserQueryCount < 2` 「由目录结果天然承接」缺少可推导性论证。**
现实现是**对已拉取行逐行 reduce**（`conversationProjectionStore.ts:1118-1121`），且带专门的「不合并探测页」内存权衡注释（`:1138-1140`：wire snapshot 只保留 60 rows，为一个不会显示的 rail 常驻完整历史不划算）。目录 result 不含**权威 query 总数**字段（只有 `entries` + `hasMore`），要承接该判据必须依赖「entries.length 与 hasMore 的组合恰好能推出 <2」——而这依赖 S2 未定的排序方向与 `hasMore` 定义。
证据：`conversationProjectionStore.ts:1118-1153`、`spec.md:66,70`。

**S6 — `atRevision` 在同族方法上并非统一约定。**
A7 断言「只读三要素…带 `atLogEpoch + atRevision`」，但紧邻的 `getPlans()` 返回值**只有 `atSeq`/`atLogEpoch`，无 `atRevision`**（`conversation-topic-publisher.ts:475-479`）。`atRevision` 只在 `getRowsRange`（`:453`）与 `transport.ts:519` 出现。A11 又要目录失效挂 store 侧 `turnNavigatorDirectoryRevision`，与 wire 侧 `atRevision` 是两套代际，SPEC 未说明二者关系。
证据：`conversation-topic-publisher.ts:453,475-479`、`transport.ts:517-520`、`conversationProjectionStore.ts:131`。

**S7 — `readTrustedZCodeAgentV4Connection` 不是同族方法的统一约定（SPEC 表述过强）。**
A9 把 `readTrustedZCodeAgentV4Connection + getReadOnlyClient` 写成 host 四件套的通用做法，但 `conversationPlansV4` **不调用** `readTrustedZCodeAgentV4Connection`（`zcodeAgentService.ts:5275-5279`），且 `zcodeAgentConnectionScope.ts` 的转发区（`:730-742`）**只有 `conversationRowsRangeV4`、没有 `conversationPlansV4`**。即同族只读方法在「是否需 trusted connection 校验 / 是否经 connection scope 转发」上已经分叉，SPEC 未指定新方法跟哪一支（这直接影响 A11 的 revision 失效与 renderer 侧连接语义）。
证据：`zcodeAgentService.ts:5259-5279`、`zcodeAgentConnectionScope.ts:730-742`。

**S8 — A15 的「13 文件」与 SPEC 自己的文件清单对不上（清单只列了 12 个条目，且 `workspaceConnectionRegistry.ts` 只在正文出现、未进清单；反之 `packages/shared/src/zcode-protocol-v4/index.ts` 必需却未列）。**
逐条数 SPEC:100-111 的「变更文件」：`ConversationTurnGroup.tsx`、`ConversationTurnRow.tsx`、`ConversationTurnNavigator.tsx`、`conversationTurnNavigatorHelpers.ts`、`shared/transport.ts`、`shared/core.ts`、`publisher.ts`、`v4-gateway.ts`、`server.ts`、`services 三件（含 workspaceConnectionRegistry）`、`ui transport 三件`、`knip.json` = 12 条目 + 三件套/三件套算多文件 → 「13 文件」口径不明。更实质的问题：`@zcode/shared` 是桶导出（`packages/shared/package.json` 的 `"./zcode-protocol-v4": "./src/zcode-protocol-v4/index.ts"`），新增 `previewText.ts` **必须改 `index.ts` 再导出**，而该文件在 SPEC:100-112 的新增/变更清单里**完全缺失**。
证据：`spec.md:100-112,126`、`packages/shared/package.json` exports。

**S9 — 摘要工具提取的「逐字节一致」（T-TD1）缺少「搬迁 vs 复制」与旧实现去留的说明。**
`buildPreviewText`/`normalizePreviewParagraphs`/`truncatePreview` 位于 `conversationTurnNavigatorHelpers.ts:102-135`，**均未 export**，且紧邻的 `buildAssistantPreview`（`:137-140`）依赖 UI 类型 `ConversationTurnRenderUnit`。SPEC:68 只说「提取到 @zcode/shared 供两端复用」，未说明原文件三函数是删除、改为 re-export 还是保留副本；T-TD1 的「逐字节一致」在搬迁场景下需要同时验证 renderer 侧调用点已切换（`buildAssistantPreview` 的调用方不在本轮阅读范围）。
证据：`conversationTurnNavigatorHelpers.ts:99-140`、`spec.md:68,169`。

**S10 — A14 的降级判定需同时改两处分支，SPEC 只描述了一处语义。**
`resolveConversationTurnNavigatorActiveUnitIndex` 对 `virtualItems` 的依赖有**两条路径**：主循环择优（`:233-248`）与 `topVirtualIndex` 兜底链（`:254-267`，且用了 `items.findLast`）。A14 的表述「已加载区间用现有逻辑，未加载区间按目录项 rowId 与窗口首行 rowId 的比较降级判定」未说明两条路径在混合态（部分目录项已挂载、部分未挂载）下的分工与优先级，而这恰是 A13 跳转闭环引入的常态。
证据：`conversationTurnNavigatorHelpers.ts:217-268`、`spec.md:72`。

**S11 — A13 的 `rowsRange` 循环拉取与「不让全量正文驻留 renderer」的目标存在张力，且页数上限未给值。**
A13 要求「循环 rowsRange 拉到包含 anchor rowId 为止（设页数上限防失控）」，但未给上限数值、失败终态（拉到最旧仍未见 anchor 时 UI 如何表现）、以及是否复用 `zcodeAgentService.ts:5259-5273` 的 `limit` 上限（`PROTOCOL_V4_LIMITS.rowsRangeMaxLimit = 200`，`core.ts:76`）与超时（`conversationQueryTimeoutMs = 10_000`，`core.ts:83`）。另注：现 `loadAllOlder` 的探测页在 `realUserQueryCount < 2` 时**刻意不合并**（`conversationProjectionStore.ts:1138-1140`），跳转闭环若无条件合并探测页会与该内存权衡相反。
证据：`conversationProjectionStore.ts:1138-1155`、`core.ts:76,83`、`spec.md:71`。

**S12 — `shouldHydrateConversationTurnNavigatorDirectory` 的入参含 `hasLoadHandler`/`canLoadOlder`，改为目录查询后契约未定义。**
现 effect（`ConversationTimeline.tsx:607-617`）把 `canLoadOlder` / `containerWidthPx` / `hasLoadHandler: Boolean(onLoadAllOlder)` / `loadingOlder` 交给判定函数。A10 说宽屏自动触发「改为目录查询」，但该判定函数的**函数签名与实现未列入任何变更文件清单**（SPEC:100-112 无此文件），且 `loadingOlder`（正文分页状态）与目录查询状态是否解耦未说明——A10 的「拆双路径」正落在这里。
证据：`ConversationTimeline.tsx:607-677`、`spec.md:70,100-112`。

**S13 — `assistantText` 与 `ToolCallRow`/`DeliveryProfileName` 之外的目录过滤维度未对齐 delivery profile。**
`getRowsRange` 会按 `clientMode` 走 `filterConversationRowsForProfile(snapshot.rows.window, DELIVERY_PROFILES[deliveryProfile])`（`conversation-topic-publisher.ts:441-444`，`continuous` vs `replayable`），`getPlans` **不过滤**。目录方法若不过滤，`replayable`（断线恢复）档位的 renderer 可能看到本应被 profile 隐藏的行派生的目录项；A5 的派生条件只列了 `turnHeader`/`userInput`/`assistantText` 三种 kind，未提 profile 过滤。
证据：`conversation-topic-publisher.ts:435-444,464-474`、`transport.ts:507`、`spec.md:67`。

**S14 — T-TD3 的触发信号表述与代码判据函数名不一致（表述层面对齐问题）。**
T-TD3 写「目录失效：`row.removed`（edit/retry 截断）后 revision 自增并触发重查」，代码侧真实判据是 **`shouldInvalidateTurnNavigatorDirectory(frame)`**（`conversationProjectionStore.ts:747`），其定义处不在本轮阅读范围；JSDoc（`:124-130`）提到的是 `row.appended`/`row.upserted`/`row.removed` 三类。T-TD3 只提 `row.removed`，比代码注释窄，且未点名判据函数——测试若按 T-TD3 字面写会漏掉 append/upsert 分支。
证据：`conversationProjectionStore.ts:124-131,745-751`、`spec.md:171`。

---

## 4）无法核实项（超出指派阅读范围或需更大窗口）

| # | 事项 | 原因 |
|---|---|---|
| U1 | `assistantText` kind 的实际 schema 定义与字段（`rows.ts` 该 kind 段落） | 超出指派的 `rows.ts:10-30/58-96/100-120` 区段；S4 因此只能标为可疑而不能判定 |
| U2 | `shouldInvalidateTurnNavigatorDirectory` / `shouldInvalidatePlanDirectory` 的函数实现与覆盖帧类型 | 未在指派区段内 |
| U3 | `shouldHydrateConversationTurnNavigatorDirectory` 的签名与阈值实现 | 文件未列入指派清单（S12 据调用点参数推断） |
| U4 | `resolveConversationTurnNavigatorActiveUnitIndex` 的 options 类型定义（`ResolveConversationTurnNavigatorActiveUnitIndexOptions`）与 `items` 元素是否已携带 rowId | 定义处未读 |
| U5 | `buildConversationTurnNavigatorItems` / `buildAssistantPreview`（`helpers:137-` 之后）与 `ConversationTurnNavigator.tsx` 的 items 数据源合并点（T-TD4 的落点） | 未在指派区段内 |
| U6 | `workspaceConnectionRegistry.ts` 的 Pick 窄面实际形态 | SPEC 正文提及但未列入 15 项取证清单；A9 中该文件为唯一「未验证」的 host 侧成员 |
| U7 | `conversationProjectionStore.ts` 中 `loadAllOlder` 的完整循环/分页实现与 `preserveIncompleteLeadingTurn` 语义 | 只读到 `:1112-1156`，未覆盖函数头部 |
| U8 | `ConversationTimeline.tsx:1307` 之后 `scrollToQuery` 的失败分支与是否已有分页拉取骨架 | 读窗口止于 1307，A13 只能确认「挂载失败即返回 false」这一入口 |
| U9 | 是否存在 `packages/shared/src/zcode-protocol-v4/apply.test.ts` 既有文件（SPEC:86 列为新增） | 未查文件存在性 |
| U10 | `pnpm lint` 是否当前零报错（Step 0 的实证） | 未执行 lint；仅取到 `.oxlintrc.json` 规则口径 |

---

**统计**：SPEC C2 断言 16 条（A1-A16）→ 代码**逐条命中 14 条**，**部分成立/需对齐 2 条**（A15 行数前提、A9 trusted-connection 表述）。
可疑点 **14 条**（S1-S14），其中 **S2/S4/S5** 直接落在契约完备性上，**S8** 落在变更文件清单完整性上。
无法核实项 **10 条**（U1-U10）。
