#!/usr/bin/env node
/**
 * Step 9（upstream-v3.15.1-backport）b/G-1——journal 读面契约：**真 SQLite**（migration
 * 0019 建出的 dwf_event / dwf_node 真表）与 `InMemoryJournalStore` 在同一场景上逐字同语义。
 *
 * ============================================================================
 * 这一步锁死的失效形态（spec §2.1 / cr-fix-spec b/G-1 验收）
 * ============================================================================
 *
 * 本批最险的一段 SQL（`octet_length` 前缀和窗口定页、`json_remove` 分界剥离、`group by`
 * 计数、`kind in (…)` + limit 下推）此前只有替身证据：替身自己实现 limit / 剥离，实现回归时
 * 测试仍然全绿（test-dwf-read-narrowing.mjs 的窄替身就是这种形状）。本脚本改走公开路径拿
 * **真库**：
 *
 *     openStartupSqliteSessionStore({ dbPath: ":memory:" })   // 构造期即跑全部迁移
 *       → .workflowJournalStore()                             // SqliteDwfJournalStore
 *
 * 内存侧 `InMemoryJournalStore` 陪跑同一份场景。两侧逐一 deepEqual——SQLite 下推与内存过滤
 * 必须给出同一份行、同一个计数、同一页字节窗口。
 *
 * 覆盖断言面（b/G-1 + b/A-2 验收的并集）：
 *   1) listNodes：kinds / withResult / limit / maxResultBytes 真下推（limit=0、单条超界的
 *      「第一条恒带上」、maxResultBytes=0）；
 *   2) countNodes / countTaggedReports 与全量语义等价（count(*) 与 group by 下推）；
 *   3) listEvents：types / cursor / limit / reportItems 剥离（大 payload 不进 JS）；
 *   4) listEventPage（b/A-2 落地）：字节窗口切页、第一条恒带上、hasMore、limit=0 空页，
 *      双实现逐页 deepEqual，且一整页经 `encodeTopicWireFrames` 不抛 frameAssemblyTooLarge；
 *   5) 变异自检：删掉 SQLite 侧 limit 分支后本脚本必须红（见文件尾注释的运行口径）。
 *
 * 运行（须在 `--filter "@zcode/bootstrap..."` 的构建步骤之后——本脚本 import 的是
 * @zcode/adapters / @zcode/dynamic-workflow 的 dist 产物）：`tsx --test scripts/test-dwf-journal-contract.mjs`
 * （node:sqlite 需 Node ≥22.13 的无旗标形态；仓库 mise.toml 钉 Node 24.14.0）
 */

import assert from "node:assert/strict";
import test from "node:test";

const { openStartupSqliteSessionStore } = await import("@zcode/adapters/storage");
const { InMemoryJournalStore } = await import("@zcode/dynamic-workflow");
const {
  WORKFLOW_RUN_EVENTS_PAGE_LIMITS,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
} = await import("@zcode/shared/zcode-protocol-v4");

const RUN = "run-contract";

// ————————————————————————————————————————————————————————————————
// 夹具：两侧喂同一份记录（只用端口方法写，走各自的编码/解码）
// ————————————————————————————————————————————————————————————————

// FORK(upgrade-316)：上游 v3.16 把 openStartupSqliteSessionStore 改成异步（返回 Promise，
// sqlite-session-store.ts:1062-1066）。本脚本的契约夹具是同步形状（contract() 同步跑两侧
// 对比，13 处调用点不逐个改 async），启动时预热一批 :memory: 实例，createSqliteStore 从池取用。
// 池大小必须 ≥ createSqliteStore 的总调用数（contract 13 + 前提 1 + b/A-2 页 1 = 15）。
const SQLITE_POOL = await Promise.all(
  Array.from({ length: 20 }, () => openStartupSqliteSessionStore({ dbPath: ":memory:" })),
);
let sqlitePoolCursor = 0;

/** 真库：构造期即跑迁移（sqlite-session-store.ts 的 ctor → runSqliteSessionMigrations）。 */
function createSqliteStore() {
  const session = SQLITE_POOL[sqlitePoolCursor++];
  return { store: session.workflowJournalStore(), close: () => session.close() };
}

/** 内存侧陪跑。可选成员（countNodes / countTaggedReports / listEventPage）它都实现。 */
function createMemoryStore() {
  return { store: new InMemoryJournalStore(), close: () => {} };
}

function baseRun(runId = RUN) {
  return { runId, caps: { maxConcurrency: 4 }, spentTokens: 0, status: "running" };
}

function node(siteId, kind, extra = {}) {
  return {
    runId: RUN,
    siteId,
    ordinal: 1,
    kind,
    inputHash: `h-${siteId}`,
    status: "completed",
    result: { of: siteId },
    ...extra,
  };
}

