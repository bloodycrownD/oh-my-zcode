# AskUserQuestion 用户回答的 v4 投影（ask-user-question-display-answers）

## 背景

AskUserQuestion 的执行链路分两段：

1. **模型段**：handler（`core/src/tool/handlers/ask-user-question.ts`）返回结构化输出
   `{questions, answers, annotations?}`，`formatModelContent` 把它格式化成
   `User has answered your questions: "问题"="回答"` 文本回给模型。这一段工作正常。
2. **展示段**：桌面/Web UI 的 AskQuestion 工具卡（`ui/src/ToolCallBlocks/renderers/ask-question.tsx`）
   通过 `readAskUserQuestionAnswers`（`ui/src/lib/askUserQuestion.ts`）从工具行的
   `output` / `input` / `raw` 里找结构化 `answers`，找不到就回退「未提供回答」。

## 缺陷链路（本 spec 修复）

v4 协议下展示段的 `answers` 在传输链上被文本化，从未到达 UI：

1. `ToolResultPayload.content` 只有 `formatModelContent` 后的纯文本；
   handler 的结构化 `answers` 不进事件 payload 的任何字段。
2. `buildToolOutput`（`bootstrap/src/zcode-protocol-v4/projection-rows.ts`）把
   `result.content` 包成 `{text}`；`toolCallRowAdapter` 又只桥接 `row.output.text`
   到旧形态 `TaskChatToolCall.output`。
3. UI 侧解析全部扑空：文本不是 JSON、`input` 是模型原始输入（无 answers）、
   `raw.rawOutput` 还是同一段文本 → 工具卡显示「未提供回答」。
   提问侧（pendingInteraction 的结构化 questions）是通的，缺的只是回答回传。

## 规则

1. **唯一事实源**：AskUserQuestion 的用户回答以 handler 输出的 `answers` 字段为
   唯一事实（键为问题全文，值为用户选择的 label 或自定义文本；空对象 = 用户零作答）。
   不允许 UI 或投影层从 `formatModelContent` 文本反向解析——该格式是模型通道契约，
   不属于展示层。
2. **承载通道**：沿用 tool result 的 display 通道（CUA、file_diff、task_output 同款）。
   executor 在 `createToolResultDisplay` 为 `AskUserQuestion` 派生
   `{kind: "ask_user_question", answers}`，随 `ToolResultPayload.display` 下发；
   持久化进 tool part 的 `metadata.display`，冷恢复经 `transcript-hydration` 重放同事件。
   实时与冷恢复共用 `onToolCallResult` → `buildToolOutput`，无第二份投影。
3. **两侧 union 同步**（既有约束重申）：contracts 的
   `toolResultDisplayPayloadSchema`（zod v3）与 shared v4 的
   `toolResultDisplaySchema` / `toolCallDisplaySchema`（zod v4）必须同时收编
   `ask_user_question` 成员；`toProtocolToolCallDisplay` 白名单同步放行。
   任一侧缺失都会让 display 整块被 strict 校验剥掉，静默退回旧行为。
4. **UI 桥接**：`toolCallRowAdapter` 在 `display.kind === "ask_user_question"` 时把
   `answers` 桥接进旧形态 `output`（`{answers}` 对象），ask-question renderer 的
   `readNestedAskUserQuestionAnswers` 既有解析直接命中，不改渲染器。
   `answers` 为空对象时维持「自动继续」（autoContinued）文案语义。
5. **模型段零改动**：`formatModelContent` 输出格式与 tool result 预算策略不变；
   display 是展示投影，不进模型上下文。

## 事件顺序

```
handler 完成（output 已过 OutputSchema 校验）
→ createToolResultDisplay 派生 display（同一 tick，无异步窗口）
→ emitToolCallResult(ToolResultPayload.display) ─┬→ 实时投影 onToolCallResult
                                                 │    → row.upserted(output.display)
                                                 └→ tool part metadata.display 持久化
                                                      → 冷恢复 replay ToolCallResult（同 payload 形态）
```

幂等性：display 是纯函数派生，重放/重投影产生相同字节；无状态、无租约。

## 失败语义

- display 缺席或校验失败（旧 CLI、修复前的历史会话、answers 值超长被 strict 拒收）：
  UI 维持现状「未提供回答」，不报错、不解析模型文本。降级不回归。
- handler 失败（未收集到 answers 即执行）：走既有 error 路径，不产 display。

## 验收场景

1. 单选回答 → 工具卡显示所选 label。
2. Other 自定义输入 → 显示自定义文本。
3. 用户零作答自动继续（`answers === {}`）→ 显示「自动继续」而非「未提供回答」。
4. 关窗重开（冷恢复）后 1-3 依旧成立。
5. 修复前的历史会话（无 display）→ 显示「未提供回答」，无报错。
6. 模型收到的 tool result 文本与修复前逐字节一致。
