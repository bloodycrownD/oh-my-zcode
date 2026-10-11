# mural-map.md — Step 15（impl-mural）证据包

- 节点：impl-mural（Step 15）｜类型：impl｜分支：bugfix-batch-20261011｜base：e81dc870
- 范围：mural 全链五件套无缝新移植 + render-trigger 壳缝① + mediaBlocks 承载通道 + memory barrel + config.mural.enabled 透传 + MEMORY_MURAL_BLOCK 到 wire 验证
- 依据：spec Step 15 全文 / D5 行 / 测试策略 T-MU 面 / r5 审查修正（P2-5 相对路径勘误）/ cr-fix-spec OQ-CTX

## 一、文件清单与处置

### 1. mural 五件套「无缝新移植」（③态，整文件复制 + FORK-NOTE 头）

| 文件 | 上游行数 | 处置 | 逐字校验 |
|---|---|---|---|
| `src/core/features/magic-context/mural/resolve-mural.ts` | 111 | 新移植 + FORK-NOTE | OK（仅 5 条 import 加 `.js` 后缀） |
| `src/core/features/magic-context/mural/render-mural.ts` | 652 | 新移植 + FORK-NOTE（纯 node:zlib，无 sharp） | OK（仅 font import 加 `.js`） |
| `src/core/features/magic-context/mural/mural-selection.ts` | 31 | 新移植 + FORK-NOTE（上游循环 import 逐字保留并登记） | OK（2 条 import 加 `.js`） |
| `src/core/features/magic-context/mural/storage-mural.ts` | 103 | 新移植 + FORK-NOTE | OK（1 条 import 加 `.js`） |
| `src/core/features/magic-context/mural/mural-font.generated.ts` | 157 | 新移植 + FORK-NOTE（BSD-2-Clause Spleen 头逐字保留） | OK（零改动） |

逐字校验方法：`.tmp-verify-ports.mjs` —— 上游文件（LF 归一后）应用已知 import 适配，断言落盘文件**以该结果结尾**（头注在前）。全部 OK。
上游 `compress-cues.ts` / `compress-cues-prompt.ts` / `cue-validation.ts` 三件按 N3 **不搬**，登记于 render-trigger FORK-NOTE。

### 2. render-trigger 壳缝①（git mv 保轨迹 + 上游 240 行真身）

- `git mv src/core/deferred/render-trigger.ts → src/core/features/magic-context/mural/render-trigger.ts`（R 状态，rename 轨迹在历史里）。
- 内容整体替换为上游 240 行真身（ensureMuralRendered / muralCoverageGate / resolveMuralWire / modelKeyAcceptsImages / renderCaches）。
- **唯一行为适配（spec Step 15 裁定）**：vision 判定源。上游 `modelSupportsVision`（models-dev apiCache，本 fork 零生产者恒 false）→ 宿主注入 probe（静态目录 `ModelInputFormatData.supportsImage`，packages/shared/src/model-config.ts:51-59）。`setMuralVisionProbe` / `MuralVisionProbe` 为本步新增注入缝（与 `setRawMessageProvider` 同范式）；`piModelRefToCanonical` 规范化逐字保留。缺 probe = fail-closed 不出图（上游同向）。
- `MuralWireOptions` 类型真身随 resolve-mural 落位（seam 曾持有的副本删除）。
- 逐字校验：`.tmp-verify-trigger.mjs` OK（240 行真身 + 两处登记适配）。
- 上游 61 行壳缺的 `modelKeyAcceptsImages` 归位。

### 3. 引用改指（纯 import 行 1:1，r5 P2-5 勘误相对路径）

- `inject-compartments.ts`：`../../deferred/render-trigger.js` → `../../features/magic-context/mural/render-trigger.js`；类型改从 `../../features/magic-context/mural/resolve-mural.js`（上游 :25-26 同形）。
- `compartment-runner-incremental.ts`：promotion / storage-memory 两条直引改走 `memory/index.js` barrel（runner 直引收口）。

### 4. memory barrel（Step 15 职责，r2/审计指出）

