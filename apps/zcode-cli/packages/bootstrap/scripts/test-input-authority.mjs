#!/usr/bin/env node
/**
 * I3 输入解析唯一入口——`resolveCanonicalInput` 的仓内等价断言 + T-IA4 源码形状守卫。
 *
 * ============================================================================
 * 为什么要有这个文件
 * ============================================================================
 *
 * spec `docs/iterations/bugfix-batch-20261025/bugs/edit-resend-stale-text` 变更点 2 把
 * 「一条 command 的 text / intent / attachments / delivery 由谁解析」收敛到
 * `commands/input-intent.ts` 的 `resolveCanonicalInput`。收敛前 admission
 * （`v4-bridge.ts` 写 session_input 账本）与执行（`fork-edit-retry.ts` 起轮）各写一套
 * 继承规则，「两边结果一致」只靠人工对齐、零断言守护——这正是 `intent.text` 类缺陷
 * 反复回归的结构性原因。
 *
 * 此前唯一的零漂移证据是上一波 impl 放在 %TEMP% 的临时对标脚本（27 组指令 × 6 种
 * routingMode、169 项断言，未入库）。临时脚本删掉 = 证据消失，所以这里把**同一份
 * 等价断言**落进仓内：全部用例直接驱动真实实现，不做任何桩替换。
 *
 * ============================================================================
 * 用例分区（名字即不变式）
 * ============================================================================
 *
 * A. 六个分支的 text 取值：createSession / createSelectionSideSession / sendText /
 *    sendGoalCommand / editUserQuery / retryTurn。其中：
 *    - editUserQuery 的 text **只能**来自 `payload.newText`（T-IA4 对应缺陷：
 *      曾被写成 `newText ?? record.text`，编辑后仍重发旧文本）；
 *    - retryTurn 忽略 `newText`（即便 payload 里混进该键），只重发 `record.text`。
 * B. attachments：payload 显式优先（含显式 `[]` = 清空）、缺省继承原轮、
 *    **无 ref 的附件不重发**、`sourceKind` 等预览授权字段原样保留。
 * C. delivery：requested / admitted / fallbackReasonCode 的继承与缺省
 *    （本函数不造缺省值，缺省键留给 admission 按活投影推导）。
 * D. provenance 折叠：`record.provenance ?? {sourceCommandId, queueItemId?, clientId?}`。
 * E. sharedContextRefs：payload 显式携带才透传，且不与其它分支混用。
 * F. 非六类命令 → `null`（不产生用户输入）。
 * G. modelSelection / modelSelectionPinned 三态：explicit > live > 继承快照，
 *    pin 只认 explicit；admission 不传事实时与收敛前逐字一致（不落 pin 键）。
 * H. 等价性（T-IA3 的仓内替身）：admission 侧（无选择事实）与执行侧（带选择事实）
 *    对同一 payload 产出完全相同的 text / attachments / delivery / 非模型 intent。
 * I. T-IA4 源码形状守卫：兜底不许搬家复活。
 *
 * 运行方式：`pnpm --dir apps/zcode-cli/packages/bootstrap run test:input-authority`
 * （= `tsx --test scripts/test-input-authority.mjs`；tsx 直接吃 src，免去先 build）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");
const inputIntentPath = join(srcRoot, "zcode-protocol-v4", "commands", "input-intent.ts");
const bridgePath = join(srcRoot, "zcode-protocol", "v4-bridge.ts");

// fork-edit-retry ⇄ input-intent ⇄ executor ⇄ handlers/index 之间存在循环依赖；
// 与 test-edit-retry-model 同源：先以 executor 为入口初始化（commandAdmissionOf 是
// 函数声明、提升后可用），再取 input-intent 的导出才不会在重导出上命中 TDZ。
await import(pathToFileURL(join(srcRoot, "zcode-protocol-v4", "commands", "executor.ts")).href);
const { resolveCanonicalInput } = await import(pathToFileURL(inputIntentPath).href);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — I3 canonical input authority (resolveCanonicalInput)"
      : `TEST FAIL — I3 canonical input authority (exit code ${code})`,
  );
});

// ── 公共夹具 ────────────────────────────────────────────────────────────────

const SESSION_ID = "ses_input_authority";

/** 被编辑轮的旧文本：任何 edit 用例都不允许把它当成结果。 */
const RECORD_TEXT = "被编辑轮的旧文本（不得重发）";
const EDITED_TEXT = "编辑后的新文本";
const STRAY_NEW_TEXT = "payload 里混进来的 newText（retry 必须忽略）";

