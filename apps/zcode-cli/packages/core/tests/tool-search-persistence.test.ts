import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createProjectId,
  createSessionId,
  type Model,
  type ModelRequest,
  type ModelResult,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { forkStableConversationAtMessage } from "../src/runtime/methods/session-fork.js";
import { collectDiscoveredTools } from "../src/tool/search/history.js";

it.each([
  { streaming: "off" as const, force: false },
  { streaming: "on" as const, force: false },
  { streaming: "on" as const, force: true },
])(
  "persists real ToolSearch completion and cold resumes ($streaming, force=$force)",
  async ({ streaming, force }) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-toolsearch-"));
    const dbPath = join(root, "session.sqlite");
    let store = await createSqliteSessionStore({ dbPath });
    const sessionId = createSessionId("toolsearch-cold");
    const requests: ModelRequest[] = [];
    let requestCount = 0;
    let continuations = 0;
    let codingPlan = !force;
    const respond = async (request: ModelRequest): Promise<ModelResult> => {
      requests.push(request);
      if (JSON.stringify(request.messages).includes("create a detailed summary"))
        return { text: "<summary>Continue the task.</summary>", finishReason: "stop", usage: {} };
      requestCount++;
      if (continuations > 0) {
        continuations--;
        return { text: "partial after cold resume", finishReason: "length", usage: {} };
      }
      return requestCount === 1
        ? {
            text: "",
            finishReason: "tool-calls",
            usage: {},
            toolCalls: [
              {
                id: "search-real",
                name: "ToolSearch",
                input: { query: "select:WebFetch,TodoWrite" },
              },
            ],
          }
        : { text: "done", finishReason: "stop", usage: {} };
    };
    const baseFactory = createTestModelFactory({
      generateText: respond,
      async *streamText(request) {
        const result = await respond(request);
        for (const toolCall of result.toolCalls ?? []) yield { type: "tool_call", toolCall };
        if (result.text) {
          yield { type: "text_start", id: "text" };
          yield { type: "text_delta", id: "text", text: result.text };
          yield { type: "text_end", id: "text" };
        }
        yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
      },
    });
    const wrap = (model: Model): Model => ({
      ...model,
      requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: codingPlan } },
      bind: (options) => wrap(model.bind(options)),
    });
    const makeRuntime = (forceStartup = false, runtimeSessionId = sessionId) =>
      createTestAgentRuntime(
        runtimeSessionId,
        {
          modelStreaming: streaming,
          toolSearch: { mode: forceStartup ? "native" : codingPlan ? "auto" : "off" },
          titleGeneration: { enabled: false },
          workspacePath: root,
        },
        {
          sessionStore: store,
          eventStore: createTestSessionEventStore(),
          modelFactory: (input) => wrap(baseFactory(input)),
        },
      );
    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("toolsearch"),
        slug: "toolsearch",
        title: "ToolSearch",
        directory: root,
        version: "test",
        time: { created: 1, updated: 1 },
      });
      const runtime = makeRuntime(force);
      await runtime.executeTurn("Load WebFetch and TodoWrite definitions.");
      expect(requests[0]?.tools?.some((tool) => tool.name === "WebFetch")).toBe(false);
      expect(requests[1]?.messages.filter((message) => message.role === "tool")).toMatchObject([
        {
          content: [
            { type: "tool_reference", toolName: "WebFetch" },
            { type: "tool_reference", toolName: "TodoWrite" },
          ],
        },
      ]);
      expect(requests[1]?.tools?.find((tool) => tool.name === "WebFetch")?.deferLoading).toBe(true);
      const originalAnnouncements = (runtime as unknown as AgentRuntimeInternal).messageHistory
        .toRuntimeEntries()
        .filter((entry) => entry.metadata?.toolSearchAnnouncement);
      expect(originalAnnouncements).toHaveLength(1);
      expect(originalAnnouncements[0]).toMatchObject({
        kind: "attachment",
        metadata: { source: "tool_search_announcement" },
      });
      expect(
        requests[1]?.messages.filter((message) => message.content === "Tool loaded."),
      ).toHaveLength(1);
      expect(
        JSON.stringify(
          (runtime as unknown as AgentRuntimeInternal).messageHistory.toRuntimeEntries(),
        ),
      ).not.toContain("Tool loaded.");
      const rows = await store.messages({ sessionID: sessionId });
      expect(JSON.stringify(rows)).not.toContain("Tool loaded.");
      const part = rows
        .flatMap((row) => row.parts)
        .find((part) => part.type === "tool" && part.callID === "search-real");
      expect(part).toMatchObject({
        state: {
          status: "completed",
          metadata: {
            schemaVersion: 1,
            modelContent: [
              { type: "tool_reference", toolName: "WebFetch" },
              { type: "tool_reference", toolName: "TodoWrite" },
            ],
          },
        },
      });
      const forkedSessionId = createSessionId("toolsearch-fork");
      await forkStableConversationAtMessage.call(runtime as unknown as AgentRuntimeInternal, {
        forkedSessionId,
        sourceCommandId: "fork-toolsearch",
        goalBoundary: { kind: "none" },
        target: {
          productTurnId: "toolsearch-turn",
          transcriptTurnId: "toolsearch-transcript",
          orderedMessageIds: rows.map((row) => String(row.info.id)),
          boundaryMessageId: String(rows.at(-1)!.info.id),
        },
      });
      await runtime.closeBrowserSession();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      const forked = makeRuntime(force, forkedSessionId);
      await forked.resumeFromStore();
      // fork 必须恢复公告本身，而不能只恢复搜索结果后再把已发现工具公告为未加载。
      const forkEntries = (
        forked as unknown as AgentRuntimeInternal
      ).messageHistory.toRuntimeEntries();
      expect(forkEntries.filter((entry) => entry.metadata?.toolSearchAnnouncement)).toEqual(
        originalAnnouncements,
      );
      expect(forkEntries.findIndex((entry) => entry.metadata?.toolSearchAnnouncement)).toBeLessThan(
        forkEntries.findIndex(
          (entry) => entry.kind !== "attachment" && entry.message.role === "tool",
        ),
      );
      expect([
        ...collectDiscoveredTools(
          (forked as unknown as AgentRuntimeInternal).messageHistory.borrowReadOnlyRuntimeEntries(),
        ),
      ]).toEqual(["WebFetch", "TodoWrite"]);
      const forkRows = await store.messages({ sessionID: forkedSessionId });
      const forkPart = forkRows
        .flatMap((row) => row.parts)
        .find((part) => part.type === "tool" && part.tool === "ToolSearch");
      expect(forkPart).toMatchObject({
        state: {
          status: "completed",
          metadata: {
            modelContent: [
              { type: "tool_reference", toolName: "WebFetch" },
              { type: "tool_reference", toolName: "TodoWrite" },
            ],
          },
        },
      });
      await forked.executeTurn("Continue from the fork without searching again.");
      expect(requests.at(-1)?.tools?.find((tool) => tool.name === "WebFetch")?.deferLoading).toBe(
        true,
      );
      expect(
        JSON.stringify(requests.at(-1)?.messages).split(
          "The following deferred tools are now available via ToolSearch.",
        ).length - 1,
      ).toBe(1);
      await forked.closeBrowserSession();
      codingPlan = false;
      const cold = makeRuntime();
      await cold.resumeFromStore();
      expect(
        (cold as unknown as AgentRuntimeInternal).messageHistory
          .toRuntimeEntries()
          .filter((entry) => entry.metadata?.toolSearchAnnouncement),
      ).toEqual(originalAnnouncements);
      expect([
        ...collectDiscoveredTools(
          (cold as unknown as AgentRuntimeInternal).messageHistory.borrowReadOnlyRuntimeEntries(),
        ),
      ]).toEqual(["WebFetch", "TodoWrite"]);
      await cold.executeTurn("Continue with the other provider.");
      expect(requests.at(-1)?.toolSearchEnabled).toBe(false);
      expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(
        "The following deferred tools are now available via ToolSearch.",
      );
      expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('"tool_reference"');
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
        "Tool references removed - tool search not enabled",
      );
      expect([
        ...collectDiscoveredTools(
          (cold as unknown as AgentRuntimeInternal).messageHistory.borrowReadOnlyRuntimeEntries(),
        ),
      ]).toEqual(["WebFetch", "TodoWrite"]);
      await cold.closeBrowserSession();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      // FORK：compact 面已删（`compactActiveConversation` / compaction part 不存在）。
      // 原「compact 后切回 coding plan」的公告去重断言改挂在普通冷恢复分支上：
      // 重启 + 重新启用 toolSearch 后，续跑的多条请求各自只带 1 条公告，历史里也只留 1 条。
      codingPlan = true;
      const resumed = makeRuntime();
      await resumed.resumeFromStore();
      const entries = (
        resumed as unknown as AgentRuntimeInternal
      ).messageHistory.borrowReadOnlyRuntimeEntries();
      expect([...collectDiscoveredTools(entries)]).toEqual(["WebFetch", "TodoWrite"]);
      const coldRequestStart = requests.length;
      continuations = 3;
      await resumed.executeTurn("Continue after provider upgrade.");
      expect(requests.at(-1)?.tools?.find((tool) => tool.name === "WebFetch")?.deferLoading).toBe(
        true,
      );
      await resumed.executeTurn("Next turn after resumed continuation.");
      expect(
        requests
          .slice(coldRequestStart)
          .map(
            (request) =>
              JSON.stringify(request.messages).split(
                "The following deferred tools are now available via ToolSearch.",
              ).length - 1,
          ),
      ).toEqual([1, 1, 1, 1, 1]);
      expect(
        (resumed as unknown as AgentRuntimeInternal).messageHistory
          .toRuntimeEntries()
          .filter((entry) => entry.metadata?.toolSearchAnnouncement),
      ).toHaveLength(1);
      await resumed.closeBrowserSession();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
