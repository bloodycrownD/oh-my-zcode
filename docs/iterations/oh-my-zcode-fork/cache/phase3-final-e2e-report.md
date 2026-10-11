# Phase 3 最终验收波 — Step 35 发布链路验证 + 全面 E2E 终验

> 执行日期：2026-10-04/05
> 代码：`dev/phase-0` @ `27b7109`（= tag `v0.1.0`），工作树全程零改动（验收前后 `git status --short` 只剩会话开始前就存在的未跟踪 `desktop-dev.log`）
> 隔离环境：`D:\Dev\Js\oh-my-zcode\.e2e-phase3-final\`（HOME + USERPROFILE + HOMEDRIVE/HOMEPATH 四项同时重定向，`ZCODE_LOG_DIR` 指向沙箱）
> 工具链：Node v24.14.0（`D:\Dev\Js\oh-my-zcode\.tools\node-v24.14.0-win-x64`）
> 本报告作为 v0.1.0 的接受证据。

---

## 0. 一句话结论

**功能面全绿，发布面有一处真实阻断。**

B1–B9 九条验收项全部通过（含真实模型回复、Bash 工具、magic-context 默认/关闭两态、§N§ wire、
compartments 落库、`/ctx-status` S30 排版、RPC 热生效、`/compact` 移除、数据完整性、隔离审计）。

但 Step 35 的产物验证挖出一条 **v0.1.0 发布阻断**：fork 新增的 workspace 包
`@zcode/magic-context` 被 S24-fix 加进了 esbuild 的 `external` 列表，却没有同步进
**tarball 与 SEA 两条发行通道的运行时 staging**。结果是**装出来的产物起不来 agent**：

```
Cannot find module '@zcode/magic-context'
Require stack:
- <install>/.omz/runtime/current/agent/zcode.cjs
```

`omz --version` 能过，`omz` / `omz --help` / `omz --prompt ...` / `omz --web` 全部在
`runner.mjs:267` 的 `import(agentEntry)` 处退出 1。根因与修复面见 §1.4 与 §4。

---

## 1. Step 35 — 发布链路

### 1.1 `build:zcode` — 品牌适配产出验证 ✅

入口：`package.json` → `build:zcode` = `node scripts/build-zcode.mjs`。
该脚本**强制要求** `--base-url`（`build-zcode.mjs:235-236`），无 `.env` 时直接抛
`Configure ZCODE_DIST_BASE_URL in .env or pass --base-url`——第一次跑就是这么失败的，
属预期行为，不是缺陷。本次用 `--base-url file:///D:/.../dist/oh-my-zcode` 重跑。

命令：`node scripts/build-zcode.mjs --skip-build --base-url file:///D:/Dev/Js/oh-my-zcode/omz/dist/oh-my-zcode`
（`--skip-build` 复用已存在的 web/server/agent 产物；这三份产物在本波之前的构建里已经产出并被 B 组全量使用过）

产出（`omz/dist/oh-my-zcode/`）：

| 项 | 期望 | 实际 | 结论 |
|---|---|---|---|
| 目录名 | `dist/oh-my-zcode/` | `dist/oh-my-zcode/` | ✅ |
| `latest.json.name` | `oh-my-zcode` | `oh-my-zcode` | ✅ |
| `latest.json.tarball` | `oh-my-zcode-<ver>.tar.gz` | `oh-my-zcode-3.14.3.tar.gz` | ✅ |
| tarball 根目录 | `oh-my-zcode/` | `oh-my-zcode/` | ✅ |
| tarball 条目数 / 体积 | — | 15 099 条 / 79.1 MB | — |
| 顶层目录 | — | `agent/ bin/ node_modules/ package.json server/ web/` | ✅ |
| `bin/omz.mjs` | 在 | 在 | ✅ |
| `agent/zcode.cjs` | 在（内部 bundle 名，保留正常） | 在 | ✅ |
| `agent/provider/zcode-builtin.json` | 在 | 在 | ✅ |
| `agent/THIRD-PARTY-NOTICES.md` | 在 | 在 | ✅ |
| `server/entry-http.js` / `web/index.html` | 在 | 在 | ✅ |
| node-pty 预编译 | 10 平台 | 10（win32-x64/arm64, linux-x64/arm64, darwin-x64/arm64） | ✅ |
| `sha256.txt` 与 latest.json 一致 | 是 | 一致（`0f319244…`） | ✅ |
| 顶层未品牌化目录 | 0 | 0 | ✅ |

`install.sh` 品牌面全部正确：`BASE_URL` 默认值、`$HOME/.omz/runtime` 安装根、`$HOME/.local/bin/omz`
bin 名、`"$TARGET.new/oh-my-zcode"` 解包目录、`echo "oh-my-zcode $VERSION installed."`。

**一处需要登记的观察（不阻断）**：包内唯一那份 `package.json` 的 `name` 是
`zcode-runtime`（`build-zcode.mjs:206-218` 写死，`private: true`），不是 `oh-my-zcode`。
它是**运行时占位 stub**，从不上 npm；对外身份由 `latest.json.name` / tarball 名 /
`install.sh` 三个面承担，三者都是新品牌。上游原本也是这个写法，Step 35 未要求改。

证据：`evidence/build-zcode-inspect.json`、`evidence/tarball-listing.txt`、
`logs/build-zcode.log`。

### 1.2 `build:sea` — EXEMPT-2（跨平台 runtime 解包失败）+ 一个必须修的真阻断

