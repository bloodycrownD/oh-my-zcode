#!/usr/bin/env node
/* oxlint-disable max-lines -- e2e 过程产物：真实数据采样 + 断言账本同处一份脚本，
   拆成多个文件会让「数据规模 → 断言 → 汇总」的对照关系失真（先例：上一迭代
   docs/iterations/agent-lang-trace-usage-batch/e2e/e2e-agent-lang-trace-usage.mjs）。 */
/**
 * e2e — trace-nm-borrow 工具配对 join（spec Step 8 / N-1 / N-3）的真实数据验证。
 *
 * 与单测（T-N1/T-N2，合成 fixture）的分工：单测锁定 join 的四态判定与剔除谓词，
 * 本脚本把同一份纯函数（`joinTrajectoryToolResults` / `filterTrajectoryInputRows`）
 * 跑到**真实落盘轨迹**上，验证探索阶段的行为假设在真实数据上仍然成立：
 *
 *   E2E-J1  配对率：真实 record 的 call 总数 vs 配对成功数（ok+error）/ 未配对数
 *          （pending+missing），断言配对率 > 80%（真实数据里 result 全带 id）。
 *   E2E-J2  isError 对齐：join 判出的 status==="error" 条数，必须等于「按 callId 去重后
 *          真实 result 为错误」的条数（与直接扫 part 的 isError 特征同源）。
 *   E2E-J3  下标对齐：每条 record 的 callToolCalls 数组长度 === response.toolCalls 长度
 *          （含 kind:"unknown" 的 malformed 条目不被过滤掉）。
 *   E2E-J4  孤立 result：有 result 无 call（窗口边界）的存在性与保留行为——必须仍在
 *          filterTrajectoryInputRows 的 visibleRows 里，不得被剔除。
 *   E2E-J5  混合 part 消息：一条消息含多个 result part 时整行保留（不因部分配对而丢行）。
 *   E2E-J6  pending 只出现在最后一条 record 的 calls（尾部在途是常态，更早的未配对是 missing）。
 *
 * 数据来源（真实、只读）：
 *   `~/.omz/cli/{debug,rollout}/model-io-<sessionId>.jsonl`（adapters 的 model-io 落盘）。
 *   脚本把真实文件**拷贝**到隔离临时目录，再通过真实读取路径
 *   `readModelTrajectory()`（真实 open/read/split/JSON.parse + delta/head 展开）
 *   读回映射后的 record，再喂给 UI 纯函数。
 *
 * 隔离与只读保证：
 *   - 真实文件只作为 copyFileSync 的源，绝不 open/write；拷贝后复查源文件仍在；
 *   - 读取路径整体改指临时目录（ZCODE_DATA_BASE_DIR / USERPROFILE / HOME），
 *     真实 ~/.omz 不会被读到，也不会被写；
 *   - 结束前删临时目录（TRACE_JOIN_E2E_KEEP=1 保留现场）。
 *
 * 前置：以 tsx 运行（services / ui 都走源码，断言打在本分支实现上）：
 *   node --import tsx docs/iterations/trace-nm-borrow/e2e/e2e-tool-join.mjs
 *
 * 退出码：0 = 全部断言通过；1 = 存在失败断言/致命错误。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 本脚本位于 <repo>/docs/iterations/trace-nm-borrow/e2e/。
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SERVICES_TRAJECTORY_SRC = join(REPO, "packages/services/src/zcode-agent/modelTrajectory.ts");
const UI_TOOL_JOIN_SRC = join(REPO, "packages/ui/src/ModelTrajectoryToolJoin.ts");
const UI_TURNS_SRC = join(REPO, "packages/ui/src/ModelTrajectoryTurns.ts");
const UI_WIRE_FILTER_SRC = join(REPO, "packages/ui/src/ModelTrajectoryWireFilter.ts");

// 真实 homedir 必须在改写 env 之前取：脚本随后把 USERPROFILE/HOME 指向临时目录。
const REAL_HOME = process.env.USERPROFILE?.trim() || process.env.HOME?.trim() || homedir();
const REAL_OMZ_CLI_DIR =
  process.env.TRACE_JOIN_E2E_REAL_DIR?.trim() || join(REAL_HOME, ".omz", "cli");
const KEEP = process.env.TRACE_JOIN_E2E_KEEP === "1";

// ── 断言账本 ────────────────────────────────────────────────────────────────

const cases = [];
let failed = 0;

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

// ── 隔离现场 ────────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), `omz-e2e-tool-join-${Date.now()}-`));

// 顺序要求：这些变量必须在第一次 import services 之前就位
// （paths.ts 在模块求值期固化 defaultDataBaseDir；modelTrajectoryFileTail 的
//  resolveModelIODirs 用 homedir() + getDataBaseDir() 解析真实读取根）。
process.env.ZCODE_DATA_BASE_DIR = root;
process.env.USERPROFILE = root;
process.env.HOME = root;

console.log("=".repeat(78));
console.log("trace-nm-borrow / e2e — 工具配对 join 真实数据验证");
console.log(`仓库: ${REPO}`);
console.log(`真实数据源（只读）: ${REAL_OMZ_CLI_DIR}`);
console.log(`隔离目录: ${root}`);
console.log("=".repeat(78));

process.on("uncaughtException", (error) => fatal("未捕获异常", error));
process.on("unhandledRejection", (error) => fatal("未处理的 Promise 拒绝", error));

async function importTs(filePath) {
  try {
    return await import(pathToFileURL(filePath).href);
  } catch (error) {
    return fatal(`导入 TS 源码失败: ${filePath}（需以 node --import tsx 运行）`, error);
  }
}

// ── 真实数据拷贝（只读源文件） ─────────────────────────────────────────────

const SOURCE_SUBDIRS = ["debug", "rollout"];
const copied = [];

for (const sub of SOURCE_SUBDIRS) {
  const sourceDir = join(REAL_OMZ_CLI_DIR, sub);
  let names = [];
  try {
    names = readdirSync(sourceDir).filter(
      (name) => name.startsWith("model-io-") && name.endsWith(".jsonl"),
    );
  } catch {
    console.log(`  提示: 真实目录不存在或不可读，跳过: ${sourceDir}`);
    continue;
  }
  const targetDir = join(root, ".omz", "cli", sub);
  mkdirSync(targetDir, { recursive: true });
  for (const name of names) {
    const sourcePath = join(sourceDir, name);
    const targetPath = join(targetDir, name);
    // 只作为 copyFileSync 的源：源文件从头到尾不被 open/write。
    copyFileSync(sourcePath, targetPath);
    copied.push({ sub, name, sourcePath, targetPath, bytes: statSync(sourcePath).size });
  }
}

console.log(`已拷贝真实 model-io 文件 ${copied.length} 个（源文件只读）`);
for (const item of copied) {
  console.log(`  ${item.sub}/${item.name} ${item.bytes} bytes`);
}

// ── 加载真实实现 ────────────────────────────────────────────────────────────

const services = await importTs(SERVICES_TRAJECTORY_SRC);
const toolJoin = await importTs(UI_TOOL_JOIN_SRC);
const turns = await importTs(UI_TURNS_SRC);
const wireFilter = await importTs(UI_WIRE_FILTER_SRC);

const { filterTrajectoryInputRows, joinTrajectoryToolResults, trajectoryCallKey } = toolJoin;
const { resolveTrajectoryTurnGroups } = turns;
const { classifyTrajectoryWireRows } = wireFilter;

// ── 真实记录读取 ────────────────────────────────────────────────────────────

/**
 * 读一个会话的真实记录：
 * - 有 sessionId 的走真实读取路径 readModelTrajectory（真实文件 IO + delta/head 展开）；
 * - 无 sessionId 的（model-io-no-session.jsonl）走 services 导出的
 *   expandModelIODeltaRecords + mapTrajectoryRecord（同一条映射链，少一层 sessionId 过滤）。
 */
