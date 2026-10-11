---
date: 2026-10-11
---

# 六项缺陷批次（bugfix-batch-20261011）技术规格（SPEC）

## 需求来源

用户口述（对话内报障，无 prd.md）。本批累计六项缺陷 + 一条硬标准：

1. magic-context 前台 settle 等待（首 token 延迟 + 排队消息阻塞）——桌面长驻进程不应付 CLI「一进程一轮」的代价。
2. 主会话切模型不实时——切换后 assistant 应立刻用新模型，实际要等下次发 user 消息。
3. 子智能体模型不实时——设置页改「继承→具体模型」同会话不生效，需重启应用。
4. magic-context 提示词面/记忆半边整缺——上游有 210 行 agent 系统提示词段与项目记忆系统，fork 只移植了工具注册，配套指导与记忆注入全部缺席，模型只能靠工具描述自悟。
5. deferred 缝全量处置——21+ 个缝逐项给出终局裁定。
6. 用户标准（原文）：「**要么做，要么不做，不存在二期。做就做好，不做就给出理由（确保不影响 magic context 的使用，像之前你丢失没做的就非常影响使用。）**」——本 spec 的一切裁定以此为准；「不做」必须有「不影响使用」论证与收口动作（FORK-NOTE 登记/删除登记），禁止挂「评估门/后续/另议」。

## 设计目标

| # | 目标 | 对应现状症状 |
|---|---|---|
| 1 | settle 按「进程真会随轮退出」条件化；长驻形态（app-server/TUI/桌面）不阻塞前台 | 每个 model step 前最多 60s×2 折叠等待（N-step turn 上界 N×120s）；排队消息 idle-only 提升与 settle 硬耦合 |
| 2 | 主会话切模型下一轮立即生效（含排队消息提升） | UI 只改草稿意图，Session Selection 等下一次提交才更新；queue item 用入队时旧快照 |
| 3 | 子智能体模型 override 每次 spawn 读活值 | agents-state.json 仅 session 创建时读一次，冻结进 runtimeConfig；native port 构造期冻结 profiles |
| 4 | magic-context 记忆半边真身移植：系统提示词段、项目记忆读写、user-memory、ctx_search、mural、prompt-surface | deferred/Batch2/S31 整块缺席；`## Magic Context` 段从未注入；`<project-memory>` 无内容 |
| 5 | 全部缝终局裁定：做的真身落位，不做的 FORK-NOTE/删除登记收口 | 23 个缝悬置，交付呈现从未说明「只接了压缩半边」 |

## 现状约束（来自探索报告，实现不得违反）

### FORK 纪律（magic-context 包）
- `apps/zcode-cli/packages/magic-context/src/core/**` 是上游逐字移植区。deferred 缝与上游真身是**三态**（r4 P0-1 口径）：
  ① **壳缝（deferred 文件=裁剪壳，头注自陈 WHY A SEAM）**——真身落地=**`git mv` 保 rename 轨迹 + 文件内容整体替换为上游真身 + 文件头 FORK-NOTE 注明上游路径/行数/差异**（小文件 git 呈现 RM；大文件因共享行 <20% 呈 D+A，轨迹靠同 commit 对偶删除 + FORK-NOTE「WHAT CHANGED VS THE SEAM IT REPLACED」段可追溯；壳中裁剪掉的 exports 不复活，按 fork 引用面）。适用：magic-context-prompt（23→210）、storage-memory（66→1267）、storage-user-memory（50→296）、render-trigger（61→240）、prompt-surface（46→162）、prompt-surface-runtime（45→283）。
  ② **全覆盖缝（壳 exports 已覆盖所需面）**——直接 `git mv` + 缝头改写 `FORK-NOTE`。适用：memory-selection、embedding-failure、model-resolution（type-only）、event-resolvers、ctx-reduce-availability（后两者**保留壳不搬上游真身**，见 D9/D10 与 Step 16）。
  ③ **deferred 无缝的上游文件**——整文件从上游复制、文件头 FORK-NOTE：promotion、storage-mural-cues、storage-memory-fts、normalize-hash、visibility、embedding-cache、storage-memory-embeddings、resolve-mural、render-mural、mural-selection、storage-mural、mural-font.generated、tools/light-descriptions。
  引用改指一律**纯 import 行 1:1**。先例：`de52c882` wip(s20)、`2053bac6` s21、`eae2933f` s20。
- 扩 `src/index.ts` barrel 必须带说明注释块（为什么要出这个面 + 宿主不得自抄），bugfix 类引批号。
- 涉及逐字区的改动标 `core 区`；宿主侧（bootstrap/core/cli）标 `fork 层`。

### 模型选择语义（本批缺陷 2/3 的回归红线）
- `turn-model.ts:47-51`：v1.0.4 修复「编辑重发/queue 提升不写回会话态」——**写回红线不变**（promote/编辑重发不写回、不置 pin，仅显式 pin 时三连）。**执行语义已被 2026-10-11 用户裁定改写**（见 :273「出队模型」）：编辑重发（fork-edit-retry.ts、goal.ts、session-mgmt.ts）与 queue 提升一律读会话当前活值，「编辑重发保旧快照」旧语义废除（de96549d）。
- `turn.ts:239-240`、`turn-guide-drain.ts:29-38`：execution-scoped 模型（闲时任务/单次执行）不改写 Session Selection、禁止切模——豁免必须保留。
- `modelSelectionPinned` 在 desktop 场景恒 true（composerSubmissionConfig.ts:13-44 每条 sendText 都带 modelSelection），设计「显式 pin」语义已被泛化；promote 规则按 2026-10-11 裁定为一律活值（时间戳判据已废除），不依赖 pin 重定义。
- 子智能体：`runner.ts:131-137` native port 构造期 `normalizeAgentProfiles` 冻结 profiles——仅改 `runtime.config.subagents` 无效，必须让 override 注入可失效重建。
- ConfigPort 无 subagent 域（contracts/src/config/index.ts:239-310）；`updateConfig`（config.ts:48-71）只认 `mode|planEnabled|language|outputStyle`。

### magic-context 移植技术约束
- **mural 图片承载硬缺口**：`RuntimeAttachmentEntry.content: string`（core/src/agent/message-history.ts:59-66）只能承载文本；上游 mural 以 `{type:"file", mime:"image/png", url:dataUrl, synthetic:true}` part 注入（上游 inject-compartments.ts:3315-3328）；ZCode `magicContextAttachment()` 的 `textOf` 只取 text part（bootstrap magic-context-turn-transform.ts:586）。contracts 已支持 `ModelImageContentBlock`（contracts/src/model/index.ts:364-370）。
- **vision 判定链断裂**：`models-dev-cache.ts:593 modelSupportsVision()` 依赖 `apiCache`，而 `refreshModelLimitsFromApi`（:369）全仓零调用者——即使换真身 render-trigger，vision 恒 false。替代判定源：`packages/shared/src/model-config.ts:51-59` `ModelInputFormatData.supportsImage`（静态目录，media-policy.ts:40 已用）。
- **render-mural 是纯 `node:zlib` PNG 编码，无 sharp**——mural 渲染不触发依赖排除令。
- **embedding 依赖排除令**：oh-my-zcode-fork spec L114 明令不引入 `onnxruntime*`/`sharp`/`@cortexkit/subc-client`；SEA 打包把 magic-context 全依赖树 BFS 收进 blob（sea-workspace-package-assets.mjs），加原生依赖=4 平台二进制+运行期 HF 模型下载（~90MB，离线失败）；`import.meta.url` 在 cjs 下被清空（build.mjs:14-21 已有先例注释，worker 路径同款风险）。
- DB 层 schema-complete：memories/memory_embeddings/mural_manifest/`session_meta.cached_m0_mural_*` 全部就位（storage-db.ts:1365-1505、migrations.ts:2600），LATEST_MIGRATION_VERSION=94（fork 与上游符号同名同值）——**记忆半边不需要新 migration**。
- 缝的取值都是「上游自己的 no-op 臂」（storage 读返回 `[]`、mural `supportsVision:false`、notification `"skipped"`）——管道通、无内容；且 `send-session-notification` 的紧急拒绝路径 throw 是**正确行为**（fail-visible），不得「修复」掉。
- 上游 `buildMagicContextSection` **11 参**中 5 个（memoryEnabled/dreamerEnabled/temporalAwarenessEnabled/cavemanTextCompressionEnabled/subagentMode）需 ZCode 数据源装配；`ctxReduceCallable` 必须来自真实判定（见 Step 16），否则提示词说谎。**段文本在 memoryEnabled=true 时含 MEMORY_GUIDANCE（硬引用 ctx_memory→D14 已注册）；CTX_NOTE_GUIDANCE 在 full preset 无条件拼接、light 分支 MEMORY_GUIDANCE_LIGHT 同样提 ctx_memory（ctx_note→N2，适配见 Step 18）。**
- ZCode 原生 `# Memory` 段（core/src/context/sections/memory.ts，文件式 MEMORY.md）与 magic-context `<project-memory>`（SQLite 记忆库）同场会给出两套矛盾的「如何记忆」指令——必须互斥。
- E 组配置白名单（host/config/schema.ts）当前不含 `prompt_surface`/`memory`/`mural`；`EXCLUDED_CONFIG_KEYS=["compaction"]`。