入口：`pnpm build:sea` → `pnpm --dir apps/zcode-cli build:sea` → `node scripts/build-sea.mjs --all`。

**EXEMPT-2a（宿主限制，登记豁免）**：`--all` 在 Windows 宿主上跑到 darwin-arm64 的
Node runtime 解包时失败：

```
node-v24.14.0-darwin-arm64/bin/corepack: Can't create '...': Invalid argument
node-v24.14.0-darwin-arm64/bin/npx:     Can't create '...': Invalid argument
node-v24.24.0-darwin-arm64/bin/npm:     Can't create '...': Invalid argument
Could not extract ... node-v24.14.0-darwin-arm64.tar.gz
```

Node 官方 tarball 里 `corepack/npx/npm` 是符号链接，Windows NTFS 无开发者模式时
`tar` 无法创建软链。这是 Phase 0 **EXEMPT-1（SEA host-only）** 的同一类问题：产物只能在
对应宿主上构建。与 fork 无关，不阻断。

**资产收集面 ✅（这是 Step 5/35 指定的缺件暴露点）**：在失败之前，SEA 资产清单是完整的——

```
[sea] generating SEA blob for win-x64 with 5230 TUI assets,
      2 official plugins, 3 bundled skill files,
      2 runtime tools, and 465 Playwright assets
Wrote single executable preparation blob to dist/zcode-win-x64.sea.blob
[sea] building win-x64 -> dist\zcode-windows-x64.exe
[sea] removed and truncated Windows Authenticode signature at offset 91364352
Start injection of NODE_SEA_BLOB ... Injection done!
```

`browser-use-plugin` / `bundled-skills` 的缺件问题**没有复现**，R10 在本波不成立。

改为只构宿主平台 `node scripts/build-sea.mjs --target win-x64` → blob + exe 全部产出，
**但自带 smoke test 挂了**：

```
[oh-my-zcode] 数据目录已更名：...
No such built-in module: @zcode/magic-context
dist\zcode-windows-x64.exe --version failed
```

**这是 §1.4 同一条根因**，且在 SEA 通道上表现为 `No such built-in module`（SEA 没有
磁盘 `node_modules` 可回落）。按指令登记为 **EXEMPT-2b**，但它不是「host-only」级别的
豁免——它意味着 **SEA 单文件发行物起不来**，与 tarball 通道同级阻断。

证据：`logs/build-sea.log`、`logs/build-sea-win.log`、
`apps/zcode-cli/packages/cli/dist/sea-config-win-x64.json`（5 736 个 asset，无任何
`@zcode/magic-context` 条目）。

### 1.3 `install.sh` 本地 file 源安装演练 ✅（安装本身成功，产物启动被 §1.4 阻断）

仓库里**没有 npm 发布通道**：根 `package.json` 与 `apps/zcode-cli/package.json` 都是
`private: true`，`build:zcode` 产出的也不是 npm 包而是 `releases/<ver>/oh-my-zcode-<ver>.tar.gz`。
spec 里写的「install.sh 本地 file 源安装演练」对应的正是这条 tar.gz + install.sh 通道，
所以演练按 `install.sh` 做（不是 npm pack / npm install）。

用 msys2 bash（`GNU bash 5.2.26`，Scoop shims）跑，`ZCODE_DIST_BASE_URL` 指向
`file:///D:/Dev/Js/oh-my-zcode/omz/dist/oh-my-zcode`：

```
== install.sh (file:// source) ==
100 75.4M  curl  ← curl 直接吃 file:// URL，下载 tar.gz
oh-my-zcode 3.14.3 installed.
Run: omz (TUI) or omz --web (Web)

== installed tree ==
~/.omz/runtime/current -> releases/3.14.3   (agent bin node_modules package.json server web)
~/.local/bin/omz                            (121 B sh wrapper, +x)

== run the installed bin: omz --version ==
3.14.3                                       ← 通过（只读 package.json，不加载 agent 模块图）
```

**install.sh 本身全绿**：file 源取 `latest.json` → 解析 version/tarball → curl 拉 tarball →
解包 → 软链 `current` → 落 bin wrapper → 打印品牌文案。bin 名 `omz`、安装根
`~/.omz/runtime`、品牌回显全部正确。

紧接着跑真实 TUI/agent 路径就撞上 §1.4：

```
$ ~/.local/bin/omz --help
[oh-my-zcode] 数据目录已更名：本产品现在使用 …
Cannot find module '@zcode/magic-context'
Require stack:
- <install>/.omz/runtime/current/agent/zcode.cjs
```

证据：`evidence/a3-install-sh.txt`。

