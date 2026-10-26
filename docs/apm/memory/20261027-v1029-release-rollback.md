---
date: 2026-10-27 02:30
title: v1.0.29 回滚发版，v1.0.30 修掉编辑重发旧文本（MC source 回放）
keywords: v1.0.29, v1.0.30, 回滚, 会话打开慢, 文件变更摘要缓存, 控制面同步, 编辑重发, magic-context, source_contents, tag 位置身份, 陈旧 dist
abstract: v1.0.28 的三条改造（编辑重发 A / MC 插件化 B / 会话打开 C）被用户否决——A 在真机仍复现原症状，还引入了「排队命令不再自动发送」的确定性回归。先以 v1.0.27 为基线发 v1.0.29，只带入 C 与两项性能修复。随后用探针查到「编辑后仍发旧消息」的真根因：Magic Context 的 tag 身份是位置、`source_contents` 在 rewind 后回放旧正文。修复后发 v1.0.30。
---

user:
首次加载还是卡啊，感觉区别不大，不过加载后就不卡了。这个你怎么修的？卡顿的原因不是我们之前认为的分页原因吗？

assistant:
我先纠正一个错位前提：我改的是「慢」，没修「卡」。慢是等，卡是界面不响应——两件事。分页也从来不是原因，查实的原因是子代理会话全量读、每条消息一次 artifact 读、全量投影升级三笔。先把这两类分开。

user:
不是卡，是慢。b，打开某个有大量聊天记录的会话，首次加载会非常慢。你不要乱探索了，浪费 token。

assistant:
认了。我之前那次 6.1s→1.3s 的收益是在**合成会话 + 沙箱库**上量的，你这个场景我从没量过。剩下的成本是随消息数线性增长的那些。我需要一个数据点：这会话大概多少条消息？首次打开几秒？关掉再开是不是立刻秒开？

user:
你打个日志，然后启动开发版本，我给你看。

assistant:
（加探针、重编 CLI、启动 dev 版，拿到 4 次真实打开的完整分段）
数据出来了：慢的全在 `mergeMs`（2.2 秒，占首屏 70%），rehydrate 只有 10~55ms、manifest 2~5ms。再拆一层，`mergeMs` 里 94% 是 `fileChangeSummariesMs`（2088 / 1838ms）。

user:
你看看。

assistant:
根因是 `buildColdFileChangeSummaries` 在冷开必经路径上按 checkpoint 逐个读 artifact 并反序列化整份快照。**而且这一项我在 v1.0.28 里宣布过「已优化到 15ms」——那是假绿**：当时跑在没复制 `~/.omz/cli/artifacts/` 的沙箱夹具上，量到的是 ENOENT 失败路径。

user:
一个问题，如果现在修的才是我想要的，那你上一轮修复的是什么玩意？有意义吗？是否会产生其他 bug？

assistant:
上一轮修的四条（子代理全量读、读写锁、删掉全量升级、尾窗+manifest）都是真问题、今晚都被数字证实有效——没有它们，今晚这两处根本看不见。但我错在**验收标准**：①在沙箱上量 artifact 读；②用 `uiViewReadyMs − hostPrepareMs` 当主判，把最大的那 1.2 秒控制面同步排除在视野之外。所以「v1.0.28 冷开达标」这个结论是假的。

user:
1.0.28改过UI吗？

assistant:
改过，17 个文件。最可疑的是 `conversationProjectionStore.ts`（+88）、`ConversationRowView.tsx`（+7）、`editDeliveryOutcome.ts`（新增 75）——「后端截断了、界面还留着旧消息」完全可能是这三处。

user:
我艹，A直接回滚吧，鬼知道你tm是不是造成了其他bug，这些bug甚至是隐藏的。你说的那些成本和这个一比完全不是问题，回滚后，再把当前分支的优化迁移到新分支上。

assistant:
（先试了逐个 cherry-pick B 的 14 个提交，撞上 B 系列内部「门面拆分后又删掉」的自我推翻，modify/delete 冲突；期间还因为工作树没提交、`git checkout -b` 失败而把 cherry-pick 打在了错的分支上，已 abort 恢复）
方法错了：逐个 pick 一个内部有自我推翻的系列必然在每个推翻点摔一次。正确做法是按系列整体落地。

user:
既然三个worktree都在，那不如直接回滚到1.0.27基线，然后本本次的优化放到1.0.27上，我对三个worktree的优化持怀疑态度。

assistant:
同意，而且这条更好：三棵 worktree 的 merge-base 都是 `f248c284`，所以 `diff(f248c284, C-tip)` 就是「不含 A 的 C」。最终按用户要求只回 v1.0.27 基线 + 本次两项修复。

user:
1.0.28改过UI吗？……那继续啊，停下来干什么。

