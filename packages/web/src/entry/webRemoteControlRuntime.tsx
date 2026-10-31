/* eslint-disable max-lines -- Web 远控 external relay 装配按上游 v3.16.2 入口整体移植；
   fork 适配点：官方登录面删除（auth 只读本地 JWT、login/callback 视图渲染 auth-required 失败页）、
   遥测转发跳过、Root 无 terminalOwnerId prop。 */
import type { ComponentProps, ReactNode } from "react";
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  ensurePendingTaskDraft,
  setStreamClientId,
  setWebRemoteControlTerminalTransportState,
  generateMobileDeviceFingerprint,
  type WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState,
} from "@zcode/ui";
import {
  connectViaProtocol,
  createAcknowledgedWebRemoteControlRelayProtocol,
} from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  createWebRemoteControlConnectionRecoveryTimeoutFailure,
  matchesWebRemoteControlRoutePath,
  resolveWebRemoteControlRelayWsUrl,
  resolveWebRemoteControlWorkspaceKey,
  type IPlatformService,
  type WebRemoteControlAppPayload,
  type WebRemoteControlExternalWorkspaceBridge,
  type WebRemoteControlFailure,
  type WebRemoteControlFailureReason,
  type WebRemoteControlMobileNavigationIntent,
  type WebRemoteControlTaskTarget,
  type WebRemoteControlWindowBootstrapResult,
  type WebRemoteControlWorkspaceBridge,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWorkspaceSwitchOptions,
} from "@zcode/shared";
import type { WebRemoteControlEntryConnection } from "#src/web-remote-control/contract.js";
import {
  WebRemoteControlEntry,
  createWebRemoteControlV2TokenClient,
  readKnownDevices,
  createWebRemoteControlDeviceClient,
  createWebRemoteControlBridgeRecoveryRunner,
  acceptWebRemoteControlBridgeInvalidation,
  resolveWebRemoteControlRecoveryTarget,
  getWebRemoteControlBridgeRecoveryRetryDelay,
  WebRemoteControlTerminalTransport,
  type WebRemoteControlTerminalTransportDiagnostic,
  type WebRemoteControlTerminalTransportState,
  createWebRemoteControlAppPayloadRequester,
  createWebRemoteControlRelayRequestRecovery,
  createWebRemoteControlLifecycleRecovery,
  collectWebRemoteControlMobileDeviceInfo,
  createWebRemoteControlVersionGuard,
  resolveWebRemoteControlRoutePath,
  registerWebRemoteControlWorkspaceBridgeServices,
  connectWebRemoteControlWorkspaceBridgeServices,
  replayWebRemoteControlWorkspaceBridgeFrames,
  createWebRemoteControlTaskViewPublisher,
  type WebRemoteControlWorkspaceBridgeServiceRegistration,
  markWebRemoteControlBridgeTaskRead,
  markWebRemoteControlTaskRead,
} from "#src/web-remote-control/index.js";
import {
  WebRemoteControlDeviceListPage,
  WebRemoteControlLoadingScreen,
  WebRemoteControlFailureScreen,
  resolveWebRemoteControlScreenLocale,
  showWebRemoteControlVersionNotice,
  type WebRemoteControlConnectingDevice,
} from "#src/web-remote-control/views.js";
import { createHomeOnlyWebRemoteControlServices } from "#src/entry/homeOnlyWebRemoteControlServices.js";

/** 远控路由判定：固定 v4 页面 + BASE_URL 推导的历史路径（/remote、/remote/v3 等）。 */
export function isWebRemoteControlRoute(): boolean {
  return (
    matchesWebRemoteControlRoutePath(window.location.pathname, "/remote/v4") ||
    matchesWebRemoteControlRoutePath(
      window.location.pathname,
      resolveWebRemoteControlRoutePath(import.meta.env),
    )
  );
}

function isZhLocale(): boolean {
  return /^zh\b/i.test(navigator.language);
}

function logWebRemoteControlTaskReadFailure(
  error: unknown,
  context: { taskId: string; workspaceKey: string },
): void {
  console.warn("[web-remote-control] 标记手机端 task 已读失败", {
    error: error instanceof Error ? error.message : String(error),
    taskId: context.taskId,
    workspaceKey: context.workspaceKey,
  });
}

function toWebRemoteControlFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

function createWebRemoteControlRequestId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function seedStableWebRemoteControlClientId(deviceSid: string): void {
  const storageKey = `zcode-web-remote-client-id:${deviceSid}`;
  try {
    const existing = globalThis.localStorage?.getItem(storageKey)?.trim();
    if (existing) {
      setStreamClientId(existing);
      return;
    }
    const nextId = globalThis.crypto?.randomUUID?.() ?? generateMobileDeviceFingerprint();
    globalThis.localStorage?.setItem(storageKey, nextId);
    setStreamClientId(nextId);
  } catch {
    // Bugfix: iOS private mode 等环境可能禁用 localStorage。
    // 这里保留前面注入的物理指纹 fallback，避免远控首屏因 clientId 持久化失败而中断。
    setStreamClientId(generateMobileDeviceFingerprint());
  }
}

export interface WebRemoteControlRuntimeOptions {
  /** main.tsx 唯一 React Root 的 render 入口；远控所有页面共用同一挂载点。 */
  renderRoot(node: ReactNode): void;
  /** Web 平台服务由 main 提供；远控装配不感知普通 Web 模式的实现差异。 */
  createPlatform(): IPlatformService;
}

export interface WebRemoteControlRuntime {
  start(): Promise<void>;
  chooseOtherDevice(): Promise<void>;
  switchAccount(): Promise<void>;
  refreshDevices(): Promise<void>;
  selectDevice(sid: string): void;
  renderFailure(failure: WebRemoteControlFailure): void;
}

type RootServices = Parameters<typeof Root>[0]["services"];

