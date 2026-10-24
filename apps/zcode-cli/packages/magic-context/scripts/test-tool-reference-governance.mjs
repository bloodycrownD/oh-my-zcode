#!/usr/bin/env node
/**
 * mc-tool-reference 治理回归 —— 结构化工具结果对 Magic Context 是 opaque。
 *
 * 背景（两条既有不变量的接缝）：
 *   1. `host/types.ts` 的 `toolResultToPart` 在结果块数组含 `{type:"tool_reference"}`
 *      时保留块数组（native ToolSearch 依赖它原样到服务端）；
 *   2. `tag-part-guards.ts` 的 `isToolPartWithOutput` 只把**字符串**输出的 tool part
 *      纳入打标/drop。
 *
 * 于是「结果块数组」的弧必须整弧绕过 MC 的内容改写：drop / skeleton / legacy
 * truncate / edit_marker 全部 no-op、不提供字符串写回面，真实 pending op 只排空、
 * 不落 drop 状态。任何字符串写回（哪怕只是 `[dropped §N§]`）都会把没有 text 字段的
 * `tool_reference` 块删掉，宿主反投影再也拿不回引用。
 *
 * 本脚本驱动的是**生产调用链**，不是 tool-drop-target 的内部函数：
 *
 *     tagMessages(messages, tagger, db)   ← 真实打标 / FIFO 配对 / target 构造
 *         ↓ targets
 *     queuePendingOp(...)                 ← compartment / ctx_reduce 的真实入队形态
 *         ↓
 *     applyPendingOperations(...)         ← 生产 apply 入口
 *
 * 用例：
 *   T-TG1（升级存量）：旧版本已为同一 composite key 留下 tool tag（当时结果被文本化），
 *          现在 host 正投影改成块数组。tagMessages 必须 adopt 该 tag 并建出 opaque
 *          target；drop op 经 applyPendingOperations 被排空，块数组逐字节不变、
 *          tag 保持 active、invocation 参数不变。
 *   T-TG2（新会话）：没有存量 tag 时块数组结果根本不打标，不产生 tool target。
 *   T-TG3（对照组）：普通字符串结果仍走既有 skeleton_real 链——证明 T-TG1 的
 *          「没改动」不是整条 apply 链路空转。
 *   T-TG4（台账口径）：旧版本把结构化 tag 记成 dropped；applyFlushedStatuses
 *          在恢复前把 status 修回 active，账本与仍留在 wire 上的块数组一致，
 *          且修复后不再出现在 dropped 切片里（不会每 pass 重写）。
 *   T-TG5（生产选择器）：smart-drops 的 buildEditSupersessionReclaim 用 canDrop
 *          把 opaque 编辑弧排除在外，因此生产路径不会产生「每 pass 重试」的
 *          synthetic edit_marker op；同组字符串 edit 仍被正常选中（正对照）。
 *
 * 运行（脚本自建 staging + tsc emit，不依赖 dist，也不跑包的 typecheck 门）：
 *   node apps/zcode-cli/packages/magic-context/scripts/test-tool-reference-governance.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG = fileURLToPath(new URL("../", import.meta.url));
const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const NODE = process.execPath;
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");

// ─────────────────────────────────────────────────────────────────────────────
// staging + emit（沿用 test-transform.mjs 的做法：stage 进 node_modules/.cache，
// 让 ai-tokenizer 的 createRequire 能向上找到 hoisted 依赖）
// ─────────────────────────────────────────────────────────────────────────────

function stage() {
  mkdirSync(join(REPO, "node_modules", ".cache"), { recursive: true });
  const root = mkdtempSync(join(REPO, "node_modules", ".cache", "magic-context-tg-"));
  const src = join(root, "src");
  cpSync(join(PKG, "src", "core"), src, { recursive: true });
  return { root, src };
}

function listSources(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "host") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function fileExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function build({ root, src }) {
  const outDir = join(root, "out");
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  const listFile = join(root, "files.txt");
  writeFileSync(listFile, listSources(src).join("\n") + "\n");
  const run = spawnSync(
    NODE,
    [
      TSC,
      "--outDir",
      outDir,
      "--rootDir",
      src,
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "es2022",
      "--skipLibCheck",
      "--types",
      "node",
      "--ignoreConfig",
      "@" + listFile,
    ],
    { cwd: PKG, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // 类型错误本身不致命（缺失的 C/D/E 组模块不在 staging 内）；只有没 emit
  // 出本用例要跑的图才是失败。
  const emitOutput = ((run.stdout || "") + (run.stderr || "")).replace(/\r/g, "");
  const required = [
    "hooks/magic-context/apply-operations.js",
    "hooks/magic-context/tag-messages.js",
    "hooks/magic-context/tool-drop-target.js",
    "hooks/magic-context/tag-part-guards.js",
    "hooks/magic-context/supersession-reclaim.js",
    "features/magic-context/storage-db.js",
  ];
  const missing = required.filter((rel) => !fileExists(join(outDir, rel)));
  if (missing.length > 0) {
    console.error(emitOutput.slice(0, 4000));
    throw new Error("tsc did not emit: " + missing.join(", "));
  }
  if (process.env.MAGIC_CONTEXT_TEST_VERBOSE) console.log(emitOutput);
  return outDir;
}

const { root, src } = stage();
const out = build({ root, src });
const load = (rel) => import(pathToFileURL(join(out, rel)).href);

// DB 目录必须在 openDatabase() 之前设定；storage-db 在调用时读取该 env。
const dbDir = mkdtempSync(join(REPO, "node_modules", ".cache", "magic-context-tg-db-"));
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");

const storageDb = await load("features/magic-context/storage-db.js");
const storage = await load("features/magic-context/storage.js");
const storageTags = await load("features/magic-context/storage-tags.js");
const taggerModule = await load("features/magic-context/tagger.js");
const tagMessagesModule = await load("hooks/magic-context/tag-messages.js");
const applyOps = await load("hooks/magic-context/apply-operations.js");
const toolDropTarget = await load("hooks/magic-context/tool-drop-target.js");
const tagPartGuards = await load("hooks/magic-context/tag-part-guards.js");
const supersessionReclaim = await load("hooks/magic-context/supersession-reclaim.js");

const db = storageDb.openDatabase();
if (!db) throw new Error("openDatabase() failed");

const {
  getDroppedTagsByNumbers,
  getPendingOps,
  getTagsBySession,
  queuePendingOp,
  updateTagDropMode,
  updateTagStatus,
} = storage;
const { getTagById, insertTag } = storageTags;

const SECTION = "\u00a7";
const DROP_MARKER = `[dropped ${SECTION}`;
const TOOL_REFERENCE = "mcp__demo__ping";
const OWNER_MESSAGE_ID = "msg_ref_owner";
const CALL_ID = "call_ref_structured";

function structuredMessages(sessionId) {
  return [
    {
      info: { id: OWNER_MESSAGE_ID, role: "assistant", sessionID: sessionId },
      parts: [
        { type: "text", text: "Searching for the tool." },
        {
          type: "tool",
          callID: CALL_ID,
          tool: "ToolSearch",
          state: { status: "running", input: { query: "ping" } },
        },
      ],
    },
    {
      info: { id: "msg_ref_result", role: "user", sessionID: sessionId },
      parts: [
        {
          type: "tool",
          callID: CALL_ID,
          tool: "ToolSearch",
          state: {
            status: "completed",
            output: [
              { type: "text", text: "Found 1 tool: ping" },
              { type: "tool_reference", toolName: TOOL_REFERENCE },
            ],
          },
        },
      ],
    },
  ];
}

function stringMessages(sessionId) {
  return [
    {
      info: { id: "msg_str_owner", role: "assistant", sessionID: sessionId },
      parts: [
        { type: "text", text: "Listing files." },
        {
          type: "tool",
          callID: "call_str",
          tool: "Bash",
          state: { status: "running", input: { command: "ls" } },
        },
      ],
    },
    {
      info: { id: "msg_str_result", role: "user", sessionID: sessionId },
      parts: [
        {
          type: "tool",
          callID: "call_str",
          tool: "Bash",
          state: { status: "completed", output: "a.txt\nb.txt" },
        },
      ],
    },
  ];
}

function toolTagsOf(sessionId) {
  return getTagsBySession(db, sessionId).filter((tag) => tag.type === "tool");
}

let passed = 0;
let failed = 0;
function it(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok ${passed + failed} - ${name}`);
    console.error(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// T-TG1 — 升级存量：已有 tool tag 的结构化弧经 applyPendingOperations 仍不改写
// ─────────────────────────────────────────────────────────────────────────────

it("T-TG1: a structured result survives applyPendingOperations byte-identically", () => {
  const sessionId = "ses_mc_tg1_structured_upgrade";
  // 旧版本的 tag：message_id = callId，owner 指向 assistant 消息；byte_size 当时
  // 记的是文本化后的结果。新 pass 的 host 正投影给出块数组，tagMessages 通过
  // getToolTagNumberByOwner 自愈绑定这条存量 tag（真实升级路径）。
  insertTag(db, sessionId, CALL_ID, "tool", 64, 1, 0, "ToolSearch", 12, OWNER_MESSAGE_ID);

  const messages = structuredMessages(sessionId);
  const tagger = taggerModule.createTagger();
  const result = tagMessagesModule.tagMessages(sessionId, messages, tagger, db);

  const tags = toolTagsOf(sessionId);
  assert.equal(tags.length, 1, "the legacy tool tag must be adopted, not duplicated");
  const tagNumber = tags[0].tagNumber;
  const target = result.targets.get(tagNumber);
  assert.ok(target, "tagMessages must build a target for the adopted legacy tag");

  // 打标侧：块数组结果不满足字符串门槛，part 本身没有被写 §N§。
  const resultPart = messages[1].parts[0];
  assert.equal(tagPartGuards.isToolPartWithOutput(resultPart), false);
  assert.equal(tagPartGuards.hasStructuredToolOutput(resultPart), true);
  assert.ok(Array.isArray(resultPart.state.output), "the projection keeps the block array");

  // 治理侧：整弧 opaque。
  assert.equal(target.structuredOutputOpaque, true);
  assert.equal(toolDropTarget.toolTargetBypassesContentRewrite(target), true);
  assert.equal(target.canDrop(), false, "a structured arc must not be a drop candidate");
  assert.equal(target.drop(), "bypassed");
  assert.equal(target.skeletonReal(), "bypassed");
  assert.equal(target.editMarker(), "bypassed");
  // tool target 不提供字符串写回面：块数组结果没有忠实文本表示。
  assert.equal(typeof target.setContent, "undefined");
  assert.equal(applyOps.applyNewToolDrop(target, { inWindow: true }).result, "bypassed");

  const outputBefore = structuredClone(resultPart.state.output);
  const inputBefore = structuredClone(messages[0].parts[1].state.input);
  const serializedBefore = JSON.stringify(messages);

  queuePendingOp(db, sessionId, tagNumber, "drop");
  const mutated = applyOps.applyPendingOperations(sessionId, db, result.targets, new Set());
  assert.equal(mutated, false, "a bypass must not report a wire mutation");

  // 真实 pending op 被排空（不会每 pass 重试），tag 保持 active（字节仍在 wire 上）。
  assert.equal(getPendingOps(db, sessionId).length, 0, "the bypassed pending op must be drained");
  assert.equal(getTagById(db, sessionId, tagNumber)?.status, "active");

  // 块数组逐字节不变，且全程没有出现 drop 哨兵。
  assert.deepEqual(messages[1].parts[0].state.output, outputBefore);
  assert.deepEqual(messages[0].parts[1].state.input, inputBefore);
  assert.equal(messages[0].parts[1].state.output, undefined, "the invocation got no sentinel");
  assert.equal(JSON.stringify(messages).includes(DROP_MARKER), false);
  const references = messages[1].parts[0].state.output.filter(
    (block) => block?.type === "tool_reference",
  );
  assert.equal(references.length, 1);
  assert.equal(references[0].toolName, TOOL_REFERENCE);
  // apply 前后整棵消息树逐字节相同（tagMessages 已完成 §N§ 写入，快照在其后）。
  assert.equal(JSON.stringify(messages), serializedBefore);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-TG2 — 新会话：没有存量 tag 时结构化结果不打标、不产生 tool target
// ─────────────────────────────────────────────────────────────────────────────

it("T-TG2: a fresh structured result is not tagged and yields no tool target", () => {
  const sessionId = "ses_mc_tg2_structured_fresh";
  const messages = structuredMessages(sessionId);
  const tagger = taggerModule.createTagger();
  const result = tagMessagesModule.tagMessages(sessionId, messages, tagger, db);

  assert.equal(toolTagsOf(sessionId).length, 0, "block-array results must not be tagged");
  const dropTargets = [...result.targets.values()].filter(
    (target) => typeof target.canDrop === "function",
  );
  assert.equal(dropTargets.length, 0, "no tool drop target should exist");
  assert.ok(Array.isArray(messages[1].parts[0].state.output));
  assert.equal(JSON.stringify(messages).includes(DROP_MARKER), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-TG3 — 对照组：字符串结果仍走 skeleton_real（证明 apply 链路真的在跑）
// ─────────────────────────────────────────────────────────────────────────────

it("T-TG3: the same apply chain still drops a plain string result", () => {
  const sessionId = "ses_mc_tg3_string_control";
  const messages = stringMessages(sessionId);
  const tagger = taggerModule.createTagger();
  const result = tagMessagesModule.tagMessages(sessionId, messages, tagger, db);

  const tags = toolTagsOf(sessionId);
  assert.equal(tags.length, 1, "the string result must be tagged by the existing path");
  const tagNumber = tags[0].tagNumber;
  const target = result.targets.get(tagNumber);
  assert.ok(target);
  assert.equal(target.structuredOutputOpaque, false);
  assert.equal(target.canDrop(), true);

  queuePendingOp(db, sessionId, tagNumber, "drop");
  const mutated = applyOps.applyPendingOperations(sessionId, db, result.targets, new Set());
  assert.equal(mutated, true, "the control drop must mutate the wire");

  const output = messages[1].parts[0].state.output;
  assert.equal(typeof output, "string");
  assert.ok(
    output.startsWith(DROP_MARKER),
    `expected a drop marker, got ${JSON.stringify(output)}`,
  );
  assert.equal(getTagById(db, sessionId, tagNumber)?.status, "dropped");
  assert.equal(getPendingOps(db, sessionId).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// T-TG4 — 旧版本已落 drop 状态的存量：账本修回 active，块数组原样留在 wire
// ─────────────────────────────────────────────────────────────────────────────

it("T-TG4: a legacy dropped structured tag is healed to active to match the wire", () => {
  const sessionId = "ses_mc_tg4_legacy_dropped";
  insertTag(db, sessionId, CALL_ID, "tool", 64, 1, 0, "ToolSearch", 12, OWNER_MESSAGE_ID);
  updateTagStatus(db, sessionId, 1, "dropped");
  updateTagDropMode(db, sessionId, 1, "skeleton_real");

  const messages = structuredMessages(sessionId);
  const tagger = taggerModule.createTagger();
  const result = tagMessagesModule.tagMessages(sessionId, messages, tagger, db);
  const target = result.targets.get(1);
  assert.ok(target, "the dropped tag still gets a target on the visible wire");
  assert.equal(target.structuredOutputOpaque, true);

  const before = JSON.stringify(messages);
  // 生产 preload 形态：transform.ts 用 getDroppedTagsByNumbers 取 dropped 切片。
  const droppedSlice = getDroppedTagsByNumbers(db, sessionId, [...result.targets.keys()]);
  assert.equal(droppedSlice.length, 1, "the legacy dropped row must be in the production slice");
  const mutated = applyOps.applyFlushedStatuses(sessionId, db, result.targets, droppedSlice);
  assert.equal(mutated, false, "healing the ledger must not touch wire bytes");
  assert.equal(JSON.stringify(messages), before);
  assert.ok(Array.isArray(messages[1].parts[0].state.output));
  assert.equal(JSON.stringify(messages).includes(DROP_MARKER), false);

  // 账本与 wire 对齐：status 修回 active（没有任何字节被丢弃）。
  assert.equal(getTagById(db, sessionId, 1)?.status, "active");
  assert.equal(
    getDroppedTagsByNumbers(db, sessionId, [...result.targets.keys()]).length,
    0,
    "the healed tag must leave the dropped slice",
  );

  // 第二 pass：生产切片已空，不会重复自愈、也不会改写 wire。
  const second = tagMessagesModule.tagMessages(
    sessionId,
    messages,
    taggerModule.createTagger(),
    db,
  );
  const secondDropped = getDroppedTagsByNumbers(db, sessionId, [...second.targets.keys()]);
  assert.equal(secondDropped.length, 0, "a healed tag must not be healed again");
  const secondMutated = applyOps.applyFlushedStatuses(
    sessionId,
    db,
    second.targets,
    secondDropped,
  );
  assert.equal(secondMutated, false);
  assert.equal(JSON.stringify(messages), before);
  assert.equal(getTagById(db, sessionId, 1)?.status, "active");
  assert.equal(toolTagsOf(sessionId).length, 1, "healing must not duplicate the tool tag");
});

// ─────────────────────────────────────────────────────────────────────────────
// T-TG5 — 生产选择器：opaque 编辑弧不会进入 synthetic edit_marker 批次
// ─────────────────────────────────────────────────────────────────────────────

function editMessages(sessionId) {
  const arc = (index, output) => {
    const callId = `call_edit_${index}`;
    return [
      {
        info: { id: `msg_edit_owner_${index}`, role: "assistant", sessionID: sessionId },
        parts: [
          { type: "text", text: `Editing file (${index}).` },
          {
            type: "tool",
            callID: callId,
            tool: "edit",
            state: {
              status: "running",
              input: { filePath: "src/demo.ts", oldString: `old ${index}`, newString: `new ${index}` },
            },
          },
        ],
      },
      {
        info: { id: `msg_edit_result_${index}`, role: "user", sessionID: sessionId },
        parts: [
          {
            type: "tool",
            callID: callId,
            tool: "edit",
            state: { status: "completed", output },
          },
        ],
      },
    ];
  };
  // index 1 = 最旧（结构化结果，opaque），2 = 中间的字符串结果（可压缩），
  // 3 = 最新（同一文件的保留项）。
  return [
    ...arc(1, [
      { type: "text", text: "edited" },
      { type: "tool_reference", toolName: TOOL_REFERENCE },
    ]),
    ...arc(2, "edited"),
    ...arc(3, "edited"),
  ];
}

it("T-TG5: smart-drops never select an opaque edit arc for edit_marker compression", () => {
  const sessionId = "ses_mc_tg6_edit_selection";
  const messages = editMessages(sessionId);

  // 存量 tag（真实升级形态）：旧 → 新 = 1 → 2 → 3。
  insertTag(db, sessionId, "call_edit_1", "tool", 64, 1, 0, "edit", 12, "msg_edit_owner_1");
  insertTag(db, sessionId, "call_edit_2", "tool", 64, 2, 0, "edit", 12, "msg_edit_owner_2");
  insertTag(db, sessionId, "call_edit_3", "tool", 64, 3, 0, "edit", 12, "msg_edit_owner_3");

  const tagger = taggerModule.createTagger();
  const result = tagMessagesModule.tagMessages(sessionId, messages, tagger, db);
  const opaqueTarget = result.targets.get(1);
  assert.ok(opaqueTarget);
  assert.equal(opaqueTarget.structuredOutputOpaque, true);
  assert.equal(opaqueTarget.editMarker(), "bypassed");
  assert.equal(result.targets.get(2)?.canDrop(), true, "the string edit must stay selectable");

  const editReclaim = supersessionReclaim.buildEditSupersessionReclaim({
    db,
    sessionId,
    targets: result.targets,
    pendingOps: [],
    recentMessageIds: new Set(),
    protectedTagNumbers: new Set(),
  });

  // 最新的 3 保留；中间的 2 被选为 edit_marker；最旧的 opaque 1 被 canDrop 排除。
  assert.deepEqual([...editReclaim.editMarkerTagIds], [2]);
  assert.deepEqual(
    editReclaim.ops.map((op) => op.tagId),
    [2],
  );

  // 生产形态的 synthetic apply：只有字符串弧被改写，opaque 弧逐字节不变，
  // 且不会被每 pass 重新选中。
  const beforeOpaque = JSON.stringify(messages.slice(0, 2));
  superApply(sessionId, result.targets, editReclaim.ops, editReclaim.editMarkerTagIds);
  assert.equal(JSON.stringify(messages.slice(0, 2)), beforeOpaque);
  assert.equal(getTagById(db, sessionId, 1)?.status, "active");
  assert.equal(getTagById(db, sessionId, 2)?.status, "dropped");
  assert.equal(JSON.stringify(messages.slice(0, 2)).includes(DROP_MARKER), false);
});

function superApply(sessionId, targets, syntheticOps, editMarkerTagIds) {
  return applyOps.applyPendingOperations(
    sessionId,
    db,
    targets,
    new Set(),
    undefined,
    [],
    syntheticOps,
    editMarkerTagIds,
  );
}

console.log(`\nmagic-context tool_reference governance: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
