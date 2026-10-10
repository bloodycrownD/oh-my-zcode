#!/usr/bin/env node
/**
 * e2e/R-3 + agent/B-1 —— 未知 part type 上游根治与丢弃观测的自动化验证。
 *
 * ============================================================================
 * 这一步要锁死的失效形态
 * ============================================================================
 *
 * e2e 实机（编辑重发，出现 3 次）：conversation rewind 生效后
 * afterStateMutation → buildSessionSnapshot → mapSnapshotMessages →
 * hydrateSnapshotFilePartUrl 对个别消息 parts 中的 undefined 元素读 .type
 * 崩溃，startCanonicalIntent 被当成 TypeError → gateway 当归一
 * executionFailed——表现为「旧消息被截断、新消息丢失」。
 *
 * 根因核验结论（本批 r3，session-mapper 旧注释归因 "rewind rehydrate 遗留物"
 * 不成立，机械两说对比如下）：
 *   1) rewind 说：projectActiveSessionMessages → applyRewindBranch 只整条
 *      slice/filter 消息、从不合成 part，sqlite messages() 组装 parts 是 push
 *      数组也不可能产出显式 undefined 元素；若 raw parts 含 undefined，崩点会在
 *      mapMessageWithParts 的 filter（读 part.type）而非 hydrate，与实机崩点不符。
 *   2) 未知 type 说：mapMessagePart 的 switch 无 default，未知/缺失 type 让
 *      函数隐式返回 undefined 混进 parts 数组——这与实机崩点（hydrate 读 .type）
 *      完全吻合，是唯一自洽的解释。可达来源：decodeStoredPart 对残缺 data 行
 *      返回无 type 的对象；前向兼容的新 part type 落盘后被旧 bootstrap 读取。
 * 结论：default 分支落地后「编辑重发不再产生丢弃 warn」的理想态可达——rewind
 * 只是把可疑 part 行带进投影面的触发条件，不是生产者。
 *
 * 本文件两组断言各对一处收口：
 *   R-3 表驱动（message-mapper）：已知 type 全部保留；未知 type / 缺 type
 *     残缺行一律降级为 null 由调用侧过滤，parts 数组不产生 undefined/null，
 *     丢弃 part 经收集器回调上报。
 *   B-1 快照观测（session-mapper）：buildSessionSnapshot 遇未知 type part 时
 *     快照 parts 无 undefined/null，且 logger.warn 发射（含 messageId /
 *     dropped / partTypes）；无丢弃时不发射。
 *
 * 运行方式：`npx tsx --test scripts/test-session-mapper-parts.mjs`
 * （与 test-edit-retry-model 同源：tsx 直接吃 src，免去先 build bootstrap）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { mapMessageWithParts } = await import(
  new URL("../src/zcode-protocol/message-mapper.ts", import.meta.url).href
);
const { buildSessionSnapshot } = await import(
  new URL("../src/zcode-protocol/session-mapper.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — unknown message part dropped & observed (R-3 + B-1)"
      : `TEST FAIL — unknown message part dropped & observed (exit code ${code})`,
  );
});

const SESSION_ID = "ses_mapper_parts";
const MESSAGE_ID = "msg_mapper_parts";

function textPart(id) {
  return { id, sessionID: SESSION_ID, messageID: MESSAGE_ID, text: `text-${id}`, type: "text" };
}

function stepStartPart(id) {
  return {
    id,
    sessionID: SESSION_ID,
    messageID: MESSAGE_ID,
    snapshot: "snap-1",
    type: "step-start",
  };
}

/** 前向兼容/未知 type：DB 里存在但本版 contracts union 没有的 part 行。 */
function unknownPart(id, type = "future-part") {
  return { id, payload: { anything: true }, sessionID: SESSION_ID, messageID: MESSAGE_ID, type };
}

/** 残缺 data 行：decodeStoredPart 对非对象 JSON 返回 {} —— 缺 type 字段的 part。 */
function corruptPart(id) {
  return { id, sessionID: SESSION_ID, messageID: MESSAGE_ID };
}

function userMessage(parts) {
  return {
    info: {
      agent: "build",
      id: MESSAGE_ID,
      role: "user",
      sessionID: SESSION_ID,
      time: { created: 1_700_000_000_000 },
    },
    parts,
  };
}

// ── R-3：message-mapper 表驱动（未知 type → 不产生 undefined）─────────────────

