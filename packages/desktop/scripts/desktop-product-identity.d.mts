/** 构建脚本 desktop-product-identity.mjs 的 TS 侧声明（main/index.ts 与 vite/tsup 配置共用）。 */
export declare const ZCODE_PREVIEW_IDENTITY_ENV = "ZCODE_PREVIEW_IDENTITY";

export declare type DesktopProductFlavor = "production" | "preview";

export declare interface DesktopProductIdentity {
  readonly flavor: DesktopProductFlavor;
  readonly appId: string;
  readonly productName: string;
  readonly linuxExecutableName: string;
  readonly linuxPackageName: string;
  readonly cuaHelperInstallVariant: string | null;
}

export declare const desktopProductIdentities: Readonly<
  Record<DesktopProductFlavor, DesktopProductIdentity>
>;

export declare function isPreviewIdentityRequested(env?: Record<string, string | undefined>): boolean;

export declare function resolveDesktopProductFlavor(
  env?: Record<string, string | undefined>,
): DesktopProductFlavor;

export declare function resolveDesktopProductIdentity(
  env?: Record<string, string | undefined>,
): DesktopProductIdentity;

export declare function resolveDesktopArtifactSuffix(
  env?: Record<string, string | undefined>,
): "" | "_TEST";

export declare function resolveWindowsAppUserModelIdForFlavor(
  flavor: DesktopProductFlavor,
  runtime?: { isPackaged?: boolean },
): string;

export declare function resolveWindowsAppUserModelId(
  env?: Record<string, string | undefined>,
  runtime?: { isPackaged?: boolean },
): string;
