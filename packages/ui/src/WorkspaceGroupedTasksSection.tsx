/* eslint-disable max-lines -- 顶层 grouped task 容器仍集中维护远程 workspace service 解析、group 菜单、task 菜单和列表写回；子行与纯 helper 已拆到 project-sidebar/grouped 目录。 */
// TODO(upgrade-316): 上游 v3.16 用 project-sidebar/TaskGroupedView 取代了本组件，WorkspaceSidebar 也已
// 改为 re-export 上游 ProjectSidebar，本组件当前没有引用方。按“不能删”的要求保留，并已把数据面适配到
// 新 ITaskGroupService + ProjectTask 投影；是否重新接线到侧边栏或移除死代码需人工确认。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SetStateAction,
} from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  CollisionDetection,
  DragCancelEvent,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
  DropAnimation,
} from "@dnd-kit/core";
import type {
  GroupedDraftTaskPlacement,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
  ZCodeTaskGroupColor,
} from "@/project-sidebar/grouped/types.js";
import type {
  GroupNode,
  MoveGroupNode,
  ProjectTask,
  TaskGroupStructure,
} from "@/project-sidebar/contract.js";
import type { IServiceAccessor, WindowHostControllerTaskListItem } from "@zcode/services";
import { type ZCodeTaskMeta, remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import { createPortal } from "react-dom";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { getPathLeaf } from "@/lib/path.js";
import { toast } from "@/components/ui/toast.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { GroupItem } from "@/project-sidebar/grouped/group-item.js";
import { GroupedTaskItem } from "@/project-sidebar/grouped/task-item.js";
import { GroupDragOverlay } from "@/project-sidebar/grouped/group-drag-overlay.js";
import { VirtualizedGroupedTopLevelList } from "@/project-sidebar/grouped/virtualized-top-level-list.js";
import { GroupedDraftTaskRow } from "@/project-sidebar/grouped/draft-task-row.js";
import { StickyGroupHeader } from "@/project-sidebar/grouped/sticky-group-header.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import {
  findTaskInGroupedView,
  filterGroupedViewByTaskKeys,
  getGroupedTaskGroupIds,
  moveGroupAroundTopLevelNode,
  moveTaskByMenu,
  moveTaskToTopByMenu,
  moveTaskToGroupEnd,
  moveTaskToGroupStart,
  moveTaskToRootAroundGroup,
  moveTaskOverTask,
  replaceTaskInGroupedView,
  resolveGroupedDraftTaskPlacementForTask,
  taskKey,
} from "@/project-sidebar/grouped/shared.js";
import type { TaskGroupMenuItem } from "@/project-sidebar/grouped/shared.js";
import { buildGroupedTaskView } from "@/project-sidebar/grouped/model.js";
import { groupTaskRef } from "@/project-sidebar/grouped-view.js";
import type { WorkbenchSessionDragPayload } from "@/v4/workbenchDragDrop.js";
import { logger } from "@/logger.js";

type TaskGroupService = NonNullable<IServiceAccessor["taskGroupService"]>;

interface TaskFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

interface WorkbenchPointerPosition {
  x: number;
  y: number;
}

interface WorkbenchPointerPositionTracker {
  dispose: () => void;
  getPosition: () => WorkbenchPointerPosition;
}

const EMPTY_GROUPED_TASK_VIEW: ZCodeGroupedTaskView = { nodes: [] };
const EMPTY_TASK_GROUP_STRUCTURE: TaskGroupStructure = { groups: [], members: [], order: [] };

// 上游 v3.16 把 task-groups 的读写收敛到 ITaskGroupService（read/save/ungroup/move），
// 旧 fork 的 zcodeTaskService 分组 API 已不存在。这里按新契约重建原组件需要的
// view/CRUD 形状，任务事实改由当前唯一 owner（Window Host Controller 列表）投影。
function resolveGroupedTaskHostId(task: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  const workspaceKey = task.workspaceIdentity?.trim() || task.workspacePath;
  return remoteHostIdFromWorkspaceIdentity(workspaceKey) ?? "local";
}

function toProjectTask(item: WindowHostControllerTaskListItem): ProjectTask {
  return {
    ...item,
    projectId: null,
    hostId: resolveGroupedTaskHostId(item),
    // active 列表本身已排除置顶/归档；分组投影只需任务事实。
    pinned: false,
    archived: false,
  };
}

function resolveTaskFileTreeTarget(
  task: ZCodeTaskMeta,
  tab: WorkspaceTabState | undefined,
): TaskFileTreeTarget | null {
  // 旧本地 task 没有 workspaceIdentity，key 会回退到 workspacePath；如果同路径
  // 远程 tab 也缺 identity，仅按 key 会误带远程 session。匹配前必须先保证本地/远程类型一致。
  const taskIsRemote = Boolean(task.workspaceIdentity?.trim());
  const tabIsRemote = Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteTarget || tab?.remoteSessionId,
  );
  const matchingTab =
    tab &&
    buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
      buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) &&
    taskIsRemote === tabIsRemote
      ? tab
      : undefined;
  if (tab && !matchingTab) {
    return null;
  }
  const isRemoteWorkspace = Boolean(
    task.workspaceIdentity?.trim() || matchingTab?.remoteTarget || matchingTab?.remoteSessionId,
  );
  // 远端 task 的 workspacePath 可能和本地 workspace 相同。缺少对应 remoteSessionId
  // 时禁止打开文件树，否则文件读取会错误降级到本地 service。
  if (isRemoteWorkspace && !matchingTab?.remoteSessionId) {
    return null;
  }

  return {
    workspacePath: task.workspacePath,
    workspaceName: matchingTab?.label || getPathLeaf(task.workspacePath) || task.workspacePath,
    ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(matchingTab?.remoteSessionId
      ? { workspaceRemoteSessionId: matchingTab.remoteSessionId }
      : {}),
  };
}

function resolveTaskFileTreeTargetFromTabs(
  task: ZCodeTaskMeta,
  tabs: readonly WorkspaceTabState[],
): TaskFileTreeTarget | null {
  // 同一路径的本地与旧远程 tab 可能生成相同 key，不能先压成单值 Map；
  // 必须保留全部候选，再由单 tab 解析器校验 workspace 类型与远程 session。
  for (const tab of tabs) {
    const target = resolveTaskFileTreeTarget(task, tab);
    if (target) {
      return target;
    }
  }
  // 本地 task 不依赖已打开 tab；所属 workspace 已关闭时仍应按路径打开文件树。
  // 远程 task 则必须命中 tab 以取得受身份隔离的 remoteSessionId，禁止同样回退。
  if (!task.workspaceIdentity?.trim()) {
    return resolveTaskFileTreeTarget(task, undefined);
  }
  return null;
}

function readPointerPosition(event: Event): WorkbenchPointerPosition | null {
  if (!("clientX" in event) || !("clientY" in event)) {
    return null;
  }
  const { clientX, clientY } = event as Event & {
    clientX: unknown;
    clientY: unknown;
  };
  return typeof clientX === "number" && typeof clientY === "number"
    ? { x: clientX, y: clientY }
    : null;
}

// 上游 v3.16 删掉了 Workbench split-pane 的 pointer drop target 注册表；
// 当前代码库已无任何 registerWorkbenchPointerDropTarget 调用方，保留同名 no-op
// 以避免把分组拖拽接到已移除的落点体系上。
function createWorkbenchPointerPositionTracker(
  ownerDocument: Document,
  activatorEvent: Event,
): WorkbenchPointerPositionTracker | null {
  const initialPosition = readPointerPosition(activatorEvent);
  if (!initialPosition) {
    return null;
  }
  let position: WorkbenchPointerPosition = initialPosition;
  let disposed = false;
  const stopObserving = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    ownerDocument.removeEventListener("pointermove", handlePointerMove, true);
    ownerDocument.removeEventListener("pointerup", handlePointerUp, true);
    ownerDocument.removeEventListener("pointercancel", handlePointerCancel, true);
  };
  const handlePointerMove = (event: PointerEvent) => {
    position = { x: event.clientX, y: event.clientY };
  };
  const handlePointerUp = (event: PointerEvent) => {
    position = { x: event.clientX, y: event.clientY };
    stopObserving();
  };
  const handlePointerCancel = () => {
    stopObserving();
  };
  ownerDocument.addEventListener("pointermove", handlePointerMove, true);
  ownerDocument.addEventListener("pointerup", handlePointerUp, true);
  ownerDocument.addEventListener("pointercancel", handlePointerCancel, true);
  return {
    dispose: stopObserving,
    getPosition: () => position,
  };
}

function updateWorkbenchPointerDrag(
  _payload: WorkbenchSessionDragPayload,
  _clientX: number,
  _clientY: number,
): boolean {
  return false;
}