- 新建 `src/core/features/magic-context/memory/index.ts`：constants / normalize-hash / promotion（仅 promoteSessionFactsDurable + PromotedMemoryRef）/ storage-memory / storage-memory-fts / types。
- **禁 re-export N1 embedding 面**：embedding / embedding-backfill / storage-memory-verifications / verification-paths 不搬；embedding-cache / storage-memory-embeddings / embedding-failure 已移植但不出 barrel；`embedPromotedFacts` 不存在（Step 8 已删）不复活。
- 与上游 barrel 差异（含 project-identity 为何不出——fork 版带 test hooks 且 spawn git）全部登记在文件头注。mural 经 barrel 只取 `getMemoriesByProject` 一个符号（`getMemoryCategoryOrder` 走 constants）。

### 5. attachment 扩 mediaBlocks（方案 b，spec 已裁定）

- `core/src/agent/message-history.ts`：`RuntimeAttachmentEntry.mediaBlocks?: readonly ModelMessageContentBlock[]`（可选、请求作用域、不落 persistence）；`cloneRuntimeMessageEntry` 深拷贝携带（否则 reset/borrow 快照把壁画静默降级成纯文本）。
- `core/src/runtime/helpers/provider-request-messages.ts`：`renderProjectedEntryToModelMessage` 把 mediaBlocks 追加进 attachment 的 user message content（`[text block, ...image blocks]`）；无 mediaBlocks 时逐字节保持裸字符串 content。
- `magic-context/src/host/types.ts`（FORK copy）：`ZCodeRuntimeAttachmentEntry.mediaBlocks` 镜像 1:1；`projectRuntimeEntry` 把 mediaBlocks 投影为 synthetic part（正反投影对称）；`projectMessageUnchanged` 判定从「parts.length===1」改为「1 text + N media」。
- `bootstrap/src/app/magic-context-turn-transform.ts`：`magicContextAttachment` 从只取 text part 扩为同时提取 image part（`mediaBlocksOf`：`{type:"file",mime:"image/png",url,synthetic:true}` 上 shape + 直接 image part）；`isUnchanged` 附件分支同步新计数规则。

### 6. config.mural.enabled 透传（OQ-CTX 登记闭合）

- `buildTransformDeps` 增 `muralEnabled: config.mural.enabled`；`applyConfigToDeps` 同字段原地改写（热生效，与 memoryConfig 同纪律）。
- 包内消费链（既有）：transform.ts `muralEnabled: deps.muralEnabled` → inject-compartments `resolveMuralForM0`（`options.memoryEnabled===false || !options.muralEnabled` 即返 undefined）→ `resolveMuralWire(db, projectPath, modelKey, true, budget)` → `MEMORY_MURAL_BLOCK` section + `<memory-mural>` 注入。
- 此前该字段从未被填 → 恒 undefined → 壁画运行期恒关；本步闭合。

### 7. vision probe 宿主接线

- `createMagicContextTurnTransform` 新选项 `muralVisionProbe?`，工厂内 `setMuralVisionProbe(options.muralVisionProbe)`（每次装配整份设置/清空，防多会话残留）。
- `create-app.ts` 由 provider Registry 解析：`getModel(providerId, modelId)?.config?.properties?.inputFormat?.supportsImage === true`；冒号 tag 后缀 fallback 与上游 `modelSupportsVision` 同款；未知/缺字段一律 false。

## 二、测试（T-MU 面）

