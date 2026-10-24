/* oxlint-disable eslint(max-lines) */
import { ArrowLeft, Rocket, type LucideIcon } from "lucide-react";
import { ArchiveManagement } from "@/project-sidebar/ArchiveManagement.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type {
  AppSettings,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  IPlatformService,
  Locale,
  SourceServerManagementSnapshot,
  ZCodeInteractionBehavior,
} from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  buildRemoteHostWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";

import {
  addPendingSettingsSectionListener,
  clearPendingSettingsPluginOrigin,
  clearPendingSettingsPluginScopeKey,
  consumeInitialSettingsSection,
  consumePendingSettingsPluginOrigin,
  consumePendingSettingsPluginScopeKey,
  consumePendingSettingsPluginTab,
  consumePendingSettingsModelProviderTarget,
  consumePendingSettingsSourceServerDetails,
  consumePendingSettingsSourceServerId,
  resolveSettingsSection,
  setPendingSettingsSectionIntent,
  shouldFallbackSettingsUsageTabToApp,
  writeLastSettingsSectionPreference,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";

import { ModelProviderSection } from "@/settings/ModelProviderSection.js";
import { SourceServerManagementPanel } from "@/source-server-management/SourceServerManagementPanel.js";
import { useSourceServerManagementSnapshot } from "@/source-server-management/useSourceServerManagementSnapshot.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import { UsageStatsSection } from "@/settings/UsageStatsSection.js";
import { SubagentsSection } from "@/settings/SubagentsSection.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";

import { PluginsSection } from "@/settings/PluginsSection.js";
import { HooksSection } from "@/settings/HooksSection.js";
import { WorkspaceFileSearchSection } from "@/settings/WorkspaceFileSearchSection.js";
import { MemoryManagementSection } from "@/settings/MemoryManagementSection.js";
import { MagicContextSettingsSection } from "@/settings/MagicContextSettingsSection.js";
import { BrowserSettingsSection } from "@/settings/BrowserSettingsSection.js";
import { ComputerUseSection } from "@/settings/ComputerUseSection.js";
import { ShortcutSettingsSection } from "@/settings/ShortcutSettingsSection.js";
import { MigrationSection } from "@/settings/MigrationSection.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { Theme } from "@/useTheme.js";
import { WindowsTopLeftLogo } from "@/WindowsTopLeftLogo.js";

import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useSelectDirectory } from "@/hooks/usePlatform.js";
import { ServiceProvider, useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveModelProviderConnectivityWorkspacePath } from "@/lib/modelProviderConnectivityTarget.js";
import {
  createSettingsPageConfig,
  GeneralSectionContent,
  GeneralSectionHeader,
  resolveSettingsSectionForPlatform,
} from "./settingsPageHelpers.js";
import { AppearanceSectionContent } from "./settingsCodePreview.js";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import { logger } from "@/logger.js";
import { ensureSourceSettingsServices } from "@/store/sourceSettingsServiceStore.js";
import { getSourceSettingsServices } from "@/store/sourceSettingsServiceStore.js";
import { useSourceSettingsAttachmentId } from "@/store/sourceSettingsServiceStore.js";
import { useSourceSettingsServices } from "@/store/sourceSettingsServiceStore.js";
import { useSourceSettingsServicesVersion } from "@/store/sourceSettingsServiceStore.js";
import { releaseSourceSettingsServices } from "@/store/sourceSettingsServiceStore.js";
import {
  isSettingsSourceOnline,
  resolveSettingsSourceCapabilityServices,
} from "@/settings/settingsSourceWorkspace.js";
import type { IServiceAccessor } from "@zcode/services";
// 遥测链路移除后设置动作直接执行；保留本包装以免改动全部调用点的对象字面量形状。
// featureId / action / trigger / completed / failureStage 已无消费方，仅为兼容现有调用签名保留。
function runSettingsActionAsync<T>(options: {
  featureId: string;
  action: string;
  trigger: string;
  operation: () => Promise<T>;
  completed: unknown;
  failureStage?: string;
}): Promise<T> {
  return options.operation();
}

function SettingsSidebarButton({
  icon: Icon,
  label,
  active,
  children,
  className,
  ...buttonProps
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  children?: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <ControlHintTooltip title={label} side="right" align="center">
      <button
        {...buttonProps}
        type={buttonProps.type ?? "button"}
        aria-label={label}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors",
          "max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0",
          active
            ? "bg-surface-hover text-foreground"
            : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
          className,
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-current">
          <Icon className="size-4 text-foreground" />
        </span>
        <span className="min-w-0 flex-1 max-lg:sr-only">
          {children ?? <span className="truncate text-ui-base text-foreground">{label}</span>}
        </span>
      </button>
    </ControlHintTooltip>
  );
}

/**
 * 「按设备编辑设置」选择器的哨兵值：
 * - all：保持本机设置页旧行为（不按设备收窄 workspace scope）；
 * - local：只允许本机项目（等价 settingsSourceServerId === null）；
 * - 其它值：Source Server id（等价 settingsSourceServerId === "<id>"）。
 */
const SETTINGS_SOURCE_ALL = "__all__";
const SETTINGS_SOURCE_LOCAL = "__local__";

type SourceSettingsAttachmentRequest = (
  sourceServerId: string,
) => Promise<{ attachmentId: string }>;

/**
 * 探测平台是否提供 Source 设置 attachment（上游 IPlatformService.requestSourceSettingsAttachment）。
 *
 * 当前链路（2026-10-24 已闭环，ab7dd19e 落地）：desktop preload 暴露
 * requestSourceSettingsAttachment → main 的 sourceSettingsAttachmentBroker 校验设备登记/在线
 * 状态并等 Host 回执 → Host 确认服务集可装配后，main 经
 * `InternalChannels.SourceSettingsServicePort` 把 scoped MessagePort transfer 给 renderer →
 * renderer 启动时注册的 sourceSettingsServicePortBridge 收到消息并调用
 * registerSourceSettingsServices 登记端口；设置页只按 sourceServerId 读取已登记的服务。
 *
 * 本函数仍必须经 IPlatformService 探测而不是绕过平台层直连 renderer 全局对象：Web / 旧
 * preload 没有该能力时返回 undefined，调用方保持「该 Source 的已连接 workspace 当锚点」的
 * 既有真实链路。
 */
function resolveSourceSettingsAttachmentRequest(
  platform: IPlatformService,
): SourceSettingsAttachmentRequest | undefined {
  const candidate = (platform as { requestSourceSettingsAttachment?: unknown })
    .requestSourceSettingsAttachment;
  return typeof candidate === "function"
    ? (candidate as SourceSettingsAttachmentRequest).bind(platform)
    : undefined;
}

