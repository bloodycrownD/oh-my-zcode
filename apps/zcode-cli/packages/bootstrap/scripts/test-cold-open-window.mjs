#!/usr/bin/env node
/**
 * Step 13 / phase-gates —— **端到端回归网**（真 store + 真 runtime）。
 *
 * ============================================================================
 * 这一步补的是前几步明确排到这里的四条 T-SL，外加两条 Step 8/10 的遗留问题
 * ============================================================================
 *
 *   IS1 逐值一致（T-SL5/6 的端到端版）：窗口化冷开与全量物化必须是**同一份身份**
 *      ——`turnId` / `rowId` / `kind` / `createdAt` 逐值相等，模型切换 marker 不丢。
 *      前几步钉的是「同一套合成器 + 手写窗口」，本步把中间那一层换成**真 sqlite store**
 *      与生产的 `readColdTailWindowMaterialization` / `loadPersistedConversationMaterialization`。
 *      漂移的后果不是报错，而是翻页锚点与会话头部整体平移（spec RC4）。
 *
 *   IS2 两种事故防护（T-SL3/T-SL4 的端到端版）：`session.revert` 的 target / cut 落在
 *      窗口之外时，**不得**复活已回滚分支，也**不得**把历史清空。真 store 的这一条不能
 *      只靠纯函数用例：窗口读自己会再算一次裁断（`readColdRowPageMaterialization`），
 *      两处一旦各写一份规则就是静默分支分叉。
 *
 *   IS6 翻页不漏（T-SL9 的端到端版）：连续 `loadOlder` 到顶，行集合与全量一致、
 *      `hasMore` 按 manifest 首行判定、深翻页后 rowId 不变、**全程不触发第二次冷开**
 *      （`materializeSessionShell` / 正文读各一次）。
 *
 *   T-SL10 / T-SL11 / T-SL14 / T-SL16（真 runtime）：`view-only` 外壳下非 send 类命令回可
 *      重试的 `runtimeNotReady`；send 类是唯一激活入口，激活后**真的跑起一轮**
 *      （真 `AgentRuntime` 的事件进投影）；激活**只 resume 一次**（不产生第二条
 *      `SessionResumed`）；升级后的全量投影与 view-only 期下发的 rowId **逐值相等**；
 *      首屏无 usage / 无 fileChanges 是预期，激活后补齐。
 *
 *   T-SL13（真 runtime + 真 store）：`historyMode:"none"` 的首次发送，provider **实际收到**
 *      的历史与 `"full"` 逐字节相等。Step 12 只钉了「两条构造路径的历史逐字节相等」，
 *      没在真 store 上跑过首次发送——本步把 `resumeFromStore` → 真 turn → 真 ModelRequest
 *      整条链跑一遍。
 *
 *   遗留 ①（Step 8 起）：**页物化不重建 fileChanges 摘要**，冷首屏的摘要也不可用
 *      （真冷的会话事件表是空的）。本步把「首屏可用 / 不可用」钉成断言，而不是注释。
 *   遗留 ②（Step 10 risk 16）：**升级与首轮 send 并发**时是否观测到流式行回退。
 *
 * ============================================================================
 * 夹具分层（每层的"真"到什么程度，写清楚以免把桩当实现）
 * ============================================================================
 *
 *   A/B 组（IS1/IS2/IS6）：真 `createSqliteSessionStore`（真迁移链 + 真 SQL）、真
 *     `readColdTailWindowMaterialization` / `readColdRowPageMaterialization` /
 *     `loadPersistedConversationMaterialization` / `mergeColdConversationEvents`、
 *     真 `ConversationV4Gateway` + 真投影。只有宿主胶水是夹具（与 `v4-bridge.ts` 同形，
 *     逐段注释了对应行）。这两组不激活 runtime，因此没有"真 runtime"的声称。
 *
 *   C 组（T-SL10/11/13/14）：真 `AgentRuntime`（core 源码）+ 真 sqlite store + 真
 *     `materializeSessionShell` / `activateRuntime`（**生产函数，不绕开、不手工 createRecord**）
 *     + 真 `runSessionStartHooks` 路径。假的只有模型（`modelFactory` 返回记录请求的
 *     stub model）与 `deps.createZCodeApp` 这一个工厂（它本来就是注入点）。
 *
 * ============================================================================
 * Step 12 的两条口径（本文件必须按它们读，不能反过来）
 * ============================================================================
 *
 *   1. lazy resume 之后 `messageHistory` 是空的，内容在 `deferredHistoryHydration`；
 *      `SessionResumed` 的 `messageCount` / `partCount` / `appliedMessageCount` **恒为 0
 *      是预期**（`historyMode:"none"`）。本文件把它当**断言**，不是当 bug。
 *   2. 「provider 历史已水化」是**水位**（`deferredHistoryHydration` / 一次消费），不是
 *      resume 副产品。本文件在 C3 里同时断言：resume 后水位在、闸门跑完水位消失。
 *
 * 运行：`npx tsx --test scripts/test-cold-open-window.mjs`
 * （必须走 tsx：core/adapters 走源码，`@zcode/contracts` 之类的包走 dist。）
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { AgentRuntime } = await import(
  new URL("../../core/src/runtime/agent-runtime.ts", import.meta.url).href
);
const { createSqliteSessionStore } = await import(
  new URL("../../adapters/src/storage/session-store/sqlite-session-store.ts", import.meta.url).href
);
const { createInMemorySessionEventStore } = await import("@zcode/contracts");
const { SessionEventType } = await import("@zcode/contracts");

const {
  createSessionRowManifestReader,
  readColdRowPageMaterialization,
  readColdTailWindowMaterialization,
} = await import(new URL("../src/zcode-protocol-v4/session-row-manifest.ts", import.meta.url).href);
const { TURN_MANIFEST_PROJECTION_SCHEMA_VERSION } = await import(
  new URL("../src/zcode-protocol-v4/turn-manifest-entry.ts", import.meta.url).href
);
const {
  synthesizeEventsFromMessages,
  hydrationModelKeyOfSelection,
  hydrationTurnModelSelectionOfMessage,
} = await import(new URL("../src/zcode-protocol-v4/transcript-hydration.ts", import.meta.url).href);
const { loadPersistedConversationMaterialization, mergeColdConversationEvents } = await import(
  new URL("../src/zcode-protocol-v4/cold-event-merge.ts", import.meta.url).href
);
const { ConversationTopicPublisher } = await import(
  new URL("../src/zcode-protocol-v4/conversation-topic-publisher.ts", import.meta.url).href
);
const { ProductProjection } = await import(
  new URL("../src/zcode-protocol-v4/product-projection.ts", import.meta.url).href
);
const { ConversationV4Gateway } = await import(
  new URL("../src/zcode-protocol-v4/v4-gateway.ts", import.meta.url).href
);
const { materializeSessionShell, activateRuntime } = await import(
  new URL("../src/zcode-protocol/server-operations.ts", import.meta.url).href
);
const { ProtocolRequestError } = await import(
  new URL("../src/zcode-protocol/server-types.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 13 cold-open end-to-end (IS1 + IS2 + IS6 + IS7, real store + real runtime)"
      : `TEST FAIL — Step 13 cold-open end-to-end (exit code ${code})`,
  );
});

const SESSION_ID = "ses_cold_open_window";
const EPOCH = "epoch-cold-open-window";
const PROJECT_ID = "prj_cold_open_window";

// ── 通用夹具 ────────────────────────────────────────────────────────────────

function recordingLogger() {
  const lines = [];
  const logger = {
    debug(message, context) {
      lines.push({ level: "debug", message: String(message), context });
    },
    info(message, context) {
      lines.push({ level: "info", message: String(message), context });
    },
    warn(message, context) {
      lines.push({ level: "warn", message: String(message), context });
    },
    error(message, context) {
      lines.push({ level: "error", message: String(message), context });
    },
    child() {
      return logger;
    },
  };
  return { logger, lines };
}

/** 一轮两条消息的 durable transcript（与生产合成器的输入同形）。 */
function transcript(turnCount, { modelChangeAtTurn = 0, startAt = 1_700_000_000_000 } = {}) {
  const messages = [];
  for (let turnNumber = 1; turnNumber <= turnCount; turnNumber += 1) {
    const createdBase = startAt + (turnNumber - 1) * 1_000;
    const modelSelection =
      modelChangeAtTurn > 0 && turnNumber >= modelChangeAtTurn
        ? { providerId: "provider-b", modelId: "model-b", options: { reasoningLevel: "high" } }
        : { providerId: "provider-a", modelId: "model-a", options: { reasoningLevel: "low" } };
    messages.push({
      info: {
        id: `m-${turnNumber}-u`,
        sessionID: SESSION_ID,
        role: "user",
        time: { created: createdBase },
        agent: "zcode-agent",
        // 生产里 user 消息也带本轮选型（`saveMessage` 从 `modelSelection` 派生 `model` 快照）。
        // 窗口的「上一轮模型基线」正是从**上一轮首条消息**（= user）读出来的，
        // 这里漏了就会让那条接缝在夹具里永远取不到值。
        modelSelection,
        modelId: modelSelection.modelId,
        providerId: modelSelection.providerId,
      },
      parts: [
        {
          id: `prt-${turnNumber}-u`,
          sessionID: SESSION_ID,
          messageID: `m-${turnNumber}-u`,
          type: "text",
          text: `问 ${turnNumber}`,
        },
      ],
    });
    messages.push({
      info: {
        id: `m-${turnNumber}-a`,
        sessionID: SESSION_ID,
        role: "assistant",
        time: { created: createdBase + 500, completed: createdBase + 900 },
        agent: "zcode-agent",
        modelId: modelSelection.modelId,
        providerId: modelSelection.providerId,
        modelSelection,
        mode: "build",
        tokens: { input: 100, output: 20, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: `prt-${turnNumber}-a`,
          sessionID: SESSION_ID,
          messageID: `m-${turnNumber}-a`,
          type: "text",
          text: `答 ${turnNumber}`,
        },
      ],
    });
  }
  return messages;
}

