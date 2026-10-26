#!/usr/bin/env node
/**
 * Step 3 / phase-row-manifest —— 全序消息索引 `listSessionMessageIndex` 与裁断双路等价的
 * 自动化验证（T-SL1 + T-SL2 的 Step 3 部分）。
 *
 * ============================================================================
 * 这一步新出现的失效面
 * ============================================================================
 *
 *   A. **排序复刻**（IS2 / T-SL1）：索引与 `messages()` 必须是同一权威序
 *      （`order by sequence is null, sequence, time_created, rowid`）。两种写法最容易
 *      静默漂移：①忘了 `sequence is null`（NULL 行会跑到最前，而契约是排在非空之后）；
 *      ②省掉 `time_created` / `rowid` 两个 tiebreaker（sequence 撞号的行顺序不稳定）。
 *      漂移的后果不是崩溃，而是**索引路径与全量路径给出不同的 id 序**——裁断随之分叉。
 *
 *   B. **窄读**：这一层只准读排序键，`select *` 或读 `data` 会让冷开退回全量正文读，
 *      Step 5/7 的窗口化收益直接归零（message 表没有 role 列，role 在 data JSON 里）。
 *
 *   C. **双路裁断**（IS2 / T-SL2）：`selectActiveConversationBranch` 的输入放宽后，
 *      全量消息与索引条目必须走**同一份规则**。分叉点是三项「找不到」的场景：
 *      target 不在窗 / cut 不在窗 / `keptMessageIDs` 里混着不存在的 id。规则若在两处
 *      各写一份，找不到时的兜底方向一旦不同，就会**静默复活已回滚分支**或**清空历史**。
 *
 * 运行方式：`node --import tsx --test scripts/test-session-message-index.mjs`
 * （走 tsx 因为被测代码是 `src/` 的 TypeScript；contracts 也直接吃源码，
 *   避免测到过期的 dist。）
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const { SQLITE_MIGRATIONS } = await import(
  new URL("../src/storage/session-store/migrations.ts", import.meta.url).href
);
const { listSessionMessageIndex, messages, readLatestAssistantSelection } = await import(
  new URL("../src/storage/session-store/repositories/messages.ts", import.meta.url).href
);
const { readTurnManifest, upsertTurnManifest } = await import(
  new URL("../src/storage/session-store/repositories/turn-manifest.ts", import.meta.url).href
);
const { selectActiveConversationBranch, selectActiveConversationBranchIds } = await import(
  new URL("../../contracts/src/rewind/index.ts", import.meta.url).href
);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 3 session message index (T-SL1 / T-SL2)"
      : `TEST FAIL — Step 3 session message index (exit code ${code})`,
  );
});

const SESSION = "ses_message_index";
const OTHER_SESSION = "ses_message_index_other";
const VERSION = 1;

/** 跑完整迁移链的 :memory: 库（0001 建表 + 0014/0015 的 sequence 列与触发器都在链上）。 */
function migratedDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  // runner 会先建账本再逐条执行；0022 在 SQL 里 JOIN 了 schema_migration，缺它必然报错。
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
  ).run(sessionID, "prj_index", sessionID, "D:/ws", sessionID, "0.0.0", 1, 1);
}

/**
 * 直接写列而不用 `saveMessage`：测试需要控制 `sequence`（含 NULL）与插入序（rowid），
 * 而 `saveMessage` 恒写非空 sequence。写进来的 `data` 仍是合法消息 JSON，
 * `messages()` 的完整读路径能正常解码（本测试要拿它当权威序基准）。
 */