function SettingsSourceSelect({
  value,
  sourceServers,
  onValueChange,
}: {
  value: string;
  sourceServers: readonly { sourceServerId: string; displayName: string }[];
  onValueChange: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        size="lg"
        className="w-56 min-w-0 justify-between"
        aria-label={intl.formatMessage({ id: "settings.source.devicesHeading" })}
        data-settings-source-select="true"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={SETTINGS_SOURCE_ALL}>
          {intl.formatMessage({ id: "settings.scope.default" })}
        </SelectItem>
        <SelectItem value={SETTINGS_SOURCE_LOCAL}>
          {intl.formatMessage({ id: "project.local" })}
        </SelectItem>
        {sourceServers.map((server) => (
          <SelectItem key={server.sourceServerId} value={server.sourceServerId}>
            {server.displayName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 支持「按设备编辑」的分区：配置读写都按 Source scope 收窄。 */
const SETTINGS_SOURCE_SCOPED_SECTIONS: ReadonlySet<SettingsSectionId> = new Set([
  "plugin",
  "mcp",
  "skill",
  "commands",
  "subagents",
  "hooks",
]);

/**
 * Source 设置 attachment 自动重试的追踪状态（纯数据，便于无 jsdom 的单测）。
 *
 * Bug 原因：旧 effect 只依赖 [selectedSettingsSourceServerId, sourceAttachmentRequest]，
 * 设备掉线再上线时 management 快照变了但 effect 不重跑，端口再也申请不回来，用户只能
 * 手动重选设备。修复依据：在线状态是 management 快照的事实，用快照变化驱动重试即可，
 * 不需要轮询定时器。
 *
 * 幂等键 = `sourceServerId + cycle`（在线周期）。cycle 只在观察到「离线 → 在线」时 +1，
 * 因此同一在线周期内最多自动申请一次；端口已登记时直接跳过，不干扰成功建立的端口。
 * 例外（同一周期也允许再申请）：前一次申请失败（失败回调清空 attemptedCycle），或
 * 已登记的端口在同一周期内被释放（`portRegistered` 由 true 变 false）。
 *
 * 失败退避：连续失败越多，下一次申请要等得越久；只按状态变化到达时的退避时长封顶 30s，
 * 由调用方按 `retryAfterMs` / 失败次数注册一次性可取消定时器再跑决策（不是轮询），
 * 否则「失败后快速掉线重连」会占掉新在线周期却永远不再申请。
 *
 * 有界性（2026-10-25 复核补齐）：`failedAttempts` 与 `portReleaseAttempts` 各有明确上限；
 * 任一到达上限即进入 `exhausted` 放弃态（UI 显式提示 + 手动重试出口），不再安排定时器。
 * 放弃态在「离线→在线」新周期、端口确认登记、切换设备时重置。
 */
export interface SourceSettingsAttachmentRetryTracker {
  sourceServerId: string;
  /** 上一次观察到的在线状态；null = management 快照尚未就绪（不据此拦截）。 */
  online: boolean | null;
  /** 当前在线周期序号：每观察到一次「离线 → 在线」+1。 */
  cycle: number;
  /** 最近一次申请所在的在线周期；null = 本设备尚未自动申请过（或前一次申请已失败）。 */
  attemptedCycle: number | null;
  /** 连续失败次数：端口确认登记（成功）时清零。 */
  failedAttempts: number;
  /** 最近一次申请的时间戳（毫秒）；0 = 从未申请。 */
  lastAttemptAt: number;
  /** 上一次观察时该 Source 的端口是否已登记；用于识别同一周期内的端口释放。 */
  portRegistered: boolean;
  /** 端口首次被观察到已登记的时间（毫秒）；0 = 从未登记。用于判断「稳定登记」。 */
  portRegisteredAt: number;
  /** 同一在线周期内连续「端口登记后随即失效」的次数；稳定登记后清零。 */
  portReleaseAttempts: number;
  /**
   * 连续观察到「management 快照明确 offline 且端口仍存活」的次数。
   *
   * Bug 原因：旧实现只要快照投影短暂落后（profile→sourceServerId 绑定还没同步）就判定
   * offline 并立刻释放端口，会把刚建立且仍可用的端口误杀，也会让首次申请被 offline 拦住。
   * 修复依据：至少连续两次明确 offline，且释放前再用最新快照复核一次，才允许释放。
   */
  offlineObservations: number;
  /**
   * 自动申请已放弃：连续失败或端口抖动达到上限后不再自行重发。
   *
   * 放弃态必须在 UI 上显式提示；设备掉线重连（新在线周期）、端口成功登记、切换设备
   * 或用户手动重试都会重置，避免「每 ≤30s 无限重发 IPC」和静默卡死两种极端。
   */
  exhausted: boolean;
  /**
   * 下次允许申请的时间戳（毫秒）。
   *
   * 端口释放后的最小间隔必须跨 effect 重跑仍然生效；只依赖 `lastAttemptAt` 的 elapsed
   * 判断会被「无关快照变化触发的重跑」绕过，重新退化成立即重发。
   */
  retryNotBefore: number;
}

export const SOURCE_SETTINGS_ATTACHMENT_RETRY_BASE_DELAY_MS = 2_000;
export const SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_DELAY_MS = 30_000;
/**
 * 连续自动重试上限：设备仍被选中、快照也不显示 offline（例如 management 认为 online
 * 但 Host 一直拒绝 attachment）时，仅靠指数退避会每 ≤30s 无限重发 IPC。达到上限后
 * 停止自动重试，等重选设备/端口成功登记等新事实再重新计数。
 */
export const SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_ATTEMPTS = 6;
/**
 * 端口登记后存活多久才算「稳定成功」：低于该时长的释放（包括端口桥心跳探测发现的
 * 静默死端口）按连续抖动退避；超过则视为一次正常释放并重新计数。
 *
 * 必须严格大于端口桥判定静默死端口的最长耗时，否则每次静默死亡都会被当成稳定登记，
 * `portReleaseAttempts` 每次清零，「连续 N 次抖动即放弃」的上限永远触发不到，退化成
 * 无界重申请。按桥的探测节奏推算（15s 间隔、10s 超时、连续 3 次失败才判死）：登记后
 * 最坏情况是首个探测成功、随即静默死亡，再经历 3 个探测周期，共 4×15s + 10s = 70s
 * 才能观察到释放。取 90s 给定时器/渲染调度留 20s 余量；桥改节奏时下方守卫会失败提醒。
 */
export const SOURCE_SETTINGS_ATTACHMENT_STABLE_PORT_MS = 90_000;
/**
 * 端口释放后重新申请的最小间隔。
 *
 * Bug 原因：释放分支清零失败计数后按「释放次数 = 0」计算退避，第一次释放的退避为 0，
 * 形成 release → emit → effect → request → register → close 的无延迟自激循环。
 * 修复依据：释放驱动的重申请至少等一个基础退避，并由 `retryNotBefore` 跨 effect 重跑兜底。
 */
export const SOURCE_SETTINGS_ATTACHMENT_RELEASE_MIN_INTERVAL_MS =
  SOURCE_SETTINGS_ATTACHMENT_RETRY_BASE_DELAY_MS;
/**
 * 第一次明确 offline 到「释放前复核」之间的间隔：给 management 快照追上 Host 状态的时间。
 * 复核使用 `getSnapshot()` 重新读一次最新快照，不把陈旧投影当成释放依据。
 */
export const SOURCE_SETTINGS_ATTACHMENT_OFFLINE_CONFIRM_DELAY_MS = 2_000;

/** 失败退避时长：2s 起，按连续失败次数指数增长，封顶 30s。 */
export function resolveSourceSettingsAttachmentRetryDelayMs(failedAttempts: number): number {
  if (failedAttempts <= 0) return 0;
  return Math.min(
    SOURCE_SETTINGS_ATTACHMENT_RETRY_BASE_DELAY_MS * 2 ** (Math.min(failedAttempts, 8) - 1),
    SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_DELAY_MS,
  );
}

/** 申请回执的端口登记结论。 */
export type SourceSettingsAttachmentReceiptOutcome = "registered" | "unregistered" | "incomplete";

/**
 * 申请回执只代表 Host 接受并投递了 attachment，不等于 renderer 已登记端口。
 *
 * Bug 原因：旧成功回调直接把回执当成功清掉退避和定时器，端口消息丢失（或登记的是不完整
 * 服务集）时 `attemptedCycle` 已占住本周期且没有后续触发，页面永远停在 unavailable。
 * 修复依据：回执后必须校验注册表条目与六个分区依赖的服务集合，未登记按失败路径处理。
 */
export function resolveSourceSettingsAttachmentReceiptOutcome(
  services: IServiceAccessor | undefined,
): SourceSettingsAttachmentReceiptOutcome {
  if (!services) return "unregistered";
  return resolveSettingsSourceCapabilityServices(services) ? "registered" : "incomplete";
}

/**
 * 记录一次申请失败（含「回执成功但端口未登记」）。
 *
 * 返回 `exhausted = true` 时调用方必须停止安排定时器，并把放弃态显示到 UI；否则按
 * `retryAfterMs` 安排一次可取消的定时重试。
 */
export function recordSourceSettingsAttachmentFailure(params: {
  tracker: SourceSettingsAttachmentRetryTracker;
}): {
  tracker: SourceSettingsAttachmentRetryTracker;
  failedAttempts: number;
  exhausted: boolean;
  retryAfterMs: number;
} {
  const tracker = params.tracker;
  tracker.failedAttempts += 1;
  tracker.attemptedCycle = null;
  tracker.retryNotBefore = 0;
  if (tracker.failedAttempts >= SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_ATTEMPTS) {
    tracker.exhausted = true;
    return {
      tracker,
      failedAttempts: tracker.failedAttempts,
      exhausted: true,
      retryAfterMs: 0,
    };
  }
  return {
    tracker,
    failedAttempts: tracker.failedAttempts,
    exhausted: false,
    retryAfterMs: resolveSourceSettingsAttachmentRetryDelayMs(tracker.failedAttempts),
  };
}

export type SourceSettingsAttachmentOfflineReleaseAction = "keep" | "confirm" | "release";

/**
 * 决定「management 快照明确 offline 且端口仍存活」时是否释放端口。
 *
 * 规则：第一次明确 offline 只记录观察（confirm，调用方等一个确认间隔后再跑一次）；
 * 第二次仍明确 offline 才返回 release（调用方还须用最新 `getSnapshot()` 复核）。
 * 端口不在、快照未知或在线时一律 keep 并清零观察计数。
 */
export function decideSourceSettingsAttachmentOfflineRelease(params: {
  previous: SourceSettingsAttachmentRetryTracker | undefined;
  sourceServerId: string;
  online: boolean | undefined;
  portRegistered: boolean;
}): {
  action: SourceSettingsAttachmentOfflineReleaseAction;
  tracker: SourceSettingsAttachmentRetryTracker;
} {
  const previous =
    params.previous?.sourceServerId === params.sourceServerId ? params.previous : undefined;
  const tracker: SourceSettingsAttachmentRetryTracker = previous ?? {
    sourceServerId: params.sourceServerId,
    online: null,
    cycle: 0,
    attemptedCycle: null,
    failedAttempts: 0,
    lastAttemptAt: 0,
    portRegistered: false,
    portRegisteredAt: 0,
    portReleaseAttempts: 0,
    offlineObservations: 0,
    exhausted: false,
    retryNotBefore: 0,
  };
  if (params.online !== false || !params.portRegistered) {
    tracker.offlineObservations = 0;
    return { action: "keep", tracker };
  }
  tracker.offlineObservations += 1;
  if (tracker.offlineObservations < 2) {
    return { action: "confirm", tracker };
  }
  tracker.offlineObservations = 0;
  return { action: "release", tracker };
}

export type SourceSettingsAttachmentAttemptReason =
  | "initial"
  | "retry"
  | "reconnect"
  | "port-released"
  | "port-registered"
  | "offline"
  | "same-cycle"
  | "backoff"
  /** 自动重试次数用尽：不再自行重发，等用户/状态事件重新触发。 */
  | "exhausted";

export interface SourceSettingsAttachmentAttemptDecision {
  request: boolean;
  reason: SourceSettingsAttachmentAttemptReason;
  /** 退避剩余时长（毫秒）；仅 reason === "backoff" 时非零。 */
  retryAfterMs: number;
  /** 本次观察后的追踪状态，调用方负责写回。 */
  tracker: SourceSettingsAttachmentRetryTracker;
}

/**
 * 决定本次 effect 运行是否要申请 Source 设置 attachment。
 *
 * 触发条件（唯一口径）：
 * 1. 首次选中/挂载（cycle 0，尚无申请记录）；
 * 2. 观察到「离线 → 在线」进入新在线周期，且该周期还没申请过；
 * 3. 前一次申请失败（调用方清空 attemptedCycle），退避到期后继续；
 * 4. 已登记的端口在同一在线周期内被释放（Host detach / 端口失效）；连续「登记后
 *    随即失效」的抖动按次数退避，达到上限后不再自动申请（exhausted）。
 * 其它情况（端口已登记、已知离线、同一周期、退避未到）一律不申请。
 */
export function decideSourceSettingsAttachmentAttempt(params: {
  previous: SourceSettingsAttachmentRetryTracker | undefined;
  sourceServerId: string;
  /** management 快照的在线投影；undefined = 快照未就绪，保持旧行为允许申请。 */
  online: boolean | undefined;
  /** 该 Source 的 attachment 端口是否已登记。 */
  portRegistered: boolean;
  now: number;
}): SourceSettingsAttachmentAttemptDecision {
  const online = params.online ?? null;
  const previous =
    params.previous?.sourceServerId === params.sourceServerId ? params.previous : undefined;
  const reconnected = previous?.online === false && online === true;
  // 快照从「未就绪」变成明确在线也是新的外部事实：启动阶段若已把重试次数用尽，
  // 不能因为 previous.online 是 null 就一直卡在放弃态。
  const firstObservedOnline = previous !== undefined && previous.online === null && online === true;
  const cycle = previous ? previous.cycle + (reconnected ? 1 : 0) : 0;
  const tracker: SourceSettingsAttachmentRetryTracker = {
    sourceServerId: params.sourceServerId,
    online,
    cycle,
    attemptedCycle: previous?.attemptedCycle ?? null,
    failedAttempts: previous?.failedAttempts ?? 0,
    lastAttemptAt: previous?.lastAttemptAt ?? 0,
    portRegistered: previous?.portRegistered ?? false,
    portRegisteredAt: previous?.portRegisteredAt ?? 0,
    // 离线→在线是新的在线周期，端口抖动计数从零开始；否则连续抖动会跨周期累计。
    portReleaseAttempts: reconnected ? 0 : (previous?.portReleaseAttempts ?? 0),
    offlineObservations: online === false ? (previous?.offlineObservations ?? 0) : 0,
    // 设备状态变化（离线→在线 / 快照就绪后首次在线）是新的外部事实：放弃态必须重置。
    exhausted: reconnected || firstObservedOnline ? false : (previous?.exhausted ?? false),
    retryNotBefore: previous?.retryNotBefore ?? 0,
  };
  // 首次选中/挂载即申请：不依赖 management 的 online 投影（快照可能落后或尚未就绪），
  // 失败由退避与次数上限兜底。只有「已经申请过」的周期才按明确 offline 拦截。
  const isFirstAttempt = !previous || previous.lastAttemptAt === 0;
  const skip = (
    reason: SourceSettingsAttachmentAttemptReason,
    retryAfterMs = 0,
  ): SourceSettingsAttachmentAttemptDecision => ({
    request: false,
    reason,
    retryAfterMs,
    tracker,
  });
  const requestIfDue = (
    reason: SourceSettingsAttachmentAttemptReason,
  ): SourceSettingsAttachmentAttemptDecision => {
    // 放弃态优先级最高：即使退避时间已过也不再自行重发。
    if (tracker.exhausted) return skip("exhausted");
    // 端口释放后的最小间隔跨 effect 重跑生效（无关快照变化不能绕过它）。
    if (tracker.retryNotBefore > params.now) {
      return skip("backoff", tracker.retryNotBefore - params.now);
    }
    const backoffDelayMs = resolveSourceSettingsAttachmentRetryDelayMs(tracker.failedAttempts);
    const elapsedMs = params.now - tracker.lastAttemptAt;
    if (backoffDelayMs > 0 && elapsedMs < backoffDelayMs) {
      return skip("backoff", backoffDelayMs - elapsedMs);
    }
    tracker.attemptedCycle = tracker.cycle;
    tracker.lastAttemptAt = params.now;
    tracker.retryNotBefore = 0;
    return { request: true, reason, retryAfterMs: 0, tracker };
  };

  if (params.portRegistered) {
    // 已成功登记的端口不改动；后续即使掉线重连也以端口事实为准。
    // 端口登记 = 申请成功：清零失败计数并从放弃态恢复（迟到端口也能让自动链路自愈）。
    if (!tracker.portRegistered) tracker.portRegisteredAt = params.now;
    tracker.portRegistered = true;
    tracker.attemptedCycle = tracker.cycle;
    tracker.failedAttempts = 0;
    tracker.offlineObservations = 0;
    tracker.retryNotBefore = 0;
    tracker.exhausted = false;
    return skip("port-registered");
  }
  if (tracker.portRegistered) {
    // 端口曾登记、现在不在了：Host 在同一在线周期里 detach（离线/删除/换代）也必须能
    // 重新申请，不能停在 `attemptedCycle === cycle` 上。
    const registeredForMs =
      tracker.portRegisteredAt > 0
        ? params.now - tracker.portRegisteredAt
        : params.now - tracker.lastAttemptAt;
    tracker.portRegistered = false;
    tracker.portRegisteredAt = 0;
    tracker.attemptedCycle = null;
    if (params.online === false) return skip("offline");
    // 端口稳定登记过说明上一次申请真的可用：这是正常释放，重新按首次释放计数。
    if (registeredForMs >= SOURCE_SETTINGS_ATTACHMENT_STABLE_PORT_MS) {
      tracker.portReleaseAttempts = 0;
    }
    // 次数兜底：抖动计数与累计失败计数任一到达上限都不再自动重发。
    if (
      tracker.portReleaseAttempts >= SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_ATTEMPTS ||
      tracker.failedAttempts >= SOURCE_SETTINGS_ATTACHMENT_RETRY_MAX_ATTEMPTS
    ) {
      tracker.exhausted = true;
      return skip("exhausted");
    }
    tracker.portReleaseAttempts += 1;
    // Bug 原因：旧实现先清零失败计数再按「释放次数 = 0」算退避，第一次释放的退避为 0，
    // 形成 release→emit→effect→request→register→close 的无延迟自激循环。
    // 修复依据：释放驱动的重申请至少等待一个基础退避，并由 retryNotBefore 跨重跑兜底。
    const releaseDelayMs = Math.max(
      resolveSourceSettingsAttachmentRetryDelayMs(
        Math.max(tracker.portReleaseAttempts, tracker.failedAttempts),
      ),
      SOURCE_SETTINGS_ATTACHMENT_RELEASE_MIN_INTERVAL_MS,
    );
    tracker.retryNotBefore = params.now + releaseDelayMs;
    const elapsedMs = params.now - tracker.lastAttemptAt;
    if (elapsedMs < releaseDelayMs) {
      return skip("backoff", releaseDelayMs - elapsedMs);
    }
    tracker.attemptedCycle = tracker.cycle;
    tracker.lastAttemptAt = params.now;
    tracker.retryNotBefore = 0;
    return { request: true, reason: "port-released", retryAfterMs: 0, tracker };
  }
  if (params.online === false && !isFirstAttempt) return skip("offline");
  if (tracker.attemptedCycle === tracker.cycle) return skip("same-cycle");

  // 新在线周期的首次成功申请记 reconnect（即使它被退避推迟到本周期内稍后重试）；
  // 同周期内的失败重试记 retry，便于测试/日志区分「重连」与「退避重试」。
  const reason: SourceSettingsAttachmentAttemptReason =
    reconnected || tracker.cycle > 0
      ? "reconnect"
      : tracker.lastAttemptAt > 0
        ? "retry"
        : "initial";
  return requestIfDue(reason);
}

export function SettingsPage({
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
  windowsWindowControlsRightPaddingPx: _windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onCreateTask,

  allowOpenWorkspace: _allowOpenWorkspace = true,
  onOpenRemoteConnection,
  onConnectRemoteProfile,
  onOpenRemoteDeviceProject,
}: {
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isMacDesktop?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  allowOpenWorkspace?: boolean;
  /** 设备管理「新建连接」：打开 Root 的全局远程连接向导。 */
  onOpenRemoteConnection?: () => void;
  /** 设备管理「连接/重试/安装」：Root 用已保存线路预填向导，成功时回传 management 快照。 */
  onConnectRemoteProfile?: (profileId: string) => Promise<SourceServerManagementSnapshot | void>;
  /** 设备管理「查看项目」：Root 连接（或复用已打开 tab）后打开设备上的项目路径。 */
  onOpenRemoteDeviceProject?: (
    sourceServerId: string,
    path: string,
    profileId?: string,
  ) => Promise<void>;
}) {
  const { intl, localePreference, setLocalePreference } = useZCodeIntl();
  const { settingsSectionGroups, settingsSections } = useMemo(
    () =>
      createSettingsPageConfig({
        isDesktop: Boolean(isDesktop),
        isMacDesktop: Boolean(isMacDesktop),
        isWindowsDesktop: Boolean(isWindowsDesktop),
      }),
    [isDesktop, isMacDesktop, isWindowsDesktop],
  );
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const platform = usePlatform();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
    const initialSection = consumeInitialSettingsSection("general");
    const visibleInitialSection = resolveSettingsSectionForPlatform(
      initialSection,
      settingsSections,
    );
    // 设置页首次挂载时也要写入当前落点。否则用户直接打开再退出，
    // 下一次仍可能因为没有偏好记录而回到旧默认入口。
    writeLastSettingsSectionPreference(visibleInitialSection);
    return visibleInitialSection;
  });
  const [pluginTab, setPluginTab] = useState(() => consumePendingSettingsPluginTab());
  const [pluginNavigationOrigin, setPluginNavigationOrigin] = useState(() =>
    consumePendingSettingsPluginOrigin(),
  );
  const [pluginScopeKey, setPluginScopeKey] = useState(() =>
    consumePendingSettingsPluginScopeKey(),
  );
  const [settingsSectionNavigationVersion, setSettingsSectionNavigationVersion] = useState(0);
  // 设备卡定位（backlog-sweep Step 9/10）：分区跳转带 Source 维度时直达该设备卡；
  // 首次挂载从 sessionStorage 消费一次（已打开页面由同一导航事件直接接收）。
  const [targetSourceServerId, setTargetSourceServerId] = useState<string | undefined>(() =>
    consumePendingSettingsSourceServerId(),
  );
  const [targetSourceServerDetails, setTargetSourceServerDetails] = useState<boolean>(() =>
    consumePendingSettingsSourceServerDetails(),
  );
  useEffect(() => {
    // React Strict Mode 会双执行 state initializer；来源和 scopeKey 都在挂载完成后再清理，
    // Marketplace 只返回 User 已安装视图；Workspace 仍通过设置页自身的配置层切换进入。
    clearPendingSettingsPluginOrigin();
    clearPendingSettingsPluginScopeKey();
  }, []);
  const [settingsBreadcrumbItems, setSettingsBreadcrumbItems] = useState<
    readonly SettingsBreadcrumbItem[]
  >([]);
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  const theme = useZCodeStore((state) => state.theme);
  const setTheme = useZCodeStore((state) => state.setTheme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const setCodePreviewSettings = useZCodeStore((state) => state.setCodePreviewSettings);
  const uiFontSizePx = useZCodeStore((state) => state.uiFontSizePx);
  const setUiFontSizePx = useZCodeStore((state) => state.setUiFontSizePx);
  const notificationEnabled = useZCodeStore((state) => state.notificationEnabled);
  const setNotificationEnabled = useZCodeStore((state) => state.setNotificationEnabled);
  const notificationSoundEnabled = useZCodeStore((state) => state.notificationSoundEnabled);
  const setNotificationSoundEnabled = useZCodeStore((state) => state.setNotificationSoundEnabled);
  // FORK（D-4）：Coding Plan 使用统计（账号来源、权益、团队商品、tab 切换、
  // 购买入口）随订阅面整删。usage 分区只剩 App Usage（本地 agent 数据库统计）。
  const usageActiveTab = "app" as const;
  const checkingUsageCodingPlanTab = false;
  const showUsageCodingPlanTab = false;
  const usageProviderSettingsLoading = false;
  const usageSubscribedTeamProducts: never[] = [];
  const setNewUserOnboardingOpen = useZCodeStore((state) => state.setNewUserOnboardingOpen);
  const requestOnboardingDialog = () => setNewUserOnboardingOpen(true);
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const [pendingModelProviderTarget, setPendingModelProviderTarget] = useState<
    SettingsModelProviderTarget | undefined
  >(() => initialModelProviderTarget);
  const setActiveSettingsSection = useCallback(
    (section: SettingsSectionId, fallbackSection: SettingsSectionId = activeSection) => {
      const resolvedSection = resolveSettingsSection(section, fallbackSection);
      setActiveSection(resolvedSection);
      writeLastSettingsSectionPreference(resolvedSection);
    },
    [activeSection],
  );
  const setUsageActiveTab = useCallback((_tab: unknown) => {}, []);
  const handleOpenModelProviderSettings = useCallback(() => {
    setActiveSettingsSection("modelProvider");
  }, [setActiveSettingsSection]);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const activateTab = useTabStore((state) => state.activateTab);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  // Settings 打开后 activeTab 会变成 settings，本地反查 activeTab 读 identity 会稳定丢失。
  // 这里改为读取 tabStore 维护的“最近激活 workspace identity”，让插件管理继续命中正确远端。
  const activeWorkspaceIdentity = useTabStore(
    (state) => state.activeWorkspaceIdentity ?? undefined,
  );
  const activeWorkspaceTab = useTabStore((state) => {
    const workspacePath = state.activeWorkspacePath;
    if (!workspacePath) {
      return null;
    }
    const workspaceIdentity = state.activeWorkspaceIdentity ?? undefined;
    const matchingTabs = state.tabs
      .filter(isWorkspaceTab)
      .filter((tab) => tab.workspacePath === workspacePath);
    return (
      matchingTabs.find((tab) =>
        workspaceIdentity ? tab.workspaceIdentity === workspaceIdentity : !tab.workspaceIdentity,
      ) ??
      matchingTabs[0] ??
      null
    );
  });
  const localModelProviderConnectivityWorkspacePath = useMemo(
    () =>
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath,
        activeWorkspaceIdentity,
        activeWorkspaceTab,
        workspaceTabs,
      }),
    [activeWorkspaceIdentity, activeWorkspacePath, activeWorkspaceTab, workspaceTabs],
  );
  const isRemoteModelProviderWorkspace = Boolean(
    activeWorkspaceIdentity?.trim() ||
    activeWorkspaceTab?.remoteSessionId?.trim() ||
    activeWorkspaceTab?.remoteTarget,
  );
  const selectDirectory = useSelectDirectory();
  const services = useServices();
  const localHostServices = useBaseWorkspaceServices();
  const { settings: sharedSettings, update: updateSharedSettings } = useSettings();
  const deviceManagement = localHostServices.sourceServerManagementService;
  // 「在侧边栏中显示」需要把 tab 归属回 Source Server（legacy alias 依赖 Directory 历史）；
  // 与面板各自订阅同一 management 实例，避免把快照再抬成跨层状态。
  const { snapshot: deviceManagementSnapshot } =
    useSourceServerManagementSnapshot(deviceManagement);
  // 「按设备编辑设置」入口（本批缺陷修复）：Source 设置面的 scope 以前没有任何生产调用方，
  // 按 Source 收窄的 section 的 settingsSourceServerId 永远是 undefined。选择器直接投影
  // management 快照（设备列表的唯一事实源），不新建第二份设备状态。
  const sourceServers = deviceManagementSnapshot?.servers ?? [];
  const [settingsSourceSelection, setSettingsSourceSelection] = useState(SETTINGS_SOURCE_ALL);
  const selectedSettingsSourceServerId =
    settingsSourceSelection === SETTINGS_SOURCE_ALL
      ? undefined
      : settingsSourceSelection === SETTINGS_SOURCE_LOCAL
        ? null
        : settingsSourceSelection;
  useEffect(() => {
    if (
      settingsSourceSelection === SETTINGS_SOURCE_ALL ||
      settingsSourceSelection === SETTINGS_SOURCE_LOCAL
    ) {
      return;
    }
    // 设备被删除/换代后回落默认：按已不存在的 Source 过滤会把 scope 菜单清空，
    // 看起来像「点击没反应」。
    if (!sourceServers.some((server) => server.sourceServerId === settingsSourceSelection)) {
      setSettingsSourceSelection(SETTINGS_SOURCE_ALL);
    }
  }, [settingsSourceSelection, sourceServers]);
  // 选中 Source 时申请该设备「无 workspace」的配置 attachment（选中变化/挂载都走这里）。
  // 平台未提供该 IPC 时保持「已连接 workspace 当锚点」的既有真实链路；失败只记 warn，
  // 页面按 unavailable 空态显示，绝不静默回退本机服务。
  const sourceAttachmentRequest = useMemo(
    () => resolveSourceSettingsAttachmentRequest(platform),
    [platform],
  );
  const sourceAttachmentRetryTrackerRef = useRef<SourceSettingsAttachmentRetryTracker | null>(null);
  // 退避/失败都必须有一个后续触发：effect 只随快照/端口变化运行，失败后若没有新事件，
  // 同一设备永远不会再申请。这里用一次性定时器（非轮询）在到期后重跑同一决策；
  // 延时由 resolveSourceSettingsAttachmentRetryDelayMs 封顶 30s，effect 清理（切设备、
  // 端口登记、组件卸载）统一 clearTimeout。
  const sourceAttachmentRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sourceAttachmentRetryTick, setSourceAttachmentRetryTick] = useState(0);
  // 申请代际：并发/重复 effect 重跑可能共享同一个 ensure promise（注册表去重），
  // 只允许最后一代申请的回执记成功/失败，避免一次请求被两个 handler 各记一次失败。
  const sourceAttachmentAttemptTokenRef = useRef(0);
  // 自动重试已放弃时显式记下设备 id：达到上限必须在 UI 上可见，不能静默停在 unavailable。
  const [sourceAttachmentExhaustedFor, setSourceAttachmentExhaustedFor] = useState<string | null>(
    null,
  );
  // 「释放前再确认」用最新 management 快照复核过的那一条陈旧快照：记住后不再对同一条
  // 快照重复复核，避免「快照持续落后 → 每轮 effect 都发一次 getSnapshot」变成轮询。
  const sourceAttachmentRevalidatedSnapshotRef = useRef<{
    snapshot: SourceServerManagementSnapshot;
    sourceServerId: string;
  } | null>(null);
  // 申请是异步的：卸载后才 reject 的请求不得再安排定时器（否则会在已卸载页面里 setState）。
  const sourceAttachmentMountedRef = useRef(true);
  useEffect(() => {
    sourceAttachmentMountedRef.current = true;
    return () => {
      sourceAttachmentMountedRef.current = false;
    };
  }, []);
  const clearSourceAttachmentRetryTimer = useCallback(() => {
    if (sourceAttachmentRetryTimerRef.current !== null) {
      clearTimeout(sourceAttachmentRetryTimerRef.current);
      sourceAttachmentRetryTimerRef.current = null;
    }
  }, []);
  const scheduleSourceAttachmentRetry = useCallback(
    (delayMs: number) => {
      clearSourceAttachmentRetryTimer();
      sourceAttachmentRetryTimerRef.current = setTimeout(() => {
        sourceAttachmentRetryTimerRef.current = null;
        setSourceAttachmentRetryTick((tick) => tick + 1);
      }, delayMs);
    },
    [clearSourceAttachmentRetryTimer],
  );
  // 放弃态只从 tracker 这一份事实派生，避免再维护第二份「是否放弃」状态。
  const syncSourceAttachmentExhausted = useCallback(
    (tracker: SourceSettingsAttachmentRetryTracker | null) => {
      const exhaustedFor = tracker?.exhausted ? tracker.sourceServerId : null;
      setSourceAttachmentExhaustedFor((current) =>
        current === exhaustedFor ? current : exhaustedFor,
      );
    },
    [],
  );
  // 放弃态的手动出口：用户点「重试」视为新的申请意图，清零退避/抖动/放弃标记后立即重跑。
  const handleRetrySourceAttachment = useCallback(() => {
    const tracker = sourceAttachmentRetryTrackerRef.current;
    if (tracker) {
      tracker.failedAttempts = 0;
      tracker.portReleaseAttempts = 0;
      tracker.offlineObservations = 0;
      tracker.exhausted = false;
      tracker.attemptedCycle = null;
      tracker.lastAttemptAt = 0;
      tracker.retryNotBefore = 0;
    }
    setSourceAttachmentExhaustedFor(null);
    setSourceAttachmentRetryTick((tick) => tick + 1);
  }, []);
  // 订阅附件端口注册表：端口登记/释放都要参与重试判定（尤其掉线时端口先释放、快照后更新），
  // 不能只在快照事件里读一次，否则重连瞬间可能看到已失效的旧端口而漏掉重申请。
  const sourceSettingsPortServices = useSourceSettingsServices(
    selectedSettingsSourceServerId ?? undefined,
  );
  // 注册表版本保证「登记后同批失效」也能让 effect 重跑：settings 对象本身可能回到
  // undefined（与上一次渲染相同），React 不会因此重算。
  const sourceSettingsPortServicesVersion = useSourceSettingsServicesVersion();
  // 与上面的 services 同一渲染快照读出的 attachment id：释放时带上它，慢到的旧信号只会
  // 命中自己那一代，不会把 render 之后才登记的新一代附件一并 dispose。
  const sourceSettingsPortAttachmentId = useSourceSettingsAttachmentId(
    selectedSettingsSourceServerId ?? undefined,
  );
  useEffect(() => {
    // 本轮重算接管后续触发权：上一轮安排的定时器必须先撤销（卸载时由本 effect 的
    // cleanup 统一清理），避免切设备/端口已恢复后旧定时器再触发一次申请。
    clearSourceAttachmentRetryTimer();
    if (!selectedSettingsSourceServerId || !sourceAttachmentRequest) {
      // 回到「全部/本机」或平台没有该能力：清空追踪，再次选中同一设备视为一次新的
      // 手动申请，不被上一条在线周期的幂等键拦住。
      sourceAttachmentRetryTrackerRef.current = null;
      // 作废迟到的申请回执：切回「全部/本机」后不得再往已清空的追踪里记成功/失败。
      sourceAttachmentAttemptTokenRef.current += 1;
      setSourceAttachmentExhaustedFor(null);
      return clearSourceAttachmentRetryTimer;
    }
    const sourceServerId = selectedSettingsSourceServerId;
    const snapshot = deviceManagementSnapshot;
    const revalidatedSnapshot = sourceAttachmentRevalidatedSnapshotRef.current;
    const revalidatedOnline =
      snapshot !== null &&
      revalidatedSnapshot?.sourceServerId === sourceServerId &&
      revalidatedSnapshot.snapshot === snapshot;
    const online = snapshot
      ? revalidatedOnline || isSettingsSourceOnline(snapshot, sourceServerId)
      : undefined;
    // 端口「条目存在」不等于「设置面可用」：服务集缺少六个分区依赖的必需通道时，
    // 下面的 ensure 会被存活条目短路（只重试不重新申请）。先摘掉不完整条目并解除
    // 本周期幂等键，让决策按「端口未登记」重新申请；同一 Source 的新端口仍可接替。
    if (
      sourceSettingsPortServices !== undefined &&
      resolveSourceSettingsAttachmentReceiptOutcome(sourceSettingsPortServices) !== "registered"
    ) {
      releaseSourceSettingsServices(sourceServerId, sourceSettingsPortAttachmentId);
      const staleTracker = sourceAttachmentRetryTrackerRef.current;
      if (staleTracker?.sourceServerId === sourceServerId) staleTracker.attemptedCycle = null;
    }
    const portRegistered =
      sourceSettingsPortServices !== undefined &&
      resolveSourceSettingsAttachmentReceiptOutcome(sourceSettingsPortServices) === "registered";

    // 1) 释放判定：只有连续两次明确 offline（且释放前最新快照复核仍 offline）才释放。
    // Bug 原因：只按快照投影的单次 online=false 就释放，会把刚建立且仍可用的端口误杀；
    // 首次申请也被 online 判定拦住。修复依据见 decideSourceSettingsAttachmentOfflineRelease。
    const releaseDecision = decideSourceSettingsAttachmentOfflineRelease({
      previous: sourceAttachmentRetryTrackerRef.current ?? undefined,
      sourceServerId,
      online,
      portRegistered,
    });
    sourceAttachmentRetryTrackerRef.current = releaseDecision.tracker;
    if (portRegistered) {
      // 端口已登记 = 申请成功：即时退出放弃态，避免「端口可用但还挂着失败提示」。
      releaseDecision.tracker.failedAttempts = 0;
      releaseDecision.tracker.exhausted = false;
    }
    syncSourceAttachmentExhausted(releaseDecision.tracker);
    if (releaseDecision.action === "confirm") {
      // 第一次明确 offline：先保留端口，等一个确认间隔后再观察一次（快照可能短暂落后）。
      scheduleSourceAttachmentRetry(SOURCE_SETTINGS_ATTACHMENT_OFFLINE_CONFIRM_DELAY_MS);
      return clearSourceAttachmentRetryTimer;
    }
    if (releaseDecision.action === "release") {
      const tracker = releaseDecision.tracker;
      // 第二次观察仍 offline：释放前再向 management 读一次最新快照，避免用陈旧投影误杀端口。
      let confirmSnapshot: Promise<SourceServerManagementSnapshot> | undefined;
      if (deviceManagement) {
        try {
          confirmSnapshot = deviceManagement.getSnapshot();
        } catch (error) {
          logger.warn("[settings] 无法确认 Source 在线状态，保留现有设置端口", error);
        }
      }
      if (!confirmSnapshot) {
        tracker.offlineObservations = 0;
        return clearSourceAttachmentRetryTimer;
      }
      void confirmSnapshot.then(
        (latest) => {
          if (!sourceAttachmentMountedRef.current) return;
          // tracker 身份校验：切设备/重选会换 tracker，迟到的确认不得释放新设备的端口。
          if (sourceAttachmentRetryTrackerRef.current !== tracker) return;
          if (isSettingsSourceOnline(latest, sourceServerId)) {
            // 快照短暂落后：保留仍可用的端口，并记住这条陈旧快照，避免重复复核。
            tracker.offlineObservations = 0;
            if (snapshot) {
              sourceAttachmentRevalidatedSnapshotRef.current = { snapshot, sourceServerId };
            }
            return;
          }
          // 最新快照仍明确 offline：Host 侧 attachment 已不可用，显式释放旧条目。
          releaseSourceSettingsServices(sourceServerId, sourceSettingsPortAttachmentId);
        },
        (error: unknown) => {
          if (!sourceAttachmentMountedRef.current) return;
          if (sourceAttachmentRetryTrackerRef.current !== tracker) return;
          // 复核失败不构成「明确 offline」：保留端口，避免把仍可用的连接误判成离线。
          tracker.offlineObservations = 0;
          logger.warn("[settings] 确认 Source 离线状态失败，保留现有设置端口", error);
        },
      );
      return clearSourceAttachmentRetryTimer;
    }

    // 2) 申请判定：首次选中即申请（不依赖 online），失败走退避与次数上限。
    const decision = decideSourceSettingsAttachmentAttempt({
      previous: releaseDecision.tracker,
      sourceServerId,
      online,
      portRegistered,
      now: Date.now(),
    });
    sourceAttachmentRetryTrackerRef.current = decision.tracker;
    syncSourceAttachmentExhausted(decision.tracker);
    if (!decision.request) {
      if (decision.reason === "backoff" && decision.retryAfterMs > 0) {
        scheduleSourceAttachmentRetry(decision.retryAfterMs);
      }
      return clearSourceAttachmentRetryTimer;
    }

    const applyFailure = (error: unknown): void => {
      // 失败：解除同在线周期的幂等键（attemptedCycle = null），否则退避到期后仍会被
      // same-cycle 拦住；随后按指数退避安排一次性定时重试。设备重新在线也会由快照变化
      // 再跑决策，所以定时器只是「没有新事件」时的兜底；连续失败达到上限后停止，
      // 并把放弃态交给 UI 显式提示（不静默）。
      // 已切到别的设备时不再记这次失败，避免把上一台设备的回执算到当前设备头上。
      if (!sourceAttachmentMountedRef.current) return;
      const tracker = sourceAttachmentRetryTrackerRef.current;
      if (tracker?.sourceServerId !== sourceServerId) return;
      const outcome = recordSourceSettingsAttachmentFailure({ tracker });
      if (outcome.exhausted) {
        logger.warn("[settings] Source 设置 attachment 连续失败，停止自动重试", error);
        clearSourceAttachmentRetryTimer();
        syncSourceAttachmentExhausted(outcome.tracker);
        return;
      }
      logger.warn("[settings] 请求 Source 设置 attachment 失败，退避后自动重试", error);
      syncSourceAttachmentExhausted(outcome.tracker);
      scheduleSourceAttachmentRetry(outcome.retryAfterMs);
    };

    const attemptToken = sourceAttachmentAttemptTokenRef.current + 1;
    sourceAttachmentAttemptTokenRef.current = attemptToken;
    void ensureSourceSettingsServices(selectedSettingsSourceServerId, sourceAttachmentRequest).then(
      () => {
        if (sourceAttachmentAttemptTokenRef.current !== attemptToken) return;
        if (!sourceAttachmentMountedRef.current) return;
        const tracker = sourceAttachmentRetryTrackerRef.current;
        if (tracker?.sourceServerId !== sourceServerId) return;
        // IPC 回执 ≠ 端口已登记：端口消息可能丢失，或登记了缺少必需通道的服务集。
        // 旧实现直接清掉退避，此时 attemptedCycle 已占住本周期且没有定时器，页面会
        // 永远停在 unavailable。未登记必须按失败路径继续退避重试。
        const receipt = resolveSourceSettingsAttachmentReceiptOutcome(
          getSourceSettingsServices(sourceServerId),
        );
        if (receipt !== "registered") {
          if (receipt === "incomplete") {
            // 已登记但服务集不完整：对设置面不可用，先摘掉条目，避免下次 ensure 被
            // 「存活条目」短路成空转（只重试不重新申请）。
            releaseSourceSettingsServices(sourceServerId, sourceSettingsPortAttachmentId);
          }
          logger.warn(
            "[settings] Source 设置 attachment 回执后端口未登记，按失败退避重试",
            receipt,
          );
          applyFailure(receipt);
          return;
        }
        if (!tracker.portRegistered) tracker.portRegisteredAt = Date.now();
        tracker.portRegistered = true;
        tracker.failedAttempts = 0;
        tracker.offlineObservations = 0;
        tracker.retryNotBefore = 0;
        // 不重置 portReleaseAttempts：端口刚登记又释放时仍要累计抖动次数，否则
        // 「登记→释放」循环会不断清零计数，次数上限永远触发不了。
        tracker.exhausted = false;
        clearSourceAttachmentRetryTimer();
        syncSourceAttachmentExhausted(tracker);
      },
      (error: unknown) => {
        if (sourceAttachmentAttemptTokenRef.current !== attemptToken) return;
        applyFailure(error);
      },
    );
    return clearSourceAttachmentRetryTimer;
  }, [
    clearSourceAttachmentRetryTimer,
    deviceManagement,
    deviceManagementSnapshot,
    scheduleSourceAttachmentRetry,
    selectedSettingsSourceServerId,
    sourceAttachmentRequest,
    sourceAttachmentRetryTick,
    sourceSettingsPortServices,
    sourceSettingsPortServicesVersion,
    syncSourceAttachmentExhausted,
  ]);
  const showSettingsSourceSelect =
    SETTINGS_SOURCE_SCOPED_SECTIONS.has(activeSection) &&
    Boolean(deviceManagement) &&
    sourceServers.length > 0;
  const handleShowDeviceInSidebar = useCallback(
    (sourceServerId: string) => {
      const target = workspaceTabs.find(
        (tab) =>
          getWorkspaceSourceServerId(tab, {
            workspaceHistory: deviceManagementSnapshot?.workspaceHistory,
          }) === sourceServerId,
      );
      // 面板只在存在对应 tab 时渲染该菜单项；这里的迟到点击直接忽略，不新开连接。
      if (!target) return;
      onBack?.();
      activateTab(target.id);
      requestAnimationFrame(() => {
        // 侧栏项目行的身份是 Host 侧 `remote:server:<id>:<path>`，与 tab 的
        // legacy/ssh identity 不同源，必须用同一构造函数比对而不是字符串猜测。
        const hostId = remoteHostIdFromWorkspaceIdentity(
          buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath: "/" }),
        );
        const identity = hostId
          ? buildRemoteHostWorkspaceIdentity(hostId, target.workspacePath)
          : undefined;
        const row = identity
          ? Array.from(
              document.querySelectorAll<HTMLElement>("[data-project-workspace-identity]"),
            ).find((element) => element.dataset.projectWorkspaceIdentity === identity)
          : undefined;
        row?.scrollIntoView({ block: "center" });
        row?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
      });
    },
    [activateTab, deviceManagementSnapshot?.workspaceHistory, onBack, workspaceTabs],
  );
  const handleShowDeviceUpdateDetails = useCallback(
    (sourceServerId: string) => {
      // 更新 toast 可能来自已卸载的面板：写一次性导航意图再拉起设置页，
      // 已挂载页面由同一事件直接定位设备卡详情。
      setPendingSettingsSectionIntent("remoteDevices", {
        sourceServerId,
        sourceServerDetails: true,
      });
      openSettingsTab();
    },
    [openSettingsTab],
  );
  const nativeSearchEnhancementsEnabled = sharedSettings?.nativeSearchEnhancementsEnabled !== false;
  const toolSearchMode = sharedSettings?.toolSearchMode ?? "off";
  const askUserQuestionAutoResolutionEnabled =
    sharedSettings?.askUserQuestionAutoResolutionEnabled !== false;
  const modelIoFullRetentionEnabled = sharedSettings?.modelIoFullRetentionEnabled === true;
  const [dataBaseDir, setDataBaseDir] = useState("");
  const [terminalInheritSystemProfile, setTerminalInheritSystemProfile] = useState(true);
  const [terminalFontFamily, setTerminalFontFamily] = useState("");
  const [integratedTerminalShell, setIntegratedTerminalShell] =
    useState<IntegratedTerminalShellSelection>({ mode: "auto" });
  const [integratedTerminalShellOptions, setIntegratedTerminalShellOptions] = useState<
    IntegratedTerminalShellOption[]
  >([]);
  const [httpProxy, setHttpProxy] = useState("");
  const [httpProxyNoProxy, setHttpProxyNoProxy] = useState("");
  const [httpProxyCaCertPath, setHttpProxyCaCertPath] = useState("");
  const [embeddedBrowserAllowInsecureCertificates, setEmbeddedBrowserAllowInsecureCertificates] =
    useState(false);
  const [taskAutoArchiveEnabled, setTaskAutoArchiveEnabled] = useState(false);
  const [taskAutoArchiveOlderThanDays, setTaskAutoArchiveOlderThanDays] = useState(7);
  const [closeToTrayOnWindows, setCloseToTrayOnWindows] = useState(true);
  const [
    desktopChromiumHardwareAccelerationEnabled,
    setDesktopChromiumHardwareAccelerationEnabled,
  ] = useState(true);
  const [messageStreamShowReasoning, setMessageStreamShowReasoning] = useState(true);
  const [messageStreamShowTodos, setMessageStreamShowTodos] = useState(false);
  const [toolGroupingExploreEnabled, setToolGroupingExploreEnabled] = useState(true);
  const [toolGroupingTerminalEnabled, setToolGroupingTerminalEnabled] = useState(true);
  const [toolGroupingChangesEnabled, setToolGroupingChangesEnabled] = useState(false);
  const [zcodeInteractionBehavior, setZCodeInteractionBehavior] =
    useState<ZCodeInteractionBehavior>("queue");
  const [defaultHomeDir, setDefaultHomeDir] = useState("");
  const [hostPlatform, setHostPlatform] = useState("");

  useEffect(() => {
    if (
      !shouldFallbackSettingsUsageTabToApp({
        activeTab: usageActiveTab === "app" ? "app" : "codingPlan",
        checkingCodingPlanTab: checkingUsageCodingPlanTab,
        loadingModelProviders: usageProviderSettingsLoading,
        showCodingPlanTab: showUsageCodingPlanTab,
      })
    ) {
      return;
    }

    // 剩余额度入口会先写入 Coding Plan tab 意图，再打开设置页。
    // 如果首帧 provider/entitlement 仍在加载就立刻回退，会让“更多”看起来只打开了 App Usage。
    // 这里等数据确认没有套餐后再回退，避免空入口误导用户。
    setUsageActiveTab("app");
  }, [
    checkingUsageCodingPlanTab,
    showUsageCodingPlanTab,
    usageSubscribedTeamProducts.length,
    usageActiveTab,
    usageProviderSettingsLoading,
  ]);

  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        // SettingsPage 已打开时再次从 quickpick 点“个性化/MCP”等设置入口，
        // 页面不会重新挂载，之前写入的 pending section 无人消费，看起来像点击没反应。
        // 这里订阅同窗口跳转意图，立即切换当前设置分区。
        setActiveSettingsSection(section, activeSection);
        // 设置入口是一级路由边界。即使仍落在同一 section，也必须销毁旧的 New/Edit/Detail 子状态。
        setSettingsSectionNavigationVersion((version) => version + 1);
        setTargetSourceServerId(section === "remoteDevices" ? detail?.sourceServerId : undefined);
        setTargetSourceServerDetails(
          section === "remoteDevices" && detail?.sourceServerDetails === true,
        );
        if (section === "usage" && detail?.usageTab) {
          setUsageActiveTab(detail.usageTab);
        }
        if (resolveSettingsSection(section) === "plugin" && detail?.pluginTab) {
          setPluginTab(detail.pluginTab);
          setPluginNavigationOrigin(detail.pluginOrigin);
          setPluginScopeKey(detail.pluginScopeKey);
        } else if (resolveSettingsSection(section) !== "plugin") {
          setPluginNavigationOrigin(undefined);
        }
        if (section === "modelProvider" && detail?.modelProviderId) {
          setPendingModelProviderTarget({
            providerId: detail.modelProviderId,
          });
        }
      }),
    [activeSection, setActiveSettingsSection],
  );

  useEffect(() => {
    services.settingService
      .get()
      .then((settings: AppSettings) => {
        setDataBaseDir(settings.dataBaseDir ?? "");
        setTerminalInheritSystemProfile(settings.terminalInheritSystemProfile ?? true);
        setTerminalFontFamily(settings.terminalFontFamily ?? "");
        setIntegratedTerminalShell(settings.integratedTerminalShell ?? { mode: "auto" });
        setHttpProxy(settings.httpProxy ?? "");
        setHttpProxyNoProxy(settings.httpProxyNoProxy ?? "");
        setHttpProxyCaCertPath(settings.httpProxyCaCertPath ?? "");
        setEmbeddedBrowserAllowInsecureCertificates(
          settings.embeddedBrowserAllowInsecureCertificates ?? false,
        );
        setTaskAutoArchiveEnabled(settings.taskAutoArchiveEnabled ?? false);
        setTaskAutoArchiveOlderThanDays(settings.taskAutoArchiveOlderThanDays ?? 7);
        setCloseToTrayOnWindows(settings.closeToTrayOnWindows ?? true);
        setDesktopChromiumHardwareAccelerationEnabled(
          settings.desktopChromiumHardwareAccelerationEnabled ?? true,
        );
        setMessageStreamShowReasoning(settings.messageStreamShowReasoning ?? true);
        setMessageStreamShowTodos(settings.messageStreamShowTodos ?? false);
        setToolGroupingExploreEnabled(settings.toolGroupingExploreEnabled ?? true);
        setToolGroupingTerminalEnabled(settings.toolGroupingTerminalEnabled ?? true);
        setToolGroupingChangesEnabled(settings.toolGroupingChangesEnabled ?? false);
        setZCodeInteractionBehavior(settings.zcodeInteractionBehavior ?? "queue");
      })
      .catch(() => {});
    // 这里配置的是本地全局设置。远端 workspace 激活时 useServices()
    // 可能已经被替换为远端 host，不能用远端 shell 枚举结果写入本机设置。
    localHostServices.systemService
      .info()
      .then((info) => {
        setDefaultHomeDir(info.homedir);
        setHostPlatform(info.platform);
        if (info.platform !== "win32") {
          setIntegratedTerminalShellOptions([]);
          return;
        }
        void localHostServices.systemService
          .listIntegratedTerminalShells()
          .then(setIntegratedTerminalShellOptions)
          .catch(() => {
            setIntegratedTerminalShellOptions([]);
          });
      })
      .catch(() => {});
  }, [localHostServices.systemService, services.settingService]);

  useEffect(() => {
    if (!sharedSettings) {
      return;
    }
    setMessageStreamShowReasoning(sharedSettings.messageStreamShowReasoning ?? true);
    setMessageStreamShowTodos(sharedSettings.messageStreamShowTodos ?? false);
    setToolGroupingExploreEnabled(sharedSettings.toolGroupingExploreEnabled ?? true);
    setToolGroupingTerminalEnabled(sharedSettings.toolGroupingTerminalEnabled ?? true);
    setToolGroupingChangesEnabled(sharedSettings.toolGroupingChangesEnabled ?? false);
    setZCodeInteractionBehavior(sharedSettings.zcodeInteractionBehavior ?? "queue");
  }, [sharedSettings]);
  const handleTerminalInheritSystemProfileChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "toggle_system_profile",
        trigger: "switch",
        operation: () => services.settingService.update({ terminalInheritSystemProfile: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setTerminalInheritSystemProfile(enabled);
    },
    [services.settingService],
  );
  const handleTerminalFontFamilyChange = useCallback(
    async (fontFamily: string) => {
      const normalizedFontFamily = fontFamily.trim();
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "save_font_family",
        trigger: "button",
        operation: () =>
          services.settingService.update({ terminalFontFamily: normalizedFontFamily }),
        completed: { resultSource: "setting_service", configured: normalizedFontFamily.length > 0 },
      });
      setTerminalFontFamily(normalizedFontFamily);
    },
    [services.settingService],
  );
  const handleIntegratedTerminalShellChange = useCallback(
    async (selection: IntegratedTerminalShellSelection) => {
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "change_shell",
        trigger: "select",
        operation: () => services.settingService.update({ integratedTerminalShell: selection }),
        completed: {
          resultSource: "setting_service",
          valueAfter: selection.mode === "auto" ? "auto" : "explicit",
        },
      });
      setIntegratedTerminalShell(selection);
    },
    [services.settingService],
  );
  const handleNativeSearchEnhancementsEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.search",
        action: "toggle_native_search",
        trigger: "switch",
        operation: () => updateSharedSettings({ nativeSearchEnhancementsEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleToolSearchModeChange = useCallback(
    async (mode: "auto" | "local" | "off") => {
      await runSettingsActionAsync({
        featureId: "settings.search",
        action: "select_tool_search_mode",
        trigger: "select",
        operation: () => updateSharedSettings({ toolSearchMode: mode }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: mode,
        },
      });
    },
    [updateSharedSettings],
  );
  const handleAskUserQuestionAutoResolutionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_ask_user_auto_resolution",
        trigger: "switch",
        operation: () => updateSharedSettings({ askUserQuestionAutoResolutionEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleModelIoFullRetentionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_model_io_retention",
        trigger: "switch",
        operation: () => updateSharedSettings({ modelIoFullRetentionEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  // FORK（magic-context-memory-management / 变更点 10 · Step 8）：存量迁移。
  // 原生「工作区记忆」开关已从 UI 退场（分区改挂 magic-context 项目记忆管理面板），
  // 但协议字段 memoryEnabled 保留照发（strict 兼容窗口 + 压制 CLI 原生记忆提取），
  // 因此存量 true 必须在这里归零——这是隐形开关的唯一出口。onboarding 侧已停写该键
  // （Step 9），这里写回 false 后不会被换号同步复活。
  useEffect(() => {
    if (activeSection !== "memory") return;
    if (sharedSettings?.memoryEnabled !== true) return;
    void (async () => {
      try {
        await updateSharedSettings({ memoryEnabled: false });
        toast(intl.formatMessage({ id: "settings.memory.management.legacySwitchRetired" }));
      } catch (error) {
        // 归零失败不阻塞分区渲染：下次进入分区会重试，面板本身不依赖该字段。
        console.warn("[settings] 关闭遗留的原生记忆开关失败", String(error));
      }
    })();
  }, [activeSection, intl, sharedSettings?.memoryEnabled, updateSharedSettings]);
  const handleHttpProxyChange = useCallback(
    async (proxy: string) => {
      const normalizedProxy = proxy.trim();
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_http_proxy",
        trigger: "button",
        operation: () =>
          services.settingService.update({
            // Bugfix: RPC 会丢弃 undefined；清空代理必须传空串，由服务层删除旧字段。
            httpProxy: normalizedProxy,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedProxy.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxy(normalizedProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [services.settingService, intl],
  );
  const handleHttpProxyNoProxyChange = useCallback(
    async (noProxy: string) => {
      const normalizedNoProxy = noProxy
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .join(",");
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_no_proxy",
        trigger: "button",
        operation: () =>
          services.settingService.update({
            // Bugfix: 清空 No Proxy 必须传空串，否则旧绕过规则会继续影响下次启动。
            httpProxyNoProxy: normalizedNoProxy,
          }),
        completed: { resultSource: "setting_service", configured: normalizedNoProxy.length > 0 },
      });
      setHttpProxyNoProxy(normalizedNoProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [services.settingService, intl],
  );
  const handleHttpProxyCaCertPathChange = useCallback(
    async (caCertPath: string) => {
      const normalizedCaCertPath = caCertPath.trim();
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_ca_certificate",
        trigger: "button",
        operation: () =>
          services.settingService.update({
            // Bugfix: 清空自定义 CA 必须传空串，否则旧 NODE_EXTRA_CA_CERTS 路径会残留。
            httpProxyCaCertPath: normalizedCaCertPath,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedCaCertPath.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxyCaCertPath(normalizedCaCertPath);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [services.settingService, intl],
  );
  const handleDataBaseDirChange = useCallback(
    async (dir: string) => {
      await runSettingsActionAsync({
        featureId: "settings.storage",
        action: "change_data_directory",
        trigger: "button",
        operation: () => services.settingService.updateDataBaseDir(dir || undefined),
        completed: { resultSource: "setting_service", requiresRestart: true },
        failureStage: "data_directory_update",
      });
      // Bugfix: 迁移失败时不能先把本地状态改成失败路径，否则设置页会误显示为已切换。
      setDataBaseDir(dir);
    },
    [services.settingService],
  );
  const handleTaskAutoArchiveEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.task",
        action: "toggle_auto_archive",
        trigger: "switch",
        operation: () => services.settingService.update({ taskAutoArchiveEnabled: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setTaskAutoArchiveEnabled(enabled);
    },
    [services.settingService],
  );
  const handleTaskAutoArchiveOlderThanDaysChange = useCallback(
    async (days: number) => {
      await runSettingsActionAsync({
        featureId: "settings.task",
        action: "change_auto_archive_days",
        trigger: "select",
        operation: () => services.settingService.update({ taskAutoArchiveOlderThanDays: days }),
        completed: { resultSource: "setting_service", valueAfter: String(days) },
      });
      setTaskAutoArchiveOlderThanDays(days);
    },
    [services.settingService],
  );
  const handleCloseToTrayOnWindowsChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_close_to_tray",
        trigger: "switch",
        operation: () => services.settingService.update({ closeToTrayOnWindows: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      platform.syncAppSettings?.({ closeToTrayOnWindows: enabled });
      setCloseToTrayOnWindows(enabled);
    },
    [services.settingService, platform],
  );
  // keep-awake：走 useSettings 统一写盘 + syncAppSettings，和 Automations/创建页入口共享同一状态源。
  const handleKeepAwakeWhileRunningChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_keep_awake",
        trigger: "switch",
        operation: () => updateSharedSettings({ keepAwakeWhileRunning: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleDesktopChromiumHardwareAccelerationChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_hardware_acceleration",
        trigger: "switch",
        operation: () =>
          services.settingService.update({ desktopChromiumHardwareAccelerationEnabled: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
          requiresRestart: true,
        },
      });
      setDesktopChromiumHardwareAccelerationEnabled(enabled);
      toast(
        intl.formatMessage({
          id: "settings.desktopChromiumHardwareAccelerationSavedHint",
        }),
      );
    },
    [services.settingService, intl],
  );
  const handleEmbeddedBrowserAllowInsecureCertificatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.browser",
        action: "toggle_insecure_certificates",
        trigger: "switch",
        operation: () =>
          services.settingService.update({ embeddedBrowserAllowInsecureCertificates: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
          requiresRestart: true,
        },
      });
      setEmbeddedBrowserAllowInsecureCertificates(enabled);
      // 证书策略在 main 启动时装到 Session 上，改完必须重启才会换掉 verifyProc。
      toast(
        intl.formatMessage({
          id: "settings.embeddedBrowserAllowInsecureCertificatesSavedHint",
        }),
      );
    },
    [services.settingService, intl],
  );
  const handleMessageStreamShowReasoningChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_show_reasoning",
        trigger: "switch",
        operation: () => updateSharedSettings({ messageStreamShowReasoning: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setMessageStreamShowReasoning(enabled);
    },
    [updateSharedSettings],
  );
  const handleMessageStreamShowTodosChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_show_todos",
        trigger: "switch",
        operation: () => updateSharedSettings({ messageStreamShowTodos: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setMessageStreamShowTodos(enabled);
    },
    [updateSharedSettings],
  );
  const handleToolGroupingExploreEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_explore_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingExploreEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingExploreEnabled(enabled);
    },
    [updateSharedSettings],
  );
  const handleToolGroupingTerminalEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_terminal_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingTerminalEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingTerminalEnabled(enabled);
    },
    [updateSharedSettings],
  );
  const handleToolGroupingChangesEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_changes_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingChangesEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingChangesEnabled(enabled);
    },
    [updateSharedSettings],
  );
  const handleZCodeInteractionBehaviorChange = useCallback(
    async (behavior: ZCodeInteractionBehavior) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "change_interaction_behavior",
        trigger: "select",
        operation: () => updateSharedSettings({ zcodeInteractionBehavior: behavior }),
        completed: { resultSource: "shared_settings", valueAfter: behavior },
      });
      setZCodeInteractionBehavior(behavior);
    },
    [updateSharedSettings],
  );
  const handleFooterLocaleChange = useCallback(
    (value: string) => {
      if (value === "system") {
        setLocalePreference("system");
        return;
      }
      if (value === "zh-CN" || value === "en-US") {
        setLocalePreference(value as Locale);
      }
    },
    [setLocalePreference],
  );
  const handleFooterThemeChange = useCallback(
    (value: string) => {
      if (
        value === "light" ||
        value === "dark" ||
        value === "zai-light" ||
        value === "zai-dark" ||
        value === "system"
      ) {
        setTheme(value as Theme);
      }
    },
    [setTheme],
  );
  const handleCodePreviewSettingsChange = useCallback(
    (patch: Parameters<typeof setCodePreviewSettings>[0]) => {
      return setCodePreviewSettings(patch);
    },
    [setCodePreviewSettings],
  );
  const activeSectionMeta = settingsSections.find((section) => section.id === activeSection);
  // 灰度裁决异步到达：sections 列表可能在挂载后变化（如 computerUse 区被灰度移除）。
  // 若用户正停留在被移除的 section，回落到第一个可见区，避免整页 return null。
  useEffect(() => {
    setActiveSection((current) => resolveSettingsSectionForPlatform(current, settingsSections));
  }, [settingsSections]);
  if (!activeSectionMeta) {
    return null;
  }

  const activeSectionLabel = intl.formatMessage({
    id: activeSectionMeta.contentTitleId ?? activeSectionMeta.titleId,
  });
  const settingsBreadcrumbSectionLabel =
    activeSection === "plugin" && pluginNavigationOrigin === "plugin-store"
      ? intl.formatMessage({ id: "workspace.openPluginsSettings" })
      : activeSectionLabel;
  const visibleSettingsBreadcrumbItems =
    settingsBreadcrumbItems[0]?.label === settingsBreadcrumbSectionLabel
      ? settingsBreadcrumbItems
      : [];
  const hasVisibleSettingsBreadcrumb = visibleSettingsBreadcrumbItems.length >= 2;
  const showActiveSectionTitle =
    !hasVisibleSettingsBreadcrumb ||
    (activeSection === "plugin" && pluginNavigationOrigin === "plugin-store");

  return (
    <>
      <DesktopWindowFrame
        title={intl.formatMessage({ id: "settings.title" })}
        isDesktop={isDesktop}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        <div
          data-testid={TID_SETTINGS_PAGE}
          data-active-section={activeSection}
          // 隐式 auto 行会按 Memory viewer 的内容高度撑出窗口，随后被 DesktopWindowFrame 裁切且没有滚动条。
          // 固定为单个 minmax(0, 1fr) 行，让普通设置页和内部滚动 viewer 都以窗口剩余高度为边界。
          className="relative grid h-screen min-h-full w-full grid-cols-[68px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] lg:grid-cols-[268px_minmax(0,1fr)]"
        >
          {isWindowsDesktop ? <WindowsTopLeftLogo /> : null}

          {usesInlineWindowControls ? (
            <div className="absolute right-1 top-1 z-30 mt-px mr-px flex h-12 items-center gap-0.5 px-2 pointer-events-auto [app-region:no-drag]">
              {/* Windows/Linux 设置页仍保留旧 caption 下箭头，与主界面和 macOS 的帮助入口不一致。
                  统一复用问号帮助按钮，并让它在普通 flex 流中紧邻自绘窗控。
                  Settings 的独立标题层还需计入 4px 外层留白和 1px 边框，才能与 Workspace 控制组对齐。 */}
              <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} />
              <DesktopWindowControls />
            </div>
          ) : null}
          <aside className="min-w-0">
            <div className="flex h-full flex-col">
              <div className="h-12 [app-region:drag]"></div>
              <div className="px-2 pb-3 pt-3">
                {onBack ? (
                  <ControlHintTooltip
                    title={intl.formatMessage({
                      id: "workspace.backToWorkspace",
                    })}
                    side="right"
                    align="center"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="lg"
                      data-testid={TID_SETTINGS_BACK_BUTTON}
                      aria-label={intl.formatMessage({
                        id: "workspace.backToWorkspace",
                      })}
                      className="m-1 w-[calc(100%-0.5rem)] justify-start gap-2 rounded-xl px-1.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground max-lg:m-1 max-lg:size-10 max-lg:justify-center max-lg:px-0"
                      onClick={() => {
                        if (pluginNavigationOrigin === "plugin-store") {
                          requestPluginStoreOpen("user");
                        }
                        onBack?.();
                      }}
                    >
                      <ArrowLeft className="size-4" />
                      <span className="max-lg:sr-only">
                        {intl.formatMessage({
                          id: "workspace.backToWorkspace",
                        })}
                      </span>
                    </Button>
                  </ControlHintTooltip>
                ) : null}

                {/* <div className={onBack ? "mt-5" : "pt-2"}>
                    <h1 className="flex items-center gap-2 px-2.5 text-ui-lg font-medium text-foreground-subtle">
                      {intl.formatMessage({ id: "settings.title" })}
                    </h1>
                  </div> */}
              </div>

              <nav
                aria-label={intl.formatMessage({ id: "settings.navLabel" })}
                className="flex-1 overflow-y-auto px-2 pb-3"
              >
                <div className="space-y-4">
                  {settingsSectionGroups.map((group, groupIndex) => {
                    const groupLabel = intl.formatMessage({
                      id: group.titleId,
                    });
                    const groupLabelId = `settings-sidebar-group-${group.id}`;

                    return (
                      <div
                        key={group.id}
                        role="group"
                        aria-labelledby={groupLabelId}
                        className={cn(
                          "space-y-1",
                          groupIndex > 0 && "max-lg:border-t max-lg:border-border max-lg:pt-3",
                        )}
                      >
                        <div
                          id={groupLabelId}
                          className="px-2.5 pb-1 text-ui-sm font-medium text-foreground-subtlest max-lg:sr-only"
                        >
                          {groupLabel}
                        </div>
                        {group.sections.map(({ id, icon: Icon, titleId }) => {
                          const isActive = activeSection === id;
                          const label = intl.formatMessage({ id: titleId });

                          return (
                            <SettingsSidebarButton
                              key={id}
                              icon={Icon}
                              label={label}
                              active={isActive}
                              aria-current={isActive ? "page" : undefined}
                              data-testid={testId(TID_SETTINGS_SECTION_NAV, id)}
                              onClick={() => {
                                setPluginNavigationOrigin(undefined);
                                // 手动切分区时清掉设备卡定位意图，避免下次进入仍吸附旧设备。
                                setTargetSourceServerId(undefined);
                                setTargetSourceServerDetails(false);
                                setSettingsSectionNavigationVersion((version) => version + 1);
                                setActiveSettingsSection(id);
                              }}
                            >
                              <span className="truncate text-ui-base text-foreground">{label}</span>
                            </SettingsSidebarButton>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>

                <SettingsSidebarButton
                  icon={Rocket}
                  label={intl.formatMessage({ id: "settings.onboarding" })}
                  className="mt-4 border border-dashed border-border hover:border-border-hover"
                  onClick={() => {
                    requestOnboardingDialog();
                  }}
                >
                  <span className="text-ui-base text-foreground">
                    {intl.formatMessage({ id: "settings.onboarding" })}
                  </span>
                </SettingsSidebarButton>
              </nav>

              <div className="max-lg:hidden">
                <WorkspaceSidebarFooter
                  theme={theme}
                  localeMenuValue={localePreference}
                  onLocaleChange={handleFooterLocaleChange}
                  onThemeChange={handleFooterThemeChange}
                  onSettingsButtonClick={onBack}
                  settingsButtonMode="back"
                  // 头像菜单是 WorkspaceSidebarFooter 的共享菜单，Settings 场景不能丢失桌面平台能力。
                  // 之前这里没透传 isDesktop，导致同一个头像菜单在设置页缺少界面缩放入口。
                  isDesktop={isDesktop}
                />
              </div>
            </div>
          </aside>

          <section
            data-settings-content-frame="true"
            className={cn(
              "flex min-h-0 flex-col",
              // 桌面平台统一复用主工作区的面板 inset；左侧仍与导航相接，顶部由独立拖拽留白承接。
              isDesktop ? "p-1 pl-0 pt-0" : "p-0",
            )}
          >
            <div
              data-settings-top-inset={isDesktop ? "true" : undefined}
              className={cn("[app-region:drag]", isDesktop && "h-1", isMacDesktop && "max-lg:h-16")}
            />
            <div
              data-settings-panel-frame="true"
              className={cn(
                "relative flex flex-col min-h-0 h-full border border-border bg-background",
                // Windows 设置页已有 4px 外层留白，不再承担系统窗口外沿；圆角与主工作区统一为 5px。
                isWindowsDesktop ? "rounded-[5px]" : "rounded-xl",
              )}
            >
              {!usesInlineWindowControls ? (
                <div
                  className={cn(
                    // Settings 使用和 new task 一致的问号定位：在内容面板内定位，外层让出自绘窗口按钮区，内层保持 top-2.5/right-2.5。
                    "absolute top-0 z-50 h-10 w-10 pointer-events-auto [app-region:no-drag]",
                    "right-0",
                  )}
                >
                  <div className="absolute right-2.5 top-2.5 pointer-events-auto [app-region:no-drag]">
                    <WorkspaceHelpMenuButton
                      className="relative z-50 [app-region:no-drag]"
                      isDesktop={Boolean(isDesktop)}
                    />
                  </div>
                </div>
              ) : null}
              <SettingsBreadcrumbProvider
                onItemsChange={setSettingsBreadcrumbItems}
                sectionLabel={settingsBreadcrumbSectionLabel}
              >
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex h-12 shrink-0">
                    <div
                      // Settings 窄布局会像左侧导航一样在 max-lg 收成 icon rail。
                      // 此时外层已经提供 max-lg:h-16 的顶部拖拽/避让区，内层 h-10 再保留会把内容额外压低。
                      // Electron 的 drag 区不能和右上角帮助/窗口按钮命中区域重叠；
                      // 这里把右侧按钮区域从拖拽条里让出来，避免真实鼠标点击被标题栏拖拽吞掉。
                      // Windows/Linux 设置页共同避开右上角菜单与内联窗控组。

                      className={cn(
                        "min-w-0 flex-1 [app-region:drag]",
                        // 四个 28px 按钮、组内 2px 间距和左右 8px padding，共 134px。
                        usesInlineWindowControls ? "mr-[134px]" : "mr-12",
                      )}
                    >
                      <SettingsHeaderBreadcrumb
                        ariaLabel={intl.formatMessage({
                          id: "settings.breadcrumbLabel",
                        })}
                        items={visibleSettingsBreadcrumbItems}
                      />
                    </div>
                  </div>
                  <main className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                    <div
                      className={cn(
                        SETTINGS_FRAME_CONTENT_CLASSNAME,
                        "flex flex-col gap-8",
                        isMacDesktop && "pt-0",
                        // isWindowsDesktop && "pt-12",
                      )}
                    >
                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex min-w-0 flex-wrap items-center gap-3">
                            {showActiveSectionTitle ? (
                              <h2 className="text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                                {activeSectionLabel}
                              </h2>
                            ) : null}
                            {!hasVisibleSettingsBreadcrumb && activeSectionMeta.titleBadgeId ? (
                              <span className="inline-flex h-6 items-center rounded-full border border-sky-500 px-2 text-ui-xs font-semibold tracking-normal text-sky-500 dark:border-sky-400 dark:text-sky-400">
                                {intl.formatMessage({
                                  id: activeSectionMeta.titleBadgeId,
                                })}
                              </span>
                            ) : null}
                          </div>
                          {showSettingsSourceSelect ? (
                            <div className="flex min-w-0 items-center gap-2">
                              <SettingsSourceSelect
                                value={settingsSourceSelection}
                                sourceServers={sourceServers}
                                onValueChange={setSettingsSourceSelection}
                              />
                            </div>
                          ) : null}
                        </div>
                        {showSettingsSourceSelect &&
                        sourceAttachmentExhaustedFor !== null &&
                        sourceAttachmentExhaustedFor === selectedSettingsSourceServerId ? (
                          // 自动申请达到次数上限后必须让用户看见：继续静默退避会无限重发 IPC，
                          // 直接隐藏又会让页面像「设备没有配置」。这里保留显式失败态，
                          // 并给一个手动重试出口（重置退避/放弃标记后立即重跑决策）。
                          <div
                            data-testid="settings-source-attachment-exhausted"
                            data-source-server-id={sourceAttachmentExhaustedFor}
                            className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-surface px-3 py-2"
                          >
                            <span className="text-ui-sm text-foreground-subtle">
                              {intl.formatMessage({ id: "settings.source.operationFailed" })}
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={handleRetrySourceAttachment}
                            >
                              {intl.formatMessage({ id: "common.retry" })}
                            </Button>
                          </div>
                        ) : null}
                        {activeSection === "general" ? (
                          <GeneralSectionHeader localePreference={localePreference} />
                        ) : null}
                      </div>
                      <div className="space-y-8">
                        {activeSection === "general" ? (
                          <GeneralSectionContent
                            localePreference={localePreference}
                            interfaceMode={interfaceMode}
                            setInterfaceMode={setInterfaceMode}
                            isDesktop={isDesktop}
                            isWindowsDesktop={isWindowsDesktop}
                            platform={platform}
                            notificationEnabled={notificationEnabled}
                            notificationSoundEnabled={notificationSoundEnabled}
                            closeToTrayOnWindows={closeToTrayOnWindows}
                            keepAwakeWhileRunning={sharedSettings?.keepAwakeWhileRunning ?? false}
                            desktopChromiumHardwareAccelerationEnabled={
                              desktopChromiumHardwareAccelerationEnabled
                            }
                            dataBaseDir={dataBaseDir}
                            terminalInheritSystemProfile={terminalInheritSystemProfile}
                            terminalFontFamily={terminalFontFamily}
                            integratedTerminalShell={integratedTerminalShell}
                            integratedTerminalShellOptions={integratedTerminalShellOptions}
                            nativeSearchEnhancementsEnabled={nativeSearchEnhancementsEnabled}
                            toolSearchMode={toolSearchMode}
                            onToolSearchModeChange={handleToolSearchModeChange}
                            httpProxy={httpProxy}
                            httpProxyNoProxy={httpProxyNoProxy}
                            httpProxyCaCertPath={httpProxyCaCertPath}
                            defaultHomeDir={defaultHomeDir}
                            showIntegratedTerminalShell={hostPlatform === "win32"}
                            setLocalePreference={handleFooterLocaleChange}
                            setNotificationEnabled={(enabled) => setNotificationEnabled(enabled)}
                            setNotificationSoundEnabled={(enabled) =>
                              setNotificationSoundEnabled(enabled)
                            }
                            taskAutoArchiveEnabled={taskAutoArchiveEnabled}
                            taskAutoArchiveOlderThanDays={taskAutoArchiveOlderThanDays}
                            messageStreamShowReasoning={messageStreamShowReasoning}
                            messageStreamShowTodos={messageStreamShowTodos}
                            toolGroupingExploreEnabled={toolGroupingExploreEnabled}
                            toolGroupingTerminalEnabled={toolGroupingTerminalEnabled}
                            toolGroupingChangesEnabled={toolGroupingChangesEnabled}
                            zcodeInteractionBehavior={zcodeInteractionBehavior}
                            askUserQuestionAutoResolutionEnabled={
                              askUserQuestionAutoResolutionEnabled
                            }
                            modelIoFullRetentionEnabled={modelIoFullRetentionEnabled}
                            onDataBaseDirChange={handleDataBaseDirChange}
                            onSelectDataBaseDir={selectDirectory}
                            onTerminalInheritSystemProfileChange={
                              handleTerminalInheritSystemProfileChange
                            }
                            onTerminalFontFamilyChange={handleTerminalFontFamilyChange}
                            onIntegratedTerminalShellChange={handleIntegratedTerminalShellChange}
                            onNativeSearchEnhancementsEnabledChange={
                              handleNativeSearchEnhancementsEnabledChange
                            }
                            onModelIoFullRetentionEnabledChange={
                              handleModelIoFullRetentionEnabledChange
                            }
                            onHttpProxyChange={handleHttpProxyChange}
                            onHttpProxyNoProxyChange={handleHttpProxyNoProxyChange}
                            onHttpProxyCaCertPathChange={handleHttpProxyCaCertPathChange}
                            onTaskAutoArchiveEnabledChange={handleTaskAutoArchiveEnabledChange}
                            onTaskAutoArchiveOlderThanDaysChange={
                              handleTaskAutoArchiveOlderThanDaysChange
                            }
                            onCloseToTrayOnWindowsChange={handleCloseToTrayOnWindowsChange}
                            onKeepAwakeWhileRunningChange={handleKeepAwakeWhileRunningChange}
                            onDesktopChromiumHardwareAccelerationChange={
                              handleDesktopChromiumHardwareAccelerationChange
                            }
                            onMessageStreamShowReasoningChange={
                              handleMessageStreamShowReasoningChange
                            }
                            onMessageStreamShowTodosChange={handleMessageStreamShowTodosChange}
                            onToolGroupingExploreEnabledChange={
                              handleToolGroupingExploreEnabledChange
                            }
                            onToolGroupingTerminalEnabledChange={
                              handleToolGroupingTerminalEnabledChange
                            }
                            onToolGroupingChangesEnabledChange={
                              handleToolGroupingChangesEnabledChange
                            }
                            onZCodeInteractionBehaviorChange={handleZCodeInteractionBehaviorChange}
                            onAskUserQuestionAutoResolutionEnabledChange={
                              handleAskUserQuestionAutoResolutionEnabledChange
                            }
                            onOpenOnboardingDialog={() => requestOnboardingDialog()}
                          />
                        ) : null}
                        {/* 归档管理（upstream-v316-fullsync P4.1）：与任务自动归档设置同区段；
                            自带 ProjectDirectoryProvider，不依赖侧栏挂载。 */}
                        {activeSection === "general" ? <ArchiveManagement /> : null}
                        {/* 远程设备管理（backlog-sweep Step 9 / P9-3）：桌面端专属分区。
                            降级登记：连接/新建主操作依赖 Root 全局向导（拍板 A 未搬），
                            故面板内连接族按钮 disabled；设备行、编辑连接、删除、日志、
                            迁移报告、默认线路与开机重连开关全部真实可用。 */}
                        {activeSection === "remoteDevices" ? (
                          sharedSettings &&
                          isDesktop &&
                          localHostServices.sourceServerManagementService ? (
                            <SourceServerManagementPanel
                              key={`remote:${settingsSectionNavigationVersion}`}
                              targetSourceServerId={targetSourceServerId}
                              targetSourceServerDetails={targetSourceServerDetails}
                              onTargetSourceServerFocused={() => {
                                setTargetSourceServerId(undefined);
                                setTargetSourceServerDetails(false);
                              }}
                              management={localHostServices.sourceServerManagementService}
                              workspaceTabs={workspaceTabs}
                              settings={sharedSettings}
                              onUpdateSettings={updateSharedSettings}
                              onCreateConnection={onOpenRemoteConnection}
                              onConnectProfile={onConnectRemoteProfile}
                              onDisconnectSource={
                                deviceManagement
                                  ? async (sourceServerId) => {
                                      // Host 负责断开物理连接并广播 state 事件；
                                      // 面板 run 随后按新快照回写本页状态。
                                      await deviceManagement.disconnectSource(sourceServerId);
                                    }
                                  : undefined
                              }
                              onOpenProject={onOpenRemoteDeviceProject}
                              onShowInSidebar={handleShowDeviceInSidebar}
                              onShowUpdateDetails={handleShowDeviceUpdateDetails}
                            />
                          ) : (
                            <p className="text-ui-sm text-remote-foreground-muted">
                              {intl.formatMessage({
                                id: sharedSettings ? "settings.source.empty" : "common.loading",
                              })}
                            </p>
                          )
                        ) : null}
                        {activeSection === "appearance" ? (
                          <AppearanceSectionContent
                            codePreviewSettings={codePreviewSettings}
                            setCodePreviewSettings={handleCodePreviewSettingsChange}
                            theme={theme}
                            setTheme={(nextTheme) => handleFooterThemeChange(nextTheme)}
                            uiFontSizePx={uiFontSizePx}
                            setUiFontSizePx={(fontSizePx) => setUiFontSizePx(fontSizePx)}
                          />
                        ) : activeSection === "shortcuts" ? (
                          <ShortcutSettingsSection isDesktop={Boolean(isDesktop)} />
                        ) : activeSection === "modelProvider" ? (
                          <ServiceProvider services={localHostServices}>
                            {/* 模型配置属于本机全局事实源；激活远端 workspace 时也不能注入远端 Host。 */}
                            <ModelProviderSection
                              workspacePath={activeWorkspacePath ?? captionWorkspacePath ?? ""}
                              connectivityWorkspacePath={
                                localModelProviderConnectivityWorkspacePath
                              }
                              connectivityWorkspaceRequired={isRemoteModelProviderWorkspace}
                              pendingModelProviderTarget={pendingModelProviderTarget}
                              onConsumePendingModelProviderTarget={() =>
                                setPendingModelProviderTarget(undefined)
                              }
                            />
                          </ServiceProvider>
                        ) : activeSection === "memory" ? (
                          <ServiceProvider services={localHostServices}>
                            {/* 项目记忆管理面板始终使用本地 Host 的 CLI 记忆库，
                                避免远程 workspace 误读远端数据（占位文案里已注明）。 */}
                            <MemoryManagementSection
                              workspacePath={activeWorkspacePath ?? captionWorkspacePath}
                            />
                          </ServiceProvider>
                        ) : activeSection === "context" ? (
                          <ServiceProvider services={localHostServices}>
                            {/* magicContext 是用户级参数域：写盘固定落在
                                ~/.omz/cli/config.json，workspace 只用于定位本机控制面
                                （读/写都走同一条 read-only lane）。 */}
                            <MagicContextSettingsSection
                              workspacePath={activeWorkspacePath ?? captionWorkspacePath}
                            />
                          </ServiceProvider>
                        ) : activeSection === "plugin" ? (
                          <PluginsSection
                            key={`plugin:${settingsSectionNavigationVersion}`}
                            isDesktop={Boolean(isDesktop)}
                            isMacDesktop={Boolean(isMacDesktop)}
                            isWindowsDesktop={Boolean(isWindowsDesktop)}
                            initialTab={pluginTab}
                            initialScopeKey={pluginScopeKey}
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            settingsSourceServerId={selectedSettingsSourceServerId}
                            showMarketplaceBreadcrumb={pluginNavigationOrigin === "plugin-store"}
                            onCreateTask={onCreateTask}
                            onOpenPluginStore={(_returnScopeKey, intent) => {
                              // 添加市场与浏览插件都先离开设置层，再显示商店。
                              requestPluginStoreOpen({ returnScopeKey: "user", intent });
                              onBack?.();
                            }}
                          />
                        ) : activeSection === "mcp" ? (
                          <PluginsSection
                            key={`mcp:${settingsSectionNavigationVersion}`}
                            mode="mcp"
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            settingsSourceServerId={selectedSettingsSourceServerId}
                            onCreateTask={onCreateTask}
                            onOpenPluginStore={(_returnScopeKey, intent) => {
                              // 添加市场与浏览插件都先离开设置层，再显示商店。
                              requestPluginStoreOpen({ returnScopeKey: "user", intent });
                              onBack?.();
                            }}
                          />
                        ) : activeSection === "skill" ? (
                          <PluginsSection
                            key={`skill:${settingsSectionNavigationVersion}`}
                            mode="skill"
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            settingsSourceServerId={selectedSettingsSourceServerId}
                            onCreateTask={onCreateTask}
                            onOpenPluginStore={(_returnScopeKey, intent) => {
                              // 添加市场与浏览插件都先离开设置层，再显示商店。
                              requestPluginStoreOpen({ returnScopeKey: "user", intent });
                              onBack?.();
                            }}
                          />
                        ) : activeSection === "migration" ? (
                          <MigrationSection
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            isDesktop={isDesktop}
                            settingsSourceServerId={selectedSettingsSourceServerId}
                          />
                        ) : activeSection === "usage" ? (
                          /* FORK（D-4）：Coding Plan 额度页整删，只剩 App Usage（无 tab）。 */
                          <UsageStatsSection />
                        ) : activeSection === "subagents" ? (
                          <SubagentsSection
                            onManageModels={handleOpenModelProviderSettings}
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            settingsSourceServerId={selectedSettingsSourceServerId}
                          />
                        ) : activeSection === "automations" ? (
                          <AutomationsSection
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            settingsSourceServerId={selectedSettingsSourceServerId}
                          />
                        ) : activeSection === "commands" ? (
                          <PluginsSection
                            mode="command"
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            settingsSourceServerId={selectedSettingsSourceServerId}
                            onCreateTask={onCreateTask}
                            onOpenPluginStore={(_returnScopeKey, intent) => {
                              // 添加市场与浏览插件都先离开设置层，再显示商店。
                              requestPluginStoreOpen({ returnScopeKey: "user", intent });
                              onBack?.();
                            }}
                          />
                        ) : activeSection === "hooks" ? (
                          <HooksSection
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            settingsSourceServerId={selectedSettingsSourceServerId}
                          />
                        ) : activeSection === "workspaceFileSearch" ? (
                          <WorkspaceFileSearchSection
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            settingsSourceServerId={selectedSettingsSourceServerId}
                          />
                        ) : activeSection === "browser" ? (
                          <BrowserSettingsSection
                            isDesktop={Boolean(isDesktop)}
                            isWindowsDesktop={isWindowsDesktop}
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            settingsSourceServerId={selectedSettingsSourceServerId}
                            embeddedBrowserAllowInsecureCertificates={
                              embeddedBrowserAllowInsecureCertificates
                            }
                            onEmbeddedBrowserAllowInsecureCertificatesChange={
                              handleEmbeddedBrowserAllowInsecureCertificatesChange
                            }
                          />
                        ) : activeSection === "computerUse" ? (
                          <ComputerUseSection
                            isDesktop={Boolean(isDesktop)}
                            isMacDesktop={Boolean(isMacDesktop)}
                            isWindowsDesktop={Boolean(isWindowsDesktop)}
                            workspacePath={activeWorkspacePath}
                            workspaceIdentity={activeWorkspaceIdentity}
                            remoteSessionId={activeWorkspaceTab?.remoteSessionId}
                            remoteTarget={activeWorkspaceTab?.remoteTarget}
                            localWorkspacePath={activeWorkspaceTab?.localWorkspacePath}
                          />
                        ) : null}
                      </div>
                    </div>
                  </main>
                </div>
              </SettingsBreadcrumbProvider>
            </div>
          </section>
        </div>
      </DesktopWindowFrame>
    </>
  );
}
