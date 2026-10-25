---
date: 2026-10-25
dependency:
  - iterations/optimization-triage-20261025/research.md
---

# magic-context-decoupling 技术规格（SPEC）

## 设计目标

把 magic-context（下称 MC）从「深度耦合的移植件」改造成**真正的插件**，同时达成三件事：

1. **可一键摘除**：删包、删依赖、删协议面之后宿主仍能正常启动，不留孤儿状态；且有可执行的摘除脚本，不是靠人工清单。
2. **关闭即零加载**：`features.magicContext` 为 false 时，MC 包**一个模块都不进内存**（今天不成立，见 W1/W2/W3）。
3. **便于跟随上游升级**：把「宿主侧 MC 耦合散点」压缩到可枚举的接缝清单，且散点数量有门禁守护（只减不增），UPSTREAM-SYNC 的过期口径一并修正。

顺带根治两条已定位的 MC 行为缺陷（都是「模型读到错误内容」类，与编辑重发无关）：

- **C1 compartment 悬挂注入**：rewind 后旧 compartment 摘要仍被注入，且被摘要覆盖的原文也仍在窗内 → 模型同时看到旧摘要与旧原文。
- **C2 `rebuildEntry` 无身份守卫**：`original.metadata` 被无条件整拷，幽灵用户消息事故（assistant 旁白被当成真实 user 输入）在本树上**防护为零**。

### 需求来源

用户口述（2026-10-25，最早原话）：

> magic context 允许更改，magic context 只是插件，不应该深度耦合。

> magic-context 问题太多，我希望它可以完全插件化、我们把它和主体切割开、重新优化防腐层，未来可以一键去除 magic context。

> MC 防腐层还有一个作用是方便跟随 ZCode 升级——从记忆与 git 历史能看到 MC 非常影响 omz 升级。

本轮追加授权：

> 都修吧，根治。如果需要决定的地方，通通按照根治的思路做决定。

需求路径：`docs/iterations/optimization-triage-20261025/research.md`（三方向评估）+ 上述口述。

### 本 spec 的决策立场

用户已授权「按根治思路自行决定」，因此以下分叉**直接定为**（不再回问），并逐条写明理由与代价：

| 分叉 | 决定 | 理由 |
|---|---|---|
| W1 解法：窄子路径 vs 宿主 opaque 化 | **窄子路径**（包内新增 `exports`） | opaque 化要放弃字段级校验，`adapters/src/config/schema.ts:52-64` 注释已明确反对复制 schema；且记忆 #135 已允许改 MC 包，窄子路径是唯一「既保校验又不拉全图」的路 |
| `host/config/schema` 的 4 文件闭包 | **接受，并抽零依赖叶子** | 该子路径会拉 `core/shared/prompt-surface.js` → `harness-provider-map.js`；把 `isValidPromptSurfaceModelKey` 抽到 `core/shared/prompt-surface-key.ts`（零 import），使 schema 子路径闭包降到 2 文件 |
| C1 修在哪一层 | **host 侧失效 + core 侧 refused 不注入，双保险** | 只改 host（清缓存）挡不住「边界行仍在原始库、下次仍 refused」；只改 core 不改 host 会让陈旧摘要继续被重放。属 `src/core/**` 逐字区改动 → 按 #135 写 FORK 偏离理由与 rebase 点 |
| 冷/热两套真值 | **保留，但都由同一函数计算** | 合并成单值会让设置页关闭要等重启；这是 MF-01 的回归点 |
| 包缺失时的行为 | **删包由摘除脚本承载**（宿主代码里对 MC 的引用被逐条删除）；运行期只保留「动态 import 失败 → `absent(import_failed)`」这一真实可达分支 | 手工删 node_modules 不可行：`adapters/src/config/schema.ts:4-8` 会在配置装载阶段（早于 create-app）先抛 `ERR_MODULE_NOT_FOUND` |

## 根因：今天为什么做不到「一键摘除」

不是缺脚本，是三个结构事实：

### W1 — adapters 配置 schema 在顶层求值（无条件、最早）

`adapters/src/config/schema.ts:4-8` 静态值导入 MC barrel；`:65` `const magicContextDomainSchema = MagicContextConfigSchema.optional()` 在**模块顶层执行**。该模块由 `adapters/src/config/index.ts:15,524` 静态引入，而配置装载是每次启动必经路径。`features.magicContext` 此刻还不存在，所以**任何开关都不可能拦住这次加载**。

### W2 — 协议 handler 两个模块静态挂在 server 上

`bootstrap/src/zcode-protocol/server.ts:85`（config handler）、`:88-91`（memories handler）静态 import；两模块各自值导入 MC barrel。可达链：`bootstrap/src/index.ts:67` → `zcode-protocol-entrypoint.ts:31` → `server.js`，而 `cli/src/bootstrap-loader.ts:6` 对 `@zcode/bootstrap` 做**包 barrel** 动态 import——barrel 的 `export … from` 是静态边。结论：**TUI / print / app-server 三种形态启动即载整棵 MC**（`src/core` 255 文件 + `src/host` 12 文件）。

附带问题：`magic-context-memories.ts:166-169` 在自己的 handler 里 `initializeMagicContextHost()` + `openDatabase()`，**不复用装配层 db**——这是「摘除后留下孤儿库句柄」的来源。

### W3 — 生效判定有 9 处消费点，口径靠人工对齐

唯一口径 `bootstrap/src/app/magic-context/gate.ts:32-36`（`(override ?? featureFlag) && domainEnabled !== false`，**工作树未提交**），但消费方仍各写一遍：

| # | 位置 | 表达式 |
|---|---|---|
| G1 | `gate.ts:32-36` | 唯一口径（新，未提交） |
| G2 | `runtime-config.ts:213-226` | 调 G1（冷值） |
| G3 | `zcode-protocol/magic-context-memories.ts:128-150` | 调 G1 |
| G4 | `create-app.ts`（分析时在 `:827 / :884 / :1281`，行号会漂；落地后按符号定位） | `runtimeConfig.magicContext?.enabled === true` **同一求值写三遍** |
| G5 | `magic-context-turn-transform.ts:1611-1612` | `isEnabled()` 读 bridge 快照（热值） |
| G6 | `core/src/runtime/helpers/runtime-tools.ts:126` | `config.magicContext?.enabled === true` |
| G7 | `core/src/runtime/helpers/magic-context-prompt-section.ts:84` | `!== true` → 回落原生记忆段 |
| G8 | `core/src/runtime/helpers/magic-context-turn-transform.ts:232-234` | 三重判空 |
| G9 | `bootstrap/src/ctx-commands/run-ctx-command.ts:172` | `host.isMagicContextEnabled?.() !== true` |

G6/G7/G8 在 core 侧、按设计不 import 包（`import type` only），它们的判定语义必须与 G1 完全一致，否则会出现「设置页显示已关、core 仍注册 ctx_* 工具」。

### 数据面：不可逆

