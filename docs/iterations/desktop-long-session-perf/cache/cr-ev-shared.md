# CR 取证证据包 — shared 契约与摘要工具（phase-shared / previewText）

- head_sha: `d11a97c`
- base_sha: `ba7c240`
- 取证日期: 2026-10-05
- 仓库: `D:\Dev\worktree\desktop-long-session-perf`
- 取证范围（6 文件 / +1123 行，全部新增）:
  - `packages/shared/src/zcode-protocol-v4/transport.ts` (+59)
  - `packages/shared/src/zcode-protocol-v4/core.ts` (+3)
  - `packages/shared/src/zcode-protocol-v4/index.ts` (+2)
  - `packages/shared/src/zcode-protocol-v4/previewText.ts` (新 191)
  - `packages/shared/test/apply.test.ts` (新 645)
  - `packages/shared/test/previewText.test.ts` (新 223)
- Spec 对照源: `docs/iterations/desktop-long-session-perf/spec.md` L53/L64/L75-95/L118/L139-141/L180/L183-184/L201/L205/L216
- 角色: **只取证，不下结论、不给评级**。下列条目均为事实陈述与可复现观测。

---

## 0. 已执行的验证动作（可复现）

| 动作 | 命令 | 结果 |
|---|---|---|
| 跑 previewText 测试 | `npx tsx --test packages/shared/test/previewText.test.ts` | 13 pass / 0 fail |
| 跑 apply 测试 | `npx tsx --test packages/shared/test/apply.test.ts` | 10 pass / 0 fail |
| shared 包类型检查 | `npx tsc -p packages/shared/tsconfig.json --noEmit` | 无输出（通过） |
| lint | `npx oxlint <4 个变更文件>` | 1 warning（`transport.ts:893` `no-control-regex`，**存量行，不在本次 diff 内**） |
| 桶导出可解析性 | `import * as S from '.../zcode-protocol-v4/index.js'` | 340 个导出；`buildPreviewText`/`buildPreviewTextWithStats`/`DEFAULT_MAX_PREVIEW_*`/`turnDirectoryEntrySchema`/`v4ConversationTurnDirectory*Schema`/`PROTOCOL_V4_LIMITS` 全部在列 |
| 单串穷举对拍 | 自建脚本，12 元字母表（`a B \n ' ' \t \u3000 \ufeff \u00a0 \u2028 \r \v \f`）深度 4 = 20 736 串 × maxChars 0..16 × maxParas 0..3 | **1 410 048 组，0 失配** |
| 多 texts 数组对拍 | LCG 随机，1..3 段 × 每段 0..6 字符 × maxChars 0..19 × maxParas 0..3 | **400 000 组，0 失配** |
| Unicode 边界对拍 | `\u{1F600}` / `e\u0301` / 孤立代理 `\uD800` `\uDC00` / `\u200B` / `\u180E` / `\uFEFF` / `a\u0000b`，两两组合 × maxChars {0,1,5,8,9,10,11,20} × maxParas {0,1,2,3} | **0 失配** |
| `emitBudget = cap+1` 边界对拍 | len 7..20 × maxChars {0,1,7,8} + 两段/三 texts 变体 | 0 失配 |
| 非有限数/小数边界 | maxChars ∈ {NaN, ±Infinity, -0, 10.5, 1e-9, 2^31} × maxParas ∈ {NaN, 2.5, 0, -5} | **见 S-10，有失配** |
| schema 严格性/数值探针 | `safeParse` 各边界 | 见 §3 S-06/S-07 |

---

## 1. Spec 声明 vs 代码现状 逐条对照

### 1.1 契约段（spec L75-86 → `transport.ts` / `core.ts`）

