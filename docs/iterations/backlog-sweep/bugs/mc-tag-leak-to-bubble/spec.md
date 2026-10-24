---
date: 2026-10-24
agile_trace: true
---

# mc-tag-leak-to-bubble 实现规格（SPEC）

## 根因 / 方案摘要

**根因**：MC 的 `stripPersistedAssistantText`（上游 `tag-content-primitives.ts:95-104`）在 omz 是**零调用死码**——函数随 vendored 包搬了进来，但「持久化边界调用」这条链（上游 `text-complete.ts:27-35` 的 `experimental.text.complete`、Pi 的 `strip-tag-prefix.ts:23-57`）在 omz 不存在，因为 omz 的 MC 接入形态是 turn transform 端口而非 OpenCode/Pi 插件 hook。于是模型自己写出的 `§N§` 前缀直接落库、直接上屏；MC transform 的 `prependTag` 又会打一层，形成 `§N§ §N§`。

**方案**（用户拍板：落库剥 + 消费端剥，不回刷历史库）：

1. 剥离语义集中到 `@zcode/shared`，MC vendored 包零改动（保持 MC 可替换、可升版）。
2. 落库前剥一份 → 新数据不再带前缀。
3. 五个消费端读时剥 → 9,522 条历史立即干净，且不动数据库字节。

**为什么不在存储层整体清掉 `§`**：`§N§` 打标是 MC 自己的身份与缓存锚（`magic-context-turn-transform.ts` 的 identity guard、`source: real_user` 气泡身份、cache 前缀都依赖它）。本次只剥「模型抄进正文」的可见前缀，MC 的镜像与账本保持原样。

## 变更点清单