- 迁移 `migrations.ts` 3485 行 / **93 条**（92 编号 + `v10000` fork 哨兵），**v85/v87 为 fork 主动省略**（`:2978-2987`、`:3042-3047`）——每次升版都要重做同样的省略判定。
- **无任何自动备份**：全包搜 `backup` 只有 legacy OpenCode 目录一次性拷贝与 `single_store_state.backup_dir`（后者是 Rust 单库账本，不是备份）。
- `closeDatabase()`（`storage-db.ts:2890-2901`）**生产零调用方**，靠进程退出收尾。
- `fail_closed_blocking` 默认 **true**（`host/config/schema.ts:330-335`），开库失败即 throw 阻断首轮（`turn-transform.ts:1392-1394`）。
- 迁移只前向。删包留 `~/.omz/cli/db/magic-context.db` + `-wal`/`-shm`；重装旧版本会命中 `db_null:fence` 并因默认 true **阻断每一轮**。

## 不变式

| ID | 不变式 |
|---|---|
| **IM1** | 开关为 false ⇒ **M0 白名单之外**的 MC 模块零加载。M0 = `magic-context/dist/host/config/{schema,language}.js` + `dist/core/shared/prompt-surface-key.js` **及其 zod4 依赖闭包**（`magic-context/package.json:38` 是 zod `4.6.5`，不是 zod3；`sea-tui-assets.mjs:135` 注释亦记 zod4 抢根位）。`language.js` 必在闭包内，因为 `schema.ts:52` 值导入它、`:341` 的 `.refine(isValidLanguageCode)` 在模块顶层求值；`prompt-surface.js` 必须**被替换**为 `prompt-surface-key.js`（改 `schema.ts:51`），否则闭包多出 `prompt-surface.js` 与 `harness-provider-map.js` 两个文件。判定口径：「**M0 之外**的行为模块（`src/core/**`、`src/host/**` 中除 M0 三者外的文件）计数为 0」，不是「全部模块为 0」 |
| **IM2** | **摘除脚本执行后**，宿主 typecheck / lint / `createApp()` 启动 / 非 MC 测试全通过。此路径下宿主代码被删匹配项，**不依赖任何运行期「包缺失探测」**；运行期只保留 `absent(import_failed)`（动态 import 失败这一真实可达场景）。**不存在 `package_missing` 这个 reason** |
| **IM3** | 三轴生效判定只有**一个实现**（`bootstrap/src/app/magic-context/effective-enabled.ts` 的 `resolveMagicContextEffectiveEnabled`；core 侧只有同义的布尔投影 `isMagicContextEffectiveByConfig`）。**冷值**由它算出并冻结进 `RuntimeConfig`；**热值**（bridge 快照 `isEnabled()`，G5）只投影同一域值，feature 门由装配门**结构性**携带——开关为 false 就根本没有端口，热路径不重算三轴 |
| **IM4** | core 侧对 MC 的依赖只有三端口 + 静态导入面永不出现运行期值 import；**例外（须单列预算，不得混算）**：`core/src/tool/handlers/ctx-{context,memory,search}.ts` 在**调用期** `await import("@zcode/magic-context")`（`:56`/`:63`/`:77`），这是 ctx 工具自身的实现依赖，随 4 个工具一起被摘除。**MC 包内的行为（含 compartment 失效）只能由 host 侧调用**，core 不得反向依赖 |
| **IM5** | 注入身份只存活在「字节未改且 role 匹配」的条目上（C2 的根不变量） |
| **IM6** | `prefixTrimStatus === "refused"` 时**不注入 M1 中的 `<new-compartments>` 块**（M1 其余内容照旧，它承载 memory 增量 / new memories / user profile）；`boundary-precedes-window` 保持现状（该态下 M1 可能是窗口外历史的唯一载体，抑制反而丢信息） |
| **IM7** | 宿主侧 MC 耦合散点数量有门禁，只减不增。**口径写死**：正则 `^@zcode/magic-context(/|$)` 匹配**所有**导入行——值导入、`import type`、`await import`、`typeof import`、以及**窄子路径**（`/host/config/schema` 等，本 spec 自己会新增 3 处，必须计入）；按包分列 + 上限。文件数不计（`phase-facade` 会新增 8 个文件）。core 的 ctx handler 调用期 `await import` 单列预算（见 IM4 例外） |

## 总体方案

### phase-0-baseline（先清基线）

工作树有未提交的 wave-1 半成品：`app/magic-context/gate.ts`（新，36 行）、`runtime-config.ts`、`zcode-protocol/magic-context-memories.ts`、`bootstrap/package.json`（+`test:magic-context-gate`）、`scripts/test-magic-context-gate.mjs`（新，untracked）。

**决定：保留这批改动作为基线并先提交**（它们与 IM3 同向）。同时修两个即时缺陷：
- `bootstrap/package.json:35` 的 `test:magic-context-gate` 指向 untracked 文件 → 干净 checkout 必挂，必须入库。
- `gate.ts` 命名有两义（research 里「agent 门控」vs 本树「effective 开关」）→ 改名 `bootstrap/src/app/magic-context/effective-enabled.ts`，导出 `resolveMagicContextEffectiveEnabled`。

### phase-effective-single（IM3）

把 G4/G5/G6/G7/G8/G9 全部收敛到一个通道：

- **bootstrap 侧**：导出唯一 `resolveMagicContextEffectiveEnabled()`；`create-app.ts` 里三处同一求值（装配门 / 工厂 `enabled:` 入参 / `isMagicContextEnabled()` 契约，按符号定位、不写死行号）改为调用一次 `projectMagicContextEffectiveEnabled(runtimeConfig)` 并复用结果；`isMagicContextEnabled()` 契约只转发。
- **core 侧**：`runtime-tools.ts:126`、`magic-context-prompt-section.ts:84`、`magic-context-turn-transform.ts:232-234` 三处改调 core 内部纯函数。**注意三者今天的缺省方向不一致**：`:126` 用 `=== true`（undefined→关）、`:84` 用 `!== true`（undefined→关）、`:234` 用 `=== false`（undefined→开，且以端口在场为前提）。因此**不合并成单函数**：core 侧保留各自的缺省语义，只把「真值来源」统一为同一个 `isMagicContextEffectiveByConfig(enabled)` 投影；`magic-context-turn-transform.ts:232-234` 的「端口在场 + `isEnabled()` 优先、config 只做否决」结构原样保留。bootstrap 三轴表与 core 布尔投影表在同一测试文件里逐行对齐（见 T-MC1）。
- **冷/热分工保留**：冷值进 `RuntimeConfig`（G2）；热值走 bridge 快照（G5）。core 的 `:233` 以 `isEnabled()` 为准、`:234` 再兜底 `config` 的顺序不动。

### phase-facade（2240 → 门面 + 六工厂，零行为）

`bootstrap/src/app/magic-context-turn-transform.ts` 实测 **2240 行**（research.md 写的 1663 行不可复现）。按职责拆为：