> **勘误（M1 修复后）**：上面的 `evidence/a3-install-sh.txt` 是 **M1 修复之前**的演练输出（安装成功、产物启动被 §1.4 阻断）。**M1 修复之后的 install 演练证据不在本目录**，而在仓库外的 `D:\Dev\Js\oh-my-zcode\.e2e-s35\`：
> - `install-drill2.txt` —— M1 修复后的 `install.sh` 安装树复验（`~/.omz/runtime/current` + bin wrapper + 品牌回显）；
> - `prompt-drill.txt` —— 安装后真实 prompt 链路复验（含 `S35FIX-MARKER-OK`、`BASH-DONE`、`magic-context.db` 落盘、真实 `~/.omz` 未被污染）。
>
> 早期「无落盘证据」的说法是查错了沙箱（查了 `.e2e-phase3-final/` 而非 `.e2e-s35/`），并非修复无效。

### 1.4 🔴 BLOCKER：发行产物缺 `@zcode/magic-context`，agent 起不来

**根因链**

1. S24-fix 因为 `@zcode/magic-context` 的 SQLite chokepoint 用了可变说明符动态 import
   （产物里有模块级 await，CJS 打不了）而把它加进 esbuild 的 external 列表：

   `apps/zcode-cli/packages/cli/scripts/build.mjs:14-27`
   ```js
   export const resolveBuildExternal = () => [
     "@zcode/tui",
     "@zcode/magic-context",   // ← S24-fix 新增
     "playwright-core",
     "koffi",
   ];
   ```

2. 于是 `dist/zcode.cjs` 里它是一条 `require("@zcode/magic-context")`，**运行期**解析。

3. 仓库里能解析，是因为 pnpm workspace 在 `apps/zcode-cli/packages/cli/node_modules/@zcode/`
   下有软链。**一旦离开仓库，两条发行通道的 staging 白名单都没带上它**：

   - tarball：`scripts/zcode-distribution/assets.mjs` 的 `runtimePackageNames`（第 12-30 行，
     14 个包，无 `@zcode/magic-context`）；`stageTuiRuntime` 只搬 TUI 闭包
   - SEA：`apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs:127-139` 的种子队列从
     `@zcode/tui` 出发按 manifest 递归收依赖，magic-context 不在可达图里

**实测证据（三条独立）**

1. tarball 内 `node_modules/@` 只有 3 个 scoped 包（`@hono/node-server`、`@hono/node-ws`、`@hono`），
   **0 个** `magic-context` 资产（`evidence/check-tarball-nm` 输出，落进
   `evidence/tarball-listing.txt`）。
2. 安装后 `agent/node_modules/@zcode/` = `contracts, i18n, model-option-map, shared, tui`
   ——**没有 magic-context**。
3. 反证（决定性）：把 `packages/magic-context/dist` + `package.json` 手工塞进解包目录的
   `agent/node_modules/@zcode/magic-context/` 之后，同一个 tarball 解出来的产物立刻正常：

   ```
   $ node agent\zcode.cjs --version
   0.16.9
   ```

   （改之前同一命令是 `Cannot find module '@zcode/magic-context'`。复现目录保留在
   `.e2e-phase3-final/stage/oh-my-zcode/`。）

**影响面**

| 通道 | `--version` | agent / TUI / `--prompt` / `--web` |
|---|---|---|
| 仓库内直跑 `dist/zcode.cjs` | ✅ | ✅ |
| tar.gz + install.sh | ✅ | ❌ `Cannot find module` |
| SEA 单文件 | ❌ `No such built-in module` | ❌ |

即：**v0.1.0 目前无法通过任何一条发行通道交付可用的 CLI**。这是本波唯一的红项，
也是 Step 35（`blocking: no`）在收官时最该抓到的那一类问题——仓库内一切正常，
一打包就塌。

**修复面（未实施，按「不改 src 代码」纪律留给下一波）**：把 `@zcode/magic-context`
加进上述两处 staging 白名单。具体是

- `scripts/zcode-distribution/assets.mjs` → `runtimePackageNames` 加一项
  （需确认 `copyRuntimeNodeModules` 走的是 `runtimePackageNames` 还是 TUI 资产通道；
  `agent/node_modules/@zcode/` 里已有 tui 说明 TUI 是走 `stageTuiRuntime` 落的，
  magic-context 更像是该走同一条，见 `sea-tui-assets.mjs:127-139` 的种子队列）
- `apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs` → 种子队列加
  `{ fromDirectory: <cli 或 magic-context 目录>, packageName: "@zcode/magic-context" }`

改动量估计 >2 行且需要实际构建验证，**不在本波「≤2 行显然修复」范围内**，因此未动代码。

---

## 2. 全面 E2E 终验矩阵（B1–B9）

主会话：`sess_4412808b-3e11-4f59-81c8-db92b6f2b251`（on 臂）
关闭臂：`sess_f51d0a7f-c7b7-4eb4-bb0b-bff42ab60e0d`（off 臂）

### 2.1 结论表

| # | 项 | 结论 | 关键证据 |
|---|---|---|---|
| B1 | 身份与首启 | ✅ PASS | `--version` = `0.16.9`；`--help` 头行 `omz 0.16.9`；首启提示 run1 出现、run2 不出现 |
| B2 | 核心会话链路 | ✅ PASS | 真实模型回复 marker、1 次 Bash 工具调用、10 次 model request、4+ 轮上下文延续、`--resume` 历史完整 |
| B3 | magic-context 默认 on | ✅ PASS | wire 21 处 `§N§`；tags 29 行；compartments 1 条；`/ctx-status` 三分节；`usage.magicContext` 字段齐全 |
| B4 | magic-context 显式 off（T-M8） | ✅ PASS | off 臂 wire `§N§` 命中 **0**；mc.db 里该 session **0 行**；日志无任何 `magic_context.*` 事件 |
| B5 | 配置面 RPC 热生效（T-U1） | ✅ PASS | 真 app-server stdio：`read 65 → update 73(changed/applied) → 落盘 73 → 同进程 read 73`；`updatedSessionCount:1` |
| B6 | 压缩移除（T-M9 真机侧） | ✅ PASS | `/compact` → `Unknown slash command`；可用命令表无 `/compact`，有 4 个 `/ctx-*` |
| B7 | 后端可用性（T-P2 自动面） | ✅ PASS | 真实 coding-plan 回复；marketplaces 目录建成、合并 manifest `name=oh-my-zcode-official`、CDN 源列出、2 插件已装 |
| B8 | 数据完整性 | ✅ PASS | session.db 全表 `LIKE '%compact%'` = **0**；usage 表 17 行健全；mc.db fence 到 v94、`migration_pending` 空；tags 1..29 唯一 |
| B9 | 隔离审计 | ✅ PASS | 真实库中以 omz session id **为自身标识**的行数 = **0**；隔离 HOME 内无 `.zcode`；真实 `~/.omz` 不存在 |

### 2.2 B1 身份与首启

`--version` → `0.16.9`。`--help` 首行 `omz 0.16.9`，`Usage: omz [command] [options]`，
`With no command, omz opens the full-screen TUI.`——品牌改名（L1）在 CLI 自述面上完整生效。

首启提示（`data-dir-notice.ts`）在全新沙箱 HOME 下：

```
run1:
[oh-my-zcode] 数据目录已更名：本产品现在使用 D:\...\e2e-phase3-final\home\.omz。
[oh-my-zcode] 旧的 D:\...\home\.zcode 不会被自动迁移——请按需自行把里面的内容复制到新目录后重启。
0.16.9

