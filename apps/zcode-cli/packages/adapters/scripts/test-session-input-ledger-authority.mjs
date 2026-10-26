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
 * **唯一例外（fix-a10 / cr-func P1-3）**：`intent` 与 `conversationInputIntent`
 * **同时**缺失的 legacy 形状（`{ text }`，今天仍会产出）读成 pending + `attachments: []`。
 * 这不是放宽「损坏 ≠ 空」：账本与投影都从未记录过附件时，`[]` 是唯一可读答案；
 * 把它判成损坏会让该项永久不可提升。判据是「intent 事实整体缺失」vs「字段在但读不出」，
 * 后者仍然 corrupt（用例 5b）。
 *
 * 本脚本用**真实 SQLite 库**（临时目录）验证适配器侧：
 * 1) 非法 JSON → corrupt（而不是 `text: ""`）；
 * 2) 合法空文本 → pending；
 * 3) 附件事实只认 `conversationInputIntent.attachments`（两个账本写者都覆盖的位置），
 *    顶层 `payload.attachments` 会被 `TurnSteerQueued` 的重写丢掉，不得读它；
 * 4) F5：`promoteSessionInput` 只接受 status=admitted 的行，已 settle 的行 promote
 *    必须抛错并回滚（不留半截 user message）；
 * 5) legacy 无 intent 行可执行（P1-3），而「字段在但读不出」仍 corrupt；
 * 6) promote 事务里的 shared-context 收口（`session-input-shared-context.ts`）：reserved 条目
 *    随 promote 变 attached 并记住 attachedMessageId，缺项/已失效一律连带回滚；
 * 7) `updateSessionInputs` 的 durable 改写（queue edit）：`payload.text` 与
 *    `conversationInputIntent.text` 都必须变成新文本，且只改 status=admitted 的行。
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

test("5a legacy「intent 事实整体缺失」→ 可执行，附件为空（P1-3：不得造永久死项）", async () => {
  // 生产形状：`TurnSteerQueued` 在 intent 缺失时只写 `{ text }`（events.ts）。
  // 这种行以前被判 `corrupt/attachments_unreadable` → 永久不可提升、auto-drain 停住。
  // 账本与投影都没有附件事实（投影 attachments 也只从 intent.attachmentRefs 来），
  // 所以读成 `[]` 是唯一的答案，不是猜测。
  insertInput({
    id: "input-legacy-no-intent",
    behavior: { payload: JSON.stringify({ text: "legacy 文本" }) },
  });
  const legacy = await store.getSessionInputForExecution({
    id: "input-legacy-no-intent",
    sessionID: SESSION_ID,
  });
  assert.equal(legacy.state, "pending", "legacy 形状必须可执行，不得造永久死项");
  assert.equal(legacy.text, "legacy 文本");
  assert.deepEqual(legacy.attachments, [], "账本没有附件事实时按无附件读");
});

