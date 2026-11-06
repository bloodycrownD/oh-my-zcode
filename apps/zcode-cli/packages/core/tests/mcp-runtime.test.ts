import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createSessionId,
  createTraceId,
  type LogContext,
  type Logger,
  type McpConnectionSnapshot,
  type McpPort,
  type McpServerConfig,
  type PermissionBrokerPort,
  type SessionEventStorePort,
  type SessionId,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// SB-B7 的编译期断言：真正被 `tsc -b packages/core` 检查的是
// src/runtime/agent-runtime.ts 里的 mcpStartupRevisionAtStartTypePin（类字段侧只能在类体内
// 断言）。这里保留接口侧的一份，改测试时能立刻看到成员类型漂移。
type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type McpStartupRevisionAtStartIsNullable = Expect<
  Equal<AgentRuntimeInternal["mcpStartupRevisionAtStart"], number | undefined>
>;

describe("AgentRuntime MCP integration", () => {
  it("keeps the session resident while detached MCP startup is pending", async () => {
    const sessionId = createSessionId("runtime-mcp-residency");
    const startup = deferred<McpConnectionSnapshot>();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createMockMcpPort({
          connectConfiguredServers: async () => startup.promise,
        }),
      },
    );

    // 冷开优化：MCP 预热延后（agent-runtime.ts 的 MCP_WARMUP_DELAY_MS），构造期不 spawn，
    // 也就没有阻塞驻留的工作；显式触发启动后才算 pending。
    expect(runtime.hasResidencyBlockingWork()).toBe(false);
    const pending = runtime.startMcpStartup({
      sessionId,
      traceId: createTraceId("runtime-mcp-residency"),
    });
    expect(runtime.hasResidencyBlockingWork()).toBe(true);
    startup.resolve(emptyMcpSnapshot());
    await pending;
    expect(runtime.hasResidencyBlockingWork()).toBe(false);
  });

  it("defers configured MCP server startup until the warmup trigger", async () => {
    const sessionId = createSessionId("runtime-mcp-startup");
    const eventStore = createTestSessionEventStore();
    let connectCalls = 0;
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => {
        connectCalls++;
        return emptyMcpSnapshot();
      },
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
      },
    );

    // 构造期不 spawn（冷开路径上不压主线程），显式触发时才连。
    expect(connectCalls).toBe(0);
    await runtime.startMcpStartup({
      sessionId,
      traceId: createTraceId("runtime-mcp-startup"),
    });
    expect(connectCalls).toBe(1);
  });

  it("starts configured MCP servers only after the 1s warmup timer fires", async () => {
    // SC-C6：只伪造 setTimeout，避免把 Date / interval / microtask 一起冻结影响其它初始化。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const sessionId = createSessionId("runtime-mcp-warmup-timer");
      let connectCalls = 0;
      const mcpPort = createMockMcpPort({
        connectConfiguredServers: async () => {
          connectCalls += 1;
          return emptyMcpSnapshot();
        },
      });

      createTestAgentRuntime(
        sessionId,
        {
          mode: "build",
          mcp: {
            enabled: true,
            servers: {
              local: {
                type: "stdio",
                command: "node",
                args: ["server.js"],
              },
            },
          },
        },
        { eventStore: createTestSessionEventStore(), mcpPort },
      );

      // 冷开优化：构造函数只挂 1s 预热定时器，到点之前不 spawn。
      expect(connectCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(999);
      expect(connectCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(connectCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start MCP servers from the warmup timer once shutdown began", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const sessionId = createSessionId("runtime-mcp-warmup-shutdown");
      let connectCalls = 0;
      const mcpPort = createMockMcpPort({
        connectConfiguredServers: async () => {
          connectCalls += 1;
          return emptyMcpSnapshot();
        },
      });

      const runtime = createTestAgentRuntime(
        sessionId,
        {
          mode: "build",
          mcp: {
            enabled: true,
            servers: {
              local: {
                type: "stdio",
                command: "node",
                args: ["server.js"],
              },
            },
          },
        },
        { eventStore: createTestSessionEventStore(), mcpPort },
      );

      // 关闭中的 runtime 不能在延迟到点后再拉起 12 个 spawn（shuttingDown 守卫）。
      runtime.beginShutdown();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connectCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a 15s OAuth authorization wait limit to session MCP startup", async () => {
    const sessionId = createSessionId("runtime-mcp-oauth-timeout");
    const eventStore = createTestSessionEventStore();
    let connectOptions: Parameters<McpPort["connectConfiguredServers"]>[1];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async (_servers, options) => {
        connectOptions = options;
        return emptyMcpSnapshot();
      },
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            notion: {
              type: "http",
              url: "https://mcp.example.test/mcp",
              oauth: {
                type: "authorization_code",
              },
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
      },
    );

    await runtime.startMcpStartup({
      sessionId,
      traceId: createTraceId("runtime-mcp-oauth-timeout"),
    });
    expect(connectOptions?.oauthAuthorizationTimeoutMs).toBe(15_000);
  });

  it("emits turn_started before pending MCP startup resolves and waits before model request", async () => {
    const sessionId = createSessionId("runtime-mcp-background-startup");
    const eventStore = createTestSessionEventStore();
    const startup = deferred<McpConnectionSnapshot>();
    let modelRequestCount = 0;
    let toolNames: string[] = [];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => startup.promise,
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            modelRequestCount++;
            toolNames = request.tools.map((tool: { name: string }) => tool.name);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    const turn = runtime.executeTurn("use mcp if needed");
    await waitForEvent(eventStore, sessionId, SessionEventType.TurnStarted);
    expect(modelRequestCount).toBe(0);

    startup.resolve({
      statuses: {
        local: {
          status: "connected",
          transport: "stdio",
          toolCount: 1,
          updatedAt: "now",
        },
      },
      tools: [
        {
          serverName: "local",
          toolName: "ping",
          inputSchema: {
            type: "object",
            properties: {},
          },
          annotations: {
            readOnlyHint: true,
          },
        },
      ],
    });

    await turn;
    expect(modelRequestCount).toBe(1);
    expect(toolNames).toContain("mcp__local__ping");
  });

  it("registers configured MCP tools before the first model request", async () => {
    const sessionId = createSessionId("runtime-mcp-tools");
    const eventStore = createTestSessionEventStore();
    let toolNames: string[] = [];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          local: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "local",
            toolName: "ping",
            inputSchema: {
              type: "object",
              properties: {},
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      }),
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            toolNames = request.tools.map((tool: { name: string }) => tool.name);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("use mcp if needed");

    expect(toolNames).toContain("mcp__local__ping");
  });

  it("asks before running a non-destructive MCP tool in plan mode without readOnlyHint", async () => {
    const sessionId = createSessionId("runtime-mcp-plan-mode");
    const eventStore = createTestSessionEventStore();
    let modelCallCount = 0;
    let mcpCallCount = 0;
    let permissionRequestCount = 0;

    const permissionBroker: PermissionBrokerPort = {
      async requestPermission() {
        permissionRequestCount++;
        // Plan 模式下「只读但需要审批」的工具交回用户：确认后放行这一次。
        return { decision: "allow" } as never;
      },
    };

    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          local: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "local",
            toolName: "lookup",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
        ],
      }),
      callTool: async (request) => {
        mcpCallCount++;
        return {
          content: [{ type: "text", text: `lookup:${request.arguments?.query}` }],
        };
      },
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "plan",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        permissionBroker,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            modelCallCount++;
            if (modelCallCount === 1) {
              expect(request.tools.map((tool: { name: string }) => tool.name)).toContain(
                "mcp__local__lookup",
              );
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "I will look this up.",
                toolCalls: [
                  {
                    id: "mcp-lookup",
                    name: "mcp__local__lookup",
                    input: { query: "plan context" },
                  },
                ],
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
            }

            expect(
              request.messages.some((message: any) => {
                return (
                  message.role === "tool" && String(message.content).includes("lookup:plan context")
                );
              }),
            ).toBe(true);

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("use mcp while planning");

    expect(result.response).toBe("done");
    expect(mcpCallCount).toBe(1);
    // 收紧后的语义：Plan 下非 destructive MCP 不再静默放行，而是问一次。
    expect(permissionRequestCount).toBe(1);
  });

  it("re-registers tools that arrive after an incomplete startup snapshot", async () => {
    const sessionId = createSessionId("runtime-mcp-late-tools");
    const eventStore = createTestSessionEventStore();
    let revision = 0;
    let tools: Array<{ serverName: string; toolName: string; inputSchema: unknown }> = [];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => {
        // 现场签名（sess_6b69c667）：启动快照在 12 个 server 全 connecting 时返回（tools=[]），
        // 后台连接随后完成并 bump revision。快照比 revision 采样更早，若采样放在 await 之后，
        // 这次 bump 就被吞掉，refreshMcpToolsIfChanged 之后永远 no-op。
        tools = [
          {
            serverName: "local",
            toolName: "lookup",
            inputSchema: { type: "object", properties: {} },
          },
        ];
        revision += 1;
        return {
          statuses: {
            local: { status: "connecting", transport: "stdio", toolCount: 0, updatedAt: "now" },
          },
          tools: [],
        };
      },
      listTools: async () => tools as never,
      toolListRevision: () => revision,
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: { type: "stdio", command: "node", args: ["server.js"] },
          },
        },
      },
      { eventStore, mcpPort },
    );

    const traceContext = { sessionId, traceId: createTraceId("runtime-mcp-late-tools") };
    await (runtime as never as { initializeMcp(t: unknown): Promise<void> }).initializeMcp(
      traceContext,
    );
    await (
      runtime as never as { refreshMcpToolsIfChanged(t: unknown): Promise<void> }
    ).refreshMcpToolsIfChanged(traceContext);

    const names = (runtime as never as { getTools(): Array<{ name: string }> })
      .getTools()
      .map((tool) => tool.name);
    expect(names).toContain("mcp__local__lookup");
  });

  it("converges after the first post-startup refresh consumes the revision", async () => {
    const sessionId = createSessionId("runtime-mcp-refresh-converges");
    const eventStore = createTestSessionEventStore();
    let revision = 0;
    let listToolsCalls = 0;
    let tools: Array<{ serverName: string; toolName: string; inputSchema: unknown }> = [];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => {
        // 首连成功：工具就绪并 bump；快照本身带全，注册的就是这份。
        tools = [
          {
            serverName: "local",
            toolName: "lookup",
            inputSchema: { type: "object", properties: {} },
          },
        ];
        revision += 1;
        return {
          statuses: {
            local: { status: "connected", transport: "stdio", toolCount: 1, updatedAt: "now" },
          },
          tools: tools as never,
        };
      },
      listTools: async () => {
        listToolsCalls += 1;
        return tools as never;
      },
      toolListRevision: () => revision,
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: { type: "stdio", command: "node", args: ["server.js"] },
          },
        },
      },
      { eventStore, mcpPort },
    );
    const internals = mcpInternals(runtime);
    const traceContext = { sessionId, traceId: createTraceId("runtime-mcp-refresh-converges") };

    await internals.initializeMcp(traceContext);
    // SB-B2 收敛断言：基线故意取启动点，首回合必然多一次 listTools（计数 1）；该轮在签名比较
    // 之前推进基线，所以第二回合不再 listTools。HEAD 的「await 之后现读」基线等于 current，
    // 两回合都不会 listTools（计数 0）。
    await internals.refreshMcpToolsIfChanged(traceContext);
    await internals.refreshMcpToolsIfChanged(traceContext);

    expect(listToolsCalls).toBe(1);
    expect(internals.getTools().map((tool) => tool.name)).toContain("mcp__local__lookup");
  });

  it("re-registers tools when the port bumps only after initializeMcp returns", async () => {
    const sessionId = createSessionId("runtime-mcp-bump-after-init");
    const eventStore = createTestSessionEventStore();
    let revision = 0;
    let tools: Array<{ serverName: string; toolName: string; inputSchema: unknown }> = [];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          local: { status: "connecting", transport: "stdio", toolCount: 0, updatedAt: "now" },
        },
        tools: [],
      }),
      listTools: async () => tools as never,
      toolListRevision: () => revision,
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: { type: "stdio", command: "node", args: ["server.js"] },
          },
        },
      },
      { eventStore, mcpPort },
    );
    const internals = mcpInternals(runtime);
    const traceContext = { sessionId, traceId: createTraceId("runtime-mcp-bump-after-init") };

    await internals.initializeMcp(traceContext);
    // 初始化返回之后才到的 bump（后台重连 / 延迟 list_changed）。本用例在 HEAD 也是绿的
    // （旧读法在 await 之后现读，本来就能看见晚到的 bump），作用是防止后续把采样点再挪回
    // await 之后。
    tools = [
      {
        serverName: "local",
        toolName: "lookup",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    revision += 1;
    await internals.refreshMcpToolsIfChanged(traceContext);

    expect(internals.getTools().map((tool) => tool.name)).toContain("mcp__local__lookup");
  });

  it("keeps a pre-connect revision baseline when refreshMcpServers reconnects", async () => {
    const sessionId = createSessionId("runtime-mcp-refresh-servers-baseline");
    const eventStore = createTestSessionEventStore();
    let revision = 0;
    let connectCalls = 0;
    let listToolsCalls = 0;
    let tools: Array<{ serverName: string; toolName: string; inputSchema: unknown }> = [];
    const servers: Record<string, McpServerConfig> = {
      local: { type: "stdio", command: "node", args: ["server.js"] },
    };
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => {
        connectCalls += 1;
        if (connectCalls === 2) {
          // 第二次 connect（refresh 自己发起）期间后台连接完成：工具就绪并 bump，但这次
          // connect 返回给 refresh 的快照仍是空 tools（server 还在 connecting）。
          tools = [
            {
              serverName: "local",
              toolName: "lookup",
              inputSchema: { type: "object", properties: {} },
            },
          ];
          revision += 1;
        }
        return {
          statuses: {
            local: { status: "connecting", transport: "stdio", toolCount: 0, updatedAt: "now" },
          },
          tools: [],
        };
      },
      listTools: async () => {
        listToolsCalls += 1;
        return tools as never;
      },
      toolListRevision: () => revision,
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build", mcp: { enabled: true, servers } },
      { eventStore, mcpPort },
    );
    const internals = mcpInternals(runtime);
    const traceContext = {
      sessionId,
      traceId: createTraceId("runtime-mcp-refresh-servers-baseline"),
    };

    // refreshMcpServers 会先等 initializeMcp（门闩）落定，故 connectConfiguredServers 共两次：
    // 一次来自 initializeMcp，一次来自 refresh 自己。
    const result = await runtime.refreshMcpServers(servers, traceContext);
    expect(connectCalls).toBe(2);
    expect(result.registeredToolCount).toBe(0);

    // SB-B1：基线取 connect 之前的采样值（0），connect 期间的 bump（→1）留给下一回合。
    // HEAD 在注册完成后再现读（1），这次 bump 会被当成已消费，工具永久拿不到。
    await internals.refreshMcpToolsIfChanged(traceContext);
    expect(listToolsCalls).toBe(1);
    expect(internals.getTools().map((tool) => tool.name)).toContain("mcp__local__lookup");

    // 收敛：revision 未再变，不再重复 listTools。
    await internals.refreshMcpToolsIfChanged(traceContext);
    expect(listToolsCalls).toBe(1);
  });

  it("does not refresh MCP tools when the port does not implement toolListRevision", async () => {
    const sessionId = createSessionId("runtime-mcp-no-revision-port");
    const eventStore = createTestSessionEventStore();
    let listToolsCalls = 0;
    // SB-B6：静态端口（mock / 不支持 notifications/tools/list_changed 的 server）不实现
    // toolListRevision。「不会变化」与「变化计数 = 0」是两件事：若 runtime 把缺席的方法当成 0
    // 去和「未采样」的基线比较，每回合都会白跑一次 listTools 并重注册。
    // 这里故意让再次 listTools 返回多一个工具，一旦发生轮询，计数断言之外
    // 「无 mcp.tools.reregistered」「工具面不变」两条也会同时红。
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          local: { status: "connected", transport: "stdio", toolCount: 1, updatedAt: "now" },
        },
        tools: [
          {
            serverName: "local",
            toolName: "ping",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      listTools: async () => {
        listToolsCalls += 1;
        return [
          {
            serverName: "local",
            toolName: "ping",
            inputSchema: { type: "object", properties: {} },
          },
          {
            serverName: "local",
            toolName: "late",
            inputSchema: { type: "object", properties: {} },
          },
        ] as never;
      },
    });
    // 前提：该端口确实没有 revision 能力（helper 若将来补上默认实现，这条先红）。
    expect(mcpPort.toolListRevision).toBeUndefined();

    const loggedEvents: string[] = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: { type: "stdio", command: "node", args: ["server.js"] },
          },
        },
      },
      { eventStore, logger: createRecordingLogger(loggedEvents), mcpPort },
    );
    const internals = mcpInternals(runtime);
    const traceContext = { sessionId, traceId: createTraceId("runtime-mcp-no-revision-port") };

    await internals.initializeMcp(traceContext);
    expect(listToolsCalls).toBe(0);
    // 连续两回合刷新：没有 revision 信号的端口不会被轮询，也不会有任何重注册。
    await internals.refreshMcpToolsIfChanged(traceContext);
    await internals.refreshMcpToolsIfChanged(traceContext);

    expect(listToolsCalls).toBe(0);
    expect(loggedEvents).not.toContain("mcp.tools.reregistered");
    expect(
      internals
        .getTools()
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("mcp__")),
    ).toEqual(["mcp__local__ping"]);
  });

  it("keeps mcpStartupRevisionAtStart unset until MCP startup opens the gate", async () => {
    // SB-B7 的运行期一半：编译期断言钉住「类型 = number | undefined」，
    // 这里钉住「未开闸时必须是 undefined 而不是 0」——`=` 改成 `= 0`（哪怕类型仍带 `?`）
    // 会把「没采到」静默变成「已消费的基线 0」，首回合的 bump 就被吞掉。
    const sessionId = createSessionId("runtime-mcp-startup-revision-type");
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: { type: "stdio", command: "node", args: ["server.js"] },
          },
        },
      },
      { eventStore: createTestSessionEventStore(), mcpPort: createMockMcpPort() },
    );

    expect(mcpStartupRevisionField(runtime)).toBeUndefined();
    await mcpInternals(runtime).initializeMcp({
      sessionId,
      traceId: createTraceId("runtime-mcp-startup-revision-type"),
    });
    // 端口没有 toolListRevision → 开闸采样也只能是 undefined，不能回落成 0。
    expect(mcpStartupRevisionField(runtime)).toBeUndefined();
  });

  it("denies destructive MCP tools in plan mode before calling the MCP server", async () => {
    const sessionId = createSessionId("runtime-mcp-plan-destructive");
    const eventStore = createTestSessionEventStore();
    let modelCallCount = 0;
    let mcpCallCount = 0;
    let secondRequest: any;

    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          device: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "device",
            toolName: "reset",
            inputSchema: {
              type: "object",
              properties: {},
            },
            annotations: {
              destructiveHint: true,
            },
          },
        ],
      }),
      callTool: async () => {
        mcpCallCount++;
        return { content: [{ type: "text", text: "should-not-run" }] };
      },
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "plan",
        mcp: {
          enabled: true,
          servers: {
            device: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            modelCallCount++;
            if (modelCallCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "I will reset the device.",
                toolCalls: [
                  {
                    id: "mcp-reset",
                    name: "mcp__device__reset",
                    input: {},
                  },
                ],
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
            }

            secondRequest = request;
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("do not mutate while planning");
    const toolMessage = secondRequest.messages.find((message: any) => message.role === "tool");

    expect(result.response).toBe("done");
    expect(mcpCallCount).toBe(0);
    expect(toolMessage?.content).toContain(
      "Plan mode only allows read-only, non-destructive tools",
    );
  });
});

