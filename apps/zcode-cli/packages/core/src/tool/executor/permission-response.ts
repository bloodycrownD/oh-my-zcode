import { CoreErrorType, createCoreError, type PermissionBrokerResult } from "@zcode/contracts";

/**
 * 应答形状校验。
 *
 * `once`（user-once 单次确认）与 `noAlwaysAllow`（这次不提供「始终允许」）都禁止应答
 * 夹带项目规则：借一次弹窗把规则永久写进项目，等于绕开「只此一次」的核心判定。
 * 会话级更新只由 `once` 约束——`no-always-allow` 收窄的是持久化规则选项。
 */
export function validatePermissionResponse(
  response: PermissionBrokerResult,
  once: boolean,
  options?: { noAlwaysAllow?: boolean },
): void {
  const forbidProjectRules = once || options?.noAlwaysAllow === true;
  if (
    !response ||
    !["allow", "deny", "modify", ...(once ? [] : ["escalate"])].includes(response.decision) ||
    (response.reason !== undefined && typeof response.reason !== "string") ||
    (response.permissionUpdates !== undefined &&
      (!Array.isArray(response.permissionUpdates) ||
        (forbidProjectRules && response.permissionUpdates.length > 0))) ||
    (response.decision === "modify" && response.modifiedInput === undefined) ||
    (response.sessionPermissionUpdates !== undefined &&
      (!Array.isArray(response.sessionPermissionUpdates) ||
        (once && response.sessionPermissionUpdates.length > 0)))
  ) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      "Invalid permission response; single-use requests cannot persist project rules",
      { recoverable: true },
    );
  }
}
