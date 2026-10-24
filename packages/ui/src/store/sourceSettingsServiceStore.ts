// 照搬上游 v3.16.2 ui/store/sourceSettingsServiceStore.ts（backlog-sweep Step 11）：
// Source 设置面 attachment 的 renderer 侧服务注册表。
//
// omz 落位差异：attachment 的物理通道由平台层发起（desktop host 的 resolveScope 已按
// 在线 Source 装配 createSourceSettingsServiceCollection，走 client/host 现有的 scoped
// MessagePort 链路），本模块只接收注入的 request 回调，不反向 import desktop，也不直接
// 访问 window.zcode。拿不到 Source 时 getSourceSettingsServices 返回 undefined，调用方
// 回落本机 scope，不抛错崩页。
//
// 接线现状（2026-10-24 收口）：desktop 侧通道已闭环——renderer 的
// sourceSettingsServicePortBridge 在窗口启动时注册 message 监听，Host 回执成功后 main 经
// InternalChannels.SourceSettingsServicePort 投递端口，桥在这里登记；SettingsPage 选中 Source
// 时经 IPlatformService.requestSourceSettingsAttachment 触发申请。拿不到 Source 时
// getSourceSettingsServices 仍返回 undefined，调用方回落本机 scope，不抛错崩页。
import { useSyncExternalStore } from "react";
import type { IServiceAccessor } from "@zcode/services";

interface SourceSettingsServicesEntry {
  attachmentId: string;
  services: IServiceAccessor;
  dispose: () => void;
}

interface RegisterSourceSettingsServicesParams extends SourceSettingsServicesEntry {
  sourceServerId: string;
}

const servicesBySourceServerId = new Map<string, SourceSettingsServicesEntry>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function registerSourceSettingsServices(
  params: RegisterSourceSettingsServicesParams,
): () => void {
  const { sourceServerId } = params;
  const entry: SourceSettingsServicesEntry = {
    attachmentId: params.attachmentId,
    services: params.services,
    dispose: params.dispose,
  };
  const previous = servicesBySourceServerId.get(sourceServerId);
  servicesBySourceServerId.set(sourceServerId, entry);
  previous?.dispose();
  emit();
  return () => {
    // Bug 原因：旧 attachment 的 close 可能晚于新一代注册；只按 Source 删除会误删当前服务。
    if (servicesBySourceServerId.get(sourceServerId) !== entry) return;
    servicesBySourceServerId.delete(sourceServerId);
    entry.dispose();
    emit();
  };
}

export function getSourceSettingsServices(
  sourceServerId: string | undefined,
): IServiceAccessor | undefined {
  return sourceServerId ? servicesBySourceServerId.get(sourceServerId)?.services : undefined;
}

/**
 * 订阅注册表变化（端口登记 / 释放 / 同 Source 换代）。
 *
 * 设置分区要靠它把「端口迟到」与「端口释放」变成重算：用户先打开设置页、端口后到时
 * 不需要重新选择设备；设备掉线或删除导致条目移除时同一路径回落锚点链或 unavailable。
 * 返回退订函数；订阅本身不读任何 Source 事实。
 */
export function subscribeSourceSettingsServices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSourceSettingsServices(
  sourceServerId: string | undefined,
): IServiceAccessor | undefined {
  // 订阅函数必须是稳定引用：内联箭头会在每次 render 后重新订阅，订阅/退订开销随渲染放大。
  return useSyncExternalStore(
    subscribeSourceSettingsServices,
    () => getSourceSettingsServices(sourceServerId),
    () => undefined,
  );
}

// 同一 Source 的配置面板共享一次 attachment admission，不复制物理连接或业务状态。
const attachmentRequests = new Map<string, Promise<void>>();
export function ensureSourceSettingsServices(
  sourceServerId: string,
  request: (id: string) => Promise<{ attachmentId: string }>,
): Promise<void> {
  if (getSourceSettingsServices(sourceServerId)) return Promise.resolve();
  const pending = attachmentRequests.get(sourceServerId);
  if (pending) return pending;
  const result = request(sourceServerId)
    .then(() => undefined)
    .finally(() => {
      if (attachmentRequests.get(sourceServerId) === result)
        attachmentRequests.delete(sourceServerId);
    });
  attachmentRequests.set(sourceServerId, result);
  return result;
}
