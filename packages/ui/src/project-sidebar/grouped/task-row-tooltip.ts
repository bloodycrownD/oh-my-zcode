// 照搬上游 v3.16.2 project-sidebar/grouped/task-row-tooltip.ts（upstream-v316-fullsync P4.1 分组视角批；omz 化差异见文件内注释）
import type { ZCodeTaskChangeSummary } from "@zcode/shared";

export function formatGroupedTaskHoverChangeParts(
  summary: ZCodeTaskChangeSummary | null,
): string[] {
  if (!summary) {
    return [];
  }

  const parts: string[] = [];
  if (summary.added > 0) {
    parts.push(`+${summary.added}`);
  }
  if (summary.removed > 0) {
    parts.push(`-${summary.removed}`);
  }
  return parts;
}
