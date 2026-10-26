#!/usr/bin/env node
/**
 * Step 5 / phase-paged-materialization —— 分支感知尾窗正文读 `readActiveBranchTail`。
 *
 * ============================================================================
 * 这一步新出现的失效面（每条都对应下面一组用例）
 * ============================================================================
 *
 *   A. **窗口不是「按时间取尾 N 条」**（IS2 / T-SL3 / T-SL4）：revert 过的会话里旧分支的
 *      消息仍在 append-only store 里。若按 `time_created desc` 取尾 N 条再裁断，或者把窗口
 *      本身喂给裁断函数：
 *        - target 落在窗外 → `targetIndex < 0` → **原样返回窗口 = 旧分支复活**（T-SL3）；
 *        - cut 落在窗外 → `cutIndex < 0` → 返回空 kept → **整段清空历史**（T-SL4）。
 *      所以 `readActiveBranchTail` 吃的是调用方用「消息索引 + 全序裁断」算好的 active id 序，
 *      自己不做任何裁断。
 *
 *   B. **两侧权威序都要复刻**：message 段按 `activeMessageIds` 的**给定顺序**（裁断可以给出
 *      与 DB 序不同的 kept 顺序），part 段按
 *      `order by message_id, sequence is null, sequence, time_created, id`。
 *      后者漏一个 tiebreaker 就与 `messages()` 静默不同序，合成器看到的 part 序随之漂移。
 *
 *   C. **只读窗口内的正文**：更早消息的 `data` 与 part 一条都不读。这是冷开读放大比的来源；
 *      退回全量读（或 part 段按 session 读）会让窗口化在时延上没有任何效果。
 *
 * 运行方式：`node --import tsx --test scripts/test-active-branch-tail.mjs`。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const { SQLITE_MIGRATIONS } = await import(
  new URL("../src/storage/session-store/migrations.ts", import.meta.url).href
);
const { listSessionMessageIndex, messages, readActiveBranchTail, readActiveBranchToolParts } =
  await import(
    new URL("../src/storage/session-store/repositories/messages.ts", import.meta.url).href
  );
const { selectActiveConversationBranchIds } = await import(
  new URL("../../contracts/src/rewind/index.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 5 active branch tail read (IS2 / T-SL3 / T-SL4)"
      : `TEST FAIL — Step 5 active branch tail read (exit code ${code})`,
  );
});

const SESSION = "ses_branch_tail";
const OTHER_SESSION = "ses_branch_tail_other";

/** 跑完整迁移链的 :memory: 库（0015 的 sequence 触发器也在链上）。 */
function migratedDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(`create table if not exists schema_migration (
    id text primary key, checksum text not null, app_version text, time_applied integer not null
  )`);
  for (const migration of SQLITE_MIGRATIONS) db.exec(migration.sql);
  seedSession(db, SESSION);
  seedSession(db, OTHER_SESSION);
  return db;
}

function seedSession(db, sessionID) {
  db.prepare(
    `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionID, "prj_tail", sessionID, "D:/ws", sessionID, "0.0.0", 1, 1);
}

function insertMessage(db, { id, sequence, timeCreated, role = "user", sessionID = SESSION }) {
  db.prepare(
    `insert into message (id, session_id, time_created, time_updated, data, sequence)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sessionID,
    timeCreated,
    timeCreated,
    JSON.stringify({ role, time: { created: timeCreated } }),
    sequence,
  );
  return id;
}

