#!/usr/bin/env node
/**
 * Step 8/9 acceptance tests — D13 记忆写入链真身 + 引用改指闭合
 * (bugfix-batch-20261011, phase-mc-memory-core)。
 *
 * 钉死什么：
 *   T-MC0 — 真 compartment run（runCompartmentAgent 走完整 publish 事务，真
 *           sqlite 临时库、真 raw provider、真 lease、真 boundary 快照工厂）后
 *           memories 表有行：historian facts 经恢复的
 *           promoteSessionFactsDurable 在与 boundary floor 同一事务内落库。
 *           同一库上跑 m0 注入面（renderMemoryBlockV2 / computeM0BlockTokens）
 *           可见记忆内容。
 *           [注入断言边界] m0 的完整 system-prompt 装配属 Step 13
 *           (prompt-surface 波次) 未接面，故这里只断言注入面公共函数读到
 *           promoted 行——「m0 全链注入断言补于 Step 13」。
 *   T-MC0b — Issue #44 门：memoryEnabled/autoPromote 关闭时同一条 publish 路径
 *            不写 memories（门是单写路径，不是只挡 embed）。
 *   T-MC0b2 — Issue #44 右臂（MF-MC-1）：memoryEnabled=true / autoPromote=false
 *             同样不写 memories（promotionGateOpen 双门的右半）。
 *   T-MC0c — unanchored skip 可观测性（MF-MC-2）：双舱 fixture 末舱 discard-last
 *            → promotion skipped 的 sessionLog 带 reason=discarded_last 与 facts 计数。
 *   T-MC1 — selection 排序生效：memory-selection 真身（permanent 优先 → importance
 *           降序 → reinforcement 新近 → id）经 inject-compartments 的预算选择
 *           面 observable：紧预算下 active 高 importance 让位 permanent 低
 *           importance；storage-memory 读出 promoted 行。
 *   T-MC1b — 引用改指回归：getMaxMemoryIdForProjects 水位从 stub 恒 0 变真值；
 *            getActiveUserMemories / insertUserMemory 走 storage-user-memory
 *            真身（stub 时代恒空）。
 *
 * 隔离：
 *   MAGIC_CONTEXT_DB_DIR / MAGIC_CONTEXT_LOG_PATH 显式指 OS 临时目录
 *   （mkdtempSync(tmpdir())），绝不写真实 ~/.omz / ~/.zcode；测试结束 rmSync。
 *   T-MC0c 断言 sessionLog 落盘，故在 import 任何被测模块前 delete NODE_ENV
 *   （node --test 会把它置成 test，logger 顶层据此整臂静默；本脚本经 test:all
 *   是独立进程，删除只影响本进程）。
 *
 * dist 前置：
 *   从 dist/ 加载被测模块（同 test-historian.mjs / test-transform.mjs:b4 模式），
 *   运行前必须 `pnpm --dir apps/zcode-cli/packages/magic-context build`（= tsc）；
 *   dist 缺失即快速失败。
 *
 * Requires Node >= 24 (node:sqlite)。Exits 0 全绿，1 否则。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));
const load = (rel) => import(pathToFileURL(join(PKG_ROOT, "dist", rel)).href);

// ── dist 前置：被测模块必须先构建 ───────────────────────────────────────
for (const rel of [
  "core/features/magic-context/memory/promotion.js",
  "core/features/magic-context/memory/storage-memory.js",
  "core/features/magic-context/memory/memory-selection.js",
  "core/features/magic-context/user-memory/storage-user-memory.js",
  "core/hooks/magic-context/compartment-runner-incremental.js",
  "core/shared/logger.js",
]) {
  try {
    statSync(join(PKG_ROOT, "dist", rel));
  } catch {
    throw new Error(
      `dist 前置缺失 ${rel} —— 先运行 pnpm --dir apps/zcode-cli/packages/magic-context build`,
    );
  }
}

// T-MC0c 断言 historian 的 sessionLog 落盘（MF-MC-2），而 logger 模块顶层把
// `NODE_ENV === "test"` 判为静默臂（node --test 运行器会把 NODE_ENV 置成
// test）。本脚本经 test:all 是独立进程，删除 NODE_ENV 只影响本进程的 logger
// （开始真正写 MAGIC_CONTEXT_LOG_PATH），不影响其他测试文件。
delete process.env.NODE_ENV;

// ── 隔离：DB 与日志都落在 OS 临时目录 ───────────────────────────────────
const dbDir = mkdtempSync(join(tmpdir(), "mc-memory-port-db-"));
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");
const projectDir = mkdtempSync(join(tmpdir(), "mc-memory-port-proj-"));
const projectDir2 = mkdtempSync(join(tmpdir(), "mc-memory-port-proj2-"));

const { initializeMagicContextHost } = await load("host/harness.js");
initializeMagicContextHost();

const storage = await load("core/features/magic-context/storage.js");
const compartmentStorage = await load("core/features/magic-context/compartment-storage.js");
const storageMemory = await load("core/features/magic-context/memory/storage-memory.js");
const normalizeHash = await load("core/features/magic-context/memory/normalize-hash.js");
const memorySelection = await load("core/features/magic-context/memory/memory-selection.js");
const projectIdentityModule = await load("core/features/magic-context/memory/project-identity.js");
const storageUserMemory = await load(
  "core/features/magic-context/user-memory/storage-user-memory.js",
);
const lease = await load("core/features/magic-context/compartment-lease.js");
const readSessionChunk = await load("core/hooks/magic-context/read-session-chunk.js");
const protectedTailBoundary = await load("core/hooks/magic-context/protected-tail-boundary.js");
const runner = await load("core/hooks/magic-context/compartment-runner-incremental.js");
const injectCompartments = await load("core/hooks/magic-context/inject-compartments.js");
const m0Breakdown = await load("core/hooks/magic-context/m0-token-breakdown.js");
const logger = await load("core/shared/logger.js");

const db = storage.openDatabase();
if (!db) throw new Error("openDatabase() failed — MAGIC_CONTEXT_DB_DIR 未生效？");

const cleanupTempDirs = () => {
  try {
    storage.closeDatabase();
  } catch {
    // A failed close must not mask the original failure.
  }
  for (const dir of [dbDir, projectDir, projectDir2]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows EBUSY on a still-open handle is not a test failure.
    }
  }
};
process.on("exit", cleanupTempDirs);

// ── 共享装置：historian 假执行器 + raw provider ───────────────────────────

const SESSION = "ses_mc0_promotion";
/** 20 条交替 user/assistant；默认快照工厂把最后 5 个 user turn 当保护尾。 */
const MESSAGE_TEXTS = Array.from({ length: 20 }, (_unused, index) =>
  index % 2 === 0
    ? `user turn ${index + 1}: 讨论记忆写入链的落地`
    : `assistant turn ${index + 1}: 记录分舱边界事务与 promotion 的关系`,
);

