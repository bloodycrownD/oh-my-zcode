import type { WebRemoteControlFailure, WebRemoteControlV2QrParams } from "@zcode/shared";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";

// 升级 316 说明：上游 WebOAuthProviderId / WebAuthService 来自 packages/web/src/auth/*，
// 该目录随官方账号体系在 fork 合并时删除。contract 只描述登录入口的依赖形状，
// 这里保留最小类型面（provider 退化为普通字符串），不重新引入已删除的账号实现。
type WebOAuthProviderId = string;

interface WebAuthService {
  getZCodeJwtToken(): string | null;
  getActiveAccount(): WebRemoteControlDeviceListAccount | null | undefined;
  startLogin(options?: unknown): unknown;
  logout(): Promise<void> | void;
}

export interface WebRemoteControlDeviceGroup {
  deviceMid: string;
  name?: string;
  /** relay meta.platform（darwin / win32 / linux 等），离线时回退到本机记住的平台。 */
  platform?: string;
  onlineConnections: WebRemoteControlRelayV2Device[];
}

/** 本机见过的在线设备展示信息；name / platform 至少一项非空。 */
export interface KnownDevice {
  name?: string;
  platform?: string;
}

/** 设备页账号行的只读展示资料；不是登录事实，登录门禁仍以 JWT 为准。 */
export interface WebRemoteControlDeviceListAccount {
  displayName: string;
  avatarUrl?: string;
  provider: WebOAuthProviderId;
}

export type WebRemoteControlDeviceListView = {
  kind: "devices";
  devices: WebRemoteControlDeviceGroup[];
  loading: boolean;
  error: boolean;
  account?: WebRemoteControlDeviceListAccount;
};

export type WebRemoteControlEntryView =
  | { kind: "callback" | "login" }
  | WebRemoteControlDeviceListView
  | { kind: "failure"; failure: WebRemoteControlFailure };

export interface WebRemoteControlEntryConnection {
  params: WebRemoteControlV2QrParams & { deviceSid: string };
  signal: AbortSignal;
  getToken(signal: AbortSignal): Promise<string>;
  onPaired(): void;
  onFailure(failure: WebRemoteControlFailure): void;
}

export interface WebRemoteControlEntryOptions {
  // 浏览器 location/history/storage 经现有边界注入，不另存一份登录事实。
  auth: Pick<WebAuthService, "getZCodeJwtToken" | "getActiveAccount" | "startLogin" | "logout">;
  getHref(): string;
  replaceHref(href: string): void;
  storage: Pick<Storage, "getItem" | "setItem">;
  locale: "zh-CN" | "en-US";
  devices(jwt: string, signal: AbortSignal): Promise<WebRemoteControlRelayV2Device[]>;
  subscribeVisible(listener: () => void): () => void;
  loginOptions?: Parameters<WebAuthService["startLogin"]>[0];
  token(jwt: string, signal: AbortSignal): Promise<string>;
  connect(connection: WebRemoteControlEntryConnection): void;
  onView(view: WebRemoteControlEntryView): void;
}

export type * from "#src/web-remote-control/contracts/transport.js";
