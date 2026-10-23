# CR Fix Spec: v1.0.21 启动即崩（asar 裸 sqlite 导入）

## 元信息
- repo: D:\Dev\Js\oh-my-zcode（main）
- base_sha: 1ff8cad9 → head_sha: 775fe1a9（v1.0.21 tag）
- prd_path: 未提供（事故驱动） ｜ spec_path: docs/iterations/upstream-v316-fullsync/spec.md
- review_round: 3 ｜ dag_version: 2 ｜ 状态: fix-spec-ready（r3 复核三点全闭合，末轮干净）
- 来源: review-diff r1（agent_3fa77146）+ review-r2 复审（agent_6cb0d056，逐条实证核验）
- 执行授权: 用户既有指令「按照skill走完剩下的流程，然后publish吧」+ 事故修复语境（发版阻塞，用户在等）

## 事故一句话
v1.0.21 打包产物 `out/main/chunk-*.js` 含 `import{DatabaseSync}from"sqlite"`——tsup 8.5.1 默认 `removeNodeProtocol:true` 把外部化的 `node:sqlite` 剥成裸 `sqlite`，而 sqlite 是 Node 22.5+ prefix-only 内建**无裸别名**，ESM 静态加载即 ERR_MODULE_NOT_FOUND；**main/host/scheduler 三进程启动即崩**（坏 chunk 被四个入口引用）。源头=本迭代 P3 照搬上游的 `packages/shared/src/sqlite-migrations/{backup,restore}.ts` 值导入 `from "node:sqlite"`，违反 fork 既有规避惯例（chromeCookieManager.ts:30 / startup.ts:5 两处成文）。测试全绿的原因：test:v4-perf 走 tsx 源码直跑不打包，产物级门禁为空。

## Must-fix

### CR-1 [P0] backup.ts 值导入 node:sqlite → 打包裸 sqlite
- 维度：B 正确性（发版阻塞）
- 文件：packages/shared/src/sqlite-migrations/backup.ts
- 问题：`import { DatabaseSync } from "node:sqlite"`（值导入）经 desktop tsup noExternal 内联后改写为 `from"sqlite"`，三进程启动崩。
- 改法（r2 实测定稿形——**构造值必须改名**，否则与 `import type` 同名撞 TS2440）：按仓库惯例（automationRepo.ts:33-34 / startup.ts:6-8 同形）改为：
  ```ts
  import type { DatabaseSync } from "node:sqlite";
  import { createRequire } from "node:module";
  const { DatabaseSync: DatabaseSyncConstructor } = createRequire(import.meta.url)(
    "node:sqlite",
  ) as typeof import("node:sqlite");
  ```
  加中文注释引用 chromeCookieManager.ts:30 的雷区说明。使用位三处：import 位（删原值导入）、类型位 `:14`（db 参数注解，保持 `DatabaseSync`）、构造位 `:44`（`new DatabaseSync(`→`new DatabaseSyncConstructor(`）。
- 验收：production build 后 out/{main,host,scheduler} 无 `from"sqlite"`；sqliteMigrationsRunner.test.ts 绿。
- 来源：review-diff P0-1；r2 核验（改名形实测全绿）

### CR-2 [P0] restore.ts 同病
- 维度：B
- 文件：packages/shared/src/sqlite-migrations/restore.ts
- 问题/改法/验收：同 CR-1（import 位 `:3`、类型位 `:24`、构造位 `:30`）。
- 来源：review-diff P0-2；r2 核验