| 用例 | 位置 | 断言 |
|---|---|---|
| T-MU1a | magic-context `scripts/test-mural-render.mjs` | supportsImage 判定四态（vision true / 非 vision false / 无键 false / 未注入 false）+ pi 前缀规范化后交 probe |
| T-MU1b | 同上 | vision+enabled+cue 池 ⇒ **真渲染触发**：PNG data URL（magic + IHDR 尺寸与 width/height 一致）、contentHash 64hex、mural_manifest 落行（model=deterministic）、40 条 overflow 全渲染 |
| T-MU1c | 同上 | 变更检测：同池 rerendered=false 同字节；cue 变 ⇒ 新哈希新 PNG |
| T-MU1d | 同上 | 禁用/无 vision/未注入/无 modelKey/无 project 五态**静默不渲染**且 manifest 一行不写 |
| T-MU2 | 同上 | 覆盖门：3/40 cued ⇒ hasMural:false + skipReason 带度量；零 active ⇒ "no active memories" |
| MU-X1/X2/X3 | 同上 | 渲染确定性（两次逐字节相同）/ resolveMural 排序（category→importance DESC→id ASC，stale cue 排除）/ memory barrel 闭包符号出、N1 embedding 面不出 |
| T-MU2a | bootstrap `scripts/test-mural-media-blocks.mjs` | 壁画 part 反投影成 attachment.mediaBlocks（PNG 上路），m0/m1 落位规矩不破 |
| T-MU2b | 同上 | 无图片 part ⇒ attachment 不带 mediaBlocks 键（形状不变） |
| T-MU2c | 同上 | core provider 投影：mediaBlocks ⇒ user content `[text, image]`；无媒体 ⇒ 裸字符串 |
| T-MU2d | 同上 | 正投影往返（part 级）+ projectMessageUnchanged 未改动判定 + transform 追加文本判为已改动 |
| T-MU2e | 同上 | 真工厂 probe 透传（选项 ⇒ 包内 modelKeyAcceptsImages 真值）；不传 ⇒ false；收口清空 |

挂载：`magic-context/package.json` `test:mural-render` + 进 `test:all`；`bootstrap/package.json` `test:mural-media-blocks`。

## 三、验证实跑记录（Node 24 便携版 .tools/node-v24.14.0-win-x64）

| 命令 | 结果 |
|---|---|
| `pnpm --dir apps/zcode-cli/packages/magic-context test:all` | 全绿：smoke 36 / config 11 / host 30 / **transform 38 cases, 0 failures（基线不破）** / historian 18 / ctx-tools 20 / ctx-search-memory 10 / **prompt-surface 26（基线不破）** / memory-promotion 4 / **mural-render 8** / boot-busy-retry 7 |
| `pnpm --dir apps/zcode-cli/packages/bootstrap run test:magic-context` | 23/23 |
| `pnpm --dir apps/zcode-cli/packages/bootstrap run test:settle-background` | 4/4 |
| `pnpm --dir apps/zcode-cli/packages/bootstrap run test:mural-media-blocks` | 5/5 |
| `pnpm --dir apps/zcode-cli/packages/core run test:magic-context-section` | 10/10 |
| `pnpm --dir apps/zcode-cli run typecheck`（turbo） | **27 successful, 27 total** |
| 根 `pnpm typecheck`（tsc -b） | **0 error** |
| `pnpm architecture:check --changed` | **OK / violations 0 / baseline 0 / new 0** |
| oxfmt 公平对拍（HEAD vs 工作区，tmp 通道防 autocrlf 误报） | 见下 |

## 四、oxfmt 状态（本节点诚实登记）

- 仓库自己的判据是 `apps/zcode-cli/.oxfmtrc.json`：`ignorePatterns` 显式排除
  `packages/magic-context/src/core/**`（逐字区保真）。官方
  `pnpm --dir apps/zcode-cli run format:check` 实测：**本节点 9 个非 core 文件全部
  clean**（host/types.ts、magic-context/package.json、scripts/test-mural-render.mjs、
  core message-history.ts / provider-request-messages.ts、bootstrap
  magic-context-turn-transform.ts / create-app.ts / package.json /
  scripts/test-mural-media-blocks.mjs）。
- core 逐字区（5 个移植件 + render-trigger + memory/index.ts + inject-compartments /
  compartment-runner-incremental）被官方配置排除，oxfmt 不归一——与「无缝=整文件
  逐字复制」的 FORK 纪律一致（Step 8 移植件同一 zone 状态）。
- 仓库级 `format:check` 在 HEAD 上即为红（1131/1407，全为 ignored core 之外的历史
  状态，任何节点相同），非本节点新增。
- 本机 checkout 为 CRLF（`.gitattributes` 锁定 eol=lf），oxfmt 直接对工作区文件判定
  会把换行算成 issue；本节点提交的文件一律以 LF 落盘（逐个校验过），这也是上述
  「9 个文件全 clean」的前提。

## 五、lint（诚实登记，非本节点门禁）