function makeRawProvider() {
  const messages = MESSAGE_TEXTS.map((text, index) => ({
    id: `msg-mc0-${index + 1}`,
    ordinal: index + 1,
    role: index % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text }],
    createdAt: 1_700_000_000_000 + index * 1000,
  }));
  return {
    readMessages: () => messages,
    getMessageCount: () => messages.length,
    hasMessageById: (id) => messages.some((message) => message.id === id),
    readMessageById: (id) => messages.find((message) => message.id === id) ?? null,
    readMessageOrdinalById: (id) => messages.find((message) => message.id === id)?.ordinal ?? null,
  };
}

/**
 * D-6 契约的假执行器：恒定返回一条单舱 + 两条 v2 facts 的 historian 输出。
 * 单舱覆盖整个 eligible head（1-10）→ 只有 1 个 compartment 时 discard-last
 * 启发式不触发（<2 个），promotion 的 unanchored 门不被跳过。
 */
const HISTORIAN_OUTPUT = [
  "<output>",
  '<compartment start="1" end="10" title="记忆写入链落地" episode_type="design" importance="50">',
  "<p1>前 10 条消息确定记忆写入链依赖 historian 分舱边界事务。</p1>",
  "</compartment>",
  "<facts>",
  "<PROJECT_RULES>",
  "* 项目记忆写入必须与分舱边界同事务",
  "</PROJECT_RULES>",
  "<ARCHITECTURE>",
  "* ctx_search 复用 storage-memory-fts 的查询消毒层",
  "</ARCHITECTURE>",
  "</facts>",
  "</output>",
].join("\n");

