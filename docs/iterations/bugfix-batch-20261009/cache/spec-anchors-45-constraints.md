# spec-anchors-45-constraints — 缺陷④⑤锚点核验 + 现状约束三断言 + busy 分类取证

- 取证时间：2026-10-09
- 待核验文档：docs/iterations/bugfix-batch-20261009/spec.md（缺陷④⑤ + 「现状约束」）
- 仓库基线：D:\Dev\Js\oh-my-zcode\omz（apps/zcode-cli/packages 下 packages；路径省略 `apps/zcode-cli/` 前缀）
- 结论口径：命中 = 行号与所述内容均对得上；偏移 = 内容在但行号有出入（标出实际行）；失效 = 所述内容不存在

## 一、缺陷④锚点核验（4/4 命中）

| 锚点 | 结论 | 代码摘要 |
|---|---|---|
| `contracts/src/tools/contracts`…（`contracts/src/tools/agent.ts:44-55`，AgentCompletedOutput 无 childSessionId） | **命中** | :44-55 `export interface AgentCompletedOutput { status/agentId/agentType/description/prompt/content/totalToolUseCount/totalDurationMs/totalTokens?/usage? }`，共 10 个字段，确无 childSessionId。对照 :57-68 `AgentBackgroundedOutput`（异步侧）有 `childSessionId: string`（:64）——两侧不对齐属实。 |
| `contracts/src/tools/agent.ts:79-92`（zod .strict()） | **命中** | :79-92 `AgentCompletedOutputSchema = z.object({ … }).strict()`，字段与接口同构、无 childSessionId；:94-107 异步侧 schema 有 childSessionId（:102）。`AgentOutputSchema` 为 :109-112 union。 |
| `core/src/tool/handlers/agent.ts:23-52`（completed 分支 additionalProperties:false + required） | **命中** | :23-82 `AGENT_TOOL_OUTPUT_SCHEMA`（JSON Schema，oneOf[0]=completed）。:42 `additionalProperties: false`（content items）、:51 completed 分支 `additionalProperties: false`、:50 `required: ["status","agentId","prompt","content","totalToolUseCount","totalDurationMs"]`（无 childSessionId）。**附带发现**：oneOf[1] 异步分支（:53-80）properties 也没有 childSessionId（仅 status/agentId/description/prompt/outputFile/canReadOutputFile）且 :79 additionalProperties:false——handler 的 JSON schema 与 contracts zod（异步侧有 childSessionId）已存在既有不一致。 |
| `core/src/tool/handlers/agent.ts:137-151`（formatAgentOutputForModel 同步分支无 sessionId） | **命中** | :130-172 `formatAgentOutputForModel`；:137 起 `if (data.status !== "async_launched")` 同步分支：输出 childContent + `agentId: …` + usage 三行（:146-150），**无 sessionId/childSessionId 行**；:153-171 异步分支文本同样只出现 agentId，未透出 childSessionId。 |

小结：④ 的「同步输出无 childSessionId、且 zod .strict() 与 handler JSON schema 双 strict」证据链完整。
spec 变更点 4a（contracts 接口+zod 双改）、4c（handler schema + 渲染）的锚点行区间可用。

## 二、缺陷⑤锚点核验（8/8 命中）

