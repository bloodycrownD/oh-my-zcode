// 轨迹面板长文本 clamp 的溢出判定纯逻辑（spec trace-nm-borrow Step 4 / N-5 / T-N3）。
//
// 硬约束：本模块零 React、零 `@/` 别名——被 packages/ui/test/modelTrajectoryClamp.test.ts
// 以 node:test + tsx 直测（tsx 下别名不可解析，先例 ModelTrajectoryToolJoin.ts:7-11）。
// 组件侧只负责测量（scrollHeight/clientHeight）与渲染，判定口径统一走本模块，
// 避免路径 A（折叠行）与路径 B（扁平行）各写一套阈值。
//
// 容差语义：判定条件是「溢出像素数 **严格大于** 容差」。
// 容差用来吸收亚像素抖动（zoom/DPR/字体回退导致的 1px 级误差），
// 恰好等于容差的差值不算溢出，避免胶囊与「查看全文」入口忽隐忽现。

/** 溢出判定输入：元素的内容高度与可视高度（px）。 */
export interface ClampOverflowInput {
  /** 元素内容完整高度（DOM 的 scrollHeight）。 */
  scrollHeight: number;
  /** 元素可视高度（DOM 的 clientHeight），受 max-h 约束。 */
  clientHeight: number;
  /** 容差（px），缺省 {@link DEFAULT_CLAMP_TOLERANCE_PX}。 */
  tolerance?: number;
}

/** 默认容差（px）：吸收亚像素抖动。 */
export const DEFAULT_CLAMP_TOLERANCE_PX = 2;

/**
 * 是否溢出：溢出像素数（scrollHeight - clientHeight）严格大于容差才判定为溢出。
 *
 * scrollHeight === clientHeight（内容未超出可视区）恒不溢出。
 */
export function isClampOverflow({
  scrollHeight,
  clientHeight,
  tolerance = DEFAULT_CLAMP_TOLERANCE_PX,
}: ClampOverflowInput): boolean {
  return clampOverflowPx({ scrollHeight, clientHeight }) > tolerance;
}

/**
 * 溢出像素数（最小 0）：内容超出可视区的部分。
 * 判定与展示共用同一口径（isClampOverflow 内部即调用本函数）。
 */
export function clampOverflowPx({
  scrollHeight,
  clientHeight,
}: Pick<ClampOverflowInput, "scrollHeight" | "clientHeight">): number {
  return Math.max(0, scrollHeight - clientHeight);
}