```
bootstrap/src/app/magic-context/
  index.ts              门面：createMagicContextPlugin() 唯一出口
  types.ts              TransformDeps / Options 类型
  usage.ts              pushMagicContextUsageSummary + createMagicContextUsageRecorder
  projection.ts         isUnchanged / rebuildEntry / projectMagicContextEntries + 调度器适配
  storage.ts            describeStorageUnavailability / boot 开库重试 / stored rows
  ports.ts              turn-transform 端口 + promptSection + toolDescription 三个 resolver
  assembly.ts           createMagicContextTurnTransform + applyConfigToDeps + buildTransformDeps
  settle.ts             settle 两态 + close 时序
  effective-enabled.ts  唯一生效口径
```

**五条零行为不变量（拆分时逐条守）**：

1. `if (!options.enabled)` 必须是工厂**第一句**（`:1331-1338`，前面只有注释）。
2. deps **同引用**：`applyConfigToDeps` 原地改写（`:1661-1703`），不得每 pass 重建（否则热生效与 `getToolSetHash` 指纹静默失效）。
3. settle 时序：`settlesInForeground` 只求值一次（`:1986`）；前台 `:2098-2102` / 后台 `:1893-1913` 两态不得合并。
4. `registerClose` 顺序 `drain → shutdown → dispose`，且必须早于 `closeSessionResources`（`:1543-1562`）。
5. 失败分级顺序不可重排：fail-closed → LKG → 拒发 → busy → fail-open（`:2143-2192`）；统一 catch 会改变「开库失败阻断首轮」的产品语义。

`create-app.ts` 只消费门面。**门面签名（零参数不成立，装配有顺序依赖）**：

```ts
createMagicContextPlugin(options: Omit<MagicContextTurnTransformOptions, "usageRecorder"> & {
  resolveFallbackContextWindow: () => number | undefined;   // 新增，见下
}): Promise<{
  turnTransform: MagicContextTurnTransform | undefined;     // db_null / disabled 时为 undefined
  promptSection; toolDescription; usageRecorder; close;
}>
```

**返回 `Promise`**：`createMagicContextTurnTransform` 本身是 `async`（`magic-context-turn-transform.ts:1317-1319`），同步签名会让实现类型不符。

约束：
- `resolveFallbackContextWindow` **必须进契约**。它现在是 `createMagicContextUsageRecorder` 的第三参（`magic-context-turn-transform.ts:451-462`），由 create-app 传闭包（`create-app.ts:859-873`），是上下文窗口三源（env / e2e / R-2）的第二层。漏掉会让该层静默消失、退回 128k 默认值，改变 scheduler 决策——**违反「零行为」**。
- `usageRecorder` 由门面**构造并返回**，options 不再接收（现有 `MagicContextTurnTransformOptions` 含 `:291` 的同名项，须从 options 类型里剔除）。
- `turnTransform` 在 db_null / disabled 时是 `undefined`，返回类型必须写出来。
- `close` 与 `registerClose` 二选一：**保留 `registerClose`（构造期回填，时序依赖 `create-app.ts:878/:886` 早于 `:1118` 的注入），门面额外返回同一个 `close` 便于脚本使用**；不得让两者指向不同实现。
- `usageRecorder` 必须先于 `turnTransform` 构造（`create-app.ts:845` 早于 `:879`）。
- 单体实测 **8 个导出函数 + 若干常量/类型**（`:315,346,451,1034,1117,1185,1272,1317,1928`），`createZCodeMagicContextTurnTransformPort`（`:1928`）并入 `ports.ts` 并**进 shim 导出面**。
- `magic-context-historian.ts`、`magic-context-usage-summary.ts` 迁入 `magic-context/` 目录（它们目前是单体的静态依赖 `:187`/`:189`），并各留 shim。
- 装配门（`:826-844`）保持动态 import 形态。

**`magic-context-turn-transform.ts` 不删除，保留为 re-export shim**（只被动态 import，不破 IM1）。原因：11 个脚本硬编码该 dist 路径（`test-magic-context-turn-transform.mjs:89`、`test-settle-background.mjs:107`、`test-mural-media-blocks.mjs:99`、`test-prompt-surface-toolset-hash.mjs:95`、`test-magic-context-lifecycle.mjs:68`、`test-magic-context-config-rpc.mjs:66`、`test-magic-context-section-zh.mjs:270`、`magic-context/scripts/test-boot-busy-retry.mjs:97`、`test-e2e-live-all.mjs:152`、`diag-first-send-latency.mjs:52`），且 `test-magic-context-absent-event.mjs:368` 的 `FACTORY_MODULE_MARKER` 需要它存在（该文件中 `:95-101` 有 existsSync 预检，缺文件会先 throw，不会假绿——但 shim 保留后，marker 必须**改指真正的装配入口 `dist/app/magic-context/index.js`**，否则守卫只盯 shim，不覆盖生产入口）。

### phase-zero-load（IM1）

三处硬墙同时拆，单改任一处无效：

**W1 → 包内窄子路径 + 零依赖叶子**
- `magic-context/package.json` 新增 `"./host/config/schema"`（导出 `MagicContextConfigSchema` / `DEFAULT_MAGIC_CONTEXT_CONFIG` / `MagicContextConfig` 类型）。
- 新增 `magic-context/src/core/shared/prompt-surface-key.ts`：把 `isValidPromptSurfaceModelKey` 抽成零 import 叶子；`prompt-surface.ts` 改为从它 re-export 该函数（函数真身在 `:56`）。**属 `src/core/**` → 写 FORK 标记 + rebase 点**。
- `adapters/src/config/schema.ts:4-8` 改从窄子路径导入；`:65` 顶层求值**保留**。这也是 IM1 必须写成「M0 白名单之外零加载」而不是「零模块」的原因：`adapters` 的配置装载是每次启动必经路径，只要保留字段级校验，`schema.js` 就一定会被加载。M0 的最终成员以 Step 5 落地后的实测闭包为准，**预期 3 个文件（schema + language + prompt-surface-key）+ zod 4.6.5 闭包**。
- **叶子必须真正接上（否则闭包仍是 4 个文件）**：`magic-context/src/host/config/schema.ts:51` 现在是 `import { isValidPromptSurfaceModelKey } from "../../core/shared/prompt-surface.js"`，而 `prompt-surface.ts` 又拉 `harness-provider-map.js`。Step 5 必须把 `schema.ts:51` **改指新叶子 `prompt-surface-key.js`**，并把 `prompt-surface.ts` 的该函数实现改成从叶子 re-export。实测：`prompt-surface.ts:22` 是 `import { modelRefLookupOrder } from "./harness-provider-map.js"`（**既不是注释、也不是 re-export 点**），承载函数的是 `:56`——首轮我把它当注释写错了。

**W2 → 协议 handler 惰性化**
- **两种导入必须分列**（否则关态仍拉全图）：
  - **判 flag 只需 schema**：`magic-context-memories.ts:153` 的 `MagicContextConfigSchema.safeParse` 走窄子路径 `@zcode/magic-context/host/config/schema`（或 `@zcode/adapters/config` 的再导出 `schema.ts:341`）；
  - **业务符号**（memory-admin 等）才在 handler 内 `await import("@zcode/magic-context")`。
  `magic-context-config.ts` 同理：schema 走窄子路径，RPC 注册静态即可。
