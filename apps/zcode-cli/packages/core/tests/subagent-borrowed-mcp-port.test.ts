import { describe, expect, it, vi } from "vitest";
import type {
  McpConnectionSnapshot,
  McpPort,
  McpServerStatus,
  McpToolDescriptor,
} from "@zcode/contracts";
import { createBorrowedSubagentMcpAccess } from "../src/subagent/borrowed-mcp-port.js";

describe("borrowed subagent MCP port", () => {
  it("re-reads the live parent tool set on every call while keeping the create-time scope", async () => {
    const alphaTool = createDescriptor("alpha", "search");
    const lateTool = createDescriptor("alpha", "late-tool");
    const startupSnapshot: McpConnectionSnapshot = {
      statuses: {
        alpha: createStatus("connected"),
        "alpha-extra": createStatus("connected"),
        offline: createStatus("disconnected"),
      },
      tools: [
        alphaTool,
        createDescriptor("alpha-extra", "search"),
        createDescriptor("offline", "search"),
      ],
    };
    // 创建之后父端口继续推进：alpha 多了一个工具、offline 连上了。
    const liveStatuses: Record<string, McpServerStatus> = {
      alpha: createStatus("connected"),
      "alpha-extra": createStatus("connected"),
      offline: createStatus("connected"),
    };
    const liveTools = [
      alphaTool,
      lateTool,
      createDescriptor("alpha-extra", "search"),
      createDescriptor("offline", "search"),
    ];
    const parentPort = createMockMcpPort({
      status: vi.fn(async () => liveStatuses),
      listTools: vi.fn(async () => liveTools),
      toolListRevision: vi.fn(() => 3),
    });

    const borrowed = createBorrowedSubagentMcpAccess(parentPort, startupSnapshot, [
      "alpha",
      "offline",
    ]);

    // 创建时快照仍按作用域裁一次（子代理 prompt / 初始视图用它），作用域本身创建后冻结。
    expect(borrowed.snapshot.statuses).toEqual({
      alpha: startupSnapshot.statuses.alpha,
      offline: startupSnapshot.statuses.offline,
    });
    expect(borrowed.snapshot.tools).toEqual([alphaTool]);

    // SB-B8：status / listTools 每次实时向父端口取当前快照，再套用同一作用域 + 已连接谓词。
    // 冻结启动快照会把「MCP 尚未连完就派生的子代理」的半份工具集继承一辈子。
    expect(await borrowed.port.status()).toEqual({
      alpha: liveStatuses.alpha,
      offline: liveStatuses.offline,
    });
    expect(await borrowed.port.listTools()).toEqual([
      alphaTool,
      lateTool,
      createDescriptor("offline", "search"),
    ]);
    // status 被调用两次：一次来自 port.status()，一次来自 port.listTools() 的实时观测。
    expect(parentPort.status).toHaveBeenCalledTimes(2);
    expect(parentPort.listTools).toHaveBeenCalledTimes(1);
    expect(borrowed.port.toolListRevision?.()).toBe(3);

    // 调用方改返回值不能污染下一次读取：每次返回新的数组 / 对象。
    const statusesForCaller = await borrowed.port.status();
    const toolsForCaller = await borrowed.port.listTools();
    delete statusesForCaller.alpha;
    toolsForCaller.length = 0;

    expect(await borrowed.port.status()).toEqual({
      alpha: liveStatuses.alpha,
      offline: liveStatuses.offline,
    });
    expect((await borrowed.port.listTools()).map(({ toolName }) => toolName)).toEqual([
      "search",
      "late-tool",
      "search",
    ]);
  });

  it("delegates visible calls without propagating child lifecycle operations", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "parent result" }],
    }));
    const parentPort = createMockMcpPort({ callTool });
    const borrowed = createBorrowedSubagentMcpAccess(
      parentPort,
      {
        statuses: {
          alpha: createStatus("connected"),
          beta: createStatus("connected"),
        },
        tools: [createDescriptor("alpha", "search"), createDescriptor("beta", "search")],
      },
      ["alpha"],
    );
    const request = {
      serverName: "alpha",
      toolName: "search",
      arguments: { query: "zcode" },
    };
    const options = { timeoutMs: 1_000 };

    await expect(borrowed.port.callTool(request, options)).resolves.toEqual({
      content: [{ type: "text", text: "parent result" }],
    });
    expect(callTool).toHaveBeenCalledWith(request, options);
    await expect(
      borrowed.port.callTool({ serverName: "beta", toolName: "search" }),
    ).rejects.toThrow("outside visible scope");

    await expect(borrowed.port.connectConfiguredServers({})).rejects.toThrow(
      "cannot mutate parent connection lifecycle",
    );
    await expect(
      borrowed.port.connectServer("alpha", { type: "stdio", command: "mcp" }),
    ).rejects.toThrow("cannot mutate parent connection lifecycle");
    await expect(borrowed.port.disconnectServer("alpha")).rejects.toThrow(
      "cannot mutate parent connection lifecycle",
    );
    await expect(borrowed.port.close()).resolves.toBeUndefined();

    expect(parentPort.connectConfiguredServers).not.toHaveBeenCalled();
    expect(parentPort.connectServer).not.toHaveBeenCalled();
    expect(parentPort.disconnectServer).not.toHaveBeenCalled();
    expect(parentPort.close).not.toHaveBeenCalled();
  });

  it("hides and blocks denied official servers without forwarding to the parent", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "parent result" }] }));
    const parentPort = createMockMcpPort({ callTool });
    const official = createDescriptor("plugin:computer-use:computer-use", "left_click");
    const unrelated = createDescriptor("plugin:demo:search", "lookup");
    const borrowed = createBorrowedSubagentMcpAccess(
      parentPort,
      {
        statuses: {
          "plugin:computer-use:computer-use": createStatus("connected"),
          "plugin:demo:search": createStatus("connected"),
        },
        tools: [official, unrelated],
      },
      undefined,
      new Set(["plugin:computer-use:computer-use"]),
    );

    expect(borrowed.snapshot.statuses).toEqual({
      "plugin:demo:search": expect.anything(),
    });
    expect(borrowed.snapshot.tools).toEqual([unrelated]);
    await expect(
      borrowed.port.callTool({
        serverName: official.serverName,
        toolName: official.toolName,
      }),
    ).rejects.toThrow("Computer Use is not available in subagent");
    expect(callTool).not.toHaveBeenCalled();
    await expect(
      borrowed.port.callTool({ serverName: unrelated.serverName, toolName: unrelated.toolName }),
    ).resolves.toEqual({ content: [{ type: "text", text: "parent result" }] });
  });

  it("keeps out-of-scope and denied official servers hidden after a parent revision bump", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "parent result" }] }));
    const alphaTool = createDescriptor("alpha", "search");
    const lateTool = createDescriptor("alpha", "late-tool");
    const outOfScopeTool = createDescriptor("beta", "search");
    const deniedCuaTool = createDescriptor("plugin:computer-use:computer-use", "left_click");
    const liveStatuses: Record<string, McpServerStatus> = {
      alpha: createStatus("connected"),
      beta: createStatus("connected"),
      "plugin:computer-use:computer-use": createStatus("connected"),
    };
    let revision = 1;
    const parentPort = createMockMcpPort({
      status: vi.fn(async () => liveStatuses),
      listTools: vi.fn(async () => [alphaTool, lateTool, outOfScopeTool, deniedCuaTool]),
      callTool,
      toolListRevision: vi.fn(() => revision),
    });
    const borrowed = createBorrowedSubagentMcpAccess(
      parentPort,
      { statuses: { alpha: createStatus("connected") }, tools: [alphaTool] },
      // CUA server 在 allowlist 里也必须被 denylist 挡住：denylist 优先于 scope。
      ["alpha", "plugin:computer-use:computer-use"],
      new Set(["plugin:computer-use:computer-use"]),
    );

    expect(borrowed.snapshot.tools).toEqual([alphaTool]);

    // 父端口 bump：工具面同时出现作用域外 server 与被 deny 的 official CUA server 的工具。
    revision = 2;
    expect(borrowed.port.toolListRevision?.()).toBe(2);

    // status 只按作用域裁剪（含 denylist），工具集每次实时取并重新过滤。
    expect(await borrowed.port.status()).toEqual({ alpha: liveStatuses.alpha });
    expect(
      (await borrowed.port.listTools()).map(
        ({ serverName, toolName }) => `${serverName}/${toolName}`,
      ),
    ).toEqual(["alpha/search", "alpha/late-tool"]);

    await expect(
      borrowed.port.callTool({ serverName: "beta", toolName: "search" }),
    ).rejects.toThrow("outside visible scope");
    await expect(
      borrowed.port.callTool({
        serverName: deniedCuaTool.serverName,
        toolName: deniedCuaTool.toolName,
      }),
    ).rejects.toThrow("Computer Use is not available in subagent");
    expect(callTool).not.toHaveBeenCalled();
  });
});

function createDescriptor(serverName: string, toolName: string): McpToolDescriptor {
  return {
    serverName,
    toolName,
    inputSchema: { type: "object" },
  };
}

function createStatus(status: McpServerStatus["status"]): McpServerStatus {
  return {
    status,
    transport: "stdio",
    toolCount: status === "connected" ? 1 : 0,
    updatedAt: "now",
  };
}

function createMockMcpPort(overrides: Partial<McpPort> = {}): McpPort {
  return {
    connectConfiguredServers: vi.fn(async () => ({ statuses: {}, tools: [] })),
    connectServer: vi.fn(async () => createStatus("connected")),
    disconnectServer: vi.fn(async () => undefined),
    status: vi.fn(async () => ({})),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({ content: [] })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}