function makeExecutor(historianOutput = HISTORIAN_OUTPUT) {
  return {
    capabilities: { tools: false, harness: "zcode" },
    open: async () => ({ id: "run-mc0" }),
    attempt: async () => {},
    collect: async () => ({
      text: historianOutput,
      usage: { inputTokens: 10, outputTokens: 5 },
      lengthCapped: false,
    }),
    close: async () => {},
  };
}

/** 双舱 fixture（T-MC0c）：末舱紧贴 eligible head（end=10）触发 discard-last。 */
const HISTORIAN_OUTPUT_TWO_COMPARTMENTS = [
  "<output>",
  '<compartment start="1" end="4" title="首舱落定" episode_type="design" importance="40">',
  "<p1>首舱覆盖消息 1-4。</p1>",
  "</compartment>",
  '<compartment start="5" end="10" title="末舱紧贴 head" episode_type="design" importance="30">',
  "<p1>末舱覆盖消息 5-10，无前瞻上下文，边界不可信。</p1>",
  "</compartment>",
  "<facts>",
  "<CONSTRAINTS>",
  "* 未锚定分舱的 facts 必须留在下次重导",
  "</CONSTRAINTS>",
  "<NAMING>",
  "* 末舱丢弃后命名约定不得提前落库",
  "</NAMING>",
  "</facts>",
  "</output>",
].join("\n");

/** 跑一次真 compartment run；返回该 session 发布的 compartments 行数。 */
async function runHistorianOnce(sessionId, { memoryEnabled, autoPromote, historianOutput }) {
  const holderId = `holder-${sessionId}-${Math.random().toString(36).slice(2)}`;
  assert.notEqual(
    lease.acquireCompartmentLease(db, sessionId, holderId),
    null,
    "compartment lease 必须可获取，否则 publish 会被 lease 检查拒绝",
  );
  const cleanupProvider = readSessionChunk.setRawMessageProvider(sessionId, makeRawProvider());
  try {
    // 默认快照工厂按真实 raw provider 计算保护尾/eligible head/token 索引。
    const boundarySnapshot = protectedTailBoundary.createDefaultBoundarySnapshotForTests(sessionId);
    await runner.runCompartmentAgent({
      db,
      sessionId,
      directory: projectDir,
      historianChunkTokens: 20_000,
      boundarySnapshot,
      compartmentLeaseHolderId: holderId,
      hiddenCompletionExecutor: makeExecutor(historianOutput ?? HISTORIAN_OUTPUT),
      model: "test/fake-historian",
      memoryEnabled,
      autoPromote,
    });
  } finally {
    cleanupProvider();
    lease.releaseCompartmentLease(db, sessionId, holderId);
  }
}

// ── T-MC0 ────────────────────────────────────────────────────────────────