- `magic-context-memories.ts:166-169` 的自开库改为**向宿主取已装好的 handle**。注意：`openDatabase` 本来就是按 path 缓存的进程级单例（`storage-db.ts:2695-2719`），所以这里拿到的其实是**同一个** handle，不是第二个连接——真正的问题是「一条只读 RPC 会在 flag/装配缺席时创建并迁移 DB」。需要**新增**一个端口（当前全仓不存在 `getMagicContextStorage()`）：由装配层提供 `getInstalledMagicContextStorage(): { db } | null`，flag off / 包缺失 / 未初始化时返回 `null`，handler 在 `null` 时回 `unavailable` 信封而不开库。
- **观测面不可破**：`unavailableListResult`（`:172-186`）的信封语义必须保持——「包缺失」「开关关闭」「库不可用」三种情况都回同一 `supported:true` 信封，绝不出现 `-32603`（否则设置页崩）。

**W3 验收**：新增 `test-magic-context-zero-load.mjs`，在子进程里 `createApp()` 后断言 MC 模块计数为 0（关闭态），并对 M0 白名单外的 `@zcode/magic-context` import 抛错。

### phase-identity-guard（IM5，C2）

从 `git show ff8b4522` 取回上游已修的两条守卫：

- `originalPairsWithMessage(original, message)`：role 不符即断配对（`tool ↔ user` 折叠例外）→ 断配对后**仍调用** `rebuildEntry(message, undefined)`（不带模板），因此不会整拷 `original.metadata`、`inputPresentation` 不出现、`source` 退化为 `legacy_synthetic`。**不是「不调用 rebuildEntry」**——那样等于把条目直接丢掉（`ff8b4522` 的实际实现就是 `paired=undefined → rebuildEntry(message, paired)`）。
- `sanitizeRebuiltMetadata(metadata)`（**单参，按 `ff8b4522` 的实际形态**）：**永不继承 `inputPresentation`**；`source` 保留（§N§ 打标与气泡身份/cache 锚定依赖它）。不引入 `roleChanged` 参数——role 不匹配由 `originalPairsWithMessage` 在配对阶段就断掉，不走「重建后再剥」。`magic-context/package.json` 的新 exports 写成带 `types` 条件的同构对象（与现有 `.` 三条件形态一致），避免 `verbatimModuleSyntax` 下的邻接推断失败。
- 落点：`bootstrap/src/app/magic-context/projection.ts`（拆分后）的 `rebuildEntry` metadata 整拷行（原 `:788`、`:825`）。

**同时补齐身份不变量测试**（本树 `test-mc-entry-identity-guard.mjs` 不存在）：构造「投影下标漂移 → 同 id 换内容 + role 不符」的用例，断言重建条目不带 `inputPresentation`、下游 `provider-entry-origins.ts:44-76` 不将其识别为准入输入。

> 注：幽灵事故的 **B 线**（并发轮投影互踩 / `primaryTurnId` 缺失）属 `product-projection` 的会话上下文模型问题，**不并入本 spec**，另立条目跟踪。本 spec 只修 A 线（身份守卫）。

### phase-compartment-rewind（IM6，C1）

C1 的确切条件（四条同时成立）：① 缓存对 `cached_m0/m1_bytes` 非空且 `cached_m0_last_baseline_end_message_id` 指向 rewind 前的最后 compartment end（`:2752`、`:3268-3284`，只向前推进）；② 本轮 `preparedTrimBoundaryId` 取到该 id；③ rewind 只写 `session.revert` 不删库，该行仍在原始库且排在首个 live 行之后 → `classifyAbsentBoundary` 返回 `"refused"`（`:3705`）；④ MC 无任何 rewind 失效逻辑（全包搜 `rewind/revert` 仅两条注释）。

**先纠正一个载体误判：旧摘要活在 M0，不在 M1。** 链路是 `inject-compartments.ts:2490-2492` 调 `readM0Compartments(db, sessionId)`（`:2085-2098`，**按 session 全量、不按 rewind 过滤**）→ `renderM0`（`:2343-2351`）把这些 compartments 渲染进 `<session-history>`，即 **M0 本体**。M1 是 `renderM1WithMetadata`（`:2887-3019`）的 `<session-history-since>`，只含**新增** compartments + memory 增量 + new memories + new user profile。所以「refused 时不注入 M1」对 C1 无效，整条丢 M1 还会连带丢 memory 增量。

三处修法，缺一不可：

- **① host 侧按水位过滤（根）**：`fork-edit-retry.ts:106` 之后调 `invalidateMagicContextCompartments(sessionId, revert)`。**三个前提必须先解决，否则按字面实现不了**：
  - **revert 从哪来（已定案）**：`ConversationRewindResult`（`core/src/runtime/types.ts:639-647`）没有 `revert` 字段，**给它加**（最小改动、语义正确）；不要走「调用前读旧值」——调用返回后读到的就是新水位，不需要旧值。
  - **「标记」不会生效**：`readM0Compartments`（`inject-compartments.ts:2089-2095`）的 WHERE 只有 session_id，没有 `rebase_status` 过滤，`renderM0` 也不看 `rebaseStatus`——标成 `unresolved` 的旧 compartment **仍会进 `<session-history>`**。因此必须二选一：host 侧 **DELETE 水位之后的行**，或改 `readM0Compartments` 加 WHERE（`src/core/**` 改动，FORK 登记 + rebase 点）。本 spec 选**后者**（DELETE 会丢摘要，且 MC 的 tag/绑定依赖这些行）。
  - **只覆盖 v4 edit/retry 不够**：TUI 的 `/rewind` 走 `core/src/runtime/methods/turn.ts:219-220 → rewind.ts:83 → rewind-message.ts:397`（同样 `setRevert`）而没有 host 失效调用。必须**收窄 C1 的范围为「v4 编辑重发/重试路径的 rewind」**并同步 IM6/T-MC9，否则 T-MC9 在 TUI 路径上覆盖不到。
  同时清 `session_meta` 缓存（`cached_m0_bytes`/`cached_m1_bytes`/`cached_m0_last_baseline_end_message_id`）与 `clearInjectionCache`（`:124-125`，现在只清内存）。**仅清缓存不够**——M0 会从同一批旧 compartments 重渲染，旧摘要照旧复现。
- **② 惰性接缝（否则破坏 IM1）**：调用点在启动即加载的静态图里（`server.ts:101 → v4-bridge.ts:29 → commands/executor.ts:7 → commands/handlers/index.ts:4 → fork-edit-retry.ts`），直接静态 import 会新增第 7 处静态值导入。改为**可选端口注入**：`record.app.invalidateMagicContextCompartments?`，由 `create-app.ts` 在装配成功时挂上，`fork-edit-retry.ts` 只调可选方法（不存在即跳过）。
- **③ core 侧兜底（只掐块，不掐整条）**：`injectM0M1` 的 unshift（`:3903-3917`、`:4188-4195`）在 `prefixTrimStatus === "refused"` 时**只抑制 `<new-compartments>` 块**，不抑制整条 M1（M1 还承载 memory 增量）；`boundary-precedes-window` 不动（见 IM6）。`src/core/**` 改动写 FORK 标记 + rebase 点，并在 `UPSTREAM-SYNC.md` 登记。

