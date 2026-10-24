/**
 * Source 设置面 attachment 的跨进程契约（backlog-sweep Step 11 收口）。
 *
 * 链路：renderer `requestSourceSettingsAttachment(sourceServerId)`
 * → preload `PlatformChannels.RequestSourceSettingsAttachment`
 * → main 向窗口 Host 发 `attach-service-port`（scope=`source-settings`）
 * → Host `resolveScope` 用在线 Source 的 accessor 装配远端配置服务集，并回执
 *   `HostResponseTypes.SourceSettingsAttachmentResult`
 * → main 通过 `InternalChannels.SourceSettingsServicePort` 把 MessagePort 交给 renderer
 * → renderer `registerSourceSettingsServices` 登记，供设置页按 Source 读取远端配置。
 *
 * 错误码是整条链唯一可读口径：设备不存在、离线、Source 版本缺通道、Host 不可用必须各自
 * 返回明确 code，不允许静默 null 或折叠成同一条模糊错误。跨 contextBridge / IPC 时 Error
 * 的自定义字段可能丢失，因此 message 统一带上 `code: ` 前缀，code 本身仍保留在结构化结果里。
 */
export const SourceSettingsAttachmentErrorCodes = {
  /** 请求载荷缺 sourceServerId（preload/main 参数校验失败）。 */
  InvalidSourceServerId: "invalid-source-server-id",
  /** 当前平台没有该能力（Web、旧 preload，或 main 未接线）。 */
  Unsupported: "unsupported",
  /** 当前窗口没有可用的 Local Host 进程。 */
  HostUnavailable: "host-unavailable",
  /** Directory 中不存在该设备（已删除或从未登记）。 */
  SourceServerNotFound: "source-server-not-found",
  /** 设备存在但当前不在线（含 updating/disconnected）。 */
  SourceServerOffline: "source-server-offline",
  /** 在线 Source 缺少配置通道（旧版本 Source 未实现 settings collection）。 */
  SourceServerSettingsUnavailable: "source-server-settings-unavailable",
  /** Host 装配 attachment 失败（其他异常）。 */
  AttachRejected: "attach-rejected",
  /** Host 在超时内没有回执（Host 卡住或已退出）。 */
  AttachTimeout: "attach-timeout",
} as const;

export type SourceSettingsAttachmentErrorCode =
  (typeof SourceSettingsAttachmentErrorCodes)[keyof typeof SourceSettingsAttachmentErrorCodes];

/** `PlatformChannels.RequestSourceSettingsAttachment` 的成功回执。 */
export interface SourceSettingsAttachmentIpcSuccess {
  ok: true;
  attachmentId: string;
}

/** `PlatformChannels.RequestSourceSettingsAttachment` 的失败回执。 */
export interface SourceSettingsAttachmentIpcFailure {
  ok: false;
  code: SourceSettingsAttachmentErrorCode;
  message: string;
}

export type SourceSettingsAttachmentIpcResult =
  | SourceSettingsAttachmentIpcSuccess
  | SourceSettingsAttachmentIpcFailure;

/**
 * 结构性失败错误：preload 把 IPC 回执解包成 throw，调用方（UI/平台层）能按 code 分支。
 * `message` 已包含 code，便于跨 contextBridge 后仍可读。
 */
export class SourceSettingsAttachmentError extends Error {
  public readonly code: SourceSettingsAttachmentErrorCode;

  public constructor(code: SourceSettingsAttachmentErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SourceSettingsAttachmentError";
    this.code = code;
  }
}

const errorCodeValues = new Set<string>(Object.values(SourceSettingsAttachmentErrorCodes));

export function isSourceSettingsAttachmentErrorCode(
  value: unknown,
): value is SourceSettingsAttachmentErrorCode {
  return typeof value === "string" && errorCodeValues.has(value);
}

/**
 * preload 侧解包 IPC 回执的唯一实现：成功返回 `{ attachmentId }`，失败抛带 code 的错误。
 * 旧 main（返回 undefined）与畸形回执一律按 `unsupported` 处理，绝不返回静默 null。
 */
export function unwrapSourceSettingsAttachmentIpcResult(value: unknown): {
  attachmentId: string;
} {
  if (value && typeof value === "object" && "ok" in value) {
    const record = value as {
      ok?: unknown;
      attachmentId?: unknown;
      code?: unknown;
      message?: unknown;
    };
    if (record.ok === true && typeof record.attachmentId === "string") {
      const attachmentId = record.attachmentId.trim();
      if (attachmentId) return { attachmentId };
    }
    if (record.ok === false) {
      const code = isSourceSettingsAttachmentErrorCode(record.code)
        ? record.code
        : SourceSettingsAttachmentErrorCodes.AttachRejected;
      const message =
        typeof record.message === "string" && record.message.trim()
          ? record.message
          : "Source settings attachment failed";
      throw new SourceSettingsAttachmentError(code, message);
    }
  }
  throw new SourceSettingsAttachmentError(
    SourceSettingsAttachmentErrorCodes.Unsupported,
    "Source settings attachment IPC returned no usable result",
  );
}