function reportEvent(siteId, item, artifactId) {
  return {
    type: "report",
    instance: { siteId, ordinal: 1 },
    item,
    ...(artifactId === undefined ? {} : { artifactId }),
  };
}

const utf8Bytes = (value) =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;

/** 一条事件的序列化字节数——与两实现的度量同一把尺（JSON.stringify 的 UTF-8 字节）。 */
const eventBytes = (event) => utf8Bytes(JSON.stringify(event));

const hasItem = (event) => Object.hasOwn(event, "item");

/**
 * 事件里的 `timeCreated` 由**各实现自己的时钟**在 append 时打：两侧独立喂数据，毫秒级差值
 * 是环境噪声，不属契约。契约钉的是「两个真实现都必须填这个数」（types.ts 的 StoredEvent），
 * 所以归一化时断言它在场且是正数，再把它从 deepEqual 里摘掉。
 */
function normalizeStored(stored) {
  assert.equal(
    typeof stored.timeCreated,
    "number",
    "StoredEvent.timeCreated 必须在场（真实现都要填）",
  );
  assert.ok(stored.timeCreated > 0, "timeCreated 必须是 epoch 毫秒");
  const { timeCreated: _dropped, ...rest } = stored;
  return rest;
}

const normalizeEvents = (events) => events.map(normalizeStored);

/** 一页事件：事件的 timeCreated 按各实现自己的时钟归一（同上），其余逐字比较。 */
function normalizePage(page) {
  return { events: normalizeEvents(page.events), hasMore: page.hasMore };
}

/**
 * 同一场景喂两个实现、对结果逐字 deepEqual（SQLite 下推 vs 内存过滤）。
 * 返回内存侧结果供具体断言；两侧不等时那次 deepEqual 直接给出 diff。
 */
function contract(label, scenario) {
  const sqlite = createSqliteStore();
  const memory = createMemoryStore();
  try {
    const expected = scenario(memory.store);
    const actual = scenario(sqlite.store);
    assert.deepEqual(actual, expected, `${label}：SQLite 与内存实现必须逐字同语义`);
    return expected;
  } finally {
    sqlite.close();
    memory.close();
  }
}

/** 本轮契约的两个可选成员都必须两实现同席（b/A-2 把 listEventPage 定为双实现要求）。 */
test("契约前提：两个实现都实现了 countNodes / countTaggedReports / listEventPage", () => {
  const sqlite = createSqliteStore();
  const memory = createMemoryStore();
  try {
    for (const [label, store] of [
      ["sqlite", sqlite.store],
      ["memory", memory.store],
    ]) {
      for (const member of ["countNodes", "countTaggedReports", "listEventPage"]) {
        assert.equal(typeof store[member], "function", `${label} 必须实现端口成员 ${member}`);
      }
    }
  } finally {
    sqlite.close();
    memory.close();
  }
});

// ————————————————————————————————————————————————————————————————
// 1) listNodes：kinds / withResult / limit / maxResultBytes
// ————————————————————————————————————————————————————————————————

/** 一条 run：ask、report×3（第二条带标签）、world-read、world-run、artifact，按序落库。 */
function seedNodes(store) {
  store.createRun(baseRun());
  store.putNode(node("ask#1", "ask", { actorSiteId: "actor#1", actorOrdinal: 1, actorSeq: 0 }));
  store.putNode(node("report#1", "report"));
  store.putNode(node("report#2", "report", { artifactId: "chart" }));
  store.putNode(node("files.grep#1", "world-read", { input: { op: "grep", args: ["x"] } }));
  store.putNode(node("report#3", "report"));
  store.putNode(node("shell.run#1", "world-run", { input: { op: "run", args: ["echo", "hi"] } }));
  store.putNode(node("artifact#1", "artifact", { artifactId: "chart" }));
}

test("listNodes：kinds 过滤按插入顺序、all / [] 语义，两实现逐字一致", () => {
  const result = contract("listNodes kinds", (store) => {
    seedNodes(store);
    const sites = (rows) => rows.map((row) => row.siteId);
    return {
      reports: sites(store.listNodes(RUN, { kinds: ["report"], withResult: true })),
      work: sites(store.listNodes(RUN, { kinds: ["ask", "world-read"], withResult: true })),
      all: sites(store.listNodes(RUN, { kinds: "all", withResult: true })),
      none: store.listNodes(RUN, { kinds: [], withResult: true }),
      unknownRun: store.listNodes("nope", { kinds: "all", withResult: true }),
      grepRow: store.listNodes(RUN, { kinds: ["world-read"], withResult: true })[0],
    };
  });
  assert.deepEqual(result.reports, ["report#1", "report#2", "report#3"]);
  assert.deepEqual(result.work, ["ask#1", "files.grep#1"]);
  assert.deepEqual(result.all, [
    "ask#1",
    "report#1",
    "report#2",
    "files.grep#1",
    "report#3",
    "shell.run#1",
    "artifact#1",
  ]);
  assert.deepEqual(result.none, []);
  assert.deepEqual(result.unknownRun, []);
  // input_json 的有界输入原样解回（0030 列）。
  assert.deepEqual(result.grepRow?.input, { op: "grep", args: ["x"] });
});

