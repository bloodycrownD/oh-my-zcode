#!/usr/bin/env node
/* oxlint-disable max-lines -- e2e 过程产物：B/C 两章共用一份隔离现场与断言账本，拆分无收益 */
/**
 * e2e — agent-lang-trace-usage-batch 磁盘级端到端验证。
 *
 * 单测（T-L、T-T、T-U 三组）覆盖的是纯函数与单模块契约；本脚本覆盖它们碰不到的
 * 「真实文件 IO + 跨包串联」链路，两章各一条：
 *
 *   E2E-B  head 链（写侧 adapters 构建产物 → 读侧 services 源码 → UI 源码）
 *          用 `recordStreamTextDebug` 的 debugDir 注入缝向真实磁盘写 model-io JSONL
 *          （80 条消息 > 生产 tail 窗口 64，触发 tail + messagesHead），然后在
 *          **只把 homedir/dataDir 指向临时目录** 的真实读取路径上跑
 *          `readModelTrajectory()`（真实 open/read/split/JSON.parse），最后喂
 *          `resolveTrajectoryTurnGroups()` 断言回合聚合与首调用输入。
 *          这条链正是「系统消息加载不出来」的端到端证明：盘中 tail 记录只有最近
 *          64 条，head 合并后首调用必须重新看到前 12 条（含 3 条 system 段）。
 *          三条记录分别覆盖 tail / delta / full 三种落盘形态与 messageCount 三分支。
 *
 *   E2E-C  ctx-status 隔离库真机
 *          真实库（~148MiB）主库 + 源库实际存在的 WAL/SHM 只读拷贝到临时目录，
 *          MAGIC_CONTEXT_DB_DIR 指过去，走 bootstrap 的 `runCtxCommand("ctx-status")`
 *          真实命令链
 *          （→ @zcode/magic-context 快照 → formatCtxStatus 排版），断言：
 *            - 输出含 `last usage context limit` 行；
 *            - 真实 session 的持久值原样透传（分子/分母成对）；
 *            - 新建 session（0）渲染 `-`（0 = 未观测）。
 *
 * 路径选择（为什么不真跑 headless 会话）：触发 tail 需要一次请求携带 >64 条消息，
 * 即至少几十个 assistant 轮次，远超「≤3 次小请求」预算；且本机 CLI bundle
 * （dist/zcode.cjs，2026-10-14）早于本迭代改动，真跑也打不到这条写路径。
 * 本脚本因此走合成 fixture，但**全程真实文件 IO**（见上方链路），与单测的区别
 * 正是「落盘 → 重新读回」。
 *
 * 隔离与清理：
 *   - 所有写入只发生在 mkdtemp 生成的临时目录；E2E-B 通过 ZCODE_DATA_BASE_DIR /
 *     USERPROFILE / HOME 把 homedir 解析整体改指临时目录，读取路径不会碰到真实 rollout；
 *   - E2E-C 的真实库只作为 copyFileSync 的源，绝不 open/write（源库仍存在的断言见
 *     C-0-4/C-3-1；mtime/大小的并发变化只提示不判红）；
 *   - 结束前关闭 sqlite 句柄并删临时目录（MC_E2E_KEEP=1 保留现场）。
 *
 * 前置：adapters / bootstrap / magic-context 的 dist 已构建且不早于对应源码（脚本自检）；
 *      以 tsx 运行（services / ui 走源码，保证断言打在本分支实现上）：
 *   node --import tsx docs/iterations/agent-lang-trace-usage-batch/e2e/e2e-agent-lang-trace-usage.mjs
 *
 * 退出码：0 = 全部断言通过；1 = 存在失败断言/致命错误。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

// 本脚本位于 <repo>/docs/iterations/agent-lang-trace-usage-batch/e2e/。
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const ADAPTERS_DIST = join(REPO, "apps/zcode-cli/packages/adapters/dist");
const BOOTSTRAP_DIST = join(REPO, "apps/zcode-cli/packages/bootstrap/dist");
const MC_DIST = join(REPO, "apps/zcode-cli/packages/magic-context/dist");
const SERVICES_TRAJECTORY_SRC = join(REPO, "packages/services/src/zcode-agent/modelTrajectory.ts");
const UI_TURNS_SRC = join(REPO, "packages/ui/src/ModelTrajectoryTurns.ts");
const UI_WIRE_FILTER_SRC = join(REPO, "packages/ui/src/ModelTrajectoryWireFilter.ts");

// 真实 homedir 必须在改写 env 之前取：E2E-B 会把 USERPROFILE/HOME 指向临时目录。
const REAL_HOME = process.env.USERPROFILE?.trim() || process.env.HOME?.trim() || homedir();
const REAL_MC_DB_DIR = process.env.MC_E2E_REAL_DB_DIR ?? join(REAL_HOME, ".omz", "cli", "db");
const REAL_MC_DB = join(REAL_MC_DB_DIR, "magic-context.db");
const KEEP = process.env.MC_E2E_KEEP === "1";

// ── 断言账本 ─────────────────────────────────────────────────────────────────

const cases = [];
let failed = 0;
// E2E-C 才会赋值；finish() 在提前 fatal 时也要能用，所以先声明再晚绑定。
let mcStorageDb = null;

function formatValue(value) {
  return JSON.stringify(value) ?? String(value);
}

function truncate(text, max = 220) {
  return text.length <= max ? text : `${text.slice(0, max)}…(${text.length} chars)`;
}

/** 记录一条断言；expected/actual 用 JSON 序列化后做严格相等比较。 */
function check(scenario, id, name, expected, actual) {
  const expectedText = formatValue(expected);
  const actualText = formatValue(actual);
  const pass = expectedText === actualText;
  if (!pass) failed += 1;
  cases.push({ scenario, id, name, expected: expectedText, actual: actualText, pass });
  console.log(`  ${pass ? "ok  " : "FAIL"} ${id} ${name}`);
  if (!pass) {
    console.log(`        期望: ${truncate(expectedText)}`);
    console.log(`        实际: ${truncate(actualText)}`);
  }
  return pass;
}