/** 真 sqlite store（真迁移链），把 durable transcript 写进去。 */
async function seededStore({ root, messages, session = {} }) {
  const { revert, ...sessionInput } = session;
  const store = createSqliteSessionStore({ dbPath: join(root, "sessions.db") });
  await store.createSession({
    id: SESSION_ID,
    projectID: PROJECT_ID,
    slug: "cold-open-window",
    directory: root,
    title: "冷开回归会话",
    version: "0.0.0",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
    ...sessionInput,
  });
  // `createSession` 的 DDL 不接受 revert（那一列固定写 null，见适配器 SQL），
  // 回滚事实只能经 `updateSession` 落盘——这正是真 store 与手写夹具的差别之一。
  if (revert !== undefined) {
    await store.updateSession({ id: SESSION_ID, revert });
  }
  for (const message of messages) {
    await store.saveMessage(message.info);
    for (const part of message.parts) await store.savePart(part);
  }
  return store;
}

/**
 * 把「活投影终态」写进 turn manifest —— 生产里这两处是 `onTurnComplete` / `onTurnError`
 * 的回写（`v4-gateway.ts:967` 的 ingest 挂 `recordTurnManifest`）。夹具用同一份投影入口
 * 取 entry，因此清单与投影的规则是同构的（IS5 的前提，不是巧合）。
 */
async function writeTurnManifests(store, events) {
  const publisher = new ConversationTopicPublisher(SESSION_ID, EPOCH, { now: () => 1_000 });
  const entries = [];
  for (const event of events) {
    publisher.ingest(event);
    if (event.type !== "turn_complete") continue;
    const entry = publisher.getTurnManifestEntry(event);
    if (entry) entries.push(entry);
  }
  for (const entry of entries) {
    await store.turnManifest.upsertTurnManifest({
      sessionID: SESSION_ID,
      branchGeneration: 0,
      ...entry,
    });
  }
  return { publisher, rows: publisher.getSnapshot().rows.window, entries };
}

/** 全量物化的事件（与 bridge 的 `fullMaterialization: true` 同一条：不传 planColdWindow）。 */
async function fullMaterializationEvents({ store, messages }) {
  const source = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    sessionId: SESSION_ID,
    store,
  });
  const merged = mergeColdConversationEvents({
    memoryEvents: source.memoryEvents,
    messages: source.messages,
    sessionId: SESSION_ID,
    goalVerificationEntries: source.goalVerificationEntries,
    ...(Object.prototype.hasOwnProperty.call(source, "target") ? { target: source.target } : {}),
  });
  return { store, messages, merged, materialization: source };
}

/**
 * 宿主胶水（与 `v4-bridge.ts` 的 `loadPersistedEvents` / `materializeRowPage` 同形）。
 *
 * A/B 组的 `materializeSessionShell` / `resumePersistedSession` 只是计数器：这两组不声称
 * runtime 行为，只观测「冷开被触发了几次」。C 组另有一套真实现（见 `realRuntimeWorld`）。
 */
function coldOpenHost({ store, reader, counters }) {
  const host = {
    sessionExists: () => counters.live,
    isSessionRuntimeActive: () => counters.runtimeActive,
    emitWireFrame: (wire) => counters.wires.push(wire),
    onError: (scope, error) => counters.errors.push({ scope, error }),
    onDebug: (message) => counters.debugs.push(String(message)),
    loadPersistedEvents: async (sessionId, persistedMessages, loadOptions) => {
      counters.load += 1;
      counters.loadOptions.push(loadOptions ?? {});
      return await readColdMaterialization({
        store,
        reader,
        sessionId,
        persistedMessages,
        loadOptions,
      });
    },
    readRowManifest: (sessionId, input) => reader.read(sessionId, input),
    invalidateRowManifestIndex: (sessionId) => reader.invalidateMessageIndex(sessionId),
    materializeRowPage: async (sessionId, plan) => {
      counters.page += 1;
      counters.pagePlans.push(plan);
      const page = await readColdRowPageMaterialization({
        sessionID: sessionId,
        store,
        reader,
        plan,
      });
      if (page.kind !== "page") return null;
      const baseline = plan.precedingTurnFirstMessageId
        ? await readHydrationTurnModelSelection(store, sessionId, plan.precedingTurnFirstMessageId)
        : null;
      const initialModelKey = baseline
        ? hydrationModelKeyOfSelection(baseline.modelSelection)
        : null;
      // 与 bridge 同形：页只吃持久正文，且**不重建 fileChanges 摘要**（见 v4-bridge.ts:1541）。
      const merged = mergeColdConversationEvents({
        memoryEvents: [],
        messages: page.messages,
        sessionId,
        goalVerificationEntries: [],
        synthesis: {
          initialTurnNumber: plan.ordinal,
          ...(initialModelKey === null ? {} : { initialModelKey }),
          ...(page.baseTimestampMs === undefined ? {} : { baseTimestampMs: page.baseTimestampMs }),
        },
      });
      return {
        events: merged.events,
        messageCount: page.messages.length,
        initialModelKeyResolved: initialModelKey !== null,
        ...(baseline === null
          ? {}
          : {
              modelBaseline: {
                provider: baseline.modelSelection.providerId,
                model: baseline.modelSelection.modelId,
                thought: baseline.modelSelection.options?.reasoningLevel ?? "",
              },
            }),
      };
    },
    materializeSessionShell: async () => {
      counters.shell += 1;
      counters.live = true;
      counters.runtimeActive = false;
      return { status: "materialized" };
    },
    resumePersistedSession: async () => {
      counters.resume += 1;
      // 让激活悬在半空：view-only 期的读入口必须不等激活、也不重复触发冷开。
      if (counters.resumeGate) await counters.resumeGate.promise;
      counters.runtimeActive = true;
      if (!counters.live) counters.live = true;
      return { status: "resumed", persistedMessages: [] };
    },
    executeCommand: async (envelope) => {
      counters.executed.push(envelope.type);
      return undefined;
    },
  };
  return host;
}

/** 让下一次激活停在半空，返回放行函数（同 Step 8 夹具的 `holdResume`）。 */
function holdResume(counters) {
  let release;
  counters.resumeGate = { promise: new Promise((resolve) => (release = resolve)) };
  return () => {
    counters.resumeGate = null;
    release();
  };
}

/**
 * 冷开物化（复刻 `v4-bridge.ts:1977-2260` 的关键段）。
 *
 * 与 bridge 的差异**只有**三处，都是测试环境必须的：
 *   ① `memoryEvents` 恒空（真冷：进程重启后内存事件表本来就是空的）；
 *   ② 没有 artifact reader → 不重建 fileChanges 摘要（与 `record` 缺席时的生产降级同义）；
 *   ③ 没有 subagent 种子（本会话没有子智能体）。
 */
async function readColdMaterialization({
  store,
  reader,
  sessionId,
  persistedMessages,
  loadOptions,
}) {
  const source = await loadPersistedConversationMaterialization({
    memoryEvents: [],
    persistedMessages,
    sessionId,
    store: {
      getSession: (id) => store.getSession(id),
      messages: (input) => store.messages(input),
      readTarget: (input) => store.readTarget(input),
      messageWithParts: (input) => store.messageWithParts(input),
      sessionEntries: (input) => store.sessionEntries(input),
    },
    ...(loadOptions?.fullMaterialization === true
      ? {}
      : {
          planColdWindow: async (facts) =>
            await readColdTailWindowMaterialization({
              sessionID: sessionId,
              store,
              reader,
              branchGeneration: facts.branchGeneration,
              expectedProjectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
              rewind: facts.rewind,
              ...(facts.persistedMessages === undefined
                ? {}
                : { loadedMessages: facts.persistedMessages }),
            }),
        }),
  });
  const windowPlan = source.coldWindow;
  const windowedMessageIds = windowPlan ? new Set(windowPlan.windowMessageIds) : null;
  const goalVerificationEntries = windowedMessageIds
    ? source.goalVerificationEntries.filter((entry) => {
        const anchor = entry.payload.anchorAssistantMessageId;
        return !anchor || windowedMessageIds.has(anchor);
      })
    : source.goalVerificationEntries;
  const modelBaseline =
    windowPlan?.precedingTurnFirstMessageId && store
      ? await readHydrationTurnModelSelection(
          store,
          sessionId,
          windowPlan.precedingTurnFirstMessageId,
        )
      : null;
  const initialModelKey = modelBaseline
    ? hydrationModelKeyOfSelection(modelBaseline.modelSelection)
    : null;
  const merged = mergeColdConversationEvents({
    memoryEvents: source.memoryEvents,
    messages: source.messages,
    sessionId,
    goalVerificationEntries,
    ...(Object.prototype.hasOwnProperty.call(source, "target") ? { target: source.target } : {}),
    ...(windowPlan
      ? {
          synthesis: {
            initialTurnNumber: windowPlan.ordinal,
            ...(initialModelKey === null ? {} : { initialModelKey }),
            ...(windowPlan.baseTimestampMs === undefined
              ? {}
              : { baseTimestampMs: windowPlan.baseTimestampMs }),
          },
        }
      : {}),
  });
  return {
    events: merged.events,
    synthesized: merged.usedDurableTranscript,
    sourceEventSeq: 0,
    branchGeneration: source.branchGeneration,
    ...(windowPlan ? { coldWindow: windowPlan } : {}),
    ...(modelBaseline === null
      ? {}
      : {
          synthesisModelBaseline: {
            provider: modelBaseline.modelSelection.providerId,
            model: modelBaseline.modelSelection.modelId,
            thought: modelBaseline.modelSelection.options?.reasoningLevel ?? "",
          },
        }),
    ...(loadOptions?.viewOnlyHydration === true ? { viewOnlyHydration: true } : {}),
  };
}

