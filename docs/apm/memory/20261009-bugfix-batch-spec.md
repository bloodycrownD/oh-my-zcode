---
date: 2026-10-10 18:00
title: 六缺陷批次发布 v1.0.4/v1.0.5 + magic-context「前台卡在记录记忆」诊断
keywords: bugfix-batch, magic-context 停机, 前台卡住, historian settle, passDurationMs, editUserQuery, 子智能体停止, childSessionId, 会话跳顶, exec 输出膨胀, spec-generate, spec-check-loop
abstract: 六缺陷批次已发布 v1.0.3-v1.0.5（压缩不启动/boot busy/会话卡死等修复，折叠模型默认继承会话模型）。2026-10-10 追问「前台被 magic-context 卡住修了吗」结论：没修、设计保留——turn 请求发出前同步 await transform pass（阈值命中=长会话全量投影，mc/BG-1 调查后不落地只加计时）+ 两次各有 60s 上界的折叠 settle；v1.0.5 折叠改默认 inherit 后人人可触发，感知变强。发布体系定稿（d69ef5e）：omz-publish/omz-changelog skill、changelog 手写四分类、Unreleased 段流转、release-desktop.yml 从 CHANGELOG 提取版本段；应用内无自动更新。
---

user:
编辑消息后发送仍然是旧消息、模型没切到最新；agent 默认模型切换不实时。消息多时切会话 msg 列表跳到最上方。子智能体支持手动关闭（参考 novelmaster）。同步派遣工具同样返回 sessionId。Magic context 90% 都没压缩。先看看这些 bug。……[$spec-generate] 直接生成 spec 吧，我就不复现了，反正你能 e2e 复现。……[$spec-check-loop]，另外发现一个新bug：子代理失控命令（for(let i=700; i=880; i++) 赋值笔误死循环）把 exec 日志撑到单次 5.13GB、5 次共 25.7GB，入库只有 338 字符。另外子代理卡了用异步派遣+同步查询，多派几个。

assistant:
（第一轮见上一轮次记录。）spec-check-loop 编排：按用户纪律后台派遣（run_in_background）+ TaskOutput 阻塞等待 + 失败 SendMessage 续派同 agent；并发 5 个 evidence（⑥前台写入点/⑥后台链路/⑥DB截断与测试/①②③锚点/④⑤锚点+约束断言）。关键修正：⑥不是「无上限」而是 5GiB 看门狗（5s 轮询超调到 5.13GiB）杀进程后文件原样保留，且 cli/exec 在 storageCatalog 归不可清类、无 GC；「入库有截断」是假象（sqlite 层无截断，338 字符=后台固定通知文案，截断在 executor 序列化层 2k preview/30k budget）；OutputCollector 50MB 预算被 Bash OS 直写 fd 路径绕过；可复用 capForegroundArtifactStream 物理 truncate。锚点 33/33 命中，另捕获 4 个 spec 修正点（④异步分支 JSON schema 既有不一致、⑤ openDatabase catch 抹错误类型→重试分类必须 FORK 保留类型、1d 需连 emitModelSelected 事件面、2a 需与二次 restore effect 共存）。doc-fix 已全部并入 spec（Step 16/17 + T-C1/C2 + 变更点 6a-6d + 5e 错误类型）。round-1 judge（单审查者两段式）已派，等待结论中。证据包 5 份：docs/iterations/bugfix-batch-20261009/cache/。

