---
date: 2026-10-25
agile_trace: true
---

# mc-tag-leak-to-bubble 实现规格（SPEC）

## 根因 / 方案摘要

MC 的自标注在 v1.0.20 既没在落库前剥离，也没在任何消费端剥离。方案是在 `@zcode/shared` 新建一个与 MC 包同源的剥离模块（shared 是基础层，不能反向依赖 `apps/zcode-cli/packages/magic-context`），落库与消费两端统一调用。

## 变更点清单

| 文件 | 改动 |
|---|---|
| `packages/shared/src/text/magic-context-tag.ts` | 新建（118 行）：`stripMagicContextTagPrefix` / `stripMagicContextTagNotation` / `hasMagicContextTagNotation`，正则与 MC 包内 `tag-content-primitives.ts` 逐字同源 |
| `packages/shared/src/index.ts` | 导出新模块 |
| `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts` | 落库写入前剥离（text part） |
| `apps/zcode-cli/packages/core/src/runtime/methods/cancelled-stream-persistence.ts` | 中断落库同样剥离（**本次补的缺口**：v1.0.26 漏修，用户 stop 后仍会把标记写进库） |
| `apps/zcode-cli/packages/bootstrap/src/session-transcript.ts` | CLI 恢复会话 transcript 剥离 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts` | 会话列表预览剥离 |
| `packages/ui/src/v4/ConversationRowView.tsx` | 气泡正文（visibleText）、复制按钮、轮尾合并复制三处剥离；**用户消息复制未动（`:1381-1385`）** |
| `packages/ui/src/v4/conversationFindIndex.ts` | 会话内搜索目标文本剥离（保证高亮偏移落在实际渲染文本上） |
| `apps/zcode-cli/packages/bootstrap/scripts/test-magic-context-tag-strip.mjs` | 新增回归脚本（取自 `05508750`） |

## 详细改动说明

- 剥离函数同时处理单前缀与重复前缀；只在 assistant 文本上调用。
- 落库剥离会顺带 trim 首尾空白（与上游实现一致），不影响 markdown 渲染。
- 新增三个导出中 `stripMagicContextTagPrefix` / `hasMagicContextTagNotation` 目前只有测试消费，保留以对齐上游语义。

## 测试策略

### 测试用例

- `test:magic-context-tag-strip`：10 例，覆盖单前缀、双前缀、正文中间标记、精度守卫（`§5.1` / `99 files` 不动）、空串与纯标记。
- `test:magic-context`（turn-transform）：23/23，确认 MC 打标语义未变。
- UI 侧无 jsdom，气泡/复制落点以字符串形状断言 + 手工验收为准。

## 风险与回滚方案

- 风险：正则会删掉 assistant 正文里合法出现的 `§12§` 形态引用（上游既有语义）；若要保留需改语义并同步上游。
- 风险：落库剥离后历史数据仍带标记，因此消费端剥离不能省。
- 回滚：只涉及新增模块与调用点，revert 单个提交即可恢复旧行为。