function fatal(message, error) {
  failed += 1;
  console.error(`\nFATAL: ${message}`);
  if (error) console.error(error);
  finish(1);
}

// ── 隔离现场 ─────────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), `omz-e2e-lang-trace-${Date.now()}-`));
const MC_DB_DIR = join(root, "magic-context-db");
const DEBUG_DIR = join(root, ".omz", "cli", "debug");
mkdirSync(MC_DB_DIR, { recursive: true });
mkdirSync(DEBUG_DIR, { recursive: true });

// 顺序要求：这些变量必须在第一次 import services / bootstrap 之前就位
// （paths.ts 在模块求值期固化 defaultDataBaseDir；magic-context 的 data-path 惰性读 env）。
process.env.ZCODE_DATA_BASE_DIR = root;
process.env.USERPROFILE = root;
process.env.HOME = root;
process.env.MAGIC_CONTEXT_DB_DIR = MC_DB_DIR;
process.env.MAGIC_CONTEXT_LOG_PATH = join(MC_DB_DIR, "magic-context.log");
delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
delete process.env.MAGIC_CONTEXT_DB_PATH;
// NODE_ENV=test 会让 magic-context 走 test backstop 而忽略 MAGIC_CONTEXT_DB_DIR。
delete process.env.NODE_ENV;

console.log("=".repeat(78));
console.log("agent-lang-trace-usage-batch / e2e");
console.log(`仓库: ${REPO}`);
console.log(`隔离目录: ${root}`);
console.log("E2E-B 路径: 合成 fixture + 真实文件 IO（adapters dist → services 源码 → ui 源码）");
console.log(`E2E-C 真实库源: ${REAL_MC_DB}（只读拷贝）`);
console.log("=".repeat(78));

// 未捕获错误也要走 finish：否则临时目录留现场、断言矩阵不打印。
process.on("uncaughtException", (error) => fatal("未捕获异常", error));
process.on("unhandledRejection", (error) => fatal("未处理的 Promise 拒绝", error));

// dist 自检：产物早于源码时断言会打在旧实现上，属于环境问题而非产品问题。
const DIST_GATES = [
  [
    join(ADAPTERS_DIST, "model/runner-debug.js"),
    join(REPO, "apps/zcode-cli/packages/adapters/src/model/runner-debug.ts"),
    "@zcode/adapters",
  ],
  [
    join(BOOTSTRAP_DIST, "ctx-commands/format-ctx-status.js"),
    join(REPO, "apps/zcode-cli/packages/bootstrap/src/ctx-commands/format-ctx-status.ts"),
    "@zcode/bootstrap",
  ],
  [
    join(MC_DIST, "host/ctx-status.js"),
    join(REPO, "apps/zcode-cli/packages/magic-context/src/host/ctx-status.ts"),
    "@zcode/magic-context",
  ],
];
for (const [built, source, name] of DIST_GATES) {
  if (!existsSync(built)) {
    fatal(`dist 缺失: ${built}，先执行 pnpm build（${name}）`);
  }
  if (statSync(built).mtimeMs < statSync(source).mtimeMs) {
    fatal(`dist 早于源码: ${built}，先重建 ${name}（否则 e2e 打在旧实现上）`);
  }
}

async function importTs(filePath) {
  try {
    return await import(pathToFileURL(filePath).href);
  } catch (error) {
    return fatal(`导入 TS 源码失败: ${filePath}（需以 node --import tsx 运行）`, error);
  }
}

// ── E2E-B：head 链磁盘级端到端 ───────────────────────────────────────────────

