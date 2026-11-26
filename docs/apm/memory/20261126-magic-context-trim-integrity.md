# 20261126 magic-context-trim-integrity

## 需求来源

用户口述（2026-11-26），在 v1.0.37 发布完成后修复 magic-context-fork-inherit 迭代中发现的三个既有问题，走 spec → check → dev → cr → e2e 流程：

1. 长会话发给模型的请求里没有 system prompt：裁前缀对头部整体裁，没有豁免。
2. 折叠后的条目再次进入 transform 会打乱工具调用与结果的配对，模型拒收；续写和重试路径会走到，父会话自己也能复现。
3. 长会话多次重启后 tag 的坐标不可靠，ctx_expand 取回的原文可能已经不是原来那条。

背景见 docs/iterations/magic-context-fork-inherit/spec.md 末尾「实现过程中发现的既有问题」。

## 轮次

- 2026-11-26 需求读取：三个问题都是 fork 继承迭代中用真实数据复现出来的既有缺陷，与 fork 继承本身无关；目标产出是一份可确认的 spec。v1.0.37（fork 继承）已发布：Release Desktop 成功，GitHub Release 带 10 个三平台资产。
- 2026-11-26 探索（三份只读报告，system prompt 一份因用量上限中断后重派）：
  - 工具弧：折叠后的条目再次进入 transform 只有一个生产者——core 的输出续写路径把 transform 的输出写回了 turn-local 请求状态（turn-model-step.ts:574）；正常的工具循环和重试都在全量历史上重跑，位置稳定所以安全。推荐修法是 core 不再写回折叠条目（约十行，不感知 magic-context）。
  - tag 坐标：tag 身份是位置字符串且命中时不比对内容，重启后前缀长度一变就整体错位，并把新消息的文本写进旧 tag 的原文；ctx_expand 的 tag 模式按位置 id 读当前条目（不读存的原文），所以直接取到错位的消息。落库剥章已在主代码修复（1612ba10），库里的带章行是存量。推荐「命中时做内容校验」为主、长期做稳定身份；与编辑重发「同位置换内容」的既有语义冲突，需用户拍板。
  - system prompt：裁前缀的两条路径（无缓存切片与 trimToPreparedPrefix 的两个分支）对头部无条件整体裁；唯一豁免只认无 id 的 system，而 ZCode 投影给 system 条目也发了 mc 序号 id。上游把 system prompt 放在消息数组之外（session_meta 有 system_prompt_tokens 列，ZCode 从不写），所以上游没这个问题。推荐在包内豁免「数组开头连续的带 id system 段」，单文件约 60-90 行，与 LKG 字节记账自洽；宿主补回会让 LKG 输入指纹和 token 估算失配，core 补回有双 system 风险。唯一硬编码「system 被裁」的测试断言在 test-magic-context-fork-inherit.mjs:469-472。system-prompt-guard spec 第 179 行的论断来自 tag 清扫集合，当时没考察过位置切片。