验收：T-MC9 断言 rewind 后下个 turn 的 provider 请求里 **M0 的 `<session-history>`** 不含被裁轮次的摘要文本——只断言 M1 会假绿。

### phase-unplug（IM2）

- **包缺失分支：删掉 `package_missing`。** 首轮设计它是为了「删包也不崩」，但复核后不可达：`adapters/src/config/schema.ts:4-8` 的静态值导入在配置装载阶段（早于 `create-app`）就会抛 `ERR_MODULE_NOT_FOUND`，而 SEA / desktop bundle 里 MC 是 external（`cli/scripts/build.mjs:24`、`stage-agent-bundle.mjs:31`），第一个静态 require 就在 config 装载失败，走不到 `create-app.ts:829` 的动态 import catch。保留它等于留一条永远不执行的分支 + 一个没有执行对象的 `qa:auto`。IM2 的「删包后正常启动」**只由摘除脚本承载**：`create-app.ts:836` 的 rethrow 改按 `absent(import_failed)` 记录（仅覆盖「动态 import 失败」这一真实可达场景）。
- **摘除脚本** `apps/zcode-cli/packages/cli/scripts/unplug-magic-context.mjs`：dry-run 优先。清单**必须由 `grep -rn "@zcode/magic-context"` + `grep -rn "MagicContext"` 生成并逐项确认**，下面是实测全量（首诊已核）：
  - **静态值导入 6 处**：`adapters/src/config/schema.ts:8`、`bootstrap/src/app/magic-context-historian.ts:85`、`magic-context-turn-transform.ts:182`、`magic-context-usage-summary.ts:43`、`bootstrap/src/zcode-protocol/magic-context-config.ts:3`、`magic-context-memories.ts:92`
  - **静态 type-only 1 处**：`magic-context-prompt-section-zh-cn.ts:34`
  - **`typeof import` 11 处**：`format-ctx-status.ts:24`、`run-ctx-command.ts:146,210,219,230,242,268,297`、`ctx-context.ts:48`、`ctx-memory.ts:53`、`ctx-search.ts:60`
  - **适配层再导出 1 处**：`adapters/src/config/schema.ts:341`
  - **contracts 8 处**：`contracts/src/config/index.ts:38,44,134,177-187,264,277,320,375`
  - **services 转发层**：`zcodeAgentService.ts` **37 处**、`zcodeAgent.ts` **21 处**
  - **UI 7 文件**：`settings/MagicContextSettingsSection.tsx`、`MagicContextSettingsFields.tsx`、`magicContextSettingsForm.ts`、`MemoryManagementSection.tsx`、`chat-input-toolbar/magicContextUsageRows.ts`、**`SettingsPage.tsx:58,1271`**、**`chat-input-toolbar/contextUsage.tsx:17,31,212,275`**；另有 **`v4/composer/V4ComposerToolbar.tsx:562`** 与 **`packages/ui/test/magicContextPromptSurfaceOverrides.test.ts:54`**
  - **CLI 命令面**：`cli/src/command-center/handlers/ctx.ts` + `bootstrap/src/zcode-protocol-v4/commands/handlers/ctx.ts` + `bootstrap/src/ctx-commands/**` 本体 + `bootstrap/package.json:13-16` 的 `./ctx-commands` 子路径导出
  - **core ctx 工具面**：`core/src/tool/handlers/index.ts:64-66`（静态 import 三个 ctx handler）+ `:322`（注册门）、`runtime/helpers/runtime-tools.ts:126,133`（string-keyed 门）、`tool/handlers/ctx-{context,memory,search}.ts` 的调用期 `await import`
  - **bootstrap 装配面**：`create-app.ts`（装配门 / absent / `isMagicContextEnabled`）、`runtime-config.ts`（调 gate）
  - **构建/打包/门禁**：4 个 `package.json` 的 `workspace:*`、`knip.json:30-36`、`build.mjs:14-27` external、`sea-tui-assets.mjs:129-166` deferred 段、`stage-agent-bundle.mjs:21-31`、`build-desktop-agent-cli.mjs:33-36`
  - **协议面**：4 组 RPC schema + 方法名、4 个 v4 命令、4 个 ctx 工具与 3 处 string-keyed 门、2 个 locale 的 46+10 条 ×2
- **数据面归档**：`--archive-db` 把 `~/.omz/cli/db/magic-context.db{,-wal,-shm}` 移到 `~/.omz/backup-<ts>/`。**不自动改配置**：根 schema 是 `.passthrough()`（`adapters/src/config/schema.ts:333`），残留的顶层 `magicContext` 块既不报错也不被 strip，因此只打印提示建议用户自行清理 `features.magicContext` 与 `magicContext`。
- 验收**顺序不可换**：临时 checkout 上跑 `--apply` → **`pnpm typecheck`** → **`pnpm exec turbo --cwd apps/zcode-cli run typecheck --force`** → **`pnpm exec turbo --cwd apps/zcode-cli run lint`** → 全部非 MC 测试 → `createApp()` 起得来 → 设置页不回 `-32603`。**根 `pnpm typecheck` 只跑 `packages/*` 的 `tsc -b`，不含 `apps/zcode-cli`；根 `oxlint` 的 ignorePatterns 也含 `apps/zcode-cli`** —— 不加这两条 turbo 命令，主战场（bootstrap/core/adapters 全在 apps/zcode-cli 下）根本不会被检查，T-MC10 会假绿。services 与 ui 两面必须**同批删**。

### phase-upgrade-surface（IM7）

- `UPSTREAM-SYNC.md:119` 的过期口径（「5 静态 + 2 动态 = 7 处」）改为实测值：**6 静态值 + 1 静态 type-only + 4 动态 + 11 处 `typeof import` 类型位**。
- FORK 标记机读化：统一语法 `FORK(<scope>): <reason>`；现测大写 `FORK` 口径为 core 120 处 / 68 文件、host 41 处 / 5 文件（research 的 294/75 是忽略大小写口径，含散文里的 "fork"，不可复现）。
- 新增 `test-magic-context-coupling-budget.mjs`：散点数量上限写死（按本 spec 落地后的实测值），超限即失败。

### phase-gates

- 接线未挂的测试：`test-magic-context-lifecycle.mjs`、`test-magic-context-ui-config.mjs`、`test-magic-context-ui-model-picker.mjs` 当前不在任何 script/CI 里。
- **29 个 MC 相关脚本没有 CI 执行点**（`.github/workflows/` 只有 `release-desktop.yml` 构建用到 MC）。
- `test-magic-context-gate.mjs` 早期的源码形状守卫是字符串包含判定，注释里提到函数名也会通过 → 升级为**剥注释 + 逐行正则**判定（**定案：不做 AST**，与全仓源码形状守卫同口径；覆盖边界见 Step 16）。

## 最终项目结构

