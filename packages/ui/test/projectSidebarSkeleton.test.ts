/**
 * T-SB1 / T-SB3（backlog-sweep Step 3 + Step 5）：侧栏骨架形状与双视角移除守卫。
 *
 * 形态与 projectSidebarP42.test.ts 一致：无 jsdom，纯源码形状守卫（本仓 ui 测试没有 DOM 断言），
 * 可直接 tsx --tsconfig packages/ui/tsconfig.json --test 运行。
 * T-SB1：骨架区块顺序（nav → task-list-region → scroll → footer）、文件树滑层、别名导出、
 *        新建入口分组继承、独有面逐项归宿（tab 列表 / 拖拽层 / CollapsedRail / tooltip）。
 * T-SB3：双视角 `sidebarViewMode`/切换钮/持久化键/i18n 两键全仓 0 残留；alias 后零功能残留；
 *        死文件簇按清单删除；AppProps 的重连日志链已摘除。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const uiSrc = path.join(root, "packages", "ui", "src");
const readUi = (...parts: string[]) => readFileSync(path.join(uiSrc, ...parts), "utf8");
const uiFile = (...parts: string[]) => path.join(uiSrc, ...parts);

/** 递归扫描 ui/src 下的 ts/tsx，命中即返回相对路径，用于「全仓 0 残留」判定。 */
function scanUiSources(predicate: (source: string) => boolean): string[] {
  const hits: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (predicate(readFileSync(absolute, "utf8"))) {
        hits.push(path.relative(uiSrc, absolute).replace(/\\/g, "/"));
      }
    }
  };
  walk(uiSrc);
  return hits;
}

// ---------- T-SB1：骨架形状 ----------

test("T-SB1: 骨架区块顺序 nav → task-list-region → scroll → footer（上游 :231/:232/:327）", () => {
  const index = readUi("project-sidebar", "index.tsx");
  const nav = index.indexOf("<ProjectSidebarNavigation");
  const region = index.indexOf('data-testid="sidebar-task-list-region"');
  const scroll = index.indexOf("<ScrollFadeViewport");
  const footer = index.indexOf("<WorkspaceSidebarFooter");
  for (const [name, offset] of [
    ["nav", nav],
    ["task-list-region", region],
    ["scroll", scroll],
    ["footer", footer],
  ] as const) {
    assert.ok(offset >= 0, `${name} 必须在骨架内挂载`);
  }
  assert.ok(nav < region, "导航必须在任务区之前");
  assert.ok(region < scroll, "滚动区必须包在任务区里");
  assert.ok(scroll < footer, "底部必须在滚动区之后（常驻不随列表滚动）");
  // 目录面板与既有 tripwire 断言行原文。
  assert.match(index, /data-project-sidebar-panel="navigation"/);
  assert.match(index, /<aside data-testid=\{TID_SIDEBAR\}/);
});

test("T-SB1: 导航是 omz 化子集（无 relay v2 设备头），tooltip/自动化/插件市场入口在位", () => {
  const navigation = readUi("project-sidebar", "ProjectSidebarNavigation.tsx");
  assert.match(navigation, /data-testid="sidebar-primary-navigation"/);
  assert.match(navigation, /<NewTaskButtonGroup/, "新建入口必须复用 NewTaskButtonGroup");
  assert.match(navigation, /TID_AUTOMATIONS_OPEN/, "自动化入口必须在位");
  assert.match(navigation, /"plugin-store-sidebar-open"/, "插件市场入口必须在位");
  assert.match(navigation, /<WorkspaceNewTaskTooltip/, "独有面④：tooltip 由骨架新建入口复用");
  assert.match(navigation, /ControlHintTooltip/, "禁用原因必须走既有提示组件");
  assert.doesNotMatch(
    navigation,
    /WebRemoteControlDeviceHeader|isWebRemoteControl/,
    "relay v2 面必须剔除",
  );
  // 只读闸门仍由 Shell 的 onCreateTask 承担，骨架只解释原因。
  assert.match(readUi("project-sidebar", "contract.ts"), /workspaceReadOnlyReason\?: string/);
});

test("T-SB1: 底部 banner 槽在位（omz 无注入内容，拍板遗留②）", () => {
  const footer = readUi("WorkspaceSidebarFooter.tsx");
  assert.match(footer, /banner\?: ReactNode/, "banner 槽必须声明");
  assert.match(footer, /\{banner\}/, "banner 槽必须渲染");
  assert.match(readUi("project-sidebar", "index.tsx"), /onSettingsButtonClick=\{openSettings\}/);
});

