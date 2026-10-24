/**
 * T-SS2（backlog-sweep Step 11 收口）：Source 设置 attachment 主链契约与 main/host 装配。
 *
 * 形态：无 Electron、无 jsdom。main broker 与 Host scope 判定都是生产代码，fake 的只有
 * 「窗口 Host 进程」和「renderer webContents」这两个 IPC 端点：
 *
 *   broker.request(renderer, payload)                       ← renderer 请求
 *     → host.postMessage(attach-service-port, scope=source-settings)
 *     → fake host 走真实判定链（Directory 存在性 + online + scope resolver）
 *     → host 回执 source-settings-attachment-result
 *     → broker 把 MessagePort 投给 renderer（SourceSettingsServicePort）
 *
 * 断言重点：Host 的 `resolveScope` 真被调用、端口真被返回、失败码逐类可读（不存在/离线/
 * 不支持/无 Host/超时），而不是源码字符串存在性检查。
 *
 * 运行：node --import tsx --test packages/desktop/test/sourceSettingsAttachmentChannel.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  HostMessageTypes,
  HostResponseTypes,
  InternalChannels,
  PlatformChannels,
  SourceSettingsAttachmentError,
  SourceSettingsAttachmentErrorCodes,
  hostIncomingMessageSchema,
  hostResponseMessageSchema,
  hostSourceSettingsAttachmentResultResponseSchema,
  sourceSettingsAttachmentRequestSchema,
  sourceSettingsServicePortPayloadSchema,
  unwrapSourceSettingsAttachmentIpcResult,
  type HostSourceSettingsAttachmentResultResponse,
  type WindowHostAttachmentScope,
} from "@zcode/shared";
import {
  requireSourceSettingsOnlineConnection,
  resolveSourceSettingsAttachmentAvailability,
  toSourceSettingsAttachmentFailure,
} from "../src/host/sourceSettingsAttachmentScope.js";
import { createWindowHostAttachmentRegistry } from "../src/host/windowHostAttachmentRegistry.js";
import {
  createSourceSettingsAttachmentBroker,
  type SourceSettingsAttachmentHost,
  type SourceSettingsAttachmentPortPair,
  type SourceSettingsAttachmentRenderer,
} from "../src/main/sourceSettingsAttachmentBroker.js";

type FakeServices = { marker: string };

/** MessagePort 的最小 fake：注册 close 监听并可幂等关闭。 */
class FakePort {
  public closed = false;
  private readonly closeListeners: Array<() => void> = [];

  public once(_event: "close", listener: () => void): this {
    this.closeListeners.push(listener);
    return this;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners.splice(0)) listener();
  }
}

interface RendererDelivery {
  channel: string;
  message: { attachmentId?: string; sourceServerId?: string };
  port: FakePort;
}

/**
 * 窗口 Host 的 fake：只替换 Electron 的 message transport，判定与 registry 全用生产实现。
 * 与 host/index.ts 的 AttachServicePort 分支同序：存在性/在线判定 → registry.attach → 回执。
 */
class FakeWindowHost implements SourceSettingsAttachmentHost {
  public readonly registeredSourceServerIds = new Set<string>();
  public readonly onlineConnections = new Map<string, { services: FakeServices }>();
  public readonly resolveScopeCalls: string[] = [];
  public readonly detachCalls: string[] = [];
  public readonly attachedAttachmentIds: string[] = [];
  public readonly registry = createWindowHostAttachmentRegistry<FakeServices, FakePort>({
    resolveScope: (scope) => {
      if (scope.kind !== "source-settings") throw new Error("unexpected-scope");
      this.resolveScopeCalls.push(scope.sourceServerId);
      if (this.scopeFailure) throw this.scopeFailure;
      // 生产 host/index.ts 的同一调用：online 判定 + fail-closed。
      const connection = requireSourceSettingsOnlineConnection({
        sourceServerId: scope.sourceServerId,
        onlineConnection: this.onlineConnections.get(scope.sourceServerId),
      });
      return { services: connection.services, generation: 1 };
    },
    expose: ({ attachmentId, port }) => {
      this.attachedAttachmentIds.push(attachmentId);
      return {
        dispose: () => port.close(),
      };
    },
  });
  public scopeFailure: Error | null = null;
  public ignoreAttach = false;
  private readonly listeners = new Set<(message: unknown) => void>();

