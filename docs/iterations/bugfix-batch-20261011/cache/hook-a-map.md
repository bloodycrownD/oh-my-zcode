# hook-a-map — Step 16（D9/D10 缝收口 + 两壳删除）证据包

- commit: `a5618a3b` `[bugfix-batch-20261011/Step 16]`（12 files, +513/−287）
- 分支: `bugfix-batch-20261011`（HEAD 前为 e81dc870 Step 14）
- 执行时 Step 15 mural、Step 18 测试闭合并行在跑；禁触清单执行情况见末节。
- 提交纪律备注：首次 commit（6eac0468）用 `git commit -F msg -- <paths>`，git 的 pathspec 语义取**工作区**内容，把 mural 对 `src/index.ts` 的两个并行 hunk（4e mural barrel 段 + magic-context-prompt 单行化，+51 行）一并夹带；已 `reset --soft` 撤销，改用**临时 index**（`GIT_INDEX_FILE` + `read-tree HEAD` + `git apply --cached` 我的 hunk patch + 精确 `git add`/`git rm --cached` + `commit-tree`/`update-ref`）重做为 a5618a3b——真实 index 未动，mural 全部 staged 状态原样保留。

## D9 event-resolvers（r4 P1-1：引用子集壳 → 补真身）

- `git mv`：`src/core/deferred/event-resolvers.ts` → `src/core/hooks/magic-context/event-resolvers.ts`（git 识别 rename，71% 相似）
- 内容整体替换为上游真身 `.reference/magic-context/packages/plugin/src/hooks/magic-context/event-resolvers.ts`（550 行）；被调用函数体逐字取上游（壳内为压缩摘录，注释/行号标注更粗）
- 裁剪（fork 引用面，不复活）：`resolveContextLimit`、`resolveCacheTtl`、`resolveSessionId`；连带删 `resolveModelCacheTtl` import 与 `CacheTtlConfig`
- 引用改指（r5 P2-3 清单）：
  - `transform.ts:96-103` → `./event-resolvers.js`
  - `scheduler.ts:19`（+ 头注 :8-11）→ `../../hooks/magic-context/event-resolvers.js`
  - `lkg-replay-fit.ts:3` → `./event-resolvers.js`
  - barrel `src/index.ts:162-165`、`:301` → `./core/hooks/magic-context/event-resolvers.js`
- barrel 改指以 hunk 级 patch（`.tmp-hooka-index.patch`，仅两处）入 index，避免夹带 mural 对 index.ts 的并行改动（4e mural barrel 段 + magic-context-prompt 单行化留工作区）

## D10 ctx-reduce-availability（r4 P1-1 + r5 P2-1/P2-6）

- `git mv` → `src/core/hooks/magic-context/ctx-reduce-availability.ts`（上游 569 行）
- 逐字保留：`verdictFromToolsMap` / `unfrozenVerdict` / `resolveToolAvailabilityFromMessages` / 冻结与 `availabilityBySession` / spawn 权限预热链 / `spawnAgentFromMessages` / `cachedToolPermissionDenied` / 日志去重对
- THROW 臂 → `return false`（r5 P2-6）：ZCode 无 OpenCode `app.agents()`/`session.get()` 权限 API；ctx_reduce 可调用真值判定已在宿主侧（core `magic-context-prompt-section.ts:89` 真工具表 `runtime.getTools` + `runtime-tools.ts:132` `resolveRuntimeDisallowedToolsWithMagicContext`，Step 13 落地）；与 `transform-postprocess-phase.ts:344-349`（todowrite）、`:2048-2062`（ctx_reduce）既有 try/catch fail-open 对齐，「保留旧裁决」语义不变
- 裁剪：`resolveToolAvailability` 家族（DB 臂）、`setCtxReduceRegisteredGlobally`/`resetCtxReduceRegisteredGloballyForTest`、`spawnAgentFromOpenCodeDb`、`ctxReduceSpawnPermissionReadNeeded`、`clearTool*`、OpenCode 权限规则求值助手（`permissionRules`/`permissionDisabled`/`PermissionRule` 等）
- 引用改指：`transform.ts:79-86`、`transform-postprocess-phase.ts:89-99` → `./ctx-reduce-availability.js`（r5 P2-1 勘误：:92/99 属 D10 面）

## magic-context-schema / project-security 两壳删除（r4 P0-2）

