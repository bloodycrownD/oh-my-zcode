# verify-e2e 证据包：协议级 e2e「模型实时切换 × 排队提升 × settle 后台化」叠加

> 节点：verify-e2e（重试）｜迭代：bugfix-batch-20261011｜分支：bugfix-batch-20261011
> Spec：docs/iterations/bugfix-batch-20261011/spec.md（Step 1-6 已实装）
> 测试脚本：apps/zcode-cli/packages/bootstrap/scripts/test-e2e-live-all.mjs
> 纪律：增量落盘。每完成一个场景即追加断言矩阵与实跑摘录。
> 本文件不提交（cache/ 按仓库约定不入库，工作区保留）。

---

## 0. 环境

| 项 | 值 |
| --- | --- |
| 仓库 | D:\Dev\Js\oh-my-zcode |
| 分支 | bugfix-batch-20261011 |
| HEAD | a10e74a1 `[bugfix-batch-20261011/Step 9] magic-context 记忆链测试 T-MC0/T-MC1 + 编译链闭合收尾` |
| Node（测试） | .tools/node-v24.14.0-win-x64/node.exe（node:sqlite 需 ≥22；本项目 pin 24.14.0） |
| Node（shell 默认） | v22.22.0（不用于跑测试） |
| tsc | node_modules/typescript@6.0.2（本仓 devDependency `^6.0.2`） |
| 构建 | core dist、bootstrap dist 亲自跑 `tsc` 生成（exit 0） |

### 构建踩坑（记录给继任者）

- `pnpm --filter ... build` **不可用**：PATH 上的 `pnpm` 指向 nvm shim（`E:\App\Scoop\apps\nvm\...\pnpm.CMD`），
  且 `node_modules/pnpm/bin/pnpm.cjs` 不存在。改用包内直调 tsc：
  `cd apps/zcode-cli/packages/{core,bootstrap} && node <repo>/node_modules/typescript/bin/tsc`
- TypeScript **6.x** 改变了 `-p` 的行为：`tsc -p tsconfig.json` 会报
  `TS5042: Option 'project' cannot be mixed with source files on a command line`，裸 `tsc` 报
  `TS5112`。**这是 Bash 工具的 Windows 命令透传把整条命令按 token 拆开造成的**
  （cmd 不把 `;` 当分隔符，`;`、`echo`、`EXIT=0` 会被当作源文件参数传给 tsc）。
  **规避：命令里不要用 `;` 和 `|`**（`|` 在 node -e 内联正则里同样会炸），用 `&&` 串接或分次调用。

### 隔离声明

- `ZCODE_STORAGE_DIR`、`MAGIC_CONTEXT_DB_DIR`、`MAGIC_CONTEXT_LOG_PATH` 在 import 任何被测模块
  **之前**指到 `os.tmpdir()` 下的一次性临时目录，绝不写真实 `~/.omz` / `~/.zcode`。
- mock/echo model：modelFactory 只造内存 Model，`bind`/`generateText`/`streamText` 一律抛错。
- 被测代码零打桩：core / bootstrap / @zcode/magic-context 一律按 dist 文件路径加载真实模块
  （registerHooks 同 test-model-live.mjs 手法）。

---

## 1. 前置三套既有单测（第一步要求：先构建 dist 并跑通）

实测命令（从仓库根）：

```
.tools\node-v24.14.0-win-x64\node.exe --test apps\zcode-cli\packages\bootstrap\scripts\test-model-live.mjs
.tools\node-v24.14.0-win-x64\node.exe --test apps\zcode-cli\packages\bootstrap\scripts\test-subagent-live-model.mjs
.tools\node-v24.14.0-win-x64\node.exe --test apps\zcode-cli\ackages\bootstrap\scripts\test-settle-background.mjs
```

（第三条路径为 `apps\zcode-cli\packages\bootstrap\scripts\test-settle-background.mjs`；上表拼写已校正。）

| 套件 | 期望 | 实测 | 结果 |
| --- | --- | --- | --- |
| test-model-live.mjs（T-ML1..T-ML4） | 7 | **7 pass / 0 fail**（duration 1678.6ms） | 绿 |
| test-subagent-live-model.mjs（①-④） | 4 | **4 pass / 0 fail**（duration 1937.4ms） | 绿 |
| test-settle-background.mjs（T-S1×2 + T-S2 + MF-05） | 4 | **4 pass / 0 fail**（duration 5632.3ms） | 绿 |

实跑摘录（model-live）：

```
✔ T-ML1a: setSessionModelSelection 只在选型变值时记 lastModelSwitchAt (1.7207ms)
✔ T-ML1b: 切换后下一个新提交轮用新模型（admission 冻结活值 → 执行 → 写回不刷时间戳） (2.2838ms)
✔ T-ML2a: 入队后切换 → 提升轮用活值且不 pin、不写回会话态 (1.4184ms)
✔ T-ML2b: 入队后未切换 → 提升轮用 item 旧快照 (0.5832ms)
✔ T-ML2c: auto-drain 提升（内部 sendQueuedNow）与手动提升同规则 (0.459ms)
✔ T-ML3: 编辑重发仍用被编辑轮快照且不写回会话态（切换发生在编辑之后） (1.1519ms)
✔ T-ML4: execution-scope 轮按 intent 选择执行但绝不写回会话态 (0.2547ms)
ℹ tests 7 / pass 7 / fail 0
```