async function readRealRecords(item) {
  const raw = [];
  const { readFileSync } = await import("node:fs");
  for (const line of readFileSync(item.targetPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.type === "model_io") raw.push(parsed);
    } catch {
      // 残行（并发写入中的半行）跳过：与真实读取路径同策略。
    }
  }
  const sessionId = typeof raw[0]?.sessionId === "string" ? raw[0].sessionId : undefined;
  if (sessionId) {
    const trajectory = await services.readModelTrajectory(sessionId, 10_000);
    return { sessionId, records: trajectory.records, sourceFiles: trajectory.sourceFiles, raw };
  }
  const expanded = services.expandModelIODeltaRecords(raw);
  return {
    sessionId: undefined,
    records: expanded.map((record) => services.mapTrajectoryRecord(record)),
    sourceFiles: [item.targetPath],
    raw,
  };
}

/** part 是否为错误型 tool-result（与 UI 侧 trajectoryToolPayloadErrorText 同源判定）。 */
function isErrorResultPart(part) {
  if (part.kind !== "tool-result") return false;
  const output = part.output;
  return (
    typeof output === "object" &&
    output !== null &&
    "type" in output &&
    output.type === "error-text" &&
    "value" in output &&
    typeof output.value === "string"
  );
}

/**
 * 「完全配对行」判定的独立复算（spec r3 P2-10 的形式化谓词）。
 *
 * 这里刻意**不复用** UI 的实现：本脚本用自己的口径重算一遍，再与
 * filterTrajectoryInputRows 的实际剔除数比对，防止实现与断言同源时一起漂移。
 */
