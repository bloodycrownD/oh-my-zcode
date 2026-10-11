---
date: 2026-10-06
node: impl-s1-gates-prep
worktree: D:\Dev\worktree\official-endpoints-removal (feat/official-endpoints-removal, base ba7c240)
---

# 测试名单快照（Step 1 — phase-gates-prep）

**用途**：T-R1（Step 12 全量回归）判据以本名单为准，**不是数字口径**——名单随 S9（删 `mkt-alias` 测试）更新。
**枚举口径**：worktree 内全部 `package.json` 的 `scripts` 中以 `test` 开头的条目（根 package.json 与 `apps/zcode-cli/package.json` 均**无** test 接线）。
**枚举方式**：`git ls-files '*package.json'` 遍历 33 个 package.json 的 scripts 字段；脚本实体以 `git ls-files '*scripts/test*'` 交叉核对。

---

## 一、package.json 已接线的 test 脚本（13 条）

| # | package.json 路径 | 包名 | 脚本名 | 命令 |
|---|---|---|---|---|
| 1 | `apps/zcode-cli/packages/magic-context/package.json` | `@zcode/magic-context` | `test` | `node scripts/test-config.mjs` |
| 2 | `apps/zcode-cli/packages/magic-context/package.json` | `@zcode/magic-context` | `test:host` | `node scripts/test-host.mjs` |
| 3 | `apps/zcode-cli/packages/magic-context/package.json` | `@zcode/magic-context` | `test:transform` | `node scripts/test-transform.mjs` |
| 4 | `apps/zcode-cli/packages/magic-context/package.json` | `@zcode/magic-context` | `test:historian` | `node scripts/test-historian.mjs` |
| 5 | `apps/zcode-cli/packages/magic-context/package.json` | `@zcode/magic-context` | `test:ctx-tools` | `node scripts/test-ctx-tools.mjs` |
| 6 | `apps/zcode-cli/packages/magic-context/package.json` | `@zcode/magic-context` | `test:all` | `npm run build && npm run smoke && npm run test && npm run test:host && npm run test:transform && npm run test:historian && npm run test:ctx-tools`（**聚合脚本**，内含 `smoke` = `node scripts/smoke-storage.mjs`） |
| 7 | `apps/zcode-cli/packages/bootstrap/package.json` | — | `test:magic-context` | `node --test scripts/test-magic-context-turn-transform.mjs` |
| 8 | `apps/zcode-cli/packages/bootstrap/package.json` | — | `test:magic-context-historian` | `node --test scripts/test-magic-context-historian.mjs` |
| 9 | `apps/zcode-cli/packages/bootstrap/package.json` | — | `test:magic-context-config-rpc` | `node scripts/test-magic-context-config-rpc.mjs` |
| 10 | `apps/zcode-cli/packages/bootstrap/package.json` | — | `test:magic-context-usage` | `node --test scripts/test-magic-context-usage-projection.mjs` |
| 11 | `apps/zcode-cli/packages/adapters/package.json` | — | `test:magic-context-domain` | `node scripts/test-magic-context-domain.mjs` |
| 12 | `apps/zcode-cli/packages/adapters/package.json` | — | `test:plugin-marketplace-official-alias` | `node scripts/test-plugin-marketplace-official-alias.mjs` |
| 13 | `apps/zcode-cli/packages/cli/package.json` | `@zcode/cli` | `test:ctx-commands` | `node --import tsx scripts/test-ctx-commands.mjs` |

**分组小计**：magic-context 6 + bootstrap 4 + adapters 2 + cli 1 = **13**，与 spec Step 1 预期一致。

**跑法**：逐条在对应包目录执行 `pnpm run <脚本名>`。注意第 6 条 `test:all` 已内含 1–5 与 `smoke`，重复跑 1–5 属同义验证；S12 全量回归时按聚合跑即可，但 1–5 / 7–13 的**单条退出码**仍需在改动波及对应包时单独可见（便于定位失败归属）。

---

## 二、未接线但存在的 test 脚本（7 条，直接 node 跑）

以下脚本文件在 git 中存在，但**任何 package.json 均未接线**，需手动 `node <脚本>` 运行。上游文档 `UPSTREAM-SYNC.md:101` 的历史口径将其中 `test-feature-flag` 与 `test-sidecar-model-request` 计入「15 个脚本」，S11 文档收口时改为本名单口径。

| # | 脚本路径 | 归属包 | 直接运行命令 |
|---|---|---|---|
| 1 | `apps/zcode-cli/packages/adapters/scripts/test-feature-flag.mjs` | adapters | `node scripts/test-feature-flag.mjs` |
| 2 | `apps/zcode-cli/packages/core/scripts/test-sidecar-model-request.mjs` | core | `node scripts/test-sidecar-model-request.mjs` |
| 3 | `apps/zcode-cli/packages/contracts/scripts/test-rewind-strategy.mjs` | contracts | `node scripts/test-rewind-strategy.mjs` |
| 4 | `apps/zcode-cli/packages/contracts/scripts/test-saved-workflow-scope-dirs.mjs` | contracts | `node scripts/test-saved-workflow-scope-dirs.mjs` |
| 5 | `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-lifecycle.mjs` | bootstrap | `node scripts/test-magic-context-lifecycle.mjs` |
| 6 | `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-ui-config.mjs` | bootstrap | `node scripts/test-magic-context-ui-config.mjs` |
| 7 | `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-ui-model-picker.mjs` | bootstrap | `node scripts/test-magic-context-ui-model-picker.mjs` |

**注意事项**：
- 5 / 6 / 7 跑 `packages/ui` 的 **dist 产物**（`test-magic-context-ui-config.mjs:12` 明确记载「跑 packages/ui 的 dist 产物」纪律），故须先 `pnpm --filter @zcode/ui build`，否则失败原因与本迭代改动无关。
- 2 / 3 / 4 涉及 core / contracts，属 D-12 旧会话容错与 contracts 契约面，S3 / S10 改动后需重跑。

---

## 三、S9 之后的名单变更预案

S9（phase-marketplace）删除 `apps/zcode-cli/packages/adapters/scripts/test-plugin-marketplace-official-alias.mjs` 及其接线（清单第 12 条），届时第一节降为 **12 条**，第二节升为 **8 条**。UPSTREAM-SYNC.md §4 与 CHANGELOG 的测试族表述需同步（S11 执行）。

---

## 四、不属于本名单的门禁

八门禁中的 typecheck / turbo / typecheck:desktop-full / lint / knip / oxfmt / licenses.mjs check / architecture:check 是 `package.json` 的非 test 脚本或 CLI 命令，不计入本测试名单；desktop baseline 见 `cache/desktop-baseline-v0.1.1.txt`。