| spec 声明 | 代码现状 | 位置 | 判定 |
|---|---|---|---|
| 新增只读方法 `v4/conversation/turnDirectory` | `V4_METHODS.conversationTurnDirectory = "v4/conversation/turnDirectory"` | `transport.ts:339` | 落地 |
| params = `{ sessionId, clientMode, limit?, beforeQueryRowId? }`，形状照 rowsRange | `v4ConversationTurnDirectoryParamsSchema` 四字段齐全，`clientMode` enum 与注释逐字照抄 rowsRange | `transport.ts:534-542` | 落地 |
| result = `{ entries, realUserQueryTotal, atSeq, atRevision, atLogEpoch, hasMore }` | 六字段齐全 | `transport.ts:568-579` | 落地 |
| `TurnDirectoryEntry` 五字段、**不用 turnKey** | `turnId/queryRowId/queryPreview/assistantPreview/assistantPreviewKind` 五字段，无 turnKey | `transport.ts:557-565` | 落地 |
| entries 按 `queryRowId` 升序（硬定义，注释固化） | JSDoc 三条硬定义逐条写明（升序 / 严格小于 / hasMore 语义），并显式警告「不要照抄 getPlans 的降序」 | `transport.ts:547-556`、`transport.ts:569` | 落地（契约层注释固化；实际排序由 publisher `toSorted((l,r)=>l.rowId-r.rowId)` 保证） |
| 游标 `beforeQueryRowId` = 严格小于 | JSDoc + publisher `entry.queryRowId < beforeQueryRowId` | `transport.ts:538`、`conversation-topic-publisher.ts:530` | 落地 |
| `hasMore` = 更早方向仍有条目（非「这页满 limit」） | JSDoc 明写；publisher `hasMore: eligible.length > page.length` | `transport.ts:555`、`publisher.ts:538` | 落地 |
| `realUserQueryTotal` = 全量现算权威总数 | JSDoc 明写；publisher 取 `allEntries.length`（在游标/limit 过滤之前） | `transport.ts:571-573`、`publisher.ts:536` | 落地 |
| `assistantPreviewKind` 三态 + 文案不下发 | enum `["empty","running","text"]`；JSDoc 写明「文案不下发，客户端填 i18n」 | `transport.ts:562-564` | 落地 |
| `PROTOCOL_V4_LIMITS` 新增 `turnDirectoryMaxEntries` | `turnDirectoryMaxEntries: 500` + 注释说明 220 字符摘要的传输成本 | `core.ts:77-79` | 落地 |

**未发现 spec 声明但代码缺失的契约项。** 三条硬定义以 JSDoc 形式固化在契约文件里，spec 要求的「硬定义」形式满足。

### 1.2 摘要口径段（spec L53 / L90 / L183 / L205 T-TD1）

| spec 声明 | 代码现状 | 判定 |
|---|---|---|
| 提取到 `@zcode/shared` 的 `previewText.ts` | 文件存在，191 行，头部注释写明出身与 B-4 改造 | 落地 |
| 更新 `index.ts` 桶导出（不加导出 renderer 引用不到） | `index.ts:35` `export * from "./previewText.js"`；实测 renderer `conversationTurnNavigatorHelpers.ts:1-5` 从 `@zcode/shared/zcode-protocol-v4` 引入成功 | 落地 |
| renderer 原三函数**删除**并改 import | `ba7c240` 版本 `:99-135` 有 `normalizePreviewParagraphs`/`truncatePreview`/`buildPreviewText` 三个本地函数；HEAD 版本只剩一行注释「三件套已下沉」，函数体已删 | 落地 |
| `buildAssistantPreview` 留 renderer | 仍在 `conversationTurnNavigatorHelpers.ts:183-213`，依赖 `ConversationTurnRenderUnit`（UI 类型） | 落地 |
| sessions-index 的 120 字符口径不动 | `sessions-index-projection.ts:21` `MAX_PREVIEW_CHARS = 120` 保持独立 | 落地 |
| 逐字节等价（折叠前缀单调） | §0 四组对拍共 **1 810 048 组 0 失配**；`previewText.ts:13-24` 给出两条依赖事实（`\s` 集合 == trim 集合；`/\n\s*\n/` 切点 == 极大空白串含 ≥2 换行）的论证 | 落地（另见 S-10 的定义域外情形） |
| 扫描量有界 O(maxChars + 段数) | **仅在无长空白串时成立**，见 S-01 | **部分**（见 S-01） |
| T-TD1 四类固定边界语料 | 语料齐备（超长空白前缀段 / 段间多空白 / 截断边界落空白串内 / 纯空白输入），另加 4 条扩展语料 | 落地 |
| T-TD1 扫描量断言 | 两条 `scannedChars` 上界断言存在 | 落地但断言域偏窄（见 S-01） |

### 1.3 C1 / T-AP1（spec L64 / L180 / L201 / L216）

