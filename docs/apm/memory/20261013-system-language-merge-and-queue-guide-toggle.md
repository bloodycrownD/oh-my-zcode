---
date: 2026-10-13 21:30
title: 两项优化探索：界面/模型语言合并为系统语言、排队项「引导/排队」切换按钮
keywords: 系统语言, 语言合并, promptLanguage, localePreference, 引导按钮, guide, queue, delivery.admitted, sendQueuedNow, pendingGuide, brain-storm
abstract: 用户提出两项优化：①界面语言与模型语言合并为统一「系统语言」；②排队项上加「引导」按钮（点击切换 引导/排队）。三路探索结论：语言两链路完全独立（setting.json 的 localePreference vs config.json 的 promptLanguage，auto 解析来源分叉是最大合并冲突，分立本身是 v1.0.4 有 PRD 的显式设计）；「引导」按钮的协议基础已在（delivery.admitted 已有 guide 值、pendingGuide 投影已存在），上游无此按钮属 fork 新 UX，但需先澄清「引导」语义=复用既有 guide（当前轮 tool 边界内联注入）还是下一轮优先出队。
---

user:
优化：
1. 界面语言和模型语言合并，变成系统语言
2. 后续操作加入队列，在队列上加一个按钮——引导，点击后变为引导，再次点击变回排队

assistant:
按 brain-storm 派 3 个只读探索子代理（语言双链路 / 队列与引导链路 / 历史文档既往拍板），结论如下。

【优化① 语言合并现状】两条链路完全独立：界面语言=LocalePreference(system|zh-CN|en-US) 存 ~/.omz/v2/setting.json（locale+localePreference）+2 个 localStorage 键，system 解析走宿主 Electron app.getLocale→navigator，有跨窗口广播 state:locale（IntlProvider 结构化 payload 与 zustand store 遗留字符串 payload 两套机制共用频道名）；模型语言=PromptLanguage(auto|zh-CN|en-US) 存 ~/.omz/cli/config.json 顶层 promptLanguage，auto 解析走 env→Intl，无广播、CLI 进程内 runtime.updateConfig 热更新。值域实际语言集合相同，差异只在 auto/system 命名。分立是 v1.0.4 prompt-language-option PRD 的显式设计（代码注释「刻意相同值域但相互独立」）。合并三个必答决策：①auto 语义统一（宿主系统语言 vs env+Intl，英文系统+中文 LANG 会得界面英文+提示词中文；统一需把宿主 locale 透传进 CLI 协议通道=重开 OQ-9 拍板）；②真源归属（倾向 setting.json 为主+host 顺带调 workspace/updatePromptLanguage；须定义无 workspace/旧 CLI 降级态）；③第三处语言域 CLI TUI ui.locale 是否跟随。上游无 promptLanguage（fork 自有），合并不增加上游同步冲突面；影响面含广播防回环、宿主菜单链路 setApplicationLocale、migrateLegacyLocalePreference 式迁移、promptLanguageDegradation 测试族与 UPSTREAM-SYNC §4 登记。

【优化② 引导按钮现状】busy 输入进 core activeTurn.pendingInputs（FIFO 无优先级），UI 唯一渲染点 ConversationQueuePanel（拖拽重排+立即/编辑/删除，rowLocked=dispatch.state!=="queued"）。已有能力：sendQueuedNow「立即」=reserve+lease+preemptActiveTurnAndWait（会 stop 当前轮，抢占式）；reorderQueueItem=移位不改投递语义；guide 投递（delivery.admitted==="guide"）=当前轮 tool 边界内联注入（turn-guide-drain），展示为时间线内联 pendingGuide 列表（从可见队列过滤掉）。关键澄清点：用户说的「引导」最可能就是既有 guide 语义的提交后切换（followupMode=guide 是提交前设置，按钮=把已排队项 queue↔guide 切换），上游无此按钮、协议 delivery 字段已在。若语义是「下一轮优先出队不抢占不内联」则成本更高（需新增命令+字段，schema 全 .strict() 须同步 snapshot.ts/input-intent.ts）。安全护栏可直接复用 pendingInputReservations+foregroundPromotionLease 互斥（dispatch.state!=="queued" 拒绝切换）；必须遵守 v1.0.6 队列五红线（出队模型活值 getSessionModelSelection、promote 不写回不置 pin 不广播、idle-only promotion lease 五条件门等）。UX 注意：切到 guide 后该项从队列面板消失转入 pendingGuide 列表，切换反馈要先设计。遗留线索：TID_V4_QUEUE_ITEM_UP 常量存在但无消费方（上游快照带入的「上移按钮」痕迹，后被 dnd-kit 拖拽取代）；RuntimeCommandPriority now/next/later 三档定义了但生产者全硬编码 next。