test("5b intent 事实在、附件字段读不出 → 仍是 corrupt（真损坏不许兜成空）", async () => {
  // 反向守卫：只要行里存在 intent 事实（新写者），`conversationInputIntent` 缺失就是
  // 「字段在、读不出」——这一态必须继续硬失败，否则「读不出 ≠ 没有附件」的规则被放宽。
  insertInput({
    id: "input-intent-without-projection",
    behavior: {
      payload: JSON.stringify({ text: "文本", intent: { kind: "sendText", queueItemId: "qi" } }),
    },
  });
  const damaged = await store.getSessionInputForExecution({
    id: "input-intent-without-projection",
    sessionID: SESSION_ID,
  });
  assert.equal(damaged.state, "corrupt");
  assert.equal(damaged.reason, "attachments_unreadable");

  // 数组里混了坏项 → 整体不可信（过滤坏项 = 静默丢附件）
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

test("9 I2 判据的写侧单点（① admitted）：settle 不得改写已终态行", async () => {
  // rewind 级联的候选来自**事件投影**（`pendingSteerInputs`），那条投影不携带账本状态，
  // 所以判据三条里的 ①`status=admitted` 只能由这条 WHERE 子句保证（spec 变更点 7/19）。
  // 一旦条件被去掉：`promoted`（已起跑）会被记成 `discarded`，诊断面看到的是
  // 「这条输入是回退作废的」，而真实事故形态是「它已经在跑了」——两种状态混为一谈。
  const statusOf = (id) =>
    raw.prepare("select status from session_input where id = ?").get(id).status;
  const reasonOf = (id) =>
    raw.prepare("select status_reason from session_input where id = ?").get(id).status_reason;

  // 正向：admitted 行照常收口（两个方向都要，否则「一律不改」也能绿）。
  insertInput({ id: "input-settle-admitted", behavior: { payload: payloadOf() } });
  await store.settleSessionInput({
    id: "input-settle-admitted",
    reason: "rewound",
    sessionID: SESSION_ID,
    status: "discarded",
  });
  assert.equal(statusOf("input-settle-admitted"), "discarded");
  assert.equal(reasonOf("input-settle-admitted"), "rewound");

  // 反向：已 promoted 的行不得被回退成 discarded（迟到的级联/事件汇都不许改写终态）。
  insertInput({ id: "input-settle-promoted", status: "promoted" });
  await store.settleSessionInput({
    id: "input-settle-promoted",
    reason: "rewound",
    sessionID: SESSION_ID,
    status: "discarded",
  });
  assert.equal(statusOf("input-settle-promoted"), "promoted", "已起跑的输入不得被记成作废");
  assert.equal(reasonOf("input-settle-promoted"), null, "终态行连 reason 都不许被补写");

  // 反向：更早的用户取消同样是终态，不能被级联覆盖成 rewound。
  insertInput({ id: "input-settle-cancelled", status: "cancelled", statusReason: "user_removed" });
  await store.settleSessionInput({
    id: "input-settle-cancelled",
    reason: "rewound",
    sessionID: SESSION_ID,
    status: "discarded",
  });
  assert.equal(statusOf("input-settle-cancelled"), "cancelled");
  assert.equal(reasonOf("input-settle-cancelled"), "user_removed");
});

test("10 promote 事务的 shared-context 收口：reserved → attached，缺项/已失效连带回滚", async () => {
  // 这条路径过去零覆盖（本轮变异探测暴露的基线缺口）：「promote 事务里 status: "attached"
  // 改成 "reserved"，三套 authority 测试全绿」。原因是全仓没有任何用例构造过
  // `v4/shared_context_import` 条目 —— 收口结果只写 session_entry.data 与上下文消息的
  // metadata，没有任何其他套件会读这两处。
  //
  // 生产顺序（`v4-bridge.ts` + `commitSharedContextImportBundle`）：
  // 导入时落「上下文消息 + v4/shared_context_import 条目(pending)」→ admission 把条目
  // pending→reserved（delivery != startNow）→ promote 在同一事务里收口成 attached。
  const CONTEXT_ID = "ctx-shared-1";
  const GHOST_CONTEXT_ID = "ctx-shared-ghost";
  const CONTEXT_MESSAGE_ID = "msg-shared-context";
  const ENTRY_ID = `v4_shared_context_import:${SESSION_ID}:${CONTEXT_ID}`;
  const sharedRef = { kind: "shared_context_import", context_id: CONTEXT_ID };
  const messageCount = (id) =>
    raw.prepare("select count(*) as n from message where id = ?").get(id).n;
  const entryData = () =>
    JSON.parse(raw.prepare("select data from session_entry where id = ?").get(ENTRY_ID).data);
  const contextMetadata = () =>
    JSON.parse(raw.prepare("select data from message where id = ?").get(CONTEXT_MESSAGE_ID).data)
      .metadata;
  const promotedMessage = (id, refs) => ({
    id,
    sessionID: SESSION_ID,
    role: "user",
    metadata: refs ? { inputIntent: { sharedContextRefs: refs } } : {},
    time: { created: Date.now() },
  });
  const partsOf = (messageId) => [
    {
      id: `${messageId}-part`,
      sessionID: SESSION_ID,
      messageID: messageId,
      type: "text",
      text: "内容",
      time: { start: Date.now(), end: Date.now() },
    },
  ];
  const setEntryStatus = async (status) =>
    store.saveSessionEntry({
      id: ENTRY_ID,
      sessionID: SESSION_ID,
      type: "v4/shared_context_import",
      data: { contextId: CONTEXT_ID, shareUrl: "https://share.example/ctx", status },
      time: { created: Date.now(), updated: Date.now() },
    });

  await store.saveMessage({
    id: CONTEXT_MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "user",
    source: "shared_context",
    visibility: "model-only",
    metadata: { contextId: CONTEXT_ID, sharedContextStatus: "reserved" },
    time: { created: Date.now() },
  });
  await setEntryStatus("reserved");

  // 10a 正向：reserved 条目随 promote 一起收口成 attached。
  insertInput({ id: "input-shared-context" });
  await store.promoteSessionInput({
    id: "input-shared-context",
    sessionID: SESSION_ID,
    message: promotedMessage("msg-shared-promote", [sharedRef]),
    parts: partsOf("msg-shared-promote"),
  });
  const attached = entryData();
  assert.equal(
    attached.status,
    "attached",
    "promote 提交即收口：这条导入已经随 user message 进入 transcript，不能停在 reserved",
  );
  assert.equal(
    attached.attachedMessageId,
    "msg-shared-promote",
    "必须记住挂在哪条消息上（解绑与展示都只认这个字段）",
  );
  assert.equal(attached.contextId, CONTEXT_ID, "收口是改写条目，不许把它的身份键抹掉");
  const context = contextMetadata();
  assert.equal(
    context.sharedContextStatus,
    "attached",
    "上下文消息自身的状态位必须同步（UI 的「已附加」读的是这条 metadata）",
  );
  assert.equal(context.contextId, CONTEXT_ID, "重写 metadata 不得抹掉 contextId（否则后续再也找不到它）");

  // 10b 已失效的条目不得被 promote 复活：整笔事务回滚，user message/parts 不落盘。
  await setEntryStatus("discarded");
  insertInput({ id: "input-shared-stale" });
  await assert.rejects(
    () =>
      store.promoteSessionInput({
        id: "input-shared-stale",
        sessionID: SESSION_ID,
        message: promotedMessage("msg-shared-stale", [sharedRef]),
        parts: partsOf("msg-shared-stale"),
      }),
    /no longer attachable/u,
    "已 discarded 的导入不得被提升「顺手复活」",
  );
  assert.equal(messageCount("msg-shared-stale"), 0, "shared-context 抛错必须连带回滚 user message");
  assert.equal(entryData().status, "discarded", "失败的 promote 不得改写条目状态");

  // 10c 引用还在、条目不在（缺项）：同样硬失败并回滚，不许静默跳过附带。
  insertInput({ id: "input-shared-orphan" });
  await assert.rejects(
    () =>
      store.promoteSessionInput({
        id: "input-shared-orphan",
        sessionID: SESSION_ID,
        message: promotedMessage("msg-shared-orphan", [
          { kind: "shared_context_import", context_id: GHOST_CONTEXT_ID },
        ]),
        parts: partsOf("msg-shared-orphan"),
      }),
    /is missing/u,
    "缺项的导入必须硬失败：静默跳过等于让用户以为上下文已带上",
  );
  assert.equal(messageCount("msg-shared-orphan"), 0, "缺项同样要回滚 user message");

  // 10d 非导入引用 / 缺 context_id 的引用不触发收口（它们不是 shared_context_import）。
  insertInput({ id: "input-shared-noop" });
  await store.promoteSessionInput({
    id: "input-shared-noop",
    sessionID: SESSION_ID,
    message: promotedMessage("msg-shared-noop", [
      { kind: "attachment", context_id: CONTEXT_ID },
      { kind: "shared_context_import" },
    ]),
    parts: partsOf("msg-shared-noop"),
  });
  assert.equal(
    entryData().status,
    "discarded",
    "非导入引用（kind 不符 / 缺 context_id）不得改写导入条目、更不得让 promote 失败",
  );
});

test("11 updateSessionInputs：queue edit 必须改写 durable payload.text（重启后不得恢复旧文本）", async () => {
  // queue edit 的落库链路是 handler → core `editPendingInputById` → `persistSessionInputUpdates`
  // → 本仓库的 `updateSessionInputs`。写入侧过去零覆盖：本轮变异探测把
  // 「payload.text 那行关掉」时四个套件全绿。这里直接对真实库读回 durable 结果。
  const OLD_TEXT = "编辑前的旧文本";
  const NEW_TEXT = "编辑后的新文本";
  const payloadOfRow = (id) =>
    JSON.parse(raw.prepare("select payload from session_input where id = ?").get(id).payload);

  insertInput({ id: "input-edited", behavior: { payload: payloadOf({ text: OLD_TEXT }) } });
  await store.updateSessionInputs({
    sessionID: SESSION_ID,
    updates: [{ id: "input-edited", text: NEW_TEXT }],
  });
  const edited = payloadOfRow("input-edited");
  assert.equal(edited.text, NEW_TEXT, "重启后重建的队列项文本只能来自 payload.text（旧文本会再次被执行）");
  assert.equal(
    edited.conversationInputIntent.text,
    NEW_TEXT,
    "投影/恢复侧读的是 conversationInputIntent.text，两处必须同时改写",
  );

  // 只改 admitted 行：已 settled 的输入是执行历史，queue edit 不得回写它。
  insertInput({
    id: "input-edit-settled",
    behavior: { payload: payloadOf({ text: OLD_TEXT }) },
  });
  await store.settleSessionInput({
    id: "input-edit-settled",
    sessionID: SESSION_ID,
    status: "discarded",
    reason: "rewound",
  });
  await store.updateSessionInputs({
    sessionID: SESSION_ID,
    updates: [{ id: "input-edit-settled", text: NEW_TEXT }],
  });
  assert.equal(
    payloadOfRow("input-edit-settled").text,
    OLD_TEXT,
    "终态行的 payload 不得被编辑改写（它已经不是待执行输入）",
  );
});