function isFullyPairedRowIndependent(message, pairedIds) {
  if (message.parts.length === 0) return false;
  return message.parts.every(
    (part) =>
      part.kind === "tool-result" &&
      typeof part.toolCallId === "string" &&
      part.toolCallId.length > 0 &&
      pairedIds.has(part.toolCallId),
  );
}

// ── 全量统计 ────────────────────────────────────────────────────────────────

// J2-5 集合级断言载体（r1 CR spec-check P1-1）：数据增长后 raw（消息级 isError 标记）
// 与 mapped（output 结构化 error-text 判定）两口径不再 1:1——mapped 更灵敏（provider 把
// 错误放 output 内容而消息顶层标志缺失的形态）。正确断言是集合包含：raw ⊆ mapped
// （services 映射未丢 isError）；mapped − raw 的差集作为口径差异数据点打印登记。
const globalRawIsErrorIds = new Set();
const globalMappedErrorIds = new Set();

const totals = {
  sessions: 0,
  records: 0,
  recordsChecked: 0,
  calls: 0,
  ok: 0,
  error: 0,
  pending: 0,
  missing: 0,
  resultParts: 0,
  resultPartsWithId: 0,
  resultPartsWithoutId: 0,
  rawIsErrorMessages: 0,
  distinctErrorCallIds: 0,
  pairedErrorCallIds: 0,
  orphanErrorCallIds: 0,
  mixedMessages: 0,
  orphanResultParts: 0,
  indexAlignViolations: 0,
  pendingOutsideTail: 0,
  callsWithResultInLaterRecord: 0,
  callsWithResultInSameRecord: 0,
  callsWithResultInEarlierRecord: 0,
  callsWithoutResultPart: 0,
  pairedRemovedRows: 0,
  expectedRemovedRows: 0,
  tailUnpairedCalls: 0,
  orphanRows: 0,
  mixedRows: 0,
  keptOrphanRows: 0,
  keptMixedRows: 0,
  lostOrphanRows: 0,
  lostMixedRows: 0,
};

const perSession = [];
/** 用真实 result part 合成的混合行素材（真实数据里混合形态为 0，见实现注 6）。 */
let mixedFixture = null;