assistant:
（第二轮：code-review-loop 全程。）对 dev/bugfix-batch-20261009（0eb7674..5a35027）跑 code-review-loop：wave-1 四个 review-scope 后台并行（mc / agent-chain / ui-exec / subagent）→ 全部 scope-ready:no，合计 6 P1 + 12 P2；主代理 spec-fix 落盘 cr-fix-spec.md 并并入 e2e 三小修（e2e/R-1 异步渲染 sessionId 行·锚点 agent.ts:180-198 / e2e/R-2 unknown provider usage 调查+适配 / e2e/R-3 mapMessagePart 无 default 根治）；wave-2 单个 review-full 校验 → fix-spec-ready:yes，5 处修订已落入：①uix/G-1 硬性修订（CLEANABILITY 回 none 须同时放行 4 处 none 闸门 storageCatalog:259/storageService:84/cleanPlan:45/usageAggregate:73，且既有测试 storageExecOutputClean.test.ts:175 notEqual("none") 锁旧行为须改写 T-C2-4a）；②uix/B-1 措辞修正（outputLimitDetected 非死标志，仅交错竞态可达；主缺口=自然退出+超限文件零覆盖）+N-1 并入（截断后结果面须附「output file truncated」说明）；③uix/A-1 验收改 tracker 纯模块层（组件层无法表达陈旧 key 场景）；④sub/C-orch-1+N-2 并入（ambiguous 回退路径硬编码 cancellable:true 须尊从上游）；⑤行号校正（execution-utils :23/:29；agent.ts :180-198）。产物：docs/iterations/bugfix-batch-20261009/cr-fix-spec.md（fix-spec-ready，0 P0/6 P1/15 P2）。待拍板项在 spec Open questions：busy_timeout 40s 叠加、hasActiveTurn 抢占后台通知 turn、registry 双真相、env 记忆化、clear 零调用、T-E2(a) 复现方法收窄确认。技能终点=fix-spec-ready，代码执行待用户确认。

user:
（2026-10-10 追问）omz 被 magic context 卡住前台的问题修了吗？怎么感觉有时候还是请求卡住，明显是在记录记忆。

assistant:
结论：没修，且是设计有意保留；v1.0.3-v1.0.5 恰好修好了「90% 不压缩」并把折叠模型改为默认继承会话模型，以前从不触发的折叠现在真的在跑，前台等待从「从不出现」变成「阈值命中就出现」，感知自然变强。代码事实：前台请求发出前，turn-loop 插入点（core helpers/magic-context-turn-transform.ts:237 await 端口）同步完成三件事——① transform pass 本身（阈值命中=长会话全量投影；mc/BG-1 判定「后台预投影+lkg_replayed 快路径」四条不可行、本期不落地，dc7e5805 只补 passDurationMs 计时，ZCODE_MAGIC_CONTEXT_DEBUG_WIRE=1 时 magic_context.wire 事件可读）；② settleInFlightHistorian（bootstrap magic-context-turn-transform.ts:1609，上界 HISTORIAN_SETTLE_TIMEOUT_MS=60s :1431，等本 pass 起的 compartment agent）；③ settleScheduledPass（MF-04，:1632，上界 60s，等 notifyTurnSuccess 触发的调度器折叠）。等待理由=CLI「一进程一轮」，不等则折叠结果随进程消失（drain 预留泄漏、compartment 不落库）；注释原话「代价是这一轮的请求会晚发出几秒」。次要前台成本：resolveStoredRows 每 turn 缓存失效后无分页全量读 session store。缓解：设置页折叠模型显式清空=off（不装 executor、无折叠记忆）或显式指定快小模型替代 inherit；根治需重开 BG-1/settle 后台化（扩 barrel 或动包内 core，此前按 FORK 纪律否决，须用户拍板）。

user:
（同日追问）桌面端本来就是长驻进程，记忆录制前台等待不成立吧？另外 magic-context 上游不止注册工具，还有系统提示词注入，你的系统提示词里没有；还有子智能体改模型（继承→具体模型）同会话不生效要重启。