  public on(_event: "message", listener: (message: unknown) => void): this {
    this.listeners.add(listener);
    return this;
  }

  public postMessage(rawMessage: unknown, transfer?: readonly unknown[]): void {
    const message = rawMessage as Record<string, unknown>;
    if (message.type === HostMessageTypes.DetachServicePort) {
      this.detachCalls.push(String(message.attachmentId));
      this.registry.detach(String(message.attachmentId));
      return;
    }
    if (message.type !== HostMessageTypes.AttachServicePort) return;
    if (this.ignoreAttach) return;

    const requestId = String(message.requestId);
    const attachmentId = String(message.attachmentId);
    const scope = message.scope as {
      kind: string;
      sourceServerId?: string;
    };
    const port = transfer?.[0] as FakePort | undefined;
    assert.equal(scope.kind, "source-settings");
    const sourceServerId = scope.sourceServerId ?? "";

    // 与 host/index.ts 前置判定完全同序：Directory 存在性 → Manager 在线性。
    const availability = resolveSourceSettingsAttachmentAvailability({
      sourceServerId,
      sourceServerExists: this.registeredSourceServerIds.has(sourceServerId),
      onlineConnection: this.onlineConnections.get(sourceServerId),
    });
    if (!availability.available) {
      port?.close();
      this.emitResult({
        requestId,
        attachmentId,
        ok: false,
        code: availability.code,
        message: availability.message,
      });
      return;
    }

    try {
      this.registry.attach({
        requestId,
        attachmentId,
        clientMode: message.clientMode as "desktop-continuous",
        scope: message.scope as WindowHostAttachmentScope,
        port: port as FakePort,
      });
      this.emitResult({ requestId, attachmentId, ok: true });
    } catch (error) {
      port?.close();
      this.emitResult({
        requestId,
        attachmentId,
        ok: false,
        ...toSourceSettingsAttachmentFailure(error),
      });
    }
  }

  private emitResult(params: Omit<HostSourceSettingsAttachmentResultResponse, "type">): void {
    const message: HostSourceSettingsAttachmentResultResponse = {
      type: HostResponseTypes.SourceSettingsAttachmentResult,
      ...params,
    };
    for (const listener of this.listeners) listener(message);
  }
}

function createRenderer(): {
  renderer: SourceSettingsAttachmentRenderer;
  deliveries: RendererDelivery[];
} {
  const deliveries: RendererDelivery[] = [];
  return {
    deliveries,
    renderer: {
      id: 7,
      postMessage(channel, message, transfer) {
        deliveries.push({
          channel,
          message: message as RendererDelivery["message"],
          port: transfer?.[0] as FakePort,
        });
      },
    },
  };
}

function createPorts(): {
  ports: SourceSettingsAttachmentPortPair;
  rendererPort: FakePort;
  hostPort: FakePort;
} {
  const rendererPort = new FakePort();
  const hostPort = new FakePort();
  return {
    rendererPort,
    hostPort,
    ports: {
      rendererPort,
      hostPort,
      closeRendererPort: () => rendererPort.close(),
      closeHostPort: () => hostPort.close(),
    },
  };
}

const ONLINE_SOURCE_ID = "7c1e3f52-3ad9-4a4c-9a52-6d4b9f1f0f01";
const OFFLINE_SOURCE_ID = "7c1e3f52-3ad9-4a4c-9a52-6d4b9f1f0f02";
const MISSING_SOURCE_ID = "7c1e3f52-3ad9-4a4c-9a52-6d4b9f1f0f03";