/** 内部方法（initializeMcp / refreshMcpToolsIfChanged / getTools）不在公开 AgentRuntime 上。 */
function mcpInternals(runtime: ReturnType<typeof createTestAgentRuntime>): {
  initializeMcp(traceContext: unknown): Promise<void>;
  refreshMcpToolsIfChanged(traceContext: unknown): Promise<void>;
  getTools(): Array<{ name: string }>;
} {
  return runtime as never as {
    initializeMcp(traceContext: unknown): Promise<void>;
    refreshMcpToolsIfChanged(traceContext: unknown): Promise<void>;
    getTools(): Array<{ name: string }>;
  };
}

/** SB-B7：`declare` 的私有字段没有运行期初始化，读到的就是「是否被赋过值」。 */
function mcpStartupRevisionField(
  runtime: ReturnType<typeof createTestAgentRuntime>,
): number | undefined {
  return (runtime as never as { mcpStartupRevisionAtStart?: number }).mcpStartupRevisionAtStart;
}

/** 记录日志 event 名，用于断言「没有 mcp.tools.reregistered」这类负向信号。 */
function createRecordingLogger(events: string[]): Logger {
  const record = (context?: LogContext): void => {
    if (typeof context?.event === "string") events.push(context.event);
  };
  const logger: Logger = {
    child: () => logger,
    debug: (_message, context) => record(context),
    error: (_message, _error, context) => record(context),
    info: (_message, context) => record(context),
    warn: (_message, context) => record(context),
  };
  return logger;
}

function createMockMcpPort(overrides: Partial<McpPort> = {}): McpPort {
  return {
    connectConfiguredServers: async () => emptyMcpSnapshot(),
    connectServer: async () => ({
      status: "connected",
      transport: "stdio",
      toolCount: 1,
      updatedAt: "now",
    }),
    disconnectServer: async () => undefined,
    status: async () => ({}),
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
    close: async () => {},
    ...overrides,
  };
}

function emptyMcpSnapshot(): McpConnectionSnapshot {
  return {
    statuses: {},
    tools: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function waitForEvent(
  eventStore: SessionEventStorePort,
  sessionId: SessionId,
  type: string,
): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const events = await eventStore.getEvents(sessionId);
    if (events.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for event: ${type}`);
}