function insertPart(db, { id, messageID, sequence, timeCreated, text, sessionID = SESSION }) {
  db.prepare(
    `insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    messageID,
    sessionID,
    timeCreated,
    timeCreated,
    JSON.stringify({ type: "text", text, time: { start: timeCreated } }),
    sequence,
  );
  return id;
}

/** 六个消息、按插入序（= 权威序）m1..m6，每轮两段。 */
function seedBranchFixture(db) {
  const spec = [
    ["m1", 0, "user"],
    ["m2", 1, "assistant"],
    ["m3", 2, "user"],
    ["m4", 3, "assistant"],
    ["m5", 4, "user"],
    ["m6", 5, "assistant"],
  ];
  spec.forEach(([id, sequence, role], index) =>
    insertMessage(db, { id, sequence, timeCreated: 100 + index, role }),
  );
  for (const id of ["m1", "m2", "m3", "m4", "m5", "m6"]) {
    insertPart(db, {
      id: `${id}-p1`,
      messageID: id,
      sequence: 0,
      timeCreated: 200,
      text: `${id}a`,
    });
  }
  return db;
}

async function fullOrder(db, sessionID = SESSION) {
  return (await messages(db, { sessionID })).map((message) => message.info.id);
}

// ── A: 窗口 = 全量读的后缀（逐条 + parts 全等）──────────────────────────────

test("A1: 尾窗读与 messages() 的后缀逐条相等（含 parts 内容）", async () => {
  const db = seedBranchFixture(migratedDb());
  const full = await messages(db, { sessionID: SESSION });
  const activeIds = full.map((message) => message.info.id);

  const tail = await readActiveBranchTail(db, {
    sessionID: SESSION,
    activeMessageIds: activeIds,
    limitBefore: "m4",
  });
  assert.deepEqual(tail, full.slice(3), "窗口必须是全量读的后缀，不是另一份物化");
  assert.deepEqual(
    tail.map((message) => message.info.id),
    ["m4", "m5", "m6"],
  );
  db.close();
});

test("A2: 缺 limitBefore = 读整条分支（与全量读逐条相等）", async () => {
  const db = seedBranchFixture(migratedDb());
  const full = await messages(db, { sessionID: SESSION });
  const all = await readActiveBranchTail(db, {
    sessionID: SESSION,
    activeMessageIds: full.map((message) => message.info.id),
  });
  assert.deepEqual(all, full);
  db.close();
});

test("A3: 顺序由 activeMessageIds 决定，不按 DB 序重排（rewind 的 kept 顺序）", async () => {
  const db = seedBranchFixture(migratedDb());
  const tail = await readActiveBranchTail(db, {
    sessionID: SESSION,
    activeMessageIds: ["m2", "m1"],
  });
  assert.deepEqual(
    tail.map((message) => message.info.id),
    ["m2", "m1"],
    "裁断可以给出与存储序不同的 kept 顺序，读面必须照它返回",
  );
  db.close();
});

test("A4: 空 active 序 → 空结果（不发 SQL，也不当成全量）", async () => {
  const db = seedBranchFixture(migratedDb());
  assert.deepEqual(
    await readActiveBranchTail(db, { sessionID: SESSION, activeMessageIds: [] }),
    [],
  );
  db.close();
});

test("A5: 重复 id 按首现去重（kept 与 cut 后缀重叠时一行只出现一次）", async () => {
  const db = seedBranchFixture(migratedDb());
  const tail = await readActiveBranchTail(db, {
    sessionID: SESSION,
    activeMessageIds: ["m1", "m2", "m1"],
  });
  assert.deepEqual(
    tail.map((message) => message.info.id),
    ["m1", "m2"],
    "投影一行一条；重复位置若参与排序还会把 m2 挤到前面",
  );
  db.close();
});

// ── B: part 权威序复刻 ──────────────────────────────────────────────────────

/** 同一条消息上覆盖：非空 sequence / 撞号 / 同时间 / NULL sequence。 */
async function seedPartOrderFixture(db) {
  insertMessage(db, { id: "p-msg", sequence: 0, timeCreated: 100 });
  insertPart(db, { id: "q1", messageID: "p-msg", sequence: 0, timeCreated: 100, text: "a" });
  insertPart(db, { id: "q3", messageID: "p-msg", sequence: 2, timeCreated: 100, text: "c" });
  insertPart(db, { id: "q2", messageID: "p-msg", sequence: 0, timeCreated: 110, text: "b" });
  insertPart(db, { id: "q4", messageID: "p-msg", sequence: 9, timeCreated: 90, text: "d" });
  // 0015 的 AFTER INSERT 触发器会把 NULL 补成队尾序号，所以 NULL 只能事后写出来。
  db.prepare("update part set sequence = null where id = ?").run("q4");
  return db;
}

test("B1: part 序 = sequence is null, sequence, time_created, id（NULL 排在非空之后）", async () => {
  const db = await seedPartOrderFixture(migratedDb());
  const full = await messages(db, { sessionID: SESSION });
  const tail = await readActiveBranchTail(db, {
    sessionID: SESSION,
    activeMessageIds: ["p-msg"],
  });
  assert.deepEqual(
    tail[0].parts.map((part) => part.id),
    ["q1", "q2", "q3", "q4"],
    "非空 sequence 先按 sequence、再按 time_created；NULL 行排最后",
  );
  assert.deepEqual(tail[0].parts, full[0].parts, "两条路径的 part 序必须逐条相等");
  db.close();
});

test("B2: part 段 ORDER BY 与 messages() 逐字一致（形状守卫）", () => {
  const source = readFileSync(
    new URL("../src/storage/session-store/repositories/messages.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function readActiveBranchTail");
  assert.ok(start >= 0, "readActiveBranchTail 必须存在于 messages.ts");
  const body = source.slice(start, source.indexOf("export async function messages("));
  const partSql = body.slice(body.indexOf("from part"));
  assert.ok(partSql.length > 0, "两段查询的第二段必须是 part 查询");
  const orderOf = (sql) => {
    const match = sql.match(/order by\s+([\s\S]*?)(?:`|\n|$)/i);
    assert.ok(match, "必须有 order by");
    return match[1].replace(/\s+/g, " ").trim();
  };
  const fullBody = source.slice(source.indexOf("export async function messages("));
  const fullPartSql = fullBody.slice(fullBody.indexOf("from part"));
  assert.equal(
    orderOf(partSql),
    orderOf(fullPartSql),
    "part 段必须复刻 messages() 的权威序（漏一个 tiebreaker 就静默不同序）",
  );
  assert.equal(orderOf(partSql), "message_id, sequence is null, sequence, time_created, id");
  assert.ok(!/sequence is not null/i.test(partSql));
  // 两段查询：part 段只按 message_id 过滤，不得按 session 全读（那是全量正文读）。
  assert.ok(/message_id in \(\$\{/.test(partSql), "part 段必须按本窗口的 messageId 收窄");
  // 收窄条件只有 session + message_id 两条：任何 `or` 都会把窗口读放大回全量（行集合不变，
  // 只有时延会变——这类退化必须由形状守卫拦住，不能指望行为用例）。
  assert.ok(!/\bor\b/i.test(partSql), "part 段不得出现 or（收窄条件只能是 and）");
});