### settle/进程形态约束（探索子代理报告已复核）
- **settle 在每个 model step 之前都跑**（`turn-loop.ts:119` 在 `while(true)` 内），不是每 turn 一次：一次 N-step 的 turn 理论前台阻塞上界 = N×120s（两段 settle 各 60s、串行 await）。
- 两处 settle 是**独立机制**：`settleInFlightHistorian`（bootstrap :1605-1609，端口实现内无条件 await，**无端口开关**）与 `settleScheduledPass`（:1628-1626，端口钩子，装配于 :1264-1276）。只条件化其一只能砍一半上界。
- 判据取「**进程是否随本轮退出**」，不是「是否桌面」：app-server（protocol 入口，长驻）与 **TUI（`run.ts:560`，同为长驻）**=后台化；print/一次性（`run.ts:497-527`）=保留前台。权威切分 `isProtocolServerInvocation`（cli/src/arguments.ts:112-126），但**形态应由三个入口显式透传**（先例：zcode-protocol-entrypoint.ts:215 硬编码 `sourceTitle:"electron"`），bootstrap 不做 argv 嗅探（TUI/print 与 `--surface` 组合不othogonal）。
- **`hostProcessLifetime` 保持硬编码 `"one-process-per-turn"` 不动**：改 per-session 会在长驻进程 resume 新 session 时重引入 usage 全灭回归（T-M2/T-M3/T-M6 风险）；新增第三枚举=包内 transform.ts S20 特权区。本批只动 settle，FORK 注释登记理由。
- **core turn-loop 是 FORK 纪律禁区**（core 包 `core/src/runtime/helpers/magic-context-turn-transform.ts:1-26` 文件头、bootstrap 包 `bootstrap/src/app/magic-context-turn-transform.ts` 对应注释（Step 1/2 提交后行号已移位，以内容检索「刻意不在 core 的 turn-loop 上挂点」为准）均明示该纪律）：settle 条件化只能落 bootstrap 端口层。
- 排队阻塞的硬耦合机制：settle 拖长 `runtimeCommandDrainActive`/`activeForegroundExecution` 存活期 → `hasActiveOrQueuedTurnWork()` 恒真 → 新 prompt 走 busy 分支；且 auto-drain 的 `acquireForegroundPromotionLease({mode:"idle-only"})`（runtime-command-queue.ts:125-134）要求**五条件全空**（activeForegroundExecution / runtimeCommandDrainActive / hasPending() / activeTurn / activeTurnStartReservation）——**桌面排队消息自动提升直接卡在 settle 未结束**。
- 后台化后的收口语义：调度器契约自陈 fire-and-forget 自行 publish（historian-scheduler.ts:19-36）；`notifyTurnSuccess` 的 `in_flight` 丢弃在长驻形态是**预期行为**（同一 raw head 由首次 pass 覆盖），`getLastNoFireCause` 会稳定显示 `in_flight`，运维文档登记、不得当故障修。MF-05 registerClose 兜底边界：优雅关闭（app.close()：idle 10min 回收/disposeAllAndWait graceful 段）drain 收口；**强杀（force-kill）下与 CLI 一进程一轮同损——既有风险，非本批新增**。
- 既有单测锁定：`test-magic-context-turn-transform.mjs:410-430` 断言顺序 `[transform,notify,settle:start,settle:end]`——需按形态分化，不是删除。
- 桌面 host 是 Electron UtilityProcess 长驻（desktopHostProcess.ts:636，exit 仅故障/销毁边界）；agent 进程按 workspace 缓存长驻（zcodeAgentProcessManager processesByWorkspaceKey，SessionResidentPool target 8/high water 16/idle 10min）。
- 门禁：根 `pnpm typecheck` 0 err；`pnpm lint` 真基线 71w/0e（分支允许持平或下降）；`cd apps\zcode-cli && pnpm typecheck` turbo 全 successful；magic-context `pnpm run build && pnpm run test:all`；`pnpm test:v4-perf`（手工枚举清单，新增 ui/shared 测试须同步根 package.json:32）；`node scripts/typecheck-desktop-full.mjs` 差分无新增（不写死 kinds 数）；oxfmt 根+apps/zcode-cli 各自「改动文件零新增」；knip stash 对比零新增+零 magic-context 命中；`pnpm architecture:check --changed`。CLI turbo lint 不是门禁。
- 测试隔离：绝不写真实 `~/.omz`/`~/.zcode`；magic-context 测试显式 `MAGIC_CONTEXT_DB_DIR`/`MAGIC_CONTEXT_LOG_PATH`；exec 类显式 `ZCODE_STORAGE_DIR` 指临时目录。
- Windows 坑：便携 Node 24（node:sqlite 必须 24）；`%ERRORLEVEL%` 链式回显是解析期假象；PowerShell 往返写中文文件曾毁 fix-spec——批量改文件用 node 脚本。

## 总体方案

### 裁定总表（终局，无二期）

**做（真身移植 / ZCode 等价适配）**：

| # | 项 | 方式 |
|---|---|---|
| D1 | `agents/magic-context-prompt.ts`（210 行段 + SELF_TAG_GUIDANCE） | **壳缝①**：git mv+内容替换为上游真身（23→210，buildMagicContextSection/SELF_TAG_GUIDANCE 归位）（**CR fix 追加 B三 行数口径**：上游 211/163/284 之数为旧引用，本仓按含尾 LF 计实为 210/162/283；spec/FORK-NOTE 以此为准）+FORK-NOTE；ZCode 注入缝（context/sections 新增 magic-context.ts） |
| D2 | `memory/storage-memory.ts`（1266 行） | **壳缝①**：git mv+内容替换（66→1267，insertMemory/insertMemoryIdempotent 等 34 exports 归位——D13/D14 的 import 闭包全在此）+FORK-NOTE；schema 已就位 |
| D3 | `memory/memory-selection.ts`（44 行）+ `user-memory/storage-user-memory.ts`（295 行） | memory-selection=**全覆盖缝②**直接 git mv；storage-user-memory=**壳缝①**替换（50→296）+FORK-NOTE；连带闭包按各自上游 import 闭包补齐（**cosine-similarity 不在任何闭包内，不搬=N1**） |
| D4 | ctx_search 工具（关键词/FTS5 版） | ZCode D 组模式新增（contracts→core handler→builtInTools→allowlist），检索 storage-memory，无向量 |
| D5 | mural 家族（render-trigger=**壳缝①** git mv+内容替换 61→240（ensureMuralRendered/modelKeyAcceptsImages 等归位）+FORK-NOTE；resolve-mural/render-mural/mural-selection/storage-mural/mural-font.generated 5 件=**③新移植**；storage-mural-cues **随 Step 8 提前**——它是 storage-memory 的 import 闭包项，落 `mural/` 目录；**mural/ 另 3 件 compress-cues/compress-cues-prompt/cue-validation 不搬**——依赖 dreamer 链（N3），FORK 登记于 mural 目录 FORK-NOTE） | vision 判定源换 `supportsImage`；attachment 扩 mediaBlocks 承载 PNG |
| D6 | `shared/prompt-surface.ts` + `prompt-surface-runtime.ts` | **壳缝①**×2：git mv+内容替换（46→162 / 45→283）+FORK-NOTE；`tools/light-descriptions.ts` **③随行新移植**（runtime 上游 :4-14 import 5 常量）；ZCode 适配（jsonc→JSON、配置面接线） |
| D7 | `shared/model-resolution.ts`（3 type） | git mv（type-only） |
| D8 | `memory/embedding-failure.ts`（上游 152 行，零依赖） | git mv（format-embed-failure.ts:1 已消费，删缝必须归位） |
| D9 | `hooks/event-resolvers.ts` | **全覆盖缝②（review-full 勘误 2026-10-11：实装为 git mv+替换为上游真身函数体、按 fork 引用面裁剪 3 个 exports——resolveContextLimit/resolveCacheTtl/resolveSessionId 属 fork 未接语义不复活；原「保留壳不搬真身」措辞系 r4 P1-1 判定下的文书遗留，头注已自陈依据，行为零影响）**（引用面：transform.ts:97-103、scheduler.ts:19、lkg-replay-fit.ts:3、barrel :164-165；r5 勘误：transform-postprocess-phase.ts:92/99 属 D10 面非本面）；缝头改 FORK-NOTE 登记裁剪面 |
| D10 | ctx-reduce-availability 的 ZCode 等价判定 | **壳②保留**（fork 引用面 ⊆ 壳 153 行 exports：transform.ts:79-86、transform-postprocess-phase.ts:89-99——上游 569 行多出 17 exports 属未接语义不复活）；`spawnAgentFromMessages` 壳内逐字保留；`ctxReduceCallable` 用 ZCode 工具注册/结构禁用面判定；THROW 臂删除后改 `return false`（=未拒绝，fail-open 对齐，见 Step 16） |
| D11 | 原生 `# Memory` 段互斥退场 | magicContext.enabled 时 `core/src/context/builder.ts` 以「段在场为门」不注入原生 Memory 段（**CR fix 追加 B②**：spec 原写「sections/memory.ts 不注入」，实现在 builder.ts 依 `context/sections/memory.ts` 的 section 是否在场判定退场——语义等价，spec 文本对齐实现） |
| D13 | `memory/promotion.ts`（上游 145 行，**新移植**——deferred 无缝非 rename）+ fork `compartment-runner-incremental.ts` 恢复 `promoteSessionFactsDurable` 调用（沿用既有 `autoPromote` 门，与 boundary floor 同事务） | **记忆自动写入入口**——没有它 memories 表永远为空（r1 P0-1）；`embedPromotedFacts`（promotion.ts:100）按 N1 删除并清理失效 import（review-full 勘误：实清 4 个——getMemoryById 唯一调用点亦在删除段内）+FORK-NOTE；`memory/storage-memory-embeddings.ts`（纯 sqlite）随行新移植 |
| D14 | ctx_memory 工具（FTS5 写入面，`insertMemoryIdempotent`） | 210 行段 MEMORY_GUIDANCE **硬引用**（r1 P0-2）；storage-memory 真身已在 D2，成本≈ctx_search；给模型显式 pin 记忆的能力 |
| D12 | 三项 bug 修复 | settle 条件化 / 主会话切模型实时 / 子智能体 per-spawn 活值 |

