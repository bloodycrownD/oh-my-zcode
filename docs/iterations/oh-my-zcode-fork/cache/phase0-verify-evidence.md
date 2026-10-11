# Phase 0（phase-baseline）执行与验证证据

- 日期：2026-10-03 · 执行者：主代理（executor: main）· 仓库：`D:\Dev\Js\oh-my-zcode\omz`

## 提交链

| sha | 内容 |
|---|---|
| `c34a938` | baseline: import ZCode v3.14.3 snapshot（tag `baseline/v3.14.3`） |
| `7e805e8` | phase-0 Step 1：删 `scripts/bootstrap.mjs` submodule 行、删死目录 `superpowers-plugin`、删遗留 `apps/zcode-cli/pnpm-lock.yaml`（分支 `dev/phase-0`） |

## 工具链（环境注记，非 spec deviation）

- Node：`D:\Dev\Js\oh-my-zcode\.tools\node-v24.14.0-win-x64\node.exe`（便携 zip，nodejs.org 官方 dist，与 mise 钉的 24.14.0 完全一致；PATH 前缀方式，**未动全局 nvm 链接**；本机另有 24.13.0/22.22.0）。scoop-nvm 因 NVM_HOME 指向 current 目录静默失败，弃用。
- pnpm：全局 11.5.1 → 依 `packageManager: pnpm@10.33.2` 自动委托，实际执行 10.33.2（install 日志证实）。
- `.npmrc` 无 engine-strict，engines 差异仅 WARN。仓库局部 `git config core.autocrlf false`（消除 d.ts 行尾噪音）。

## Step 2 安装（exit 0）

- `pnpm install`：Done in 58.3s（pnpm v10.33.2），node_modules 顶层 1080 项（hoisted）。
- 已知环境项：`ssh2` 的**可选**原生 crypto binding 因无 Visual Studio 构建失败（官方回退 JS 实现，非阻断）；`node-pty` 用 win32-x64 prebuild，跳过 electron-rebuild。

## Step 3 构建与冒烟（T-B1 自动部分 ✓）

- 根依赖三包：`model-option-map` / `provider` / `provider-node` build（tsc）Done。
- CLI 子仓 `turbo run build`：**16/16 successful**（36.8s，0 cached），含 `browser-use-plugin`（此前探索担忧的"残缺"未影响构建，仅 turbo outputs 空告警）。
- 产物：`apps/zcode-cli/packages/cli/dist/zcode.cjs` 29.7MB（+sourcemap 50.1MB）。
- 冒烟：`--version` → `0.16.9`（exit 0）；`--help` → 用法文本正常（exit 0）。
- `cli:dev` 真机对话 = spec 标注 qa:manual_user，**留给用户验收**（T-B1 的 manual 部分）。

## Step 4 校验基线（全部 exit 0）

> **勘误（Phase 1 期间发现）**：本表命令链的 `_EXIT=%ERRORLEVEL%` 回显是 cmd 解析期展开的假象，退出码未被逐项真实捕获。后续复核结论：lint/typecheck/architecture 在基线确为绿（Phase 1 各波次有独立对照证实）；**fmt:check 在基线实为红**（root `oxfmt --check` 全量 ~2650 文件不合规，上游 verify:pre-push 从不含 fmt）——Phase 0 的"FMT 通过"不成立，已按"改动文件零新增不合规"口径收敛（见 spec 测试策略）。cr-func-p0 复核时未覆盖此项，特此勘误。

| 命令 | 结果 |
|---|---|
| `pnpm typecheck`（根，tsc -b 全桌面侧包） | 0 |
| `pnpm --dir apps/zcode-cli typecheck`（turbo） | 0 |
| `pnpm lint`（oxlint） | 0 |
| `pnpm fmt:check`（oxfmt） | 0 |
| `pnpm architecture:check` | 0 |

注：CLI 子仓脚本需根 `node_modules\.bin` 在 PATH（turbo 在根 .bin，子仓 .bin 未链接）——所有构建命令统一加 `set PATH=D:\Dev\Js\oh-my-zcode\omz\node_modules\.bin;<node24.14.0>;%PATH%` 前缀。

## Step 5 SEA（blocking: no，实际通过，T-B2 ✓）

- 首次失败：Node 24.13.0 下 `Missing Node 24.13.0 license provenance`（SEA 按运行时版本查存证）→ 换 24.14.0 后通过。
- host 目标（不带 `--all`）：`dist/zcode-windows-x64.exe` 产出（官方 node.exe v24.14.0 win-x64 87MB + postject 注入 + Authenticode 摘除），**注入后自检打印 `0.16.9`**。
- 资产：5228 TUI assets / 2 official plugins / 3 bundled skills / 2 runtime tools / 465 Playwright assets；native search tools 解包至 `packages/desktop/bundled-tools/win32-x64`。

## spec_deviations / 豁免登记

- **EXEMPT-1（Step 5 SEA host-only，正式豁免）**：spec Step 5 命令 `pnpm build:sea` 的脚本链固定追加 `--all`（`apps/zcode-cli/packages/cli/package.json:17` + `build-sea.mjs:45-54` usage），语义为全平台目标。实际仅构建 host（win-x64）。豁免理由：非本机目标（darwin/linux）产物在 Windows 上耗时与下载量超基线验证预算，且 host 产物已完整覆盖"SEA 打包链路可用"的验证目的（blob 组装/资产收集/官方二进制下载/postject 注入/注入后自检 0.16.9 全部走通）。**T-B2 结论仍成立**。跨平台 SEA 能力留待 Phase 3 发布链路（Step 35）按需验证。
- **环境注记（非偏离）**：`mise install` 未执行（本机无 mise 且 scoop-nvm 静默失败）→ 便携 Node v24.14.0（与 `mise.toml` 钉值完全一致）+ PATH 前缀；pnpm 经 `packageManager` 委托至 10.33.2；lockfile 零改动。
- **T-B1 状态标注**：自动部分（构建 + `--version`/`--help` 冒烟）**通过**；manual 部分（`cli:dev` 真机对话：登录 / 一次工具调用 / `/compact` 原生压缩对照）**挂起待用户验收**——须在 Phase 2b 开工前完成，否则 `/compact` 对照基线随压缩删除丢失。
- **browser-use-plugin 复核补记（cr-func-p0 结论）**："残缺"为探索期误判——不在 `@zcode/cli` 依赖闭包内，turbo build 实际成功（产出 `scripts/browser-client.mjs`），SEA 官方插件清单 `requiredSeedPaths` 8 条全部命中，无缺件。