function createOnlineHost(): FakeWindowHost {
  const host = new FakeWindowHost();
  host.registeredSourceServerIds.add(ONLINE_SOURCE_ID);
  host.registeredSourceServerIds.add(OFFLINE_SOURCE_ID);
  host.onlineConnections.set(ONLINE_SOURCE_ID, { services: { marker: "remote" } });
  return host;
}

// ---------- ① 共享协议契约 ----------

test("T-SS2 契约：频道名与 zod schema 覆盖 renderer→main→host→renderer 三段", () => {
  assert.equal(
    PlatformChannels.RequestSourceSettingsAttachment,
    "zcode:request-source-settings-attachment",
  );
  assert.equal(InternalChannels.SourceSettingsServicePort, "zcode:source-settings-service-port");
  assert.equal(
    HostResponseTypes.SourceSettingsAttachmentResult,
    "source-settings-attachment-result",
  );

  assert.ok(
    sourceSettingsAttachmentRequestSchema.safeParse({ sourceServerId: "source-a" }).success,
  );
  assert.equal(
    sourceSettingsAttachmentRequestSchema.safeParse({ sourceServerId: "" }).success,
    false,
    "空 sourceServerId 必须是 invalid-source-server-id，不能落到 host",
  );
  assert.equal(
    sourceSettingsAttachmentRequestSchema.safeParse({ sourceServerId: "a", extra: 1 }).success,
    false,
    "请求载荷保持 strict，避免跨版本字段漂移",
  );

  assert.ok(
    sourceSettingsServicePortPayloadSchema.safeParse({
      attachmentId: "source-settings-a",
      sourceServerId: "source-a",
    }).success,
  );
  assert.equal(
    sourceSettingsServicePortPayloadSchema.safeParse({ attachmentId: "source-settings-a" }).success,
    false,
  );

  const attachMessage = {
    type: HostMessageTypes.AttachServicePort,
    requestId: "req-1",
    attachmentId: "source-settings-a",
    clientMode: "desktop-continuous",
    scope: { kind: "source-settings", sourceServerId: ONLINE_SOURCE_ID },
  };
  assert.ok(hostIncomingMessageSchema.safeParse(attachMessage).success);
  assert.equal(
    hostIncomingMessageSchema.safeParse({
      ...attachMessage,
      scope: { kind: "source-settings" },
    }).success,
    false,
  );

  const okResult = {
    type: HostResponseTypes.SourceSettingsAttachmentResult,
    requestId: "req-1",
    attachmentId: "source-settings-a",
    ok: true,
  };
  assert.ok(hostSourceSettingsAttachmentResultResponseSchema.safeParse(okResult).success);
  // desktopHostProcess 只用 hostResponseMessageSchema 过滤 Host 消息：漏登记会让回执被丢弃。
  assert.ok(
    hostResponseMessageSchema.safeParse(okResult).success,
    "Host 回执必须进入 hostResponseMessageSchema，否则 main 永远等不到结果",
  );
  assert.equal(
    hostResponseMessageSchema.safeParse({ ...okResult, attachmentId: "" }).success,
    false,
  );
});

test("T-SS2 preload 解包：成功返回 attachmentId，失败按 code 抛可读错误", () => {
  // 与 preload/index.ts 调用的是同一个共享实现。
  const unwrap = unwrapSourceSettingsAttachmentIpcResult;
  assert.deepEqual(unwrap({ ok: true, attachmentId: "source-settings-a" }), {
    attachmentId: "source-settings-a",
  });
  assert.throws(
    () =>
      unwrap({
        ok: false,
        code: SourceSettingsAttachmentErrorCodes.SourceServerOffline,
        message: "Source Server is offline",
      }),
    (error: unknown) =>
      error instanceof SourceSettingsAttachmentError &&
      error.code === SourceSettingsAttachmentErrorCodes.SourceServerOffline &&
      error.message.includes("source-server-offline"),
  );
  assert.throws(
    () => unwrap(undefined),
    (error: unknown) =>
      error instanceof SourceSettingsAttachmentError &&
      error.code === SourceSettingsAttachmentErrorCodes.Unsupported,
    "旧 main 返回 undefined 时必须显式 unsupported，不允许静默 null",
  );
});