run2:
0.16.9
```

marker 文件 `~/.omz/.oh-my-zcode-first-run-notice` 落盘，二次启动不再出现。
**未**出现「检测到旧目录仍然存在」那一行——正确，因为隔离 HOME 里确实没有 `.zcode`（见 B9）。

> **偏差登记**：验收条目要求「help 有 `/ctx-*`」。`--help` 的 Slash Commands 段**没有**
> `/ctx-*`。查证后确认这是 fork 的既定设计，不是回归：`zcode-slash-command-help.ts:194-197`
> 明确写「这一组是本地命令……**不进 App 的 `/` 面板**」。它们确实在帮助表里，
> `/help ctx-status` 正常返回条目全文（`evidence/b3-help-ctx-status.txt`）。
> 若要让 `--help` 也列出，需要往 `i18n/src/locales/{en-US,zh-CN}.ts` 的 help 串里加 4 行，
> 属产品决定，留给用户拍板。

证据：`evidence/b1-*.txt`、`evidence/b3-help-ctx-status.txt`、`evidence/b6-help-compact.txt`。

### 2.3 B2 核心会话链路

| 子项 | 结果 |
|---|---|
| 新会话 + 真实模型回复 | turn1 prompt「Reply with exactly: P3FINAL-MARKER-ALPHA」→ 输出 `P3FINAL-MARKER-ALPHA` |
| Bash 工具调用（yolo） | turn2：`Bash(echo TOOLCHECK-OMZ-OK > tool-marker.txt)` → 回复 `BASH-TOOL-DONE`，磁盘出现 `tool-marker.txt` 内容 `TOOLCHECK-OMZ-OK` |
| modelRequestCount | 10 次 model-io 记录（≥2 满足；含工具回合的二次请求） |
| 多轮上下文延续 | turn3 问「第一轮让你 echo 的 marker」→ `P3FINAL-MARKER-ALPHA`；turn4 问「用 Bash 建的文件名」→ `tool-marker.txt` |
| `--resume` 续话 | `--resume sess_4412808b-…` → 问「当前目录下所有文件名」→ `README.md, tool-marker.txt`，历史完整 |

证据：`evidence/b2-turn*.txt`、`evidence/b2-resume.txt`、`evidence/b2-b3-modelio-on.json`。

### 2.4 B3 magic-context 默认态（on）

**wire 层（§N§ tag）** — `ZCODE_RUNTIME_ENV=development` 下 model-io 落 `~/.omz/cli/debug/`。
第 5 次请求 16 条消息，命中 13 处 tag，编号单调递增、覆盖 system/user/assistant/tool 四种 role：

```
[0] system    §1§   [1] system   §2§   [2] system    §3§
[5] user      §4§   [6] user     §5§   [7] user      §6§
[8] assistant §7§   [9] user     §8§   [11] tool     §9§
[12] assistant §10§ [13] user     §11§ [14] assistant §12§
```

**mc 库落盘** — `~/.omz/cli/db/magic-context.db`：

```
tags         29 行，全部 status=active，type: message 23 / tool 6
             tag_number 1..29 唯一，harness=zcode，token 合计 3 085
compartments  1 条  mc1 -> mc15  title="E2E phase3 marker test session"   ← historian 真实摘要
pending_ops  14
session_meta sess_4412808b: protected_tokens_effective=50000,
             last_input_tokens=14531, last_context_percentage=1.4531,
             cached_m0_bytes=35B, cached_m1_bytes=90B
```

> **踩坑记录（值得留给下一波）**：第一次跑时 `compartments` 恒为 0。日志里
> `magic_context.config_readiness` 直接把原因写出来了——
> 「magicContext 已启用但未配置 historian 模型……请在用户级 config.json 的
> `magicContext.historian.model` 字段写入旁路模型 ID」。补上
> `{"magicContext":{"historian":{"model":"bigmodel-api/GLM-5.3"}}}` 之后，
> 再跑两轮真实会话，historian 就落了 compartment。**这是配置缺失，不是代码缺陷**，
> 但它意味着「开箱即用」时 T-M6 相关的分舱能力是关闭的，报错文案已有指引，可接受。

**`/ctx-status`（S30 / D-13 排版）** — headless `--prompt` 只特判 `/help`、`/skill`、
`/login`、`/logout`（`prompt-command.ts:79-102`），本地命令只在 TUI 里被消费，
所以走**同一个 handler + 同一份真实 mc.db** 的 harness 取证（`handleCtxCommand("ctx-status", …)`，
deps 只提供 `getApp()` 返回真实 sessionId）：

```
Magic Context status
session  sess_4412808b-3e11-4f59-81c8-db92b6f2b251

