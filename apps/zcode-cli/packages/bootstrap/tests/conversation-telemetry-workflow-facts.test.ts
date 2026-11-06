// FORK（Phase 1 遥测移除）：`conversationTelemetryFactSchema` 只保留 turn.started / turn.terminal
// 两条事实（packages/shared/src/zcode-protocol-v4/telemetry.ts）。工作流用量、workflow.lifecycle、
// usage.delta、tool.lifecycle 等 kind 已随遥测通道删除，normalizer 对相应事件返回 null。
// 本文件保留两类断言：turn 载荷的 wf 维度仍随活事实透传；已删 kind 不再产出（防止再往 strict
// 判别联合里写不存在的 kind）。
import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ConversationTelemetryFactNormalizer } from "../src/zcode-protocol-v4/conversation-telemetry-facts.js";

function event(
  type: SessionEvent["type"],
  payload: unknown,
  seq: number,
  sessionId = "sess_dwf-run-1-worker_1",
): SessionEvent {
  return {
    id: `event-${seq}`,
    sessionId,
    turnId: "turn",
    traceId: "trace",
    sequenceNumber: seq,
    timestamp: new Date(),
    type,
    payload,
  } as SessionEvent;
}

const usage = {
  inputTokens: 120,
  outputTokens: 30,
  totalTokens: 150,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

describe("turn 载荷的 wf 维度", () => {
  it("TurnStarted.backgroundSource workflow 透传", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    expect(
      normalizer.normalize(
        "parent",
        event(
          SessionEventType.TurnStarted,
          {
            turnNumber: 1,
            input: "notice",
            inputId: "wake-1",
            inputSource: "background_task",
            backgroundSource: "workflow",
            messageId: "msg_1",
          },
          1,
          "parent",
        ),
      ),
    ).toMatchObject({ kind: "turn.started", backgroundSource: "workflow" });
  });

  it("TurnComplete(resultType success) → turn.terminal，终态摘要原样携带", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    expect(
      normalizer.normalize(
        "parent",
        event(
          SessionEventType.TurnComplete,
          {
            response: "",
            tokenCount: 301,
            toolCallCount: 2,
            duration: 10,
            resultType: "success",
          },
          2,
          "parent",
        ),
      ),
    ).toMatchObject({
      kind: "turn.terminal",
      status: "success",
      resultType: "success",
      durationMs: 10,
      tokenCount: 301,
      toolCallCount: 2,
    });
  });
});

describe("已删除的遥测 kind 不再产出", () => {
  it("子会话 ModelComplete(querySource workflow_child) 不产出 usage.delta", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const fact = normalizer.normalize(
      "sess_dwf-run-1-worker_1",
      event(
        SessionEventType.ModelComplete,
        {
          content: "",
          stopReason: "end_turn",
          usage,
          toolCallCount: 0,
          querySource: "workflow_child",
        },
        1,
      ),
    );
    expect(fact).toBeNull();
  });

  it("父会话 ModelComplete(tool_internal) 也不外送用量", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    expect(
      normalizer.normalize(
        "parent",
        event(
          SessionEventType.ModelComplete,
          { content: "", stopReason: "tool_internal", usage, toolCallCount: 0 },
          1,
          "parent",
        ),
      ),
    ).toBeNull();
  });

  it.each(["actor-created", "run-settled", "node-queued", "usage-updated", "run-started"])(
    "DynamicWorkflowRunProgress(%s) 不产出 workflow.lifecycle",
    (eventType) => {
      const normalizer = new ConversationTelemetryFactNormalizer();
      expect(
        normalizer.normalize(
          "parent",
          event(
            SessionEventType.DynamicWorkflowRunProgress,
            {
              runId: "dwfrun-1",
              toolCallId: "tool-wf",
              sequence: 3,
              eventType,
              payload: { actor: { siteId: "worker", ordinal: 1 }, status: "completed" },
              actorSessionId: "sess_dwf-run-1-worker_1",
              launchInputId: "launch-input-1",
            },
            1,
            "parent",
          ),
        ),
      ).toBeNull();
    },
  );

  it.each([SessionEventType.ToolCallResult, SessionEventType.ToolCallError])(
    "%s 不产出 tool.lifecycle（含 MCP 插件归因）",
    (type) => {
      const normalizer = new ConversationTelemetryFactNormalizer();
      expect(
        normalizer.normalize(
          "s",
          event(
            type,
            {
              toolCallId: "mcp-call",
              pluginId: "demo@market",
              duration: 12,
              result: { success: true, content: "do not report" },
              error: { type: "tool_error", message: "do not report" },
            },
            1,
            "s",
          ),
        ),
      ).toBeNull();
    },
  );
});