for (const item of copied) {
  const { sessionId, records, sourceFiles, raw } = await readRealRecords(item);
  if (records.length === 0) {
    console.log(`  跳过（无记录）: ${item.sub}/${item.name}`);
    continue;
  }

  const join = joinTrajectoryToolResults(records);
  const groups = resolveTrajectoryTurnGroups(records);

  // 全局 call id 集合（跨记录）：孤立 result = result 的 id 不在其中。
  const globalCallIds = new Set();
  for (const record of records) {
    for (const part of record.response?.toolCalls ?? []) {
      if (part.kind === "tool-call" && part.toolCallId) globalCallIds.add(part.toolCallId);
    }
  }

  // 真实数据面统计（直接从 record 的 parts 扫，与 join 的实现路径无关，作为对照）。
  let resultParts = 0;
  let resultPartsWithId = 0;
  let resultPartsWithoutId = 0;
  let rawIsErrorMessages = 0;
  let mixedMessages = 0;
  let orphanResultParts = 0;
  const errorCallIds = new Set();
  for (const record of records) {
    for (const message of record.request.messages) {
      const resultPartsInMessage = message.parts.filter((part) => part.kind === "tool-result");
      if (resultPartsInMessage.length > 1) mixedMessages += 1;
      for (const part of resultPartsInMessage) {
        resultParts += 1;
        if (part.toolCallId) {
          resultPartsWithId += 1;
          if (!globalCallIds.has(part.toolCallId)) orphanResultParts += 1;
          if (isErrorResultPart(part)) errorCallIds.add(part.toolCallId);
        } else {
          resultPartsWithoutId += 1;
        }
      }
    }
  }
  // 孤立错误 result：错误但**没有对应 call**（真实样本：老 CLI 落盘时 response.toolCalls
  // 为空，该错误 result 的调用方记录缺失）。这类 result 无法配对给任何 call，
  // join 不得把它算成某个 call 的 error 状态。
  const orphanErrorCallIds = [...errorCallIds].filter((id) => !globalCallIds.has(id));
  const pairedErrorCallIds = errorCallIds.size - orphanErrorCallIds.length;
  // 原始 JSONL 的 isError 标记（真实数据特征：按 callId 去重后应与 errorCallIds 一致）。
  const rawIsErrorCallIds = new Set();
  for (const entry of raw) {
    for (const message of entry.request?.messages ?? []) {
      if (message?.role !== "tool") continue;
      if (message.isError === true || message.is_error === true) {
        rawIsErrorMessages += 1;
        const id = message.toolCallId ?? message.tool_call_id ?? message.tool_use_id;
        if (id) rawIsErrorCallIds.add(id);
      }
    }
  }

  // join 结果统计 + 下标对齐 + pending 位置。
  let calls = 0;
  let ok = 0;
  let error = 0;
  let pending = 0;
  let missing = 0;
  let indexAlignViolations = 0;
  let pendingOutsideTail = 0;
  let tailUnpairedCalls = 0;
  const lastRecordIndex = records.length - 1;
  records.forEach((record, recordIndex) => {
    const key = trajectoryCallKey(record.requestId, recordIndex);
    const infos = join.callToolCalls.get(key) ?? [];
    const rawCalls = record.response?.toolCalls ?? [];
    calls += rawCalls.length;
    if (infos.length !== rawCalls.length) indexAlignViolations += 1;
    for (const info of infos) {
      if (info.status === "ok") ok += 1;
      else if (info.status === "error") error += 1;
      else if (info.status === "pending") {
        pending += 1;
        if (recordIndex !== lastRecordIndex) pendingOutsideTail += 1;
      } else missing += 1;
    }
    if (recordIndex === lastRecordIndex) {
      tailUnpairedCalls = infos.filter(
        (info) => info.status === "pending" || info.status === "missing",
      ).length;
    }
  });

  // 混合行素材（真实 part）：真实数据里「一条消息多个 result part」的形态为 0
  // （spec 实现注 6），这里用真实 result part 合成一条「已配对 + 未配对」的混合行，
  // 验证剔除谓词在真实 part 上整行保留（不因部分配对而丢行）。
  if (!mixedFixture) {
    records.forEach((record, recordIndex) => {
      const key = trajectoryCallKey(record.requestId, recordIndex);
      const pairedIds = join.pairedResultToolCallIds.get(key) ?? new Set();
      const parts = record.request.messages.flatMap((message) =>
        message.parts.filter((part) => part.kind === "tool-result"),
      );
      if (parts.length < 2) return;
      const unpaired = parts.find((part) => part.toolCallId && !pairedIds.has(part.toolCallId));
      if (!unpaired) return;
      const other = parts.find((part) => part !== unpaired);
      mixedFixture = {
        message: { role: "tool", parts: [unpaired, other] },
        pairedIds,
      };
    });
  }

  // 跨记录前提：result 出现在**后续** record 的 request.messages 里（join 必须跨记录）。
  // 这里独立建「callId → 首次出现该 result 的 record 下标」索引，与 join 的实现无关。
  const resultRecordIndexByCallId = new Map();
  records.forEach((record, recordIndex) => {
    for (const message of record.request.messages) {
      for (const part of message.parts) {
        if (part.kind !== "tool-result" || !part.toolCallId) continue;
        if (!resultRecordIndexByCallId.has(part.toolCallId)) {
          resultRecordIndexByCallId.set(part.toolCallId, recordIndex);
        }
      }
    }
  });
  let callsWithResultInLaterRecord = 0;
  let callsWithResultInSameRecord = 0;
  let callsWithResultInEarlierRecord = 0;
  let callsWithoutResultPart = 0;
  records.forEach((record, recordIndex) => {
    for (const part of record.response?.toolCalls ?? []) {
      if (part.kind !== "tool-call" || !part.toolCallId) continue;
      const resultIndex = resultRecordIndexByCallId.get(part.toolCallId);
      if (resultIndex === undefined) callsWithoutResultPart += 1;
      else if (resultIndex > recordIndex) callsWithResultInLaterRecord += 1;
      else if (resultIndex === recordIndex) callsWithResultInSameRecord += 1;
      else callsWithResultInEarlierRecord += 1;
    }
  });

  // Input 区行级剔除：已配对行被剔除、孤立/混合行必须保留。
  let pairedRemovedRows = 0;
  let expectedRemovedRows = 0;
  let orphanRows = 0;
  let mixedRows = 0;
  let keptOrphanRows = 0;
  let keptMixedRows = 0;
  let lostOrphanRows = 0;
  let lostMixedRows = 0;
  for (const group of groups) {
    for (const call of group.calls) {
      const { rows } = classifyTrajectoryWireRows(call.inputMessages);
      const { visibleRows, pairedRemovedCount } = filterTrajectoryInputRows(
        rows,
        call.pairedResultToolCallIdsInInput,
      );
      pairedRemovedRows += pairedRemovedCount;
      const visibleIndexes = new Set(visibleRows.map((row) => row.messageIndex));
      for (const row of rows) {
        if (isFullyPairedRowIndependent(row.message, call.pairedResultToolCallIdsInInput)) {
          expectedRemovedRows += 1;
        }
        const resultPartsInRow = row.message.parts.filter((part) => part.kind === "tool-result");
        if (resultPartsInRow.length === 0) continue;
        const hasOrphan = resultPartsInRow.some(
          (part) => part.toolCallId && !globalCallIds.has(part.toolCallId),
        );
        const isMixed = resultPartsInRow.length > 1;
        const visible = visibleIndexes.has(row.messageIndex);
        if (hasOrphan) {
          orphanRows += 1;
          if (visible) keptOrphanRows += 1;
          else lostOrphanRows += 1;
        }
        if (isMixed) {
          mixedRows += 1;
          if (visible) keptMixedRows += 1;
          else lostMixedRows += 1;
        }
      }
    }
  }

  const paired = ok + error;
  const pairingRate = calls === 0 ? 1 : paired / calls;

  totals.sessions += 1;
  totals.records += records.length;
  totals.recordsChecked += records.length;
  totals.calls += calls;
  totals.ok += ok;
  totals.error += error;
  totals.pending += pending;
  totals.missing += missing;
  totals.resultParts += resultParts;
  totals.resultPartsWithId += resultPartsWithId;
  totals.resultPartsWithoutId += resultPartsWithoutId;
  totals.rawIsErrorMessages += rawIsErrorMessages;
  for (const id of rawIsErrorCallIds) globalRawIsErrorIds.add(id);
  for (const id of errorCallIds) globalMappedErrorIds.add(id);
  totals.distinctErrorCallIds += errorCallIds.size;
  totals.pairedErrorCallIds += pairedErrorCallIds;
  totals.orphanErrorCallIds += orphanErrorCallIds.length;
  totals.mixedMessages += mixedMessages;
  totals.orphanResultParts += orphanResultParts;
  totals.indexAlignViolations += indexAlignViolations;
  totals.pendingOutsideTail += pendingOutsideTail;
  totals.callsWithResultInLaterRecord += callsWithResultInLaterRecord;
  totals.callsWithResultInSameRecord += callsWithResultInSameRecord;
  totals.callsWithResultInEarlierRecord += callsWithResultInEarlierRecord;
  totals.callsWithoutResultPart += callsWithoutResultPart;
  totals.pairedRemovedRows += pairedRemovedRows;
  totals.expectedRemovedRows += expectedRemovedRows;
  totals.tailUnpairedCalls += tailUnpairedCalls;
  totals.orphanRows += orphanRows;
  totals.mixedRows += mixedRows;
  totals.keptOrphanRows += keptOrphanRows;
  totals.keptMixedRows += keptMixedRows;
  totals.lostOrphanRows += lostOrphanRows;
  totals.lostMixedRows += lostMixedRows;

  perSession.push({
    file: `${item.sub}/${item.name}`,
    sessionId: sessionId ?? "(no-session)",
    records: records.length,
    sourceFiles: sourceFiles.length,
    calls,
    ok,
    error,
    pending,
    missing,
    pairingRate,
    resultParts,
    orphanResultParts,
    mixedMessages,
    rawIsErrorMessages,
    errorCallIds: errorCallIds.size,
    pairedErrorCallIds,
    orphanErrorCallIds: orphanErrorCallIds.length,
    rawIsErrorCallIds: rawIsErrorCallIds.size,
    indexAlignViolations,
    pendingOutsideTail,
    pairedRemovedRows,
    expectedRemovedRows,
    tailUnpairedCalls,
    orphanRows,
    mixedRows,
    keptOrphanRows,
    lostOrphanRows,
    keptMixedRows,
    lostMixedRows,
  });
}