assistant:
三项全部查实。① settle 修正：桌面 host 是 Electron UtilityProcess 长驻（desktopHostProcess.ts:636 exit 仅故障/销毁边界），bootstrap 却硬编码 hostProcessLifetime="one-process-per-turn"（:1374）并无条件 settle（:1609/:1632）——CLI 形态的约束无差别套给所有形态，桌面端是纯增延迟。修法（不动包内逐字区）：settle 按「进程真会随轮退出」条件化，长驻形态不等，靠已有 MF-05 registerClose 会话关闭 drain 兜底。② 提示词面未移植：上游 agents/magic-context-prompt.ts 是 211 行 agent 系统提示词段落（project-memory/记忆 mural/ctx 工具使用指导），fork 标 FORK-DEFERRED(Batch2)/S31 未移植（v0.1.0 时 S31 登记 blocking:no 推迟至今）；同批 deferred 还有 memory-selection/storage-memory/storage-user-memory（项目记忆选择注入）、render-trigger+mural（supportsVision 恒 false 永不注入）、prompt-surface full/light preset。即 S21 只移了工具注册、配套指导面整个缺席——模型只能靠工具描述自悟。③ 子智能体模型不实时=真 bug：设置页写 v2/agents-state.json（builtInModelSelectionOverrides），但该文件仅进程启动时 loadZCodeAgentProfiles 读一次（create-app.ts:250→subagents.ts:71），结果冻结进 runtimeConfig；每次 spawn 读 this.config.subagents?.builtInModelSelectionOverrides（runtime/methods/subagent.ts:73）=启动快照。bugfix 批次 bug②「模型切换实时」只修了主 agent 默认模型（emitModelSelected/resolveConfiguredDefaultModelSelectionOf），子智能体 overrides 走另一条路没接活值。修法：spawn 时改读活值（重读 agents-state.json 或 ConfigPort/事件推送刷新）。三项待用户拍板立项。

user:
（同日再追问）blocking:no 可独立排期就是糊弄——还有哪些没接？另外主会话切模型也不实时：切了之后 assistant 不立刻用新模型，要等下次发 user 消息才更新；排队消息之前会被后台 magic context 直接阻塞，修了吗？

assistant:
④ deferred 全量盘点（deferred/ 目录 21 文件）：已接=压缩主链（transform B 组/historian C 组/ctx 工具 D 组/缩减版配置 E 组/boot DB/LKG）。没接分三类——A. Batch2/S31 整块用户可见功能：项目记忆系统（storage-memory/memory-selection/storage-user-memory，`<project-memory>` 注入整缺）、211 行系统提示词段（magic-context-prompt）、记忆 mural（render-trigger，supportsVision 恒 false）、embedding 召回（embedding-failure/embedding-status-tables，即 S31「embedding 带评估门」）；B. E 组扩展：prompt-surface full/light preset 运行时（prompt-surface/prompt-surface-runtime）+model-resolution；C. NOT-PORTED hook 缝 ~10 个（ctx-reduce-availability「OpenCode 权限 API 在 ZCode 宿主不存在」、send-session-notification、note-nudger/auto-search-runner/dreamer-task-registry/channel2-cycle/embed-session-state/compaction-off-transition/event-resolvers/hook-handlers，多依赖 OpenCode 宿主 API）。blocking:no 判定语境是 phase2a MVP 依赖顺序（不阻塞压缩主链），工程上成立，但交付呈现上没向用户说明「magic-context 只接了压缩半边、记忆半边缺席」——对用户构成糊弄，认。⑤ 主会话切模型不实时=设计如此但不符合用户预期：turn-model.ts:27-30「选择只决定新创建的 Model；已被其他 Loop 持有的 Model 不会被修改」（turn 内不换模）；turn.ts:100 turn admit 时读 intent.modelSelection ?? getSessionModelSelection()——queue item 携带 enqueue 时快照，v1.0.4 修复（turn-model.ts:47-51）只改「不再把旧快照写回会话态」，执行仍用旧快照（注释明说「本次执行仍使用上面的 selection 创建 Model」）。用户期望=切换后下一个 assistant 输出直接用新模型：需改 queue 提升读活值 session selection（除非消息显式 pin），行为变更须过 spec。⑥ 排队消息被 magic-context 阻塞=未修，与 settle 同根因的另一症状：settle 在 port 内、port 在每个 model step 的 wire 请求前被 await——最后一个 model step 首 token 被 settle 拖长 + 排队消息 admission 等 turn 完成 + 新 turn 自己再付一次 transform pass。修 settle（条件化/后台化）即同时缓解此项。