BUDGET
  protected floor     50,000
  last context usage  1%
  last input tokens   14,531

COMPARTMENTS
  count                   1
  last compacted message  15
  pending operations      14

TAGS
  active     29 (3,085 tokens)
  dropped    0 (0 tokens)
  compacted  0 (0 tokens)
```

BUDGET / COMPARTMENTS / TAGS 三分节、千分位、未知值统一 `-`——S30 排版口径达成。

**用量面板数据链** — 用 D-13 投影层同一个读入口
（`readMagicContextUsageSummary`，`bootstrap/src/app/magic-context-usage-summary.ts`）
对着同一份真实 mc.db 取 `snapshot.usage.magicContext` 的载荷：

```json
{
  "budgetTokens": 50000,
  "usedTokens": 14531,
  "usedPercent": 1.4531,
  "compartmentCount": 1,
  "droppedTagCount": 0,
  "droppedTagTokens": 0,
  "cache": { "m0": true, "m1": true }
}
```

字段与 `packages/shared/src/zcode-protocol-v4/snapshot.ts:217-226` 的
`sessionMagicContextUsageSchema` 逐项对齐；`cache.m0/m1 = true` 说明本轮 m[0]/m[1]
注入块直接命中上下文缓存（T-M5 的正面读数）。

证据：`evidence/b2-b3-modelio-on.json`、`evidence/b3-ctx-status-after-historian.txt`、
`evidence/b3-ctx-status-and-usage.txt`、`evidence/b8-fence.json`。

### 2.5 B4 magic-context 显式关闭（T-M8）

off 臂 = 项目级 `work-off/.zcode/config.json`：

```json
{ "features": { "magicContext": false }, "magicContext": { "enabled": false } }
```

| 观察面 | on 臂 | off 臂 |
|---|---|---|
| wire `§N§` 命中 | 21 | **0** |
| model request / tool call | 10 / 3 | 3 / 1（功能完全正常） |
| mc.db `tags` 行 | 29（全在 on session） | **0** |
| mc.db `session_meta` 行 | 1（on session） | **0** |
| 日志 `magic_context.*` 事件 | `config_readiness` / `usage_recorded` / `usage_primed` | **一条都没有** |

最后一行是比「行数为 0」更强的证据：transform 根本没被装配，所以不存在「建了库但不写」
的可能——T-M8「零差异」在能观测到的所有面上成立。

> 口径说明：验收条目写的是「mc 目录连库都不建」。本波 on/off 两臂共用同一个沙箱 HOME，
> 库已被 on 臂建好，所以「不建库」这一条无法在共享 HOME 里直接展示；上面的
> `session_meta`/`tags` 零行 + 零 `magic_context.*` 事件已经等价地证明了
> off 态下 fork 对 magic-context 存储零接触。

证据：`evidence/b4-off-turn*.txt`、`evidence/b4-modelio-both.json`。

### 2.6 B5 配置面 RPC 热生效（T-U1，RPC 级）

**验证面**：真 `omz app-server` 子进程 + stdio NDJSON 帧（desktop host 用的同一条通道），
由 Node 驱动真实 JSON-RPC。踩到两个协议细节值得记下来：请求信封是 `.strict()` 的，
**不能带 `jsonrpc` 字段**；`session/create` 会反向请求
`session/requestRuntimePreferences`，client 必须应答否则 15 s 超时（`-32022`）。

```
session/create                                        ok, sess_25aacc6f-…
workspace/readMagicContextConfig            (before)  execute_threshold_percentage = 65
workspace/updateMagicContextConfig                     changed: true, applied: true,
                                                      path: <sandbox>/home/.omz/cli/config.json
config.json 落盘读回                                     73
workspace/readMagicContextConfig            (after)   73      ← 同一进程，未重启
workspace/updateMagicContextConfig           (重复)    changed: false        ← 幂等
```

日志侧同刻的三条（`logs/zcode-log/zcode-2026-10-05.jsonl`）：

```
22:09:05 zcode_protocol.magic_context.config_read   { fromConfigPort: false, … }
22:09:05 zcode_protocol.magic_context.config_updated { changed: true,  updatedSessionCount: 1, … }
22:09:05 zcode_protocol.magic_context.config_updated { changed: false, updatedSessionCount: 1, … }
```

`updatedSessionCount: 1` 是关键：不是「只有文件变了」，而是 ConfigPort fan-out 真的推到了
那个还在跑的 session 上。handler 的 ①②③ 三段（校验 → `atomicWriteJson` 落盘 →
`configPort.set` 广播）在真协议面上按序走通。

**一处与文档不符的行为（登记，不阻断）**：`MagicContextConfigSchema` 对白名单外字段是
**strip 而非 reject**。`{"definitely_not_a_field": 1}` 没有返回 `-32602`，而是安静地被剥掉
（返回值里看不到该键）。`magic-context-config.ts:113-123` 的注释与 `formatIssues` 分支
读起来像「未知键会被拒」，实际语义是「未知键被忽略、类型错误才被拒」。S29 单测覆盖的是
类型错误路径，所以这条没被测出来。不构成安全问题（写入的一定是规范化后的域），但注释
与行为对不上，建议下一波改注释或改 schema 语义二选一。

证据：`evidence/b5-rpc.txt`、日志。

### 2.7 B6 压缩移除终验（T-M9 真机侧）

`--prompt "/help compact"` 的真机回包：

```
Unknown slash command: /compact. Available commands: /help, /login, /logout, /init,
/expert, /effort, /dwf, /fork, /locale, /mcp, /plugins, /mode, /model, /new, /resume,
/rewind, /skill, /goal, /workflow, /ctx-status, /ctx-reduce, /ctx-expand, /ctx-recomp.
```

- `/compact` 不被识别 → 未知命令
- 可用命令表里没有 `/compact`，有 4 个 fork 新增的 `/ctx-*`
- `--help` 全文（`evidence/b1-help.txt`）同样没有 `/compact`

T-M9 的真机侧达成。

### 2.8 B7 后端可用性（T-P2 自动面）

**登录 + Coding Plan**：新目录、全新会话拿到真实模型回复（`P3FINAL-MARKER-ALPHA` 等 6 轮），
说明 `credentials.json` 种子 + `provider_config.json`（`builtin:bigmodel` → GLM-5.3，
`https://open.bigmodel.cn/api/anthropic`）+ 出网链路整条通。`model_usage` 17 行里
`provider_id=bigmodel-api`、`model_id=GLM-5.3`、`finish_reason` 齐全、
`cache_read_input_tokens` 正常增长。