| spec 声明 | 代码现状 | 判定 |
|---|---|---|
| `apply.ts:200` 的 `Object.assign(snapshot, delta.patch)` 正确性前提是 `statePatchSchema` 键集合不含 `rows`/`seq`/`logEpoch` | 实测 `statePatchSchema.keyof().options` = 18 键，`rows`/`seq`/`logEpoch` 均不在；`Object.hasOwn(shape, k)` 三者皆 false；`apply.ts:198-201` 确为 `Object.assign` | 前提成立 |
| T-AP1 断言固化（键集合封闭） | `apply.test.ts:596-624` 两条断言：①`LEGAL_PATCH_KEYS.has(forbidden)===false` + `Object.hasOwn(statePatchSchema.shape, forbidden)===false`；②纵深防御：真的夹带三键时 `parse` 后 `Object.keys(parsed)===["revision"]` | 落地 |
| T-AP1 等价性（随机 delta 序列含 5 类 op） | `assertDeltasEquivalent` 三路对比：批量不可变 vs 逐条不可变 vs 可变 accumulator（逐条 + 批量） | 落地（覆盖度见 S-02/S-03/S-04） |

---

## 2. diff 变更点清单（`git diff ba7c240..d11a97c`）

### 2.1 `transport.ts` (+59)

**块 A — `V4_METHODS` 新增一项（:336-339）**
```
conversationTurnDirectory: "v4/conversation/turnDirectory",
```
前置注释三点：与 rowsRange 同族的只读 query；目录不是「再给一份全量快照」，服务端从全量投影行现算派生；独立成方法而非给 rowsRange 加 mode（理由：给行语义加 mode 会污染）。

**块 B — `v4ConversationTurnDirectoryParamsSchema` + type（:530-545）**
四字段；`clientMode` 注释逐字沿用 rowsRange 的 `/** Host attachment injects this trusted value; renderer callers omit it. */`；`limit` 上界绑 `PROTOCOL_V4_LIMITS.turnDirectoryMaxEntries`，缺省语义写在注释。

**块 C — `turnDirectoryEntrySchema` + `TurnDirectoryEntry` type（:547-566）**
前置 JSDoc 明确「不带 turnKey」的理由（避免 turnId/productTurnId/turnKey 三义），并列出**三条硬定义**：①entries 按 queryRowId 升序，附「不要照抄 getPlans 降序」警告；②beforeQueryRowId 只返回严格小于；③hasMore = 更早方向仍存在条目，不是「这次拉满了 limit」。三态判定规则与「文案不下发」写在 `assistantPreviewKind` 字段注释里。

**块 D — `v4ConversationTurnDirectoryResultSchema` + type（:568-583）**
六字段；`realUserQueryTotal` 注释写明它替代客户端「翻页探测后 reduce」；`atSeq/atRevision/atLogEpoch` 注释写明与 rowsRange 共用以避免跨 revision 拼接。

### 2.2 `core.ts` (+3)

`PROTOCOL_V4_LIMITS` 内新增 `turnDirectoryMaxEntries: 500`，前置两行注释给出取值依据（目录条目自带 220 字符摘要，500 条 ≈ 一屏导航纵深，再多传输成本线性涨）。

### 2.3 `index.ts` (+2)

`export * from "./previewText.js";` + 一行注释「摘要口径（220 字符 / 2 段落）的唯一实现：renderer rail 与服务端 turn 目录共用」。位置在 `apply.js` 之后、`transport.js` 之前。

### 2.4 `previewText.ts` (新 191)

结构：`DEFAULT_MAX_PREVIEW_CHARS=220` / `DEFAULT_MAX_PREVIEW_PARAGRAPHS=2` 两个常量；`PREVIEW_MIN_MAX_CHARS=8`（对齐旧 `truncatePreview` 的 `Math.max(8, …)`）；`isPreviewWhitespaceCode(code)` 逐码元空白判定（ASCII 分支 + 8 个非 ASCII 码点）；`buildPreviewTextStreaming` 主体（`emitBudget = cap+1`、`push/closeParagraph/paragraphBudgetSpent` 三个闭包、`scan:` 标签双层循环、texts 间 join 的 `"\n\n"` 记账）；两个公开入口 `buildPreviewText` / `buildPreviewTextWithStats`。

### 2.5 `apply.test.ts` (新 645)

