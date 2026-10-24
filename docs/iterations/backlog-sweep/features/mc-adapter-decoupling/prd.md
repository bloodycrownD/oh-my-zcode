---
date: 2026-10-24
dependency: iterations/backlog-sweep/spec.md
---

# mc-adapter-decoupling Feature PRD

## 背景与变更动机

Magic Context（MC）是 omz 从上游移植的上下文压缩/记忆插件。用户提出：「magic context 现在对 omz 有很多负面影响，感觉需要重新梳理下，解耦 magic context」——此前连续两次事故（幽灵用户消息、`§N§` 标记上屏）都指向同一件事：MC 与 omz 的接线散落在多个层，出问题时很难判断是 MC 的语义问题还是宿主的接线问题，且「关掉 MC」这件事本身不彻底。

探索确认的核心事实：omz 里 MC 是**进程内 TS 库**（无插件 hook、无独立进程），真正的程序化接缝只有三个端口（turn transform / prompt section / tool description）。但接线的推导逻辑散在 `create-app.ts` 五处，装配细节塞在 2286 行的单个工厂文件里，而「关闭」只关掉了 bootstrap 的 `import()` 门——进程启动仍然会把 MC 的 231 个模块（含 92 个实现模块与 `node:sqlite`）拉进内存。

## 范围说明（相对原需求）

本次按用户拍板的 **C 档**交付，拆成三件事：

1. **装配缝收敛**：把散在 `create-app.ts` 的五处 MC 接线推导收成一个适配器契约 `MagicContextAdapter`，`create-app` 只做字段分发。
2. **工厂拆分**：把 2286 行的单文件按职责拆成 assembly / projection / ports / prompt-surface / usage / types 六个模块，原文件降为薄门面，导出面与行为零变化。
3. **关闭时零加载**：配置 schema 改走窄子路径、bootstrap 两处静态 barrel/实现值 import 收敛，使 `features.magicContext=false` 时进程级不再加载 MC 实现模块；顺带修掉「总开关关了但记忆管理 RPC 仍会开 MC 库」的生效门缺口。

**不在本次范围**（登记为后续）：UI 设置面与用量面板不动；MC 包内部 `core/**` 算法不动；`ctx_*` 工具的 handler 内动态 import 保持原样（该路径本身就在 `enabled` 门后）；`packages/desktop` 打包 external 配置不动。

## 影响模块与接口

| 层 | 影响 |
| --- | --- |
| `apps/zcode-cli/packages/adapters` | 配置 schema 不再静态求值 MC barrel（231 → 4 个纯配置模块） |
| `apps/zcode-cli/packages/magic-context` | 仅新增窄子路径导出 `./host/config/schema`，实现零改动 |
| `apps/zcode-cli/packages/bootstrap` | 新增 `app/magic-context/{gate,adapter}.ts` 与六个拆分模块；`create-app.ts` 的五处推导收敛；RPC 侧两处 import 收敛；新增两个守卫测试 |
| `packages/ui` / `packages/services` | 零改动 |

对外行为变化只有一条（有意）：`features.magicContext=false` 且参数域 `enabled` 缺省 true 时，记忆管理 list/archive 现在返回「disabled」可读错误，不再开库读写。

## 验收标准

1. `MagicContextAdapter` 单一契约存在，`create-app.ts` 不再各自推导 MC 端口；生效判定只有一个函数 `resolveMagicContextEffectiveEnabled`。
2. 工厂文件从 2292 行降到薄门面（实测 158 行），对外 15 个导出逐个等价（10 个运行时值 + 5 个纯类型）。
3. `features.magicContext=false` 时，进程装载清单里 MC 实现模块数为 **0**（改造前 94 个）。
4. 既有 MC 套件全绿：turn-transform 23/23、identity-guard 4/4、tag-strip 10/10、absent-event 4/4、config-lazy 3/3、memories-rpc 19/19、config-rpc 10/10；新增 zero-load 4/4。
5. `apps/zcode-cli` turbo typecheck 27/27。

## 测试用例

- `bootstrap/scripts/test-magic-context-zero-load.mjs`（新）：T1 入口零实现模块；T2 关闭态真实调用适配器返回 `undefined`、发 `transform_absent(disabled)`、装载清单零新增；T3 反例守卫（故意引入静态 barrel 时该测试必须变红）；T4 门面未被静态装载。
- `adapters/scripts/test-magic-context-config-lazy.mjs`（新）：只 import 配置 schema 时 MC 侧仅 4 个纯配置模块；窄子路径与 barrel 同一性（默认值对象仍同一引用）；schema 校验语义不变。
- 既有 7 个 MC 套件作为行为不回退门禁。