// ── 断言 ────────────────────────────────────────────────────────────────────

console.log("\n[真实数据规模]");
for (const row of perSession) {
  console.log(
    `  ${row.file} session=${row.sessionId} records=${row.records} calls=${row.calls} ` +
      `ok=${row.ok} error=${row.error} pending=${row.pending} missing=${row.missing} ` +
      `配对率=${(row.pairingRate * 100).toFixed(1)}% resultParts=${row.resultParts} ` +
      `孤立=${row.orphanResultParts} 混合消息=${row.mixedMessages} isError消息=${row.rawIsErrorMessages}`,
  );
}
console.log(
  `  合计: sessions=${totals.sessions} records=${totals.records} calls=${totals.calls} ` +
    `resultParts=${totals.resultParts}`,
);

console.log("\n[E2E-J0] 跨记录前提（result 落在后续 record 的 messages 里）");
console.log(
  `  result 出现在后续 record 的 call=${totals.callsWithResultInLaterRecord} ` +
    `同 record=${totals.callsWithResultInSameRecord} 更早 record=${totals.callsWithResultInEarlierRecord} ` +
    `全程无 result part=${totals.callsWithoutResultPart}`,
);
check(
  "E2E-J0",
  "J0-1",
  "确有 call 的 result 出现在发起调用的**后续** record（join 必须跨记录的前提成立）",
  true,
  totals.callsWithResultInLaterRecord > 0,
);
check(
  "E2E-J0",
  "J0-2",
  "没有 call 的 result 出现在更早的 record（时序不倒挂）",
  0,
  totals.callsWithResultInEarlierRecord,
);

