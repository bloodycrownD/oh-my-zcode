# 证据包 — magic-context 前台 settle 按「进程是否随轮退出」条件化

| 项 | 值 |
|---|---|
| 生成节点 | impl-settle |
| spec | `docs/iterations/bugfix-batch-20261011/spec.md`（Step 1-3，phase-mc-settle-bg，缺陷①） |
| head_sha（本包生成时） | `cfaf198e010d1daab20ef3cf1022def728985ccd` |
| 分支 | `bugfix-batch-20261011` |
| 日期 | 2026-10-11 |

> 本文件是 impl-settle 节点的证据落盘：记录 settle 调用链**改动前**的现状、本节点改了哪些
> 锚点、单测如何按形态分化、以及实跑验证结果。行号以 head_sha 为准；spec「现状约束
> / settle/进程形态约束」节是权威锚点，本文只做改动面索引，不复制其论证。

## 1. settle 调用链现状（改动前）

```
core turn-loop（每个 model step 都过一次；turn-loop.ts:119 在 while(true) 内）
  └── runMagicContextTurnTransform(...)                       ← core 侧，本批零改动
        └── MagicContextTurnTransform 端口（bootstrap 装配层）
              ├─ ① settleInFlightHistorian(sessionId)
              │     bootstrap/src/app/magic-context-turn-transform.ts :1605-1609（改前）
              │     定义 :1433-1452（改前）；读 getActiveCompartmentRun(sessionId)
              │     → Promise.race([active.promise, 60s 定时器])
              │     **无端口开关**：端口实现内无条件 await
              └─ ② settleScheduledPass()（端口钩子）
                    bootstrap/src/app/magic-context-turn-transform.ts :1628-1636（改前）
                    钩子在 :1264-1276（改前）装配，实参 =
                    drainHistorianSchedulerWithTimeout(scheduler, 60_000)（常量 :1431）
```

两条 settle 串行、都发生在 transform 成功之后：N-step turn 的前台阻塞上界
= N ×（60s + 60s）。core 侧零 `@zcode/magic-context` import，`core/src/runtime/
helpers/magic-context-turn-transform.ts` 文件头明示「刻意不在 core 的 turn-loop 上
挂点」——改 core 是 fork 纪律禁区，因此条件化只能落 bootstrap 端口层。

入口形态（改前无显式声明，端口侧隐式按「一进程一轮」处理）：

| 入口 | 文件 | 进程形态 |
|---|---|---|
| app-server（stdio 协议宿主，Electron 拉起） | `bootstrap/src/zcode-protocol-entrypoint.ts` :186-218 | 长驻 |
| TUI | `cli/src/tui-prompt-handler.ts` :141-160 | 长驻 |
| print（`-p`） | `cli/src/prompt-command.ts` :182 | 一次性 |

## 2. 本节点改动的锚点（改后行号 = head_sha）

### Step 1 — 形态透传（commit `67a48e96`）

| 文件 | 行 | 改动 |
|---|---|---|
| `bootstrap/src/app/types.ts` | 129-148 | `ZCodeAppOptions` 新增 `processExitsAfterTurn?: boolean`（判据文档：进程生命周期，不是「是否桌面」） |
| `bootstrap/src/app/magic-context-turn-transform.ts` | 203-226 | `MagicContextTurnTransformOptions` 新增同名字段，缺省 `true` = 保守 |
| `bootstrap/src/app/create-app.ts` | 885-890 | 透传 `processExitsAfterTurn: options.processExitsAfterTurn ?? true` 进 transform options |
| `bootstrap/src/zcode-protocol-entrypoint.ts` | 216-221 | 显式 `processExitsAfterTurn: false`（`sourceTitle:"electron"` 先例同侧） |
| `cli/src/tui-prompt-handler.ts` | 144-149 | 显式 `processExitsAfterTurn: false` |
| `cli/src/prompt-command.ts` | 186-191 | 显式 `processExitsAfterTurn: true`（一次性进程，行为不变） |