两项均建议走 agile-dev/spec-generate 立 prd+spec（语言合并是修订 v1.0.4 PRD 拍板、引导按钮触 v1.0.6 队列红线），不可当 bugfix。

---

【agile-dev 执行记录】

用户追加拍板（2026-10-13 深夜）：①「两设置并存没有意义，当时设计就不合理……用界面语言那套就行」——合并口径=LocalePreference 值域+宿主探测，模型语言跟随界面语言解析值，不做 detectedLocale 协议透传（不重开 OQ-9）；②引导语义=既有 guide 投递（用户引用设置文案「引导至下一轮工具调用后运行」），按钮=排队项 delivery.admitted queue↔guide 切换，非抢占非新优先级。

敏捷项① system-language-unification（feature 分支，基于 main）：5 commit（9be0a787 spec 留痕 / 97d91761 设置页合并删模型语言行 / 7e68c89a IntlProvider localeChangeToken+promptLanguageSync+useSystemLanguagePromptSync 联动 / 035f9aa4 清理相互独立注释+CHANGELOG / 08114e10 prd 补交）。核心设计：token 只在发起窗口 setLocalePreference 递增（广播接收侧不递增→不重复写）；hook 单飞+workspace 可用后补跑一次（覆盖存量迁移）；无 workspace/旧 CLI/失败一律静默。验证：typecheck 0e、lint 74w/0e 基线持平、i18n parity 5901=5901、新增 systemLanguagePromptSync.test 6/6、promptLanguageDegradation 2/2（断言不变）、architecture:check 0。文档：docs/iterations/oh-my-zcode-fork/features/system-language-unification/{prd,spec}.md。已知边界：无桌面实机 E2E；存量用户 promptLanguage 首次进 workspace 被改写为界面语言解析值（拍板语义，CHANGELOG 已登记）。

敏捷项② queue-item-guide-toggle（feature 分支，基于 main，与①文件面不相交）：5 commit（1fa073ee 协议命令+core setPendingInputDelivery / fd2db756 core+bootstrap 单测 10+10 / 7dcfa76a UI 双侧按钮+QueueRow 拆分 / 5a63ceb3 i18n+CHANGELOG / 55b48af5 prd+spec 留痕）。核心结论：firstInlineGuideIndex 是**动态扫描**（steering.ts:445-454 按 delivery 实时 findIndex），切换后项自然进出 guide 子序列，core 消费侧零改动（单测钉死）。handler 门序=投影命中→dispatch.state==="queued"→同值 noop→core 改写；reserved/promoting 拒绝（guard.queueItemDeliveryLocked）；held 回落复用 edit 先例；持久化复用 TurnSteerDeliveryChanged→updateSessionInputs 集中记账。guide→queue 恢复保持原 FIFO 位。验证：根+CLI typecheck 0e、lint 74w/0e、i18n parity 5912=5912、architecture:check 0、projectionCore 47/47 回归通过。文档：docs/iterations/oh-my-zcode-fork/features/queue-item-guide-toggle/{prd,spec}.md。

两分支均未合并 main、未 push（待用户过目）。

【真机 e2e 记录（2026-10-14，主代理手工执行——执行子代理两次 provider 限流后接管）】

① system-language-unification：**S0-S3 全绿**（分支新 commit aafae0ba 证据包 cache/realdevice-e2e.md）。S1 设置页仅一行系统语言；S2 联动写盘 setLocale('en-US')→config.json promptLanguage=en-US→切回 zh-CN（初始迁移同步也生效）；S3 选「系统默认」→写宿主 locale。driver=cache/e2e-system-language.mjs。

