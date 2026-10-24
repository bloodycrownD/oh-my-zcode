// Renderer → main 的 Source 设置 attachment 申请：main 侧唯一实现（backlog-sweep Step 11）。
//
// 与既有的 `ScopedServicePort` 链同形，但 source-settings 是「按需申请、无 session 语义」：
// 1. 校验 renderer 载荷（sourceServerId 必填）；
// 2. 找到该窗口的 Local Host，创建 MessageChannelMain；
// 3. 向 Host 发 `attach-service-port`（scope=`source-settings`），Host 用在线 Source 的
//    accessor 装配配置服务集；
// 4. 等 Host 回执 `source-settings-attachment-result`——只有 ok 才把 port1 投给 renderer；
// 5. 失败按 code 返回结构化回执，不把错误对象直接抛过 IPC（Electron 会把自定义字段抹掉）。
//
// 回执链是刻意多出来的一跳（上游直接投端口）：没有它就无法区分「设备不存在 / 离线 /
// Source 版本缺通道」，只能让 renderer 拿着一个注定不可用的端口等 RPC 超时。
import { randomUUID } from "node:crypto";
import {
  HostMessageTypes,
  InternalChannels,
  SourceSettingsAttachmentErrorCodes,
  hostSourceSettingsAttachmentResultResponseSchema,
  isSourceSettingsAttachmentErrorCode,
  sourceSettingsAttachmentRequestSchema,
  type HostSourceSettingsAttachmentResultResponse,
  type SourceSettingsAttachmentErrorCode,
  type SourceSettingsAttachmentIpcResult,
} from "@zcode/shared";

/** main 只依赖 Host 进程的最小子集，单测用 fake host 替换。 */
export interface SourceSettingsAttachmentHost {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
}

/** main 只依赖 renderer 的 webContents 最小子集（id + postMessage + transfer）。 */
export interface SourceSettingsAttachmentRenderer {
  readonly id: number;
  postMessage(channel: string, message: unknown, transfer?: readonly unknown[]): void;
}

/**
 * 一对已创建的端口。两个 close 分开暴露：`hostPort` 一旦 postMessage 就已 transfer 给 Host，
 * 此时只能由 Host 侧关闭；main 只在尚未投递时关闭 renderer 端。
 */
export interface SourceSettingsAttachmentPortPair {
  rendererPort: unknown;
  hostPort: unknown;
  closeRendererPort(): void;
  closeHostPort(): void;
}

export interface SourceSettingsAttachmentBrokerOptions {
  getHost(webContentsId: number): SourceSettingsAttachmentHost | undefined;
  createPorts(): SourceSettingsAttachmentPortPair;
  /** Host 回执超时；默认 15s，与远程 renderer attachment ready 超时同量级。 */
  timeoutMs?: number;
}

export interface SourceSettingsAttachmentBroker {
  request(
    renderer: SourceSettingsAttachmentRenderer,
    rawPayload: unknown,
  ): Promise<SourceSettingsAttachmentIpcResult>;
  /** 进程退出/窗口销毁时清理未决申请，避免 Promise 永远挂起。 */
  dispose(): void;
}

export const DEFAULT_SOURCE_SETTINGS_ATTACHMENT_TIMEOUT_MS = 15_000;

interface PendingSourceSettingsRequest {
  renderer: SourceSettingsAttachmentRenderer;
  host: SourceSettingsAttachmentHost;
  sourceServerId: string;
  ports: SourceSettingsAttachmentPortPair;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: SourceSettingsAttachmentIpcResult) => void;
}

function failure(
  code: SourceSettingsAttachmentErrorCode,
  message: string,
): SourceSettingsAttachmentIpcResult {
  return { ok: false, code, message };
}

