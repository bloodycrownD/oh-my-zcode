import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import { registerMcpTools, traceContextToLogContext } from "../deps.js";
import { toModelVisibleMcpNamePart } from "../../mcp/name.js";
import type { McpConnectionSnapshot, McpServerConfig, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { McpToolDescriptor, PluginReferenceCatalog } from "@zcode/contracts";

const MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS = 15_000;

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
  // 开闸这一刻采样基线 revision：为什么必须在这里采、以及 `undefined` 的语义见
  // internal.ts 的 mcpStartupRevisionAtStart（唯一权威解释，这里只留短引用）。
  // 生命周期与 mcpInitialized / mcpToolsRegistered 绑定：将来若新增「重置 MCP 启动态」的
  // 入口，必须把这个字段一并清空，否则下一轮启动会沿用上一轮的基线。
  this.mcpStartupRevisionAtStart = this.mcpPort?.toolListRevision?.();

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

export async function initializeMcp(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (this.mcpToolsRegistered) return;

  const startup = this.startMcpStartup(traceContext);
  const mcpPort = this.mcpPort;
  if (!startup || !mcpPort) {
    this.mcpToolsRegistered = true;
    return;
  }
  const serverCount = Object.keys(this.config.mcp?.servers ?? {}).length;

  try {
    // 阻塞归属探针：`await startup` 是等 IO（不该占主线程），`registerMcpTools` 是
    // 同步 CPU（78 个工具的描述/schema/registry 构建，会直接堵事件循环）。冷开期间
    // 实测事件循环单次漂移 1.6~2.9s，这两段各自贡献多少必须分开量。
    const startupWaitStartedAt = Date.now();
    const snapshot = await startup;
    const startupWaitMs = Date.now() - startupWaitStartedAt;
    const registerStartedAt = Date.now();
    const registered = registerMcpTools(this.registry, mcpPort, snapshot.tools, {
      allowedTools: this.config.toolAllowlist,
      disallowedTools: this.config.toolDisallowlist,
      officialCuaServerNames: computeOfficialCuaServerNames(
        this.config.mcp?.servers ?? {},
        new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
      ),
      // 插件 UI：display.ui 需要 server → pluginId 的归属；catalog 是 session 冻结的唯一权威。
      pluginIdByServerName: buildPluginIdByServerName(this.config.pluginReferenceCatalog),
    });
    this.mcpRegisteredToolNames = new Set(registered);
    // N4：注册日志带两个 revision 数值——AtStart 是本轮基线来源（启动点采样），Now 是注册
    // 完成时端口的真实值。两者不等就说明注册期间已经发生过 bump，下一回合边界会被 refresh
    // 看见；sess_6b69c667 那类「基线被吞」再发生时，只有这组数值能复盘。
    const revisionNow = mcpPort.toolListRevision?.();
    this.logger?.info("MCP tools registration timing", {
      ...traceContextToLogContext(traceContext),
      event: "mcp.tools.registration.timing",
      module: "core.runtime",
      registerMs: Date.now() - registerStartedAt,
      registeredToolCount: registered.length,
      revisionAtStart: this.mcpStartupRevisionAtStart,
      revisionNow,
      serverCount,
      startupWaitMs,
      toolCount: snapshot.tools.length,
    });
    if (registered.length > 0) {
      this.invalidateToolCache();
    }
    // A7：记住注册集合与签名，回合边界 refreshMcpToolsIfChanged 据此判断是否重注册。
    this.registeredMcpToolNames = registered;
    this.mcpToolsSignature = mcpToolsSignature(snapshot.tools);
    // 基线直接取启动点采样，不再「await 之后现读」（SB-B6：能走到这里说明端口已经过上面的
    // 判空并提前 return，端口不实现 toolListRevision 时 `现读` 与 `启动点` 同为 undefined，
    // 原来的 `??` 右操作数是死分支，留着只会掩盖将来把它挪回 await 之后的回归）。
    // 值为什么必须来自启动点见 internal.ts 的唯一解释。
    //
    // SB-B2：基线故意取启动点而不是「注册完成时」，代价是首回合必然多一次 listTools ——
    // 新 lease 的 revision 求和为 0，任一 server 首连成功都会 bump，refreshMcpToolsIfChanged
    // 第一回合必然进一次 listTools；它在签名比较之后推进基线，因此只多这一次，不会反复重注册。
    this.mcpToolListRevision = this.mcpStartupRevisionAtStart;
    this.logger?.info("MCP tools registered", {
      ...traceContextToLogContext(traceContext),
      event: "mcp.tools.registered",
      module: "core.runtime",
      registeredToolCount: registered.length,
      revisionAtStart: this.mcpStartupRevisionAtStart,
      revisionNow,
      serverCount,
      status: "completed",
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
  // SB-B1：基线必须在「等初始化落定之后、发起 connectConfiguredServers 之前」采样。
  // connectConfiguredServers 给出的只是连接器当下能拿到的一份快照——新 server 常仍在
  // connecting、慢 server 会被 MCP_CONNECT_DEADLINE_MS 掐掉，而 pool.snapshot() 逐 entry
  // await status/listTools 是真实 IO 窗口，后台连接完成后会 bump revision。若像此前那样
  // 等注册完成后再现读，落在 connect 期间的 bump 会被当成「已消费」，该 server 直到下一次
  // bump 或手动刷新前一直是 no-op。
  // 残余窗口：真正可能被吞的 bump 发生在「initializeMcp 内部取到工具快照之后」到「本行采样」
  // 之间——既包含 initializeMcp 返回前的各次 await（等待 startup、注册期间），也包含返回后到
  // 本行的同步段。基线一旦取本行现读值，这些 bump 就被当成已消费，而它们对应的工具不在
  // initializeMcp 的注册结果里，后续 refreshMcpToolsIfChanged 不会再补。这段窗口远小于
  // connect 的 IO 窗口，概率低；根治是端口级「快照自带 revision」，届时直接取 snapshot 上
  // 同一次读到的值。
  const revisionBeforeConnect = this.mcpPort.toolListRevision?.();
  this.config.mcp = {
    ...this.config.mcp,
    servers,
    trustedOfficialCuaServerNames: this.config.mcp?.trustedOfficialCuaServerNames ?? [],
  };
  this.mcpToolsRegistered = true;

  const snapshot = await this.mcpPort
    .connectConfiguredServers(servers, {
      // Bugfix（断连失效根因 E）：热刷新此前不带 revalidate——pool 对已有 entry 直接返回
      // 首次连接那个早已 resolve 的 promise（可能早已 failed），刷新实际是 no-op；带
      // revalidate 才会在同一 entry 上探测并原地重连（语义见 McpConnectOptions 注释：
      // 用户明确要求重新探测的调用必须置位）。
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

  const registered = registerMcpTools(this.registry, this.mcpPort, snapshot.tools, {
    allowedTools: this.config.toolAllowlist,
    disallowedTools: this.config.toolDisallowlist,
    officialCuaServerNames: computeOfficialCuaServerNames(
      servers,
      new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
    ),
    pluginIdByServerName: buildPluginIdByServerName(this.config.pluginReferenceCatalog),
  });
  const desired = new Set(registered);
  // Bugfix（断连失效根因 F）：某 server 仍在配置里但连接未就绪（failed/connecting/
  // OAuth 等待）时，snapshot 里它的 tools 为空——这是「拿不到」不是「工具没了」。此前
  // 对旧集合中不在新集合的名字一律 unregister，一次失败刷新就把该 server 的全部工具
  // 从注册表清掉，且死 entry 返回的空 tools 让后续刷新也救不回来。这里保留未就绪
  // server 的既有注册工具，恢复后由 revision 变化（adapter 重连成功会 bump）走
  // refreshMcpToolsIfChanged 同步。
  const notReadyServerPrefixes = Object.entries(snapshot.statuses)
    .filter(([name, status]) => status.status !== "connected" && servers[name])
    // 注册名用 sanitize 后的 server 段（toMcpToolName/toModelVisibleMcpNamePart 同构），
    // 前缀必须走同一清洗，否则含特殊字符的 server 名保护会静默失效。
    .map(([name]) => `mcp__${toModelVisibleMcpNamePart(name)}__`);
  const nextRegistered = new Set(desired);
  let removedToolCount = 0;
  for (const name of this.mcpRegisteredToolNames) {
    if (desired.has(name)) continue;
    if (notReadyServerPrefixes.some((prefix) => name.startsWith(prefix))) {
      nextRegistered.add(name);
      continue;
    }
    this.registry.unregister(name);
    removedToolCount += 1;
  }
  this.mcpRegisteredToolNames = nextRegistered;
  // A7 基线同步：手动全量刷新后，refreshMcpToolsIfChanged 的签名/revision 基线
  // 若不跟着更新，下一次 tools/list_changed 会拿旧基线做无意义的重注册。
  this.registeredMcpToolNames = registered;
  this.mcpToolsSignature = mcpToolsSignature(snapshot.tools);
  // 基线用 connect 之前采样的值（SB-B1）：注册结果只覆盖到那一刻的工具面，之后的 bump 必须
  // 留给下一回合的 refreshMcpToolsIfChanged，否则本次刷新的快照会把它永久吞掉。
  this.mcpToolListRevision = revisionBeforeConnect;
  this.invalidateToolCache();
  this.logger?.info("MCP tools refreshed", {
    ...traceContextToLogContext(effectiveTrace),
    event: "mcp.tools.refreshed",
    module: "core.runtime",
    registeredToolCount: registered.length,
    removedToolCount,
    revisionBeforeConnect,
    revisionNow: this.mcpPort.toolListRevision?.(),
    serverCount: Object.keys(servers).length,
    status: "completed",
  });
  return {
    serverCount: Object.keys(servers).length,
    registeredToolCount: registered.length,
    removedToolCount,
  };
}

/**
 * server 名 → 插件稳定 id。catalog 里 disabled 插件的 mcpServerNames 为空，天然不参与；
 * 同名冲突插件的 server 名互不相同（带插件名前缀），不需要额外去重。
 */
function buildPluginIdByServerName(
  catalog: PluginReferenceCatalog | undefined,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const plugin of catalog?.plugins ?? []) {
    for (const serverName of plugin.mcpServerNames) map.set(serverName, plugin.pluginId);
  }
  return map;
}

function mcpToolsSignature(descriptors: readonly McpToolDescriptor[]): string {
  return descriptors
    .map((tool) => `${tool.serverName}\u0001${tool.toolName}\u0001${tool.description ?? ""}`)
    .sort()
    .join("\n");
}

/**
 * 回合开始前刷新 MCP 工具表。只有端口报告 tools/list_changed 计数变化时才重新 listTools
 * （adapter 对收到通知的 server 重拉），再比较工具签名，变了就注销旧的、注册新的并失效工具缓存。
 * 不实现 toolListRevision 的端口（mock / 静态 server）永远不刷新；回合内也不刷新（已拍板）。
 */
export async function refreshMcpToolsIfChanged(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const mcpPort = this.mcpPort;
  if (!mcpPort || !this.mcpToolsRegistered) return;
  const revision = mcpPort.toolListRevision?.();
  if (revision === undefined || revision === this.mcpToolListRevision) return;
  let descriptors: McpToolDescriptor[];
  try {
    descriptors = await mcpPort.listTools();
  } catch {
    return;
  }
  const previousRevision = this.mcpToolListRevision;
  this.mcpToolListRevision = revision;
  const signature = mcpToolsSignature(descriptors);
  if (this.mcpToolsSignature === signature) {
    // N4：revision 推进了但工具签名没变（adapter 重拉后结果一致，或 bump 来自本端尚未观察到
    // 的 server）。这条 debug 是「基线被吞 / 反复重注册」类问题唯一可自查的痕迹。
    this.logger?.debug("MCP tool list revision advanced without signature change", {
      ...traceContextToLogContext(traceContext),
      event: "mcp.tools.revision_advanced_without_change",
      module: "core.runtime",
      previousRevision,
      revision,
      toolCount: descriptors.length,
    });
    return;
  }
  const previous = new Set(this.registeredMcpToolNames ?? []);
  // Bugfix（断连失效根因 F 半路径）：listTools 快照里缺席的 server 不一定是「工具没了」
  // ——更可能是该 server 连接未就绪（failed/connecting），快照天然为空。此前对 previous
  // 一律全量 unregister，一次部分空快照就把该 server 的工具永久移出注册表（revision 已
  // 推进，后续不会自动再来一次）。这里保留「配置里存在但快照缺席」的 server 的既有工具，
  // 待其恢复后（adapter 重连成功会 bump revision）自然同步。
  const configuredServers = Object.keys(this.config.mcp?.servers ?? {});
  const presentServers = new Set(descriptors.map((descriptor) => descriptor.serverName));
  const notReadyPrefixes = configuredServers
    .filter((name) => !presentServers.has(name))
    // 与 refreshMcpServers 同构：注册名的 server 段走同一 sanitize，见 toMcpToolName。
    .map((name) => `mcp__${toModelVisibleMcpNamePart(name)}__`);
  const retainedNames: string[] = [];
  for (const name of previous) {
    if (notReadyPrefixes.some((prefix) => name.startsWith(prefix))) retainedNames.push(name);
  }
  const previousConfirmed = [...previous].filter((name) => !retainedNames.includes(name));
  for (const name of previousConfirmed) this.registry.unregister(name);
  const registered = registerMcpTools(this.registry, mcpPort, descriptors, {
    allowedTools: this.config.toolAllowlist,
    disallowedTools: this.config.toolDisallowlist,
    officialCuaServerNames: computeOfficialCuaServerNames(
      this.config.mcp?.servers ?? {},
      new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
    ),
    pluginIdByServerName: buildPluginIdByServerName(this.config.pluginReferenceCatalog),
  });
  this.registeredMcpToolNames = [...registered, ...retainedNames];
  this.mcpToolsSignature = signature;
  this.invalidateToolCache();
  this.logger?.info("MCP tools re-registered after list_changed", {
    ...traceContextToLogContext(traceContext),
    event: "mcp.tools.reregistered",
    module: "core.runtime",
    removedToolCount: previousConfirmed.length,
    registeredToolCount: registered.length,
    retainedNotReadyToolCount: retainedNames.length,
    status: "completed",
  });
}