async function markCurrentWebRemoteControlBridgeTaskRead({
  bridge,
  services,
  task,
}: {
  bridge: WebRemoteControlExternalWorkspaceBridge | WebRemoteControlWorkspaceBridge;
  services: RootServices;
  task: WebRemoteControlTaskTarget;
}): Promise<void> {
  const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
  if (taskWorkspaceKey !== bridge.workspaceKey) {
    // 修复原因：同路径 remote workspace 可能属于不同 identity，禁止误用当前 bridge 写另一条连接。
    console.warn("[web-remote-control] 跳过跨 workspace 的 task 已读写入", {
      taskId: task.taskId,
      taskWorkspaceKey,
      bridgeWorkspaceKey: bridge.workspaceKey,
    });
    return;
  }
  if (typeof task.unreadAt !== "number") {
    return;
  }

  const result = await markWebRemoteControlTaskRead({
    service: services.zcodeTaskService,
    target: {
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      expectedUnreadAt: task.unreadAt,
    },
  });
  if (!result.ok) {
    logWebRemoteControlTaskReadFailure(result.error, {
      taskId: task.taskId,
      workspaceKey: taskWorkspaceKey,
    });
  }
}

async function markOpenedWebRemoteControlBridgeTaskRead({
  bridge,
  expectedUnreadAt,
  services,
}: {
  bridge: WebRemoteControlExternalWorkspaceBridge | WebRemoteControlWorkspaceBridge;
  expectedUnreadAt?: number;
  services: RootServices;
}): Promise<void> {
  const result = await markWebRemoteControlBridgeTaskRead({
    bridge,
    expectedUnreadAt,
    service: services.zcodeTaskService,
  });
  if (!result.ok) {
    logWebRemoteControlTaskReadFailure(result.error, {
      taskId: bridge.initialTaskId ?? "unknown",
      workspaceKey: bridge.workspaceKey,
    });
  }
}

/**
 * 组装 Web 远控入口运行时：external relay bootstrap、版本护栏、帧恢复与
 * home-only Root 挂载都收口在这里；main.tsx 只负责路由选择与平台注入。
 */
