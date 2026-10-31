import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeSessionStateSnapshotSchema,
} from "@zcode/shared";
import { getLegacyTaskSessionSnapshotPath, setDataBaseDir } from "../src/paths.js";
import { parseLegacyTaskSessionFile } from "../src/session/legacyTaskSessionFile.js";
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
      // FORK(upgrade-316)：上游 v3.16 在 syncer 侧改走 updateTaskPresentation
      // （taskIndexRepo.ts:1223，只写展示缓存，不接受 title/time/status/deleted）。
      // 本用例断言的是流回退路径，展示写入不参与断言，原样返回即可。
      async updateTaskPresentation(_params: unknown) {
        return meta;
      },
      close() {},
    } as unknown as TaskIndexRepo,
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      getWorkspaceEmitter: () => ({ fire() {} }),
      ensureSessionSubscription() {},
      emitWorkspaceTaskListChanged() {},
      // FORK(upgrade-316)：上游 v3.16 必填端口成员（zcodeTaskIndexSyncer.ts:118），
      // 返回值会被 rememberIndexedTaskMeta 当 ZCodeTaskMeta 用，不能返回 undefined。
      async syncSnapshotAndBroadcast() {
        return meta;
      },
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

// FORK (upstream-v3.15.1-backport) T-SVC-2：legacy 快照标记只允许在「真正以 legacy 交付」的
// 路径登记。失效形态：claudeCode legacy 升级为 zcode-cli session 成功后，key 仍留在
// legacySnapshotTaskKeys 里，onDynamicTaskEvent 永久退化为 local-only，bot channel 镜像收不到
// live 流（上游在 readLegacyTaskSnapshot 内登记、onDynamicTaskEvent 处守卫，同款缺陷且未修；
// fork 裁定为仅在 resumeSnapshotOrLegacy 的 legacy 返回点登记）。
//
// 下面两个用例经真实门面驱动：先 getTaskSnapshot 走 legacy 恢复/升级，再订阅 onDynamicTaskEvent，
// 用 protocol 帧能否投影出 stream 事件（行为级）证明协议订阅面是否挂上，不读内部 Set。

const legacyResumeTaskId = "t-svc-2";
const legacyResumeWorkspacePath = "/example/t-svc-2";