| 锚点 | 结论 | 代码摘要 |
|---|---|---|
| `bootstrap/src/app/magic-context-turn-transform.ts:770-830`（enabled 门/开库/fail-closed/storage_unavailable/dispose） | **命中**（全部子点逐行对上） | :770-772 `createMagicContextTurnTransform` 工厂；**:776 `if (!options.enabled) return undefined;`**（静默路径 1，:773-775 注释说明「关着时既不建 bridge、也不 import、更不开 DB」）；:810 `const db = openDatabase(getMagicContextDatabasePath());`；**:811 `if (!db) {`**；:812-815 fence/detail 构造（`getSchemaFenceRejection()`→「schema fence rejected」/ 否则「could not be opened」）；**:816-818 `if (config.fail_closed_blocking !== false) { throw new Error(\`[magic_context] ${detail} (fail_closed_blocking=true)\`); }`**；**:819-823 `options.logger.warn("Magic context storage unavailable; transform stays inert", { event: "magic_context.storage_unavailable", … })`**；**:826-827 `disposeBridge(); return undefined;`**。另 :781 `initializeMagicContextHost()` 在任何 DB 写之前（S15 遗留 #6）。 |
| `bootstrap/src/app/create-app.ts:782-897`（动态 import / recorder 先建 / 端口在场即注册） | **命中** | :782-785 `const magicContextAssembly = runtimeConfig.magicContext?.enabled === true ? await import("./magic-context-turn-transform.js") : undefined;`（import 失败无 try/catch，直接冒泡）；**:786-789 `createMagicContextUsageRecorder(sessionId, logger)` 在 transform 工厂之前创建**；:794-843 transform 工厂调用（含 :799 `enabled: runtimeConfig.magicContext?.enabled === true` 与 :876-779 注释「单生产者 contextUsageMap」）；**：897 `...(magicContextTurnTransform === undefined ? {} : { magicContextTurnTransform })`**（端口在场即注册，缺席即纯判空）。另 :783-785 的动态 import 失败会静默断链——与 5b 计划的「捕获 import 失败并入 5a 事件」对应。 |
| `magic-context/src/core/features/magic-context/storage-db.ts:260-270`（installBootBusyTimeout 每次成功开库都打） | **命中** | :260-270 `installBootBusyTimeout(db, dbPath, timeoutMs, report)` = `db.exec(\`PRAGMA busy_timeout=${timeoutMs}\`)` + `report(\`[magic-context] SQLite boot busy timeout: backend=${detectSqliteRuntime()} timeout=${timeoutMs}ms path=${dbPath}\`)`。调用点 :2666 在 `new Database(dbPath)` 成功**之后**无条件执行 → 是成功诊断行而非失败信号；真实失败信号是 :2684 `log('[magic-context] storage fatal: failed to open …')`。spec「本机取证」结论与代码一致。 |
| `storage-db.ts:2622-2691`（openDatabase null 分支与 throw 分支） | **命中** | :2622-2691 同步 `openDatabase`：:2631-2642 pendingAsyncOpens 竞争拒绝返回 null（log `storage not ready: … refusing a second synchronous open`）；:2644-2646 / :2667-2670 schema fence null；:2671-2674 migration guard null；**:2679-2690 catch：`log(\`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}\`)` + `throw new Error(\`[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.\`)`**。另 :2604-2618 官方注释明示双失败形态（fence=null 可恢复，fatal=throw）与「callers MUST both null-check AND be prepared for a throw」「NEVER a silent in-memory fallback」。 |
| `magic-context/src/core/hooks/magic-context/transform-postprocess-phase.ts:2547-2549`（execute 时单独 updateSessionMeta({lastResponseTime})） | **命中** | :2545-2546 注释「After a TTL-based scheduler execute, reset lastResponseTime so subsequent transforms defer instead of re-executing every pass.」；**:2547 `if (args.schedulerDecision === "execute" && !materializationRequested) {` :2548 `updateSessionMeta(args.db, args.sessionId, { lastResponseTime: Date.now() });` :2549 `}`**。在 TTL 到期 execute 后单独推进时间戳、且不与任何「真实 provider usage 读数」绑定——与 usage 假 0% 的组合误导成立。 |
| `bootstrap/src/app/magic-context-usage-summary.ts:67`（usedPercent 假 0%） | **命中** | :67 `usedPercent: finite(snapshot.contextPercentage, 0),`——读不到真读数时回落字面 0。上下文：:62 `if (!snapshot) return { usage: null }`、:74-75 catch 也返 null；即「有 snapshot 但 percentage 类型为默认/0」与「无读数」在面板上分不开。:36-39 接口注释已声明「`usage` 为 `null` 即没有可展示的读数」——5c 的 null 语义与既有注释方向一致。 |
| `magic-context/host/config/schema.ts:198-203`（fail_closed_blocking 默认 true） | **命中**（注：实际文件在包内 `src/host/config/schema.ts`，spec 路径省略了 `src/`） | :198-203 `fail_closed_blocking: z.boolean().default(true).describe("When Magic Context cannot operate (schema fence mismatch, storage open/migration failure), block the primary-session prompt with a loud recovery error instead of silently degrading. Default true. Set false only to restore the old degrade-silently behavior (not recommended).")`。 |

小结：⑤ 的全部锚点（含 spec 描述的各静默路径、诊断行语义、fail-closed throw、usage 假 0）与当前代码一致，无偏移。

## 三、任务 B：spec「现状约束」三断言（3/3 命中）

