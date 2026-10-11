---
date: 2026-10-05 22:30
title: 桌面端长会话卡顿根因定位（brain-storm，对比 novel-master）
keywords: 性能, 长会话卡顿, ConversationTurnNavigator, loadAllOlder, applyConversationDeltas, O(N)拷贝, liveNowMs, rows.window, tokensCache, novel-master 对比
abstract: 用户反馈桌面 Electron 长会话越用越卡、侧边 msg 缩略列表消息多时最卡，怀疑全量加载。4 个并行子代理探索 omz 渲染层/数据层 + nm（novel-master）两层的结论：协议层其实是窗口化+增量（设计正确），真正根因是宽屏≥864px 自动 loadAllOlder 把全量历史灌进 renderer 且 rows.window 只增不减，叠加 renderer 侧 applyConversationDeltas 不可变 O(N) 拷贝（服务端有可变累加器但 renderer 没用）、liveNowMs 每秒全量重建 renderUnits 击穿 rail memo、滚动每帧 O(N) Map 构建。nm 不卡不是因为优化强（它无虚拟化无分页无 memo），而是流式引用稳定+尾巴独立节点+tool_result 全文不进 DOM+没有 rail 这个组件。给出按性价比排序的优化清单，待用户拍板后落地。
---

user:
看看能不能给 omz 的 electron 性能优化下：目前性能还可以，主要是一个会话长时间使用后会卡顿，感觉是很多消息全量加载的问题，尤其是侧边的 msg 列表（不是左侧会话列表，是 msg 列表缩略）一多就非常卡。对比 D:\Dev\Js\novel-master（nm）反而不太卡顿，看看 nm 的实现。

assistant:
brain-storm 派 4 个只读子代理（omz 渲染层 / omz 数据链路 / nm 渲染层 / nm 数据链路）探索后的结论：

**组件定位**：用户说的「侧边 msg 缩略列表」= `packages/ui/src/v4/ConversationTurnNavigator.tsx`（会话区左侧 48px rail，每项 10px 横条+hover 摘要）。它本身已虚拟化（tanstack virtual），DOM 量不是瓶颈——卡在计算与数据层。「historian」是 magic-context 后端概念，与此无关（历史误导线索）。

**omz 根因（按影响排序）**：
1. 宽屏 ≥864px 时 ConversationTimeline 自动 `loadAllOlder()`（conversationProjectionStore.ts:1035）把全部历史 rows 灌进 renderer，`mergeOlderRows` 只前插无裁剪无上限 → N=整场会话。
2. renderer 每条 delta 走不可变 `applyConversationDelta`（shared/zcode-protocol-v4/apply.ts:83-118）：findIndex 扫全窗 + `[...window]` 全量复制，流式期每 150ms 一次 O(N) → O(N²)。apply.ts 头注释自己点名此问题，服务端已有 `createMutableConversationSnapshotAccumulator`（带 rowIndexById Map）但 renderer 没用。
3. `liveNowMs` 每秒 tick（ConversationTimeline.tsx:562）击穿 renderUnits useMemo → 每秒全量重建 renderUnits + navigator items（每 unit 全文正则清洗后才截断 220 字符）→ rail 的 memo 形同虚设。
4. 滚动每帧：resolveConversationTurnNavigatorActiveUnitIndex 里 `new Map(items.map(...))` O(N) 重建 + syncTurnNavigatorViewport 的 querySelectorAll+getBoundingClientRect 强制 reflow。
5. 次要：shikiHighlighter tokensCache 无淘汰（内存增长+GC 压力）；SessionPane 十余处 useMemo 依赖 rows.window（引用每帧必变，全失效）。

**用户假设修正**：首屏其实是 60 行尾窗+游标分页+增量 delta（协议设计正确），「全量加载」在宽屏下因 loadAllOlder 而事实成立。

**nm 为何不卡（反直觉）**：nm 桌面端其实更原始——无虚拟滚动、无分页（数据层有 listBySessionPage 但 desktop 没接）、MessageList 无 memo、每 step 全量 reload。它不卡是因为：(a) 没有 ConversationTurnNavigator 这种每秒全量重建的组件；(b) 流式期间 messages 数组引用完全不变（streamingText 独立 state+尾巴独立兄弟节点）；(c) tool_result 全文不进消息 DOM（≤120 字符摘要+Modal），消息 DOM 体积与工具 payload 解耦；(d) delta 走 RAF 帧合并（conversation-batch.ts）。nm 的 mobile 端反而有真正的行窗口化（row-windowing.ts，60+20 buffer）。