**不做（终局裁定；理由 + 不影响使用论证 + 收口动作）**：

| # | 项 | 理由 | 不影响使用论证 | 收口动作 |
|---|---|---|---|---|
| N1 | embedding 运行时面：`embedding-synapse` provider class、`project-embedding-registry`（3649 行）、本地 transformers/onnx 链、shadow backfill 执行面、`embed-session-state`、`auto-search-runner` | ① 三 provider 两家依赖外部服务/被排除依赖（subc-client 是 fork spec L114 依赖排除令；openai-compatible 需用户配 key）；② 本地 provider=@huggingface/transformers+onnxruntime-node/web：SEA blob 膨胀（4 平台原生二进制）+ 运行期 ~90MB HF 模型下载（离线必挂）+ `import.meta.url` cjs worker 路径坑；③ 上游 provider enum 本含 `"off"`，缺席=合法配置态 | 记忆链完整不依赖向量：写入（historian 分舱 `promoteSessionFactsDurable`（D13）→storage-memory；模型显式 pin 走 ctx_memory（D14））→ 选择（memory-selection 排序）→ 注入（m0/m1 文本+mural cue）→ 检索（ctx_search FTS5 关键词）；缺席仅损失「语义召回」增强；format-embed-status 诚实显示 off | `embedding-status-tables.ts` 缝保留 type 面 + **被 format-embed-status.ts:1,3 消费的两个 formatter 运行时值**（formatSynapseLaneDescriptor、describeShadowBackfillWriteRefusal），头注改 `FORK-NOTE`：终局不做+本表理由；**其余 embedding 缝按 fork 实际清单逐一处理（r2 P1，勿找不存在的 embedding.ts/cosine-similarity）**：`compartment-chunk-embedding.ts`、`embed-session-state.ts`、`auto-search-runner.ts` 同改 FORK-NOTE【勘误 2026-10-11（Step 17 实装后）：`embed-session-state.ts` 终态为**删除**（`git rm`，`145f8f2a`）——其 `EmbedDrainUiStatus` 四成员并集已本地化 `format-embed-status.ts`，`getEmbedDrainUiStatus` 零消费者随删；保留壳无消费者面，删除比挂 FORK-NOTE 更诚实。与行首「`embedding-status-tables.ts` 缝保留 type 面」不冲突——那是仍被消费的 formatter 面】 |
| N2 | ctx_note 工具 + note-nudger（+smart-notes） | ZCode D 组工具面只登记 ctx_reduce/ctx_expand（本批 +ctx_search）；note 属上游交互笔记特性，无 ZCode 工具宿主面 | 记忆主链（写/选/注/检）不经过 note；缺席=无笔记功能，不阻断任何既有能力 | 缝头改 FORK-NOTE；Step 19 核查 210 行段文案，note 句若受 flag 控制则关 flag，若硬引用则 host 装配处最小适配并在 FORK 注释登记差异 |
| N3 | dreamer 后台整理 | 上游 cron 型后台记忆整理；ZCode agent 进程无对应宿主（desktopCronScheduler 属 Electron main，不属 agent 进程） | 记忆质量由 selection 排序 + 读时强化维持；读写链完整；缺席不阻断 | 缝头改 FORK-NOTE |
| N4 | channel2-cycle + send-session-notification（通知/nudge 闭环） | 上游走 OpenCode RPC pushNotification；ZCode 等价缝 steerTurn 接入需干预 turn-loop，风险/收益失衡 | 「跳过折叠」等信息由日志 + 时间线 + `ZCODE_MAGIC_CONTEXT_DEBUG_WIRE=1` 覆盖；紧急拒绝路径保持 fail-visible throw（缝头注已确认此为正确语义） | 两缝头改 FORK-NOTE；`TransformDeps.hostRefusalNotice` 预留端口保持预留态并注释指向本裁定 |
| N5 | compaction-off-transition | fork 无 compaction 域（D-7 已删原生压缩，`compaction` 在 EXCLUDED_CONFIG_KEYS） | 语义域不存在，无使用者 | 删除缝文件，引用改指/清理 |
| N6 | hook-handlers | OpenCode plugin 事件面 type-only 摘录；ZCode 事件走 appendEvent/SessionEventType，宿主适配职责在 host/hooks.ts | 纯 type 缝，无运行时语义 | 删除缝文件；4 个进程本地 Map alias 内联 live-session-state.ts（缝头已建议） |

> 「不做」不是丢弃：每一项都有收口动作（FORK-NOTE 终局登记或删除），`docs/.iteration-state.yaml` 同步登记裁定，防止再次出现「静默缺席」。

### 方案分述

**缺陷①（settle）**：三个入口（protocol/TUI/print）显式透传「进程是否随轮退出」形态 → create-app → bootstrap 端口层把**两处 settle 都条件化**（长驻形态 fire-and-forget，靠调度器自行 publish + MF-05 优雅关闭 drain 兜底；短驻保留前台等待）。`hostProcessLifetime` 不动（理由见约束）。排队消息的 idle-only 提升随 turn 完成立即可获（不再被 settle 拖住的 drain/execution 存活期卡住）。core turn-loop 零改动。

**缺陷②（主会话切模型）**：两刀。a) UI 侧：composer 选模型时对已有会话立即下发 `switchModelConfig`（handler 已存在且支持运行中会话：model-config.ts:76-142，`app.setModel`+`emitModelSelected`），Session Selection 即时更新；b) promote 侧：**2026-10-11 裁定简化（出队模型，de96549d）——queue item 提升与编辑重发一律读会话当前活值 `getSessionModelSelection()`，废除 `lastModelSwitchAt > admittedAt` 时间戳判据与「编辑重发保旧快照」语义（显式 payload 仅会话无活值时兜底并 pin）**；execution-scope 豁免不动；写回会话态红线不动。 **OQ-1 口径补充（CR fix）：「模型选择变值」含 **reasoningLevel/thought 级变更**，与 `sameModelSelection` 的比较面一致**（core `runtime/methods/turn-model.ts` 的 `sameModelSelection` 比较 providerId + modelId + options.reasoningLevel；`setSessionModelSelection` 据此决定是否记 `lastModelSwitchAt`）——切 thought 等级于切模型。运行中的当前轮不中断换模（Model 是 turn 级单例，guide-drain 缝已有 step 边界换模能力，保留）。

