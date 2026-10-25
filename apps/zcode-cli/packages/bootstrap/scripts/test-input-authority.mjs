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
 * I3. 执行侧（fork-edit-retry）不得再有本地模型优先级链 / 自算 pin——只传事实。
 * I4. 模型优先级链（`??` + 会话活值）只许在 input-intent.ts；其余站点全部在
 *     allowlist 里并注明「待收口」（cr-func N2：不许一轮全清，但也不许再长新的）。
 * I5. `modelSelectionPinned:` 的自算只许在 input-intent.ts；其余同上。
 * I6. retry 分支不得把 payload 整体断言成 edit 形状（`as { newText: string }`）——
 *     旧写法让「retry 偷读 newText」在类型上合法，是兜底搬家的温床。
 * I7. queue.ts 的执行内容（提升轮 content / intent.text）**只能来自 session_input 账本**；
 *     投影项的 `queueItem.text` 仅剩 spec 4b 例外表的三处（goal objective/goal intent.text/
 *     displayText），其余站点即红。
 * L. I1 执行权威（sendQueuedNow 直驱真实 handler）：账本文本 ≠ 投影文本时执行账本文本；
 *    账本终态/缺失/宿主能力缺席一律硬失败，且不起轮、不留 reservation。
 * J. 执行侧重建 intent 的 pin 形状：`resolveCanonicalInput` 保持三态（缺键=无 pin
 *    事实），`inputIntentMetadataFromCanonical` 在 wire 上落实为 boolean。
 * K. retry 的 canonical 解析不得读 `payload.newText`（payload 只有 target）。
 *
 * 运行方式：`pnpm --dir apps/zcode-cli/packages/bootstrap run test:input-authority`
 * （= `tsx --test scripts/test-input-authority.mjs`；tsx 直接吃 src，免去先 build）。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");
const inputIntentPath = join(srcRoot, "zcode-protocol-v4", "commands", "input-intent.ts");
const bridgePath = join(srcRoot, "zcode-protocol", "v4-bridge.ts");
const forkEditRetryPath = join(
  srcRoot,
  "zcode-protocol-v4",
  "commands",
  "handlers",
  "fork-edit-retry.ts",
);
const queueHandlerPath = join(srcRoot, "zcode-protocol-v4", "commands", "handlers", "queue.ts");
const INPUT_INTENT_REL_PATH = "zcode-protocol-v4/commands/input-intent.ts";

// fork-edit-retry ⇄ input-intent ⇄ executor ⇄ handlers/index 之间存在循环依赖；
// 与 test-edit-retry-model 同源：先以 executor 为入口初始化（commandAdmissionOf 是
// 函数声明、提升后可用），再取 input-intent 的导出才不会在重导出上命中 TDZ。
await import(pathToFileURL(join(srcRoot, "zcode-protocol-v4", "commands", "executor.ts")).href);
const { inputIntentMetadataFromCanonical, resolveCanonicalInput } = await import(
  pathToFileURL(inputIntentPath).href
);

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