| # | 文件 | 改动 |
| - | ---- | ---- |
| 1 | `packages/shared/src/text/magic-context-tag.ts`（新） | 逐字搬上游正则，导出三个函数 |
| 2 | `packages/shared/src/index.ts` | barrel 导出两个剥离函数 + 一个判定函数 |
| 3 | `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts` | 落库 text part 处套 `stripMagicContextTagNotation` |
| 4 | `packages/ui/src/v4/ConversationRowView.tsx` | `visibleText` 外层剥；行级复制与 `ConversationAssistantTextActions` 内的复制文本剥 |
| 5 | `packages/ui/src/v4/conversationFindIndex.ts` | assistant 目标文本剥（否则高亮偏移整体错位） |
| 6 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts` | 会话预览先剥再 `slice(0,120)` |
| 7 | `apps/zcode-cli/packages/bootstrap/src/session-transcript.ts` | CLI transcript 正文剥 |
| 8 | `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-tag-strip.mjs`（新） | 10 个用例 |
| 9 | `apps/zcode-cli/packages/bootstrap/package.json` | 登记 `test:magic-context-tag-strip` |

提交：`0d35063c`（shared 函数）、`05508750`（落库 + 消费端 + 测试）。

## 详细改动说明

### 1. 共享剥离模块（`packages/shared/src/text/magic-context-tag.ts`）

正则与上游 `tag-content-primitives.ts` 逐字一致，不做「顺手优化」：

- `TAG_PREFIX_REGEX = /^(?:§\d+§\s*)+/` —— 正常前缀，可叠加。
- `MALFORMED_TAG_PREFIX_REGEX = /^(?:§\d+">§(?:\d+§)?\s*)+/` —— 旧版舱位标签残留的 hybrid 形态。
- `DANGLING_TAG_PREFIX_REGEX = /^(?:§\d+(?!\.\d)[^\s§\w.]?\s*)+/` —— 悬空开标记（`§103012$`、`§11865ҩ`），整体吃掉，避免只剥 `§` 留下孤儿数字。
- `(?!\.\d)` 精度守卫：`§5.1` 是章节引用，不是标签。
- 循环最多 8 轮直到不再变化（上游同款，处理 cargo-cult 累积形态）。

导出：

- `stripMagicContextTagPrefix(value)` —— 只剥开头，用户气泡用。
- `stripMagicContextTagNotation(value)` —— 完整剥离（前导 → 全局 `§N§` 对 → malformed → dangling → 残余 `§` → `trim`），助手文本用。
- `hasMagicContextTagNotation(value)` —— 判定/调试用。

### 2. 落库剥离（`turn-model-step.ts`）

只在构造**持久化** text part 处剥：`text: stripMagicContextTagNotation(state.modelResponse)`。流式 `state.modelResponse`、`text_delta` 下发、`ModelComplete.content` 保持原文，避免影响 stream 语义与 MC 的 transform 输入。

`message-persistence.ts` 核查后未改：该文件里两处 text part 写入分别是 `persistUserPrompt`（用户输入）与 `persistSyntheticUserNoticeForSession`（user-role 合成提示），都不是助手正文（钦定档「无清洗需求的分支不要动」）。

### 3. 消费端剥离

- **气泡**：`visibleText` 在 `projectAssistantCodeComments` 分支外层统一剥（注释投影逻辑不变）。
- **复制**：行级复制 `text={stripMagicContextTagNotation(copyText ?? row.text)}`；整轮合并复制的入口 `ConversationAssistantTextActions` 内先剥再交给 `CopyRowAction`；`navigator.clipboard` 内部不做处理。用户消息行的复制**不剥**，避免吃掉用户正文里的合法 `§`。
- **会话预览**：先剥再 `slice(0,120)`，避免前缀挤占预览预算。
- **会话内查找**：`assistant` 目标文本剥后与 `visibleText` 同源，否则高亮偏移会因前缀长度整体错位。
- **CLI transcript**：正文拼接结果剥。

## 测试策略

### 测试用例

新增 `test-magic-context-tag-strip.mjs`（10 个，全 PASS）：

1. `§3017§ §3017§ 直接回答` → `直接回答`（用户报告形态）
2. `§42§ Hello` → `Hello`
3. `99 files are located in folder zzz` / `2024 roadmap` / `1. do this now, 2. do that next` 原样
4. `答完后 §12§ 继续` → 正文（不含 `§`；上游不折叠空白，双空格是逐字对齐的预期）
5. 畸形 hybrid `§15298">§ hello` → `hello`；悬空 `§103012$ hi` → `hi`
6. `stripMagicContextTagPrefix` 只剥开头，正文中间的 `§12§` 保留
7. `hasMagicContextTagNotation` 有/无
8. `@zcode/shared` barrel 导出可用
9. core 落库点使用同一函数的源码形状断言
10. 四个消费端落点（UI 展示/复制/查找、会话预览、CLI transcript）使用同一函数的源码形状断言

回归与门禁（本机复跑结果）：

- `test-magic-context-turn-transform.mjs` 23/23 PASS
- `test-mc-entry-identity-guard.mjs` 4/4 PASS
- `pnpm exec tsc -b packages/ui` 零 error
- `apps/zcode-cli` 下根 turbo typecheck 27/27 successful

## 风险与回滚方案

**已知未覆盖（按钦定档保留，登记待办）**：

1. **实时流未剥**：`text_delta` / `ModelComplete.content` / `state.modelResponse` 仍是原文。v4 气泡由 `visibleText` 兜住，但其它实时消费方（系统通知、非 v4 旧界面、hook 输出）仍可能短暂看到 `§N§`。
2. **历史库未回刷**：9,522 条只在登记的消费端被剥；会话标题自动生成、服务端搜索、团队导出等直接读 part 原文的路径仍会带前缀。
3. **其它落库路径未剥**：`cancelled-stream-persistence.ts:45`（取消流的助手正文）、`control-only-turn.ts:172`、`session-fork.ts:435/544`（fork 复制原文）。
4. **CLI transcript 的 `parts` 分支**：本次只剥 `content` 分支，`hasStructuredParts` 为真时 `parts` 内的 text 段仍是原文。
5. **行为差异**：`stripMagicContextTagNotation` 末尾 `trim` 是上游语义，展示/复制的首尾空白会被裁掉。

**回滚**：两个提交互相独立，`git revert 05508750` 即可退回「只显示原文」的旧状态；`0d35063c` 只新增文件与导出，保留无副作用。

**后续（独立评估，不在本 bug 范围）**：MC 与 omz 的耦合面梳理（turn transform 端口、提示词段、工具描述、双投影、显示边界五处收敛为一个适配器接口，flag off 时零行为）——另立 feature 项。