test("T-MC0：真 compartment run 走到边界事务后 memories 表有行，m0 注入面可见记忆内容", async () => {
  const identity = projectIdentityModule.resolveProjectIdentityForSession(projectDir);
  assert.ok(
    identity !== undefined,
    "临时项目目录必须能解析出 identity，否则 promotion 无从落库（测试环境失效）",
  );

  await runHistorianOnce(SESSION, { memoryEnabled: true, autoPromote: true });

  // 前置证明：publish 事务真的走到了——compartments 表留下该 session 的行。
  const compartments = compartmentStorage.getCompartments(db, SESSION);
  assert.equal(compartments.length, 1, "本次 run 必须恰好发布 1 个 compartment（单舱组合）");
  assert.equal(compartments[0].startMessage, 1);
  assert.equal(compartments[0].endMessage, 10);

  // D13 核心：memories 表有行，且是 promoteSessionFactsDurable 从 historian
  // facts 落的（不是手工 insert 的）。
  const architectureMemory = storageMemory.getMemoryByHash(
    db,
    identity,
    "ARCHITECTURE",
    normalizeHash.computeNormalizedHash("ctx_search 复用 storage-memory-fts 的查询消毒层"),
  );
  assert.ok(architectureMemory, "ARCHITECTURE fact 必须已落库");
  assert.equal(architectureMemory.sourceType, "historian");
  assert.equal(architectureMemory.sourceSessionId, SESSION);
  assert.equal(architectureMemory.seenCount, 1);

  const rulesMemory = storageMemory.getMemoryByHash(
    db,
    identity,
    "PROJECT_RULES",
    normalizeHash.computeNormalizedHash("项目记忆写入必须与分舱边界同事务"),
  );
  assert.ok(rulesMemory, "PROJECT_RULES fact 必须已落库");

  // storage-memory 读出 promoted 行（引用改指后的真读路径）。
  const active = storageMemory.getMemoriesByProject(db, identity);
  assert.ok(
    active.length >= 2,
    `getMemoriesByProject 至少读到 2 条 promoted 行，实际 ${active.length}`,
  );

  // m0 注入面可见记忆内容（renderMemoryBlockV2 即 m0 <project-memory> 块的渲染器）。
  const rendered = injectCompartments.renderMemoryBlockV2(active);
  assert.match(rendered, /^<project-memory>/, "必须渲染出 <project-memory> 块");
  assert.ok(
    rendered.includes("ctx_search 复用 storage-memory-fts 的查询消毒层"),
    "m0 渲染面必须包含 promoted fact 内容",
  );

  // m0 token 归因面（m0-token-breakdown）必须看到记忆 token——它的
  // getMemoriesByProject  import 已改指真身（stub 时代恒 0 tokens）。
  const breakdown = m0Breakdown.computeM0BlockTokens(db, SESSION, {
    m0Text: "",
    projectIdentity: identity,
    injectionBudgetTokens: 8_000,
    memoryBlockCount: 1,
  });
  assert.ok(
    breakdown.memoryTokens > 0,
    `m0 memory token 归因必须 > 0，实际 ${breakdown.memoryTokens}`,
  );
});

// ── T-MC0b ───────────────────────────────────────────────────────────────

test("T-MC0b：Issue #44 门关闭时 publish 仍走边界事务但不写 memories", async () => {
  const identity = projectIdentityModule.resolveProjectIdentityForSession(projectDir);
  const before = storageMemory.getMemoriesByProject(db, identity).length;

  // 新 session = 同一 eligible head、同一条 publish 路径再来一次，只是门关闭。
  await runHistorianOnce(`${SESSION}_gate_off`, { memoryEnabled: false, autoPromote: true });

  // 阴性对照的前提：边界事务真的发生了（不是 no-op 造成的假阴性）。
  const gatedCompartments = compartmentStorage.getCompartments(db, `${SESSION}_gate_off`);
  assert.equal(
    gatedCompartments.length,
    1,
    "门关闭时 publish 必须照常落 compartments——否则本条只是 no-op 假阴性",
  );
  const after = storageMemory.getMemoriesByProject(db, identity).length;
  assert.equal(
    after,
    before,
    "memoryEnabled=false 时 historian 不得新增 memories（Issue #44 单写门）",
  );
});