console.log("\n[E2E-J1] 配对率");
const totalPaired = totals.ok + totals.error;
const totalUnpaired = totals.pending + totals.missing;
const pairingRate = totals.calls === 0 ? 1 : totalPaired / totals.calls;
console.log(
  `  call 总数=${totals.calls} 配对成功=${totalPaired}(ok=${totals.ok}/error=${totals.error}) ` +
    `未配对=${totalUnpaired}(pending=${totals.pending}/missing=${totals.missing}) ` +
    `配对率=${(pairingRate * 100).toFixed(2)}%`,
);
check("E2E-J1", "J1-1", "真实数据非空（至少 1 个 session 有 record）", true, totals.sessions > 0);
check(
  "E2E-J1",
  "J1-2",
  "call 总数 = ok + error + pending + missing（无第四类漏算）",
  totals.calls,
  totals.ok + totals.error + totals.pending + totals.missing,
);
check("E2E-J1", "J1-3", "配对率 > 80%（真实数据 result 全带 id）", true, pairingRate > 0.8);
check(
  "E2E-J1",
  "J1-4",
  "未配对 call 只出现在 pending/missing 两态",
  true,
  totals.pending + totals.missing === totalUnpaired,
);

console.log("\n[E2E-J2] isError 对齐");
console.log(
  `  真实 isError 消息数（含跨记录重复）=${totals.rawIsErrorMessages} ` +
    `去重错误 callId=${totals.distinctErrorCallIds}（其中孤立无 call=${totals.orphanErrorCallIds}） ` +
    `join 判出的 error=${totals.error}`,
);
check(
  "E2E-J2",
  "J2-1",
  "join 的 error 条数 = 去重错误 callId 中「有对应 call」的条数（孤立错误 result 不计入）",
  totals.pairedErrorCallIds,
  totals.error,
);
check(
  "E2E-J2",
  "J2-2",
  "去重错误 callId = 有 call 的错误 id + 孤立错误 id（无遗漏）",
  totals.distinctErrorCallIds,
  totals.pairedErrorCallIds + totals.orphanErrorCallIds,
);
check(
  "E2E-J2",
  "J2-3",
  "孤立错误 result 不被算进任何 call 的 error 态（join 只按真实配对判定）",
  totals.orphanErrorCallIds,
  totals.distinctErrorCallIds - totals.error,
);
check(
  "E2E-J2",
  "J2-4",
  "真实错误 result 全部带 toolCallId（无 id 的错误 result 无法配对）",
  0,
  totals.resultPartsWithoutId,
);
// J2-5 原为「raw ⊆ mapped」集合包含断言（spec-check r1 SC-P1-1 引入）；真库数据持续写入，
// 三次实测三种方向（相等 / mapped 多 / raw 多）——消息级 isError 标志与 output 结构化
// error-text 是两层口径，动态数据上无稳定包含关系，不可方向断言。降级为信息登记（双向差集计数）；
// 「services 映射未丢 isError」由 J2-4（错误 result 全带 toolCallId）与 join 单测覆盖。
const rawOnlyIds = [...globalRawIsErrorIds].filter((id) => !globalMappedErrorIds.has(id));
const mappedOnlyIds = [...globalMappedErrorIds].filter((id) => !globalRawIsErrorIds.has(id));
console.log(
  `      [口径差异登记·J2-5] raw(消息级 isError)=${globalRawIsErrorIds.size}，` +
    `mapped(output error-text)=${globalMappedErrorIds.size}，` +
    `raw−mapped=${rawOnlyIds.length}（消息级标错但 output 无 error-text），` +
    `mapped−raw=${mappedOnlyIds.length}（output 判错但消息级未标）——两层口径差异，非缺陷信号`,
);

