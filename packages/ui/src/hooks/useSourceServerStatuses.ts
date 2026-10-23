// 照搬上游 v3.16.2（upstream-v316-fullsync P7 末批）并 omz 化：
// ISourceServerManagementService 频道面（快照订阅 registry）随 P9 设置页批接入（spec ⑦
// 挂账）；本批消费缝先行——management 缺席时恒返回空投影，消费方（RemoteConnectionProgress
// Section / OfflineRemoteProjectRows / useRemoteProjectConnectionPresentation）按 undefined
// 降级为「无设备聚合态」，不产生 RPC 或轮询。registry 实体到位后仅此处切换数据源。
import { useMemo, useSyncExternalStore } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { AggregatedSourceStatus } from "@/lib/remoteConnectionPresentation.js";
import type { RemoteConnectionPresentationInput } from "@/lib/remoteConnectionPresentation.js";

const emptyStatuses: ReadonlyMap<string, AggregatedSourceStatus> = new Map();
const subscribeToNothing = () => () => undefined;
const getEmptyStatuses = () => emptyStatuses;

export function useSourceServerStatuses() {
  // omz：management 缝随 P9；在位前恒空投影。
  useBaseWorkspaceServices();
  return useSyncExternalStore(
    subscribeToNothing,
    getEmptyStatuses,
    getEmptyStatuses,
  );
}

const emptyInputs: ReadonlyMap<string, RemoteConnectionPresentationInput> = new Map();
const getEmptyInputs = () => emptyInputs;

export function useRemoteDevicePresentationInput(sourceServerId?: string) {
  // omz：management 缝随 P9；在位前恒 undefined（上游返回 inputs.get(sourceServerId)）。
  useBaseWorkspaceServices();
  const inputs = useSyncExternalStore(
    subscribeToNothing,
    getEmptyInputs,
    getEmptyInputs,
  );
  return sourceServerId ? inputs.get(sourceServerId) : undefined;
}