test("T-MC0b2：Issue #44 右臂——autoPromote=false 同样不写 memories", async () => {
  // MF-MC-1：双门的右臂此前无直证。memoryEnabled=true（记忆注入开着）但
  // autoPromote=false（用户关掉「自动写入」）时，publish 事务照常，但
  // memories 一列不得新增。
  const identity = projectIdentityModule.resolveProjectIdentityForSession(projectDir);
  const before = storageMemory.getMemoriesByProject(db, identity).length;

  await runHistorianOnce(`${SESSION}_auto_promote_off`, {
    memoryEnabled: true,
    autoPromote: false,
  });

  // 防假阴性前提：右臂关闭的这条 publish 路真的走到了。
  const gatedCompartments = compartmentStorage.getCompartments(db, `${SESSION}_auto_promote_off`);
  assert.equal(
    gatedCompartments.length,
    1,
    "autoPromote=false 时 publish 仍必须落 compartments——否则本条只是 no-op 假阴性",
  );
  const after = storageMemory.getMemoriesByProject(db, identity).length;
  assert.equal(
    after,
    before,
    "autoPromote=false 时 historian 不得新增 memories（Issue #44 双门右臂）",
  );
});

// ── T-MC0c ───────────────────────────────────────────────────────────────

test("T-MC0c：unanchored promotion skip 留可观测日志（discard-last，reason+facts 在场）", async () => {
  // MF-MC-2：末舱紧贴 eligible head → discard-last → 本舱 facts unanchored，
  // promotion 被跳过。没有日志时「记忆没写」与「记忆功能被关」同形，无法归因。
  // 断言 sessionLog 同时给出 reason=discarded_last 与 facts 计数。
  const sessionId = `${SESSION}_discard_last`;
  const identity = projectIdentityModule.resolveProjectIdentityForSession(projectDir);

  await runHistorianOnce(sessionId, {
    memoryEnabled: true,
    autoPromote: true,
    historianOutput: HISTORIAN_OUTPUT_TWO_COMPARTMENTS,
  });

  // 行为侧：末舱被丢、只落首舱（discard-last 的既有语义不被日志改动破坏）。
  const compartments = compartmentStorage.getCompartments(db, sessionId);
  assert.equal(compartments.length, 1, "discard-last 必须只落首舱（末舱留待下次重导）");
  assert.equal(compartments[0].startMessage, 1);
  assert.equal(compartments[0].endMessage, 4);

  // facts 随末舱被 skip：独特内容的 fixture fact 不得出现在 memories 里。
  const unanchoredMemory = storageMemory.getMemoryByHash(
    db,
    identity,
    "CONSTRAINTS",
    normalizeHash.computeNormalizedHash("未锚定分舱的 facts 必须留在下次重导"),
  );
  assert.equal(
    unanchoredMemory,
    null,
    "unanchored facts 不得落库——skip 必须在行为上成立，日志只是可观测面",
  );

  // 可观测侧（本条的 CR 修复点）：logger 落盘后 reason + facts 计数在场。
  // fork 无上游 publishableEvents 计数面，只强制这两个量（fix-spec 口径）。
  logger.flushLogger();
  let logText = "";
  try {
    logText = readFileSync(process.env.MAGIC_CONTEXT_LOG_PATH, "utf8");
  } catch {
    // 文件缺失时下面断言以空串失败，报出可比对的定位信息。
  }
  const skipLine = logText
    .split("\n")
    .find((line) => line.includes("promotion skipped: reason="));
  assert.ok(skipLine !== undefined, "sessionLog 必须记录 promotion skipped 行（reason+facts 在场）");
  assert.match(skipLine, /reason=discarded_last/, "discard-last 场景的 reason 必须是 discarded_last");
  assert.match(skipLine, /facts=\d+/, "日志必须带 facts 计数");
  assert.match(skipLine, /facts=2\b/, "双舱 fixture 的 historian facts 为 2 条");
});

// ── T-MC1 ────────────────────────────────────────────────────────────────

