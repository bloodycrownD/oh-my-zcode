# CR v0.1.0 证据包 — evidence-mc-core-port

```
node_id:      evidence-mc-core-port
wave:         wave-1 (evidence)
skill:        code-review-loop
repo:         D:\Dev\Js\oh-my-zcode\omz
base_sha:     1fa2d0e (phase1/cr-fixed)
head_sha:     aba59a9 (v0.1.0)
scope:        apps/zcode-cli/packages/magic-context/src/core/**
reference:    D:\Dev\Js\oh-my-zcode\.reference\magic-context (0.44.4, git 55b70ea82)
mode:         readonly 取证（只写本文件，未改任何代码/文档）
spec:         docs/iterations/oh-my-zcode-fork/spec.md（:95-101 移植范围/明确不搬清单）
constraints:  omz/UPSTREAM-SYNC.md §3「各 phase 的不可回退点（硬约束）」五条
state:        docs/.iteration-state.yaml（phase2a.deviations / deviations_added / methodology_added）
```

---

## 0. 规模基线

| 指标 | 值 |
| --- | --- |
| `git diff --shortstat 1fa2d0e..aba59a9 -- src/core/` | **245 files changed, 75753 insertions(+)** |
| `git diff --shortstat 1fa2d0e..aba59a9 -- packages/magic-context/`（整包） | 268 files changed, 82887 insertions(+) |
| src/core 下 `.ts` 文件数 | 245 |
| src/core 二进制（git 视为 binary）文件 | **2**（见 §5-S1） |
| `src/core/` 变更性质 | **纯新增，零删除**（numstat 每行第二列全 0 / `-`） |
| src/core 顶层子目录 | `agents/` `deferred/` `features/` `hooks/` `plugin/` `shared/` `tools/` |

口径说明：BASE=1fa2d0e 是 Phase 1 收口点，magic-context 移植发生在 Phase 2a/2b/3，因此本范围在 BASE..HEAD 全程为「新增」面。**本节点无 BASE..HEAD 的修改型 diff 可审**——所有取证只能靠「对上游 .reference 逐文件 diff」来做（见 §3）。

---

## 1. FORK 偏离登记核对（iteration-state 已登记 → 代码落点）

`.iteration-state.yaml` 声明的 src/core 相关偏离逐条定位。核对项：是否找到落点、注释块是否按「源位置 / 上游语义 / ZCode 差异 / 改动面」四段登记。

### 1.1 data-path 重定向

- **登记**：`phase2a.deviations` 未单列，但 `spec.md:190` 明确要求改 `shared/data-path.ts:214`；UPSTREAM-SYNC §5 与 iteration-state `phase2a.s24-fix` 系列的 sibling 条目隐含。
- **落点**：`src/core/shared/data-path.ts:7-12`
  ```ts
  export function getDataDir(): string {
      // FORK: ZCode's data root. Upstream resolved an XDG data home and hung a
      // `cortexkit/` subtree off it; this fork follows the convention the session
      // store already uses (`adapters/src/storage/session-store/paths.ts`).
      return path.join(os.homedir(), ".omz");
  }
  ```
- **配套改动**（与上游 diff 实证，见 §3.6）：
  - `getMagicContextStorageResolution()`：上游 4 条分支（`XDG_DATA_HOME` / `MAGIC_CONTEXT_STORAGE_DIR` 绝对路径强制 / test isolation 的 cortexkit 子树 / platform default）→ fork 3 条（`MAGIC_CONTEXT_DB_DIR` 绝对路径强制 / test isolation → `<testDir>/cli/db` / `<dataDir>/cli/db`）。
  - **环境变量重命名**：`MAGIC_CONTEXT_STORAGE_DIR` → `MAGIC_CONTEXT_DB_DIR`（`:237-243`）。上游该变量名在 `storage-db.ts:909` 也被读取，fork 侧改为同名（`MAGIC_CONTEXT_DB_DIR`）。
  - `MagicContextStorageSource` 枚举：上游 4 项 → fork 2 项（`"environment override" | "ZCode data dir"`），`:218-221`。
  - test backstop：`<tmp>/cortexkit/magic-context` → `<tmp>/cli/db`（`:264-267`）。
- **四段注释核对**：❌ **只登记了「ZCode 差异」，未登记「源位置」段**。`getDataDir` 的注释块没有写上游对应行号，也没有写「改动面」（哪些调用点受影响）。同文件其余重定向点（`getMagicContextStorageResolution` / `getTestBackstopStorageDir`）**完全没有注释**。

### 1.2 migrations 跳 v85 / v87

- **登记**：`spec.md:95`「`features/magic-context/migrations.ts`（新库起，跳过 v85/v87 relabel）」。
- **落点（v85）**：`src/core/features/magic-context/migrations.ts:2979-2988`
  ```
  // OMITTED IN THIS FORK — upstream v85 "relabel OpenCode 1.x mis-tagged
  // opencode 1.x session rows". ... The version number is intentionally left
  // unclaimed: `runMigrations` selects the first candidate above the current
  // version rather than by array index, so a gap costs nothing and
  // `LATEST_MIGRATION_VERSION` is unaffected.
  version: 86,
  ```
- **落点（v87）**：同文件 `:3042-3048`，`version: 88`（注释放置在 88 号条目头上，不是 87 号）。
- **相关新增常量**：`:11-12` `export const FORK_MIGRATION_VERSION_FLOOR = 10_000;`（上游无此常量）。消费点 `:3205-3212` `getCurrentVersion()`：`SELECT COALESCE(MAX(version),0) WHERE version < 10000`。该常量**同时被 `storage.ts:41` barrel 再导出**。
- **四段注释核对**：✅ 三段齐（源位置/上游语义/ZCode 差异/改动面合并在同块内），比 data-path 规范。
- **⚠ 观察**：`:3048` 的注释挂在 `version: 88` 条目上，读作「v87 omitted」但代码行号指向 88。语义正确（88 是 v87 之后的下一个候选），但**注释与代码版本号的对应关系反直觉**，读者需靠 "Same unclaimed-number reasoning as v85 above" 才能跟上。

### 1.3 transform 首 pass usage hostProcessLifetime

- **登记**：`phase2a.deviations_added[0]`「s24-fix: transform 首 pass usage 语义偏离（hostProcessLifetime 可选注入）」；`key_fixes` 首条；`handoffs` 第三条（S20 executor 硬约束前移）。
- **落点 A（类型声明）**：`src/core/hooks/magic-context/transform.ts:445-456`
  ```
  /**
   * FORK (S24-fix)：宿主的**进程生命周期**声明，决定首 pass usage 重置的语义。
   *   - 缺席 / `"one-process-per-session"`：上游 OpenCode 的模型。...
   *   - `"one-process-per-turn"`：ZCode CLI 的模型。...
   * 缺席时保持上游逐字行为——未声明的宿主不替它做假设。
   */
  hostProcessLifetime?: "one-process-per-session" | "one-process-per-turn";
  ```
- **落点 B（手术点）**：`transform.ts:1221-1269`。注释块分四段且带 `── 上游语义 ── / ── ZCode 的差异 ── / ── 改法与改动面 ──` 分隔线；条件由上游的
  `if (isFirstTransformPassForSession && sessionMeta)`
  改为
  ```ts
  if (isFirstTransformPassForSession && sessionMeta && deps.hostProcessLifetime !== "one-process-per-turn") {
  ```
  （`:1245-1249`）。块内 `updateSessionMeta` 清理与 `deps.contextUsageMap.delete` 逻辑逐字保留。
- **注入点**：`apps/zcode-cli/packages/bootstrap/src/app/magic-context-turn-transform.ts:929` `hostProcessLifetime: "one-process-per-turn"`，前置注释 `:925-928`。
- **回归测试**：`apps/zcode-cli/packages/magic-context/scripts/test-transform.mjs:733/773/797/836/845/867/870`——含对照组「无 `hostProcessLifetime` 时行为必须与上游逐字相同（清零）」。
- **四段注释核对**：✅ **完全合规**（源位置 + 上游语义 + ZCode 差异 + 改动面四段齐备，且带行号引用 MVP 报告 §3/§6.1）。