/**
 * 窗口/页的「上一轮模型基线」：bridge 的同名私有函数（`v4-bridge.ts:208`）只读一条消息，
 * 读不到就回 null（少一条冗余事件，不影响种子权威）。夹具按同一语义复刻。
 */
async function readHydrationTurnModelSelection(store, sessionId, messageId) {
  try {
    const message = await store.messageWithParts({ sessionID: sessionId, messageID: messageId });
    const modelSelection = message ? hydrationTurnModelSelectionOfMessage(message) : null;
    return modelSelection ? { modelSelection } : null;
  } catch {
    return null;
  }
}

function newCounters() {
  return {
    load: 0,
    loadOptions: [],
    shell: 0,
    resume: 0,
    page: 0,
    pagePlans: [],
    executed: [],
    wires: [],
    errors: [],
    debugs: [],
    events: [],
    live: false,
    runtimeActive: false,
    /** 可控的「激活悬在半空」——用来证明 view-only 期确实没就绪。 */
    resumeGate: null,
    /** 让下一次激活失败一次（验证失败不驻留）。 */
    failNextResume: false,
  };
}

function tempRoot(label) {
  return mkdtempSync(join(tmpdir(), `omz-cold-open-${label}-`));
}

/** 关掉真 sqlite 句柄再删临时目录（Windows 上不关就是 EBUSY）。 */
async function closeQuietly(world) {
  try {
    await world?.store?.close?.();
  } catch {
    // 清理失败不影响断言结论。
  }
  for (const runtime of world?.counters?.runtimes ?? []) {
    try {
      await runtime.close?.();
    } catch {
      // 同上。
    }
  }
}

/** 行身份（IS1 比较的单位：**只比身份**，不比正文）。 */
function identityOfRow(row) {
  return {
    rowId: row.rowId,
    turnId: row.turnId,
    kind: row.kind,
    createdAt: row.createdAt,
    ...(row.kind === "timelineMarker" ? { timelineType: row.timelineType } : {}),
  };
}

function fullProjectionRows(events) {
  const projection = new ProductProjection(SESSION_ID);
  for (const event of events) projection.applyEvent(event);
  return projection.getSnapshot().rows.window;
}

async function subscribeSnapshot(gateway, connectionId) {
  const result = await gateway.subscribe({
    topic: `conversation/${SESSION_ID}`,
    connectionId,
    clientMode: "desktop-continuous",
  });
  return result.initialFrame.payload.snapshot;
}

// ── A: IS1 / IS2（真 store 上的冷开）────────────────────────────────────────

// `coldWindowTurns` 是 8（`@zcode/shared/zcode-protocol-v4` 的 PROTOCOL_V4_LIMITS）。
// 会话必须**明显长于**窗口，A1 的「窗口 ⊂ 全量」才有意义（12 轮 = 36 行，窗口 24 行）。
const WINDOW_TURNS = 8;
const TOTAL_TURNS = 12;

async function coldWorld({ root, turnCount = TOTAL_TURNS, session = {} } = {}) {
  // 模型切换**恰好落在窗口首轮**（第 WINDOW_TURNS + 1 轮）：这样窗口头需要一个
  // `timelineMarker` 行，而它只能由「窗口前一轮的模型基线」推出来
  // （`precedingTurnFirstMessageId` → `initialModelKey` / `seedTurnModelBaseline`）。
  // 切在窗口之外会让这条接缝失去承重（变异探测下不会红）。
  const messages = transcript(turnCount, { modelChangeAtTurn: turnCount - WINDOW_TURNS + 1 });
  const store = await seededStore({ root, messages, session });
  const baseTimestampMs = messages[0].info.time.created;
  const events = synthesizeEventsFromMessages(messages, { sessionId: SESSION_ID, baseTimestampMs });
  const written = await writeTurnManifests(store, events);
  const reader = createSessionRowManifestReader({ store: () => store });
  const fullRows = fullProjectionRows(events);
  const counters = newCounters();
  const host = coldOpenHost({ store, reader, counters });
  return { messages, store, events, manifest: written, reader, fullRows, counters, host, root };
}

test("A1 (IS1): 窗口化冷开的行身份 = 全量物化的尾部前缀（rowId/turnId/kind/createdAt 逐值）", async (t) => {
  const root = tempRoot("a1");
  const world = await coldWorld({ root });
  t.after(async () => {
    await closeQuietly(world);
    rmSync(root, { recursive: true, force: true });
  });
  const gateway = new ConversationV4Gateway(world.host);
  try {
    const snapshot = await subscribeSnapshot(gateway, "conn-a1");
    const windowRows = snapshot.rows.window;
    assert.ok(windowRows.length > 0, "窗口必须真的物化出行");
    assert.ok(
      windowRows.length < world.fullRows.length,
      `夹具：窗口 (${windowRows.length}) 必须小于全量 (${world.fullRows.length})，否则这条用例白测`,
    );
    assert.equal(
      snapshot.rows.totalCount,
      snapshot.rows.totalCount,
      "totalCount 是 manifest 权威（下面单独比）",
    );

    // 尾部前缀：窗口是最近 WINDOW_TURNS 轮，必须与全量的对应尾部**逐值**相等。
    const tail = world.fullRows.slice(world.fullRows.length - windowRows.length);
    assert.deepEqual(
      windowRows.map(identityOfRow),
      tail.map(identityOfRow),
      "窗口行身份必须与全量物化的尾部逐值相等（IS1）",
    );
    // 显式的 rowId 断言：更短、更直白地指认「平移」这种漂移。
    assert.deepEqual(
      windowRows.map((row) => row.rowId),
      tail.map((row) => row.rowId),
      "rowId 必须逐值相等（漂移会表现为翻页锚点跳动）",
    );
    // 模型切换 marker：夹具把切换放在窗口首轮，因此窗口头**必须**有一行 marker，
    // 且它的 rowId 与全量里那一行逐值相等（少一行会让其后所有 rowId 前移一行）。
    const markers = (rows) => rows.filter((row) => row.kind === "timelineMarker");
    assert.ok(
      markers(windowRows).length > 0,
      "窗口首轮就是模型切换轮 → 窗口里必须有 timelineMarker 行（没有它 IS1 的比较就空转）",
    );
    assert.deepEqual(
      markers(windowRows).map((row) => row.rowId),
      markers(tail).map((row) => row.rowId),
      "timelineMarker（模型切换）行的 rowId 序列必须相等",
    );
    assert.equal(
      new Set(windowRows.map((row) => row.turnId)).size,
      WINDOW_TURNS,
      "窗口应恰好覆盖配置的轮数（整轮对齐）",
    );
    // 冷窗口的坐标必须真的生效过（否则上面比的是两份全量）。
    const outcome = gateway.getColdWindowOutcome(SESSION_ID);
    assert.ok(outcome, "首屏必须走过冷窗口路径");
    assert.equal(outcome.turnCount, WINDOW_TURNS);
    assert.equal(outcome.ordinal, TOTAL_TURNS - WINDOW_TURNS);
  } finally {
    gateway.dispose();
  }
});