test("listNodes：withResult:false 只剥 result，其余列逐字保留（upsert 不挪行）", () => {
  const result = contract("listNodes withResult", (store) => {
    seedNodes(store);
    // 准入 running → 结算 completed 是同一条 upsert：行的位置（id）不能挪到末尾。
    store.putNode(
      node("ask#1", "ask", {
        status: "failed",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
        actorSeq: 0,
        error: { code: "DriverError", message: "boom" },
      }),
    );
    const full = store.listNodes(RUN, { kinds: ["ask"], withResult: true });
    const slim = store.listNodes(RUN, { kinds: "all", withResult: false });
    return { full, slim };
  });
  assert.equal(result.full[0].status, "failed");
  assert.equal(result.slim[0].siteId, "ask#1");
  assert.equal(result.slim[0].status, "failed");
  for (const row of result.slim) {
    assert.equal(
      Object.hasOwn(row, "result"),
      false,
      "withResult:false 必须让 result 键缺席（不是 null）",
    );
  }
  // 剥了 result 的 ask 行仍带 error / messageBoundary 等非结果列。
  assert.deepEqual(result.slim[0].error, { code: "DriverError", message: "boom" });
});

test("listNodes：limit 在 kind 过滤之后生效，limit=0 是空页（真下推）", () => {
  const result = contract("listNodes limit", (store) => {
    seedNodes(store);
    const sites = (rows) => rows.map((row) => row.siteId);
    return {
      reportsTwo: sites(store.listNodes(RUN, { kinds: ["report"], withResult: true, limit: 2 })),
      reportsZero: store.listNodes(RUN, { kinds: ["report"], withResult: true, limit: 0 }),
      allThree: sites(store.listNodes(RUN, { kinds: "all", withResult: true, limit: 3 })),
      beyond: sites(store.listNodes(RUN, { kinds: ["report"], withResult: true, limit: 99 })),
    };
  });
  // limit 作用在过滤之后：前两条 report，而不是「前两条行里的 report」。
  assert.deepEqual(result.reportsTwo, ["report#1", "report#2"]);
  assert.deepEqual(result.reportsZero, []);
  assert.deepEqual(result.allThree, ["ask#1", "report#1", "report#2"]);
  assert.deepEqual(result.beyond, ["report#1", "report#2", "report#3"]);
});

test("listNodes：maxResultBytes 前缀窗口——再加一行超界即收尾、第一条恒带上、0 也带第一条", () => {
  const oneRow = { index: 1, pad: "x".repeat(100) };
  const rowBytes = utf8Bytes(oneRow);
  const result = contract("listNodes maxResultBytes", (store) => {
    store.createRun(baseRun());
    for (let index = 1; index <= 4; index += 1) {
      store.putNode(node(`report#${index}`, "report", { result: { index, pad: "x".repeat(100) } }));
    }
    const sites = (maxResultBytes, limit) =>
      store
        .listNodes(RUN, {
          kinds: ["report"],
          withResult: true,
          maxResultBytes,
          ...(limit === undefined ? {} : { limit }),
        })
        .map((row) => row.siteId);
    return {
      // 两行半的预算放得下两行；恰好两行也放得下（超过才收尾）。
      twoAndHalf: sites(rowBytes * 2 + Math.floor(rowBytes / 2)),
      exactlyTwo: sites(rowBytes * 2),
      // 一行都放不下时第一行照样在：页不会因为一条大报告而一条都不带。
      onlyFirst: sites(1),
      zeroBudget: sites(0),
      // limit 与字节界同时生效，先到先停。
      withLimit: sites(rowBytes * 10, 3),
      results: store
        .listNodes(RUN, { kinds: ["report"], withResult: true, maxResultBytes: rowBytes * 2 })
        .map((row) => row.result),
    };
  });
  assert.deepEqual(result.twoAndHalf, ["report#1", "report#2"]);
  assert.deepEqual(result.exactlyTwo, ["report#1", "report#2"]);
  assert.deepEqual(result.onlyFirst, ["report#1"]);
  assert.deepEqual(result.zeroBudget, ["report#1"]);
  assert.deepEqual(result.withLimit, ["report#1", "report#2", "report#3"]);
  assert.deepEqual(result.results, [
    { index: 1, pad: "x".repeat(100) },
    { index: 2, pad: "x".repeat(100) },
  ]);
});