function insertMessage(
  db,
  { id, sequence, timeCreated, role = "user", sessionID = SESSION, extra = {} },
) {
  db.prepare(
    `insert into message (id, session_id, time_created, time_updated, data, sequence)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sessionID,
    timeCreated,
    timeCreated,
    JSON.stringify({ role, time: { created: timeCreated }, ...extra }),
    sequence,
  );
  return id;
}

/**
 * 排序夹具：覆盖「非空 sequence / NULL sequence / sequence 撞号 / 同 sequence 同时间」。
 *
 * 期望序（权威序 = `messages()`）：
 *   seq0(m1) → seq1(m2) → seq2(m3) → seq3@t100(m5) → seq3@t105(m6) → seq3@t105(m7, rowid 更大)
 *   → NULL@t90(m4，时间最早但**排在最后**)
 */
async function seedOrderingFixture(db) {
  insertMessage(db, { id: "m1", sequence: 0, timeCreated: 100 });
  insertMessage(db, { id: "m2", sequence: 1, timeCreated: 110, role: "assistant" });
  insertMessage(db, { id: "m3", sequence: 2, timeCreated: 120 });
  insertMessage(db, { id: "m5", sequence: 3, timeCreated: 100 });
  insertMessage(db, { id: "m6", sequence: 3, timeCreated: 105, role: "assistant" });
  insertMessage(db, { id: "m7", sequence: 3, timeCreated: 105 });
  insertMessage(db, { id: "m4", sequence: 9, timeCreated: 90 });
  // 0015 的 AFTER INSERT 触发器会把 NULL 补成队尾序号，所以 NULL 只能事后写出来
  // （真实来源：旧版本二进制并存写入的行，读路径必须仍然支持）。
  db.prepare("update message set sequence = null where id = ?").run("m4");
  // 另一个会话的行绝不能出现（缺 where session_id 的索引会把它带进来）。
  insertMessage(db, { id: "x1", sequence: 0, timeCreated: 1, sessionID: OTHER_SESSION });
  return db;
}

const EXPECTED_ORDER = ["m1", "m2", "m3", "m5", "m6", "m7", "m4"];

async function fullOrder(db) {
  return (await messages(db, { sessionID: SESSION })).map((message) => message.info.id);
}

async function indexOrder(db) {
  return (await listSessionMessageIndex(db, { sessionID: SESSION })).map((entry) => entry.id);
}

/** 从源码里抽出某个函数体内的第一条 SQL 模板字符串（用于形状守卫）。 */
function sqlOf(source, functionName) {
  const start = source.indexOf(`export async function ${functionName}`);
  assert.ok(start >= 0, `${functionName} 必须存在于 messages.ts`);
  const body = source.slice(start);
  const match = body.match(/\.prepare\(\s*`([\s\S]*?)`/);
  assert.ok(match, `${functionName} 必须有一条 prepare 的 SQL 模板字符串`);
  return match[1];
}

// ── A: 排序复刻（T-SL1）─────────────────────────────────────────────────────

test("A1: 索引 id 序与 messages() 全量读逐条相等（含 NULL sequence / 撞号 / 同时间）", async () => {
  const db = await seedOrderingFixture(migratedDb());
  assert.deepEqual(await fullOrder(db), EXPECTED_ORDER, "先钉住权威序本身");
  assert.deepEqual(await indexOrder(db), EXPECTED_ORDER);
  db.close();
});

test("A2: 索引只读本会话（缺 where session_id 会把别的会话行带进来）", async () => {
  const db = await seedOrderingFixture(migratedDb());
  const ids = await indexOrder(db);
  assert.ok(!ids.includes("x1"));
  assert.equal(ids.length, EXPECTED_ORDER.length);
  db.close();
});

test("A3: rewind 删行留下的 sequence 空洞不影响两路同序", async () => {
  const db = await seedOrderingFixture(migratedDb());
  db.prepare("delete from message where id = ?").run("m6");
  insertMessage(db, { id: "m8", sequence: 10, timeCreated: 200 });
  const full = await fullOrder(db);
  assert.deepEqual(await indexOrder(db), full, "空洞后的追加行也要同序");
  // m4 的 sequence 是 NULL：即便 m8 是后追加的行，NULL 行仍排在**所有**非空行之后。
  assert.deepEqual(full, ["m1", "m2", "m3", "m5", "m7", "m8", "m4"]);
  db.close();
});

test("A4: 索引行的 ORDER BY 与 messages() 逐字一致（形状守卫）", async () => {
  const source = readFileSync(
    new URL("../src/storage/session-store/repositories/messages.ts", import.meta.url),
    "utf8",
  );
  const fullSql = sqlOf(source, "messages");
  const indexSql = sqlOf(source, "listSessionMessageIndex");
  const orderOf = (sql) => {
    const match = sql.match(/order by\s+([\s\S]*)$/i);
    assert.ok(match, "必须有 order by");
    return match[1].replace(/\s+/g, " ").trim();
  };
  assert.equal(orderOf(indexSql), orderOf(fullSql), "两段查询必须复刻同一权威序");
  assert.equal(orderOf(indexSql), "sequence is null, sequence, time_created, rowid");
  // NULL 契约：`sequence is null` 的 0/1 语义把 NULL 排在非空之后，写反成 `is not null`
  // 会让旧行跑到队首——那是最容易被「整理 SQL」改坏的一处。
  assert.ok(!/sequence is not null/i.test(indexSql));
  assert.ok(!/select\s+\*/i.test(indexSql), "索引不得 select *");
  assert.ok(!/\bdata\b/.test(indexSql), "索引不得读 data（role 在 data JSON 里）");
  assert.ok(/from message/.test(indexSql));
});

test("A5: 索引条目只有排序键，不带 role/正文/parts（窄读契约）", async () => {
  const db = await seedOrderingFixture(migratedDb());
  const entries = await listSessionMessageIndex(db, { sessionID: SESSION });
  assert.equal(entries.length, EXPECTED_ORDER.length);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["id", "sequence", "storageRowId", "timeCreated"]);
  }
  const nullEntry = entries.find((entry) => entry.id === "m4");
  assert.equal(nullEntry.sequence, null, "NULL sequence 必须原样返回，不能被读成 0");
  assert.equal(typeof nullEntry.storageRowId, "number");
  db.close();
});

// ── B: 双路裁断（T-SL2）─────────────────────────────────────────────────────

/**
 * 双路等价：同一份输入（全量消息 vs 索引条目）与同一组 rewind 选项必须得到同一 id 序。
 * 顺带断言 id 核心（`selectActiveConversationBranchIds`）与两者都一致——三条路径
 * 指的是同一份规则。
 */
async function assertDualPath(db, options) {
  const full = await messages(db, { sessionID: SESSION });
  const index = await listSessionMessageIndex(db, { sessionID: SESSION });
  const fullIds = selectActiveConversationBranch(full, options).map((message) => message.info.id);
  const indexIds = selectActiveConversationBranch(index, {
    ...options,
    getMessageId: (entry) => entry.id,
  }).map((entry) => entry.id);
  const coreIds = selectActiveConversationBranchIds(
    index.map((entry) => entry.id),
    options,
  );
  assert.deepEqual(indexIds, fullIds, `索引路径与全量路径必须同序：${JSON.stringify(options)}`);
  assert.deepEqual(coreIds, fullIds, `id 核心与全量路径必须同序：${JSON.stringify(options)}`);
  return fullIds;
}

test("B1: 无 rewind 选项 → 两路都返回完整序", async () => {
  const db = await seedOrderingFixture(migratedDb());
  assert.deepEqual(await assertDualPath(db, {}), EXPECTED_ORDER);
  db.close();
});

test("B2: target 在序内 → 两路都截在 target 之前", async () => {
  const db = await seedOrderingFixture(migratedDb());
  assert.deepEqual(await assertDualPath(db, { rewindTargetMessageId: "m5" }), ["m1", "m2", "m3"]);
  db.close();
});

test("B3: target 不在序内 → 两路都不截（不得把「找不到」当成「全截」）", async () => {
  const db = await seedOrderingFixture(migratedDb());
  assert.deepEqual(await assertDualPath(db, { rewindTargetMessageId: "m-absent" }), EXPECTED_ORDER);
  db.close();
});

test("B4: cut 在序内 → 两路都是「target 前缀 + cut 之后」", async () => {
  const db = await seedOrderingFixture(migratedDb());
  assert.deepEqual(
    await assertDualPath(db, { rewindTargetMessageId: "m3", branchCutAfterMessageId: "m6" }),
    ["m1", "m2", "m7", "m4"],
  );
  db.close();
});

test("B5: cut 不在序内 → 两路都只保留 target 前缀（不得清空历史）", async () => {
  const db = await seedOrderingFixture(migratedDb());
  assert.deepEqual(
    await assertDualPath(db, { rewindTargetMessageId: "m3", branchCutAfterMessageId: "m-absent" }),
    ["m1", "m2"],
  );
  db.close();
});

test("B6: keptMessageIDs 混入不存在的 id → 两路都按 kept 给定顺序过滤", async () => {
  const db = await seedOrderingFixture(migratedDb());
  assert.deepEqual(
    await assertDualPath(db, {
      rewindTargetMessageId: "m3",
      rewindKeptMessageIds: ["m2", "m-ghost", "m1"],
    }),
    ["m2", "m1"],
  );
  db.close();
});

test("B7: kept + created 在序内 → 两路都是「kept 顺序 + created 起的后缀」", async () => {
  const db = await seedOrderingFixture(migratedDb());
  assert.deepEqual(
    await assertDualPath(db, {
      rewindTargetMessageId: "m3",
      rewindKeptMessageIds: ["m1", "m2"],
      rewindCreatedMessageId: "m6",
    }),
    ["m1", "m2", "m6", "m7", "m4"],
  );
  db.close();
});

test("B8: kept 给全但 created 不在序内 → 两路都只回 kept", async () => {
  const db = await seedOrderingFixture(migratedDb());
  assert.deepEqual(
    await assertDualPath(db, {
      rewindTargetMessageId: "m3",
      rewindKeptMessageIds: ["m1", "m2"],
      rewindCreatedMessageId: "m-absent",
    }),
    ["m1", "m2"],
  );
  db.close();
});

test("B9: target 不在序内但给了 created → 两路都忽略 created（targetIndex<0 分支优先）", async () => {
  const db = await seedOrderingFixture(migratedDb());
  assert.deepEqual(
    await assertDualPath(db, {
      rewindTargetMessageId: "m-absent",
      rewindCreatedMessageId: "m6",
    }),
    EXPECTED_ORDER,
  );
  db.close();
});

test("B10: 只喂窗口（target 在窗口外）→ 两路一致地返回窗口本身（IS2 要求调用方给全序）", async () => {
  const db = await seedOrderingFixture(migratedDb());
  const full = await messages(db, { sessionID: SESSION });
  const index = await listSessionMessageIndex(db, { sessionID: SESSION });
  const windowFull = full.slice(-3);
  const windowIndex = index.slice(-3);
  const options = { rewindTargetMessageId: "m1" };
  const fullIds = selectActiveConversationBranch(windowFull, options).map(
    (message) => message.info.id,
  );
  const indexIds = selectActiveConversationBranch(windowIndex, {
    ...options,
    getMessageId: (entry) => entry.id,
  }).map((entry) => entry.id);
  assert.deepEqual(indexIds, fullIds);
  // 这就是 T-SL3 的事故形态：target 落在窗口外时窗口输入会**原样返回旧分支**。
  // Step 3 只保证两条路径对同一输入等价；「必须喂全序」由 Step 5 的
  // readActiveBranchTail 与 Step 13 的 T-SL3/T-SL4 兜（不得在裁断里塞窗口兜底）。
  assert.deepEqual(
    fullIds,
    windowFull.map((message) => message.info.id),
  );
  db.close();
});

test("B11: 全量条目路径不传 getMessageId 仍然按 { info: { id } } 读（旧调用点不破）", async () => {
  const db = await seedOrderingFixture(migratedDb());
  const full = await messages(db, { sessionID: SESSION });
  assert.deepEqual(
    selectActiveConversationBranch(full, { rewindTargetMessageId: "m3" }).map((m) => m.info.id),
    ["m1", "m2"],
  );
  db.close();
});

// ── C: manifest 缺项的检测输入（Step 3 的 listSessionMessageIndex 是它的数据源）──

function turnRecord(turnId, ordinal, messageIds, rowCount = 2) {
  return {
    turnId,
    ordinal,
    messageIds,
    firstMessageId: messageIds[0] ?? null,
    lastMessageId: messageIds[messageIds.length - 1] ?? null,
    rowCount,
    rowCountSource: "live",
    projectionSchemaVersion: VERSION,
  };
}

test("C1: 索引给出的 id 覆盖 manifest → readTurnManifest 返回 ok（不误判重建）", async () => {
  const db = await seedOrderingFixture(migratedDb());
  await upsertTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    turn: turnRecord("t1", 0, ["m1", "m2", "m3"]),
    queries: [],
  });
  await upsertTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    turn: turnRecord("t2", 1, ["m5", "m6", "m7", "m4"]),
    queries: [],
  });
  const observedMessageIds = (await listSessionMessageIndex(db, { sessionID: SESSION })).map(
    (entry) => entry.id,
  );
  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
    observedMessageIds,
    observedTurnIds: ["t1", "t2"],
  });
  assert.equal(result.status, "ok");
  assert.equal(result.snapshot.totalCount, 4);
  db.close();
});

test("C2: manifest 指向索引里不存在的消息 → messageIndexMismatch（整表重建）", async () => {
  const db = await seedOrderingFixture(migratedDb());
  await upsertTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    turn: turnRecord("t1", 0, ["m1", "m-deleted"]),
    queries: [],
  });
  const observedMessageIds = (await listSessionMessageIndex(db, { sessionID: SESSION })).map(
    (entry) => entry.id,
  );
  const result = await readTurnManifest(db, {
    sessionID: SESSION,
    branchGeneration: 0,
    expectedProjectionSchemaVersion: VERSION,
    observedMessageIds,
  });
  assert.equal(result.status, "inconsistent");
  assert.equal(result.reason, "messageIndexMismatch");
  assert.deepEqual(result.missingMessageIds, ["m-deleted"]);
  db.close();
});

// ── D: 首屏 model/mode 窄读（Step 9）────────────────────────────────────────
//
// 失效面：view-only shell 用 `createRecord(resume:false)` 物化，runtime 停在默认模型，
// 首屏种子只能来自持久事实。查询有三个容易写错的地方：
//   ① 取「最后一条 assistant」而不是「最后一条消息」（会话尾部常常是 user/queue 行）；
//   ② 排序必须复刻权威序的**反序**（`sequence is null desc, sequence desc, ...`），
//      少一个 tiebreaker 就会在撞号/同时间时挑到隔壁那条；
//   ③ 没有 mode 的旧 assistant 必须跳过，不能当成「没有历史选型」。

/** 三条 assistant：a1 有 mode+模型、a2 没有 mode（旧记录）、a3 有 mode 但排在 a1 之前。 */
async function seedSelectionFixture(db) {
  insertMessage(db, {
    id: "u1",
    sequence: 0,
    timeCreated: 100,
    extra: { mode: "build" },
  });
  insertMessage(db, {
    id: "a1",
    sequence: 1,
    timeCreated: 110,
    role: "assistant",
    extra: {
      mode: "plan",
      modelId: "claude-x",
      providerId: "anthropic",
      reasoningLevel: "high",
      parentID: "u1",
    },
  });
  insertMessage(db, {
    id: "a2",
    sequence: 2,
    timeCreated: 120,
    role: "assistant",
    extra: { modelId: "ignored", providerId: "ignored", parentID: "u1" },
  });
  // 排在 a1 之前（sequence 更小）的 assistant：不能被当成「最后一条」。
  insertMessage(db, {
    id: "a0",
    sequence: -1,
    timeCreated: 90,
    role: "assistant",
    extra: { mode: "yolo", modelId: "old", providerId: "old" },
  });
  return db;
}

test("D1: 取最后一条**带 mode** 的 assistant（跳过无 mode 的旧记录与尾部 user 行）", async () => {
  const db = await seedSelectionFixture(migratedDb());
  const selection = await readLatestAssistantSelection(db, { sessionID: SESSION });
  assert.ok(selection, "必须找到一条");
  assert.equal(selection.mode, "plan", "a2 没有 mode → 继续往前找（不是「没有历史选型」）");
  assert.deepEqual(selection.modelSelection, {
    providerId: "anthropic",
    modelId: "claude-x",
    options: { reasoningLevel: "high" },
  });
  db.close();
});

test("D2: 无模式的历史 assistant 不参与（没有可用 mode 时返回的 mode 仍是空）", async () => {
  const db = migratedDb();
  insertMessage(db, { id: "u1", sequence: 0, timeCreated: 100 });
  insertMessage(db, {
    id: "a1",
    sequence: 1,
    timeCreated: 110,
    role: "assistant",
    extra: { modelId: "claude-x", providerId: "anthropic", parentID: "u1" },
  });
  assert.equal(
    await readLatestAssistantSelection(db, { sessionID: SESSION }),
    null,
    "一条带 mode 的 assistant 都没有 → null（首屏空态），不得伪造默认值",
  );
  db.close();
});

test("D3: 别的会话的 assistant 不会串进来（缺 where session_id 的最直接症状）", async () => {
  const db = await seedSelectionFixture(migratedDb());
  insertMessage(db, {
    id: "x9",
    sequence: 99,
    timeCreated: 999,
    role: "assistant",
    sessionID: OTHER_SESSION,
    extra: { mode: "yolo", modelId: "other", providerId: "other" },
  });
  const selection = await readLatestAssistantSelection(db, { sessionID: SESSION });
  assert.equal(selection.mode, "plan");
  assert.equal(selection.modelSelection.modelId, "claude-x");
  db.close();
});
