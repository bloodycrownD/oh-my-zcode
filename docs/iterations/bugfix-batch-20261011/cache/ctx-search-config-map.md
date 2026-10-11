# ctx-search + config 证据包（bugfix-batch-20261011 / Step 10-11 / impl-ctx-search-config）

- head_sha: e618e079（初版 Step 10 提交；因 cmd 传参吞正文与一处 lint 修正未入栈，历史重建后基点为 a10e74a1，最终 sha 见「提交记录」）
- 生成节点: impl-ctx-search-config
- 上游对照源: `.reference/magic-context/packages/plugin/src/tools/ctx-search|ctx-memory`、`.reference/magic-context/packages/plugin/src/config/schema/magic-context.ts`、`.reference/magic-context/packages/pi-plugin/src/tools/ctx-search.ts`、`.reference/magic-context/packages/pi-plugin/src/tools/ctx-memory.ts`、`.reference/magic-context/packages/plugin/src/features/magic-context/search.ts`
- 提交序列（pathspec 仅本节点文件，LF）:
  - a187650c `[Step 10]` ctx_search + ctx_memory 工具（D4+D14）
  - e5302fa8→285054a0 `[Step 11]` 配置白名单扩 E 组（memory/prompt_surface/mural 四层一致 + 设置面）

## 工具注册链图（ctx_search / ctx_memory）

```
contracts/src/tools/ctx-context.ts ── 名字常量 + zod 输入 schema + 共用文本输出 schema
   │  （tools/index.ts `export *` 已覆盖，无需新增导出行）
   ▼
core/src/tool/handlers/ctx-search.ts ──┐
core/src/tool/handlers/ctx-memory.ts ──┤ ToolEntry（capability/metadata/permission/resultBudget/timeout/cancellation/trace）
   │                                   │ handler = 动态 import("@zcode/magic-context")（flag off 时整棵不进内存）
   ▼                                   ▼
core/src/tool/handlers/index.ts  builtInTools[]（ctxReduce/ctxExpand + ctxSearch/ctxMemory 相邻）
   │  registerBuiltInTools 过滤链：
   │    allowedTools 交集 → disallowedTools 差集 → 各 include* 门
   │    → includeMagicContextTools !== true 时四个 ctx_* 一起缺席（门语义不变，只扩名单）
   ▼
core/src/runtime/helpers/runtime-tools.ts
   ├─ registerRuntimeBuiltInTools: includeMagicContextTools = runtime.config.magicContext?.enabled === true
   └─ resolveRuntimeDisallowedToolsWithMagicContext: workflow_child 结构性禁用名单
      （ctx_reduce/ctx_expand + Step 10 新增 ctx_search/ctx_memory 四条）
   ▼
包侧公共面（magic-context/src/index.ts 4c 节，带注释块）：
   resolveProjectIdentityForSession / storedPathBelongsToIdentity（身份，非抛错入口，
     promotion 与 transform 同款）  searchMemoriesFTS（内联 sanitizeFtsQuery/relaxedFtsQuery）
   getVisibleMemoryIds（m0 渲染列，读过滤）/ getMemoriesByIds（id 形状短路）
   insertMemoryIdempotent / getMemoryByHash / updateMemorySeenCount / computeNormalizedHash /
   V2_MEMORY_CATEGORIES（写面）  ModuleMemoryAuthorityError（fail-visible）
```

幂等两条链（ctx_memory）：①调用级 commandId 账本（core 侧，键推导照搬 ctx_reduce：
`oc-<session>-<callID>`，>128B sha256，无 callID 单调序号；BoundedSessionMap 等价物，
上界 2000）；②内容级 前置 `getMemoryByHash(computeNormalizedHash(content))` → 已存在
`updateMemorySeenCount` + 「already exists」文案；竞争写由 `insertMemoryIdempotent`
唯一约束收口。**不自造查询消毒/去重规则**（FORK 纪律：宿主不得自抄）。

## 配置四层映射表（Step 11 E 组：memory.enabled / prompt_surface.* / mural.enabled）

