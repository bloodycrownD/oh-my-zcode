# prompt-surface + 211 行段证据包（bugfix-batch-20261011 / Step 12-14 / impl-prompt-surface）

- head_sha: e81dc870（Step 14；三点序列见「提交记录」）
- 生成节点: impl-prompt-surface
- 上游对照源: `.reference/magic-context/packages/plugin/src/{shared/prompt-surface,shared/prompt-surface-runtime,shared/model-resolution,agents/magic-context-prompt,tools/light-descriptions}.ts`
- 提交序列（pathspec 仅本节点文件，LF，正文 `-F <utf8 文件>` 传入）:
  - bc7a20d7 `[Step 12]` prompt-surface 真身归位（D6/D1/D7）+ light 描述随行移植
  - 09b52efe `[Step 13]` `## Magic Context` 段注入（D1 宿主侧）+ 原生 # Memory 段互斥
  - e81dc870 `[Step 14]` 设置面消费：prompt_surface preset 分档工具描述 + per-model 覆盖只读呈现

## 三态 FORK 处置表

| # | 上游文件（163/284/244/211/13 行） | 处置 | fork 落位 | git 呈现 |
|---|---|---|---|---|
| D6-a | `shared/prompt-surface.ts` | ① 壳缝：git mv + 内容整体替换 + FORK-NOTE | `core/shared/prompt-surface.ts`（162 行） | D+A（共享行 <20%） |
| D6-b | `shared/prompt-surface-runtime.ts` | ① 壳缝：git mv + 内容整体替换 + FORK-NOTE | `core/shared/prompt-surface-runtime.ts`（266 行） | D+A |
| D1 | `agents/magic-context-prompt.ts` | ① 壳缝：git mv + 内容整体替换 + FORK-NOTE | `core/agents/magic-context-prompt.ts`（210 行） | D+A |
| D7 | `shared/model-resolution.ts` | ② 全覆盖缝：git mv + 缝头改写 FORK-NOTE（三个 type 逐字不变） | `core/shared/model-resolution.ts`（13 行） | R100 |
| D6-c | `tools/light-descriptions.ts` | ③ 无缝新移植 + FORK-NOTE（5 常量搬 4） | `core/tools/light-descriptions.ts` | A |

### 逐字保真核对（归一化 CRLF→LF、剥 import 的 `.js` 后缀后逐字节比对）

| 文件 | 结果 |
|---|---|
| `magic-context-prompt.ts`（剥 FORK-NOTE 头） | **IDENTICAL** 210 行 |
| `prompt-surface-runtime.ts` 的 `markerCount` 及之后 | **IDENTICAL** 164 行 |
| `prompt-surface.ts` | 仅 1 处 oxfmt 换行差异（`promptSurfaceConfigIdentity` 的链式箭头），语义相同；壳在 HEAD 即为该换行形态 |
| `light-descriptions.ts` 四条常量 | **IDENTICAL**（逐常量比对） |
| `model-resolution.ts` | 三个 type 的注释带 `Verbatim:` 标注，逐字不变（壳本身就是从上游 :1/:3-8/:10 摘的） |

`prompt-surface-runtime.ts` 的三处显式差异（文件头差异注 ①②③）：
① `resolveUserConfigDirectory` 折叠成 `~/.omz/cli` 一行——上游 `cortexKitUserConfigBasePath` /
`resolveLegacyConfigSourcesForHarness` / `detectConfigFile` 三个依赖（含 `config/migrate-config-location`
与 `jsonc-parser` 两个上游模块）一并去掉；② 删除只服务 legacy 目录探测的 `harness` / `directory`
选项；③ `ACTIVE_TOOL_IDS` / `LIGHT_TOOL_DESCRIPTIONS` 去掉 `ctx_note`（N2）。

## 引用改指清单（纯 import 行 1:1）

