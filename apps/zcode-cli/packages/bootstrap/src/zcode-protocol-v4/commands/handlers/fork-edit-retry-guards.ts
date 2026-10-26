// edit/retry/fork 共用的「行目标」拒绝词汇。
//
// 为什么单独成文件：这些错误只承载「这一行能不能当目标」的裁决结果（reasonCode + 文案），
// 不含任何事务状态。把它们与 `rewind → start` 事务骨架放在一起会让 `fork-edit-retry.ts`
// 的行数上限先被穷举式错误类吃掉，逼着后来者去拆真正的语义（提交标记 / 草稿回传）。
// V4RowTranslationError 仍由 assistant-feedback / file-rewind 复用，所以放在这层共享词汇里，
// 不挂在某一条命令上。

/** row target → messageId 翻译失败（非 assistant 行 / 迟到实体 / 会话无投影）。 */
export class V4RowTranslationError extends Error {
  readonly reasonCode = "fault.command.executionFailed";

  constructor(command: string, targetRowId: number) {
    super(`${command} targetRowId ${targetRowId} 无法解析到 transcript messageId`);
    this.name = "V4RowTranslationError";
  }
}

/** 权威代次/实体已推进：目标行不在当前投影里（或宿主管线给不出投影）。 */
const STALE_TARGET_REASON_CODE = "proto.staleTarget";

/** 行目标已过期（见 `assertRowTargetFresh`）：reasonCode 原样取自解析器。 */
export class V4RowTargetStaleError extends Error {
  constructor(
    readonly reasonCode: string,
    command: string,
    targetRowId: number,
  ) {
    super(`${command} targetRowId ${targetRowId} 的目标已过期（${reasonCode}），需刷新后重试`);
    this.name = "V4RowTargetStaleError";
  }
}

/**
 * 行目标过期 → 抛**原样**的 `proto.*` 码，绝不折成 `guard.*`。
 *
 * 两个前缀是两种动作，不是同一种失败的两个写法：
 * - `proto.*`（本函数）= 权威已推进，客户端必须先刷新权威、再用同代 rowId/entityId 裁决
 *   （UI 判据 `packages/ui/src/v4/staleAuthorityRecovery.ts`）。折成 `guard.*` 会让客户端
 *   认为「重试无用」而永远不刷新，用户点重试一直落在已消失的行上。
 * - `guard.*` = 行在、但这个动作不被允许 / 解析器给了 ok 却缺必填字段。这类不由本函数裁决，
 *   调用方继续抛各命令自己的 guard 码。
 *
 * `undefined/null`（宿主没有解析面）与 `v4-gateway.ts` 的 admission 判据同码：那里也把
 * 「拿不到 resolution」判成 `proto.staleTarget`（两条入口对同一输入必须同判）。
 */
export function assertRowTargetFresh(
  resolution:
    | { ok: boolean; status?: "stale" | "rejected"; reasonCode?: string }
    | null
    | undefined,
  command: string,
  targetRowId: number,
): void {
  if (resolution?.ok) return;
  if (resolution && resolution.status !== "stale") return;
  throw new V4RowTargetStaleError(
    resolution?.reasonCode ?? STALE_TARGET_REASON_CODE,
    command,
    targetRowId,
  );
}

/** latestQueryEditOnly：旧 row / 非 realUser row / 无投影均直接拒绝，不 stop 当前 turn。 */
export class V4EditTargetNotLatestError extends Error {
  readonly reasonCode = "guard.latestQueryEditOnly";

  constructor(targetRowId: number) {
    super(`editUserQuery targetRowId ${targetRowId} 不是最后一轮 real user query`);
    this.name = "V4EditTargetNotLatestError";
  }
}

/** latestAssistantRetryOnly：历史 assistant 回复 retry 会回退 active branch，必须拒绝。 */
export class V4RetryTargetNotLatestError extends Error {
  readonly reasonCode = "guard.latestAssistantRetryOnly";

  constructor(targetRowId: number) {
    super(`retryTurn targetRowId ${targetRowId} 不是最后一轮 assistant 回复`);
    this.name = "V4RetryTargetNotLatestError";
  }
}