- `pnpm --dir apps/zcode-cli/packages/magic-context run lint`（oxlint src）在本节点之前即为红（24 warnings / 40 errors，命中项全为 HEAD 既有文件：max-lines 大文件、既有 unused import 等）；根 `.oxlintrc.json` 的 ignorePatterns 含 `apps/zcode-cli`，故根 `pnpm lint`（真基线 71w/0e）不覆盖本包。
- 本节点新增 1 error + 1 warning，全部来自逐字移植件本身：`render-mural.ts` max-lines（667 行 > 400）与 `unicorn(no-useless-spread)`（上游 `for (const character of [...text])` 原文）。与上游逐字一致，不做本地改写；同 zone 的 transform.ts（2228 行）/ inject-compartments.ts（4205 行）等早已是同款 error。

## 六、提交

- 提交 1（真身移植，`6d40a729`）：mural 五件套 + render-trigger git mv + memory barrel + 引用改指 + test-mural-render.mjs（并因 index 里遗留暂存内容把 `src/index.ts` mural 扩面段一并带入，终态自洽，见第六节）。
- 提交 2（承载通道，`a0dc4704`）：core message-history + provider 投影 + host/types 镜像 + bootstrap 提取/muralEnabled/probe + create-app 接线 + test-mural-media-blocks.mjs + bootstrap/package.json 挂载。
- **并发节点的提交穿插（诚实登记）**：执行期间 Step 16 / Step 18 节点在同一工作树并行落地提交（`a5618a3b`、`214823ce`）。
  - `magic-context/src/index.ts`（mural barrel 扩面段）先被 Step 16 的 `6eac0468` 带入、又在其 `a5618a3b` 中被摘除（对方按「不碰 Step 15 半成品」处理）；本节点提交 1 因 `git commit` 提交整个 index（该路径的旧暂存内容仍在 index 里）把 mural 段随提交 1 一并恢复，终态含全部 mural 导出——bootstrap 的 `setMuralVisionProbe` import 依赖它，缺失即编译失败，已由 27/27 typecheck 与全量测试证明终态自洽。
  - `magic-context/package.json` 的 `test:mural-render` 挂载行最终随 Step 18 的 `214823ce` 落地（与其 `test:tool-name-closure` 同文件一并提交），`test:all` 链现已包含两个新测试；本节点未单独提交该文件（避免把对方的 test:all 段带入而不带其脚本、造出断裂的中间提交），终态无任何工作丢失。
  - 本节点两个提交均用显式 pathspec，未带入 Step 16/18 的任何文件。
  - Step 16 提交信息自述「test:transform / test-ctx-search-memory / test-prompt-surface 被 Step 15 mural 并行半成品阻断（memory/index.ts 错位副本 + mural/render-trigger.ts 无扩展名 import，均禁触）」——那是本节点修复途中的瞬时状态（oxfmt 写回脚本 basename 撞车 + 首次生成漏改一条 import），两个问题在本节点内已自查发现并修复（memory/index.ts 重建、`.js` 后缀补齐），并以逐字节校验 + 全量 test:all 复跑确认终态。

## 七、观察项 / 遗留

1. `magic-context/package.json` 挂载如上（并发写入，未提交）。
2. mural 的 cue 生产面（compress-cues dreamer）按 N3 终局不做 ⇒ cue 只能由 `storage-mural-cues.setMuralCue` 写入（测试直证路径）；真实项目里 cue 池为空时覆盖门静默跳过（`skipReason` 可观测）。cue 生产入口属 dreamer 裁定，本批不重开。
3. 实机验收（qa: manual_user，T-MU2 spec blocking:no）：vision 模型 wire 收到 mural PNG part 的桌面/CLI 实机录屏留给合并后用户执行；本节点以 core provider 投影单测（T-MU2c）+ bootstrap 反投影单测（T-MU2a）覆盖到「PNG 进 attachment 的 message 变体」这一级。
4. 并行节点的在途改动（transform.ts / transform-postprocess-phase.ts / scheduler.ts / storage-meta-persisted.ts / lkg-replay-fit.ts / core/package.json / core/context/sections/magic-context.ts / protected-tokens.ts / host/config/schema.ts）未动本节点文件；turbo typecheck 27/27 与根 tsc -b 0 error 是在含这些在途改动的全树上实跑通过。