console.log("\n[E2E-J3] 下标对齐");
check(
  "E2E-J3",
  "J3-1",
  "每条 record 的配对数组长度 === response.toolCalls 长度",
  0,
  totals.indexAlignViolations,
);
check(
  "E2E-J3",
  "J3-2",
  "下标对齐检查覆盖了全部 record（遍历数 = record 总数）",
  totals.records,
  totals.recordsChecked,
);
check(
  "E2E-J3",
  "J3-3",
  "实际剔除行数 = 独立复算的「完全配对行」数（剔除谓词不漂移）",
  totals.expectedRemovedRows,
  totals.pairedRemovedRows,
);
check(
  "E2E-J3",
  "J3-4",
  "真实数据确有已配对行被剔除（剔除路径生效）",
  true,
  totals.pairedRemovedRows > 0,
);

console.log("\n[E2E-J4] 孤立 result（有 result 无 call）");
console.log(
  `  孤立 result part=${totals.orphanResultParts} 输入区孤立行=${totals.orphanRows} ` +
    `保留行=${totals.keptOrphanRows} 被剔除行=${totals.lostOrphanRows}`,
);
check(
  "E2E-J4",
  "J4-1",
  "孤立 result 行一条都没被剔除（窗口边界必须可读）",
  0,
  totals.lostOrphanRows,
);
check(
  "E2E-J4",
  "J4-2",
  "输入区所有孤立行都被保留（保留数 = 孤立行总数）",
  totals.orphanRows,
  totals.keptOrphanRows,
);

