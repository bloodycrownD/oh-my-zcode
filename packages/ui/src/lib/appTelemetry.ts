/**
 * FORK (upgrade-316): 应用层遥测上报的 no-op 垫片。
 *
 * fork 已整体移除 renderer 遥测面（collectTelemetryRendererContext /
 * sanitizeTelemetryEventDetail / IPlatformService.reportTelemetryEvent 均不存在），
 * 但解 v3.16.2 冲突时 PluginStorePage / pluginUiManagedPage /
 * WorkspaceWebRemoteControlTrigger 仍保留了对本模块的调用。
 *
 * 按「已移除特性只删引用或改 no-op，不重新引入实现」的约定，这里保留同名导出，
 * 丢弃上报内容并直接返回；调用面无需改动，也不会再产生任何 IPC 遥测流量。
 */
export interface AppTelemetryEventPayload {
  elementName: string;
  eventRegion: string;
  eventType: string;
  eventText?: string;
  eventExtraDetail: Record<string, string>;
  userId?: string;
  talkId?: string;
  messageId?: string;
}

export async function reportAppTelemetryEvent(
  _platform: unknown,
  _payload: AppTelemetryEventPayload,
  _scope: string,
): Promise<void> {
  // no-op：渲染层遥测已移除。
}