function finishWorkbenchPointerDrag(
  _payload: WorkbenchSessionDragPayload,
  _clientX: number,
  _clientY: number,
): boolean {
  return false;
}

function cancelWorkbenchPointerDrag(): void {}

function shouldHideGroupedTaskContent(params: {
  initialized: boolean;
  loading: boolean;
  hasNodes: boolean;
  /**
   * 门禁只该拦首屏。已经画出过列表之后再回到隐藏态，就是用户看到的
   * 「grouped 整块闪一下」——祖先重挂载和后台刷新都会走到这里。
   * 画过一次之后一律继续渲染上一份列表：旧数据优于空白。
   */
  hasPaintedOnce?: boolean;
}): boolean {
  if (params.hasPaintedOnce) {
    return false;
  }
  return !params.initialized || (params.loading && !params.hasNodes);
}

function groupedNodeIdentity(node: ZCodeGroupedTaskViewNode): string {
  return node.type === "group" ? `group:${node.group.id}` : `task:${taskKey(node.task)}`;
}

// 行组件仍按 ZCodeTaskMeta 暴露回调，但节点实际来自 ProjectTask 投影；
// 视图改写函数（上游 v3.16）已把参数收紧为 ProjectTask，这里恢复完整形状。
function asProjectTask(task: ZCodeTaskMeta): ProjectTask {
  return task as ProjectTask;
}

function groupedNodeRef(node: ZCodeGroupedTaskViewNode): GroupNode {
  return node.type === "group"
    ? { type: "group", groupId: node.group.id }
    : { type: "task", task: groupTaskRef(node.task) };
}

interface GroupedNodePlacement {
  identity: string;
  parentId: string | null;
  index: number;
}

interface GroupedTargetPlacement extends GroupedNodePlacement {
  node: GroupNode;
  previous: GroupNode | null;
  next: GroupNode | null;
}

function collectGroupedNodePlacements(view: ZCodeGroupedTaskView): Map<string, GroupedNodePlacement> {
  const placements = new Map<string, GroupedNodePlacement>();
  view.nodes.forEach((node, index) => {
    const identity = groupedNodeIdentity(node);
    placements.set(identity, { identity, parentId: null, index });
    if (node.type !== "group") {
      return;
    }
    node.tasks.forEach((task, taskIndex) => {
      const taskIdentity = `task:${taskKey(task)}`;
      placements.set(taskIdentity, {
        identity: taskIdentity,
        parentId: node.group.id,
        index: taskIndex,
      });
    });
  });
  return placements;
}

function collectGroupedTargetPlacements(view: ZCodeGroupedTaskView): GroupedTargetPlacement[] {
  const targets: GroupedTargetPlacement[] = [];
  view.nodes.forEach((node, index) => {
    targets.push({
      identity: groupedNodeIdentity(node),
      parentId: null,
      index,
      node: groupedNodeRef(node),
      previous: view.nodes[index - 1] ? groupedNodeRef(view.nodes[index - 1]!) : null,
      next: view.nodes[index + 1] ? groupedNodeRef(view.nodes[index + 1]!) : null,
    });
    if (node.type !== "group") {
      return;
    }
    node.tasks.forEach((task, taskIndex) => {
      const previousTask = node.tasks[taskIndex - 1];
      const nextTask = node.tasks[taskIndex + 1];
      targets.push({
        identity: `task:${taskKey(task)}`,
        parentId: node.group.id,
        index: taskIndex,
        node: { type: "task", task: groupTaskRef(task) },
        previous: previousTask ? { type: "task", task: groupTaskRef(previousTask) } : null,
        next: nextTask ? { type: "task", task: groupTaskRef(nextTask) } : null,
      });
    });
  });
  return targets;
}

/**
 * 旧 API 一次提交整棵 view 顺序；新 ITaskGroupService 只接受单节点 move。
 * 这里按目标顺序逐节点下发带锚点的 move，把整表顺序拆成幂等的单节点命令。
 */
async function persistGroupedTaskViewOrder(
  service: TaskGroupService,
  previousView: ZCodeGroupedTaskView,
  nextView: ZCodeGroupedTaskView,
): Promise<void> {
  const currentPlacements = collectGroupedNodePlacements(previousView);
  for (const target of collectGroupedTargetPlacements(nextView)) {
    const current = currentPlacements.get(target.identity);
    if (current && current.parentId === target.parentId && current.index === target.index) {
      continue;
    }
    const anchor: MoveGroupNode["anchor"] = target.previous
      ? { node: target.previous, side: "after" }
      : target.next
        ? { node: target.next, side: "before" }
        : undefined;
    await service.move({
      node: target.node,
      sourceGroupId: current?.parentId ?? null,
      groupId: target.parentId,
      ...(anchor ? { anchor } : {}),
    });
  }
}

function useGroupedTaskView({ workspaceTabs }: { workspaceTabs: WorkspaceTabState[] }) {
  const services = useBaseWorkspaceServices();
  const taskGroupService = services.taskGroupService;
  const taskGroupServiceRef = useRef<TaskGroupService | undefined>(taskGroupService);
  taskGroupServiceRef.current = taskGroupService;
  const globalTaskList = useGlobalTaskList({
    kind: "active",
    workspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 0,
  });
  const tasks = useMemo<ProjectTask[]>(
    () => globalTaskList.items.map(toProjectTask),
    [globalTaskList.items],
  );
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [structure, setStructure] = useState<TaskGroupStructure>(EMPTY_TASK_GROUP_STRUCTURE);
  const [view, setViewState] = useState<ZCodeGroupedTaskView>(EMPTY_GROUPED_TASK_VIEW);
  const viewRef = useRef(view);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const setView = useCallback((next: SetStateAction<ZCodeGroupedTaskView>) => {
    const resolved = typeof next === "function" ? next(viewRef.current) : next;
    viewRef.current = resolved;
    setViewState(resolved);
  }, []);

  const refresh = useCallback(async () => {
    const service = taskGroupServiceRef.current;
    if (!service) {
      setStructure(EMPTY_TASK_GROUP_STRUCTURE);
      setView(buildGroupedTaskView(tasksRef.current, EMPTY_TASK_GROUP_STRUCTURE));
      setInitialized(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const nextStructure = await service.read();
      setStructure(nextStructure);
      setView(buildGroupedTaskView(tasksRef.current, nextStructure));
      setInitialized(true);
    } catch (error) {
      logger.error("[WorkspaceGroupedTasksSection] 读取 task group 结构失败", error);
    } finally {
      setLoading(false);
    }
  }, [setView]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const subscription = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:task-groups") {
        void refresh();
      }
    });
    return () => subscription.dispose();
  }, [refresh, services.broadcastService]);

  // 任务事实（活动/标题）变化时按已接受结构重建展示树，结构本身不在这里改写。
  useEffect(() => {
    setView(buildGroupedTaskView(tasks, structure));
  }, [setView, structure, tasks]);

  const saveGroup = useCallback(
    async (input: { id?: string; title?: string; color?: ZCodeTaskGroupColor }) => {
      const service = taskGroupServiceRef.current;
      if (!service) {
        throw new Error("task-group.service-unavailable");
      }
      setSaving(true);
      try {
        const group = await service.save(input);
        await refresh();
        return group;
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  const createGroup = useCallback(() => saveGroup({}), [saveGroup]);
  const renameGroup = useCallback(
    (groupId: string, title: string) => saveGroup({ id: groupId, title }),
    [saveGroup],
  );
  const updateGroupColor = useCallback(
    (groupId: string, color: ZCodeTaskGroupColor) => saveGroup({ id: groupId, color }),
    [saveGroup],
  );

  const ungroupGroup = useCallback(
    async (groupId: string) => {
      const service = taskGroupServiceRef.current;
      if (!service) {
        throw new Error("task-group.service-unavailable");
      }
      setSaving(true);
      try {
        await service.ungroup(groupId);
        await refresh();
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  const applyOrder = useCallback(
    async (nextView: ZCodeGroupedTaskView) => {
      const service = taskGroupServiceRef.current;
      const previousView = viewRef.current;
      setView(nextView);
      if (!service) {
        setView(previousView);
        return;
      }
      setSaving(true);
      try {
        await persistGroupedTaskViewOrder(service, previousView, nextView);
        await refresh();
      } catch (error) {
        // 写入失败回滚本地乐观视图，再刷新收敛到 Host 真相源。
        setView(previousView);
        await refresh();
        logger.error("[WorkspaceGroupedTasksSection] 保存 grouped task 顺序失败", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [refresh, setView],
  );

  return {
    view,
    setView,
    loading,
    initialized,
    saving,
    refresh,
    createGroup,
    renameGroup,
    updateGroupColor,
    ungroupGroup,
    applyOrder,
  };
}

function findNearestScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const canScrollY =
      /(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight;
    if (canScrollY) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function areTaskGroupMenuItemsEqual(
  left: readonly TaskGroupMenuItem[],
  right: readonly TaskGroupMenuItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.id === right[index]?.id &&
        item.title === right[index]?.title &&
        item.color === right[index]?.color,
    )
  );
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function getGroupedTaskDragTaskKey(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; taskKey?: unknown };
  return data.type === "grouped-task" && typeof data.taskKey === "string" ? data.taskKey : null;
}

function getGroupedTaskDragGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-group" && typeof data.groupId === "string" ? data.groupId : null;
}

function getGroupedTaskDragType(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown };
  return typeof data.type === "string" ? data.type : null;
}

function getGroupedGroupOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-group-over" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

function getGroupedTaskCollapsedOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-collapsed-group" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

function getGroupedTaskHeaderOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-expanded-group-header" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

function getGroupedTaskFooterOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-expanded-group-footer" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

function getGroupedTaskEmptyOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-empty-drop-zone" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

type GroupedTaskDragDirectionPosition = "before" | "after";

const groupedTaskCollisionDetection: CollisionDetection = (args) => {
  const activeType = getGroupedTaskDragType(args.active.data.current);
  const droppableContainers =
    activeType === "grouped-group"
      ? args.droppableContainers.filter((container) => {
          const type = getGroupedTaskDragType(container.data.current);
          return type === "grouped-task" || type === "grouped-group-over";
        })
      : args.droppableContainers.filter(
          (container) => getGroupedTaskDragType(container.data.current) !== "grouped-group-over",
        );
  return closestCenter({
    ...args,
    droppableContainers,
  });
};

function getGroupedTaskOverTaskPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overTaskKey = getGroupedTaskDragTaskKey(event.over?.data.current);
  if (!activeTaskKey || !overTaskKey || activeTaskKey === overTaskKey) {
    return view;
  }
  return moveTaskOverTask(view, {
    activeTaskKey,
    overTaskKey,
    position,
  });
}

function getGroupedTaskOverCollapsedGroupPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskCollapsedOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  return moveTaskToRootAroundGroup(view, {
    activeTaskKey,
    groupId: overGroupId,
    position,
  });
}

function getGroupedTaskOverGroupHeaderPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskHeaderOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  if (position === "before") {
    return moveTaskToRootAroundGroup(view, {
      activeTaskKey,
      groupId: overGroupId,
      position: "before",
    });
  }
  return moveTaskToGroupStart(view, {
    activeTaskKey,
    groupId: overGroupId,
  });
}

function getGroupedTaskOverGroupFooterPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskFooterOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  if (position === "before") {
    return moveTaskToGroupEnd(view, {
      activeTaskKey,
      groupId: overGroupId,
    });
  }
  return moveTaskToRootAroundGroup(view, {
    activeTaskKey,
    groupId: overGroupId,
    position: "after",
  });
}

function getGroupedTaskOverEmptyDropZonePreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskEmptyOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  return moveTaskToGroupStart(view, {
    activeTaskKey,
    groupId: overGroupId,
  });
}

function getGroupedGroupOverGroupPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeGroupId = getGroupedTaskDragGroupId(event.active.data.current);
  const overGroupId = getGroupedGroupOverGroupId(event.over?.data.current);
  if (!activeGroupId || !overGroupId || activeGroupId === overGroupId) {
    return view;
  }
  return moveGroupAroundTopLevelNode(view, {
    activeGroupId,
    over: { type: "group", groupId: overGroupId },
    position,
  });
}

function getGroupedGroupOverTaskPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeGroupId = getGroupedTaskDragGroupId(event.active.data.current);
  const overTaskKey = getGroupedTaskDragTaskKey(event.over?.data.current);
  if (!activeGroupId || !overTaskKey) {
    return view;
  }
  return moveGroupAroundTopLevelNode(view, {
    activeGroupId,
    over: { type: "task", taskKey: overTaskKey },
    position,
  });
}

function getGroupedTaskViewSignature(view: ZCodeGroupedTaskView): string {
  return view.nodes
    .map((node) =>
      node.type === "task"
        ? `t:${taskKey(node.task)}`
        : `g:${node.group.id}[${node.tasks.map(taskKey).join(",")}]`,
    )
    .join("|");
}

type GroupedTaskLayoutRects = Map<
  string,
  {
    height: number;
    left: number;
    top: number;
  }
>;

const GROUPED_TASK_DROP_ANIMATION: DropAnimation = {
  duration: 150,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
};
const GROUPED_TASK_AUTO_SCROLL_THRESHOLD = {
  x: 0.1,
  y: 0.1,
} as const;

function collectGroupedTaskLayoutRects(root: HTMLElement | null): GroupedTaskLayoutRects {
  const rects: GroupedTaskLayoutRects = new Map();
  if (!root) {
    return rects;
  }
  root.querySelectorAll<HTMLElement>("[data-grouped-layout-key]").forEach((element) => {
    const key = element.getAttribute("data-grouped-layout-key");
    if (!key) {
      return;
    }
    const rect = element.getBoundingClientRect();
    rects.set(`layout:${key}`, {
      height: rect.height,
      left: rect.left,
      top: rect.top,
    });
  });
  root.querySelectorAll<HTMLElement>("[data-grouped-task-key]").forEach((element) => {
    const key = element.getAttribute("data-grouped-task-key");
    if (!key) {
      return;
    }
    const rect = element.getBoundingClientRect();
    rects.set(`task:${key}`, {
      height: rect.height,
      left: rect.left,
      top: rect.top,
    });
  });
  return rects;
}

function measureGroupedTaskPreviewWidth(
  root: HTMLElement | null,
  targetTaskKey: string,
): number | null {
  if (!root) {
    return null;
  }
  const targetDomKey = encodeURIComponent(targetTaskKey);
  for (const element of root.querySelectorAll<HTMLElement>("[data-grouped-task-key]")) {
    if (element.getAttribute("data-grouped-task-key") === targetDomKey) {
      return element.getBoundingClientRect().width;
    }
  }
  return null;
}

function measureGroupedGroupPreviewWidth(
  root: HTMLElement | null,
  targetGroupId: string,
): number | null {
  if (!root) {
    return null;
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-grouped-group-item-id]")) {
    if (element.getAttribute("data-grouped-group-item-id") === targetGroupId) {
      return element.getBoundingClientRect().width;
    }
  }
  return null;
}

function resolveStickyGroupedTaskGroupId(root: HTMLElement | null): string | null {
  if (!root) {
    return null;
  }
  const scrollContainer = findNearestScrollableAncestor(root);
  if (!scrollContainer) {
    return null;
  }
  const containerTop = scrollContainer.getBoundingClientRect().top;
  let stickyGroupId: string | null = null;
  for (const element of root.querySelectorAll<HTMLElement>("[data-grouped-group-item-id]")) {
    const groupId = element.getAttribute("data-grouped-group-item-id");
    if (element.getAttribute("data-group-collapsed") === "true") {
      continue;
    }
    const header = groupId
      ? root.querySelector<HTMLElement>(`[data-grouped-group-header-id="${CSS.escape(groupId)}"]`)
      : null;
    if (!groupId || !header) {
      continue;
    }
    const groupRect = element.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const headerHeight = headerRect.height || 32;
    const headerHasScrolledPastTop = headerRect.top < containerTop - 0.5;
    const groupStillCoversTop = groupRect.bottom > containerTop + headerHeight + 0.5;
    if (headerHasScrolledPastTop && groupStillCoversTop) {
      stickyGroupId = groupId;
    }
  }
  return stickyGroupId;
}

function animateGroupedTaskLayoutFrom(
  root: HTMLElement | null,
  previousRects: GroupedTaskLayoutRects,
) {
  if (!root || previousRects.size === 0) {
    return;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const selector = "[data-grouped-layout-key], [data-grouped-task-key]";
  root.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    const layoutKey = element.getAttribute("data-grouped-layout-key");
    const taskKeyValue = element.getAttribute("data-grouped-task-key");
    const previousRect = layoutKey
      ? previousRects.get(`layout:${layoutKey}`)
      : taskKeyValue
        ? previousRects.get(`task:${taskKeyValue}`)
        : null;
    if (!previousRect) {
      return;
    }
    const nextRect = element.getBoundingClientRect();
    const deltaX = previousRect.left - nextRect.left;
    const deltaY = previousRect.top - nextRect.top;
    const deltaHeight = previousRect.height - nextRect.height;
    const shouldAnimateHeight = Boolean(layoutKey) && Math.abs(deltaHeight) >= 0.5;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5 && !shouldAnimateHeight) {
      return;
    }
    element.getAnimations().forEach((animation) => animation.cancel());
    const previousOverflow = element.style.overflow;
    if (shouldAnimateHeight) {
      element.style.overflow = "hidden";
    }
    const animation = element.animate(
      [
        {
          height: shouldAnimateHeight ? `${previousRect.height}px` : undefined,
          transform: `translate(${deltaX}px, ${deltaY}px)`,
        },
        {
          height: shouldAnimateHeight ? `${nextRect.height}px` : undefined,
          transform: "translate(0, 0)",
        },
      ],
      {
        duration: 150,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      },
    );
    animation.addEventListener(
      "finish",
      () => {
        element.style.overflow = previousOverflow;
      },
      { once: true },
    );
    animation.addEventListener(
      "cancel",
      () => {
        element.style.overflow = previousOverflow;
      },
      { once: true },
    );
  });
}

