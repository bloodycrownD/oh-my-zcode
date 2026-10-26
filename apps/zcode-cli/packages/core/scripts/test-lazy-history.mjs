#!/usr/bin/env node
/**
 * Step 12 / phase-lazy-history — 懒历史 + 发送闸门（IS7 / T-SL13 的本地版）。
 *
 * ============================================================================
 * 这一步新出现的失效面（每条都对应下面一组用例）
 * ============================================================================
 *
 *   L1. **`historyMode:"none"` 与 `"full"` 的 provider 历史必须逐字节相等**
 *       （T-SL13）。两条路径的差别只在**时机**：`"full"` 在 resume 里水化、随后
 *       `init()` 把 context 前缀插到最前面；`"none"` 在 resume 里只登记待办，闸门做
 *       `init()` → hydrate → 补回 resume 期条目。顺序错一步（init 在 hydrate 之后、
 *       补回在 hydrate 之前、或者干脆不补）都是**静默**的：模型看到的历史缺一段或
 *       顺序颠倒，不报错。
 *   L2. **`init()` 不得吃掉 init 之前写进 history 的条目**。resume 不再 eager 初始化
 *       context，历史/提醒条目会先落到 empty history 上；`MessageHistoryImpl.init()`
 *       的原始语义是「整份替换」，照旧用就会把刚水化的历史清空（这正是 spec 要求
 *       「闸门必须在 init 之后」的原因）。
 *   L3. **闸门是纯早退**：没有待办时不得读 store、不得初始化 context（否则每个热会话的
 *       每一轮都白付一次全量读）。
 *   L4. **顺序硬约束**：`init()` 早于正文水化。反过来（先 hydrate 再 init）会把历史清空。
 *   L5. **待办只消费一次**：补水化之后必须清掉待办，否则下一轮再水化一遍，历史出现两份。
 *   L6. **resume 不再 eager 初始化 context**，且全量水化受 `historyMode` 控制。
 *   L7. **接线**：闸门在 turn 起点的 init 之后、startup hooks 之前；`emitControlOnlyUserTurn`
 *       同样过闸门；v4 的激活必须真的传 `"none"`（否则这一步的收益是 0）。
 *
 * 运行：`npx tsx --test scripts/test-lazy-history.mjs`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { MessageHistoryImpl } = await import(
  new URL("../src/agent/message-history.ts", import.meta.url).href
);
const { hydrateMessageHistoryFromSession } = await import(
  new URL("../src/agent/session-history-hydrator.ts", import.meta.url).href
);
const { initializeMessageHistoryFromContext } = await import(
  new URL("../src/runtime/methods/context.ts", import.meta.url).href
);
const { clearDeferredHistoryHydration, deferHistoryHydration, hydrateDeferredMessageHistory } =
  await import(new URL("../src/runtime/methods/history-hydration.ts", import.meta.url).href);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 12 lazy history + send gate (IS7)"
      : `TEST FAIL — Step 12 lazy history (exit code ${code})`,
  );
});

const SESSION_ID = "ses_lazy_history";
const TRACE = { traceId: "trace-lazy-history" };

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 记录 history 的写入顺序：L4/L5 断言靠它，不靠「看起来对不对」。 */
class RecordingHistory extends MessageHistoryImpl {
  constructor() {
    super();
    this.calls = [];
  }
  init(entries) {
    this.calls.push("init");
    super.init(entries);
  }
  addEntries(entries) {
    this.calls.push(`addEntries:${entries.length}`);
    super.addEntries(entries);
  }
  addAttachment(source, content) {
    this.calls.push(`addAttachment:${source}`);
    super.addAttachment(source, content);
  }
  addUser(content, metadata) {
    this.calls.push("addUser");
    super.addUser(content, metadata);
  }
  addAssistant(content) {
    this.calls.push("addAssistant");
    super.addAssistant(content);
  }
  addToolResult(...args) {
    this.calls.push("addToolResult");
    super.addToolResult(...args);
  }
}

function userMessage(id, text) {
  return {
    info: { id, role: "user", sessionID: SESSION_ID, time: { created: 1 } },
    parts: [{ id: `prt-${id}`, messageID: id, sessionID: SESSION_ID, type: "text", text }],
  };
}