```
apps/zcode-cli/packages/magic-context/
  package.json                                         改（新增窄子路径 exports）
  src/core/shared/prompt-surface-key.ts                 新增（零依赖叶子）
  src/core/shared/prompt-surface.ts                     改（re-export 该叶子）
  src/core/hooks/magic-context/inject-compartments.ts   改（读侧 WHERE + 掐 `<new-compartments>` 块 + 缓存回放过滤；FORK 登记）
  src/host/compartment-invalidation.ts                  新增（rewind 失效 compartment 缓存）
apps/zcode-cli/packages/bootstrap/src/app/
  magic-context/effective-enabled.ts                     新增（更名自 gate.ts）
  magic-context/{index,types,usage,projection,storage,ports,assembly,settle}.ts  新增（拆分）
  magic-context-turn-transform.ts                        改为纯 re-export shim，**保留完整旧导出面**（`export *` 自各新模块，不只门面）：脚本需要的 8 个导出（`createMagicContextTurnTransform`、`createZCodeMagicContextTurnTransformPort`、`createMagicContextUsageRecorder`、`createMagicContextPromptSectionResolver`、`describeStorageUnavailability`、`openMagicContextStorageWithBusyRetry`、`pushMagicContextUsageSummary` 等）一个都不能少，`test-magic-context-absent-event.mjs:106` 直接从该路径 import `describeStorageUnavailability`
  magic-context-historian.ts / magic-context-usage-summary.ts  迁入该目录，**同时各自留一个 re-export shim**（`test-magic-context-historian.mjs:67-69`、`test-magic-context-usage-projection.mjs:70-72` 硬编码了这两个 dist 路径）
  magic-context-absent-event.ts                          改（reason 只保留 `disabled|import_failed|db_null:*`，**不加 `package_missing`**）
  create-app.ts                                          改（门面消费 + 包缺失降级 + 判定复用）
  runtime-config.ts                                      改（调 effective-enabled）
apps/zcode-cli/packages/bootstrap/src/zcode-protocol/
  server.ts                                              改（两 handler 惰性化）
  magic-context-config.ts                                改（去顶层值 import）
  magic-context-memories.ts                              改（惰性 + 复用注入 handle）
apps/zcode-cli/packages/adapters/src/config/schema.ts    改（窄子路径）
apps/zcode-cli/packages/core/src/runtime/
  methods/rewind-message.ts                              **不改**（compartment 失效由 host 侧 fork-edit-retry.ts:106 调用；IM4 禁止 core 运行时值 import）
  helpers/{runtime-tools,magic-context-prompt-section,magic-context-turn-transform}.ts  改（判定收口）
apps/zcode-cli/packages/cli/scripts/unplug-magic-context.mjs  新增
apps/zcode-cli/packages/bootstrap/scripts/
  test-magic-context-zero-load.mjs                       新增
  test-magic-context-coupling-budget.mjs                 新增
  test-magic-context-gate.mjs                            改（剥注释 + 正则守卫 + 入库；覆盖边界见 Step 16）
  test-mc-entry-identity-guard.mjs                       新增
UPSTREAM-SYNC.md                                         改（口径修正 + FORK 语法 + rebase 点登记）
```

## 变更点清单

| # | 不变式 | 文件 | 改动 |
|---|---|---|---|
| 1 | — | `bootstrap/package.json` + `scripts/test-magic-context-gate.mjs` | 基线入库（现为 untracked，干净 checkout 必挂） |
| 2 | IM3 | `app/magic-context/gate.ts` → `effective-enabled.ts` | 更名去两义；导出 `resolveMagicContextEffectiveEnabled` |
| 3 | IM3 | `app/magic-context/effective-enabled.ts` | 新增冷值投影 `projectMagicContextEffectiveEnabled()`：只读 `RuntimeConfig.magicContext.enabled` 这一位**已算出**的冷值，不重算三轴；入参用具名类型（唯一允许 `resolveAppRuntimeConfig` 的返回值），同源守卫钉「生产代码只允许 `create-app.ts` 一处、实参必须是 `runtimeConfig`」 |
| 4 | IM3 | `create-app.ts`（按符号定位，不写死行号：`projectMagicContextEffectiveEnabled(runtimeConfig)` 那一处） | 三处同一求值收敛为一次调用并复用同一个布尔：装配门 `if (magicContextEffectiveEnabled)`、工厂 `enabled:` 入参、`isMagicContextEnabled` 契约 |
| 5 | IM3 | `core/.../{runtime-tools,magic-context-prompt-section,magic-context-turn-transform}.ts` | 真值来源统一为同一投影函数，但**各自保留原有 undefined 语义**（三者方向不一致，见 T-MC1），不合并成单函数 |
| 6 | — | `app/magic-context-turn-transform.ts`（2240 行） | 拆为门面 + 八文件，守五条零行为不变量；原文件保留为全导出面 shim |
| 7 | IM1 | `magic-context/package.json` | 新增 `./host/config/schema` 窄子路径 |
| 8 | IM1 | `core/shared/prompt-surface-key.ts`（新）+ `prompt-surface.ts` | 抽零依赖叶子，压窄 schema 子路径闭包 |
| 9 | IM1 | `adapters/src/config/schema.ts:4-8` | 改走窄子路径 |
| 10 | IM1 | `zcode-protocol/magic-context-config.ts:3`、`magic-context-memories.ts:80-92` | 去顶层值 import，handler 内惰性 |
| 11 | IM1 | `magic-context-memories.ts:166-169` | 自开库改为复用注入 handle |
| 12 | IM5 | `app/magic-context/projection.ts` | 加 `originalPairsWithMessage` + `sanitizeRebuiltMetadata`（取 `ff8b4522`） |
| 13 | IM6 | `core/hooks/magic-context/inject-compartments.ts:2089-2095`（**读侧 WHERE，根修**）、`:2939-2945`（`<new-compartments>` 块构建点）、`:3865-3891`（缓存回放路径） | ①`readM0Compartments` 加 `rebase_status`/水位 WHERE（**否则 host 侧「标记」不生效，整修是空的**）；②refused 时只抑制 `<new-compartments>` 块，不抑制整条 M1；③缓存回放路径必须同样过滤，否则 `prepareCachedM0M1Replay` 会原样重放带块文本。FORK 登记 |
| 14 | IM6 | `magic-context/src/host/compartment-invalidation.ts`（新）+ `fork-edit-retry.ts:106` + `create-app.ts`（挂可选端口） | rewind 后**按 revert 水位过滤 DB 层 compartment 记录**（M0 的 `readM0Compartments` 才不会再吐出旧摘要）+ 清 `session_meta` 缓存与 injection cache；**不改 core 的 `rewind-message.ts`** |
| 15 | IM2 | `create-app.ts:836` | 动态 import 失败降级为 `absent(import_failed)` 并记录，不 throw（**不引入 `package_missing`**，见 phase-unplug） |
| 16 | IM2 | `cli/scripts/unplug-magic-context.mjs`（新） | 一键摘除 + `--archive-db` |
| 17 | IM7 | `UPSTREAM-SYNC.md:119`、FORK 语法 | 口径修正 + 机读化 |
| 18 | IM7 | `bootstrap/scripts/test-magic-context-coupling-budget.mjs`（新） | 散点数量上限门禁 |
| 19 | IM1 | `bootstrap/scripts/test-magic-context-zero-load.mjs`（新） | 关闭态「M0 白名单之外零模块」断言 |
| 20 | IM5 | `bootstrap/scripts/test-mc-entry-identity-guard.mjs`（新） | 身份不变量回归 |
| 21 | — | `bootstrap/package.json`、CI 配置 | 接线 3 个未挂测试 + 补 CI 执行点 |