| 引用方 | 旧 | 新 |
|---|---|---|
| `hooks/magic-context/transform.ts` | `../../deferred/model-resolution.js` | `../../shared/model-resolution.js` |
| `hooks/magic-context/transform.ts` | `../../deferred/prompt-surface.js` ×2 | `../../shared/prompt-surface.js` / `prompt-surface-runtime.js` |
| `hooks/magic-context/transform-compartment-phase.ts` | `../../deferred/model-resolution.js` | `../../shared/model-resolution.js` |
| `hooks/magic-context/compartment-runner-historian.ts` | 同上 | 同上 |
| `hooks/magic-context/compartment-runner-types.ts` | 同上 | 同上 |
| `hooks/magic-context/inject-compartments.ts:2` | `../../deferred/magic-context-prompt.js` | `../../agents/magic-context-prompt.js` |
| `host/config/schema.ts` | Step 11 的 `isValidPromptSurfaceModelKey` 本地副本（23 行） | `../../core/shared/prompt-surface.js` 真身 import |

barrel `src/index.ts` 扩 4d 节（带注释块：为何出这个面 + 宿主不得自抄 + 引批号），覆盖
`buildMagicContextSection` / `SELF_TAG_GUIDANCE` / preset 解析六件套 / prompt-surface runtime
七件套 / D7 三个 type。

## `## Magic Context` 段注入链路（Step 13）

```
bootstrap（唯一 import 包；features.magicContext 开时动态 import 本模块）
  createMagicContextPromptSectionResolver({ configPort, configDomain, logger })
    │  每次调用现读 ConfigPort → MagicContextConfigSchema.safeParse
    │  → createPromptSurfaceRuntime().resolveGuidance(config.prompt_surface, modelKey)
    │  → buildMagicContextSection(null, 0, ctxReduceCallable, false×3, subagentMode,
    │                             language, memory.enabled, preset, primaryOverride)
    ▼  AgentRuntimeDeps.magicContextPromptSection
core AgentRuntime（零包依赖；只判空 + 收集自己那份活值）
  resolveMagicContextPromptSection(runtime, model)
    │  modelKey ← `${model.providerId}/${model.modelId}`
    │  ctxReduceCallable ← getTools(model).some(t => t.name === "ctx_reduce")   ← 注册事实，非 flag
    │  subagentMode ← config.taskType === "subagent_child"
    ▼  ContextBuilderConfig.magicContextSection（成品字节）
ContextBuilder.build()
  buildMagicContextSectionEntry(content) → source:"magic_context" / system / dynamic
    段在场 ⇒ 原生 `# Memory` 段退场 + MEMORY.md 索引块不进 meta_user（互斥）
```

11 参映射：`agent`=null（ZCode 无 agent 名概念）；`legacyProtectionCount`=0（上游同款，参数未使用）；
`ctxReduceCallable`=工具注册事实；`dreamer/temporal/caveman`=false（N3 + transform 侧两个
`deps.experimental*` 从未被 bootstrap 填过，恒 undefined——开着就是在描述不存在的管道）；
`subagentMode`=taskType；`language`=runtime config；`memoryEnabled`=`memory.enabled` 活值；
`preset`/`primaryOverride`=prompt-surface runtime。

已知偏差登记：`ctx_note` 在 211 行段文案里被无条件引用（`CTX_NOTE_GUIDANCE` 及 light 变体），
ctx_note 工具按 N2 终局不做。本节点按 spec Step 18 口径不动逐字常量，仅在文件头登记；
`light-descriptions.ts` 的 `CTX_MEMORY_LIGHT_DESCRIPTION` 末句同样引用 ctx_note（惰性），
由 `test-prompt-surface.mjs` 的「tool references close against the ZCode tool surface」
把豁免集钉成 `["ctx_note"]`——豁免集长大时该断言红。

## preset 分档链路（Step 14）

```
createMagicContextToolDescriptionResolver({ configPort, configDomain, logger })
  → (input:{toolId, fullDescription, modelKey?}) => resolveRegistration(cfg, key).descriptionFor(...)
      优先级由包侧排好：用户 tool_descriptions 覆盖 > light 目录 > full 原文
  ▼  AgentRuntimeDeps.magicContextToolDescription
registerBuiltInTools(options)
  resolveBuiltInToolEntryForBranch：四 ctx_* 工具只换 metadata.description
     ── modelKey ← config.modelSelection（缺席则只按 configured default）
两个注册入口共用 resolveMagicContextPromptSurfaceOptions(runtime)：
  registerRuntimeBuiltInTools（首次装配）+ refreshBranchAwareBuiltInTools（embedded-search 分支）