② queue-item-guide-toggle：S0/S4 绿（真模型 busy 中排队、每行渲染引导按钮，tooltip 文案正确）；**S5 切换往返 failed=疑似产品缺陷待裁决**（分支新 commit e7599f5d 证据包）。症状链：原子点击成功→行级 ACK 态翻转→console 无拒绝日志（ack∈accepted/noop/duplicate）→45s 稳定 busy 窗口内队列项不动、无 restore 按钮、无 turnSteer 痕迹、无 toast。候选断点：handler 同值 noop 误判（getQueueItem 投影滞后）或 renderer 侧 guide 投影消费链断（SessionPane 挂载链无测试覆盖——conversationProjectionCore.test 只测纯函数）。guard 行为（reserved/promoting 拒绝）与 autoDrain 竞态均符合设计。

e2e 方法学教训（复用）：config.json 落点=os.homedir()/.omz/cli（ZCODE_STORAGE_DIR 不控制，USERPROFILE 重定向会令 Electron appData 崩）→必须备份/恢复式验证；**事故**：v1 轮误信隔离变量，真实 ~/.omz/cli/config.json 被写 promptLanguage=zh-CN（与用户既有值一致无行为影响，后已备份/还原口径修正）；制造稳定 busy 用工具循环任务（ping×N），纯数数任务 GLM 几秒完成窗口不足；workspace 打开走第二实例 `--open-workspace=<path>` 单实例锁转发；设置页分区需先点 settings-section-nav-general；e2e 结果绝不 dump 完整 config.json（含 MCP Bearer）。


【code-dev-loop 轮：②S5 根因定案与修复 dev-ready（2026-10-14，主代理手工——子代理全天 4 次 provider 限流）】

- **根因实锤（推翻此前两条候选）**：baseRevision CAS stale。busy 流式期间投影 revision 随流式事件快速前进，hook 点击瞬间读到的 baseRevision 到达 CLI 已落后，gateway 以 proto.staleRevision 拒绝；hook 原设计「stale 不重试静默回滚」→操作无痕丢失。插桩铁证：fail 轮 ack={status:stale, revisionAtDecision:7} vs 发送 rev=6，CLI handler/core 零执行；pass 轮恰好 rev 新鲜全链 8 条日志完整。fail/pass 各半=点击瞬间 revision 新鲜度竞态。
- **两条旧诊断作废**：「查找域不含 queue 项」（实验 mock 空投影失真，真 EventReducer 含 queue 项、held 回落真机正常命中）；「renderer 消费链断」（pass 轮链路完整）。CR 时对 CAS 的怀疑（v11）当时被 pass 轮样本误排除——**e2e 诊断必须多轮采样，单轮 pass 不是排除证据**。
- **修复两次迭代**：c1671fae（stale 单次重试+P0-2 handler core miss 改显式 rejected guard.queueItemDeliveryCoreMiss+P2-1 观测）复跑 1/3——单次重试读本地投影 revision 在流式高峰仍连续落后（本地 delta 滞后于 CLI 权威）；2158c8ed（重试升级：重发 revision=max(本地, ack.revisionAtDecision)，上限 2 次）复跑 **3/3 全过**。验收：bootstrap 10/10（B5 新语义）、typecheck 27 包、lint 0w0e、S0/S4/S5 e2e 3/3。分支②累计 commit 至 abeb3af7，未合并未 push。
- **插桩方法学**：desktop fork host 进程 env 是 buildHostProcessEnv 白名单构造（desktopHostProcess.ts:237），自定义 OMZ_* 环境变量传不进 CLI——插桩日志必须写死绝对路径；core 包 tsc 严格，插桩回调参数须显式类型。
- 已知限制：hook stale 重试无单测（ui 包无测试基建，建基建超 cr-fix 范围，e2e S5 承担覆盖，fix-spec 已记 P1 后续项）。


【v1.0.10 发版终态（2026-10-14，tag v1.0.10 @ 7331191d，main 已合并推送）】

