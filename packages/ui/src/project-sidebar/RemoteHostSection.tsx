// 照搬上游 v3.16.2（upstream-v316-fullsync P7 末批，拍板 B：Remote* 组件与同步链回填）。
// omz：server 直连传输不随本期（拍板②），server 展示分支随传输批回补。
import type { RemoteProjectHost } from "@/project-sidebar/contract.js";

export function remoteHostLabel(host: RemoteProjectHost): string {
  const target = host.target;
  if (!target) return host.id;
  switch (target.kind) {
    case "ssh":
      return `${target.username}@${target.host}`;
    case "docker":
      return target.container;
    case "wsl":
      return target.distro || "WSL";
  }
}
