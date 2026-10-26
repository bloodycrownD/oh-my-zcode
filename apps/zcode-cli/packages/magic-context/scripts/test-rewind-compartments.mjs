#!/usr/bin/env node
/**
 * FORK（spec phase-compartment-rewind / C1）：rewind 后的 compartment 失效验收。
 *
 * 钉死什么（三处修法 + refused 兜底，每一条都有正/反向断言）：
 *   T-RW1 — **DB 水位标记**：`invalidateCompartmentsForRewind(db, sessionId, anchor)`
 *           把 `end_message >= anchor` 的行写成 `rebase_status='unresolved'`；
 *           幂等（二次调用只增 alreadyInvalidated）；水位非法（0）时不标记但照旧
 *           清缓存；`session_meta` 的 cached_m0/m1 字节与 marker 全部清空。
 *   T-RW2 — **M0 过滤 + 说明块**：第二次 `materializeM0` 的 `<session-history>` 不含
 *           被作废段的正文，且投出 `<session-history-invalidated>`（count + 序号区间）。
 *           反向：未失效时该块不出现（不能永久挂在 prompt 里）。
 *   T-RW2b — **全部段被作废**（有效段为空，可达：rewind 到第一个 compartment 之前）：
 *           说明块换成「No still-valid summary remains above」半句，不得再声称
 *           「上面的 <session-history> 还有最后一个有效摘要」（那是假话，P2-4）。
 *   T-RW3 — **M1 增量同样过滤**：`renderM1` 的 `<new-compartments>` 不引用 unresolved 行。
 *   T-RW4 — **refused 时只掐块**：`prefixTrimStatus === "refused"` ⇒ m[1] 的
 *           `<new-compartments>` 被剔掉（注入头里也没有），而 `<new-memories>` 等
 *           其余内容照旧注入；`applied`（边界在窗口内）时块保留（反向对照）。
 *   T-RW5 — **缓存回放路径同样过滤**：`prepareCachedM0M1Replay` 发现缓存对早于一次
 *           失效（边界行 unresolved / 基线之后有 unresolved 行）时返回 undefined，
 *           并清掉持久缓存对；无失效时照旧返回缓存对（反向对照）。
 *
 * 隔离：MAGIC_CONTEXT_DB_DIR / MAGIC_CONTEXT_LOG_PATH 显式指 OS 临时目录，进程
 * 退出即清理，绝不写真实 ~/.omz / ~/.zcode。
 *
 * dist 前置：从 dist/ 加载被测模块；运行前必须
 *   `pnpm --dir apps/zcode-cli/packages/magic-context build`
 * Requires Node >= 24 (node:sqlite).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));
const load = (rel) => import(pathToFileURL(join(PKG_ROOT, "dist", rel)).href);

// `@zcode/shared` / `@zcode/model-option-map` 的包入口发布的是原始 TypeScript，
// 裸 node 加载不了；与 bootstrap 侧脚本同一手法改指同布局编译产物。
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const segments = specifier.split("/");
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
        : null;
    if (packageName === null) return nextResolve(specifier, context);
    const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
    const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
    for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
      try {
        statSync(candidate);
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      } catch {
        // 试下一个候选
      }
    }
    throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
  },
});

for (const rel of [
  "core/features/magic-context/rewind-invalidation.js",
  "core/features/magic-context/compartment-storage.js",
  "core/hooks/magic-context/inject-compartments.js",
  "host/harness.js",
  "core/features/magic-context/storage.js",
]) {
  try {
    statSync(join(PKG_ROOT, "dist", rel));
  } catch {
    throw new Error(
      `dist 前置缺失 ${rel} —— 先运行 pnpm --dir apps/zcode-cli/packages/magic-context build`,
    );
  }
}

// ── 隔离：DB 与日志都落在 OS 临时目录 ───────────────────────────────────
const dbDir = mkdtempSync(join(tmpdir(), "mc-rewind-db-"));
process.env.MAGIC_CONTEXT_DB_DIR = dbDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dbDir, "magic-context.log");

const { initializeMagicContextHost } = await load("host/harness.js");
initializeMagicContextHost();

const storage = await load("core/features/magic-context/storage.js");
const compartmentStorage = await load("core/features/magic-context/compartment-storage.js");
const rewindInvalidation = await load("core/features/magic-context/rewind-invalidation.js");
const inject = await load("core/hooks/magic-context/inject-compartments.js");

const db = storage.openDatabase();
if (!db) throw new Error("openDatabase() failed — MAGIC_CONTEXT_DB_DIR 未生效？");

process.on("exit", () => {
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响结论
  }
});

const { appendCompartments } = compartmentStorage;
const { invalidateCompartmentsForRewind } = rewindInvalidation;
const {
  materializeM0,
  renderM1,
  readCurrentM0SnapshotMarkers,
  prepareCachedM0M1Replay,
  injectM0M1,
} = inject;

function seedCompartments(sessionId, entries) {
  appendCompartments(
    db,
    sessionId,
    entries.map((entry) => ({
      sequence: entry.sequence,
      startMessage: entry.startMessage,
      endMessage: entry.endMessage,
      startMessageId: entry.startMessageId,
      endMessageId: entry.endMessageId,
      title: entry.title ?? `segment-${entry.sequence}`,
      content: entry.content,
      p1: entry.content,
    })),
  );
}

function renderOptions(sessionId, extra = {}) {
  return {
    db,
    sessionId,
    projectDirectory: "",
    injectDocs: false,
    memoryEnabled: false,
    compactionOff: false,
    state: {},
    ...extra,
  };
}

function sessionMeta(sessionId) {
  return db
    .prepare(
      `SELECT cached_m0_bytes AS m0, cached_m1_bytes AS m1,
              cached_m0_last_baseline_end_message_id AS boundary,
              cached_m0_max_compartment_seq AS maxSeq
         FROM session_meta WHERE session_id = ?`,
    )
    .get(sessionId);
}

function compartmentStatuses(sessionId) {
  return db
    .prepare(
      `SELECT sequence, rebase_status FROM compartments
        WHERE session_id = ? ORDER BY sequence ASC`,
    )
    .all(sessionId);
}

// ── T-RW1：水位标记 + 缓存清理 + 幂等 + 非法水位 ─────────────────────────
test("T-RW1 水位标记：end_message >= anchor 的行作废，缓存对整份清空，二次调用幂等", () => {
  const sessionId = "ses_t_rw1";
  seedCompartments(sessionId, [
    {
      sequence: 0,
      startMessage: 1,
      endMessage: 1,
      startMessageId: "m-1",
      endMessageId: "m-1",
      content: "SUMM-A",
    },
    {
      sequence: 1,
      startMessage: 2,
      endMessage: 2,
      startMessageId: "m-2",
      endMessageId: "m-2",
      content: "SUMM-B",
    },
    {
      sequence: 2,
      startMessage: 3,
      endMessage: 3,
      startMessageId: "m-3",
      endMessageId: "m-3",
      content: "SUMM-C",
    },
    {
      sequence: 3,
      startMessage: 4,
      endMessage: 4,
      startMessageId: "m-4",
      endMessageId: "m-4",
      content: "SUMM-D",
    },
    {
      sequence: 4,
      startMessage: 5,
      endMessage: 5,
      startMessageId: "m-5",
      endMessageId: "m-5",
      content: "SUMM-E",
    },
  ]);

  // 先落一份缓存对（证明 invalidation 会把它整份清掉，而不只是标记行）。
  materializeM0(renderOptions(sessionId));
  const cached = sessionMeta(sessionId);
  assert.ok(cached?.m0, "前置：materializeM0 必须落下 cached_m0_bytes");
  assert.ok(cached?.boundary, "前置：缓存对必须有基线边界");

  // 水位 3 ⇒ 只保 seq 0-1（end_message 1,2），作废 seq 2-4（end_message 3,4,5）。
  const first = invalidateCompartmentsForRewind(db, sessionId, 3);
  assert.equal(first.markedUnresolved, 3, "seq 2/3/4 三行必须被标成 unresolved");
  assert.equal(first.alreadyInvalidated, 0);
  assert.equal(first.skipped, undefined);

  const statuses = compartmentStatuses(sessionId);
  assert.deepEqual(
    statuses.map((row) => [row.sequence, row.rebase_status]),
    [
      [0, "ok"],
      [1, "ok"],
      [2, "unresolved"],
      [3, "unresolved"],
      [4, "unresolved"],
    ],
  );

  const cleared = sessionMeta(sessionId);
  assert.equal(cleared?.m0, null, "cached_m0_bytes 必须清空");
  assert.equal(cleared?.m1, null, "cached_m1_bytes 必须清空");
  assert.equal(cleared?.boundary, null, "cached_m0_last_baseline_end_message_id 必须清空");

  const second = invalidateCompartmentsForRewind(db, sessionId, 3);
  assert.equal(second.markedUnresolved, 0, "第二次调用不应重复标记");
  assert.equal(second.alreadyInvalidated, 3, "二次调用必须看到前次标记（幂等）");

  const invalid = invalidateCompartmentsForRewind(db, sessionId, 0);
  assert.equal(invalid.skipped, "invalid_anchor", "水位非法必须显式跳过标记");
  assert.equal(invalid.markedUnresolved, 0);
});

// ── T-RW2：M0 <session-history> 不含旧摘要 + 投失效说明块 ─────────────────
test("T-RW2 rewind 后 M0 不再注入被裁段，且投 <session-history-invalidated> 说明", () => {
  const sessionId = "ses_t_rw2";
  seedCompartments(sessionId, [
    {
      sequence: 0,
      startMessage: 1,
      endMessage: 1,
      startMessageId: "m-1",
      endMessageId: "m-1",
      content: "KEEP-SUMMARY-A",
    },
    {
      sequence: 1,
      startMessage: 2,
      endMessage: 2,
      startMessageId: "m-2",
      endMessageId: "m-2",
      content: "REWOUND-SUMMARY-B",
    },
    {
      sequence: 2,
      startMessage: 3,
      endMessage: 3,
      startMessageId: "m-3",
      endMessageId: "m-3",
      content: "REWOUND-SUMMARY-C",
    },
  ]);

  const before = materializeM0(renderOptions(sessionId));
  const beforeText = before.m0Bytes.toString("utf8");
  assert.ok(beforeText.includes("KEEP-SUMMARY-A"));
  assert.ok(beforeText.includes("REWOUND-SUMMARY-B"), "前置：未失效时旧摘要本来就在 M0 里");
  assert.ok(
    !beforeText.includes("<session-history-invalidated>"),
    "未失效时不得投说明块（否则会永久挂在 prompt 里）",
  );

  // rewind 锚点 = 第 2 条消息 ⇒ 水位 2 ⇒ seq 1/2 作废。
  invalidateCompartmentsForRewind(db, sessionId, 2);

  const after = materializeM0(renderOptions(sessionId));
  const afterText = after.m0Bytes.toString("utf8");
  assert.ok(afterText.includes("KEEP-SUMMARY-A"), "未被裁段的摘要必须保留");
  assert.ok(!afterText.includes("REWOUND-SUMMARY-B"), "被裁段正文不得再进 <session-history>");
  assert.ok(!afterText.includes("REWOUND-SUMMARY-C"), "被裁段正文不得再进 <session-history>");
  assert.ok(
    afterText.includes("<session-history-invalidated>"),
    "必须显式说明旧摘要已作废，而不是悄悄少给内容",
  );
  assert.ok(afterText.includes("2 summary segment(s)"), "说明块必须给出作废段数");
  assert.ok(afterText.includes("sequences 1-2"), "说明块必须给出序号区间");
  // cr-func 第 2 轮 P1-1：正文不得承诺磁盘状态。旧句「Tool effects and files on disk are
  // unaffected」在 workspaceMode=rewind 的编辑重发路径上是假话（文件真被回滚），旧句
  // 「The user rewound the conversation」在 retryTurn 路径上把「点重试」说成 rewind。
  // 中性表述在两条路径上都为真：只说历史被截断，并明确「本说明不描述工作区文件」。
  assert.ok(
    afterText.includes("Conversation history was truncated at this point"),
    "说明块必须中性陈述「历史在此被截断」（不假定是用户主动 rewind）",
  );
  assert.ok(
    afterText.includes("This notice says nothing about workspace files"),
    "说明块必须明确「本说明不描述工作区文件状态」（workspaceMode=rewind 时文件确实被回滚）",
  );
  assert.equal(
    afterText.includes("files on disk are unaffected"),
    false,
    "不得再向模型承诺「磁盘未受影响」——那是可证伪的假话（workspaceMode=rewind 会回滚文件）",
  );
  assert.equal(
    afterText.includes("The user rewound the conversation"),
    false,
    "不得把「点重试」说成用户主动 rewind（retryTurn 与 editUserQuery 共用同一段说明）",
  );
});

// ── T-RW2b：全部段都被作废时，说明块不得声称「上面还有效」 ───────────────
test("T-RW2b 全部 compartment 作废（有效段为空）→ 说明块换成空历史措辞", () => {
  const sessionId = "ses_t_rw2b";
  seedCompartments(sessionId, [
    {
      sequence: 0,
      startMessage: 1,
      endMessage: 1,
      startMessageId: "m-1",
      endMessageId: "m-1",
      content: "ONLY-SUMMARY",
    },
  ]);

  // 锚点 = 第 1 条消息 ⇒ 唯一的段（end_message 1 >= 1）同样被作废。这正是
  // 「rewind 到第一个 compartment 之前」的形态：compartments 空 + invalidatedTail 非空。
  invalidateCompartmentsForRewind(db, sessionId, 1);

  const afterText = materializeM0(renderOptions(sessionId)).m0Bytes.toString("utf8");
  assert.ok(
    afterText.includes("<session-history></session-history>"),
    "前置：没有有效段时 <session-history> 必须是空壳（M0_EMPTY_BODY）",
  );
  assert.ok(!afterText.includes("ONLY-SUMMARY"), "被作废段的正文不得进 M0");
  assert.ok(afterText.includes("<session-history-invalidated>"), "说明块照旧要投");
  assert.ok(afterText.includes("1 summary segment(s)"), "说明块给出作废段数");
  // cr-func 第 3 轮 P2-4：空历史下旧句「The <session-history> above ends at the last
  // still-valid summary」是**假话**——上面那个 <session-history> 里一段都没有。
  assert.ok(
    afterText.includes("No still-valid summary remains above"),
    "有效段为空时必须换半句（不能指着一个空 <session-history> 说「上面还有最后一个有效摘要」）",
  );
  assert.equal(
    afterText.includes("ends at the last still-valid summary"),
    false,
    "空历史下不得保留「ends at the last still-valid summary」",
  );
});

// ── T-RW3：M1 增量块同样过滤 unresolved ─────────────────────────────────
test("T-RW3 renderM1 的 <new-compartments> 不引用 unresolved 行", () => {
  const sessionId = "ses_t_rw3";
  seedCompartments(sessionId, [
    {
      sequence: 0,
      startMessage: 1,
      endMessage: 1,
      startMessageId: "m-1",
      endMessageId: "m-1",
      content: "BASE-SEGMENT-0",
    },
  ]);
  materializeM0(renderOptions(sessionId));

  seedCompartments(sessionId, [
    {
      sequence: 1,
      startMessage: 2,
      endMessage: 2,
      startMessageId: "m-2",
      endMessageId: "m-2",
      content: "DELTA-ALIVE-1",
    },
    {
      sequence: 2,
      startMessage: 3,
      endMessage: 3,
      startMessageId: "m-3",
      endMessageId: "m-3",
      content: "DELTA-STALE-2",
    },
  ]);
  db.prepare(
    "UPDATE compartments SET rebase_status = 'unresolved' WHERE session_id = ? AND sequence = 2",
  ).run(sessionId);

  const markers = readCurrentM0SnapshotMarkers({
    db,
    sessionId,
    projectDirectory: "",
    memoryEnabled: false,
  });
  // 基线只覆盖 seq 0 ⇒ 增量区 = seq 1/2；其中 seq 2 已失效。
  const m1Text = renderM1(renderOptions(sessionId), { ...markers, maxCompartmentSeq: 0 }, []);
  assert.ok(m1Text.includes("DELTA-ALIVE-1"), "有效增量段必须照旧投递");
  assert.ok(!m1Text.includes("DELTA-STALE-2"), "unresolved 增量段不得进 <new-compartments>");
});

// ── T-RW4：refused 时只掐 <new-compartments>，不掐整条 m[1] ──────────────
const M1_BLOCK = [
  "<session-history-since>",
  "<new-compartments>",
  "SEQUENCE 9 — REWOUND SEGMENT BODY",
  "</new-compartments>",
  "<new-memories>",
  "#7: MEMORY DELTA MUST SURVIVE",
  "</new-memories>",
  "</session-history-since>",
].join("\n");

function preparedPair(sessionId, boundaryId) {
  const m0Text = "<session-history>\nKEEP-BASE\n</session-history>";
  return {
    injected: true,
    prependedMessageCount: 2,
    m0RematerializedThisPass: false,
    materializationContentionRetryExhausted: true,
    decision: { value: false, reason: "cache_hit" },
    m0Bytes: Buffer.from(m0Text, "utf8"),
    m1Text: M1_BLOCK,
    preparedMessages: [
      {
        info: { role: "user", sessionID: sessionId, syntheticHead: true },
        parts: [{ type: "text", text: m0Text, synthetic: true }],
      },
      {
        info: { role: "user", sessionID: sessionId, syntheticHead: true },
        parts: [{ type: "text", text: M1_BLOCK, synthetic: true }],
      },
    ],
    preparedTrimBoundaryId: boundaryId,
  };
}

function headM1Text(messages) {
  // 注入头固定是 unshift 进去的两条（[m[0], m[1], ...原窗口]），不是 `at(-1)`。
  const m1Message = messages.find(
    (message) => message?.info?.syntheticHead === true && message !== messages[0],
  );
  const part = m1Message?.parts?.[0];
  return typeof part?.text === "string" ? part.text : "";
}

test("T-RW4 refused ⇒ m[1] 的 <new-compartments> 被剔掉，其余内容与注入照旧", () => {
  const sessionId = "ses_t_rw4_refused";
  // 边界行不在窗口里，且无法判定「排在窗口之前」⇒ classifyAbsentBoundary = refused。
  const messages = [
    { info: { id: "m-live-2", role: "user" }, parts: [{ type: "text", text: "next question" }] },
  ];
  const result = injectM0M1(
    renderOptions(sessionId, {
      messages,
      preparedPrefix: preparedPair(sessionId, "m-boundary-not-in-window"),
      isCacheBustingPass: false,
    }),
  );

  assert.equal(result.prefixTrimStatus, "refused");
  assert.ok(result.injected, "refused 不是「不注入」——m[0]/m[1] 本身照旧注入");
  assert.ok(!result.m1Text.includes("<new-compartments>"), "refused 时不得投 <new-compartments>");
  assert.ok(!result.m1Text.includes("REWOUND SEGMENT BODY"), "块正文不得漏回 m[1]");
  assert.ok(
    result.m1Text.includes("#7: MEMORY DELTA MUST SURVIVE"),
    "m[1] 其余内容（memory 增量）必须保留——整条丢 M1 会连带丢记忆更新",
  );
  assert.ok(!headM1Text(messages).includes("<new-compartments>"), "注入头里的 m[1] 也必须已剔块");
  assert.ok(headM1Text(messages).includes("#7: MEMORY DELTA MUST SURVIVE"));
  assert.equal(messages.length, 3, "头仍注入（m[0] + m[1] + 原消息）");
});

test("T-RW4b 反向对照：边界在窗口内（applied）时 <new-compartments> 保留", () => {
  const sessionId = "ses_t_rw4_applied";
  const messages = [
    { info: { id: "m-boundary", role: "user" }, parts: [{ type: "text", text: "boundary row" }] },
    { info: { id: "m-live-2", role: "user" }, parts: [{ type: "text", text: "next question" }] },
  ];
  const result = injectM0M1(
    renderOptions(sessionId, {
      messages,
      preparedPrefix: preparedPair(sessionId, "m-boundary"),
      isCacheBustingPass: false,
    }),
  );

  assert.equal(result.prefixTrimStatus, "applied");
  assert.ok(result.m1Text.includes("<new-compartments>"), "applied 时块必须原样保留");
  assert.ok(result.m1Text.includes("REWOUND SEGMENT BODY"));
});

// ── T-RW5：缓存回放路径同样过滤 ─────────────────────────────────────────
test("T-RW5 缓存对早于一次失效 ⇒ prepareCachedM0M1Replay 返回 undefined 并清掉缓存对", () => {
  const sessionId = "ses_t_rw5_boundary";
  seedCompartments(sessionId, [
    {
      sequence: 0,
      startMessage: 1,
      endMessage: 1,
      startMessageId: "m-1",
      endMessageId: "m-1",
      content: "ONLY-SEGMENT",
    },
  ]);
  materializeM0(renderOptions(sessionId));
  assert.ok(prepareCachedM0M1Replay(db, sessionId) !== undefined, "前置：无失效时缓存对可回放");

  // 判据 1：分包基线边界那一行被判 unresolved（rewind 把基线自己作废了）。
  db.prepare(
    "UPDATE compartments SET rebase_status = 'unresolved' WHERE session_id = ? AND sequence = 0",
  ).run(sessionId);
  assert.equal(
    prepareCachedM0M1Replay(db, sessionId),
    undefined,
    "边界已作废 ⇒ 缓存对必须被拒绝（否则热路径原样重放旧摘要）",
  );
  assert.equal(sessionMeta(sessionId)?.m0, null, "拒绝时必须清掉 cached_m0_bytes，逼下一次重建");
});

test("T-RW5b 反向对照：基线之后出现 unresolved 增量行同样拒绝回放", () => {
  const sessionId = "ses_t_rw5_newer";
  seedCompartments(sessionId, [
    {
      sequence: 0,
      startMessage: 1,
      endMessage: 1,
      startMessageId: "m-1",
      endMessageId: "m-1",
      content: "BASE-SEGMENT",
    },
  ]);
  materializeM0(renderOptions(sessionId));
  const before = prepareCachedM0M1Replay(db, sessionId);
  assert.ok(before !== undefined, "前置：无失效时缓存对可回放");

  seedCompartments(sessionId, [
    {
      sequence: 1,
      startMessage: 2,
      endMessage: 2,
      startMessageId: "m-2",
      endMessageId: "m-2",
      content: "NEWER-SEGMENT",
    },
  ]);
  db.prepare(
    "UPDATE compartments SET rebase_status = 'unresolved' WHERE session_id = ? AND sequence = 1",
  ).run(sessionId);

  assert.equal(
    prepareCachedM0M1Replay(db, sessionId),
    undefined,
    "基线之后有作废行 ⇒ 缓存的 <new-compartments> 已失效，必须拒绝回放",
  );
});
