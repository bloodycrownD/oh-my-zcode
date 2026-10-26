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