test("listNodes：无 opts 的历史形态仍全量带结果，两实现一致", () => {
  const result = contract("listNodes 无 opts", (store) => {
    seedNodes(store);
    return store.listNodes(RUN);
  });
  assert.equal(result.length, 7);
  assert.deepEqual(result[0].result, { of: "ask#1" });
});

// ————————————————————————————————————————————————————————————————
// 2) countNodes / countTaggedReports：与全量语义等价
// ————————————————————————————————————————————————————————————————

test("countNodes：count(*) 与全量扫描逐 kind 等价，两实现同一张数表", () => {
  const counts = contract("countNodes", (store) => {
    seedNodes(store);
    const kinds = ["ask", "world-read", "world-run", "report", "artifact"];
    return {
      counted: Object.fromEntries(kinds.map((kind) => [kind, store.countNodes(RUN, kind)])),
      scanned: Object.fromEntries(
        kinds.map((kind) => [
          kind,
          store.listNodes(RUN, { kinds: [kind], withResult: false }).length,
        ]),
      ),
      unknownRun: store.countNodes("nope", "report"),
    };
  });
  assert.deepEqual(counts.counted, {
    ask: 1,
    "world-read": 1,
    "world-run": 1,
    report: 3,
    artifact: 1,
  });
  assert.deepEqual(counts.counted, counts.scanned, "countNodes 必须与全量扫描同数");
  assert.equal(counts.unknownRun, 0);
});

test("countTaggedReports：group by 只数打了标签的 report 行，两实现同一张映射", () => {
  const maps = contract("countTaggedReports", (store) => {
    store.createRun(baseRun());
    store.putNode(node("report#1", "report", { artifactId: "artifact-a" }));
    store.putNode(node("report#2", "report", { artifactId: "artifact-a" }));
    store.putNode(node("report#3", "report", { artifactId: "artifact-b" }));
    store.putNode(node("report#4", "report")); // 无标签：不计数
    store.putNode(node("artifact#1", "artifact", { artifactId: "artifact-a" })); // 非 report：不计数
    store.putNode(node("ask#1", "ask", { artifactId: "artifact-b" })); // 非 report：不计数
    const empty = new Map();
    const tagged = store.countTaggedReports(RUN);
    const none = store.countTaggedReports("nope");
    return {
      tagged: [...tagged.entries()].sort(([a], [b]) => a.localeCompare(b)),
      none: [...none.entries()],
      emptyShape: [...empty.entries()],
    };
  });
  assert.deepEqual(maps.tagged, [
    ["artifact-a", 2],
    ["artifact-b", 1],
  ]);
  assert.deepEqual(maps.none, []);
});

// ————————————————————————————————————————————————————————————————
// 3) listEvents：types / cursor / limit / reportItems 剥离
// ————————————————————————————————————————————————————————————————

function seedEvents(store) {
  store.createRun(baseRun());
  store.appendEvent(RUN, { type: "log", message: "a" }); // 0
  store.appendEvent(RUN, { type: "usage-updated", spentTokens: 1 }); // 1
  store.appendEvent(RUN, { type: "log", message: "b" }); // 2
  store.appendEvent(RUN, {
    type: "import-cache-closed",
    instance: { siteId: "ask#1", ordinal: 1 },
    cause: "world-run",
  }); // 3
  store.appendEvent(RUN, { type: "log", message: "c" }); // 4
}

test("listEvents：types 过滤先于 cursor 与 limit，两实现逐字一致", () => {
  const result = contract("listEvents types/cursor/limit", (store) => {
    seedEvents(store);
    const seqs = (opts) => store.listEvents(RUN, opts).map((stored) => stored.sequence);
    return {
      logOnly: seqs({ types: ["log"], reportItems: "all" }),
      logPlusClose: seqs({ types: ["import-cache-closed", "log"], reportItems: "all" }),
      limited: seqs({ types: ["log"], reportItems: "all", limit: 2 }),
      cursor: seqs({ types: ["log"], reportItems: "all", afterSequence: 0, limit: 1 }),
      emptyTypes: seqs({ types: [], reportItems: "all" }),
      all: seqs({ types: "all", reportItems: "all" }),
      noOpts: seqs(undefined),
      unknownRun: store.listEvents("nope", { types: "all", reportItems: "all" }),
      events: normalizeEvents(store.listEvents(RUN, { types: ["log"], reportItems: "all" })),
    };
  });
  assert.deepEqual(result.logOnly, [0, 2, 4]);
  assert.deepEqual(result.logPlusClose, [0, 2, 3, 4]);
  assert.deepEqual(result.limited, [0, 2]);
  assert.deepEqual(result.cursor, [2]);
  assert.deepEqual(result.emptyTypes, []);
  assert.deepEqual(result.all, [0, 1, 2, 3, 4]);
  // 无 opts 的历史形态：全量、不剥。
  assert.deepEqual(result.noOpts, [0, 1, 2, 3, 4]);
  assert.deepEqual(result.unknownRun, []);
  assert.deepEqual(result.events[1].event, { type: "log", message: "b" });
});

