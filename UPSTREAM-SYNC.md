# 上游同步 SOP

oh-my-zcode 是 [ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）的 fork，并集成移植了 [magic-context](https://github.com/cortexkit)（MIT）。本文件是**维护者操作手册**：把上游新版本同步进本 fork 时按顺序执行，不写背景故事。

红线：本 fork 的四个 phase 差异（遥测移除 / magic-context 集成 / 原生压缩移除 / 品牌改名）是产品决策，**同步上游时不许顺手回退**。遇到上游改动与这些差异冲突时，改上游适配层，不改决策。

---

## 1. 更新参照快照

参照快照在**仓库外的同级目录**（`<repo>/../.reference/`），只读，禁止从本仓库反向写入。

| 路径                       | 内容                                        | 本 fork 当前基线        |
| -------------------------- | ------------------------------------------- | ----------------------- |
| `.reference/ZCode`         | 上游 zai-org/ZCode 源码树                   | v3.14.3 @ `29628c9`     |
| `.reference/magic-context` | 上游 `@cortexkit/opencode-magic-context`    | 0.44.4                  |
| `.reference/pi`            | 上游 Pi harness（magic-context 的宿主之一） | 随 magic-context 版本走 |

更新方式：把整个目录替换为目标上游版本的干净 checkout（例如 `git clone` 后 `git checkout <tag>` / `git checkout <commit>`），不要在旧快照上增量改。随后记下 commit，写进本文件的基线表格。

```bash
cd ../.reference/ZCode && git fetch --tags && git checkout <target>
cd ../.reference/magic-context && git fetch --tags && git checkout <target>
```

快照更新后**不要**立刻动 fork 代码，先做第 2 步的影响面评估。

## 2. diff 与影响面评估

本 fork 的 tag 链（每个 tag 都是一次可回退的改造快照）：

| tag                         | 含义                                                |
| --------------------------- | --------------------------------------------------- |
| `baseline/v3.14.3`          | 上游 v3.14.3 快照导入点，之后所有提交都是 fork 差异 |
| `phase1/telemetry-removed`  | 遥测/崩溃上报全链移除                               |
| `phase1/cr-fixed`           | Phase 1 评审修复收口                                |
| `phase2a/magic-context-mvp` | magic-context 移植 MVP                              |
| `phase2b/compact-removed`   | ZCode 原生压缩移除 + magic-context 默认启用         |
| `v0.1.0`                    | 首个发布点（合规收口）                              |

两个变更面：

- **fork 改动面** = `git diff baseline/v3.14.3..HEAD --stat`（含未发布提交时用 `..HEAD`）。
- **上游变更面** = 两个参照快照目录之间的差异（各自是 git 仓库时用 `git -C <snapshot> log --oneline <old>..<new>` + `git -C <snapshot> diff --stat <old>..<new>`；不是 git 仓库时用 `git diff --no-index`）。

**交集判定是本步骤唯一要做的事**：把上游变更文件清单与 fork 改动文件清单求交，得到"两边都动过"的文件集。交集为空 → 本次同步对 fork 无侵入，只做门禁复核即可。交集非空 → 逐个交集文件读 diff，按第 3 步映射到 phase，逐个判定：

1. 上游改动是否落在 fork 已删除的代码上（遥测族 / 原生压缩族 / 品牌字面量）——落在已删除面上，**丢弃**，不重放。
2. 上游改动是否落在 magic-context 移植面上——落在 `src/core/`，走第 3 步的移植件更新流程（逐字覆盖 + 重贴归属头）。
3. 上游改动是否落在 fork 新写的适配层（`src/host/`、`adapters`、`bootstrap`、`ui`、`desktop`）——需要人工适配 + 回归测试。
4. 上游改动了 `preserveProviderStreamBoundaries` / raw-message / hostProcessLifetime 任一契约（见第 3 步硬约束）——停下来，先读硬约束再改。

结论落成一份"受影响文件 → 所属 phase → 处置（丢弃/逐字重放/人工适配）"清单，再开工。

## 3. 重放改造

按 phase 顺序映射，**后面的 phase 依赖前面的**：

| 顺序 | phase              | 同步时的处置                                                                                                                                                                    |
| ---- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 遥测移除           | 上游新增遥测/上报/ARMS/OTLP 接线一律不重放（已删族的复活=回退决策）。上游删除遥测代码时，fork 侧对应文件可能已是死代码，顺手清掉                                                |
| 2    | magic-context 集成 | `apps/zcode-cli/packages/magic-context/src/core/**` 按上游新版本逐字重放；`src/host/**` 是 fork 写的 ZCode 适配层，逐个判定是否要跟着改                                         |
| 3    | 原生压缩移除       | 上游对压缩/compact 的改动不重放（已删族）；但 `compact_stream_boundary` / `preserveProviderStreamBoundaries` 契约字段**必须保留**——它们是上一步的承重面                         |
| 4    | 品牌改名           | 上游新增的 ZCode 字面量（包名、目录名、市场 id、`~/.zcode`）一律改写成 fork 词汇（`omz` / `oh-my-zcode` / `~/.omz` / `oh-my-zcode-official`）；官方市场 id 需保留旧 id 别名兼容。**改名只覆盖用户级 HOME 下的 `.zcode`**——工作区级 `<cwd>/.zcode` 与插件清单目录 `.zcode-plugin/` 跟随仓库内容、不参与品牌改名，刻意保留（见 `NOTICE.md` 零节「品牌改名」行） |
| 5    | 新增内容           | 常规上游代码                                                                                                                                                                    |

### 移植件更新流程（`src/core/**`）

1. 从 `.reference/magic-context` 取上游新版本文件，逐字覆盖到 `src/core/` 对应位置。
2. 保留/重贴文件头注释：移植来源路径 + `MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.`（上游无 per-file 版权头，归属靠这行 + `LICENSE.magic-context`）。
3. 若上游改了 host↔core 的结构契约，同步 `src/host/typecheck-seams.ts`。
4. 更新 `apps/zcode-cli/packages/magic-context/LICENSE.magic-context` 里的 `upstream version` / `snapshot used`。

### 各 phase 的不可回退点（硬约束）

这些是 fork 内部发明或收紧的语义，**任何同步/重构都不得回退**：

| 约束                                                | 位置                                                                                                                                           | 为什么不能动                                                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preserveProviderStreamBoundaries: true`（包内字面量强制 + core 侧可选透传） | **字面量强制点**：`src/host/hidden-completion-executor.ts`——`SidecarModelCallOptions.preserveProviderStreamBoundaries` 是必填字面量 `true`。**通用门面**：`contracts/src/model/index.ts` 与 `core/src/runtime/methods/sidecar-model-request.ts` 只是可选 boolean（`preserveProviderStreamBoundaries?: boolean`）透传，不强制 `true`；provider 适配层 | 它是"编译期 token 测量"能成立的前提：provider 层据此定义流边界，边界消失则 historian 的测量失真。上游 provider 适配层重构时，包内这个 `true` 必须继续透传。core/contracts 侧只是同一 boolean 的通道，**不要**把它们也收紧成必填 `true`——无 historian 的调用方会被迫填一个无意义的值                      |
| raw-message 单读单权威                              | `src/host/raw-message-provider.ts`                                                                                                             | live `borrowReadOnlyRuntimeEntries()` 非空即整读；只有冷启动才落 store。**禁止合并两半边**：两侧 id 词汇表不同（`mc<N>` vs `msg_*`），合并会让跨半边校验退化成 stale no-op |
| `hostProcessLifetime = 'one-process-per-turn'`      | `src/core/hooks/magic-context/transform.ts`、`bootstrap/src/app/magic-context-turn-transform.ts`                                               | ZCode 一进程一轮 prompt，上游是一进程一会话；首 pass usage 的跨进程持久语义由此参数决定。不传=退回上游逐字行为=错                                                          |
| `sidecar-model-request` 命名                        | `core/src/runtime/methods/sidecar-model-request.ts`                                                                                            | 原 compact 原语的去 compact 化改名，是 phase2b 收口结果；不要改回 compact-\* 命名                                                                                          |
| 压缩词汇白名单                                      | `src/core/**` 之外零命中                                                                                                                       | 原生压缩已整删；`src/core/**` 之外的 "compact" 命中一律是残留                                                                                                              |

表中路径除已写全前缀者外，均为**包内相对路径**（根在 `apps/zcode-cli/packages/`）：`src/core/**` 与 `src/host/**` 指 `magic-context` 包，`contracts/` 指 `contracts` 包，`core/` 指 `core` 包，`bootstrap/` 指 `bootstrap` 包。`core/src/runtime/methods/sidecar-model-request.ts` 全仓只有这一处（`:80` 与 `:83` 指同一文件）。

## 4. 门禁清单

按顺序跑，全绿才算同步完成。Windows 提示：先 `set PATH=<repo>\node_modules\.bin;<node-24.14.0>;%PATH%`（Node 必须 24.14.0，见 `mise.toml`）。

| 门禁         | 命令                                                                                                                                                                                                                                                                                                                                                           | 判据                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 根类型       | `pnpm typecheck`                                                                                                                                                                                                                                                                                                                                               | 0 error                                                                                                          |
| CLI 类型     | `pnpm --dir apps/zcode-cli typecheck`（= `turbo run typecheck`）                                                                                                                                                                                                                                                                                               | 与基线同，无新增                                                                                                 |
| desktop 类型 | `pnpm typecheck:desktop-full`                                                                                                                                                                                                                                                                                                                                  | 差分模式：只看 `removed` 与新增 kind，基线既有错误不算回归                                                       |
| lint         | `pnpm lint`                                                                                                                                                                                                                                                                                                                                                    | 71 warnings / 0 errors（基线即如此；根 `.oxlintrc` ignorePatterns 含 `apps/zcode-cli`，CLI 子树另有 turbo lint） |
| knip         | `pnpm knip`                                                                                                                                                                                                                                                                                                                                                    | 与前一提交 stash 对比**零新增**；且新增项不得命中 magic-context                                                  |
| 格式         | `pnpm fmt:check` / `oxfmt --check <改动文件>`                                                                                                                                                                                                                                                                                                                  | 改动文件零新增不合规（`.oxfmtrc` 已忽略 THIRD-PARTY-NOTICES.md / inventory.json；markdown 不在 oxfmt 范围）      |
| 三方许可     | `node scripts/licenses.mjs notices` 后 `node scripts/licenses.mjs check`                                                                                                                                                                                                                                                                                       | 包版本数变化 = 依赖真实变化；无 `Stale npm notice override`；check 通过（`reviewRequired` 15 项为既有基线）      |
| 测试族       | `apps/zcode-cli` 下 15 个脚本：magic-context 6（`smoke-storage` / `test-config` / `test-host` / `test-transform` / `test-historian` / `test-ctx-tools`）+ bootstrap 5（`test:magic-context*`）+ adapters 2（`test-feature-flag` 直接 node 跑、`test:magic-context-domain`）+ core 1（`test-sidecar-model-request` 直接 node 跑）+ cli 1（`test:ctx-commands`） | 全绿                                                                                                             |
| E2E          | 隔离环境下跑（见第 5 节）                                                                                                                                                                                                                                                                                                                                      | 主链路一致，且**零污染**：不碰用户真实 `~/.omz` 会话库                                                           |

**发布前额外一条（sea-config 全 target 重建）**：`apps/zcode-cli/packages/cli/dist/sea-config-*.json` 是 SEA 打包的资产清单快照，逐 target 生成、**不进版本库**（`apps/zcode-cli/.gitignore` 忽略 `dist/`）。只重建部分 target 会留下上一版的陈旧清单（曾出现 darwin-arm64 清单里 `@zcode/magic-context` 资产数为 0 的陈旧产物，发布后 SEA 起不来）。因此：发布任何 target 前必须对**全部 target** 重跑 SEA 构建，确认 `dist/` 下每个 `sea-config-<target>.json` 都包含当期包资产；发现陈旧文件直接删除后重建，不要就地编辑。

## 5. 已知不适配项

以下是"上游有、fork 没有 / fork 改了、上游没有"的已知项。同步时遇到它们，**不要**当成 bug 修回去。

| 项                                      | 事实                                                                                                                                                                                                                                            | 处置                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/bootstrap.mjs` 的 submodule 行 | 上游 `bootstrap.mjs:161` 有 `runGit(["submodule","update","--init","--recursive","apps/zcode-cli"])`（连带 `gitCommand` 常量与 `runGit` 函数）。phase-0 Step 1 已删；`apps/zcode-cli` 在 fork 里是普通目录                                      | 上游同步回来后**重新删掉这三处**                                                                                                                                                                                                                                                                                 |
| `scripts/check-workspace-freshness.mjs` | 脚本按上游 `origin/main` 设计。本 fork 若无 origin remote，默认跑法会在 `git fetch origin --prune` 硬失败退出 128                                                                                                                               | 无 remote 时用 `node scripts/check-workspace-freshness.mjs --no-fetch`（会跳过 behind-remote 与 behind-main 检查并打印"基线新鲜"）；配了 origin 的 fork 按原样跑                                                                                                                                                 |
| `pnpm -r ls` EMFILE                     | 本机 `node-linker=hoisted`、`node_modules` 1077 项时，`pnpm -r ls --prod --json --depth Infinity` 必现 `EMFILE: too many open files`（Node 直接并发读 981 个 package.json 正常，是 pnpm 自身 fd 累积）。`licenses.mjs notices` / `check` 都经它 | 临时把 `scripts/third-party-npm.mjs` 的 `readWorkspaceProductionGraph` 改成"按 `pnpm -r ls --depth -1` 列出的项目逐个 `pnpm --filter <name> ls --prod --json --depth Infinity` 串行跑"，跑完**回滚**（与 s12 同做法）。注意 `pnpm -C <dir> ls` / `cd <dir> && pnpm ls` 在本机返回**空依赖树**，必须用 `--filter` |
| `pnpm -C` 空树                          | 同上：workspace 包用 `-C` 或 cwd 进去跑 `ls`，只回项目自身、无 dependencies；用 `pnpm --filter <name>` 才有完整树                                                                                                                               | 排查依赖图时统一用 `--filter`                                                                                                                                                                                                                                                                                    |
| `knip` 计数口径                         | 历史上出现过 742 / 719 / 718 / 676 等不同数——口径不同（分类和 vs 行数）与存量漂移都算在内                                                                                                                                                       | 判据只用"与前一提交 stash 对比零新增 + 零 magic-context 命中"，不要用绝对数当门禁                                                                                                                                                                                                                                |
| desktop 完整构建                        | 基线 `tsc` 有既有错误，门禁是差分模式（基线快照在 `scripts/desktop-typecheck-baseline.txt`）                                                                                                                                                    | 不要试图把基线错误清零                                                                                                                                                                                                                                                                                           |
| EXEMPT-2b：SEA 运行时加载层               | SEA 单文件发行物启动时报 `No such built-in module: @zcode/magic-context`——Node SEA 的 `require()` 只解析内置模块，裸说明符 staging 修不了。登记口径：**产物实测 5 处静态 require + 2 处动态 import = 共 7 处加载点**（静态 5：`adapters/src/config/schema.ts`、`bootstrap/src/app/magic-context-historian.ts`、`magic-context-turn-transform.ts`、`magic-context-usage-summary.ts`、`bootstrap/src/zcode-protocol/magic-context-config.ts`；动态 2：`cli/src/command-center/handlers/ctx.ts`、`core/src/tool/handlers/ctx-context.ts`）。计划 v0.1.1 按 `sea-playwright-runtime.ts` / `tui-runtime-loader.ts` 范式补显式路径加载层 | 同步时**不要**把这 7 处加载点当 bug 改回静态 require；新增同类加载点时在 `docs/.iteration-state.yaml` 的 `exempt` 里同步更新计数（本表与该文件保持一致）                                                                                                                                                                                                    |
