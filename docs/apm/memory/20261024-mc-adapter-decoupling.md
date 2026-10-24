# 2026-10-24 mc-adapter-decoupling（agile-dev 敏捷项，feature）

## 前因

用户在 `mc-tag-leak-to-bubble` 修完后提出：「感觉 magic context 现在对 omz 有很多负面影响，感觉需要重新梳理下，解耦 magic context」。按 `agile-dev` 走：先两路只读探索（omz 侧接触面 / 开关与数据面），再由用户拍板档位，最后派三路实现。

## 拍板与范围

- 拍板档位：**C（拆工厂 + 关时零加载）**。
- 交付三件事：适配器契约收敛装配缝；2292 行工厂拆 6 模块；关闭时进程级零加载（含修生效门缺口）。
- 不在范围：UI 设置/用量面板、MC 包内部算法、desktop 打包 external、`ctx_*` handler 已动态 import 的路径。

## 落地

| 提交 | 内容 |
| --- | --- |
| `f5bc0e0a` | MC 包新增窄子路径导出；`adapters/config/schema.ts` 改走窄子路径（231→4 模块）；新增装载白名单守卫 3/3 |
| `7c9ba0b7` | 工厂 2292→158 行门面 + 6 模块（types/usage/projection/ports/prompt-surface/assembly），15 个导出逐项等价 |
| `b82cd023` | `MagicContextAdapter` 契约 + `createMagicContextAdapter`；`create-app.ts` 五处推导收敛为一次调用 |
| `32f205b7` | 统一口径 `resolveMagicContextEffectiveEnabled`；bootstrap 两处静态 import 收敛；修 memories RPC 生效门缺口；新增 zero-load 4/4 |
| `84076681` | 两处注释改回与实现一致 |

## 复核（主代理独立复跑，不采信子代理口供）

turbo typecheck 27/27；zero-load 4/4；turn-transform 23/23；identity-guard 4/4；tag-strip 10/10；config-lazy 3/3。

## 关键结论（可复用）

- omz 的 MC 是**进程内库**，真正接缝只有三个 core 端口；「耦合重」不是算法重，而是**接线散布 + 关闭不彻底 + 口径不一**。
- 零加载要动三处：`adapters/config/schema.ts`、`bootstrap/zcode-protocol/magic-context-config.ts`、`bootstrap/zcode-protocol/magic-context-memories.ts`（实现值需 handler 内动态 import）。
- 生效口径必须单一函数（`gate.ts`）：此前 memories RPC 只判 `magicContext.enabled`，导致总开关关闭仍开库。
- 拆分门面时三条零行为不变量：`deps` 同引用、settle/close 时序、`if (!options.enabled)` 必须是工厂第一句。

## 挂账

1. 启用态无新增 E2E（既有套件覆盖）。
2. MC 包内 `src/host/*`（omz 宿主层）仍在 MC 包内部 —— 下一轮候选：搬出成独立包，让 MC 更接近纯净 vendored 依赖。
3. `packages/desktop` 打包 external 未调整。

## 文档

`docs/iterations/backlog-sweep/features/mc-adapter-decoupling/{prd.md,spec.md}`
