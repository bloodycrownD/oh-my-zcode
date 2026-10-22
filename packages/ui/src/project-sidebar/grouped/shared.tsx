// 照搬上游 v3.16.2 project-sidebar/grouped/shared.tsx（upstream-v316-fullsync P4.1 分组视角批；omz 化差异见文件内注释）
export { TaskGroupColorDot, TaskGroupColorMark } from "@/project-sidebar/grouped/colors.js";
export { taskKey } from "@/project-sidebar/grouped/ids.js";
export {
  areAllGroupedTaskGroupsExpanded,
  cloneView,
  filterGroupedViewByTaskKeys,
  findTaskInGroupedView,
  getGroupedTaskGroupIds,
  moveGroupAroundTopLevelNode,
  moveTaskByMenu,
  moveTaskToTopByMenu,
  moveTaskToGroupEnd,
  moveTaskToGroupStart,
  moveTaskToRootAroundGroup,
  moveTaskOverTask,
  pruneCollapsedGroupedTaskGroupIds,
  removeTaskFromGroupedView,
  replaceTaskInGroupedView,
  resolveGroupedDraftTaskPlacementForTask,
} from "@/project-sidebar/grouped/view.js";
export {
  TASK_GROUP_BORDER_COLOR_CLASS,
  TASK_GROUP_COLORS,
  TASK_GROUP_CONTAINER_CLASS,
  TASK_GROUP_CONTENT_CLASS,
  TASK_GROUP_COUNT_BADGE_CLASS,
  TASK_GROUP_HEADER_CLASS,
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_TITLE_CLASS,
} from "@/project-sidebar/grouped/types.js";
export type { TaskGroupMenuItem } from "@/project-sidebar/grouped/types.js";
export type { GroupedTaskInsertPosition } from "@/project-sidebar/grouped/view.js";
