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
  /**
   * 失效标记（由端口桥的存活探测写入，例如连续心跳 RPC 失败）。
   *
   * 与 `isAlive` 的区别：`isAlive` 是端口桥持有的存活事实，close 与「连续探测失败达到
   * 阈值」会先把它置 false（单次超时/单条 messageerror 只是补一次探测，不判死）；
   * `invalidated` 让没有存活探测的调用方也能显式标记失效。
   * 两者都不删除条目——条目保留在注册表里，读取方立刻回落 undefined、订阅者收到通知，
   * `ensure` 见到失效条目才走替换分支真正 dispose。
   */
  invalidated?: boolean;
  /**
   * 端口存活探测（由端口桥注入）。
   *
   * Bug 原因：失效以前只依赖 MessagePort 的 close 事件；close 不触发时旧条目会一直留在
   * 注册表里，`portRegistered` 恒真，设置页的退避/重连重申请链被永久挡住。有了显式探测，
   * 读取方与 `ensure` 都能识别「已存在但已失效」的条目。缺省视为存活，兼容只按 close 释放的调用方。
   *
   * 2026-10-25 复核：端口桥的 close 与「连续探测失败」都改为「alive=false + 保留条目」，
   * 因此本探测返回 false 的条目会真实留在注册表里等待 `ensure` 替换。
   */
  isAlive?: () => boolean;
}

interface RegisterSourceSettingsServicesParams extends SourceSettingsServicesEntry {
  sourceServerId: string;
}

const servicesBySourceServerId = new Map<string, SourceSettingsServicesEntry>();
const listeners = new Set<() => void>();
/**
 * 注册表变更版本号：登记/释放/失效都会 +1。
 *
 * Bug 原因：`useSourceSettingsServices` 的 snapshot 是 services 对象本身；「先登记、随后
 * 同一批更新内失效」会让 snapshot 从 undefined 回到 undefined，React 认为没有变化而不
 * 重跑设置页 effect，失效条目等不到重申请。版本号让每次注册表变更都能触发订阅方重算。
 */
let registryVersion = 0;

function emit(): void {
  registryVersion += 1;
  for (const listener of listeners) listener();
}

function isEntryAlive(entry: SourceSettingsServicesEntry): boolean {
  // 先问存活探测：端口桥在 close 或连续探测失败达到阈值时把 alive 置 false，条目保留
  // 在注册表里（不删除），因此 `ensure` 的「失效条目替换」分支在生产可命中。
  if (entry.isAlive && !entry.isAlive()) return false;
  if (entry.invalidated) return false;
  return true;
}

/**
 * 只撤销「当前」条目：旧 attachment 的迟到释放不能误删同一 Source 的新一代服务。
 * 返回是否真的移除了条目。
 */
function forgetEntry(sourceServerId: string, entry: SourceSettingsServicesEntry): boolean {
  // Bug 原因：旧 attachment 的 close 可能晚于新一代注册；只按 Source 删除会误删当前服务。
  if (servicesBySourceServerId.get(sourceServerId) !== entry) return false;
  servicesBySourceServerId.delete(sourceServerId);
  entry.dispose();
  emit();
  return true;
}

export function registerSourceSettingsServices(
  params: RegisterSourceSettingsServicesParams,
): () => void {
  const { sourceServerId } = params;
  const entry: SourceSettingsServicesEntry = {
    attachmentId: params.attachmentId,
    services: params.services,
    dispose: params.dispose,
    ...(params.isAlive ? { isAlive: params.isAlive } : {}),
  };
  const previous = servicesBySourceServerId.get(sourceServerId);
  servicesBySourceServerId.set(sourceServerId, entry);
  previous?.dispose();
  emit();
  return () => {
    forgetEntry(sourceServerId, entry);
  };
}

/**
 * 显式释放一个 Source 的端口条目（删除条目并 dispose，不依赖 MessagePort close 事件）。
 *
 * 生产调用方（2026-10-25 复核补齐）：
 * - 设置页确认 Source 离线后释放仍存活的旧端口；
 * - 端口桥建连失败时清理迟到/重复登记的同一 attachment；
 * - `register` 返回的 release 仍是同一条 `forgetEntry` 路径（按条目身份保护）。
 *
 * close / 连续探测失败**不**走这里：它们只把条目标记失效并保留在注册表，
 * 让 `isAlive() === false` 在生产可观察、`ensure` 的替换分支可达；真正的删除/关闭由
 * 设置页重申请时的 `ensure` 或本函数完成。
 *
 * `attachmentId` 可选：带上时只释放匹配的条目，避免慢到的旧失败信号误删新一代 attachment。
 * 返回是否真的移除了条目。
 */
