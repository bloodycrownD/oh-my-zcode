import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import { registerMcpTools, traceContextToLogContext } from "../deps.js";
import type { McpConnectionSnapshot, McpServerConfig, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS = 15_000;

/**
 * startup 快照不完整时，补注册最多尝试的回合数。
 *
 * 触发场景：会话启动只等 15s（authorization_code 类 server 会在这段时间里一直 connecting），
 * 快照返回时 tools 为空；一次性门闩 `mcpToolsRegistered` 会把这份空工具面永久固化，
 * 此后 server 连上了也没有任何路径把它注册进 registry —— 表现就是「会话里看不到 MCP 工具」。
 *
 * 补注册挂在 turn 边界（turn-loop 每回合都会 await initializeMcp），只做 registry diff、
 * 不重新连接，所以单次成本是一次 status() + listTools()。上限存在的意义是：server 真的坏掉时
 * 不能每回合都去摸一遍；到上限后回到原来的一次性语义，设置页热刷新仍然可以救回来。
 */
const MCP_TOOL_SETTLE_MAX_ATTEMPTS = 5;

/** 快照里还有 server 停在 connecting（或压根没拿到状态）时，工具面就还不是终态。 */
function mcpSnapshotStillConnecting(
  snapshot: McpConnectionSnapshot,
  serverCount: number,
): boolean {
  if (serverCount === 0) return false;
  const statuses = Object.values(snapshot.statuses ?? {});
  if (statuses.length === 0) return true;
  return statuses.some((status) => status.status === "connecting");
}

/**
 * `serverName:status` 指纹（回移 3ef91590 的替代品）。
 *
 * 1.1.x 靠 adapter 的 `toolListRevision` 让 core 发现「工具面变了」；1.0.x 没有这个信号，
 * 于是用连接状态指纹：断开、重连成功、被停用都会改变指纹，据此重新武装一次补注册。
 */
function mcpStatusSignature(statuses: Record<string, { status: string }>): string {
  return Object.entries(statuses)
    .map(([name, status]) => `${name}:${status.status}`)
    .sort()
    .join("|");
}

/**
 * 只有同时携带 resolver 注入的官方 plugin id 和本进程私有 authority 的 server 才能共享
 * Computer Use 项目授权。server 名、tool 名和 manifest env 都可被第三方仿造，不能单独作为信任依据。
 */
export function computeOfficialCuaServerNames(
  servers: Record<string, McpServerConfig>,
  trustedServerNames: ReadonlySet<string>,
): Set<string> {
  const expectedAuthority = getCapturedZCodeCuaBrokerCredentials().pluginAuthority;
  const names = new Set<string>();
  if (!expectedAuthority) return names;

  for (const [name, config] of Object.entries(servers)) {
    if (!trustedServerNames.has(name)) continue;
    if (config.type !== "stdio") continue;
    if (
      config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() !==
        ZCODE_CUA_OFFICIAL_PLUGIN_ID ||
      config.env?.[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim() !== expectedAuthority
    ) {
      continue;
    }
    names.add(name);
  }
  return names;
}

export function startMcpStartup(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<McpConnectionSnapshot> | undefined {
  if (this.mcpInitialized) return this.mcpStartupPromise;
  this.mcpInitialized = true;

  if (!this.mcpPort || this.config.mcp?.enabled === false) {
    this.mcpToolsRegistered = true;
    return undefined;
  }

  const servers = this.config.mcp?.servers ?? {};
  if (Object.keys(servers).length === 0) {
    const startup = Promise.all([this.mcpPort.status(), this.mcpPort.listTools()])
      .then(([statuses, tools]) => ({ statuses, tools }))
      .catch((error) => {
        this.logger?.warn("MCP existing tool discovery failed", {
          ...traceContextToLogContext(traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.existing_tools.failed",
          module: "core.runtime",
          status: "failed",
        });
        return { statuses: {}, tools: [] };
      });
    this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
    return this.mcpStartupPromise;
  }

  const startedAt = Date.now();
  const startup = this.mcpPort
    .connectConfiguredServers(servers, {
      // authorization_code MCP 无人完成浏览器授权时，session 启动过去会等默认 5 分钟，
      // 导致模型请求迟迟不发出；session 只等 15s，授权入口由设置页 mcp/list 展示。
      oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
      trace: traceContext,
      workingDirectory: this.workingDirectory,
      workspaceIdentity: this.config.workspaceIdentity?.toString(),
    })
    .then((snapshot) => {
      const statusCounts = Object.values(snapshot.statuses).reduce<Record<string, number>>(
        (counts, status) => {
          counts[status.status] = (counts[status.status] ?? 0) + 1;
          return counts;
        },
        {},
      );
      this.logger?.info("MCP startup completed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        event: "mcp.startup.completed",
        module: "core.runtime",
        serverCount: Object.keys(servers).length,
        status: "completed",
        statusCounts,
        toolCount: snapshot.tools.length,
      });
      return snapshot;
    })
    .catch((error) => {
      this.logger?.warn("MCP startup failed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.startup.failed",
        module: "core.runtime",
        status: "failed",
      });
      return { statuses: {}, tools: [] };
    });
  this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
  this.logger?.debug("MCP startup scheduled", {
    ...traceContextToLogContext(traceContext),
    event: "mcp.startup.scheduled",
    module: "core.runtime",
    serverCount: Object.keys(servers).length,
    status: "started",
  });
  return this.mcpStartupPromise;
}

/**
 * 把一份连接快照投影到 registry。
 *
 * `replace: true` 是设置页热刷新的语义：以本次快照为准，消失的工具反注册（diff 基线随之替换）。
 * `replace: false` 是启动与补注册的语义：只增不减——补注册拿到的快照可能来自半连接状态，
 * 拿它当「权威集合」会把已经注册好的工具误删。
 */
function applyMcpToolSurface(
  this: AgentRuntimeInternal,
  snapshot: McpConnectionSnapshot,
  servers: Record<string, McpServerConfig>,
  options: { replace: boolean },
): { registered: string[]; removed: number } {
  const mcpPort = this.mcpPort;
  if (!mcpPort) return { registered: [], removed: 0 };

  const registered = registerMcpTools(this.registry, mcpPort, snapshot.tools ?? [], {
    allowedTools: this.config.toolAllowlist,
    disallowedTools: this.config.toolDisallowlist,
    officialCuaServerNames: computeOfficialCuaServerNames(
      servers,
      new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
    ),
  });

  let removed = 0;
  if (options.replace) {
    const desired = new Set(registered);
    for (const name of this.mcpRegisteredToolNames) {
      if (desired.has(name)) continue;
      this.registry.unregister(name);
      removed += 1;
    }
    this.mcpRegisteredToolNames = desired;
  } else {
    this.mcpRegisteredToolNames = new Set([...this.mcpRegisteredToolNames, ...registered]);
  }

  // 有新增或有反注册都必须让下一轮模型请求重新取工具表；只有「两个都为 0」时缓存仍然有效。
  if (registered.length > 0 || removed > 0) {
    this.invalidateToolCache();
  }
  return { registered, removed };
}

/**
 * 启动快照不完整时的一次补注册：只重新读 status/listTools，不重连、不动 config。
 * 由 turn 边界驱动（turn-loop 每回合 await initializeMcp），工具到齐后自然落定。
 */
async function settleMcpTools(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const attempts = (this.mcpToolSettleAttempts ?? 0) + 1;
  this.mcpToolSettleAttempts = attempts;

  const mcpPort = this.mcpPort;
  const servers = this.config.mcp?.servers ?? {};
  const serverCount = Object.keys(servers).length;
  if (!mcpPort || serverCount === 0) {
    this.mcpToolSettlePending = false;
    return;
  }

  try {
    const [statuses, tools] = await Promise.all([mcpPort.status(), mcpPort.listTools()]);
    const snapshot: McpConnectionSnapshot = { statuses, tools };
    this.mcpToolStatusSignature = mcpStatusSignature(statuses);
    const { registered } = applyMcpToolSurface.call(this, snapshot, servers, { replace: false });
    const stillConnecting = mcpSnapshotStillConnecting(snapshot, serverCount);
    this.mcpToolSettlePending = stillConnecting && attempts < MCP_TOOL_SETTLE_MAX_ATTEMPTS;
    if (registered.length > 0) {
      this.logger?.info("MCP tools settled", {
        ...traceContextToLogContext(traceContext),
        attempt: attempts,
        event: "mcp.tools.settled",
        module: "core.runtime",
        registeredToolCount: registered.length,
        serverCount,
        status: "completed",
        stillConnecting,
      });
    }
  } catch (error) {
    this.mcpToolSettlePending = attempts < MCP_TOOL_SETTLE_MAX_ATTEMPTS;
    this.logger?.warn("MCP tool settle failed", {
      ...traceContextToLogContext(traceContext),
      attempt: attempts,
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.tools.settle.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

/**
 * 已落定之后，只在连接状态指纹变化时才重新武装补注册（回移 3ef91590 的 core 侧等价物）。
 *
 * 场景：会话中途 server 掉线 → adapter 把 record 翻成 failed/disconnected（或 transport 报错
 * 直接翻转），下次工具调用前的懒重连成功后 record.tools 已刷新。1.0.x 没有 revision 信号，
 * 这里用状态指纹发现「连接面变了」，然后补一次工具面 diff，把重连后回来的工具重新注册上。
 *
 * 成本：每回合一次 status()（adapter 侧是内存读取）。健康且指纹不变时完全不碰工具面。
 */
async function rearmSettleAfterStatusChange(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const mcpPort = this.mcpPort;
  if (!mcpPort) return;
  if (Object.keys(this.config.mcp?.servers ?? {}).length === 0) return;

  let signature: string;
  try {
    signature = mcpStatusSignature(await mcpPort.status());
  } catch {
    // 状态读取失败不影响本回合；下一回合边界再判。
    return;
  }
  if (this.mcpToolStatusSignature === undefined) {
    this.mcpToolStatusSignature = signature;
    return;
  }
  if (signature === this.mcpToolStatusSignature) return;

  this.mcpToolStatusSignature = signature;
  this.mcpToolSettleAttempts = 0;
  this.mcpToolSettlePending = true;
  await settleMcpTools.call(this, traceContext);
}

export async function initializeMcp(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (this.mcpToolsRegistered) {
    if (this.mcpToolSettlePending) {
      await settleMcpTools.call(this, traceContext);
      return;
    }
    await rearmSettleAfterStatusChange.call(this, traceContext);
    return;
  }

  const startup = this.startMcpStartup(traceContext);
  const mcpPort = this.mcpPort;
  if (!startup || !mcpPort) {
    this.mcpToolsRegistered = true;
    return;
  }
  const servers = this.config.mcp?.servers ?? {};
  const serverCount = Object.keys(servers).length;

  try {
    const snapshot = await startup;
    this.mcpToolStatusSignature = mcpStatusSignature(snapshot.statuses ?? {});
    const { registered } = applyMcpToolSurface.call(this, snapshot, servers, { replace: false });
    // 快照返回时还有 server 停在 connecting：工具面不是终态，交给下一回合补注册。
    this.mcpToolSettlePending = mcpSnapshotStillConnecting(snapshot, serverCount);
    this.logger?.info("MCP tools registered", {
      ...traceContextToLogContext(traceContext),
      event: "mcp.tools.registered",
      module: "core.runtime",
      registeredToolCount: registered.length,
      serverCount,
      status: "completed",
      stillConnecting: this.mcpToolSettlePending,
    });
  } catch (error) {
    this.mcpToolsRegistered = true;
    this.logger?.warn("MCP initialization failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.initialization.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
  this.mcpToolsRegistered = true;
}

export interface McpRuntimeRefreshResult {
  serverCount: number;
  registeredToolCount: number;
  removedToolCount: number;
}

/**
 * MCP 热刷新（2026-10-14：设置页新建/改名/删除 MCP 后无需重启会话）。
 *
 * runtime 的 MCP 工具面是启动期一次性装配（initializeMcp 的 mcpToolsRegistered
 * 单次门闩 + config.mcp.servers 创建时快照），此前配置变更只能重启进程生效。
 * 本方法用 UI 下发的全量 servers 做：
 *   ① config.mcp.servers 权威替换；
 *   ② mcpPort.connectConfiguredServers（replace 语义：新增即连、消失即断）；
 *   ③ 工具面 diff——旧集合中不在新注册结果的 unregister，新工具 register，
 *      最后 invalidateToolCache 让下一轮模型请求看到新工具表。
 * 并发：turn-loop 每次 await initializeMcp（门闩挡住），refresh 与 turn 之间的
 * registry 竞态由 registry 自身同步语义兜底；busy turn 中刷新下一轮生效。
 */
export async function refreshMcpServers(
  this: AgentRuntimeInternal,
  servers: Record<string, McpServerConfig>,
  traceContext?: TraceContext,
): Promise<McpRuntimeRefreshResult> {
  const effectiveTrace = traceContext ?? this.rootTraceContext;
  if (!this.mcpPort || this.config.mcp?.enabled === false) {
    return { serverCount: 0, registeredToolCount: 0, removedToolCount: 0 };
  }
  // 竞态防护（cr-fix-spec mcp/B-2）：session 刚创建时 turn-loop 的 initializeMcp
  // 可能仍在 await startup；若 refresh 抢先完成 diff 并置门闩，晚到的 initializeMcp
  // 会用旧 snapshot.tools 重新注册旧工具并覆盖 mcpRegisteredToolNames（diff 基线
  // 污染）。这里等待初始化先落定——initializeMcp 自身幂等（门闩挡重入），已初始化
  // 完成时立即返回，不改变常规路径时序。
  if (!this.mcpToolsRegistered) {
    await this.initializeMcp(effectiveTrace);
  }
  this.config.mcp = {
    ...this.config.mcp,
    servers,
    trustedOfficialCuaServerNames: this.config.mcp?.trustedOfficialCuaServerNames ?? [],
  };
  this.mcpToolsRegistered = true;

  const snapshot = await this.mcpPort
    .connectConfiguredServers(servers, {
      // 回移 3ef91590：热刷新此前不带 revalidate——连接池对已有 entry 直接返回首次连接那个
      // 早已 resolve 的 promise（可能早已 failed），刷新实际是 no-op；带 revalidate 才会在
      // 同一 entry 上探测并原地重连。
      revalidate: true,
      oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
      trace: effectiveTrace,
      workingDirectory: this.workingDirectory,
      workspaceIdentity: this.config.workspaceIdentity?.toString(),
    })
    .catch((error: unknown) => {
      this.logger?.warn("MCP refresh connection failed", {
        ...traceContextToLogContext(effectiveTrace),
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.refresh.connect.failed",
        module: "core.runtime",
        status: "failed",
      });
      return { statuses: {}, tools: [] } satisfies McpConnectionSnapshot;
    });

  const { registered, removed: removedToolCount } = applyMcpToolSurface.call(this, snapshot, servers, {
    replace: true,
  });
  // 设置页刷新是权威快照：它把工具面重新定死，补注册的残余状态随之作废。
  this.mcpToolSettlePending = false;
  this.mcpToolSettleAttempts = 0;
  this.logger?.info("MCP tools refreshed", {
    ...traceContextToLogContext(effectiveTrace),
    event: "mcp.tools.refreshed",
    module: "core.runtime",
    registeredToolCount: registered.length,
    removedToolCount,
    serverCount: Object.keys(servers).length,
    status: "completed",
  });
  return {
    serverCount: Object.keys(servers).length,
    registeredToolCount: registered.length,
    removedToolCount,
  };
}