const EXPLICIT_SELECTION = Object.freeze({
  providerId: "anthropic",
  modelId: "claude-sonnet-5",
  options: Object.freeze({ reasoningLevel: "high" }),
});
const LIVE_SELECTION = Object.freeze({
  providerId: "google",
  modelId: "gemini-3-pro",
  options: Object.freeze({ reasoningLevel: "medium" }),
});
const SNAPSHOT_SELECTION = Object.freeze({
  providerId: "openai",
  modelId: "gpt-5",
  options: Object.freeze({ reasoningLevel: "medium" }),
});

const PAYLOAD_ATTACHMENT = Object.freeze({
  ref: "att-payload-1",
  fileName: "payload.txt",
  mime: "text/plain",
  bytes: 21,
});
/** 有 ref = 已提交内容，可重发；sourceKind/previewRef 是预览授权依据，必须原样带过去。 */
const INHERITED_ATTACHMENT = Object.freeze({
  ref: "att-inherit-1",
  fileName: "paste.txt",
  mime: "text/plain",
  bytes: 120,
  sourceKind: "clipboard-text",
  previewRef: "preview-inherit-1",
});
/** 无 ref = 没有已提交内容，不能重发（重发会变成一条指向空内容的附件）。 */
const INHERITED_ATTACHMENT_WITHOUT_REF = Object.freeze({
  fileName: "never-committed.txt",
  mime: "text/plain",
  bytes: 7,
});

const RECORD = Object.freeze({
  kind: "sendText",
  text: RECORD_TEXT,
  sourceCommandId: "cmd-original",
  clientId: "ui",
  queueItemId: "queue-original",
  requestedDelivery: "startNow",
  admittedDelivery: "startNow",
  modelSelection: SNAPSHOT_SELECTION,
  attachments: Object.freeze([INHERITED_ATTACHMENT, INHERITED_ATTACHMENT_WITHOUT_REF]),
});

/** 只有投递事实、没有归因字段的继承源（provenance 折叠的另一半）。 */
const RECORD_WITHOUT_PROVENANCE = Object.freeze({
  kind: "sendGoalCommand",
  text: RECORD_TEXT,
  sourceCommandId: "cmd-original-2",
  clientId: "desktop",
  queueItemId: "queue-original-2",
});

function envelopeOf(type, payload) {
  return {
    commandId: "cmd-authority-1",
    clientId: "ui",
    sessionId: SESSION_ID,
    baseRevision: 3,
    baseLogEpoch: "epoch-input-authority",
    type,
    payload,
  };
}

function keysOf(object) {
  return Object.keys(object).sort();
}

/** 断言键真的缺省（不是值为 undefined 的「伪缺省」）。 */
function assertAbsent(object, key, message) {
  assert.equal(key in object, false, message ?? `不得携带 ${key} 键`);
}

// ── A: 六个分支的 text 取值 ─────────────────────────────────────────────────

test("A1 createSession：text 取 payload.firstInput.text，kind=sendText，delivery 不造缺省", () => {
  const payload = {
    workspaceId: "ws-input-authority",
    firstInput: { text: "首条输入", attachments: [PAYLOAD_ATTACHMENT] },
  };
  const resolved = resolveCanonicalInput(null, payload, envelopeOf("createSession", payload));
  assert.ok(resolved, "createSession 带 firstInput 必须产生输入");
  assert.equal(resolved.text, "首条输入");
  // I3：text 只有一个来源，intent.text 必须与顶层 text 逐字相同。
  assert.equal(resolved.intent.text, resolved.text);
  assert.equal(resolved.intent.kind, "sendText");
  // 缺省键留给 admission（它按活投影推导 requested/admitted），本函数不发明默认值。
  assert.deepEqual(resolved.delivery, {});
  assertAbsent(resolved.intent, "provenance", "首条输入没有原轮可归因，不得伪造 provenance");
});

