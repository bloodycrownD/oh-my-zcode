// FORK（Phase 1 遥测移除）：`usage.delta` 等 kind 已从 protocol 事实联合删除，
// 真实 Adapter 的模型完成事件不再进入埋点。本文件只保留仍 live 的 turn 身份断言：
// inputId 必须贯穿 turn.started → turn.terminal，且绝不拿持久化 messageId 顶替。
import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { uuidv7 } from "@zcode/shared";
import { ConversationTelemetryFactNormalizer } from "../src/zcode-protocol-v4/conversation-telemetry-facts.js";

function event(type: SessionEvent["type"], payload: unknown, seq: number): SessionEvent {
  return {
    id: `event-${seq}`,
    sessionId: "parent",
    turnId: "turn",
    traceId: "trace",
    sequenceNumber: seq,
    timestamp: new Date(),
    type,
    payload,
  } as SessionEvent;
}

describe("main turn telemetry identity", () => {
  it.each([undefined, "background_task"])("keeps inputId through %s turn facts", (inputSource) => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const inputId = uuidv7();
    expect(
      normalizer.normalize(
        "parent",
        event(
          SessionEventType.TurnStarted,
          {
            turnNumber: 1,
            input: "prompt",
            inputId,
            inputSource,
            messageId: "msg_persisted",
          },
          1,
        ),
      ),
    ).toMatchObject({ sourceCommandId: inputId, kind: "turn.started" });
    expect(
      normalizer.normalize(
        "parent",
        event(
          SessionEventType.TurnComplete,
          {
            response: "done",
            tokenCount: 10,
            toolCallCount: 0,
            duration: 10,
            resultType: "success",
          },
          2,
        ),
      ),
    ).toMatchObject({ sourceCommandId: inputId, kind: "turn.terminal" });
  });

  it("does not substitute a persisted message ID for a missing input ID", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const fact = normalizer.normalize(
      "parent",
      event(
        SessionEventType.TurnStarted,
        {
          turnNumber: 1,
          input: "notice",
          inputSource: "background_task",
          messageId: "msg_persisted",
        },
        1,
      ),
    );
    expect(fact).not.toHaveProperty("sourceCommandId");
  });
});
