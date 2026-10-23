// 照搬上游 v3.16.2（upstream-v316-fullsync P7 末批，拍板 B：Remote* 组件与同步链回填）。
// omz shouldShowRemoteSyncActions 维持 ssh/wsl 现状口径（docker 同步面 omz 未开放）。
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  buildRemoteHostWorkspaceIdentity,
  type ProjectRowAction,
  type RemoteProjectDirectory,
  type RemoteProjectHost,
  type VirtualProject,
} from "@/project-sidebar/contract.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { RemoteSyncDialogs, shouldShowRemoteSyncActions } from "@/settings/RemoteSyncActions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { refreshWorkspacePluginCapabilitiesAfterRemoteSync } from "@/lib/remotePluginSyncRefresh.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

type Kind = "skills" | "mcp" | "plugins";
interface SyncTarget {
  kind: Kind;
  host: RemoteProjectHost;
  path: string;
  identity: string;
  sessionId: string;
  localWorkspacePath?: string;
}

/** 同步菜单只适配已有 workspace attachment；不因展示菜单创建 tab、连接或 Agent。 */
export function useProjectRemoteSync(directory: RemoteProjectDirectory) {
  // omz 化：上游首参的手机侧栏开关决定 clientMode（web-remote-replayable /
  // desktop-continuous）；omz 项目侧栏无手机远控面（relay v1 剔除），恒 desktop-continuous，
  // 故收掉该形参；shouldShowRemoteSyncActions 走 omz ssh/wsl 现状口径。
  const base = useBaseWorkspaceServices();
  // omz 化：RemoteWorkspaceSession 无 workspaceIdentity 字段（identity 绑定在
  // sessionIdByWorkspaceIdentity 映射），等价改读该索引。
  const sessions = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const tabs = useOptionalTabStore((state) => state.tabs);
  const { intl } = useZCodeIntl();
  const [selection, setSelection] = useState<SyncTarget | null>(null);
  const selectedHost =
    selection &&
    directory.hosts.find(
      (host) =>
        host.id === selection.host.id &&
        host.membershipId === selection.host.membershipId &&
        host.connectionStatus === "online",
    );
  const selectedSession = selection && sessions[selection.sessionId];
  const current =
    selection &&
    selectedHost &&
    sessionIdByWorkspaceIdentity[selection.identity] === selection.sessionId &&
    selectedSession
      ? selection
      : null;
  useEffect(() => {
    if (selection && !current) setSelection(null);
  }, [selection, current]);
  const hasLocalSourceService = Boolean(base.skillSyncService);
  const actions = useCallback(
    (project: VirtualProject): ProjectRowAction[] => {
      const host = directory.hosts.find(
        (item) => item.id === project.hostId && item.connectionStatus === "online",
      );
      if (!host) return [];
      return project.roots.flatMap((root, index) => {
        const identity = buildRemoteHostWorkspaceIdentity(host.id, root.rootPath);
        const boundSessionId = sessionIdByWorkspaceIdentity[identity];
        const session = boundSessionId ? sessions[boundSessionId] : undefined;
        if (
          !shouldShowRemoteSyncActions({
            remoteSessionId: session?.sessionId,
            remoteTarget: host.target,
            clientMode: "desktop-continuous",
            hasLocalSourceService,
          }) ||
          !session
        )
          return [];
        return (["skills", "mcp", "plugins"] as const).map((kind) => ({
          id: `sync-${kind}-${index}`,
          icon: RefreshCw,
          label: `${intl.formatMessage({ id: { skills: "remote.syncSkills", mcp: "remote.syncMcp", plugins: "remote.syncPlugins" }[kind] })}${project.roots.length > 1 ? ` · ${root.rootPath}` : ""}`,
          run: () =>
            setSelection({
              kind,
              host,
              path: root.rootPath,
              identity,
              sessionId: session.sessionId,
              localWorkspacePath: tabs
                .filter(isWorkspaceTab)
                .find(
                  (tab) =>
                    tab.workspaceIdentity === identity && tab.remoteSessionId === session.sessionId,
                )?.localWorkspacePath,
            }),
        }));
      });
    },
    [directory.hosts, sessions, sessionIdByWorkspaceIdentity, hasLocalSourceService, tabs, intl],
  );
  return {
    actions,
    dialog: current ? (
      <ProjectRemoteSyncDialog
        key={`${current.host.membershipId}:${current.identity}`}
        target={current}
        onClose={() => setSelection(null)}
      />
    ) : null,
  };
}

function ProjectRemoteSyncDialog({ target, onClose }: { target: SyncTarget; onClose(): void }) {
  const base = useBaseWorkspaceServices();
  const { services, rpcReady } = useWorkspaceServicesResolution(
    target.path,
    target.sessionId,
    target.identity,
    target.host.target,
  );
  const close = (open: boolean) => {
    if (!open) onClose();
  };
  if (!rpcReady) return null;
  return (
    <RemoteSyncDialogs
      canSyncSkills
      canSyncMcp
      canSyncPlugins
      skillOpen={target.kind === "skills"}
      mcpOpen={target.kind === "mcp"}
      pluginOpen={target.kind === "plugins"}
      onSkillOpenChange={close}
      onMcpOpenChange={close}
      onPluginOpenChange={close}
      localSkillSyncService={base.skillSyncService}
      remoteSkillSyncService={services.skillSyncService}
      localMcpSyncService={base.mcpSyncService}
      remoteMcpSyncService={services.mcpSyncService}
      localPluginSyncService={base.pluginSyncService}
      remotePluginSyncService={services.pluginSyncService}
      localZCodeAgentService={base.zcodeAgentService}
      remoteZCodeAgentService={services.zcodeAgentService}
      remoteTarget={target.host.target}
      workspaceIdentity={target.identity}
      skillWorkspacePath={target.path}
      mcpWorkspacePath={target.path}
      pluginWorkspacePath={target.path}
      mcpLocalWorkspacePath={target.localWorkspacePath}
      pluginLocalWorkspacePath={target.localWorkspacePath}
      onSkillsSynced={async () => {
        await invalidateDeferredDraftSessionForSkillChange({
          workspacePath: target.path,
          workspaceIdentity: target.identity,
          reason: "project-remote-skill-sync",
          // omz 化：omz 版显式要求 zcodeSessionService（deferred 草稿清理 owner）。
          zcodeSessionService: services.zcodeSessionService,
        });
        await refreshSharedSkillStoreForWorkspace({
          workspacePath: target.path,
          workspaceIdentity: target.identity,
          skillsService: services.skillsService,
        });
      }}
      onMcpSynced={async () => {
        await useMcpStore
          .getState()
          .ensureLoadedForWorkspace(target.path, services.mcpSyncService, target.identity);
      }}
      onPluginsSynced={() =>
        refreshWorkspacePluginCapabilitiesAfterRemoteSync({
          commandsService: services.commandsService,
          mcpSyncService: services.mcpSyncService,
          zcodeAgentService: services.zcodeAgentService,
          // omz 化：omz 版要求 zcodeSessionService（能力刷新后的失效会话关闭面）。
          zcodeSessionService: services.zcodeSessionService,
          reason: "project-remote-plugin-sync",
          skillsService: services.skillsService,
          workspaceIdentity: target.identity,
          workspacePath: target.path,
        })
      }
    />
  );
}