`PATCH_BUILDERS` 18 个键的构造函数 → `buildPatch` 随机取 1~3 键 → `generateDeltaSequence`（LCG/mulberry32，五类 op 按 0.28/0.45/0.72/0.87 阈值混合，含 ghost rowId no-op 用例）→ `assertDeltasEquivalent` 三路对比。另含 5 条边界用例与 2 条 C1 不变量用例。

### 2.6 `previewText.test.ts` (新 223)

测试内**逐字照抄**旧 renderer 三函数作参照实现（`legacyNormalizePreviewParagraphs`/`legacyTruncatePreview`/`legacyBuildPreviewText`）；8 条 `BOUNDARY_CASES` + 1 条 maxChars 全扫（8..72 × 段数 {1,2,5}）+ 1 条 400 轮固定种子混合语料 + 2 条扫描量上界 + 1 条纯空白回退。

---

## 3. 可疑点清单（事实描述，不含评级/结论）

> 不重复 iteration-state 已登记的 M1/M2；以下均为本轮独立取证所得。

### S-01 `previewText.ts:79-81` — JSDoc 对「无界扫描」情形的描述不完整，与实测不符

JSDoc 原文：

> 唯一的无界情形：输入里没有任何非空白字符（纯空白），**或长空白串之后接不到内容**——要判定「回落 fallback / 段已收尾」就必须扫到那串空白末尾

实测（`buildPreviewTextWithStats`，maxChars=24 / 段数 2）：

| 输入 | `scannedChars` | 相对 maxChars 倍数 |
|---|---|---|
| `" ".repeat(400000) + "x" + "答"*5000`（长空白**前缀**，后面**有**内容） | 400 025 | 16 667× |
| `"\u00a0".repeat(400000) + "x"` | 400 001 | 16 667× |
| `"a" + " ".repeat(400000) + "b"`（**段内**长空白，两侧都有内容） | 400 002 | 16 667× |
| `"\n".repeat(400000) + "x"` | 400 001 | 16 667× |
| `"\u2028".repeat(100000)` | 100 000 | 455× |
| `" ".repeat(1MiB)`（纯空白） | 1 048 576 | 4 766× |
| 对照：`"x" + "答".repeat(400000)`（无空白） | 25 | 1.0× |

即：**长空白串无论位于前缀、段内还是尾随，只要后面还接着内容，扫描量同样无界**——JSDoc 只把「接不到内容」列为无界，遗漏了「接得到内容」的前缀/段内形态。逐字节等价确实要求扫到该空白串末尾才能判定它是分隔符还是折叠空格，所以这是等价性的必要代价而非缺陷；但注释给出的「唯一无界情形」清单是不准确的描述。

关联事实：spec L53 写「扫描量有界（O(maxChars + 段数)）」、L205 T-TD1 写「新实现扫描字符数 ≤ maxChars + 段开销 的常数倍」。`previewText.test.ts:198` 的断言 `scannedChars <= maxPreviewChars * 2 + 64` 只在**不含长空白串**的语料上成立；而 `previewText.test.ts:68` 的 BOUNDARY#1 语料恰恰含 4096 空格 + 2048 NBSP + 1 全角空格前缀，在 maxChars=24 下实测 `scannedChars = 6171`（257×）——该用例只断言逐字节一致，**未对扫描量断言**，因此 T-TD1 的「常数倍」在含长空白串的语料上未被测试覆盖，也未被 spec 兑现。

### S-02 `apply.test.ts:192-273 / 286-288` — 「覆盖全部合法键」无守卫断言

注释 L192 声称「覆盖 `statePatchSchema` 除 rows/seq/logEpoch 外的全部合法键」。实测：`PATCH_BUILDERS` 的键集 = 18 键，与 `statePatchSchema.keyof().options` 的 18 键当前**恰好相同**。但代码中**没有任何断言**比对这两个集合（`LEGAL_PATCH_KEYS` 只在生成时做 `has(key)` 单向校验）。若日后 `statePatchSchema` 新增第 19 个合法键，测试会静默失去对该键的等价性覆盖，且 `state.updated` 覆盖度下降不会有任何失败信号。

### S-03 `apply.test.ts:328-365` — 等价性测试只生成 5 类 op，未覆盖 `conversationDeltaSchema` 的 7 类