- 2026-11-26 spec 落盘（待用户确认）：docs/iterations/magic-context-trim-integrity/spec.md。三项修复互相独立、均无 schema 迁移：裁前缀在包内豁免开头的带 id system 段（四个切片点）；core 删除输出续写路径里把折叠条目写回请求状态的那一行；文本 tag 位置命中内容不符时按内容认领或判漂移（只挪位置键的墓碑化，不改 status），区分漂移与编辑重发的信号是「旧原文是否被本 pass 另一个 part 以内容命中」，ctx_expand 的 tag 模式优先返回存量原文。复述闸门提的两个选择（前缀范围、tag 漂移档位）用户未答，先按推荐项成文。
- 2026-11-26 文档审查：第 1 轮（1 全局 judge + 3 模块审查者）No-Go，5 个 P0、7 个 P1，全是文档问题、技术方向被核对通过。已直改 spec：裁头部的切片点由四处补成五处（补上缓存回放分支），「跳过条数」改为显式记录被移除的消息 id 以免把留在请求里的 system 的 tag 误标成已压缩；tag 认领改为「预扫描出计划、再就地执行」，拒绝位置命中一律墓碑化，认领扩展到位置未命中的末端消息，只认领 active 且非 system 的候选，围栏接受原键或墓碑键；续写补 core 层最小用例。待第 2 轮审查。
- 2026-11-26 文档审查第 2 轮：全局 judge Go、续写模块就绪（并实测 tsx 能直接加载 core 源文件、假运行时约 12-14 个成员），system prompt 与 tag 两个模块各 1 个 P0。已修：接缝处的隐藏集合也按「前 N 条」切片，必须与压缩边界切片一起改用显式的被移除消息列表（上一版写成「不受影响」是错的）；tag 的计划必须先于位置解析执行，漂移分支要屏蔽同消息内的回退匹配，否则会抢占兄弟文本片段的 tag（补了同消息双文本片段用例）；认领候选限定为文本型、active、role 非 NULL 且非 system。第 3 轮审查在跑。
- 2026-11-26 文档审查第 3 轮：system prompt 模块就绪；tag 模块剩 1 个 P1（索引签名拼不出认领判据的元数据）；全局 judge No-Go，两条真问题——删掉 requestEntries option 后测试却没有入口传折叠产物（文档自相矛盾）；system prompt 保留在请求里之后，它孤悬在打标窗口最前，重启平移后会经「编辑重发」分支把 system prompt 写进被裁区域旧对话 tag 的原文并改其 role（今天 system 行不在打标窗口，是修复新暴露的损坏路径）。已修：core 用例改经 options.messages 注入哨兵对象；新增「入站 system 行」专门规则（位置命中的 tag 只有自身 role 是 system 才沿用，否则墓碑化并分配新号）和 T-T9 用例。第 4 轮审查在跑。
- 2026-11-26 文档审查第 4 轮：全局 judge Go、tag 模块就绪、system prompt 模块上轮已就绪——三个模块首次全部通过，无 P0/P1。随后补了 8 条 P2：system 行分支明确「跳过 resolver.resolve 直接 assignTag」并扩到空白 system part（避免 scoped fallback 把桶里上一代 synthetic head 的旧 tag 重绑上来）；inbound 只计带 contentId 的 part；listTagRowsBySession 带 entry_fingerprint；补了两张时序图；专门规则的触发条件改为枚举（fork 子会话 / system 段条数变化 / NULL-role 存量行），不是每次重启都触发。第 5 轮全局终态认证在跑。
- 2026-11-26 文档审查第 5 轮（终态认证）：全局 judge Go（execute-ready），P2 修订与次序图、T-T9、:908 的无条件 role 盖章路径自洽，无新问题。spec 共 5 轮审查（累计修掉 7 个 P0、7 个 P1）。停在开工闸门：等用户确认 spec 与两项选择（前缀范围、tag 漂移档位），未确认前不动代码。
- 2026-11-26 开发：用户确认开工（防腐层保留；子代理用 GLM-5.3-Flash；两项选择按推荐项）。分支 fix/magic-context-trim-integrity，基线 30209b79（spec 与记忆文件）。开发 DAG v1：wave0 并行实现三模块源码 → wave1 补两处测试 + 真实数据 e2e 脚本 → 每模块一个只读功能小检 → 强档检查（magic-context test:all、根 lint、architecture:check、两套 typecheck、真实库只读拷贝 e2e）。提交由工作流脚本按节点文件清单带 pathspec 做，子代理不碰 git。注意：这台 Windows 上不经 shell 直接 spawn pnpm 会 ENOENT/EINVAL，工作流里要写成 cmd /c pnpm。工作流运行 ID dwfrun-9b72191a-ad5e-4927-96f9-c62260f39966。
- 2026-11-26 dev 工作流跑完（1h31m，约 7655 万 token）：三模块实现 + 测试 + 功能小检（tag 第 2 轮过）+ 强档全绿，提交 caeefaaa..ab2dc2c8（含还原子代理越权改的 apps/zcode-cli/package.json typecheck 脚本——`turbo run typecheck` 在 cmd 下报「turbo 不是内部或外部命令」，真实结果待用可用的调用方式复验）。真实数据 e2e 26/33：问题一在真实库上成立（V1 请求以 system prompt 起头、条数仅 +1、摘要块与账本完好、ctx_expand 30/30）。失败 7 条两类：(a) T-E3.2 存量原文被改写——会话 ca98e4a2（裁剪形态）1/1445（窗口最边缘那条：S(T) 掉出窗口后与编辑重发无法区分）；会话 65700b26（未裁剪形态，e2e 按 tags 数选中了 fork 子会话）92/662——**spec 漂移判据「S(T) 还活在入站窗口」的盲区：已折叠消息在入站里是 [dropped §N§] 占位符，原文不在入站，于是被当成编辑重发覆盖**；(b) T-E3.4/5 平移后请求有孤立工具调用——位置裁剪从调用/结果中间切开是既有行为（V0 对照基线就是 弧=0/1），孤立调用会被模型拒收且裁点每轮相同。两者都是 spec 缺口，需回 spec：问题三判据改为对折叠 part 用占位符里的 §N§ 做身份、对活跃 part 用整体平移证据；弧完整性另立项或并入。下一步：带 MC_TRIM_E2E_KEEP/DUMP 重跑取现场实证。
- 2026-11-26 现场实证（e2e 现场 zcode-mc-e2e-trim-axG3XG，用完可删，5.3GB）：spec v1 漂移判据在真实库只能识别 2.0%（fork 子会话 104/5118）与 4.1%（最长会话 94/2306）；主因是重复样板让「原文全库唯一持有」不成立，其次是裁剪形态下窗口外 tag 的原文不在请求里（折叠占位符只占个位数——打标器拿到的是折叠前的数组，transform.ts:2103-2115，所以「用占位符 §N§ 做身份」不成立）。spec 已做 v2 修订：问题三新增（b′）整体平移层——先从数据识别窗口整体平移 d（候选 = 唯一持有者位置差，计分 = 平移位置上原文相等，≥3 成立），成立时按「位置 − d」找回真身（相符则保号保 status；不符/落空拿新号，不覆盖任何原文），d=0 时 v1 规则不变；不能用「分不清就拿新号」做默认（未裁剪会话里等于解折叠数千条 dropped）。另：「位置裁剪劈开工具弧」列为既有已知限制、建议单独立项，T-E3 弧断言改观察项；e2e 选会话改为裁剪形态。两份只读审查（全局 judge + tag 模块）在跑。
- 2026-11-26 spec v2 审查闭合：tag 模块终态复核抓到我在 T-T8 上的处方是错的（删掉原文为 P 的 part 会同时删掉 v1 漂移分支的前提；正确做法是保留在入站、从 mc3 挪到 mc5）；全局 judge 终态 Go，剩余 P2 全是 v1 落地后的陈旧行号（已在 spec 问题三开头加说明，以函数名为准）。教训：改夹具压低平移计分时，要同时核对 v1 各分支的前提是否还在。spec 提交 23adbad0。dev 工作流已 Amend 启动 v2（新 run 接替 dwfrun-d486f014，v1 的三个模块与检查从缓存导入）：tag 判定层改造 → e2e 脚本按 v2 改写 → 真实库硬闸门（存量原文零改写）→ 换人功能小检 → 全量检查；turbo 闸门改为 pnpm --dir apps/zcode-cli exec node ../../node_modules/turbo/bin/turbo run typecheck（cmd 下直接 turbo 找不到）。
- 2026-11-26 dev 收尾：v2 工作流的真实库 e2e 抓到问题一修复的拒发缺陷（3577a02f 修）：裁前缀豁免 system 段后，classifyAbsentBoundary 的 firstPersistedLiveId 拿到保留的 system 行 mc1，摘要边界永远排不到它前面 → refused → 请求不裁，是否拒发只取决于估算口径（真实库一个会话侥幸发出、另一个估到 100 万被拒）。修法：该判定跳过开头 system 段；回归用例 T-S8（bootstrap/scripts/test-magic-context-fork-inherit.mjs）。教训：改裁剪形态时，不只查「切片点」，还要查所有以「数组第一条消息」为参照的判定。干净拷贝 e2e 全部断言通过（f71cd2d0），两大会话存量原文零改写 0/2354、0/1936。E2.4 口径改为「没有 system tag 新被置为 compacted」（拷贝源里本来就有 3 个存量 compacted）。分支 fix/magic-context-trim-integrity：30209b79 之上共 12 个提交，未合并；cr 与 Electron 真机未做。