test("listEvents：reportItems 按全 run 排名剥离 item，其余字段逐字保留", () => {
  const result = contract("listEvents reportItems", (store) => {
    store.createRun(baseRun());
    store.appendEvent(RUN, reportEvent("report#1", { n: 1 })); // 0: 第 1 条
    store.appendEvent(RUN, { type: "log", message: "between" }); // 1
    store.appendEvent(RUN, reportEvent("report#1", null)); // 2: 第 2 条——null 是合法 item
    store.appendEvent(RUN, reportEvent("report#2", { n: 3 }, "chart")); // 3: 第 3 条
    store.appendEvent(RUN, reportEvent("report#1", "four")); // 4: 第 4 条
    const stripTwo = store.listEvents(RUN, { types: "all", reportItems: { limit: 2 } });
    return {
      seqs: stripTwo.map((stored) => stored.sequence),
      hasItem: stripTwo.map((stored) => hasItem(stored.event)),
      first: stripTwo[0].event,
      log: stripTwo[1].event,
      second: stripTwo[2].event,
      third: stripTwo[3].event,
      fourth: stripTwo[4].event,
      fourthTime: typeof stripTwo[4].timeCreated,
      // 排名按全 run 计，与 cursor / limit / types 无关。
      page: normalizeEvents(
        store.listEvents(RUN, { types: ["report"], reportItems: { limit: 2 }, afterSequence: 1 }),
      ),
      head: normalizeEvents(
        store.listEvents(RUN, { types: ["report"], reportItems: { limit: 3 }, limit: 1 }),
      ),
      none: store
        .listEvents(RUN, { types: ["report"], reportItems: { limit: 0 } })
        .map((stored) => hasItem(stored.event)),
      every: store
        .listEvents(RUN, { types: ["report"], reportItems: "all" })
        .map((stored) => hasItem(stored.event)),
    };
  });
  assert.deepEqual(result.seqs, [0, 1, 2, 3, 4]);
  assert.deepEqual(result.hasItem, [true, false, true, false, false]);
  assert.deepEqual(result.first, {
    type: "report",
    instance: { siteId: "report#1", ordinal: 1 },
    item: { n: 1 },
  });
  assert.deepEqual(result.log, { type: "log", message: "between" });
  // null item 照旧保留（剥离只删键，不改值）。
  assert.deepEqual(result.second, {
    type: "report",
    instance: { siteId: "report#1", ordinal: 1 },
    item: null,
  });
  // 被剥的行保留 instance / artifactId 与时间，只少 item 键。
  assert.deepEqual(result.third, {
    type: "report",
    instance: { siteId: "report#2", ordinal: 1 },
    artifactId: "chart",
  });
  assert.deepEqual(result.fourth, {
    type: "report",
    instance: { siteId: "report#1", ordinal: 1 },
  });
  assert.equal(result.fourthTime, "number");
  assert.deepEqual(
    result.page.map((stored) => stored.sequence),
    [2, 3, 4],
  );
  // 排名按全 run 计：页内第一条（seq2，第 2 名）带 item，seq3 / seq4 被剥——
  // 「这条是这一页的第一条」不能把它自己的 item 带回来。
  assert.deepEqual(
    result.page.map((stored) => hasItem(stored.event)),
    [true, false, false],
  );
  assert.deepEqual(result.head, [
    {
      sequence: 0,
      event: { type: "report", instance: { siteId: "report#1", ordinal: 1 }, item: { n: 1 } },
    },
  ]);
  assert.deepEqual(result.none, [false, false, false, false]);
  assert.deepEqual(result.every, [true, true, true, true]);
});

test("listEvents：被剥的大 payload 一行都不进 JS（剥离后的事件序列化只有几百字节）", () => {
  const bigItem = { blob: "x".repeat(512 * 1024), index: 7 };
  const bigBytes = utf8Bytes(bigItem);
  const result = contract("listEvents 大 payload 剥离", (store) => {
    store.createRun(baseRun());
    store.appendEvent(RUN, reportEvent("report#1", bigItem)); // 0: 第 1 条，保留
    store.appendEvent(RUN, reportEvent("report#1", bigItem)); // 1: 第 2 条，剥离
    const stripped = store.listEvents(RUN, { types: ["report"], reportItems: { limit: 1 } });
    return {
      strippedHasItem: stripped.map((stored) => hasItem(stored.event)),
      // 剥离发生在存储层，读回来的行里没有 item，序列化自然回到小体积——
      // SQLite 侧是 json_remove 在库里删键，item 从未进入 JS 堆。
      strippedSerializedBytes: stripped.map((stored) => eventBytes(stored.event)),
      keptItemBytes: eventBytes(stripped[0].event.item),
      fullHasItem: store
        .listEvents(RUN, { types: ["report"], reportItems: "all" })
        .map((stored) => hasItem(stored.event)),
    };
  });
  assert.deepEqual(result.strippedHasItem, [true, false]);
  assert.ok(bigBytes > 512 * 1024);
  assert.equal(result.keptItemBytes, bigBytes);
  assert.ok(
    result.strippedSerializedBytes[1] < 512,
    `被剥的事件必须只剩元数据（实测 ${result.strippedSerializedBytes[1]} 字节）`,
  );
  assert.deepEqual(result.fullHasItem, [true, true]);
});

