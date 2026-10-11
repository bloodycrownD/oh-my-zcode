---
date: 2026-10-11
generated_by: impl-model-sub
head_sha_at_generation: 62dceebe2fb099ef15a6463301f44bce477fb4e8
iteration: bugfix-batch-20261011
phase: phase-model-live
steps: [Step 6]
---

# 子智能体模型 override 同会话实时生效（Step 6）证据包

> 生成节点：impl-model-sub。spec 权威红线见 `docs/iterations/bugfix-batch-20261011/spec.md`
> 缺陷③（「子智能体模型 override 每次 spawn 读活值」）与「现状约束 → 模型选择语义」
> （`runner.ts` native port 构造期冻结 profiles；ConfigPort 无 subagents 域）。
> 本文件只覆盖缺陷③；缺陷②（主会话切模型）见同目录 `model-live-chain.md`（impl-model-main）。

## 1. 现状冻结链（改造前，探索核实锚点）

```text
设置页（Local Host 进程，写侧——本批不动）
  └─ packages/ui/src/settings/SubagentsSection
       └─ packages/services/src/subagents/subagentStorage.ts
            resolveSubagentStateFile() = <storage.dir>/v2/agents-state.json
            ← subagentsService.ts:650-674 setBuiltInModelOverride：read-modify-write
              写 builtInModelSelectionOverrides（atomicWriteText 原子写）

CLI 读侧（问题所在：只读一次，冻结到底）
  ① bootstrap/src/app/server-operations 形态入口 → create-app.ts:250 loadZCodeAgentProfiles
       └─ bootstrap/src/subagents.ts:71 readAgentState(storageRoot)
            读 <storageRoot>/v2/agents-state.json → normalizeBuiltInSelectionOverrides
       └─ create-app.ts:298 → resolveAppRuntimeConfig
            （app/runtime-config.ts:182-185 合并进 runtimeConfig.subagents）
  ② runtimeConfig.subagents.builtInModelSelectionOverrides = 启动快照（冻结）
       └─ AgentRuntime config（core/runtime/types.ts:138）
  ③ core/runtime/agent-runtime.ts:287 this.subagentPort = runtime.createDefaultSubagentPort(deps)
       └─ core/runtime/methods/subagent.ts:73 读 this.config.subagents?.builtInModelSelectionOverrides
            └─ core/subagent/runner.ts:131 createExploreSubagentPort
                 normalizeAgentProfiles(...) ← 构造期冻结 profiles
  ④ 每次 spawn（core/subagent/runner.ts launch/run/start）用冻结 profiles
       └─ core/runtime/methods/subagent.ts:100-105 runExploreAgent
            resolveSubagentSelection({ profileSelection: request.profile.modelSelection })
            → childSelection（override 命中这里才生效）
```

结论：`agents-state.json` 只在 **App 创建时**读一次；改 `runtime.config.subagents` 也无效，
因为 `createExploreSubagentPort` 在**构造期**就冻结了 profiles。热改的唯一入口是
「每次 spawn 前重新解析」。

## 2. 改动点（Step 6，B1 方案：per-spawn 活读，不扩协议）

| # | 文件 | 改动 | 说明 |
|---|---|---|---|
| 3a | `apps/zcode-cli/packages/core/src/subagent/runner.ts` | `ExploreSubagentPortOptions.builtInModelSelectionOverrides` 改联合类型：静态值 **或** `() => overrides \| undefined` provider；`createExploreSubagentPort` 内 `const profiles = normalizeAgentProfiles(...)` 冻结改为 `resolveProfiles()` 闭包，`launch`/`run`/`start` 每次 spawn 现调；新增 `resolveBuiltInModelSelectionOverrides(options)`（provider 抛错也 fail-open 返回 undefined）；`sendMessageToLocalAgent`/`resumeTerminalAgentInBackground` 的 `profiles` 参数改惰性 `resolveProfiles` —— deliver 到运行中 task 是纯转发零成本，resume 终态 task（=一次新 spawn）取活值 | 归一化仍只走 `normalizeAgentProfiles` 一份，不复制校验规则；静态值形态逐行保持旧语义 |
| 3a | `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` | `createDefaultSubagentPort` 的 `builtInModelSelectionOverrides` 从静态值改为 provider：`() => deps.resolveBuiltInSubagentModelSelectionOverrides?.() ?? this.config.subagents?.builtInModelSelectionOverrides` | 活读优先；读不到（文件缺失/损坏/字段缺失）回退 App 创建时冻结进 config 的启动快照 |
| 3a | `apps/zcode-cli/packages/core/src/runtime/types.ts` | `AgentRuntimeDeps` 新增可选 `resolveBuiltInSubagentModelSelectionOverrides?: () => BuiltInSubagentModelSelectionOverrides \| undefined` | 宿主注入点；顺带修复 HEAD 已入库的两行缩进损伤（`modelIoDir`/`permissionService` 顶格，oxfmt 基线违规），使本文件恢复 oxfmt 合规 |
| 3b | `apps/zcode-cli/packages/bootstrap/src/subagents.ts` | 新增 `createAgentStateOverrideProvider({ storageRoot, logger, isModelSelectionAvailable })`（见 §3 语义） | 复用既有 `readAgentState` 同路径读取与 `normalizeBuiltInSelectionOverrides` 归一化 |
| 3b | `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` | 在 `loadZCodeAgentProfiles` 之后创建 provider（`storageRoot` + `logger` + `getRegistryBackedModel(options.providerRegistry, selection) !== undefined` 可用性判据），注入主 `new AgentRuntime(...)` 的 deps | workflow child runtime（script-workflow-child-runtime/workflow-facade）不注入 → 维持启动快照（actor 配置本就另源，最小侵入） |
| 测试 | `apps/zcode-cli/packages/bootstrap/scripts/test-subagent-live-model.mjs` | 新增（node --test，registerHooks→dist，4 用例） | 见 §4 |
| 挂载 | `apps/zcode-cli/packages/bootstrap/package.json` | `"test:subagent-live-model": "node --test scripts/test-subagent-live-model.mjs"`（沿用 test:settle-background 命名风格） | **未**挂根 package.json（impl-model-main 独占） |

