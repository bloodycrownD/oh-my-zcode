import assert from "node:assert/strict";
import test from "node:test";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import type { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

// FORK (upstream-v3.15.1-backport) T-SVC-1：spec §2.1 P4 #18——流式 turn 兜底补投的后缀不得
// 重发已流式的前缀。
//
// 失效形态：`turn.completed` 的 `response` 是本轮最终正文，而 delta 早已逐条投过。旧判据只记
// 「本轮收到过文字」，于是工具前言（scheduled tool.updated）清掉记录后，完整正文被当成"缺的后缀"
// 整条重投；更常见的是文本在流式与终态之间被截断过，兜底投出的 chunk 带上了已流式的前缀。
// 修复按 workspace 前缀比对：`response` 以已流式文本开头时只补后缀，不重复投前缀。
//
// 本用例经**真实门面**驱动：订阅 onDynamicTaskEvent（它挂上 agentService 的动态事件面），
// 再把 protocol 事件帧按序喂进去，看投影出来的 stream 事件。

const meta = {
  taskId: "t-svc-1",
  traceId: "trace-t-svc-1",
  title: "stream fallback",
  workspacePath: "/example/t-svc-1",
  createdAt: 1,
  updatedAt: 2,
};

/** 搭一个只够本用例跑通的 adapter：agentService 的动态事件面被测试接管，其余是空实现。 */
function createHarness() {
  const serviceEventListeners: Array<(event: unknown) => void> = [];
  const disposed: string[] = [];
  const disposable = () => ({ dispose() {} });
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      onDynamicSessionEvent() {
        return (listener: (event: unknown) => void) => {
          serviceEventListeners.push(listener);
          return { dispose() {} };
        };
      },
      disposeAll() {
        disposed.push("agentService");
      },
    } as unknown as Options["zcodeAgentService"],
    taskIndexRepo: {
      async getTaskMeta() {
        return meta;
      },
      async applyAgentPatch(params: { patch: { status?: string } }) {
        return params;
      },
      async syncTaskMeta(params: { meta: typeof meta }) {
        return params.meta;
      },
      close() {},
    } as unknown as TaskIndexRepo,
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      getWorkspaceEmitter: () => ({ fire() {} }),
      ensureSessionSubscription() {},
      emitWorkspaceTaskListChanged() {},
      disposeAll() {
        disposed.push("syncer");
      },
    } as unknown as Options["taskIndexSyncer"],
  });

  const streamEvents: Array<Record<string, unknown>> = [];
  const target = { taskId: meta.taskId, workspacePath: meta.workspacePath };
  const subscription = service.onDynamicTaskEvent(target)((event) => {
    streamEvents.push(event as unknown as Record<string, unknown>);
  });

  let seq = 0;
  const frame = (type: string, payload: Record<string, unknown>, turnId = "turn-1") => ({
    type: "session.event",
    event: {
      eventId: `evt-${++seq}`,
      seq,
      sessionId: meta.taskId,
      traceId: meta.traceId,
      turnId,
      timestamp: Date.now(),
      type,
      payload,
    },
  });

  return {
    service,
    subscription,
    streamEvents,
    frame,
    emit: (event: unknown) => {
      for (const listener of serviceEventListeners) listener(event);
    },
  };
}

test("T-SVC-1 turn.completed 只补投未流式的后缀", () => {
  const harness = createHarness();
  try {
    harness.emit(
      harness.frame("model.streaming", {
        kind: "text_delta",
        delta: "前半",
        assistantMessageId: "msg-1",
      }),
    );
    harness.emit(
      harness.frame("turn.completed", {
        response: "前半后半",
        resultType: "complete",
      }),
    );

    const chunks = harness.streamEvents
      .filter((event) => event.type === "agent_message_chunk")
      .map((event) => event.content);
    // 已流式的「前半」不重投，兜底只投后缀「后半」。
    assert.deepEqual(chunks, ["前半", "后半"]);
    assert.equal(harness.streamEvents.at(-1)?.type, "task_complete");
  } finally {
    harness.subscription.dispose();
    harness.service.disposeAll();
  }
});

test("T-SVC-1 response 与已流式文本完全一致时不补投空 chunk", () => {
  const harness = createHarness();
  try {
    harness.emit(
      harness.frame("model.streaming", {
        kind: "text_delta",
        delta: "完整正文",
        assistantMessageId: "msg-1",
      }),
    );
    harness.emit(harness.frame("turn.completed", { response: "完整正文", resultType: "complete" }));

    const chunks = harness.streamEvents
      .filter((event) => event.type === "agent_message_chunk")
      .map((event) => event.content);
    assert.deepEqual(chunks, ["完整正文"]);
  } finally {
    harness.subscription.dispose();
    harness.service.disposeAll();
  }
});

test("T-SVC-1 response 不以已流式文本开头时按完整正文兜底（不吞内容）", () => {
  const harness = createHarness();
  try {
    // 工具前言（scheduled tool.updated）清掉已流式记录：下一条模型消息必须独立核对正文。
    harness.emit(
      harness.frame("model.streaming", {
        kind: "text_delta",
        delta: "让我先看看文件",
        assistantMessageId: "msg-1",
      }),
    );
    harness.emit(
      harness.frame("tool.updated", {
        kind: "scheduled",
        toolCallId: "call-1",
        toolName: "Read",
        status: "running",
      }),
    );
    harness.emit(
      harness.frame("turn.completed", {
        response: "让我先看看文件，结论是没问题。",
        resultType: "complete",
      }),
    );

    const chunks = harness.streamEvents
      .filter((event) => event.type === "agent_message_chunk")
      .map((event) => event.content);
    // 前言被工具事件清账，终态正文与记录不一致 → 整条兜底（宁重不漏）。
    assert.deepEqual(chunks.at(-1), "让我先看看文件，结论是没问题。");
  } finally {
    harness.subscription.dispose();
    harness.service.disposeAll();
  }
});