## 详细实现步骤

- Step 1 — phase-0-baseline — blocking: yes — qa: auto：`git add` 现有 wave-1 三改一新增，`test:magic-context-gate` 入库并可跑；`gate.ts` 更名 `effective-enabled.ts`，同步 `runtime-config.ts`、`magic-context-memories.ts`、测试文件引用。
- Step 2 — phase-effective-single — blocking: yes — qa: auto：bootstrap 三处同一求值收敛；core 三处统一真值来源但**保留各自 undefined 语义**；补两张真值表测试（bootstrap 三轴 / core 布尔投影）。
- Step 3 — phase-facade — blocking: yes — qa: auto：先落 `types.ts` + `usage.ts` + `storage.ts` + `projection.ts`（纯函数与既有测试对齐），再落 `ports.ts` + `assembly.ts` + `settle.ts` + `index.ts`；**本步结束必须零行为**（现有 MC 测试族全绿）。
- Step 4 — phase-facade — blocking: yes — qa: auto：`create-app.ts` 改消费门面；`magic-context-turn-transform.ts` 改为**完整旧导出面**的 re-export shim（**不删**，8 个导出一个不少）；`test-magic-context-absent-event.mjs:368` 的 `FACTORY_MODULE_MARKER` **改指新入口 `dist/app/magic-context/index.js`**（否则守卫只盯 shim，生产入口不再受保护）；实测模块数与内存不退化。
- Step 5 — phase-zero-load — blocking: yes — qa: auto：包内新增窄子路径 + 抽零依赖叶子（**目标闭包 = 3 个文件：schema + language + prompt-surface-key，外加 zod 4.6.5 闭包**）；**`schema.ts:51` 必须改指 `prompt-surface-key.js`**，否则闭包仍是 4 个文件；`adapters/src/config/schema.ts` 改导入（顺序必须先改包、后改宿主）。
- Step 6 — phase-zero-load — blocking: yes — qa: auto：两个 handler 惰性化 + memories 复用注入 handle；保持 `supported:true` 信封三态一致。
- Step 7 — phase-zero-load — blocking: yes — qa: auto：`test-magic-context-zero-load.mjs` 落地，断言**M0 白名单之外**模块计数为 0（`module.register` resolve hook 记录），M0 内 ≤ 实测上限并写死。
- Step 8 — phase-identity-guard — blocking: yes — qa: auto：从 `ff8b4522` 取回双守卫，落到拆分后的 `projection.ts`。
- Step 9 — phase-identity-guard — blocking: yes — qa: auto：`test-mc-entry-identity-guard.mjs` 落地（下标漂移 + role 不符用例）。
- Step 10 — phase-compartment-rewind — blocking: yes — qa: auto：`compartment-invalidation.ts`（**DB 层按 revert 水位过滤**，不止清缓存）+ `record.app.invalidateMagicContextCompartments?` 可选端口 + `create-app.ts` 挂载 + `fork-edit-retry.ts:106` 调用。（**不改 core 的 `rewind-message.ts`**；静态 const import 会新增第 7 处静态值导入并破坏 IM1。）
- Step 11 — phase-compartment-rewind — blocking: yes — qa: auto：**core 读侧** `readM0Compartments`（`:2089-2095`）加水位/`rebase_status` WHERE + `<new-compartments>` 块在 refused 时抑制（`:2939-2945`）+ 缓存回放路径（`:3865-3891`）同样过滤；写 FORK 标记与 rebase 点；补「rewind 后 **M0 的 `<session-history>`** 不含旧摘要」用例（只测 M1 会假绿）。
- Step 12 — phase-unplug — blocking: yes — qa: auto：`create-app.ts:836` 的 `absent(import_failed)` 降级路径。（**不再验证「人工移走 node_modules 仍能启动」**——`adapters/src/config/schema.ts:4-8` 会先在配置装载阶段抛 `ERR_MODULE_NOT_FOUND`，该场景由 Step 13 的摘除脚本承载。）
- Step 13 — phase-unplug — blocking: yes — qa: auto：`unplug-magic-context.mjs`（dry-run + `--apply` + `--archive-db`），在临时 checkout 上端到端跑通。
- Step 14 — phase-upgrade-surface — blocking: yes — qa: auto：`UPSTREAM-SYNC.md` 口径修正 + FORK 语法 + rebase 点登记。
- Step 15 — phase-upgrade-surface — blocking: yes — qa: auto：`test-magic-context-coupling-budget.mjs` 落地，上限取本 spec 落地后的实测值。
- Step 16 — phase-gates — blocking: yes — qa: auto：接线 3 个未挂测试；**新建 `.github/workflows/mc-tests.yml`** 承载 29 个 MC 脚本；`test-magic-context-gate.mjs` 守卫升级为**剥注释 + 逐行正则**判定（不是 AST，与全仓的源码形状守卫同口径）。覆盖边界写死：正则只认字面形态（比较 / 取反 / 真值化），不识别类型层面的别名与间接调用（`const f = () => cfg.magicContext.enabled; f()`），这类写法靠评审兜住；守卫入口另有一道扫描面断言（三个扫描根存在 + 扫描文件数下限 + 已知锚点在列），杜绝脚本被移动后的「零扫描通过」假绿。
- Step 17 — phase-gates — blocking: no — qa: manual_user：真机验证（关闭态启动快、设置页可开、`/ctx-status` 有明确不可用提示、rewind 后模型不再看到旧摘要）。

## 测试策略

### 测试用例