**优化清单（按性价比）**：P0=renderer 改用/对齐可变累加器消除 O(N) 拷贝 + 重新设计 loadAllOlder（turn 目录走服务端窄投影而非全量 rows，或给 window 设上限）；P1=切断 liveNowMs→renderUnits 依赖、Map 索引提出 useMemo、滚动 active 判定量化节流、querySelectorAll 改 ref 注册；P2=tokensCache 加 LRU、摘要截断前置。验证：React DevTools Profiler + applyConversationDeltas 加 performance.now 探针看耗时随 N 的斜率。注意 apply.ts:3 有「已发布快照不可篡改」协议不变量，renderer 改可变需明确取舍。

user:
[$prd-generate][$spec-generate] 出 PRD 和 SPEC。

assistant:
PRD 阶段补派 1 个子代理探索度量基建：结论「现有设施只能答内存涨了多少，答不了有多卡」——无 performance.mark、sampleNow() 句柄无 UI/命令出口、v4/ 下 200+ 文件零测试、无性能基线；verify:pre-push 不含 test；CDP 脚本模板在 .cu-shots/cdp-lib.mjs（dev 固定 9229）。用户两轮澄清拍板：①范围=P0 数据层（O(N) 拷贝 + loadAllOlder 改造）+ P1 渲染层（liveNowMs 解耦/滚动 O(N)/reflow）+ P2 内存护栏（tokensCache LRU/摘要截断前置）+ 性能度量基建，全部纳入「尽量都做」；②成功指标口径=相对基线改善（度量先行，改动前基线留存，流式期长任务目标降一个数量级）。PRD 落盘 docs/iterations/desktop-long-session-perf/prd.md（含风险与待确认：验收环境 dev/prod、造数方式、apply.ts 协议不变量取舍、阈值回填）。

user:
继续出 spec。

assistant:
SPEC 阶段补派 3 个子代理（服务端投影扩展点 / renderer 不可变性依赖 / 造数度量注入点），关键结论：①renderer 侧「已发布快照不可变」无实质依赖者——所有消费点同 render 周期内读、无跨帧 row 缓存/无快照 diff/无 freeze，copy-on-notify 三层换引用（window 数组+rows 对象+snapshot 外壳）可完全满足 React 引用失效语义，apply.ts 头注释是服务端冷恢复边界约定非 renderer 契约、数据流严格单向；②新 v4 只读方法固定改动面 13 文件（契约/限额/publisher/gateway/server switch/host 四件套/transport 三件），turn 目录可从全量投影行现算（turnHeader 行定边界+userInput(realUser) 挑 query），冷恢复照 rowsRange 三段式自动可用；两个硬问题=跳转（scrollToQuery 依赖已加载 DOM，方案=循环 rowsRange 拉到 anchor）与 unitIndex 语义（方案=目录项 rowId 区间降级判定）；loadAllOlder 不能删（分享链路要全量正文）；③度量正确形态=页面内探针（PerformanceObserver longtask 自持缓冲，dev 下 performance timeline 每 10s 被 performanceTimelineCleanup 清空所以不能用 mark/measure）+ 新增不经门控的 collectRendererMemorySample（sampleNow() 只返回 boolean 不可用）+ CDP evaluate 取数；造数拍板走真实长会话（workspace+sessionId 参数化，transportDelayE2E 不能伪造帧、主会话无 jsonl 可重放）；single-instance 锁与 9229 端口冲突需脚本前置探测。SPEC 落盘 docs/iterations/desktop-long-session-perf/spec.md：21 步（Step 0 前置验证 max-lines 口径；phase-perf-probe→baseline→render-hot→delta-apply→turn-directory→memory-guard→verify）、11 个测试用例（T-AP1 等价性 mutable≡immutable 为核心）、风险表（accumulator 索引静默错乱=最高危，统一 rebuild 入口钉死）。PRD+SPEC 均待用户最终确认。

user:
[$spec-check-loop] 审查这两份文档。

assistant:
启动 spec-check-loop（目标 execute-ready），两段式：evidence×3 并行取证（delta-apply / turn-directory / perf-probe+render-hot，落盘 cache/sc-evidence-*.md）→ judge×1 裁决。编排状态在 docs/.iteration-state.yaml 的 desktop_long_session_perf 节。审查中。

user:
（spec-check-loop 过程记录）

