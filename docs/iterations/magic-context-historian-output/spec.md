---
date: 2026-11-17
---

# magic-context historian 空输出误报修复（SPEC）

## 背景

会话 `sess_fd608e43-d950-481e-91d5-b1f49fb472c0` 的 Magic Context 从 2026-11-16 20:30 之后不再产生新的 compartment。诊断证据（`%TEMP%/zcode/magic-context/magic-context.log`）：

- 最后一次成功压缩为 compartment #166（覆盖消息 1220，11-16 20:30:50）。
- 之后 historian 连续失败 46 次：39 次 `Historian returned no assistant output.`，8 次 `output left uncovered messages ... without <unprocessed_from>`。
- 每次真实尝试 `input=50818 output=8192 response_chars=0`；成功时期为 `input=15K~20K output=1K~5K`。积压后单次 chunk 变成 146 条消息、50K 输入。
- 失败尝试按 input+output 计入 MC 内部 drain 预算（10 分钟窗口约 192K tokens），两三次失败即耗尽，随后每个 turn 直接 `historian skip: internal drain budget spent`。

根因有两层：

1. **输出预算不足**：`historian.maxTokens` 未配置时默认 8192。推理模型 `deepseek-v4.1-flash` 面对 50K 输入的长 chunk 把 8192 全部用于 reasoning，正文为空（或 12K 字符后截断，导致尾部消息没有 `<unprocessed_from>`）。
2. **reasoning 被丢弃**：`core/src/runtime/methods/sidecar-model-request.ts` 对 `reasoning_delta` 只记 `sawDelta`，不累积内容；`sidecarStreamResult` 不填 `reasoning`。`bootstrap/src/app/magic-context-historian.ts` 的结果映射也只映射 `text`。于是 `compartment-runner-historian.ts` 的 `!text && !reasoning` 分支把「推理耗尽输出预算」误报成「模型没有输出」，`historianReasoningBudgetDiagnostic`（提示调 `historian.maxTokens`）永远走不到，重试也只会重复同一次截断。

## 修复范围

### R1 core：sidecar 保留 reasoning 文本

`runSidecarModelRequest` 在事件循环内按 `reasoning_start` / `reasoning_delta` / `reasoning_end` 累积 reasoning 文本，并在 `RuntimeModelTextResult.reasoning` 中回传（`ModelReasoningContentBlock[]`）。该内容只用于诊断与 historian 的空输出判定，不改变 text/tool-call 的提交语义（`compact_stream_boundary` 与 `commitNormalizedContentBlock` 不动）。

### R2 bootstrap：映射 reasoning 到 `SidecarModelCallResult`

`createZCodeSidecarModelCall` 把 `raw.reasoning` 的文本块拼接后填入 `SidecarModelCallResult.reasoning`，使 `HiddenCompletionExecutor.collect` 能把它交给 `compartment-runner-historian.ts`。

### R3 配置：historian 输出上限

用户环境 `~/.omz/cli/config.json` 的 `magicContext.historian.maxTokens` 设为 `128000`（仓库外配置）。仓库内缺省值同步改为 `DEFAULT_HISTORIAN_MAX_OUTPUT_TOKENS = 128_000`：**发版默认即 128K**，未配置用户与显式配置走同一条「按模型 `optionSpecs.maxOutputTokens.max` 夹紧」的路径，小输出模型不会被要求超过它声明的上限；128K 是上限而非强制写满。

## 行为契约

| 输入 | 行为 |
| --- | --- |
| `text` 非空 | 以 text 为准；`lengthCapped` 时保持既有 length-capped 错误 |
| `text` 空、`reasoning` 非空、`lengthCapped` | `historianReasoningBudgetDiagnostic`（提示设置 `historian.maxTokens`） |
| `text` 空、`reasoning` 非空、未截断 | 以 reasoning 作为结果进入 validation（解析失败会得到具体的 compartment 格式错误） |
| `text` 与 `reasoning` 都为空 | 保持 `Historian returned no assistant output.` |

## 非目标

- 本次不改 validation 的 repair 策略（尾部 `<unprocessed_from>` 缺失）；输出预算提高后先观察是否自然消失。
- 本次不改 MC 的 drain 预算阈值与窗口。
- 不调整 historian 的默认模型（仍由用户配置决定）。

## 验证

- `packages/core/scripts/test-sidecar-model-request.mjs`：新增 reasoning-only 响应被保留的断言。
- `packages/bootstrap/scripts/test-magic-context-historian.mjs`：新增 reasoning 透传与 lengthCapped 组合的断言。
- `pnpm --filter @zcode/magic-context test:historian`、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 真机验证：重启会话后 historian recovery 重试，观察 `historian response_chars` 与新的 compartment。
