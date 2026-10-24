import type {
  ConnectionProfile,
  RemoteAssetInstallMode,
  RemoteTarget,
  SourceServerManagementSnapshot,
} from "@zcode/shared";
import { isValidWslUser, normalizeRemoteResourcePackageSelection } from "@zcode/shared";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

type WizardIntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

interface RemoteConnectionFormSnapshot {
  kind: RemoteTarget["kind"];
  host: string;
  port: string;
  username: string;
  sshAuthMethod: SSHAuthMethod;
  assetInstallMode?: RemoteAssetInstallMode;
  selectedSshConfigAlias?: string | null;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  wslDistro: string;
  wslUser?: string;
  dockerContainer: string;
  manualDockerContainer?: string;
}

export function getRemoteWizardStepCopy(
  intl: WizardIntlLike,
  step: RemoteWizardStep,
  kind: RemoteTarget["kind"],
) {
  switch (step) {
    case "kind":
      return {
        title: intl.formatMessage({ id: "remote.kindStepTitle" }),
        description: intl.formatMessage({ id: "remote.kindStepDescription" }),
      };
    case "settings":
      return {
        title: intl.formatMessage({ id: "remote.settingsStepTitle" }),
        description: intl.formatMessage(
          { id: "remote.settingsStepDescription" },
          {
            method: intl.formatMessage({ id: `remote.kind.${kind}` }),
          },
        ),
      };
    case "connecting":
      return {
        title: intl.formatMessage({ id: "remote.connectingStepTitle" }),
        description: intl.formatMessage(
          { id: "remote.connectingStepDescription" },
          {
            method: intl.formatMessage({ id: `remote.kind.${kind}` }),
          },
        ),
      };
    case "directory":
      return {
        title: intl.formatMessage({ id: "remote.selectDirectoryTitle" }),
        description: intl.formatMessage({ id: "remote.selectDirectoryDescription" }),
      };
  }
}

export function buildRemoteTarget(
  intl: WizardIntlLike,
  snapshot: RemoteConnectionFormSnapshot,
): { target?: RemoteTarget; errorMessage?: string } {
  switch (snapshot.kind) {
    case "ssh":
      if (!snapshot.host || !snapshot.username) {
        return {
          errorMessage: intl.formatMessage({ id: "ssh.validation.required" }),
        };
      }

      if (snapshot.sshAuthMethod === "password" && !snapshot.password) {
        return {
          errorMessage: intl.formatMessage({ id: "ssh.validation.passwordRequired" }),
        };
      }

      if (snapshot.sshAuthMethod === "privateKey" && !snapshot.privateKeyPath) {
        return {
          errorMessage: intl.formatMessage({ id: "ssh.validation.privateKeyRequired" }),
        };
      }

      const sshConfigAlias = snapshot.selectedSshConfigAlias?.trim();

      return {
        target: {
          kind: "ssh",
          host: snapshot.host,
          port: snapshot.port ? Number(snapshot.port) : undefined,
          username: snapshot.username,
          ...(sshConfigAlias ? { sshConfigAlias } : {}),
          assetInstallMode: snapshot.assetInstallMode,
          ...(snapshot.sshAuthMethod === "password" && snapshot.password
            ? { password: snapshot.password }
            : {}),
          ...(snapshot.sshAuthMethod === "privateKey" && snapshot.privateKeyPath
            ? { privateKeyPath: snapshot.privateKeyPath }
            : {}),
          ...(snapshot.sshAuthMethod === "privateKey" && snapshot.privateKeyPassphrase
            ? { privateKeyPassphrase: snapshot.privateKeyPassphrase }
            : {}),
        },
      };
    case "docker":
      // Docker 运行中列表可能因为探测失败或刷新延迟不完整。
      // 手动输入必须独立于下拉选择，提交时优先使用手动输入，空值再回落到下拉选择。
      const dockerContainer =
        snapshot.manualDockerContainer?.trim() || snapshot.dockerContainer.trim();

      if (!dockerContainer) {
        return {
          errorMessage: intl.formatMessage({ id: "docker.validation.required" }),
        };
      }

      return {
        target: {
          kind: "docker",
          container: dockerContainer,
        },
      };
    case "wsl": {
      const wslUser = snapshot.wslUser?.trim();
      if (wslUser && !isValidWslUser(wslUser)) {
        return {
          errorMessage: intl.formatMessage({ id: "wsl.validation.invalidUser" }),
        };
      }
      return {
        target: {
          kind: "wsl",
          distro: snapshot.wslDistro || undefined,
          ...(wslUser ? { user: wslUser } : {}),
        },
      };
    }
  }
}

export function withDefaultRemoteResourcePackages(target: RemoteTarget): RemoteTarget {
  if (target.kind !== "ssh") {
    return target;
  }

  return {
    ...target,
    resourcePackages: {
      // 当前分支只保留一个 ZCode Agent，SSH 向导再让用户手动挑资源包会产生无意义分叉。
      // 这里统一走默认 active 资源集，历史重连传入的旧选择不再影响部署范围。
      selectedPackageIds: normalizeRemoteResourcePackageSelection(),
    },
  };
}

// 照搬上游 v3.16.2 remoteConnectionWizard.ts:338-393（backlog-sweep Step 10 / P9-4 前置符号）：
// 连接向导按目标找「必须升级」的 Profile，用于在 needs-upgrade 到达前就抑制重复更新提示。
export function profileMatchesRemoteTarget(
  profile: ConnectionProfile,
  target: Exclude<RemoteTarget, { kind: "server" }>,
): boolean {
  if (profile.target.kind !== target.kind) return false;
  switch (target.kind) {
    case "ssh":
      return (
        profile.target.kind === "ssh" &&
        profile.target.host === target.host &&
        (profile.target.port ?? 22) === (target.port ?? 22) &&
        profile.target.username === target.username &&
        (profile.target.sshConfigAlias?.trim() ?? "") === (target.sshConfigAlias?.trim() ?? "")
      );
    case "wsl":
      return (
        profile.target.kind === "wsl" &&
        (profile.target.distro?.trim() ?? "") === (target.distro?.trim() ?? "") &&
        (profile.target.user?.trim() ?? "") === (target.user?.trim() ?? "")
      );
    case "docker":
      return profile.target.kind === "docker" && profile.target.container === target.container;
  }
}

export function findSourceServerUpgradeProfileId(
  snapshot: SourceServerManagementSnapshot,
  target: Exclude<RemoteTarget, { kind: "server" }>,
  failedProfileId?: string,
): string | null {
  const requiredByProfileId = new Map(
    snapshot.states
      .filter(
        (state) =>
          state.state === "needs-upgrade" &&
          state.upgradeTarget === "server" &&
          state.updateAvailability === "required",
      )
      .map((state) => [state.profileId, state.updatedAt]),
  );
  return (
    snapshot.profiles
      .filter(
        (profile) =>
          (!failedProfileId || profile.profileId === failedProfileId) &&
          profile.lifecycleState !== "retired" &&
          requiredByProfileId.has(profile.profileId) &&
          profileMatchesRemoteTarget(profile, target),
      )
      .toSorted(
        (left, right) =>
          (requiredByProfileId.get(right.profileId) ?? 0) -
          (requiredByProfileId.get(left.profileId) ?? 0),
      )[0]?.profileId ?? null
  );
}
