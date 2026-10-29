import type { ConversationDelta, SessionMagicContextUsage } from "@zcode/shared/zcode-protocol-v4";

/**
 * FORK（D-13）：magic-context 预算摘要的 side-state 推送——「一份读数 → 待发布 delta」。
 *
 * 与 `ingest` 的差别只有一处：**没有事件**。这份读数来自 `magic-context.db`（装配层主动
 * 读出来推过来），所以它借用事件 delta 的同一条扇出管线与同一份 delta 日志——记在
 * **当前 seq** 上，于是 (a) 在线订阅者下一帧就看到，(b) 从更早 base 续流的订阅者在重放时
 * 也拿得到。它不进 `session.events`，所以冷恢复不重放它（新客户端从 snapshot 起就有，
 * 之后第一次 pass 会再推一次）。
 *
 * 抽成独立文件的理由与 `magic-context-usage-state.ts` 相同：这段「无事件 side state」契约
 * 只服务 magic-context，留在 `conversation-topic-publisher.ts`（上游文件）里纯属冲突面。
 * 真正的记账与扇出留在 publisher 的**中性原语** `publishSideState`——它不知道自己在发什么，
 * 因此上游新增的通用 side-state 发布（`setRuntimeInitialization`）可以原地复用同一条路。
 *
 * 这里只 `import type` 协议类型、不 import `ProductProjection`：投影侧用结构类型接收，
 * 依赖方向仍是 publisher → 本文件，与投影模块无环。
 */

/** 接收摘要的投影（结构类型：只要求这一个入口，不耦合 ProductProjection）。 */
export interface MagicContextUsageTarget {
  applyMagicContextUsage(usage: SessionMagicContextUsage | null | undefined): ConversationDelta[];
}

/**
 * D-13：一份预算摘要 → 待发布的 delta。
 *
 * 缺席语义与 conflation 都在投影侧（`transitionMagicContextUsage`）：`null` = 移除
 * `usage.magicContext` 键（不是写一份全零对象），逐字段相等 = 返回空数组。
 *
 * 空数组必须由调用方**发布前**短路：一旦进了 delta 日志，无变化的读例会以空条目挤占
 * 保留窗并提前推进 floorSeq，把续流中的客户端逼成 snapshot。因此这里只负责推导，
 * 短路由 `publishSideState` 统一执行。
 */
export function magicContextTopicDeltas(
  target: MagicContextUsageTarget,
  usage: SessionMagicContextUsage | null,
): ConversationDelta[] {
  return target.applyMagicContextUsage(usage);
}