export function releaseSourceSettingsServices(
  sourceServerId: string,
  attachmentId?: string,
): boolean {
  const entry = servicesBySourceServerId.get(sourceServerId);
  if (!entry) return false;
  if (attachmentId !== undefined && entry.attachmentId !== attachmentId) return false;
  return forgetEntry(sourceServerId, entry);
}

/**
 * 标记条目失效但保留在注册表里（不 dispose、不删除）。
 *
 * 使用场景：端口没有触发 close/messageerror、management 快照也仍显示 online，但存活探测
 * （端口桥的心跳 RPC）已经失败。此时直接 release 会让「失效事实」和「条目消失」混在一起；
 * 标记 invalidated 后，读取方经 `isAlive` 立即拿到 undefined（并收到订阅通知，设置页据此
 * 走端口释放/重申请），真正清理与重申请交给 `ensureSourceSettingsServices` 的替换分支。
 *
 * `attachmentId` 可选：带上时只失效匹配的条目，迟到的心跳失败不能误伤新一代 attachment。
 * 返回是否真的改变了状态（重复失效幂等）。
 */
export function invalidateSourceSettingsServices(
  sourceServerId: string,
  attachmentId?: string,
): boolean {
  const entry = servicesBySourceServerId.get(sourceServerId);
  if (!entry) return false;
  if (attachmentId !== undefined && entry.attachmentId !== attachmentId) return false;
  if (entry.invalidated) return false;
  entry.invalidated = true;
  emit();
  return true;
}

export function getSourceSettingsServices(
  sourceServerId: string | undefined,
): IServiceAccessor | undefined {
  if (!sourceServerId) return undefined;
  const entry = servicesBySourceServerId.get(sourceServerId);
  if (!entry) return undefined;
  // 失效条目不在这里删除：getSnapshot 会在 React render 期间调用，避免渲染期改注册表；
  // 真正的清理交给 `ensure`（重新申请前替换）或 `release`。
  return isEntryAlive(entry) ? entry.services : undefined;
}

/**
 * 当前登记的 attachment 标识（同 Source 换代后即为新一代的 id）。
 *
 * 供调用方把「我这一轮看到的端口」与「要释放的条目」绑成同一代：release/invalidate 传入
 * 这个 id 后，慢到的旧信号只会命中它自己那一代，不会误删新登记的附件。
 */
export function getSourceSettingsAttachmentId(
  sourceServerId: string | undefined,
): string | undefined {
  if (!sourceServerId) return undefined;
  return servicesBySourceServerId.get(sourceServerId)?.attachmentId;
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

/**
 * 与 `useSourceSettingsServices` 同一渲染快照读出的 attachment id。
 *
 * 两者必须成对使用：只拿 id 而不校验 services 是否仍是同一个对象时，仍可能把新端口当成
 * 旧端口释放；组件按「同一 render 读到的 services + id」传参即可获得代际安全。
 */
export function useSourceSettingsAttachmentId(
  sourceServerId: string | undefined,
): string | undefined {
  return useSyncExternalStore(
    subscribeSourceSettingsServices,
    () => getSourceSettingsAttachmentId(sourceServerId),
    () => undefined,
  );
}

/**
 * 注册表变更版本：登记 / 释放 / 失效都会递增。
 *
 * 设置页的附件重试 effect 必须依赖它：只依赖 services 对象时，「登记后同批失效」的
 * snapshot 变化（undefined → accessor → undefined）会被 React 合并掉，effect 不重跑，
 * 失效条目就等不到重申请。
 */
export function useSourceSettingsServicesVersion(): number {
  return useSyncExternalStore(
    subscribeSourceSettingsServices,
    () => registryVersion,
    () => 0,
  );
}

// 同一 Source 的配置面板共享一次 attachment admission，不复制物理连接或业务状态。
const attachmentRequests = new Map<string, Promise<void>>();
export function ensureSourceSettingsServices(
  sourceServerId: string,
  request: (id: string) => Promise<{ attachmentId: string }>,
): Promise<void> {
  const existing = servicesBySourceServerId.get(sourceServerId);
  if (existing) {
    // Bug 原因：旧实现只要条目存在就直接返回，close 不触发时旧端口记录永远残留，
    // 后续申请被这行恒真的短路吃掉。已存在但失效的条目必须先摘掉再走申请（替换语义）。
    if (isEntryAlive(existing)) return Promise.resolve();
    forgetEntry(sourceServerId, existing);
  }
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