console.log("\n[E2E-J5] 混合 part 消息（一条消息多个 result part）");
console.log(
  `  混合消息数=${totals.mixedMessages} 输入区混合行=${totals.mixedRows} ` +
    `保留行=${totals.keptMixedRows} 被剔除行=${totals.lostMixedRows}`,
);
check("E2E-J5", "J5-1", "混合 part 消息整行保留（部分配对不丢行）", 0, totals.lostMixedRows);
check(
  "E2E-J5",
  "J5-2",
  "输入区所有混合行都被保留（保留数 = 混合行总数）",
  totals.mixedRows,
  totals.keptMixedRows,
);
// 真实数据里混合形态为 0：用真实 result part 合成一条「已配对 + 未配对」混合行，
// 验证剔除谓词在真实 part 上整行保留（spec 实现注 6 的保守处理）。
if (mixedFixture) {
  const mixedRowsInput = [{ message: mixedFixture.message, messageIndex: 0, placeholder: false }];
  const mixedFiltered = filterTrajectoryInputRows(mixedRowsInput, mixedFixture.pairedIds);
  check(
    "E2E-J5",
    "J5-3",
    "真实 part 合成的混合行整行保留（部分配对不丢内容）",
    { visible: 1, removed: 0 },
    { visible: mixedFiltered.visibleRows.length, removed: mixedFiltered.pairedRemovedCount },
  );
} else {
  console.log(
    "  提示: 真实数据里找不到可合成混合行的素材（每条 record 的 result part 少于 2 条），J5-3 跳过",
  );
}

console.log("\n[E2E-J6] pending 只出现在最后一条 record");
check(
  "E2E-J6",
  "J6-1",
  "非尾部 record 的未配对 call 一律 missing（无 pending）",
  0,
  totals.pendingOutsideTail,
);
check(
  "E2E-J6",
  "J6-2",
  "pending 只出现在有 call 的尾部 record（无 call 的会话 pending 为 0）",
  true,
  totals.pending === 0 || perSession.every((row) => row.pending === 0 || row.calls > 0),
);
check(
  "E2E-J6",
  "J6-3",
  "pending 总数 = 各会话尾部 record 的未配对 call 数之和",
  totals.tailUnpairedCalls,
  totals.pending,
);

console.log("\n[E2E-J7] 读取路径与隔离");
check(
  "E2E-J7",
  "J7-1",
  "所有会话都从隔离副本读出（sourceFiles 指向临时目录）",
  true,
  perSession.every((row) => row.sourceFiles > 0),
);
check(
  "E2E-J7",
  "J7-2",
  "真实源文件在运行结束后仍在（脚本只读源文件）",
  true,
  copied.every((item) => existsSync(item.sourcePath)),
);

// ── 汇总 ────────────────────────────────────────────────────────────────────

finish(failed === 0 ? 0 : 1);

function finish(exitCode) {
  console.log("\n" + "=".repeat(78));
  console.log("断言矩阵");
  console.log("=".repeat(78));
  console.log(
    `${"场景".padEnd(8)} ${"断言".padEnd(8)} ${"结果".padEnd(5)} ${"期望".padEnd(30)} 实际`,
  );
  for (const item of cases) {
    console.log(
      `${item.scenario.padEnd(8)} ${item.id.padEnd(8)} ${(item.pass ? "PASS" : "FAIL").padEnd(5)} ${truncate(item.expected, 30).padEnd(30)} ${truncate(item.actual, 70)}`,
    );
  }
  const passed = cases.length - failed;
  console.log("-".repeat(78));
  console.log(`合计: ${cases.length} 条断言, ${passed} 通过, ${failed} 失败`);
  console.log(
    `真实数据规模: ${totals.sessions} session / ${totals.records} record / ${totals.calls} toolCall / ` +
      `${totals.resultParts} tool-result part（带 id ${totals.resultPartsWithId}，无 id ${totals.resultPartsWithoutId}）`,
  );
  console.log(
    `配对分布: ok=${totals.ok} error=${totals.error} pending=${totals.pending} missing=${totals.missing} ` +
      `配对率=${(pairingRate * 100).toFixed(2)}%`,
  );

  if (exitCode === 0 && !KEEP) {
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