**缺陷③（子智能体）**：`createDefaultSubagentPort` 的 `builtInModelSelectionOverrides` 从构造期冻结值改为 provider 回调（bootstrap 侧 `() => readAgentState()` + mtime 缓存），每次 spawn 解析 profile 时取新值——同会话立即生效（AgentRuntime spawn 是进程内构造）。

**缺陷④（记忆半边）**：按裁定表 D1-D14 落地。顺序：先记忆读写核心（storage 三件套 + promotion 写入链（D13）+ ctx_search/ctx_memory（D14）），再 prompt-surface 与 210 行段注入（依赖 ctxReduceCallable 真值与配置白名单），再 mural 承载（mediaBlocks+vision 源；storage-mural-cues 已随记忆核心提前落位），最后缝收口。

## 最终项目结构

```text
apps/zcode-cli/packages/magic-context/src/
  core/agents/magic-context-prompt.ts                  （新增=git mv 自 deferred/，210 行真身）
  core/features/magic-context/memory/
    storage-memory.ts / memory-selection.ts            （git mv 真身）
    embedding-failure.ts                               （git mv 真身，N1 例外归位）
    normalize-hash.ts / visibility.ts / embedding-cache.ts / storage-memory-embeddings.ts / storage-memory-fts.ts / promotion.ts（D13）（上游新移植非 rename，FORK-NOTE 头注明上游路径/行数；cosine-similarity 不搬=N1）
  core/features/magic-context/user-memory/storage-user-memory.ts （git mv 真身）
  core/features/magic-context/mural/
    render-trigger.ts（git mv 1 缝 rename）/ resolve-mural.ts / render-mural.ts / mural-selection.ts / storage-mural.ts / mural-font.generated.ts / storage-mural-cues.ts（后 6 件=上游新移植+FORK-NOTE；cues 随 Step 8 提前落位）
  core/shared/prompt-surface.ts / prompt-surface-runtime.ts / model-resolution.ts （git mv 真身/适配）
  core/hooks/magic-context/event-resolvers.ts          （git mv 真身）
  core/deferred/                                       （23 缝终局对账：11 缝移出真身= magic-context-prompt / storage-memory / memory-selection / storage-user-memory / render-trigger / prompt-surface / prompt-surface-runtime / model-resolution / embedding-failure / event-resolvers / ctx-reduce-availability；8 缝改 FORK-NOTE= N1 四缝（compartment-chunk-embedding/embed-session-state/auto-search-runner/embedding-status-tables）+ note-nudger + dreamer-task-registry + channel2-cycle + send-session-notification；2 缝删除（Step 17）= compaction-off-transition / hook-handlers；2 缝 Step 16 删除并改指 = magic-context-schema / project-security（magic-context-schema.ts:11 头注自陈「Step 16 删除」；project-security 头注无自陈但同批处置——显式动作见 Step 16：deriveDefaultProtectedTokens→**core/shared/protected-tokens.ts**（**CR fix 追加 A 勘误**：spec 原写 `host/config/schema.ts`，实际落点是 `core/shared/protected-tokens.ts`，fork 侧 buildTransformDeps 从该模块 import；方向勘误，FORK-NOTE 已登记）、ProtectedTokensTierOverrides 内联、3 处引用改指））
  index.ts                                             （barrel 扩记忆/检索公共面，注释块）
apps/zcode-cli/packages/contracts/src/
  config/index.ts                                      （E 组白名单扩 memory/prompt_surface/mural）
  tools/ctx-context.ts                                 （ctx_search 契约）
apps/zcode-cli/packages/core/src/
  context/sections/magic-context.ts                    （新增：## Magic Context 段注入桥）
  context/sections/memory.ts                           （互斥退场钩子）
  agent/message-history.ts                             （RuntimeAttachmentEntry 扩 mediaBlocks）
  runtime/methods/{turn,turn-model,config,subagent}.ts （缺陷②③改动点）
  tool/handlers/ctx-search.ts                          （新增：ctx_search handler）
  runtime/helpers/runtime-tools.ts                     （ctxReduceCallable 判定接线）
apps/zcode-cli/packages/bootstrap/src/
  app/magic-context-turn-transform.ts                  （两处 settle 条件化 + buildTransformDeps 接 memory/mural/promptSurface + mediaBlocks 提取）
  app/create-app.ts / subagents.ts                     （形态透传 + override provider 回调）
  zcode-protocol-entrypoint.ts                         （app-server 形态透传，sourceTitle 先例）
  zcode-protocol-v4/commands/handlers/model-config.ts  （lastModelSwitchAt 写点）
  zcode-protocol-v4/commands/{input-intent,handlers/queue}.ts（promote 活值规则）
apps/zcode-cli/packages/cli/src/
  tui-prompt-handler.ts / prompt-command.ts            （TUI=长驻 / print=短驻 形态透传）
  bootstrap/scripts/test-magic-context-turn-transform.mjs（:410-430 按形态分化）+ test-settle-background.mjs（新增）
packages/ui/src/
  v4/SessionPane.tsx                                   （选模型即发 switchModelConfig）
  settings/MagicContextSettingsSection.tsx             （已存在——扩字段：Fields/form，勿重建整文件）
packages/shared/src/model-config.ts                    （supportsImage 判定源复用）
docs/iterations/bugfix-batch-20261011/                 （本 spec；cache/ 证据包）
```

## 变更点清单

| # | 文件 | 改动 | 区域 |
|---|---|---|---|
| 1a | cli/src/{tui-prompt-handler.ts,prompt-command.ts} + bootstrap/src/zcode-protocol-entrypoint.ts + app/create-app.ts | 「进程是否随轮退出」形态显式透传（protocol/TUI=false，print=true），create-app :862-911 传入 | fork 层 |
| 1b | bootstrap/src/app/magic-context-turn-transform.ts | 两处 settle 条件化（:1264-1276 装配条件 + :1605-1609 条件 await）；hostProcessLifetime 保持不动（理由登记）；单测 :410-430 按形态分化 | fork 层 |
| 2a | packages/ui/src/v4/SessionPane.tsx | handleSelectModel 对已有会话追加 switchModelConfig 下发 | ui |
| 2b | core/runtime/methods/config.ts + model-config.ts | runtime 记录 lastModelSwitchAt（setModel/switchModelConfig 写点） | core |
| 2c | bootstrap/…/commands/input-intent.ts + handlers/queue.ts | promote 用活值 selection（**2026-10-11 裁定简化：出队模型——一律 `getSessionModelSelection()`，废除时间戳判据**）；编辑重发同语义（fork-edit-retry 活值优先）；execution-scope 语义不动 | fork 层 |
| 3a | core/src/runtime/methods/subagent.ts + subagent/runner.ts | overrides 改 provider 回调 + normalizeAgentProfiles 可失效重建（**MF-ML-5 勘误：spec 原 3a 清单含 `profile.ts`，实际交付不含**——per-spawn 活读已在 runner.ts resolveProfiles 达成（回调在每次 spawn 解析 profile 时取新值），profile.ts 无需改） | core |
| 3b | bootstrap/src/subagents.ts + create-app.ts | readAgentState 带 mtime 缓存的 provider 传入 | fork 层 |
| 4a | magic-context core（4 缝 git mv：storage-memory/memory-selection/storage-user-memory/embedding-failure；7 件新移植+FORK-NOTE：promotion（D13）/normalize-hash/visibility/embedding-cache/storage-memory-embeddings/storage-mural-cues/storage-memory-fts + compartment-runner-incremental 恢复写入调用） | 混合：rename（4 缝）+上游新移植（7 件）+引用改指 | core 区 |
| 4b | contracts tools/ctx-context.ts + core tool/handlers/{ctx-search.ts,ctx-memory.ts} + builtInTools + allowlist | ctx_search 检索 + ctx_memory 写入工具（D14） | contracts/core |
| 4c | magic-context shared/prompt-surface*.ts + host/config/schema.ts + contracts config + UI 设置面 | preset/guidance/tool_descriptions 配置面 | core 区/fork 层/ui |
| 4d | core/context/sections/magic-context.ts + context/builder.ts + sections/memory.ts + context/types.ts（ContextSource 联合扩 "magic_context"） | 210 行段注入 + 原生 Memory 段互斥 | core |
| 4e | magic-context mural 五件套 + core message-history.ts + bootstrap transform（mediaBlocks 提取）+ shared/model-config.ts（vision 源） | mural 全链 | core 区/core/fork 层/shared |
| 4f | magic-context event-resolvers.ts + ctx-reduce-availability 归位 + runtime-tools.ts | 做的缝收口 | core 区/core |
| 4g | deferred/ 4 缝改 FORK-NOTE + 2 缝删除（N1-N6 收口）+ docs/.iteration-state.yaml 登记 | 不做项终局登记 | core 区/docs |
| 5a | 根 package.json / magic-context package.json scripts | 新增测试挂载（test:v4-perf 清单等） | 新增 |

