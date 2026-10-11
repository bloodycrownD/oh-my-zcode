# CR v0.1.0 wave-1 证据包 — evidence-brand-dist-compliance

> 节点 id：`evidence-brand-dist-compliance`
> 仓库：`D:\Dev\Js\oh-my-zcode\omz`（git，分支 `dev/phase-0`）
> BASE_SHA：`1fa2d0e`（tag `phase1/cr-fixed`）／HEAD_SHA：`aba59a9`（tag `v0.1.0`）
> 取证日期：2026-10-04（会话时钟）
> 范围：S32 品牌改名 / S33-pre CDN 别名 / S34 合规 / S35 分发 staging
> 参考材料：`docs/iterations/oh-my-zcode-fork/spec.md:243-247, 297-300`（Step 32-35）、`:38`（D-2）、`:46`（D-10）、`docs/.iteration-state.yaml:32-46`（phase3 全节）、`docs/iterations/oh-my-zcode-fork/cache/phase3-final-e2e-report.md`
> **性质：只取证，不下结论。** 下列每条都给出 file:line 或可复算的落盘/构建产物证据；判断留给 cr-func / 主代理。

---

## 0. diff 统计（本范围）

| 区间 | 提交 | 文件 | +/− |
|---|---|---|---|
| `8267303~1..aba59a9`（**S32+S33-pre+S34+S35-fix 全范围**） | 5 个提交 | **184** | **+963 / −547** |
| `8267303`（S32 改名） | 1 | 149 | +617 / −474 |
| `4c8a580`（S33-pre CDN 别名） | 1 | 1 | +7 / −1 |
| `27b7109`（S34 合规） | 1 | 38 | +292 / −69 |
| `8a395e7`（S35-fix M1 分发 staging） | 1 | 1 | +32 / −1 |
| `aba59a9`（S35-fix M2/M3） | 1 | 3 | +15 / −2 |
| 参考：`1fa2d0e..aba59a9`（BASE→HEAD 全量，含 Phase 2a/2b） | — | 584 | +92020 / −7884 |

分组（BASE→HEAD）：magic-context 279 文件 +87165/−0；apps/zcode-cli 167 +2881/−6614；packages/ui 43 +1165/−323；packages/services 32 +197/−414；packages/shared 23 +220/−176；packages/desktop 14 +37/−37；scripts(root) 5 +24/−22；root/docs 21 +331/−298。

Phase 3 提交链（`git log 2b3ca7e..aba59a9`，9 条）：`8267303 → 4c8a580 → 27b7109 → 8a395e7 → aba59a9`（其间夹 `e94c895` s29、`cf1f5df` s30，属 Phase 2b，不在本节点范围）。

---

## 1. 改名正确性（S32）

### 1.1 bin / npm 包名落点

| 面 | 位置 | 值 | 证据 |
|---|---|---|---|
| npm 包名（根） | `package.json:2` | `oh-my-zcode` | `git show 8267303 -- package.json` |
| CLI bin | `apps/zcode-cli/packages/cli/package.json:7` | `"omz": "./dist/zcode.cjs"` | 同上 |
| 进程名常量 | `apps/zcode-cli/packages/cli/src/process-name.ts:1-2` | `CLI_COMMAND_NAME="omz"` / `CLI_PROCESS_NAME="omz-cli"` | 同上 |
| 发行包内 runner | `scripts/build-zcode.mjs:202` | `bin/omz.mjs` | 同上 |
| 发行包目录名 | `scripts/build-zcode.mjs:16-18` | `packageDirName="oh-my-zcode"`、`defaultOutDir=dist/oh-my-zcode` | 同上 |
| `latest.json.name` | `scripts/build-zcode.mjs:279` | `"oh-my-zcode"` | 同上 |
| install.sh bin | `scripts/zcode-distribution/installer.mjs:2-3, 47-54` | `binName="omz"` / `runnerFileName="omz.mjs"` / `$BIN_DIR/omz` | 同上 |
| install.sh 安装根 | `installer.mjs:10` | `${ZCODE_DIST_HOME:-$HOME/.omz/runtime}` | 同上 |
| install.sh 文案 | `installer.mjs:53-54` | `oh-my-zcode $VERSION installed.` / `Run: omz (TUI) or omz --web (Web)` | 同上 |
| runner.mjs 自述 | `scripts/zcode-distribution/runner.mjs:18-19, 263` | `omz --web ...` / `omz --version` | 同上 |
| CLI help 头 | `apps/zcode-cli/packages/i18n/src/locales/en-US.ts:10,13,15` | `omz ${version}` / `omz [command] [options]` / `omz opens the full-screen TUI` | 同上 |
| README | `README.md:1` `# oh-my-zcode`；`:84,162` `### oh-my-zcode 命令行版` | ✅ | `git show 8267303 -- README.md` |

发行产物实测（`omz/dist/oh-my-zcode/releases/3.14.3/`）：
- 目录 `dist/oh-my-zcode/` ✅、tarball `oh-my-zcode-3.14.3.tar.gz` ✅、tarball 根目录 `oh-my-zcode/` ✅（e2e 报告 §1.1 表 + 本节点 §5.1 tar 实测）。
- 包内唯一 `package.json` 的 `name` 仍是 `zcode-runtime`（本节点实测 `oh-my-zcode/package.json => zcode-runtime 3.14.3`）——与 e2e 报告 §1.1「需要登记的观察」一致，`build-zcode.mjs:206-218` 写死、`private: true`、从不上 npm。

### 1.2 用户级 `.omz` vs 工作区级 `.zcode` 双轨常量拆分

四组常量，均已显式拆成 `USER_* = ".omz"` / `WORKSPACE_ZCODE_DIR = ".zcode"`：

| 文件 | user 常量 | workspace 常量 | 注入点 |
|---|---|---|---|
| `apps/zcode-cli/packages/adapters/src/skills/roots.ts` | `:10-11` `USER_ZCODE_DIR=".omz"` | `:13-14` `WORKSPACE_ZCODE_DIR=".zcode"` | `:49`（home）/ `:56`（project），函数签名 `:100-110` 增 `zcodeDir` 形参 |
| `apps/zcode-cli/packages/adapters/src/commands/roots.ts` | `:10-11` 同上 | `:13-14` 同上 | `:49` / `:56`，签名 `:100-110` |
| `packages/services/src/hooks/hooksService.ts` | `:36-37` `USER_ZCODE_DIR=".omz"` | `:39-40` `WORKSPACE_ZCODE_DIR=".zcode"` | `:63-66` `getRootDir()`：`workspacePath ? join(base,WORKSPACE) : join(base,USER,"cli")` |
| `packages/desktop/src/main/mcpUserDirectory/{index,types}.ts` | `index.ts:40` `userConfigDirSegments:[".omz","cli"]`；`types.ts:25` `configDirSegments:[".omz","cli"]` | `index.ts:41` `workspaceConfigDirSegments:[".zcode"]` | — |
| `packages/services/src/commands/commandsService.ts` | `:55` `userDirectorySegments:[".omz","commands"]` | `:56` `workspaceDirectorySegments:[".zcode","commands"]` | — |