`conversationDeltaSchema`（`delta.ts:94-144`）是 `z.discriminatedUnion("op", [...])`，含 **7** 个变体：`row.appended` / `row.upserted` / `row.removed` / `row.delta` / `state.updated` / `workflowRun.updated` / `workflowRun.removed`。`generateDeltaSequence` 只造前 5 类；`applyConversationDeltaMutable` 中 `workflowRun.updated` / `workflowRun.removed` 有**独立分支**（`apply.ts:204-208`），该两分支的可变/不可变等价性无任何测试覆盖。测试名「覆盖到全部五类 op」如实反映了 5 类。注：spec T-AP1（L201）也只列了这 5 类，故这属 spec 覆盖范围问题，不是实现偏离 spec。

### S-04 `apply.test.ts:311-312, 378` — 生成器以被测对象自身作为 oracle

`generateDeltaSequence` 用 `applyConversationDelta`（不可变版，即两条被比较路径之一）推进 `shadow`，据此判断「哪些 rowId 已在窗口里」。代码注释已自陈此选择。事实后果：若不可变版与可变版**共享**同一处语义 bug（例如窗口裁剪规则），生成出的 delta 序列会一致地偏移，等价性断言仍全绿，无法发现共享缺陷。断言能发现的是**两版分歧**，不能发现**两版同错**。

### S-05 `previewText.ts:47-50, 188-191` + `index.ts:35` — 诊断用 API 进入公共桶导出

`buildPreviewTextWithStats` 与 `PreviewTextBuildResult`（含 `scannedChars`）是标注为「诊断/测试钩子」的接口，但 `index.ts:35` 的 `export * from "./previewText.js"` 把它们一并导出到 `@zcode/shared/zcode-protocol-v4` 公共面（实测在 barrel 的 340 个导出中）。spec Step 13（L183）只要求「摘要工具提取 + 桶导出」，未要求把诊断统计量纳入公共契约。当前 `scannedChars` 的唯一消费方是 `packages/shared/test/previewText.test.ts`（全仓 grep 无其他引用）。

### S-06 `transport.ts:534 / 557 / 568` — 三个新 schema 均未 `.strict()`

实测：`parse({sessionId:"s", bogus:1})` → 未知键被**静默剥离**（返回 `{sessionId:"s"}`）；`turnDirectoryEntrySchema` 与 result schema 同。

横向事实：同文件内 `v4ConversationPlansParamsSchema`（:587-591）、`v4ConversationResyncParamsSchema`（:482-487）、`v4ConversationUnsubscribeParamsSchema`（:499-503）等均 `.strict()`；而**被 spec 点名为模板的** `v4ConversationRowsRangeParamsSchema`（:508-515）与 `v4ConversationRowsRangeResultSchema`（:518-527）同样未 `.strict()`。故新 schema 与直接模板一致、与文件主流约定背离。协议方向上前向兼容（老客户端剥键而非解析失败）符合 `delta.ts:54-56` 记录的既有取舍，但三处 schema 的严格性等级与同文件邻居不一致这一事实成立。

### S-07 `transport.ts:539, 559, 574` — 同一 result 内数值约束松紧不一

实测 `safeParse` 结果：

| 探针 | 结果 |
|---|---|
| `beforeQueryRowId: 1.5` | **通过** |
| `beforeQueryRowId: -3` | **通过** |
| `queryRowId: 1.5`（entry 内） | **通过** |
| `atSeq: 1.5` / `atSeq: -1` | **通过** |
| `realUserQueryTotal: 1.5` | 拒绝（`invalid_type`） |
| `realUserQueryTotal: -1` | 拒绝（`too_small`） |
| `limit: 1.5` | **通过** |
| `limit: 0` / `limit: 501` / `limit: NaN` | 拒绝 |
| `clientMode: "nope"` | 拒绝 |
| `assistantPreviewKind: "xx"` | 拒绝 |

即 `realUserQueryTotal`/`atRevision` 用 `.int().nonnegative()`，而同一对象里的 `atSeq`、`entry.queryRowId`、`params.beforeQueryRowId` 用裸 `z.number()`。与 `rows.ts:11` 的 `rowId: z.number()` 及 rowsRange 的 `beforeRowId: z.number()` 一致，故属**跨文件一致、文件内不一致**的事实。

### S-08 `packages/shared/tsconfig.json` + 无 script 引用 — 两个测试文件既不被 typecheck 也不被任何脚本执行

