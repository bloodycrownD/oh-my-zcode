// TODO(upgrade-316): 上游 v3.16 把整份 WorkspaceSidebar 实现搬到 @/project-sidebar/*，本次合并
// 也已把 fork 旧实现依赖的 helper 模块（SortableWorkspaceSidebar、useWorkspaceTaskLists、
// sidebarTaskPreferences、workspacePurpose、WorkspaceArchivedTasksFlatSection /
// WorkspacePinnedTasksSection / WorkspaceTimelineTasksSection、workspace-grouped-tasks/* 等）
// 标记为删除，fork 版 WorkspaceSidebar.tsx 已无法独立编译，这里改用上游的 re-export。
// 需人工确认：project-sidebar/index.tsx 仍引用 fork 已删除的账号/订阅模块
// （@/settings/CodingPlanUpgradeDialogProvider、@/lib/userActionTelemetry），并向
// WorkspaceSidebarFooter 下发 onLogin/onLogout/onUsageClick/onUpgradeClick；采用 project-sidebar
// 前必须先清理这些接线，或整体删除上游新增的 project-sidebar/**。
// 项目树是唯一组织视图；workspace tab 继续只负责导航与执行目录。
export { ProjectSidebar as WorkspaceSidebar } from "@/project-sidebar/index.js";
export type { SidebarFileTreeOpenRequest } from "@/project-sidebar/contract.js";