## 详细实现步骤

> 每步一个 commit（pathspec 提交）。

- Step 1 — phase-mc-settle-bg — blocking: yes — qa: auto：形态透传：`zcode-protocol-entrypoint.ts`（:186-218，`sourceTitle:"electron"` :215 先例）与 `cli/src/tui-prompt-handler.ts`（:141-160）传 `processExitsAfterTurn:false`；`cli/src/prompt-command.ts` 传 `true`；`create-app.ts`（:862-911）透传进 magic-context-turn-transform options。**第四通路补记（CR OQ-2）：`zcode-protocol-entrypoint.ts` v4 server 工厂对协议进程内 per-workspace app（`createWorkspaceZCodeApp` 通路）同样传 `false`（协议宿主长驻）——超出「三入口」字面但方向正确，登记为本批既成语义**。不改 core。
- Step 2 — phase-mc-settle-bg — blocking: yes — qa: auto：bootstrap 端口两处 settle 条件化：`settleScheduledPass` 装配条件（:1264-1276）扩「进程不随轮退出」；`settleInFlightHistorian`（:1605-1609）加同判据的条件 await（长驻=fire-and-forget+日志，保留超时保护防泄漏）。`hostProcessLifetime`（:1374）**保持硬编码**，FORK 注释登记「为何不动」（usage 清零回归/包内特权区两条理由）；:1431 附近「一进程=一轮」论证按形态改写；`in_flight` no-fire 预期行为与 MF-05 强杀边界注释登记。
- Step 3 — phase-mc-settle-bg — blocking: yes — qa: auto：测试：`test-magic-context-turn-transform.mjs:410-430` 顺序断言按形态分化（长驻=`[transform,notify]`；`:432-443` settle 抛错用例保留于 foreground 形态）；新增 `scripts/test-settle-background.mjs`：长驻形态断言 model step 不等两处 settle、turn 完成后 idle-only promotion lease 即可获取、close() drain 收口折叠落库。
- Step 4 — phase-model-live — blocking: yes — qa: auto：`packages/ui/src/v4/SessionPane.tsx` handleSelectModel：对已有 session 追加 `dispatchConfigCas("switchModelConfig", …)`（model-config.ts:76-142 已支持运行中会话，无 active-turn guard）；composer 草稿意图更新保留。**显式处置两处既有 submission-scoped 注释**（r1 P1-5）：改写 :2824-2825（「Composer 选择表达下一次提交」）与 :2757-2758（ensureDraftPrewarmConfigBeforeSend「不能在发送前通过 CAS 改写共享 Session」）为新语义——「选模型=对已有 session 的即时 session 语义；模型选择仍随首发原子提交兜底」；**仅对已有 session 下发**（草稿/预热 session 仍走首发 CAS 链，不破单写者纪律）；下发失败收口对齐既有 :2392-2400（noop/stale ack 不弹错误 toast）。
- Step 5 — phase-model-live — blocking: yes — qa: auto：**已被 2026-10-11 出队模型裁定改写并实装（de96549d，T-ML2b/T-ML3/T-E2E2 翻转）**：queue.ts `applyPromotedModelSelection` 去 gate——提升一律读会话活值，废除 `lastModelSwitchAt > admittedAt` 判据；fork-edit-retry `startCanonicalIntent` 同链（live ?? explicit ?? snapshot，pin 仅显式兜底成立）；写回会话态红线（不经 pin 泛化、不新增写回调用）与 execution-scope 语义不变。原稿的 `lastModelSwitchAt` 字段仍保留（`app.setModel`/`switchModelConfig` 变值时记录），但不再作 promote 判据。
- Step 6 — phase-model-live — blocking: yes — qa: auto：子智能体活值：`subagent.ts:73` overrides 改 provider 回调；`runner.ts`/`profile.ts` normalizeAgentProfiles 支持按 spawn 取新 override；bootstrap `subagents.ts` readAgentState 加 mtime 缓存 provider 传入 create-app。
- Step 7 — phase-model-live — blocking: no — qa: manual_user：桌面实机验收（合并后用户执行）：切模型→发送排队消息→提升轮用新模型；时间线 modelChange marker 按轮落（config 即时更新）确认观感可接受；排队阻塞缓解：busy 队列+折叠进行中，promote 延迟不含 settle 时长（时间线对比，覆盖 T-S3）。**实机验收清单升级（MF-ML-1，CR fix）：显式加入「切模型后 UI 无 toast 错误」+「提升轮模型变更时间线 marker」两条断言**——UI 层 `handleSelectModel → dispatchConfigCas("switchModelConfig")` 的渲染层下发整类在 CLI 侧无自动化直证（判定 b：登记收窄 + 实机升级，用户可否决改为 a 补 `packages/ui/test/sessionPaneSelectModelDispatch.test.ts` 挂根 test:v4-perf），CDP 锚点 `chat-model-select-trigger`/`v4-model-config` 已备于 cache/cdp-anchors.md；协议命令侧由 test-model-live.mjs + verify-e2e 覆盖。
- Step 8 — phase-mc-memory-core — blocking: yes — qa: auto：**既有 4 缝按三态处置（r4 口径，实装已按此完成）**：storage-memory/storage-user-memory=壳缝①git mv 保 rename 轨迹+内容整体替换为上游真身+FORK-NOTE；memory-selection/embedding-failure=全覆盖缝②直接 git mv；**其余 7 件为③新移植**（deferred 无缝）：`memory/promotion.ts`（D13，145 行）、`normalize-hash`、`visibility`、`embedding-cache`、`storage-memory-embeddings`（纯 sqlite，不违反依赖排除令）、`../mural/storage-mural-cues`（提前于 mural 波次）、`memory/storage-memory-fts.ts`（206 行，sanitizeFtsQuery/relaxedFtsQuery——ctx_search 的 FTS 查询消毒层，纯查询工具无向量依赖，r2 P1）——文件头 FORK-NOTE 注明上游路径/行数/差异；恢复 fork `compartment-runner-incremental.ts` 的 `promoteSessionFactsDurable` 调用（沿用 autoPromote 门）；`embedPromotedFacts`+`embedAndStoreMemory`（:100-144）删除后**同步清理 promotion.ts 头部 3 个失效 import**（embedTextForProject/sessionLog/saveEmbeddingIfHashMatches）并在 FORK-NOTE 登记（r2 P2；r4 曾质疑 embedAndStoreMemory 不存在——**已亲测存在于上游 promotion.ts:111-144，r3 口径正确**）；**cosine-similarity 不搬**（不在闭包内，属 N1）；引用改指：inject-compartments.ts、m0-token-breakdown.ts:1 等（纯 import 行）。
- Step 9 — phase-mc-memory-core — blocking: no — qa: auto（**已由 Step 8 提交吸收，r5 P0-2**）：memory-selection/storage-user-memory 两缝的 git mv+改指已随 `944b4967` 实盘落地（inject-compartments.ts 四处 `.sort()`、safeGetActiveUserMemories :2057-2064 已指真身）；本步仅保留 qa 核查：a10e74a1 的 test:all 全绿即覆盖，无独立实施动作。
- Step 10 — phase-mc-memory-core — blocking: yes — qa: auto：ctx_search 工具：contracts `tools/ctx-context.ts` 扩契约（关键词检索 storage-memory，FTS5）；core `tool/handlers/ctx-search.ts` 新增，**复用 Step 8 已移植的 `sanitizeFtsQuery`/`relaxedFtsQuery`（storage-memory-fts.ts），不自造查询消毒逻辑**；builtInTools + includeMagicContextTools 门 + allowlist；幂等 commandId。无向量依赖。**ctx_memory 工具（D14）同批**：写入面 `insertMemoryIdempotent`（storage-memory 真身已在 Step 8），契约/handler/allowlist 同款路径，无向量。
- Step 11 — phase-mc-memory-core — blocking: yes — qa: auto：配置白名单：E 组 schema（host/config/schema.ts）+ contracts config + adapters merge/patch + `adapters/src/config/file-config.adapter.ts` 的 `patchMagicContext`；UI 侧**扩字段而非新建**（r1 P1-4：`MagicContextSettingsSection.tsx` 已存在（Section 300 行 / Fields 271 行 / form 304 行，以改 Fields+form 为准），勿重建整文件）——改 `MagicContextSettingsFields.tsx` + `magicContextSettingsForm.ts`；字段：`memory.enabled`、`prompt_surface.{default,models,guidance_override_path,tool_descriptions}`、`mural.enabled`；i18n key 随行；默认值对齐上游（memory 默认 on）；遵守 RULE.md「设置页自动保存」链（updateMagicContextConfig→ConfigPort 写盘）。
- Step 12 — phase-mc-prompt-surface — blocking: yes — qa: auto：git mv `shared/prompt-surface.ts` + `prompt-surface-runtime.ts`（**两者均壳缝①：内容整体替换为上游真身 162/283 行+FORK-NOTE**；ZCode 适配：jsonc-parser 不引入，guidance 文件按 JSON 解析或宽松 JSONC 自实现；**`tools/light-descriptions.ts` ③随行新移植**——上游 runtime :4-14 import 的 5 常量，ctx_reduce/ctx_expand/ctx_search/**ctx_memory** 四条工具描述随行，ctx_note 不搬（N2）并在 FORK 注释登记；壳中同名 type 由真身覆盖、壳删除）；**D1 壳缝①（r5 P0-1）：git mv `deferred/magic-context-prompt.ts` → `core/agents/magic-context-prompt.ts` + 内容整体替换为上游 210 行真身 + FORK-NOTE；`inject-compartments.ts:2`（MEMORY_MURAL_BLOCK）改指 `../../agents/magic-context-prompt.js`**；**D7 全覆盖缝②（r5 P1-2）：git mv `deferred/model-resolution.ts` → `core/shared/model-resolution.ts` + 4 处 import 改指（transform.ts:68、transform-compartment-phase.ts:9、compartment-runner-historian.ts:60、compartment-runner-types.ts:33）**；transform.ts:70-71 引用改指（prompt-surface 对）；`promptSurfaceConfigIdentity` 接 buildTransformDeps。
- Step 13 — phase-mc-prompt-surface — blocking: yes — qa: auto：210 行段注入：**承接 Step 12 已落地的 D1 壳缝①（`core/agents/magic-context-prompt.ts` 上游 210 行真身，`buildMagicContextSection`/`SELF_TAG_GUIDANCE` 已归位）**；`core/src/context/sections/magic-context.ts` 新增（ContextSection source:"magic_context"、injectionTarget:"system"；`core/src/context/types.ts:30-49` ContextSource 联合扩 "magic_context"）；`context/builder.ts` 装配（customSections 位）；`buildMagicContextSection` **11 参** ZCode 数据源装配（ctxReduceCallable←Step 16；memoryEnabled/muralEnabled←Step 11 配置；language←现有 prompt-language-option；dreamer/caveman/temporal=关臂并注释指向 N2/N3 裁定）；memoryEnabled=true 时段文本含 MEMORY_GUIDANCE（ctx_memory 硬引用→D14 已注册）与 CTX_NOTE_GUIDANCE（full preset 无条件拼接；ctx_note→N2，适配见 Step 18）；bootstrap `buildTransformDeps`（:1351-1413）补 promptSurface/memory/mural 字段。
- Step 14 — phase-mc-prompt-surface — blocking: yes — qa: auto：**设置面消费**：`prompt_surface.default` / `models` 接上工具注册链——core `RegisterBuiltInToolsOptions` 增 `magicContextToolDescription` 求值器与 `magicContextModelKey`，`resolveBuiltInToolEntryForBranch` 只对四个 ctx_* 工具换 `metadata.description`（参数 schema/权限/预算/超时不动；没有 description 的工具不参与分档）；bootstrap `createMagicContextToolDescriptionResolver` 现读配置域，首次装配与 embedded-search 分支刷新共用同一推导入口；UI 侧 `promptSurfaceOverrides` per-model 覆盖只读呈现（刻意无编辑入口，同 execute_threshold per-model 先例）。**D11 互斥（原生 `# Memory` 段退场）已随 Step 13 提交 `09b52efe` 落地，不占本步**。**commit 映射 K-note（CR fix 追加 B①）**：Step 13/14 两行的实际 commit 承载为——`09b52efe`（题注 Step 13）= 210 行段注入（D1 宿主侧）+ 原生 # Memory 段互斥；`e81dc870`（题注 Step 14）= 设置面消费（preset 分档工具描述 + per-model 覆盖只读呈现）。步骤表早前版本把互斥写在 Step 14、且无「设置面消费」行，本 spec 按此对齐。
- Step 15 — phase-mc-prompt-surface — blocking: yes — qa: manual_user：mural 承载：**render-trigger=壳缝① git mv+内容替换为上游 240 行真身（ensureMuralRendered/modelKeyAcceptsImages 等归位）+FORK-NOTE；resolve-mural / render-mural / mural-selection / storage-mural / mural-font.generated.ts（157 行字体位图）5 件=③新移植+FORK-NOTE**；**mural/ 另 3 件 compress-cues 系不搬（依赖 dreamer=N3，FORK 登记）**；storage-mural-cues 已随 Step 8 提前落 mural/ 目录；**引用改指：inject-compartments.ts 由 `../../deferred/render-trigger.js` 改指 `../../features/magic-context/mural/*`（r5 P2-5 勘误相对路径；纯 import 行 1:1）**；闭包补齐 `memory/index.ts` barrel（按 fork 实际导出裁剪，**禁 re-export N1 的 embedding 面**，FORK 注释登记与上游 barrel 差异并覆盖 mural 导出面）；`mural-selection.ts:1` 对 `../../hooks/magic-context/inject-compartments` 的上游既有循环 import 逐字保留并以 FORK-NOTE 登记理由；vision 判定改 `ModelInputFormatData.supportsImage`（shared/model-config.ts:51-59，绕开 models-dev-cache apiCache 零调用者断链，FORK 注释登记）；`RuntimeAttachmentEntry` 扩 `mediaBlocks?: ModelMessageContentBlock[]`；bootstrap `magicContextAttachment`/`contentBlocksOf` 提取 image part；provider 投影透传；实机验收 vision 模型收到 mural PNG。
- Step 16 — phase-mc-hook-closure — blocking: yes — qa: auto：ctx-reduce-availability 等价判定：**壳②保留**，`spawnAgentFromMessages` 壳内逐字；`ctxReduceCallable` 判定接 ZCode 面（runtime-tools.ts 结构禁用 `resolveRuntimeDisallowedToolsWithMagicContext` + 工具注册表），删 THROW 臂（`PluginContext["client"]` 缺失桩；**替代契约=r5 P2-6：`resolveToolPermissionDenied`/`todowritePermissionDenied` 改 `return false`=未拒绝，与调用点 fail-open 现状对齐——transform-postprocess-phase.ts:344-349/:2048-2062 已 try/catch，勿改变「保留旧裁决」语义**）；event-resolvers **壳②保留不搬真身**，落位 `core/hooks/magic-context/event-resolvers.ts`，**barrel 改指**：`index.ts:164-165`（export 块）与 `index.ts:301`（resolveModelKey）由 `./core/deferred/event-resolvers.js` 改指壳的新落位；**import 改指显式清单（r5 P2-3）**：event-resolvers 3 处（transform.ts:96-103、scheduler.ts:19、lkg-replay-fit.ts:3）+ ctx-reduce-availability 2 处（transform.ts:79-86、transform-postprocess-phase.ts:89-99——r5 P2-1 勘误：:92/99 属 ctx 面非 event-resolvers 面）；ctx-reduce-availability 壳②保留、落位 `core/hooks/magic-context/ctx-reduce-availability.ts`；embedding-failure 全覆盖缝②直接 git mv（如未随 Step 8 落地）；format-embed-{failure,status} 引用改指；**user-facing-codes.ts：已由 Step 8（944b4967）闭合（r5 P1-1）——注释已更新，EmbeddingFailureClass 本地副本按 FORK-NOTE 决议刻意保留（core/shared 不得反向 import core/features，仓内零先例），本步无动作**；**magic-context-schema/project-security 两壳删除并改指（r4 P0-2，拍板=按壳头注计划落实）**：`deriveDefaultProtectedTokens` 搬入 **`core/shared/protected-tokens.ts`**（**CR fix 追加 A 勘误**：spec 原写 `host/config/schema.ts`，实际落点是 `core/shared/protected-tokens.ts`，fork 侧 buildTransformDeps 从该模块 import；方向勘误，FORK-NOTE 已登记）、`ProtectedTokensTierOverrides` 内联两使用处（`storage-meta-persisted.ts:13`、`transform.ts:1`）、删 2 壳、3 处引用改指（`storage-meta-persisted.ts:11` 含）。
- Step 17 — phase-mc-hook-closure — blocking: yes — qa: auto：不做项收口：N1-N4 缝头改 `FORK-NOTE`（终局不做+裁定表理由+不影响使用论证；embedding 缝清单=compartment-chunk-embedding/embed-session-state/auto-search-runner/embedding-status-tables）；N5/N6 删除缝文件（compaction-off-transition.ts、hook-handlers.ts），**删除范围=compaction 模式段整体退场（r2 P1，非仅 import）**：`transform.ts:573`（`Parameters<typeof reconcileCompactionMode>` 类型引用）、`:867-945`（reconcileCompactionMode 调用块+transition 效果处理+sendStatusNotification notice 投递+commitCompactionModeRecord :932+failPass :944）、`:953`（`!compactionOff` 条件）、`:76` import（compaction 仅此一处——**勘误 r5 P2-4：`:109` 是 `LiveModelBySession` 的 hook-handlers import，属 N6，不属 compaction**；N6 删除 hook-handlers.ts 时 `:109` 改指 `./live-session-state.js`（alias 落位后），随 N6 清单执行）、`live-session-state.ts:9`、barrel `src/index.ts:166` 对外导出（随删；如需公共面按 barrel 注释块规矩重开）、deps.compactionOff 上游 plumbing；**既有事实：host/config/schema.ts:249 `EXCLUDED_CONFIG_KEYS=["compaction"]` 下 compactionOff 恒假——删除不改变任何运行时行为**；**flag 本体保留（恒假、gate 为死代码无害）——仅删 transition 段，禁止顺手清理包内其余 `!compactionOff` 条件引用（总量约 80 处、计数随分支漂移，以本步显式删除清单为准）**；4 个 alias 内联 live-session-state.ts；`docs/.iteration-state.yaml` 登记 `bugfix-batch-20261011` 节（裁定表摘录）。
- Step 18 — phase-mc-hook-closure — blocking: yes — qa: auto：210 行段工具引用一致性核查（r1 P0-2 口径）：**从段文本正则提取工具名集合**，断言 ⊆ {ctx_reduce, ctx_expand, ctx_search, ctx_memory} ∪ 登记豁免集（豁免必须带 FORK 登记与适配口径，如 ctx_note）；ctx_note 句处置：有 flag 控制则关 flag，无 flag 则 host 装配处最小适配（适配函数落宿主层，**不改动包内逐字常量**）+FORK 注释登记差异；断言测试固化。
- Step 19 — phase-gates — blocking: yes — qa: auto：全门禁：根 typecheck/lint（71w/0e 基线）/knip（stash 对比零新增+零 magic-context 命中）/architecture:check --changed/oxfmt（根+apps/zcode-cli）/desktop 差分/magic-context `build+test:all`/`test:v4-perf`（新 ui 测试进根 package.json:32）。**MF-ML-4 登记（CR fix）：test:v4-perf 聚合链已含 bootstrap `test:model-live` / `test:subagent-live-model` / `test:prompt-surface-toolset-hash`（MF-PS-1）三个 script 入口；core `test:promotion-lease`（MF-1 a-lease）按逐脚本约定挂载，不进根链。

## 测试策略

- magic-context 包：新增/更新 `scripts/test-*.mjs` 进 `test:all`（真身替换后 38 cases 基线只增不减）；隔离：显式 `MAGIC_CONTEXT_DB_DIR`/`MAGIC_CONTEXT_LOG_PATH` 临时目录。
- bootstrap：`node --test scripts/test-*.mjs` 新增 `test-settle-background.mjs`、`test-model-live.mjs`（promote 活值+编辑重发回归+execution-scope 豁免）、`test-subagent-live-model.mjs`（同会话改 override 生效；**MF-ML-5 勘误：spec 原写 `test-subagent-override-live.mjs` 为误引，实际交付文件名是 `test-subagent-live-model.mjs`**）。前两者与 subagent 测试已统一挂载进根 `test:v4-perf`（MF-ML-4：bootstrap 侧 `test:model-live` / `test:subagent-live-model` 两个 script 进根聚合链，此前 subagent 测试零门禁入口）；`test-prompt-surface-toolset-hash.mjs`（MF-PS-1 getToolSetHash 活读）同链路挂载。
- core：`tsx --test` ctx_search handler、sections/magic-context 注入与互斥、ctxReduceCallable 判定；`test:promotion-lease`（MF-1 a-lease：`acquireForegroundPromotionLease` idle-only 五条件门）按逐脚本约定挂载。
- ui：`test:v4-perf` 清单补 SessionPane 切模型下发断言——**MF-ML-1 登记收窄**：该 UI 层断言未以自动化落地，改由 Step 7 桌面实机直证（`handleSelectModel → dispatchConfigCas("switchModelConfig")` 渲染层下发；CDP 锚点 `chat-model-select-trigger`/`v4-model-config` 见 cache/cdp-anchors.md；切模型→排队提升用新模型列为必测项，清单另加「UI 无 toast 错误 + 提升轮模型变更时间线 marker」两断言）；协议命令侧由 test-model-live.mjs + verify-e2e 覆盖。备选 a（用户否决登记时启用）：补 `packages/ui/test/sessionPaneSelectModelDispatch.test.ts`（mock store/rpc：sessionId≠null 经 barrier enqueue switchModelConfig、null 不下发、CAS reject 只 warn 不弹 toast）挂根 test:v4-perf。
- 桌面实机（qa: manual_user）：Step 3/7/15 三项录屏验收（CDP 通道按 RULE.md「桌面 UI 实机验证方法」重建模板，`.cu-shots/` untracked）。
- 全部命令实跑并贴结果进 cache/ 证据包。

### 测试用例

- T-S1 — blocking: yes — 长驻形态每个 model step 前不等两处 settle；turn 完成后 idle-only promotion lease 即可获取（Step 1/2/3）。**后半「lease 即可获取」的机制直证（MF-1 a-lease，fix 节点）**：core 五条件门单测 `apps/zcode-cli/packages/core/scripts/test-promotion-lease.mjs`（挂 core `test:promotion-lease`，`tsx --test`）——`acquireForegroundPromotionLease` 的 idle-only 门五条件（activeForegroundExecution / runtimeCommandDrainActive / hasPending() / activeTurn / activeTurnStartReservation）逐一 occupied→`busy`、全空→`acquired`、执行期同 leaseId 幂等/异 leaseId `conflict` 不覆盖；此前全仓零直证，settle 后台化（Step 1/2）不改门本身，本测钉死「排队不被 settle 卡」的落点。
- T-S2 — blocking: yes — 长驻形态 close() drain 收口、折叠落库；foreground 形态顺序断言仍为 [transform,notify,settle:start,settle:end]（Step 2/3）。**覆盖映射（MF-1 b-落库登记收窄，fix 节点）**：「折叠落库」不在 `test-settle-background.mjs` 重复断言临时库折叠行——由既有 historian 测试覆盖：magic-context `scripts/test-historian.mjs`（18 项）+ bootstrap `scripts/test-magic-context-historian.mjs`（historian 分舱 promote 落库链）+ 本波 MF-05 close drain 契约用例（真实 `createHistorianScheduler`，drain 等在飞 pass 落定再 shutdown）+ T-S3 实机。close drain 契约本身（真工厂 registerClose 恰好 1 次、drain 落定）仍由 test-settle-background.mjs 直证。
- T-S3 — blocking: no — 排队 promote 延迟不含 settle 时长（Step 7，实机）
- T-ML1 — blocking: yes — 切模型后下一个新提交轮用新模型（Step 4）
- T-ML2 — blocking: yes — 入队后切换→提升轮用新模型；入队后未切换→也用会话活值（**出队模型裁定改写**，T-ML2b 翻转直证）（Step 5）
- T-ML3 — blocking: yes — 编辑重发用会话活值且不写回会话态（**出队模型裁定改写**：废除「保旧快照」；写回红线仍钉死——不写回/不置 pin/不广播）（Step 5）
- T-ML4 — blocking: yes — execution-scope 轮豁免切模（Step 5）
- T-ML5 — blocking: yes — 同会话改子智能体 override，下一次 spawn 生效（Step 6）
- T-MC0 — blocking: yes — historian 分舱边界事务后 memories 表有行、m0 注入可见（D13 promotion 生效）（Step 8/13）
- T-MC0b — blocking: yes — Issue #44 双门：memoryEnabled=false 或 autoPromote=false 时同一条 publish 路径照常落 compartments 但不写 memories（MF-MC-1 补右臂直证：T-MC0b2；落位 magic-context/scripts/test-memory-promotion.mjs）
- T-MC0c — blocking: yes — unanchored promotion skip 可观测：discard-last 场景 sessionLog 记 reason=discarded_last + facts 计数（MF-MC-2，compartment-runner-incremental.ts skip 处日志）
- T-MC1 — blocking: yes — 记忆写入后 m0/m1 注入含记忆内容；selection 排序生效（Step 8/9）
- T-MC2 — blocking: yes — ctx_search 关键词命中并返回记忆条目；无向量路径（Step 10）
- T-MC3 — blocking: yes — prompt_surface light preset 换挡 + guidance 覆盖读取（Step 12）
- T-P1 — blocking: yes — `## Magic Context` 段注入 system prompt；magicContext.enabled 时原生 # Memory 段退场（Step 13；D11 互斥随 `09b52efe` 落地，见 Step 14 K-note）
- T-P2 — blocking: yes — 段内工具引用 ⊆ 已注册 ∪ 豁免登记（Step 18）
- T-MU1 — blocking: yes — supportsImage 判定真值（vision 模型 true）（Step 15）
- T-MU2 — blocking: no — vision 模型 wire 收到 mural PNG part（Step 15，实机）
- T-X1 — blocking: yes — 全门禁跑一遍（Step 19）

## 风险与回滚方案

| 风险 | 缓解 | 回滚 |
|---|---|---|
| settle 后台化后折叠结果丢失 | 调度器契约自陈 fire-and-forget 自行 publish；MF-05 优雅关闭 drain 兜底；强杀边界=与 CLI 同损（既有风险，非新增，spec 登记） | revert 1a/1b，回前台 settle |
| promote 活值规则复活 v1.0.4「编辑重发还原切换」 | T-ML3 回归钉死（活值+不写回/不 pin/不广播三连）；出队模型裁定下一律活值、无时间戳判据，不重定义 pin | revert 2b/2c |
| 子智能体 per-spawn 读文件的同步 IO 开销 | agents-state.json <2KB + mtime 缓存 | revert 3a/3b |
| storage-memory 真身与 fork 行为分歧（上游演进漂移） | git mv rename 逐行对照 + 38 cases 基线 | revert 4a 单 commit |
| mediaBlocks 扩字段破坏投影/持久化兼容 | attachment 无该字段时行为不变（可选字段）；投影层透传未知块已有先例（contentBlocksOf） | revert 4e |
| 210 行段与 ZCode 原生指令冲突 | 互斥裁定（Step 14）+ T-P1 | revert 4d/4e 单 commit |
| SEA/打包受影响 | 本批不新增任何依赖（embedding 不做=不引 onnx/transformers）；oxfmt/knip 门禁兜底 | — |
| 不做项被误当「二期」 | FORK-NOTE 终局措辞 + .iteration-state.yaml 登记 + 本 spec 裁定表 | — |

## Context Bundle

```yaml
iteration_name: bugfix-batch-20261011
requirement_path: 用户口述（对话内报障，无 prd.md；标准原文见「需求来源」第 6 条）
spec_path: docs/iterations/bugfix-batch-20261011/spec.md
explore_summary:
  轮次: 1（并行 4 子代理 + 主代理手工探索 settle 节）
  子代理:
    - 模型选择实时性链路（A/B 双链路+进程拓扑+回归红线）✅
    - Batch2 记忆面移植（上游真身清单/注入缝/SEA/白名单/逐缝判断）✅
    - spec 模式与门禁约束（格式/测试基建/门禁基线/FORK 先例）✅
    - settle 与排队链路（三形态判定/两处 settle 独立条件化/per-step 语义/hostProcessLifetime 不动/idle-only 硬耦合）✅
  手工探索: settle 装配点/hostProcessLifetime/桌面进程生命周期/MF-05 兜底
  证据包: docs/iterations/bugfix-batch-20261011/cache/（实现时逐 Step 落）
impact_files:
  - apps/zcode-cli/packages/magic-context/src/core/**（真身 git mv + 引用改指 + FORK-NOTE）
  - apps/zcode-cli/packages/contracts/src/{config/index.ts,tools/ctx-context.ts}
  - apps/zcode-cli/packages/core/src/{context/**,runtime/methods/**,tool/handlers/**,agent/message-history.ts}
  - apps/zcode-cli/packages/bootstrap/src/{app/**,subagents.ts,zcode-protocol-v4/commands/**}
  - packages/ui/src/{v4/SessionPane.tsx,settings/MagicContextSettingsSection.tsx}
  - packages/shared/src/model-config.ts
  - 根 package.json / magic-context package.json（测试挂载）
  - docs/.iteration-state.yaml（裁定登记）（修改）
constraints:
  - FORK 纪律：git mv rename + 纯 import 改指 + FORK-NOTE 终局登记；barrel 扩面带注释块
  - v1.0.4 回归红线（2026-10-11 用户裁定改写）：「出队模型」统一规则——queue 提升与编辑重发在 admission 时一律读会话当前活值（`getSessionModelSelection()`，废除「编辑重发保旧快照」与 `lastModelSwitchAt > admittedAt` 时间戳判据，`lastModelSwitchAt` 字段保留供 T-ML1 语义/诊断）；**写回会话态仍禁止**（唯一写入口仍是 switchModelConfig/首发原子链）；execution-scope 豁免不可破坏
  - 不新增任何运行时依赖（embedding 终局不做；render-mural 纯 zlib）
  - 互斥裁定：magicContext.enabled 时原生 # Memory 段退场
  - 测试隔离：MAGIC_CONTEXT_DB_DIR/LOG_PATH/ZCODE_STORAGE_DIR 临时目录
  - 门禁清单见「现状约束」；lint 真基线 71w/0e；desktop 差分不写死数字
blocking_steps: [1,2,3,4,5,6,8,10,11,12,13,14,15,16,17,18,19]  # 9 已由 Step 8 提交吸收（r5），非独立 blocking
```

> **提交数口径（review-full 勘误 2026-10-11）**：本批实际 33 提交 = dev 21 + verify-e2e 2 + 纪律修正 1 + fix 节点 8 + oxfmt 门禁归一 1 + review-full P1 收尾 1；spec 早期叙述的「28」为计划口径。另：FORK-NOTE 头内行数（211/163/284）与勘误口径（210/162/283）差 1 属 wc -l 与 split 尾行计法差，以本表勘误口径为准，不再改逐字区文件。

## 追加裁定（review-full 之后、1.0.6 发布前，用户直接拍板）

| # | 裁定 | 实装 | 红线/边界 |
|---|---|---|---|
| A1 | **出队模型简化**：queue 提升与编辑重发一律读会话当前活值（见 :273 改写） | `de96549d`（T-ML2b/T-ML3/T-E2E2 翻转；B 组五例重写见 CR P1-1 修复） | 写回会话态红线 + execution-scope 豁免不变 |
| A2 | **移除双用途安全提示词段**（「IMPORTANT: Assist with authorized…」整段，zh/en 两份文案、交互式身份与工作流子代理身份注入点） | `2a52c7a9` | 语言测试断言翻转（zh/en 双侧缺席断言，CR P2-5 补英文侧） |
| A3 | **magic-context 系统段中英双语**：按运行时 language 切换，与其他段同机制 | `29f84e39`（fork 侧 zh 孪生逐分支镜像；包内英文逐字零改动；`isChinesePromptLanguage` 选路；ctx_note 以降级语义直接撰写；16 例矩阵 + resolver 选路字节级 golden 测试挂双门禁） | 协议记号（§N§/ctx_*/标记/标题）任何语言保持原字节 |
| A4 | **首发消息卡顿优化**：tokenizer（claude 2.3MB CJS，~850ms 首编译）与 git 身份解析预热搬进 app 启动窗口 | `97aa3243`（barrel 出 `preloadTokenizer`；setImmediate 预热；实测首轮 pass 1401ms→57ms） | 未预热成功时按既有懒加载语义回退，行为零变化；诊断脚本 `diag-first-send-latency.mjs` 随行 |