test("T-SB1: WorkspaceSidebar alias 在位（上游两行导出形态）", () => {
  const alias = readUi("WorkspaceSidebar.tsx");
  assert.match(
    alias,
    /export \{ ProjectSidebar as WorkspaceSidebar \} from "@\/project-sidebar\/index\.js";/,
  );
  assert.match(
    alias,
    /export type \{ SidebarFileTreeOpenRequest \} from "@\/project-sidebar\/contract\.js";/,
  );
  const shell = readUi("app-shell", "WorkspaceShellLayout.tsx");
  assert.match(
    shell,
    /import \{ WorkspaceSidebar, type SidebarFileTreeOpenRequest \} from "@\/WorkspaceSidebar\.js";/,
    "壳层必须从别名文件取侧栏与该类型（上游 :64 同形态）",
  );
});

test("T-SB1: 顶层新建裸调用 + 三参 start + grouped 分组继承", () => {
  const index = readUi("project-sidebar", "index.tsx");
  assert.match(
    index,
    /<ProjectSidebarNavigation props=\{props\} onCreate=\{\(\) => props\.onCreateTask\(\)\} \/>/,
    "顶层新建不得显式传 null（会抹掉当前项目）",
  );
  assert.match(
    index,
    /const start = async \(projectId\?: string, hostId\?: string, taskGroupId\?: string \| null\) =>/,
    "start 必须是三参形态（上游 :131）",
  );
  assert.match(index, /groups\.parents\.get\(/, "分组继承必须读 groups.parents");
  assert.match(index, /taskGroupKey\(\{/, "分组键必须复用 taskGroupKey");
  assert.match(index, /draftTaskGroupId/, "无活动会话时回退草稿分组意图");
  assert.match(
    index,
    /onCreate=\{\(groupId\) =>\s*action\(\(\) => start\(undefined, undefined, groupId\)\)/,
    "grouped 建组入口必须按三参序传 groupId",
  );
  assert.match(index, /\.\.\.\(hostId \? \{ hostId \} : \{\}\)/, "hostId 只在有值时透传");
});

test("T-SB1: hostId 消费闸门——DTO/透传/拒绝提示三段在位", () => {
  assert.match(
    readUi("app-shell", "types.ts"),
    /hostId\?: string;/,
    "CreateTaskOptions 必须声明 hostId",
  );
  assert.match(
    readUi("project-sidebar", "ProjectSidebarNode.tsx"),
    /\.\.\.\(remoteHost \? \{ hostId: project\.hostId \} : \{\}\)/,
    "项目行对象展开必须天然透传 hostId",
  );
  const actions = readUi("root", "useRootWorkspaceActions.ts");
  assert.match(actions, /requestedHostId !== "local"/, "非 local hostId 必须在动作边界拒绝");
  assert.match(actions, /project\.remote-host-create-unsupported/, "拒绝必须带专属提示键");
  for (const locale of ["zh-CN", "en-US"]) {
    assert.match(
      readUi("i18n", "locales", `${locale}.ts`),
      /"project\.remote-host-create-unsupported":/,
      `${locale} 必须登记拒绝提示文案`,
    );
  }
});

test("T-SB1: 独有面归宿——拖拽层在骨架内可断言，文件树滑层由骨架承接", () => {
  // ① 拖拽层：项目树自带 DndContext + DragOverlay（grouped 拖拽分组），不依赖已删的 workspace tab 列表。
  const groupedView = readUi("project-sidebar", "TaskGroupedView.tsx");
  assert.match(groupedView, /<DragOverlay/, "骨架拖拽层必须在场");
  assert.match(groupedView, /GroupDragOverlay/, "拖拽预览必须走项目树 overlay");
  assert.match(readUi("project-sidebar", "index.tsx"), /<SortableProjects/, "项目排序拖拽必须在场");
  // ② 文件树滑层：经典侧栏的内部文件树由骨架承接（omz 无 side-pane 文件管理器 tab）。
  const index = readUi("project-sidebar", "index.tsx");
  assert.match(index, /<WorkspaceFileTree/, "文件树滑层必须挂骨架");
  assert.match(index, /useProjectFileTree\(/, "useProjectFileTree 必须接入骨架");
  assert.match(index, /onViewFiles=\{openFiles\}/, "项目行查看文件必须接真");
  assert.match(index, /onOpenTaskFiles: openTaskFiles/, "任务行查看文件必须接真");
});

// ---------- T-SB3：双视角移除 ----------

test("T-SB3: 双视角状态/切换钮/持久化键在全仓 0 残留", () => {
  const residues = scanUiSources(
    (source) =>
      source.includes("sidebarViewMode") ||
      source.includes("sidebar-view-mode") ||
      source.includes("WorkspaceSidebarViewMode"),
  );
  // 删除说明注释会提到该键名（证明「上游 0 命中」的判断依据），只允许出现在壳层注释里。
  const offenders = residues.filter((file) => file !== "app-shell/WorkspaceShellLayout.tsx");
  assert.deepEqual(offenders, [], `双视角残留：${offenders.join(", ")}`);
  const shell = readUi("app-shell", "WorkspaceShellLayout.tsx");
  assert.doesNotMatch(shell, /const WORKSPACE_SIDEBAR_VIEW_MODE_STORAGE_KEY/);
  assert.doesNotMatch(shell, /data-testid="sidebar-view-mode-toggle"/);
});

test("T-SB3: i18n 两键（classicSidebarView/projectTreeView）zh/en 同步删除", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const source = readUi("i18n", "locales", `${locale}.ts`);
    assert.ok(
      !source.includes("workspaceSidebar.classicSidebarView"),
      `${locale} 残留 classicSidebarView`,
    );
    assert.ok(
      !source.includes("workspaceSidebar.projectTreeView"),
      `${locale} 残留 projectTreeView`,
    );
  }
});

test("T-SB3: alias 后零功能残留——经典侧栏实现与死文件簇按清单删除", () => {
  const alias = readUi("WorkspaceSidebar.tsx");
  for (const marker of [
    "DndContext",
    "SortableWorkspaceSidebarItem",
    "WorkspaceFileTree",
    "useWorkspaceTaskLists",
    "WorkspaceSidebarItem",
  ]) {
    assert.ok(!alias.includes(marker), `alias 文件不得残留经典侧栏实现（${marker}）`);
  }
  const deleted = [
    "SortableWorkspaceSidebar.tsx",
    "WorkspaceSidebarItem.tsx",
    "WorkspaceSidebar/ReconnectingRemoteWorkspaceLogTooltip.tsx",
    "WorkspaceSidebar/WorkspaceSidebarCollapsedRail.tsx",
    "WorkspaceSidebar/taskGroupTogglePresentation.ts",
    "WorkspaceSidebar/workspaceSidebarSelection.ts",
    "lib/workspaceSidebarDrag.ts",
  ];
  for (const file of deleted) {
    assert.ok(!existsSync(uiFile(...file.split("/"))), `${file} 必须已删除`);
  }
  // ③ CollapsedRail 全仓 0 命中（本就零消费的死导出，随 alias 退役）。
  assert.deepEqual(
    scanUiSources((source) => source.includes("WorkspaceSidebarCollapsedRail")),
    [],
  );
  // 保留下来的同目录共享件仍在位（PurposeSections/RemoteConversationDisconnected 消费）。
  assert.ok(existsSync(uiFile("WorkspaceSidebar", "WorkspacePurposeSection.tsx")));
  assert.ok(existsSync(uiFile("WorkspaceSidebar", "RemoteProjectConnectionDetails.tsx")));
});

test("T-SB3: AppProps 重连日志链摘除（侧栏不再消费 reconnecting* 两 prop）", () => {
  const types = readUi("app-shell", "types.ts");
  assert.ok(!types.includes("reconnectingRemoteWorkspaceKeys"), "AppProps 不得再声明恢复中键集合");
  assert.ok(
    !types.includes("reconnectingRemoteWorkspaceLogsByWorkspaceKey"),
    "AppProps 不得再声明重连日志集合",
  );
  const app = readUi("App.tsx");
  assert.ok(!app.includes("reconnectingRemoteWorkspaceKeys"), "App 不得再下传");
  assert.ok(
    !app.includes("reconnectingRemoteWorkspaceLogsByWorkspaceKey"),
    "App 不得再下传日志集合",
  );
  const content = readUi("root", "RootWorkspaceContent.tsx");
  assert.ok(
    !content.includes("reconnectingRemoteWorkspaceKeys={"),
    "RootWorkspaceContent 不得再转发",
  );
  assert.match(
    readUi("app-shell", "WorkspaceShellLayout.tsx"),
    /remoteWorkspaceErrorByWorkspaceKey=\{remoteWorkspaceErrorByWorkspaceKey\}/,
    "连接错误投影仍要喂项目树（ProjectSidebarProps 必填）",
  );
});