test("A2 createSession：缺 firstInput → null（不产生用户输入）", () => {
  const payload = { workspaceId: "ws-input-authority" };
  assert.equal(resolveCanonicalInput(null, payload, envelopeOf("createSession", payload)), null);
});

test("A3 createSelectionSideSession：text 取 firstInput.text，且首条输入永不携带附件", () => {
  const payload = {
    workspaceId: "ws-input-authority",
    firstInput: { text: "副屏选区提问", attachments: [PAYLOAD_ATTACHMENT] },
  };
  const resolved = resolveCanonicalInput(
    null,
    payload,
    envelopeOf("createSelectionSideSession", payload),
  );
  assert.ok(resolved, "带 firstInput 必须产生输入");
  assert.equal(resolved.text, "副屏选区提问");
  assert.equal(resolved.intent.text, resolved.text);
  // 副屏是一次性选区问答，装不了附件；payload 里就算带了也不能透传。
  assert.deepEqual(resolved.attachments, []);
  assert.deepEqual(resolved.intent.attachmentRefs, []);
});

test("A4 sendText：text 取 payload.text，附件引用零拷贝透传", () => {
  const payload = { text: "普通发送", attachments: [PAYLOAD_ATTACHMENT] };
  const resolved = resolveCanonicalInput(null, payload, envelopeOf("sendText", payload));
  assert.ok(resolved, "sendText 必须产生输入");
  assert.equal(resolved.text, "普通发送");
  assert.equal(resolved.intent.kind, "sendText");
  // 附件数组原样透传（不重排、不重建），避免下游拿到与 payload 不同的事实。
  assert.equal(resolved.attachments, payload.attachments);
  assert.equal(resolved.intent.attachmentRefs, resolved.attachments);
});

test("A5 sendGoalCommand：text 取 payload.text（displayText 不可替换 canonical 文本）", () => {
  const payload = { text: "/goal 修复输入权威", displayText: "/GoAl 修复输入权威" };
  const resolved = resolveCanonicalInput(null, payload, envelopeOf("sendGoalCommand", payload));
  assert.ok(resolved, "sendGoalCommand 必须产生输入");
  assert.equal(resolved.text, "/goal 修复输入权威");
  assert.equal(resolved.intent.kind, "sendGoalCommand");
});

test("A6 editUserQuery：text 只取 payload.newText，绝不回退 record.text", () => {
  const payload = {
    target: { rowId: 4, entityId: "ent-4" },
    newText: EDITED_TEXT,
  };
  const resolved = resolveCanonicalInput(RECORD, payload, envelopeOf("editUserQuery", payload));
  assert.ok(resolved, "editUserQuery 必须产生输入");
  assert.equal(resolved.text, EDITED_TEXT);
  assert.equal(resolved.intent.text, EDITED_TEXT);
  assert.notEqual(resolved.text, RECORD_TEXT, "编辑后重发旧文本 = 「编辑无效」缺陷复活");
  // 继承的是归因/投递事实，不是文本。
  assert.equal(resolved.intent.kind, RECORD.kind);
});

test("A7 retryTurn：忽略 payload 里混进的 newText，固定重发 record.text", () => {
  const payload = {
    target: { rowId: 4, entityId: "ent-4" },
    newText: STRAY_NEW_TEXT,
  };
  const resolved = resolveCanonicalInput(RECORD, payload, envelopeOf("retryTurn", payload));
  assert.ok(resolved, "retryTurn 必须产生输入");
  assert.equal(resolved.text, RECORD_TEXT);
  assert.equal(resolved.intent.text, RECORD_TEXT);
  assert.notEqual(resolved.text, STRAY_NEW_TEXT, "retry 的语义是重发原文，不得吃 payload 文本");
});