**插件市场**：

```
$ omz plugins list
Plugins (2)
- node-repl-host@oh-my-zcode-official [enabled]
- browser-use@oh-my-zcode-official [enabled]   skills: 2

$ omz plugins marketplace list
Marketplaces (1)
- oh-my-zcode-official [official]: 1 plugins
  source: url https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json
```

落盘结构：

```
~/.omz/cli/plugins/marketplaces/oh-my-zcode-official/marketplace.json
  { name: "oh-my-zcode-official", plugins: [node-repl-host, browser-use] }   ← 合并清单
~/.omz/cli/plugins/marketplaces/oh-my-zcode-official/bundled-marketplace.json
  { manifest, version }                                                        ← bundled 分片
~/.omz/cli/plugins/cache/oh-my-zcode-official/{browser-use/0.5.1, node-repl-host/0.6.0}
```

`4c8a580` 的「接受旧 CDN id 别名」在改名后仍然生效：marketplace 以
`oh-my-zcode-official` 出现在列表里、CDN 源能拉到分片、bundled 分片与 CDN 分片成功合并
（合并清单里两个插件都在，且 browser-use 的 2 个 skill 被正确加载）。
**CDN 分片刷新在本环境可达、无异常**——T-P2 的可自动化部分全过。

### 2.9 B8 数据完整性

**session.db（`~/.omz/cli/db/db.sqlite`）**

| 表 | 行数 |
|---|---|
| session | 2（on + off 臂各一） |
| message | 29 |
| part | 77 |
| model_usage | 17 |
| turn_usage | 11 |
| tool_usage | 7 |
| session_entry | 7 |

- **压缩残留扫描**：遍历 22 张表的每一列做 `CAST(col AS TEXT) LIKE '%compact%'`，
  **命中 0**（`compactLikeHits: {}`）。T-M9 / T-M10 的数据侧达成。
- usage 健全：`model_usage` 行含 `input_tokens / output_tokens / cache_read_input_tokens /
  finish_reason / duration_ms / time_to_first_token_ms / raw_usage_json`，
  `status=completed`，无 error 字段。
- 迁移：最后三条 `schema_migration` = `0020/0021/0022`，checksum 齐全。

**mc.db**

- **fence**：`schema_migrations` 到 **version 94**（85/87 号是上游自身退役/跳号），
  `schema_migrations_meta` 两条 key 正常，`migration_pending` **空**（干净退出，无跨宿主迁移挂起）。
- **tags 结构断言**：29 行 / `status` 全 active / `tag_number` 1..29 无重复 /
  `harness` 只有 `zcode` / `type` 只有 message+tool —— 与 §2.4 的 wire 编号一一对应。
- **compartments**：1 条，边界 `mc1 → mc15`，标题是 historian 真实摘要。

证据：`evidence/b8-fence.json`、`evidence/b8-db-final.json`。

### 2.10 B9 隔离审计

| 检查 | 结果 |
|---|---|
| 真实 `~/.zcode/cli/db/db.sqlite` 中**以 omz session id 作为自身 id 列值**的行数 | **0** |
| 真实 `~/.zcode/v2/tasks-index.sqlite` 同上 | **0** |
| 真实库最新会话 | 全部 `sess_subagent_agent_*`（本次验收的编排 agent 自身，不是被测 CLI） |
| 隔离 HOME（`e2e-phase3-final/home`）内是否存在 `.zcode` | **不存在** |
| 隔离 HOME 内 `.omz` 条目 | `.oh-my-zcode-first-run-notice`, `cli`, `v2` |
| 真实 `~/.omz` 是否存在 | **不存在**（收尾时确认） |

> **一个必须说清的口径陷阱**：先用「全文件 LIKE」粗扫时，真实库里出现了 201 行命中。
> 逐条拆开后确认**全部落在 `part.data` 一列**，内容是**本次验收的编排 agent 自己
> 正在写的会话转录**——我用来驱动被测 CLI 的 shell 命令里字面量包含了那些 session id
> 与 marker 串。于是改用「id 列精确等值」重扫，结果为 0（`evidence/b9-session-rows.json`）。
> 结论：**被测 CLI 未写真实数据根**；那 201 行属于验收工具链自己，与 fork 无关。