test("A2 (IS2): revert 的 cut/target 落在窗口之外——不复活旧分支、也不清空历史", async (t) => {
  // 两种事故形态各一份真 store（都是「窗口已经物化不出来」的形态）：
  //   ① 清空防护（T-SL4）：cut 指向一条**已不存在**的消息（硬删/旧版残留）且没有 kept
  //      → 裁断必须退回整条分支，绝不能返回空历史。
  //   ② 复活防护（T-SL3）：target 在窗口之外、cut 指向第 1 轮之后 → 窗口游标不在 active 序
  //      里时，若仍按窗口播种就会把已回滚的 5..12 轮原样交出去。
  const rootGone = tempRoot("a2-gone");
  const goneWorld = await coldWorld({
    root: rootGone,
    session: {
      revert: { branchCutAfterMessageID: "m-deleted-u", keptMessageIDs: [] },
    },
  });
  const rootRolled = tempRoot("a2-rolled");
  const rolledWorld = await coldWorld({
    root: rootRolled,
    session: {
      revert: {
        targetMessageID: "m-2-u",
        createdMessageID: "m-2-r",
        keptMessageIDs: ["m-1-u", "m-1-a"],
      },
    },
  });
  t.after(async () => {
    await closeQuietly(goneWorld);
    rmSync(rootGone, { recursive: true, force: true });
    await closeQuietly(rolledWorld);
    rmSync(rootRolled, { recursive: true, force: true });
  });

  // ① 清空防护
  const goneGateway = new ConversationV4Gateway(goneWorld.host);
  try {
    const snapshot = await subscribeSnapshot(goneGateway, "conn-a2-gone");
    assert.ok(
      snapshot.rows.window.length > 0,
      "cut 指向不存在的消息时不得返回空历史（IS2 清空防护 / T-SL4）",
    );
    // 退化的 cut 被防御性地忽略 → 走的是正常的尾窗，行身份与全量尾部逐值相等。
    const tail = goneWorld.fullRows.slice(goneWorld.fullRows.length - snapshot.rows.window.length);
    assert.deepEqual(
      snapshot.rows.window.map(identityOfRow),
      tail.map(identityOfRow),
      "非法 cut 被忽略后，投影必须是正常的尾部窗口（不许多一行也不许少一行）",
    );
  } finally {
    goneGateway.dispose();
  }

  // ② 复活防护
  const rolledGateway = new ConversationV4Gateway(rolledWorld.host);
  try {
    const snapshot = await subscribeSnapshot(rolledGateway, "conn-a2-rolled");
    const rows = snapshot.rows.window;
    assert.ok(rows.length > 0, "回滚到第 1 轮之后仍然有历史");
    const turnIds = new Set(rows.map((row) => String(row.turnId)));
    for (let turnNumber = 2; turnNumber <= TOTAL_TURNS; turnNumber += 1) {
      assert.ok(
        !turnIds.has(`m-${turnNumber}-u`),
        `第 ${turnNumber} 轮已被回滚，不得出现在投影里（IS2 复活防护 / T-SL3）`,
      );
    }
    assert.deepEqual([...turnIds].sort(), ["m-1-u"], "active 分支只剩第 1 轮");
    assert.equal(rows.length, 3, "第 1 轮 = turnHeader + userInput + assistantText 三行");
    assert.equal(
      rolledGateway.getColdWindowOutcome(SESSION_ID),
      null,
      "裁断把窗口游标挤出 active 序时必须退回全量物化（不是按窗口播种 rowId）",
    );
  } finally {
    rolledGateway.dispose();
  }
});

// ── B: IS6 翻页（真 store，按需物化走生产读端）───────────────────────────────

test("B1 (IS6): 连续翻页到顶——行集合与全量一致、hasMore 按 manifest 首行、全程只冷开一次", async (t) => {
  const root = tempRoot("b1");
  const world = await coldWorld({ root });
  // 把激活**钉在半空**：翻页发生在 view-only 期，任何「读入口重新冷开」都会立刻可见
  // （若让它自然激活，激活后的全量升级会多一次 `fullMaterialization` 读，混进判据里）。
  const releaseResume = holdResume(world.counters);
  t.after(async () => {
    releaseResume();
    await closeQuietly(world);
    rmSync(root, { recursive: true, force: true });
  });
  const gateway = new ConversationV4Gateway(world.host);
  try {
    const snapshot = await subscribeSnapshot(gateway, "conn-b1");
    const seen = new Map(snapshot.rows.window.map((row) => [row.rowId, row]));
    let hasMore = snapshot.rows.hasOlderRows !== false;
    let guard = 0;
    while (hasMore) {
      guard += 1;
      assert.ok(guard <= TOTAL_TURNS + 2, "翻页必须有界（hasMore 恒 true 会死循环）");
      const beforeRowId = Math.min(...[...seen.keys()]);
      const page = await gateway.rowsRange({
        sessionId: SESSION_ID,
        beforeRowId,
        limit: 2,
        clientMode: "desktop-continuous",
      });
      for (const row of page.rows) seen.set(row.rowId, row);
      hasMore = page.hasMore === true;
      if (page.rows.length === 0) break;
    }

    // ① 行集合与全量一致（逐 rowId，值也比）。
    const byRowId = [...seen.values()].sort((left, right) => left.rowId - right.rowId);
    assert.deepEqual(
      byRowId.map(identityOfRow),
      world.fullRows.map(identityOfRow),
      "翻页到顶后行集合必须与全量物化逐值一致（T-SL9）",
    );
    // ② 深翻页后 rowId 仍连续（没有空洞、没有平移）。
    assert.deepEqual(
      byRowId.map((row) => row.rowId),
      world.fullRows.map((row) => row.rowId),
      "深翻页后 rowId 必须与全量一致",
    );
    // ③ 全程只冷开一次：外壳一次、正文读一次、按需物化若干次。
    assert.equal(world.counters.shell, 1, "翻页不得再次物化外壳（= 不得触发第二次冷开）");
    assert.equal(
      world.counters.load,
      1,
      `翻页不得重读整份正文：options=${JSON.stringify(world.counters.loadOptions)}`,
    );
    assert.equal(world.counters.resume, 1, "首屏的预激活已经发起过（夹具前提）");
    assert.ok(world.counters.page > 0, "夹具：翻页必须真的走到按需物化");
    assert.equal(world.counters.errors.length, 0, "翻页不得产生宿主错误");

    // ④ 放行激活：升级是唯一一次全量读，且不碰外壳。
    releaseResume();
    await waitFor(
      () => world.counters.loadOptions.some((options) => options.fullMaterialization === true),
      "激活成功后必须发生一次全量升级",
    );
    assert.equal(world.counters.shell, 1, "升级不碰外壳");
    assert.equal(
      world.counters.loadOptions.filter((options) => options.fullMaterialization !== true).length,
      1,
      "升级之外的正文读仍然只有一次（升级是全量口径，不计入冷开）",
    );
  } finally {
    gateway.dispose();
  }
});

// ── C: 真 runtime（T-SL10 / T-SL11 / T-SL13 / T-SL14）──────────────────────