test("A8 editUserQuery / retryTurn：无 record → null（必须先解析出 canonical 继承源）", () => {
  const editPayload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  assert.equal(
    resolveCanonicalInput(null, editPayload, envelopeOf("editUserQuery", editPayload)),
    null,
  );
  const retryPayload = { target: { rowId: 4, entityId: "ent-4" } };
  assert.equal(
    resolveCanonicalInput(undefined, retryPayload, envelopeOf("retryTurn", retryPayload)),
    null,
  );
});

// ── B: attachments ─────────────────────────────────────────────────────────

test("B1 editUserQuery：payload 显式 attachments 优先（含显式 [] 清空继承）", () => {
  const explicit = { ...PAYLOAD_ATTACHMENT, ref: "att-edit-1" };
  const withAttachments = {
    target: { rowId: 4, entityId: "ent-4" },
    newText: EDITED_TEXT,
    attachments: [explicit],
  };
  const resolved = resolveCanonicalInput(
    RECORD,
    withAttachments,
    envelopeOf("editUserQuery", withAttachments),
  );
  assert.deepEqual(resolved.attachments, [explicit]);
  assert.equal(resolved.intent.attachmentRefs, resolved.attachments);

  // 显式 [] 是「用户删掉了原轮所有附件」，不能当成缺省再继承回来。
  const cleared = {
    target: { rowId: 4, entityId: "ent-4" },
    newText: EDITED_TEXT,
    attachments: [],
  };
  const clearedResult = resolveCanonicalInput(
    RECORD,
    cleared,
    envelopeOf("editUserQuery", cleared),
  );
  assert.deepEqual(clearedResult.attachments, [], "显式 [] 必须清空继承的附件");
});

test("B2 editUserQuery：缺省 attachments 才继承原轮，且无 ref 的附件不重发", () => {
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(RECORD, payload, envelopeOf("editUserQuery", payload));
  assert.deepEqual(resolved.attachments, [INHERITED_ATTACHMENT]);
  assert.equal(resolved.attachments.length, 1, "无 ref 的附件没有已提交内容，不得重发");
});

test("B3 附件继承保留 sourceKind / previewRef（逐字段枚举会丢预览授权依据）", () => {
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const [inherited] = resolveCanonicalInput(
    RECORD,
    payload,
    envelopeOf("editUserQuery", payload),
  ).attachments;
  assert.equal(inherited.sourceKind, "clipboard-text");
  assert.equal(inherited.previewRef, "preview-inherit-1");
  assert.equal(inherited.ref, "att-inherit-1");
});

test("B4 retryTurn：无视 payload.attachments，固定继承原轮", () => {
  const payload = {
    target: { rowId: 4, entityId: "ent-4" },
    attachments: [{ ...PAYLOAD_ATTACHMENT, ref: "att-retry-should-be-ignored" }],
  };
  const resolved = resolveCanonicalInput(RECORD, payload, envelopeOf("retryTurn", payload));
  assert.deepEqual(resolved.attachments, [INHERITED_ATTACHMENT]);
});

// ── C: delivery ────────────────────────────────────────────────────────────

test("C1 delivery：三键全继承（requested / admitted / fallbackReasonCode）", () => {
  const record = {
    ...RECORD,
    requestedDelivery: "guide",
    admittedDelivery: "queue",
    fallbackReasonCode: "guide.attachmentsUnsupported",
  };
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(record, payload, envelopeOf("editUserQuery", payload));
  assert.deepEqual(resolved.delivery, {
    requested: "guide",
    admitted: "queue",
    fallbackReasonCode: "guide.attachmentsUnsupported",
  });
  // intent 侧也带同一份投递事实（给 inputIntentMetadataFromCanonical 用）。
  assert.equal(resolved.intent.requestedDelivery, "guide");
  assert.equal(resolved.intent.admittedDelivery, "queue");
  assert.equal(resolved.intent.fallbackReasonCode, "guide.attachmentsUnsupported");
});

