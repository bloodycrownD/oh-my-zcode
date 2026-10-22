// 照搬上游 v3.16.2 source-server-management/sourceServerManagement.ts 的 Profile 编辑输入
// 契约（upstream-v316-fullsync Step 18，SourceServerDirectory.updateProfile 消费）。
// omz 裁量：ISourceServerManagementService 频道面（Snapshot/StateDelta/OperationLog 与
// ServiceChannels.SourceServerManagement 注册）属设置页「设备管理」UI 批，随 P9 再议挂账；
// 本期只落目录层依赖的类型，避免牵入未接线的服务面。
import type { RemoteTarget } from "@zcode/shared";

export interface UpdateConnectionProfileInput {
  profileId: string;
  profileDisplayName: string;
  sourceDisplayName?: string;
  target: Exclude<RemoteTarget, { kind: "server" }>;
  sshAuthMethod?: "password" | "privateKey";
}