// ————————————————————————————————————————————————————————————————
// 4) listEventPage（b/A-2）：字节窗口 / 第一条恒带上 / hasMore / limit=0
// ————————————————————————————————————————————————————————————————

/** 一条 run：小事件与大事件交替，供字节窗口切页。 */
function seedPagedEvents(store, bigCount = 3) {
  store.createRun(baseRun());
  const sizes = [];
  for (let index = 0; index < 7; index += 1) {
    const big = index % 3 === 1;
    const message = big ? "y".repeat(4000) : "z".repeat(40);
    const event = { type: "log", message, index };
    store.appendEvent(RUN, event);
    sizes.push(eventBytes(event));
  }
  return sizes;
}

test("listEventPage：条数页 + cursor 翻页 + limit=0 空页，两实现逐字一致", () => {
  const result = contract("listEventPage 条数页", (store) => {
    assert.equal(typeof store.listEventPage, "function");
    seedPagedEvents(store);
    const page = (p) => normalizePage(store.listEventPage(RUN, p));
    const first = page({ limit: 3, maxBytes: 1e9 });
    const second = page({ afterSequence: first.events.at(-1).sequence, limit: 3, maxBytes: 1e9 });
    const third = page({ afterSequence: second.events.at(-1).sequence, limit: 3, maxBytes: 1e9 });
    return {
      first: { seqs: first.events.map((e) => e.sequence), hasMore: first.hasMore },
      second: { seqs: second.events.map((e) => e.sequence), hasMore: second.hasMore },
      third: { seqs: third.events.map((e) => e.sequence), hasMore: third.hasMore },
      zeroLimit: page({ limit: 0, maxBytes: 1e9 }),
      unknownRun: store.listEventPage("nope", { limit: 5, maxBytes: 1e9 }),
    };
  });
  assert.deepEqual(result.first, { seqs: [0, 1, 2], hasMore: true });
  assert.deepEqual(result.second, { seqs: [3, 4, 5], hasMore: true });
  assert.deepEqual(result.third, { seqs: [6], hasMore: false });
  assert.deepEqual(result.zeroLimit, { events: [], hasMore: false });
  assert.deepEqual(result.unknownRun, { events: [], hasMore: false });
});

test("listEventPage：字节窗按序列化字节收尾，第一条恒带上（含自己就超界的情形）", () => {
  const result = contract("listEventPage 字节窗", (store) => {
    const sizes = seedPagedEvents(store);
    const page = (p) => normalizePage(store.listEventPage(RUN, p));
    return {
      sizes,
      // 恰好放下两条：through <= maxBytes 才带上（等于不收尾）。
      exactlyTwo: page({ limit: 10, maxBytes: sizes[0] + sizes[1] }),
      oneLess: page({ limit: 10, maxBytes: sizes[0] + sizes[1] - 1 }),
      // 0 预算 = 只带第一条（第一条恒带上，否则翻页永远卡死）。
      zeroBudget: page({ limit: 10, maxBytes: 0 }),
      // 第一条自己就超界：自成一页，hasMore 如实说后面还有。
      tinyBudget: page({ limit: 10, maxBytes: 1 }),
      // 条数界与字节界同时生效，先到先停。
      bothBounds: page({ limit: 2, maxBytes: 1e9 }),
    };
  });
  assert.ok(result.sizes[1] > 1000, "夹具里必须有一条大事件来制造字节窗");
  assert.deepEqual(
    result.exactlyTwo.events.map((e) => e.sequence),
    [0, 1],
  );
  assert.equal(result.exactlyTwo.hasMore, true);
  assert.deepEqual(
    result.oneLess.events.map((e) => e.sequence),
    [0],
  );
  assert.deepEqual(
    result.zeroBudget.events.map((e) => e.sequence),
    [0],
  );
  assert.deepEqual(
    result.tinyBudget.events.map((e) => e.sequence),
    [0],
  );
  assert.equal(result.tinyBudget.hasMore, true);
  assert.equal(result.tinyBudget.events.length, 1);
  assert.deepEqual(
    result.bothBounds.events.map((e) => e.sequence),
    [0, 1],
  );
  assert.equal(result.bothBounds.hasMore, true);
});

