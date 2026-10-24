import { useEffect, useRef } from "react";
import { useServices } from "@/hooks/useServices.js";
import {
  claimMcpStoreDirectoryService,
  releaseMcpStoreDirectoryService,
  useMcpStore,
} from "@/store/mcpStore.js";

export function useEnsureWorkspaceMcpLoaded(
  workspaceAbsPath: string,
  workspaceIdentity: string | undefined,
  rpcReady: boolean,
) {
  const services = useServices();
  // App 壳层是 workspace 目录服务的常驻持有者。claim/release 与设置页端口面板共用
  // 同一张登记表：本 hook 因 rpcReady / 服务变化重跑时只释放自己的令牌，不会清掉
  // 端口面板仍在持有的登记（反之亦然）。
  const directoryServiceOwnerRef = useRef<object>({});

  useEffect(() => {
    if (!rpcReady) {
      return;
    }
    const owner = directoryServiceOwnerRef.current;
    claimMcpStoreDirectoryService(owner, services.mcpSyncService, "workspace");
    return () => {
      releaseMcpStoreDirectoryService(owner);
    };
  }, [rpcReady, services.mcpSyncService]);

  useEffect(() => {
    if (!rpcReady) {
      // remote tab 恢复时 App 会先拿到断连代理；若立即
      // 读取 MCP 目录，只是在 store 内吞掉了断连错误，并未遵守 workspace
      // RPC 隔离边界。等待真实 services 注册后再执行，不缓存也不跨 transport 重放。
      return;
    }
    void useMcpStore
      .getState()
      .ensureLoadedForWorkspace(workspaceAbsPath, services.mcpSyncService, workspaceIdentity);
  }, [rpcReady, services.mcpSyncService, workspaceAbsPath, workspaceIdentity]);
}
