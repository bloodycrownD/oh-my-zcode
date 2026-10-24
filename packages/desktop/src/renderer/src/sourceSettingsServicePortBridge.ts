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
import {
  invalidateSourceSettingsServices,
  registerSourceSettingsServices,
  releaseSourceSettingsServices,
} from "@zcode/ui";

export interface SourceSettingsServicePortRegistration {
  attachmentId: string;
  sourceServerId: string;
  port: MessagePort;
}

/**
 * 存活探测节奏：close / messageerror 都可能永远不触发（Host 挂起、端口被静默 detach），
 * 只能靠一次真实 RPC 往返证明 attachment 仍可用。间隔要大于正常 RPC 延迟；单次超时只计入
 * 连续失败，达到阈值才把「对方已死但 port 未关」判定为失效。
 */
export const SOURCE_SETTINGS_PORT_HEARTBEAT_INTERVAL_MS = 15_000;
export const SOURCE_SETTINGS_PORT_HEARTBEAT_TIMEOUT_MS = 10_000;
/**
 * 连续失败阈值：单次 RPC 超时只说明链路瞬时慢/抖动，单条 `messageerror` 只说明那一条
 * payload 反序列化失败，都不足以判死仍可用的 attachment。连续多次探测无回执才标记失效；
 * 按 15s 间隔 + 10s 超时计算，首个探测在登记后一个间隔开始，真死端口最迟约 55s 被发现，
 * 期间能容忍两次连续抖动。
 */
export const SOURCE_SETTINGS_PORT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES = 3;

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
 * 登记一个端口；close 与连续探测失败经注册表的失效 API 保留失效条目，Host 侧
 * detach（设备离线/删除、updater 换代）触发 close 时读取面立即回落 undefined，
 * 避免设置页继续读已失效的远端 accessor。返回的 release 供调用方主动撤销（同一条移除路径）。
 *
 * Bug 原因：close 不是唯一的失效信号（静默死端口、建连失败都不会触发 close）。旧实现
 * 只监听 close；即便监听，也在同一 tick 删除条目，导致「失效条目」在生产不可观察，
 * 设置页的新在线周期永远等不到重新申请。修复依据：close / 连续探测失败统一
 * 「alive=false + 保留条目」，建连失败走真实释放入口；`ensureSourceSettingsServices`
 * 据此走失效替换分支。
 *
 * 静默死端口（close/messageerror 都不来、快照仍 online）没有事件可用，只能主动探测：
 * 周期性地经服务集必带的 `ISystemService.info()` 做一次 RPC 往返，连续
 * `SOURCE_SETTINGS_PORT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES` 次失败才
 * `invalidateSourceSettingsServices` 标记失效（条目保留在注册表，读取面立即回落
 * undefined，由设置页重申请链与 ensure 的替换分支收口）。
 *
 * `messageerror` 不等于端口死亡（可能只是某条消息反序列化失败），因此不直接判死，
 * 只立即补一次真实探测，由连续失败计数决定；`close` 才是确定的死亡信号。
 */
