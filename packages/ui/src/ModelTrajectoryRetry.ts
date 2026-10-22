// 轨迹面板读取失败/空读后的自动重试判定纯逻辑（spec trace-3fix-v119 P1-2 / P2-3 / P2-4）。
//
// 硬约束：本模块零 React、零 `@/` 别名——被 packages/ui/test/modelTrajectoryRetry.test.ts
// 以 node:test + tsx 直测（tsx 下别名不可解析，先例 ModelTrajectoryClamp.ts:2-6）。
//
// 为什么把判定抽成纯函数：重试预算的语义是「失败次数达到上限才落终态」，
// 早期实现把「读到了空记录」也算成功并清零计数，导致空响应时无限重试；
// 把 success/empty/error 三条分支统一收口到本模块后，
// hook 侧不再存在第二份预算判定，空读与失败共用同一条有界退避链路。

/** 本次读取结果的分类。 */
type TrajectoryRetryKind = "success" | "empty" | "error";

/** 重试判定输入。 */
export interface TrajectoryRetryInput {
  /** 本次读取结果：读到记录=success、读到空记录=empty、读取抛错=error。 */
  kind: TrajectoryRetryKind;
  /** 当前已消耗的重试预算（已经排过几次退避重试）。 */
  retryCount: number;
  /** 重试预算上限（ERROR_RETRY_LIMIT）。 */
  limit: number;
}

/** 重试判定结果。 */
export interface TrajectoryRetryDecision {
  /** 是否重置重试预算：仅「读到记录」的成功分支为 true。 */
  resetBudget: boolean;
  /** 本次是否排一次退避重试。 */
  retry: boolean;
  /** 本次是否落终态（empty/error 终态）。 */
  terminal: boolean;
}

/**
 * 统一重试判定：
 * - success（读到记录）：重置预算，不重试，不落终态；
 * - empty/error 且预算未耗尽（retryCount < limit）：排一次退避重试，期间保持 loading，不落终态；
 * - empty/error 且预算耗尽（retryCount >= limit）：不再重试，落终态。
 *
 * 注意：empty 与 error 同等对待——读取「目录不存在 / 文件读失败 / sessionId 不匹配」
 * 都会返回空记录而非抛错，空读必须走与失败一致的有界退避，否则换模型的读取窗口
 * 会把面板永久钉死在空态。
 */
export function decideTrajectoryRetry({
  kind,
  retryCount,
  limit,
}: TrajectoryRetryInput): TrajectoryRetryDecision {
  if (kind === "success") {
    return { resetBudget: true, retry: false, terminal: false };
  }
  if (retryCount < limit) {
    return { resetBudget: false, retry: true, terminal: false };
  }
  return { resetBudget: false, retry: false, terminal: true };
}
