/**
 * T-VU3（upstream-v316-fullsync P4.1 补全批）：编辑/新建/分组视角/面板作用域纯逻辑与接线守卫。
 *
 * 形态与 T-VU1/T-VU2 一致：无 jsdom，纯逻辑 + 源码形状守卫，可直接 tsx --test。
 * ①grouped-view 分组投影（collapse/空组/系统分组标题）；②workspaceSidePane 作用域
 * 可见性与关闭族（new-tab 占位/跨 scope 保留）；③P4.1 接线形状守卫（host 注册链/
 * client getter/入口真组件化/归档入口/分组视角/未读信号契约面）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  groupTaskRef,
  projectGroupedNodes,
  taskGroupKey,
  taskGroupTitleMessageId,
} from "../src/project-sidebar/grouped-view.js";
import {
  closeSidePaneTabForScope,
  ensureSidePaneTab,
  isSidePaneTabVisibleInScope,
} from "../src/lib/workspaceSidePane.js";
import { CRON_DEFAULT_GROUP_ID } from "@zcode/shared";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const uiSrc = path.join(root, "packages", "ui", "src");
const read = (...parts) => readFileSync(path.join(uiSrc, ...parts), "utf8");

const task = (taskId, overrides = {}) => ({
  taskId,
  workspacePath: "W:/proj",
  hostId: "local",
  status: "completed",
  updatedAt: 1,
  createdAt: 1,
  pinned: false,
  archived: false,
  projectId: null,
  ...overrides,
});

// ---------- T-VU3：grouped-view 分组投影 ----------

test("T-VU3: projectGroupedNodes 按 structure 投影组头/成员/未分组任务，折叠组隐藏成员", () => {
  const structure = {
    groups: [{ id: "g1", title: "组一", color: "blue", createdAt: 1, updatedAt: 1 }],
    members: [
      { groupId: "g1", workspaceKey: "W:/proj", taskId: "t1", sortOrder: 0 },
    ],
    order: [
      { type: "group", key: "g1", sortOrder: 0 },
      { type: "task", key: taskGroupKey(task("t2")), sortOrder: 1 },
    ],
  };
  const tasks = [task("t1"), task("t2")];
  const expanded = projectGroupedNodes(tasks, structure, new Set());
  assert.deepEqual(
    expanded.map((row) => row.type),
    ["group", "task", "task"],
  );
  assert.equal(expanded[0].group.id, "g1");
  assert.equal(expanded[1].task.taskId, "t1");
  assert.equal(expanded[1].groupId, "g1");
  assert.equal(expanded[2].groupId, null);
  const collapsed = projectGroupedNodes(tasks, structure, new Set(["g1"]));
  assert.deepEqual(collapsed.map((row) => row.type), ["group", "task"]);
  assert.ok(!collapsed.some((row) => row.type === "task" && row.task.taskId === "t1"));
});

test("T-VU3: 折叠空组显示 empty 占位；系统分组标题走 i18n 键", () => {
  const structure = {
    groups: [
      { id: "g1", title: "空组", color: "gray", createdAt: 1, updatedAt: 1 },
      { id: CRON_DEFAULT_GROUP_ID, title: "cron", color: "gray", createdAt: 1, updatedAt: 1 },
    ],
    members: [],
    order: [
      { type: "group", key: "g1", sortOrder: 0 },
      { type: "group", key: CRON_DEFAULT_GROUP_ID, sortOrder: 1 },
    ],
  };
  const rows = projectGroupedNodes([], structure, new Set());
  assert.deepEqual(
    rows.map((row) => row.type),
    ["group", "empty", "group", "empty"],
  );
  assert.equal(taskGroupTitleMessageId(structure.groups[0]), undefined);
  assert.equal(taskGroupTitleMessageId(structure.groups[1]), "taskGroup.cron");
  assert.deepEqual(groupTaskRef(task("t9")), {
    hostId: "local",
    taskId: "t9",
    workspacePath: "W:/proj",
  });
});

// ---------- T-VU3：workspaceSidePane 作用域化 ----------

const browserTab = {
  id: "b1",
  type: "browser",
  ownerTaskId: "task-a",
  workspaceKey: "W:/proj",
};

test("T-VU3: isSidePaneTabVisibleInScope 按 workspace+owner 收窄；new-tab 归当前 owner", () => {
  const scope = { workspaceKey: "W:/proj", ownerTaskId: "task-a" };
  assert.equal(isSidePaneTabVisibleInScope(browserTab, scope), true);
  assert.equal(
    isSidePaneTabVisibleInScope(browserTab, { workspaceKey: "W:/other", ownerTaskId: "task-a" }),
    false,
  );
  assert.equal(
    isSidePaneTabVisibleInScope(browserTab, { workspaceKey: "W:/proj", ownerTaskId: "task-b" }),
    false,
  );
  const newTab = { id: "n1", type: "new-tab", ownerTaskId: "task-b", workspaceKey: "W:/proj" };
  assert.equal(isSidePaneTabVisibleInScope(newTab, { ...scope, ownerTaskId: "task-b" }), true);
});

test("T-VU3: closeSidePaneTabForScope 关闭后 active 收敛到可见 tab；末标签触发收起由 hook 承担", () => {
  const state = {
    tabs: [
      browserTab,
      { id: "b2", type: "browser", ownerTaskId: "task-a", workspaceKey: "W:/proj" },
    ],
    activeTabId: "b1",
  };
  const scope = { workspaceKey: "W:/proj", ownerTaskId: "task-a" };
  const next = closeSidePaneTabForScope(state, "b1", scope);
  assert.equal(next.tabs.length, 1);
  assert.equal(next.activeTabId, "b2");
  const emptied = closeSidePaneTabForScope(next, "b2", scope);
  assert.equal(emptied, null);
});

test("T-VU3: ensureSidePaneTab 只为无可见标签的 scope 补 new-tab 入口", () => {
  const scope = { workspaceKey: "W:/proj", ownerTaskId: "task-a" };
  const ensured = ensureSidePaneTab(null, scope);
  assert.equal(ensured.tabs.length, 1);
  assert.equal(ensured.tabs[0].type, "new-tab");
  assert.equal(ensured.tabs[0].ownerTaskId, "task-a");
  const again = ensureSidePaneTab(ensured, scope);
  assert.equal(again, ensured, "已有可见标签时不得重复补入口");
});

// ---------- T-VU3：P4.1 接线形状守卫 ----------

test("T-VU3: host 注册链——node.ts 注册 project/task-groups 通道 + zcodeAgent 三选项", () => {
  const nodeTs = readFileSync(
    path.join(root, "packages", "services", "src", "node.ts"),
    "utf8",
  );
  assert.match(nodeTs, /\.register\(IProjectService, projectService\)/);
  assert.match(nodeTs, /\.register\(ITaskGroupService, taskGroupService\)/);
  assert.match(nodeTs, /prepareProjectExecution:/);
  assert.match(nodeTs, /prepareSessionCreation:/);
  assert.match(nodeTs, /resolveSessionDirectories:/);
  const agentService = readFileSync(
    path.join(root, "packages", "services", "src", "zcode-agent", "zcodeAgentService.ts"),
    "utf8",
  );
  assert.match(agentService, /project\.creation-unavailable/);
  assert.match(agentService, /prepareSessionCreation/);
  const client = readFileSync(
    path.join(root, "packages", "client", "src", "remoteServiceAccess.ts"),
    "utf8",
  );
  assert.match(client, /this\.projectService = ProxyChannel\.toService<IProjectService>/);
  assert.match(client, /this\.taskGroupService = ProxyChannel\.toService<ITaskGroupService>/);
});

test("T-VU3: 入口真组件化——编辑/新建/归档/分组视角/chip 入口挂载", () => {
  const sidebarIndex = read("project-sidebar", "index.tsx");
  assert.match(sidebarIndex, /setCreating\(true\)/, "新建入口必须换真组件");
  assert.match(sidebarIndex, /onEdit=\{setEditor\}/, "编辑入口必须换真组件");
  assert.match(sidebarIndex, /<ProjectCreation/, "ProjectCreation 必须挂载");
  assert.match(sidebarIndex, /<ProjectEditor/, "ProjectEditor 必须挂载");
  assert.match(sidebarIndex, /<ProjectComposerMenu/, "项目 chip 入口必须挂载");
  assert.match(sidebarIndex, /<TaskGroupedView/, "grouped 视角必须挂载");
  assert.match(sidebarIndex, /SidebarTooltipProvider/);
  const settings = read("SettingsPage.tsx");
  assert.match(settings, /<ArchiveManagement \/>/, "归档入口必须挂设置页");
  const provider = read("project-sidebar", "ProjectDirectoryProvider.tsx");
  assert.match(provider, /useTaskGroups\(result\.factTree\)/, "groups 必须接真实现");
});

test("T-VU3: 未读信号契约面先行——协议行/事件方法/host 空流发射器", () => {
  const controller = readFileSync(
    path.join(root, "packages", "services", "src", "window-controller", "windowController.ts"),
    "utf8",
  );
  assert.match(controller, /interface WindowHostTaskUnreadSignal/);
  assert.match(controller, /onDynamicTaskUnreadSignal\(\): Event<WindowHostTaskUnreadSignal>/);
  const hostService = readFileSync(
    path.join(root, "packages", "desktop", "src", "host", "windowHostControllerService.ts"),
    "utf8",
  );
  assert.match(hostService, /taskUnreadSignalEmitter = new Emitter<WindowHostTaskUnreadSignal>/);
  assert.match(hostService, /onDynamicTaskUnreadSignal\(\) \{[\s\S]*?taskUnreadSignalEmitter\.event/);
});