### 1.4 raw-message 单读单权威

- **登记**：`phase2a.deviations_added[1]`「s24-fix2: raw-message-provider 单读单权威（合并两半边被明令禁止）」；`key_fixes` 末条。
- **落点**：`src/host/raw-message-provider.ts:29-53`（文件头注释块）+ 每个成员的分支实现。
- **四段注释核对**：✅ 合规（`:20-28` 先声明与 core 侧 `read-session-chunk.ts:128-158` 的结构等价性约束，`:29-53` 再声明单权威语义与「禁止合并」的理由，`:55-60` 解释为何实现了全部 12 个成员）。
- **⚠ 观察**：该约束的**定义点在 `src/host/`（不在本节点范围内）**，但**验证点/消费点在 `src/core/hooks/magic-context/read-session-chunk.ts`**。core 侧只有 VERBATIM interface 声明，无「不得合并」的第二道强制点。

### 1.5 登记核对小结

| 登记项 | 落点 | 四段注释 |
| --- | --- | --- |
| data-path 重定向 | ✅ `shared/data-path.ts:7-12` | ❌ 缺「源位置」+「改动面」；其余重定向点无注释 |
| migrations 跳 v85/v87 | ✅ `migrations.ts:2979-2988 / 3042-3048` | ✅ |
| transform hostProcessLifetime | ✅ `transform.ts:445-456 / 1221-1269` | ✅ |
| raw-message 单权威 | ✅ `host/raw-message-provider.ts:29-53` | ✅ |

**未在 iteration-state 找到登记、但代码里有显式 FORK 手术的 src/core 改动**（详见 §5-S2）：`shared/sqlite.ts` 的 TLA→同步加载、`storage-db.ts` 的 `MAGIC_CONTEXT_DB_FILE_NAME` / 删 tool-owner backfill / `XDG_DATA_HOME`→`MAGIC_CONTEXT_DB_DIR`、`transform.ts` 的 Rust lane 全删、`compartment-runner-historian.ts` 的 1055→572 行缩减。

---

## 2. 硬约束现状（UPSTREAM-SYNC §3）

### 2.1 `preserveProviderStreamBoundaries: true` 编译期字面量

**类型定义位置（4 处，全部不在 src/core 内）：**

| 文件:行 | 形态 |
| --- | --- |
| `apps/zcode-cli/packages/magic-context/src/host/hidden-completion-executor.ts:71-82` | `export interface SidecarModelCallOptions { preserveProviderStreamBoundaries: true }` — **必填 + 字面量 `true`**（编译期强约束的源头） |
| `apps/zcode-cli/packages/contracts/src/model/index.ts:692` | `preserveProviderStreamBoundaries?: boolean`（可选，宽松） |
| `apps/zcode-cli/packages/contracts/src/model/invocation-context.ts:29` | `preserveProviderStreamBoundaries?: boolean`（可选，宽松） |
| `apps/zcode-cli/packages/core/src/runtime/methods/sidecar-model-request.ts:30` | `preserveProviderStreamBoundaries?: boolean`（可选，宽松） |
| `apps/zcode-cli/packages/adapters/src/model/runner-runtime.ts:46` | `preserveProviderStreamBoundaries?: boolean`（可选，宽松） |

**唯一 `true` 生产点**：`src/host/hidden-completion-executor.ts:339`
```ts
{ preserveProviderStreamBoundaries: true },
```
全仓 `git grep preserveProviderStreamBoundaries` 扫描：除上表 5 个类型声明 + 该生产点，其余 30+ 处命中全是**消费/透传/条件判断**（`runner-stream.ts` 12 处、`runner-generate.ts:231`、`runner-options.ts:153`）。

**⚠ 取证观察（不下结论）**：`sidecar-model-request.ts:30` 的 `SidecarModelCallOptions`（core 包内）声明为 `?: boolean`，与 `hidden-completion-executor.ts:81` 的 `: true` 是**两个同名不同包的类型**。UPSTREAM-SYNC §3 表格把 `core/src/runtime/methods/sidecar-model-request.ts` 与 `src/host/hidden-completion-executor.ts` 并列写成「必填字面量」的落点，但实测只有后者是必填字面量；前者是可选 boolean，并在 `:306` 把值原样透传给下层。即：**字面量强约束只存在于 magic-context 包的 host 层，跨到 core/adapters 就退化为可选 boolean**——约束在跨包边界处不再由类型系统承载。

**测试锚点**：
- `apps/zcode-cli/packages/core/scripts/test-sidecar-model-request.mjs:10,207` — 记录 core 侧字面量
- `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-historian.mjs:13,100,226,246,262,270,286` — 断言 `invocation.preserveProviderStreamBoundaries === true`
- `apps/zcode-cli/packages/magic-context/scripts/test-historian.mjs:8,71,348-395` — **负向 typecheck**：片段必须编译失败于 `{ preserveProviderStreamCallOptions } = { preserveProviderStreamBoundaries: false }`

### 2.2 raw-message 两半边词汇表隔离

**定义点**：`src/host/raw-message-provider.ts:29-53`，明确两套词汇：
- live 半边：1..N 编号 + 铸造 `mc<ordinal>`（例 `mc7:p0`）—— 这正是 magic-context 落库的 `tags.message_id` 与 compartment boundary id 词汇
- persisted 半边：1..M 编号 + 真实行 id `msg_mutre…`
- 合并后果：`stale protected-tail snapshot (offset ordinal 1 id changed)` 永久循环（现场 = MVP 报告 §7.5 T-M6 失败）

**实现落点（隔离规则的实际执行）**：`raw-message-provider.ts:387-414` `readMessageOrdinalPage()`
```ts
// FORK (S24-fix2): one source. The pre-fix2 shape merged stored rows with
// live rows into one (timeCreated, id) page, which put `mc<N>` and
// `msg_…` ids in the same ordinal space and made every ordinal derived
// from this page unusable.
const rows =
  live !== null
    ? ordinalEntries(live)
    : deps.readStoredOrdinalPage
      ? deps.readStoredOrdinalPage(after, pageSize)
      : ordinalEntries(readRangeFromSource(deps, 1, Number.MAX_SAFE_INTEGER));
```
二选一，**无合并分支**。另有 `liveHalf(deps)` / `readRangeFromSource(deps, ...)` / `ordinalEntries(...)` 三个私有 helper 承担「按半边取源」。

**⚠ 取证观察**：`:393-396` 的 FORK 注释只挂在 `readMessageOrdinalPage` 上。`RawMessageProvider` 接口共 12 个成员（`:81-103`），**其余 11 个成员各自的 live-vs-stored 选择点没有同样的 FORK 注释**——只有 `readServedBoundaryId`（`:426-434`）另有一段解释性注释。隔离规则对「读过这 12 个成员代码的人」是否处处成立，本节点未逐一验证（属 cr-func 可查项）。

### 2.3 `hostProcessLifetime` 注入点

- **声明**：`src/core/hooks/magic-context/transform.ts:456`
- **唯一注入**：`apps/zcode-cli/packages/bootstrap/src/app/magic-context-turn-transform.ts:929`（在 `buildTransformDeps()` 返回的对象字面量里）
- **装配层文档**：`magic-context-turn-transform.ts:32`（选项表）+ `:79` + `:224`
- **消费**：`transform.ts:1248`
- 详见 §1.3。

**注入点唯一性核对**：`git grep hostProcessLifetime` 全仓 9 命中——4 处在 `magic-context/scripts/test-transform.mjs`，4 处在 `core/hooks/magic-context/transform.ts`，1 处在 bootstrap 装配层。**生产代码注入点唯一** ✅。

---

## 3. 抽样语义漂移检测（对 `.reference/magic-context` 逐文件 diff）