- `deriveDefaultProtectedTokens`：先落类型再改指。**落点勘误**：spec 原文与 r4 P0-2 说 `host/config/schema.ts`，实际落 `src/core/shared/protected-tokens.ts`。理由：① core→host 依赖方向与包内既有方向（host→core，schema.ts→prompt-surface.js）相反；② Step 18 的 `scripts/test-transform.mjs` staging 只 copy `src/core/**` 且注释明示排除 host sibling layer，core→host import 会让其运行期 ERR_MODULE_NOT_FOUND，且该测试属并行禁触面；③ r4 P0-2「先落类型再改指」意图等价满足。HEAD~ 曾短暂落 host 后 revert；FORK-NOTE 与 commit 均已登记，待 Step 19/spec-check 收口
- `storage-meta-persisted.ts:11` 改指 `../../shared/protected-tokens.js`
- `ProtectedTokensTierOverrides` 按 spec 内联两使用处：`storage-meta-persisted.ts`（本地 alias + 注释）、`transform.ts`（本地 alias + 注释）；type 与上游逐字一致（readonly user?/project?）
- 删壳：`git rm` magic-context-schema.ts（31 行）、project-security.ts（14 行）
- user-facing-codes / embedding-failure：Step 8（944b4967）已闭合，本步零动作（r5 P1-1）

## 验证实跑

| 项 | 结果 |
|---|---|
| magic-context test:config / host / ctx-tools / historian / memory-promotion / boot-busy-retry / smoke-storage | 全过 |
| test:transform（38 基线） | 被 Step 15 并行半成品阻断（错误栈 `out/features/magic-context/memory/host/harness.js imported from memory/index.js`——untracked 的 memory/index.ts 是 src 根副本，路径基准错位） |
| test:ctx-search-memory / test-prompt-surface | 被 mural 半成品阻断（`mural/render-trigger.js` import `./resolve-mural` 缺 `.js` 扩展名，dist 未产出 resolve-mural.js） |
| 隔离复刻验证 `.tmp-hooka-s16-verify.mjs`（复刻 s18 staging + 临时剔除 memory/index.ts，不动工作区） | 13/13 全过：resolveExecuteThreshold 65/95→90、resolveModelKey、resolveTrustedContextLimit、deriveDefaultProtectedTokens 100k→8000 / 200k→16000 / 1M→50000、ctx fail-open frozen、tools-map frozen、wildcard-deny filtered、resolveToolPermissionDenied=false、todowritePermissionDenied=false、spawnAgentFromMessages |
| typecheck（apps/zcode-cli tsc --noEmit） | 72 err 现存：71 属并行产物（memory/index.ts 57 + mural/resolve-mural 2 + compartment-runner-incremental.ts:64 引用半成品 barrel 1 + 其它），改动面 0 错 |
| architecture:check --changed | OK，violations 0 / baseline 0 / new 0 |
| oxfmt | `src/index.ts`、`src/host/config/schema.ts` clean（apps/zcode-cli 自带 oxfmt 单跑）；core/** 被 `apps/zcode-cli/.oxfmtrc.json` ignorePatterns 显式排除（逐字区保真，不参与格式化） |
| workspace freshness | ahead 18 / behind 0（阈值 50） |

## 冲突/缺口登记（给 Step 17/18/19）

1. **memory/index.ts 半成品**（untracked，mural/Step 15 面）：当前是 `src/index.ts` 的逐行副本放在 `src/core/features/magic-context/memory/`，全部 `./core/...`/`./host/...` 引用基准错位（57 个 TS2307）；`compartment-runner-incremental.ts:64` 经它 import `promoteSessionFactsDurable` 报 TS2305。禁触未动。Step 15 完成后其 test:all / typecheck 才能全绿。
2. **mural/render-trigger.ts:59** import `./resolve-mural` 缺 `.js` 扩展名（TS2835），dist 少 resolve-mural.js，连带阻断 test-ctx-search-memory / test-prompt-surface / test:transform 的 dist 链。禁触未动。
3. **根 oxfmt --check 全仓报 1133 files list-different**（既有现象，与本次改动无关——我的文件均不在列表）；由 Step 19 门禁口径复核。
4. **spec 勘误待收口**：Step 16 原文「deriveDefaultProtectedTokens 搬入 host/config/schema.ts」与实际落点 `core/shared/protected-tokens.ts` 的偏差，已在 protected-tokens.ts 头注 + commit 正文登记。
5. transform.ts 禁触说明：D9/D10 引用改指必须动 `src/core/hooks/magic-context/transform.ts`（spec/工作流显式清单），该文件在禁触列表但实测 mtime 早于 mural 并行改动 3.5 小时（mural 未持有），改动仅两处纯 import 行 1:1 + 1 个本地 type 内联；已按 spec 显式范围执行并在此登记。

## 并行禁触清单执行

- mural/**、deferred/render-trigger.ts、contracts RuntimeAttachmentEntry、bootstrap magic-context-turn-transform.ts、memory/index.ts barrel：零改动
- scripts/test-* 新建、user-facing-codes.ts、i18n locales：零改动（Step 8 已闭合项未重做）
- 隔离验证脚本 `.tmp-hooka-s16-verify.mjs` 不落 scripts/、非 test-* 命名，一次性使用后随其它 .tmp 清理
