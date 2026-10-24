// 照搬上游 v3.16.2 remote-connection/RemoteLinkRail.tsx（28L，backlog-sweep Step 9 / P9-3）。
// omz 适配：`RemoteTarget` 无 `server` 直连种类（拍板②：URL Server 走 LEGACY deployServer
// 旧链，不经 Source 管理域），故上游 `case "server"` 两分支删除。
import type { RemoteTarget } from "@zcode/shared";

export function formatRemoteLinkRailTarget(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl":
      return `WSL · ${target.distro ?? "default"}`;
    case "docker":
      return `Docker · ${target.container}`;
  }
}

export function formatRemoteLinkRailDevice(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return target.host;
    case "wsl":
      return target.distro ?? "WSL";
    case "docker":
      return target.container;
  }
}
