# Changelog

## [1.0.5](https://github.com/bloodycrownD/oh-my-zcode/compare/v1.0.4...v1.0.5) (2026-10-10)

### Features

* **desktop:** Windows 打包补 zip 便携版产物——win target 加 zip，与 mac dmg+zip 双产物对齐（Release 上传 glob 已覆盖 *.zip） ([c27f44d](https://github.com/bloodycrownD/oh-my-zcode/commit/c27f44d630a5e6448b47719070286c2a3e928777))

* **magic-context:** 折叠模型默认继承会话模型（historian.model 三态） ([33a4d57](https://github.com/bloodycrownD/oh-my-zcode/commit/33a4d572a19abd6a2a4d238404be7c0a9fecab4b))
  * 字段缺失 / "inherit"（新 sentinel）：折叠模型 = 会话 live 绑定模型
  * "provider/model"：显式旁路模型（现状不变，装配期静态解析）
  * ""（显式清空）：关闭分舱折叠（现状「留空」语义收窄为显式关闭）
  * 装配门改为「配置值 !== ""」即装 executor：inherit 无条件装（会话模型要等
  * inherit：historian 模型 key 由 noteLiveModel 与主模型窗口同步刷新
  * 「inherit」只是配置面哨兵：runPass 的 model 与 TransformDeps 的
  * historianMaxOutputTokens 改为活值 getter：返回快照会让 live 夹紧对宿主
  * turn-transform 的 bindLiveModel 在 inherit 模式原地改写 deps.historianModel
  * historian.model 放行空串哨兵：z.union([z.literal(""), z.string().trim().min(1)])。
  * 随「缺省即继承」一并失效的是「enabled 但未配 historian 模型」这条 readiness
  * 配置链：adapters 的 magicContext 域直接复用包内 MagicContextConfigSchema，
  * 新增「继承会话模型（默认）」项（persist "inherit"）
  * 「不配置（留空）」改为「关闭分舱折叠」（persist ""，语义不变）
  * form 读侧：缺省/undefined 显示为 inherit，"" 原样（不再塌成 fallback）
  * form 写侧：空串照字面写进域（删键 = 缺失 = 继承，与显式选择相反）；
  * missingHint 改为说明默认继承、关闭需显式选择；zh-CN / en-US 同步
  * bootstrap historian：缺省=inherit 装载 + live 绑定后模型入口切换 + 惰性夹紧
  * 绑不到 Model 退回保守回退 + ""/显式回归，共 11 项
  * 包 test-config：historian.model 三态 schema 用例替换 readiness 用例
  * UI form/picker：读侧三态、零改动保存逐字节相同、off⇄显式⇄inherit 往返、
  * 回归全绿：magic-context config/host/transform/historian、bootstrap

## [1.0.4](https://github.com/bloodycrownD/oh-my-zcode/compare/v1.0.3...v1.0.4) (2026-10-10)

### Features

* **subagent:** 同步派遣返回 childSessionId + 前台子智能体可手动停止 ([8a0909b](https://github.com/bloodycrownD/oh-my-zcode/commit/8a0909b60de51587fe2ad79065e6176b77a8d18c))
  * ④ Agent/Task 同步派遣（AgentCompletedOutput 接口+zod .strict()+JSON schema
  * ③ 前台子代理 run() catch 补 isTerminalRuntimeTask 早退：stopTask 置的
  * ③ 状态面板 controlWorkId 回退：后台 work 条目未命中时用 subagent.agentId
  * 测试：test-subagent-sync-dispatch.mjs 5 例（T-D1×3/T-S1×2，真实 port +

* **ui:** ⑥ 清理展示链 UI 收口——cleanScope 透传 + 三门控统一谓词 + toolOutputs 文案收敛「仅 cli/exec」（uix/G-1） ([d195c57](https://github.com/bloodycrownD/oh-my-zcode/commit/d195c57ddd0f8b444c969c0be341b5e80a406a47))
  * 新增零 @/ 依赖纯 model storageCategoryModel.ts（isStorageCategoryCleanable 门控谓词 + sumCategoriesAcrossRoots 跨根合并透传 cleanScope，取任一非空），storageCategoryPresentation 改再导出，消费方 import 面不变

* **ui:** 子智能体目录页支持手动停止（3c） ([e86f020](https://github.com/bloodycrownD/oh-my-zcode/commit/e86f020070b8f681ac88c2db11e97dae2f0c2979))
  * SubagentDirectorySidePane：running 行加「停止」按钮（复用既有 i18n key
  * AnimatedSidePanePanel/WorkspaceShellLayout 透传 canCancelBackgroundWork，
  * 纯判据模块 subagentDirectoryCancel.ts + 5 例测试（T-S3）；A4（子会话


### Bug Fixes

* **adapters:** ⑥ 截断三修——自然退出兜底截断 + 预算扣 marker + 等待上界/逃逸信号（uix/B-1+B-2+C-1/N-1） ([1bb5e9e](https://github.com/bloodycrownD/oh-my-zcode/commit/1bb5e9ed87235855fa243efff4ae1900058b23ed))
  * uix/B-1：截断触发从「仅 kill/竞态标志」改为收尾状态判定——子进程自然退出、
  * N-1：截断实际生效时结果面附「output file truncated (head/tail kept)」——
  * uix/B-2：截断窗口预算先扣 BASH_OUTPUT_TRUNCATE_MARKER_MAX_BYTES
  * uix/C-1：BASH_OUTPUT_TRUNCATE_WAIT_MS 5s→7s（严格大于 FORCE_EXIT_AFTER_KILL_MS，
  * uix/G-3a/d：truncateBashOutputAfterKill 直测 4 例（settled 截断/未 settle 跳过/

* **agent:** 编辑重发 rewind 后快照崩溃——session-mapper 过滤 rehydrate 遗留的空 part ([5a35027](https://github.com/bloodycrownD/oh-my-zcode/commit/5a35027bceb073b6f036296fac22f8593ecb282c))
  * session-mapper 快照映射处过滤 undefined/null part（一行防御），编辑重发
  * undefined part 的上游来源（rewind rehydrate）另行追踪，不在本提交展开。

* **agent:** 编辑重发模型侧——editUserQuery 显式模型覆盖 + modelSelectionPinned 承载 + 写回收敛 ([e9f3ca9](https://github.com/bloodycrownD/oh-my-zcode/commit/e9f3ca9930d2c4ace9c688611b25639139649893))
  * editUserQuery 协议补 modelSelection（可选）；UI handleEdit 与普通发送同源取当前
  * 契约 TurnInputIntentMetadata 增 modelSelectionPinned：「显式携带=置 pin」全集
  * turn-model 写回收敛：仅 pinned 时执行 set+persist+emit 三连；fork-edit-retry
  * T-E1：test-edit-retry-model.mjs 12 用例（zod/编辑/retry/写回/三路径闭环）。

* **agent:** 编辑重发文本侧——v4/model-only turn 抢占判据对齐，修复「编辑后发送仍是旧消息」 ([2dcb38c](https://github.com/bloodycrownD/oh-my-zcode/commit/2dcb38cbf0095d787b35aad7eb0910d9d35b1b6d))
  * session-flow.ts 新增 hasActiveTurn（与 waitForSessionIdle 同源判据：
  * fork-edit-retry.ts 抢占门改用 hasActiveTurn；
  * T-E2 常驻 test-edit-retry.mjs 4 例（model-only 抢占生效/legacy 不回退/
  * 候选(a)编辑器提交值回退经 chatPromptEditorSubmitValue.test.ts 6 例验证

* **agent:** 默认模型配置同进程实时生效（1f）+ exec 上限 debug 落点接线 ([3aadf24](https://github.com/bloodycrownD/oh-my-zcode/commit/3aadf241efef6df7c07ef562a3c770752530442f))
  * process-provider-registry-runtime：首读后维护同步缓存（repository 只有
  * 消费面 8 点转活读（round-2 审查清单全量）：create-app 两处闭包/静态拷贝、
  * 运行中会话粘住自己的选择（有意设计）未动——只改「解析时读哪一份默认」。
  * T-E3 test-default-model-live 8 例（含变异验证：改回静态快照 5/8 红，
  * 顺带 D4：create-app 装配 adapter 处接入 onDebug → logger.debug

* **agent:** 未知 part type 上游根治（R-3）+ 丢弃观测（B-1） ([dbb63a8](https://github.com/bloodycrownD/oh-my-zcode/commit/dbb63a8adcfbca234ff797abf9c42fadd2062548))
  * message-mapper mapMessagePart switch 补 default：未知/缺 type 一律返回 null 由调用侧过滤（原无 default 隐式返回 undefined 混入 parts 数组，是编辑重发快照 TypeError 的真源头）。根因核验结论：rewind 投影只整条丢弃消息、不合成 part，session-mapper 旧注释『rewind rehydrate 遗留物』归因不成立（raw parts 含 undefined 时崩点应在 mapMessageWithParts 的 filter 而非 hydrate）；可达来源为 decodeStoredPart 残缺行缺 type 与前向兼容新 type——『编辑重发不再产生丢弃 warn』理想态可达，不降级为登记项。
  * session-mapper 过滤时统计丢弃数（未知 type + legacy undefined/null 兜底），buildSessionSnapshot 加可选 logger 参数，唯一调用点 server-operations.ts:3411 传 context.logger；warn 含 messageId/dropped/partTypes。
  * 新增 scripts/test-session-mapper-parts.mjs：R-3 表驱动（未知 type→不产生 undefined）+ B-1 快照用例（无 undefined 且 warn 发射）/ B-1b（无丢弃不 warn），并挂 package.json test:session-mapper-parts 脚本。
  * 回归：edit-retry-model 16/16、mapper-parts 3/3、edit-retry 4/4、turn-directory 15/15 全绿。

* **exec:** 失控命令输出三道护栏——上限 256MiB/env 可配/杀后头尾截断/cli-exec 可清理 ([165045d](https://github.com/bloodycrownD/oh-my-zcode/commit/165045d550abe9948b1a917eba9de854787e09a1))
  * 上限 5GiB→256MiB，env ZCODE_EXEC_OUTPUT_LIMIT_BYTES 可覆盖（1MiB..1GiB，
  * 杀进程后物理截断（新 helper，不复用仅头部 truncate 的既有函数）：保留
  * cli/exec 以 per-path 覆盖纳入可清理（不动 shared 类别面/ui/i18n），
  * T-C1 14 例（env 解析/优先级链/防硬填回潮网/真实 spawn 端到端截断）+

* **magic-context:** transform_absent 可观测性 + boot busy 有界重试 + 假 0% 修正 ([4e7f7d8](https://github.com/bloodycrownD/oh-my-zcode/commit/4e7f7d8a0c548d8a1c6486cb89f27d1c1d332bc6))
  * 三条装配静默路径（enabled / db_null / import 失败）发结构化事件
  * storage-db（FORK 登记）openDatabase/openDatabaseAsync catch 保留底层错误
  * usage summary 无真读数返回 null（默认 0 不再当读数渲染）；TTL execute 后
  * test-boot-busy-retry.mjs 6 例：真实子进程 BEGIN IMMEDIATE 占锁（临时目录

* **mc:** contextWindow 绑定提前到 turn 开始 + 窗口三源兜底（e2e/R-2） ([29fd850](https://github.com/bloodycrownD/oh-my-zcode/commit/29fd850b106da175a6e18d978595202239380d14))
  * record() 只有两道门（inputTokens / contextWindow），usage_skipped 日志的
  * bridge 侧 resolveConfiguredDefaultModelSelectionOf（agent/C-1，35b37a2）
  * onTurnStart：端口入口（pass 之前）即 noteLiveModel(input.model)，failure
  * 窗口三源：模型 properties -> create-app 注入的 resolveFallbackContextWindow
  * 保留 lastObservedModelKey 语义（S24-fix 换模型失效判据，提前绑定只会更准）。

* **mc:** transform_absent 事件生产可达 + 发射点单点化（mc/A-1、mc/C-1、mc/K-1） ([c8de401](https://github.com/bloodycrownD/oh-my-zcode/commit/c8de401b9654c1f7e945e7fd120ccbbd0980959f))
  * 新增零依赖 leaf src/app/magic-context-absent-event.ts：事件名常量 MAGIC_CONTEXT_TRANSFORM_ABSENT_EVENT、reason union（disabled|import_failed|db_null:migration_guard|db_null:fence|db_null:pending_or_unclassified，五值与真实发射值一致）与 emitMagicContextTransformAbsent；生产发射点（logger event 字段赋值处）收敛到这一处。
  * mc/A-1：create-app 的 enabled gate 补 else 分支调 leaf 发 disabled（flag 关时工厂永不执行，事件此前生产不可达，『压缩停机』在 disabled 形态静默）；import_failed 分支与工厂 db_null/disabled 分支全部改调 leaf；工厂 disabled 分支注释标注生产由 create-app 侧发射、本分支保留给直构/测试。
  * mc/C-1：describeStorageUnavailability 补与包内 storage-unavailable-reason.ts:24 同形守卫（migration 且确有阻塞进程或 unreadableFile 才判 migration_guard），export 作测试缝并支持注入 refusal 直测。
  * mc/K-1：storage_unavailable → storage_unavailability 改名处补注释（与 transform_absent 成对，已检索零消费者）。
  * 新增 scripts/test-magic-context-absent-event.mjs：子进程驱动 create-app 装配路径（enabled!==true）+ registerHooks resolve hook 断言工厂模块零加载（含阳性对照与哨兵活性自检）+ 可控 dataDir 断言无 db 文件 + 回传日志断言捕获 disabled 事件；leaf emit helper 进程内直测；db_null 细分表驱动直测。全部隔离在临时目录，不碰真实 ~/.omz。

* **storage:** ⑥ 清理展示链 service 侧收口——override 前置 none 门 + cleanScope 下发 + 在飞保护时钟语义锁定（uix/G-1/G-2） ([1ae1dfc](https://github.com/bloodycrownD/oh-my-zcode/commit/1ae1dfc16a66b73a9774bcdbc86fc447ab2c341a))
  * uix/G-1：service 三闸门统一以 hasStorageCleanPathOverride 优先于 none 门放行（storageCatalog.ts getStorageCleanScopes 枚举门、storageService.ts:84 clean throw、cleanPlan.ts planStorageClean 空 targets），CLEANABILITY.toolOutputs 回 none（整组不可一键清理）

* **subagent:** 锁 Agent 工具 schema 同一引用与异步派遣 sessionId 渲染（④ e2e/R-1 + sub/G-1） ([1578414](https://github.com/bloodycrownD/oh-my-zcode/commit/157841442f57080cd9f48162ec62f3e4ca6d9fc2))

* **ui:** ②guard 释放信号改组件自有 measuredKeys tracker——measurementsCache 陈旧键不再误释放切会话落点（uix/A-1 + G-3c） ([b12072f](https://github.com/bloodycrownD/oh-my-zcode/commit/b12072fc2c3e63f5aeb4ca561d8cfd69cc0e1139))
  * 释放判据不再读 virtualizer.measurementsCache（非响应式快照；同 commit 内陈旧同键测量可让 guard 在首个真实测高前误释放，guard 一次性不可恢复，误判=本会话永久回退跳顶形态）
  * 新增 SessionMeasuredKeysTracker（timelineRowHeightCache.ts 纯模块）：per-arm 代际契约——arm()（切会话武装）时整体清零，只收本 arm 周期内两写点（measureElement / live-tail cacheHeight）新写入 key；分区仅防跨会话串键、不跨 arm 保留（heights 缓存跨会话持久且切会话刻意不清，tracker 不得同源持久，否则 A→B→A 重访旧键复活跳顶回归）
  * 测试补 4 例 tracker（空 tracker+armed 不释放 / 首键写入恰好一次 / 跨分区不串 / A→B→A 重访）+1 例 LRU 跨分区竞争（uix/G-3c）；既有 21 例不回归

* **ui:** 会话切换首帧落点 guard + 测高缓存按会话分区 ([fd974fb](https://github.com/bloodycrownD/oh-my-zcode/commit/fd974fb2f3c5f3ae6cc5164a391a13e55fb68dad))
  * 初始落点 guard：sessionKey 切换不再立即落点，等本会话首个真实测高
  * timelineRowHeightCache 按 sessionKey 分区（\u0000 复合键），LRU 上限不变；
  * T-U1：timelineRowHeightCache.test.ts 21 例（guard 状态机/分区/命中率/LRU/

* **ui:** 重复 childSessionId 下 Agent 行回退 agentId 且可停性按组聚合（③ sub/C-orch-1+N-2） ([a7b1ee6](https://github.com/bloodycrownD/oh-my-zcode/commit/a7b1ee6ab1c58951061c8fe3e3d16dace2e2de9e))


### Documentation

* **core:** ctx 工具描述补主动使用时机引导（⑤ mc/T-1） ([acf6676](https://github.com/bloodycrownD/oh-my-zcode/commit/acf66765ef3efc4a465d110ea77bcb171d579766))


### Refactorings

* **agent:** 默认模型回落式抽为 resolveConfiguredDefaultModelSelectionOf（agent/C-1） ([35b37a2](https://github.com/bloodycrownD/oh-my-zcode/commit/35b37a28036dc486865832f30d12a869397ab152))
  * types.ts 新增导出纯函数 resolveConfiguredDefaultModelSelectionOf(options)：accessor 优先 → 静态字段 → undefined；结构上只依赖那两个字段，不绑死 ZCodeAppOptions / CreateSessionFacadeDeps，无模块环。
  * 三处重复回落改调用：create-app 的 resolveFallbackSelection 闭包、runtime-config 的初始选择解析、session-facade setModel("main") 兜底——漏改任一处都会悄悄退回 startup 快照，此后语义只有一份。
  * test-default-model-live 补 E 组三例（accessor 优先/仅静态/都无→undefined），8 例 → 11 例。

## v1.0.3（2026-10-09）

两处本地已验证修复的上游落地：magic-context 会话卡死修复、macOS 打包 ad-hoc 签名开关（CI mac 产物默认开启）。

### 修复

- **magic-context tool drop 残留孤儿 tool-call，会话卡死且重启/重放不恢复**：ZCode 把一个 tool call 拆成两个 part——assistant 消息上是 running 的 invocation（只有 input），user 结果消息上才是 completed/error 的 result（有 output）；而 tool 弧分类把 `type:"tool"` 一律当 result，FIFO 配对收不到 invocation 入队，result 一侧又复用了 user 宿主绑定（本是为 OpenCode「调用/结果同消息」形态准备的快路径）。两个 part 落进不同 composite key 后，drop 只清 result 一侧，invocation 成孤儿：客户端持续报 `AI_MissingToolResultsError: Tool result is missing for tool call ...`，坏字节还会被 LKG 固化逐 pass 重放。现在 `extractToolCallObservation` 按弧是否闭合（`partHasCompletedResult`）分流——完成/出错 → result、pending/running → invocation（anthropic 的 `tool_use`/`tool_result` 形态不变）；result 复用宿主绑定补 `role === "assistant"` 条件，user-role 宿主交回 FIFO 配对；`tag-messages` 与 `read-session-chunk` 两个 FIFO 消费方同时修正。缺陷链路与规则见 `docs/specs/magic-context-tool-arc-pairing.md`，transform 常驻测试 +3 例（38 cases 全过）。

### 功能

- **macOS 打包 ad-hoc 签名开关 `ZCODE_MAC_ADHOC_SIGN`**：无证书时 `identity: null` 让 bundle 完全不签名（没有 `_CodeSignature`），浏览器下载（带 com.apple.quarantine 隔离属性）后被 Gatekeeper 判「已损坏」且无法自救。开关打开后以 ad-hoc（identity `"-"`）完整封签，报错回到真实可行动的「无法验证开发者」提示。identity 回退链为 真实证书 → ad-hoc → 不签名；`notarize` 恒 false、`hardenedRuntime` 只跟随真实证书签名；默认关闭，本地与 CI 现状行为不变。CI 的 mac 产物自本版起默认 ad-hoc 封签（按 matrix 注入开关）——未公证包首次打开仍需右键 → 打开（或系统设置放行 / `xattr -rd com.apple.quarantine`），彻底解决需要开发者证书 + 公证。

## v1.0.2（2026-10-09）

v1.0.1 发布 diff 全量代码评审（32 项）+ 三线实机 E2E 验证后的修复批次：启动稳定性、品牌一致性收尾、模型体验补漏与测试基建。

### 修复

- **带残留旧版环境变量的机器上，打包版桌面仍「启动即退」（v1.0.1 修复的盲区）**：v1.0.1 的修复只在开发布局验证过——CLI 侧解析「随包基线」的候选清单缺桌面打包布局（`resources/glm` → `resources/config/provider`），打包产物在残留 stale `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 的机器上仍会抛「无法定位 CLI ZCode Built-in Provider Config」退出（read-only 控制面与会话 agent 均受影响）。现在解析收敛为 `@zcode/provider-node` 公共函数，CLI 与桌面 Main 共用同一候选清单（CLI 打包/桌面打包/桌面 dev/CLI dev 四布局），并在解析失败时接受继承的 `ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE` 兜底；agent spawn env 的 BUNDLED 恒指真实随包基线（fallback 优先、显式值仅兜底，单测锁定）。附带：成对环境变量探针改为纯读取校验，不再对（可能属于另一旧安装的）显式文件目录产生 mkdir/文件锁写副作用。
- **模型语言「自动」在 Windows 中文系统热切换回落英文**：运行中把「模型语言」切到「自动」（或从显式值切回）时，热路径只探测 `LANG`/`LC_*`（Windows 常缺位）会解析为英文直至重启，与冷启动（env → `Intl`）分叉。现在热路径与冷启动同源（公共函数单点），冷热一致有测试锁定；`zh_CN` 等 POSIX 风格标签也能正确识别为中文。
- **模型列表拉取三处补漏**：legacy 导入的自定义请求头（`api.headers`）随拉取上行——此前被丢弃，依赖自定义鉴权头的 provider 会 401 且误提示「请检查 API Key」（同名头大小写不敏感覆盖，显式鉴权头优先，头值不进日志/错误）；超时不再误报为「响应不是合法 JSON」、全链 405 不再误报 404（错误文案附最后状态与已尝试路径）；「密钥不经过 renderer」类注释与 CHANGELOG 措辞订正为事实（API Key 不作为 RPC 参数传递，由主机本地读取）。
- **「添加模型」可输入下拉的竞态与键盘可达性**：拉取未完成时关闭弹窗，晚到的响应不再把旧候选写进下次打开的弹窗（此前存在幽灵候选闪入）；已展开候选时点击输入框定位光标不再丢候选；补齐 combobox ARIA 契约（role/aria-expanded/aria-activedescendant），纯键盘（↓/↑ 选择、Enter 填入、Esc 收起候选且不连锁关弹窗）可完成全流程。
- **web 标签页标题回退 ZCode**：web 入口 `main.tsx` 运行时覆盖 `document.title` 的两处品牌串漏改（静态 `<title>` 已改但会被覆盖），现收敛为单一品牌常量；CUA 权限面板的运行时标题同理修正。

### 品牌

- **资产再生成管线可复现**：字标缩放精度修正（0.0185567，不再四舍五入漂移）、Z 字形保留原始贝塞尔曲线（不再折线化）、新增 `--check` 模式——36 项资产映射逐字节比对（SVG/PNG/ICO/ICNS/DMG/内嵌 favicon + 5 处内联 `d` 串），「重跑产物与仓库资产字节一致」首次可机验。
- **macOS 图标档位与 DMG 背景修正**：icns 补回 ic11..ic14（32/64/256/512 的 @2x 槽位——v1.0.1 重生成时档位回退，Finder 小图标此前只能降采样）；DMG 背景箭头纵向归位（与图标行 y=220 对齐，v1.0.1 补齐 mac 资产时错位约 80px 不指向「应用程序」）。
- **web 内嵌 favicon 与重生成图标同步**（v1.0.1 重绘全量图标后内嵌副本漂移）；`app-logo.svg` 描边环一处贝塞尔控制点抄错订正（与 Z.ai 供应商图标壳形逐字一致）；空状态明/暗线框线宽补偿（缩放后有效线宽此前约为原设计一半）；**原生菜单/托盘品牌词补齐**——Windows 帮助菜单「关于 omz」、托盘 tooltip「omz」/「打开 omz」（v1.0.1 改名在 shared 原生菜单 catalog 的漏网项，E2E 实机发现）；陈旧品牌注释清理与 DMG 卷图标注释对齐（安装器图标统一复用应用方标）。

### 工程

- 四组常驻测试落盘（共 40 用例）：Built-in 基线回落（含桌面打包布局回归锁）、模型语言（RPC 写盘/上下文构建三态/旧 CLI -32601 降级）、模型列表拉取（候选路径链/超时与错误分类/鉴权头/脏数据/密钥不泄漏）；资产 `--check` 纳入门禁（UPSTREAM-SYNC.md 测试族 15→17 项）。
- `electron-builder.config.js` 行尾归一 LF 并以 `.gitattributes` 锁定（`*.js text eol=lf`，消除 746/737 行的整文件噪音 diff）；设置页 i18n 清理删除组件遗留的 10×2 个孤儿 key（parity 5891=5891）；`presetLoading` 死别名与不可达 preset 分支清理。
- 全部 32 项经三线实机 E2E 验证：打包布局模拟 + stale env 真实 bundle、桌面实机（含真实端点拉取与键盘操作）、web 运行时标题；相关 feature/bug 的 PRD/SPEC 文档同步订正。

### 已知限制

- macOS 安装包仍未签名/未公证，首次打开需右键 → 打开（沿用 v1.0.1）。
- DMG 背景箭头指向与 icns 小尺寸槽位表现为像素级/结构级验证（箭头中心 y≈219.5、ic07..ic14 齐备），mac 实机视觉终判建议发版后目检确认。

## v1.0.1（2026-10-09）

品牌视觉定型 omz + 模型体验补齐（中文提示词、拉取模型列表、预设清理）与三处稳定性修复。

### 变更

- **桌面应用品牌由 ZCode 收敛为 omz**：打包身份（`productName` = `omz`、`appId` = `dev.omz.app`、Linux 可执行名/包名 = `omz`、Windows 开发态 AUMID）、运行时应用名（数据目录随之变为 `omz`/`omz Dev` 等，与旧 `ZCode` 安装互不干扰）、关于面板、深链确认文案、Linux 桌面项显示名、资源管理器右键项（新键 `omz.OpenInOmz` 并清理旧 `ZCode.OpenInZCode`）、界面 i18n 品牌词全部改为 omz，Windows 产物名随之变为 `omz-<version>-win-x64.exe`。`ZCODE_*` 环境变量、`@zcode/*` 包名、`zcode://` 深链 scheme 与 `~/.omz` 数据目录保持不变，详见 [docs/specs/desktop-app-rename-omz.md](docs/specs/desktop-app-rename-omz.md)。
- **品牌标志 Z → OMZ**：应用内全部 Z 字标渲染点（启动壳/关于面板/引导页/侧栏与顶栏方标/空状态明暗两套/CLI TUI ASCII）与全平台二进制图标（Windows icon.ico×3 同源/九档 png/icon_windows/web favicon、macOS icon.icns×2/DMG 背景 dmg_background×2）替换为 OMZ 三字母字标（设计语言沿用原 Z：笔画比例、末端斜切、对角斜率；Z 字母逐字沿用原字形）；安装器图标（icon_installer.*，原“包裹箱插画”）统一复用应用方标；DMG 安装背景以 OMZ 字标重绘同构图；新增 `scripts/generate-omz-brand-assets.mjs` 作为可复用的再生成管线（纯 Node 栅格化 + ICO/ICNS 容器写入，无新依赖）。
- **模型语言选项与中文提示词**：`~/.omz/cli/config.json` 顶层新增 `promptLanguage: "auto" | "zh-CN" | "en-US"`（缺省 auto，中文环境自动中文），设置页「通用 → 模型语言」可切换（自动保存、热生效于下一轮对话）；agent 系统提示词的身份/沟通规范/行为段/桌面上下文段支持中文（文案集中在 `prompt-copy-zh-cn.ts`，英文原文保留为回退），中文提示词显式要求以简体中文交流、技术名词保持原文。协议 `workspace/read|updatePromptLanguage` 旧 CLI 自动降级。
- **设置页移除 zai/bigmodel 预设可见面**：左栏「智谱」预设占位组（OAuth 早已删除的死占位卡）与「添加供应商」模板选择器的智谱分组（zai-api/zai-standard-api/bigmodel-api/bigmodel-standard-api 四张模板卡）整体移除；`config/provider/zcode-builtin.json` 的模板数据保留不动（存量用户从模板创建的 provider 依赖稀疏 overlay，删除数据属破坏性变更，登记为后续可选）。

### 新增

- **「添加模型」支持拉取模型列表**：`IProviderSettingsService.listProviderModels` 在主机侧按 provider 的 api 类型请求模型列表端点（走 host 代理/CA 传输层，API Key 不作为 RPC 参数传递）；模型 ID 输入框为可输入下拉框——拉取后聚焦/输入即弹出候选、输入即过滤、点选即填入，也保留任意手输。**路径兼容**（实测各家网关差异）：anthropic-messages 按 `/v1/models` 约定先试（对齐 SDK 消息端点 `{base}/v1/messages`），OpenAI 系先试 `{base}/models`；404/405 时逐条回落（含源站根路径 `/v1/models`、`/models` 兜底，覆盖 DeepSeek `/anthropic` 这类只在 OpenAI 面提供列表的双面网关及 API 类型与基址错配的配置）；全部 404 时错误信息列出已尝试路径。

### 修复

- **设置页「读取上下文管理配置失败」（read-only 控制面进程启动即退出）**：CLI 入口 `prepareCliProviderRuntimeEnv` 在显式 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 存在时把该值直接当随包基线且无兜底（成对快捷路径更是零校验透传），残留旧安装 env 的机器上 app-server 启动即抛「Bundled 与 Active 均不可用」退出（桌面侧表现为 read-only 协议请求 `stdout_closed`）。现在无条件解析真实随包基线并作为 `bundledFallbackFilePath` 兜底（与桌面侧/构建脚本 D-16 同语义），显式值失效时回落并告警；返回 env 的 bundled 基线恒指向真实基线。

- **桌面端「Bundled 与 Active ZCode Built-in Release 均不可用 / 模型加载失败」**：用户级环境变量 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 若指向旧版本缓存（如 ZCode 3.14.4 的 `~/.zcode` 运行时文件，schema 已不兼容），桌面 Main 会把它当作 Bundled 基线原样透传给 Host，双候选同源失效后所有 provider/model RPC 持续失败。现在 `NodeZCodeBuiltinProviderConfigSource` 支持 `bundledFallbackFilePath`：Bundled 基线无效时回落随包基线（打包 `resources/config/provider/zcode-builtin.json`、开发态仓库 `config/provider/zcode-builtin.json`）并输出可检索告警，语义与构建脚本 `builtin-provider-config.mjs` 一致；接线经 shared `hostInitLocalMessageSchema` → Desktop Main/Host → Services → provider-node 全链路。

- **桌面版启动停在「数据准备进程意外退出或连接中断」**：`glm/zcode.cjs` 的运行期 external 依赖 `@zcode/magic-context`（连同闭包内的 `zod`、`ai-tokenizer`）从未随桌面包暂存，Host 的存储准备 Worker 一启动就 `Cannot find module` 静默退出，用户侧只看到 `Storage preparation failed: transport_closed`。现在 `stage-agent-bundle.mjs` 按生产依赖闭包把 external 依赖平铺到 `glm/node_modules/`，并在暂存后实跑 `zcode.cjs --version` 自检（含 require.resolve 断言）；`electron-builder.config.js` 的 agent 资产条目改为从平台目录取件，绕开 electron-builder 对「拷贝根下 node_modules」的剪枝；`bundle.mjs` 新增打包后校验，源已暂存而产物缺失时直接失败。规则与验收场景见 [docs/specs/desktop-agent-bundle-externals.md](docs/specs/desktop-agent-bundle-externals.md)。

### 已知限制

- macOS 安装包仍未签名/未公证，首次打开需右键 → 打开（沿用 v1.0.0）。

## v1.0.0（2026-10-06）

首个正式版本：本地化 fork 定型（官方端点退场）+ 长会话性能治理完成。

### 变更

- **官方端点与账号域全线退场**：自动更新链（electron-updater、强更 gate、菜单/托盘/设置页更新入口）、登录与订阅账号态（UI 订阅额度族、CLI `/login`、官方 MCP 鉴权）、闲时任务（off-peak）链路、会话分享域（发布/导入/web 落地页）、帮助/反馈/社区入口、OAuth/支付 deep link 死管道整删。模型 provider 收敛为本地配置两组（preset / custom），仅凭自备 API 即完整可用；zh/en 键集对齐（5893 键，新增 parity 门禁）。
- **长会话性能**：投影层增量渲染（accumulator + copy-on-notify 引用复用 + renderUnits 增量缓存）、turn 目录窄投影（侧边消息 rail 的目录合并 / 跳转 / 上滚分页）、内存护栏（shiki tokensCache LRU 上限 500 + 订阅表上界）、全局秒级 tick 下线改局部组件自刷新。979 消息会话实测：滚动 longtask 121→43（2.8x）、阻塞时长 12293→3553ms（3.5x）、滚动行程归一 5.8–7.1x、heap 增长 +81.8MB→−3.7MB。
- **测试基建**：`pnpm test:v4-perf` 单命令聚合全部本期 blocking 测试（125 项），测试文件纳入根 typecheck 工程。

### 修复

- **v0.1.1 全量代码评审的 22 条 must-fix**：无行变更帧引用复用、共享缓存 (scopeKey, phase) 口径统一、rail 可见性单一真源、rowElementRegistry 跨 pane 撞号过滤、跳转 loading 接入 aria-busy 与禁点、目录翻页截断显式提示等，全部落地并通过独立终验（22+1 条矩阵 + 四门禁复跑）。
- **升级兼容**：旧版本 provider 缓存含已删字段（access.accountType/mode）时按随包基线回落，不再「模型配置加载失败」；bootstrap 严格模式编译错修复。

### 已知限制

- macOS 安装包未签名/未公证，首次打开需右键 → 打开。
- GitHub Release 单文件上限 2 GiB：超限产物不上传 Release，仍在 workflow 的 Artifacts 中完整保留。
- CLI 单文件（SEA）运行时仍需显式加载层（推迟项）。

## v0.1.1（2026-10-05）

### 新增

- **免登录完整使用**：只配置外部 API（DeepSeek、OpenCode Go、bigmodel-api key 等自定义 provider）不再被首启欢迎页强制选择品牌身份或登录，直接进入主界面；会话、工具调用、设置全部可用。不登录仅缺少账号态功能（剩余额度/Pro 展示、Coding Plan 订阅管理、官方 MCP 配额、会话分享），均静默降级。
- **`/ctx-*` 命令接入桌面端**：`/ctx-status`（状态快照）、`/ctx-reduce`（排队回收上下文）、`/ctx-expand`（取回已丢弃内容）、`/ctx-recomp`（分舱重算）在桌面 composer 输入 `/` 即可见、可执行，结果以底部信息浮层展示（状态快照常驻可手动关闭）。与 CLI/TUI 共用同一份实现，行为一致。
- **发布自动化**：推送 `v*` tag 即自动构建并发布四平台安装包——macOS（dmg + zip，arm64/x64）、Windows（NSIS exe）、Linux（AppImage / deb / rpm / pacman）——并附到 GitHub Release。

### 修复

- **设置页「折叠模型」无法设置**：选中任何模型都被静默清空（模型选择器编码与落盘格式的转换不对称），保存按钮永不点亮。已修复并补转换链测试锁定。
- **magic-context 设置改自动保存**：移除「保存 / 放弃修改」按钮，任何改动自动写盘并即时生效；保存失败弹提示并回滚到上次成功状态。
- **v0.1.0 全量代码评审的 33 条修复**，要点：
  - `magicContext.enabled = false` 时 transform 直通且不再打开/创建 magic-context 数据库（此前存在不生效与多余落盘两类缺陷）
  - 内置市场 CDN 旧 id 别名容忍——官方市场刷新必败的问题修复
  - `workspace/updateMagicContextConfig` 拒绝空 config，杜绝整域静默重置
  - 设置页清空「Token 覆盖」只摘除 default 分支，不再误删用户已有的 per-model 键
  - 生命周期/中断守卫、协议信封校验、UI 无障碍标注、品牌与合规文档口径等其余各项

### 已知限制

- macOS 安装包未签名/未公证，首次打开需右键 → 打开。
- GitHub Release 单文件上限 2 GiB：超限产物不上传 Release，仍在 workflow 的 Artifacts 中完整保留。
- CLI 单文件（SEA）运行时仍需显式加载层（推迟项，计划 v0.1.1+ 版本处理）。

## v0.1.0（2026-10-04）

首个可用版本：magic-context 上下文管理 MVP（裁剪/折叠/分舱、historian 旁路模型、执行阈值与预算参数域、用户级配置与设置页、`/ctx-*` 命令）；移除上游 `/compact` 链路（由 magic-context 取代）；品牌由 ZCode 过渡为 omz；tarball + install.sh 主分发通道与 E2E 终验通过。

## v0.1.0 之前

继承上游 ZCode v3.14.3 基线（tag `baseline/v3.14.3`）：phase1 移除遥测并完成基线评审修复；phase2a magic-context MVP；phase2b 移除 compact。