assistant:
三轮收敛到 execute-ready：r1 No-Go（P0×10/P1×16/P2×9，judge 全部亲自回读代码核实）→ doc-fix 整体重写 spec（dev 启动契约/量化 72/RowShell 注册/startedAt 硬约束/摘要算法/目录契约 realUserQueryTotal/可测性前置 Step 5）→ r2 No-Go（32/35 闭合；仍开放 P0-4 startedAt 只覆盖 guide 段+根级 interval 未删、P0-5 分段截断与逐字节一致不可兼得、P0-10 导出 seam 不解除 @/ 传递依赖——judge 实跑 tsx 证明 ui 模块因 @/ 不可 import）→ doc-fix r2（startedAt 逐分支同源链+liveNowMs 彻底下线；摘要改流式折叠前缀单调等价方案+T-TD1 四类边界语料；Step 5 硬 gate 零 @/+纯逻辑下沉 conversationProjectionCore.ts+tsx -e import 自检）→ r3 Go（judge 子代理两次未产出，按 skill 失败处理降级主代理手工审查；回读 conversationTurnWorkSegments fact 链/interval 位置/折叠管线验证三 P0 修复对齐代码事实，顺手闭合 1 条 P1：单段 turn startedAt 应为 header.startedAt 非 triggerRow.createdAt）。报告在 cache/sc-review-r{1,2,3}.md。**PRD+SPEC 已 execute-ready，待用户确认后可开工**（确认后切 agile-dev/code-dev-loop，按 Step 0-21 执行）。

user:
[$code-dev-loop] 这里新建 worktree（D:\Dev\worktree）。

assistant:
用户确认开工。code-dev-loop 启动：worktree=D:\Dev\worktree\desktop-long-session-perf（feature/desktop-long-session-perf，base main=ba7c240=v0.1.1——主仓现已在 main 而非 dev/phase-0），完整 pnpm install --prefer-offline 25.6s 装好（不挂 junction 规避 RULE 坑；cpu-features 可选依赖构建失败无害）。Step 0 完成（main 直改）：SessionPane 豁免在第 4 行块注释（首行检测漏报教训）；renderUnits 445 总行临界，S12 下沉新文件规避。DAG 11 wave 落 iteration-state（dev_exec 节），wave-1 四节点并行（perf-probe/cdp-script/testability/memory-guard）。

user:
（开发过程汇总）

assistant:
代码开发全部收敛（HEAD=7964219，27 commits）：度量基建（perfProbe 探针+CDP 采样脚本+可测性下沉 conversationProjectionCore.ts）、render-hot（liveNowMs 彻底下线+WorkingDurationText 局部 tick startedAt 逐分支同源、滚动 Map 预计算+量化 72、RowShell rowElementRegistry）、delta-apply（accumulator+copy-on-notify 三层换引用+四处 rebuild、renderUnits 增量重建 fuzz 抓两真 bug 修复、lastMutation）、turn-directory 全链（previewText 流式折叠逐字节等价、契约+服务端 getTurnDirectory+host 13 文件、store 目录态双路径+250ms 去抖、items 合并+active 三态、跳转闭环 async+rowId 反查）、memory-guard（tokensCache LRU+subscribers）。两轮 cr-func：A=yes；B=no 抓到 M1 目录首查死链（SessionPane 无条件下发空态 total=0 自锁——测试没覆盖 loaded=false 所以门禁全绿也漏）→ fix 7964219 → 复检 yes。终态门禁：根+CLI typecheck、lint 71w/0e 同基线、测试 88 通过（唯余存量 @/ 红）、architecture 0。事故记录：wave-3 并行节点 reset --mixed 摘掉他人 commit（已恢复，教训入 iteration-state：并行禁 reset 拆提交用 pathspec）。**未 dev-ready**：S4 基线（blocked-user 三选项：a 对用户 main 实例注入采/b 关实例修隔离/sessionDbPath 根因已定位二/c 授权写 ~/.omz 造会话）与 S21 终验待用户拍板；工具链全部打通（隔离实例 9333/独立 profile/数据抽取/CDP 驱动 exit0，唯 sessionDbPath 未生效）。

user:
electron 方便进行 e2e 吧？不用操作电脑？

