import type { ISettingService } from "@zcode/services";
import {
  type AppSettings,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
} from "@zcode/shared";

export function resolveLogoutProviderFamilyDomain(params: {
  currentDomain: ProviderFamilyDomain | null | undefined;
}): ProviderFamilyDomain | null {
  void params;
  return null;
}

export async function setProviderFamilyDomain(
  settingService: Pick<ISettingService, "get" | "update">,
  domain: ProviderFamilyDomain,
): Promise<void> {
  const currentSettings = await settingService.get();
  // TODO(upgrade-316): 上游 3.16 给 update() 加了 CAS 期望值（providerFamilyDomain /
  // providerFamilyConnectionSelections / updatedAt）以避免登录入口与 Composer 并发写覆盖。
  // fork 账号登录面已整删（D-19），本函数无调用方，先保留 fork 的单参写法。
  await settingService.update({
    providerFamilyDomain: domain,
    providerFamilyDomainUpdatedAt: Date.now(),
    providerFamilyDomainMigrated: true,
    // 历史语义：账号登录表示用户选择的是同 family 的 Coding Plan/OAuth 模式。
    // FORK（D-19）：账号面整删后本函数已无调用方，保留仅为旧设置项的读路径不破。
    // 只写 providerFamilyDomain 会保留之前 API Key 入口写入的 apiKey mode，导致登录成功后仍停在 API Key。
    providerFamilyConnectionSelections: buildOAuthProviderFamilySelections(
      domain,
      currentSettings.providerFamilyConnectionSelections,
    ),
  });
}

export function buildOAuthProviderFamilySelections(
  domain: ProviderFamilyDomain,
  currentSelections: ProviderFamilyConnectionSelectionSettings | null | undefined,
): ProviderFamilyConnectionSelectionSettings {
  return {
    ...currentSelections,
    [domain]: { kind: "individual-coding-plan" },
  };
}

export async function clearProviderFamilyDomain(
  settingService: Pick<ISettingService, "update">,
): Promise<void> {
  await settingService.update({
    // 清理原因：providerFamilyDomain 通过 RPC 传 undefined 容易被吞掉。
    // settingService 会把空串归一成 undefined，确保退出/解绑后不会继续过滤到旧 domain。
    providerFamilyDomain: "" as AppSettings["providerFamilyDomain"],
    providerFamilyDomainUpdatedAt: Date.now(),
    providerFamilyDomainMigrated: true,
  });
}