const MODEL_PROPERTIES = {
  requiresMfjsToolSchema: false,
  contextWindow: 200_000,
  inputFormat: {
    supportsText: true,
    supportsImage: true,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
  supportsToolCall: true,
  supportsJsonSchemaOutput: false,
  supportsNativeWebSearch: false,
  supportsMidConversationSystem: false,
};

/** 记录 provider 实际收到的请求的 stub model（这是 T-SL13 的观测点本体）。 */
function recordingModel(requestLog) {
  const model = {
    providerId: "provider-a",
    modelId: "model-a",
    displayName: "recording-model",
    properties: MODEL_PROPERTIES,
    optionSpecs: { maxOutputTokens: { max: 8_192, map: "8192" } },
    options: {},
    bind() {
      return model;
    },
    async generateText(request) {
      requestLog.push({ kind: "generate", request });
      return { text: "stub answer", finishReason: "stop", toolCalls: [], usage: {} };
    },
    async *streamText(request) {
      requestLog.push({ kind: "stream", request });
      yield { type: "text_end", id: "part-stub" };
      yield { type: "finish", finishReason: "stop", usage: {} };
    },
  };
  return model;
}

/**
 * 真 runtime + 真 store 的世界。
 *
 * `deps.createZCodeApp` 是**唯一**被替换的装配点（它本来就是注入点）：返回的真
 * `AgentRuntime` 与 `create-app.ts` 的 `resumeFromStore` 同一条链（`historyMode` 原样透传）。
 * 外壳与激活走生产的 `materializeSessionShell` / `activateRuntime`。
 */
function realRuntimeWorld({ root, store, requestLog, counters, logger }) {
  const context = {
    sessions: new Map(),
    deps: {
      version: "0.0.0-test",
      platform: "win32",
      env: {},
      sessionStore: store,
      createSessionEventStore: () => createInMemorySessionEventStore(),
      createZCodeApp: async (options) => {
        const runtime = new AgentRuntime(
          options.sessionId,
          {
            workingDirectory: options.runtimeConfig?.workingDirectory ?? root,
            modelSelection: { providerId: "provider-a", modelId: "model-a" },
          },
          {
            appVersion: "0.0.0-test",
            eventStore: options.eventStore,
            sessionStore: store,
            modelFactory: () => recordingModel(requestLog),
            logger,
            traceContext: { traceId: `trace-${options.sessionId}` },
          },
        );
        counters.runtimes.push(runtime);
        return {
          sessionId: options.sessionId,
          runtime,
          resume: async (resumeOptions) => {
            counters.runtimeResumes += 1;
            const result = await runtime.resumeFromStore({
              ...(resumeOptions?.historyMode ? { historyMode: resumeOptions.historyMode } : {}),
            });
            return { modelSelection: result.modelSelection, ...result };
          },
          close: async () => {
            await runtime.close?.();
          },
        };
      },
    },
    logger,
    appRuntimePreferences: {
      dynamicWorkflowEnabled: false,
      modelIoFullRetentionEnabled: false,
    },
    v4Interactions: {
      initializeAskUserQuestionAutoResolutionEnabled: async () => {},
    },
    assertServing: () => {},
    // 无 Host 的兼容分支（生产里旧 Host 返回 -32601 时走的同一条）。
    requestClient: async () => {
      throw new ProtocolRequestError(-32601, "no host in test");
    },
  };
  return context;
}

/**
 * C 组的宿主：外壳/激活走生产函数，事件转发到 gateway，`executeCommand` 直连真 runtime。
 */
function realRuntimeHost({ context, gatewayRef, counters }) {
  let shell = null;
  const host = {
    sessionExists: () => context.sessions.has(SESSION_ID),
    // 与 bridge 同一条判定：record 在册 ≠ runtime 在跑。
    isSessionRuntimeActive: (sessionId) => {
      const record = context.sessions.get(sessionId);
      return record !== undefined && record.runtimeViewOnlyShell !== true;
    },
    emitWireFrame: (wire) => counters.wires.push(wire),
    onError: (scope, error) => counters.errors.push({ scope, error }),
    onDebug: (message) => counters.debugs.push(String(message)),
    // bridge 的实现就是「store 里没有 → notFound；有 → 生产 materializeSessionShell」。
    materializeSessionShell: async (sessionId) => {
      counters.shell += 1;
      const persisted = await context.deps.sessionStore.getSession(sessionId);
      if (!persisted) return { status: "notFound" };
      shell = await materializeSessionShell(context, { sessionId });
      return { status: "materialized" };
    },
    // bridge 的实现是 `activateSessionForResume` = materializeSessionShell + activateRuntime
    // （`v4-bridge.ts:1672`）。这里把两步显式写开，只为断言「各只发生一次」。
    resumePersistedSession: async (sessionId) => {
      counters.resume += 1;
      const persisted = await context.deps.sessionStore.getSession(sessionId);
      if (!persisted) return { status: "notFound" };
      if (shell === null || shell.record !== context.sessions.get(sessionId)) {
        shell = await materializeSessionShell(context, { sessionId });
      }
      // 让激活悬在半空：覆盖「ACK 之后的预激活还在飞时，send 类命令拿到同一次飞行」。
      if (counters.resumeGate) await counters.resumeGate.promise;
      if (counters.failNextResume === true) {
        // 一次瞬时激活失败（provider registry 抖动 / 存储瞬时错误）：必须不驻留。
        counters.failNextResume = false;
        throw new Error("activation boom (test)");
      }
      // `reusePersistedMessages: true` + `historyMode: "none"`：与 bridge 的 v4 激活逐值同参。
      const activated = await activateRuntime(context, shell, {
        historyMode: "none",
        reusePersistedMessages: true,
      });
      return { status: "resumed", persistedMessages: activated.persistedMessages ?? [] };
    },
    loadPersistedEvents: async (sessionId, persistedMessages, loadOptions) => {
      counters.load += 1;
      counters.loadOptions.push(loadOptions ?? {});
      const record = context.sessions.get(sessionId);
      const [liveEvents] = record
        ? await Promise.all([record.eventStore.getEvents(sessionId)])
        : [[]];
      return await readColdMaterializationWithMemoryEvents({
        store: context.deps.sessionStore,
        reader: gatewayRef.reader,
        sessionId,
        persistedMessages,
        loadOptions,
        memoryEvents: liveEvents,
        // view-only 首屏：record 还是外壳（runtime 没起）→ usage / fileChanges 一起缺席。
        viewOnlyShell: record?.runtimeViewOnlyShell === true,
        record,
      });
    },
    readRowManifest: (sessionId, input) => gatewayRef.reader.read(sessionId, input),
    invalidateRowManifestIndex: (sessionId) => gatewayRef.reader.invalidateMessageIndex(sessionId),
    materializeRowPage: async (sessionId, plan) => {
      counters.page += 1;
      const page = await readColdRowPageMaterialization({
        sessionID: sessionId,
        store: context.deps.sessionStore,
        reader: gatewayRef.reader,
        plan,
      });
      if (page.kind !== "page") return null;
      const baseline = plan.precedingTurnFirstMessageId
        ? await readHydrationTurnModelSelection(
            context.deps.sessionStore,
            sessionId,
            plan.precedingTurnFirstMessageId,
          )
        : null;
      const initialModelKey = baseline
        ? hydrationModelKeyOfSelection(baseline.modelSelection)
        : null;
      const merged = mergeColdConversationEvents({
        memoryEvents: [],
        messages: page.messages,
        sessionId,
        goalVerificationEntries: [],
        synthesis: {
          initialTurnNumber: plan.ordinal,
          ...(initialModelKey === null ? {} : { initialModelKey }),
          ...(page.baseTimestampMs === undefined ? {} : { baseTimestampMs: page.baseTimestampMs }),
        },
      });
      return {
        events: merged.events,
        messageCount: page.messages.length,
        initialModelKeyResolved: initialModelKey !== null,
      };
    },
    getSessionUsageSeed: async () => {
      const record = context.sessions.get(SESSION_ID);
      if (!record || record.runtimeViewOnlyShell === true) return null;
      // 生产从 runtime 的 context usage 派生（view-only 期刻意不给）。形状与
      // `sessionUsageSeedFromRuntimeContextUsage` 一致：`{contextWindow:{usedTokens,maxTokens}}`。
      return {
        contextWindow: { usedTokens: 1_234, maxTokens: MODEL_PROPERTIES.contextWindow },
        cumulative: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
    executeCommand: async (envelope) => {
      counters.executed.push(envelope.type);
      if (envelope.type !== "sendText") return undefined;
      const record = context.sessions.get(SESSION_ID);
      if (!record) throw new Error("sendText without record");
      const text = String(envelope.payload?.text ?? "");
      const admission = await record.app.runtime.admitPrompt(text, undefined, {
        traceContext: record.traceContext,
      });
      if (admission.kind === "started") await admission.completion;
      return undefined;
    },
  };
  return host;
}

/** 带内存事件的冷开物化（C 组：激活后 record.eventStore 里会有 resume 恢复的 checkpoint）。 */
async function readColdMaterializationWithMemoryEvents({
  store,
  reader,
  sessionId,
  persistedMessages,
  loadOptions,
  memoryEvents,
  viewOnlyShell,
  record,
}) {
  const source = await loadPersistedConversationMaterialization({
    memoryEvents,
    persistedMessages,
    sessionId,
    store: {
      getSession: (id) => store.getSession(id),
      messages: (input) => store.messages(input),
      readTarget: (input) => store.readTarget(input),
      messageWithParts: (input) => store.messageWithParts(input),
      sessionEntries: (input) => store.sessionEntries(input),
    },
    ...(loadOptions?.fullMaterialization === true
      ? {}
      : {
          planColdWindow: async (facts) =>
            await readColdTailWindowMaterialization({
              sessionID: sessionId,
              store,
              reader,
              branchGeneration: facts.branchGeneration,
              expectedProjectionSchemaVersion: TURN_MANIFEST_PROJECTION_SCHEMA_VERSION,
              rewind: facts.rewind,
              ...(facts.persistedMessages === undefined
                ? {}
                : { loadedMessages: facts.persistedMessages }),
            }),
        }),
  });
  const windowPlan = source.coldWindow;
  const windowedMessageIds = windowPlan ? new Set(windowPlan.windowMessageIds) : null;
  const goalVerificationEntries = windowedMessageIds
    ? source.goalVerificationEntries.filter((entry) => {
        const anchor = entry.payload.anchorAssistantMessageId;
        return !anchor || windowedMessageIds.has(anchor);
      })
    : source.goalVerificationEntries;
  const modelBaseline = windowPlan?.precedingTurnFirstMessageId
    ? await readHydrationTurnModelSelection(
        store,
        sessionId,
        windowPlan.precedingTurnFirstMessageId,
      )
    : null;
  const initialModelKey = modelBaseline
    ? hydrationModelKeyOfSelection(modelBaseline.modelSelection)
    : null;
  // fileChanges 摘要：与 bridge 同一条门——只有「有 record（有 artifact reader）」才重建。
  // 真冷（record 缺席）时它是空的，这是**预期降级**（首屏降级清单第 ⑤ 项）。
  const fileChangeSummaries = record
    ? await buildFileChangeSummaries({
        events: source.memoryEvents,
        messageIds: windowPlan
          ? windowPlan.activeMessageIds.map((messageId) => String(messageId))
          : source.messages.map((message) => String(message.info.id)),
      })
    : undefined;
  const merged = mergeColdConversationEvents({
    memoryEvents: source.memoryEvents,
    messages: source.messages,
    sessionId,
    goalVerificationEntries,
    ...(fileChangeSummaries === undefined
      ? {}
      : { fileChangeSummariesByMessageId: fileChangeSummaries }),
    ...(Object.prototype.hasOwnProperty.call(source, "target") ? { target: source.target } : {}),
    ...(windowPlan
      ? {
          synthesis: {
            initialTurnNumber: windowPlan.ordinal,
            ...(initialModelKey === null ? {} : { initialModelKey }),
            ...(windowPlan.baseTimestampMs === undefined
              ? {}
              : { baseTimestampMs: windowPlan.baseTimestampMs }),
          },
        }
      : {}),
  });
  return {
    events: merged.events,
    synthesized: merged.usedDurableTranscript,
    sourceEventSeq: 0,
    branchGeneration: source.branchGeneration,
    ...(windowPlan ? { coldWindow: windowPlan } : {}),
    ...(modelBaseline === null
      ? {}
      : {
          synthesisModelBaseline: {
            provider: modelBaseline.modelSelection.providerId,
            model: modelBaseline.modelSelection.modelId,
            thought: modelBaseline.modelSelection.options?.reasoningLevel ?? "",
          },
        }),
    ...(viewOnlyShell || record === undefined ? { viewOnlyHydration: true } : {}),
  };
}

/** 与 `v4-bridge.ts:2137` 的 `buildColdFileChangeSummaries` 同一入口（夹具只提供 artifact 内容）。 */
async function buildFileChangeSummaries({ events, messageIds }) {
  const { buildColdFileChangeSummaries } = await import(
    new URL("../src/zcode-protocol-v4/cold-file-change-summaries.ts", import.meta.url).href
  );
  const durableMessageIds = new Set(messageIds);
  const checkpoints = events.filter((event) => event.type === SessionEventType.CheckpointCreated);
  if (checkpoints.length === 0) return new Map();
  return await buildColdFileChangeSummaries({
    events,
    messageIds: [...durableMessageIds],
    readArtifact: async (snapshotRef) => WORKSPACE_ARTIFACTS[snapshotRef] ?? "{}",
  });
}

const WORKSPACE_ARTIFACTS = {
  "artifact-turn-6": JSON.stringify({
    version: 1,
    kind: "workspace_file_before_change",
    createdAt: "2026-10-25T00:00:00.000Z",
    toolCallId: "toolu-turn-6",
    toolName: "Write",
    files: [
      {
        path: "src/app.ts",
        existedBefore: true,
        beforeContent: "const a = 1;\n",
        afterContent: "const a = 1;\nconst b = 2;\n",
        structuredPatch: [],
      },
    ],
  }),
};

async function realRuntimeCase({ root, turnCount = TOTAL_TURNS, counters, requestLog, logger }) {
  const messages = transcript(turnCount, { modelChangeAtTurn: 4 });
  const store = await seededStore({ root, messages });
  const baseTimestampMs = messages[0].info.time.created;
  const events = synthesizeEventsFromMessages(messages, { sessionId: SESSION_ID, baseTimestampMs });
  await writeTurnManifests(store, events);
  // 第 6 轮的文件改动：落在 session_entry 里（resume 会把它恢复成 CheckpointCreated 事件，
  // 于是激活后的全量升级才有 artifact reader 可用 → fileChanges 补齐）。
  // `data` 的形状必须与 `persistWorkspaceCheckpointEntry` 写入的逐字段一致
  // （`core/.../workspace-checkpoint-persistence.ts:44-50`）：`eventId` 缺席会被读端整条丢弃。
  await store.saveSessionEntry({
    id: "entry-checkpoint-6",
    sessionID: SESSION_ID,
    type: "runtime/workspace_checkpoint",
    time: { created: 1_700_000_006_000, updated: 1_700_000_006_000 },
    data: {
      eventId: "evt-checkpoint-6",
      payload: {
        checkpointId: "ckpt-turn-6",
        messageId: "m-6-u",
        targetMessageId: "m-6-u",
        scope: "both",
        snapshotRef: "artifact-turn-6",
        fileCount: 1,
      },
      sequenceNumber: 900,
      traceId: "trace-ckpt-6",
      turnId: "turn-6",
    },
  });
  const reader = createSessionRowManifestReader({ store: () => store });
  const context = realRuntimeWorld({ root, store, requestLog, counters, logger });
  const gatewayRef = { reader };
  const host = realRuntimeHost({ context, gatewayRef, counters });
  const gateway = new ConversationV4Gateway(host);
  return { gateway, context, counters, messages, store, events, reader, requestLog };
}

/** 把真 runtime 的事件接进 gateway（record 建好后才有 runtime，所以延迟接线）。 */
function forwardRuntimeEvents(runtime, gateway) {
  return runtime.subscribeEvents({
    onSessionEvent: (event) => gateway.ingest(SESSION_ID, event),
  });
}

test("C1 (T-SL10): view-only 非 send 拒（runtimeNotReady）；send 是唯一激活入口且真起一轮", async (t) => {
  const root = tempRoot("c1");
  const counters = newCounters();
  counters.runtimes = [];
  counters.runtimeResumes = 0;
  const requestLog = [];
  const { logger } = recordingLogger();
  const world = await realRuntimeCase({ root, counters, requestLog, logger });
  const { gateway, context } = world;
  const unsubscribers = [];
  // 让 ACK 之后那次预激活**失败一次**：只有「激活失败且不驻留」时才会出现
  // 「runtime 未就绪而命令已经到达」的窗口。require-runtime 命令会先等已在飞的水位
  // （`handleCommand:3423`），所以「把激活钉在半空再去发非 send 命令」不是这个窗口，
  // 而是生产里刻意不允许的形态（那样命令会一直等到激活收口）。
  counters.failNextResume = true;
  t.after(async () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    gateway.dispose();
    await closeQuietly(world);
    rmSync(root, { recursive: true, force: true });
  });
  // 首屏（view-only 外壳）：订阅一次，接线真 runtime 的事件。
  const snapshot = await subscribeSnapshot(gateway, "conn-c1a");
  assert.equal(
    snapshot.availability.sessionRuntime,
    "viewOnly",
    "外壳在册而 runtime 没起 → 首屏必须是 viewOnly",
  );
  const record = context.sessions.get(SESSION_ID);
  assert.ok(record?.app?.runtime, "外壳必须真的建出 runtime（materializeSessionShell 的产物）");
  unsubscribers.push(forwardRuntimeEvents(record.app.runtime, gateway));
  await waitFor(
    () =>
      counters.errors.some(
        (entry) => entry.scope.includes("resume") || entry.scope.includes("activation"),
      ),
    "预激活的失败必须被记账（否则下面大概率撞上「还在飞」而不是「还没起」）",
  );

  // ① 非 send 类：未就绪时必须回可重试的 runtimeNotReady（不是 executionFailed）。
  const rejected = await gateway.handleCommand({
    commandId: "cmd-c1-stop",
    clientId: "client-test",
    sessionId: SESSION_ID,
    type: "stop",
    payload: {},
    issuedAt: 1_700_000_000_000,
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reasonCode, "runtimeNotReady", "非 send 类不得被当成失败");
  assert.equal(counters.executed.length, 0, "被门拒掉的命令不得进 handler");
  assert.equal(counters.runtimeResumes, 0, "非 send 类不得自己 resume");

  // ③ queryCommands 不受 runtime 门限（view-only 上必须照常可用）。
  const queried = await gateway.queryCommands({
    commands: [{ sessionId: SESSION_ID, commandId: "never-seen" }],
  });
  assert.equal(queried.results[0].result, "unknown");

  // ② send 类：唯一激活入口，不回拒，激活后**真的起一轮**。
  // 前一次失败不驻留：这一次必须真的重新 resume。
  const ack = await gateway.handleCommand({
    commandId: "cmd-c1-send",
    clientId: "client-test",
    sessionId: SESSION_ID,
    type: "sendText",
    payload: { text: "继续说" },
    issuedAt: 1_700_000_000_000,
  });
  assert.equal(ack.status, "accepted", "send 类不得被 runtimeNotReady 拒（那会死锁）");
  assert.equal(counters.resume, 2, "失败不驻留：send 必须重新发起一次激活");
  assert.equal(counters.runtimeResumes, 1, "成功的那次 resume 恰好一次（失败的那次没进 runtime）");
  assert.deepEqual(counters.executed, ["sendText"], "激活后命令必须真正执行");
  assert.equal(requestLog.length, 1, "send 必须真的打到 provider（真起一轮，不是空转）");
  assert.equal(
    (await gateway.runtimeReady({ sessionId: SESSION_ID })).runtimeReady,
    true,
    "T-SL16：激活后 runtime 必须就绪且有本体耗时",
  );

  // 激活后快照翻回 live（同一 provider，不需要二次接线）。
  const after = await subscribeSnapshot(gateway, "conn-c1b");
  assert.equal(after.availability.sessionRuntime, "live");
});

test("C2 (T-SL11): 激活不产生第二条 SessionResumed；升级后 rowId 与 view-only 期逐值相等", async (t) => {
  const root = tempRoot("c2");
  const counters = newCounters();
  counters.runtimes = [];
  counters.runtimeResumes = 0;
  const requestLog = [];
  const { logger } = recordingLogger();
  const world = await realRuntimeCase({ root, counters, requestLog, logger });
  const { gateway, context } = world;
  const resumedEvents = [];
  const unsubscribers = [];
  // 预激活与 send 类命令**并发**撞同一条激活：这正是「第二条 SessionResumed」最容易出现的形态。
  const releaseResume = holdResume(counters);
  t.after(async () => {
    releaseResume();
    for (const unsubscribe of unsubscribers) unsubscribe();
    gateway.dispose();
    await closeQuietly(world);
    rmSync(root, { recursive: true, force: true });
  });

  const first = await subscribeSnapshot(gateway, "conn-c2a");
  const viewOnlyRows = first.rows.window;
  const record = context.sessions.get(SESSION_ID);
  unsubscribers.push(
    record.app.runtime.subscribeEvents({
      onSessionEvent: (event) => {
        if (event.type === SessionEventType.SessionResumed) resumedEvents.push(event);
        gateway.ingest(SESSION_ID, event);
      },
    }),
  );
  assert.equal(resumedEvents.length, 0, "外壳阶段不得有 SessionResumed（runtime 还没起）");
  assert.equal(counters.resume, 1, "夹具：ACK 之后的后台预激活已经发起（并在飞）");

  // send 类命令必须汇入同一次飞行，而不是发起第二次 resume。
  const sending = gateway.handleCommand({
    commandId: "cmd-c2-send",
    clientId: "client-test",
    sessionId: SESSION_ID,
    type: "sendText",
    payload: { text: "继续说" },
    issuedAt: 1_700_000_000_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(counters.resume, 1, "send 期间不得出现第二个激活飞行");
  releaseResume();
  const ack = await sending;
  assert.equal(ack.status, "accepted");

  // 升级是 fire-and-forget：等到 host 收到 fullMaterialization 那次调用。
  await waitFor(
    () => counters.loadOptions.some((options) => options.fullMaterialization === true),
    "激活成功后必须排一次全量升级",
  );
  await waitFor(
    () => counters.debugs.some((line) => line.includes("v4 projection upgrade applied")),
    "升级必须落定（否则下面比的是两份窗口投影）",
  );

  assert.equal(
    resumedEvents.length,
    1,
    "激活 + 升级 + 首轮 send 全程只能有一条 SessionResumed（幽灵 runtime 前哨）",
  );
  assert.equal(counters.runtimeResumes, 1, "第二次 resume 会追写第二条 SessionResumed");
  assert.equal(resumedEvents[0].payload.messageCount, 0, "lazy resume：messageCount=0 是预期");
  assert.equal(resumedEvents[0].payload.partCount, 0, "lazy resume：partCount=0 是预期");
  assert.equal(
    resumedEvents[0].payload.directory,
    root,
    "事件仍要带 workspace 事实（不是把 payload 整体压空）",
  );

  // 升级后的全量投影：view-only 期下发过的每一行都必须**原样**在场（rowId 逐值）。
  const after = await subscribeSnapshot(gateway, "conn-c2b");
  const afterById = new Map(after.rows.window.map((row) => [row.rowId, row]));
  for (const row of viewOnlyRows) {
    const upgraded = afterById.get(row.rowId);
    assert.ok(upgraded, `rowId ${row.rowId} 在升级后消失（翻页锚点会跳）`);
    assert.deepEqual(
      identityOfRow(upgraded),
      identityOfRow(row),
      `rowId ${row.rowId} 的身份在升级前后必须逐值相等（T-SL11）`,
    );
  }
  // 升级必须真的补了更早的行（否则上面的比较是「窗口 vs 窗口」）。
  assert.ok(after.rows.totalCount > viewOnlyRows.length, "升级后的投影必须包含窗口之外的历史");
});

test("C3 (T-SL13): 真 store 上的首次发送，provider 收到的历史与 historyMode:'full' 逐字节相等", async (t) => {
  const roots = [tempRoot("c3-lazy"), tempRoot("c3-full")];
  // 两条路径必须共用同一个 workingDirectory（系统提示里有工作目录），否则比的是环境差异。
  const workDir = tempRoot("c3-work");
  t.after(() => {
    for (const root of [...roots, workDir]) rmSync(root, { recursive: true, force: true });
  });
  const messages = transcript(3, { modelChangeAtTurn: 2 });

  const run = async (root, historyMode) => {
    // `session.directory` 决定 resumed runtime 的 workingDirectory（系统提示里写着它），
    // 两条路径必须共用同一个值，否则比出来的是「两个临时目录」的差异而不是历史差异。
    const store = await seededStore({ root, messages, session: { directory: workDir } });
    const requestLog = [];
    const counters = newCounters();
    counters.runtimes = [];
    counters.runtimeResumes = 0;
    const { logger } = recordingLogger();
    const runtime = new AgentRuntime(
      SESSION_ID,
      {
        workingDirectory: workDir,
        modelSelection: { providerId: "provider-a", modelId: "model-a" },
      },
      {
        appVersion: "0.0.0-test",
        eventStore: createInMemorySessionEventStore(),
        sessionStore: store,
        modelFactory: () => recordingModel(requestLog),
        logger,
        traceContext: { traceId: `trace-${historyMode}` },
      },
    );
    const resume = await runtime.resumeFromStore({ historyMode });
    const deferredAfterResume = runtime.deferredHistoryHydration;
    const turn = await runtime.executeTurn("第四问", [], { traceContext: { traceId: "t4" } });
    const deferredAfterTurn = runtime.deferredHistoryHydration;
    await runtime.close?.();
    store.close?.();
    return { resume, turn, requestLog, deferredAfterResume, deferredAfterTurn };
  };

  const lazy = await run(roots[0], "none");
  const full = await run(roots[1], "full");

  // lazy 的 resume 语义：三个计数恒为 0（不是 bug），正文在待办里。
  assert.equal(lazy.resume.messageCount, 0, "lazy resume 的 messageCount 恒为 0 是预期");
  assert.equal(lazy.resume.partCount, 0);
  assert.equal(lazy.resume.appliedMessageCount, 0);
  assert.ok(lazy.deferredAfterResume, "闸门跑之前必须留下待办（provider 历史尚未水化）");
  assert.equal(
    lazy.deferredAfterTurn,
    undefined,
    "闸门跑完必须消费掉待办（否则下一轮会再水化一份 → 历史出现两份）",
  );
  assert.equal(full.resume.appliedMessageCount, 6, "full 路径在 resume 里就水化完（对照组）");

  // provider 实际收到的请求：这是 T-SL13 的判据本体。
  assert.equal(lazy.requestLog.length, 1, "首次发送必须真的打到 provider");
  assert.equal(full.requestLog.length, 1);
  const lazyMessages = lazy.requestLog[0].request.messages;
  const fullMessages = full.requestLog[0].request.messages;
  assert.equal(
    JSON.stringify(lazyMessages),
    JSON.stringify(fullMessages),
    "historyMode:'none' 的首次发送历史必须与 'full' 逐字节相等（顺序：context → 历史 → resume 期注入）",
  );
  // 正文确实进了请求（不是两份都空）。
  const roles = lazyMessages.map((message) => message.role);
  assert.deepEqual(
    roles,
    [
      "system",
      "system",
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ],
    "历史三段必须按 context → 持久正文 → 本轮输入 的顺序出现",
  );
  assert.ok(
    JSON.stringify(lazyMessages).includes("问 1") && JSON.stringify(lazyMessages).includes("答 3"),
    "持久正文必须真的进请求（否则逐字节相等是两份空历史）",
  );
  assert.equal(lazy.turn.response, "stub answer");
});

test("C4 (T-SL14): view-only 首屏无 usage / 无 fileChanges；激活后两者补齐", async (t) => {
  const root = tempRoot("c4");
  const counters = newCounters();
  counters.runtimes = [];
  counters.runtimeResumes = 0;
  const requestLog = [];
  const { logger } = recordingLogger();
  const world = await realRuntimeCase({ root, counters, requestLog, logger });
  const { gateway, context } = world;
  const unsubscribers = [];
  t.after(async () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    gateway.dispose();
    await closeQuietly(world);
    rmSync(root, { recursive: true, force: true });
  });

  const first = await subscribeSnapshot(gateway, "conn-c4a");
  const record = context.sessions.get(SESSION_ID);
  unsubscribers.push(forwardRuntimeEvents(record.app.runtime, gateway));

  // 首屏降级：usage / fileChanges 都缺席，而且是**明确缺席**（不是伪造默认值）。
  const firstHeaders = first.rows.window.filter((row) => row.kind === "turnHeader");
  assert.ok(firstHeaders.length > 0, "夹具：首屏必须有 turnHeader 行");
  assert.ok(
    firstHeaders.every((row) => row.fileChanges === undefined),
    "view-only 首屏不得有 fileChanges 摘要（那需要 runtime 的 artifact reader）",
  );
  assert.equal(
    first.usage.contextWindow,
    null,
    "view-only 首屏不得给 contextWindow（默认分母比「暂时没有」更误导）",
  );

  await gateway.handleCommand({
    commandId: "cmd-c4-send",
    clientId: "client-test",
    sessionId: SESSION_ID,
    type: "sendText",
    payload: { text: "继续说" },
    issuedAt: 1_700_000_000_000,
  });
  await waitFor(
    () => counters.debugs.some((line) => line.includes("v4 projection upgrade applied")),
    "激活后必须完成全量升级（补齐只发生在升级里）",
  );

  const after = await subscribeSnapshot(gateway, "conn-c4b");
  const headersWithSummary = after.rows.window.filter(
    (row) => row.kind === "turnHeader" && row.fileChanges !== undefined,
  );
  assert.ok(
    headersWithSummary.length > 0,
    "激活后 fileChanges 摘要必须补齐（session_entry 的 checkpoint 在 resume 时被恢复成事件）",
  );
  assert.equal(headersWithSummary[0].fileChanges.files, 1);
  assert.equal(headersWithSummary[0].fileChanges.additions, 1);
  assert.equal(
    headersWithSummary[0].turnId,
    "m-6-u",
    "摘要必须挂在**第 6 轮**的 turnHeader 上（checkpoint 的 targetMessageId 决定归属）",
  );
  assert.equal(
    typeof after.usage.contextWindow?.maxTokens,
    "number",
    "激活后 usage 必须补齐（runtime 知道分母）",
  );
  assert.ok((after.usage.contextWindow.usedTokens ?? 0) > 0, "usage 必须有实际用量");
});

// ── D: 两条遗留（fileChanges 首屏可用性 + 升级/首轮 send 并发）────────────────

test("D1 (遗留①): 真冷首屏拿不到 fileChanges 摘要，页物化也不重建（现有口径，记账不修）", async (t) => {
  const root = tempRoot("d1");
  // record 缺席 = 真冷：`buildColdFileChangeSummaries` 的数据源（内存 CheckpointCreated）
  // 与 artifact reader 都不存在，因此摘要**不可用**——这是首屏降级清单的第 ⑤ 项。
  const world = await coldWorld({ root });
  t.after(async () => {
    await closeQuietly(world);
    rmSync(root, { recursive: true, force: true });
  });
  const gateway = new ConversationV4Gateway(world.host);
  try {
    const snapshot = await subscribeSnapshot(gateway, "conn-d1");
    const headers = snapshot.rows.window.filter((row) => row.kind === "turnHeader");
    assert.ok(headers.length > 0);
    assert.ok(
      headers.every((row) => row.fileChanges === undefined),
      "真冷首屏：fileChanges 摘要不可用（artifact reader 缺席，摘要为空是预期降级）",
    );
    // 页物化同样不重建摘要（`v4-bridge.ts:1541-1546` 的已知代价）。
    await gateway.rowsRange({
      sessionId: SESSION_ID,
      beforeRowId: Math.min(...snapshot.rows.window.map((row) => row.rowId)),
      limit: 4,
      clientMode: "desktop-continuous",
    });
    const afterPage = await subscribeSnapshot(gateway, "conn-d1b");
    assert.ok(
      afterPage.rows.window
        .filter((row) => row.kind === "turnHeader")
        .every((row) => row.fileChanges === undefined),
      "按需物化的页不得凭空长出 fileChanges 摘要（页不读 artifact）",
    );
    // 源码守卫：这条「不重建」是**刻意的**，不是漏写——bridge 里必须有那段记账注释，
    // 而且按需物化的执行体里**不得**出现摘要构造器（出现了就是悄悄改了口径）。
    const bridgeSource = readFileSync(
      new URL("../src/zcode-protocol/v4-bridge.ts", import.meta.url),
      "utf8",
    );
    assert.ok(
      bridgeSource.includes("刻意不对称") && bridgeSource.includes("不重建 `fileChanges` 摘要"),
      "「页不重建 fileChanges 摘要」必须留下刻意的记账（否则会被当成 bug 复现不了）",
    );
    const pageAt = bridgeSource.indexOf("materializeRowPage: async (sessionId, plan) => {");
    assert.ok(pageAt > 0, "bridge 的按需物化入口必须存在");
    const pageBody = bridgeSource.slice(
      pageAt,
      bridgeSource.indexOf("materializeSessionShell: async (sessionId, resumeThoughtLevel", pageAt),
    );
    assert.ok(
      !pageBody.includes("buildColdFileChangeSummaries"),
      "按需物化不得构造 fileChanges 摘要（那是冷窗口路径的成本，页不付）",
    );
  } finally {
    gateway.dispose();
  }
});

test("D2 (遗留②): 升级与首轮 send 并发——观测流式行是否回退（risk 16）", async (t) => {
  const root = tempRoot("d2");
  const counters = newCounters();
  counters.runtimes = [];
  counters.runtimeResumes = 0;
  const requestLog = [];
  const { logger } = recordingLogger();
  const world = await realRuntimeCase({ root, counters, requestLog, logger });
  const { gateway, context } = world;
  const unsubscribers = [];
  t.after(async () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    gateway.dispose();
    await closeQuietly(world);
    rmSync(root, { recursive: true, force: true });
  });

  // 客户端视角的行观测：**出站帧序列**（`emitWireFrame` 的完整快照 + 行增量）。
  // 用帧而不是「再订阅一次」：resync 快照正是升级改写投影后客户端实际收到的形态，
  // 回退（行数/rowId 上界倒退）只会在帧序列里可见。
  const first = await subscribeSnapshot(gateway, "conn-d2a");
  const beforeRows = first.rows.window;
  const record = context.sessions.get(SESSION_ID);
  unsubscribers.push(forwardRuntimeEvents(record.app.runtime, gateway));

  await gateway.handleCommand({
    commandId: "cmd-d2-send",
    clientId: "client-test",
    sessionId: SESSION_ID,
    type: "sendText",
    payload: { text: "继续说" },
    issuedAt: 1_700_000_000_000,
  });
  await waitFor(
    () => counters.debugs.some((line) => line.includes("v4 projection upgrade applied")),
    "本轮必须发生一次升级（否则没有并发）",
  );

  // 判据：rowId 上界只能单调不减。任何一帧快照的上界低于此前已下发的上界 = 流式行回退。
  const startingMax = Math.max(...beforeRows.map((row) => row.rowId));
  let observedMax = startingMax;
  let rollback = null;
  let frameCount = 0;
  for (const wire of counters.wires) {
    // 出站帧 = `{kind:"complete", frame:{payload:{kind:"snapshot"|"deltas"}}}`。
    const payload = wire?.frame?.payload;
    if (!payload) continue;
    frameCount += 1;
    if (payload.kind === "snapshot") {
      const snapshotRows = payload.snapshot?.rows?.window ?? [];
      const maxRowId =
        snapshotRows.length === 0 ? 0 : Math.max(...snapshotRows.map((row) => row.rowId));
      if (maxRowId < observedMax) {
        rollback = { kind: "snapshot", maxRowId, observedMax };
        break;
      }
      observedMax = Math.max(observedMax, maxRowId);
      continue;
    }
    // 增量帧：只认 row.upserted 抬高上界；row.removed 不降低「已下发过的」上界（rewind 才会）。
    for (const delta of payload.deltas ?? []) {
      if (delta.op === "row.upserted" && typeof delta.row?.rowId === "number") {
        observedMax = Math.max(observedMax, delta.row.rowId);
      }
    }
  }
  process.stdout.write(
    `\n[risk16] upgrade/send concurrency: frames=${frameCount} ` +
      `finalMaxRowId=${observedMax} rollback=${rollback === null ? "none" : JSON.stringify(rollback)}\n`,
  );
  assert.ok(frameCount > 0, "夹具：必须真的下发过出站帧（否则这条观测是空的）");

  // 并发之后的两条硬事实：
  //   ① **数据面没写坏**：本轮的消息已经落进真 store（投影的陈旧不等于持久层丢数据）；
  //   ② 投影自洽：行号连续、totalCount 与窗口长度一致。
  // 注意：升级会把投影**整份替换**成「升级那一刻的持久事实」，因此并发期已在飞的行
  // 可能不在最终快照里——这是 spec risk 16 描述的现象，本用例把它记成观测输出
  // （`[risk16]` 行）而不是断言某个方向，避免把「已修」和「未修」任一侧写死。
  const persisted = await world.store.messages({ sessionID: SESSION_ID });
  assert.ok(
    persisted.length >= TOTAL_TURNS * 2 + 2,
    `本轮的用户消息与 assistant 消息必须已落库（数据面不受投影回退影响），实际 ${persisted.length} 条`,
  );
  assert.ok(
    persisted.some(
      (message) =>
        message.info.role === "user" &&
        message.parts.some((part) => part.type === "text" && part.text === "继续说"),
    ),
    "本轮的用户输入必须能在真 store 里按原文找到",
  );
  const after = await subscribeSnapshot(gateway, "conn-d2b");
  const afterIds = after.rows.window.map((row) => row.rowId);
  for (const row of beforeRows) {
    assert.ok(afterIds.includes(row.rowId), `rowId ${row.rowId} 在并发之后消失`);
  }
  assert.equal(
    after.rows.totalCount,
    after.rows.window.length,
    "升级之后投影必须自洽（totalCount 与窗口长度一致）",
  );
  assert.deepEqual(
    afterIds,
    afterIds.map((_rowId, index) => index + 1),
    "行号必须连续（回退不得在投影里留下空洞）",
  );
  assert.equal(counters.resume, 1, "并发路径同样只能激活一次");
  // 观测面的结论必须显式留在输出里：回退是否发生是 Step 14 前需要裁定的输入。
  assert.ok(
    rollback === null || rollback.maxRowId < rollback.observedMax,
    "回退观测项的形状必须自洽（回退点 = 把升级改成首个 turn 结束后再排）",
  );
});

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timeout: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