| 层 | 文件 | 改动 | 不改的后果 |
|---|---|---|---|
| ① 包 schema（权威） | apps/zcode-cli/packages/magic-context/src/host/config/schema.ts | +MemoryConfigSchema/PromptSurfaceConfigSchema/MuralConfigSchema + isValidPromptSurfaceModelKey 本地副本（待 Step 12 改指真身）+ MagicContextConfigSchema 三字段 | config.json 装载与 RPC 校验都把新字段 strip 掉 |
| ② contracts 域 | apps/zcode-cli/packages/contracts/src/config/index.ts | **零代码改动**（`ConfigKey.MagicContext` + `RuntimeConfig(Compat).magicContext?: unknown`，权威结构在包内，注释已登记）；测试钉住投影 | key 不在 ConfigKey → ConfigPort.get 抛「key not found」 |
| ③ adapters merge/patch | adapters/src/config/schema.ts（复用包 schema）/ config/index.ts（merge 整域透传 + getDefaultValue 登记 DEFAULT_MAGIC_CONTEXT_CONFIG） | **零代码改动**（schema 身份复用，DEFAULT 由 parse({}) 派生）；测试钉住 merge/observer | 高层来源整域被丢 / 缺省域缺新字段 |
| ④ file-config.adapter | adapters/src/config/file-config.adapter.ts `patchMagicContext`（整域替换 + 深比较幂等） | **零代码改动**；测试钉住落盘与幂等 | 设置页保存成功但重启还原 |
| UI | packages/ui/src/settings/{magicContextSettingsForm.ts, MagicContextSettingsFields.tsx, MagicContextSettingsSection.tsx(DEFAULT_FORM 最小补键)} + i18n zh-CN/en-US | 扩字段勿重建；`prompt_surface.models`/`tool_descriptions` 同 execute_threshold per-model 先例只读保留不建编辑入口；guidance 空串删键 | 表单缺字段 → 整域写回抹掉用户配置 |
| 协议层 | packages/shared/src/zcode-protocol/index.ts | **零代码改动**（`config: z.unknown()` + 非空 refine，字段权威在包内） | 新字段被协议信封拒 |

默认值（与上游对齐）：`memory.enabled=true`、`prompt_surface={default:"full"}`、`mural.enabled=false`。
上游 memory 其余字段与 mural.model 不搬（本批无消费者 / dreamer=N3 终局不做），
`EXCLUDED_CONFIG_KEYS` 仍只含 compaction。

## 测试矩阵

| 用例 | 文件 | 结果 |
|---|---|---|
| 包侧：身份解析+所有权 / 写面去重 / 关键词命中+跨项目隔离 / FTS5 操作符消毒 / relaxed OR 放宽 / 过期+archived 排除 / 日期界 / getVisibleMemoryIds / 无向量路径 | apps/zcode-cli/packages/magic-context/scripts/test-ctx-search-memory.mjs（新，挂 test:all） | 10/10 |
| handler 层：注册名册 / includeMagicContextTools 门四工具同开合 / category drift guard / ctx_memory 写入+commandId 幂等+内容去重+字段错误 / ctx_search 命中+id 短路+日期错误+可见抑制 | apps/zcode-cli/packages/core/scripts/test-ctx-search-memory.mjs（新，tsx --test） | 10/10 |
| E 组 schema：默认键名单+新子树默认值/校验 / 排除键（mural 出列） | magic-context/scripts/test-config.mjs（改） | 11/11 |
| 四层一致性：layer1 包 schema / layer2 ConfigPort / layer3 文件 parse+merge+文件 schema 拒坏 key / layer4 patchMagicContext 落盘+幂等 | apps/zcode-cli/packages/adapters/scripts/test-magic-context-domain.mjs（改，已挂 test:magic-context-domain） | 22/22 |
| T-U1 设置链（不可触碰文件，只运行）：B7 零改动保存字节一致等 14 例 | apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-ui-config.mjs | 14/14 |
| 既有回归：ctx 工具描述引导句（mc/T-1） | core/scripts/test-ctx-tool-descriptions.mjs | 3/3 |
| magic-context 全量：smoke 36 / config 11 / host 30 / transform 38 / historian 18 / ctx-tools 20 / ctx-search-memory 10 / memory-promotion 4 / boot-busy-retry 7 | `pnpm --dir apps/zcode-cli/packages/magic-context test:all` | 全绿 |

## 验证记录（Node 24 便携版 .tools/node-v24.14.0-win-x64 实测）