test("C2 delivery：缺省即缺键——本函数不把 startNow/queue 之类默认值发明出来", () => {
  const record = { kind: "sendText", text: RECORD_TEXT };
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(record, payload, envelopeOf("editUserQuery", payload));
  assert.deepEqual(resolved.delivery, {});
  assertAbsent(resolved.intent, "requestedDelivery");
  assertAbsent(resolved.intent, "admittedDelivery");
  assertAbsent(resolved.intent, "fallbackReasonCode");
});

test("C3 delivery：只继承存在的键，partial record 不补齐兄弟键", () => {
  const record = { kind: "sendText", text: RECORD_TEXT, requestedDelivery: "queue" };
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(record, payload, envelopeOf("editUserQuery", payload));
  assert.deepEqual(keysOf(resolved.delivery), ["requested"]);
});

// ── D: provenance 折叠 ─────────────────────────────────────────────────────

test("D1 provenance：record 自带 provenance 时原样继承（含原始 queueItemId/clientId）", () => {
  const originalProvenance = {
    sourceCommandId: "cmd-real-origin",
    queueItemId: "queue-real-origin",
    clientId: "ui",
  };
  const record = { ...RECORD, provenance: originalProvenance };
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(record, payload, envelopeOf("editUserQuery", payload));
  assert.deepEqual(resolved.intent.provenance, originalProvenance);
  // 归因指向真正产生输入的原始命令，而不是本次 edit 的 commandId。
  assert.notEqual(resolved.intent.provenance.sourceCommandId, "cmd-authority-1");
});

test("D2 provenance：无 provenance 时由 sourceCommandId 折叠，queueItemId/clientId 可选", () => {
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(
    RECORD_WITHOUT_PROVENANCE,
    payload,
    envelopeOf("editUserQuery", payload),
  );
  assert.deepEqual(resolved.intent.provenance, {
    sourceCommandId: "cmd-original-2",
    queueItemId: "queue-original-2",
    clientId: "desktop",
  });

  // 只有 sourceCommandId 时不补空的可选键。
  const minimalRecord = { kind: "sendText", text: RECORD_TEXT, sourceCommandId: "cmd-only" };
  const minimal = resolveCanonicalInput(
    minimalRecord,
    payload,
    envelopeOf("editUserQuery", payload),
  );
  assert.deepEqual(minimal.intent.provenance, { sourceCommandId: "cmd-only" });
});

test("D3 provenance：既无 provenance 又无 sourceCommandId → 不产生该键", () => {
  const record = { kind: "sendText", text: RECORD_TEXT, clientId: "ui" };
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(record, payload, envelopeOf("editUserQuery", payload));
  assertAbsent(resolved.intent, "provenance");
});

// ── E: sharedContextRefs ───────────────────────────────────────────────────

test("E1 sharedContextRefs：payload.context_refs 显式携带才透传（数组拷贝）", () => {
  const contextRefs = [{ kind: "shared_context_import", context_id: "ctx-1" }];
  const payload = { text: "带共享上下文", context_refs: contextRefs };
  const resolved = resolveCanonicalInput(null, payload, envelopeOf("sendText", payload));
  assert.deepEqual(resolved.intent.sharedContextRefs, contextRefs);
  assert.notEqual(
    resolved.intent.sharedContextRefs,
    contextRefs,
    "必须拷贝，不得把 payload 数组交出去",
  );
});

test("E2 sharedContextRefs：缺省 → 不产生该键（edit/retry 不 invent 上下文引用）", () => {
  const sendPayload = { text: "无共享上下文" };
  const sent = resolveCanonicalInput(null, sendPayload, envelopeOf("sendText", sendPayload));
  assertAbsent(sent.intent, "sharedContextRefs");

  const editPayload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const edited = resolveCanonicalInput(
    RECORD,
    editPayload,
    envelopeOf("editUserQuery", editPayload),
  );
  assertAbsent(edited.intent, "sharedContextRefs");
});

// ── F: 非六类命令 ──────────────────────────────────────────────────────────

