# memory-port 证据包（bugfix-batch-20261011 / Step 8-9 / impl-memory-port）

- head_sha: a10e74a1
- 生成节点: impl-memory-port（magic-context src/core 记忆面）
- 上游对照源: `.reference/magic-context/packages/plugin/src/features/magic-context/`
- 提交序列（pathspec 仅本节点文件）:
  - 944b4967 `[Step 8]` 4 缝 git mv 归位 + 引用改指
  - d915d73b `[Step 8]` 7 件上游新移植（promotion 等）
  - 62dceebe `[Step 8]` 恢复 D13：historian 分舱边界事务内 promoteSessionFactsDurable
  - a10e74a1 `[Step 9]` 测试 T-MC0/T-MC1 + 编译链闭合收尾

## 搬运清单表

| # | fork 文件（相对 magic-context/src/core/） | 上游相对路径（features/magic-context/） | 上游行数→fork 行数 | rename\|新移植 | FORK-NOTE 差异登记 |
|---|---|---|---|---|---|
| 1 | features/magic-context/memory/storage-memory.ts | memory/storage-memory.ts | 1267→1294 | rename（git mv 自 deferred/storage-memory.ts 缝） | 整模块落盘无删减；仅 CRLF→LF + 相对 import 补 .js；曾经的 3 读 stub（[]/0）由真身替代 |
| 2 | features/magic-context/memory/memory-selection.ts | memory/memory-selection.ts | 45→59 | rename（deferred/memory-selection.ts） | 缝本就是逐字摘录，仅 import 行 `./types`→`./types.js` |
| 3 | features/magic-context/user-memory/storage-user-memory.ts | user-memory/storage-user-memory.ts | 296→313 | rename（deferred/storage-user-memory.ts） | getActiveUserMemories 由恒空 stub 变真读；新增候选/晋升/编辑/驳回写面 |
| 4 | features/magic-context/memory/embedding-failure.ts | memory/embedding-failure.ts | 152→170 | rename（deferred/embedding-failure.ts） | D8/N1 例外归位：纯分类零依赖，无 import 可改写 |
| 5 | features/magic-context/memory/promotion.ts | memory/promotion.ts | 145→119 | **新移植**（deferred 无缝） | D13 核心。删 `embedPromotedFacts`+`embedAndStoreMemory`（上游 :96-145，N1 终局不做 embedding 运行时）；同步删 4 个失效 import：`embedTextForProject`、`saveEmbeddingIfHashMatches`、`sessionLog`、`getMemoryById`（后两者唯一调用点在删除段内）。FORK-NOTE 逐项登记 |
| 6 | features/magic-context/memory/normalize-hash.ts | memory/normalize-hash.ts | 13→22 | 新移植 | 零依赖（node:crypto），无差异 |
| 7 | features/magic-context/memory/visibility.ts | memory/visibility.ts | 7→15 | 新移植 | FOREIGN_VISIBLE_SQL 单常量，无差异 |
| 8 | features/magic-context/memory/embedding-cache.ts | memory/embedding-cache.ts | 89→102 | 新移植 | 进程内 TTL map + 纯 sqlite 读；无 provider，不违反依赖排除令 |
| 9 | features/magic-context/memory/storage-memory-embeddings.ts | memory/storage-memory-embeddings.ts | 218→232 | 新移植 | 纯 sqlite（memory_embeddings blob 读写/coverage）；无向量计算面 |
| 10 | features/magic-context/mural/storage-mural-cues.ts | mural/storage-mural-cues.ts | 183→207 | 新移植（提前于 mural 波次：storage-memory 的 import 闭包项） | **1 行类型适配**：上游 `prepare<number,R>` 标量首参 → fork `prepare<[number],R>`（better-sqlite3 的 BindParameters 须 tuple）；运行时语句不变，FORK-NOTE 登记 |
| 11 | features/magic-context/memory/storage-memory-fts.ts | memory/storage-memory-fts.ts | 207→219 | 新移植 | sanitizeFtsQuery/relaxedFtsQuery + bm25 关键词检索；无向量路径；Step 10 ctx_search 复用本层 |

非搬运的改动文件：

| 文件 | 改动 | 说明 |
|---|---|---|
| hooks/magic-context/compartment-runner-incremental.ts | +93/-3 | D13：头部「promotion 缺席」登记改写；恢复 promoteSessionFactsDurable 调用（in-transaction、events 前）；gate 计算（discardedLast/weak-lookahead/memoryEnabled/autoPromote）；identity 用 fork 的 `resolveProjectIdentityForSession`（不抛错，与 transform.ts:1869 同款；上游 `resolveProjectIdentity` 会抛且 fork runner deps 无 allowHomeProject 旋钮）；ModuleMemoryAuthorityError 分支逐字保留；不移植上游 post-commit embed 调度段（N1）与 historian_runs telemetry（fork 无对应 FK） |
| hooks/magic-context/inject-compartments.ts | 3 处 import | memory-selection / storage-memory / storage-user-memory 改指真身（四处 `.sort()` 与 safeGetActiveUserMemories 随之闭合） |
| hooks/magic-context/m0-token-breakdown.ts:1 | 1 处 import | getMemoriesByProject 改指真身 |
| hooks/magic-context/format-embed-failure.ts:1 | 1 处 import | EmbeddingFailure 改指真身 |
| core/shared/user-facing-codes.ts | 注释 | embedding-failure 已归位，「Batch2 不搬」缝头作废；本地 union 副本保留（`core/shared/**` 不得反向 import `core/features/**`，仓内零先例），改 FORK-NOTE 登记理由 |
| scripts/test-memory-promotion.mjs | 新增 | T-MC0/T-MC0b/T-MC1/T-MC1b（见下） |
| package.json（magic-context） | +2 行 | test:memory-promotion 脚本 + 挂入 test:all |

