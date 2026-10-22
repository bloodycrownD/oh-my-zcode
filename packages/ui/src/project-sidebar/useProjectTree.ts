/* eslint-disable max-lines -- 项目树读取编排单文件收口（照搬上游 v3.16.2，omz 化差异见各注释） */
import { flushSync } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  ProjectTree,
  ProjectTaskRef,
  ProjectAvailability,
  RemoteProjectDirectory,
} from "@/project-sidebar/contract.js";
import { readProjectSidebarTree } from "@/project-sidebar/project-tree-reader.js";
import { stabilizeProjectTree, applyProjectTaskActivities } from "@/project-sidebar/view.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useWorkspaceSessionsIndexItems } from "@/v4/useWorkspaceSessionsIndexItems.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { getWindowControllerTaskListRegistry } from "@/v4/windowControllerTaskListRegistry.js";
import { logger } from "@/logger.js";
import { areStabilizedValuesEquivalent } from "@/v4/taskListItemStabilization.js";
import { useProjectUnreadSignals } from "@/project-sidebar/useProjectUnreadSignals.js";

const subscribeToNothing = () => () => {};
const zeroRevision = () => 0;
// omz 化差异（对照上游 useProjectTree.ts）：
// ①windowProjectDirectory/remoteProjectService/projectChanges 缺席：P4 只接本机 Host，
//   目录投影为空集；项目写事件仍走 broadcastService "state:projects"；
// ②registry 快路径（P4.2）：Controller 在场时活动态改读 readActivities()（行已随 frame
//   常驻内存，不再按 scope 逐个订阅 sessions-index）；目录失效由 directoryRevision 驱动；
// ③useProjectUnreadSignals（P4.2）：Host onDynamicTaskUnreadSignal 完成态 → 前台离开补记/
//   导航清零，见 useProjectUnreadSignals.ts。
const EMPTY: ProjectTree = { projects: [], tasks: [] };
export function useProjectTree(isDesktop = false) {
  const services = useBaseWorkspaceServices();
  // 远端 bridge 的 base 服务属于 Source；侧栏读写与失效流必须整组来自窗口目录。
  // omz：窗口目录服务随 source-server 三期接入，当前恒为本机 base services。
  const service = services.projectService;
  const remoteService = undefined;
  const controller = services.windowControllerService;
  const registry = useMemo(
    () => (controller ? getWindowControllerTaskListRegistry(controller) : null),
    [controller],
  );
  const revision = useSyncExternalStore(
    registry?.subscribe ?? subscribeToNothing,
    registry?.getRevision ?? zeroRevision,
    registry?.getRevision ?? zeroRevision,
  );
  const directoryRevision = registry?.getDirectoryRevision() ?? 0;
  const tabs = useTabStore((state) => state.tabs);
  const version = useZCodeSessionStore((state) =>
    Object.values(state.workspaces).reduce((n, workspace) => n + workspace.taskListVersion, 0),
  );
  const [tree, setTree] = useState<ProjectTree>(EMPTY);
  const [availability, setAvailability] = useState<ReadonlyMap<string, ProjectAvailability>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const serial = useRef(0);
  const reads = useMemo(() => ({ flight: null as Promise<void> | null, dirty: false }), [service]);
  const pendingCommits = useRef(
    new Set<{
      target: ProjectTaskRef;
      commit(): void;
      organize?(): Promise<void>;
      finish(error?: unknown): void;
    }>(),
  );
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const accepted = useRef<{
    service: typeof service;
    tree: ProjectTree;
  } | null>(null);
  const readOnce = useCallback(async () => {
    const request = serial.current;
    try {
      if (!service) throw new Error("project.service-unavailable");
      const result = await readProjectSidebarTree({
        projectService: service,
        remoteProjectService: remoteService,
      });
      if (request === serial.current) {
        const previous = accepted.current;
        if (previous?.service === service) {
          for (const project of result.tree.projects) {
            const before = previous.tree.projects.find(
              (item) => item.id === project.id && item.hostId === project.hostId,
            );
            if (before && before.primaryRootStatus !== project.primaryRootStatus) {
              logger.debug("[project-sidebar] 项目主目录状态变化", {
                projectId: project.id,
                hostId: project.hostId,
                previous: before.primaryRootStatus,
                current: project.primaryRootStatus,
              });
            }
          }
        }
        accepted.current = { service, tree: result.tree };
        // Bugfix: 自动归档只改 Host archived，未执行手动归档的 UI 清理，导致列表消失而详情残留。
        // 只处理已接受快照中的明确状态转换；首次已归档、离线缺行与迟到响应都不是归档事件。
        if (previous?.service === service) {
          const key = (task: ProjectTree["tasks"][number]) =>
            JSON.stringify([
              task.hostId,
              task.workspaceIdentity?.trim() || task.workspacePath,
              task.taskId,
            ]);
          const before = new Map(previous.tree.tasks.map((task) => [key(task), task]));
          for (const task of result.tree.tasks) {
            if (task.archived && before.get(key(task))?.archived === false) {
              logger.info("[project-sidebar] 归档后清理任务展示", {
                taskId: task.taskId,
                workspacePath: task.workspacePath,
                workspaceIdentity: task.workspaceIdentity,
              });
              removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
            }
          }
        }
        const ready = [...pendingCommits.current].filter(({ target }) =>
          result.tree.tasks.some(
            (task) =>
              task.taskId === target.taskId &&
              (task.workspaceIdentity?.trim() || task.workspacePath) ===
                (target.workspaceIdentity?.trim() || target.workspacePath),
          ),
        );
        // 根因：把组织 RPC 放进共享读取屏障后，一个无回包请求会卡住整棵目录和所有首发。
        // 真实行确认后独立提交组织动作；目录发布、详情提升和导航取消都不等待它。
        for (const pending of ready) {
          if (pending.organize)
            void Promise.resolve()
              .then(pending.organize)
              .catch((cause) => logger.error("[project-sidebar] 首发组织提交失败", cause));
        }
        const commit = () => {
          setTree((previous) => stabilizeProjectTree(previous, result.tree));
          // 树已复用等价引用，但连接/入口每次 RPC 都是新对象，仍会广播整棵目录。
          // 在接收边界比较完整内容；连接变化与入口移除仍发布，不在组件 memo 中忽略字段。
          setAvailability((previous) =>
            previous.size === result.availability.size &&
            [...result.availability].every(([key, value]) =>
              areStabilizedValuesEquivalent(previous.get(key), value),
            )
              ? previous
              : result.availability,
          );
          setError(null);
          for (const pending of ready) {
            try {
              pending.commit();
              logger.info("[project-sidebar] 首发目录与详情提交", pending.target);
              pending.finish();
            } catch (cause) {
              pending.finish(cause);
              throw cause;
            }
          }
        };
        // Bug 根因：目录是 React state，详情绑定是外部 store；首发只靠事件先后不能
        // 保证同一可见帧。真实行到达后在这里一起提交，沿用原首发回调。
        if (ready.length) flushSync(commit);
        else commit();
      }
    } catch (cause) {
      if (request === serial.current) {
        setError(String(cause));
        for (const pending of pendingCommits.current) pending.finish(cause);
        logger.error("[project-sidebar] 读取项目树失败", cause);
      }
    } finally {
      if (request === serial.current) setLoading(false);
    }
  }, [service, remoteService, removeTaskState]);
  const refresh = useCallback(() => {
    reads.dirty = true;
    if (reads.flight) return reads.flight;
    const generation = serial.current;
    const flight = (async () => {
      // 事实变化只标记下一次读取，不能反复废弃当前结果，否则连续变化会饿死列表。
      while (reads.dirty && generation === serial.current) {
        reads.dirty = false;
        await readOnce();
      }
    })().finally(() => {
      if (reads.flight === flight) reads.flight = null;
    });
    reads.flight = flight;
    return flight;
  }, [readOnce, reads]);
  const commitCreatedTask = useCallback(
    (
      target: ProjectTaskRef,
      commit: () => void,
      signal?: AbortSignal,
      organize?: () => Promise<void>,
    ) => {
      if (signal?.aborted && !organize) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const complete = (error?: unknown) => {
          signal?.removeEventListener("abort", cancel);
          if (error) reject(error);
          else resolve();
        };
        const cancel = () => {
          // 导航取消立即结束 UI 等待；尚未确认的组织意图保留到真实行到达，不丢掉已 accepted 的 placement。
          if (!organize) pendingCommits.current.delete(pending);
          complete();
        };
        const pending = {
          target,
          organize,
          commit: () => {
            if (!signal?.aborted) commit();
          },
          finish(error?: unknown) {
            pendingCommits.current.delete(pending);
            complete(error);
          },
        };
        pendingCommits.current.add(pending);
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
        void refresh();
      });
    },
    [refresh],
  );
  useEffect(
    () => () => {
      serial.current++;
      reads.flight = null;
      for (const pending of pendingCommits.current) pending.finish();
    },
    [reads],
  );
  useEffect(() => {
    void refresh();
    // directoryRevision（P4.2）：目录事实变化（归属/成员/持久 meta/快照重建）驱动整树重读；
    // 普通 timeline live delta 只递增 revision，不打目录读取。
  }, [refresh, version, tabs, directoryRevision]);
  const scopes = useMemo(() => {
    const byKey = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
    for (const task of tree.tasks) byKey.set(task.workspaceIdentity || task.workspacePath, task);
    for (const project of tree.projects)
      for (const root of project.roots) byKey.set(root.rootPath, { workspacePath: root.rootPath });
    for (const tab of tabs)
      if (isWorkspaceTab(tab) && !tab.workspaceIdentity && !tab.remoteSessionId)
        byKey.set(tab.workspacePath, { workspacePath: tab.workspacePath });
    return [...byKey.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, { workspacePath, workspaceIdentity }]) => ({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      }));
  }, [tree, tabs]);
  const scopeKey = JSON.stringify(scopes);
  // 未读信号链（P4.2）：Host 完成态 → 前台离开补记 / 导航清零；放在 scopes 定形之后挂载。
  useProjectUnreadSignals(scopes, refresh, isDesktop);
  const refreshDirectory = useCallback(async () => {
    await refresh();
  }, [refresh]);
  useEffect(() => {
    // Finder/终端移走或恢复目录不会产生项目写事件；回到窗口时重新检查。
    const onFocus = () => void refreshDirectory();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshDirectory]);
  useEffect(() => {
    // registry 在场时列表活性由 Controller frame 驱动（readActivities + directoryRevision），
    // 不再按 scope 逐个订阅 sessions-index（与上游同构）；仅 web/旧 wire 回退 scope 订阅。
    const subscriptions = (registry ? [] : scopes).map((scope) =>
      services.zcodeTaskService.onDynamicWorkspaceEvent(scope)((event) => {
        if (event.type === "workspace_task_list_changed") void refresh();
      }),
    );
    // 项目写事件广播（saveProject/deleteProject/reorder 等 afterChange 链）触发整树重读。
    const broadcast = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") void refresh();
    });
    return () => {
      subscriptions.forEach((subscription) => subscription.dispose());
      broadcast.dispose();
    };
    // scopeKey 变化才重挂订阅，避免每次 refresh 重建事件流。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, services, refresh, registry]);
  const activity = useWorkspaceSessionsIndexItems(registry ? [] : scopes);
  const lastDisplay = useRef<ProjectTree>(EMPTY);
  const displayedTree = useMemo(() => {
    const activities = registry
      ? registry.readActivities()
      : activity.items.flatMap((task) => {
          const live = getTaskListRowActivity(task);
          return live
            ? [
                {
                  address: {
                    taskId: task.taskId,
                    workspacePath: task.workspacePath,
                    workspaceIdentity: task.workspaceIdentity,
                  },
                  activity: live,
                },
              ]
            : [];
        });
    const next = applyProjectTaskActivities(tree, activities);
    lastDisplay.current = stabilizeProjectTree(lastDisplay.current, next);
    return lastDisplay.current;
  }, [tree, activity.items, registry, revision]);
  return useMemo(
    () => ({
      tree: displayedTree,
      factTree: tree,
      directory: { hosts: [], entries: [] } as RemoteProjectDirectory,
      availability,
      service,
      remoteService,
      refresh: refreshDirectory,
      commitCreatedTask,
      error,
      loading,
    }),
    [
      displayedTree,
      tree,
      availability,
      service,
      remoteService,
      refreshDirectory,
      commitCreatedTask,
      error,
      loading,
    ],
  );
}