合并方式：① system-language-unification ff-merge（7 commit 保 hash）→ ② queue-item-guide-toggle --no-ff merge（abdd9a32，13 commit 保 hash）→ e2e driver lint 清理（c158cd30）→ release commit（7331191d，CHANGELOG 定稿+version bump 1.0.10+APM 记忆入库）。门禁：test:v4-perf 全段 0 fail（**注意：Node 默认堆在本机内存紧张时会 OOM exit 134，须 NODE_OPTIONS=--max-old-space-size=4096 重跑，非测试失败**）、全仓 lint 74w/0e 基线（新入库的 docs/iterations cache e2e driver 需写干净，3 处 warning 已修）、typecheck-desktop-full OK、architecture 0 violations、magic-context 未涉及跳过。CI Release Desktop run 38470464610 成功，10 资产（Linux deb/pacman/AppImage/rpm + mac arm64/x64 dmg+zip + win exe+zip），Release 正文=CHANGELOG 1.0.10 段（新增/变更/修复三段）。gh CLI 注意：gh 在本仓解析默认 repo 为 zai-org/ZCode（上游），操作 bloodycrownD/oh-my-zcode 必须 -R 显式指定。


【v1.0.11：引导物化修复 + doom loop 检查（2026-10-14，tag v1.0.11 @ 58edba24，main 已 ff-merge 推送，分支 fix/queue-guide-materialize 4 commit）】

- **引导物化修复（04a91581，用户实测 v1.0.10 后报障）**：排队项切「引导」后 UI 显示等待引导但**注入从未发生**——根因：queue 车道项只存在于事件/投影（enqueueDeferredInput 不写 activeTurn.pendingInputs 内存），而两个注入点（turn-tools.ts:467 tool 边界 + turn-stop:195 content 收口）只扫内存 pendingInputs；切换只改投影 delivery，注入点永远看不见，turn 结束被 autoDrain 当普通输入跑掉。修复：setPendingInputDelivery 的 held 回落路径把项**物化**进内存 pendingInputs（materialized 标记），切回 queue 反物化移除；reserved 项拒绝物化（与 sendQueuedNow promotion 互斥）；带附件项跳过物化（投影缺完整附件载荷，已知限制登记 CHANGELOG）。验证：core 14/14（含物化/反物化/附件跳过/reserved 四新例）+ e2e S5 injected=true 且模型当轮响应。用户语义拍板：注入边界=当前 step（tool call 或 content 输出）结束即注入，非「下一 tool call 后」。
- **doom loop 检查（86f83cce + aba261c2 阈值拍板）**：参考 opencode（processor.ts：连续 3 个已完成 part 同工具+同输入→permission.ask("doom_loop")）。用户拍板修正阈值：**事不过三——容忍 3 次重复，第 4 次调用执行前拦截**（与软提醒阈值 3 成梯度：第 3 次文字提醒/第 4 次硬拦）。实现：tool/executor/doom-loop-gate.ts（executor 会话级闭包状态；streak 连续性单游标防 A,A,B,A 误判——opencode #25254 教训；ask 走既有权限卡链路 UI 零改动，ruleId=doom_loop；deny/无客户端（自动 reject "No permission client configured"）降级拒绝——防 #18108 子代理 ask 死锁；拒绝结果 turnControl.reason=doom_loop 停整轮复用 stopTurnAfterResult；sessionPermissionUpdates 驱动会话级豁免）。配置 ModelAnomalyGuardConfig.doomLoopCheck=ask(默认)|deny|off。**行数红线插曲**：permission-flow 414>400，把 ask race 内芯（racePermissionResponders 调用+hook modify/recheck 段）抽至 permission-responder-race.ts 的 runPermissionAskRace（行为不变）。gate 单测 9/9。
- 门禁：test:v4-perf 全绿（NODE_OPTIONS=--max-old-space-size=4096 pnpm run test:v4-perf——**直跑 node .bin/vitest 不行（.bin 是 shell 脚本非模块）**）、lint 74w/0e、typecheck:desktop-full + cli 27 包 0 错、architecture 0 violations、core 单测 23/23。
- e2e 建议（未跑，用户选择直发）：真机验证 doom 门=让模型连续读同一文件 4 次，期望第 3 次软提醒、第 4 次弹卡、拒绝后停轮。