### Step 2 — 端口层条件化两处 settle（commit `2255ac5b`）

| 文件 | 行 | 改动 |
|---|---|---|
| `magic-context-turn-transform.ts` 文件头 | 32-46 | `hostProcessLifetime` 行补「保持不动」指向；新增「settle 形态」交接表行 |
| 同上（`createMagicContextTurnTransform`） | 1282-1310 | `settleScheduledPass` 装配处：FORK 注释登记「钩子无条件装配、判据只在端口」+ `in_flight` no-fire 为长驻形态**预期行为**（不得当故障修） |
| 同上（`buildTransformDeps`） | 1405-1424 | `hostProcessLifetime` 保持硬编码，FORK 注释登记两条理由（per-session 重引入 usage 全灭回归 T-M2/T-M3/T-M6；新增枚举属包内 transform.ts S20 特权区） |
| 同上（`HISTORIAN_SETTLE_TIMEOUT_MS` 注释） | 1455-1484 | 「一进程=一轮」论证按两形态改写 |
| 同上（新增函数） | 1525-1548 | `settleInFlightHistorianInBackground`：长驻专用，`void` 丢出 + 完成/失败记账日志，保留内部 60s 上界与 `timer.unref()` 防泄漏 |
| 同上（端口工厂） | 1544-1558 / 1617-1618 / 1726-1735 / 1755-1767 | 端口 options Pick 扩 `processExitsAfterTurn`；`settlesInForeground` 一次求值；两处 settle 按同判据条件化；`settleScheduledPass` 形参注释补形态条件说明 |

**形态决策记录**（spec 授权的「二选一」）：`settleScheduledPass` 选「端口门 + 钩子无条件
装配」，而非「长驻不装配」。理由：判据只有一处（端口是唯一阻塞决策点），装配保持单一
形态；端口层的单测因此能用假钩子直接证明「不被调用」。若改成不装配，将来只改一处的
午后就会静默分叉（装配说不等、端口还在等）。

## 3. 单测分化结果（Step 3，commit `cfaf198e`）

`scripts/test-magic-context-turn-transform.mjs`（改后 23 用例，改前 20）——既有顺序
断言按形态分化，**不删原语义**：

| 用例 | 形态 | 断言 |
|---|---|---|
| 短驻形态：调度器那次 pass …有界 settle（MF-04） | `processExitsAfterTurn: true` | `[transform, notify, settle:start, settle:end]`（原断言逐字保留） |
| 形态缺省 = 短驻：不声明时顺序断言逐字不变 | 不传该字段 | 同上（钉死保守缺省值） |
| 长驻形态：调度器那次 pass 不等 settle，钩子根本不被调用 | `false` | `[transform, notify]` + 钩子调用计数为 0 |
| settle 抛错不影响这一轮请求 | `true` | `outcome==="unchanged"`（原断言保留） |
| 长驻形态：settle 钩子压根不被调用… | `false` | `outcome==="unchanged"` + 钩子调用计数为空 |

`scripts/test-settle-background.mjs`（新增，4 用例，挂 `test:settle-background`）：

| 用例 | 覆盖 |
|---|---|
| 长驻形态：model step 不等两处 settle，端口返回时在飞的 historian 仍在跑（T-S1） | 真 compartment run 在场：顺序 `[transform, notify]`、settle 钩子未调用、端口 <100ms 返回、`getActiveCompartmentRun()` 此刻非空（drain/execution 不被拖住的直接证据）；放行 run 后后台 promise 落定、run 表清空、留下 `magic_context.settle_background_settled` 记账日志 |
| 短驻形态（对照组） | 顺序 `[transform, notify, settle:start, settle:end]`、elapsed ≥ run 时长、返回时 run 已落定（证明「不等」有区分力） |
| MF-05 drain 收口：close 钩子把在飞的折叠 pass 等完再停机（T-S2 契约） | 真 `createHistorianScheduler` + 复刻装配处 close 钩子：drain 等 pass 落定 → shutdown → 之后触发记 `shutdown` no-fire |
| 长驻形态下 registerClose 钩子仍在场，close() 跑通 drain→shutdown→dispose | 真工厂 + 临时库驱动一次真 turn；`registerClose` 恰好注册 1 次且可调用完成 |