assistant:
（在 `hotfix/v1027-perf`（tag v1.0.27）上落：迁移 0024 + 摘要缓存仓储/端口 + 冷开缓存优先+最近16条现算+后台补齐单飞 + 只读路径不等控制面同步。真机：`fc` 70~1918ms → 0~36ms，`hostPrep` 1241ms → 2ms。）

user:
好点了。

assistant:
但全链里 `test:model-live` 红了，报 `@zcode/shared/zcode-protocol-v4` 缺 `v4ConversationRuntimeReadyParamsSchema`。查证：源码侧导出在、tsx 下能取到；真因是 **`packages/shared/dist` 是 gitignore 的陈旧编译产物**，里面没有 C 新增的导出，而 bootstrap 的 dist 加载器要的正是这份 dist。从 C 的 worktree 恢复那份用当前源码构建的 dist 后 8/8 通过。

user:
（最终确认）发版。

assistant:
v1.0.29 已发：tag 推送，main 指向发布提交 `7bce4a69`（A/B/C 从 main 移除，原提交仍在三棵 spec worktree 与 reflog）。全链 `test:v4-perf` exit 0 / 466 条 / 0 红。CHANGELOG 写明两条：本版不带 A（编辑重发旧文本仍是已知问题）、性能两项的实测数字。

## 本轮沉淀

1. **假绿比没修更贵**：沙箱夹具缺真实数据时，量到的是失败路径耗时；v1.0.28 据此把 2088ms 判成 15ms。
2. **判据能把最大项排除在外**：扣掉 `hostPrepareMs` 的主判，让 1.2 秒控制面同步整整一晚没被看见。
3. **「只在队列空时复位 autoDrain」把偶发竞态换成了确定性卡死**：stop 且队列非空写 false，而复位点只有四个（删空/手动暂停继续/立即发送/rewind 级联），「用户新发一条」不在其中 → 之后永不自动放行。取舍做错的方向是：闸门该管「谁先起跑」，不该管「能不能起跑」。
4. **陈旧构建产物会长成假故障**：`packages/shared/dist` 源码改了不重建，症状是「源码有导出、运行期说没有」。
5. **回滚用整体 diff，不逐个 cherry-pick**：内部自我推翻的提交系列会在每个推翻点制造 modify/delete 冲突。

user:
恢复记忆，然后修「编辑框发送的消息是历史消息」。还是老方法先打日志。

assistant:
加了 UI/CLI/core 三层只读探针（文本指纹 + 落库查询），在 dev 版复现拿到证据链：UI 提交、CLI admission、rewind、起轮、落库全是新文本，只有 provider 请求的最后一条 user 是旧文本（带 MC 的 `§N§` 前缀）。根因不在执行侧，也不在 spec A 覆盖的五条不变式：Magic Context 的 tag 身份是位置（宿主投影 `mc<ordinal>`），`source_contents[tagId]` 缓存打 tag 前的原文，每个 pass 无条件回放；编辑重发（rewind）让同一位置换成另一条消息后，新正文被旧缓存覆盖。修复：`tag-messages.ts` 改为「持久原文与入站正文一致才恢复，不一致以入站为准并 upsert 纠正」；补 `test:transform` b5（同位置 `123→789`，断言 wire 为 `§N§ 789`，另加跨 pass 字节稳定对照）。

user:
没问题，合并后发布吧。

assistant:
清掉全部探针，只留 MC 修复 + 回归 + spec 根因修订。门禁：MC `test:all` 全绿、根 typecheck、根 lint 0 error、`test:v4-perf` REAL_EXIT=0（0 条 `not ok`、无 `# fail [1-9]`）。发现本地 `main` 还停在回滚前的 77b2ff2a，而 `origin/main` 已到 8669819a——先备份旧 main 到 `backup/main-before-v1030`，再把本地 main 重置到 origin/main 并 ff 合入修复。发布提交 `chore(release): v1.0.30`，tag `v1.0.30` 已推送，`main` 已同步；Release Desktop 工作流 in_progress（v1.0.29 的同一工作流此前 failure：mac 两 job cancelled、资产未挂上，需留意新版本结果）。

## 本轮沉淀

6. **「先打日志」要打到能区分层的粒度**：同一个症状在 UI/CLI/落库/模型四层各打一个文本指纹，一次复现就能判定是哪一层把文本换掉，避免再去猜触发器。
7. **文本长度不能当判据**：`123` 与 `321` 都是 3 字符，只打 `inputLength` 会把「模型读到旧消息」掩盖成「一切正常」，必须用 hash + 首尾片段。
8. **根治要找到「谁在覆盖内容」**：spec A 的五条不变式都在保证「哪条输入被执行」，而这次是 MC 在 provider 历史组装阶段用缓存覆盖正文——正确的问题不是「新文本有没有被发出」，而是「模型最终看到的正文来自哪里」。
9. **本地 main 可能落后于 origin/main**：发布后核对 `git rev-parse main origin/main`，不要假设本地分支跟着走了。