export function createSourceSettingsAttachmentBroker(
  options: SourceSettingsAttachmentBrokerOptions,
): SourceSettingsAttachmentBroker {
  const pending = new Map<string, PendingSourceSettingsRequest>();
  const listenedHosts = new WeakSet<object>();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOURCE_SETTINGS_ATTACHMENT_TIMEOUT_MS;

  const settleFailure = (
    attachmentId: string,
    entry: PendingSourceSettingsRequest,
    code: SourceSettingsAttachmentErrorCode,
    message: string,
  ): void => {
    pending.delete(attachmentId);
    clearTimeout(entry.timer);
    entry.ports.closeRendererPort();
    entry.resolve(failure(code, message));
  };

  const handleHostResult = (result: HostSourceSettingsAttachmentResultResponse): void => {
    const entry = pending.get(result.attachmentId);
    // 超时或 dispose 之后的迟到回执：端口已作废，直接丢弃。
    if (!entry) return;
    if (!result.ok) {
      settleFailure(
        result.attachmentId,
        entry,
        isSourceSettingsAttachmentErrorCode(result.code)
          ? result.code
          : SourceSettingsAttachmentErrorCodes.AttachRejected,
        result.message ?? "Source settings attachment rejected by host",
      );
      return;
    }
    try {
      // 只有 Host 确认服务集可装配后才把端口交给 renderer；port1 在此处 transfer，
      // renderer 的 preload 会转投到 window context，最终由 sourceSettingsServicePortBridge 注册。
      entry.renderer.postMessage(
        InternalChannels.SourceSettingsServicePort,
        { attachmentId: result.attachmentId, sourceServerId: entry.sourceServerId },
        [entry.ports.rendererPort],
      );
    } catch (error) {
      // 端口没投递成功：Host 侧 attachment 已经建立，必须显式 detach，否则只能等窗口关闭回收。
      try {
        entry.host.postMessage({
          type: HostMessageTypes.DetachServicePort,
          attachmentId: result.attachmentId,
        });
      } catch {
        // Host 已退出时 detach 也发不出去，按失败回执收尾即可。
      }
      settleFailure(
        result.attachmentId,
        entry,
        SourceSettingsAttachmentErrorCodes.AttachRejected,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    pending.delete(result.attachmentId);
    clearTimeout(entry.timer);
    entry.resolve({ ok: true, attachmentId: result.attachmentId });
  };

  const ensureHostListener = (host: SourceSettingsAttachmentHost): void => {
    if (listenedHosts.has(host)) return;
    listenedHosts.add(host);
    host.on("message", (message: unknown) => {
      const parsed = hostSourceSettingsAttachmentResultResponseSchema.safeParse(message);
      if (parsed.success) handleHostResult(parsed.data);
    });
  };

  return {
    request(renderer, rawPayload) {
      const parsed = sourceSettingsAttachmentRequestSchema.safeParse(rawPayload);
      if (!parsed.success) {
        return Promise.resolve(
          failure(
            SourceSettingsAttachmentErrorCodes.InvalidSourceServerId,
            "sourceServerId is required",
          ),
        );
      }
      const sourceServerId = parsed.data.sourceServerId.trim();
      const host = options.getHost(renderer.id);
      if (!host) {
        return Promise.resolve(
          failure(
            SourceSettingsAttachmentErrorCodes.HostUnavailable,
            `Desktop Window Host is unavailable, windowId=${renderer.id}`,
          ),
        );
      }

      const attachmentId = `source-settings-${randomUUID()}`;
      const ports = options.createPorts();
      ensureHostListener(host);

      return new Promise<SourceSettingsAttachmentIpcResult>((resolve) => {
        const timer = setTimeout(() => {
          const entry = pending.get(attachmentId);
          if (!entry) return;
          // best-effort 清理：Host 可能只是慢，晚到的 attachment 会在 detach 里被释放。
          try {
            host.postMessage({ type: HostMessageTypes.DetachServicePort, attachmentId });
          } catch {
            // Host 已退出时 detach 也发不出去；超时错误本身已足以让 renderer 停在 unavailable。
          }
          settleFailure(
            attachmentId,
            entry,
            SourceSettingsAttachmentErrorCodes.AttachTimeout,
            `Source settings attachment timed out after ${timeoutMs}ms`,
          );
        }, timeoutMs);
        // 不 unref：这是 renderer 正在等待的请求，超时必须真实触发（main 的事件循环常驻，
        // 不会因这一个 timer 阻止退出；退出路径由 dispose() 清理）。
        pending.set(attachmentId, {
          renderer,
          host,
          sourceServerId,
          ports,
          timer,
          resolve,
        });

        try {
          host.postMessage(
            {
              type: HostMessageTypes.AttachServicePort,
              requestId: randomUUID(),
              attachmentId,
              clientMode: "desktop-continuous",
              scope: { kind: "source-settings", sourceServerId },
            },
            [ports.hostPort],
          );
        } catch (error) {
          pending.delete(attachmentId);
          clearTimeout(timer);
          ports.closeRendererPort();
          ports.closeHostPort();
          resolve(
            failure(
              SourceSettingsAttachmentErrorCodes.AttachRejected,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      });
    },

    dispose() {
      for (const [attachmentId, entry] of pending) {
        pending.delete(attachmentId);
        clearTimeout(entry.timer);
        entry.ports.closeRendererPort();
        entry.resolve(
          failure(
            SourceSettingsAttachmentErrorCodes.HostUnavailable,
            "Source settings attachment broker disposed",
          ),
        );
      }
    },
  };
}
