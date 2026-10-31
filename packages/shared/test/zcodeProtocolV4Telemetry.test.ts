import { describe, expect, it } from "vitest";
import {
  conversationTelemetryFactSchema,
  commandAckSchema,
  parseCommandEnvelope,
} from "../src/zcode-protocol-v4/index.js";

// FORK(upgrade-316/D-8)：Phase 1 遥测移除后，ConversationTelemetryFact 只保留
// turn.started / turn.terminal 两条会话事实（供 taskActivityTracker 统计运行中任务）；
// tool/subagent/stream/workflow/model.request 等 kind 及 off-peak admission、skill 名
// sanitize、provider hostname allowlist 均随遥测面删除——对应上游用例不再保留。

const base = {
  version: 1 as const,
  eventId: "event-1",
  eventSeq: 1,
  occurredAt: 1_700_000_000_000,
  sessionId: "session-1",
};

describe("ConversationTelemetryFact schema", () => {
  it("Memory 元数据保持 boolean 且兼容旧 ACK/fact", () => {
    const ack = { commandId: "command-1", status: "accepted", revisionAtDecision: 0 };
    const fact = { ...base, kind: "turn.started" };
    for (const [schema, value] of [
      [commandAckSchema, ack],
      [conversationTelemetryFactSchema, fact],
    ] as const) {
      expect(schema.parse(value)).not.toHaveProperty("memoryEnabled");
      for (const memoryEnabled of [true, false]) {
        expect(schema.parse({ ...value, memoryEnabled })).toMatchObject({ memoryEnabled });
      }
      expect(schema.safeParse({ ...value, memoryEnabled: "false" }).success).toBe(false);
    }
  });

  it("只允许定时任务 admission 字段，不接收任务正文", () => {
    const started = conversationTelemetryFactSchema.parse({
      ...base,
      kind: "turn.started",
      sourceCommandId: "automation-1:1700000000000",
      automationId: "automation-1",
      taskTrigger: "schedule",
      scheduledAt: 1_700_000_000_000,
    });
    expect(started).toMatchObject({ automationId: "automation-1", taskTrigger: "schedule" });
    expect(() =>
      conversationTelemetryFactSchema.parse({ ...started, prompt: "private" }),
    ).toThrow();
  });

  it("turn.started 接受 workflow 唤起来源；turn.terminal 接受后台子代理结果消费标记", () => {
    expect(
      conversationTelemetryFactSchema.parse({
        ...base,
        kind: "turn.started",
        inputSource: "background_task",
        backgroundSource: "workflow",
      }),
    ).toMatchObject({ backgroundSource: "workflow" });
    expect(
      conversationTelemetryFactSchema.parse({
        ...base,
        kind: "turn.terminal",
        status: "success",
        // FORK(upgrade-316)：fork 保留的终态标记是 backgroundSubagentResultConsumed
        //（上游 workflowResultConsumed 已随 workflow.lifecycle 遥测面删除）。
        backgroundSubagentResultConsumed: true,
      }),
    ).toMatchObject({ backgroundSubagentResultConsumed: true });
  });
});

describe("setAssistantFeedback command schema", () => {
  it("复用 row target CAS，feedback null 表示清除", () => {
    const parsed = parseCommandEnvelope({
      commandId: "command-1",
      clientId: "desktop-1",
      sessionId: "session-1",
      baseRevision: 3,
      baseLogEpoch: "epoch-1",
      type: "setAssistantFeedback",
      payload: {
        target: { rowId: 7, entityId: "assistant-message-1" },
        feedback: null,
      },
      issuedAt: 1_700_000_000_000,
    });
    expect(parsed.ok).toBe(true);
  });

  it("缺少 revision/logEpoch 或伪造 target 字段时拒绝", () => {
    const envelope = {
      commandId: "command-1",
      clientId: "desktop-1",
      sessionId: "session-1",
      type: "setAssistantFeedback" as const,
      payload: {
        target: { rowId: 7, entityId: "assistant-message-1" },
        feedback: "like",
      },
      issuedAt: 1_700_000_000_000,
    };
    expect(parseCommandEnvelope(envelope).ok).toBe(false);
    expect(
      parseCommandEnvelope({
        ...envelope,
        baseRevision: 3,
        baseLogEpoch: "epoch-1",
        payload: {
          ...envelope.payload,
          target: { ...envelope.payload.target, messageId: "x" },
        },
      }).ok,
    ).toBe(false);
  });
});
