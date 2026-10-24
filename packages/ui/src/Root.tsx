/* eslint-disable max-lines -- Root 当前集中编排启动和 workspace shell wiring，先保持入口收口避免跨层状态拆散。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LucideProvider, RefreshCw } from "lucide-react";
import {
  APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
  DesktopCommandIds,
  appRuntimePreferencesChangedBroadcastPayloadSchema,
  stripRemoteTargetSecrets,
  type ConnectionProfile,
  type IPlatformService,
  type RemoteTarget,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import type {
  DeviceAdditionResult,
  DeviceAdditionReturnTarget,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useDynamicWorkflowAvailabilityLoader } from "@/hooks/useDynamicWorkflowAvailability.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { useTabPersistence } from "@/hooks/useTabPersistence.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SSHDialog } from "@/SSHDialog.js";
import { RemoteConnectionProgressProvider } from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
import { RemoteProjectPicker } from "@/project-sidebar/RemoteProjectPicker.js";
import type { RemoteProjectHost } from "@/project-sidebar/contract.js";
import { SettingsPage } from "@/SettingsPage.js";
import { setDefaultFileDisplayBasePath } from "@/lib/fileDisplay.js";
import { countAllUnreadTasks } from "@/lib/unreadTaskCount.js";
import {
  shouldBlockRootRender,
  shouldShowRootStartupLoading,
  shouldOpenFallbackWorkspaceAfterCreate,
} from "@/lib/rootStartupGate.js";
import { StoreProvider, useZCodeStore } from "@/store/StoreProvider.js";
import { setMcpStorePlatform } from "@/store/mcpStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isSettingsTab, isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import { logger } from "@/logger.js";
import { RootShell } from "@/root/RootShell.js";
import { RootWorkspaceContent } from "@/root/RootWorkspaceContent.js";
import { resolveRootWorkspaceShellTarget } from "@/root/rootWorkspaceShellTarget.js";
import { OccupationOnboarding } from "@/onboarding/OccupationOnboarding.js";
import { OnboardingDialog } from "@/onboarding/OnboardingDialog.js";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import type { RemoteWorkspaceProjectIntent } from "@/root/useRemoteWorkspaceHistory.js";
import { useRemoteWorkspaceTabLifecycle } from "@/root/useRemoteWorkspaceTabLifecycle.js";
import { useRootProviderStateRefresh } from "@/root/useRootProviderStateRefresh.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useRootProviderSettingsSnapshot } from "@/root/useRootProviderSettingsSnapshot.js";
import { useDesktopNativeThemeSync } from "@/root/useDesktopNativeThemeSync.js";
import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import {
  requiresResolvedDeviceAdditionSource,
  resolveConnectedSourceServerId,
} from "@/root/deviceAdditionSource.js";
import { useSourceServerUpdateNotifications } from "@/root/sourceServerUpdateNotifications.js";
import { useBotBroadcastEffects } from "@/root/useBotBroadcastEffects.js";
import {
  registerBaseWorkspaceServices,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { attachRemoteProjectWorkspace } from "@/project-sidebar/remote-navigation.js";
import type { RootProps } from "@/root/types.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";

import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import {
  CODE_COMMENT_REMOVE_BROADCAST_CHANNEL,
  CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL,
  isCodeCommentPayload,
  isCodeCommentRemovePayload,
  markCodeCommentRemoved,
} from "@/lib/codeCommentContext.js";
import { useCodeCommentPreviewStore } from "@/store/codeCommentPreviewStore.js";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useSystemLanguagePromptSync } from "@/hooks/useSystemLanguagePromptSync.js";
import { CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT } from "@/lib/closeActiveContext.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";

const DEFAULT_LUCIDE_STROKE_WIDTH = 1.5;

/**
 * 菜单项/按钮直接把回调挂在 onSelect/onClick 上时，DOM 事件会作为首参传入。
 * 只接受带契约字段的 preference；事件等其它对象一律按“无意图”归零，避免把事件存进向导状态。
 */
const REMOTE_CONNECTION_PREFERENCE_KEYS = [
  "returnTarget",
  "completion",
  "preferredKind",
  "preferredWslDistro",
  "initialTarget",
] as const satisfies ReadonlyArray<keyof RemoteConnectionOpenPreference>;

function normalizeRemoteConnectionOpenPreference(
  value: RemoteConnectionOpenPreference | undefined,
): RemoteConnectionOpenPreference | null {
  if (!value || typeof value !== "object") return null;
  return REMOTE_CONNECTION_PREFERENCE_KEYS.some((key) => key in value) ? value : null;
}

/** 设备管理入口发起的向导只承担认证/安装，成功后把 management 快照交回面板的 run 通道。 */
interface PendingDeviceIntent {
  project?: { path: string; localWorkspacePath?: string };
  resolve: (snapshot?: SourceServerManagementSnapshot) => void;
  reject: (cause: unknown) => void;
}

/**
 * 已保存 Profile 的 target 只做表单预填：剔除 credential ref，
 * 凭据必须由用户在本次向导里重新提供，不能把历史 secret 引用带进新草稿。
 */
function toWizardTarget(target: ConnectionProfile["target"]): RemoteTarget {
  switch (target.kind) {
    case "ssh":
      return {
        kind: "ssh",
        host: target.host,
        ...(target.port != null ? { port: target.port } : {}),
        username: target.username,
        ...(target.sshConfigAlias ? { sshConfigAlias: target.sshConfigAlias } : {}),
        ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
        ...(target.assetInstallMode ? { assetInstallMode: target.assetInstallMode } : {}),
      };
    case "wsl":
      return {
        kind: "wsl",
        ...(target.distro ? { distro: target.distro } : {}),
        ...(target.user ? { user: target.user } : {}),
      };
    case "docker":
      return { kind: "docker", container: target.container };
  }
}

/** Directory 缺可静默使用的凭据时抛出的公开错误码（sourceServerDirectory.resolveProfileTarget）。 */
function isInteractiveCredentialsRequired(cause: unknown): boolean {
  return Boolean(
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "credentials-required",
  );
}

/**
 * Root —— 应用根组件
 *
 * 外层挂载 StoreProvider（连接广播服务）+ TabStoreProvider，内层处理认证和路由。
 */
export function Root(props: RootProps) {
  return (
    <LucideProvider strokeWidth={DEFAULT_LUCIDE_STROKE_WIDTH}>
      {/*
       * 之前通过 lucide.tsx 包装每个图标，把默认 strokeWidth 固定成 1.5。
       * 现在移除包装文件后，如果不在根层统一注入，按钮、列表和工具栏里的 Lucide 图标会回退到 2，
       * 导致同一套 size class 下视觉显得更粗、更挤。这里改用官方 LucideProvider 保持默认值，
       * 同时保留个别图标显式传入 strokeWidth 时的覆盖能力。
       */}
      <TooltipProvider>
        {/*
         * 大会话消息动作里会出现大量 tooltip。Provider 如果跟随每个 tooltip 实例创建，
         * React 点击切换任务时会同步构造数量级相同的 Radix 上下文树；根层共享一次即可保留零延迟配置。
         */}
        <ServiceProvider services={props.services}>
          <PlatformProvider platform={props.platform}>
            <StoreProvider broadcastService={props.services.broadcastService}>
              <TabStoreProvider>
                <DiffsWorkerPoolProvider>
                  <AssistantCodeCommentFeatureProvider
                    enabled={props.assistantCodeCommentCardsEnabled}
                  >
                    {/*
                     * 后台连接进度必须跨「向导」与「设置-设备面板」共享：RootInner 同时渲染
                     * SSHDialog（发布方）和 SettingsPage（消费方），Provider 只能挂在它们的公共祖先。
                     */}
                    <RemoteConnectionProgressProvider>
                      <RootInner {...props} />
                    </RemoteConnectionProgressProvider>
                  </AssistantCodeCommentFeatureProvider>
                </DiffsWorkerPoolProvider>
              </TabStoreProvider>
            </StoreProvider>
          </PlatformProvider>
        </ServiceProvider>
      </TooltipProvider>
    </LucideProvider>
  );
}