- `packages/shared/tsconfig.json` 的 `include` 只有 `["src"]`（注释与 `apply.test.ts:4-5` 自述一致：测试不进产物）。因此根 `pnpm typecheck`（`tsc -b … packages/shared …`）**不覆盖** `packages/shared/test/*.ts`。手工 `npx tsc --noEmit --strict …` 校验这两个文件会报 `TS2591: Cannot find name 'node:assert/strict'`（缺 node types），需显式补 types 才能跑。
- 全仓 grep：**没有任何 `package.json` script 或 CI 配置引用 `packages/shared/test`**。唯一带 script 的测试是 `apps/zcode-cli/packages/bootstrap/package.json:29` 的 `test:turn-directory`。`packages/shared/test/` 与 `packages/ui/test/`、`packages/services/test/` 均为「靠人工 `npx tsx --test <file>` 跑」形态。T-AP1/T-TD1 两个 blocking 测试当前**无自动化执行入口**。

### S-09 `previewText.test.ts:195-201` — 扫描量断言用了实现相关的魔数常量

断言 `scannedChars <= maxPreviewChars * 2 + 64` 与 `scannedChars < 1_024`。这两个上界不是从契约推导的，而是对当前实现行为的经验值；注释「宽容常数覆盖段首/段尾空白串」承认了这一点。作为回归护栏有效，但强度绑定实现（若未来把 `emitBudget` 从 `cap+1` 改成 `cap`，或改变段首空白处理，上界需要重算）。

### S-10 `previewText.ts:84-86` — 非有限数/小数入参下新旧不等价（逐字节等价的定义域外）

`maxPreviewChars`/`maxPreviewParagraphs` 传入 `NaN` 时 `Math.max` 不吸收 `NaN`，新旧走不同分支：

| maxPreviewChars | maxPreviewParagraphs | new | legacy |
|---|---|---|---|
| `NaN` | `NaN` | `"F"`（fallback） | `"F"` |
| `NaN` | `2.5` / `0` / `-5` | `"F"` | `"..."` |
| `Infinity` | `NaN` | 全文 | `"F"` |
| `-Infinity` | `NaN` | `"答案正文内..."` | `"F"` |
| `0` / `10.5` / `1e-9` / `2^31` | `NaN` | 截断结果 | `"F"` |

小数（`10.5`）与 `-Infinity` 在 `maxPreviewParagraphs` 为正常值时新旧**一致**；失配集中在 `NaN` 传播路径。实际调用方（`conversationTurnNavigatorHelpers.ts:221-222` 的 `?? DEFAULT_*`、publisher 的常量入参）不会传入 `NaN`，故当前不可达。记录为「`previewText.ts:13-15` 声称的『对任意输入逐字节一致』在非有限数入参上不成立」这一事实。

### S-11 `previewText.ts:152` — `text[i] ?? ""` 恒为死分支

`for (let i = 0; i < text.length; i += 1)` 内的 `text[i]` 在 `noUncheckedIndexedAccess` 下类型为 `string | undefined`，但循环条件保证 `i < length`，运行时恒非 undefined。同理 `previewText.ts:116` 的 `texts[t] ?? ""`。oxlint 未报（无 `no-unnecessary-condition` 规则）。纯冗余，非缺陷。

---

## 4. 与其他模块的接缝点（消费方清单）

### 4.1 新增/变更导出 → 消费方

