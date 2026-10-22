/**
 * T-VU1 / T-VU2（upstream-v316-fullsync P4 Step 14）：虚拟项目 UI 消费链与纯逻辑守卫。
 *
 * 形态：无 jsdom，纯逻辑/形状测试。①消费链源码形状守卫（useProjectTree 必须经
 * useBaseWorkspaceServices 取 accessor.projectService，禁止直连 DB/私有服务）；
 * ②archive-view 分组/筛选；③projectOrder 排序协调与移动；④timelineDates 日期段。
 * 依赖零 `@/` 运行时别名（contract 只作 type import，tsx 下擦除），可直接 tsx --test。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  buildArchiveGroups,
  buildArchiveProjectOptions,
} from "../src/project-sidebar/archive-view.js";
import { moveProjectOrder, reconcileProjectOrder } from "../src/project-sidebar/projectOrder.js";
import { timelineDateHeadings } from "../src/project-sidebar/timelineDates.js";

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// ---------- T-VU1：消费链形状守卫 ----------

test("T-VU1: useProjectTree 经 useBaseWorkspaceServices 消费 IProjectService（accessor.projectService）", () => {
  const source = readFileSync(path.join(srcRoot, "project-sidebar", "useProjectTree.ts"), "utf8");
  assert.match(source, /useBaseWorkspaceServices\(\)/, "必须取 base services accessor");
  assert.match(source, /services\.projectService/, "必须消费 accessor.projectService");
  assert.doesNotMatch(source, /node:sqlite|ProjectRepository|readProjects\(/, "UI 不得触碰 DB");
});

test("T-VU1: ProjectSidebar 经 ProjectDirectoryProvider 共享目录 owner", () => {
  const index = readFileSync(path.join(srcRoot, "project-sidebar", "index.tsx"), "utf8");
  assert.match(index, /useProjectDirectory\(\)/, "侧栏必须消费共享目录 context");
  const provider = readFileSync(
    path.join(srcRoot, "project-sidebar", "ProjectDirectoryProvider.tsx"),
    "utf8",
  );
  assert.match(
    provider,
    /useProjectTree\(isDesktop\)/,
    "Provider 必须是 useProjectTree 唯一 owner",
  );
});

test("T-VU1: 壳层并存入口——经典侧栏与项目树视角二选一渲染且可切换", () => {
  const shell = readFileSync(path.join(srcRoot, "app-shell", "WorkspaceShellLayout.tsx"), "utf8");
  assert.match(shell, /sidebarViewMode === "projects"/, "项目树视角分支必须在场");
  assert.match(shell, /<ProjectDirectoryProvider/, "项目树子树必须挂目录 owner");
  assert.match(shell, /<WorkspaceSidebar/, "omz 经典侧栏必须保留（并存拍板）");
  assert.match(shell, /sidebar-view-mode-toggle/, "视角切换入口必须在场");
  assert.match(shell, /zcode:workspace-shell:sidebar-view-mode/, "视角偏好必须持久化");
});

test("T-VU1: services 公开出口暴露 IProjectService 契约且 accessor 为可选字段", () => {
  const servicesIndex = readFileSync(
    path.join(srcRoot, "..", "..", "services", "src", "index.ts"),
    "utf8",
  );
  assert.match(servicesIndex, /export \{ IProjectService, LEGACY_SINGLE_ROOT_PROJECT_PREFIX \}/);
  const accessor = readFileSync(
    path.join(srcRoot, "..", "..", "services", "src", "accessor.ts"),
    "utf8",
  );
  assert.match(accessor, /readonly projectService\?: IProjectService/, "host 未注册前必须可选");
});

// ---------- T-VU2：纯逻辑 ----------

const task = (overrides: Record<string, unknown>) => ({
  taskId: "t1",
  title: "task",
  workspacePath: "/w",
  hostId: "local",
  projectId: null,
  pinned: false,
  archived: true,
  deleted: false,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});
const project = (overrides: Record<string, unknown>) => ({
  id: "p1",
  hostId: "local",
  name: "proj",
  roots: [{ rootPath: "/w", position: 0, isPrimary: true }],
  position: 0,
  pinned: false,
  deleted: false,
  createdAt: 1,
  updatedAt: 2,
  nameOverridden: false,
  ...overrides,
});

test("T-VU2: buildArchiveGroups 只收 archived 任务并按项目分组", () => {
  const tree = {
    projects: [project({})],
    tasks: [
      task({ taskId: "a", archived: true, projectId: "p1", updatedAt: 5 }),
      task({ taskId: "b", archived: false, projectId: "p1", updatedAt: 9 }),
      task({ taskId: "c", archived: true, projectId: null, updatedAt: 3 }),
    ],
  };
  const groups = buildArchiveGroups(tree);
  assert.equal(groups.length, 2);
  const named = groups.find((g) => g.projectId === "p1");
  const unclassified = groups.find((g) => g.projectId === null);
  assert.ok(named && unclassified);
  assert.deepEqual(
    named.tasks.map((t) => t.taskId),
    ["a"],
  );
  assert.deepEqual(
    unclassified.tasks.map((t) => t.taskId),
    ["c"],
  );
  // updatedAt 降序：组间与组内都成立。
  assert.ok(named.tasks[0].updatedAt >= unclassified.tasks[0].updatedAt);
});

test("T-VU2: buildArchiveGroups 查询过滤不区分大小写；项目筛选保留身份", () => {
  const tree = {
    projects: [project({ name: "Alpha" })],
    tasks: [task({ taskId: "a", archived: true, title: "Fix LOGIN bug", projectId: "p1" })],
  };
  assert.equal(buildArchiveGroups(tree, { query: "login" }).length, 1);
  assert.equal(buildArchiveGroups(tree, { query: "nope" }).length, 0);
  const options = buildArchiveProjectOptions(tree);
  assert.equal(options.length, 1, "未归档项目也要出现在筛选选项");
});

test("T-VU2: reconcileProjectOrder 并集保留未知键；moveProjectOrder 只在分区内换位", () => {
  assert.deepEqual(reconcileProjectOrder(["k2"], ["k1", "k3"]), ["k2", "k1", "k3"]);
  const section = ["a", "b", "c"];
  assert.deepEqual(moveProjectOrder(["a", "b", "c"], section, "a", "c"), ["b", "c", "a"]);
  assert.deepEqual(moveProjectOrder(["a", "b", "c"], section, "a", "a"), ["a", "b", "c"]);
  assert.deepEqual(moveProjectOrder(["a", "b", "c"], section, "x", "c"), ["a", "b", "c"]);
});

test("T-VU2: timelineDates 日期段首行插入、连续段不重复", () => {
  const now = new Date("2026-10-22T12:00:00Z").getTime();
  const day = 86_400_000;
  const stamps = [now, now - 1000, now - day, now - day - 1000, now - 70 * day];
  const headings = timelineDateHeadings(stamps, now, "zh-CN");
  assert.equal(headings.length, stamps.length);
  assert.equal(headings[0]?.id, "taskTimeline.today");
  assert.equal(headings[1], null, "同段第二行不插标题");
  assert.equal(headings[2]?.id, "taskTimeline.yesterday");
  assert.equal(headings[4]?.id, "taskTimeline.older");
  // daysAgo 段带天数插值；older 段为静态标题。
  const threeDays = timelineDateHeadings([now - 3 * day], now, "zh-CN");
  assert.equal(threeDays[0]?.id, "taskTimeline.daysAgo");
  assert.deepEqual(threeDays[0]?.values, { days: "3" });
});