// ── C: 窗口边界 ─────────────────────────────────────────────────────────────

test("C1: limitBefore 含在窗口内，且更早的消息一条都不返回", async () => {
  const db = seedBranchFixture(migratedDb());
  const tail = await readActiveBranchTail(db, {
    sessionID: SESSION,
    activeMessageIds: ["m1", "m2", "m3", "m4", "m5", "m6"],
    limitBefore: "m5",
  });
  assert.deepEqual(
    tail.map((message) => message.info.id),
    ["m5", "m6"],
  );
  db.close();
});

test("C2: limitBefore 不在 active 序里 → 退化为整条分支（多读，绝不少读）", async () => {
  const db = seedBranchFixture(migratedDb());
  const tail = await readActiveBranchTail(db, {
    sessionID: SESSION,
    activeMessageIds: ["m1", "m2", "m3"],
    limitBefore: "m-gone",
  });
  assert.deepEqual(
    tail.map((message) => message.info.id),
    ["m1", "m2", "m3"],
    "游标找不到时不能返回空首屏",
  );
  db.close();
});

test("C3: 跨会话隔离（active 序里混进别的会话 id 也不得读出来）", async () => {
  const db = seedBranchFixture(migratedDb());
  insertMessage(db, { id: "x1", sequence: 0, timeCreated: 1, sessionID: OTHER_SESSION });
  const tail = await readActiveBranchTail(db, {
    sessionID: SESSION,
    activeMessageIds: ["m1", "x1"],
  });
  assert.deepEqual(
    tail.map((message) => message.info.id),
    ["m1"],
  );
  db.close();
});

test("C4: 非 active（被裁掉）的消息不返回——分支归属只由 activeMessageIds 决定", async () => {
  const db = seedBranchFixture(migratedDb());
  const full = await messages(db, { sessionID: SESSION });
  const activeIds = selectActiveConversationBranchIds(
    full.map((message) => message.info.id),
    { rewindTargetMessageId: "m3" },
  );
  assert.deepEqual(activeIds, ["m1", "m2"]);
  const tail = await readActiveBranchTail(db, { sessionID: SESSION, activeMessageIds: activeIds });
  assert.deepEqual(
    tail.map((message) => message.info.id),
    ["m1", "m2"],
    "旧分支 m3..m6 仍在 append-only store 里，但不得出现在尾窗读里",
  );
  db.close();
});

test("C5: limitAfter 是**不含**的上界（Step 7 按页物化：翻第 N 页不读它以下的后缀）", async () => {
  const db = seedBranchFixture(migratedDb());
  const activeIds = ["m1", "m2", "m3", "m4", "m5", "m6"];
  const page = await readActiveBranchTail(db, {
    sessionID: SESSION,
    activeMessageIds: activeIds,
    limitBefore: "m2",
    limitAfter: "m4",
  });
  assert.deepEqual(
    page.map((message) => message.info.id),
    ["m2", "m3"],
    "两端都是整轮边界；上界那条**不**读",
  );
  // 上界找不到 = 读到分支末尾（多读，绝不少读），与 limitBefore 同一条纪律。
  const fallback = await readActiveBranchTail(db, {
    sessionID: SESSION,
    activeMessageIds: activeIds,
    limitBefore: "m2",
    limitAfter: "m-gone",
  });
  assert.deepEqual(
    fallback.map((message) => message.info.id),
    ["m2", "m3", "m4", "m5", "m6"],
  );
  // 两个游标重合 = 空页（调用方的页计划自相矛盾，不得静默读掉整条分支）。
  const empty = await readActiveBranchTail(db, {
    sessionID: SESSION,
    activeMessageIds: activeIds,
    limitBefore: "m3",
    limitAfter: "m3",
  });
  assert.deepEqual(empty, []);
  db.close();
});