test("listEventPage：整页逐字节翻完不丢行不重复（翻页永远有界、不卡死）", () => {
  const result = contract("listEventPage 全量翻页", (store) => {
    const sizes = seedPagedEvents(store);
    const limit = 2;
    const maxBytes = Math.max(...sizes) + Math.floor(sizes[0] / 2);
    const walked = [];
    const pages = [];
    let cursor;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = store.listEventPage(RUN, {
        ...(cursor === undefined ? {} : { afterSequence: cursor }),
        limit,
        maxBytes,
      });
      pages.push({
        seqs: page.events.map((e) => e.sequence),
        hasMore: page.hasMore,
        bytes: page.events.reduce((total, e) => total + eventBytes(e.event), 0),
      });
      walked.push(...page.events.map((e) => e.sequence));
      if (!page.hasMore) break;
      cursor = page.events.at(-1).sequence;
    }
    return { pages, walked, maxBytes };
  });
  assert.deepEqual(result.walked, [0, 1, 2, 3, 4, 5, 6], "翻页必须覆盖全部事件且不重复");
  assert.equal(new Set(result.walked).size, result.walked.length);
  for (const page of result.pages.slice(0, -1)) assert.equal(page.hasMore, true);
  assert.equal(result.pages.at(-1).hasMore, false);
  for (const page of result.pages) {
    if (page.seqs.length <= 1) continue; // 第一条恒带上，单行页不受字节界约束
    assert.ok(
      page.bytes <= result.maxBytes,
      `多行页的序列化字节必须 ≤ maxBytes（实测 ${page.bytes} > ${result.maxBytes}）`,
    );
  }
});

test("b/A-2 验收：大 payload 一页 ≤ maxBytes、第一条在、hasMore 正确，且经 encodeTopicWireFrames 不抛", () => {
  const contractPage = contract("b/A-2 大 payload 页", (store) => {
    store.createRun(baseRun());
    const eventCount = 48;
    const payload = "p".repeat(160 * 1024);
    for (let index = 0; index < eventCount; index += 1) {
      store.appendEvent(RUN, reportEvent("report#1", { index, payload }));
    }
    const page = store.listEventPage(RUN, {
      limit: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
      maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
    });
    return {
      pageCount: page.events.length,
      bytes: page.events.reduce((total, stored) => total + eventBytes(stored.event), 0),
      firstSequence: page.events[0]?.sequence,
      hasMore: page.hasMore,
      // limit=0 空页的旁证（同一夹具）。
      zero: store.listEventPage(RUN, {
        limit: 0,
        maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
      }),
      // 小 payload 的条数界不回归：limit 说了多少就是多少（后面没有行时 hasMore=false）。
      small: store.listEventPage(RUN, {
        limit: 10,
        maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
      }).events.length,
    };
  });
  assert.equal(WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes, 4 * 1024 * 1024);
  assert.ok(contractPage.pageCount >= 1, "字节界不能把页裁成 0 条");
  assert.ok(
    contractPage.pageCount < 48,
    `48 条 × 160KiB 的载荷必须被字节界截住（实测页内 ${contractPage.pageCount} 条）`,
  );
  assert.ok(
    contractPage.bytes <= WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
    `单页序列化字节必须 ≤ maxBytes（实测 ${contractPage.bytes}）`,
  );
  assert.equal(contractPage.firstSequence, 0, "第一条恒带上");
  assert.equal(contractPage.hasMore, true, "后面还有 47 条，hasMore 必须说准");
  assert.deepEqual(contractPage.zero, { events: [], hasMore: false });
  assert.equal(contractPage.small, 10);

  // 该页进 wire：logical frame 的 16MiB 装配界是 b/A-2 的故障面（旧行为一页可超界、
  // encodeTopicWireFrames 抛 proto.frameAssemblyTooLarge）。mirror v4-gateway 的
  // encodeReservedTopicFrame：frame + measureTopicNotificationEnvelopeBytes。
  const sqlite = createSqliteStore();
  try {
    sqlite.store.createRun(baseRun());
    const payload = "p".repeat(160 * 1024);
    for (let index = 0; index < 48; index += 1) {
      sqlite.store.appendEvent(RUN, reportEvent("report#1", { index, payload }));
    }
    const { events, hasMore } = sqlite.store.listEventPage(RUN, {
      limit: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
      maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
    });
    const frame = {
      topic: "conversation/contract-session",
      subscriptionId: "sub-contract",
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: { kind: "snapshot", snapshot: { events, hasMore } },
    };
    const options = {
      deliveryKind: "initial",
      topic: frame.topic,
      subscriptionId: frame.subscriptionId,
      logicalFrameId: "logical-1",
      logicalFrameOrdinal: 1,
      measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
    };
    const wires = encodeTopicWireFrames(frame, options);
    assert.ok(wires.length >= 1);
    // 负例自检：同一个编码器在小装配预算下必须真的抛 frameAssemblyTooLarge——
    // 证明上面那句「不抛」不是空断言。
    assert.throws(
      () => encodeTopicWireFrames(frame, { ...options, maxAssemblyBytes: 1024 }),
      (error) => error.reasonCode === "proto.frameAssemblyTooLarge",
      "encodeTopicWireFrames 的装配界必须真实生效（不是空断言）",
    );
  } finally {
    sqlite.close();
  }
});