## import 闭包核对（为什么只有这些文件）

- storage-memory.ts ← ../mural/storage-mural-cues、./constants（既有）、./embedding-cache、./normalize-hash、./types（既有）、./visibility：闭包内全部本批落位。
- promotion.ts ← ./constants、./normalize-hash、./storage-memory、./types（既有）：闭合。
- storage-memory-fts.ts ← ./storage-memory、./types：闭合。
- embedding-cache.ts ← ./storage-memory-embeddings：闭合。
- runner ← memory/promotion、memory/project-identity（既有）、memory/storage-memory：闭合。
- mural/storage-mural-cues ← core/shared/sqlite（既有）：闭合。
- **cosine-similarity 不搬**（不在任何闭包内，N1 终局不做）。
- memory/index.ts barrel：未建（Step 15 职责）；runner 直接 import 文件路径，已在 C3 commit message/FORK-NOTE 说明。

## 逐字一致性验证（落盘后机械比对，脚本化核对）

对 11 个搬运文件做「去 FORK-NOTE 头 + 去相对 import 的 `.js` 后缀」后与上游逐字节比对：

- **9/9 逐字一致**：storage-memory、memory-selection、embedding-failure、storage-user-memory、
  normalize-hash、visibility、embedding-cache、storage-memory-embeddings、storage-memory-fts
  —— 相对上游零改写，仅有 CRLF→LF（仓内 eol=lf 强制）与 `.js` 后缀（NodeNext）两处机械变换。
- storage-mural-cues.ts：**恰好 1 行差异**= 已登记的 `prepare<number,R>`→`prepare<[number],R>` 类型适配（@172）。
- promotion.ts：**143 行差异全部来自纯删除**——子序列校验通过（fork 正文是上游正文的保序纯删除子序列，
  无任何改写/新增行）：删 4 个 import 行 + 上游 :96-145 的 `embedPromotedFacts`/`embedAndStoreMemory`（50 行，
  含其文档注释）；145 - 4 - 50 = 91 = fork 正文行数，行数吻合。

## 验证记录（Node 24 便携版 .tools/node-v24.14.0-win-x64 实测）

| 命令 | 结果 |
|---|---|
| `tsc --noEmit`（magic-context 包） | TYPECHECK_OK |
| `pnpm --dir apps/zcode-cli/packages/magic-context test:all` | 全绿：smoke 36 checks/0 失败；config 10/10；host 30/30；**transform 38 cases/0 失败（回归基线）**；historian 18/18；ctx-tools 20/20；**memory-promotion 4/4**；boot-busy-retry 7/7 |
| `oxfmt --check`（apps/zcode-cli 版，scripts+package.json） | 零新增（新脚本经一次 --write 后复检通过） |
| `oxfmt --check`（根版） | 不适用：根 .prettierignore 排除 apps/zcode-cli/ |
| `pnpm --dir apps/zcode-cli run typecheck`（turbo 全工作区） | **27 successful, 27 total**（含并行节点在途改动的全树编译） |
| `node scripts/architecture/architecture-check.mjs check --changed` | OK / violations: 0 / new: 0 |
| 9 文件逐字比对 + promotion 子序列校验 + mural-cues 单行适配核对 | 全部符合登记（见上节） |

## 观察项 / 遗留登记（不阻塞本节点）

1. **lint 门对本区不生效（既有形态，非本节点新增）**：根 `.oxlintrc.json` ignorePatterns 含 `apps/zcode-cli`，magic-context 包自身 `lint`（oxlint src）实际上「0 files / exit 1」。若改用根规则集抽检，既有文件 inject-compartments.ts(3274 行)/migrations.ts(2821)/storage-db.ts(2257)/project-identity.ts(915) 全部触发 max-lines(400) —— verbatim 移植区长文件是仓内既有形态（.oxfmtrc.json 已对 `packages/magic-context/src/core/**` 排除格式化即同款处理）。建议 Step 19 门禁整治时给该区配 oxlint override（与 oxfmt 排除对齐），本节点不动共享配置。
2. storage-memory.ts:404 `new Array(idCount)` 触发 no-new-array warning（上游逐字码，全 fork 仅此一处）。保持逐字不改（FORK 纪律「diff 逐行对照上游」优先；该 warning 在排除区不进门禁）。如需治理见上条 override。
3. `user-facing-codes.ts` 保留本地 `EmbeddingFailureClass` 副本（shared 不得反向 import features）。防漂移靠逐字一致；如需强约束可在后续加一条类型相等断言测试。
4. m0 全链（system-prompt 装配）注入断言待 Step 13；本包测试只锁注入面公共函数（renderMemoryBlockV2 / computeM0BlockTokens / trimMemoriesToBudgetV2 / getMemoriesByProject）。
5. D14（ctx_memory）与 Step 10（ctx_search）未接：`insertMemoryIdempotent` 与 `sanitizeFtsQuery`/`relaxedFtsQuery` 已就位待用；`storage-memory-embeddings.ts` 的写入面（saveEmbedding 等）暂无调用方（N1 终局不做向量），knip 可能报未用导出——Step 19 knip 门禁需按「magic-context verbatim 区既有多导出」基线处理。
