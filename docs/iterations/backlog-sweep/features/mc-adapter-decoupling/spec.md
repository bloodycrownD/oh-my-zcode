---
date: 2026-10-24
agile_trace: true
---

# mc-adapter-decoupling 实现规格（SPEC）

## 根因 / 方案摘要

MC 与 omz 的耦合不是「算法耦合」而是「接线散布」：

- **装配散**：`create-app.ts` 五处（transform 端口、prompt section resolver、tool description resolver、`isMagicContextEnabled`、会话关闭钩子）各自推导，任何一处口径漂移就会分叉。
- **文件巨**：`bootstrap/src/app/magic-context-turn-transform.ts` 2292 行，装配 / 投影 / 端口 / 用量四类职责混在一起，改一处必须读全文件。
- **关闭不彻底**：`adapters/src/config/schema.ts:4-8` 静态 import MC barrel、`bootstrap/src/zcode-protocol/magic-context-config.ts:3` 与 `magic-context-memories.ts:92` 同样静态，导致 flag off 时进程仍加载 231 个 MC 模块（92 个实现模块 + `node:sqlite`）。
- **口径不一**：`magic-context-memories.ts:127-149` 只判 `magicContext.enabled`（默认 true），不看 `features.magicContext`，于是总开关关掉、记忆 RPC 仍开库；两处注释对「effective」的定义互相矛盾。

方案：**契约化 + 纯搬迁 + 惰性求值 + 单一口径**。MC 包内部实现零改动（只新增一个窄子路径导出），所有改造都在宿主侧，使 MC 重新变成「可整体替换/整体关闭」的插件。

## 变更点清单

| # | 提交 | 文件 | 改动 |
| - | ---- | ---- | ---- |
| 1 | `f5bc0e0a` | `magic-context/package.json` | 新增窄子路径导出 `./host/config/schema`（只加导出） |
| 2 | `f5bc0e0a` | `adapters/src/config/schema.ts` | MC schema/默认值改从窄子路径引入 + 装载面理由注释 |
| 3 | `f5bc0e0a` | `adapters/scripts/test-magic-context-config-lazy.mjs`（新） | 装载白名单守卫（3 用例） |
| 4 | `7c9ba0b7` | `bootstrap/src/app/magic-context/{types,usage,projection,ports,prompt-surface,assembly}.ts`（新） | 按职责拆出 6 模块 |
| 5 | `7c9ba0b7` | `bootstrap/src/app/magic-context-turn-transform.ts` | 2292 → 158 行薄门面，15 个导出全量再导出 |
| 6 | `b82cd023` | `bootstrap/src/app/magic-context/{gate,adapter}.ts`（新） | `resolveMagicContextEffectiveEnabled` + `MagicContextAdapter` 契约与工厂 |
| 7 | `b82cd023` | `bootstrap/src/app/create-app.ts` | 五处推导 → 一次 adapter 调用 + 字段分发 |
| 8 | `32f205b7` | `bootstrap/src/zcode-protocol/magic-context-config.ts` | barrel → 窄子路径 |
| 9 | `32f205b7` | `bootstrap/src/zcode-protocol/magic-context-memories.ts` | 实现值改 handler 内 `await import()`；生效门改用统一口径；反向口径注释改写 |
| 10 | `32f205b7` | `bootstrap/scripts/test-magic-context-zero-load.mjs`（新） | 进程级装载清单守卫（4 用例） |
| 11 | `84076681` | `run-ctx-command.ts` / adapters 守卫测试头注 | 注释改回与实现一致 |

## 详细改动说明

### 1. 适配器契约（`app/magic-context/adapter.ts`，190 行）

```ts
interface MagicContextAdapter {
  turnTransform?: MagicContextTurnTransform;      // core 端口类型，原 create-app:879-955 推导
  promptSection: MagicContextPromptSectionResolver; // 原 :1016-1025
  toolDescription: NonNullable<AgentRuntimeDeps["magicContextToolDescription"]>; // 原 :1030-1035
  isEnabled: () => boolean;                        // 原 :1281
  registerSessionClose?: () => Promise<void>;      // 原 :878/:886/:1118
  usage: MagicContextUsageRecorder;                // 原 :845-874 组装
}

async function createMagicContextAdapter(runtimeConfig, deps): Promise<MagicContextAdapter | undefined>
```

- 门是第一句（`enabled` 为假直接返回 `undefined`，模块不加载）；动态 `import()` 在其后，`transform_absent(import_failed)` 事件与 rethrow 语义逐字保留。
- `deps` 用 `Omit<MagicContextTurnTransformOptions, ...>` 派生，不新造同名类型。

### 2. 单一口径（`app/magic-context/gate.ts`，48 行）

`resolveMagicContextEffectiveEnabled({ features, magicContext }) = features.magicContext && magicContext.enabled !== false`，零依赖 leaf（避免与 assembly 成环）。所有现存调用点（create-app、memories RPC、ctx 命令面）改调它。

> 口径从 `=== true` 变 `!== false`：今日等价（`resolveAppRuntimeConfig` 恒把 `enabled` 物化为 boolean），若将来把裸 config 传给适配器，「缺席」会从「关」变「开」——该前提已登记在 `gate.ts` 头注。

