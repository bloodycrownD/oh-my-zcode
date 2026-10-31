/**
 * FORK (upgrade-316): highspeed（加速卡计费 / 输出 footer）已整体移除，
 * 上游此处 `interface ConversationTurnRenderUnit extends HighspeedOutputFooterMark`
 * 不再成立。fork 的单轮渲染单元类型唯一 owner 是
 * conversationTurnRenderUnitsDraft.ts；本文件保留为上游导入路径的兼容 re-export，
 * 避免同一接口维护两份定义（该文件仍被 test/conversationLatestTurnSummary.test.ts 引用）。
 */
export type {
  BuildConversationTurnRenderUnitsOptions,
  ConversationTurnRenderUnit,
} from "./conversationTurnRenderUnitsDraft.js";
