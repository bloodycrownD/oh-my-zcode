// 照搬上游 v3.16.2 useProjectDirectoryServices.ts（upstream-v316-fullsync P4.1 挂账7 定夺：
// ProjectEditor 的目录浏览依赖本适配器，随编辑器组件同批搬入；上游形态无 Remote* 依赖，零改写）。
import { useMemo } from "react";
import type { IProjectService } from "@/project-sidebar/contract.js";

/** 目录查询沿用项目的 Host 路由，手机无需桌面专用 attachment，也不借当前 tab 的文件服务。 */
export function useProjectDirectoryServices(service: IProjectService, hostId?: string) {
  return useMemo(
    () => ({
      services: {
        systemService: {
          info: async () => ({ homedir: (await service.readDirectory({ hostId })).path }),
        },
        fileService: {
          readdir: async (params: { path: string; includeHidden?: boolean }) =>
            (await service.readDirectory({ ...params, hostId })).entries,
        },
      },
    }),
    [service, hostId],
  );
}