assistant:
确认全自动 E2E 路线后基线+终验全部闭环：关键发现=dev 实例数据根是 ~/.omz（空）而 158 会话在 ~/.zcode（生产）——把 sess_edd74a25（979 msgs）从 .zcode 只读导入 .omz（10 表+tasks-index，备份 VACUUM 快照；sessions-index publisher 按 workspace 永久缓存、外部导入不进侧栏→命令面板搜索完整 pointer 序列绕行）。before=主仓 main 实例（复活 vite 5174+注入探针）、after=worktree 隔离实例 9335（独立 userData+vite 5188；**坑：out/zcode.cjs 构建产物早于 af8c129 会静默缺 getTurnDirectory，须重建**）。同会话同口径 30s 滚动对比：longtask 121→43（2.8x）/12293ms→3553ms（3.5x）/行程归一 5.8x-7.1x/**heap +81.8MB→−3.7MB（增长彻底消除）**/最大值 330→316ms 未动。四条验收路径全过（跳转/hover 摘要/上滚分页/分享 19/19），console 零异常，turnDirectory 端到端 9.3ms。PRD「一个数量级(10x)」未达（判定线本为待回填项），建议「≥3x+heap 零增长」，待用户拍板；导入会话保留供实机体验。基线三件套在 docs/iterations/desktop-long-session-perf/（before/after/compare.md）。

user:
[$code-review-loop] cr吧。

assistant:
code-review-loop 三轮收敛到 **fix-spec-ready**（两段式：evidence×4 取证 51 条可疑点落 cache/cr-ev-*.md → review-full 全局裁决 → r2 复审 fix-spec → r3 定点复核）。裁决：P0×1（full/B-1 rowElementRegistry 模块级单例跨 pane 撞号=本轮引入的回归——SessionPane 有 5 处挂载点，侧 pane 与主 pane 并存常态；修法=读取端 element.contains 过滤+抽 pickOwnedRowElements）+P1×8（E-1 无行变更帧仍换引用伤旗舰指标/B-2 目录失败静默陈旧/G-1 分页逻辑零测试/G-2 九套测试无执行入口且不在 typecheck/C-1 死代码五项/B-5 探针 HMR 双 observer 污染采样/B-4 目录降级项 userPreview 无 fallback/J-1 jump loading 无消费方且切会话粘 true）+P2×13（F-1 previewText 注释三处不准+spec 措辞同步/C-5 缓存口径不对称+空 rows 清表/J-2 gutter 与 rail 渲染不同源（r3 追出第三条判定在子组件 :202，最终修法=merge 上提父组件单一真源）/E-3 翻页静默截断/E-1-C-1 顺序依赖等）+open_questions×4+否决×10（含 schema 不 strict=有意取舍、重查无退避=天然限流等）。fix-spec=cr-fix-spec.md（22 条全含文件+改法+验收；deviations #1-#4 待用户拍板不阻塞 ready：扫描量措辞收窄/三层换引用收窄/loading 走补齐/>500 条 truncated 最小方案）。r2 抓出 fix-spec 自身 4 处与代码矛盾的改法/验收（J-2/C-5 原断言必红等）均闭合。**待用户：确认 fix-spec 开工 + 4 条 deviations 拍板**。

user:
[$spec-check-loop] cr spec不是开发spec，loop。

assistant:
用户指出 fix-spec 本身要过 execute-ready 审查。spec-check-loop 四轮收敛到 **execute-ready（r4 Go）**：r1 No-Go（2P0——C-5 改法 TDZ 必崩+执行编排缺失致 loadTurnDirectory 三改打架；6P1——G-1 签名不可测/G-2 rootDir 实测必红/J-2 接口缺 loadedItems 等；8P2）→ r2 No-Go（13/16 闭合但我的 r1 修复引入新 P0：C-5 下移漏下游两消费点仍 TDZ；C-1 跨波次劈半）→ r3 No-Go（C-5 上提 :990 还是 TDZ——:990 在消费点 :659 之后，**教训：修「声明位置」类缺陷必须验证「声明<全部消费点」而非「依赖<插入点」**；C-5 无波次归属；B-1 单测无文件）→ r4 Go（C-5 双双上提至 :654 前，四项实测全过）。最终版 fix-spec 新增：5 波次执行编排（C-1 拆 C-1a/C-1b、G-1→B-2→E-3 顺序、G-2 最后写 test 列表 8 文件）、行号基线硬约定（符号定位）、B-2 如实描述退避耗尽后 rail 隐藏的取舍、G-1 签名带 expectedLogEpoch/readCurrentLogEpoch。**待用户：确认 execute-ready 开工 + 4 条 deviations + 验收线（三个决策点一直挂着）**。

user:
[$code-dev-loop] 修复吧。/ 继续，刚才电脑重启了。/ 你可以重新派遣智能体。/ 修好了，可以派遣智能体了。