隔离：新测试文件在 import 任何被测模块**之前**把 `MAGIC_CONTEXT_DB_DIR` /
`MAGIC_CONTEXT_LOG_PATH` 指到 `os.tmpdir()` 一次性目录；绝不写真实 `~/.omz` /
`~/.zcode`。退出时目录删除为尽力而为（真工厂开的 SQLite 句柄在进程退出前不释放，
Windows 上可能 EPERM；清理失败不影响用例结论，文件头已登记）。

## 4. 实跑验证（便携 Node 24.14.0）

| 命令 | 结果 |
|---|---|
| `node --test scripts/test-magic-context-turn-transform.mjs scripts/test-settle-background.mjs scripts/test-magic-context-historian.mjs scripts/test-magic-context-absent-event.mjs scripts/test-magic-context-usage-projection.mjs` | tests 56 / pass 56 / fail 0 |
| `node scripts/test-magic-context-config-rpc.mjs`（同工厂消费者，回归） | `TEST PASS — workspace/updateMagicContextConfig handler + T-M8 gate` |
| `pnpm --dir apps/zcode-cli run typecheck` | `Tasks: 27 successful, 27 total`（Step 1/2/3 各跑一次，均 0 error TS） |
| `oxfmt --check`（本节点 9 个改动/新增文件） | `All matched files use the correct format` |

已知既有抖动（非本节点引入）：`test-magic-context-turn-transform.mjs` 的
`mc/BG-1` 用例断言 `passDurationMs >= 20ms`（对一个 `setTimeout(20)` 的挂钟测量），
偶发 19.82ms 失败；复跑即过（20/20）。未修改该用例。

## 5. 环境备注（非代码改动，供后续节点参考）

本仓曾位于 `D:\Dev\Js\oh-my-zcode\omz\...`，pnpm（`node-linker=hoisted`）写下的
workspace 软链是指向旧路径的绝对链接，全部断链——`node --test` 因此报
`Cannot find package '@zcode/magic-context'`。已把 89 个断链按各包 `package.json`
声明的依赖重建成 **junction**（绝对目标、无需管理员权限），`node_modules` 之外未动。
`turbo` 需把根 `node_modules/.bin` 加进 PATH（`pnpm run typecheck` 在该 CLI
workspace 下找不到它）。另：本工作区存在**并发节点**（phase-model-live）的未提交
改动，本节点提交一律用显式 pathspec，未触碰他人文件。

## 6. MF-1 登记（CR fix 节点，2026-10-11）

CR round 1 裁定的混合方案 a+b 落点：

- **(a-lease) 已补强**：core 新增 `scripts/test-promotion-lease.mjs`（4 用例，挂 core
  `test:promotion-lease` script，`tsx --test`）——`acquireForegroundPromotionLease`
  的 idle-only 五条件门直证：五条件逐一 occupied→`busy` 且 lease 不落、全空→
  `acquired` 且 lease 真落 runtime、同 leaseId 幂等/异 leaseId `conflict` 不覆盖、
  `after-current` 模式无视五条件（模式分界显式化）。spec T-S1 后半「lease 即可获取」
  的机制落点即此门；此前全仓零单测覆盖。实跑 4/4 过（便携 Node 24.14.0）。
- **(b-落库) 登记收窄**：T-S2「折叠落库」不在 test-settle-background.mjs 重复断言
  临时库折叠行，覆盖映射 = magic-context `scripts/test-historian.mjs`（18 项）+
  bootstrap `scripts/test-magic-context-historian.mjs` + 本文件第 3 节 MF-05 close
  drain 契约用例（真 createHistorianScheduler）+ T-S3 实机。spec 测试策略 T-S1/T-S2
  两条已按同口径落文。
