---
date: 2026-10-05
dependency: []
---

# 桌面端长会话性能优化 PRD

## 背景

桌面 Electron 是 omz 的核心用户面。用户反馈：单会话长时间使用后卡顿，消息越多越明显，侧边消息缩略导航（`ConversationTurnNavigator`，会话区左侧的 turn 摘要 rail）在消息多时最卡；对照项目 novel-master 同场景反而不卡。

brain-storm 阶段 4 个并行子代理 + PRD 阶段 1 个补充子代理的探索结论：

- 协议层设计正确（60 行尾窗快照 + 游标分页 + 增量 delta + 服务端合并），卡顿根因集中在渲染进程的实现细节：
  1. 宽屏（容器宽 ≥864px）自动 `loadAllOlder` 把全量历史灌进 renderer，`rows.window` 只增不减、无上限；
  2. 每条流式 delta 对整个窗口做 O(N) 不可变拷贝（`findIndex` + `[...window]`），流式期每 150ms 一次，整体退化为 O(N²)；服务端已有可变累加器方案但 renderer 未使用；
  3. `liveNowMs` 每秒 tick（仅为「工作中 N 秒」文案）击穿 `renderUnits` memo，每秒全量重建 renderUnits 与导航条目（turn 摘要对全文做正则清洗后才截断到 220 字符）；
  4. 滚动每帧 O(N) 条目索引重建 + `querySelectorAll`/`getBoundingClientRect` 强制 reflow；
  5. shiki 代码高亮 `tokensCache` 无淘汰，renderer 内存只增不减。
- 度量现状：只有内存维度诊断（`[memory]` 日志 + 7 个注册计数器），完全没有「卡」的度量手段——无 performance.mark、采样句柄无 UI/命令出口、v4/ 下 200+ 文件零测试、无性能基线。
- novel-master 不卡的原因是结构性的（流式期间消息数组引用不变 + 工具输出全文不进 DOM + 没有该导航组件），非架构更优，仅作设计参考。

探索详情存于 `docs/apm/memory/20261005-desktop-long-session-perf.md`。

## 目标（含成功指标）

总目标：长会话（数千行消息）下，滚动、流式输出、会话内交互不再随会话时长/消息量劣化。

成功指标（口径已拍板：相对基线改善，度量基建先行）：

1. 建立可复现的长会话性能采样手段，并留存**改动前基线**（流式期间主线程长任务次数/耗时、滚动期间长任务、renderer 内存计数三类指标）。
2. 流式输出期间主线程长任务次数/耗时相对基线下降至少一个数量级（以基线报告实测值为准回填验收记录）。
3. 同规模会话持续使用时，renderer 无界缓存类内存计数（`shiki.tokensCache` 等）趋于有界，不随使用时长增长。
4. UI 交互响应不随会话历史长度线性劣化（长会话滚动与短会话滚动的采样指标同量级）。

## 用户与场景

- 用户：omz 桌面端重度用户；桌面 Electron 是唯一重要用户面（TUI 不在目标内）。
- 场景：
  1. 数千行消息的会话中滚动浏览、用侧边导航定位历史 turn；
  2. AI 流式输出期间同时滚动或操作界面；
  3. 长时间挂起后继续使用的会话。

## 范围

### 包含范围

- **P0 数据层主干**：流式 delta 应用路径消除 O(N) 全量拷贝；宽屏 `loadAllOlder` 改造——turn 导航目录不需要全量消息正文驻留 renderer，历史正文按需加载。
- **P1 渲染层热点**：`liveNowMs` 与 renderUnits 解耦（秒级计时不再触发会话级重算）；滚动路径 O(N) 索引重建消除；强制 reflow 消除。
- **P2 内存护栏**：`tokensCache` 加容量上限与淘汰；turn 摘要截断前置（先截断再清洗）。
- **性能度量基建**：性能采样脚本 + 指标出口 + 改动前基线留存 + 改动后对比报告。

### 不包含范围