**写侧协议不变**：设置页 → host → `agents-state.json` 的链路零改动；本批只改 CLI 读侧。

**同步 IO 成本**：每次 spawn 一次 `readFileSync`（<2KB）+ 内容与上次相同则零解析；
不同于 mtime 缓存——内容字符串比对不受「同毫秒同尺寸改写」粒度坑影响，且更简单。

## 3. 活读 provider 语义与回退矩阵

`createAgentStateOverrideProvider` 返回 `() => BuiltInSubagentModelSelectionOverrides | undefined`：

```text
每次 spawn（core 调 provider）
  ├─ readFileSync 抛错（文件缺失/不可读）
  │    → undefined（core 回退启动冻结快照）+ warn "不可读"（签名 "unreadable"，去重）
  ├─ 内容与上次完全相同 → 直接返回上次归一化结果（零 parse）
  ├─ JSON.parse 失败
  │    → undefined（回退启动快照）+ warn "解析失败"（签名 corrupt:<len>，去重；
  │      不写失败缓存，写侧修好后下一次 spawn 自然恢复）
  ├─ 顶层不是对象 / builtInModelSelectionOverrides 字段缺失或不是对象
  │    → undefined（信任启动快照；不 warn——写侧 RMW 恒写该字段，缺字段只可能是
  │      外部/旧格式写入；用户从未设置过 override 也是这个形态）
  └─ 字段存在（含 {}）→ normalizeBuiltInSelectionOverrides 归一化
       ├─ 该条 override 的模型经 isModelSelectionAvailable 判定为不可用
       │    → 丢弃该条目 + warn "指向不可用模型"（签名 unavailable:<agent>:<p>/<m>，去重），
       │      回退 profile 默认（不是回退快照）
       └─ 否则收入结果表；内容未变时结果按 raw 字符串缓存
```

可用性判据在 bootstrap 侧注入：`getRegistryBackedModel(providerRegistry, selection) !== undefined`
（provider + model 都在 Registry 索引中）。丢弃不可用 override 是必需的：否则 core 的
`resolveSubagentSelection`（helpers/subagent-selection.ts:29-53）对该选择 fail-visible 抛错，
而「设置页写过、后来模型被删」应回退默认而非让 spawn 失败。

**回退矩阵**：

| agents-state.json 状态 | provider 返回 | spawn 用哪个模型 | warn |
|---|---|---|---|
| 文件缺失 | `undefined` | 启动冻结快照（通常 = profile 默认） | 1 次 "不可读" |
| JSON 损坏 | `undefined` | 启动冻结快照 | 1 次 "解析失败" |
| 缺 `builtInModelSelectionOverrides` 字段 | `undefined` | 启动冻结快照 | 无 |
| `{}`（用户改回「继承」） | `{}` | profile 默认（override 当场清除） | 无 |
| override 指向 Registry 不存在的模型 | 过滤后余表 | 该 agent 回退 profile 默认；其余 override 照常 | 1 次/identity |
| override 有效 | 归一化表 | override 指定模型（per-spawn 现读） | 无 |