/** 搭一个 legacy 恢复场景：落盘 legacy 快照，resume 报 session 缺失，createSession 成功。 */
async function createLegacyResumeHarness(migrationSource?: "claudeCode") {
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  type CreateInput = Parameters<Options["zcodeAgentService"]["createSession"]>[0];
  const dir = await mkdtemp(join(tmpdir(), "zcode-t-svc-2-"));
  setDataBaseDir(dir);

  const meta = {
    taskId: legacyResumeTaskId,
    traceId: "trace-t-svc-2",
    title: "legacy resume",
    workspacePath: legacyResumeWorkspacePath,
    createdAt: 1,
    updatedAt: 2,
    mode: "build" as const,
    provider: "glm" as const,
    ...(migrationSource ? { migrationSource } : {}),
  };
  const legacy = parseLegacyTaskSessionFile({
    meta,
    messages: [
      { id: "old-user", role: "user", content: "旧问题", timestamp: 1 },
      { id: "old-assistant", role: "assistant", content: "旧回答", timestamp: 2 },
    ],
  });
  const legacyPath = getLegacyTaskSessionSnapshotPath(meta.workspacePath, meta.taskId);
  await mkdir(dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, JSON.stringify(legacy));

  /** 测试接管 protocol 事件面：记录被挂上的订阅回调。 */
  const protocolListeners: Array<(event: unknown) => void> = [];
  const created: CreateInput[] = [];
  const disposable = () => ({ dispose() {} });
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      async resumeSession(): Promise<never> {
        throw new Error(`Session not found: ${meta.taskId}`);
      },
      async createSession(input: CreateInput) {
        created.push(input);
        return zcodeSessionStateSnapshotSchema.parse({
          protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
          session: {
            sessionId: input.sessionId,
            workspace: {
              workspacePath: meta.workspacePath,
              workspaceKey: meta.workspacePath,
            },
            sessionKind: "interactive",
            title: input.importedHistory?.title,
            mode: "build",
            status: "idle",
            createdAt: 1,
            updatedAt: 2,
          },
          settings: {
            model: { available: [] },
            thoughtLevel: { enabled: false, available: [] },
            mode: { current: "build" },
          },
          projection: {
            sessionId: input.sessionId,
            status: "idle",
            mode: "build",
            turnCount: 0,
            totalTokenCount: 0,
            contextUsed: 0,
            contextWindow: 200000,
            pendingPermissions: [],
            activeToolCalls: [],
            backgroundJobs: [],
          },
          runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
          messages: [],
        });
      },
      onDynamicSessionEvent() {
        return (listener: (event: unknown) => void) => {
          protocolListeners.push(listener);
          return { dispose() {} };
        };
      },
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexRepo: {
      async getTaskMeta() {
        return null;
      },
      async syncTaskMeta(params: { meta: typeof meta }) {
        return params.meta;
      },
      async applyAgentPatch(params: { patch: { status?: string } }) {
        return params;
      },
      // FORK(upgrade-316)：同上——上游 syncer 走 updateTaskPresentation 写展示缓存。
      async updateTaskPresentation(_params: unknown) {
        return null;
      },
      close() {},
    } as unknown as TaskIndexRepo,
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      getWorkspaceEmitter: () => ({ fire() {} }),
      ensureSessionSubscription() {},
      emitWorkspaceTaskListChanged() {},
      // FORK(upgrade-316)：同上。
      async syncSnapshotAndBroadcast() {
        return meta;
      },
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });

  let seq = 0;
  const frame = (type: string, payload: Record<string, unknown>) => ({
    type: "session.event",
    event: {
      eventId: `evt-${++seq}`,
      seq,
      sessionId: meta.taskId,
      traceId: meta.traceId,
      turnId: "turn-1",
      timestamp: Date.now(),
      type,
      payload,
    },
  });

  return {
    service,
    created,
    frame,
    protocolListenerCount: () => protocolListeners.length,
    emitProtocol: (event: unknown) => {
      for (const listener of protocolListeners) listener(event);
    },
    cleanup: async () => {
      service.disposeAll();
      setDataBaseDir(null);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("T-SVC-2 claudeCode legacy 升级成功后 onDynamicTaskEvent 挂上 protocol 订阅面", async () => {
  const harness = await createLegacyResumeHarness("claudeCode");
  try {
    const snapshot = await harness.service.getTaskSnapshot({
      taskId: legacyResumeTaskId,
      workspacePath: legacyResumeWorkspacePath,
      clientMode: "desktop-continuous",
    });
    assert.equal(snapshot?.meta.taskId, legacyResumeTaskId);
    // 前置事实：legacy claudeCode 已被 createSession 接成真 session。
    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0]?.importedHistory?.source, "claudeCode");

    const streamEvents: Array<Record<string, unknown>> = [];
    const subscription = harness.service.onDynamicTaskEvent({
      taskId: legacyResumeTaskId,
      workspacePath: legacyResumeWorkspacePath,
    })((event) => {
      streamEvents.push(event as unknown as Record<string, unknown>);
    });
    try {
      // 升级成功的 task 不得残留 legacy 标记：protocol 帧必须能投影成 live 流事件。
      harness.emitProtocol(
        harness.frame("model.streaming", {
          kind: "text_delta",
          delta: "升级后的 live 流",
          assistantMessageId: "msg-1",
        }),
      );
      assert.equal(harness.protocolListenerCount(), 1);
      assert.deepEqual(
        streamEvents
          .filter((event) => event.type === "agent_message_chunk")
          .map((event) => event.content),
        ["升级后的 live 流"],
      );
    } finally {
      subscription.dispose();
    }
  } finally {
    await harness.cleanup();
  }
});

test("T-SVC-2 非 claudeCode legacy 仍 local-only，不挂 protocol 订阅", async () => {
  const harness = await createLegacyResumeHarness();
  try {
    const snapshot = await harness.service.getTaskSnapshot({
      taskId: legacyResumeTaskId,
      workspacePath: legacyResumeWorkspacePath,
      clientMode: "desktop-continuous",
    });
    assert.equal(snapshot?.meta.taskId, legacyResumeTaskId);
    // 前置事实：没有 claudeCode 迁移来源，不会走 createSession 升级。
    assert.equal(harness.created.length, 0);

    const streamEvents: Array<Record<string, unknown>> = [];
    const subscription = harness.service.onDynamicTaskEvent({
      taskId: legacyResumeTaskId,
      workspacePath: legacyResumeWorkspacePath,
    })((event) => {
      streamEvents.push(event as unknown as Record<string, unknown>);
    });
    try {
      // 真正以 legacy 快照交付的 task 保持只读历史语义：不向 ZCode Protocol 建订阅。
      harness.emitProtocol(
        harness.frame("model.streaming", {
          kind: "text_delta",
          delta: "不应出现的 live 流",
          assistantMessageId: "msg-1",
        }),
      );
      assert.equal(harness.protocolListenerCount(), 0);
      assert.deepEqual(streamEvents, []);
    } finally {
      subscription.dispose();
    }
  } finally {
    await harness.cleanup();
  }
});