- novel-master 仓库的任何改动（仅作设计参考）。
- TUI 侧性能。
- v4 协议 wire 格式的破坏性变更（允许新增只读投影类 RPC，须向后兼容）。
- 消息流 UI 的视觉/交互改版。

## 核心需求（3-7 条）

1. 【度量】提供可复现的长会话性能采样：能输出「流式期间主线程长任务、滚动期间长任务、renderer 内存计数」指标，支持改动前后对比，基线在改动前留存。
2. 【P0-数据】流式 delta 到达时，消息窗口更新成本与窗口大小解耦：不再每条 delta 对整个 `rows.window` 做全量拷贝与线性查找。
3. 【P0-数据】侧边 turn 导航目录的获取不再要求全量消息正文进入 renderer；上滚加载更早历史的行为保持可用。
4. 【P1-渲染】运行中 turn 的秒级计时刷新只影响计时文案所在局部，不触发 renderUnits/导航条目的会话级重建。
5. 【P1-渲染】滚动期间不出现每帧 O(N) 的条目索引重建与 DOM 全量查询/强制 reflow。
6. 【P2-内存】renderer 内消息相关无界缓存（代码高亮 token 缓存）具备容量上限与淘汰策略。
7. 【回归】现有能力不回归：虚拟滚动、上滚分页、turn 导航交互（hover 摘要、点击定位）、分享选择流程。

## 验收标准

- 度量基建：
  - Given 度量脚本与数千行消息的会话样本，When 执行采样，Then 输出三类指标报告，且改动前基线已留存（文件入库或在验收记录中引用）。
- 数据层（P0）：
  - Given 长会话 + 流式输出进行中，When 采样主线程长任务，Then 次数/耗时相对基线下降 ≥ 一个数量级（或按基线报告回填的明确阈值）。
  - Given 宽屏打开长会话，When 检查 renderer 驻留数据，Then 消息正文不全量驻留，且 turn 导航 hover 摘要、点击定位、上滚加载历史均正常。
- 渲染层（P1）：
  - Given 存在运行中 turn 且页面停留 60 秒，When 采样，Then 秒级 tick 不引起会话级重算（长任务/重渲染计数相对基线显著下降）。
  - Given 长会话中连续滚动 30 秒，When 采样，Then 滚动期间长任务相对基线显著下降。
- 内存（P2）：
  - Given 持续使用同一长会话并渲染大量代码块，When 观察内存计数，Then `shiki.tokensCache` 等计数保持在上限内，不随使用时长增长。
- 回归：
  - 根 `pnpm typecheck`、`pnpm lint`（零新增）、`architecture:check --changed` 通过。
  - turn 导航、上滚分页、分享选择流程按既有桌面验证方式（CDP 脚本）人工验证通过。

## 约束与依赖

- 门禁：根 `pnpm typecheck` / `pnpm lint`（oxlint，`max-lines: 400`）/ `architecture:check --changed`；仓库无统一 test 入口（AGENTS.md 约定以目标包实际为准）。
- `conversationProjectionStore.ts` 已 1300+ 行，改动时受 `max-lines` 约束，可能需要拆分。
- 涉及包：`packages/shared`（zcode-protocol-v4）、`packages/ui`（v4/）、`packages/desktop`（如需 RPC 通道扩展）。

## 非功能需求（业务/体验）

- 不改变用户可见的消息流交互与视觉——含侧边导航 hover 摘要文本内容不变（其内部生成顺序可优化，输出语义等价）。
- 度量/诊断能力保持低开销，不得因采样引入新的卡顿。

## 风险与待确认项

- **验收环境**：dev build 可用 CDP（9229）与 `[memory]` 日志；生产包 renderer 诊断日志默认 no-op——是否为生产留诊断开关，待确认（不阻塞 dev 验收）。
- **长会话造数方式**（`conversationTransportDelayE2E` seam 注入 vs 真实会话样本）在 spec 阶段裁定。
- delta 应用路径改可变更新涉及 `apply.ts` 顶部「已发布快照不可被后续事件篡改」协议不变量的取舍，具体方案在 spec 阶段裁决。
- 「下降一个数量级」的精确判定线在基线报告产出后回填验收记录。