test("F1 非六类命令一律 null（stop / forkAssistant / deleteQueueItem / setAutoDrain）", () => {
  for (const [type, payload] of [
    ["stop", {}],
    ["forkAssistant", { target: { rowId: 4, entityId: "ent-4" } }],
    ["deleteQueueItem", { queueItemId: "queue-1" }],
    ["setAutoDrain", { autoDrain: true }],
  ]) {
    assert.equal(resolveCanonicalInput(null, payload, envelopeOf(type, payload)), null, type);
  }
});

// ── G: modelSelection / modelSelectionPinned 三态 ──────────────────────────

test("G1 只有 explicit（payload 显式选择）→ 用它且 pin=true（唯一写回门开关）", () => {
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(RECORD, payload, envelopeOf("editUserQuery", payload), {
    explicit: EXPLICIT_SELECTION,
  });
  assert.deepEqual(resolved.intent.modelSelection, EXPLICIT_SELECTION);
  assert.equal(resolved.intent.modelSelectionPinned, true);
});

test("G2 只有 live（运行态会话活值）→ 用活值，pin 缺省（继承选择不得写回）", () => {
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(RECORD, payload, envelopeOf("editUserQuery", payload), {
    live: LIVE_SELECTION,
  });
  assert.deepEqual(resolved.intent.modelSelection, LIVE_SELECTION);
  assertAbsent(
    resolved.intent,
    "modelSelectionPinned",
    "活值是继承事实，pin 缺省 = runtime 不写回会话选择",
  );
});

test("G3 事实都缺省（admission 现状）→ 继承 record.modelSelection，且不落 pin 键", () => {
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(RECORD, payload, envelopeOf("editUserQuery", payload));
  assert.deepEqual(resolved.intent.modelSelection, SNAPSHOT_SELECTION);
  assertAbsent(resolved.intent, "modelSelectionPinned", "admission 不传事实时行为必须与收敛前一致");
});

test("G4 explicit 与 live 同时存在 → explicit 胜出且 pin=true（优先级只在函数内）", () => {
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(RECORD, payload, envelopeOf("editUserQuery", payload), {
    explicit: EXPLICIT_SELECTION,
    live: LIVE_SELECTION,
  });
  assert.deepEqual(resolved.intent.modelSelection, EXPLICIT_SELECTION);
  assert.equal(resolved.intent.modelSelectionPinned, true);
});

test("G5 无显式事实时继承 record.modelSelectionPinned（pin 事实不因传 live 被抹掉）", () => {
  const record = { ...RECORD, modelSelectionPinned: true };
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(record, payload, envelopeOf("editUserQuery", payload), {
    live: LIVE_SELECTION,
  });
  assert.deepEqual(resolved.intent.modelSelection, LIVE_SELECTION);
  assert.equal(resolved.intent.modelSelectionPinned, true);
});

test("G6 非 edit 分支同样接受选择事实（sendText 显式选择 → intent 携带且 pin）", () => {
  const payload = { text: "带模型选择发送" };
  const resolved = resolveCanonicalInput(null, payload, envelopeOf("sendText", payload), {
    explicit: EXPLICIT_SELECTION,
  });
  assert.deepEqual(resolved.intent.modelSelection, EXPLICIT_SELECTION);
  assert.equal(resolved.intent.modelSelectionPinned, true);

  const inherited = resolveCanonicalInput(null, payload, envelopeOf("sendText", payload), {
    live: LIVE_SELECTION,
  });
  assert.deepEqual(inherited.intent.modelSelection, LIVE_SELECTION);
  assertAbsent(inherited.intent, "modelSelectionPinned");
});

// ── H: admission / 执行两侧等价（T-IA3 仓内替身）────────────────────────────