const B_SESSION = "sess_e2e_b_head_chain";
const B_TURN = "turn-e2e-b-1";
const SYSTEM_SEGMENTS = [
  "SYSTEM SEGMENT ONE — 系统提示词第一段，必须在 head 里逐字保留",
  "SYSTEM SEGMENT TWO — 第二段（技能 / 工具说明）",
  "SYSTEM SEGMENT THREE — 第三段（项目记忆注入）",
];

// 主会话：80 条（> 生产 tail 窗口 64）。前 12 条是 head 覆盖区，第 16 条起进入 tail，
// 12..15 这 4 条两侧都不在 → 它们就是预期被裁掉的 4 条（croppedCount）。
function buildMainConversation(count) {
  const messages = Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `m${index}:` + "x".repeat(12),
  }));
  messages[0] = { role: "system", content: SYSTEM_SEGMENTS[0] };
  messages[1] = { role: "system", content: SYSTEM_SEGMENTS[1] };
  messages[2] = { role: "system", content: SYSTEM_SEGMENTS[2] };
  messages[3] = { role: "user", content: "<session-history>§1§ 上一轮摘要</session-history>" };
  messages[4] = { role: "user", content: "<project-memory>§2§ 项目记忆</project-memory>" };
  messages[5] = { role: "user", content: "[dropped §4§]" };
  messages[6] = { role: "user", content: "§7§ 请总结这个仓库的架构" };
  // 空 content + 顶层 toolCalls：B-4 的两条修复（toolCalls 映射 + 空占位分类）共用这条。
  messages[7] = {
    role: "assistant",
    content: [
      { type: "reasoning", text: "先看目录结构" },
      { type: "text", text: "我来分析。" },
    ],
    toolCalls: [{ id: "call_m7", name: "grep", input: { pattern: "src" } }],
  };
  messages[8] = { role: "assistant", content: "" };
  messages[9] = { role: "user", content: "继续" };
  messages[20] = { role: "user", content: "[cleared]" };
  messages[21] = { role: "assistant", content: "[dropped §9§]" };
  return messages;
}

// 无 turnId 的独立上下文（full 落盘）：30 条 ≤ 64，走 full 分支。
function buildFallbackConversation(count) {
  const messages = Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "assistant" : "user",
    content: `sub${index}:` + "y".repeat(8),
  }));
  messages[0] = { role: "system", content: "SUBAGENT SYSTEM — 独立子代理上下文" };
  messages[1] = { role: "user", content: "独立的子代理请求" };
  return messages;
}