assistant:
cr-fix-spec 22 条/5 波次全部执行完毕并过终验（**dev-ready：fix 全闭环**，24 commits，d11a97c..7a03590，worktree=feature/desktop-long-session-perf）。W1（1b43174/98f5723/92f8910/1b3e783/c9af3f2）+W2（6001f08/b63f8cd/6c65e1a/10b247a）+W3（adbeffb+1a22f60）+W4（126e84b/70b3e25/fbc4619/4d74508）+W5（ed4e8f1/047bc22/1efff40/cade3a8/541c33c/aed34f3/e623393/34eacac/7a03590）。要点：C-3 原改法被执行者证伪为 no-op（Map 同键覆盖）改 detachedTurnIds 独立字段；E-1 windowChanged 写死 turnIdByRowId.size>0+只读帧复用引用；J-2 build/merge 上提 ConversationTimeline、turnNavigatorVisible 单一真源管渲染+gutter；B-1 pickOwnedRowElements 容器归属过滤；G-2 tsconfig.test.json×2 纳入根 typecheck（**坑：extends 不继承 references 须显式声明；rootDir 须覆盖 "." 否则 TS6059**）+pnpm test:v4-perf 聚合入口（125 测试）。终验 cr-fixspec-func=func-ready:yes（22+1 矩阵全 pass、四门禁独立复跑全绿、零阻塞）。过程事故：W4 子代理连续 provider rejected 降级主代理手工，用户修复后 W5 交回子代理。

user:
正好，把两个分支都合并到主分支吧，然后对electron进行e2e测试。

assistant:
双分支合入 main 并完成 E2E。**合并**：1dbe627(official-endpoints S1-S8，540 文件)+339bafc(perf，53 文件)；交集 8 文件、真冲突 3 文件 7 块——语义裁决原则=两侧意图都保留：TurnGroup 删 OffPeakTurnCards 留 WorkingDurationText；Timeline 删 liveNowMs tick（perf 目标）与分享布局同步（official 整删）、rail 取 perf 单一真源并随 hideTurnNavigator 移除收窄；SessionPane 分享机器整删、isDraft/sessionLeaseReady/timelineSnapshot 保留 perf 上提位、sessionPhase 走 sessionRenderPhase 单源。**行拼接脚本两次 off-by-one 吃行**（selectionActions{/initialDraftConfigForDiagnostics 声明被吃，typecheck 抓回）；PowerShell WriteAllLines 会把整个文件转 CRLF 须显式 UTF8-noBOM+LF 写回。**合并暴露 official 末梢潜伏缺陷 2 处**（其分支没重跑构建）：3968844 bootstrap TS18048（schema optional 化后 source?.title.trim()）；2be607a agent env 无随包基线——升级用户旧 Active 缓存含已删 accountType/mode 时 provider 判死（bootstrap BUNDLED env 去 standalone 门槛+services 随附基线，对齐 D-16 回落语义）。**门禁**：typecheck/lint 71w0e/arch/i18n parity 5893/test:v4-perf 125 全绿；**坑：bootstrap contracts dist 陈旧产物引用已删 OFFICIAL_MCP_TOOL_ERROR_CODES，须重建**；根 typecheck 不含 apps/zcode-cli（其 tsc 自建才查，潜伏错误因此漏网）。**E2E 最大教训：本 agent 会话本身跑在生产 ZCode 子进程内，shell 带 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE（~/.zcode 3.14.4 旧缓存）等生产 env，全链路污染 dev 实例伪装成「模型配置加载失败」——排查两小时（静态追源码+临时 debug print 三轮），最终 Get-ChildItem env: 一眼定位；**dev 启动前必 scrub ZCODE_* env**。次要：隐藏窗口（visibilityState=hidden）下 Chromium 节流页内定时器+rAF 挂起——CDP 功能测试必须驱动侧轮询（页内 Promise/interval 永不回传）、smooth 滚动冻结（jump 无法断言=纯 harness 限制）、CDP mousePressed/Released 因按下后重渲染不合成 click（downs=1 clicks=0）。**E2E 结果**：启动零横幅/长会话 1160 行恢复/rail 19 合并条目/hover tooltip 369 字符/上滚分页 300→1160/console 零异常 PASS；采样稳态零 longtask、rows 恒定（滚动 7 步 vs 基线 249 步=节流，绝对值对比不成立，权威数字仍为分支终验）。遗留：~/.omz/v2/runtime/provider 改名为 provider.stale-*（可回收）；main 本地领先 origin 4 commits 未 push；jump 实机 QA 建议合并后 manual 验证。
