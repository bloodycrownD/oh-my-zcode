import type { Event } from "@zcode/rpc";
import type { IPlatformService } from "@zcode/shared";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

export type WebRemoteControlDeviceNavigation = NonNullable<
  WebRemoteControlWorkspaceSwitcherApi["deviceNavigation"]
>;
export type WebRemoteControlAuthPlatform = Pick<
  IPlatformService,
  "notifyWebRemoteControlAuthStateChanged"
>;
/**
 * FORK (upgrade-316)：IOAuthService 已随账号面整删（removed-features），
 * 这里只保留远控同步消费的最小凭据变更事件形状，等价于原
 * `Pick<IOAuthService, "onDidChangeSession">`（OAuthSessionState = "signed-in" | "signed-out"）。
 */
export type WebRemoteControlAuthEvents = {
  readonly onDidChangeSession: Event<"signed-in" | "signed-out">;
};
export type { WebRemoteControlMobileTaskView } from "@zcode/shared";
export type WebRemoteControlTaskViewSwitcher = Pick<
  WebRemoteControlWorkspaceSwitcherApi,
  "updateMobileTaskView" | "updateMobileViewState"
>;
