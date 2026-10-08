# 桌面 Agent bundle 的运行期 external 依赖（desktop-agent-bundle-externals）

## 背景

桌面端内置 agent 是单个 CJS bundle：`apps/zcode-cli/packages/cli/dist/zcode.cjs`，
由 esbuild 打包（`cli/scripts/build.mjs`），暂存到 `packages/desktop/bundled-agents/<platform>/glm/`，
打包时经 extraResources 进入 `resources/glm/`。Host 用 Electron 内置 Node
（`ELECTRON_RUN_AS_NODE`）执行它，其中存储准备走 Worker：
`zcode.cjs app-server --stdio --prepare-storage`（`packages/desktop/src/host/storagePreparationProcesses.ts`）。

并非所有依赖都能内联进 CJS 产物——`resolveBuildExternal()` 清单：

- `@zcode/magic-context`：模块级 top-level await（`core/shared/sqlite.ts` 的
  bun:sqlite / node:sqlite 可变说明符动态 import）+ 三处 `import.meta.url`，CJS 无法内联；
- `@zcode/tui`：Ink/yoga 同样 top-level await，交原生加载；
- `playwright-core` / `koffi`：运行时 package assets / 原生 `.node`。

external 在产物里是 `require("<包名>")`，只能靠 Node 目录向上查找，从 `zcode.cjs`
旁边解析——也就是必须有 `glm/node_modules/<包名>`。

## 故障模式（已修复）

`@zcode/magic-context` 是 **app-server 启动路径** 上唯一直接加载的 external，
但它从未被暂存进桌面包。Worker 一启动就 `Cannot find module` 静默退出，Host 只看到
非零退出，按 `transport_closed` 上报，界面显示「数据准备进程意外退出或连接中断」——
文案完全指向不了真因。两处叠加：

1. `stage-agent-bundle.mjs` 只拷贝 `zcode.cjs`，不搬 external 依赖；
2. 即使搬了，electron-builder 的 `createFilter` 会把**拷贝根下的** `node_modules`
   整棵静默剪掉（`app-builder-lib/out/util/filter.js`：`relative === "node_modules"`）。
   旧条目 `from: bundled-agents/<platform>/glm` 让 `glm/node_modules` 恰好是拷贝根
   node_modules，进不了包。

## 规则

1. **external 依赖必须随 bundle 暂存**：`stage-agentBundle()` 按生产依赖闭包把
   `AGENT_BUNDLE_RUNTIME_EXTERNAL_MODULES`（当前仅 `@zcode/magic-context`，闭包含
   `zod`、`ai-tokenizer`）平铺进 `glm/node_modules/`（realpath 拷贝，剔除包内
   `node_modules`/`.turbo`/`*.map`/`*.tsbuildinfo`）。`@zcode/tui` / `playwright-core`
   / `koffi` 不在 app-server 启动路径，刻意不平铺（见清单注释）。
2. **暂存后自检**：从暂存产物 `require.resolve` 每个 external（含闭包成员），再实跑
   `zcode.cjs --version`。`--version` 分支会打印加载异常但仍 exit 0，所以必须同时
   断言 stderr 无 `Cannot find module`，退出码本身不可信。
3. **extraResources 取件用平台目录**：`from: bundled-agents/<platform>` +
   `filter: ["glm/**/*", ...]`，让 `glm/node_modules` 成为嵌套层，绕开 electron-builder
   对拷贝根 node_modules 的剪枝。禁止改回从 `glm` 本身取件。
4. **打包后校验**：`bundle.mjs` 的 `verifyPackagedAgentRuntimeExternalModules` 对比
   暂存源与产物 `resources/glm/node_modules`——源里有而产物没有直接失败，防同类漏搬
   （后续 hook、builder 版本行为变化等）流出坏包。

新增启动期 external（改 `resolveBuildExternal()` 或 CLI 依赖图）时：把它加进
`AGENT_BUNDLE_RUNTIME_EXTERNAL_MODULES`；规则 2 的 resolve 自检会当场拦住漏配。

## 验收场景

- `node packages/desktop/bundled-agents/<platform>/glm/zcode.cjs --version` 输出版本号，
  stderr 无 `Cannot find module`（dev 与打包产物同口径）。
- `zcode.cjs app-server --stdio --prepare-storage` 能吐出
  `{"method":"startup/storagePath",...}` 帧（Host Worker 启动即 require
  magic-context，此帧即证明加载成功）。
- 打包产物 `resources/glm/node_modules/@zcode/magic-context/package.json`（及闭包成员）
  存在；缺失时 `pnpm bundle:desktop` 在 `bundle:verify-agent-runtime-externals` 阶段失败。
- 桌面启动不再出现 `startup.global.error.transport_closed`（「数据准备进程意外退出
  或连接中断」）且根因为 agent 缺依赖的场景。