配套的 user/workspace 成对函数（`packages/services/src/settings-sync/settingsSyncService.ts:426-460`、`skill-sync/skillSyncService.ts:133`、`skills/skillsService.ts:74 vs 84`、`packages/services/src/subagents/subagentStorage.ts:24`）都保持成对且只改 user 侧。

**双轨一致性抽查结论（只陈述事实）**：全仓 `.zcode` 作为「工作区约定目录」的残留点（`packages/services/src/settings-sync/settingsSyncService.ts:425/433/441/453`、`skills/skillsService.ts:74`、`subagents/subagentStorage.ts:24`、`bootstrap/src/plugins.ts:1298`、`bootstrap/src/subagents.ts:56`、`contracts/src/tools/saved-workflow.ts:19/25`、`shared/src/workspace-hook-config.ts:177/235/241/245`、`adapters/src/config/project-config.adapter.ts:119`）与 D-10「L2 不改 `.zcode-plugin/` 目录名 / 工作区约定」一致，未见把工作区 `.zcode` 误改成 `.omz` 的代码点。**但见 §6.2 的注释/代码口径不一致 4 处。**

### 1.3 硬编码 HOME 解析点抽查

全仓 `homedir()` / `HOME` / `USERPROFILE` 解析点扫描结果：**106 处**（`.tmp-home.txt` 全量清单见本包 §附录 A）。S32 中实际改到 `.omz` 的**代码/文案 HOME 落点 59 处**（`git show 8267303 -U0 | grep '^+.*\.omz'` 交集 HOME 关键字）。抽查 12 处（全部为真代码行，非注释）：

| # | file:line | 现状 | 真改？ |
|---|---|---|---|
| 1 | `adapters/src/context/index.ts:237` | `join(resolveUserHomeDir(env), ".omz", "AGENTS.md")` | ✅ |
| 2 | `adapters/src/exec/execution-utils.ts:19` | `ZCODE_STORAGE_DIR \|\| join(homedir(), ".omz")` | ✅ |
| 3 | `adapters/src/logging/index.ts:223` | `join(homedir(), ".omz","cli","log")` | ✅ |
| 4 | `adapters/src/model/runner-debug.ts:590` | `join(homedir(), ".omz","cli", isDev?"debug":"rollout")` | ✅ |
| 5 | `adapters/src/storage/session-store/paths.ts:7` | `join(homedir(), ".omz","cli","db","db.sqlite")` | ✅ |
| 6 | `adapters/src/workflow/index.ts:35` | `DEFAULT_WORKFLOW_ROOT = join(homedir(), ".omz","cli","workflows")` | ✅ |
| 7 | `bootstrap/src/app/script-workflow-tool-port.ts:318` | `join(homedir(), ".omz","workflows",fileName)` | ✅ |
| 8 | `bootstrap/src/app/script-workflow-utils.ts:174` | `isWithin(scriptPath, join(homedir(), ".omz","workflows"))` | ✅ |
| 9 | `cli/src/clipboard-image.ts:33` / `cli/src/sea-runtime-tools.ts:69` | 均 `\|\| join(homedir(), ".omz")` | ✅ |
| 10 | `debug/server/sources.ts:19,23` | `~/.omz/cli/log`、`~/.omz/cli/db/db.sqlite` | ✅ |
| 11 | `packages/desktop/src/main/index.ts:468` | `join(homedir(), ".omz","v2","setting.json")` | ✅ |
| 12 | `packages/zcode-server-cli/src/runtime/paths.ts:25` | `join(configured \|\| homedir(), ".omz","server")` | ✅ |