// ── D: T-SL3 / T-SL4 —— 窗口喂裁断会复活旧分支 / 清空历史 ──────────────────

test("D1: T-SL3 target 在窗外 → 全序裁断不复活旧分支，窗口裁断会", async () => {
  const db = seedBranchFixture(migratedDb());
  const fullIds = await fullOrder(db);
  const options = { rewindTargetMessageId: "m3" };

  const fullCut = selectActiveConversationBranchIds(fullIds, options);
  assert.deepEqual(fullCut, ["m1", "m2"]);

  // 窗口 = 最后两条（target 在窗外）：裁断函数原样返回窗口 = 旧分支复活。
  const windowIds = fullIds.slice(-2);
  assert.deepEqual(selectActiveConversationBranchIds(windowIds, options), windowIds);

  // 正确组合：全序裁断 → 尾窗读。返回的必须是被保留的分支，不是窗口。
  const tail = await readActiveBranchTail(db, { sessionID: SESSION, activeMessageIds: fullCut });
  assert.deepEqual(
    tail.map((message) => message.info.id),
    ["m1", "m2"],
  );
  db.close();
});

test("D2: T-SL4 cut 在窗外且无 kept → 全序裁断非空，窗口裁断清空", async () => {
  const db = seedBranchFixture(migratedDb());
  const fullIds = await fullOrder(db);
  const options = {
    rewindTargetMessageId: "m3",
    branchCutAfterMessageId: "m2",
  };

  const fullCut = selectActiveConversationBranchIds(fullIds, options);
  assert.ok(fullCut.length > 0, "全序裁断不得清空历史");
  assert.deepEqual(fullCut, ["m1", "m2", "m3", "m4", "m5", "m6"]);

  // 窗口正好从 target 起：kept = slice(0, 0) = []，cut 在窗外 → 返回空。
  const windowIds = fullIds.slice(2);
  assert.deepEqual(
    selectActiveConversationBranchIds(windowIds, options),
    [],
    "这就是 T-SL4 的事故形态：窗口喂裁断会整段清空",
  );

  const tail = await readActiveBranchTail(db, { sessionID: SESSION, activeMessageIds: fullCut });
  assert.deepEqual(
    tail.map((message) => message.info.id),
    fullCut,
  );
  db.close();
});

// ── E: 读放大比（5k 消息 / 20k part，非 phase-0 基线）──────────────────────

