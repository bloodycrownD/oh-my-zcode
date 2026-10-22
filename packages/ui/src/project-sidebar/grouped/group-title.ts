// 照搬上游 v3.16.2 project-sidebar/grouped/group-title.ts（upstream-v316-fullsync P4.1 分组视角批；omz 化差异见文件内注释）
import { CRON_DEFAULT_GROUP_ID, OFF_PEAK_DEFAULT_GROUP_ID } from "@zcode/shared";

/** 系统分组标题按语言环境本地化展示，忽略 DB 里存的固定占位标题（'cron' / 'off-peak'）。 */
function getTaskGroupDisplayTitle(
  group: { id: string; title: string },
  localizedSystemTitles: { cron: string; offPeak: string },
): string {
  if (group.id === CRON_DEFAULT_GROUP_ID) return localizedSystemTitles.cron;
  if (group.id === OFF_PEAK_DEFAULT_GROUP_ID) return localizedSystemTitles.offPeak;
  return group.title;
}

export { getTaskGroupDisplayTitle };