/** 一条消息的纯文本（string content 或 parts 里的 text）。 */
function fixtureText(message) {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** 读取侧映射后的消息文本（tool-call / reasoning 等非文本 part 不参与）。 */
function mappedText(message) {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

const fixtureMessages = buildMainConversation(80);
const fixtureAfterDelta = buildMainConversation(82);
fixtureAfterDelta[80] = { role: "user", content: "顺手看一下轨迹脚本" };
fixtureAfterDelta[81] = { role: "assistant", content: "好的，继续看" };
const fallbackMessages = buildFallbackConversation(30);

const { recordStreamTextDebug } = await import(
  pathToFileURL(join(ADAPTERS_DIST, "model/runner-debug.js")).href
);

async function writeModelIoRecord({ messages, requestId, startedAt, text, turnId }) {
  await recordStreamTextDebug({
    attempt: 1,
    debugDir: DEBUG_DIR,
    // isDev=false → 生产 rollout 口径：tail 窗口 64，且 request 会去掉 sdkMessages/body.messages。
    isDev: false,
    modelIoFullRetentionEnabled: false,
    normalizedToolCalls: [{ id: `call_${requestId}`, name: "read_file", input: { path: "a.ts" } }],
    options: { messages },
    recordModelIO: true,
    request: {
      messages,
      metadata: {
        querySource: "main_turn",
        sessionId: B_SESSION,
        ...(turnId ? { turnId } : {}),
      },
    },
    requestId,
    resolved: {
      modelId: "e2e-model",
      properties: {},
      providerId: "e2e-provider",
      rawRequestBodyCapture: { body: { messages } },
    },
    result: {
      text: Promise.resolve(text),
      reasoning: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
      totalUsage: Promise.resolve({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
      toolResults: Promise.resolve([]),
      sources: Promise.resolve([]),
      providerMetadata: Promise.resolve({}),
      request: Promise.resolve({ body: { messages } }),
      response: Promise.resolve({ id: `resp-${requestId}`, modelId: "e2e-model" }),
    },
    startedAt,
  });
}

const B_STARTED_AT = Date.now() - 4000;
await writeModelIoRecord({
  messages: fixtureMessages,
  requestId: "req-e2e-b-1",
  startedAt: B_STARTED_AT,
  text: "assistant reply one",
  turnId: B_TURN,
});
await writeModelIoRecord({
  messages: fixtureAfterDelta,
  requestId: "req-e2e-b-2",
  startedAt: B_STARTED_AT + 1000,
  text: "assistant reply two",
  turnId: B_TURN,
});
await writeModelIoRecord({
  messages: fallbackMessages,
  requestId: "req-e2e-b-3",
  startedAt: B_STARTED_AT + 2000,
  text: "subagent reply",
  turnId: undefined,
});

console.log("\n[E2E-B] head 链：写侧落盘 → readModelTrajectory → 回合聚合");

const modelIoPath = join(DEBUG_DIR, `model-io-${B_SESSION}.jsonl`);
const rawLines = existsSync(modelIoPath)
  ? readFileSync(modelIoPath, "utf8").trim().split("\n").filter(Boolean)
  : [];
const rawRecords = rawLines.map((line) => JSON.parse(line));
const raw1 = rawRecords[0]?.request ?? {};
const raw2 = rawRecords[1]?.request ?? {};
const raw3 = rawRecords[2]?.request ?? {};

check("E2E-B", "B-1-1", "model-io JSONL 落盘 3 条记录", 3, rawRecords.length);
check("E2E-B", "B-1-2", "记录 1 是 tail（80 条 > 窗口 64）", "tail", raw1.messagesKind);
check("E2E-B", "B-1-3", "record.messageCount 契约=压缩前全量 80", 80, raw1.messageCount);
check("E2E-B", "B-1-4", "tail 窗口起点 offset=16", 16, raw1.messageOffset);
check("E2E-B", "B-1-5", "磁盘上 tail 窗口只有 64 条", 64, raw1.messages?.length);
check("E2E-B", "B-1-6", "headMessageCount=12", 12, raw1.headMessageCount);
check("E2E-B", "B-1-7", "messagesHead 含前 12 条", 12, raw1.messagesHead?.length);
check("E2E-B", "B-1-8", "未触发字节预算截断", false, raw1.messagesHeadTruncated);
check(
  "E2E-B",
  "B-1-9",
  "head 前 3 条是 system 段原文",
  SYSTEM_SEGMENTS,
  (raw1.messagesHead ?? []).slice(0, 3).map(fixtureText),
);
check(
  "E2E-B",
  "B-1-10",
  "head 序列化 ≤64KB",
  true,
  Buffer.byteLength(JSON.stringify(raw1.messagesHead), "utf8") <= 64 * 1024,
);
check(
  "E2E-B",
  "B-1-11",
  "生产落盘不写 sdkMessages / body.messages",
  { sdkMessages: false, bodyMessages: false },
  { sdkMessages: "sdkMessages" in raw1, bodyMessages: Array.isArray(raw1.body?.messages) },
);
check("E2E-B", "B-1-12", "记录 2 是 delta（追加 2 条）", "delta", raw2.messagesKind);
check(
  "E2E-B",
  "B-1-13",
  "delta 记录只落增量 2 条且不写 head",
  { offset: 80, count: 2, head: null },
  {
    offset: raw2.messageOffset,
    count: raw2.messages?.length,
    head: raw2.headMessageCount ?? null,
  },
);
check("E2E-B", "B-1-14", "记录 3 是 full（30 条 ≤ 窗口）", "full", raw3.messagesKind);
check(
  "E2E-B",
  "B-1-15",
  "full 记录 offset=0 且无 head",
  { offset: 0, count: 30, head: null },
  { offset: raw3.messageOffset, count: raw3.messages?.length, head: raw3.headMessageCount ?? null },
);

const services = await importTs(SERVICES_TRAJECTORY_SRC);
const trajectory = await services.readModelTrajectory(B_SESSION);
const [record1, record2, record3] = trajectory.records;

check("E2E-B", "B-2-1", "readModelTrajectory 读回 3 条记录", 3, trajectory.records.length);
check(
  "E2E-B",
  "B-2-2",
  "读取源文件来自隔离 debug 目录（真实文件 IO）",
  true,
  trajectory.sourceFiles.length === 1 && trajectory.sourceFiles[0] === modelIoPath,
);
check(
  "E2E-B",
  "B-2-3",
  "record1 缺口元数据五字段就位",
  {
    messageCount: 80,
    messageOffset: 16,
    messagesKind: "tail",
    headMessageCount: 12,
    croppedCount: 4,
  },
  {
    messageCount: record1?.request.messageCount,
    messageOffset: record1?.request.messageOffset,
    messagesKind: record1?.request.messagesKind,
    headMessageCount: record1?.request.headMessageCount,
    croppedCount: record1?.request.croppedCount,
  },
);
check(
  "E2E-B",
  "B-2-4",
  "head+tail 合并后可见 76 条（12 + 64）",
  76,
  record1?.request.messages.length,
);
check(
  "E2E-B",
  "B-2-5",
  "croppedCount = 80 − 76（被裁的是 head 之后的 4 条）",
  4,
  record1?.request.croppedCount,
);
check(
  "E2E-B",
  "B-2-6",
  "合并边界正确：head 末尾 + tail 起点 + tail 末尾",
  [
    SYSTEM_SEGMENTS[0],
    fixtureText(fixtureMessages[11]),
    fixtureText(fixtureMessages[16]),
    fixtureText(fixtureMessages[79]),
  ],
  [
    record1 ? mappedText(record1.request.messages[0]) : null,
    record1 ? mappedText(record1.request.messages[11]) : null,
    record1 ? mappedText(record1.request.messages[12]) : null,
    record1 ? mappedText(record1.request.messages[75]) : null,
  ],
);
const headTexts = new Set((record1?.request.messages ?? []).slice(0, 12).map(mappedText));
const tailTexts = new Set((record1?.request.messages ?? []).slice(12).map(mappedText));
check(
  "E2E-B",
  "B-2-7",
  "head 与 tail 窗口无重叠（合并未产生重复条）",
  0,
  [...headTexts].filter((text) => tailTexts.has(text)).length,
);
check(
  "E2E-B",
  "B-2-8",
  "delta 记录展开：前序 76 + 增量 2 = 78 条",
  { visible: 78, count: 82, offset: 80, cropped: 4, head: null },
  {
    visible: record2?.request.messages.length,
    count: record2?.request.messageCount,
    offset: record2?.request.messageOffset,
    cropped: record2?.request.croppedCount,
    head: record2?.request.headMessageCount ?? null,
  },
);
check(
  "E2E-B",
  "B-2-9",
  "delta 尾部追加两条内容正确",
  ["顺手看一下轨迹脚本", "好的，继续看"],
  record2 ? record2.request.messages.slice(-2).map(mappedText) : [],
);
check(
  "E2E-B",
  "B-2-10",
  "full 记录：30 条全量、croppedCount=0、messageCount 兜底",
  { visible: 30, count: 30, cropped: 0 },
  {
    visible: record3?.request.messages.length,
    count: record3?.request.messageCount,
    cropped: record3?.request.croppedCount,
  },
);
check(
  "E2E-B",
  "B-2-11",
  "toolCalls 映射：空 assistant 行的顶层 toolCalls → tool-call part",
  [{ kind: "tool-call", toolCallId: "call_m7", toolName: "grep", input: { pattern: "src" } }],
  record1 ? record1.request.messages[7].parts.filter((part) => part.kind === "tool-call") : [],
);
check(
  "E2E-B",
  "B-2-12",
  "reasoning part 映射（关闭开关前的原始数据）",
  true,
  record1 ? record1.request.messages[7].parts.some((part) => part.kind === "reasoning") : false,
);

const ui = await importTs(UI_TURNS_SRC);
const wireFilter = await importTs(UI_WIRE_FILTER_SRC);
const groups = ui.resolveTrajectoryTurnGroups(trajectory.records);

check(
  "E2E-B",
  "B-3-1",
  "回合聚合：2 个回合（1 个 turnId 组 + 1 个 fallback 组）",
  2,
  groups.length,
);
check(
  "E2E-B",
  "B-3-2",
  "turnId 组键与调用数",
  { key: `turn:${B_TURN}`, turnId: B_TURN, calls: 2, turnIndex: 0 },
  {
    key: groups[0]?.key,
    turnId: groups[0]?.turnId,
    calls: groups[0]?.calls.length,
    turnIndex: groups[0]?.turnIndex,
  },
);
check(
  "E2E-B",
  "B-3-3",
  "首调用输入 = head + tail 76 条，且前 3 条是 system 段（系统消息加载不出来已修复）",
  { visible: 76, firstThree: SYSTEM_SEGMENTS },
  {
    visible: groups[0]?.calls[0]?.inputMessages.length,
    firstThree: (groups[0]?.calls[0]?.inputMessages ?? [])
      .slice(0, 3)
      .map((message) => mappedText(message)),
  },
);
check(
  "E2E-B",
  "B-3-4",
  "第二调用按 messageCount 增量：只展示新增 user（assistant 被过滤）",
  { count: 1, texts: ["顺手看一下轨迹脚本"], hasSystem: false },
  {
    count: groups[0]?.calls[1]?.inputMessages.length,
    texts: (groups[0]?.calls[1]?.inputMessages ?? []).map(mappedText),
    hasSystem: (groups[0]?.calls[1]?.inputMessages ?? []).some(
      (message) => message.role === "system",
    ),
  },
);
check(
  "E2E-B",
  "B-3-5",
  "fallback 组：无 turnId 的 key + 计数下降分支整段展示（30 条，过滤 assistant 后 16 条）",
  { key: "turn:fallback:req-e2e-b-3", turnId: null, visible: 16, nextCount: 30 },
  {
    key: groups[1]?.key,
    turnId: groups[1]?.turnId,
    visible: groups[1]?.calls[0]?.inputMessages.length,
    nextCount: ui.resolveTrajectoryInputMessages({
      record: trajectory.records[2],
      index: 2,
      previousConversationMessageCount: 82,
    }).nextConversationMessageCount,
  },
);
check(
  "E2E-B",
  "B-3-6",
  "回合用户预览：剥 §7§、排除 session-history/project-memory/占位符",
  { text: "请总结这个仓库的架构", kind: "user" },
  { text: groups[0]?.userPreview, kind: groups[0]?.userPreviewKind },
);
check(
  "E2E-B",
  "B-3-7",
  "回合 assistant 预览（多次调用的 assistant 文本）与统计",
  {
    startsWithFirst: true,
    includesSecond: true,
    callCount: 2,
    sourceKinds: ["main"],
    durationMatchesRecords: true,
    errors: 0,
  },
  {
    startsWithFirst: groups[0]?.assistantPreview.startsWith("assistant reply one"),
    includesSecond: groups[0]?.assistantPreview.includes("assistant reply two"),
    callCount: groups[0]?.stats.callCount,
    sourceKinds: groups[0]?.stats.sourceKinds,
    durationMatchesRecords:
      groups[0]?.stats.durationMs === (record1?.durationMs ?? 0) + (record2?.durationMs ?? 0),
    errors: groups[0]?.stats.errorCount,
  },
);

const stripped = ui.stripTrajectoryReasoning(trajectory.records);
check(
  "E2E-B",
  "B-3-8",
  "fallback 回合预览：取该组首条真实 user（独立子代理请求）",
  { text: "独立的子代理请求", kind: "user" },
  { text: groups[1]?.userPreview, kind: groups[1]?.userPreviewKind },
);
check(
  "E2E-B",
  "B-4-1",
  "reasoning 投影：只删 part 不删 message",
  { messages: 76, reasoning: 0, toolCalls: 1 },
  {
    messages: stripped[0]?.request.messages.length,
    reasoning: (stripped[0]?.request.messages ?? [])
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "reasoning").length,
    toolCalls: (stripped[0]?.request.messages ?? [])
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "tool-call").length,
  },
);
const wireRows = wireFilter.classifyTrajectoryWireRows(groups[0]?.calls[0]?.inputMessages ?? []);
check(
  "E2E-B",
  "B-4-2",
  "wire 占位分类：隐藏 2 条（空 assistant + marker-only assistant）",
  2,
  wireRows.hiddenCount,
);
check(
  "E2E-B",
  "B-4-3",
  "user 角色永不隐藏：`[dropped §4§]` 与 `[cleared]` 仍可见",
  [
    { index: 5, placeholder: false },
    { index: 16, placeholder: false },
  ],
  [
    { index: 5, placeholder: wireRows.rows[5]?.placeholder },
    // fixture 20 在展开数组里的下标：head 12 条 + tail 从 fixture 16 起。
    { index: 16, placeholder: wireRows.rows[16]?.placeholder },
  ],
);

// ── E2E-C：ctx-status 隔离库真机 ─────────────────────────────────────────────

console.log("\n[E2E-C] ctx-status 隔离库真机");

if (!existsSync(REAL_MC_DB)) {
  fatal(`真实库不存在: ${REAL_MC_DB}（可用 MC_E2E_REAL_DB_DIR 覆盖）`);
}

const sourceStatBefore = statSync(REAL_MC_DB);
const copyDbPath = join(MC_DB_DIR, "magic-context.db");
// 主库必拷；-wal/-shm 是 SQLite 的运行时伴生文件——干净关闭（或随后被 checkpoint 合并
// 回主库）后源库上可能根本不存在，拷贝时只拷源库实际存在的件（cr-fix-spec usage/G-2）。
const sourceParts = [];
const copiedParts = [];
for (const suffix of ["", "-wal", "-shm"]) {
  const source = `${REAL_MC_DB}${suffix}`;
  if (!existsSync(source)) continue;
  sourceParts.push(suffix || "(main)");
  copyFileSync(source, `${copyDbPath}${suffix}`);
  copiedParts.push(suffix || "(main)");
}
for (const suffix of ["-wal", "-shm"]) {
  if (!sourceParts.includes(suffix)) {
    console.log(
      `  提示: 源库当前不存在 ${suffix}（SQLite 干净关闭后伴生文件可能已被清理），跳过该件`,
    );
  }
}
const sourceStillExistsAfterCopy = existsSync(REAL_MC_DB);
const sourceStatAfterCopy = sourceStillExistsAfterCopy ? statSync(REAL_MC_DB) : null;

check("E2E-C", "C-0-1", "真实库存在且非空", true, sourceStatBefore.size > 0);
check(
  "E2E-C",
  "C-0-2",
  "拷贝（主库必拷；源库实际存在的 wal/shm 必在）",
  ["(main)", ...["-wal", "-shm"].filter((suffix) => sourceParts.includes(suffix))],
  copiedParts,
);
check("E2E-C", "C-0-3", "拷贝主文件大小与源一致", sourceStatBefore.size, statSync(copyDbPath).size);
// 「未写源库」的硬证据是 C-1-1 的隔离路径 + 脚本全程只做 copyFileSync；这里不比较
// mtime/大小——真实 CLI 并发写入（含 VACUUM）会改动二者，严格相等会假红
// （cr-fix-spec usage/G-2）。只断言源库仍在，变化仅提示。
check(
  "E2E-C",
  "C-0-4",
  "拷贝窗口结束后源库仍存在（未被本脚本删除/替换）",
  true,
  sourceStillExistsAfterCopy,
);
if (
  sourceStatAfterCopy &&
  (sourceStatAfterCopy.size !== sourceStatBefore.size ||
    sourceStatAfterCopy.mtimeMs !== sourceStatBefore.mtimeMs)
) {
  console.log("  提示: 源库在拷贝窗口内 mtime/大小变化，来源是外部 CLI 并发写入（本脚本只读）");
}

const ctxCommands = await import(pathToFileURL(join(BOOTSTRAP_DIST, "ctx-commands/index.js")).href);
const { getMagicContextDatabasePath } = await import(
  pathToFileURL(join(MC_DIST, "host/storage-dir.js")).href
);
mcStorageDb = await import(
  pathToFileURL(join(MC_DIST, "core/features/magic-context/storage-db.js")).href
);

/** 取快照文本里某个 label 的值（排版是 `  label   value`，label 右侧补齐）。 */
function ctxField(output, label) {
  const match = new RegExp(`^\\s{2}${label}\\s{2,}(.+)$`, "m").exec(output);
  return match ? match[1].trim() : null;
}

function formatEnUs(value) {
  return Math.trunc(value).toLocaleString("en-US");
}

check(
  "E2E-C",
  "C-1-1",
  "命令链打开的是隔离拷贝（未碰真实库目录）",
  copyDbPath,
  getMagicContextDatabasePath(),
);

const UNOBSERVED_SESSION = "sess_e2e_c_unobserved";
const unobservedOutput = await ctxCommands.runCtxCommand("ctx-status", "", {
  sessionId: UNOBSERVED_SESSION,
  isMagicContextEnabled: () => true,
});

check(
  "E2E-C",
  "C-1-2",
  "命令链返回真实快照（非 UNAVAILABLE/失败文案）",
  true,
  unobservedOutput.startsWith("Magic Context status") &&
    !unobservedOutput.includes("unavailable") &&
    !unobservedOutput.includes("failed"),
);
check(
  "E2E-C",
  "C-1-3",
  "输出含 `last usage context limit` 行",
  "-",
  ctxField(unobservedOutput, "last usage context limit"),
);
check(
  "E2E-C",
  "C-1-4",
  "新建 session 的 limit 不渲染成 0（0 = 未观测）",
  false,
  /last usage context limit\s+0\b/.test(unobservedOutput),
);
check(
  "E2E-C",
  "C-1-5",
  "三节排版就位（BUDGET / COMPARTMENTS / TAGS）",
  true,
  ["BUDGET", "COMPARTMENTS", "TAGS"].every((section) => unobservedOutput.includes(section)),
);

// 迁移后的拷贝上挑一个「真实观测过占用」的会话。先读列/版本，再按值排序取一条。
const copyDb = new DatabaseSync(copyDbPath);
const copyColumns = copyDb
  .prepare("PRAGMA table_info(session_meta)")
  .all()
  .map((column) => column.name);
const schemaVersion = copyDb
  .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
  .get().version;

check(
  "E2E-C",
  "C-2-1",
  "隔离拷贝已迁到本分支 schema（含 last_usage_context_limit 列）",
  true,
  copyColumns.includes("last_usage_context_limit"),
);
// 期望值取实现导出的常量，不硬编码 10000：下一次 migration 落库后这里自动跟随
// （cr-fix-spec usage/G-3）。
check(
  "E2E-C",
  "C-2-2",
  `隔离拷贝 schema 版本 = LATEST_SUPPORTED_VERSION(${mcStorageDb.LATEST_SUPPORTED_VERSION})`,
  mcStorageDb.LATEST_SUPPORTED_VERSION,
  schemaVersion,
);

let observedRow = copyDb
  .prepare(
    "SELECT session_id, last_usage_context_limit AS usage_limit, last_context_percentage AS percentage, last_input_tokens AS tokens FROM session_meta WHERE last_usage_context_limit > 0 ORDER BY last_usage_context_limit DESC, session_id ASC LIMIT 1",
  )
  .get();
let observedRowSource = "真实会话";
if (!observedRow) {
  // 换台机器时可能没有任何 >0 的会话：在**拷贝**上补一行，链路仍然是真实的。
  copyDb
    .prepare(
      "INSERT INTO session_meta (session_id, last_usage_context_limit, last_context_percentage, last_input_tokens) VALUES (?, ?, ?, ?)",
    )
    .run("sess_e2e_c_observed", 200000, 27, 54000);
  observedRow = {
    session_id: "sess_e2e_c_observed",
    usage_limit: 200000,
    percentage: 27,
    tokens: 54000,
  };
  observedRowSource = "拷贝上补的合成会话";
}
copyDb.close();

const observedOutput = await ctxCommands.runCtxCommand("ctx-status", "", {
  sessionId: observedRow.session_id,
  isMagicContextEnabled: () => true,
});

check(
  "E2E-C",
  "C-2-3",
  `透传值正确（${observedRowSource} ${observedRow.session_id}）`,
  {
    limit: formatEnUs(observedRow.usage_limit),
    percentage: `${Math.trunc(observedRow.percentage)}%`,
    tokens: formatEnUs(observedRow.tokens),
  },
  {
    limit: ctxField(observedOutput, "last usage context limit"),
    percentage: ctxField(observedOutput, "last context usage"),
    tokens: ctxField(observedOutput, "last input tokens"),
  },
);
check(
  "E2E-C",
  "C-2-4",
  "文本值回读为持久列原值（1,000,000 → 1000000）",
  observedRow.usage_limit,
  Number((ctxField(observedOutput, "last usage context limit") ?? "").replaceAll(",", "")),
);
check(
  "E2E-C",
  "C-2-5",
  "快照 session 行与请求一致",
  observedRow.session_id,
  new RegExp(`^session\\s+${observedRow.session_id}$`, "m").test(observedOutput)
    ? observedRow.session_id
    : null,
);

// 结束时复查源库：脚本对源库只做 copyFileSync；外部 CLI 并发写入会改 mtime/大小，
// 因此这里同样只断言源库仍在（硬证据是 C-1-1 的隔离路径），变化仅提示
// （cr-fix-spec usage/G-2：不做大小比较，避免并发 VACUUM 假红）。
const sourceStillExistsAfterRun = existsSync(REAL_MC_DB);
const sourceStatAfterRun = sourceStillExistsAfterRun ? statSync(REAL_MC_DB) : null;
check(
  "E2E-C",
  "C-3-1",
  "全程结束时源库仍存在（未被本脚本写入/删除）",
  true,
  sourceStillExistsAfterRun,
);
if (
  sourceStatAfterRun &&
  (sourceStatAfterRun.size !== sourceStatBefore.size ||
    sourceStatAfterRun.mtimeMs !== sourceStatBefore.mtimeMs)
) {
  console.log("  提示: 源库 mtime/大小在运行期间变化，来源是外部 CLI 并发写入（本脚本只读）");
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

finish(failed === 0 ? 0 : 1);

function finish(exitCode) {
  console.log("\n" + "=".repeat(78));
  console.log("断言矩阵");
  console.log("=".repeat(78));
  console.log(
    `${"场景".padEnd(6)} ${"断言".padEnd(9)} ${"结果".padEnd(5)} ${"期望".padEnd(38)} 实际`,
  );
  for (const item of cases) {
    console.log(
      `${item.scenario.padEnd(6)} ${item.id.padEnd(9)} ${(item.pass ? "PASS" : "FAIL").padEnd(5)} ${truncate(item.expected, 38).padEnd(38)} ${truncate(item.actual, 60)}`,
    );
  }
  const passed = cases.length - failed;
  console.log("-".repeat(78));
  console.log(`合计: ${cases.length} 条断言, ${passed} 通过, ${failed} 失败`);

  // magic-context 的读句柄留在同进程里；Windows 上不先关就删不掉临时目录。
  if (mcStorageDb) {
    try {
      mcStorageDb.closeDatabase();
    } catch {
      // 关库失败不改变判定。
    }
  }

  if (exitCode === 0 && !KEEP) {
    // magic-context 的 logger 注册了 `process.on("exit", flush)`：它会在 process.exit()
    // 期间把缓冲日志写回磁盘（ensureDir + append），把我们刚删掉的目录又建出来。
    // Node 的 exit 监听器按注册顺序执行，而本监听器注册得比 logger 晚（logger 在
    // E2E-C 打开库时才加载），因此一定在其 flush 之后跑——最终清理放在这里。
    process.on("exit", () => {
      try {
        rmSync(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 });
        console.log(`已清理隔离目录: ${root}`);
      } catch (error) {
        console.log(`提示: 隔离目录清理失败（${error?.code ?? "unknown"}），保留: ${root}`);
      }
    });
  } else {
    console.log(`隔离目录保留: ${root}`);
  }

  process.exit(exitCode);
}
