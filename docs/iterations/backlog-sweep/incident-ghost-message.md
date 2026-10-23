# 幽灵用户消息事故 + 并发轮投影互踩（P0，2026-10-23）

## 一句话

用户排队后「立即发送」的提示词从未到达模型；模型收到的是一条**由 MC 压缩错配把 assistant 旁白嫁接成 `user_steer` 身份**的幽灵消息；同时真消息命中的并发后台轮又因投影单写者模型互踩而连环崩溃、可见性错乱。两侧根因均已修复并附回归测试。

## 证据链（全部落库实证）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 幽灵文本「§1487§ E1 已恢复。同法恢复 E2/E3/E4：」是**assistant 旁白**，12:17:34.921 以 text part 正常落库 | `db.sqlite` `part` 表（msg_mvkxqlzd_e98，role=assistant 的旁白 part） |
| 2 | 同文本 12:17:48.675 被 MC 记成 **role:user**（主会话 tag 1487），相邻于 4 个探索代理的 spawn/失败窗口 | `magic-context.db` `source_contents` tag_id=1487；`message_history` mc1829 role:user；lkg_slot_chunks |
| 3 | 该文本经 `formatIncomingMessage(user_steer)` 包装为 "The user sent a new message" 注入运行中的轮，并进入后续所有请求 | `rollout/model-io-sess_*.jsonl` LINE 4-17 |
| 4 | 权威输入表里**从未存在**这条输入（session_input/input_history/CLI 日志全 0 命中）——不是任何输入通道产生的 | `db.sqlite` session_input / input_history；log/zcode-*.jsonl |
| 5 | 用户真消息（【关键坑】rebuttal）**提交了 3 次**（d7/d8/da 全部 status=promoted）：d7 轮 12:59:25、da 轮 13:01:29 被 provider 流失败秒杀；d8 轮跑到 13:00:52 也死于流失败；三者均未进入前台轮上下文 | session_input + CLI 日志 turn 序列 |
| 6 | 嫁接机制=MC 压缩重排后 `originals`（按 MC 消息 id 查原 entry）错配，`rebuildEntry` **无条件整拷 original.metadata**（含 `inputPresentation:"user_steer"` + `source:"real_user"`），旁白内容就此伪造「被准入的真实输入」身份 | `magic-context-turn-transform.ts` rebuildEntry:788 旧码 |

## 根因 A：MC 反投影身份嫁接（已修）

**修复**（`magic-context-turn-transform.ts`）：

- `projectMagicContextEntries` 增**配对守卫** `originalPairsWithMessage`：role 不符（含 tool↔user 折叠例外）一律断开原 entry 配对，重建走无模板路径；
- `rebuildEntry` 增 `sanitizeRebuiltMetadata`：重建条目（=内容已验证与原输入不同）**永不继承 `inputPresentation`**；`source`（real_user 气泡身份）保留——§N§ 打标是合法日常改写，气泡身份与 cache 锚定依赖它（既有测试 #5 锁死）。
- 不变量：**注入身份只能存活于字节级未改动且 role 匹配的条目上**——MC 无论在包内怎么重排/翻 role，都不可能再让任意内容声称自己是「被准入的用户输入」。

**回归**：`scripts/test-mc-entry-identity-guard.mjs` 4 用例（事故形状复刻/合法改写/role 翻转/value 原样往返）+ 既有 `test-magic-context-turn-transform.mjs` 23 用例全绿。

## 根因 B：投影单写者模型 vs 并发轮（已根修）

旧投影把「当前轮」当单值状态：`currentTurnId` 最后写入者获胜、`streamingText/ReasoningRowId`/`outputContinuationTextRowId` 全局单槽、终态事件无条件作用于全局 phase/lastError/heldQueue。任何一条后台轮（queue 提升）都能：清空前台轮的流式锚点、收口前台轮的行、把会话全局态翻成 error。

**修复**（`product-projection.ts`，单槽位 → `Map<runtimeTurnId, ActiveTurnContext>`）：

- `onTurnStarted` 每轮建独立上下文（流式锚点/continuation 锚点/开始时间/modelOnly 标记），不再全局清空；`primaryTurnId` = 最近一次 user-visible 起点轮（model-only 维护轮不抢占）；
- 流式生命周期（open/close text/reasoning、continuation、`establishedStreamingAppend`、`openAssistantSegments`）全部按事件轮上下文路由；
- `onTurnComplete/onTurnError` 按事件轮归属：先收口**该轮自己的**行，再落该轮 header 终态；全局 phase/lastError/heldQueue 只由前台轮迁移，前台轮收口后 `releasePrimaryTurn` 提升最近可见轮或清空；
- `acceptsActiveModelEvent` 归属改为「事件轮是否有活跃上下文」（已收口轮迟到事件仍拒收；无任何上下文时保持旧宽容语义）；
- `cloneProjection/adoptProjection` 深拷上下文表与 `productTurnStartedAtByRuntimeTurnId`（queue drain 切段起点也按轮分键）；
- controlOnly 收口路径同样按轮清理。

**回归**：`scripts/test-concurrent-turn-terminal-guard.mjs` 4 用例（后台轮失败只落自己 header 不判死前台轮/当前轮失败仍完整/缺 turnId 旧语义/后台轮完成不连带收口前台轮）+ late-tool-input/ask-question/MC-usage 三个既有投影套件全绿；`test-queue-item-delivery-command` 的 2 个失败在基准 HEAD 同样红（既有 fixture 缺陷，与本轮无关）。

## 开放项（不在本轮修复范围，已登记）

1. **MC 包内 role 翻转的出生点**：压缩重排把 assistant 内容产出为 role:user 的 MessageLike（mc1829 的 role 来源）发生在 `@zcode/magic-context` 包内部（inject-compartments/strip-content 的 id 重排路径）。port 侧守卫已把杀伤面封死（不可能再获得输入身份），但包内错配本身未修，属上游魔法上下文包级工作。
2. **MC 端口架构耦合**：transform 是「整个 entries 数组交出去、可能被整组重建」的 OpenCode 遗传设计，内容改写与身份元数据共用一条通道——本事故的结构成因。进一步解耦方向：身份元数据在进通道前剥离、出通道后按内容锚定重新附着（当前守卫已等价实现该不变量；物理剥离可作为后续硬化）。
3. **并发轮准入侧疑点**：d7/d8/da 在用户前台轮运行期间各起独立轮——`sendQueuedNow` 手动路径应 preempt、autoDrain 应 idle-only，日志未能证明两者之一成立（provider 风暴干扰取证）。需在稳定的 provider 环境复现并补日志。
4. **后台轮可见性**：本轮根修保证后台轮的失败/完成以其 header 终态可见且不连坐前台轮；「并行轮在 UI 上如何并列展示」属产品面，未做。

## 复现（自动化）

```
cd apps/zcode-cli/packages/bootstrap
pnpm run build
node --test scripts/test-mc-entry-identity-guard.mjs        # A 线 4/4
npx tsx --test scripts/test-concurrent-turn-terminal-guard.mjs  # B 线 4/4
node --test scripts/test-magic-context-turn-transform.mjs   # MC 既有 23/23
```