user:
（同日）本次累计 bug 非常多，生成 spec。embedding 和 hook 可以选择性地做——标准：要么做，要么不做，不存在二期；不做要给理由且确保不影响 magic-context 使用。

assistant:
已按 spec-generate 流程完成：并行 4 只读探索子代理（settle/排队链路、模型实时性双链路、Batch2 记忆面全量、spec 模式与门禁）全部返回；spec 落盘 docs/iterations/bugfix-batch-20261011/spec.md，待用户确认。要点：① settle 探索修正三处——每个 model step 前都跑（N-step 上界 N×120s）、两处 settle 独立机制（settleInFlightHistorian 无端口开关）、hostProcessLifetime 不动（动=usage 清零回归或包内 S20 特权区）；形态判据「进程是否随轮退出」三入口显式透传（protocol/TUI/print）。② 裁定表：做=D1-D12（211 行提示词段/storage 三件套/ctx_search 关键词版/mural 全链含 mediaBlocks+supportsImage 源/prompt-surface/event-resolvers/ctxReduceCallable 真值/原生 Memory 段互斥/三项 bug 修复）；不做=N1-N6（embedding 运行时面=依赖排除令+SEA 膨胀+离线必挂，记忆链完整性不依赖向量；ctx_note/note-nudger=无 ZCode 工具宿主面；dreamer=无 agent 进程宿主；channel2+notification=日志/时间线已覆盖且紧急拒绝 fail-visible 保留；compaction-off+hook-handlers=删除登记）——每项附「不影响使用」论证与收口动作（FORK-NOTE 终局登记/删除），.iteration-state.yaml 同步登记。19 个 Step、T-S/ML/MC/P/MU/X 用例、每 Step 单 commit 可回滚。

user:
（次日）三个不做的点对原始需求的影响问过、认可（「没什么问题」），确认 spec，进 spec-check-loop。

assistant:
spec 已确认；iteration-state 已登记 bugfix-batch-20261011/speccheck 节（r1 pending）。不做项影响已向用户说明：embedding=语义检索损失（链路完整，mural/注入走确定性排序）；note=零影响；dreamer=长期整理质量缓退（读时强化兜底）；channel2=可观测性。spec-check-loop 第 1 轮审查子代理已派（含代码锚点抽查要求），返回后按 P0 闭合循环。

user:
（同日）e2e 验证 + 没问题就发 1.0.6（omz-publish）。

assistant:
开发全面启动：分支 bugfix-batch-20261011（base d69ef5e4）；dev_exec DAG（dag v2：impl-settle ∥ impl-model-main 文件零交集提前并行）+ cr_exec（diff-per-wave + 末轮 full；fix-spec 产出后走**独立** spec-check-loop 至用户确认）+ release 节（1.0.6 前置门禁链，omz-publish 最后加载）。speccheck r1 返回 **No-Go（2P0+5P1+8P2）**，硬伤：①记忆写入链整条不在清单（promoteSessionFactsDurable 被 fork 剥离，memories 表会永远空）→ doc-fix 新增 D13；②211 段硬引用 ctx_memory 无裁定 → 新增 D14（做）。全部 doc-fix 已落盘（含 admittedAt 判据/闭包逐条/设置面扩字段/Step4 注释处置等），r2 复审已派；impl-model-main 已在跑中收到更正（admittedAt+写回不经 pin+两处注释处置）。e2e：verify-e2e 节点（协议级全链场景）+ CDP 锚点收集器在跑。