方法：`git diff --no-index --ignore-cr-at-eol -U1 <上游> <fork>`，剔除 import 路径（`.js` 后缀 + deferred/ 重定向）后人工过读。上游根：`D:\Dev\Js\oh-my-zcode\.reference\magic-context\packages\plugin\src\`。

### 3.0 全量抽样 stat（20 个 hooks 文件，--stat 汇总）

| 上游文件 | +/- | 性质判读 |
| --- | --- | --- |
| `hooks/magic-context/apply-operations.ts` | +9/−9 | ✅ **纯 import 路径**（9/9 全是 `from "x"` → `from "x.js"`），函数体零改动。spec:96 称此文件「`[dropped §N§]` 承重，纯函数不可改」——实证成立 |
| `hooks/magic-context/inject-compartments.ts` | +28/−28 | ✅ 纯 import 路径 + `readProjectDocsCanonical` 从 `storage` barrel 改为直连 `project-docs-hash.js`（`:39-40`）——因 fork 的 `storage.ts` barrel **不导出** `readProjectDocsCanonical`（见 §5-S4） |
| `hooks/magic-context/transform-postprocess-phase.ts` | +47/−47 | ✅ 纯 import 路径 |
| `hooks/magic-context/transform-compartment-phase.ts` | +16/−16 | ✅ 纯 import 路径 |
| `hooks/magic-context/tag-messages.ts` | +16/−16 | ✅ 纯 import 路径 |
| `hooks/magic-context/read-session-chunk.ts` | +13/−13 | ✅ 纯 import 路径 |
| `hooks/magic-context/protected-tail-boundary.ts` | +12/−12 | ✅ 纯 import 路径 |
| `hooks/magic-context/heuristic-cleanup.ts` | +13/−13 | ✅ 纯 import 路径 |
| `hooks/magic-context/emergency-drop.ts` | +4/−4 | ✅ 纯 import 路径 |
| `hooks/magic-context/read-session-raw.ts` | +1/−1 | ✅ 纯 import 路径 |
| **`hooks/magic-context/transform.ts`** | **+137/−171** | ⚠ **实质改动 3 处**（见 §3.1） |
| **`hooks/magic-context/compartment-runner-types.ts`** | **+111/−21** | ⚠ **实质改动 4 处**（见 §3.2） |
| **`hooks/magic-context/compartment-runner-historian.ts`** | **+210/−693** | ⚠ **1055→572 行，缩减 46%**（见 §3.3） |
| **`hooks/magic-context/compartment-runner-incremental.ts`** | **+180/−869** | ⚠ **缩减 ~50%**（未逐行过读） |
| **`hooks/magic-context/compartment-runner.ts`** | **+48/−124** | ⚠ 缩减（未逐行过读） |
| `hooks/magic-context/compartment-runner-validation.ts` | +22/−7 | ✅ 函数体逐字，仅加 15 行文件头说明「逐字移植 + load-bearing」 |
| `hooks/magic-context/compartment-runner-mapping.ts` | +10/−2 | ⚠ 少量实质（未逐行过读） |
| `hooks/magic-context/historian-prompt.generated.ts` | +21/−0 | ⚠ **纯新增 21 行，零删除**——fork 比上游**多**内容 |
| `hooks/magic-context/historian-no-fire-cause.ts` | +10/−0 | ⚠ 纯新增 10 行 |
| `hooks/magic-context/historian-publish-stage-logger.ts` | +10/−1 | ⚠ 新增 10 行 |

### 3.1 `transform.ts` 实质差异（3 处）

**① Rust lane 整体摘除（最大块）**
- `:169-172` 删 `clearRustModeBoundaryRecord` import
- `:642-651` `TransformDeps` 删 6 个 rust 成员：`rustModeModuleClient` / `rustModeProjectRoot` / `onRustModeParked` / `onRustEngineReconnectRefusal` / `rustMemorySyncRequestedSessions`；`transformMode?: "ts" | "rust"` → `transformMode?: "ts"`；`promptSurface` / `promptSurfaceRuntime` 的注释改为「TS lane does not read them」
- `:692-695` 删 `rustModeTransform` 创建表达式
- `:729` `const lkgInput = deps.transformMode === "rust" ? [] : projectEntry(sessionId, messages)` → `const lkgInput = projectEntry(sessionId, messages)`
- `:778-787` 删 store-rebase 前的 `clearRustModeBoundaryRecord` + `rustModeTransform.clearSession` 分支
- `:960-975` 删 `if (deps.transformMode === "rust") { ... return; }` 整个权威适配分支，换成 3 行注释说明「Rust lane 随 rust-mode-transform.ts 一同移除」
- `:3198-3204` 删 `Object.assign(transform, {...})` 包装的 5 个 Rust accessor（`invalidateRustWireState` / `clearRustSession` / `disposeRust` / `getRustReplayParticipant` / `getRustWireCacheHeapStats`），改为 `return transform;` + 3 行注释

对应 spec「明确不搬」`rust-*/module-*`。fork 侧注释（`:1222-1226` 等）明确说明这是决策不是遗漏。**注**：`rust-mode-transform.ts` 在 fork 的 `src/core/` 中确实不存在（§5 已验证）。

**② hostProcessLifetime 首 pass 判据**（§1.3，不重复）

**③ rustModeProjectRoot 相关的 `promptSurfaceRuntime` 注释改写**（`:265-269`）——仅注释。

**⚠ 未登记观察**：`transformMode?: "ts"` 这个类型收窄**未出现在 `.iteration-state.yaml` 的任何 deviations 列表中**。它是「明确不搬」的直接推论，但 UPSTREAM-SYNC §3 第 2 条要求「落在 `src/core/` 的上游改动走逐字重放流程」——本次是缩减而非重放，且未进登记。

### 3.2 `compartment-runner-types.ts` 实质差异（4 处）

fork 在 `:1-41` 加了 FORK-NOTE，逐条列出 3 处 substitution：

| # | 替换 | fork 落点 | 上游来源 |
| --- | --- | --- | --- |
| 1 | `TokenTotals` 本地重声明（6 成员） | `:56-68` | `features/magic-context/subagent-token-capture`（OpenCode 子会话 token 归集，fork 无子会话） |
| 2 | `PromptArgs` 本地重声明（`path`/`body`/`signal` + 索引签名） | `:71-83` | `shared/model-suggestion-retry`（E 组） |
| 3 | `compactionMarkerStrategy` 两槽从 `typeof import(...)` 改为显式函数类型 | `:218-228` | 模块被 fork 裁剪，签名结构等价 |
| 4 | `HiddenCompletion.tokenLog` 从 `import("../../shared/run-token-log").RunTokenLog` 改为 `Record<string, unknown>` | `:178` | `shared/run-token-log` 未搬 |

**⚠ 取证观察（不下结论）**：`PromptArgs` 的本地重声明（`:78-83`）带 `[key: string]: unknown` 索引签名，而上游 `PromptArgs` 无此索引签名。`hidden-completion-executor.ts` 的 `readPrompt(request)` 消费该类型。下游 `compartment-runner-historian.ts` 构造的 body 是 `{agent, model?, parts}` —— 索引签名放宽了类型约束，是否掩盖了某个字段名错误，本节点未验证。

### 3.3 `compartment-runner-historian.ts` 实质差异（1055→572 行）

fork `:1-100` 加了 60 行 FORK-NOTE，分「上游保留不变」与「transport 变更所迫」两栏。删减清单：

| 删除项 | 上游规模 | fork 处置 | 理由（fork 注释） |
| --- | --- | --- | --- |
| `createV1HiddenCompletionExecutor` | ~110 行 | 整删 | D-6：无 OpenCode SDK client |
| `resolveHiddenCompletionExecutor` 的 client/db/directory 参数 | 3 参 → 1 参 | 收窄 | 同上；缺 executor 现在 throw 而非 fallback |
| historian response dump（`historianResponseDumpDir` / `dumpHistorianResponse` / `cleanupHistorianDump` / `sanitizeDumpName` / `ensureCortexKitArtifactGitignore`） | ~50 行 | 整删 | dump 落 `<project>/.opencode/...`，fork 无此路径；诊断改走 `ValidatedHistorianPassResult.error` |
| `subagent_invocations` 行记录（`recordChildInvocation` / `failedInvocationStatus` / `sumTokensFromChildMessages` / `parentInvocationId` 链） | ~40 行 | 整删 | 上游 key 在 OpenCode 子会话 id，fork 无 |
| producer-window admission（`historianPromptAdmissionFailure` + `parseModelOverride` + `unknownProducerWindows`） | ~57 行 | 整删 | 需 `models-dev-cache` context limit；chunk 已由 `historianChunkTokens` 定尺 |
| `extractLatestHistorianReasoning` / `isHistorianReasoningPart` / `historianMessageCreatedAt` / `describeAssistantFailure` | ~70 行 | 整删 | 依赖 `shared/assistant-message-extractor`（未搬） |
| `shared.*` barrel 全部调用 | 12 处 | → 直引 `sessionLog` / `getErrorMessage` | E 组未搬 `shared` barrel |
| **新增** `withTimeoutBudget` | — | +26 行 | fork 在 executor 内**也**强制 timeout（上游只靠 host transport 的 `timeoutMs`）——防 provider socket 挂死导致 drain 永久 wedge |
| **新增** 本地 `toModelEntry` | — | +6 行 | 替代上游 `shared/resolve-fallbacks` |
| **新增** 本地 `DEFAULT_HISTORIAN_TIMEOUT_MS = 600_000` | — | +4 行 | E 组没把 `timeout_ms` 放进热更白名单 |
| `runValidatedHistorianPass` 参数表 | 20 字段 | → `RunValidatedHistorianPassArgs` 接口，删 `client`/`db`/`dumpLabelBase`/`subagentKind` | 同上 |

**⚠ 取证观察 A**：`historianReasoningBudgetDiagnostic(outputTokens)` 的返回串**被删了 run-token-log 尾巴**。上游：`` `...(no text${tokens ? `; ${formatRunTokenLog(tokens)}` : ""}) — set historian.maxTokens...` ``；fork（`:568-571`）：`` `...(no text) — set historian.maxTokens...` ``。诊断字符串的**信息量下降**（少了 token 明细），属可诊断性削减。

**⚠ 取证观察 B**：`runFallbackHistorianPass` 删了 `if (!parseModelOverride(modelId)) continue;`（上游 `:872-873`）。`parseModelOverride` 要求 model id 形如 `provider/model`（至少一个 `/`），删掉后**任何非空 model id 都会进链**。fork 的 `runHistorianPrompt` 里 `modelOverride` 传给 `executor.attempt` 的 body，键名由 fork 的 `readPrompt` 决定——本节点未追到该解构点。

**⚠ 取证观察 C**：`:1047` `}` 后 `\ No newline at end of file`——**该文件缺文件末尾换行**。见 §5-S5（66 个文件同病）。

**⚠ 取证观察 D**：`fallbackModels` 的传递从上游 `fallbackModels: modelOverride ? undefined : fallbackModels`（"已在最后兜底路径则不再迭代 fallback"）改为 `...args.fallbackModels ?? []` 直接进 `HiddenRunIdentity.fallbackModels`，**且不再有 modelOverride 判据**。fork 注释称 "Resolved historian fallback chain, forwarded to the run identity"——语义从「控制是否迭代」变成「上报给 executor」。`runFallbackHistorianPass` 自身的链仍按 `chain` 逐个跑。是否导致 double-iteration 取决于 `hidden-completion-executor.ts` 是否读 `run.fallbackModels`（本节点未查）。

### 3.4 `storage-db.ts` 实质差异（4 处）

fork `:68-74` 加 FORK 注释段；实测差异：

1. **删 tool-definition-tokens + tool-owner-backfill 的 boot 接线**（`:68-74` 注释 + `:1127-1130` 删 `setToolDefinitionDatabase(db)` / `loadToolDefinitionMeasurements(db)`）。注释理由：`tool-owner-backfill` 在 spec 不搬清单（`opencode2-relabel/tool-owner-backfill`），`tool-definition-tokens` 依赖 B 组 read-session 格式化链。
2. **`MAGIC_CONTEXT_DB_FILE_NAME` 常量**（`:160-167`）：上游 `context.db` 硬编码 3 处 → fork 单点导出 + 3 处引用（`:99` `resolveDatabasePath`、`:363` legacy migrate、`:916` `isDefaultSharedDatabasePath`）。
3. **`isDefaultSharedDatabasePath` 的 env 判据**（`:909`）：`!process.env.XDG_DATA_HOME` → `!process.env.MAGIC_CONTEXT_DB_DIR`。
4. **`finishDatabaseOpen` 的 backfill 链**（`:1089-1123`）：删 `runToolOwnerBackfill` 与 `startMessageTimeBackfill`（后者需 B 组 `read-session-chunk`），保留 `startMessageFtsRowidMapBackfill` + `isTransientSqliteError` 退避重试。**重试语义保持**（`busyRetryMs` 指数退避 + `withoutSqliteTransformPass` 让出）。

**⚠ 取证观察**：`tool-definition-tokens.ts` **文件本身在 fork 里存在**（297 行，与上游 diff 仅 +3/−3 = 纯 import 路径），且被 `storage.ts` barrel 导出 `loadToolDefinitionMeasurements` 等。也就是**代码搬了、接线删了**。这与 `compartment-chunk-embedding.ts`（deferred 缝，被 `storage-session-tables.ts` 真消费）形成对照。

### 3.5 `compartment-storage.ts` 实质差异（893→455 行，−574）

fork `:1-42` 加 FORK-NOTE。删除清单：

| 删除 | 上游行数 | 理由（fork 注释 `:29-41`） |
| --- | --- | --- |
| `replaceAllCompartments` | ~25 | recomp 家族（spec Step 22 重写） |
| `replaceSessionFacts` | ~12 | 同上 |
| `replaceAllCompartmentState` / `replaceAllCompartmentStateAndBumpDepth` | ~60 | 同上 |
| `getCompartmentsByEndMessageId` | ~20 | marker drain 的 `validatePendingTarget` 依赖，marker 链不搬 |
| `saveRecompStagingPass` / `getRecompStaging` | ? | recomp staging 表 |
| `insertCompartmentRows` 尾的 `invalidateAutoEmbedSession` | 1 | Batch 2 embed drain |
| `insertCompartmentRows` 里的 `deleteChunkEmbedBackoffForSession`（在 replaceAll 家族内） | — | 同上 |
| `queueM0Mutation` 调用（全部 4 处） | 4 | 见下 ⚠ |
| `clearCachedM0M1` 调用（2 处） | 2 | 见下 ⚠ |
| import `invalidateAutoEmbedSession` / `deleteChunkEmbedBackoffForSession` / `isCompartmentLeaseHeld` / `getIncrementDepthStatement` / `queueM0Mutation` / `clearCachedM0M1` | 6 imports | 随上述删除 |

**⚠ 取证观察 A（注释与代码不一致）**：fork 头注 `:22-25` 声明「`escapeXmlAttr` / `escapeXmlContent` / `getCompartments` / `getLastCompartmentEndMessage` / `getLastCompartmentEndMessageId` / `isPartialCompartmentEnd` / `buildCompartmentBlock` / `getSessionFacts` bodies are upstream's, unchanged」——8 个函数。实测 `getSessionFacts` **确实存在**（`:449-455`，逐字，含 SQL 与 filter），头注成立 ✅。

**⚠ 取证观察 B（m0 失效链断裂）**：`queueM0Mutation` 与 `clearCachedM0M1` 在 fork 的 `compartment-storage.ts` 里被**全部移除**，但二者在 fork 里**仍存在且被其他模块导出**：
- `queueM0Mutation`：`storage-m0-mutation-log.ts:48` 定义，`storage.ts:80-81` 双别名再导出（`queueM0Mutation` + `appendM0Mutation`）
- `clearCachedM0M1`：`storage-meta-shared.ts:560` 定义，`storage-meta.ts:121` / `storage.ts:112` 再导出

`git grep` 结果：**这两个符号在整个 `src/` 里除定义与 barrel 再导出外，零消费点**。上游 `queueM0Mutation` 的用途是 recomp 边界变更时使 m[0] 失效，recomp 不搬 → 无消费合理；但 `clearCachedM0M1` 的语义（compartment 写入后清 m[0]/m[1] 缓存）在 fork 里也没有别的触发点。**appendCompartments 写完 compartments 后，m[0] 缓存是否失效，取决于 `appendCompartments` 自身是否清了**——本节点读到 fork 的 `appendCompartments` 声明为「`compartment-storage.ts:370-380`, minus the trailing `invalidateAutoEmbedSession`」，即只删了 embed 那一行，**`clearCachedM0M1` 不在其列**（上游 `appendCompartments` 本来也没调它，只在 replaceAll 家族里调）。故 fork 的 append 路径与上游一致，**不构成移植错误**；但整条 m0 失效链在 fork 里只剩 `storage-meta-shared.ts:607` 一个内部调用点，属可疑的窄链（见 §5-S3）。

### 3.6 `shared/data-path.ts` 实质差异

见 §1.1。补充：`getOpenCodeStorageDir()` 及其相关分支在上游 `:164-207` 有 4 段改动（fork 保留但注释未标注改了什么）；`getMagicContextStorageDir()`（`:95-98`）有 6 行新增。

### 3.7 `shared/sqlite.ts` 实质差异（1 处，重要）

fork `:186-238` 新增 `requireSqliteModule()` 53 行，替换模块级 `const sqliteModule = await loadSqliteModule(detectedRuntime)`（上游 TLA）为 `const sqliteModule = requireSqliteModule(detectedRuntime)`。

fork 注释自述理由（S24-fix）：
- 模块级 await → `require("@zcode/magic-context")` 抛 `ERR_REQUIRE_ASYNC_MODULE`
- esbuild CJS bundle 报 "Top-level await is currently not supported with the cjs output format"
- 改用 `process.getBuiltinModule()`（Node 22.3+）同步取 `node:sqlite`；**因说明符是变量**，esbuild/bun 不在构建期解析另一后端
- 拿不到同步后端 → 抛 `SqliteRuntimeUnavailableError`（**不再静默退化成异步图**）
- `loadSqliteModule`（异步版）保持导出不变

**⚠ 取证观察**：`bunSpec` 分支仍在 `requireSqliteModule` 里（`:runtime === "Bun" ? bunSpec : nodeSpec`），但注释说「Bun 路径不再是构建目标」。Bun 下 `process.getBuiltinModule("bun:sqlite")` 是否可用，本节点未验证。spec:95 要求「`shared/sqlite.ts`（913 行，变量间接动态 import 手法必须保留，防 esbuild 改写 `node:sqlite`）」——**变量间接手法保留 ✅**（`specifier` 是变量）。

### 3.8 其余抽样（features/shared，--stat）

| 文件 | +/- | 判读 |
| --- | --- | --- |
| `features/magic-context/storage-meta-persisted.ts` | +15/−15 | ✅ 纯 import 路径 |
| `features/magic-context/tagger.ts` | +4/−4 | ✅ 纯 import 路径 |
| `features/magic-context/storage-tags.ts` | +9/−9 | ✅ 纯 import 路径 |
| `features/magic-context/storage.ts` | +40/−46 | ⚠ 20 行头注 + 4 个 barrel 再导出被删（见 §5-S4） |
| `features/magic-context/memory/project-identity.ts` | +2/−2 | ✅ 纯 import 路径 |
| `features/magic-context/storage-subagent-invocations.ts` | +2/−2 | ✅ 纯 import 路径（但 fork 已无写方，见 §5-S6） |
| `features/magic-context/tool-definition-tokens.ts` | +3/−3 | ✅ 纯 import 路径（接线已删，见 §3.4） |
| `features/magic-context/overflow-detection.ts` | +1/−1 | ✅ 纯 import 路径 |
| `hooks/magic-context/lkg-replay.ts` | +4/−4 | ✅ 纯 import 路径 |
| `hooks/magic-context/read-session-db.ts` | +5/−5 | ✅ 纯 import 路径（但整个文件被 `harnessOwnsOpenCodeStore()` 短路，见 §5-S7） |

---

## 4. `deferred/` 缝现状

### 4.1 数量与分类

- **文件总数**：23（与 iteration-state `phase2a.deferred_final` 「23 条 FORK-NOT-PORTED 缝」一致 ✅）
- **带 FORK 头注的**：21 / 23
  - `FORK-NOT-PORTED` 头注：**10 个文件**（auto-search-runner / channel2-cycle / compaction-off-transition / ctx-reduce-availability / dreamer-task-registry / embed-session-state / event-resolvers / hook-handlers / note-nudger / send-session-notification）
  - `FORK-DEFERRED(E)` 头注：4 个（embedding-failure / embedding-status-tables / model-resolution / prompt-surface / prompt-surface-runtime = 5）
  - `FORK-DEFERRED(Batch2)` 头注：4 个（magic-context-prompt / memory-selection / render-trigger / storage-memory / storage-user-memory = 5）
  - `embed-session-state.ts` **两个头注都有**（`:1` FORK-NOT-PORTED + `:28` FORK-DEFERRED(S20)）
- **无任何 FORK 头注的**：**2 个**
  - `deferred/compartment-chunk-embedding.ts:1-13` — `/** Deferred seam — ... */`（普通块注释，写明 Step 20 删除指引）
  - `deferred/project-security.ts:1-9` — `/** Deferred seam — config/project-security.ts ... */`
  - **⚠ 观察**：这两个用的是「Deferred seam」措辞而非登记词汇 `FORK-DEFERRED`/`FORK-NOT-PORTED`，grep 这两个标记会漏掉它们。

### 4.2 头注四段结构核对（抽样）

抽样 `deferred/auto-search-runner.ts`（1-23 行）与 `deferred/compaction-off-transition.ts`（1-35 行）——这两个是**规范样本**：

```
// FORK-NOT-PORTED: `hooks/magic-context/auto-search-runner.ts` 的
//   AutoSearchOutcome / AutoSearchRunnerOptions 类型与 runAutoSearchHint 函数摘录，
//   Step 21 决定移植或删除后重写本文件
//
// WHY NOT PORTED. ...
//
// SEMANTIC DECISION — `runAutoSearchHint` returns `{ ok: true }`, 上游的 ...,
//   六个 no-op 出口之一 ... 调用点只读 `.ok` ...
//
// Step 21: delete this file and repoint `transform-postprocess-phase.ts`
//   back at `./auto-search-runner.js`, or — if ctx_search stays out of the fork
//   — delete the import outright.
```

四要素齐备：**源位置（含上游路径与符号名）/ WHY NOT PORTED / SEMANTIC DECISION（含返回值的语义论证与调用点）/ 删除指引（含 Step 号）**。

`deferred/project-security.ts` 与 `deferred/compartment-chunk-embedding.ts` 的头注**缺 SEMANTIC DECISION 段**（前者只说「本 fork 不搬 per-project policy，只需要类型形状」，后者只说「A 组只需要这条 DELETE 语句」——比另两个薄）。

### 4.3 缝的返回值形状（逐个）

| 文件 | 导出符号 | 返回形状 | 语义论证是否在头注 |
| --- | --- | --- | --- |
| `auto-search-runner.ts` | `runAutoSearchHint` | `{ ok: true }` | ✅ 详述（上游 `AUTO_SEARCH_OK`，六个 no-op 出口之一，调用点只读 `.ok`，false 会误记 degradation） |
| `storage-memory.ts` | `getMemoriesByProject` / `getMemoriesByProjects` / `getMaxMemoryIdForProjects` | `[]` / `[]` / `0` | ✅ 逐个详述（空集 = 无 memory block；`0` = watermark「从未写入」） |
| `compaction-off-transition.ts` | `reconcileCompactionMode` | `recordToWrite: "on"` | ✅ 详述（`hasTransitionEffects` 表达式为 false → 跳过 notice 块；**明确声明「NOT a no-op stub」**） |
| `ctx-reduce-availability.ts` | 未逐行读（binary 判定） | — | 头注存在（2 处命中） |
| `event-resolvers.ts` | 9 个 resolver（473 行） | 未逐行读 | 头注 1 处 |
| `embed-session-state.ts` | `EmbedDrainUiStatus` 类型 | 类型缝 | 头注 2 处 |
| `project-security.ts` | `ProtectedTokensTierOverrides` | 纯类型 | 无 SEMANTIC DECISION 段 |
| `compartment-chunk-embedding.ts` | `deleteChunkEmbedBackoffForSession` | **真实现**（非占位，SQL 逐字） | 无 SEMANTIC DECISION 段，但说明了「只重放需要的这一条」 |

**⚠ 观察**：`iteration-state.deviations` 记「user-facing-codes/builtin-commands/event-resolvers 三缝**逐字摘录非占位**」——但这三个文件**不在 `deferred/` 目录**，而在上游路径（`src/core/shared/user-facing-codes.ts` 416 行、`src/core/features/builtin-commands/*`、`src/core/deferred/event-resolvers.ts` 473 行）。`event-resolvers.ts` 既在 deferred 又标 FORK-NOT-PORTED，其 `git grep -l FORK-NOT-PORTED` 命中——与另两个位置策略不一致。

### 4.4 deferred 缝的消费点抽查

| 缝 | 消费点 |
| --- | --- |
| `deferred/storage-memory.ts` | `hooks/magic-context/inject-compartments.ts:29` |
| `deferred/render-trigger.ts` | `inject-compartments.ts:31-32`（`resolveMuralWire` + `MuralWireOptions`） |
| `deferred/memory-selection.ts` | `inject-compartments.ts:20`（`compareMemorySelectionPriority`） |
| `deferred/magic-context-prompt.ts` | `inject-compartments.ts:8`（`MEMORY_MURAL_BLOCK`） |
| `deferred/compaction-off-transition.ts` | `transform.ts:92`（`commitCompactionModeRecord`, `reconcileCompactionMode`） |
| `deferred/model-resolution.ts` | `transform.ts:84`、`compartment-runner-historian.ts:105`、`compartment-runner-types.ts:45` |
| `deferred/prompt-surface.ts` / `-runtime.ts` | `transform.ts:86-87` |
| `deferred/project-security.ts` | `transform.ts:1`（`ProtectedTokensTierOverrides`） |
| `deferred/ctx-reduce-availability.ts` | `transform.ts:99` |
| `deferred/event-resolvers.ts` | `transform.ts:115` |
| `deferred/hook-handlers.ts` | `transform.ts:122` |
| `deferred/note-nudger.ts` | `transform.ts:135` |
| `deferred/send-session-notification.ts` | `transform.ts:155` + `transform.ts:201/206/211/252`（`import()` 类型） |
| `deferred/compartment-chunk-embedding.ts` | `features/magic-context/storage-session-tables.ts` |
| `deferred/auto-search-runner.ts` | `transform-postprocess-phase.ts` |
| `deferred/dreamer-task-registry.ts` / `channel2-cycle.ts` / `embed-session-state.ts` / `embedding-failure.ts` / `embedding-status-tables.ts` / `storage-user-memory.ts` | `inject-compartments.ts:45`（`storage-user-memory`） |

**⚠ 观察**：6 个 deferred 文件在本节点的 grep 中**未找到 `src/` 内消费点**：`dreamer-task-registry.ts`、`channel2-cycle.ts`、`embed-session-state.ts`、`embedding-failure.ts`、`embedding-status-tables.ts`、`send-session-notification.ts`（后者经 `transform.ts` 的 `import()` 类型消费点确认有引用，故不算无消费）。即 **`dreamer-task-registry` / `channel2-cycle` / `embed-session-state` / `embedding-failure` / `embedding-status-tables` 5 个缝目前零 import**（knip 靠 `ignore: ["src/**"]` 兜住，见 §5-S8）。

---

## 5. 可疑点清单

> 全部为「观察到的事实 + 为什么可疑」，不裁决对错。

### S1 — 两个 src/core 文件含裸 NUL 字节，git 视为 binary

- `src/core/deferred/ctx-reduce-availability.ts` 字节偏移 **4127**（单字节 `0x00`），上下文：`` return `${toolName}␀${sessionId}`; ``（`permissionCacheKey`，`:~70`）
- `src/core/deferred/embedding-failure.ts` 单字节 `0x00`，上下文：`` const key = `${failure.class}␀${failure.reason}`; ``（`:~20`）
- **上游对照**：两处上游写的都是**转义序列** `\u0000`（6 字节 ASCII），fork 落成了**真字节 0x00**
- **为什么可疑**：
  1. 运行时语义等价（JS 模板字面量里的裸 NUL 与 `\u0000` 同值）—— 但这**削弱了「逐字移植」的字节等价性**：UPSTREAM-SYNC §3「移植件更新流程」第 1 步要求「从 .reference 取上游文件**逐字覆盖**」，这两处不是逐字。
  2. git 把这两个文件判为 **binary**，`git diff` / `git log -p` / code review diff / `git grep -n` 全部退化为「Binary file matches」（本次取证中 `git grep FORK-NOT-PORTED` 就是这样吞掉了 ctx-reduce-availability 的第 2 处命中）。
  3. 二进制文件不参与文本 diff 的任何下游门禁（PR diff 视图、`.gitattributes` diff driver 未配置）。
- **上游无对应文件被改动**：这是 fork 侧写入时就带入的（BASE..HEAD 全为新增）。

### S2 — 4 处实质 FORK 手术未进 iteration-state 登记

| 手术 | 位置 | iteration-state 是否有登记 |
| --- | --- | --- |
| `sqlite.ts` TLA → `requireSqliteModule()` | `shared/sqlite.ts:186-238`（53 行） | ✅ **有**（`key_fixes`「s24-fix: cli build 三件套（…sqlite.ts TLA 换同步 requireSqliteModule+process.getBuiltinModule/exports 补 require 条件）」）——更正：**此项已登记** |
| `storage-db.ts` `MAGIC_CONTEXT_DB_FILE_NAME` | `storage-db.ts:160-167` | ❌ 无独立登记（D-5 决策，隐含在 `storage-dir.ts` 适配层行） |
| `storage-db.ts` 删 tool-owner / message-time backfill | `storage-db.ts:68-74 / 1089-1123` | ❌ 无（注释自述「Step 18/21 re-add」） |
| `transform.ts` `transformMode?: "ts"` 收窄 + Rust lane 全删 | `transform.ts:169/642/692/729/778/960/3198` | ❌ 无（隐含在「明确不搬 `rust-*`」） |
| `compartment-storage.ts` 893→455 缩减 | `compartment-storage.ts` 全文 | ❌ 无（隐含在「明确不搬 `compaction-marker*` / recomp 族」） |
| `read-session-db.ts` 短路 | 整个文件被 `harnessOwnsOpenCodeStore()` 短路（harness 默认 `"opencode"` → 恒 true；但 ZCode 装配层 `setHarness("zcode")` → 恒 false） | ❌ 无 |

**为什么可疑**：UPSTREAM-SYNC §3 要求「落在 `src/core/` 的上游改动走逐字重放 + 重贴归属头」，但本次 src/core 是**移植首版**而非同步——`.iteration-state.yaml` 的 `deviations` 只登记了 4 条（s16 schema 位置 / s16 historian 子形状 / s18 批次边界 / s18-fix 批次 + 环境 + 临时项）+ `deviations_added` 3 条。**缩减型手术（每个都在 100+ 行量级）不在任何登记里**。这是登记粒度问题，不是代码问题。

### S3 — `queueM0Mutation` / `clearCachedM0M1` 在 fork 里已成零消费导出

- `storage.ts:80-81`（`queueM0Mutation` + 别名 `appendM0Mutation`）、`storage.ts:112`（`clearCachedM0M1`）仍 barrel 导出
- `git grep` 全 `src/`：**除定义与 barrel 外零消费点**
- **为什么可疑**：fork 的 `compartment-storage.ts` 把 `appendCompartments` 的 `invalidateAutoEmbedSession` 尾删了（`:366-378` 注释确认），但**上游 `insertCompartmentRows` 尾的 `invalidateAutoEmbedSession` 与 `queueM0Mutation` 是两个不同调用**——fork 只删了前者（它在 replaceAll 家族里）。需要确认 `appendCompartments` 在 fork 里是否还调用 `clearCachedM0M1`（上游 appendCompartments 本身不调，只在 replaceAll 家族里调）→ 若确实不调，则 fork 里**没有任何路径在 compartment 写入后清 m[0] 缓存**，只能靠 `storage-meta-shared.ts:607` 的内部路径。m[0] 缓存陈旧会导致 inject 渲染过期记忆。本节点未追完这条链。

### S4 — `storage.ts` barrel 的头注与自身实现不同步

`storage.ts:1-20` 头注声明 barrel 相比上游**少再导出 4 个模块**：`./compartment-storage.js` / `./message-index.js` / `./project-docs-hash.js` / `./project-identity.js`。

- **实测**：`compartment-storage.ts` 已「LANDED at its own path in Step 20」（头注 `:4-6` 自述），`project-identity.ts` 已作为 1 行 barrel（`export * from "./memory/project-identity.js"`）存在，**但 `storage.ts` 里确实都没有再导出它们**——头注在这一点上是对的。
- **⚠ 但**：`inject-compartments.ts:39-40` 的 diff 显示 fork 把 `readProjectDocsCanonical` 的 import 从 `../../features/magic-context/storage` 改成了 `../../features/magic-context/project-docs-hash.js`，而头注 `:16` 说 `project-docs-hash.js` 是「Batch 2 (Step 31)」不导出——**但 `project-docs-hash.ts` 文件在 fork 里存在（190 行，纯 import 路径 diff）且被 `inject-compartments` 真消费**。即：**头注把一个已落地且已消费的模块归类为「Batch 2 待落地」**。
- 同理 `message-index-async.ts` 头注 `:13-15` 说「fork has no FTS tables to reconcile into」，但 `storage-db.ts:1123` 明确调了 `startMessageFtsRowidMapBackfill`——**有 FTS 表**。头注的判据描述与代码事实不一致。
- **为什么可疑**：这是「头注描述的世界模型」与「代码实际落地状态」的分叉。取证时若只看头注会得出错误结论。

### S5 — 66 个 src/core 文件缺文件末尾换行

`src/core/**/*.ts` 中 **66 个文件**最后一个字节不是 `0x0A`。含全部 21 个 deferred 文件、全部 `tools/**`（13 个）、`compartment-runner-historian.ts`（diff 里显式 `\ No newline at end of file`）、`plugin/types.ts`、`shared/user-facing-codes.ts`、`shared/model-cache-ttl.ts` 等。

**为什么可疑**：
1. `.oxfmtrc` 的 `apps/zcode-cli/.oxfmtrc.json` **忽略 `packages/magic-context/src/core/**`**（§5-S8），所以 fmt 门禁不会修
2. 上游对应文件多数有末尾换行（`compartment-runner-historian.ts` diff 明确显示 fork 侧缺）
3. 移植工具链按行写文件时易丢末行换行；这 66 个与「deferred 缝 = 手工新建」的文件集高度重合

### S6 — `storage-subagent-invocations.ts` 已无写方

- 文件在 fork 存在（210 行，纯 import 路径 diff），被 `storage.ts:261-269` barrel 导出（7 个符号）
- fork 的 `compartment-runner-historian.ts` 删掉了全部 `recordChildInvocation` 调用（§3.3），并在 `:80-83` 注释说明「fork's attribution for a historian run is the executor's own usage」
- `git grep recordSubagentInvocation / getSubagentInvocations / getSubagentTotalsBySubagent`：**仅定义 + barrel，零消费**
- **为什么可疑**：`subagent_invocations` 表的 DDL 是否还在 `migrations.ts` 里？（若有 → 表在、无写方、无读方，纯 schema 负担；若无 → barrel 指向不存在的表）。本节点未查 DDL。

### S7 — `read-session-db.ts`（682 行）在 ZCode 恒短路但仍全量移植

- 文件 682 行，与上游 diff 仅 +5/−5（纯 import 路径）
- 全部 5 个对外查询函数（`:52` `openCodeDbPathExists`、`:72`/`:345`/`:580`/`:608` 四处）都以 `harnessOwnsOpenCodeStore()` 为闸
- `harness.ts:74-76` `harnessOwnsOpenCodeStore(harness = currentHarness)` 只对 `"opencode" | "opencode2"` 返回 true
- `harness.ts:34` 默认值 `"opencode"`；ZCode 装配层在 boot 时 `setHarness("zcode")`（`host/harness.ts`，见 `harness.ts:26-30` 注释自述）
- **为什么可疑**：ZCode 运行时该文件**全部函数恒返回「不可用」**。682 行 × 4 处闸门的代码在 fork 里是死面。且 `storage-db.ts:21` 还 import 了同一个 `harnessOwnsOpenCodeStore`（见 S9）。

### S8 — `.oxfmtrc` 与 knip 对 src/core 的两处长期忽略仍生效

- `apps/zcode-cli/.oxfmtrc.json`：`ignorePatterns` 含 `"packages/magic-context/src/core/**"`（另有 dist）
- `omz/knip.json:32`：`"apps/zcode-cli/packages/magic-context": { "ignore": ["src/**"], "ignoreDependencies": ["ai-tokenizer"] }`
- `iteration-state.phase2a.methodology_added` 记：「s15/s16 临时项: `.oxfmtrc ignore src/core/**`（保持与上游可 diff）；knip ignore src/**（barrel 接线后移除）——**均已登记待办**」
- **为什么可疑**：
  1. knip `ignore: ["src/**"]` 意味着**整个 magic-context 包（含 245 个 core 文件 + host + index.ts）对 knip 完全不可见**——§5-S3/S6/S9 列出的所有「零消费导出」都被这条吞掉，没有任何门禁会报
  2. `.oxfmtrc` 忽略 src/core 意味着 §5-S5 的 66 个缺末尾换行、§3.1 里 `transform.ts:265` 的超长注释行等格式问题**永不进 fmt 门禁**
  3. 这两项在 phase2a 登记为「临时待办」，到 HEAD（v0.1.0）**仍未移除**——距登记已过 4 个 phase

### S9 — `storage-db.ts` 有未使用的 import

- `storage-db.ts:21` `import { harnessOwnsOpenCodeStore } from "../../shared/harness.js";`
- `Select-String` 全文件扫描：该符号**只出现在 :21 这一行**（其余命中是 `readProcessProbeEvidence` / `bootQuiet` 等其他符号）
- **为什么可疑**：
  1. §3.4 的 diff 显示 `const readsOpenCodeStore = harnessOwnsOpenCodeStore();` 在 `finishDatabaseOpen` 里被删（fork 删 tool-owner backfill 时连带删的），**import 没跟着删**
  2. `packages/magic-context/tsconfig.json` **没有 `noUnusedLocals` / `noUnusedParameters`**（实测全文 17 行，只有 `strict: true`）——`strict` 不含这两项
  3. 根 `.oxlintrc.json` 的 `ignorePatterns` 含 `apps/zcode-cli`（iteration-state 已记为基线事实），CLI 子树不受根 lint 管
  4. knip `ignore: ["src/**"]`（§5-S8）
  → **四道门禁全部不覆盖这个未使用 import**。它大概率是 S24-fix 删 `runToolOwnerBackfill` 时的漏删（那行 import 在上游是被 `readsOpenCodeStore` 用的）。

### S10 — `compartment-runner-historian.ts` 的 fallbackModels 语义改写

- 上游 `runHistorianPrompt` 内：`fallbackModels: modelOverride ? undefined : fallbackModels`（「已在 modelOverride 最后兜底路径则不再迭代 fallback 链」）
- fork：`:693` `...(args.fallbackModels ?? [])` 直接进 `HiddenRunIdentity.fallbackModels`，**modelOverride 判据消失**
- fork 注释 `:686` 声称 "Resolved historian fallback chain, forwarded to the run identity"——即语义从「控制是否迭代」改为「上报给 executor」
- **为什么可疑**：`runFallbackHistorianPass` 自己仍逐个跑 `chain`。若 `hidden-completion-executor.ts` 也读 `run.fallbackModels` 并自己迭代 → **同一 pass 可能跑两遍 fallback 链**。本节点未查 `hidden-completion-executor.ts` 是否消费 `run.fallbackModels`。

### S11 — `historianReasoningBudgetDiagnostic` 诊断串信息量削减

见 §3.3 观察 A。上游串含 `formatRunTokenLog(tokens)` 的 token 明细，fork 版只有 `(no text)`。该串进 `ValidatedHistorianPassResult.error` → 用户可见的失败原因。**为什么可疑**：historian 失败是 T-M6 类问题的主要诊断面，减少信息量与 `compartment-runner-historian.ts:79` fork 自述的「A failed validation is still fully diagnosable」有张力。

### S12 — `fallbackModels` / `parseModelOverride` 相关的模型 id 校验缺口

见 §3.3 观察 B。上游 `if (!parseModelOverride(modelId)) continue;`（要求 `provider/model` 形状）被删。**为什么可疑**：`readPrompt` 如何解构 `body.model` 决定了这个校验是否在别处补回；若别处没有，则一个纯 `model` 串（无 `/`）会被当作合法模型下发给 executor。

### S13 — `harness.ts:4-6` 注释仍描述上游的数据路径

```
 * Magic Context's SQLite database lives at a vendor-scoped path
 * (`~/.local/share/cortexkit/magic-context/`) so OpenCode, Pi, and OMP can share ...
```
fork 的实际路径是 `~/.omz/cli/db/magic-context.db`（`data-path.ts:11` + `storage-db.ts:89`）。FORK 注释块（`:23-31`）解释了 `"zcode"` harness id 与默认值决策，但**没有修正 `:4-6` 的路径陈述**。**为什么可疑**：路径陈述被 UPSTREAM-SYNC §3 第 4 条（品牌改名字面量一律改写）覆盖，但该条针对「上游新增的 ZCode 字面量」，本处是 fork 侧遗留未改；取证者若只读文件头会取到错的路径。

### S14 — `internal-initiator-marker.ts` 的 `OMO_` 前缀

`shared/internal-initiator-marker.ts:1` `export const OMO_INTERNAL_INITIATOR_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->";`

上游 `.reference/.../shared/internal-initiator-marker.ts:1` **逐字相同**（已核对）。消费点：`read-session-chunk.ts:287` / `read-session-formatting.ts:43`，用 `.replace(OMO_INTERNAL_INITIATOR_MARKER, "")` 剥除。

**为什么可疑（低）**：该标记串会被写进/读出 ZCode 的会话库，是一条**跨包承重的字面量契约**。上游的 `OMO_` 前缀源自 OpenCode 系命名，fork 保留它是对的（逐字移植 + marker 必须与上游产出对齐，否则剥离失效）。但若未来 ZCode 自己产生 system-reminder 时用了不同的 initiator 标记，`replace` 静默不命中。本节点未查 ZCode 侧是否产生该标记（该标记属 OpenCode 的 system-reminder 格式，ZCode 大概率不产生 → 剥离永不生效 = 恒 no-op）。**这与 §5-S7 同型**。

---

## 6. FORK 偏离登记核对：未登记但代码里有注释块的 src/core 文件

`git grep -l "FORK-NOTE\|FORK:"` 命中但**未进 iteration-state** 的显式手术文件（部分，抽样）：

| 文件 | 头注类型 | 行数变更 | 是否登记 |
| --- | --- | --- | --- |
| `features/magic-context/compartment-storage.ts:1-42` | FORK-NOTE(S20) | 893→455 | ❌ |
| `features/magic-context/session-project-storage.ts:1-17` | FORK-NOTE(S20) | ? | ❌ |
| `hooks/magic-context/compartment-runner-historian.ts:1-100` | FORK-NOTE(S20) | 1055→572 | ❌ |
| `hooks/magic-context/compartment-runner-types.ts:1-41` | FORK-NOTE(S20) | +90 | ❌ |
| `features/magic-context/compaction-marker.ts:1-25` | FORK-NOTE(S20) | 1083→43 | ❌ |
| `features/magic-context/storage-db.ts:68-74/160-167/283-299/911/916/1089-1123` | FORK（内联） | 多处 | ❌ |
| `shared/sqlite.ts:186-238` | FORK（S24-fix） | +53 | ✅ 已登记 |
| `shared/data-path.ts:8-11` | FORK（内联） | — | ❌ |
| `hooks/magic-context/transform.ts:1221-1244/445-456/3198-3204` | FORK（S24-fix / 裁剪） | 多处 | ✅ hostProcessLifetime 已登记；Rust lane 未登记 |
| `features/magic-context/storage.ts:1-20` | FORK（内联） | barrel 删 4 | ❌ |

**观察**：`compaction-marker.ts` 1083→43 行（96% 缩减）——`compareOpenCodeMessagesByCanonicalOrder` 恒返回 `null`，是**有意的语义降级**（fork 注释 `:16-25` 说 `transform-postprocess-phase.ts` 把 `null` 当「不可比较」→ 走 ordinal 相等分支 = 保守路径）。这是**唯一一个「移植件语义被有意改成恒定值」**的地方，且未进登记。

---

## 7. 门禁覆盖盲区汇总（供 cr-func 参考）

| 盲区 | 影响 |
| --- | --- |
| `tsconfig.json` 无 `noUnusedLocals` | S9 的未使用 import 不被 typecheck 捕获 |
| 根 `.oxlintrc.json` ignorePatterns 含 `apps/zcode-cli` | CLI 子树不受根 lint；`turbo run lint` 在基线即红 |
| `knip.json` `ignore: ["src/**"]`（magic-context workspace） | S3/S6/S9/S10 的零消费导出全部不可见 |
| `apps/zcode-cli/.oxfmtrc.json` ignore `src/core/**` | S5 的 66 个无末尾换行、格式问题不进 fmt 门禁 |
| `src/core` 2 文件被判 binary（S1） | git diff / git grep / PR review 全部退化 |

---

## 8. 取证方法与局限

**命令**：
- `git diff --no-index --ignore-cr-at-eol -U1/2 <.reference 路径> <fork 路径>`（`-c core.autocrlf=false`），输出重定向到临时文件后以 Read 逐行过读
- `git diff --shortstat / --numstat 1fa2d0e..aba59a9 -- <scope>`
- `git grep -n/-c/-l <pattern> -- <path>`（对 binary 文件只输出「Binary file matches」）
- `Select-String`（PowerShell）逐行确认符号在文件内的全部出现
- `[System.IO.File]::ReadAllBytes()` 校验 NUL 字节与末尾换行

**局限**：
1. **未逐行过读**的文件（仅 --stat）：`compartment-runner-incremental.ts`（+180/−869）、`compartment-runner.ts`（+48/−124）、`compartment-runner-mapping.ts`、`compartment-runner-drop-queue.ts`、`ctx-reduce-availability.ts`、`event-resolvers.ts`（473 行）、其余 ~215 个 src/core 文件。**本包的语义漂移结论只覆盖 §3 表中已逐行过读的 10 个文件。**
2. 未运行任何门禁（typecheck / lint / knip / test），全部为静态取证。
3. 未追完 §5-S3（m0 失效链）、§5-S6（subagent DDL 是否在）、§5-S10（executor 是否消费 `run.fallbackModels`）、§5-S12（`readPrompt` 解构）四条链。
4. 未验证 `.reference/magic-context` 快照是否真为 0.44.4（只读到 git `55b70ea82`）。
5. 两个 binary 文件（S1）的**内容**未逐行核对，仅核对了 NUL 位置与上游对应片段。