1. **`host/config/schema.ts:198-203` 注释确为「fence/存储失败应 loud block」语义且默认 true —— 命中**。describe 原文见上表（"schema fence mismatch, storage open/migration failure … loud recovery error instead of silently degrading. Default true."），`.default(true)`。即 spec 引用的「fail-closed 契约：busy 重试须有上界、上界后仍 throw」有 schema 层依据。
2. **`core/src/subagent/runner.ts:465-468` port.start 对 signal 只判启动时已 aborted、不挂 listener —— 命中**。该区间位于 port.start 实现（:439-526 `async start(rawRequest, startOptions)`）：:465 `const taskAbort = createSubagentTaskAbortController(abortControllers, lifecycle.agentId)`；:466-468 `if (startOptions?.signal?.aborted) { taskAbort.abort(startOptions.signal.reason); }`。通读 :445-557 无 `signal.addEventListener`；后台 run 拿到的是 `taskAbort.signal`（:476）而非 `startOptions.signal`，故启动后父 turn 再 abort 不会传导——与 spec「后台子代理与父 turn abort 脱钩（有意设计）」一致。附带：stopTask（:547-553）同样只判 `stopOptions?.signal?.aborted` 即抛。
3. **`core/src/runtime/methods/turn.ts:97-100` 注释确为「任何 await 之前冻结本轮事实」的有意设计 —— 命中**。:97-99 注释原文：「普通 Turn 过去在异步初始化完成后才读取 Session Selection/输出样式，初始化期间发生的切模会越过 admission 边界，错误影响已经开始的 Turn。这里在任何 await 之前冻结本轮事实；后续配置变化只作用于下一轮。」:100 `const admittedModelSelection = options?.intent?.modelSelection ?? this.getSessionModelSelection();` 为冻结点首行。锚点标「:97-100 注释」实际注释占 :97-99、:100 是首行冻结代码，起点精确、终点差 1 行，按锚点意图判命中。

## 四、任务 C：busy 类失败分类取证（供 spec ⑤「boot busy 有界重试」方案评审）

**A. openDatabase 抛出的 Error message 前缀（确认——就是 spec 猜的那个）**：
- `storage-db.ts:2687-2689`：`throw new Error(\`[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.\`)`，其中 `detail = getErrorMessage(error)`（:2683）。
- `openDatabaseAsync` 同构：`storage-db.ts:2785-2788` 同前缀。
- 同时 :2684 打 `log('[magic-context] storage fatal: failed to open ${dbPath}: ${detail}')`。
- 注意 bootstrap 装配点（`magic-context-turn-transform.ts:810`）无 try/catch，该 throw 目前直接冒泡出 `createMagicContextTurnTransform` → create-app 的 `await` 调用点。

**B. 能否据 message/错误类区分 busy vs 确定性失败**：
- **不能据错误类区分**：catch 块是 `throw new Error(...)` 重新构造（不 rethrow 原对象、未传 `{ cause }`），且 `getErrorMessage`（`src/core/shared/error-message.ts:1-3`）只取 `error.message`——原错误的类名/`name`/`code`/`errcode` 全部丢失。装配处 catch 到的永远是普通 `Error`，对 `MigrationLockBusyError` / `SqliteAcquisitionBusyError` 做 `instanceof` 均不成立。
- **可以据 message 文本区分（有现成特征）**：busy 类原 error message 有三类可识别文本：
  1. `failed to prepare migration lock: …`——`migrations.ts:3292-3296` `MigrationLockBusyError`；
  2. `failed to acquire migration write lock: …`——`migrations.ts:3369-3373` `MigrationLockBusyError`；
  3. 裸 sqlite 锁错误文本 `database is locked` / `sqlite_busy|sqlite_locked` / `SQLITE_BUSY|SQLITE_LOCKED`——见 `migrations.ts:43-51 isSqliteLockError` 正则可复用（`/database is locked\|sqlite_(busy\|locked)/i`）。
  上述信息都嵌在包装后 message 的 `${detail}` 段内，因此 `/storage unavailable: .*(migration lock|database is locked|sqlite_(busy\|locked)\|SQLITE_BUSY\|SQLITE_LOCKED)/i` 一类子串正则即可在装配点分类（fence/ABI/unwritable 等确定性失败不命中）。