function RootInner({
  services,
  platform,
  initialWorkspaceAbsPath,
  unavailableWorkspacePath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  restoreSession = true,
  supportsSettings = true,
  allowOpenWorkspace = true,
  preferDirectoryBrowser,
  supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
  allowRemoteWorkspace = true,
  initialWorkspaceLoadingFallback,
}: RootProps) {
  useEffect(() => {
    setMcpStorePlatform(platform);
    return () => {
      setMcpStorePlatform(null);
    };
  }, [platform]);

  // 动态工作流开关的唯一发布点（D-20 已改本地默认 alwaysOn，不再有远端灰度取数）。
  useDynamicWorkflowAvailabilityLoader();

  const { intl, locale } = useZCodeIntl();
  // P9-4：Source/Controller 更新提示的唯一挂载点（对照上游 Root.tsx:256）。
  // 只有桌面端 enabled：更新动作要经 Host 的 management 服务，Web 面没有这条链。
  const handleRemoteConnectionTargetChange = useSourceServerUpdateNotifications({
    enabled: isDesktop === true,
    management: services.sourceServerManagementService,
  });
  const theme = useZCodeStore((state) => state.theme);
  const {
    settings: appSettings,
    refresh: refreshAppSettings,
    update: updateAppSettings,
  } = useSettings();
  const rootModelSelectionRead = useModelSelectionServiceView(services.modelSelectionService);
  const rootModelSelectionErrorNode =
    rootModelSelectionRead.state.status === "error" ? (
      <div className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-destructive/30 bg-surface-raised px-3 py-2 text-ui-base text-foreground shadow-lg">
        <span className="min-w-0 flex-1">
          {intl.formatMessage({ id: "root.modelSelection.loadFailed" })}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={rootModelSelectionRead.reload}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    ) : null;
  const [remoteConnectionDialogOpen, setRemoteConnectionDialogOpen] = useState(false);
  const [remoteConnectionOpenPreference, setRemoteConnectionOpenPreference] =
    useState<RemoteConnectionOpenPreference | null>(null);
  // 设备管理面板发起的向导请求；连接成功后用它把 management 快照交回面板的 run 通道。
  const pendingDeviceIntentRef = useRef<PendingDeviceIntent | null>(null);
  // Picker 真链（backlog-sweep Step 4）：选目录只进入项目创建，不建 tab。
  // stale-intent 守卫：epoch 自增使迟到的 selection 装配与旧 onClose 失效。
  const remoteProjectIntentEpoch = useRef(0);
  const [remoteProjectSelection, setRemoteProjectSelection] = useState<{
    host: RemoteProjectHost;
    path: string;
    sessionId: string;
  } | null>(null);
  // 向导接管更新提示的目标（P9-4）：omz 向导壳（SSHDialog）没有上游 onFlowTargetChange 出口
  // （拍板 A：壳层不外扩），以项目创建流程持有的 host.target 作等价投影——该设备正在走
  // 连接/目录步时不再叠加「有更新」提示，避免用户同屏看到两个并行动作。
  useEffect(() => {
    handleRemoteConnectionTargetChange(remoteProjectSelection?.host.target ?? null);
  }, [handleRemoteConnectionTargetChange, remoteProjectSelection]);
  // 向导内部自己持有 connectedSessionId；项目流程彻底关闭后必须换代重挂，
  // 否则下次打开「远程工作区」会回到已被释放的目录步（shouldResetRemoteConnectionOnOpen 恒 false）。
  const [remoteConnectionDialogEpoch, setRemoteConnectionDialogEpoch] = useState(0);
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false);
  const [remoteConnectionInProgress, setRemoteConnectionInProgress] = useState(false);
  const [remoteConnectionRequestId, setRemoteConnectionRequestId] = useState<string | null>(null);
  const [isCreatingFallbackWorkspace, setIsCreatingFallbackWorkspace] = useState(false);
  const { connectionLogs: remoteConnectionLogs, resetConnectionLogs: resetRemoteConnectionLogs } =
    useRemoteConnectionLogs(remoteConnectionRequestId);
  const [isBootstrappingInitialWorkspace, setIsBootstrappingInitialWorkspace] = useState(
    Boolean(initialWorkspaceAbsPath),
  );
  const previousRemoteConnectionInProgressRef = useRef(false);
  const didRequestFallbackWorkspaceRef = useRef(false);
  const rootInnerMountedRef = useRef(true);
  const [hasEnteredNativeThemeSyncSurface, setHasEnteredNativeThemeSyncSurface] = useState(false);

  useEffect(() => {
    return () => {
      rootInnerMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const disposable = services.broadcastService.onMessage((message) => {
      if (message.channel === APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL) {
        const parsed = appRuntimePreferencesChangedBroadcastPayloadSchema.safeParse(
          message.payload,
        );
        if (!parsed.success) {
          logger.warn("[settings] 丢弃无效的运行时偏好广播", {
            issues: parsed.error.issues,
          });
          return;
        }
        void refreshAppSettings();
        void services.zcodeAgentService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] 同步跨窗口运行时偏好失败", error);
        });
        void services.botsService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] 同步跨窗口 Bot 运行时偏好失败", error);
        });
        return;
      }

      if (message.channel === CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL) {
        if (!isCodeCommentPayload(message.payload) || !message.payload.id) {
          return;
        }
        useCodeCommentPreviewStore.getState().restoreCommentFromAttachment({
          ...message.payload,
          id: message.payload.id,
        });
        return;
      }

      if (message.channel !== CODE_COMMENT_REMOVE_BROADCAST_CHANNEL) {
        return;
      }

      if (!isCodeCommentRemovePayload(message.payload)) {
        return;
      }

      // 关闭文件 tab 后 PreviewPane 会卸载，不能再依赖 PreviewPane 自己监听跨窗口清理事件。
      // 这里在 Root 生命周期内同步清理 renderer 级 preview store，避免发送后重新打开文件又恢复旧 comment。
      markCodeCommentRemoved(message.payload);
      useCodeCommentPreviewStore.getState().removeCommentBySource(message.payload);
    });

    return () => {
      disposable.dispose();
    };
  }, [
    refreshAppSettings,
    services.botsService,
    services.broadcastService,
    services.zcodeAgentService,
  ]);

  useEffect(() => {
    if (!appSettings) {
      return;
    }
    void services.zcodeAgentService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] 初始化运行时偏好失败", error);
      });
    void services.botsService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] 初始化 Bot 运行时偏好失败", error);
      });
  }, [
    appSettings?.askUserQuestionAutoResolutionEnabled,
    appSettings?.modelIoFullRetentionEnabled,
    services.botsService,
    services.zcodeAgentService,
  ]);

  const tabs = useTabStore((state) => state.tabs);
  const windowWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeTab = activeTabId ? (tabs.find((tab) => tab.id === activeTabId) ?? null) : null;
  const activeWorkspaceTab = activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
  const isSettingsTabActive = activeTab ? isSettingsTab(activeTab) : false;
  const {
    workspaceShellPath,
    workspaceIdentity: workspaceShellIdentity,
    workspaceRemoteSessionId: workspaceShellRemoteSessionId,
  } = resolveRootWorkspaceShellTarget({
    activeWorkspaceTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    // Settings 覆盖时仍使用被覆盖 tab 的完整远程身份，避免通知与侧栏建立重复订阅。
    workspaceTabs: windowWorkspaceTabs,
  });
  const workspaceScopedServices = useWorkspaceServices(
    workspaceShellPath,
    workspaceShellRemoteSessionId,
    workspaceShellIdentity,
  );

  // FORK（system-language-unification）：界面语言确定/变化时把模型语言同步到同一 locale。
  // 只由发起窗口执行（IntlProvider.localeChangeToken 不在广播接收侧递增），挂在 Root 是
  // 为了同时覆盖设置页 select 与 footer 语言子菜单两条入口，并在 workspace 可用后兜底一次
  // 存量迁移。载体用 workspaceShellPath：Settings tab 覆盖 workspace 时它仍指向被覆盖的
  // 那个 workspace，与其它 root 级同步同源。
  useSystemLanguagePromptSync({ workspacePath: workspaceShellPath });

  const localWorkspacePathForRemoteConnection = useTabStore((state) => {
    const activeTab = state.activeTabId
      ? state.tabs.find((tab) => tab.id === state.activeTabId)
      : null;
    if (
      !activeTab ||
      !isWorkspaceTab(activeTab) ||
      activeTab.remoteSessionId ||
      activeTab.remoteTarget ||
      activeTab.workspaceIdentity ||
      activeTab.workspacePurpose === "conversation"
    ) {
      return undefined;
    }
    return activeTab.workspacePath;
  });
  const totalUnreadTaskCount = useZCodeSessionStore((state) =>
    countAllUnreadTasks(state.workspaces),
  );
  const addTab = useTabStore((state) => state.addTab);
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);
  const tabStoreApi = useTabStoreApi();
  const refreshProviderState = useRootProviderStateRefresh(services);
  useRootProviderSettingsSnapshot(services);
  // FORK（D-13）：providerFamilyDomain 迁移的推断逻辑随账号面整删（恒 null），
  // 迁移本身不再有可执行内容；只保留一次启动刷新，让设置与 Registry 拿到最新值。
  useEffect(() => {
    void (async () => {
      try {
        await refreshAppSettings();
        await refreshProviderState();
      } catch (error) {
        logger.warn("[Root] 启动刷新 provider 状态失败", { error });
      }
    })();
  }, [refreshAppSettings, refreshProviderState]);

  const shouldPreferDirectoryBrowser = Boolean(preferDirectoryBrowser);
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  // FORK（D-19）：登录态恢复整删，启动期不再有「正在确认登录」这一态。
  const isResolvingStartupAuthState = false;
  const providerStartupSyncPending = false;
  // FORK（D-19）：provider 登录入口整删，启动门禁不再有「账号未就绪」这一态。
  // 阻断条件 `isStartupProviderLoginEntryOpen` 已随 WelcomeScreen 一并删除——
  // 留着它就是「启动登录态永远打不开」的首启死锁。
  const canRestoreWorkspaceSession = true;

  useEffect(() => {
    // 跨 workspace 任务列表需要一个稳定的“本地/root services”入口。
    // 桌面端 renderer 启动时会注册一次，但 Web 和测试入口也会直接挂 Root；
    // 这里再以 Root props 兜底注册，避免当前激活远端 workspace 时本地列表误用远端 host。
    registerBaseWorkspaceServices(services);
  }, [services]);

  useBotBroadcastEffects(services, tabStoreApi);

  /**
   * 设备管理往返的原 owner（创建草稿/设备面板）。引用只活在本 renderer 内存里：
   * `finish` 由 Root 在向导成功或取消时调用，owner 自己决定是否提交设备选择。
   */
  const deviceAdditionReturn = useRef<{
    target: DeviceAdditionReturnTarget;
    completion?: "checking" | "delivered";
    tabId: string | null;
    workspaceKey?: string;
  } | null>(null);

  /**
   * 把向导结果投递给原 owner（对齐上游 Root.tsx:470-527）：
   * - 投递前按原 tab 存续与同一 workspace 重新校验，迟到结果不能跨入口复活旧草稿；
   * - `canFinish` 由 owner 校验异步成员资格，失败退化成后台 cancelled；
   * - 一次性消费：成功/失败/取消都在退出前清掉引用（只有可重试的读失败保留 owner），
   *   迟到成功与后续「连接/查看项目」都不会再复用同一返回目标。
   */
  const finishDeviceAddition = useCallback(
    async (
      result: DeviceAdditionResult,
      background = false,
      canDeliver: () => boolean = () => true,
    ) => {
      const pending = deviceAdditionReturn.current;
      // 同步消费；异步资格校验仍保留同一 owner 标识，新入口替换后旧结果无权导航。
      if (!pending) return false;
      if (pending.completion && result.kind === "connected") return true;
      // 一次性消费（backlog-sweep 缺陷修复）：本次调用认领 owner 后，成功/失败/取消都必须在
      // 退出前释放引用。残留的已投递 owner 会让设备面板后续的「连接/查看项目」在
      // handleRemoteConnectionDialogConnect 的 deviceAdditionReturn 分支被提前 return，
      // pendingDeviceIntentRef 永不结算（面板 promise 悬空、「查看项目」不再打开）。
      const release = () => {
        if (deviceAdditionReturn.current === pending) deviceAdditionReturn.current = null;
      };
      pending.completion = "checking";
      const isCurrent = () =>
        deviceAdditionReturn.current === pending && pending.target.isCurrent();
      const deliver = (value: DeviceAdditionResult, inBackground: boolean) => {
        if (!isCurrent()) return;
        const tabs = tabStoreApi.getState();
        const tab = tabs.tabs.find((item) => item.id === pending.tabId);
        const workspaceKey =
          tab && isWorkspaceTab(tab)
            ? tab.workspaceIdentity?.trim() || tab.workspacePath
            : undefined;
        if ((pending.tabId && !tab) || pending.workspaceKey !== workspaceKey) return;
        if (pending.tabId && !inBackground) tabs.activateTab(pending.tabId);
        logger.debug("[Root] return from device addition", {
          kind: value.kind,
          tabId: pending.tabId,
        });
        pending.completion = "delivered";
        return pending.target.finish(value);
      };
      // 只有可重试的读失败保留 owner（连接 flow 会显示原因并允许重试/取消）；其余终态释放。
      let retryable = false;
      try {
        if (result.kind === "connected" && pending.target.canFinish) {
          const valid = await pending.target.canFinish(result);
          if (!isCurrent()) return true;
          if (!valid) {
            await deliver({ kind: "cancelled", background: true }, true);
            return true;
          }
        }
        if (result.kind === "connected" && !canDeliver()) {
          pending.completion = undefined;
          return true;
        }
        await deliver(result, background);
      } catch (error) {
        if (!isCurrent()) return true;
        // 读取失败不是取消。保留原 owner 和禁发约束，让连接 flow 显示原因并提供重试/取消。
        pending.completion = undefined;
        retryable = true;
        throw error;
      } finally {
        if (!retryable) release();
      }
      return true;
    },
    [tabStoreApi],
  );

  /**
   * 反解本次向导实际连上的 Source server id，供 owner 回写设备选择。
   *
   * 缺陷根因：入口偏好里的「打开向导时选中的设备」只代表打开时点的那一行，用户可以在
   * 向导里把目标改成另一台机器；直接回显会把创建草稿和后续「查看项目」带到错的 Source。
   * 因此只按本次 `connectRemote` 的真实 target 去 management 快照里找对应 Profile /
   * online 状态 / preferredProfileId 归属，收敛不到唯一 id 就返回 undefined，由调用点按
   * 设备类型决定是「可读失败」还是「legacy 设备照常 connected」（见
   * requiresResolvedDeviceAdditionSource）。
   */
  const resolveDeviceAdditionSourceServerId = useCallback(
    async (connectedTarget: RemoteTarget): Promise<string | undefined> => {
      const management = services.sourceServerManagementService;
      if (!management) return undefined;
      try {
        const snapshot = await management.getSnapshot();
        return resolveConnectedSourceServerId(snapshot, connectedTarget);
      } catch (error) {
        logger.warn("[Root] 解析设备连接结果失败", { error });
        return undefined;
      }
    },
    [services.sourceServerManagementService],
  );

  const handleOpenRemoteConnection = useCallback(
    (rawPreference?: RemoteConnectionOpenPreference): void | boolean => {
      const preference = normalizeRemoteConnectionOpenPreference(rawPreference);
      // 连接流程进行中或原 owner 正在校验返回时，不接受新的往返意图；
      // 调用方（创建草稿）据此把 accepted=false 当作“未接管”处理。
      if (
        preference?.returnTarget &&
        (remoteConnectionInProgress ||
          (deviceAdditionReturn.current && !deviceAdditionReturn.current.completion))
      )
        return false;
      if (!remoteConnectionInProgress) {
        // 新入口替换尚在资格校验的旧返回，先解除旧 owner 的门禁，再使其迟到结果失效。
        deviceAdditionReturn.current?.target.onVisibilityChange?.(false);
        const tabs = tabStoreApi.getState();
        const tab = tabs.tabs.find((item) => item.id === tabs.activeTabId);
        deviceAdditionReturn.current = preference?.returnTarget
          ? {
              target: preference.returnTarget,
              tabId: tabs.activeTabId,
              workspaceKey:
                tab && isWorkspaceTab(tab)
                  ? tab.workspaceIdentity?.trim() || tab.workspacePath
                  : undefined,
            }
          : null;
        // 新增设备往返设置页；已有设备的重连留在原项目/草稿页，不能被误当成新增设备。
        if (preference?.returnTarget?.kind === "add-device") {
          setPendingSettingsSectionIntent("remoteDevices");
          tabStoreApi.getState().openSettingsTab();
        }
        setRemoteConnectionOpenPreference(preference ?? null);
      }
      deviceAdditionReturn.current?.target.onVisibilityChange?.(true);
      setRemoteConnectionDialogOpen(true);
      return true;
    },
    [remoteConnectionInProgress, tabStoreApi],
  );
  /**
   * Picker 真链的 Root 侧装配（上游 Root.tsx:1284-1361 的等价形态）。
   * hostId 由 useRemoteWorkspaceHistory 用统一 identity 工具派生后随 intent 送达；
   * 这里只负责按成员校正目录事实并落 selection，不自行拼身份键。
   */
  const handleRemoteProjectIntent = useCallback(
    async ({ sessionId, path, hostId }: RemoteWorkspaceProjectIntent) => {
      const epoch = remoteProjectIntentEpoch.current;
      const remoteService = services.remoteProjectService;
      if (!remoteService) throw new Error("remote-project.service-unavailable");
      const directory = await remoteService.readDirectory();
      // 读取目录跨了异步边界：期间用户关闭/改选流程时，迟到结果不得再打开项目表单。
      if (epoch !== remoteProjectIntentEpoch.current) throw new Error("project.creation-cancelled");
      const host = directory.hosts.find((item) => item.id === hostId);
      if (!host) throw new Error("remote-project.host-removed");
      setRemoteProjectSelection({ host, path, sessionId });
    },
    [services.remoteProjectService],
  );
  const handleOpenDirectoryBrowser = useCallback(() => {
    setDirectoryBrowserOpen(true);
  }, []);
  /**
   * 远端项目建任务的 workspace admission（对照上游 Root.tsx:783-817）：目录与身份已由
   * Host 侧 prepareSession 解析，这里只复用既有连接申请 logical attachment 并打开 tab。
   * 连接/绑定失败直接抛错，由 Root 动作边界 toast，不降级到本机 workspace。
   */
  async function openPreparedRemoteProjectWorkspace(target: {
    hostId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    expectedMembershipId?: string;
    projectId: string | null;
  }): Promise<void> {
    const workspaceIdentity = target.workspaceIdentity?.trim();
    if (!workspaceIdentity) throw new Error("project.workspace-identity-required");
    const remoteService = services.remoteProjectService;
    if (!remoteService) throw new Error("remote-project.service-unavailable");
    await attachRemoteProjectWorkspace({
      hostId: target.hostId,
      workspacePath: target.workspacePath,
      workspaceIdentity,
      ...(target.expectedMembershipId ? { expectedMembershipId: target.expectedMembershipId } : {}),
      projectId: target.projectId,
      ...(services.projectService ? { projectService: services.projectService } : {}),
      remoteService,
      findSession: (identity) => {
        const state = useRemoteWorkspaceSessionStore.getState();
        const sessionId = state.sessionIdByWorkspaceIdentity[identity];
        return sessionId ? state.sessionsById[sessionId] : undefined;
      },
      connect: handleConnectRemote,
      bind: (sessionId, workspacePath, isCurrent) =>
        handleSelectPreparedRemoteProject(sessionId, workspacePath, workspaceIdentity, isCurrent),
      cancel: handleCancelRemoteProject,
    });
  }
  const {
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,

    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateScratchWorkspace,
    handleCreateTask,
    handleBackFromSettings,
  } = useRootWorkspaceActions({
    intl,
    platform,
    services,
    tabStoreApi,
    addTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    supportsSettings,
    allowOpenWorkspace,
    preferDirectoryBrowser: shouldPreferDirectoryBrowser,
    openDirectoryBrowser: handleOpenDirectoryBrowser,
    refreshProviderState,
    updateAppSettings,
    onOpenRemoteConnection: allowRemoteWorkspace ? handleOpenRemoteConnection : undefined,
    openRemoteProjectWorkspace: openPreparedRemoteProjectWorkspace,
  });
  const handleRemoteWorkspaceActivated = useCallback(
    ({
      workspacePath,
      workspaceIdentity,
    }: {
      workspacePath: string;
      workspaceIdentity: string;
    }) => {
      startDraftInWorkspace(workspacePath, workspaceIdentity);
    },
    [startDraftInWorkspace],
  );

  const {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    buildPersistedTabPatch,
    restorePersistedSession,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleSelectPreparedRemoteProject,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    handleRemoteWorkspaceTabsClosed,
  } = useRemoteWorkspaceHistory({
    intl,
    services,
    platform,
    supportsSettings,
    allowRemoteWorkspace,
    // conversation backing workspace 只属于本地桌面主恢复链路；远程窗口和手机
    // shared-host attachment 不能因此创建独立本地 runtime 或改变 replayable 边界。
    ensureConversationWorkspaceOnRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    deferInactiveWorkspaceRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    unavailableWorkspacePath,
    tabStoreApi,
    activateTabByPath,
    addTab,
    onWorkspaceActivated: handleRemoteWorkspaceActivated,
    onRemoteProjectIntent: handleRemoteProjectIntent,
  });

  /**
   * app-shell 侧栏既有调用面把 Host 已准备的 identity 透传到第四参（ProjectSidebarProps
   * `preparedWorkspaceIdentity`），向导壳则传 purpose。这里按值分派：purpose 保持连接流程，
   * identity 走已准备目录的 bind，避免 remote:server:* 被按 transport target 重算成 remote:ssh:*。
   */
  const handleSelectRemoteProjectFromSidebar = useCallback(
    (
      sessionId: string,
      path: string,
      localWorkspacePath?: string,
      preparedWorkspaceIdentityOrPurpose?: string,
      isCurrent?: () => boolean | Promise<boolean>,
    ) => {
      if (
        preparedWorkspaceIdentityOrPurpose === "project" ||
        preparedWorkspaceIdentityOrPurpose === "conversation"
      ) {
        return handleSelectRemoteProject(
          sessionId,
          path,
          localWorkspacePath,
          preparedWorkspaceIdentityOrPurpose,
        );
      }
      if (preparedWorkspaceIdentityOrPurpose) {
        return handleSelectPreparedRemoteProject(
          sessionId,
          path,
          preparedWorkspaceIdentityOrPurpose,
          isCurrent,
        );
      }
      return handleSelectRemoteProject(sessionId, path, localWorkspacePath);
    },
    [handleSelectPreparedRemoteProject, handleSelectRemoteProject],
  );

  useEffect(() => {
    // fileDisplay 默认不传 basePath 时需要落到“当前激活 workspace”。
    // 之前纯工具层拿不到窗口内的 workspace 上下文，只能退回绝对路径，导致 mention / 文件展示在输入框里不够简洁。
    // 这里由 Root 在 workspace 切换时同步一份当前上下文，既保留工具层复用性，也不把 Zustand 依赖硬塞进工具函数。
    setDefaultFileDisplayBasePath(activeWorkspacePath);
  }, [activeWorkspacePath]);

  useEffect(() => {
    if (!activeWorkspacePath) {
      return;
    }

    setWorkspaceActionError(null);
  }, [activeWorkspacePath, setWorkspaceActionError]);

  const { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore } = useTabPersistence({
    settingService: supportsSettings ? services.settingService : undefined,
    // 首次安装未连接账号时，provider 登录入口判定会晚于 workspace 恢复。
    // 如果这里先恢复 workspace，ChatView mount 会触发草稿 session 预热并在登录页背后报错。
    restoreSession: restoreSession && canRestoreWorkspaceSession,
    persistSession: restoreSession && canRestoreWorkspaceSession,
    restorePersistedSession,
    buildPersistPatch: buildPersistedTabPatch,
  });

  // 启动阻塞是桌面窗口保护期，手机 Web 远控在进入 Root 前已有配对/加载页。
  // Web 端继续使用该 gate 会在 workspace tab 注入前渲染空 RootShell，露出浏览器白底。
  const isStartupRenderBlocked = shouldShowRootStartupLoading({
    isDesktop,
    welcomeScreenOpen: false,
    isResolvingStartupAuthState,
    isResolvingProviderStartupState: false,
    isRestoring,
    isBootstrappingInitialWorkspace: isBootstrappingInitialWorkspace || isCreatingFallbackWorkspace,
  });

  useRootPlatformEffects({
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    initialTaskId,
    // 系统右键/Service 冷启动传入 initialWorkspacePath 时，必须先恢复历史 tabs，
    // 再把目标 workspace 合并并激活。否则先 addTab 会被 restoreTabs 整体替换掉；
    // 直接禁用 restoreSession 又会让其他 workspace 全部消失。
    canBootstrapInitialWorkspace: canRestoreWorkspaceSession && hasCompletedInitialRestore,
    addTab,
    setIsBootstrappingInitialWorkspace,
    platform,
    activateTabByPath,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    openWorkspace: handleOpenWorkspace,
    openWorkspacePath: (path) => {
      void handleSelectProject(path);
    },
    setWorkspaceActionError,
    allowOpenWorkspace,
    isDesktop,
    locale,
    tabs,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    totalUnreadTaskCount,
    hasCompletedFullTabRestore: hasCompletedFullRestore,
    intl,
    isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
  });

  useEffect(() => {
    if (!platform.onCloseActiveContextRequest) {
      return;
    }

    return platform.onCloseActiveContextRequest(() => {
      const event = new Event(CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT, { cancelable: true });
      window.dispatchEvent(event);
      if (event.defaultPrevented) {
        return;
      }

      // 关闭请求先广播给 workspace 层判断 side pane active tab。
      // 没有可见 workspace 或没有可关闭的 side pane tab 时，才回落到关窗口语义。
      void platform.executeDesktopCommand(DesktopCommandIds.CloseWindow);
    });
  }, [platform]);

  const canEnterNativeThemeSyncSurface = Boolean(
    !isStartupRenderBlocked && (workspaceShellPath || isSettingsTabActive),
  );

  useEffect(() => {
    if (!canEnterNativeThemeSyncSurface) {
      return;
    }

    // macOS nativeTheme 会影响窗口 vibrancy。这里等 RootStartupLoading
    // 真正退出并进入主界面/设置页后一轮再允许同步，避免启动壳背景被应用主题提前改写。
    setHasEnteredNativeThemeSyncSurface(true);
  }, [canEnterNativeThemeSyncSurface]);

  useDesktopNativeThemeSync({
    enabled: hasEnteredNativeThemeSyncSurface,
    isDesktop,
    platform,
    theme,
  });

  useRemoteWorkspaceTabLifecycle({
    tabs,
    activeWorkspaceTab,
    platform,
    onRemoteWorkspaceTabsClosed: handleRemoteWorkspaceTabsClosed,
    // lastClosedWorkspaceEvent 语义（P4.2）：只有 user-close 才触发解绑/释放。
    tabStoreApi,
  });

  useEffect(() => {
    if (
      shouldBlockRootRender({
        isResolvingStartupAuthState,
        isResolvingProviderStartupState: false,
        isRestoring,
        isBootstrappingInitialWorkspace,
      }) ||
      workspaceShellPath ||
      isSettingsTabActive ||
      !allowOpenWorkspace ||
      didRequestFallbackWorkspaceRef.current
    ) {
      return;
    }

    didRequestFallbackWorkspaceRef.current = true;
    setIsCreatingFallbackWorkspace(true);
    // 以前 tab store 的默认空态会把 Root 带到打开工作区中间页。
    // 删除整页流程后，启动恢复为空或入口没有传 initialWorkspacePath 时必须在 Root
    // 兜底落到默认 workspace，避免用户先看到一张“打开工作区”中间页或空白页。
    // 这里不能用当前 effect 的 cleanup 作为异步取消标记：setIsCreatingFallbackWorkspace
    // 或 addTab 后的 workspaceShellPath 变化都会让 React 先跑 cleanup，若因此跳过 finally，
    // 启动 loading gate 会永远保持 true。
    services.fileService
      .ensureConversationWorkspace()
      .then((result) => {
        // 启动兜底创建目录可能早于会话恢复发起、晚于恢复完成返回。
        // 返回后必须按 tab store 最新 active workspace 再判一次，避免迟到的默认项目抢走上次恢复的 tab。
        if (
          !shouldOpenFallbackWorkspaceAfterCreate({
            isMounted: rootInnerMountedRef.current,
            activeWorkspacePath: tabStoreApi.getState().activeWorkspacePath,
          })
        ) {
          return;
        }
        handleSelectConversationWorkspace(result.path);
      })
      .catch((error) => {
        if (!rootInnerMountedRef.current) {
          return;
        }
        logger.error("[Root] 启动兜底创建默认 workspace 失败", { error });
        setWorkspaceActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (rootInnerMountedRef.current) {
          setIsCreatingFallbackWorkspace(false);
        }
      });
  }, [
    allowOpenWorkspace,
    handleSelectConversationWorkspace,
    isBootstrappingInitialWorkspace,
    isResolvingStartupAuthState,
    isRestoring,
    isSettingsTabActive,
    services.fileService,
    setWorkspaceActionError,
    tabStoreApi,
    workspaceShellPath,
  ]);

  useEffect(() => {
    if (!workspaceShellPath) {
      return;
    }

    logger.info(
      `[Root] settings view ${isSettingsTabActive ? "open" : "closed"} workspace=${workspaceShellPath}`,
    );
  }, [isSettingsTabActive, workspaceShellPath]);

  const settlePendingDeviceIntent = useCallback((snapshot?: SourceServerManagementSnapshot) => {
    const pending = pendingDeviceIntentRef.current;
    pendingDeviceIntentRef.current = null;
    pending?.resolve(snapshot);
  }, []);

  /** 连接已建立但项目没落地时的回收：已经提交成 tab 的 session 不能拆。 */
  const releaseUncommittedRemoteSession = useCallback(
    async (sessionId: string) => {
      const committed = tabStoreApi
        .getState()
        .tabs.some((tab) => isWorkspaceTab(tab) && tab.remoteSessionId === sessionId);
      if (!committed) {
        await handleCancelRemoteProject(sessionId).catch(() => undefined);
      }
    },
    [handleCancelRemoteProject, tabStoreApi],
  );

  const handleRemoteConnectionDialogOpenChange = useCallback(
    (open: boolean) => {
      // 关闭向导即作废尚未落地的项目意图：迟到 readDirectory 不能重新弹出已关闭的项目表单。
      if (!open) remoteProjectIntentEpoch.current++;
      if (!open) {
        // 用户没连就关掉向导时，面板按钮不能一直停在 busy；按当前快照收尾。
        settlePendingDeviceIntent();
        // 设备管理往返：关闭即取消，解除原 owner（创建草稿）的等待；
        // 已投递或正在做资格校验的结果不能重复回传。
        const pendingDeviceAddition = deviceAdditionReturn.current;
        if (pendingDeviceAddition && !pendingDeviceAddition.completion) {
          void finishDeviceAddition({ kind: "cancelled" }).catch((error) =>
            logger.warn("[Root] 设备添加取消回传失败", error),
          );
        }
        if (pendingDeviceAddition?.completion !== "delivered") {
          pendingDeviceAddition?.target.onVisibilityChange?.(false);
        }
      }
      setRemoteConnectionDialogOpen(open);
      if (!open) {
        setRemoteConnectionOpenPreference(null);
      }
    },
    [finishDeviceAddition, settlePendingDeviceIntent],
  );

  // 项目流程关闭（取消或保存完成）统一释放向导 attachment：
  // epoch++ 让旧 intent 失效，同时换代重挂向导，避免下次打开落回已释放的目录步。
  const handleRemoteProjectSelectionClose = useCallback(() => {
    const sessionId = remoteProjectSelection?.sessionId;
    setRemoteProjectSelection(null);
    handleRemoteConnectionDialogOpenChange(false);
    setRemoteConnectionDialogEpoch((value) => value + 1);
    if (sessionId) {
      void handleCancelRemoteProject(sessionId).catch((error) =>
        logger.warn("[Root] 释放项目创建 attachment 失败", error),
      );
    }
  }, [handleCancelRemoteProject, handleRemoteConnectionDialogOpenChange, remoteProjectSelection]);

  /**
   * 用已保存线路打开向导，并把后续结果交给面板的 run 通道。
   * 同一时刻只保留一个面板发起的向导；重复点击不同线路时先收尾上一个 promise。
   */
  const openDeviceWizard = useCallback(
    (
      profile: ConnectionProfile,
      project?: { path: string; localWorkspacePath?: string },
    ): Promise<SourceServerManagementSnapshot | void> => {
      settlePendingDeviceIntent();
      const completion = new Promise<SourceServerManagementSnapshot | void>((resolve, reject) => {
        pendingDeviceIntentRef.current = {
          ...(project ? { project } : {}),
          resolve,
          reject,
        };
      });
      setRemoteConnectionOpenPreference({
        initialTarget: toWizardTarget(profile.target),
        preferredKind: profile.transport,
      });
      setRemoteConnectionDialogOpen(true);
      return completion;
    },
    [settlePendingDeviceIntent],
  );

  /**
   * 设备管理面板的「连接 / 重试 / 安装」入口：优先走 Host 管理链（已保存凭据/在线复用
   * 时一步完成安装与重试，面板状态机直接投影进度）；只有需要交互凭据时才用预填向导接管。
   * 拿不到 manager 或 profile 时 reject，不能静默返回让按钮假装成功。
   */
  const handleConnectRemoteProfile = useCallback(
    async (profileId: string) => {
      const management = services.sourceServerManagementService;
      if (!management) {
        throw Object.assign(new Error("Source server management service is unavailable"), {
          code: "management-unavailable",
        });
      }
      const snapshot = await management.getSnapshot();
      const profile = snapshot.profiles.find(
        (candidate) => candidate.profileId === profileId && candidate.lifecycleState !== "retired",
      );
      if (!profile) {
        throw Object.assign(new Error(`Unknown Connection Profile: ${profileId}`), {
          code: "profile-not-found",
        });
      }
      try {
        return await management.connectProfile(profileId);
      } catch (error) {
        // Directory.resolveProfileTarget 在没有可静默使用的凭据时抛 credentials-required；
        // 这时才把连接交给向导，让用户补密码/口令。
        if (!isInteractiveCredentialsRequired(error)) throw error;
        return await openDeviceWizard(profile);
      }
    },
    [openDeviceWizard, services.sourceServerManagementService],
  );

  /**
   * 设备管理面板的「查看项目」入口：已打开的 tab 直接激活；设备在线时复用物理连接直接开 tab；
   * 离线（可能需要交互凭据）时用该设备线路预填向导，连接成功后打开用户点击的项目路径。
   */
  const handleOpenRemoteDeviceProject = useCallback(
    async (sourceServerId: string, path: string, profileId?: string) => {
      const management = services.sourceServerManagementService;
      if (!management) {
        throw Object.assign(new Error("Source server management service is unavailable"), {
          code: "management-unavailable",
        });
      }
      const snapshot = await management.getSnapshot();
      const existingTab = tabStoreApi.getState().tabs.find(
        (tab): tab is WorkspaceTabState =>
          isWorkspaceTab(tab) &&
          Boolean(tab.remoteSessionId) &&
          tab.workspacePath === path &&
          getWorkspaceSourceServerId(tab, {
            workspaceHistory: snapshot.workspaceHistory,
          }) === sourceServerId,
      );
      if (existingTab) {
        activateTabByPath(existingTab.workspacePath, {
          workspaceIdentity: existingTab.workspaceIdentity,
        });
        return;
      }

      const server = snapshot.servers.find(
        (candidate) => candidate.sourceServerId === sourceServerId,
      );
      const deviceProfiles = snapshot.profiles.filter(
        (candidate) =>
          candidate.sourceServerId === sourceServerId && candidate.lifecycleState !== "retired",
      );
      const profile =
        (profileId
          ? deviceProfiles.find((candidate) => candidate.profileId === profileId)
          : undefined) ??
        deviceProfiles.find((candidate) => candidate.profileId === server?.preferredProfileId) ??
        deviceProfiles[0];
      if (!profile) {
        throw Object.assign(
          new Error(`No active connection profile for source server: ${sourceServerId}`),
          { code: "profile-not-found" },
        );
      }

      // 设备已在线时直接复用 Host 物理连接创建 session：密码等凭据由 Manager 的在线连接保留，
      // 再走向导会因表单没有 secret 而要求用户重复输入。
      const deviceOnline = snapshot.states.some(
        (state) => state.sourceServerId === sourceServerId && state.state === "online",
      );
      if (deviceOnline) {
        const sessionId = await handleConnectRemote(toWizardTarget(profile.target));
        try {
          await handleSelectRemoteProject(
            sessionId,
            path,
            localWorkspacePathForRemoteConnection,
            "conversation",
          );
        } catch (error) {
          await releaseUncommittedRemoteSession(sessionId);
          throw error;
        }
        return;
      }

      await openDeviceWizard(profile, {
        path,
        ...(localWorkspacePathForRemoteConnection
          ? { localWorkspacePath: localWorkspacePathForRemoteConnection }
          : {}),
      });
    },
    [
      activateTabByPath,
      handleConnectRemote,
      handleSelectRemoteProject,
      localWorkspacePathForRemoteConnection,
      openDeviceWizard,
      releaseUncommittedRemoteSession,
      services.sourceServerManagementService,
      tabStoreApi,
    ],
  );

  /**
   * 向导统一连接入口：普通连接成功后把 management 快照交回面板；设备管理发起的
   * 「查看项目」则先收起向导，再按已连接的 session 直接打开目标路径。
   */
  const handleRemoteConnectionDialogConnect = useCallback(
    async (
      target: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
    ) => {
      const sessionId = await handleConnectRemote(target, requestId, context);
      // 设备管理往返（completion:"device-management" + returnTarget）：只回传设备事实，
      // 不进入目录/项目链路；owner 自己决定是否把该设备写回创建草稿的选择。
      if (deviceAdditionReturn.current) {
        // 回执按设备类型分流（判定依据见 requiresResolvedDeviceAdditionSource）：
        // 「添加设备」和 server 形态设备必须确认本次连上的 Source；legacy ssh/wsl/docker
        // 设备没有 Source 归属，约定「报告 connected 即回原流程」（ProjectCreation 只在
        // device.sourceServerId 存在时才校验身份），不能把成功连接降级成取消并释放会话。
        // 回执形态在 await 前确定；await 期间 owner 被取消/替换时，由 finishDeviceAddition
        // 按当前 ref 的 isCurrent 守卫丢弃迟到结果。
        const pendingAddition = deviceAdditionReturn.current;
        const requiresResolvedSource = requiresResolvedDeviceAdditionSource(pendingAddition.target);
        // 按本次实际连接目标反解归属（用户可能在向导里改选了另一台设备）。
        const sourceServerId = await resolveDeviceAdditionSourceServerId(target);
        if (!sourceServerId && requiresResolvedSource) {
          // 连接成功但归属无法唯一确认：不能把 undefined 当成功静默回传给 owner——
          // 「添加设备」会静默什么都不做，server 形态设备则无法确认回写的仍是同一 Source。
          // 这里给可读提示并按取消收尾，宁可不回写也不能回写一个猜的 Source。
          logger.warn("[Root] 设备连接成功但无法唯一确认 Source 归属", {
            target: stripRemoteTargetSecrets(target),
            expectedSourceServerId: pendingAddition.target.deviceSourceServerId,
          });
          toast(intl.formatMessage({ id: "settings.source.deviceSourceUnresolved" }), {
            variant: "warning",
            dedupeKey: "root.device-addition-source-unresolved",
          });
        }
        let delivered: boolean;
        try {
          delivered = await finishDeviceAddition(
            !sourceServerId && requiresResolvedSource
              ? { kind: "cancelled" }
              : { kind: "connected", sourceServerId },
          );
        } catch (error) {
          // 原 owner 可能在 finish 里拒绝（例如向导改连到另一台 Source 后身份校验失败）。
          // finish 拒绝说明本次连接没有提交成 tab；必须回收未提交 session，再把错误交给
          // 连接 flow 显示原因并允许重试，不能把 session 留在会话存储里无人引用。
          await releaseUncommittedRemoteSession(sessionId);
          throw error;
        }
        if (delivered) {
          if (!sourceServerId && requiresResolvedSource) {
            // 归属未确认时不会再有 tab 使用这条 session，按未提交回收，避免残留逻辑会话。
            await releaseUncommittedRemoteSession(sessionId);
          }
          // 让 SSHDialog 先完成自己的成功态提交，再收起并换代；否则它随后的
          // applyOpenState(true) 会把刚关掉的向导重新拉起，且下次打开会落回已连接的目录步。
          window.setTimeout(() => {
            handleRemoteConnectionDialogOpenChange(false);
            setRemoteConnectionDialogEpoch((value) => value + 1);
          }, 0);
          return sessionId;
        }
      }
      const pending = pendingDeviceIntentRef.current;
      if (!pending) {
        return sessionId;
      }
      // 先摘掉 ref，后续收起向导触发的 onOpenChange 不能把本次结果再 settle 一次。
      pendingDeviceIntentRef.current = null;
      const project = pending.project;
      if (!project) {
        void services.sourceServerManagementService?.getSnapshot().then(
          (snapshot) => pending.resolve(snapshot),
          () => pending.resolve(undefined),
        );
        return sessionId;
      }

      void (async () => {
        try {
          // 让 SSHDialog 先完成自己的成功态提交，再收起并换代；否则它随后的
          // applyOpenState(true) 会把刚关掉的向导重新拉起。
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 0);
          });
          handleRemoteConnectionDialogOpenChange(false);
          setRemoteConnectionDialogEpoch((value) => value + 1);
          await handleSelectRemoteProject(
            sessionId,
            project.path,
            project.localWorkspacePath,
            "conversation",
          );
          const snapshot = await services.sourceServerManagementService?.getSnapshot();
          pending.resolve(snapshot);
        } catch (error) {
          logger.warn("[Root] 设备管理打开项目失败", { error });
          // 只有尚未提交成 tab 的 session 才回收；已经建出的 tab 不能因后续刷新失败被拆掉。
          await releaseUncommittedRemoteSession(sessionId);
          // 连接成功但打开项目失败必须回到面板错误态，不能吞掉。
          pending.reject(error);
        }
      })();
      return sessionId;
    },
    [
      finishDeviceAddition,
      handleConnectRemote,
      handleRemoteConnectionDialogOpenChange,
      handleSelectRemoteProject,
      intl,
      releaseUncommittedRemoteSession,
      resolveDeviceAdditionSourceServerId,
      services.sourceServerManagementService,
    ],
  );

  const remoteConnectionDialog = allowRemoteWorkspace ? (
    <>
      {/* 项目创建面：向导选目录后接管（不建 tab），保存/取消都由这里释放 attachment。 */}
      {remoteProjectSelection && services.projectService && services.remoteProjectService ? (
        <RemoteProjectPicker
          key={remoteProjectSelection.host.membershipId}
          host={remoteProjectSelection.host}
          initialRoots={[remoteProjectSelection.path]}
          service={services.projectService}
          remoteService={services.remoteProjectService}
          onClose={handleRemoteProjectSelectionClose}
          onSaved={async () => {}}
        />
      ) : null}
      <SSHDialog
        key={remoteConnectionDialogEpoch}
        onConnect={handleRemoteConnectionDialogConnect}
        onSelectProject={handleSelectRemoteProject}
        workspacePurpose="project"
        onCancelSession={handleCancelRemoteProject}
        localWorkspacePath={localWorkspacePathForRemoteConnection}
        isWindowsDesktop={isWindowsDesktop}
        remoteWorkspaceSessions={remoteWorkspaceSessions}
        open={remoteConnectionDialogOpen && !remoteProjectSelection}
        onOpenChange={handleRemoteConnectionDialogOpenChange}
        onFlowActiveChange={setRemoteConnectionInProgress}
        onFlowRequestIdChange={setRemoteConnectionRequestId}
        preferredKind={remoteConnectionOpenPreference?.preferredKind}
        preferredWslDistro={remoteConnectionOpenPreference?.preferredWslDistro}
        initialTarget={remoteConnectionOpenPreference?.initialTarget}
        hideTriggerWhenClosed
      />
    </>
  ) : null;
  const directoryBrowserDialog = directoryBrowserOpen ? (
    <ScopedErrorBoundary
      scope="directory-browser"
      resetKeys={["directory-browser"]}
      variant="silent"
    >
      <DirectoryBrowser
        services={services}
        onCancel={() => setDirectoryBrowserOpen(false)}
        onSelect={(path) => {
          setDirectoryBrowserOpen(false);
          void handleSelectProject(path);
        }}
      />
    </ScopedErrorBoundary>
  ) : null;

  useEffect(() => {
    const wasInProgress = previousRemoteConnectionInProgressRef.current;
    if (!wasInProgress && remoteConnectionInProgress) {
      resetRemoteConnectionLogs();
    }
    previousRemoteConnectionInProgressRef.current = remoteConnectionInProgress;
  }, [remoteConnectionInProgress, resetRemoteConnectionLogs]);

  const settingsLayerProps = {
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    captionWorkspacePath: activeWorkspacePath,
    onBack: activeWorkspacePath ? handleBackFromSettings : undefined,
    onCreateTask: handleCreateTask,
    onOpenWorkspace: handleOpenWorkspace,
    allowOpenWorkspace,
    // 设备管理接线（backlog-sweep 设备面板）：新建连接 / 连接线路 / 打开项目
    // 都必须落到 Root 的同一份向导与 remote workspace 链，SettingsPage 不自建连接。
    onOpenRemoteConnection: allowRemoteWorkspace ? handleOpenRemoteConnection : undefined,
    onConnectRemoteProfile: allowRemoteWorkspace ? handleConnectRemoteProfile : undefined,
    onOpenRemoteDeviceProject: allowRemoteWorkspace ? handleOpenRemoteDeviceProject : undefined,
  };

  if (isStartupRenderBlocked) {
    const loadingLabel = intl.formatMessage({ id: "common.loading" });
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        {/* HTML 启动壳已经展示 ZCode SVG，但 React 接管 root 后旧壳会被整棵替换。
            之前阻塞恢复 tab / 初始 workspace 注入时重新渲染纯文字“加载中...”，所以启动被拆成两套 loading。
            这里复用同一套 SVG 启动画面，只把文案保留到 aria-label，保证视觉始终连续且不牺牲可访问性。 */}
        <RootStartupLoading label={loadingLabel} />
      </RootShell>
    );
  }

  if (
    !workspaceShellPath &&
    !isDesktop &&
    initialWorkspaceAbsPath &&
    initialWorkspaceLoadingFallback
  ) {
    // 非桌面入口的 workspace tab 由 effect 注入，首帧不能返回 null。
    // 这里延续入口 loading，等任务列表有 workspaceShellPath 后再切换，避免露出浏览器白底。
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {initialWorkspaceLoadingFallback}
        {directoryBrowserDialog}
      </RootShell>
    );
  }

  return (
    <RootShell>
      {rootModelSelectionErrorNode}
      {remoteConnectionDialog}
      {directoryBrowserDialog}
      <OccupationOnboarding
        showWindowControls={Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop))}
        showChildrenWhileLoading={!workspaceShellPath && isSettingsTabActive}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        {/* 新引导属于应用级偏好；无项目时也要挂载，才能响应设置页的手动打开请求。 */}
        {!workspaceShellPath ? (
          isSettingsTabActive ? (
            <ScopedErrorBoundary
              scope="settings-page"
              resetKeys={["settings-root"]}
              variant="panel"
              className="h-full"
            >
              <SettingsPage {...settingsLayerProps} />
            </ScopedErrorBoundary>
          ) : null
        ) : (
          <RootWorkspaceContent
            workspaceScopedServices={workspaceScopedServices}
            workspaceShellPath={workspaceShellPath}
            workspaceIdentity={workspaceShellIdentity}
            workspaceRemoteSessionId={workspaceShellRemoteSessionId}
            activeWorkspacePath={activeWorkspacePath}
            isSettingsTabActive={isSettingsTabActive}
            handleConnectRemote={handleConnectRemote}
            handleSelectRemoteProject={handleSelectRemoteProjectFromSidebar}
            handleCancelRemoteProject={handleCancelRemoteProject}
            handleReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
            handleCreateTask={handleCreateTask}
            handleCreateConversationTask={handleCreateConversationTask}
            handleResolveConversationWorkspace={handleResolveConversationWorkspace}
            handleOpenWorkspace={handleOpenWorkspace}
            handleOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
            handleOpenRemoteWorkspace={
              allowRemoteWorkspace ? handleOpenRemoteConnection : undefined
            }
            handleConnectRemoteProfile={
              allowRemoteWorkspace ? handleConnectRemoteProfile : undefined
            }
            handleOpenRemoteDeviceProject={
              allowRemoteWorkspace ? handleOpenRemoteDeviceProject : undefined
            }
            handleCreateScratchWorkspace={handleCreateScratchWorkspace}
            remoteConnectionInProgress={remoteConnectionInProgress}
            remoteWorkspaceSessions={remoteWorkspaceSessions}
            allowRemoteWorkspace={allowRemoteWorkspace}
            handleBackFromSettings={handleBackFromSettings}
            reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
            remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
            reconnectingRemoteWorkspaceLogsByWorkspaceKey={
              reconnectingRemoteWorkspaceLogsByWorkspaceKey
            }
            remoteConnectionLogs={remoteConnectionLogs}
            allowOpenWorkspace={allowOpenWorkspace}
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            supportsEmbeddedBrowser={supportsEmbeddedBrowser}
          />
        )}
        <ScopedErrorBoundary
          scope="onboarding-dialog"
          resetKeys={[workspaceShellIdentity?.trim() || workspaceShellPath]}
          variant="silent"
        >
          <OnboardingDialog
            workspacePath={workspaceShellPath || undefined}
            workspaceIdentity={workspaceShellIdentity}
            isDesktop={isDesktop}
          />
        </ScopedErrorBoundary>
      </OccupationOnboarding>
    </RootShell>
  );
}
