import type {
  McpConnectionSnapshot,
  McpPort,
  McpServerStatus,
  McpToolDescriptor,
} from "@zcode/contracts";
import { SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE } from "./computer-use-policy.js";

export interface BorrowedSubagentMcpAccess {
  port: McpPort;
  snapshot: McpConnectionSnapshot;
}

/**
 * 子代理借用的 MCP 端口。
 *
 * 作用域 = 创建时冻结的 allowlist（`scopedServerNames`，undefined 表示不限）+ official CUA
 * denylist：它是权限边界，父会话之后新增的 server 不能自动进入子代理可见范围。
 * 工具集 = 每次向父端口实时取当前快照并重新过滤：父端口在后台连接完成后 bump
 * `toolListRevision`，子 runtime 的 `refreshMcpToolsIfChanged` 只有拿到活列表才能真正重注册；
 * 冻结启动快照会让「MCP 尚未连完就派生的子代理」把半份工具集继承一辈子。
 * `registerMcpTools` 只按精确工具名过滤（mcp/index.ts），不认识 server 作用域，所以
 * allowlist / denylist 只能在这里兜住。
 */
export function createBorrowedSubagentMcpAccess(
  parentPort: McpPort,
  parentStartupSnapshot: McpConnectionSnapshot,
  scopedServerNames?: readonly string[],
  deniedServerNames?: ReadonlySet<string>,
): BorrowedSubagentMcpAccess {
  const scope = scopedServerNames === undefined ? undefined : new Set(scopedServerNames);
  const isDenied = (serverName: string): boolean => deniedServerNames?.has(serverName) === true;
  const isInScope = (serverName: string): boolean =>
    (scope === undefined || scope.has(serverName)) && !isDenied(serverName);
  const filterStatuses = (
    statuses: Record<string, McpServerStatus>,
  ): Record<string, McpServerStatus> =>
    Object.fromEntries(Object.entries(statuses).filter(([serverName]) => isInScope(serverName)));
  const connectedNamesOf = (statuses: Record<string, McpServerStatus>): Set<string> =>
    new Set(
      Object.entries(statuses)
        .filter(([, status]) => status.status === "connected")
        .map(([serverName]) => serverName),
    );
  // 与原先（启动快照）同一谓词：在作用域内 **且** 该 server 当前已连接。
  const filterTools = (
    tools: readonly McpToolDescriptor[],
    connectedServerNames: ReadonlySet<string>,
  ): McpToolDescriptor[] =>
    tools.filter(
      (descriptor) =>
        isInScope(descriptor.serverName) && connectedServerNames.has(descriptor.serverName),
    );
  const rejectLifecycleMutation = (): never => {
    // child 借用 parent adapter，不拥有 MCP 连接生命周期。
    throw new Error("Subagent MCP port cannot mutate parent connection lifecycle");
  };

  const startupStatuses = filterStatuses(parentStartupSnapshot.statuses);
  // 最近一次实时观测到的「在作用域内且已连接」的 server 集合。callTool 的前置判定用它而不是
  // 启动快照：工具只有在一次实时 listTools() 之后才会被注册，而那次调用必然已刷新本集合，
  // 若仍按启动快照判定，刷新后新出现的工具会「注册成功但一调用就报 outside visible scope」。
  let connectedServerNames = connectedNamesOf(startupStatuses);
  const observeStatuses = (
    statuses: Record<string, McpServerStatus>,
  ): Record<string, McpServerStatus> => {
    const scoped = filterStatuses(statuses);
    connectedServerNames = connectedNamesOf(scoped);
    return scoped;
  };

  const snapshot: McpConnectionSnapshot = {
    statuses: startupStatuses,
    tools: filterTools(parentStartupSnapshot.tools, connectedServerNames),
  };

  const port: McpPort = {
    async callTool(request, options) {
      if (isDenied(request.serverName)) {
        throw new Error(SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE);
      }
      if (!connectedServerNames.has(request.serverName)) {
        throw new Error(`Subagent MCP server is outside visible scope: ${request.serverName}`);
      }
      return parentPort.callTool(request, options);
    },
    async close() {
      // child 结束时不向 parent adapter 传播 close。
    },
    async connectConfiguredServers() {
      return rejectLifecycleMutation();
    },
    async connectServer() {
      return rejectLifecycleMutation();
    },
    async disconnectServer() {
      return rejectLifecycleMutation();
    },
    async listTools() {
      // 每次向父端口取当前快照后重新过滤：作用域冻结、工具集实时。
      const [statuses, tools] = await Promise.all([parentPort.status(), parentPort.listTools()]);
      observeStatuses(statuses);
      return filterTools(tools, connectedServerNames);
    },
    async status() {
      // 只按作用域裁剪，连接状态原样透传（子代理需要看到 in-scope server 的失败原因）。
      return observeStatuses(await parentPort.status());
    },
  };
  // revision 委托父端口。父端口实现才给子端口装上：`toolListRevision?(): number` 要求返回
  // number，直接返回 `parentPort.toolListRevision?.()` 会得到 `number | undefined`；而父端口
  // 不支持时子端口也不实现，子 runtime 的 refreshMcpToolsIfChanged 才按契约永不刷新。
  if (parentPort.toolListRevision) {
    port.toolListRevision = parentPort.toolListRevision.bind(parentPort);
  }
  return { snapshot, port };
}