```

## 测试矩阵

| 用例 | 文件 | 结果 |
|---|---|---|
| preset 五条路由 + identity 稳定性 + hash 材质 | magic-context/scripts/test-prompt-surface.mjs（新，挂 test:all） | 26/26 |
| registration 三档分档 / 未知 id 告警一次 / guidance marker 纪律 / epoch 缓存 | 同上 | 含于 26 |
| 211 行段 11 参开关效应（memoryEnabled / preset / no-reduce / subagent / override / language / caveman / temporal / dreamer） | 同上 | 含于 26 |
| **工具名闭合直证**：ACTIVE_TOOL_IDS == LIGHT_TOOL_DESCRIPTIONS 键集 == ZCODE_CTX_TOOL_IDS 硬编码对照表 | 同上 | 含于 26 |
| light 文案引用的 ctx_* 工具名 ⊆ 已注册 ∪ {ctx_note}（Step 18 前哨） | 同上 | 含于 26 |
| **T-P1**：`## Magic Context` 段进 system prompt（段文本原样可见） | core/scripts/test-magic-context-prompt-section.mjs（新，挂 test:magic-context-section） | 10/10 |
| 互斥：原生 # Memory 段 + MEMORY.md 索引双双退场 / 缺席时双双回归护栏 / customSystemPrompt 路径不受影响 | 同上 | 含于 10 |
| 端口三条 null 路径 / ctxReduceCallable 由真实工具表推导 / modelKey+subagentMode 透传 | 同上 | 含于 10 |
| 子智能体 builder 落位与顺序 | 同上 | 含于 10 |
| light 四工具换包侧目录逐字节一致 / full 与不传选项恒等 / 用户覆盖压过 light / 只改 ctx_* 且四不漏 / 端口缺席不换档 + modelKey 推导 | core/scripts/test-prompt-surface-tiering.mjs（新，挂 test:prompt-surface-tiering） | 5/5 |
| per-model 覆盖只读呈现：展示串稳定 / 只呈现键 / 坏值按未配置 / 无覆盖空表 / 写侧 round-trip 字节一致 | packages/ui/test/magicContextPromptSurfaceOverrides.test.ts（新） | 5/5 |
| 既有回归：ctx 工具描述引导句（mc/T-1） | core/scripts/test-ctx-tool-descriptions.mjs | 3/3 |
| 既有回归：ctx_search handler / prompt-language / subagent-sync | core | 10 / 6 / 5 |

## 验证记录（Node 24 便携版 .tools/node-v24.14.0-win-x64 + turbo 2.9.14 实测）

| 命令 | 结果 |
|---|---|
| `pnpm --dir apps/zcode-cli/packages/magic-context test:all` | 全绿：smoke 36 / config 11 / host 30 / **transform 38 cases, 0 failures** / historian 18 / ctx-tools 20 / ctx-search-memory 10 / **prompt-surface 26** / memory-promotion 4 / boot-busy-retry 7 |
| `pnpm --dir apps/zcode-cli/packages/core run test:magic-context-section` | 10/10 |
| `pnpm --dir apps/zcode-cli/packages/core run test:prompt-surface-tiering` | 5/5 |
| `pnpm --dir apps/zcode-cli/packages/core run test:ctx-tool-descriptions` | 3/3 |
| `pnpm --dir apps/zcode-cli/packages/core run test:ctx-search-memory` | 10/10 |
| `pnpm --dir apps/zcode-cli/packages/core run test:prompt-language-context` | 6/6 |
| `pnpm --dir apps/zcode-cli/packages/core run test:subagent-sync-dispatch` | 5/5 |
| `tsx --test packages/ui/test/magicContextPromptSurfaceOverrides.test.ts` | 5/5 |
| `pnpm --dir apps/zcode-cli run typecheck`（turbo） | 27 successful, 27 total |
| 根 `tsc -b`（rpc/provider/provider-node/shared/services/client/server/zcode-server-cli/ui/web/desktop host + 两个 test tsconfig） | 0 error |
| `node scripts/architecture/architecture-check.mjs check --changed` | OK / violations 0 / baseline 0 / new 0 |
| oxfmt（本节点全部改动文件，tmp 中转规避仓内位置参数吞噬） | All matched files use the correct format |
| oxlint src --no-ignore | core 17w/0e、bootstrap 23w/0e、magic-context 21w/0e、ui 57w/0e；命中项均为 HEAD 既有代码（如 create-app.ts:31 的未用 `type SessionEvent` 在 HEAD 即存在） |
| 逐字保真脚本（cache-tmp/verbatim-check2.cjs + tail-check.cjs） | 见上表 |