| 导出 | 消费方（file:line） |
|---|---|
| `V4_METHODS.conversationTurnDirectory` | `apps/zcode-cli/src/zcode-protocol/server.ts:514`（switch case） |
| `v4ConversationTurnDirectoryParamsSchema` / `…ResultSchema` | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:123-124, 1588, 1595` |
| `V4ConversationTurnDirectoryResult`（type） | `v4-gateway.ts:70, 1587` |
| `TurnDirectoryEntry`（type） | `apps/zcode-cli/packages/bootstrap/…/conversation-topic-publisher.ts:28, 558`；`packages/ui/src/v4/ConversationTimeline.tsx:29, 334`；`packages/ui/src/v4/conversationProjectionStore.ts:21, 171, 1374` |
| `PROTOCOL_V4_LIMITS.turnDirectoryMaxEntries` | `conversation-topic-publisher.ts:518-519`（缺省 + 封顶）；`packages/ui/src/v4/conversationProjectionStore.ts:194, 1381`；`packages/services/src/zcode-agent/zcodeAgent.ts:392`（注释）；`apps/zcode-cli/packages/bootstrap/scripts/test-turn-directory.mjs:377` |
| `buildPreviewText` | `conversation-topic-publisher.ts:39, 548`；`packages/ui/src/v4/conversationTurnNavigatorHelpers.ts:2, 192, 244` |
| `DEFAULT_MAX_PREVIEW_CHARS` / `…PARAGRAPHS` | 同上（publisher `:35-36, 552-553`；helpers `:3-4, 221-222`） |
| `buildPreviewTextWithStats` / `PreviewTextBuildResult` | **仅** `packages/shared/test/previewText.test.ts:11, 179, 206, 216`（无生产消费方，见 S-05） |

### 4.2 契约链下游（本模块只提供契约，实现分布在别处）

- 服务端：`conversation-topic-publisher.ts:495-540`（`getTurnDirectory`）→ `v4-gateway.ts:1587-1607`（三段式取 publisher，`clientMode` 映射与 rowsRange `:1576` 逐字一致）→ `server.ts:514`。
- host：`packages/services/src/zcode-agent/zcodeAgent.ts:778`（接口 + `ZCodeAgentConversationTurnDirectoryParams{beforeQueryRowId?, limit?}`）→ `zcodeAgentService.ts:5280-5294`（用 `readTrustedZCodeAgentV4Connection` + `getReadOnlyClient`，符合 spec L93 的「跟 rowsRange 支」）→ `zcodeAgentConnectionScope.ts:742-744`。
- renderer：`packages/ui/src/v4/agentConversationTransport.ts:64`（Pick 联合新增 `"conversationTurnDirectoryV4"`）、`:348`（实际调用）；`workspaceConnectionRegistry.ts:28`（Pick 窄面）。
- 摘要口径共享：`packages/ui/src/v4/conversationTurnNavigatorDirectory.ts:41` 注释声明其 item 形状与 `@zcode/shared` 的 `TurnDirectoryEntry` 同形。
- 摘要口径回归：`apps/zcode-cli/packages/bootstrap/scripts/test-turn-directory.mjs` 12 条用例（A1/B1/C1 升序/D1 游标/D2 hasMore/D3 limit 封顶/E1 total/F1 三态含无 header→empty/F2 steer/G1 与共享 `buildPreviewText` 逐字节一致/G2 空白 query fallback 空串/H1/H2）——**服务端侧对 C2 契约的自动化覆盖在此文件**，与本模块的 schema 测试互补。

### 4.3 分层边界事实

- `apply.ts` / `delta.ts` 本次**未改动**（spec L149 明确排除）；新增的 `apply.test.ts` 是纯消费方测试。
- `sessions-index-projection.ts` 的 120 字符口径未被合并进 `previewText.ts`（spec L90 明确不动），实测其 `MAX_PREVIEW_CHARS = 120` 仍独立存在。
- 分享链路未引入 `turnDirectory` 引用（spec L149/L263），实测 `conversationShareService.ts` / `conversationShareAttachmentService.ts` 无相关 grep 命中。

---

## 5. 已确认无问题的项（负面取证，避免下游重复核查）

- 桶导出完整：`index.ts:35` 的加入足以让 renderer 与 publisher 引用到全部所需符号（实测 barrel 340 导出全部可解析）。
- 三条契约硬定义以 JSDoc 固化在契约文件本体，未被稀释到外部文档。
- `turnDirectoryMaxEntries` 的取值与 `limit` schema 上界、publisher 缺省封顶、`store` 续拉页上限四处一致（均为 500）。
- `statePatchSchema` 键集合封闭不变量经运行时实测成立（18 键，无 rows/seq/logEpoch），`Object.assign` 前提无洞。
- 两个新增测试文件均为 `@/`-free 纯相对路径导入，`npx tsx --test` 可直接跑通（13 + 10 全绿），符合 spec Step 5 的可测性硬 gate。
- 逐字节等价性在 181 万组对拍下零失配（含代理对、孤立代理、组合字符、NUL、全角空白、NBSP、U+2028/2029、BOM、`emitBudget=cap+1` 精确边界）。

---

*证据包结束。本文件为 code-review-loop 取证产物，不含评级与结论。*