| 命令 | 结果 |
|---|---|
| `pnpm --dir apps/zcode-cli/packages/magic-context test:all` | 全绿（transform 38 cases 回归基线保持） |
| `pnpm --dir apps/zcode-cli/packages/core run test:ctx-search-memory`（tsx --test） | 10/10 |
| `pnpm --dir apps/zcode-cli/packages/core run test:ctx-tool-descriptions` | 3/3 |
| `pnpm --dir apps/zcode-cli/packages/adapters run test:magic-context-domain` | 22/22 |
| `node --test apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-ui-config.mjs` | 14/14 |
| `pnpm --dir apps/zcode-cli run typecheck`（turbo） | 27 successful, 27 total |
| 根 `pnpm typecheck`（tsc -b 含 packages/ui） | 0 error |
| `node scripts/architecture/architecture-check.mjs check --changed` | OK / violations: 0 / new: 0 |
| oxfmt（apps 侧 13 个本节点文件 / 根侧 5 个 UI 文件） | All matched files use the correct format |
| oxlint（本节点全部改动文件） | 0 error；唯一 warning 为 test-config.mjs:38 既有代码（非本节点引入，diff 起点在 :98） |

## 观察项 / 遗留登记（不阻塞本节点）

1. **`insertMemoryIdempotent` 唯一约束回退在 node:sqlite 下不可达**（逐字区可移植性缺口）：
   上游逐字的 `isUniqueConstraintError` 判 Bun 命名错误码 `SQLITE_CONSTRAINT_UNIQUE`，
   node:sqlite 抛 `ERR_SQLITE_ERROR` + errcode 2067，该 catch 分支在本 fork 运行期
   走不到。本节点按纪律不改 `src/core/**`，由 handler 前置精确哈希检查覆盖去重语义
   （工具文案层无差异），真竞争时 fail-visible 抛错。已在 barrel 4c 注释块、handler
   头注与包测试头注三处登记，待逐字区 owner 处置（最小修法：该函数兼容 errcode 2067）。
2. **`prompt_surface.models` key 校验是 schema.ts 本地副本**：上游
   `isValidPromptSurfaceModelKey` 在 `shared/prompt-surface.ts`（Step 12 git mv 换真身），
   本批先内联并注释登记；Step 12 真身落位后改指 import 删除副本。
3. **`prompt_surface.models` / `tool_descriptions` 无编辑 UI**：按
   `execute_threshold_percentage` per-model 先例，读侧不解析、写侧经 base 原样带回
   （零改动保存字节一致已由 T-U1 B7 钉住）。`guidance_override_path` 的文件读取/JSONC
   宽松解析属 Step 12，本节点只落配置面（描述文案已如实表述）。
4. **根 lint 全量计数不可比**：本环境存在未追踪的 `.reference/`（上游对照源）与
   `.tools/`，根 `pnpm lint` 把它们计入（779w/307e），与 spec 的 71w/0e 基线不可比。
   本节点改动文件单独抽检 0 error / 0 新增 warning（见上表）。
5. **en-US.ts 附带一行 oxfmt 归一**：`chat.placeholder.newTask` 在 HEAD 即为未格式
   化状态，`--write` 修文件时顺带修正；不引入新违规（复检通过）。
6. `memory.enabled` 的运行期消费（211 行段装配 / m0 注入门）在 Step 13，
   `prompt_surface` 解析在 Step 12，`mural.enabled` 渲染在 Step 15——本节点只落配置面。

## 提交记录

- a187650c `[bugfix-batch-20261011/Step 10] ctx_search + ctx_memory 工具（D4+D14）：契约/handler/注册链/barrel 扩面 + 测试`（10 files, +1426/-16）
- fc7d0e81 / 1993b220 `[bugfix-batch-20261011/verify-e2e]`（并行节点两提交，内容原样重建）
- 285054a0 `[bugfix-batch-20261011/Step 11] 配置白名单扩 E 组：memory/prompt_surface/mural 四层一致 + 设置面`（8 files, +591/-13）

历史重建说明：cmd.exe 传参会丢失多行提交正文（仅剩标题），且 oxlint 发现的
ctx-memory.ts 死变量修正未入栈。已在备份分支护航下按 soft/mixed reset 重建本节点
两个提交（正文用 UTF-8 文件 -F 写入、修正并入 Step 10），并行 verify-e2e 两提交
按原始中间态精确重放（内容逐字节一致）；最终树与重建前仅差 ctx-memory.ts 的
3 行 lint 修正（3 insertions / 3 deletions）。

最终态复验：turbo typecheck 27/27 successful（FULL TURBO 缓存回放全绿）；
根 `pnpm typecheck` 0 error；`architecture:check --changed` OK/0/0；
oxfmt（apps 13 文件 + 根 5 文件）全部通过；
oxlint 本节点文件 0 error（唯一 warning 为 test-config.mjs:38 既有代码）。
