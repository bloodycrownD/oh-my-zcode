/* eslint-disable max-lines -- Web 入口集中编排启动、路由与 workspace shell wiring，与 Root.tsx 同样先保持入口收口，避免跨层状态拆散。 */
import { createRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  generateMobileDeviceFingerprint,
  installDocumentHiddenMotionPause,
  playTaskNotificationSound,
  setStreamClientId,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import { connectViaWebSocket } from "@zcode/client";
import {
  isWebRemoteControlThemeSeed,
  type IPlatformService,
  type RemoteTarget,
  type ServerRemoteInfo,
  type WebRemoteControlStatus,
  type WebRemoteControlThemeSeed,
} from "@zcode/shared";
import {
  assembleWebRemoteControlRuntime,
  isWebRemoteControlRoute,
} from "#src/entry/webRemoteControlRuntime.js";
import { resolveWebRemoteControlScreenLocale } from "#src/web-remote-control/views.js";

// 测试与断连首页直接消费 home-only 服务面；入口保持唯一 re-export 点，避免调用方深入 entry 内部模块。
export { createHomeOnlyWebRemoteControlServices } from "#src/entry/homeOnlyWebRemoteControlServices.js";

// Web 标签标题的品牌名单一常量：静态 index.html title 与两条 bootstrap 路径的运行时重写共用，防止漂移。
const OMZ_WEB_BRAND_NAME = "omz";

/** Web 端默认主题；与桌面/远控首屏一致，缺省走 Zai dark。 */
const WEB_DEFAULT_THEME: WebRemoteControlThemeSeed = "zai-dark";

function normalizeWebThemeSeed(theme: WebRemoteControlThemeSeed): WebRemoteControlThemeSeed {
  if (theme === "dark") return "zai-dark";
  if (theme === "light") return "zai-light";
  return theme;
}

function resolveWebThemePreference(
  defaultTheme: WebRemoteControlThemeSeed = WEB_DEFAULT_THEME,
): WebRemoteControlThemeSeed {
  const stored = localStorage.getItem("zcode-theme");
  return normalizeWebThemeSeed(isWebRemoteControlThemeSeed(stored) ? stored : defaultTheme);
}

// 初始化主题：默认 Zai dark，后续由 useTheme hook 接管
// system 模式下需要查询系统偏好；非 system 模式直接用存储值
{
  const saved = resolveWebThemePreference();
  const resolved =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

// 浏览器标签页 / 手机切后台时禁用 CSS 动画，避免 DocumentTimeline 持有已卸载的 DOM 子树。
installDocumentHiddenMotionPause();

const root = createRoot(document.getElementById("root")!);

// 初始化 Web 端流式 clientId，确保所有 hook 在首次渲染前就使用稳定 ID
{
  setStreamClientId(generateMobileDeviceFingerprint());
}

// Web 远控入口运行时：external relay bootstrap、版本护栏与 home-only Root 装配都在其中；
// 这里只注入唯一 React Root 与 Web 平台服务，远控页面与普通 Web 模式共用挂载点。
const webRemoteControlRuntime = assembleWebRemoteControlRuntime({
  renderRoot: (node) => root.render(node),
  createPlatform: createWebPlatform,
});

interface WebBootstrapResult {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialTaskId?: string;
  restoreSession?: boolean;
  allowOpenWorkspace?: boolean;
}

function createWebPlatform(): IPlatformService {
  return {
    canSelectFilePath: false,
    // Web 端无法打开系统目录选择框
    selectDirectory: () => Promise.resolve(null),
    // Web 端无法打开系统文件选择框
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    createTempTextAttachment: () =>
      Promise.reject(new Error("Temporary text attachments require a desktop host")),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    // Web 端无多窗口管理
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    // TODO(web-remote-workspace): 普通 Web 模式先只保证 server 本地工作区可用。
    // 远程 WebSocket 只暴露部分 service，与 Root/RemoteServiceAccess 需要的完整
    // accessor 不匹配，直接打开 ?remote=<id> 会在项目向导或首屏卡住。
    connectRemote(options: RemoteTarget) {
      return Promise.resolve({
        success: false,
        error: `Remote connect is not supported in Web mode yet: ${options.kind}`,
      });
    },
    cancelPendingRemoteConnection: (_requestId?: string) => Promise.resolve(),
    // Web 端不作为 Web 远程控制的发起端，保留显式拒绝以兼容统一平台接口。
    startWebRemoteControl: () =>
      Promise.reject(new Error("Web remote control can only be started from desktop")),
    stopWebRemoteControl: () => Promise.resolve(),
    getWebRemoteControlStatus: () => Promise.resolve<WebRemoteControlStatus>({ status: "idle" }),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () => Promise.resolve(false),
    listWSLDistros: () => Promise.resolve([]),
    listDockerContainers: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),
    loadMcpFromUserDirectory: () => Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: () =>
      Promise.resolve({
        success: false,
        error: "MCP native directory management requires a desktop attachment",
      }),
    migrateLegacyCommonMcp: () =>
      Promise.resolve({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openInFileManager: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    openExternalFile: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    notifyRendererReady: () => {},
    showTaskNotification: (payload) => {
      if (document.hasFocus()) {
        return;
      }

      if (
        typeof window.Notification === "undefined" ||
        window.Notification.permission !== "granted"
      ) {
        return;
      }

      try {
        new window.Notification(payload.title, {
          body: payload.body,
          silent: true,
        });
        void playTaskNotificationSound();
      } catch {
        // 浏览器通知不可用时静默忽略，避免打断主流程
      }
    },
    // Web 端不需要跨窗口 tab 管理
    syncWindowTabs: () => {},
    // Web 端没有宿主层 Dock / 任务栏徽标，保持空实现以兼容统一平台接口
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: (_options) =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: (_locale) => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    getDeviceId: () => {
      const nav = globalThis.navigator as Navigator & { platform?: string };
      const platform = nav?.platform ?? "";
      const screenWidth = globalThis.screen?.width;
      const screenHeight = globalThis.screen?.height;
      const colorDepth = globalThis.screen?.colorDepth;
      const parts = [
        platform,
        screenWidth !== undefined ? String(screenWidth) : "",
        screenHeight !== undefined ? String(screenHeight) : "",
        colorDepth !== undefined ? String(colorDepth) : "",
      ];
      return parts.filter(Boolean).join("|");
    },
  };
}

function resolveDefaultWsOrigin(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

async function resolveWebBootstrap(): Promise<WebBootstrapResult> {
  const params = new URLSearchParams(window.location.search);
  const remoteId = params.get("remote");
  const wsUrl = remoteId
    ? `${resolveDefaultWsOrigin()}/ws/remote/${remoteId}`
    : `${resolveDefaultWsOrigin()}/ws`;

  if (remoteId) {
    return { wsUrl };
  }

  try {
    const response = await fetch("/api/server-info", {
      cache: "no-store",
    });
    if (!response.ok) {
      return { wsUrl };
    }
    const serverInfo = (await response.json()) as Partial<ServerRemoteInfo>;
    const workspace = Array.isArray(serverInfo.workspaces) ? serverInfo.workspaces[0] : undefined;
    return {
      wsUrl,
      ...(workspace?.path ? { initialWorkspaceAbsPath: workspace.path } : {}),
      ...(workspace?.workspaceIdentity
        ? { initialWorkspaceIdentity: workspace.workspaceIdentity }
        : {}),
    };
  } catch {
    return { wsUrl };
  }
}

function WebBootstrapErrorScreen({ message }: { message: string }) {
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-destructive" />
            <h1 className="text-ui-xs font-medium">
              {/^zh\b/i.test(navigator.language) ? "Web 启动失败" : "Web bootstrap failed"}
            </h1>
          </div>
          <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">{message}</p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
            onClick={() => {
              window.location.reload();
            }}
          >
            {/^zh\b/i.test(navigator.language) ? "重试" : "Retry"}
          </button>
        </section>
      </div>
    </div>
  );
}

function renderWebBootstrapError(error: unknown): void {
  document.title = `${OMZ_WEB_BRAND_NAME} - Web`;
  root.render(
    <WebBootstrapErrorScreen message={error instanceof Error ? error.message : String(error)} />,
  );
}

async function bootstrapWebApp() {
  // Web 远控（/remote、/remote/v3、/remote/v4）优先于普通 Web+Server 模式；
  // 入口 owner 在远控装配内，登录/回调视图也由它收敛（fork 无官方登录面，渲染 auth-required）。
  if (isWebRemoteControlRoute()) {
    document.documentElement.lang = resolveWebRemoteControlScreenLocale(navigator.language);
    await webRemoteControlRuntime.start();
    return;
  }

  let bootstrap: WebBootstrapResult;
  try {
    bootstrap = await resolveWebBootstrap();
  } catch (error) {
    renderWebBootstrapError(error);
    return;
  }

  try {
    const services = await connectViaWebSocket(bootstrap.wsUrl, {
      onClose: () => {},
    });
    const platform = createWebPlatform();
    document.title = `${OMZ_WEB_BRAND_NAME} - Web + Server`;

    root.render(
      <AppErrorBoundary>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
        >
          <Root
            services={services}
            platform={platform}
            initialWorkspaceAbsPath={bootstrap.initialWorkspaceAbsPath}
            initialWorkspaceIdentity={bootstrap.initialWorkspaceIdentity}
            initialTaskId={bootstrap.initialTaskId}
            restoreSession={bootstrap.restoreSession}
            allowOpenWorkspace={bootstrap.allowOpenWorkspace}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  } catch (error) {
    renderWebBootstrapError(error);
  }
}

void bootstrapWebApp();