## 观察项 / 遗留登记（不阻塞本节点）

1. **`deps.memoryConfig` 此前从未被填过**（Step 13 首次填）：恒 undefined ⇒ 包内 transform 的
   `<project-memory>` 注入面与 historian 分舱的 Issue #44 自动提升门在运行期是**关**的，
   这正是缺陷④「只接了压缩半边」的现场症状之一。另两个字段按上游缺省直填
   （injection_budget_tokens 4000 / auto_promote true）并在 `MEMORY_INJECTION_BUDGET_TOKENS_DEFAULT`
   / `MEMORY_AUTO_PROMOTE_DEFAULT` 两处注释登记「为什么是同一个数」；若将来开放这两个旋钮，
   改 schema + 常量两处并同步注释。
2. **ctx_note 的文案引用**：211 行段与 ctx_memory light 描述都提到 ctx_note，而工具按 N2
   不注册。本节点按 spec 不动逐字常量；spec Step 18 的 host 装配层最小适配与 regex 闭合
   断言**不在本节点**。豁免集已被测试钉成 `["ctx_note"]`。
3. **切模型不重算已注册的工具描述**：preset 路由发生在工具注册时（runtime 构造 +
   embedded-search 分支刷新共两个入口），会话中途切模型不会立刻换档。与上游自己的注释同
   性质（OpenCode 每个插件进程只物化一份 tool map），已在 create-app 的 options 注释登记；
   本批不扩大刷新机制。
4. **`prompt_surface.models` 仍是只读呈现**：没有编辑入口（spec 明令），写侧经 base 原样
   带回。ui 测试钉住了 round-trip 字节一致。
5. **新增 ui 测试未挂进根 `test:v4-perf` 清单**：根 package.json 属本节点并行禁触面，
   挂载留给 Step 19 全门禁步（spec 测试策略「新增 ui/shared 测试须同步根 package.json:32」）。
6. **mural 渲染本体（Step 15）尚未接线**：本批只把 `mural.enabled` 配置面立起来
   （Step 11），`deps.muralEnabled` 仍不被 bootstrap 填；`deferred/render-trigger.ts` 的
   `supportsVision:false` 臂因此继续生效，`MEMORY_MURAL_BLOCK` 到不了 wire——预期行为。
7. **`third-party/**` 与若干根级文件在工作区处于删除态**（`THIRD-PARTY-NOTICES.md`、
   `UPSTREAM-SYNC.md`、`third-party/**`，另有并行 CR 节点的未追踪文件）。非本节点改动，
   按「保留与任务无关的本地改动」未触碰、未提交；本节点三个提交均用显式 pathspec。

## 提交记录

| SHA | 标题 | stat |
|---|---|---|
| bc7a20d7 | `[bugfix-batch-20261011/Step 12] prompt-surface 真身归位（D6/D1/D7）+ light 描述随行移植` | 19 files, +1330/-182 |
| 09b52efe | `[bugfix-batch-20261011/Step 13] \`## Magic Context\` 段注入（D1 宿主侧）+ 原生 # Memory 段互斥` | 14 files, +655/-5 |
| e81dc870 | `[bugfix-batch-20261011/Step 14] 设置面消费：prompt_surface preset 分档工具描述 + per-model 覆盖只读呈现` | 16 files, +669/0 |

提交纪律备注：中文多行正文一律 `git commit -F <utf8 文件>`（cmd 传参会丢正文，已知坑）；
`subagent/context-builder.ts` 曾在 Step 13 提交里带上一次编码修复前的字节，已用
`git commit --amend` 重写该提交，HEAD 复验无 mojibake（三个提交的 .ts/.mjs 全量签名扫描）。