### 3. 工厂拆分（`7c9ba0b7`）

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `types.ts` | 128 | 公共类型面（断开 ports↔assembly 类型环） |
| `usage.ts` | 301 | 用量 recorder、窗口三源、summary 推送 |
| `projection.ts` | 373 | 反投影全套（`rebuildEntry` / `sanitizeRebuiltMetadata` / `originalPairsWithMessage` / `hoistHeadsAfterSystemPrefix` / `projectMagicContextEntries`） |
| `ports.ts` | 515 | transform 端口工厂、失败分级、`settleInFlightHistorian*` |
| `prompt-surface.ts` | 183 | section resolver + 工具描述 resolver（因 ports 触顶 400 行 max-lines 而拆出） |
| `assembly.ts` | 757 | 装配（开库 busy 重试、config bridge、historian、deps 构造/热更新、settle/close 生命周期） |
| 门面 | 158 | 仅再导出 + 结构说明 |

依赖方向无环：`usage ← types ← ports / prompt-surface ← assembly`，`ports → projection`。

**零行为不变量的三处敏感点**（搬迁时逐字保留）：
1. `deps` 必须是同一引用（`applyConfigToDeps` 原地改写、`bindLiveModel`、`getToolSetHash` 构造后赋值）。
2. settle/close 时序：`settlesInForeground` 只在端口构造时求值一次；`registerClose` 仍 `drain → shutdown → dispose`；`HISTORIAN_SETTLE_TIMEOUT_MS` 全仓只有一份。
3. 模块加载门：`if (!options.enabled)` 仍是工厂第一句；新增 6 模块保持零模块级副作用（仅 const）。

### 4. 零加载

- 配置层：窄子路径 `@zcode/magic-context/host/config/schema` 只依赖 `host/config/language`、`core/shared/prompt-surface`、`core/shared/harness-provider-map` 三个零副作用模块。
- bootstrap 层：`magic-context-config.ts` 走同一窄子路径；`magic-context-memories.ts` 的实现值（`archiveProjectMemories` 等）改为 handler 内 `await import()`（Node ESM 缓存保证只求值一次）。
- 实测：MC 侧装载 231 → **4** 模块，实现模块 92 → **0**，`node:sqlite` 不再被拉起。

### 5. 生效门缺口修复

`features.magicContext=false` + 参数域 `enabled=true`（最易误开的组合）下，记忆管理 list/archive 现在直接返回可读 disabled 错误，不再 `initializeAndOpenDatabase()`。

## 测试策略

### 测试用例

| 套件 | 结果 | 用途 |
| --- | --- | --- |
| `bootstrap/scripts/test-magic-context-zero-load.mjs`（新） | 4/4 | T1 入口零实现模块；T2 关闭态真实装配零新增；T3 反例守卫（引入静态 barrel 必须变红）；T4 门面未被静态装载 |
| `adapters/scripts/test-magic-context-config-lazy.mjs`（新） | 3/3 | 装载白名单（严格清单，MC 新增依赖会红并要求显式确认）、窄子路径与 barrel 同一性、schema 语义不变 |
| `test-magic-context-turn-transform.mjs` | 23/23 | 行为不回退主门禁 |
| `test-mc-entry-identity-guard.mjs` | 4/4 | 幽灵消息三守卫未因拆分失效 |
| `test-magic-context-tag-strip.mjs` | 10/10 | 落库剥离点仍在链上 |
| `test-magic-context-absent-event.mjs` | 4/4 | flag off 时工厂模块不被加载 |
| `test-magic-context-memories-rpc.mjs` / `config-rpc.mjs` | 19/19 / 10/10 | 被改 RPC 面的直接覆盖 |
| `pnpm --dir apps/zcode-cli typecheck` | 27/27 | 全包类型 |

主代理独立复跑（不采信子代理口供）：上述 5 个套件 + turbo typecheck 全部复验通过。

## 风险与回滚方案

**风险**

1. **口径语义变化**（`!== false`）：今日等价，前提是 `enabled` 已被 `resolveAppRuntimeConfig` 物化；已登记注释。
2. **resolver 创建时机微移**：`promptSection`/`toolDescription` 从「`new AgentRuntime` 前一行」移到「transform 工厂之后」；两者构造均无副作用（guidance 文件在 resolver 调用时才读），未观察到可观测差异。
3. **memories RPC 成本后移**：启用路径下首次调用付整图加载（约等于改造前启动成本），关闭路径纯收益。
4. **用户可见行为变化（有意）**：总开关关闭时记忆管理不再可用（此前是缺口，会静默开库）。
5. **新守卫白名单严格**：MC 若给 config schema 新增依赖，`config-lazy` 会红——这是设计意图（防实现模块回潮）。

**回滚**：四个提交互相独立，按需 `git revert 32f205b7`（零加载+口径）→ `b82cd023`（适配器）→ `7c9ba0b7`（拆分）→ `f5bc0e0a`（配置惰性化）。任一步回滚都不影响 MC 包与 UI。

**未覆盖（登记后续）**

- 启用态（transform 真跑 pass）没有新增 E2E，靠既有 23 例 + absent-event 关闭态路径。
- UI 设置面与用量面板不在本次范围。
- `packages/desktop` 打包 external 配置未调整（MC 仍随包分发）。
- MC 包内 `src/host/*` 这层 omz 宿主代码仍在 MC 包内部（属下一轮「把宿主层搬出 MC 包」的候选）。