plugin agent 的 model override（`pluginAgentModelSelectionOverrides`）**仍随启动快照**：
`loadPluginAgentProfiles` 在启动时把 override 烘进 markdown 派生的 profiles，name→
`plugin:<pluginId>:<bare>` 的稳定 id 映射没有带进 profile 对象，per-spawn 重放需要重建
markdown 装配（成本与复杂度不对等）。报障面与 spec 缺陷③均指内置 general-purpose/Explore，
本批只做内置活读；插件 agent override 维持「重启生效」现状，此处显式登记。

## 4. 测试覆盖（验收 ①-④ / T-MU1·T-MU2 的 auto 部分）

`node --test apps/zcode-cli/packages/bootstrap/scripts/test-subagent-live-model.mjs`
（便携 Node 24.14.0；被测代码零打桩——core `dist/subagent/runner.js` 与 bootstrap
`dist/subagents.js` 按文件路径加载真实模块，`@zcode/shared`/`@zcode/model-option-map`
经 registerHooks 改指 dist，同 `test-settle-background.mjs` 手法）：

| 用例 | 断言 |
|---|---|
| ① per-spawn 生效 | 同一 port 实例（core 每 runtime 只建一个 subagent port = 同 App）内：无文件 → spawn 用默认；写 override → 第二次 spawn 用新模型（`profile.modelSelection` + `subagent_spawned` 事件 `model` 标记双证据）；Explore 不受影响；override 更换后再 spawn 跟上；改回 `{}` 当场恢复继承 |
| ② 不回归 | 无 override 时自定义 profile 保留自身 `modelSelection`、内置无显式选择；静态值形态（旧装配，未注入 provider 的 workflow child runtime）与构造期快照逐行等价 |
| ③ fail-open | 文件缺失 / JSON 损坏 / 缺字段 → 回退冻结快照且 spawn 不炸（`createDefaultSubagentPort` 合并语义 `provider() ?? 快照` 在测试内 1:1 复刻）；warn 去重（同一损坏内容再 spawn 不新增）；缺字段不 warn；文件恢复有效后下一次 spawn 立即跟上（失败不缓存） |
| ④ 不可用模型 | override 指向 Registry 不存在的模型 id → 丢弃并 warn 一次（同一失效形态重复 spawn 不刷屏）；同文件里可用的 Explore override 不受影响 |

隔离：`ZCODE_STORAGE_DIR` 与 provider 的 `storageRoot`、`agents-state.json` 全部显式指向
`os.tmpdir()` 一次性目录（per-test 子目录，缓存互不污染）；agent 元数据/输出写独立 output 目录。
**绝不写真实 `~/.omz`/`~/.zcode`**。

T-MU2（vision 模型 wire 收到 mural PNG）属 Step 15 实机验收，不在本文件范围。

## 5. 验证记录（实跑，2026-10-11）

| 命令 | 结果 |
|---|---|
| `.tools/node-v24.14.0-win-x64/node.exe --test apps/zcode-cli/packages/bootstrap/scripts/test-subagent-live-model.mjs` | 4/4 pass，exit 0 |
| `pnpm --filter @zcode/core build` / `--filter @zcode/bootstrap build` | 0 error（tsc） |
| `pnpm --dir apps/zcode-cli run typecheck`（turbo 27 任务） | 27 successful / 27 total，exit 0 |
| `tsx --test apps/zcode-cli/packages/core/scripts/test-subagent-sync-dispatch.mjs`（既有 subagent 回归） | 5/5 pass |
| `oxlint src --no-ignore`（core） | 17 warnings / 0 errors，本人文件 0 命中（基线不变） |
| `oxlint src --no-ignore`（bootstrap） | 23 warnings / 0 errors；`create-app.ts` 的 1 条为 HEAD 既有的 `SessionEvent` 未用 import，非本节点新增 |
| oxfmt 改动文件（7 个） | 全部零差异（方法见下） |

oxfmt 核实方法说明：本环境 `oxfmt --check <位置参数>`（含 `npx oxfmt --check`）报
"Expected at least one target file"（0.41.0 在此机的多位置参数缺陷，与仓库基线无关）。
改用等价判定：把每个改动文件复制到 `os.tmpdir()` 一次性目录后对副本执行 `oxfmt --write`，
再逐字节比对写前/写后——7 个文件全部 `changed=false`（controller：未改动的
`core/src/subagent/profile.ts` 在同一方法下 `rawChanged=true, normalizedChanged=false`，
即仅 CRLF 行尾差，证实该方法对「真实格式差异」有区分力）。期间 oxfmt 顺带把
`core/src/runtime/types.ts`、`bootstrap/src/subagents.ts` 与测试文件按仓库规范重排
（含把 subagents.ts 工作区混合行尾归一为 LF），重排后全部复验通过。
