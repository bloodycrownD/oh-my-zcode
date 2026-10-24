// 照搬上游 v3.16.2 hooks/useSourceServerStatuses.ts（backlog-sweep Step 9 / P9-3 消费缝切换）。
// 历史沿革：P7 末批以「management 频道面随 P9」为由先落恒空 stub；本批 management 服务
// （Step 7-8）已在位，故切回上游真实数据源——`getSourceServerStatusRegistry(management)`
// 订阅 Host 快照事件；management 缺席（Web 入口 / 无本机 Host）时仍退化为恒空投影，
// 不产生 RPC 或轮询。
import { useMemo, useSyncExternalStore } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getSourceServerStatusRegistry } from "@/store/sourceServerStatusRegistry.js";
import type {
  AggregatedSourceStatus,
  RemoteConnectionPresentationInput,
} from "@/lib/remoteConnectionPresentation.js";

const emptyStatuses: ReadonlyMap<string, AggregatedSourceStatus> = new Map();
const subscribeToNothing = () => () => undefined;
const getEmptyStatuses = () => emptyStatuses;

export function useSourceServerStatuses() {
  const management = useBaseWorkspaceServices().sourceServerManagementService;
  const registry = useMemo(
    () => (management ? getSourceServerStatusRegistry(management) : null),
    [management],
  );
  return useSyncExternalStore(
    registry?.subscribe ?? subscribeToNothing,
    registry?.getSnapshot ?? getEmptyStatuses,
    registry?.getSnapshot ?? getEmptyStatuses,
  );
}

const emptyInputs: ReadonlyMap<string, RemoteConnectionPresentationInput> = new Map();
const getEmptyInputs = () => emptyInputs;

export function useRemoteDevicePresentationInput(sourceServerId?: string) {
  const management = useBaseWorkspaceServices().sourceServerManagementService;
  const registry = useMemo(
    () => (management ? getSourceServerStatusRegistry(management) : null),
    [management],
  );
  const inputs = useSyncExternalStore(
    registry?.subscribe ?? subscribeToNothing,
    registry?.getInputs ?? getEmptyInputs,
    registry?.getInputs ?? getEmptyInputs,
  );
  return sourceServerId ? inputs.get(sourceServerId) : undefined;
}