test("E1: 5k 消息会话的读放大比（全量 messages() vs 尾窗 readActiveBranchTail）", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(`create table if not exists schema_migration (
    id text primary key, checksum text not null, app_version text, time_applied integer not null
  )`);
  for (const migration of SQLITE_MIGRATIONS) db.exec(migration.sql);
  seedSession(db, SESSION);

  // 与 Step 3 的 A 组同一形状：5000 消息 / 20000 part × 1200B（≈24MB 正文）。
  const body = "x".repeat(1200);
  db.exec("begin");
  for (let index = 0; index < 5000; index += 1) {
    const messageId = `big-${String(index).padStart(4, "0")}`;
    insertMessage(db, {
      id: messageId,
      sequence: index,
      timeCreated: 1_700_000_000_000 + index,
      role: index % 2 === 0 ? "user" : "assistant",
    });
    for (let part = 0; part < 4; part += 1) {
      insertPart(db, {
        id: `${messageId}-p${part}`,
        messageID: messageId,
        sequence: part,
        timeCreated: 1_700_000_000_000 + index,
        text: body,
      });
    }
  }
  db.exec("commit");

  const indexStartedAt = performance.now();
  const index = await listSessionMessageIndex(db, { sessionID: SESSION });
  const indexMs = performance.now() - indexStartedAt;

  const fullStartedAt = performance.now();
  const full = await messages(db, { sessionID: SESSION });
  const fullMs = performance.now() - fullStartedAt;

  // 冷窗口：8 轮 × 10 条 = 80 条消息（320 part），正是 coldWindowTurns 的规模。
  const windowSize = 80;
  const windowStartedAt = performance.now();
  const tail = await readActiveBranchTail(db, {
    sessionID: SESSION,
    activeMessageIds: index.map((entry) => entry.id),
    limitBefore: index[index.length - windowSize].id,
  });
  const windowMs = performance.now() - windowStartedAt;

  assert.equal(full.length, 5000);
  assert.equal(tail.length, windowSize);
  assert.equal(
    tail.reduce((sum, message) => sum + message.parts.length, 0),
    windowSize * 4,
    "窗口只读这 80 条消息的 part",
  );
  assert.deepEqual(tail, full.slice(-windowSize), "窗口内容必须与全量读的后缀逐条相等");
  console.log(
    `[read-amplification] index=${indexMs.toFixed(1)}ms ` +
      `full(messages)=${fullMs.toFixed(1)}ms window(80 of 5000)=${windowMs.toFixed(1)}ms ` +
      `ratio=${(fullMs / Math.max(windowMs, 0.001)).toFixed(1)}x`,
  );
  assert.ok(windowMs < fullMs, "只读 1.6% 正文不可能比全量读慢（环境异常时先怀疑夹具）");

  // ③ 按 tool 名的窄读（fix-c19：子会话候选不再读父会话全文）——同一条「读放大」主线：
  //    只解命中的 part，且分支序/内容与全量读过滤结果逐值一致。
  const toolDb = seedBranchFixture(migratedDb());
  insertToolPart(toolDb, { id: "t-a1", messageID: "m1", tool: "Task" });
  insertToolPart(toolDb, { id: "t-a2", messageID: "m2", tool: "Agent" });
  insertToolPart(toolDb, { id: "t-b1", messageID: "m4", tool: "Bash" });
  insertToolPart(toolDb, { id: "t-a3", messageID: "m6", tool: "subagent" });

  const toolFull = await messages(toolDb, { sessionID: SESSION });
  const toolActiveIds = toolFull.map((message) => message.info.id);
  const narrow = await readActiveBranchToolParts(toolDb, {
    sessionID: SESSION,
    toolNames: ["Agent", "Task", "subagent"],
    activeMessageIds: toolActiveIds,
  });
  assert.deepEqual(
    narrow.map((entry) => entry.part.callID),
    ["call-t-a1", "call-t-a2", "call-t-a3"],
    "只读 Agent 类 tool part（Bash 必须被 SQL 过滤掉），顺序 = active 分支序",
  );
  // 与「全量读 + 手工过滤」逐值一致（同一份 part 判定，不允许两套）。
  const fullFiltered = toolFull.flatMap((message) =>
    message.parts
      .filter((part) => part.type === "tool" && ["Agent", "Task", "subagent"].includes(part.tool))
      .map((part) => ({ messageId: message.info.id, part })),
  );
  assert.deepEqual(narrow, fullFiltered, "窄读结果必须与全量读过滤结果逐值相等");

  // 分支裁断仍然只有一份实现：被裁掉的消息上的 Agent part 不进结果。
  const cut = await readActiveBranchToolParts(toolDb, {
    sessionID: SESSION,
    toolNames: ["Agent", "Task", "subagent"],
    activeMessageIds: ["m1", "m2"],
  });
  assert.deepEqual(
    cut.map((entry) => entry.part.callID),
    ["call-t-a1", "call-t-a2"],
    "activeMessageIds 之外的消息（含它的 part）一条都不许出来",
  );

  // 空 tool 名单 = 不读（不能退化成整会话扫描）。
  assert.deepEqual(
    await readActiveBranchToolParts(toolDb, {
      sessionID: SESSION,
      toolNames: [],
      activeMessageIds: toolActiveIds,
    }),
    [],
    "空 tool 名单必须直接返回空（不发 SQL）",
  );
  toolDb.close();
  db.close();
});

// ── F: 按 tool 名的窄读的夹具（fix-c19）────────────────────────────────────

/** 工具调用 part（`readActiveBranchToolParts` 的判据是 `$.type='tool'` + `$.tool`）。 */
function insertToolPart(db, { id, messageID, tool, sequence = 0, timeCreated = 300 }) {
  db.prepare(
    `insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    messageID,
    SESSION,
    timeCreated,
    timeCreated,
    JSON.stringify({
      type: "tool",
      callID: `call-${id}`,
      tool,
      state: {
        status: "completed",
        input: { description: id },
        output: `{\\"childSessionId\\":\\"child-${id}\\"}`,
        time: { start: timeCreated, end: timeCreated },
      },
    }),
    sequence,
  );
  return id;
}