test("R3: 表驱动——mapMessageWithParts 未知/缺 type 一律过滤，parts 不含 undefined", () => {
  const rows = [
    {
      droppedTypes: [],
      expectTypes: ["text", "step-start"],
      name: "已知 type 全部保留",
      parts: [textPart("t-known-1"), stepStartPart("t-known-2")],
    },
    {
      droppedTypes: ["future-part"],
      expectTypes: ["text"],
      name: "未知 type 被丢弃",
      parts: [textPart("t-unknown-1"), unknownPart("t-unknown-2")],
    },
    {
      droppedTypes: [undefined],
      expectTypes: ["text"],
      name: "缺 type 残缺行被丢弃",
      parts: [textPart("t-corrupt-1"), corruptPart("t-corrupt-2")],
    },
    {
      droppedTypes: ["future-part", "future-part"],
      expectTypes: ["text"],
      name: "多未知 type 合并丢弃",
      parts: [unknownPart("t-multi-1"), textPart("t-multi-2"), unknownPart("t-multi-3")],
    },
  ];
  for (const row of rows) {
    const dropped = [];
    const mapped = mapMessageWithParts(userMessage(row.parts), (part) => {
      dropped.push(part);
    });
    assert.ok(
      mapped.parts.every((part) => part !== undefined && part !== null),
      `${row.name}: parts 不得出现 undefined/null（R-3 崩溃源头）`,
    );
    assert.deepEqual(
      mapped.parts.map((part) => part.type),
      row.expectTypes,
      `${row.name}: 存活 part type 集合`,
    );
    assert.deepEqual(
      dropped.map((part) => part.type),
      row.droppedTypes,
      `${row.name}: 丢弃 part 必须经收集器上报`,
    );
  }
});

// ── B-1：buildSessionSnapshot 丢弃观测 ───────────────────────────────────────

function createProjection() {
  const now = new Date(1_700_000_000_000);
  return {
    activeToolCalls: [],
    backgroundTasks: [],
    contextUsed: 0,
    contextWindow: 0,
    createdAt: now,
    id: SESSION_ID,
    mode: "build",
    pendingPermissions: [],
    pendingSteerInputs: [],
    status: "idle",
    streamingToolLedger: [],
    targetCompletionVerificationTimeline: [],
    targetCompletionVerifications: [],
    totalTokenCount: 0,
    turnCount: 0,
    updatedAt: now,
  };
}

/** 最小可驱动的 snapshot app 桩；本文件只走消息映射，不触达模型/provider。 */
function createSnapshotApp() {
  return {
    getCurrentModelOption: () => undefined,
    getDefaultThoughtLevel: () => undefined,
    getMode: () => "build",
    getModel: () => "openai/gpt-5",
    getThoughtLevel: () => undefined,
    listModels: () => [],
    listThoughtLevels: () => ["high"],
    readToolResultArtifact: async () => {
      throw new Error("snapshot parts test must not read artifacts");
    },
    runtime: {
      getActiveTurnInfo: () => undefined,
      getProjection: () => createProjection(),
      getSessionModelSelection: () => undefined,
    },
    sessionId: SESSION_ID,
    traceId: "trace-mapper-parts",
  };
}

async function buildSnapshotWithMessages(messages, warns) {
  // 测试不写真实 ~/.omz：slash 命令发现走临时工作目录。
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "omz-mapper-parts-"));
  try {
    return await buildSessionSnapshot({
      app: createSnapshotApp(),
      eventSeq: 1,
      logger: { warn: (message, context) => warns.push({ context, message }) },
      messages,
      session: null,
      stateRevision: 1,
      workspace: { workspaceKey: "wk-mapper-parts", workspacePath },
    });
  } finally {
    await fs.rm(workspacePath, { force: true, recursive: true });
  }
}

test("B1: buildSessionSnapshot 遇未知 type part → 快照无 undefined 且 warn 发射", async () => {
  const warns = [];
  const snapshot = await buildSnapshotWithMessages(
    [userMessage([textPart("t-1"), unknownPart("t-2")])],
    warns,
  );
  const mappedMessage = snapshot.messages[0];
  assert.ok(mappedMessage, "快照必须含该消息");
  assert.ok(
    mappedMessage.parts.every((part) => part !== undefined && part !== null),
    "快照 parts 不得含 undefined/null",
  );
  assert.deepEqual(
    mappedMessage.parts.map((part) => part.type),
    ["text"],
    "未知 type part 必须被过滤出快照",
  );
  assert.equal(mappedMessage.parts[0].text, "text-t-1", "已知 part 内容不受影响");
  assert.equal(warns.length, 1, "必须发射恰好一条丢弃 warn");
  assert.match(warns[0].message, /dropped message parts/);
  assert.equal(warns[0].context.messageId, MESSAGE_ID, "warn 必须含 messageId");
  assert.equal(warns[0].context.dropped, 1, "warn 必须含丢弃计数");
  assert.deepEqual(warns[0].context.partTypes, ["future-part"], "warn 必须含 partTypes");
});

test("B1b: 无丢弃 part 的快照不发射 warn", async () => {
  const warns = [];
  const snapshot = await buildSnapshotWithMessages(
    [userMessage([textPart("t-1"), stepStartPart("t-2")])],
    warns,
  );
  assert.deepEqual(
    snapshot.messages[0].parts.map((part) => part.type),
    ["text", "step-start"],
  );
  assert.equal(warns.length, 0, "无丢弃时不得发射 warn");
});
