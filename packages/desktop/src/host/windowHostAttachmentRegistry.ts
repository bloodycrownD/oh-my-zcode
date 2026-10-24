import type { SourceServerConnectionState, WindowHostAttachmentScope } from "@zcode/shared";
import type { ZCodeAgentV4ClientMode } from "@zcode/services";

/**
 * Source settings attachment 只在本机 Desktop Host 上、且 Source 当前 online 时可用
 * （照搬上游 sourceSettingsServiceCollection.ts:26-29）：
 * 只有 online generation 可继续服务设置，updating 也可能已经 dispose 旧连接。
 */
export function shouldDetachSourceSettingsAttachment(state: SourceServerConnectionState): boolean {
  return state !== "online";
}

interface WindowHostAttachmentPort {
  once(event: "close", listener: () => void): unknown;
}

interface WindowHostAttachmentHandle {
  dispose(): void;
}

interface WindowHostResolvedAttachmentScope<TServices, TCapabilities = never> {
  services: TServices;
  generation: number;
  capabilities?: TCapabilities;
}

interface WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities = never> {
  requestId: string;
  attachmentId: string;
  clientMode: ZCodeAgentV4ClientMode;
  scope: WindowHostAttachmentScope;
  services: TServices;
  generation: number;
  capabilities?: TCapabilities;
  port: TPort;
}

interface TrackedAttachment<TServices, TPort, TCapabilities = never> {
  params: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities>;
  handle: WindowHostAttachmentHandle;
  disposed: boolean;
}

export function createWindowHostAttachmentRegistry<
  TServices,
  TPort extends WindowHostAttachmentPort,
  TCapabilities = never,
>(options: {
  resolveScope: (
    scope: WindowHostAttachmentScope,
  ) => WindowHostResolvedAttachmentScope<TServices, TCapabilities>;
  expose: (
    params: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities>,
  ) => WindowHostAttachmentHandle;
}) {
  const attachments = new Map<string, TrackedAttachment<TServices, TPort, TCapabilities>>();

  function disposeTracked(tracked: TrackedAttachment<TServices, TPort, TCapabilities>): void {
    if (tracked.disposed) {
      return;
    }
    tracked.disposed = true;
    tracked.handle.dispose();
  }

  function attach(params: {
    requestId: string;
    attachmentId: string;
    clientMode: ZCodeAgentV4ClientMode;
    scope: WindowHostAttachmentScope;
    port: TPort;
  }): void {
    // 手机（replayable）链路不得复用 Desktop 专属的 source-settings 作用域（上游同守卫）：
    // 该 scope 暴露的是本机 Source 的远端配置面，没有可 replay 的 session 语义。
    if (params.clientMode === "web-remote-replayable" && params.scope.kind === "source-settings") {
      throw new Error("Source settings attachments are Desktop-only");
    }
    // scope 必须先由 Host registry 验证；验证失败时不能影响同 attachmentId 的现有端口。
    const resolved = options.resolveScope(params.scope);
    const exposedParams: WindowHostExposeAttachmentParams<TServices, TPort, TCapabilities> = {
      ...params,
      services: resolved.services,
      generation: resolved.generation,
      ...(resolved.capabilities !== undefined ? { capabilities: resolved.capabilities } : {}),
    };
    const handle = options.expose(exposedParams);
    const tracked: TrackedAttachment<TServices, TPort, TCapabilities> = {
      params: exposedParams,
      handle,
      disposed: false,
    };
    const previous = attachments.get(params.attachmentId);
    attachments.set(params.attachmentId, tracked);
    if (previous) {
      disposeTracked(previous);
    }
    params.port.once("close", () => {
      if (attachments.get(params.attachmentId) !== tracked) {
        return;
      }
      attachments.delete(params.attachmentId);
      disposeTracked(tracked);
    });
  }

  function detach(attachmentId: string): void {
    const tracked = attachments.get(attachmentId);
    if (!tracked) {
      return;
    }
    attachments.delete(attachmentId);
    disposeTracked(tracked);
  }

  function detachStaleRemoteSessionAttachments(
    remoteSessionId: string,
    currentGeneration: number,
  ): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "remote" ||
        tracked.params.scope.remoteSessionId !== remoteSessionId ||
        tracked.params.generation === currentGeneration
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      disposeTracked(tracked);
    }
  }

  function detachRemoteSessionAttachments(remoteSessionId: string): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "remote" ||
        tracked.params.scope.remoteSessionId !== remoteSessionId
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      disposeTracked(tracked);
    }
  }

  function detachSourceSettingsAttachments(sourceServerId: string): void {
    for (const [attachmentId, tracked] of attachments) {
      if (
        tracked.params.scope.kind !== "source-settings" ||
        tracked.params.scope.sourceServerId !== sourceServerId
      ) {
        continue;
      }
      attachments.delete(attachmentId);
      disposeTracked(tracked);
    }
  }

  return {
    attach,
    detach,
    detachRemoteSessionAttachments,
    detachSourceSettingsAttachments,
    detachStaleRemoteSessionAttachments,
    size: () => attachments.size,
    list: () =>
      Array.from(attachments.values(), (tracked) => ({
        requestId: tracked.params.requestId,
        attachmentId: tracked.params.attachmentId,
        clientMode: tracked.params.clientMode,
        scope: tracked.params.scope,
        generation: tracked.params.generation,
      })),
    dispose(): void {
      for (const tracked of attachments.values()) {
        disposeTracked(tracked);
      }
      attachments.clear();
    },
  };
}
