# Step 9 T 用例接线登记表（upstream-v3.15.1-backport）

本表由 Step 9（phase-tests）交付，Step 10 门禁 9 按本表逐条核对「脚本存在 + 已接线 + 实跑通过」。

- 生成时间：2026-10-11
- 接线入口：根 `package.json` → `test:v4-perf`（下列「接线」列写明链上的具体位置）
- 计数基线：接线前 `test:v4-perf` = 236 pass；接线后 = **309 pass / 0 fail**（新增 73 例）

## 1. T 用例登记

| 编号 | 脚本路径 | 所在包 | 接线入口 | 断言/用例数 | 实跑结果 |
|---|---|---|---|---|---|
| T-NET-1 / T-NET-1b / T-NET-2 | `apps/zcode-cli/packages/adapters/scripts/test-network-status-crash.mjs` | @zcode/adapters | `test:v4-perf` → `... @zcode/adapters run test:network-status-crash`（build 之后） | 5 | pass |
| T-XFRM-1 | `apps/zcode-cli/packages/adapters/scripts/test-tool-result-cache-control.mjs` | @zcode/adapters | `test:v4-perf` → `... run test:tool-result-cache-control` | 3 | pass |
| T-MC-1（C3 转正） | `apps/zcode-cli/packages/adapters/scripts/test-magic-context-boundaries.mjs` | @zcode/adapters | `test:v4-perf` → `... run test:magic-context-boundaries` | 10（17 断言） | pass |
| T-PROC-1 | `packages/services/test/zcodeProtocolClientDispose.test.ts` | @zcode/services | `test:v4-perf` 首个 `tsx --test` 组 | 2 | pass |
| T-PROC-2 | `packages/services/test/zcodeStdioTransportFraming.test.ts` | @zcode/services | 同上 | 1 | pass |
| T-PROC-3 | `packages/services/test/zcodeAgentProcessManagerCleanup.test.ts` | @zcode/services | 同上 | 3 | pass |
| T-SVC-1 | `packages/services/test/zcodeTaskServiceAdapterStreamFallback.test.ts` | @zcode/services | 同上 | 3 | pass |
| T-SVC-3 | `packages/services/test/subagentsServiceIoErrors.test.ts` | @zcode/services | 同上 | 4 | pass |
| T-WIN-1（C2 口径） | `packages/services/test/runtimeProcessEnvShell.test.ts` | @zcode/services | 同上 | 3 | pass |
| T-SVC-2 | `packages/shared/test/sessionContentProfileIndex.test.ts` | @zcode/shared | 同上 | 4 | pass |
| T-EVICT-1 | `packages/shared/test/workflowRunsSeatBorn.test.ts` | @zcode/shared | 同上 | 6 | pass |
| T-WIN-3 | `packages/desktop/scripts/test-window-close-tray.mjs` | @zcode/desktop | 同上（electron 由 resolve 钩子替身加载） | 5 | pass |
| T-DWF-1 | `apps/zcode-cli/packages/dynamic-workflow/scripts/test-scheduler-recorded-asks.mjs` | @zcode/dynamic-workflow | 同上（该包无聚合入口，按 spec 手工枚举进根清单） | 3 | pass |
| T-EVT-1 | `apps/zcode-cli/packages/core/scripts/test-session-persistence-dedupe.mjs` | @zcode/core | `test:v4-perf` → `... @zcode/core run test:session-persistence-dedupe` | 2 | pass |
| #12 回归（T 覆盖说明点名，非 T 编号） | `apps/zcode-cli/packages/core/scripts/test-subagent-cache-breakpoints.mjs` | @zcode/core | `test:v4-perf` → `... run test:subagent-cache-breakpoints` | 4 | pass |
| T-MEM-2 | `apps/zcode-cli/packages/core/scripts/test-tool-media-stop-signal.mjs` | @zcode/core | `test:v4-perf` → `... run test:tool-media-stop-signal` | 3 | pass |
| T-MEM-1 | `apps/zcode-cli/packages/bootstrap/scripts/test-model-request-slim.mjs` | @zcode/bootstrap | `test:v4-perf` → `... run test:model-request-slim` | 4 | pass |
| T-DWF-2 / T-DWF-3 | `apps/zcode-cli/packages/bootstrap/scripts/test-dwf-read-narrowing.mjs` | @zcode/bootstrap | `test:v4-perf` → `... run test:dwf-read-narrowing` | 3 | pass |
| C1（#26 钳位） | `apps/zcode-cli/packages/bootstrap/scripts/test-publisher-buffer-clamp.mjs` | @zcode/bootstrap | `test:v4-perf` → `... run test:publisher-buffer-clamp` | 5（8 断言） | pass |

## 2. 不接线 / 手工项（spec 允许的登记口径）

| 编号 | 处置 | 说明 |
|---|---|---|
| T-WIN-2 | **不接线**（spec 定为 manual_user） | 需要真实注册表深链 + 打包态 fuse 验证（`--inspect-brk` 被拒），Step 10 手工实跑并在门禁记录中留痕。 |
| T-X1 | **不接线**（= §5 全门禁清单） | 由 Step 10 逐条实跑，无独立脚本。 |

## 3. 顺带回归（非本表 T 用例，Step 9 实跑确认）

| 套件 | 基线 | Step 9 实跑 |
|---|---|---|
| `packages/services/test/*.test.ts`（含本次新增 6 文件） | 40 | 56 pass / 0 fail |
| core `test:magic-context-prompt-section` | 10 | 10 pass / 0 fail |
| magic-context `pnpm run test:all` | 142 | 142 pass / 0 fail |
| 根 `pnpm lint`（排除 `.reference/**`） | 74w / 0e | 74w / 0e（新增文件零告警） |
| `packages/shared/tsconfig.test.json`（新 shared 测试的类型工程） | - | 0 err |
