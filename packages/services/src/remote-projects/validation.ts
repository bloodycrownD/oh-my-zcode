// 照搬上游 v3.16.2 `.reference/ZCode/packages/services/src/remote-projects/validation.ts`
// （backlog-sweep Step 1，fork 纪律：实现逐字保真，仅按 omz 传输面裁剪）。
// omz 漂移：上游 targetSchema 的 `kind:"server"`（URL 直连目标）分支不迁移——omz
// `RemoteTarget`/`RemoteTargetSnapshot` 联合只含 ssh/wsl/docker（spec r5 P0-1 裁定），
// URL Server 经 LEGACY deployServer 旧链，不进入本批 hosts 表。
import { z } from "zod";
import { REMOTE_ASSET_INSTALL_MODES } from "@zcode/shared";

export const text = z.string().trim().min(1);
export const targetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ssh"),
      host: text,
      username: text,
      port: z.number().int().min(1).max(65535).optional(),
      sshConfigAlias: z.string().optional(),
      privateKeyPath: z.string().optional(),
      passwordCredentialKey: text.optional(),
      privateKeyPassphraseCredentialKey: text.optional(),
      assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
      resourcePackages: z
        .object({ selectedPackageIds: z.array(z.string()).optional() })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("wsl"), distro: text.optional(), user: text.optional() }).strict(),
  z.object({ kind: z.literal("docker"), container: text }).strict(),
]);
export const rootSchema = z
  .object({ rootPath: text, position: z.number().int().nonnegative(), isPrimary: z.boolean() })
  .strict();
export const cacheSchema = z
  .object({ projectId: text, name: text, roots: z.array(rootSchema) })
  .strict()
  .refine(
    ({ roots }) =>
      new Set(roots.map((root) => root.rootPath)).size === roots.length &&
      (roots.length === 0 || roots.filter((root) => root.isPrimary).length === 1),
    "remote-project.invalid-roots",
  );