> **agent 侧的一次误写与清理**：最初准备沙箱种子时用了「`set VAR=…` 与 `%VAR%` 同行」
> 的 cmd 写法（同行 `%VAR%` 在解析期就被展开成空串），导致 `credentials.json` 的一份副本
> 被写到了真实家目录下的 `~/.omz/v2/`；后来的 install.sh 演练因 msys bash 未同步
> `USERPROFILE`，首启提示又把 marker 写进了同一个真实 `~/.omz`。`~/.omz` 在本波开始前
> **不存在**（会话开始时 `dir "%USERPROFILE%\.omz"` 返回空），两处均已 `rmdir /s /q` 删除并
> 复核为不存在。真实 `~/.zcode` 全程未被写入。

---

## 3. 未完成 / 降级项清单

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| M1 | 🔴 **发行产物缺 `@zcode/magic-context`** | **BLOCKER，未修** | §1.4。tarball + SEA 两条通道的 agent 都起不来。根因定位到 `build.mjs:22-27` 的 external 与两处 staging 白名单不同步。修复面 >2 行，留给下一波。 |
| M2 | `--help` 不列 `/ctx-*` | 设计如此，待用户拍板 | §2.2。命令本身、`/help <cmd>`、解析、handler 全在；只是没进 `--help` 的那串静态文案。 |
| M3 | `MagicContextConfigSchema` 对未知键 strip 而非 reject | 与注释不符，登记 | §2.6。写入的永远是规范化后的域，无安全影响；建议改注释或改语义。 |
| M4 | `build:sea --all` 跨平台 runtime 解包 | EXEMPT-2a，宿主限制 | §1.2。NTFS 软链限制，与 fork 无关；按 EXEMPT-1 先例登记。SEA 资产收集面本身全过。 |
| M5 | 「off 态连库都不建」严格形态 | 口径降级 | §2.5。共享 HOME 下库已由 on 臂建好；已用 `session_meta`/`tags` 零行 + 零 `magic_context.*` 日志事件等价替代。 |
| M6 | historian 默认未配置 | 配置项，非缺陷 | §2.4。`magic_context.config_readiness` 有明确文案指引；补配置后 compartments 正常落库。 |
| M7 | T-M6 / T-M2 / T-M3 的完整重跑 | 部分 | T-M6 本波已在真机达成（compartment 落库 + m[0] 渲染）。T-M2（`[dropped §N§]` 连续 pass 字节一致）需要更长会话制造 drop，本波 `dropped=0`，未复现；字节一致性仍由 S24-fix2 的 `test-transform.mjs` b3/b4 单测背书。 |
| M8 | T-P2 的 GUI 侧（浏览器登录 / 插件安装交互） | manual | 本波只覆盖自动面（既有登录态可用 + marketplace 解析/缓存/合并）。 |
| M9 | 打包后 `--web` 模式 UI 实测 | 被 M1 阻断 | `--web` 的 agent 子进程同样起不来，M1 修好后需补一次真机 `--web` 冒烟。 |

**需要用户决定的事**：M2（`--help` 要不要列 `/ctx-*`）、M1 的修复排期。

---

## 4. 环境与纪律记录

**环境坑（留给下一个执行 agent）**

1. cmd.exe 里 `set "VAR=…"` 与 `%VAR%` **同行**时 `%VAR%` 在解析期就被求值 → 得到空串。
   本波最初两次种沙箱就是这样把文件放错位置的。所有驱动脚本最终都写成独立 `.cmd`
   （`prompt.cmd` / `run.cmd` / `ctx-harness.cmd` / `rpc.cmd`）。
2. `shift` 不影响 `%*`；`run.cmd` 那版 `shift shift` + `%*` 的组合把 `work` 当成了
   CLI 参数。最终换成 Node 直接 spawn（`cli-run.cjs` / `rpc-b5.cjs`），彻底绕开。
3. `node -e "多行脚本"` 经 cmd 传参会静默失败（无输出、无报错）；改成写 `.cjs` 文件跑。
4. `findstr` 不支持 `\|` 交替；`head` 不存在（Scoop 环境）。
5. ZCode Protocol 请求信封 `.strict()`，**不带 `jsonrpc` 字段**；`session/create` 需要
   client 应答反向请求 `session/requestRuntimePreferences`。
6. `build-zcode.mjs` 强制 `--base-url`。
7. bash 5.2.26 是 **msys2**（Scoop shims），不是 git-bash：`file:///d/...` 打不开，
   必须写 Windows 形式 `file:///D:/...`；且 `ln -sfn` 建的是 msys 软链。

**隔离纪律执行情况**

- 全程 `HOME` + `USERPROFILE` + `HOMEDRIVE` + `HOMEPATH` 四项重定向，
  `ZCODE_LOG_DIR` 显式指到沙箱（否则日志会落到真实 `~/.zcode/cli/log`，与 S32 §2.1 的坑同源）。
- 登录种子按 S32 做法复制 4 个文件：`v2/credentials.json`、`v2/config.json`、
  `v2/provider_config.json`、`cli/config.json`。
- 未对真实 `~/.zcode` 做任何写入；未打新 tag；HEAD 仍是 `27b7109`。
- **未改 src 代码**。唯一的仓库内临时文件
  `apps/zcode-cli/packages/cli/e2e-ctx-status-scratch.mts`（`/ctx-status` 取证 harness）
  已在收尾时删除，`git status --short` 只剩会话开始前就存在的 `desktop-dev.log`。