### CR-3 [P0] 产物级说明符门禁缺位（防复发）
- 维度：G 测试（发版流程缺口）
- 文件：packages/desktop/scripts/verify-bundle-imports.mjs（新增）
- 问题：本次崩溃任何门禁都没拦——typecheck:desktop-full 是类型差分网、test 不打包、asar 校验只查 node_modules 存在性；裸 `sqlite` 说明符天然盲区。
- 改法：只读扫描器：遍历 out/{main,host,scheduler}/*.js 与 out/preload/*.cjs，提取全部 import/require 说明符；断言非相对说明符 ∈ `node:` 前缀 ∪ tsup.config.ts 的 desktopNodeRuntimeExternals（写死同步，八项）∪ `node.builtinModules` ∪ desktop package.json dependencies 键名（原型实测产物含 ws/yazl 等内联 CJS 依赖的合法裸包名）。**@zcode/ 前缀显式禁（反白名单）**——tsup.config.ts:164-166 成文记载「裸 @zcode 引用 + electron-builder 排除 node_modules/@zcode = 启动即崩」历史事故，dependencies 键名虽含九个 @zcode/* 包但产物中出现裸 @zcode 说明符必须判红。正则须只认模块说明符位置（原型对压缩产物字符串字面量有误报，以词界+说明符终止收紧，执行时以产物复证）。挂 tsup 四 target 的 onSuccess——**现有 onSuccess=write-dev-ready-marker.mjs（tsup.config.ts:178/201/233/261，单值字段），以 `node scripts/verify-bundle-imports.mjs && node scripts/write-dev-ready-marker.mjs` 串接**；并在 package.json 增 `verify:bundle-imports` 脚本供发版 checklist 显式调用。
- 验收：修复前对当前产物必红且真命中=裸 sqlite 6 处（main chunk-LRNZFPQ6 ×2、host chunk-6DB5JNT5 ×2、scheduler/index ×2，原型已实证）；修复后绿；重复运行幂等。
- 来源：review-diff P0-3（主代理原型+r2 P2 加强：@zcode 反白名单+onSuccess 串接形）

### CR-4 [P1] 桌面启动 e2e 冒烟（随修，不挂账）
- 维度：G（用户直接质问「你 e2e 了吗」——本轮必须补上，不留挂账）
- 文件：packages/desktop/scripts/desktop-launch-smoke.mjs（新增）+ src/main/index.ts（最小冒烟钩子）
- 改法：主进程在 first window ready-to-show 后检查 `process.env.ZCODE_DESKTOP_SMOKE === "1"` → 记录 smoke ok → app.exit(0)（r2 核验：主链 whenReady index.ts:1199→ensurePrimaryWindow→createWindowInstance:967，新增 once("ready-to-show") 监听可行）；smoke 脚本以 production out/ 产物启动 electron，until 轮询 exit code + stderr 断言不含 ERR_MODULE_NOT_FOUND/Uncaught Exception（模式抄 scripts/zcode-distribution-smoke.mjs:64）+**显式超时兜底（如 60s 未退即 kill 判红——renderer 异常致 ready-to-show 不触发时不挂死）**。Windows 本机跑通即验收；CI 接入挂 P9。
- 验收：本机 build→smoke 退出码 0、stderr 干净；修复前跑 smoke 能复现崩（模块加载期即崩于窗口前，恰被 stderr 断言捕获）作为对照留证。
- 来源：review-diff P1-1（升级为随修）；r2 P2 加强：超时兜底

## Spec deviations
- none（修复不偏离 fullsync spec；上游照搬纪律的例外=本仓成文惯例优先，spec L56 照搬面补注）

## Open questions / 待拍板
- tsup `removeNodeProtocol:false` 根治选项：一次改写全部产物内建形态，回归面大——**留发布后单独拍板**，本热修不动。

## 已豁免
- apps/zcode-cli sqlite-session-store.ts / debug server 值导入：审查实证 agent bundle（esbuild CJS 输出）保真 `node:sqlite`，不进 desktop bundle——不改（改了反而偏离上游）。

## 合并后 QA（manual_user）
- macOS/Windows/Linux 安装包真机启动（Release 资产更新后用户验证）。

## K 节建议（下游执行时闭合）
- CHANGELOG 1.0.21 段补「修复」条目（启动即崩）。
- .iteration-state.yaml 补事故登记与 review-diff 节点。
- apm memory 补事故复盘条目。

## Fix-Spec Closure
| 项 | 状态 |
| fix-spec-ready | yes |
| fix_spec_path | docs/iterations/upstream-v316-fullsync/cr-fix-spec-release-crash.md |
| dag_version / review_round | 2 / 3 |
| P0 / P1 / P2（已写入） | 3 / 1 / 0 |
| 未写入的开放 must-fix | 0 |
| spec_deviations | none |
| C-orch | N/A |