// ---------- ② 主链：renderer 请求 → host resolveScope → 端口返回 ----------

test("T-SS2 主链：renderer 请求 → host resolveScope(source-settings, id) → 端口回投 renderer", async () => {
  const host = createOnlineHost();
  const { renderer, deliveries } = createRenderer();
  const { ports, rendererPort, hostPort } = createPorts();
  const broker = createSourceSettingsAttachmentBroker({
    getHost: (webContentsId) => (webContentsId === renderer.id ? host : undefined),
    createPorts: () => ports,
  });

  const result = await broker.request(renderer, { sourceServerId: ONLINE_SOURCE_ID });

  assert.equal(result.ok, true);
  assert.match(
    result.ok ? result.attachmentId : "",
    /^source-settings-/,
    "成功回执必须带 attachmentId",
  );
  assert.deepEqual(
    host.resolveScopeCalls,
    [ONLINE_SOURCE_ID],
    "host 必须按 source-settings scope 解析",
  );
  assert.equal(host.registry.list().length, 1, "生产 registry 必须真的持有一个 attachment");
  const attachmentScope = host.registry.list()[0]?.scope;
  assert.equal(attachmentScope?.kind, "source-settings");
  assert.equal(
    attachmentScope?.kind === "source-settings" ? attachmentScope.sourceServerId : undefined,
    ONLINE_SOURCE_ID,
  );
  assert.equal(host.attachedAttachmentIds[0], result.ok ? result.attachmentId : undefined);

  assert.equal(deliveries.length, 1, "只有 Host 回执 ok 后才允许把端口交给 renderer");
  assert.equal(deliveries[0]?.channel, InternalChannels.SourceSettingsServicePort);
  assert.equal(deliveries[0]?.message.attachmentId, result.ok ? result.attachmentId : undefined);
  assert.equal(deliveries[0]?.message.sourceServerId, ONLINE_SOURCE_ID);
  assert.equal(deliveries[0]?.port, rendererPort);
  assert.equal(rendererPort.closed, false, "成功投递的端口不能被 main 关闭");
  assert.equal(hostPort.closed, false, "hostPort 已 transfer 给 Host，main 不再关闭");
});

// ---------- ③ 失败可读：存在性 / 在线性 / Host / 载荷 / 超时 ----------

test("T-SS2 失败：设备不存在返回 source-server-not-found，且不投递端口", async () => {
  const host = createOnlineHost();
  const { renderer, deliveries } = createRenderer();
  const { ports, rendererPort } = createPorts();
  const broker = createSourceSettingsAttachmentBroker({
    getHost: () => host,
    createPorts: () => ports,
  });

  const result = await broker.request(renderer, { sourceServerId: MISSING_SOURCE_ID });

  assert.deepEqual(result, {
    ok: false,
    code: SourceSettingsAttachmentErrorCodes.SourceServerNotFound,
    message: `Source Server is not registered: ${MISSING_SOURCE_ID}`,
  });
  assert.deepEqual(host.resolveScopeCalls, [], "不存在的设备不应进入 scope resolver");
  assert.equal(deliveries.length, 0);
  assert.equal(rendererPort.closed, true);
});

test("T-SS2 失败：设备存在但离线返回 source-server-offline，且不投递端口", async () => {
  const host = createOnlineHost();
  const { renderer, deliveries } = createRenderer();
  const { ports, rendererPort } = createPorts();
  const broker = createSourceSettingsAttachmentBroker({
    getHost: () => host,
    createPorts: () => ports,
  });

  const result = await broker.request(renderer, { sourceServerId: OFFLINE_SOURCE_ID });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? "" : result.code,
    SourceSettingsAttachmentErrorCodes.SourceServerOffline,
  );
  assert.deepEqual(host.resolveScopeCalls, []);
  assert.equal(deliveries.length, 0);
  assert.equal(rendererPort.closed, true);
});

