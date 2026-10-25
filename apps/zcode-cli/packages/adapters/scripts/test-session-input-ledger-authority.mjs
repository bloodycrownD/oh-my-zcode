#!/usr/bin/env node
/**
 * T-LEDGER-AUTHORITY（fix-a3）——`readSessionInputForExecution` 必须区分「损坏」与「合法空文本」。
 *
 * ============================================================================
 * 这一步锁死的失效形态
 * ============================================================================
 *
 * 执行侧（`sendQueuedNow`）自 Step 3 起把 `session_input` 当唯一权威：读不到 pending
 * 就硬失败。在此之前 `decodePayload` 用 try/catch 把**任何**解析失败兜底成
 * `{ text: "" }`——旧世界里那只是「展示面少了一段文本」，现在它意味着：
 *
 *   payload 损坏 → 执行侧拿到空文本 → 起一个空轮 → 把队列项移除 → 用户内容静默丢失，
 *   且不触发任何 fault（没有任何一层知道出过事）。
 *
 * 修法：admitted 行的 payload 解析失败 / 不是对象 / text 不是字符串 / 附件事实读不出，
 * 一律返回 `state:"corrupt"`（不携带 text），由 handler 走
 * `fault.command.inconsistentAuthority` 硬失败。`text: ""` 仍然是**合法**输入
 * （attachment-only query），必须照常 pending——两者绝不能再混在一起。
 *
 * 本脚本用**真实 SQLite 库**（临时目录）验证适配器侧：
 * 1) 非法 JSON → corrupt（而不是 `text: ""`）；
 * 2) 合法空文本 → pending；
 * 3) 附件事实只认 `conversationInputIntent.attachments`（两个账本写者都覆盖的位置），
 *    顶层 `payload.attachments` 会被 `TurnSteerQueued` 的重写丢掉，不得读它；
 * 4) F5：`promoteSessionInput` 只接受 status=admitted 的行，已 settle 的行 promote
 *    必须抛错并回滚（不留半截 user message）。
 *
 * handler 侧的对应断言在 `bootstrap/scripts/test-input-authority.mjs` 的 L4/L5。
 *
 * 运行：`pnpm --dir apps/zcode-cli/packages/adapters run test:session-input-ledger-authority`
 * （登记为 `node --import tsx --test`：apps/zcode-cli 是嵌套工作区，包内没有 tsx 的 .bin，
 *  Node 的 --import 会向上走到根 node_modules/tsx；直接跑 TS 源，无需先 build。）
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const { SqliteSessionStore } = await import("../src/storage/session-store/sqlite-session-store.js");

const SESSION_ID = "ses_ledger_authority";
const PROJ_ATTACHMENT = {
  ref: "C:\\tmp\\projection-stale.txt",
  fileName: "projection-stale.txt",
  mime: "text/plain",
  bytes: 21,
};
const LEDGER_ATTACHMENT = {
  ref: "C:\\tmp\\ledger-authoritative.txt",
  fileName: "ledger-authoritative.txt",
  mime: "text/plain",
  bytes: 17,
};

const tempRoot = mkdtempSync(join(tmpdir(), "omz-ledger-authority-"));
const dbPath = join(tempRoot, "session.db");
const store = new SqliteSessionStore({ dbPath });
// 独立连接用于「构造坏数据」：制造非法 JSON、跨 session 同 id 这类正常写入路径
// 不会产生的行（session 行仍按 FK 约束先建好，与真实 admission 顺序一致）。
const raw = new DatabaseSync(dbPath);

let sequence = 0;
/**
 * node:sqlite 默认 `enableForeignKeyConstraints: true`，而 session_input/message 都带
 * `references session(id)`——所以夹具必须先建 session 行（真实链路里 admission 也总是
 * 先有 session 再落账本），不能靠关 FK 绕过去。
 */
