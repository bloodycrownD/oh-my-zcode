// 上游 v3.16.2 形态（backlog-sweep Step 5）：经典侧栏（workspace tab 列表/DnD 排序/
// 侧栏任务行族）整段废弃——tab 排序语义由项目树分组拖拽取代
// （用户裁定：上游没有 classic/projects 双视角机制，omz 自创面删除）。
// 壳层只经本文件拿骨架与文件树请求类型；ProjectSidebar 的 props 与实现全在 project-sidebar/。
export { ProjectSidebar as WorkspaceSidebar } from "@/project-sidebar/index.js";
export type { SidebarFileTreeOpenRequest } from "@/project-sidebar/contract.js";