test("T-MC1：selection 真身生效——紧预算下 permanent 低 importance 胜出 active 高 importance", async () => {
  // memory-selection 真身的纯函数序（改指后 inject-compartments 的四个 .sort()
  // 都走它）：permanent 优先、importance 降序、reinforcement 新近、id 兜底。
  assert.equal(
    memorySelection.compareMemorySelectionPriority(
      { id: 1, importance: 10, status: "permanent", lastSeenAt: 1, verifiedAt: null },
      { id: 2, importance: 99, status: "active", lastSeenAt: 2, verifiedAt: null },
    ) < 0,
    true,
    "permanent 必须排在 active 之前，与 importance 无关",
  );
  assert.equal(
    memorySelection.compareMemorySelectionPriority(
      { id: 1, importance: null, status: "active", lastSeenAt: 5, verifiedAt: null },
      { id: 2, importance: 1, status: "active", lastSeenAt: 9, verifiedAt: null },
    ) > 0,
    true,
    "缺失 importance 必须排在任意已设 importance 之后",
  );

  // 预算选择面：紧预算只容一条时，选中 permanent（即便 importance 更低）。
  const identity = projectIdentityModule.resolveProjectIdentityForSession(projectDir2);
  assert.ok(identity !== undefined, "第二个临时项目目录必须能解析 identity");

  const lowImportancePermanent = storageMemory.insertMemory(db, {
    projectPath: identity,
    category: "CONSTRAINTS",
    content: "永久约束：禁止直连真实用户目录",
    importance: 5,
    sourceType: "historian",
  });
  const highImportanceActive = storageMemory.insertMemory(db, {
    projectPath: identity,
    category: "NAMING",
    content: "临时命名约定：createX 工厂",
    importance: 99,
    sourceType: "historian",
  });
  storageMemory.updateMemoryStatus(db, lowImportancePermanent.id, "permanent");

  const candidates = storageMemory
    .getMemoriesByProject(db, identity)
    .filter(
      (memory) => memory.id === lowImportancePermanent.id || memory.id === highImportanceActive.id,
    );
  assert.equal(candidates.length, 2, "两条候选都必须读得回来");

  // 预算 = wrapper 成本 + 一条 line 成本 + 一个 category 标签成本，只容一条
  // （与 inject-compartments 的 createMemoryBlockAccounting 同口径：line + 首见
  // category 标签，active 候选的标签/line 都会把用量推过预算）。
  const permanentLine = injectCompartments.renderMemoryLineV2(lowImportancePermanent);
  const estimate = await import(
    pathToFileURL(join(PKG_ROOT, "dist/core/hooks/magic-context/read-session-formatting.js")).href
  );
  const oneLineBudget =
    estimate.estimateTokens("<project-memory>\n</project-memory>") +
    estimate.estimateTokens(`${permanentLine}\n`) +
    estimate.estimateTokens("<CONSTRAINTS>\n</CONSTRAINTS>\n");

  const trimmed = injectCompartments.trimMemoriesToBudgetV2(SESSION, candidates, oneLineBudget);
  assert.equal(trimmed.selected.length, 1, "紧预算必须只选中一条");
  assert.equal(
    trimmed.selected[0].id,
    lowImportancePermanent.id,
    "选中项必须是 permanent 低 importance 那条（selection 真身，非 id/importance 近似）",
  );
});

// ── T-MC1b ───────────────────────────────────────────────────────────────

test("T-MC1b：引用改指回归——watermark 真值 + user-memory 真身读写", () => {
  const identity = projectIdentityModule.resolveProjectIdentityForSession(projectDir);
  assert.ok(identity !== undefined);

  // storage-memory 真身的 watermark（stub 时代恒 0）。
  const maxId = storageMemory.getMaxMemoryIdForProjects(db, [identity]);
  assert.ok(maxId > 0, `getMaxMemoryIdForProjects 必须返回真水位，实际 ${maxId}`);

  // storage-user-memory 真身：stub 时代 getActiveUserMemories 恒空、无写入口。
  const before = storageUserMemory.getActiveUserMemories(db);
  assert.ok(Array.isArray(before), "getActiveUserMemories 必须返回数组（真身读路径）");
  storageUserMemory.insertUserMemory(db, "用户偏好：回答保持简洁", []);
  const after = storageUserMemory.getActiveUserMemories(db);
  assert.equal(
    after.length,
    before.length + 1,
    "insertUserMemory 落库后 getActiveUserMemories 必须读到",
  );
  assert.equal(after[after.length - 1].content, "用户偏好：回答保持简洁");
});