test("T-SS2 失败：在线 Source 缺配置通道返回 source-server-settings-unavailable", async () => {
  const host = createOnlineHost();
  host.scopeFailure = new SourceSettingsAttachmentError(
    SourceSettingsAttachmentErrorCodes.SourceServerSettingsUnavailable,
    "source-server.settings-unavailable: ISkillsService",
  );
  const { renderer, deliveries } = createRenderer();
  const { ports } = createPorts();
  const broker = createSourceSettingsAttachmentBroker({
    getHost: () => host,
    createPorts: () => ports,
  });

  const result = await broker.request(renderer, { sourceServerId: ONLINE_SOURCE_ID });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? "" : result.code,
    SourceSettingsAttachmentErrorCodes.SourceServerSettingsUnavailable,
  );
  assert.equal(deliveries.length, 0);
});

test("T-SS2 失败：无窗口 Host / 非法载荷都返回结构化 code", async () => {
  const { renderer, deliveries } = createRenderer();
  const { ports } = createPorts();
  const broker = createSourceSettingsAttachmentBroker({
    getHost: () => undefined,
    createPorts: () => ports,
  });

  assert.deepEqual(await broker.request(renderer, { sourceServerId: ONLINE_SOURCE_ID }), {
    ok: false,
    code: SourceSettingsAttachmentErrorCodes.HostUnavailable,
    message: "Desktop Window Host is unavailable, windowId=7",
  });
  assert.deepEqual(await broker.request(renderer, {}), {
    ok: false,
    code: SourceSettingsAttachmentErrorCodes.InvalidSourceServerId,
    message: "sourceServerId is required",
  });
  assert.equal(deliveries.length, 0);
});

test("T-SS2 失败：Host 不回执时超时返回 attach-timeout 并 detach 清理", async () => {
  const host = createOnlineHost();
  host.ignoreAttach = true;
  const { renderer, deliveries } = createRenderer();
  const { ports, rendererPort } = createPorts();
  const broker = createSourceSettingsAttachmentBroker({
    getHost: () => host,
    createPorts: () => ports,
    timeoutMs: 20,
  });

  const result = await broker.request(renderer, { sourceServerId: ONLINE_SOURCE_ID });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.code, SourceSettingsAttachmentErrorCodes.AttachTimeout);
  assert.equal(deliveries.length, 0);
  assert.equal(rendererPort.closed, true);
  assert.equal(host.detachCalls.length, 1, "超时必须尽力 detach，避免 Host 迟到的 attachment 泄漏");
  broker.dispose();
});

test("T-SS2 失败：renderer 端口投递失败时收回 Host attachment", async () => {
  const host = createOnlineHost();
  const renderer: SourceSettingsAttachmentRenderer = {
    id: 7,
    postMessage() {
      throw new Error("renderer destroyed");
    },
  };
  const { ports } = createPorts();
  const broker = createSourceSettingsAttachmentBroker({
    getHost: () => host,
    createPorts: () => ports,
  });

  const result = await broker.request(renderer, { sourceServerId: ONLINE_SOURCE_ID });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.code, SourceSettingsAttachmentErrorCodes.AttachRejected);
  assert.deepEqual(host.detachCalls, [host.attachedAttachmentIds[0]]);
  assert.equal(host.registry.list().length, 0, "投递失败的 attachment 不能留在 Host 里");
});

test("T-SS2 dispose：未决申请收尾为 host-unavailable，端口关闭", async () => {
  const host = createOnlineHost();
  host.ignoreAttach = true;
  const { renderer, deliveries } = createRenderer();
  const { ports, rendererPort } = createPorts();
  const broker = createSourceSettingsAttachmentBroker({
    getHost: () => host,
    createPorts: () => ports,
    timeoutMs: 5_000,
  });

  const pending = broker.request(renderer, { sourceServerId: ONLINE_SOURCE_ID });
  broker.dispose();
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.code, SourceSettingsAttachmentErrorCodes.HostUnavailable);
  assert.equal(deliveries.length, 0);
  assert.equal(rendererPort.closed, true);
});
