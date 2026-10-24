import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  IModelSelectionService,
  ModelSelectionView,
  ModelSelectionViewInput,
} from "@zcode/services";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export type ModelSelectionState =
  | { status: "loading" }
  | { status: "ready"; view: ModelSelectionView }
  | { status: "unavailable"; reason: "remote-waiting" | "missing-target" }
  | { status: "error"; error: Error };

export interface ModelSelectionRead {
  state: ModelSelectionState;
  reload(): void;
}

interface OwnedModelSelectionState {
  service: IModelSelectionService | null;
  enabled: boolean;
  unavailableReason: "remote-waiting" | "missing-target";
  inputKey: string | undefined;
  state: ModelSelectionState;
}

// 首读的临时 IO 失败未必产生 Provider 变化事件；只重读两次，不轮询业务状态或重试写操作。
const INITIAL_READ_RETRY_DELAYS = [500, 1500] as const;
function isTransientReadError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; name?: unknown; message?: unknown };
  return (
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(String(error.code)) ||
    (error.name === "TypeError" &&
      ["Failed to fetch", "fetch failed", "Load failed"].includes(String(error.message)))
  );
}

function initialState(
  service: IModelSelectionService | null,
  enabled: boolean,
  unavailableReason: "remote-waiting" | "missing-target",
): ModelSelectionState {
  return enabled && service
    ? { status: "loading" }
    : { status: "unavailable", reason: unavailableReason };
}

/** 订阅明确 Host Service；返回状态在同一次 render 即绑定新 owner，不暴露旧 Host View。 */
export function useModelSelectionServiceView(
  service: IModelSelectionService | null | undefined,
  enabled = true,
  unavailableReason: "remote-waiting" | "missing-target" = "remote-waiting",
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  const normalizedService = service ?? null;
  // 调用方可每次 render 创建参数对象；所有权按选择内容绑定，不按对象引用反复订阅。
  const inputKey = input === undefined ? undefined : JSON.stringify(input);
  const stableInput = useMemo(() => input, [inputKey]);
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const [owned, setOwned] = useState<OwnedModelSelectionState>(() => ({
    service: normalizedService,
    enabled,
    unavailableReason,
    inputKey,
    state: initialState(normalizedService, enabled, unavailableReason),
  }));
  const ownedRef = useRef(owned);
  ownedRef.current = owned;
  const generationRef = useRef(0);
  const ownerMatches =
    owned.service === normalizedService &&
    owned.enabled === enabled &&
    owned.inputKey === inputKey &&
    owned.unavailableReason === unavailableReason;
  const visibleState = ownerMatches
    ? owned.state
    : initialState(normalizedService, enabled, unavailableReason);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const previous = ownedRef.current;
    const retainedReady =
      previous.service === normalizedService &&
      previous.enabled === enabled &&
      previous.inputKey === inputKey &&
      previous.unavailableReason === unavailableReason &&
      previous.state.status === "ready"
        ? previous.state
        : null;
    setOwned({
      service: normalizedService,
      enabled,
      unavailableReason,
      inputKey,
      state: retainedReady ?? initialState(normalizedService, enabled, unavailableReason),
    });
    if (!enabled || !normalizedService) return;

    let latestRevision = retainedReady?.view.revision ?? -1;
    let hasReadyView = retainedReady !== null;
    let requestId = 0;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelRetry = () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const commit = (candidate: ModelSelectionView): void => {
      if (generation !== generationRef.current || candidate.revision < latestRevision) return;
      latestRevision = candidate.revision;
      hasReadyView = true;
      cancelRetry();
      setOwned({
        service: normalizedService,
        enabled,
        unavailableReason,
        inputKey,
        state: { status: "ready", view: candidate },
      });
    };
    const read = (): void => {
      cancelRetry();
      const request = ++requestId;
      void normalizedService.getView(stableInput).then(
        (candidate) => {
          if (request === requestId) commit(candidate);
        },
        (cause: unknown) => {
          if (generation !== generationRef.current || request !== requestId) return;
          const error = cause instanceof Error ? cause : new Error(String(cause));
          logger.warn("[model-selection] 目标 Host View 读取失败", { error });
          // 读取失败不是选择失效。成功后的刷新失败保留原 View；首次失败可见且有界重读。
          if (!hasReadyView) {
            setOwned({
              service: normalizedService,
              enabled,
              unavailableReason,
              inputKey,
              state: { status: "error", error },
            });
            const delay = INITIAL_READ_RETRY_DELAYS[retryCount];
            if (delay !== undefined && isTransientReadError(cause)) {
              retryCount += 1;
              retryTimer = setTimeout(read, delay);
            }
          }
        },
      );
    };
    const subscription = normalizedService.onDidChange((candidate) => {
      if (generation !== generationRef.current) return;
      if (stableInput === undefined) commit(candidate);
      else {
        // 公共事件没有某个调用者的原意图；只能用它触发当前输入重读，不能直接接管结果。
        latestRevision = Math.max(latestRevision, candidate.revision);
        read();
      }
    });
    read();
    return () => {
      generationRef.current += 1;
      cancelRetry();
      subscription.dispose();
    };
  }, [enabled, normalizedService, reloadVersion, unavailableReason, inputKey, stableInput]);

  return { state: visibleState, reload: useCallback(() => reload(), []) };
}

export interface SettingsSourceModelSelectionResolution {
  service: IModelSelectionService | null;
  /** true = Source 端口没有设备侧模型目录，已回落本机；调用方必须在 UI 上标注来源。 */
  fromLocalFallback: boolean;
}

/**
 * 设置页「按 Source 编辑」时的模型选择服务解析。
 *
 * 修复依据：`source-settings` 端口只装配 hooks/plugin-management/skills/subagents 等配置面
 * （packages/services/src/source-server-management/sourceSettingsServiceCollection.ts:62-139），
 * 刻意不注册 model-selection；`SettingsSourceCapabilityServices` 也不投影该服务。因此端口
 * 路由下不存在「设备侧模型目录」，不能把未注册 channel 的 RPC proxy 当服务用（ChannelServer
 * 会按 Unknown channel 超时），只能明确回落本机，并让调用方把来源标出来，避免用户把本机
 * 模型当成设备事实。无端口时保持原有 workspace/锚点解析结果，本机设置页不受影响。
 */
export function resolveSettingsSourceModelSelectionService(params: {
  /** Source user scope 且 attachment 端口已登记（端口路由）。 */
  portUserScope: boolean;
  /** 无端口时原有的 workspace 解析结果（锚点远端或本机）。 */
  workspaceService?: IModelSelectionService | null;
  /** 本机 Host 的模型选择服务。 */
  localService?: IModelSelectionService | null;
}): SettingsSourceModelSelectionResolution {
  if (params.portUserScope) {
    return { service: params.localService ?? null, fromLocalFallback: true };
  }
  return { service: params.workspaceService ?? null, fromLocalFallback: false };
}

/** 模型候选只来自明确 Workspace Target；等待远端时不读取 Local/Base Host。 */
export function useModelSelectionView(
  workspacePath: string | null | undefined,
  remoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  const hasTarget = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const remoteWaiting = resolution.connectionKind === "remote-waiting";
  return useModelSelectionServiceView(
    resolution.services.modelSelectionService,
    hasTarget && !remoteWaiting,
    hasTarget ? "remote-waiting" : "missing-target",
    input,
  );
}