export function WorkspaceGroupedTasksSection({
  workspaceTabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  onSelectTask,
  onCreateTask,
  onOpenFileTree,
  onCreateGroupActionChange,
  onCreateDraftTaskActionChange,
  collapsedGroupIds,
  onGroupedTaskGroupIdsChange,
  onCollapsedGroupIdsChange,
  onStickyGroupHeaderChange,
  onOpenAutomations,
}: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCreateTask: (request?: CreateTaskRequest) => void;
  onOpenFileTree?: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  }) => void;
  onCreateGroupActionChange?: (action: (() => void) | null) => void;
  onCreateDraftTaskActionChange?: (action: (() => void) | null) => void;
  collapsedGroupIds: ReadonlySet<string>;
  onGroupedTaskGroupIdsChange?: (groupIds: string[]) => void;
  onCollapsedGroupIdsChange: (updater: (currentGroupIds: Set<string>) => Set<string>) => void;
  onStickyGroupHeaderChange?: (node: ReactNode | null) => void;
  /** 闲时系统分组的「+」/右键新建路由到 Automations 主视图。 */
  onOpenAutomations?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({
      sessionsById,
      sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath,
    }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const workspaceServiceLookup = useMemo(
    () => buildWorkspaceServiceLookup(workspaceTabs, baseServices, serviceResolverState),
    [baseServices, serviceResolverState, workspaceTabs],
  );
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const upsertOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.upsertOptimisticTaskListItem,
  );
  const setTaskUnreadIndicator = useZCodeSessionStore((state) => state.setTaskUnreadIndicator);
  // 上游新草稿模型用 draftTaskGroupId 表达分组意图：undefined = 无 grouped 草稿，
  // null = 顶部草稿，字符串 = 指定分组草稿。
  const groupedDraftTaskGroupId = useZCodeSessionStore(
    (state) =>
      selectWorkspaceZCodeState(state, activeWorkspacePath, activeWorkspaceIdentity)
        .draftTaskGroupId,
  );
  const groupedDraftFocusVersion = useZCodeSessionStore(
    (state) =>
      selectWorkspaceZCodeState(state, activeWorkspacePath, activeWorkspaceIdentity)
        .draftFocusVersion,
  );
  const clearGroupedDraftTask = useZCodeSessionStore((state) => state.clearDraftTaskGroup);
  const {
    view: authoritativeView,
    setView,
    loading,
    initialized,
    saving,
    createGroup,
    renameGroup,
    updateGroupColor,
    ungroupGroup,
    applyOrder,
  } = useGroupedTaskView({
    workspaceTabs,
  });
  const [archivingTaskKeys, setArchivingTaskKeys] = useState<ReadonlySet<string>>(() => new Set());
  const view = useMemo(
    () => filterGroupedViewByTaskKeys(authoritativeView, archivingTaskKeys),
    [archivingTaskKeys, authoritativeView],
  );

  useEffect(() => {
    if (archivingTaskKeys.size === 0) {
      return;
    }
    setArchivingTaskKeys((current) => {
      const next = new Set(
        [...current].filter((key) => findTaskInGroupedView(authoritativeView, key)),
      );
      return next.size === current.size ? current : next;
    });
  }, [archivingTaskKeys.size, authoritativeView]);
  const groupedSectionRootRef = useRef<HTMLDivElement | null>(null);
  // 已经画出过 grouped 列表：之后任何 loading/未初始化帧都不再回到空白门禁。
  // 挂载时若模块级缓存已种出非空 view，本帧就会画出列表，闩锁直接种 true——把「渲染期置位」
  // 的窗口收窄到只剩真正的首屏。
  const hasPaintedGroupedListRef = useRef(view.nodes.length > 0);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const groupMenuItemsRef = useRef<TaskGroupMenuItem[]>([]);
  const groupIdsRef = useRef<string[]>([]);
  const dragOriginViewRef = useRef<ZCodeGroupedTaskView | null>(null);
  const dragPreviewViewRef = useRef<ZCodeGroupedTaskView | null>(null);
  const lastDragOverEventRef = useRef<DragOverEvent | null>(null);
  const createDraftContextRef = useRef({
    activeTaskId,
    activeWorkspaceIdentity,
    activeWorkspacePath,
    groupedDraftTaskGroupId,
    view,
  });
  const groupDragCollapsedSnapshotRef = useRef<Set<string> | null>(null);
  const layoutAnimationFrameRef = useRef<number | null>(null);
  const dragDirectionRef = useRef<GroupedTaskDragDirectionPosition>("after");
  const lastDragDeltaYRef = useRef(0);
  const workbenchDragPayloadRef = useRef<WorkbenchSessionDragPayload | null>(null);
  const workbenchPointerPositionTrackerRef = useRef<WorkbenchPointerPositionTracker | null>(null);
  const [renamingTaskKey, setRenamingTaskKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [newGroupSetupId, setNewGroupSetupId] = useState<string | null>(null);
  const [activeDragTaskKey, setActiveDragTaskKey] = useState<string | null>(null);
  const [activeDragGroupId, setActiveDragGroupId] = useState<string | null>(null);
  const [activeDragOverlayWidth, setActiveDragOverlayWidth] = useState<number | null>(null);
  const [stickyGroupId, setStickyGroupId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
  );
  const isGroupedDraftActive = Boolean(
    groupedDraftTaskGroupId !== undefined && activeTaskId === null,
  );
  const handleGroupedPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 必须在 dnd-kit 激活前监听，才能捕获越过 6px 阈值的首个
      // pointermove；快速拖到 Workbench 后立即松手也要使用真实 viewport 坐标。
      workbenchPointerPositionTrackerRef.current?.dispose();
      workbenchPointerPositionTrackerRef.current = createWorkbenchPointerPositionTracker(
        event.currentTarget.ownerDocument,
        event.nativeEvent,
      );
    },
    [],
  );
  useEffect(
    () => () => {
      workbenchPointerPositionTrackerRef.current?.dispose();
      workbenchPointerPositionTrackerRef.current = null;
      cancelWorkbenchPointerDrag();
    },
    [],
  );
  useEffect(() => {
    createDraftContextRef.current = {
      activeTaskId,
      activeWorkspaceIdentity,
      activeWorkspacePath,
      groupedDraftTaskGroupId,
      view,
    };
  }, [
    activeTaskId,
    activeWorkspaceIdentity,
    activeWorkspacePath,
    groupedDraftTaskGroupId,
    view,
  ]);
  const handleCreateTopDraftTask = useCallback(() => {
    onCreateTask({ taskGroupId: null });
  }, [onCreateTask]);
  const handleCreateGroupDraftTask = useCallback(
    (groupId: string) => {
      onCollapsedGroupIdsChange((current) => {
        if (!current.has(groupId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(groupId);
        return next;
      });
      onCreateTask({ taskGroupId: groupId });
    },
    [onCollapsedGroupIdsChange, onCreateTask],
  );
  const handleCreateContextualDraftTask = useCallback(() => {
    const {
      activeTaskId: currentActiveTaskId,
      activeWorkspaceIdentity: currentActiveWorkspaceIdentity,
      activeWorkspacePath: currentActiveWorkspacePath,
      groupedDraftTaskGroupId: currentGroupedDraftTaskGroupId,
      view: currentView,
    } = createDraftContextRef.current;
    const activeTaskKey = currentActiveTaskId
      ? taskKey({
          taskId: currentActiveTaskId,
          workspaceIdentity: currentActiveWorkspaceIdentity,
          workspacePath: currentActiveWorkspacePath,
        })
      : null;
    const draftPlacement: GroupedDraftTaskPlacement = activeTaskKey
      ? resolveGroupedDraftTaskPlacementForTask(currentView, activeTaskKey)
      : currentGroupedDraftTaskGroupId === undefined || currentGroupedDraftTaskGroupId === null
        ? { type: "top" }
        : { type: "group", groupId: currentGroupedDraftTaskGroupId };
    if (draftPlacement.type === "group") {
      onCollapsedGroupIdsChange((current) => {
        if (!current.has(draftPlacement.groupId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(draftPlacement.groupId);
        return next;
      });
    }
    onCreateTask({ taskGroupId: draftPlacement.type === "group" ? draftPlacement.groupId : null });
  }, [onCollapsedGroupIdsChange, onCreateTask]);
  const handleCloseGroupedDraftTask = useCallback(() => {
    // grouped 草稿会在切 workspace 时迁移到目标 workspace。
    // 只能由用户关闭、真实 task 创建或明确离开草稿时清理，不能跟随列表组件卸载自动清掉。
    clearGroupedDraftTask(activeWorkspacePath, activeWorkspaceIdentity);
  }, [activeWorkspaceIdentity, activeWorkspacePath, clearGroupedDraftTask]);
  useEffect(() => {
    onCreateDraftTaskActionChange?.(handleCreateContextualDraftTask);
    return () => onCreateDraftTaskActionChange?.(null);
  }, [handleCreateContextualDraftTask, onCreateDraftTaskActionChange]);
  useEffect(() => {
    if (groupedDraftTaskGroupId !== null) {
      return;
    }
    const rootElement = groupedSectionRootRef.current;
    if (!rootElement) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      const scrollContainer = findNearestScrollableAncestor(rootElement);
      // 全局 New task 的草稿创建在 grouped 列表顶部。
      // 用户可能已经滚到下面的 group；这里按入口语义把列表滚动条归零，而不是只保证草稿可见。
      scrollContainer?.scrollTo({ top: 0 });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [groupedDraftFocusVersion, groupedDraftTaskGroupId]);
  const groups = useMemo<TaskGroupMenuItem[]>(() => {
    const nextGroups = view.nodes.flatMap((node) =>
      node.type === "group"
        ? [
            {
              id: node.group.id,
              title: node.group.title,
              color: node.group.color,
            },
          ]
        : [],
    );
    if (areTaskGroupMenuItemsEqual(groupMenuItemsRef.current, nextGroups)) {
      return groupMenuItemsRef.current;
    }
    groupMenuItemsRef.current = nextGroups;
    return nextGroups;
  }, [view.nodes]);
  const groupIds = useMemo(() => {
    const nextGroupIds = getGroupedTaskGroupIds(view);
    if (areStringArraysEqual(groupIdsRef.current, nextGroupIds)) {
      return groupIdsRef.current;
    }
    groupIdsRef.current = nextGroupIds;
    return nextGroupIds;
  }, [view]);
  useEffect(() => {
    onGroupedTaskGroupIdsChange?.(groupIds);
  }, [groupIds, onGroupedTaskGroupIdsChange]);
  useEffect(() => {
    const rootElement = groupedSectionRootRef.current;
    if (!rootElement || activeDragTaskKey !== null || activeDragGroupId !== null) {
      setStickyGroupId(null);
      return undefined;
    }
    const scrollContainer = findNearestScrollableAncestor(rootElement);
    if (!scrollContainer) {
      setStickyGroupId(null);
      return undefined;
    }
    let animationFrame: number | null = null;
    const updateStickyGroup = () => {
      animationFrame = null;
      setStickyGroupId(resolveStickyGroupedTaskGroupId(rootElement));
    };
    const scheduleUpdate = () => {
      if (animationFrame !== null) {
        return;
      }
      animationFrame = window.requestAnimationFrame(updateStickyGroup);
    };
    updateStickyGroup();
    scrollContainer.addEventListener("scroll", scheduleUpdate, {
      passive: true,
    });
    window.addEventListener("resize", scheduleUpdate);
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(rootElement);
    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      scrollContainer.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver?.disconnect();
    };
  }, [
    activeDragGroupId,
    activeDragTaskKey,
    collapsedGroupIds,
    groupedDraftTaskGroupId,
    view.nodes,
  ]);
  const workspaceTabByKey = useMemo(
    () =>
      new Map(
        workspaceTabs.map((tab) => [
          buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
          tab,
        ]),
      ),
    [workspaceTabs],
  );

  const getTaskWorkspaceLabel = useCallback(
    (task: ZCodeTaskMeta) => {
      const tab = workspaceTabByKey.get(
        buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
      );
      if (tab?.workspacePurpose === "conversation") {
        return intl.formatMessage({
          id: "workspaceSidebar.conversationsSection",
        });
      }
      return tab?.label || getPathLeaf(task.workspacePath) || task.workspacePath;
    },
    [intl, workspaceTabByKey],
  );
  const draftWorkspaceLabel = useMemo(() => {
    const tab = workspaceTabByKey.get(
      buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity),
    );
    if (tab?.workspacePurpose === "conversation") {
      return intl.formatMessage({
        id: "workspaceSidebar.conversationsSection",
      });
    }
    return tab?.label || getPathLeaf(activeWorkspacePath) || activeWorkspacePath;
  }, [activeWorkspaceIdentity, activeWorkspacePath, intl, workspaceTabByKey]);

  const getTaskRemoteSessionId = useCallback(
    (task: ZCodeTaskMeta) =>
      workspaceServiceLookup.get(buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity))
        ?.remoteSessionId,
    [workspaceServiceLookup],
  );

  const handleOpenTaskFileTree = useCallback(
    (task: ZCodeTaskMeta) => {
      const target = resolveTaskFileTreeTargetFromTabs(task, workspaceTabs);
      if (!onOpenFileTree || !target) {
        return;
      }
      onOpenFileTree(target);
    },
    [onOpenFileTree, workspaceTabs],
  );

  const handleCreateGroup = useCallback(() => {
    void createGroup()
      .then((group) => {
        setNewGroupSetupId(group.id);
      })
      .catch(() => {
        toast(intl.formatMessage({ id: "taskGroup.createFailed" }));
      });
  }, [createGroup, intl]);

  useEffect(() => {
    onCreateGroupActionChange?.(handleCreateGroup);
    return () => onCreateGroupActionChange?.(null);
  }, [handleCreateGroup, onCreateGroupActionChange]);

  const handleNewGroupSetupStarted = useCallback((groupId: string) => {
    setNewGroupSetupId((currentGroupId) => (currentGroupId === groupId ? null : currentGroupId));
  }, []);

  const handleToggleGroupCollapsed = useCallback(
    (groupId: string) => {
      onCollapsedGroupIdsChange((currentGroupIds) => {
        const nextGroupIds = new Set(currentGroupIds);
        if (nextGroupIds.has(groupId)) {
          nextGroupIds.delete(groupId);
        } else {
          nextGroupIds.add(groupId);
        }
        return nextGroupIds;
      });
    },
    [onCollapsedGroupIdsChange],
  );
  const isGroupCollapsed = useCallback(
    (groupId: string) => collapsedGroupIds.has(groupId),
    [collapsedGroupIds],
  );

  const handleCancelRenameTask = useCallback(() => {
    setRenamingTaskKey(null);
    setRenameDraft("");
  }, []);

  const handleStartRenameTask = useCallback((task: ZCodeTaskMeta) => {
    setRenamingTaskKey(taskKey(task));
    setRenameDraft(task.title ?? "");
  }, []);

  const handleMoveTaskToGroup = useCallback(
    (task: ZCodeTaskMeta, groupId: string | null) => {
      // archivingTaskKeys 过滤后的 view 只用于渲染；若拿它计算并持久化排序，
      // 归档请求失败前的任意结构变更都会把被隐藏任务从权威分组中永久删除。
      const nextView = moveTaskByMenu(authoritativeView, asProjectTask(task), groupId);
      if (nextView === authoritativeView) {
        return;
      }
      void applyOrder(nextView).catch(() => {
        toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
      });
    },
    [applyOrder, authoritativeView, intl],
  );

  const handleMoveTaskToTop = useCallback(
    (task: ZCodeTaskMeta) => {
      const nextView = moveTaskToTopByMenu(authoritativeView, asProjectTask(task));
      if (nextView === authoritativeView) {
        return;
      }
      void applyOrder(nextView).catch(() => {
        toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
      });
    },
    [applyOrder, authoritativeView, intl],
  );

  const handleSubmitRenameTask = useCallback(async () => {
    if (!renamingTaskKey) {
      return;
    }

    const task = findTaskInGroupedView(view, renamingTaskKey);
    if (!task) {
      handleCancelRenameTask();
      return;
    }
    const workspaceServices = workspaceServiceLookup.get(
      buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
    );
    if (!workspaceServices) {
      handleCancelRenameTask();
      return;
    }

    const normalizedTitle = renameDraft.trim();
    if (normalizedTitle === (task.title ?? "").trim()) {
      handleCancelRenameTask();
      return;
    }

    try {
      const meta = await workspaceServices.services.zcodeTaskService.renameTask({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        title: normalizedTitle,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      });

      if (!meta) {
        toast(intl.formatMessage({ id: "taskList.renameFailed" }));
        return;
      }

      setView((currentView) => replaceTaskInGroupedView(currentView, { ...task, ...meta }));
      upsertOptimisticTaskListItem(task.workspacePath, meta, task.workspaceIdentity);
      applyTaskQueryCacheMutation({
        previousTask: task,
        nextTask: meta,
        previousState: { pinned: false, archived: false },
        nextState: { pinned: false, archived: false },
      });
      handleCancelRenameTask();
    } catch {
      toast(intl.formatMessage({ id: "taskList.renameFailed" }));
    }
  }, [
    handleCancelRenameTask,
    intl,
    renameDraft,
    renamingTaskKey,
    setView,
    upsertOptimisticTaskListItem,
    view,
    workspaceServiceLookup,
  ]);

  const handleMarkTaskAsUnread = useCallback(
    (task: ZCodeTaskMeta) => {
      const workspaceServices = workspaceServiceLookup.get(
        buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
      );
      if (!workspaceServices) {
        return;
      }

      void workspaceServices.services.zcodeTaskService
        .setTaskUnread({
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          unread: true,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        })
        .then((meta) => {
          setTaskUnreadIndicator(task.workspacePath, task.taskId, true, task.workspaceIdentity);
          setView((currentView) =>
            replaceTaskInGroupedView(currentView, { ...asProjectTask(task), ...meta }),
          );
          upsertOptimisticTaskListItem(task.workspacePath, meta, task.workspaceIdentity);
          applyTaskQueryCacheMutation({
            previousTask: task,
            nextTask: meta,
            previousState: { pinned: false, archived: false },
            nextState: { pinned: false, archived: false },
          });
        })
        .catch(() => {
          toast(intl.formatMessage({ id: "taskList.markAsUnreadFailed" }));
        });
    },
    [intl, setTaskUnreadIndicator, setView, upsertOptimisticTaskListItem, workspaceServiceLookup],
  );

  const handleCloseTask = useCallback(
    (task: ZCodeTaskMeta) => {
      const workspaceServices = workspaceServiceLookup.get(
        buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
      );
      if (!workspaceServices) {
        return;
      }

      const closingTaskKey = taskKey(task);
      setArchivingTaskKeys((current) => {
        if (current.has(closingTaskKey)) {
          return current;
        }
        return new Set(current).add(closingTaskKey);
      });

      void workspaceServices.services.zcodeTaskService
        .archiveTask({
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        })
        .then((meta) => {
          // grouped 的后台 refresh 可能携带归档前的 membership，直接覆盖乐观删除。
          // 归档成功后主动换代 membership；渲染层在权威列表确认消失前继续屏蔽该 task。
          bumpTaskListMembershipVersion();
          removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
          // 旧 fork 的 remotePinnedTaskStore / remoteTimelineTaskStore 已被上游移除；
          // 远程置顶/时间线列表现在由 Window Host Controller 统一投影，归档后随
          // membership 换代自动消失，不再有需要单独清理的 renderer 侧缓存。
          applyTaskQueryCacheMutation({
            previousTask: task,
            nextTask: meta,
            previousState: { pinned: false, archived: false },
            nextState: { pinned: false, archived: true },
          });
        })
        .catch(() => {
          setArchivingTaskKeys((current) => {
            if (!current.has(closingTaskKey)) {
              return current;
            }
            const next = new Set(current);
            next.delete(closingTaskKey);
            return next;
          });
          toast(intl.formatMessage({ id: "taskList.archiveFailed" }));
        });
    },
    [intl, removeTaskState, workspaceServiceLookup],
  );

  const handleRenameGroup = useCallback(
    (groupId: string, title: string) => {
      void renameGroup(groupId, title).catch(() => {
        toast(intl.formatMessage({ id: "taskGroup.renameFailed" }));
      });
    },
    [intl, renameGroup],
  );

  const handleUpdateGroupColor = useCallback(
    (groupId: string, color: ZCodeTaskGroupColor) => {
      void updateGroupColor(groupId, color).catch(() => {
        toast(intl.formatMessage({ id: "taskGroup.colorFailed" }));
      });
    },
    [intl, updateGroupColor],
  );

  const handleUngroupGroup = useCallback(
    (groupId: string) => {
      void ungroupGroup(groupId).catch(() => {
        toast(intl.formatMessage({ id: "taskGroup.ungroupFailed" }));
      });
    },
    [intl, ungroupGroup],
  );

  useEffect(() => {
    return () => {
      if (layoutAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutAnimationFrameRef.current);
      }
    };
  }, []);

  const setViewWithGroupedTaskAnimation = useCallback(
    (nextView: ZCodeGroupedTaskView) => {
      const previousRects = collectGroupedTaskLayoutRects(groupedSectionRootRef.current);
      setView(nextView);
      if (layoutAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutAnimationFrameRef.current);
      }
      layoutAnimationFrameRef.current = window.requestAnimationFrame(() => {
        layoutAnimationFrameRef.current = null;
        animateGroupedTaskLayoutFrom(groupedSectionRootRef.current, previousRects);
      });
    },
    [setView],
  );

  useEffect(() => {
    if (!renamingTaskKey) {
      return;
    }
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingTaskKey]);

  useEffect(() => {
    if (!renamingTaskKey) {
      return;
    }
    if (!findTaskInGroupedView(view, renamingTaskKey)) {
      handleCancelRenameTask();
    }
  }, [handleCancelRenameTask, renamingTaskKey, view]);

  const restoreGroupDragCollapsedState = useCallback(() => {
    const snapshot = groupDragCollapsedSnapshotRef.current;
    if (!snapshot) {
      return;
    }
    groupDragCollapsedSnapshotRef.current = null;
    onCollapsedGroupIdsChange(() => new Set(snapshot));
  }, [onCollapsedGroupIdsChange]);

  const handleGroupedTaskDragStart = useCallback(
    (event: DragStartEvent) => {
      dragDirectionRef.current = "after";
      lastDragDeltaYRef.current = 0;
      lastDragOverEventRef.current = null;
      const nextActiveGroupId = getGroupedTaskDragGroupId(event.active.data.current);
      if (nextActiveGroupId) {
        dragOriginViewRef.current = authoritativeView;
        dragPreviewViewRef.current = authoritativeView;
        groupDragCollapsedSnapshotRef.current = new Set(collapsedGroupIds);
        setActiveDragGroupId(nextActiveGroupId);
        const nextWidth = measureGroupedGroupPreviewWidth(
          groupedSectionRootRef.current,
          nextActiveGroupId,
        );
        if (nextWidth !== null) {
          setActiveDragOverlayWidth(nextWidth);
        }
        onCollapsedGroupIdsChange((currentGroupIds) => {
          if (currentGroupIds.has(nextActiveGroupId)) {
            return currentGroupIds;
          }
          const nextGroupIds = new Set(currentGroupIds);
          nextGroupIds.add(nextActiveGroupId);
          return nextGroupIds;
        });
        return;
      }
      const nextActiveTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
      if (!nextActiveTaskKey) {
        return;
      }
      const activeTask = findTaskInGroupedView(view, nextActiveTaskKey);
      if (activeTask) {
        workbenchDragPayloadRef.current = {
          kind: "zcode/session",
          workspacePath: activeTask.workspacePath,
          workspaceIdentity: activeTask.workspaceIdentity,
          remoteSessionId: getTaskRemoteSessionId(activeTask),
          sessionId: activeTask.taskId,
        };
      }
      dragOriginViewRef.current = authoritativeView;
      dragPreviewViewRef.current = authoritativeView;
      // task overlay 宽度只在 drag start 测一次。
      // 之前依赖 view 的 layout effect 会在每次拖拽 preview 重排后同步 setState，容易和 dnd-kit 测量形成嵌套更新循环。
      const nextWidth = measureGroupedTaskPreviewWidth(
        groupedSectionRootRef.current,
        nextActiveTaskKey,
      );
      if (nextWidth !== null) {
        setActiveDragOverlayWidth(nextWidth);
      }
      setActiveDragTaskKey(nextActiveTaskKey);
    },
    [collapsedGroupIds, getTaskRemoteSessionId, onCollapsedGroupIdsChange, authoritativeView, view],
  );

  const applyGroupedTaskDragOverPreview = useCallback(
    (event: DragOverEvent) => {
      const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
      const activeGroupId = getGroupedTaskDragGroupId(event.active.data.current);
      if ((!activeTaskKey && !activeGroupId) || !event.over) {
        return;
      }
      const currentPreviewView = dragPreviewViewRef.current ?? authoritativeView;
      const dragDirection = dragDirectionRef.current;
      const nextView = activeGroupId
        ? getGroupedGroupOverTaskPreviewView(
            getGroupedGroupOverGroupPreviewView(currentPreviewView, event, dragDirection),
            event,
            dragDirection,
          )
        : getGroupedTaskOverTaskPreviewView(
            getGroupedTaskOverEmptyDropZonePreviewView(
              getGroupedTaskOverGroupFooterPreviewView(
                getGroupedTaskOverGroupHeaderPreviewView(
                  getGroupedTaskOverCollapsedGroupPreviewView(
                    currentPreviewView,
                    event,
                    dragDirection,
                  ),
                  event,
                  dragDirection,
                ),
                event,
                dragDirection,
              ),
              event,
            ),
            event,
            dragDirection,
          );
      if (
        nextView === currentPreviewView ||
        getGroupedTaskViewSignature(nextView) === getGroupedTaskViewSignature(currentPreviewView)
      ) {
        return;
      }
      dragPreviewViewRef.current = nextView;
      setViewWithGroupedTaskAnimation(nextView);
    },
    [authoritativeView, setViewWithGroupedTaskAnimation],
  );

  const handleGroupedTaskDragMove = useCallback(
    (event: DragMoveEvent) => {
      const workbenchPayload = workbenchDragPayloadRef.current;
      const position = workbenchPointerPositionTrackerRef.current?.getPosition();
      if (workbenchPayload && position) {
        updateWorkbenchPointerDrag(workbenchPayload, position.x, position.y);
      }
      const nextDeltaY = event.delta.y;
      const previousDirection = dragDirectionRef.current;
      if (nextDeltaY > lastDragDeltaYRef.current) {
        dragDirectionRef.current = "after";
      } else if (nextDeltaY < lastDragDeltaYRef.current) {
        dragDirectionRef.current = "before";
      }
      lastDragDeltaYRef.current = nextDeltaY;
      if (dragDirectionRef.current !== previousDirection && lastDragOverEventRef.current) {
        applyGroupedTaskDragOverPreview(lastDragOverEventRef.current);
      }
    },
    [applyGroupedTaskDragOverPreview],
  );

  const handleGroupedTaskDragOver = useCallback(
    (event: DragOverEvent) => {
      lastDragOverEventRef.current = event.over ? event : null;
      applyGroupedTaskDragOverPreview(event);
    },
    [applyGroupedTaskDragOverPreview],
  );

  const resetGroupedTaskDrag = useCallback(() => {
    cancelWorkbenchPointerDrag();
    workbenchDragPayloadRef.current = null;
    workbenchPointerPositionTrackerRef.current?.dispose();
    workbenchPointerPositionTrackerRef.current = null;
    setActiveDragTaskKey(null);
    setActiveDragGroupId(null);
    setActiveDragOverlayWidth(null);
    dragDirectionRef.current = "after";
    lastDragDeltaYRef.current = 0;
    lastDragOverEventRef.current = null;
    dragOriginViewRef.current = null;
    dragPreviewViewRef.current = null;
  }, []);

  const handleGroupedTaskDragCancel = useCallback(
    (event?: DragCancelEvent) => {
      const activeGroupId =
        getGroupedTaskDragGroupId(event?.active.data.current) ?? activeDragGroupId;
      if (activeGroupId) {
        restoreGroupDragCollapsedState();
        resetGroupedTaskDrag();
        return;
      }
      if (dragOriginViewRef.current) {
        setViewWithGroupedTaskAnimation(dragOriginViewRef.current);
      }
      resetGroupedTaskDrag();
    },
    [
      activeDragGroupId,
      resetGroupedTaskDrag,
      restoreGroupDragCollapsedState,
      setViewWithGroupedTaskAnimation,
    ],
  );

  const handleGroupedTaskDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeGroupId =
        getGroupedTaskDragGroupId(event.active.data.current) ?? activeDragGroupId;
      if (activeGroupId) {
        const originView = dragOriginViewRef.current;
        const currentPreviewView = dragPreviewViewRef.current ?? authoritativeView;
        const nextView = currentPreviewView;
        restoreGroupDragCollapsedState();
        resetGroupedTaskDrag();
        if (
          !originView ||
          getGroupedTaskViewSignature(nextView) === getGroupedTaskViewSignature(originView)
        ) {
          if (originView) {
            setViewWithGroupedTaskAnimation(originView);
          }
          return;
        }
        setViewWithGroupedTaskAnimation(nextView);
        void applyOrder(nextView).catch(() => {
          setViewWithGroupedTaskAnimation(originView);
          toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
        });
        return;
      }
      const originView = dragOriginViewRef.current;
      const workbenchPayload = workbenchDragPayloadRef.current;
      const workbenchDropPosition =
        workbenchPointerPositionTrackerRef.current?.getPosition() ?? null;
      if (
        originView &&
        workbenchPayload &&
        workbenchDropPosition &&
        finishWorkbenchPointerDrag(
          workbenchPayload,
          workbenchDropPosition.x,
          workbenchDropPosition.y,
        )
      ) {
        resetGroupedTaskDrag();
        setViewWithGroupedTaskAnimation(originView);
        return;
      }
      const currentPreviewView = dragPreviewViewRef.current ?? authoritativeView;
      const nextView = currentPreviewView;
      resetGroupedTaskDrag();
      if (
        !originView ||
        getGroupedTaskViewSignature(nextView) === getGroupedTaskViewSignature(originView)
      ) {
        if (originView) {
          setViewWithGroupedTaskAnimation(originView);
        }
        return;
      }
      setViewWithGroupedTaskAnimation(nextView);
      void applyOrder(nextView).catch(() => {
        setViewWithGroupedTaskAnimation(originView);
        toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
      });
    },
    [
      activeDragGroupId,
      applyOrder,
      authoritativeView,
      intl,
      resetGroupedTaskDrag,
      restoreGroupDragCollapsedState,
      setViewWithGroupedTaskAnimation,
    ],
  );

  const activeDragTask = useMemo(
    () => (activeDragTaskKey ? findTaskInGroupedView(view, activeDragTaskKey) : null),
    [activeDragTaskKey, view],
  );
  const activeDragGroup = useMemo(
    () =>
      activeDragGroupId
        ? view.nodes.find((node) => node.type === "group" && node.group.id === activeDragGroupId)
        : null,
    [activeDragGroupId, view.nodes],
  );

  useEffect(() => {
    const dragging = activeDragTaskKey !== null || activeDragGroupId !== null;
    if (!dragging || typeof document === "undefined") {
      return undefined;
    }
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = previousCursor;
    };
  }, [activeDragTaskKey, activeDragGroupId]);

  const groupedTooltipsDisabled = activeDragTaskKey !== null || activeDragGroupId !== null;
  const stickyGroupNode = useMemo(
    () =>
      stickyGroupId
        ? view.nodes.find((node) => node.type === "group" && node.group.id === stickyGroupId)
        : null,
    [view.nodes, stickyGroupId],
  );
  useEffect(() => {
    if (!onStickyGroupHeaderChange) {
      return undefined;
    }
    if (stickyGroupNode?.type !== "group") {
      onStickyGroupHeaderChange(null);
      return () => onStickyGroupHeaderChange(null);
    }
    onStickyGroupHeaderChange(
      <StickyGroupHeader
        node={stickyGroupNode}
        collapsed={collapsedGroupIds.has(stickyGroupNode.group.id)}
        tooltipsDisabled={groupedTooltipsDisabled}
        onCreateTask={() => handleCreateGroupDraftTask(stickyGroupNode.group.id)}
        onToggleCollapsed={handleToggleGroupCollapsed}
        onUpdateGroupColor={handleUpdateGroupColor}
        onUngroupGroup={handleUngroupGroup}
      />,
    );
    return () => onStickyGroupHeaderChange(null);
  }, [
    collapsedGroupIds,
    groupedTooltipsDisabled,
    handleCreateGroupDraftTask,
    onOpenAutomations,
    handleToggleGroupCollapsed,
    handleUngroupGroup,
    handleUpdateGroupColor,
    onStickyGroupHeaderChange,
    stickyGroupNode,
  ]);

  const renderTopLevelNode = useCallback(
    (node: ZCodeGroupedTaskView["nodes"][number]) =>
      node.type === "group" ? (
        <div key={node.group.id} data-grouped-layout-key={`group:${node.group.id}`}>
          <GroupItem
            node={node}
            groups={groups}
            activeWorkspacePath={activeWorkspacePath}
            activeWorkspaceIdentity={activeWorkspaceIdentity}
            activeTaskId={activeTaskId}
            getTaskRemoteSessionId={getTaskRemoteSessionId}
            getTaskWorkspaceLabel={getTaskWorkspaceLabel}
            onSelectTask={onSelectTask}
            onCloseTask={handleCloseTask}
            onOpenFileTree={onOpenFileTree ? handleOpenTaskFileTree : undefined}
            onCreateTask={() => handleCreateGroupDraftTask(node.group.id)}
            hasDraftTask={groupedDraftTaskGroupId === node.group.id}
            draftTaskActive={isGroupedDraftActive}
            draftWorkspaceLabel={draftWorkspaceLabel}
            onSelectDraftTask={() => handleCreateGroupDraftTask(node.group.id)}
            onCloseDraftTask={handleCloseGroupedDraftTask}
            onRenameGroup={handleRenameGroup}
            onUpdateGroupColor={handleUpdateGroupColor}
            onUngroupGroup={handleUngroupGroup}
            onMoveTaskToGroup={handleMoveTaskToGroup}
            onMoveTaskToTop={handleMoveTaskToTop}
            onStartRenameTask={handleStartRenameTask}
            onArchiveTask={handleCloseTask}
            onMarkTaskAsUnread={handleMarkTaskAsUnread}
            newGroupSetup={newGroupSetupId === node.group.id}
            onNewGroupSetupStarted={handleNewGroupSetupStarted}
            collapsed={collapsedGroupIds.has(node.group.id)}
            onToggleCollapsed={handleToggleGroupCollapsed}
            activeDragTaskKey={activeDragTaskKey}
            activeDragGroupId={activeDragGroupId}
            tooltipsDisabled={groupedTooltipsDisabled}
          />
        </div>
      ) : (
        <GroupedTaskItem
          key={taskKey(node.task)}
          task={node.task}
          groups={groups}
          remoteSessionId={getTaskRemoteSessionId(node.task)}
          workspaceLabel={getTaskWorkspaceLabel(node.task)}
          activeWorkspacePath={activeWorkspacePath}
          activeWorkspaceIdentity={activeWorkspaceIdentity}
          activeTaskId={activeTaskId}
          onSelectTask={onSelectTask}
          onCloseTask={handleCloseTask}
          onOpenFileTree={onOpenFileTree ? handleOpenTaskFileTree : undefined}
          onMoveTaskToGroup={handleMoveTaskToGroup}
          onMoveTaskToTop={handleMoveTaskToTop}
          onStartRenameTask={handleStartRenameTask}
          onArchiveTask={handleCloseTask}
          onMarkTaskAsUnread={handleMarkTaskAsUnread}
          dragId={taskKey(node.task)}
          dragging={activeDragTaskKey === taskKey(node.task)}
          tooltipsDisabled={groupedTooltipsDisabled}
        />
      ),
    [
      activeTaskId,
      activeWorkspaceIdentity,
      activeWorkspacePath,
      activeDragTaskKey,
      activeDragGroupId,
      groupedTooltipsDisabled,
      collapsedGroupIds,
      draftWorkspaceLabel,
      getTaskRemoteSessionId,
      getTaskWorkspaceLabel,
      groupedDraftTaskGroupId,
      groups,
      handleCloseGroupedDraftTask,
      handleCloseTask,
      handleCreateGroupDraftTask,
      onOpenAutomations,
      handleMoveTaskToGroup,
      handleMoveTaskToTop,
      handleNewGroupSetupStarted,
      handleOpenTaskFileTree,
      handleRenameGroup,
      handleToggleGroupCollapsed,
      handleUngroupGroup,
      handleUpdateGroupColor,
      handleMarkTaskAsUnread,
      handleStartRenameTask,
      isGroupedDraftActive,
      newGroupSetupId,
      onOpenFileTree,
      onSelectTask,
    ],
  );

  // 首次权威请求结束前既需要阻止 grouped draft/空态抢先出现，又曾把这个
  // 数据门禁直接渲染成“正在获取任务”；切换到分组时，置顶列表下方因此闪出无帮助的文案。
  // 这里保留 initialized 门禁但隐藏主体，数据就绪后再一次性展示权威列表。
  // 门禁只该拦首屏。之前每次会话流式节点都可能让它回关，
  // grouped 整棵子树随之卸载再重挂载——这就是「左侧分组列表整块闪一下」。
  // 画过一次列表后一律继续渲染，旧数据优于空白。
  if (
    shouldHideGroupedTaskContent({
      initialized,
      loading,
      hasNodes: view.nodes.length > 0,
      hasPaintedOnce: hasPaintedGroupedListRef.current,
    })
  ) {
    return null;
  }
  if (view.nodes.length > 0) {
    // 渲染期写 ref 的前提（禁止照搬到非单调状态）：本 ref 是单调闩锁（false→true，永不回落），
    // 新值只由本次渲染的 view 内容推导。concurrent 下被丢弃的渲染也会执行这次赋值，最坏结果是
    // 门禁提前开门一帧、显示空态文案而不是隐藏；对可回落状态用同样写法则会产生不可复现的漏帧。
    hasPaintedGroupedListRef.current = true;
  }
  const dragOverlayWidthStyle = activeDragOverlayWidth
    ? { width: `${activeDragOverlayWidth}px` }
    : undefined;
  const dragOverlayWidthClassName =
    "transition-[width,max-width] duration-150 ease-out motion-reduce:transition-none";

  const groupedTaskDragOverlay = (
    <DragOverlay dropAnimation={GROUPED_TASK_DROP_ANIMATION}>
      {activeDragTask ? (
        <div className={dragOverlayWidthClassName} style={dragOverlayWidthStyle}>
          <GroupedTaskItem
            task={activeDragTask}
            groups={groups}
            remoteSessionId={getTaskRemoteSessionId(activeDragTask)}
            workspaceLabel={getTaskWorkspaceLabel(activeDragTask)}
            activeWorkspacePath={activeWorkspacePath}
            activeWorkspaceIdentity={activeWorkspaceIdentity}
            activeTaskId={activeTaskId}
            onSelectTask={onSelectTask}
            onCloseTask={handleCloseTask}
            onOpenFileTree={onOpenFileTree ? handleOpenTaskFileTree : undefined}
            onMoveTaskToGroup={handleMoveTaskToGroup}
            onMoveTaskToTop={handleMoveTaskToTop}
            onStartRenameTask={handleStartRenameTask}
            onArchiveTask={handleCloseTask}
            onMarkTaskAsUnread={handleMarkTaskAsUnread}
            dragId={activeDragTaskKey ?? undefined}
            dragOverlay
          />
        </div>
      ) : activeDragGroup?.type === "group" ? (
        <GroupDragOverlay
          node={activeDragGroup}
          className={dragOverlayWidthClassName}
          style={dragOverlayWidthStyle}
        />
      ) : null}
    </DragOverlay>
  );

  return (
    <>
      <TaskRenameDialog
        open={renamingTaskKey !== null}
        value={renameDraft}
        inputRef={renameInputRef}
        intl={intl}
        onOpenChange={(open) => {
          if (!open) {
            handleCancelRenameTask();
          }
        }}
        onChange={setRenameDraft}
        onCancel={handleCancelRenameTask}
        onConfirm={() => {
          void handleSubmitRenameTask();
        }}
      />
      <DndContext
        sensors={sensors}
        autoScroll={{ threshold: GROUPED_TASK_AUTO_SCROLL_THRESHOLD }}
        collisionDetection={groupedTaskCollisionDetection}
        onDragStart={handleGroupedTaskDragStart}
        onDragMove={handleGroupedTaskDragMove}
        onDragOver={handleGroupedTaskDragOver}
        onDragEnd={handleGroupedTaskDragEnd}
        onDragCancel={handleGroupedTaskDragCancel}
      >
        <div
          ref={groupedSectionRootRef}
          onPointerDownCapture={handleGroupedPointerDownCapture}
          className={cn("pb-4", saving && "opacity-90")}
        >
          {groupedDraftTaskGroupId === null ? (
            <GroupedDraftTaskRow
              active={isGroupedDraftActive}
              workspaceLabel={draftWorkspaceLabel}
              onSelect={handleCreateTopDraftTask}
              onClose={handleCloseGroupedDraftTask}
            />
          ) : null}
          <VirtualizedGroupedTopLevelList
            nodes={view.nodes}
            isGroupCollapsed={isGroupCollapsed}
            renderNode={renderTopLevelNode}
          />
          {view.nodes.length === 0 && groupedDraftTaskGroupId === undefined && !loading ? (
            <div className="px-3 py-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "taskList.noTasks" })}
            </div>
          ) : null}
        </div>
        {/* overlay 是鼠标浮层，挂到 body，避免被 grouped task 滚动容器的滚动条/裁剪上下文影响。 */}
        {typeof document === "undefined"
          ? groupedTaskDragOverlay
          : createPortal(groupedTaskDragOverlay, document.body)}
      </DndContext>
    </>
  );
}