**未改到的 HOME 落点（用户可见，见 §6.1）**：`cli/src/tui-runtime-loader.ts:120-138`、`cli/src/sea-playwright-runtime.ts:120-134` 的 SEA 资产缓存根仍是 `…/zcode/sea-assets`（macOS `~/Library/Caches/zcode/`、win `%LOCALAPPDATA%\zcode\Cache\`、linux `$XDG_CACHE_HOME/zcode/`）。

### 1.4 `~/.omz-beta`

`apps/zcode-cli/packages/cli/src/env.ts:133-139`：

```
133 function applyBetaStorageDefault(env, argv) {
134   if (env.ZCODE_STORAGE_DIR?.trim()) return;
135   const explicitBeta = env.ZCODE_BETA === "1" || env.ZCODE_ENV === "beta";
136   const invokedAsBeta = argv.some((arg) => /(^|[/\\])zcode-beta(?:$|\.)/u.test(arg));
137   if (!explicitBeta && !invokedAsBeta) return;
138   env.ZCODE_STORAGE_DIR = join(homedir(), ".omz-beta");   // ← S32 只改了落点
139 }
```

`git show 8267303` 显示该 commit 对本函数**只改了 `:138` 的落点字符串**，`:136` 的触发键仍是 `zcode-beta`。调用链：`main.ts:22 applyCliRuntimeEnvSanitization` → `env.ts:47 applyCliRuntimeEnvDefaults` → `applyBetaStorageDefault`，早于 `main.ts:69` 的首启提示。事实陈述：fork 自身发行链（install.sh / build-zcode / SEA）产出的可执行名是 `omz`，仓内不存在任何 `zcode-beta` 产物；`zcode-beta` 字面量在 `env.ts:136` 之外无其他生产代码引用（§附录 B 全量）。

### 1.5 敏感目录 deny-list

`apps/zcode-cli/packages/core/src/memory/memory-file-path.ts:5-27`：`SENSITIVE_MEMORY_PATH_SEGMENTS` 同时含 `".zcode"`（`:17`）与 `".omz"`（`:19`，S32 新增，注释说明「与工作区级 `.zcode` 同样受保护」）。归一化走 `normalizeSensitiveSegment()`（`:80-85`：小写 + 去 bidi 控制符 + 去尾随 `.`/空格），对 `.omz-beta` 这类**不做前缀匹配**（只做段全等），因此 `.omz-beta` 未被纳入该 deny-list。全仓未发现其它以 `.zcode` 为条目的 deny-list / 敏感路径表（`path-policy.ts` 无 `.zcode`/`.omz` 字面量）。

---

## 2. 首启提示（`apps/zcode-cli/packages/cli/src/data-dir-notice.ts`，S32 新增 110 行）

- **marker 一次性机制**：`:24` `NOTICE_MARKER_FILE_NAME = ".oh-my-zcode-first-run-notice"`；`:89` `markerPath = join(dataRoot, NOTICE_MARKER_FILE_NAME)`；`:92-94` `existsSync(markerPath)` 命中即 `shown:false` 直接返回（不再写盘、不再输出）；`:102-107` 先 `stderr.write` 再 `mkdirSync(recursive)+writeFileSync`，写失败仅注释说明「下次再看一次提示」，不抛。写入内容 `new Date().toISOString()`。
- **数据根解析**：`:45-49 resolveDataRoot()` — `ZCODE_STORAGE_DIR` 优先，否则 `join(homedir(), ".omz")`，注释声明与 `execution-utils` / `clipboard-image` / `sea-runtime-tools` 同优先级。
- **旧目录只 stat 不写**：`:22 LEGACY_DATA_DIR_NAME = ".zcode"`，注释「只用于『旧目录还在不在』的只读探测，绝不写入」；`:52-55 resolveLegacyDataRoot()`；`:70-76 directoryExists()` 只调 `statSync().isDirectory()`；旧目录仅出现在 `:61`/`:64` 的文案里。全文件写操作只有 `:104 writeFileSync(markerPath,…)`，目标在**新**数据根内。
- **协议通道 / storage 模式静默条件**：`main.ts:69` `if (!isProtocol && !argv.includes("--prepare-storage"))`，`isProtocol` 来自 `:23 isProtocolServerInvocation(argv)`；注释解释为「stdout 是 ZCode Protocol 帧通道」「storage 模式输出由调用方解析」。另有一条**未被注释覆盖**的前置早退：`main.ts:62-65` `isPluginHostInvocation(argv)` 命中即 `return`，插件宿主子进程也在提示之前返回。
- 实测（e2e 报告 §2.2 + `evidence/b1-run1.txt`/`b1-run2.txt`）：run1 两行提示 + run2 无提示，marker 落 `~/.omz/.oh-my-zcode-first-run-notice`；「检测到旧目录仍然存在」那行未出现，因隔离 HOME 内确无 `.zcode`。

---

## 3. CDN 别名容忍（`4c8a580`，1 文件 +7/−1）

### 3.1 改动本体

`apps/zcode-cli/packages/adapters/src/plugins/official-marketplace.ts:121-133`：

```
121 function assertOfficialManifest(manifest) {
122-124  // FORK (S32/S33)：canonical id 已改为 oh-my-zcode-official，但官方 CDN manifest（D-2
         // 端点保留）仍以旧名 zcode-plugins-official 发布。在其重新发布前，旧名作为别名接受…
125   if (manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
127       manifest.name !== "zcode-plugins-official") { throw … }
133 }
```

调用面：`assertOfficialManifest` 只在 `:18 writeBundledOfficialMarketplacePartitionSync` 与 `:30 writeCdnOfficialMarketplacePartitionSync` 两处分片写入口各调一次（**bundled / cdn 两分片都收**）。merged manifest 的 name 归一化在 `:78-83`：`{...(bundled), ...(cdn), name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, plugins:[...cdnPlugins, ...bundledPlugins]}`，落 `marketplace.json`（`:84`）。

旧 id 字面量全仓残留扫描：除上述 `:123`（注释）与 `:127`（别名）两处外，**`.ts/.tsx/.mjs/.json` 内零残留**。

### 3.2 全部按 `manifest.name` 的比较点（grep 全集）

| file:line | 比较对象 | S33-pre 是否覆盖 |
|---|---|---|
| `official-marketplace.ts:126-127` | `manifest.name` vs canonical / 旧别名 | ✅ 已覆盖 |
| `official-marketplace.ts:81` | merged `name` 覆写为 canonical | ✅ 归一化 |
| `marketplace.ts:356` | `isOfficialMarketplaceId(loaded.manifest.name) && !== trustedId` → 抛「id 被官方保留」 | ❌ 未覆盖（`isOfficialMarketplaceId` 见 `contracts/src/plugins/index.ts:23` 只认新 id） |
| `marketplace.ts:361-365` | `input.expectedId && manifest.name !== expectedId` → 抛 id mismatch | ❌ 未覆盖 |
| **`marketplace.ts:366-373`** | `trustedId === canonical && manifest.name !== canonical` → 抛「Official marketplace source must provide …」 | ❌ **未覆盖** |
| `marketplace.ts:374-382` | `manifest.name === canonical ? writeCdnOfficialMarketplacePartitionSync(...) : loaded.manifest` | ❌ 分支条件仍只认新 id |
| `marketplace.ts:393` | `else if (manifest.name !== canonical)` → 走 `stageMarketplaceManifest`（按 `manifest.name` 建独立市场目录） | ❌ 未覆盖 |

CDN 分片写入函数 `writeCdnOfficialMarketplacePartitionSync` 的**唯一调用点**是 `marketplace.ts:377`，且被 `:375` 的 `manifest.name === canonical` 包着。

### 3.3 CDN 现状（只读取证）

`https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json` 顶层 `name` 实测 = **`"zcode-plugins-official"`**，插件 27 个（cloudbase-skills / mimosa / github / video-agent-kit / …）。即 CDN 未改 id，D-2 端点保留。

### 3.4 磁盘终态（E2E 沙箱，只读列举）

```
.e2e-phase3-final/home/.omz/cli/plugins/marketplaces/oh-my-zcode-official/
├── bundled-marketplace.json      （有）
└── marketplace.json              （有）
    —— 无 cdn-marketplace.json
known_marketplaces.json：{ id:"oh-my-zcode-official", source:url https://cdn-zcode.z.ai/...,
                          pluginCount: 0, addedAt:2026-10-04T22:18:37.209Z }
                        —— 无 lastRefreshFailure 字段
marketplace.json：name="oh-my-zcode-official"，plugins 两条，两条 `source` 均为 "filesystem"
                （node-repl-host 0.6.0 / browser-use 0.5.1，cachePath 指向 .omz 内 cache/）
