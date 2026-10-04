import { createHash } from "node:crypto";

export function digestSummary(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

/**
 * workspace identity 的 SHA-256 短摘要。
 *
 * 本实现的 identity 就是绝对路径，因此任何要跨出进程边界或写进错误的文本
 * 都必须先经此脱敏，而不是依赖下游过滤。
 */
export function workspaceIdentitySummary(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