test("G5 继承源携带 modelSelectionPinned 也不得 pin（继承分支已删：pin 只有 explicit 一种来源）", () => {
  // 投影 `ConversationEditTarget.intent` 今天不含该字段（product-projection.ts 白名单构造）。
  // 这里刻意带一位进去，钉住「即使将来有人把它加进投影白名单，编辑重发也不会凭空 pin」——
  // 旧实现的后半支 `: record.modelSelectionPinned` 正是把这条红线重新接通的入口。
  const record = { ...RECORD, modelSelectionPinned: true };
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const resolved = resolveCanonicalInput(record, payload, envelopeOf("editUserQuery", payload), {
    live: LIVE_SELECTION,
  });
  assert.deepEqual(resolved.intent.modelSelection, LIVE_SELECTION);
  assertAbsent(
    resolved.intent,
    "modelSelectionPinned",
    "继承源不得提供 pin 事实（pin 只认本次 explicit）",
  );
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
  // Step 2 形状变更（cr-func N5）：`retryTurn` 的 payload 只有 target，旧实现用一句
  // `payload as { newText: string }` 给 retry 也伪造了 newText 字段。现在按
  // `envelope.type` 拆两个分支，各自断言自己的 payload 形状（见 I6）。
  assertBranchTextShape(code);
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

// ── I3..I7: 模型选择权威 / 执行侧去重 / queue 执行文本的源码形状守卫 ──────────
//
// 本组守卫钉的是 Step 2（执行侧改调唯一入口）的形状。它们**改前是红的**：
// `fork-edit-retry.ts` 里那句 `explicitModelSelection ?? liveSelection ??
// editTarget.intent.modelSelection` 与 `modelSelectionPinned: explicitModelSelection
// !== undefined` 就是被删掉的重复规则；`input-intent.ts` 里那句
// `payload as { newText: string }` 就是给 retry 伪造的类型。

/** 递归列出 src 下所有 .ts：守卫覆盖整棵执行侧代码树，而不是点名的几个文件。 */
function listSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function relativeSourcePath(filePath) {
  return filePath.slice(srcRoot.length + 1).replace(/\\/gu, "/");
}

/**
 * 行号保持的注释剥离：块注释替换成等量换行、行注释整段删除。
 * allowlist 按「相对路径 + 该行代码」核对，行号漂移不会让条目静默失效。
 */
function stripCommentsKeepLines(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, ""))
    .replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

function codeLinesOf(filePath) {
  return stripCommentsKeepLines(readFileSync(filePath, "utf8")).split(/\r?\n/u);
}

/** 逐行收集真实代码里命中 predicate 的非空行；`only` 可把扫描限定到单个文件。 */
function collectCodeLineMatches(predicate, only) {
  const matches = [];
  const files = only ? [only] : listSourceFiles(srcRoot);
  for (const filePath of files) {
    const file = relativeSourcePath(filePath);
    codeLinesOf(filePath).forEach((line, index) => {
      const code = line.trim();
      if (!code) return;
      if (predicate(code)) matches.push({ code, file, line: index + 1 });
    });
  }
  return matches;
}

/**
 * allowlist 双向核对：
 * - 未登记的新站点 → 红（先按 spec 收口，或在条目里登记并注明排到哪一步）；
 * - 登记但已不存在的条目 → 红（站点已收口/改写，必须删条目，否则守卫变成装饰）。
 * `ownerFile` 是唯一规则的所有者，免检。
 */
function assertSourceAllowlist({ allowlist, label, matches, ownerFile }) {
  const rest = matches.filter((match) => match.file !== ownerFile);
  const allowed = new Set(allowlist.map((entry) => `${entry.file}::${entry.code}`));
  const found = new Set(rest.map((match) => `${match.file}::${match.code}`));
  const unexpected = [...found].filter((key) => !allowed.has(key));
  assert.deepEqual(
    unexpected,
    [],
    `${label}：出现未登记的站点——先按 spec 收口，或在 allowlist 里登记并注明排到哪一步`,
  );
  const stale = [...allowed].filter((key) => !found.has(key));
  assert.deepEqual(
    stale,
    [],
    `${label}：allowlist 条目已过期（该站点已收口/改写），请删除或更新条目`,
  );
}

/** edit / retry 两个分支各自的文本来源（Step 2 的形状）。 */
function assertBranchTextShape(code) {
  for (const [type, sourcePattern, message] of [
    ["editUserQuery", /text:\s*editPayload\.newText/u, "edit 的 text 只能取 payload.newText"],
    ["retryTurn", /text:\s*record\.text/u, "retry 的 text 只能取 record.text"],
  ]) {
    const start = code.indexOf(`if (envelope.type === "${type}")`);
    assert.ok(start >= 0, `${type} 必须是独立分支（按 envelope.type 拆开，各自断言 payload 形状）`);
    const end = code.indexOf("\n  }", start);
    assert.ok(end > start, `${type} 分支必须是独立块`);
    assert.match(code.slice(start, end), sourcePattern, message);
  }
}

test("I3 执行侧（fork-edit-retry）不得再有本地模型优先级链 / 自算 pin：只许传事实", () => {
  const code = stripComments(readFileSync(forkEditRetryPath, "utf8"));
  assertNoPattern(
    code,
    /\?\?\s*liveSelection/u,
    "执行侧不得再拼 `explicit ?? live ?? snapshot`（规则只在 input-intent.ts）",
  );
  assertNoPattern(
    code,
    /\?\?[^\n;]*getSessionModelSelection/u,
    "执行侧不得再用 `?? getSessionModelSelection()` 兜底模型",
  );
  assertNoPattern(
    code,
    /modelSelectionPinned\s*:/u,
    "pin 判据只许在 input-intent.ts；执行侧只提供 explicit / live 事实",
  );
  // 正向：两侧事实必须交给唯一入口（cr-func N1 的验收形态）。
  assertPattern(
    code,
    /explicit:\s*payload\.modelSelection/u,
    "edit 必须把 payload 的显式选择当事实传入",
  );
  assertPattern(
    code,
    /live:\s*record\.app\.runtime\.getSessionModelSelection\(\)/u,
    "必须把会话活值当事实传入",
  );
});

/**
 * cr-func N2 的「待收口」清单：模型选择优先级链（`??` + 会话活值）全仓只剩
 * `input-intent.ts` 一处实现。以下站点今天仍各自串联，**不在 Step 2 范围**
 * （Step 2 只收口 edit/retry 的 canonical 输入解析路径）。收口时删条目，不许扩表。
 */
const MODEL_LIVE_CHAIN_ALLOWLIST = [
  {
    code: "getRuntime().getSessionModelSelection() ?? readConfiguredDefaultModelSelection();",
    file: "app/create-app.ts",
    note: "app 装配期的默认模型解析，不产生输入 intent（待收口）",
  },
  {
    code: "activeSession?.app.runtime.getSessionModelSelection() ??",
    file: "zcode-protocol/automation-port.ts",
    note: "自动化派发取当前会话模型，不产生输入 intent（待收口）",
  },
  {
    code: "options.modelSelection ?? record.app.runtime.getSessionModelSelection(),",
    file: "zcode-protocol/v4-bridge.ts",
    note: "createSelectionSideSession 的 fork 模型解析，不属 edit/retry 输入权威（待收口）",
  },
  {
    code: "record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;",
    file: "zcode-protocol/v4-bridge.ts",
    note: "投影种子 getSessionConfigSeed 的模型展示值（待收口）",
  },
  {
    code: "const selection = record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;",
    file: "zcode-protocol/workspace-model-runtime.ts",
    note: "工作区模型展示面（待收口）",
  },
];

test("I4 模型优先级链（?? + 会话活值）只许在 input-intent.ts：其余站点在 allowlist（待收口）", () => {
  const ownerCode = stripComments(readFileSync(inputIntentPath, "utf8"));
  // 唯一实现必须仍在这里：缺了它，下面的「其余站点为空」就是假绿。
  assertPattern(
    ownerCode,
    /selection\?\.explicit \?\? selection\?\.live \?\? record\?\.modelSelection/u,
    "explicit > live > 继承快照 的唯一实现必须留在 input-intent.ts",
  );
  const matches = collectCodeLineMatches(
    (code) =>
      code.includes("??") &&
      /getSessionModelSelection\(|liveSelection|currentSelection|runtimeSelection/u.test(code),
  );
  assertSourceAllowlist({
    allowlist: MODEL_LIVE_CHAIN_ALLOWLIST,
    label: "模型优先级链",
    matches,
    ownerFile: INPUT_INTENT_REL_PATH,
  });
});

/**
 * `modelSelectionPinned:` 的自算站点（cr-func N2 点名的五处）。它们走的是另一个
 * builder（`inputIntentMetadata`），不在 edit/retry canonical 路径上。
 */
const MODEL_PIN_ALLOWLIST = [
  {
    code: "modelSelectionPinned: payload.modelSelection !== undefined,",
    file: "zcode-protocol-v4/commands/handlers/goal.ts",
    note: "sendGoalCommand 走 inputIntentMetadata（待收口）",
  },
  {
    code: "modelSelectionPinned: false,",
    file: "zcode-protocol-v4/commands/handlers/queue.ts",
    note: "queue 提升语义（活值一律不 pin），不在 canonical 路径（待收口）",
  },
  {
    code: "modelSelectionPinned: payload.modelSelection !== undefined,",
    file: "zcode-protocol-v4/commands/handlers/session-flow.ts",
    note: "sendText 走 inputIntentMetadata（待收口）",
  },
  {
    code: "modelSelectionPinned: payload.firstInput.modelSelection !== undefined,",
    file: "zcode-protocol-v4/commands/handlers/session-mgmt.ts",
    note: "createSession 走 inputIntentMetadata（待收口）",
  },
  {
    code: "modelSelectionPinned: true,",
    file: "zcode-protocol/server-operations.ts",
    note: "legacy session/send 分支（进入条件即显式 modelSelection）（待收口）",
  },
];

test("I5 `modelSelectionPinned:` 的自算只许在 input-intent.ts：其余站点在 allowlist（待收口）", () => {
  const ownerCode = stripComments(readFileSync(inputIntentPath, "utf8"));
  assertPattern(ownerCode, /modelSelectionPinned/u, "pin 键必须仍由 input-intent.ts 产出");
  const matches = collectCodeLineMatches((code) => /modelSelectionPinned\s*:/u.test(code));
  assertSourceAllowlist({
    allowlist: MODEL_PIN_ALLOWLIST,
    label: "自算 modelSelectionPinned",
    matches,
    ownerFile: INPUT_INTENT_REL_PATH,
  });
});

test("I6 retry 分支不得把 payload 断言成 edit 形状（旧写法给 retry 伪造了 newText）", () => {
  const code = stripComments(readFileSync(inputIntentPath, "utf8"));
  const start = code.indexOf('if (envelope.type === "retryTurn")');
  assert.ok(start >= 0, "retryTurn 必须是独立分支（cr-func N5）");
  const end = code.indexOf("\n  }", start);
  assert.ok(end > start, "retryTurn 分支必须是独立块");
  const retryBranch = code.slice(start, end);
  // retry 的 schema 只有 target：读到 newText 就说明 edit 的 payload 断言又越界了。
  assertNoPattern(retryBranch, /newText|editPayload/u, "retry 分支不得读 edit 的 payload 字段");
  // edit 分支**保留**自己的 schema 形状断言（不设兜底），但只在分支内：分支外那一句
  // `payload as { newText: string }` 就是给 retry 伪造类型的来源。
  const editStart = code.indexOf('if (envelope.type === "editUserQuery")');
  assert.ok(editStart >= 0, "editUserQuery 必须是独立分支");
  const editEnd = code.indexOf("\n  }", editStart);
  assert.ok(editEnd > editStart, "editUserQuery 分支必须是独立块");
  const editBranch = code.slice(editStart, editEnd);
  const castsInBranch = (editBranch.match(/payload as \{ newText: string/gu) ?? []).length;
  const castsInFile = (code.match(/payload as \{ newText: string/gu) ?? []).length;
  assert.equal(
    castsInFile,
    castsInBranch,
    "payload 的 edit 形状断言必须收在 editUserQuery 分支内（分支外 = 又给 retry 伪造 newText）",
  );
  assert.equal(castsInBranch, 1, "edit 分支必须保留自己的 payload 形状断言，且不设兜底");
  assertBranchTextShape(code);
});

/**
 * queue.ts 里 `queueItem.text` 剩下的合法用法（spec 4b 的守卫例外表：
 * goal objective 解析 / goal 分支 intent.text / displayText）。
 *
 * Step 3 已把**执行内容**（普通分支的 `content:` 与 `intent.text`）改为读
 * `session_input` 账本，那两条「待收口」条目已按过期即红的设计删掉——
 * 再出现新的 `queueItem.text` 作执行内容，本守卫会以「未登记站点」打红。
 */
const QUEUE_TEXT_ALLOWLIST = [
  {
    code: "? parseGoalObjectiveFromCommandText(queueItem.text)",
    file: "zcode-protocol-v4/commands/handlers/queue.ts",
    note: "goal objective 解析（spec 4b 例外，合法）",
  },
  {
    code: "inputIntentMetadataFromQueueItem(queueItem, objective ?? queueItem.text),",
    file: "zcode-protocol-v4/commands/handlers/queue.ts",
    note: "goal 分支的 intent.text（spec 4b 例外表，合法）",
  },
  {
    code: "displayText: queueItem.text,",
    file: "zcode-protocol-v4/commands/handlers/queue.ts",
    note: "展示文案（spec 4b 例外，合法）",
  },
];

test("I7 queue.ts 的执行内容不得读投影项：只剩 spec 4b 例外表的三处", () => {
  const code = stripComments(readFileSync(queueHandlerPath, "utf8"));
  assert.equal(
    code.includes("content: queueItem.text"),
    false,
    "提升轮执行文本必须来自 session_input 账本，不得再读投影项（RC1 根因）",
  );
  assert.equal(
    code.includes("inputIntentMetadataFromQueueItem(queueItem, queueItem.text)"),
    false,
    "落库 intent.text 必须由账本传入（变更点 21）",
  );
  // 正向：执行内容确实取账本变量，而不是某个改名后的投影读法。
  assertPattern(code, /content: executionText,/u, "提升轮 content 必须取账本权威文本");
  assertPattern(
    code,
    /inputIntentMetadataFromQueueItem\(queueItem, executionText\)/u,
    "普通分支 intent.text 必须取账本权威文本",
  );
  const matches = collectCodeLineMatches(
    (code) => code.includes("queueItem.text"),
    queueHandlerPath,
  );
  assert.equal(
    matches.length,
    3,
    "queue.ts 的 queueItem.text 只允许 spec 4b 例外表的三处；站点数量异常先确认扫描没失效",
  );
  assertSourceAllowlist({
    allowlist: QUEUE_TEXT_ALLOWLIST,
    label: "queue.ts 的 queueItem.text",
    matches,
  });
});

// ── J / K: 执行侧重建 intent 的形状与 retry payload 访问 ─────────────────────

test("J1 执行侧重建 intent 的 pin 恒为 boolean：仅活值时 false（不是缺键），显式时 true", () => {
  const payload = { target: { rowId: 4, entityId: "ent-4" }, newText: EDITED_TEXT };
  const envelope = envelopeOf("editUserQuery", payload);
  const liveOnly = resolveCanonicalInput(RECORD, payload, envelope, { live: LIVE_SELECTION });
  assert.ok(liveOnly);
  // 唯一入口保持三态：缺键 = 本次没有 pin 事实（admission 依赖它与收敛前逐字一致）。
  assertAbsent(liveOnly.intent, "modelSelectionPinned");
  const rebuilt = inputIntentMetadataFromCanonical(envelope, liveOnly.intent);
  assert.equal(
    rebuilt.modelSelectionPinned,
    false,
    "执行侧重建的 intent 必须明确表态 false，而不是缺键（test-edit-retry-model B2/B3/B5 的契约）",
  );
  assert.deepEqual(rebuilt.modelSelection, LIVE_SELECTION);
  assert.equal(rebuilt.text, EDITED_TEXT);

  const explicit = resolveCanonicalInput(RECORD, payload, envelope, {
    explicit: EXPLICIT_SELECTION,
    live: LIVE_SELECTION,
  });
  assert.ok(explicit);
  const pinned = inputIntentMetadataFromCanonical(envelope, explicit.intent);
  assert.equal(pinned.modelSelectionPinned, true, "显式事实 → pin（runtime 写回门的唯一开关）");
  assert.deepEqual(pinned.modelSelection, EXPLICIT_SELECTION);
});

test("K1 retryTurn 的 canonical 解析不得读取 payload.newText（payload 只有 target）", () => {
  let reads = 0;
  const payload = Object.defineProperty({ target: { rowId: 4, entityId: "ent-4" } }, "newText", {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return STRAY_NEW_TEXT;
    },
  });
  const resolved = resolveCanonicalInput(RECORD, payload, envelopeOf("retryTurn", payload));
  assert.ok(resolved, "retryTurn 带 record 必须产生输入");
  assert.equal(resolved.text, RECORD_TEXT);
  assert.equal(reads, 0, "retry 读 payload.newText = edit 形状越界（改前靠三元短路偶然安全）");
});

// ── L: I1 执行权威——sendQueuedNow 只认 session_input 账本 ────────────────────
//
// 本组直驱**真实** queue handler（不是源码形状断言）。改前全红：`sendQueuedNow`
// 用投影项 `queueItem.text` 起轮，账本写了什么根本不影响执行结果。

const { queueHandlers } = await import(
  pathToFileURL(join(srcRoot, "zcode-protocol-v4", "commands", "handlers", "queue.ts")).href
);

const EXEC_SESSION_ID = "ses_exec_authority";
/** 投影里的旧文本：任何执行用例都不允许把它发出去。 */
const PROJECTION_TEXT = "投影里的旧文本（不得被执行）";
/** 账本里的执行文本：唯一合法的执行内容。 */
const LEDGER_TEXT = "账本里的执行文本";

function executionQueueItem({ kind = "sendText", text = PROJECTION_TEXT } = {}) {
  return {
    sourceCommandId: "cmd-exec-original",
    queueItemId: "queue-exec-1",
    clientId: "ui",
    kind,
    text,
    attachments: [],
    delivery: { requested: "queue", admitted: "queue" },
    order: { admissionSeq: 7, queuePosition: 0 },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: 1_700_000_000_000,
  };
}

/**
 * 提升 harness：`authority` 是账本读法的返回值；`withCapability=false` 模拟旧宿主
 * 没有执行权威能力（必须硬失败，不能回落到投影项）。
 */
function executionHarness({ authority, withCapability = true, queueItem = executionQueueItem() }) {
  const calls = {
    ledgerReads: 0,
    release: 0,
    remove: 0,
    reserve: 0,
    sendInput: 0,
    warnings: [],
  };
  const captured = {};
  const record = {
    app: {
      sessionId: EXEC_SESSION_ID,
      getMode: () => "build",
      readTarget: async () => null,
      runtime: {
        // 会话无活值：applyPromotedModelSelection 不动 modelSelection（模型不在本组断言范围）。
        getSessionModelSelection: () => undefined,
        getPlanEnabled: () => false,
        getActiveTurnInfo: () => undefined,
        getActiveForegroundExecutionId: () => undefined,
        acquireForegroundPromotionLease: () => ({ kind: "acquired" }),
        releaseForegroundPromotionLease: () => undefined,
      },
      reserveQueueItem: async () => {
        calls.reserve += 1;
        return true;
      },
      markQueueItemPromoting: async () => true,
      removeQueueItem: async () => {
        calls.remove += 1;
        return true;
      },
      releaseQueueItemReservation: async () => {
        calls.release += 1;
        return true;
      },
      setQueueAutoDrain: async () => {
        calls.autoDrainResumed = true;
      },
      sendInput: async (input, options) => {
        calls.sendInput += 1;
        captured.input = input;
        captured.options = options;
        return { kind: "started_turn", turnId: "turn-exec", completion: Promise.resolve() };
      },
    },
    traceContext: { traceId: "trace-exec", sessionId: EXEC_SESSION_ID },
    persistence: "immediate",
  };
  const host = {
    getRecord: (sessionId) => (sessionId === EXEC_SESSION_ID ? record : undefined),
    logger: {
      info: () => undefined,
      warn: (message, fields) => calls.warnings.push({ message, fields }),
    },
    getQueueItem: (sessionId, queueItemId) =>
      sessionId === EXEC_SESSION_ID && queueItemId === queueItem.queueItemId ? queueItem : null,
    getInputRoutingMode: () => null,
    ensureModelReady: async () => undefined,
    afterLegacyStateMutation: async () => undefined,
    ...(withCapability
      ? {
          getSessionInputForExecution: async (sessionId, queueItemId) => {
            calls.ledgerReads += 1;
            assert.equal(sessionId, EXEC_SESSION_ID, "账本读法必须按 session 约束");
            assert.equal(queueItemId, queueItem.queueItemId, "账本读法必须按 queue item id");
            return authority;
          },
        }
      : {}),
  };
  const envelope = {
    commandId: "cmd-exec-promote",
    clientId: "ui",
    sessionId: EXEC_SESSION_ID,
    type: "sendQueuedNow",
    payload: { queueItemId: queueItem.queueItemId },
    issuedAt: new Date(1_700_000_000_000),
    baseRevision: 3,
    baseLogEpoch: "epoch-exec-authority",
  };
  return { calls, captured, envelope, host };
}

const pendingAuthority = (text) => ({
  state: "pending",
  status: "admitted",
  id: "queue-exec-1",
  sessionID: EXEC_SESSION_ID,
  text,
});

test("L1 (T-IA1) 账本文本 ≠ 投影文本：提升轮 content 与 intent.text 都取账本", async () => {
  const harness = executionHarness({ authority: pendingAuthority(LEDGER_TEXT) });
  await queueHandlers.sendQueuedNow(harness.host, harness.envelope);
  assert.equal(harness.calls.sendInput, 1, "账本 pending 必须正常起轮");
  assert.equal(harness.captured.input.text, LEDGER_TEXT, "执行内容只能来自账本");
  assert.equal(
    harness.captured.options.intent.text,
    LEDGER_TEXT,
    "落库 intent.text 必须等于账本文本（否则冷恢复把旧文本带回 edit target）",
  );
  assert.notEqual(harness.captured.input.text, PROJECTION_TEXT, "投影文本被执行 = RC1 复活");
  // 普通提升成功后必须恢复 autoDrain（held-queue tripwire 的行为面）。
  assert.equal(harness.calls.autoDrainResumed, true);
});

test("L2 (T-IA2) 账本终态 → 硬失败、不起轮、不留 reservation", async () => {
  const terminalCases = [
    {
      authority: { state: "started", status: "promoted", id: "q", sessionID: EXEC_SESSION_ID },
      status: "promoted",
    },
    {
      authority: {
        state: "voided",
        status: "cancelled",
        id: "q",
        sessionID: EXEC_SESSION_ID,
        statusReason: "user_removed",
      },
      status: "cancelled",
    },
    {
      authority: {
        state: "voided",
        status: "discarded",
        id: "q",
        sessionID: EXEC_SESSION_ID,
        statusReason: "session_resumed",
      },
      status: "discarded",
    },
    {
      authority: { state: "voided", status: "failed", id: "q", sessionID: EXEC_SESSION_ID },
      status: "failed",
    },
  ];
  for (const { authority, status } of terminalCases) {
    const harness = executionHarness({ authority });
    await assert.rejects(
      () => queueHandlers.sendQueuedNow(harness.host, harness.envelope),
      (error) => {
        assert.equal(
          error.reasonCode,
          "fault.command.inputNotPending",
          `${status} 必须按 inputNotPending 硬失败`,
        );
        assert.match(error.message, new RegExp(status, "u"), "错误信息必须带账本终态，便于对账");
        return true;
      },
      `账本 status=${status} 时不得回落投影文本起轮`,
    );
    assert.equal(harness.calls.sendInput, 0, `${status}：不得起轮`);
    assert.equal(
      harness.calls.reserve,
      0,
      `${status}：不得留 reservation（硬失败发生在 reserve 之前）`,
    );
    assert.equal(harness.calls.remove, 0, `${status}：不得移除队列项`);
    assert.equal(harness.calls.warnings.length, 1, `${status}：硬失败必须留对账 warn`);
    assert.equal(harness.calls.warnings[0].fields.ledgerStatus, status);
  }
});

test("L3 (T-IA2) 账本缺行 / 宿主无执行权威能力 → 硬失败 inconsistentAuthority", async () => {
  const missing = executionHarness({
    authority: { state: "missing", id: "queue-exec-1", sessionID: EXEC_SESSION_ID },
  });
  await assert.rejects(
    () => queueHandlers.sendQueuedNow(missing.host, missing.envelope),
    (error) => {
      assert.equal(error.reasonCode, "fault.command.inconsistentAuthority");
      return true;
    },
  );
  assert.equal(missing.calls.sendInput, 0, "账本缺行不得起轮（不许回落投影）");

  // 能力缺席（旧宿主/夹具未升级）同样是「权威不可读」，不是「按投影跑」。
  const noCapability = executionHarness({
    authority: null,
    withCapability: false,
  });
  await assert.rejects(
    () => queueHandlers.sendQueuedNow(noCapability.host, noCapability.envelope),
    (error) => {
      assert.equal(error.reasonCode, "fault.command.inconsistentAuthority");
      return true;
    },
  );
  assert.equal(noCapability.calls.sendInput, 0, "宿主无能力时不得回落到投影文本");
  assert.equal(noCapability.calls.ledgerReads, 0);
  assert.equal(noCapability.calls.warnings.length, 1, "能力缺席也必须留痕（不许静默）");
});