evidence/b7-marketplace-list.txt：`oh-my-zcode-official [official]: 1 plugins`
```

事实并列（不下结论）：磁盘上**没有** `cdn-marketplace.json`，merged 清单内容与 bundled 分片等价，`known_marketplaces.json` 无刷新失败记录。刷新失败若发生会写 `lastRefreshFailure`（`marketplace.ts:1852-1862 persistMarketplaceRefreshFailure`，被 `:524-533` 的 catch 调用）——该字段缺席说明**该次 E2E 全程未发生过一次成功的官方市场刷新，也未发生过一次被记录的失败**。

刷新触发面：`updateZCodePluginMarketplace`（`bootstrap/src/plugins.ts:509-568`）是显式入口（CLI `plugins marketplace update` / UI 顶栏刷新 / `PluginStorePage.tsx:137/306`）；`resolveZCodePlugins` 侧（`plugins.ts:571`）只**读** `lastRefreshFailure`，不做自动刷新。`plugins marketplace list` 不触发刷新。

对照文档表述（`cache/phase3-final-e2e-report.md:489-492`）：「`4c8a580` 的『接受旧 CDN id 别名』在改名后仍然生效……bundled 分片与 CDN 分片成功合并（合并清单里两个插件都在）」。落盘证据只支持「bundled 分片写成功」这一半。

---

## 4. S34 合规（`27b7109`，38 文件 +292/−69）

### 4.1 NOTICE fork 声明 vs 实际修改面

`NOTICE.md:5-15` 新增「零、Fork 声明」节，列 5 条修改面：

| NOTICE 声明 | 实际落点 | 一致性 |
|---|---|---|
| 遥测与崩溃上报整体移除 | Phase 1（1fa2d0e 之前） | ✅ 在本 diff 外 |
| ZCode 原生上下文压缩移除 | Phase 2b（`2b3ca7e`） | ✅ 在本 diff 外 |
| magic-context 集成并默认启用，`src/core/` 是逐字/近逐字移植件、文件头保留移植来源与 MIT 归属；`src/host/` 是 fork 编写 | `apps/zcode-cli/packages/magic-context/**` | ⚠️ 见 §4.2（头覆盖率 22/245） |
| 品牌改名：bin/npm/数据目录/市场 id（过渡期仍接受旧 id 别名） | §1.1、§1.2、§3 | ✅ 但「旧 id 别名」的生效面见 §3.2 |
| apps 目录扁平化、删 submodule 行 | Phase 0 | ✅ 在本 diff 外 |

`NOTICE.md:12` 的品牌行未提「工作区级 `.zcode` 保持不变」这一边界；`UPSTREAM-SYNC.md:64` 的 L1 重放规则却明写「`~/.zcode` 一律改写成 `~/.omz`」——两处口径不一致（见 §6.3）。

`NOTICE.md:70` 已把 CLI 会话库路径更新为 `~/.omz/cli/db/db.sqlite`。

### 4.2 33 个 MIT 头注释分布

`git grep -c "Ufuk Altinok" -- apps/zcode-cli/packages/magic-context` → **34 个文件命中**（含 `LICENSE.magic-context` 本身 3 处），即 **33 个 `.ts` 源文件**：

- `src/core/**`：**22**（`features/builtin-commands/{command-arguments,commands,types}.ts` 3；`features/magic-context/{dreamer/token-budget,protection-window,range-parser,scheduler,session-cache-ttl,tag-input}.ts` 6；`hooks/magic-context/dropped-input-guard.ts` 1；`shared/{model-cache-ttl,user-facing-codes}.ts` 2；`tools/ctx-expand/{constants,mode,render,tools,types}.ts` 5；`tools/ctx-reduce/{constants,tools,types}.ts` 3；`tools/{tool-definition,unwrap-imitated-reduced-args}.ts` 2）
- `src/host/**`：**10**（`config-bridge`、`config/language`、`config/snapshot`、`ctx-recomp`、`ctx-status`、`harness`、`raw-message-provider`、`session-history`、`storage-dir`、`types`）
- `src/index.ts`：**1**

`git diff 27b7109` 显示这 33 处是**注释订正**：`Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.` → `MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.`（无代码行变动）。

覆盖率实测：`git ls-files apps/zcode-cli/packages/magic-context/src` = **259** 文件（`src/core` 245 / `src/host` 13 / `src/index.ts` 1），其中**含头注释的只有 33，缺 226**（缺的全部在 `src/core/**` 与 `src/host/{config/schema,hidd**}*` 等）。

`LICENSE.magic-context:15-18` 写「Files under `src/core/` are, **per their own header comments**, verbatim or near-verbatim ports」——落盘事实是 245 个 `src/core` 文件里只有 22 个带 per-file 头注释。同文件 `:20-22` 另有一句「The upstream per-file headers were preserved as-is (the upstream sources carry no per-file copyright header, so there is nothing per-file to restore)」，与「33 个文件确有 per-file 归属头」并存。

`27b7109` commit message 自述：「核验 `.reference/magic-context` 上游快照（`@cortexkit/opencode-magic-context` 0.44.4，全 packages 目录，上游源码 `mural-font.generated.ts`：Mplus 字体，BSD-2-Clause，本 fork 未继承）外没有任何 per-file 版权头，许可证声明在二级仓库根 LICENSE 处。因此不存在『移植时丢失版权头』的文件，但查出 33 个已经写错的适配文件头注释……」——即 fork 自己的口径是「上游没有 per-file 头」，与 `LICENSE.magic-context:15-18` 的「per their own header comments」措辞相反。

### 4.3 `LICENSE.magic-context` 内容完整性

`apps/zcode-cli/packages/magic-context/LICENSE.magic-context`（49 行）：
- 上游坐标块 `:3-9`：`upstream package: @cortexkit/opencode-magic-context`、`upstream version: 0.44.4`、`upstream license: MIT`、`upstream copyright: Copyright (c) 2025 Ufuk Altinok`、`snapshot used: .reference/magic-context (read-only upstream snapshot)`。
- 范围说明 `:11-25`：头注释样例、`src/core/` vs `src/host/` 归属、MIT 保留要求、根 LICENSE 仍 Apache-2.0 的组合许可说明。
- **MIT 全文 `:29-49`**：`MIT License` / `Copyright (c) 2025 Ufuk Altinok` / 三段许可授予 / 「The above copyright notice … shall be included …」/ AS IS 免责段，逐条完整（对照标准 MIT 模板无删节）。
- 路径口径差异：`:9` 写 `.reference/magic-context`（相对本仓），`UPSTREAM-SYNC.md:11` 写「参照快照在**仓库外的同级目录**（`<repo>/../.reference/`）」。实测两者：仓内 `omz/.reference` **不存在**；`D:\Dev\Js\oh-my-zcode\.reference\` 存在且含 `magic-context / pi / ZCode`。同一份快照两处写法不一致（见 §6.4）。

### 4.4 `THIRD-PARTY-NOTICES` 与依赖变化的对应

- 依赖新增：`apps/zcode-cli/packages/magic-context/package.json:29-32` `dependencies: { "ai-tokenizer": "^1.0.6", "zod": "4.6.5" }`；`knip.json:33` `"ignoreDependencies": ["ai-tokenizer"]`。全仓 `ai-tokenizer` 在 `package.json` 中**只出现在 magic-context 一处**。
- 声明落盘：`THIRD-PARTY-NOTICES.md:733` `- ai-tokenizer@1.0.7 — MIT`；`:6828` `ai-tokenizer@1.0.7: LICENSE`；`:6857` `ai-tokenizer@1.0.7: README.md (license section)`。
- `third-party/inventory.json`：`noticesSha256` `753e1b85…` → `86da178e…`（`:5`）；inputs 哈希变更 = `adapters/bootstrap/cli/contracts/core/magic-context(新增)/package.json(根)`、`packages/ui/src/lib/builtinSkillI18n.ts`、`pnpm-lock.yaml`（即 Phase 1/2 真实变更）；新增条目 `:7426-7440` `ai-tokenizer 1.0.7 MIT` + 两条 notice 成员哈希；`:28669-28672` `builtinSkillI18n.ts` 复制源哈希同步。
- commit message 自述口径：1121 → 1122 条净增 1，唯一新增 `ai-tokenizer@1.0.7`，其余 diff 为输入哈希噪声；`licenses.mjs check` 通过；`reviewRequired` 15 项为既有基线。

### 4.5 `UPSTREAM-SYNC.md`

新文件 113 行，五节：§1 更新参照快照（3 个快照路径 + 基线表 + 更新命令）；§2 diff 与影响面评估（tag 链表 + 双变更面 + 交集判定 4 条分流）；§3 重放改造（5 行 phase 顺序映射 + 移植件更新流程 4 步 + 5 条不可回退硬约束表）；§4 门禁清单（8 项表）；§5 已知不适配项（6 行表）。
tag 链表 `:32-39` 列 6 个 tag：`baseline/v3.14.3` / `phase1/telemetry-removed` / `phase1/cr-fixed` / `phase2a/magic-context-mvp` / `phase2b/compact-removed` / `v0.1.0`。实测 `git tag` 指向与 `iteration-state.yaml:31` 记录一致（`v0.1.0=aba59a9`）。
`:80` 硬约束表把 `preserveProviderStreamBoundaries: true` 的位置写作 `src/host/hidden-completion-executor.ts`、`contracts/src/model/index.ts`、`core/src/runtime/helpers/sidecar-model-request.ts`；`:83` 又写 `core/src/runtime/methods/sidecar-model-request.ts` —— 同一文件在 `:80` 与 `:83` 用了 `helpers/` 与 `methods/` 两个路径（见 §6.5）。

---

## 5. S35 分发 staging（`8a395e7`，`sea-tui-assets.mjs` 单点 +32/−1）

### 5.1 deferred 队列实现

`apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs:127-241`：

- 首轮 `queue`（`:153-160`）6 个种子，全部 `fromDirectory: tuiDirectory`：`@zcode/tui`、`@mbears/opentui-core`、`@mbears/opentui-react`、`react`、`react-devtools-core`、`ws`。
- `deferred`（`:161-167`）1 项：`{ fromAssetPath: "node_modules", fromDirectory: magicContextDirectory, packageName: "@zcode/magic-context" }`。
- 主循环 `:171-238`：`while (queue.length > 0 || deferred.length > 0)`；**`:172-174 if (queue.length === 0) queue.push(...deferred.splice(0, deferred.length))`** —— 首轮队列排空后才把 deferred 整体入队（BFS 首轮排空再入队，与代码注释 `:139-143` 一致）。magic-context 缺席时 `:149-152` 抛 `Missing @zcode/magic-context workspace package.`。
- 依赖递归 `:205-221`：`packageJson.dependencies` 逐条过 `shouldQueueRuntimeDependency`（`:243-257`：跳 `@types/*`；`workspace:` 说明符必须能在 `workspacePackageDirectories` 命中否则抛）。**只收 `dependencies`，不收 `devDependencies`/`optionalDependencies`**（后者只在 `:222-237` opentui-core 分支特判 `koffi`/`unsafe-pointer`）。

### 5.2 zod 三处放置（构建产物实测）

放置逻辑 `apps/zcode-cli/packages/cli/scripts/sea-runtime-package-resolution.mjs:5-25 placeRuntimePackage`：先沿消费者路径向上找已有放置（`:9-18`），命中同物理包则复用（`:13` 返回 `undefined` 跳过）、命中不同物理包则 `break`；`:19-22` 若 `node_modules/<pkg>` 根位已被占，则放到 `join(fromAssetPath,"node_modules",<pkg>)` 嵌套位。

各包 zod 声明：`contracts/package.json:91` `"zod": "^3.24.0"`；`packages/shared/package.json:32` `"zod": "4.6.5"`；`adapters/package.json:124` `"zod": "4.6.5"`；`magic-context/package.json:31` `"zod": "4.6.5"`。

**tarball 实测**（`omz/dist/oh-my-zcode/releases/3.14.3/oh-my-zcode-3.14.3.tar.gz`，`tar -xzOf` 读包内 package.json）：

| 落点 | name@version |
|---|---|
| `oh-my-zcode/agent/node_modules/zod/package.json` | `zod 3.25.76` |
| `oh-my-zcode/agent/node_modules/@zcode/shared/node_modules/zod/package.json` | `zod 4.6.5` |
| `oh-my-zcode/agent/node_modules/@zcode/magic-context/node_modules/zod/package.json` | `zod 4.6.5` |

**SEA win-x64 实测**（`apps/zcode-cli/packages/cli/dist/sea-config-win-x64.json`，7182 assets）：
`zcode-tui-runtime/node_modules/zod/package.json`、`…/@zcode/shared/node_modules/zod/package.json`、`…/@zcode/magic-context/node_modules/zod/package.json` —— 同样三处。

即任务描述的「根 3.25.76 / shared 嵌套 4.6.5 / magic-context 嵌套 4.6.5」在**两条通道的构建产物里都成立**。

**SEA darwin-arm64 实测**（`sea-config-darwin-arm64.json`，5737 assets）：magic-context **0** 条、ai-tokenizer **0** 条、zod 只有根位 + `@zcode/shared` 嵌套 **2** 处 —— 该 config 是修复前的陈旧产物（EXEMPT-2a 使 `--all` 在 Windows 宿主上跑不到 darwin 目标，故未重生成）。

### 5.3 `ai-tokenizer` 收集路径

`magic-context/package.json:30` `ai-tokenizer: ^1.0.6` 是 `dependencies` → `:205-221` 的 manifest 递归会入队；`fromAssetPath` = magic-context 的 `node_modules/@zcode/magic-context`；`placeRuntimePackage` 走根位（`node_modules/ai-tokenizer` 首次出现）。落点实测：tarball `oh-my-zcode/agent/node_modules/ai-tokenizer/package.json => ai-tokenizer 1.0.7`（含 `dist/`、`LICENSE`、`README.md`）；SEA `zcode-tui-runtime/node_modules/ai-tokenizer/**` 53 条。代码注释 `:146-148` 说明其消费方是 `read-session-formatting` 的 `createRequire` 动态加载，从 `agent/node_modules/@zcode/magic-context/dist/**` 向上查找命中。

### 5.4 tarball 通道为何同一改动生效

`scripts/zcode-distribution/assets.mjs:4-7` 从 `../../apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs` **直接 import `collectSeaTuiAssets`**，`:32-59 stageTuiRuntime()` 对每个 `supportedTargets` 调它并把 `manifest.files` 拷到 `resolve(packageRoot, "agent", file.path)`。所以 SEA 收集器同时是 tarball 的 TUI runtime staging 入口 —— 这解释了「单点修复覆盖两条通道」。

### 5.5 `runtimePackageNames` 未加 magic-context 的理由复核

`scripts/zcode-distribution/assets.mjs:12-30` `runtimePackageNames` 16 项（`@hono/node-server`、`@hono/node-ws`、`ssh2`、`node-pty`、`undici`、`axios`、`form-data`、`combined-stream`、`follow-redirects`、`proxy-from-env`、`ws`、`hono`、`yaml`、`yazl`、`yauzl`、`node-forge`），S35-fix **未加** `@zcode/magic-context`。

调用面 `:156-174 copyRuntimeNodeModules(packageRoot)`：`:157` `requireFromServer = createRequire(resolve(root,"packages","server","package.json"))`；`:161` `resolve(packageRoot,"node_modules",...)` —— **落点是 `<packageRoot>/node_modules`，与 TUI 通道的 `<packageRoot>/agent/node_modules` 是不同根**；`:168-173` 另有一段把 `playwright-core` 落到 `<packageRoot>/agent/node_modules`。

`iteration-state.yaml:38` 记的 agent 理由是「deferred 队列防 zod 根位劫持」，而任务描述里转述的 agent 说法是「会双拷贝」。就落盘事实而言：`copyRuntimeNodeModules` 与 `stageTuiRuntime` 目标根不同，把 magic-context 加进 `runtimePackageNames` 不会写进 `agent/node_modules`；而 `copyRuntimePackageTree`（`:105-154`）用 `requireFromServer` 解析，`packages/server/package.json` 是否可达 `@zcode/magic-context` 未在本节点实测（未执行安装解析）。两条理由的成立性见 §6.6。

---

## 6. 可疑点清单（只列事实与疑点，不下结论）

### 6.1 改名遗漏 / 仍指向旧路径或旧 id 的用户可见面

| # | file:line | 事实 | 为什么可疑 |
|---|---|---|---|
| S-1 | `apps/zcode-cli/packages/cli/src/env.ts:136` vs `:138` | 落点改成 `~/.omz-beta`，触发键仍是 `/(^|[/\\])zcode-beta(?:$|\.)/` | fork 自己的发行链只产 `omz`；`zcode-beta` 在生产代码中零其它引用 → 隐式 beta 触发对本 fork 产物不可达，只剩 `ZCODE_BETA=1`/`ZCODE_ENV=beta` 显式开关 |
| S-2 | `cli/src/tui-runtime-loader.ts:120-138`、`cli/src/sea-playwright-runtime.ts:120-134` | SEA 资产缓存根仍是 `~/Library/Caches/zcode/sea-assets` / `%LOCALAPPDATA%\zcode\Cache\sea-assets` / `$XDG_CACHE_HOME/zcode/sea-assets` | 同一 commit 把 `~/.zcode`→`~/.omz` 改了 59 处，这三处用户可见的磁盘目录名未改；SEA 用户会看到 `zcode` 目录 |
| S-3 | `cli/src/i18n/src/locales/en-US.ts:290` / `zh-CN.ts:286` | `starting: "Starting ZCode... Ctrl+C to exit"` / `"正在启动 ZCode… Ctrl+C 退出"` | 同一文件 `:10/13/15` 已把 help 头改成 `omz`；TUI 启动串仍自称 ZCode，同一面内不一致 |
| S-4 | `packages/desktop/src/main/mcpUserDirectory/legacy.ts:205` | `candidates.push(join(appData,"ai.z.zcode","store.json"))` | Electron userData 遗留路径；桌面身份刻意不改（D-10 L2/L3），但未在任何文档登记为「已知不改」 |
| S-5 | `README.md:88` / `README.en.md:82` | 「全局安装用 `npm i -g oh-my-zcode`，装完直接跑 `omz`」 | 根 `package.json:4` `"private": true` 且**无 `bin` 字段**；`iteration-state.yaml:46` 记「npm publish 未做（发布由用户执行）」。该命令在当前仓状态下不可执行 |
| S-6 | `packages/desktop/build/installer.nsh:471-475` | 数据目录探测只查 `$R9\.omz`，不再回退 `.zcode` | NSIS 安装器在升级/卸载场景按数据目录名定位；旧版安装留下的 `~/.zcode` 不会被识别。标签名仍为 `zcodeFindNestedDataDir*`（内部标签，无害） |
| S-7 | `packages/ui/src/i18n/locales/en-US.ts` + `zh-CN.ts` | 「ZCode」在 UI 文案里大量保留（`welcome.title`/`login.title`/`titleBar.menu.help.about`/`startup.global.starting`/`resourceManager.storage.*` 等数百条）；S32 只改了 2 条（`settings.dataBaseDirDescription` 的 `.zcode/v2`→`.omz/v2`） | 与「桌面应用整体不改名」自洽，但该边界**未写入** `NOTICE.md:12` 的品牌行，也未进 `UPSTREAM-SYNC.md:64` 的 L1 重放规则 → 下一个同步者可能按 `:64` 把 UI 文案里的 ZCode 也改掉 |
| S-8 | `apps/zcode-cli/packages/cli/src/data-dir-notice.ts:53` | `resolveLegacyDataRoot`：`ZCODE_STORAGE_DIR` 存在时取 `join(dirname(dataRoot), ".zcode")` | 当 `ZCODE_STORAGE_DIR` 指向与家目录无关的隔离根时，旧目录探测落到该根的同级，属推断而非旧数据真实位置（`resolveDataRoot` 的注释声明与 `execution-utils` 同优先级，此处为新逻辑自洽，无对照先例） |

### 6.2 双轨常量相关的注释/代码口径不一致（S32 机械替换注释留下）

| # | file:line | 注释说 | 代码是 |
|---|---|---|---|
| D-1 | `packages/services/src/skills/skillsService.ts:134-138` | 「把每一层的 `.omz/skills` 与 `.agents/skills` 都收集起来」 | `:160 roots.push(getWorkspaceZcodeSkillRoot(dir))`，而 `:74` 该函数返回 `join(workspacePath,".zcode","skills")` |
| D-2 | `packages/services/src/skills/skillsService.ts:1209` | 「收集工作区各层级（沿 worktree 向上）的 `.omz/skills` 与 `.agents/skills`，再加用户级两根」 | 同上，工作区侧是 `.zcode/skills` |
| D-3 | `apps/zcode-cli/packages/contracts/src/tools/saved-workflow.ts:43-46` | 「`project` 落在项目的 `.omz/workflows/`」 | `:19 SAVED_WORKFLOW_PROJECT_DIR = ".zcode/workflows"`（同文件 `:23` 的注释反而写对了 `.zcode/workflows/`） |
| D-4 | `packages/shared/src/storage.ts:6` | 「两个数据根：用户家目录下的 .zcode，以及「数据存储路径」下的 .zcode」 | 两者现在都是 `.omz`（`packages/services/src/paths.ts:44-45`） |
| D-5 | `packages/services/src/skills/skills.ts:25,31,39` | 接口文档把「通用目录」写作 `.omz/skills` | 允许名单同时含工作区 `.zcode/skills` 与用户 `.omz/skills`（`skillsService.ts:1207-1212`），文档只提后者 |

### 6.3 品牌边界口径不一致

- `NOTICE.md:12`（品牌行）列了 bin / npm / 数据目录 / 市场 id 四项，**未提**「工作区级 `.zcode` 保持不变」。
- `UPSTREAM-SYNC.md:64`（L1 重放规则）：「上游新增的 ZCode 字面量（包名、目录名、市场 id、`~/.zcode`）一律改写成 fork 词汇（`omz` / `oh-my-zcode` / `~/.omz` / `oh-my-zcode-official`）」——按字面执行会把工作区 `.zcode` 约定目录也改掉，与 §1.2 的双轨常量实现相反。
- `spec.md:243` 只写「数据目录 `~/.zcode` → `~/.omz`」，同样只指用户级。

### 6.4 `.reference` 路径口径

`LICENSE.magic-context:9` `snapshot used: .reference/magic-context`；`UPSTREAM-SYNC.md:11` 「参照快照在**仓库外的同级目录**（`<repo>/../.reference/`）」。实测：`omz/.reference` 不存在；`D:\Dev\Js\oh-my-zcode\.reference\{magic-context,pi,ZCode}` 存在。SOP 与 LICENSE 文件对同一快照给出两种相对路径。

### 6.5 `UPSTREAM-SYNC.md` 内部路径不一致

`:80` 硬约束表 `preserveProviderStreamBoundaries` 位置列 `core/src/runtime/helpers/sidecar-model-request.ts`；`:83` 同文件写作 `core/src/runtime/methods/sidecar-model-request.ts`。实测文件在 `apps/zcode-cli/packages/core/src/runtime/methods/sidecar-model-request.ts`（`helpers/` 路径不存在）。另 `:80` 列的 `contracts/src/model/index.ts` 未带包前缀。

### 6.6 EXEMPT-2a / EXEMPT-2b 依据复核

**EXEMPT-2a**（`build:sea --all` 在 Windows 宿主解 darwin Node tar 的 symlink 失败）
- 依据来源：`phase3-final-e2e-report.md:79-91`（`corepack/npx/npm: Can't create '...': Invalid argument` ×3 + `Could not extract ... node-v24.14.0-darwin-arm64.tar.gz`），归类为与 Phase 0 EXEMPT-1 同类的 host-only 问题。
- 可复核的旁证：`.e2e-phase3-final` 沙箱内 `sea-config-darwin-arm64.json` 仍是修复前产物（§5.2），即该目标确实未能在本机跑出修复后产物。
- 疑点：报错文本只说 `tar` 无法创建 symlink，未在本节点验证 NTFS 开发者模式开关状态；「与 fork 无关」这一判断依赖上游 tarball 内符号链接这一前提（未实测 tarball 内容）。

**EXEMPT-2b**（SEA 运行时 `No such built-in module: @zcode/magic-context`，登记为「Node SEA `require()` 只解析内置模块，裸说明符 staging 修不了」）
- 静态依据（可复核）：`apps/zcode-cli/packages/cli/scripts/build.mjs:22-27` 把 `@zcode/magic-context` 放进 `resolveBuildExternal`；产物 `apps/zcode-cli/packages/cli/dist/zcode.cjs` 中 `@zcode/magic-context` 加载点 **7 处**（`import_magic_context` 5 处静态 `require(...)` @ 187163 / 545099 / 545158 / 545796 / 545906，另有 2 处 `await import("@zcode/magic-context")` @ 272595 / 573119，CJS 输出下同样落回 `require`）。
- 对照范式：`cli/src/tui-runtime-loader.ts:35-44 loadTuiRuntime()` 显式 `sea.getRawAsset()` 解包到缓存目录后 `import(pathToFileURL(...))`，`:32 packageEntryPath = "node_modules/@zcode/tui/dist/index.js"` **只覆盖 TUI 一个包**；`tui-runtime-loader.ts` / `sea-runtime-tools.ts` / `sea-playwright-runtime.ts` / `scripts/build-sea.mjs` 四个文件中 `magic` 字面量 **零命中** → 没有为 magic-context 提供任何 loader/解包入口。
- 资产侧已就位：`sea-config-win-x64.json` 含 1393 条 `@zcode/magic-context` 资产 + 53 条 `ai-tokenizer` + 3 处 zod（§5.2）。
- 为什么可疑 / 需要注意的点：
  1. `iteration-state.yaml:41` 的 EXEMPT-2b 条目写「**需按 sea-playwright-runtime/tui-runtime-loader 范式补显式路径加载层 + 5 处静态 require 改懒加载（v0.1.1）**」，但产物里实际是 **5 静态 require + 2 动态 import = 7** 处，「5 处」这个计数只覆盖了静态那一半。
  2. `iteration-state.yaml:38` 记「install 演练复验全绿（安装树/真实 prompt/Bash 工具/mc 库）」，但本节点在 `.e2e-phase3-final/install-home/.omz/runtime/current/agent/node_modules/@zcode/` 下实测到的目录是 `contracts, i18n, model-option-map, shared, tui` —— **无 `magic-context`**，根位 `zod` = 3.25.76，只有 2 处 zod 放置。该沙箱树是修复前（e2e 报告 §1.3 的阻断现场）的快照；修复后的验证产物在本沙箱内**没有落盘证据**（`stage/oh-my-zcode/` 下那份是报告 §1.4 的手工反证现场，不是 staging 产物）。仓内 `omz/dist/oh-my-zcode/releases/3.14.3/oh-my-zcode-3.14.3.tar.gz` 是修复后产物且内容正确（§5.2），但没有对应的 install.sh 安装演练记录文件。
  3. EXEMPT-2b 的定性（技术依据充分）与它的**严重级**（报告 §1.2 自述「不是 host-only 级别的豁免——它意味着 SEA 单文件发行物起不来，与 tarball 通道同级阻断」）在 `iteration-state.yaml:39-41` 里被登记为 `exempt` 而非 `pending`，与报告正文口径存在张力。

### 6.7 其他取证中撞见的可疑点

| # | file:line | 事实 | 为什么可疑 |
|---|---|---|---|
| O-1 | `cache/phase3-final-e2e-report.md:489-492` vs §3 的落盘证据 | 报告称 CDN 分片与 bundled 分片「成功合并」 | §3.4：磁盘无 `cdn-marketplace.json`、merged 内容 == bundled 内容、`known_marketplaces.json` 无刷新记录；且 §3.2 的调用链显示旧名 manifest 在到达 `writeCdnOfficialMarketplacePartitionSync` 之前就会被 `marketplace.ts:366-373` 拦下 |
| O-2 | `official-marketplace.ts:125-128` | 别名分支（旧名被接受）在当前调用图下可达性存疑 | 唯一能传旧名进来的写入口 `writeCdnOfficialMarketplacePartitionSync` 的唯一调用点 `marketplace.ts:377` 被 `:375` 的 `manifest.name === canonical` 前置条件包住；`writeBundledOfficialMarketplacePartitionSync` 的 manifest 由 `bundled-plugins.ts:410-429` 本地构造、`name` 恒为 canonical |
| O-3 | `scripts/zcode-distribution/installer.mjs:6-59` | install.sh 是 POSIX `sh`，无 Windows 分支；`$BIN_DIR` 默认 `$HOME/.local/bin`；`mkdir -p "$INSTALL_DIR/releases" "$BIN_DIR"` 已存在，`chmod +x` 对已存在同名文件无 `-f` | 任务点名的「Windows 路径/权限」：该通道本身不覆盖 Windows（README 只讲 macOS/Linux）；`cat > "$BIN_DIR/omz"` 会**静默覆盖**同名旧文件，且升级路径下 `~/.omz/runtime/current` 是 `ln -sfn` 软链（e2e 报告 §4 记录过 msys 软链的环境异常） |
| O-4 | `sea-tui-assets.mjs:205-221` | 递归只收 `packageJson.dependencies` | `magic-context` 的 `devDependencies`（`@types/node`）不入队，符合预期；但若未来给 magic-context 加 runtime 用 optionalDependencies 依赖（非 opentui-core 特判路径），不会被收集 |
| O-5 | `packages/services/src/paths.ts:227-241 copyDataDirectory` | 「Change the base directory」的数据搬迁函数把 `.zcode/v2` 改成了 `.omz/v2` | 该函数是 desktop「数据存储路径」切换时复制 `v2` 的实现；旧数据在 `~/.zcode/v2`，用户切 `ZCODE_DATA_BASE_DIR` 后复制源会指向 `.omz/v2`（新根下可能为空）。属「改名 + 存量迁移」交互面，未见配套说明 |

---

## 附录 A — 全仓 HOME 解析点清单（106 处，扫描脚本口径：`*.ts/*.tsx/*.mjs` 命中 `homedir()` / `USERPROFILE` / `os.homedir`）

（完整清单见本节点会话产物 `D:\Dev\Js\oh-my-zcode\.tmp-home.txt`；此处摘录与本范围相关的 34 条）

```
adapters/src/auth/shared-credentials.ts:288,373,376
adapters/src/commands/roots.ts:30
adapters/src/config/file-config.adapter.ts:82
adapters/src/context/index.ts:246-247
adapters/src/device/cli-device-mid.ts:58,59,213,216
adapters/src/exec/execution-utils.ts:19            → .omz ✅
adapters/src/logging/index.ts:223                 → .omz ✅
adapters/src/model/runner-debug.ts:590            → .omz ✅
adapters/src/skills/roots.ts:30,129
adapters/src/storage/session-store/paths.ts:7     → .omz ✅
adapters/src/storage/workspace-hook-trust-store.ts:133
adapters/src/workflow/index.ts:35                 → .omz ✅
bootstrap/src/app/script-workflow-tool-port.ts:318   → .omz ✅
bootstrap/src/app/script-workflow-utils.ts:174      → .omz ✅
cli/src/clipboard-image.ts:33                     → .omz ✅
cli/src/data-dir-notice.ts:48,54
cli/src/env.ts:138                                → .omz-beta（触发键仍 zcode-beta，见 S-1）
cli/src/sea-playwright-runtime.ts:120             → 缓存根仍 zcode，见 S-2
cli/src/sea-runtime-tools.ts:69                   → .omz ✅
cli/src/tui-runtime-loader.ts:121                 → 缓存根仍 zcode，见 S-2
core/src/tool/handlers/saved-workflows/store.ts:62
debug/server/sources.ts:19,23                     → .omz ✅
magic-context/src/core/shared/data-path.ts:11,199,306
magic-context/src/core/shared/opencode-db-path.ts:62
magic-context/src/core/shared/redaction.ts:123
desktop/src/main/desktopRuntimeEnv.ts:492         → .omz ✅
desktop/src/main/exportLogs.ts:36,49              → .omz ✅
desktop/src/main/index.ts:468                     → .omz ✅
desktop/src/main/mcpUserDirectory/index.ts:63-64
desktop/src/main/mcpUserDirectory/legacy.ts:201-205
services/src/commands/commandsService.ts:28-29
services/src/hooks/hooksService.ts:56-57
services/src/mcp-sync/mcpSyncService.ts:149
services/src/node.ts:1071,1804                    → :1804 .omz ✅
services/src/plugin-sync/pluginSyncService.ts:216
services/src/runtime-tools/providerRuntimeResolver.ts:62,90 → .omz ✅
services/src/setting/settingService.ts:51-52,341
services/src/settings-sync/settingsSyncService.ts:420-421
services/src/skill-sync/skillSyncService.ts:130
services/src/skills/skillsService.ts:64-65
services/src/subagents/subagentStorage.ts:15-16
services/src/zcode-agent/modelTrajectoryFileTail.ts:18  → .omz ✅
services/src/zcode-agent/zcodeTaskServiceAdapter.ts:239  → .omz ✅
shared/src/protocol.ts:349（注释已改）
zcode-server-cli/src/runtime/paths.ts:25          → .omz ✅
```

## 附录 B — `zcode-beta` 字面量在生产代码中的分布

`apps/zcode-cli/packages/cli/src/env.ts:136`（唯一一处，`/(^|[/\\])zcode-beta(?:$|\.)/u`）。仓内不存在 `zcode-beta` 可执行产物或脚本（`scripts/`、`apps/zcode-cli/scripts/`、根 `package.json` scripts、install.sh 均无）。

## 附录 C — 本节点使用的只读取证手段

- `git show/diff/log/grep/rev-parse/ls-files`（未修改工作树；`git status` 未被本节点写入）
- 文件读取：`Read` 工具
- 静态扫描：临时脚本 `D:\Dev\Js\oh-my-zcode\.cr-scan.mjs` / `.cr-scan2.mjs` / `.cr-stat.cjs` / `.cr-sea.cjs` / `.cr-home.cjs` / `.cr-q.cjs`（写在仓库外的工作目录，仅做 grep/聚合）
- 构建产物只读解包：`tar -tzf` / `tar -xzOf`（`omz/dist/oh-my-zcode/releases/3.14.3/oh-my-zcode-3.14.3.tar.gz`）
- SEA 配置只读解析：`apps/zcode-cli/packages/cli/dist/sea-config-{win-x64,darwin-arm64}.json`
- E2E 沙箱只读列举：`D:\Dev\Js\oh-my-zcode\.e2e-phase3-final\{home,install-home,evidence}`
- 一次网络只读请求：`https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json`（取顶层 `name` 与插件名列表）
- 未执行：任何构建、任何 CLI 运行、任何安装/写盘动作
