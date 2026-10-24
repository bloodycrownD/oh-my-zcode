// Source 设置面 `source-settings` scope 的判定与错误映射（backlog-sweep Step 11 收口）。
//
// 判定顺序固定为「设备是否存在 → 是否在线 → 服务集是否可装配」：
// 1. 存在性来自 Directory 快照（设备可能已登记但从未连接）；
// 2. 在线性来自 SourceServerConnectionManager 的 online connection（updating 也算离线，
//    因为旧连接可能已 dispose，见 windowHostAttachmentRegistry.shouldDetachSourceSettingsAttachment）；
// 3. 服务集装配失败（旧 Source 缺配置通道）由 createSourceSettingsServiceCollection 抛出
//    `source-server.settings-unavailable`，host 入口映射为独立 code。
//
// 这里不访问 Electron/Manager 实例，便于 main 侧测试直接用 fake host 复现同一条判定链。
import {
  SourceSettingsAttachmentError,
  SourceSettingsAttachmentErrorCodes,
  type SourceSettingsAttachmentErrorCode,
} from "@zcode/shared";

export type SourceSettingsAttachmentAvailability<TConnection> =
  | { available: true; onlineConnection: TConnection }
  | { available: false; code: SourceSettingsAttachmentErrorCode; message: string };

/** 判定某个 Source 当前能否提供设置 attachment；不存在与离线必须可区分。 */
export function resolveSourceSettingsAttachmentAvailability<TConnection>(params: {
  sourceServerId: string;
  /** Directory 中登记过该设备（含未在线 / 未安装），false = 已删除或从未登记。 */
  sourceServerExists: boolean;
  /** Manager 持有的在线连接；undefined = 离线 / 正在更新 / 从未连接。 */
  onlineConnection: TConnection | undefined;
}): SourceSettingsAttachmentAvailability<TConnection> {
  if (!params.sourceServerExists) {
    return {
      available: false,
      code: SourceSettingsAttachmentErrorCodes.SourceServerNotFound,
      message: `Source Server is not registered: ${params.sourceServerId}`,
    };
  }
  if (!params.onlineConnection) {
    return {
      available: false,
      code: SourceSettingsAttachmentErrorCodes.SourceServerOffline,
      message: `Source Server is offline: ${params.sourceServerId}`,
    };
  }
  return { available: true, onlineConnection: params.onlineConnection };
}

/**
 * registry.resolveScope 的同步版本：只校验在线连接，失败抛带 code 的
 * {@link SourceSettingsAttachmentError}，由 Host 入口原样回执给 main。
 *
 * 存在性已由 Host 入口在 attach 前用 Directory 快照校验（async），这里再查一次 Manager
 * 是为了 TOCTOU：判定后连接可能刚好断开，此时必须 fail-closed 而不是暴露空服务集。
 */
export function requireSourceSettingsOnlineConnection<TConnection>(params: {
  sourceServerId: string;
  onlineConnection: TConnection | undefined;
}): TConnection {
  if (!params.onlineConnection) {
    throw new SourceSettingsAttachmentError(
      SourceSettingsAttachmentErrorCodes.SourceServerOffline,
      `Source Server is offline: ${params.sourceServerId}`,
    );
  }
  return params.onlineConnection;
}

/** 把 Host 侧任意异常收敛成可回执的结构化失败（未知异常一律 attach-rejected）。 */
export function toSourceSettingsAttachmentFailure(error: unknown): {
  code: SourceSettingsAttachmentErrorCode;
  message: string;
} {
  if (error instanceof SourceSettingsAttachmentError) {
    // SourceSettingsAttachmentError.message 自带 `${code}: ` 前缀；回执里 code 是独立字段，
    // 这里剥掉前缀，避免 renderer 最终显示成「code: code: message」。
    const prefix = `${error.code}: `;
    return {
      code: error.code,
      message: error.message.startsWith(prefix)
        ? error.message.slice(prefix.length)
        : error.message,
    };
  }
  if (error instanceof Error) {
    return { code: SourceSettingsAttachmentErrorCodes.AttachRejected, message: error.message };
  }
  return { code: SourceSettingsAttachmentErrorCodes.AttachRejected, message: String(error) };
}