**一个环境侧未解释现象（如实记录）**：在 `install-home/.omz/runtime/current/...` 这条
**msys 软链路径**下，向 `agent/node_modules/@zcode/` 手工加入的目录，在一次 `omz` 调用后
消失（同样的事在沙箱 `.omz/v2/` 的种子文件上也出现过一次，但在普通目录下的对照实验
证明 **CLI 不会删除数据根里的任何文件**——探针文件 `probe.txt` / `probe2.txt` 跨多次运行存活）。
因此 §1.4 的反证改在**普通目录**（`.e2e-phase3-final/stage/`）里完成，结果成立。
这个现象归为沙箱/宿主侧（杀软或索引器持句柄一类），**未归因到 fork 代码**，但如实登记。

---

## 5. 证据目录

> **勘误**：本节列出的是 `.e2e-phase3-final/` 沙箱，**只覆盖 M1 修复之前**的演练。**M1 修复后**的 install 演练证据在仓库外的 `D:\Dev\Js\oh-my-zcode\.e2e-s35\`（`install-drill2.txt` / `prompt-drill.txt`，另有该轮的 `build-*.log`、`g-typecheck.log` / `g-turbo-tc.log` / `g-lint.log` / `g-oxfmt*.txt` / `g-tests.log` 门禁日志，以及 `s35-install.sh` / `s35-prompt.sh` 两个驱动脚本）。查找 M1 之后的结果时请到 `.e2e-s35/`，不要只看下面的目录树。详见 §1.3 末尾的勘误注记。

```
D:\Dev\Js\oh-my-zcode\.e2e-phase3-final\
├── env.cmd / run.cmd / prompt.cmd / rpc.cmd / seed.cmd / ctx-harness.cmd / cli.cmd
├── cli-run.cjs            通用隔离环境 CLI runner（Node spawn）
├── rpc-b5.cjs             真 app-server stdio NDJSON JSON-RPC 驱动（T-U1 取证）
├── analyze-modelio.cjs    model-io 解析：请求数 / 工具调用 / §N§ wire 取证
├── db-inspect.cjs / b8-fence.cjs   mc.db + session.db 只读断言
├── b9-audit.cjs / b9-marker-split.cjs / b9-session-rows.cjs   隔离审计
├── inspect-tarball.cjs / check-tarball-nm.cjs / inspect-marketplace.cjs / set-config.cjs
├── a3-install.sh          install.sh file:// 源安装演练
├── home/                  隔离 HOME（.omz：cli/db、cli/debug、cli/plugins、v2）
├── work/                  on 臂工作区（README.md, tool-marker.txt, notes.md）
├── work-off/              off 臂工作区（.zcode/config.json 关 magicContext）
├── install-home/          install.sh 安装目标（.omz/runtime/{current,releases}）
├── stage/oh-my-zcode/     tarball 解包 + 手工补 @zcode/magic-context 后的反证现场
├── logs/                  build-zcode.log, build-sea.log, build-sea-win.log, zcode-log/
└── evidence/              全部证据文件（见下）
```

关键证据文件：

| 文件 | 内容 |
|---|---|
| `evidence/build-zcode-inspect.json` | tarball 结构 + 12 条品牌断言 |
| `evidence/tarball-listing.txt` | 15 099 条 tar listing（§1.4 的「0 个 magic-context 资产」出处） |
| `evidence/a3-install-sh.txt` | install.sh file:// 源完整输出（含阻断报错） |
| `logs/build-sea.log` / `logs/build-sea-win.log` | SEA 资产清单 + EXEMPT-2a + smoke 失败 |
| `evidence/b1-run1.txt` / `b1-run2.txt` | 首启提示一次/不出现 |
| `evidence/b2-b3-modelio-on.json` | 10 次请求、3 次工具、21 处 §N§ |
| `evidence/b3-ctx-status-after-historian.txt` | `/ctx-status` 三分节 + `usage.magicContext` |
| `evidence/b4-modelio-both.json` | on/off 两臂 wire tag 对比（21 vs 0） |
| `evidence/b5-rpc.txt` | T-U1 完整 RPC 往返 |
| `evidence/b6-help-compact.txt` | `/compact` 未知命令 |
| `evidence/b7-plugins-list.txt` / `b7-marketplace-list.txt` | 插件与市场 |
| `evidence/b8-fence.json` | fence v94 / tags / compartments / compact 零命中 |
| `evidence/b9-session-rows.json` | 真实库 omz session 行 = 0 |

日志：`logs/zcode-log/zcode-2026-10-05.jsonl`（bootstrap 启动、magic_context readiness /
usage / RPC config_read+config_updated 的 `updatedSessionCount: 1`）。

---

## 6. 验收建议

**不建议以当前状态发 v0.1.0。** M1 是一行配置级修复（把一个 workspace 包名补进两处
staging 白名单），但它决定了「装出来能不能用」，必须在打 tag 之前修掉并重跑 §1.1–§1.3。

修 M1 的验收口径建议：

1. `build:zcode` 后 `tar -tzf … | grep -c magic-context` > 0，
   且 `oh-my-zcode/node_modules/@zcode/magic-context/dist/index.js` 在包内；
2. `install.sh` file 源装完后 `omz --version` **且** `omz --help`（真 agent 路径）都过；
3. 装完的 `omz --prompt "…"` 跑通一轮真实回复；
4. `build-sea --target win-x64` 的自带 smoke test（`--version`）转绿。

M2 / M3 属产品决定与注释订正，可与 v0.1.1 合并处理。