export function registerSourceSettingsServicePort(params: {
  attachmentId: string;
  sourceServerId: string;
  port: MessagePort;
  connect?: typeof createMessagePortServiceConnection;
}): () => void {
  const { attachmentId, sourceServerId, port } = params;
  let connection: ReturnType<typeof createMessagePortServiceConnection>;
  try {
    connection = (params.connect ?? createMessagePortServiceConnection)(port);
  } catch {
    // 建连失败：端口不能留在 renderer，也不能登记成条目。若同一 attachment 已被迟到/重复
    // 消息登记过，走注册表的真实释放入口摘掉它（代际匹配，不误删新一代 attachment）。
    releaseSourceSettingsServices(sourceServerId, attachmentId);
    port.close();
    return () => {};
  }
  let alive = true;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatInFlight = false;
  let probeTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  // 连续失败计数：成功（含超时后迟到的成功回执）即清零，只有连续失败达到阈值才判死。
  let consecutiveProbeFailures = 0;
  // 每次探测的代数：超时后允许下一周期再发探测，旧探测的迟到回执不能改写新探测的超时/
  // in-flight 归属（迟到的成功仍会清零连续失败，因为往返成功本身就证明端口可用）。
  let probeSeq = 0;
  const clearProbeTimeout = (): void => {
    if (probeTimeoutTimer !== undefined) {
      clearTimeout(probeTimeoutTimer);
      probeTimeoutTimer = undefined;
    }
  };
  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    clearProbeTimeout();
  };
  /**
   * 端口已不可用（close 或连续探测失败达到阈值）：把 alive 置 false 并**保留**条目。
   *
   * Bug 原因：旧实现在 close/messageerror 里直接 `releaseSourceSettingsServices` 删除
   * 条目，失效态和条目消失发生在同一 tick，注册表永远读不到 `isAlive() === false`，
   * 设置页的「失效条目替换」分支在生产不可达。
   * 修复依据：保留条目并标记失效——读取面立即回落 undefined、订阅者收到通知，设置页会
   * 重新申请；`ensure` 看到失效条目后走替换分支（dispose 才真正关闭端口与心跳）。
   */
  const markUnavailable = (): void => {
    if (!alive) return;
    alive = false;
    stopHeartbeat();
    invalidateSourceSettingsServices(sourceServerId, attachmentId);
  };
  const release = registerSourceSettingsServices({
    sourceServerId,
    attachmentId,
    services: connection.services,
    dispose: () => {
      alive = false;
      stopHeartbeat();
      connection.dispose();
      port.close();
    },
    isAlive: () => alive,
  });
  /**
   * 记录一次探测失败：只有连续失败达到阈值才判死。单次慢链路/抖动只累计一次失败，
   * 下一个周期探测成功就会清零，不会把仍可用的 attachment 送进释放/重申请链。
   */
  const recordProbeFailure = (): void => {
    if (!alive) return;
    consecutiveProbeFailures += 1;
    if (consecutiveProbeFailures >= SOURCE_SETTINGS_PORT_HEARTBEAT_MAX_CONSECUTIVE_FAILURES) {
      markUnavailable();
    }
  };
  /**
   * 一次真实 RPC 探测。超时按失败计，但允许下一周期重新探测（挂起的 Host 可能永不回包，
   * 不能靠 heartbeatInFlight 永久挡住后续探测，否则连续失败阈值永远到不了）。
   */
  const probeLiveness = (): void => {
    if (!alive || heartbeatInFlight) return;
    heartbeatInFlight = true;
    const seq = ++probeSeq;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearProbeTimeout();
      heartbeatInFlight = false;
    };
    // 成功往返（哪怕晚于超时）都是端口仍可用的证据：单次超时只代表这次慢，不代表对方已死。
    const succeed = (): void => {
      if (!alive) return;
      consecutiveProbeFailures = 0;
      if (seq === probeSeq) settle();
    };
    // 同一探测只计一次失败：超时后迟到的 rejection 不重复累计；换代后的旧探测也不再计数。
    const fail = (): void => {
      if (settled || !alive || seq !== probeSeq) return;
      settle();
      recordProbeFailure();
    };
    // 超时本身即为一次失败：挂起的 Host 不会回包，不能无限等待。
    probeTimeoutTimer = setTimeout(fail, SOURCE_SETTINGS_PORT_HEARTBEAT_TIMEOUT_MS);
    let probe: Promise<unknown>;
    try {
      probe = connection.services.systemService.info();
    } catch (error) {
      probe = Promise.reject(error);
    }
    void probe.then(succeed, fail);
  };
  // close 表示该 attachment 已不可用：统一走 markUnavailable，只置 alive=false 并标记失效、
  // 保留条目（带 attachmentId 代际保护，慢到的旧失败信号不会误伤同一 Source 的新一代
  // attachment）。真正删除/关闭由设置页重申请时的 `ensureSourceSettingsServices` 替换分支
  // 或显式 release 完成。
  port.addEventListener("close", markUnavailable, { once: true });
  // messageerror 只说明某条消息反序列化失败，不等于端口死亡（坏 payload / 单条消息问题）：
  // 不直接判死，立刻补一次真实 RPC 探测，让「是否还能往返」而不是「某条消息坏了」决定存活。
  port.addEventListener("messageerror", probeLiveness);
  heartbeatTimer = setInterval(probeLiveness, SOURCE_SETTINGS_PORT_HEARTBEAT_INTERVAL_MS);
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
