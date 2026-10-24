// Source 设置面 attachment 的 renderer 侧端口桥（照搬上游 v3.16.2
// desktop/renderer/src/sourceSettingsServicePortBridge.ts，backlog-sweep Step 11）。
//
// 链路：main 收到 Host ok 回执后经 `InternalChannels.SourceSettingsServicePort` 投递 port，
// preload 把 port 原样 transfer 到 window context，本桥在 renderer 启动时注册的 message
// 监听里拿到它，交给 `registerSourceSettingsServices` 登记。
//
// 生产调用方就是 `main.tsx` 里随窗口启动注册的 message 监听——不是 SettingsPage 内部自造，
// 也不依赖任何组件挂载；设置页只按 sourceServerId 读取已经登记好的 services。
import { createMessagePortServiceConnection } from "@zcode/client";
import { InternalChannels } from "@zcode/shared";
import { registerSourceSettingsServices } from "@zcode/ui";

export interface SourceSettingsServicePortRegistration {
  attachmentId: string;
  sourceServerId: string;
  port: MessagePort;
}

/** 是否为 Source 设置端口频道（含载荷不完整的情况，调用方必须消费掉该事件）。 */
export function isSourceSettingsServicePortMessage(event: MessageEvent): boolean {
  return (
    typeof event.data === "object" &&
    event.data !== null &&
    "type" in event.data &&
    (event.data as { type?: unknown }).type === InternalChannels.SourceSettingsServicePort
  );
}

export function parseSourceSettingsServicePortMessage(
  event: MessageEvent,
): SourceSettingsServicePortRegistration | null {
  if (!isSourceSettingsServicePortMessage(event)) return null;
  const payload = event.data as { attachmentId?: unknown; sourceServerId?: unknown };
  const sourceServerId =
    typeof payload.sourceServerId === "string" ? payload.sourceServerId.trim() : "";
  const attachmentId = typeof payload.attachmentId === "string" ? payload.attachmentId.trim() : "";
  const port = event.ports[0];
  if (!sourceServerId || !attachmentId || !port) return null;
  return { attachmentId, sourceServerId, port };
}

/**
 * 登记一个端口；返回的 release 同时挂在 port close 上，Host 侧 detach（设备离线/删除、
 * updater 换代）触发 close 时自动撤销，避免设置页继续读已失效的远端 accessor。
 */
export function registerSourceSettingsServicePort(params: {
  attachmentId: string;
  sourceServerId: string;
  port: MessagePort;
  connect?: typeof createMessagePortServiceConnection;
}): () => void {
  const connection = (params.connect ?? createMessagePortServiceConnection)(params.port);
  const release = registerSourceSettingsServices({
    sourceServerId: params.sourceServerId,
    attachmentId: params.attachmentId,
    services: connection.services,
    dispose: connection.dispose,
  });
  params.port.addEventListener("close", release, { once: true });
  return release;
}

/**
 * 处理一条 window message；返回 true 表示事件已被本频道消费（无论成功与否）。
 * 与 `remoteWorkspaceServicePortBridge` 同形，供 `main.tsx` 的单入口 message 分发复用。
 */
export function handleSourceSettingsServicePortMessage(event: MessageEvent): boolean {
  if (!isSourceSettingsServicePortMessage(event)) return false;
  const registration = parseSourceSettingsServicePortMessage(event);
  if (!registration) {
    // 缺 sourceServerId/attachmentId/port 的端口不能留在 renderer，直接关闭防止泄漏。
    event.ports[0]?.close();
    return true;
  }
  registerSourceSettingsServicePort(registration);
  return true;
}
