---
date: 2026-10-08
agile_trace: true
---

# readonly-provider-config-fallback 实现规格（SPEC）

## 根因 / 方案摘要

根因链：用户级全局 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向旧 ZCode 3.14.4 缓存（schema 已删除 accountType/mode 字段）→ CLI 入口 `apps/zcode-cli/packages/cli/src/provider-runtime-env.ts` 的 `prepareCliProviderRuntimeEnv` 在显式值存在时**跳过**随包基线解析（`explicit ?? resolveBundled(...)`），把失效显式值当 bundled 基线传给 `NodeZCodeBuiltinProviderConfigSource` 且不传兜底 → `source.read()` 抛「Bundled 与 Active 均不可用」→ main.ts 顶层 catch 进程退出 → 桌面 read-only 控制面 transport closed → 设置页「读取上下文管理配置失败」。

前次修复（Bundled/Active 均不可用 → 桌面 services 链路 bundledFallbackFilePath）只覆盖了桌面 host → services → provider-node 链路；CLI 子进程自身的启动链没有兜底。会话 agent 因桌面注入解析后的 spawn env 而幸免，裸 read-only lane 与独立 CLI 中招。

修复：与桌面侧同语义——无条件解析真实随包基线（existsSync 廉价；解析失败时保留旧显式行为不新增失败面），作为 `bundledFallbackFilePath` 传入 source；返回 env 的 BUNDLED 键恒指向真实基线（防下游 `startProcessProviderRegistryRuntime` 再次失去兜底）。

## 变更点清单

- `apps/zcode-cli/packages/cli/src/provider-runtime-env.ts`（唯一改动文件）：
  1. 新增 `bundledBaselinePath`：try 解析 `resolveBundledZCodeBuiltinProviderConfig`，catch 时置 undefined。
  2. `zcodeBuiltinFilePath = explicit ?? bundledBaselinePath`；两者皆空才抛「缺少入口路径」。
  3. source 新增 `bundledFallbackFilePath`：仅当显式值存在且与基线不同时传入。
  4. 返回 env 的 `ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV` 由 `zcodeBuiltinFilePath`（可能是失效显式值）改为 `bundledBaselinePath ?? zcodeBuiltinFilePath`。
  - 文件含 `FORK（readonly-provider-fallback）` 登记注释；LF 行尾。

## 详细改动说明

- 显式值仍优先作为读取入口（有效时不改变行为、不产生告警）。
- 显式值失效：source 内部告警 `[zcode-builtin] Bundled 基线不可用，已回落随包基线: <显式> -> <基线>` 并以基线继续（复用前次已验证的 provider-node 机制，未改 provider-node）。
- SEA 形态：无条件解析会走 materialize（幂等写 dataBaseDir），无行为差异。
- `requiresProviderRuntime`、`--prepare-storage` 跳过逻辑均未动。

## 测试策略

- 隔离验证（tsx 直接构造 source）：stale 显式 + 临时 active + 基线 fallback → read 成功、revision=zcode-builtin:30、可检索回落告警（已通过）。
- 手动复现链（修复前）：`echo initialize | node dist/zcode.cjs app-server --stdio` 在带 stale env 的 shell 中 1.3s 退出并打印「Bundled 与 Active 均不可用」——修复后随 dist 重建复测应存活。

### 测试用例

1. stale env + initialize 请求 → 进程存活、协议响应正常（回落告警在 stderr）。
2. 显式 env 指向有效文件 → 无告警、使用显式值。
3. 无显式 env → 与旧行为一致（基线解析 + active 缓存）。

## 风险与回滚方案

- 风险：基线解析在个别「无随包配置」的自定义部署会多走一次 try/catch（失败后行为与旧版一致）；BUNDLED env 值变化对下游仅增强（registry 多了兜底）。
- 回滚：单文件 revert 即可。
- 建议（非代码）：删除本机用户级全局 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`（残留自旧安装）——修复后不再必须，但清理可消除每次启动的回落告警噪音。