test("H1 同一 payload：admission（无事实）与执行（带事实）产出的文本/附件/投递逐字相同", () => {
  const cases = [
    {
      record: RECORD,
      envelope: () => {
        const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
        return envelopeOf("editUserQuery", payload);
      },
    },
    {
      record: RECORD,
      envelope: () => {
        const payload = { target: { rowId: 4, entityId: "ent-4" } };
        return envelopeOf("retryTurn", payload);
      },
    },
    {
      record: RECORD,
      envelope: () => {
        const payload = { text: "普通发送", attachments: [PAYLOAD_ATTACHMENT] };
        return envelopeOf("sendText", payload);
      },
    },
    {
      record: null,
      envelope: () => {
        const payload = { text: "/goal 目标", displayText: "/GoAl 目标" };
        return envelopeOf("sendGoalCommand", payload);
      },
    },
  ];

  for (const { record, envelope } of cases) {
    const admissionSide = resolveCanonicalInput(record, envelope().payload, envelope());
    const executionSide = resolveCanonicalInput(record, envelope().payload, envelope(), {
      explicit: EXPLICIT_SELECTION,
      live: LIVE_SELECTION,
    });
    assert.ok(admissionSide && executionSide);
    // text / attachments / delivery 是「唯一解析」的全部内容，必须逐字相同。
    assert.equal(executionSide.text, admissionSide.text);
    assert.deepEqual(executionSide.attachments, admissionSide.attachments);
    assert.deepEqual(executionSide.delivery, admissionSide.delivery);
    // intent 除模型选择字段外也必须相同（模型事实是调用方补的输入，不是解析差异）。
    const stripSelection = (intent) => {
      const { modelSelection, modelSelectionPinned, ...rest } = intent;
      return rest;
    };
    assert.deepEqual(stripSelection(executionSide.intent), stripSelection(admissionSide.intent));
  }
});

// ── I: T-IA4 源码形状守卫 ──────────────────────────────────────────────────

/** 去掉注释，让静态守卫只面对真实代码（否则解释性注释会误报）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

/** 只报模式与失败原因，不把整份源码倒进 TAP 输出。 */
function assertNoPattern(code, pattern, message) {
  assert.equal(pattern.test(code), false, `${message}（命中模式 ${pattern}）`);
}

function assertPattern(code, pattern, message) {
  assert.equal(pattern.test(code), true, `${message}（未命中模式 ${pattern}）`);
}

test("I1 T-IA4：input-intent.ts 的 edit 分支不得复活 `newText ?? record.text` 兜底", () => {
  const code = stripComments(readFileSync(inputIntentPath, "utf8"));
  // 这个兜底曾经住在 v4-bridge.ts:366-369（`payload.newText ?? canonical.intent.text`），
  // 收敛到共享函数时被「原样搬家」到 input-intent.ts:208（`newText ?? record.text`）——
  // 锚点留在 v4-bridge 的旧断言因此假绿，同一反模式在另一个文件里存活。守卫钉在这里。
  assertNoPattern(
    code,
    /\?\?\s*(?:editPayload|payload)\.newText/u,
    "edit 分支不得为 newText 设置兜底：schema 里 newText 必填（command.ts editUserQuery）",
  );
  assertNoPattern(
    code,
    /\?\?\s*record\??\.(?:text|intent\.text)/u,
    "edit 分支不得回退 record.text（= 编辑后重发旧文本）",
  );
  // 正向：edit 用 newText、retry 用 record.text，两分支都只认一个来源。
  assertPattern(
    code,
    /envelope\.type === "editUserQuery"\s*\?\s*editPayload\.newText\s*:\s*record\.text/u,
    "edit/retry 的 text 必须直接取各自唯一来源（M3 形状）",
  );
});

test("I2 T-IA4：v4-bridge.ts 不得再出现 `?? canonical.intent.text`（旧锚点仍须为绿）", () => {
  const code = stripComments(readFileSync(bridgePath, "utf8"));
  assertNoPattern(code, /\?\?\s*canonical\.intent\.text/u);
  assert.equal(
    code.includes("canonical.intent.text"),
    false,
    "admission 侧不再保留该兜底的任何读法：text 一律来自 resolveCanonicalInput",
  );
  // 同一条 admission 路径上不许再留 `text: input.text ?? ""`：ResolvedCanonicalInput.text
  // 是必填 string，兜底只会把契约破坏藏起来（本波只钉账本写入这一处，见 new_risks）。
  assertNoPattern(code, /\btext:\s*input\.text\s*\?\?/u, "账本 text 不得再套 ?? 兜底");
});