- T-MC1 — blocking: yes — **IM3 真值一致（两张表，非一张）**：bootstrap 侧三轴表（`featureFlag × overrideEnabled × domainEnabled`）与 core 侧布尔投影表（单入参 `enabled`）**在同一测试文件里逐行对齐**。必须写死 `undefined` 语义：`runtime-tools.ts:126` 用 `=== true`（undefined→关）、`magic-context-prompt-section.ts:84` 用 `!== true`（undefined→关）、`magic-context-turn-transform.ts:234` 用 `=== false`（undefined→开，以端口在场为前提）——三者今天方向不一致，收口必须显式选择并记录，不得静默改变其中一处行为。G8 保留「端口在场 + `isEnabled()` 优先、config 只做否决」的现有结构，不并入单一函数。
- T-MC2 — blocking: yes — **IM3 热生效**：设置页关闭后下个 turn 即落地，三条可断言事实：①下一 turn 的 transform 端口**未被调用**（或返回 `input.entries` 原引用，逐引用相等）；②`magic_context.{usage_recorded,usage_skipped,wire,settle_*}` 事件不再出现——**必须排除 `transform_absent`**（那是装配期信号，`magic-context-turn-transform.ts:1331-1337`）以及 `zcode_protocol.magic_context.config_updated` 前缀；③不新增 `session_meta` 写入。**不得断言 `includeMagicContextTools === false`**——它读装配期冻结的 `runtime.config`（`runtime-tools.ts:126`），热值只在端口 `isEnabled()`（`:1611`），工具可见性另行门控。**不得用 `getToolSetHash`**（由 `promptSurfaceConfigIdentity` 派生，与 enabled 无关）。
- T-MC3 — blocking: yes — **IM1 白名单零加载**：关闭态 `createApp()` 后，用仓库既有范式（`module.register` resolve hook，见 `test-magic-context-absent-event.mjs:94,368,452-461`）记录解析；断言 M0 内模块数 ≤ 实测上限，M0 外（`src/core/**`、`src/host/memory-admin.js` 等）为 0。**不用 `process.moduleLoadList`**（Bun 专有，本仓是 `node --test`）。
- T-MC4 — blocking: yes — **IM1 单点**：只改 W1 时 M0 外计数 > 0（因协议 handler 仍静态挂载）；只改 W2 时 `adapters` 侧仍拉全图。两者都必须失败，防止回归成半修。
- T-MC5 — blocking: yes — **信封一致**：业务符号惰性 import 失败 / 开关关闭 / 库不可用三态下 `listMagicContextMemories` 均回同一 `supported:true` 信封，无 `-32603`。
- T-MC6 — blocking: yes — **IM5 配对守卫**：投影下标漂移使同 id 换内容且 role 不符时，`rebuildEntry(message, undefined)` **被调用但无模板**；结果无 `inputPresentation`、`source` 退化为 `legacy_synthetic`。断言重建走无模板路径，**不断言「不调用 rebuildEntry」**。
- T-MC7 — blocking: yes — **IM5 身份不继承**：重建条目永不带 `inputPresentation`；`source` 保留。
- T-MC8 — blocking: yes — **IM6 悬挂摘要（两态分立）**：①`prefixTrimStatus === "refused"` 时**不注入 M1 的 `<new-compartments>` 块**（M1 其余内容——memory 增量 / new memories / user profile——照旧注入）、缓存被清；②`boundary-precedes-window` 时 M1 **整条照旧**（该态下 M1 可能是窗口外历史的唯一载体）。两态分开断言，不得合并。
- T-MC9 — blocking: yes — **IM6 覆盖分两条**：①**M0 无旧摘要**（host 侧根修 + 读侧 WHERE）：**在 v4 编辑重发/重试路径**上 rewind 后，下个 turn 的 provider 请求里 `<session-history>`（M0）不含被裁轮次的摘要文本（**范围按 phase-compartment-rewind 的定案收窄**——TUI `/rewind` 没有 host 失效调用，不在此断言）；②**窗口内原文不被替代/重复**（core 侧兜底）。
- T-MC10 — blocking: yes — **IM2 摘除**：临时 checkout 执行 `--apply` 后依次通过 **`pnpm typecheck`** + **`pnpm exec turbo --cwd apps/zcode-cli run typecheck --force`** + **`pnpm exec turbo --cwd apps/zcode-cli run lint`** + 非 MC 测试，`createApp()` 可启动。前两条缺一不可：根 `typecheck` 只跑 `packages/*`，根 `oxlint` 的 ignorePatterns 含 `apps/zcode-cli`。
- T-MC11 — blocking: yes — **IM2 数据归档**：`--archive-db` 后原路径不再有 db 文件，备份目录含 `-wal`/`-shm`。
- T-MC12 — blocking: yes — **IM7 预算**：散点数量超上限即失败（上限为本 spec 落地后的实测值）。
- T-MC13 — blocking: yes — **零行为拆分**：facade 拆分前后 MC 既有测试脚本结果逐条一致。**脚本清单按实测 29 个固定**（`magic-context/scripts/` 13 + `bootstrap/scripts/test-magic-context*.mjs` 12 + core/adapters 命名脚本 4），不写「约 30」。**CI 落地对象必须新建**：`.github/workflows/` 现只有 `release-desktop.yml`（bundle/attach，**无 test job**），需新增 `mc-tests.yml` 承载这批脚本，否则 Step 16 无处可挂。
- T-MC14 — blocking: yes — **时序不变量**：`registerClose` 为 `drain → shutdown → dispose` 且早于 `closeSessionResources`；`settlesInForeground` 只求值一次。

夹具约束：T-MC1/6/7/8/9 为纯函数级单测（不进 DB）；T-MC3/4 用子进程 + 模块计数；T-MC10/11 在临时 checkout（`git worktree`）上跑，不污染主工作树。

## 风险与回滚方案

### 风险

1. **facade 拆分是最大面**：2240 行、五条零行为不变量。任何一条破了都会静默失效（尤其 deps 同引用 → 热生效与 toolset 指纹）。缓解：Step 3/4 分两次提交，Step 3 不碰 `create-app.ts`；拆分前后跑同一批测试比对结果。
2. **改 `src/core/**` 两处**（`prompt-surface-key.ts` 抽取、`injectM0M1` 受约束）会破坏「逐字重放」，成为每次升版的 rebase 点。已按 #135 登记，但需在 `UPSTREAM-SYNC.md` 写明偏离理由。
3. **窄子路径形成新的升级耦合**：`host/config/schema` 子路径的闭包是包内文件，上游改 `host/config/schema.ts` 结构会打断该 exports。缓解：子路径只导出 schema 常量与类型，不导出行为。为将来加第三文件留缓冲——Step 5 先加仓内 import 守卫测试，稳定后再做。
4. **C1 双保险里的 host 侧清缓存**：`session_meta` 的三个 cached 列被清后，下一轮会重渲染摘要（多一次模型调用）。需在 spec 落地时确认 historian 的重渲染成本可接受；若不接受，退化为「只清 injection cache + core 侧不注入」。
5. **阶段间依赖顺序**：Step 5 必须先包后宿主，Step 10 依赖 Step 3 的 `storage.ts`/`settle.ts` 已就位。
6. **不可逆数据面**：摘除脚本务必 dry-run 优先、`--archive-db` 幂等；`fail_closed_blocking` 的清理不能漏，否则配置语义静默丢失。
7. **测试预算**：新增 4 个脚本 + 接线 3 个 + CI 接入 29 个，运行时间会上升；`test-magic-context-zero-load.mjs` 需子进程拉起，单次约数秒，放 CI 而非本地 pre-commit。

### 回滚

各 phase 独立提交、独立 revert：

- phase-facade 回滚 = 恢复单体（`create-app.ts` 同时回滚）；
- phase-zero-load 回滚 = 窄子路径可留（无害），宿主侧两处 import 改回静态；
- phase-identity-guard 回滚 = 恢复无条件整拷（症状回归但系统可跑）；
- phase-compartment-rewind 回滚 = host 侧失效停用（core 侧 FORK 保留，需同步 UPSTREAM-SYNC 说明）。

回滚**不建议**动：phase-gates（门禁是防复发的唯一保障）、phase-upgrade-surface 的口径修正（纯文档）。