const ensuredSessions = new Set();
function ensureSession(sessionID = SESSION_ID) {
  if (ensuredSessions.has(sessionID)) return;
  raw
    .prepare(
      `insert or ignore into session (
         id, project_id, slug, directory, title, version, time_created, time_updated
       ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionID,
      "proj-ledger",
      "ledger-authority",
      tempRoot,
      "ledger authority",
      "1.0.20",
      Date.now(),
      Date.now(),
    );
  ensuredSessions.add(sessionID);
}
function insertInput({ behavior = {}, id, status = "admitted", statusReason = null }) {
  sequence += 1;
  const sessionID = behavior.sessionID ?? SESSION_ID;
  ensureSession(sessionID);
  raw
    .prepare(
      `insert into session_input (
         id, session_id, kind, delivery, payload,
         admitted_sequence, status, status_reason, time_created, time_updated
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sessionID,
      "sendText",
      "queue",
      behavior.payload ?? "{}",
      sequence,
      status,
      statusReason,
      Date.now(),
      Date.now(),
    );
}
function payloadOf({ text = "账本文本", attachments = [LEDGER_ATTACHMENT] } = {}) {
  return JSON.stringify({
    text,
    // 顶层 attachments 模拟 admission 写入的位置：TurnSteerQueued 的 upsert 会丢掉它，
    // 所以执行读法不得依赖这一处（用例 3 断言的是这个语义）。
    attachments: [PROJ_ATTACHMENT],
    conversationInputIntent: {
      sourceCommandId: "cmd-ledger",
      queueItemId: "queue-ledger",
      clientId: "ui",
      kind: "sendText",
      text,
      attachments,
      delivery: { requested: "queue", admitted: "queue" },
      order: { admissionSeq: 1 },
      steer: { state: "notRequested" },
      dispatch: { state: "admitted" },
      admittedAt: 1_700_000_000_000,
    },
  });
}

test.after(() => {
  try {
    raw.close();
  } catch {
    /* 已关闭 */
  }
  store.close();
  rmSync(tempRoot, { force: true, recursive: true });
});

test("1 合法 admitted 行：text 与附件都来自账本，附件取 conversationInputIntent 而非顶层", async () => {
  insertInput({ id: "input-valid", behavior: { payload: payloadOf({ text: "真实文本" }) } });
  const authority = await store.getSessionInputForExecution({
    id: "input-valid",
    sessionID: SESSION_ID,
  });
  assert.equal(authority.state, "pending");
  assert.equal(authority.text, "真实文本");
  assert.deepEqual(
    authority.attachments.map((ref) => ref.ref),
    [LEDGER_ATTACHMENT.ref],
    "附件必须取 conversationInputIntent.attachments；顶层 payload.attachments 会被 TurnSteerQueued 丢掉",
  );
});

test("2 payload 非法 JSON → corrupt，绝不兜底成空串（F4）", async () => {
  insertInput({ id: "input-broken-json", behavior: { payload: "{这不是 JSON" } });
  const authority = await store.getSessionInputForExecution({
    id: "input-broken-json",
    sessionID: SESSION_ID,
  });
  assert.equal(authority.state, "corrupt", "解析失败必须是损坏态，不是 pending");
  assert.equal(authority.reason, "payload_unparsable");
  assert.equal(
    Object.prototype.hasOwnProperty.call(authority, "text"),
    false,
    "损坏态不得携带 text——带上 text 就等于给「空文本起轮」留了后门",
  );
});

test("3 payload 不是对象（数组/标量）→ corrupt", async () => {
  insertInput({ id: "input-array", behavior: { payload: '["not an object"]' } });
  const array = await store.getSessionInputForExecution({
    id: "input-array",
    sessionID: SESSION_ID,
  });
  assert.equal(array.state, "corrupt");
  assert.equal(array.reason, "payload_not_object");

  insertInput({ id: "input-scalar", behavior: { payload: '"just a string"' } });
  const scalar = await store.getSessionInputForExecution({
    id: "input-scalar",
    sessionID: SESSION_ID,
  });
  assert.equal(scalar.state, "corrupt");
  assert.equal(scalar.reason, "payload_not_object");
});

test("4 text 不是字符串 → corrupt（不许把 null/数字当文本起轮）", async () => {
  insertInput({
    id: "input-text-not-string",
    behavior: {
      payload: JSON.stringify({ text: 42, conversationInputIntent: { attachments: [] } }),
    },
  });
  const authority = await store.getSessionInputForExecution({
    id: "input-text-not-string",
    sessionID: SESSION_ID,
  });
  assert.equal(authority.state, "corrupt");
  assert.equal(authority.reason, "text_not_string");
});

test("5 附件事实读不出 → corrupt（不许当成「没有附件」）", async () => {
  // 5a：没有 conversationInputIntent（旧写者/被外部改写）
  insertInput({
    id: "input-no-intent",
    behavior: { payload: JSON.stringify({ text: "只有文本" }) },
  });
  const noIntent = await store.getSessionInputForExecution({
    id: "input-no-intent",
    sessionID: SESSION_ID,
  });
  assert.equal(noIntent.state, "corrupt");
  assert.equal(noIntent.reason, "attachments_unreadable");

  // 5b：数组里混了坏项 → 整体不可信（过滤坏项 = 静默丢附件）
  insertInput({
    id: "input-bad-attachment",
    behavior: {
      payload: JSON.stringify({
        text: "文本",
        conversationInputIntent: { attachments: [LEDGER_ATTACHMENT, { ref: 42 }] },
      }),
    },
  });
  const badItem = await store.getSessionInputForExecution({
    id: "input-bad-attachment",
    sessionID: SESSION_ID,
  });
  assert.equal(badItem.state, "corrupt");
  assert.equal(badItem.reason, "attachments_unreadable");
});

test("6 合法空文本（只有附件）→ 仍然 pending，与损坏态区分", async () => {
  insertInput({
    id: "input-empty-text",
    behavior: { payload: payloadOf({ text: "", attachments: [LEDGER_ATTACHMENT] }) },
  });
  const authority = await store.getSessionInputForExecution({
    id: "input-empty-text",
    sessionID: SESSION_ID,
  });
  assert.equal(authority.state, "pending", "空文本是合法输入（attachment-only query）");
  assert.equal(authority.text, "");
  assert.equal(authority.attachments.length, 1);
});

test("7 终态 / 跨 session 同 id：不携带 text，且不能被执行", async () => {
  insertInput({ id: "input-promoted", status: "promoted" });
  const promoted = await store.getSessionInputForExecution({
    id: "input-promoted",
    sessionID: SESSION_ID,
  });
  assert.equal(promoted.state, "started");
  assert.equal(Object.prototype.hasOwnProperty.call(promoted, "text"), false);

  insertInput({ id: "input-cancelled", status: "cancelled", statusReason: "user_removed" });
  const cancelled = await store.getSessionInputForExecution({
    id: "input-cancelled",
    sessionID: SESSION_ID,
  });
  assert.equal(cancelled.state, "voided");
  assert.equal(cancelled.statusReason, "user_removed");
  assert.equal(Object.prototype.hasOwnProperty.call(cancelled, "text"), false);

  // 同 id 但别的 session：投影/账本 id 空间不跨会话共享，必须如实回缺失。
  insertInput({
    id: "input-other-session",
    behavior: { sessionID: "ses_someone_else", payload: payloadOf() },
  });
  const crossSession = await store.getSessionInputForExecution({
    id: "input-other-session",
    sessionID: SESSION_ID,
  });
  assert.equal(crossSession.state, "missing", "跨会话同 id 不得被当成执行权威");
});

test("8 F5 promote 只接受 admitted：已 settle 的行 promote 必须抛错并回滚整笔事务", async () => {
  ensureSession();
  const message = (id) => ({
    id,
    sessionID: SESSION_ID,
    role: "user",
    time: { created: Date.now() },
  });
  const parts = (messageId) => [
    {
      id: `${messageId}-part`,
      sessionID: SESSION_ID,
      messageID: messageId,
      type: "text",
      text: "内容",
      time: { start: Date.now(), end: Date.now() },
    },
  ];
  const messageCount = (id) =>
    raw.prepare("select count(*) as n from message where id = ?").get(id).n;
  const partCount = (messageId) =>
    raw.prepare("select count(*) as n from part where message_id = ?").get(messageId).n;
  const statusOf = (id) =>
    raw.prepare("select status from session_input where id = ?").get(id).status;

  // 8a：admitted 行正常 promotion（证明这条路径在被测条件下确实可用）
  insertInput({ id: "input-promotable", behavior: { payload: payloadOf() } });
  await store.promoteSessionInput({
    id: "input-promotable",
    sessionID: SESSION_ID,
    message: message("msg-promoted"),
    parts: parts("msg-promoted"),
  });
  assert.equal(statusOf("input-promotable"), "promoted");
  assert.equal(messageCount("msg-promoted"), 1);

  // 8b：读权威与 promote 之间被取消的行（F5 的残余窗口）→ 不得复活成 promoted
  insertInput({
    id: "input-cancelled-midflight",
    behavior: { payload: payloadOf() },
    status: "cancelled",
    statusReason: "user_removed",
  });
  await assert.rejects(
    () =>
      store.promoteSessionInput({
        id: "input-cancelled-midflight",
        sessionID: SESSION_ID,
        message: message("msg-resurrected"),
        parts: parts("msg-resurrected"),
      }),
    /not promotable/u,
    "已取消的输入 promote 必须硬失败（无前置条件的 UPDATE 会让它复活）",
  );
  assert.equal(statusOf("input-cancelled-midflight"), "cancelled", "失败后账本状态不得被改写");
  assert.equal(messageCount("msg-resurrected"), 0, "user message 必须随事务回滚");
  assert.equal(partCount("msg-resurrected"), 0, "parts 必须随事务回滚");

  // 8c：账本无此行（投影有、账本没有）同样不得落半截 message
  await assert.rejects(
    () =>
      store.promoteSessionInput({
        id: "input-does-not-exist",
        sessionID: SESSION_ID,
        message: message("msg-orphan"),
        parts: parts("msg-orphan"),
      }),
    /not promotable/u,
  );
  assert.equal(messageCount("msg-orphan"), 0, "缺行的 promote 不得留下孤儿 user message");
});
