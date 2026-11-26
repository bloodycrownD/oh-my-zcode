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