export function assembleWebRemoteControlRuntime({
  renderRoot,
  createPlatform,
}: WebRemoteControlRuntimeOptions): WebRemoteControlRuntime {
  // 访问 window.localStorage 本身在部分浏览器会抛错，统一包在方法里交给调用方兜底。
  const webRemoteControlStorage: Pick<Storage, "getItem" | "setItem"> = {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  };

  // 升级 316 说明：fork 删除官方登录面（packages/web/src/auth）后不再有 WebAuthService。
  // 远控入口只消费桌面扫码链路可能留下的本地 JWT；缺 token 时渲染 auth-required 失败页，
  // 不提供登录跳转，也不触碰任何 OAuth 端点。
  const webRemoteControlAuth = {
    getZCodeJwtToken: () => webRemoteControlStorage.getItem("zcodejwttoken"),
    getActiveAccount: () => null,
    startLogin: () => {},
    logout: () => {
      webRemoteControlStorage.setItem("zcodejwttoken", "");
    },
  };

  let isPageUnloading = false;
  window.addEventListener("beforeunload", () => {
    isPageUnloading = true;
  });

  const remoteEntry = new WebRemoteControlEntry({
    auth: webRemoteControlAuth,
    getHref: () => window.location.href,
    replaceHref: (href) => window.history.replaceState(window.history.state, "", href),
    storage: webRemoteControlStorage,
    locale: resolveWebRemoteControlScreenLocale(navigator.language),
    devices: createWebRemoteControlDeviceClient(window.location.origin),
    subscribeVisible: (listener) => {
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") listener();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    },
    token: createWebRemoteControlV2TokenClient(window.location.origin),
    connect: (connection) => {
      void bootstrapExternalRelayWebRemoteControl(connection);
    },
    onView: (view) => {
      if (view.kind === "callback" || view.kind === "login") {
        renderWebRemoteControlAuthRequired();
      } else if (view.kind === "devices") {
        document.title = "ZCode - Web Remote Control";
        renderRoot(
          <WebRemoteControlDeviceListPage
            view={view}
            onSelect={(sid) => remoteEntry.selectDevice(sid)}
            onRefresh={() => {
              void remoteEntry.refreshDevices();
            }}
            onSwitchAccount={() => {
              void remoteEntry.switchAccount();
            }}
            locale={resolveWebRemoteControlScreenLocale(navigator.language)}
          />,
        );
      } else if (view.kind === "failure") renderWebRemoteControlFailure(view.failure);
    },
  });

  function renderWebRemoteControlAuthRequired(): void {
    // fork 无官方登录页：OAuth 回调与登录视图统一收敛为可重试的 auth-required 失败页。
    document.title = "ZCode - Web Remote Control";
    renderWebRemoteControlFailure(
      toWebRemoteControlFailure(
        "auth-required",
        isZhLocale()
          ? "此构建未提供 Web 登录；请从桌面端重新扫码进入远程控制。"
          : "Web sign-in is not available in this build; scan the QR code from desktop again.",
      ),
    );
  }

  function renderWebRemoteControlFailure(failure: WebRemoteControlFailure): void {
    renderRoot(
      <WebRemoteControlFailureScreen
        failure={failure}
        locale={resolveWebRemoteControlScreenLocale(navigator.language)}
        primaryActionLabel={
          failure.reason === "device-not-owned"
            ? isZhLocale()
              ? "切换账号"
              : "Switch account"
            : undefined
        }
        secondaryAction={
          isWebRemoteControlRoute()
            ? {
                label: isZhLocale() ? "选择其他设备" : "Choose another device",
                onClick: () => {
                  void remoteEntry.chooseOtherDevice();
                },
              }
            : undefined
        }
        onReload={() => {
          if (failure.reason === "device-not-owned") void remoteEntry.switchAccount();
          else window.location.reload();
        }}
      />,
    );
  }

  function renderWebRemoteControlLoading(
    state: WebRemoteControlTerminalTransportState,
    device: WebRemoteControlConnectingDevice,
  ): void {
    document.title = "ZCode - Web Remote Control";
    renderRoot(
      <WebRemoteControlLoadingScreen
        state={state}
        locale={resolveWebRemoteControlScreenLocale(navigator.language)}
        device={device}
      />,
    );
  }

  function resolveExternalRelayWsUrl(): string {
    return resolveWebRemoteControlRelayWsUrl({ endpointOrigin: window.location.origin });
  }

  async function bootstrapExternalRelayWebRemoteControl(
    connection: WebRemoteControlEntryConnection,
  ): Promise<void> {
    if (connection.signal.aborted) return;
    const { params: relayParams, getToken } = connection;
    const terminalClientSessionId = createWebRemoteControlRequestId("terminal-page");
    seedStableWebRemoteControlClientId(relayParams.deviceSid);
    // 平台只是展示偏好：取本机按 MID 记住的记录，扫码直连的陌生设备显示通用电脑图标。
    const connectingDevice: WebRemoteControlConnectingDevice = {
      name: relayParams.deviceName,
      platform: relayParams.deviceMid
        ? readKnownDevices(webRemoteControlStorage).get(relayParams.deviceMid)?.platform
        : undefined,
    };
    // 只由入口 owner 负责取消连接并选设备；不能重启 start()，否则会自动连回最近设备。
    const deviceNavigation = {
      deviceName: relayParams.deviceName,
      devicePlatform: connectingDevice.platform,
      chooseOtherDevice: () => {
        if (!connection.signal.aborted) void remoteEntry.chooseOtherDevice();
      },
    };

    let bootstrapping = false;
    let ready = false;
    let terminated = false;
    let terminalTransportState: UiWebRemoteControlTerminalTransportState = "idle";
    let currentWorkspaceKey: string | undefined;
    let currentTaskId: string | undefined;
    let currentRecoveryId: string | undefined;
    let bridgeRecoveryRetryAttempt = 0;
    let bridgeRecoveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let nextBridgeGeneration = 0;
    const checkVersionOnRecovery = window.location.pathname.replace(/\/+$/, "") === "/remote/v4";
    let disposeVersionNotice: (() => void) | undefined;
    const versionGuard = createWebRemoteControlVersionGuard({
      requestBootstrap: () => requestBootstrap(),
      onAccepted: (result) => {
        if (terminalTransportState === "paired") taskViewPublisher.seed(result.mobileTaskViewEpoch);
      },
      getUrl: () => window.location.href,
      isPageReady: () => ready,
      navigate: (url) => window.location.replace(url),
      onMismatch: (version) => {
        disposeVersionNotice = showWebRemoteControlVersionNotice(version, () =>
          versionGuard.confirm(),
        );
      },
    });
    // 必须先于 Root 的全局捕获阶段快捷键注册；原生 modal 只能隔离背景元素，不能隔离 window listener。
    const blockVersionMismatchShortcuts = (event: KeyboardEvent) => {
      if (versionGuard.isBlocked()) event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", blockVersionMismatchShortcuts, true);
    const disposeVersionInputGuard = () =>
      window.removeEventListener("keydown", blockVersionMismatchShortcuts, true);
    let activeRelayProtocol:
      | ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>
      | undefined;
    let pendingRelayProtocol: typeof activeRelayProtocol;
    let pendingBridgeAbort: AbortController | undefined;
    let activeBridgeServiceRegistration:
      | WebRemoteControlWorkspaceBridgeServiceRegistration
      | undefined;
    let sendMobileDiagnosticPayload:
      | ((payload: WebRemoteControlAppPayload & { zcode_type: "mobile-diagnostic" }) => void)
      | undefined;
    type WorkspaceListUpdateListener = (result: WebRemoteControlWorkspaceListResult) => void;
    const workspaceListUpdateListeners = new Set<WorkspaceListUpdateListener>();

    const subscribeWorkspaceListUpdates = (listener: WorkspaceListUpdateListener) => {
      workspaceListUpdateListeners.add(listener);
      return () => {
        workspaceListUpdateListeners.delete(listener);
      };
    };

    const normalizeWorkspaceListResult = (
      result: WebRemoteControlWorkspaceListResult,
    ): WebRemoteControlWorkspaceListResult => ({
      ...result,
      activeWorkspaceKey: result.activeWorkspaceKey ?? currentWorkspaceKey,
      activeTaskId: result.activeTaskId ?? currentTaskId,
    });

    const applyWorkspaceListUpdated = (result: WebRemoteControlWorkspaceListResult) => {
      const normalized = normalizeWorkspaceListResult(result);
      for (const listener of workspaceListUpdateListeners) {
        listener(normalized);
      }
    };

    const sendMobileDiagnostic = (diagnostic: WebRemoteControlTerminalTransportDiagnostic) => {
      if (diagnostic.type === "socket-extensions") {
        return;
      }
      sendMobileDiagnosticPayload?.({
        zcode_type: "mobile-diagnostic",
        event: diagnostic.type,
        timestamp: diagnostic.timestamp,
        state: diagnostic.state,
        previousState: "previousState" in diagnostic ? diagnostic.previousState : undefined,
        pairStatus: "pairStatus" in diagnostic ? diagnostic.pairStatus : undefined,
        closeCode: "code" in diagnostic ? diagnostic.code : undefined,
        closeReason: "reason" in diagnostic ? diagnostic.reason : undefined,
        wasClean: "wasClean" in diagnostic ? diagnostic.wasClean : undefined,
        wasPaired: "wasPaired" in diagnostic ? diagnostic.wasPaired : undefined,
        visibilityState: diagnostic.visibilityState,
        online: diagnostic.online,
        hiddenDurationMs: diagnostic.hiddenDurationMs,
      });
    };

    const sendMobileFailureDiagnostic = (failure: WebRemoteControlFailure) => {
      sendMobileDiagnosticPayload?.({
        zcode_type: "mobile-diagnostic",
        event: "failure",
        timestamp: Date.now(),
        state: terminalTransportState,
        failureReason: failure.reason,
        failureMessage: failure.message,
        visibilityState: document.visibilityState,
        online: navigator.onLine,
      });
    };

    const mapBootstrapUnknownErrorToFailure = (error: unknown): WebRemoteControlFailure => {
      if (error && typeof error === "object" && "reason" in error) {
        return error as WebRemoteControlFailure;
      }
      if (
        error instanceof Error &&
        error.message === "Web remote control relay did not recover before timeout."
      ) {
        // Bugfix: 桌面端长时间休眠导致“假连接”时，手机端 recoverConnection 超时会先落入 unknown，
        // 随后 waiting timer 又触发 invalid-mobile，用户会看到前后冲突的两张错误页。
        // 这里把 recover 超时直接映射为 desktop-disconnected，并在失败后立即终止 transport，
        // 保证错误语义单一且稳定。
        return toWebRemoteControlFailure(
          "desktop-disconnected",
          "Desktop did not recover the Web remote control session in time.",
        );
      }
      return toWebRemoteControlFailure(
        "unexpected-error",
        error instanceof Error ? error.message : String(error),
      );
    };

    const disposeConnection = () => {
      if (terminated) return;
      terminated = true;
      if (bridgeRecoveryRetryTimer) clearTimeout(bridgeRecoveryRetryTimer);
      bridgeRecoveryRetryTimer = undefined;
      versionGuard.dispose();
      disposeVersionInputGuard();
      disposeVersionNotice?.();
      activeBridgeServiceRegistration?.dispose();
      activeBridgeServiceRegistration = undefined;
      activeRelayProtocol?.dispose();
      activeRelayProtocol = undefined;
      pendingBridgeAbort?.abort();
      pendingBridgeAbort = undefined;
      pendingRelayProtocol?.dispose();
      pendingRelayProtocol = undefined;
      requester.dispose();
      transport.dispose();
      lifecycle.dispose();
      window.removeEventListener("beforeunload", disposeConnection);
      connection.signal.removeEventListener("abort", disposeConnection);
    };

    const renderBootstrapFailure = (failure: WebRemoteControlFailure) => {
      if (terminated || versionGuard.isBlocked()) return;
      sendMobileFailureDiagnostic(failure);
      disposeConnection();
      connection.onFailure(failure);
    };

    const renderBootstrapError = (error: unknown) => {
      renderBootstrapFailure(mapBootstrapUnknownErrorToFailure(error));
    };

    let bootstrapPairedSession:
      | ((options?: { preferredWorkspaceKey?: string; preferredTaskId?: string }) => Promise<void>)
      | undefined;

    const isLifecycleRecoveryReason = (reason: string): boolean =>
      reason === "visible" || reason === "pageshow" || reason === "online" || reason === "resume";

    const clearBridgeRecoveryRetry = (): void => {
      if (bridgeRecoveryRetryTimer) clearTimeout(bridgeRecoveryRetryTimer);
      bridgeRecoveryRetryTimer = undefined;
      bridgeRecoveryRetryAttempt = 0;
    };

    const scheduleBridgeRecoveryRetry = (): void => {
      if (bridgeRecoveryRetryTimer || terminated || isPageUnloading || versionGuard.isBlocked())
        return;
      const delay = getWebRemoteControlBridgeRecoveryRetryDelay(bridgeRecoveryRetryAttempt);
      if (delay === null) {
        // Bug 原因：旧逻辑把有界重试的 null 当成静默停止，导致已 degraded 的 protocol
        // 和旧 React Root 永久残留。预算耗尽必须进入既有终态边界，统一释放 bridge 资源并提供手动重试。
        renderBootstrapFailure(
          createWebRemoteControlConnectionRecoveryTimeoutFailure(
            "Mobile connection did not rebuild the workspace bridge within the retry budget.",
          ),
        );
        return;
      }
      bridgeRecoveryRetryAttempt += 1;
      bridgeRecoveryRetryTimer = setTimeout(() => {
        bridgeRecoveryRetryTimer = undefined;
        void recoverVisibleSession("bridge-rebuild-retry");
      }, delay);
    };

    const recoverVisibleSession = createWebRemoteControlBridgeRecoveryRunner(async (reason) => {
      if (isPageUnloading || terminated || versionGuard.isBlocked()) {
        return;
      }
      const preferredWorkspaceKey = currentWorkspaceKey;
      const preferredTaskId = currentTaskId;
      const isBridgeRebuildRetry = reason === "bridge-rebuild-retry";
      if (!isBridgeRebuildRetry) {
        bridgeRecoveryRetryAttempt = 0;
        currentRecoveryId = createWebRemoteControlRequestId("recovery");
      } else {
        // 同一 degraded recovery flight 的 bridge open 每次换 bridge generation，但 recoveryId
        // 保持不变；这样迟到 response 仍能按 recovery 边界拒绝。
        currentRecoveryId ??= createWebRemoteControlRequestId("recovery");
      }
      let requiresBridgeRebuild =
        !isLifecycleRecoveryReason(reason) || activeRelayProtocol?.isDegraded() === true;
      if (requiresBridgeRebuild) {
        activeRelayProtocol?.markDegraded();
      }
      bootstrapping = true;
      let transportRecovered = false;
      try {
        if (!import.meta.env.PROD) {
          console.info("[web-remote-control] recover terminal session", {
            reason,
            recoveryId: currentRecoveryId,
            currentWorkspaceKey: preferredWorkspaceKey,
            currentTaskId: preferredTaskId,
          });
        }
        await transport.recoverConnection();
        transportRecovered = true;
        if (!requiresBridgeRebuild && activeRelayProtocol && !activeRelayProtocol.isDegraded()) {
          if (checkVersionOnRecovery) {
            try {
              await checkDesktopVersion();
            } catch (error) {
              // 校验等待期间失效的 bridge 仍须走下方 bootstrap；它会重新校验版本并沿用原错误处理。
              if (!activeRelayProtocol.isDegraded()) throw error;
            }
          }
          // Bugfix: 手机短暂切后台只会暂停 JS/心跳，不代表 shared-host bridge 已经失效。
          // 原逻辑每次回前台都重建 bridge 和 Root，导致用户看到“已配对，正在加载工作区…”闪回。
          // bridge 是否需要重建以 desktop 发来的 bridge-degraded 或本地 frame gap 为准，避免只按后台时长误判。
          // 版本校验是异步的，完成后必须重新读取 bridge 状态，避免丢失并发的降级事件。
          if (!activeRelayProtocol.isDegraded()) {
            currentRecoveryId = undefined;
            return;
          }
        }
        // 校验期间也可能收到失效通知；实际转入重建后，失败必须沿原预算重试，不能沿用起点的健康判断。
        requiresBridgeRebuild = true;
        await bootstrapPairedSession?.({
          preferredWorkspaceKey,
          preferredTaskId,
        });
        clearBridgeRecoveryRetry();
      } catch (error) {
        if (!import.meta.env.PROD) {
          console.warn(
            "[web-remote-control] terminal recover timed out, keeping current page for retry",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (!terminated && !isPageUnloading && transportRecovered && requiresBridgeRebuild) {
          // Bug 原因：transport 已恢复但单次 bridge-open 失败时，旧逻辑只调用 transport
          // background recovery；旧 bridge 已 degraded，之后没有事件会再次发起 open。
          scheduleBridgeRecoveryRetry();
        } else if (!terminated && !isPageUnloading) {
          // Bugfix: 手机长时间切到后台后，recoverConnection 可能超过单次等待窗口。
          // 这不代表桌面端离线，也不应该卸载当前 React 页面；否则输入框草稿会被错误页打断。
          // 这里保留原页面和输入状态，继续让 transport 的重连状态机自动恢复。
          transport.recoverInBackground();
        }
      } finally {
        bootstrapping = false;
      }
    });

    renderWebRemoteControlLoading("connecting", connectingDevice);

    const taskViewPublisher = createWebRemoteControlTaskViewPublisher(
      (payload) => !terminated && !versionGuard.isBlocked() && transport.sendPayload(payload),
    );
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: resolveExternalRelayWsUrl(),
      deviceSid: relayParams.deviceSid,
      deviceMid: relayParams.deviceMid,
      appVersion: relayParams.appVersion,
      getToken,
      onRawTransportPayload: (payload) =>
        pendingRelayProtocol?.acceptPayload(payload) ||
        activeRelayProtocol?.acceptPayload(payload) ||
        false,
      onRawTransportFault: (reasonCode) => {
        pendingRelayProtocol?.markDegraded(reasonCode);
        activeRelayProtocol?.markDegraded(reasonCode);
      },
      onPayload: (payload) => {
        if (terminated) {
          return;
        }
        if (payload.zcode_type === "mobile-task-view-request") {
          taskViewPublisher.request(payload.epoch);
          return;
        }
        if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack") {
          if (!pendingRelayProtocol?.acceptPayload(payload))
            activeRelayProtocol?.acceptPayload(payload);
          return;
        }
        if (requester.acceptPayload(payload)) {
          return;
        }
        if (payload.zcode_type === "workspace-list-updated") {
          applyWorkspaceListUpdated(payload.result);
          return;
        }
        if (payload.zcode_type === "bridge-degraded") {
          acceptWebRemoteControlBridgeInvalidation(
            pendingRelayProtocol,
            payload.bridgeSessionId,
            payload.reason,
          );
          // 通知可能在后台丢失，桌面会重复补发；重复通知不能重置在途恢复与有界重试预算。
          acceptWebRemoteControlBridgeInvalidation(
            activeRelayProtocol,
            payload.bridgeSessionId,
            payload.reason,
          );
          return;
        }
        if (payload.zcode_type === "workspace-bridge-error") {
          if (
            pendingRelayProtocol &&
            payload.bridgeSessionId === pendingRelayProtocol.getBridgeSessionId()
          )
            pendingRelayProtocol.markDegraded(payload.reason);
          if (payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()) {
            // 失效通知不对应 pending request；先关闭 workspace RPC 门禁，让既有会话
            // 显示断线横幅并保留草稿，不能让旧 services 继续被当作 ready。
            activeBridgeServiceRegistration?.dispose();
            activeBridgeServiceRegistration = undefined;
            acceptWebRemoteControlBridgeInvalidation(
              activeRelayProtocol,
              payload.bridgeSessionId,
              payload.reason,
            );
          }
          return;
        }
        if (payload.zcode_type === "app-error") {
          renderBootstrapFailure(toWebRemoteControlFailure(payload.reason, payload.error));
        }
      },
      onStateChange: (state) => {
        if (terminated || versionGuard.isBlocked()) {
          return;
        }
        taskViewPublisher.transportStateChanged(state, terminalTransportState);
        terminalTransportState = state;
        if (state !== "paired") versionGuard.invalidate();
        setWebRemoteControlTerminalTransportState(state);
        if (!ready) {
          renderWebRemoteControlLoading(state, connectingDevice);
        }
        if (state !== "paired") {
          return;
        }
        connection.onPaired();
        // 已有校验操作自行跨重连消费一次重试；配对事件不能启动另一个恢复 owner。
        if (bootstrapping && pendingVersionCheck) return;
        // healthy bridge 与在途初始化都不能并发新建 bridge，但新配对仍必须检查桌面版本。
        if ((activeRelayProtocol && !activeRelayProtocol.isDegraded()) || bootstrapping) {
          if (!checkVersionOnRecovery) return;
          void checkDesktopVersion().catch((error) => {
            // 版本读取失败沿用恢复链路，不卸载已挂载页面和草稿。
            if (!terminated && !versionGuard.isBlocked()) {
              void recoverVisibleSession("visible");
              if (!import.meta.env.PROD)
                console.warn("[web-remote-control] version check failed", error);
            }
          });
          return;
        }
        if (!bootstrapPairedSession) {
          return;
        }
        bootstrapping = true;
        void bootstrapPairedSession()
          .catch((error) => {
            renderBootstrapError(error);
          })
          .finally(() => {
            bootstrapping = false;
          });
      },
      onFailure: (failure) => {
        renderBootstrapFailure(failure);
      },
      onError: (error) => {
        if (!import.meta.env.PROD) {
          console.warn("[web-remote-control] terminal transport error", error.message);
        }
      },
      onDiagnostic: (diagnostic) => {
        if (!import.meta.env.PROD) {
          console.info("[web-remote-control] terminal diagnostic", diagnostic);
        }
        sendMobileDiagnostic(diagnostic);
      },
      onSendReady: () => {
        if (versionGuard.isBlocked()) return;
        taskViewPublisher.flush();
        replayWebRemoteControlWorkspaceBridgeFrames({ activeRelayProtocol, pendingRelayProtocol });
      },
      reloadPage: () => {
        window.location.reload();
      },
    });
    sendMobileDiagnosticPayload = (payload) => transport.sendPayload(payload);
    const requester = createWebRemoteControlAppPayloadRequester({
      sendPayload: (payload) => !versionGuard.isBlocked() && transport.sendPayload(payload),
    });

    const requestAppPayload = requester.requestAppPayload;
    const requestWithRelayRecovery = createWebRemoteControlRelayRequestRecovery(() =>
      transport.recoverConnection(),
    );

    const requestBootstrap = async (): Promise<WebRemoteControlWindowBootstrapResult> => {
      const requestId = createWebRemoteControlRequestId("bootstrap");
      const response = await requestAppPayload(
        { zcode_type: "bootstrap-request", requestId, terminalClientSessionId },
        (
          payload,
        ): payload is Extract<WebRemoteControlAppPayload, { zcode_type: "bootstrap-response" }> =>
          payload.zcode_type === "bootstrap-response" && payload.requestId === requestId,
      );
      return response.result;
    };

    let pendingVersionCheck: Promise<WebRemoteControlWindowBootstrapResult | undefined> | undefined;
    const checkDesktopVersion = (): Promise<WebRemoteControlWindowBootstrapResult | undefined> => {
      if (pendingVersionCheck) return pendingVersionCheck;
      const readCurrentVersion = async () => {
        let result = await versionGuard.check();
        // 配对变化可能发生在旧 bootstrap 等待期间；旧响应失效后在当前连接重新读取。
        while (
          !result &&
          !terminated &&
          !versionGuard.isBlocked() &&
          terminalTransportState === "paired"
        ) {
          result = await versionGuard.check();
        }
        return result;
      };
      const request = requestWithRelayRecovery(readCurrentVersion, { recoverTimeout: true }).finally(
        () => {
          if (pendingVersionCheck === request) pendingVersionCheck = undefined;
        },
      );
      pendingVersionCheck = request;
      return request;
    };

    // 升级 316 说明：上游在 platform 上挂 externalWebRemoteControlProxy 转发平台方法与遥测；
    // fork 的 IPlatformService 没有该管线且遥测上报已删，这里整块跳过，不做空壳转发。
    const updateMobileViewState = async (workspaceKey: string, taskId?: string): Promise<void> => {
      currentWorkspaceKey = workspaceKey;
      currentTaskId = taskId;
      transport.sendPayload({
        zcode_type: "mobile-view-state-update",
        viewState: {
          activeWorkspaceKey: workspaceKey,
          ...(taskId ? { activeTaskId: taskId } : {}),
          updatedAt: Date.now(),
        },
        deviceInfo: collectWebRemoteControlMobileDeviceInfo({
          appVersion: relayParams.appVersion,
        }),
      });
    };

    const reconnectWorkspace = async (workspaceKey: string): Promise<void> => {
      const response = await requestWithRelayRecovery(() => {
        const requestId = createWebRemoteControlRequestId("workspace-reconnect");
        return requestAppPayload(
          {
            zcode_type: "workspace-reconnect-request",
            requestId,
            workspaceKey,
          },
          (
            payload,
          ): payload is Extract<
            WebRemoteControlAppPayload,
            { zcode_type: "workspace-reconnect-response" }
          > =>
            payload.zcode_type === "workspace-reconnect-response" &&
            payload.requestId === requestId &&
            payload.workspaceKey === workspaceKey,
          {
            // 远程重连会启动或部署 host，Docker/SSH 首连可能超过默认 10 秒；这里放宽等待，避免桌面端成功后手机端先误报超时。
            timeoutMs: WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
          },
        );
      });
      if (!response.success) {
        throw new Error(response.error);
      }
      if (workspaceKey === currentWorkspaceKey && activeRelayProtocol?.isDegraded()) {
        await recoverVisibleSession(
          "workspace-reconnected",
          () => workspaceKey === currentWorkspaceKey && activeRelayProtocol?.isDegraded() === true,
        );
      }
    };

    const openWorkspaceBridge = async (
      workspaceKey: string,
      options?: WebRemoteControlWorkspaceSwitchOptions & {
        project?: Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-bridge-open" }
        >["project"];
      },
    ): Promise<{
      bridge: WebRemoteControlExternalWorkspaceBridge;
      services: Awaited<ReturnType<typeof connectViaProtocol>>;
      relayProtocol: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>;
    }> => {
      const bridgeSessionId = createWebRemoteControlRequestId("bridge");
      const bridgeGeneration = ++nextBridgeGeneration;
      pendingBridgeAbort?.abort();
      const bridgeAbort = new AbortController();
      pendingBridgeAbort = bridgeAbort;
      const isCurrent = () =>
        !terminated && !versionGuard.isBlocked() && bridgeGeneration === nextBridgeGeneration;
      const response = await requestWithRelayRecovery(() =>
        requestAppPayload(
          {
            zcode_type: "workspace-bridge-open",
            terminalClientSessionId,
            requestId: createWebRemoteControlRequestId("workspace-bridge"),
            bridgeSessionId,
            bridgeGeneration,
            ...(currentRecoveryId ? { recoveryId: currentRecoveryId } : {}),
            workspaceKey,
            ...(options?.taskId ? { taskId: options.taskId } : {}),
            ...(options?.taskHostId ? { taskHostId: options.taskHostId } : {}),
            ...(options?.fileTreeTaskId ? { fileTreeTaskId: options.fileTreeTaskId } : {}),
            ...(options?.project ? { project: options.project } : {}),
          },
          (
            payload,
          ): payload is Extract<
            WebRemoteControlAppPayload,
            { zcode_type: "workspace-bridge-ready" }
          > =>
            payload.zcode_type === "workspace-bridge-ready" &&
            payload.bridgeSessionId === bridgeSessionId,
        ),
      );
      if (!isCurrent() || bridgeAbort.signal.aborted) {
        throw new Error("Web remote control version changed before the workspace bridge was ready.");
      }
      currentRecoveryId = undefined;
      const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: response.bridge.bridgeSessionId,
        bridgeGeneration: response.bridge.bridgeGeneration,
        recoveryId: response.bridge.recoveryId,
        measureFrameBytes: (frame) => transport.measurePayloadBytes(frame),
        sendFrame: (frame) => {
          if (versionGuard.isBlocked()) return false;
          const result = transport.sendPayloadResult(frame);
          if (result.kind === "oversize") {
            throw new Error("remote.rpcFrame.envelopeTooLarge");
          }
          return result.kind === "sent";
        },
      });
      relayProtocol.onDegraded((fault) => {
        if (activeRelayProtocol !== relayProtocol) return;
        if (!import.meta.env.PROD) {
          console.warn("[web-remote-control] raw relay bridge degraded", {
            bridgeSessionId: relayProtocol.getBridgeSessionId(),
            reasonCode: fault.reasonCode,
          });
        }
        void recoverVisibleSession(fault.reasonCode);
      });
      const services = await connectWebRemoteControlWorkspaceBridgeServices({
        relayProtocol,
        windowProjectDirectory:
          response.bridge.kind === "remote" &&
          response.bridge.capabilities?.windowProjectDirectory === true,
        activateTransport: () => {
          // 能力 RPC 必须先有收帧目标；服务与 Root 仍等就绪后才切换。
          pendingRelayProtocol = relayProtocol;
          return () => {
            if (pendingRelayProtocol === relayProtocol) pendingRelayProtocol = undefined;
          };
        },
        isCurrent,
        signal: bridgeAbort.signal,
      });
      const bridgeServiceRegistration = registerWebRemoteControlWorkspaceBridgeServices({
        bridge: response.bridge,
        services,
      });
      // 已读写入是打开 task 的伴随动作，不等待它完成，避免慢磁盘/远程 IO 阻塞 bridge 切换。
      void markOpenedWebRemoteControlBridgeTaskRead({
        bridge: response.bridge,
        expectedUnreadAt: options?.markTaskReadExpectedUnreadAt,
        services,
      });
      const previousRelayProtocol = activeRelayProtocol;
      const previousBridgeServiceRegistration = activeBridgeServiceRegistration;
      activeRelayProtocol = relayProtocol;
      taskViewPublisher.setBridge(response.bridge);
      if (pendingRelayProtocol === relayProtocol) pendingRelayProtocol = undefined;
      if (pendingBridgeAbort === bridgeAbort) pendingBridgeAbort = undefined;
      activeBridgeServiceRegistration = bridgeServiceRegistration;
      previousRelayProtocol?.dispose();
      previousBridgeServiceRegistration?.dispose();
      currentWorkspaceKey = response.bridge.workspaceKey;
      currentTaskId = response.bridge.initialTaskId;
      await updateMobileViewState(response.bridge.workspaceKey, response.bridge.initialTaskId);
      if (!isCurrent()) throw new Error("Workspace bridge request was superseded.");
      return { bridge: response.bridge, services, relayProtocol };
    };

    const renderExternalRelayRoot = (
      services: Awaited<ReturnType<typeof connectViaProtocol>>,
      bridge: WebRemoteControlExternalWorkspaceBridge,
      initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
      initialTaskDraft?: ComponentProps<typeof Root>["initialTaskDraft"],
      initialSidebarFileTreeOpen = false,
    ) => {
      if (terminated || versionGuard.isBlocked()) return;
      ready = true;
      document.title = "ZCode - Web Remote Control";
      renderRoot(
        <AppErrorBoundary key={bridge.bridgeSessionId}>
          <ZCodeIntlProvider
            settingService={services.settingService}
            broadcastService={services.broadcastService}
            preferSettingServiceLocale
          >
            <Root
              services={services}
              platform={createPlatform()}
              // Bug 原因：手机复用 Desktop Host 中已持久化的 Assistant row，但 Root 默认关闭
              // code-comment 投影，导致 replay hydration 暴露原始 directive。该开关只修正展示能力，
              // 不进入 relay、Host 或 replayable 状态。
              assistantCodeCommentCardsEnabled
              initialWorkspaceAbsPath={bridge.workspacePath}
              initialWorkspaceIdentity={
                bridge.kind === "remote" ? bridge.workspaceIdentity : undefined
              }
              initialTaskId={bridge.initialTaskId}
              initialTaskDraft={initialTaskDraft}
              composerClientNamespace={`mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`}
              initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
              initialWebRemoteControlMobileNavigationIntent={initialNavigationIntent}
              webRemoteControlTerminalTransportState={terminalTransportState}
              initialWorkspaceLoadingFallback={
                <WebRemoteControlLoadingScreen
                  state="paired"
                  locale={resolveWebRemoteControlScreenLocale(navigator.language)}
                  device={connectingDevice}
                />
              }
              restoreSession={false}
              allowOpenWorkspace={false}
              webRemoteControlWorkspaceSwitcher={{
                deviceNavigation,
                listWorkspaces,
                onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
                openProjectDraft,
                switchWorkspace: async (workspaceKey, options) => {
                  const initialNavigationIntent = options?.mobileNavigationIntent;
                  const result = await openWorkspaceBridge(workspaceKey, options);
                  renderExternalRelayRoot(
                    result.services,
                    result.bridge,
                    initialNavigationIntent,
                    undefined,
                    Boolean(options?.fileTreeTaskId || options?.openFileManager),
                  );
                },
                markTaskRead: (task) =>
                  markCurrentWebRemoteControlBridgeTaskRead({
                    bridge,
                    services,
                    task,
                  }),
                startDraft: async (workspaceKey, options) => {
                  const initialNavigationIntent = options?.mobileNavigationIntent;
                  const result = await openWorkspaceBridge(workspaceKey, undefined);
                  await updateMobileViewState(result.bridge.workspaceKey);
                  renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
                },
                reconnectWorkspace,
                updateMobileViewState,
                updateMobileTaskView: async (view) => {
                  taskViewPublisher.update(bridge, view);
                },
              }}
              preferDirectoryBrowser
              supportsEmbeddedBrowser={false}
              allowRemoteWorkspace={false}
            />
          </ZCodeIntlProvider>
        </AppErrorBoundary>,
      );
    };

    const listWorkspaces = async (): Promise<WebRemoteControlWorkspaceListResult> => {
      const requestWorkspaceList = async () => {
        const requestId = createWebRemoteControlRequestId("workspace-list");
        return requestAppPayload(
          { zcode_type: "workspace-list-request", requestId },
          (
            payload,
          ): payload is Extract<
            WebRemoteControlAppPayload,
            { zcode_type: "workspace-list-response" }
          > => payload.zcode_type === "workspace-list-response" && payload.requestId === requestId,
        );
      };
      const response = await requestWithRelayRecovery(() => requestWorkspaceList(), {
        // Bugfix: 外部 relay 偶发只保留手机到 desktop 的单向通路，或请求发生在重连/suspect 窗口导致未发送。
        // 首页列表是幂等请求，失败后重建 terminal socket 并重试一次，比直接展示 0 个任务更稳。
        recoverTimeout: true,
      });
      return normalizeWorkspaceListResult(response.result);
    };

    const openProjectDraft = async (
      request: NonNullable<ComponentProps<typeof Root>["initialTaskDraft"]>,
    ) => {
      const projectId = request.projectId ?? null;
      const pendingDraft =
        !projectId && (!request.hostId || request.hostId === "local")
          ? ensurePendingTaskDraft({
              clientNamespace: `mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`,
              hostId: "local",
              projectId: null,
            })
          : null;
      const result = await openWorkspaceBridge(currentWorkspaceKey ?? "project-navigation", {
        project: {
          projectId,
          ...(request.hostId ? { hostId: request.hostId } : {}),
          ...(pendingDraft
            ? { draftId: pendingDraft.draftId, reuseDraft: Boolean(pendingDraft.workspacePath) }
            : {}),
        },
      });
      renderExternalRelayRoot(result.services, result.bridge, "chat", {
        ...request,
        projectId,
        ...(pendingDraft ? { draftId: pendingDraft.draftId } : {}),
      });
    };

    const renderExternalRelayHomeOnlyRoot = async (
      workspaceKey: string,
      taskId?: string,
    ): Promise<void> => {
      if (terminated || versionGuard.isBlocked()) return;
      currentWorkspaceKey = workspaceKey;
      currentTaskId = taskId;
      await updateMobileViewState(workspaceKey, taskId);
      document.title = "ZCode - Web Remote Control";
      if (terminated || versionGuard.isBlocked()) return;
      // Bug 原因：staging 合并 a861a83cbc 丢了这里的 ready 标记，home-only 挂载后每次配对状态抖动
      // 都会被 onStateChange 当成首屏重渲染加载页，配对恢复后再整页重挂，引导与本地状态全部丢失。
      // 与 bridge Root 一致：Root 挂载后由其自身横幅展示断线状态。
      ready = true;
      renderRoot(
        <AppErrorBoundary key={`home-only-${workspaceKey}`}>
          <ZCodeIntlProvider>
            <Root
              composerClientNamespace={`mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`}
              services={createHomeOnlyWebRemoteControlServices()}
              platform={createPlatform()}
              initialWorkspaceAbsPath={workspaceKey}
              initialTaskId={taskId}
              initialWebRemoteControlMobileNavigationIntent={undefined}
              webRemoteControlTerminalTransportState={terminalTransportState}
              initialWorkspaceLoadingFallback={
                <WebRemoteControlLoadingScreen
                  state="paired"
                  locale={resolveWebRemoteControlScreenLocale(navigator.language)}
                  device={connectingDevice}
                />
              }
              restoreSession={false}
              allowOpenWorkspace={false}
              webRemoteControlWorkspaceSwitcher={{
                deviceNavigation,
                listWorkspaces: async () => ({
                  ...(await listWorkspaces()),
                  activeWorkspaceKey: currentWorkspaceKey,
                  activeTaskId: currentTaskId,
                }),
                onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
                openProjectDraft,
                switchWorkspace: async (nextWorkspaceKey, options) => {
                  const initialNavigationIntent = options?.mobileNavigationIntent;
                  const result = await openWorkspaceBridge(nextWorkspaceKey, options);
                  renderExternalRelayRoot(
                    result.services,
                    result.bridge,
                    initialNavigationIntent,
                    undefined,
                    Boolean(options?.fileTreeTaskId || options?.openFileManager),
                  );
                },
                startDraft: async (nextWorkspaceKey, options) => {
                  const initialNavigationIntent = options?.mobileNavigationIntent;
                  const result = await openWorkspaceBridge(nextWorkspaceKey, undefined);
                  await updateMobileViewState(result.bridge.workspaceKey);
                  renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
                },
                reconnectWorkspace,
                updateMobileViewState,
              }}
              preferDirectoryBrowser
              supportsEmbeddedBrowser={false}
              allowRemoteWorkspace={false}
            />
          </ZCodeIntlProvider>
        </AppErrorBoundary>,
      );
    };

    bootstrapPairedSession = async (options?: {
      preferredWorkspaceKey?: string;
      preferredTaskId?: string;
    }) => {
      const bootstrapResult = await checkDesktopVersion();
      if (!bootstrapResult || terminated || versionGuard.isBlocked()) return;
      const selectedWorkspace = resolveWebRemoteControlRecoveryTarget(bootstrapResult, options);
      if (!selectedWorkspace) {
        throw toWebRemoteControlFailure(
          "workspace-closed",
          "No opened desktop workspace is available for Web remote control.",
        );
      }
      if (!selectedWorkspace.canBridge) {
        // Source 断开后的 bootstrap 只确认离线，不替换当前 Root；内容与草稿仍由
        // 原会话 owner 持有。冷启动没有已加载 bridge，继续使用原 home-only 边界。
        if (activeRelayProtocol && selectedWorkspace.workspaceKey === currentWorkspaceKey) {
          activeBridgeServiceRegistration?.dispose();
          activeBridgeServiceRegistration = undefined;
          return;
        }
        await renderExternalRelayHomeOnlyRoot(
          selectedWorkspace.workspaceKey,
          selectedWorkspace.taskId,
        );
        return;
      }

      const result = await openWorkspaceBridge(selectedWorkspace.workspaceKey, {
        taskId: selectedWorkspace.taskId,
        taskHostId: selectedWorkspace.taskHostId,
      });
      renderExternalRelayRoot(result.services, result.bridge);
    };

    const lifecycle = createWebRemoteControlLifecycleRecovery({
      documentTarget: document,
      windowTarget: window,
      onSuspend: () => {
        // hidden/pagehide/freeze 后 JS 与 WebSocket 都可能暂停；先撤销查看，再关闭发送门。
        // 导航恢复位置保留，是否重建 bridge 仍由既有恢复流程决定。
        taskViewPublisher.suspend();
        transport.suspend();
      },
      onRecover: (reason) => {
        void recoverVisibleSession(reason);
      },
    });
    window.addEventListener("beforeunload", disposeConnection, { once: true });
    connection.signal.addEventListener("abort", disposeConnection, { once: true });
    transport.start();
  }

  return {
    start: () => remoteEntry.start(),
    chooseOtherDevice: () => remoteEntry.chooseOtherDevice(),
    switchAccount: () => remoteEntry.switchAccount(),
    refreshDevices: () => remoteEntry.refreshDevices(),
    selectDevice: (sid) => remoteEntry.selectDevice(sid),
    renderFailure: renderWebRemoteControlFailure,
  };
}