实跑摘录（subagent-live-model）：

```
✔ ① 同进程 spawn → 改 agents-state.json override → 再 spawn：第二次用新模型 (42.8291ms)
✔ ② 无 override 时用 profile 默认；静态快照形态（旧装配）语义不变 (20.9529ms)
✔ ③ agents-state.json 缺失/损坏/缺字段 → 回退冻结快照且 spawn 不炸，warn 去重 (26.6788ms)
✔ ④ override 指向不存在的模型 id → 丢弃该 override 回退 profile 默认并 warn (15.1193ms)
ℹ tests 4 / pass 4 / fail 0
```

实跑摘录（settle-background）：

```
✔ 长驻形态：model step 不等两处 settle，端口返回时在飞的 historian 仍在跑（T-S1） (4.7068ms)
✔ 短驻形态（对照组）：model step 确实等在飞的 compartment run 与 settle（T-S1 区分力） (75.3393ms)
✔ MF-05 drain 收口：close 钩子把在飞的折叠 pass 等完再停机（T-S2 契约） (5.9925ms)
✔ 长驻形态下 registerClose 钩子仍在场，且 close() 能跑通 drain→shutdown→dispose（MF-05） (3027.5109ms)
ℹ tests 4 / pass 4 / fail 0
```

> 结论：Step 1-6 的既有单测面在当前 HEAD 全绿。e2e（本文件第 2 节起）验证的是
> **三项叠加**，不重复上述单维度断言。

---

## 2. e2e 四场景（T-E2E1..T-E2E4，主代理接手完成）

> 前情：两任子代理节点均因「Model request failed」中断（第一次 66 分钟零落盘；第二次 21 分钟留下骨架+本文件前半）。四场景实现由主代理完成，三处初版失败均为**测试构造问题而非产品缺陷**（同毫秒时间戳精度：admittedAt 改固定过去墙钟；真工厂首调 ~1.4s 为开库/迁移冷启动：暖机后再计时）。复跑 4/4 全绿。

实测命令：

```
.tools\node-v24.14.0-win-x64\node.exe --test apps\zcode-cli\packages\bootstrap\scripts\test-e2e-live-all.mjs
```

| 场景 | 断言要点 | 结果 |
| --- | --- | --- |
| T-E2E1 切模型×排队提升×settle 叠加 | 长驻端口在飞 run 下 model step <100ms 且顺序=[transform,notify]；提升轮 intent=M2 活值不 pin；执行后 Model=M2 零写回；后台 settle 落定有记账日志 | ✔ 6.98ms |
| T-E2E2 编辑重发红线（叠加形态） | 真 editUserQuery → intent 沿用 M1 快照不 pin；执行 Model=M1 零写回；会话态保持 M2 未被还原 | ✔ 2.20ms |
| T-E2E3 真工厂 N-step 不阻塞 + close 收口 | 暖机后连续 2 个 model step 均 <100ms 且在飞 run 全程在场；close() drain 收口后 run 表清空 | ✔ 2829ms（含暖机+close） |
| T-E2E4 子代理 spawn 间隙活读 | 第一次 spawn=SUB_M1；只改 agents-state.json 后第二次 spawn=SUB_M2；主会话模型态不受 override 串扰 | ✔ 22.09ms |

实跑摘录：

```
✔ T-E2E1: 长驻 App 下 turn A(M1) 在飞 → switchModelConfig(M2) → A 完成 → Q promote 用 M2 (6.9787ms)
✔ T-E2E2: 入队 Q2(M1) → 切 M2 → 编辑重发 → 重发轮仍用 M1（v1.0.4 红线在叠加形态下不变） (2.1983ms)
✔ T-E2E3: 长驻真工厂端口：N 个 model step 均不等在飞折叠，close() 的 drain 仍收口 (2829.9417ms)
✔ T-E2E4: 同 App spawn(override=SUB_M1) → 改 agents-state.json(SUB_M2) → 再 spawn 用 SUB_M2 (22.0937ms)
TEST PASS — verify-e2e-live-all (T-E2E1..T-E2E4)
ℹ tests 4 / pass 4 / fail 0
```

### 挂载

`bootstrap/package.json` 增 `test:e2e-live-all`（包内逐脚本约定；根 test:v4-perf 聚合挂载待 fix 节点随 MF-ML-4 一并统一处理）。

### 结论

**四场景全绿，零阻塞项**：模型实时切换 × 排队提升 × settle 后台化 × 子代理活读在同进程同装配下叠加不互斥；v1.0.4 编辑重发红线与 MF-05 close 收口在叠加形态下保持。