// ============================================================================
// 16-17) run-service 注入钉子（cr-func MF-1）：上面 1-15 只钉存储双实现，不经过
// `dynamic-workflow-run-service.ts` 的生产装配层——删掉那里的 maxBytes/limit 注入后
// 契约脚本照样全绿（只有 tsc 的结构约束在挡）。这两条把承重一跳钉到运行期：
//   16) 带 listEventPage 的探针 journal：断言 page 缺省时 maxBytes/maxEvents 真被注入、
//       显式值原样透传；
//   17) 无 listEventPage 的薄 journal：断言 count-only 回退读 limit+1（多取一条判 hasMore）。
// 运行期走 tsx 直吃 TS 源（../src/...），与本脚本其余 dist import 互不影响。
// ============================================================================
test("run-service listEvents 注入协议缺省上限（maxBytes/maxEvents），显式值透传", async () => {
  const { createDynamicWorkflowRunService } = await import("../src/app/dynamic-workflow-run-service.js");
  const seen = [];
  const probe = {
    listEventPage(runId, page) {
      seen.push({ runId, ...page });
      return { events: [], hasMore: false };
    },
  };
  const service = createDynamicWorkflowRunService({
    journal: probe,
    parentSessionId: "sess-contract",
    fileSystemPort: {},
    executionPort: {},
    createActorRuntime: () => ({}),
  });
  await service.listEvents("run-inject", {});
  await service.listEvents("run-inject", { limit: 3, maxBytes: 1024, afterSequence: 7 });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], {
    runId: "run-inject",
    limit: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
    maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
  });
  assert.deepEqual(seen[1], { runId: "run-inject", afterSequence: 7, limit: 3, maxBytes: 1024 });
});

test("run-service count-only 回退：无 listEventPage 的 journal 读 limit+1 判 hasMore", async () => {
  const { createDynamicWorkflowRunService } = await import("../src/app/dynamic-workflow-run-service.js");
  const seen = [];
  const stored = (sequence) => ({ sequence, event: { type: "node-settled", runId: "run-fallback", siteId: `s${sequence}` } });
  const thin = {
    listEvents(runId, opts) {
      seen.push({ runId, ...opts });
      // 造 6 条（limit=5 时 count-only 应多取 1 条判 hasMore，再裁回 5）
      return [1, 2, 3, 4, 5, 6].map(stored);
    },
  };
  const service = createDynamicWorkflowRunService({
    journal: thin,
    parentSessionId: "sess-contract",
    fileSystemPort: {},
    executionPort: {},
    createActorRuntime: () => ({}),
  });
  const page = await service.listEvents("run-fallback", { limit: 5 });
  assert.equal(seen.length, 1);
  assert.deepEqual(
    seen[0],
    {
      runId: "run-fallback",
      types: "all",
      reportItems: "all",
      limit: 5 + 1,
    },
    "count-only 回退必须多取一条（limit+1）并带全量读形状",
  );
  assert.equal(page.events.length, 5);
  assert.equal(page.hasMore, true, "多取到的一条必须被用来判定 hasMore");
});

// ============================================================================
// 变异自检（反假绿，手工执行、不入 CI 断言）：
//
//   1) 临时删掉 SQLite 侧 limit 分支——dwf-journal-reads.ts 的 `listNodeRows` 里
//      `limit ?` 参数改为常量 -1（或删掉 `.all(..., limitParam(opts.limit))` 的最后一个实参），
//      重新构建 @zcode/adapters 后跑本脚本：`listNodes limit` 用例必须红（返回全部 report 行）。
//   2) 恢复后再跑：全绿。
//   3) 同类自检亦适用于 countTaggedReports（把 group by 换成全量读再数）与
//      listEventPage 的字节窗（把 `Math.max(0, page.maxBytes)` 改为 1e12 → 大 payload 页
//      用例的 `bytes <= maxBytes` 与 encode 负例必须红）。
//
//   运行口径：`npx tsx --test scripts/test-dwf-journal-contract.mjs`（在
//   `pnpm --dir apps/zcode-cli --filter "@zcode/bootstrap..." build` 之后）。
// ============================================================================