**C. sqlite 层已导出的错误类型（可直接用于分类）**：
- `src/core/shared/sqlite.ts:636 export function isTransientSqliteError(error)`——判 `code` 以 `SQLITE_BUSY|SQLITE_LOCKED` 开头，或 `errcode & 0xff ∈ {5,6}`（Bun 命名码 / node:sqlite 数字码）。**且 `src/index.ts:144` 已 re-export 到包公共面**，bootstrap 现成可 import。
  - 关键限制：它只查 `code`/`errcode` 字段、**不查 message**；对 openDatabase 重新包装后的普通 `Error` 调用会返回 false（无这两个字段）。所以装配点直接用它判 catch 得来的对象无效——除非 core 侧在 openDatabase catch 内对原 error 先分类再透出（正是 spec Step 3「仅导出 isTransientOpenFailure 判定，不改上游控制流」的动机）。
- `src/core/shared/sqlite.ts:645-653 export class SqliteAcquisitionBusyError extends Error`（`code="SQLITE_BUSY"`，`name="SqliteAcquisitionBusyError"`，`stage`，构造时带 `cause`）——writer 获取路径（:714/748/829/875/925）使用；**未 re-export 到包 `src/index.ts`**，bootstrap 要经包面使用需补导出。
- `migrations.ts:36-41 export class MigrationLockBusyError extends Error`（`name="MigrationLockBusyError"`）——**未 re-export 到包公共面**（`src/index.ts` 无此符号；storage-db.ts 也不 re-export）。
- spec 引用的 `sqlite.ts:657` 退避常量实为 `src/core/shared/sqlite.ts:657 FOREGROUND_ACQUISITION_BUDGET_MS = 16_500`（spec 省略 `shared/` 目录）；另 `migrations.ts:34 MIGRATION_LOCK_RETRY_DELAYS_MS = [1s,2s,4s,8s,15s]`。

**D. 对 spec ⑤ 方案的可判定事实**（仅陈述事实，不下结论）：
- 若采用「bootstrap 装配点 try/catch + message 正则分类 + 退避重试」：可判定 busy（三类 message 文本），可复用 `MIGRATION_LOCK_RETRY_DELAYS_MS` 语义；但 boot 期同步 API 不能同步 sleep（spec 已自述——同步重试会冻宿主），需要 async 化或改用 `openDatabaseAsync`（:2698 起，「SQLite calls remain synchronous, but the bounded migration-lock waits yield to the host between attempts」——已存在可 yield 的异步开门路径，同样返回 `Database \| null` 并可能 throw）。
- 若采用「core 区 openDatabase catch 内分类」：现成判定函数 `isTransientSqliteError` 已在包公共面（`src/index.ts:144`），对**原始** error 即可判；`MigrationLockBusyError` / `SqliteAcquisitionBusyError` 类不在包公共面。openDatabaseAsync 内已有退避重试基建（:2785-2788 之外，见 :2698-2790 注释与实现），busy 重试语义在包内有先例。

## 五、锚点核验计数

- 缺陷④：命中 4 / 偏移 0 / 失效 0（附带发现 1：handler JSON schema 异步分支同样缺 childSessionId）
- 缺陷⑤：命中 8 / 偏移 0 / 失效 0
- 现状约束三断言：命中 3 / 偏移 0 / 失效 0（断言 3 终点差 1 行：注释 :97-99、冻结点从 :100 起）
- 合计：命中 15 / 偏移 0 / 失效 0

## 六、最重要 3 条

1. ④ 全链命中且比 spec 描述更宽：`core/src/tool/handlers/agent.ts` 的 `AGENT_TOOL_OUTPUT_SCHEMA` **异步分支**（:53-80）也缺 childSessionId 且 additionalProperties:false，与 contracts zod 侧（异步 schema 有该字段）不一致——4c 双改时建议两分支一起补。
2. ⑤ 的三条静默路径与 fail-closed throw 全部逐行命中（:776/:811/:816-818/:819-823/:826-827），且 create-app.ts:783-785 的动态 import 无 try/catch（失败直接冒泡）——spec 5a/5b 的可观测性方案有落点。
3. 任务 C 的决定性事实：openDatabase 的 throw **重构成普通 Error、类与 code 全丢**（`getErrorMessage` 只取 message，无 `{ cause }`），故「据错误类区分 busy」在当前代码下**不可行**；「据 message 子串区分」可行（migration lock / database is locked / SQLITE_BUSY 三类文本），而包公共面已导出 `isTransientSqliteError`（src/index.ts:144，只认 code/errcode 不认 message，对包装后 Error 无效）。
