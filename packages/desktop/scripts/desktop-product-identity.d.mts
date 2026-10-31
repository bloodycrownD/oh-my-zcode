/**
 * 手写声明的原因：`desktop-product-identity.mjs` 是构建脚本与 main 进程共用的 ESM 模块，
 * 仓库未开启 allowJs，缺少本文件时 TS 会把它整体当成隐式 any，main 侧调用点就失去类型校验。
 * 实现把「产品身份 flavor」和「后端环境 artifactSuffix」拆成两轴；改 .mjs 导出时必须同步本文件。
 */
export declare const ZCODE_PREVIEW_IDENTITY_ENV = "ZCODE_PREVIEW_IDENTITY";

export declare type DesktopProductFlavor = "production" | "preview";

export declare interface DesktopProductIdentity {
  readonly flavor: DesktopProductFlavor;
  readonly appId: string;
  readonly productName: string;
  readonly linuxExecutableName: string;
  readonly linuxPackageName: string;
  /** 实现里只有 preview 身份带 Helper 变体，其余为 null。 */
  readonly cuaHelperInstallVariant: "preview" | null;
}

export declare const desktopProductIdentities: Readonly<{
  production: DesktopProductIdentity;
  preview: DesktopProductIdentity;
}>;

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
