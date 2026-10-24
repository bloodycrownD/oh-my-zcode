// 向导壳 → 全局进度 Provider 的发布桥（knip-wire-progress）。
// 向导壳（SSHDialog / 后续 device-connect 形态）只需把真实 state 传进来；本 hook 负责
// 只在「收起到后台」时发布，并保证发给 Provider 的对象引用稳定，避免 render/effect 回环。
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RemoteTarget } from "@zcode/shared";
import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";
import type { RemoteConnectionProgress } from "@/remote-connection-flow/contract.js";
import { usePublishRemoteConnectionProgress } from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
import { useRemoteConnectionPhaseLogs } from "@/remote-connection-flow/ui/useRemoteConnectionPhaseLogs.js";

/**
 * 进度对象只做展示，不能把凭据带出向导；这里统一裁剪到展示/匹配所需字段
 * （sshConfigAlias 不是凭据，但面板按 target 回填 Profile 时需要它）。
 */
function toRemoteConnectionDisplayTarget(target: RemoteTarget | null): RemoteTarget | null {
  if (!target) return null;
  switch (target.kind) {
    case "ssh":
      return {
        kind: "ssh",
        host: target.host,
        username: target.username,
        ...(target.port ? { port: target.port } : {}),
        ...(target.sshConfigAlias ? { sshConfigAlias: target.sshConfigAlias } : {}),
      };
    case "wsl":
      return {
        kind: "wsl",
        ...(target.distro ? { distro: target.distro } : {}),
        ...(target.user ? { user: target.user } : {}),
      };
    case "docker":
      return { kind: "docker", container: target.container };
  }
}

export interface RemoteConnectionProgressPublisherInput {
  /** 向导可见时不发布：展开的向导本身就是进度界面，后台横幅只服务收起态。 */
  minimized: boolean;
  /** 每次连接尝试唯一；用于区分先后两次后台连接。 */
  operationId: string;
  view: RemoteWizardStep;
  /** 连接目标；本 hook 会裁剪成展示字段，调用方无需自行脱敏。 */
  target: RemoteTarget | null;
  /** 本次连接尝试的 requestId；阶段日志按它从 runtime 原始事件里取。 */
  requestId: string | null;
  error: string;
  reason: string;
  ready: boolean;
  cancelled?: boolean;
  waiting?: boolean;
  sourceServerId?: string;
  profileId?: string;
  name?: string;
  onResume(): void;
  onCancel(): void;
}

export function useRemoteConnectionProgressPublisher(
  input: RemoteConnectionProgressPublisherInput,
): void {
  const {
    minimized,
    operationId,
    view,
    target,
    requestId,
    error,
    reason,
    ready,
    cancelled = false,
    waiting = false,
    sourceServerId,
    profileId,
    name,
  } = input;

  // 向导里的 onResume/onCancel 每个 render 都是新闭包；经 ref 转发后它们不再进入 memo 依赖，
  // 否则 Provider setState 引发的重渲染会不断生成新 progress 对象，形成发布回环。
  const onResumeRef = useRef(input.onResume);
  const onCancelRef = useRef(input.onCancel);
  useEffect(() => {
    onResumeRef.current = input.onResume;
    onCancelRef.current = input.onCancel;
  });
  const onResume = useCallback(() => onResumeRef.current(), []);
  const onCancel = useCallback(() => onCancelRef.current(), []);
  const displayTarget = useMemo(() => toRemoteConnectionDisplayTarget(target), [target]);
  // 阶段必须来自 runtime 原始事件：展示日志已剥掉 `[source-server:<phase>]` 前缀。
  const { phaseLogs } = useRemoteConnectionPhaseLogs(requestId);

  const progress = useMemo<RemoteConnectionProgress | null>(
    () =>
      minimized
        ? {
            operationId,
            view,
            cancelled,
            target: displayTarget,
            sourceServerId,
            profileId,
            name,
            logs: phaseLogs,
            error,
            reason,
            waiting,
            ready,
            onResume,
            onCancel,
          }
        : null,
    [
      cancelled,
      displayTarget,
      error,
      minimized,
      name,
      onCancel,
      onResume,
      operationId,
      phaseLogs,
      profileId,
      ready,
      reason,
      sourceServerId,
      view,
      waiting,
    ],
  );

  usePublishRemoteConnectionProgress(progress);
}