function assistantMessage(id, text) {
  return {
    info: {
      id,
      role: "assistant",
      sessionID: SESSION_ID,
      time: { created: 2, completed: 3 },
      modelId: "model-a",
      providerId: "provider-a",
      tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: `prt-${id}`, messageID: id, sessionID: SESSION_ID, type: "text", text }],
  };
}

const PERSISTED_MESSAGES = [
  userMessage("msg-user-1", "第一条用户输入"),
  assistantMessage("msg-assistant-1", "第一条回答"),
  userMessage("msg-user-2", "第二条用户输入"),
  assistantMessage("msg-assistant-2", "第二条回答"),
];

function contextBuilder() {
  return {
    build: () => ({
      systemMessages: [{ role: "system", content: "SYSTEM PROMPT" }],
      metaUserAttachments: [{ source: "context_prefix", content: "CONTEXT PREFIX" }],
      sections: [],
      totalChars: 10,
      totalTokens: 5,
    }),
  };
}

function recorder() {
  return { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
}

/**
 * 最小 runtime：只放闸门/初始化真正用到的字段。`ensureContextInitialized` 直接调生产函数
 * ——它在 `messageHistory` 上的作用（`init()` 前置 context 前缀）就是被验证的契约本身。
 */
function runtimeFor(history, { pending, messages, order } = {}) {
  const runtime = {
    sessionId: SESSION_ID,
    messageHistory: history,
    artifactStore: undefined,
    logger: recorder(),
    deferredHistoryHydration: pending,
    sessionStore: {
      messages: async () => {
        order?.push("read-messages");
        return messages;
      },
    },
    ensureContextInitialized: async () => {
      order?.push("init");
      initializeMessageHistoryFromContext.call(runtime, contextBuilder(), TRACE);
    },
  };
  return runtime;
}

const REWIND_INPUTS = { rewindTargetMessageId: undefined };

// ── L1: T-SL13 本地版 —— 两条路径逐字节相等 ────────────────────────────────

test("L1: historyMode:'none' 的首次发送历史与 'full' 逐字节相等（T-SL13）", async () => {
  // full：resume 里水化 → resume 期三条注入 → 之后的 init 把 context 前缀插到最前。
  const full = new RecordingHistory();
  await hydrateMessageHistoryFromSession({ history: full, messages: PERSISTED_MESSAGES });
  full.addAttachment("shell_environment_change", "SHELL NOTICE");
  full.addAttachment("resume_goal_state", "GOAL STATE");
  full.addAttachment("hook_context", "HOOK CONTEXT");
  const fullRuntime = runtimeFor(full);
  await fullRuntime.ensureContextInitialized();

  // none：resume 不水化，只把这三条注入与待办一起留下；闸门补 init → hydrate → 注入。
  const lazy = new RecordingHistory();
  lazy.addAttachment("shell_environment_change", "SHELL NOTICE");
  lazy.addAttachment("resume_goal_state", "GOAL STATE");
  lazy.addAttachment("hook_context", "HOOK CONTEXT");
  const lazyRuntime = runtimeFor(lazy, { messages: PERSISTED_MESSAGES });
  deferHistoryHydration.call(lazyRuntime, REWIND_INPUTS);
  assert.deepEqual(
    lazy.toRuntimeEntries().length,
    0,
    "resume 之后 lazy 的 history 必须是空的：那三条注入已进待办，且闸门跑之前没人该读历史",
  );
  await hydrateDeferredMessageHistory.call(lazyRuntime, TRACE);

  assert.equal(
    JSON.stringify(lazy.toRuntimeEntries()),
    JSON.stringify(full.toRuntimeEntries()),
    "provider 收到的历史必须逐字节相等：顺序是 context → 历史 → resume 期注入",
  );
  assert.equal(
    lazy.toRuntimeEntries().length,
    full.toRuntimeEntries().length,
    "条数相等（少一条 = 某段被静默丢掉）",
  );
});

// ── L2: init 不清空已有条目 ────────────────────────────────────────────────

test("L2: init 保留 init 之前写进 history 的条目，并把 context 前缀放在最前", () => {
  const history = new RecordingHistory();
  history.addUser([{ type: "text", text: "/goal 先于 init 的真实用户意图" }]);
  const runtime = runtimeFor(history);
  initializeMessageHistoryFromContext.call(runtime, contextBuilder(), TRACE);

  const entries = history.toRuntimeEntries();
  assert.equal(entries.length, 3, "context 两条 + 先写入的一条，一条都不能少");
  assert.equal(entries[0].message?.role, "system", "context 系统提示必须在最前");
  assert.equal(entries[1].metadata?.source, "context_prefix");
  assert.equal(entries[2].message?.role, "user", "init 之前写入的条目跟在 context 之后");
  assert.equal(history.calls.filter((call) => call === "init").length, 1, "只 init 一次");
});

// ── L3: 闸门是纯早退 ───────────────────────────────────────────────────────

test("L3: 没有待办时闸门不读 store、不初始化 context（热会话每轮都过闸门）", async () => {
  const history = new RecordingHistory();
  history.addUser([{ type: "text", text: "live 轮已有历史" }]);
  const before = JSON.stringify(history.toRuntimeEntries());
  const order = [];
  const runtime = runtimeFor(history, { order });
  await hydrateDeferredMessageHistory.call(runtime, TRACE);
  assert.deepEqual(order, [], "无待办时既有 store 读也不该有 init");
  assert.equal(JSON.stringify(history.toRuntimeEntries()), before, "history 原样不动");
});

// ── L4: init 早于正文水化 ──────────────────────────────────────────────────

test("L4: 闸门的顺序是 init → 读正文 → 水化（反过来 init 会清空历史）", async () => {
  const history = new RecordingHistory();
  const order = [];
  const runtime = runtimeFor(history, { messages: PERSISTED_MESSAGES, order });
  deferHistoryHydration.call(runtime, REWIND_INPUTS);
  await hydrateDeferredMessageHistory.call(runtime, TRACE);
  assert.deepEqual(
    order,
    ["init", "read-messages"],
    "init 必须在读正文/水化之前（MessageHistoryImpl.init 会整份替换 entries）",
  );
  assert.ok(
    history.calls.indexOf("init") < history.calls.indexOf("addAssistant"),
    "水化写入必须在 init 之后",
  );
});

// ── L5: 待办只消费一次 + 补回顺序 ──────────────────────────────────────────

test("L5: resume 期条目在历史之后按原顺序补回，且待办只消费一次", async () => {
  const history = new RecordingHistory();
  history.addAttachment("shell_environment_change", "SHELL");
  history.addAttachment("hook_context", "HOOK");
  const order = [];
  const runtime = runtimeFor(history, { messages: PERSISTED_MESSAGES, order });
  deferHistoryHydration.call(runtime, REWIND_INPUTS);
  await hydrateDeferredMessageHistory.call(runtime, TRACE);

  const entries = history.toRuntimeEntries();
  const lastTwo = entries.slice(-2);
  assert.deepEqual(
    lastTwo.map((entry) => entry.metadata?.source),
    ["shell_environment_change", "hook_context"],
    "resume 期注入必须按原顺序接在历史之后（反过来就是「提醒出现在对话之前」）",
  );
  assert.equal(runtime.deferredHistoryHydration, undefined, "消费后必须清掉待办");
  assert.equal(
    entries.length,
    8,
    "context 2 + 持久历史 4 + resume 期注入 2，一条都不能多也不能少（多 = 补了两遍）",
  );

  const readsBefore = order.filter((call) => call === "read-messages").length;
  await hydrateDeferredMessageHistory.call(runtime, TRACE);
  assert.equal(
    order.filter((call) => call === "read-messages").length,
    readsBefore,
    "第二次过闸门不得再读正文（否则历史会有两份）",
  );
});

test("L5b: 任何一次完整水化（rewind 重建）都要清掉待办", async () => {
  const history = new RecordingHistory();
  const runtime = runtimeFor(history, { messages: PERSISTED_MESSAGES });
  deferHistoryHydration.call(runtime, REWIND_INPUTS);
  assert.ok(runtime.deferredHistoryHydration, "先确认待办已登记");
  clearDeferredHistoryHydration.call(runtime);
  const order = [];
  const bare = runtimeFor(history, { order });
  bare.deferredHistoryHydration = runtime.deferredHistoryHydration;
  await hydrateDeferredMessageHistory.call(bare, TRACE);
  assert.deepEqual(order, [], "待办被清掉之后闸门必须是纯早退");
});

// ── L6/L7: 源码守卫（跨文件的接缝，行为用例抓不到「注释掉的接线」）──────────

const coreDir = new URL("../src/runtime/methods/", import.meta.url);
const readSource = (name) => readFileSync(new URL(name, coreDir), "utf8");
const resumeSource = readSource("resume.ts");
const turnSource = readSource("turn.ts");
const controlOnlySource = readSource("control-only-turn.ts");
const rewindSource = readSource("rewind-message.ts");
const bridgeSource = readFileSync(
  new URL("../../bootstrap/src/zcode-protocol/v4-bridge.ts", import.meta.url),
  "utf8",
);
const serverOperationsSource = readFileSync(
  new URL("../../bootstrap/src/zcode-protocol/server-operations.ts", import.meta.url),
  "utf8",
);
const appTypesSource = readFileSync(
  new URL("../../bootstrap/src/app/types.ts", import.meta.url),
  "utf8",
);
const createAppSource = readFileSync(
  new URL("../../bootstrap/src/app/create-app.ts", import.meta.url),
  "utf8",
);

test("L6: resume 不再 eager 初始化 context，且全量水化受 historyMode 控制", () => {
  assert.ok(
    !resumeSource.includes("await this.ensureContextInitialized("),
    "eager context 初始化必须从 resume 里消失（MCP/技能/MEMORY 的成本挪到 turn 起点）",
  );
  assert.ok(
    resumeSource.includes('options?.historyMode === "none"'),
    "resume 必须按 historyMode 分流（缺了这条就等于 lazy 是摆设）",
  );
  assert.ok(
    resumeSource.includes("this.deferHistoryHydration(rewindBranchInputs)"),
    "lazy 分支必须登记待办，否则闸门永远不知道要补水化",
  );
  // 登记点必须在三条 resume 期注入之后，否则快照抓不到它们。
  const injectAt = resumeSource.indexOf("injectHookAdditionalContextIntoMessageHistory(");
  const deferAt = resumeSource.indexOf("this.deferHistoryHydration(rewindBranchInputs)");
  assert.ok(
    injectAt > 0 && deferAt > injectAt,
    "deferHistoryHydration 必须晚于最后的 history 注入（否则那几条会被 init 静默清掉）",
  );
  assert.ok(
    rewindSource.includes("this.clearDeferredHistoryHydration()"),
    "rewind 已经做完整水化，必须清掉懒历史待办（否则首次发轮再追加一份）",
  );
});

test("L7: 闸门位置（init 之后、startup hooks 之前）与 v4 接线", () => {
  const initAt = turnSource.indexOf('startTurnPhase("context_initialization")');
  const gateAt = turnSource.indexOf("await this.hydrateDeferredMessageHistory(turnTraceContext)");
  const hooksAt = turnSource.indexOf('startTurnPhase("session_start_hooks")');
  assert.ok(
    initAt > 0 && gateAt > initAt,
    "闸门必须在 context_initialization 之后（init 会清空 entries）",
  );
  assert.ok(hooksAt > gateAt, "闸门必须在 startup hooks 之前（hooks 会往 history 追加上下文）");

  const controlInitAt = controlOnlySource.indexOf("await this.ensureContextInitialized(");
  const controlGateAt = controlOnlySource.indexOf(
    "await this.hydrateDeferredMessageHistory(traceContext)",
  );
  const controlAddUserAt = controlOnlySource.indexOf("this.messageHistory.addUser(");
  assert.ok(
    controlInitAt > 0 && controlGateAt > controlInitAt && controlAddUserAt > controlGateAt,
    "control-only 轮的用户 query 也必须落在历史之后（init → 闸门 → addUser）",
  );

  assert.ok(
    bridgeSource.includes('historyMode: "none"'),
    "v4 激活必须传 historyMode:'none'（不传 = 激活仍然付全量水化，Step 12 收益为 0）",
  );
  assert.ok(
    serverOperationsSource.includes("historyMode: options.historyMode"),
    "activateRuntime 必须把 historyMode 透传给 record.app.resume",
  );
  assert.ok(
    appTypesSource.includes("historyMode?: SessionHistoryMode"),
    "app 层 ResumeOptions 必须能表达 historyMode（否则 bridge 传不进来）",
  );
  assert.ok(
    createAppSource.includes("historyMode: resumeOptions.historyMode"),
    "create-app 必须把它透传给 runtime.resumeFromStore",
  );
});
