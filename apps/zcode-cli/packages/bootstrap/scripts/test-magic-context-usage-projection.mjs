#!/usr/bin/env node
/**
 * Step 30 / D-13 —— 用量显示的自动化验证（RPC / projection 层；视觉验收留给 manual）。
 *
 * ============================================================================
 * 这一步新出现的失效面
 * ============================================================================
 *
 * S22 只证明了 `/ctx-status` 能从 `magic-context.db` 读出一份文本快照；S29 只证明了
 * 设置面能整域改配置。**没有任何测试覆盖**「预算摘要从 db 一路走到面板」这条新链，
 * 而它一次引入了三处新的失败可能：
 *
 *   A. **schema**：`sessionUsageStateSchema` 加了可选字段。老快照（没有这个键）必须仍
 *      然解析得过；新快照必须过 `conversationSnapshotSchema` 的完整 round-trip。
 *   B. **projection**：`usage.magicContext` 的**缺席语义**是这一步的核心契约——
 *      magic-context 关着（从未推送）时字段必须**不存在**而不是全零；读数变化要产
 *      delta；值没变**不许**产 delta（否则每一轮都把 delta 日志灌满）。
 *   C. **reader**：`readMagicContextUsageSummary` 真的从一份临时 db 里读出数，
 *      而不是返回写死的占位。off 态（没有 db）必须给 `null`。
 *   D. **UI 纯函数**：`buildMagicContextUsageRows` 的缺席 ⇒ 空数组 ⇒ 整段不渲染
 *      （这是 T-U2 能自动化的一半；另一半「看起来对不对」留给 manual）。
 *
 * 隔离：所有 db 写入都指向 `mkdtemp` 出来的临时目录，**绝不触碰用户真实的
 * `~/.zcode/magic-context.db`**（`openDatabase` 显式传路径，不走 host 解析器）。
 *
 * 依赖已构建的 dist：`@zcode/shared`、`@zcode/magic-context`、`@zcode/bootstrap`，
 * 以及 `packages/ui/dist/chat-input-toolbar/magicContextUsageRows.js`（由根
 * `pnpm typecheck` 的 `tsc -b packages/ui` 产出）。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const packageName = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(`${specifier.split("/").slice(0, 2).join("/")}`)
        ? `${specifier.split("/").slice(0, 2).join("/")}`
        : null;
    if (packageName !== null) {
      const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
      const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
      for (const candidate of [`${distRoot}${subpath}.js`, `${distRoot}${subpath}/index.js`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      throw new Error(`no compiled dist for "${specifier}" — build ${packageName} first`);
    }
    return nextResolve(specifier, context);
  },
});

const { applyConversationDeltas, conversationSnapshotSchema, sessionUsageStateSchema } =
  await import("@zcode/shared/zcode-protocol-v4");
const { openDatabase, updateSessionMeta } = await import("@zcode/magic-context");
const { ProductProjection } = await import(
  new URL("../dist/zcode-protocol-v4/product-projection.js", import.meta.url).href
);
const { readMagicContextUsageSummary } = await import(
  new URL("../dist/app/magic-context-usage-summary.js", import.meta.url).href
);

// UI 的纯函数（真实产物，不是本测试里的复刻）。
const UI_ROWS_DIST = `${REPO_ROOT}packages/ui/dist/chat-input-toolbar/magicContextUsageRows.js`;
if (!existsSync(UI_ROWS_DIST)) {
  throw new Error(
    `missing ${UI_ROWS_DIST} — run the root \`pnpm typecheck\` (tsc -b packages/ui) first`,
  );
}
const { buildMagicContextUsageRows } = await import(pathToFileURL(UI_ROWS_DIST).href);

process.on("exit", (code) => {
  console.log("");
  console.log(
    code === 0
      ? "TEST PASS — Step 30 D-13 magic-context usage projection chain"
      : `TEST FAIL — Step 30 D-13 usage projection chain (exit code ${code})`,
  );
});

const SESSION_ID = "ses_d13";
const SAMPLE = {
  budgetTokens: 32_000,
  usedTokens: 48_120,
  usedPercent: 37.4,
  compartmentCount: 7,
  droppedTagCount: 3,
  droppedTagTokens: 12_400,
  cache: { m0: true, m1: false },
};

function projection() {
  return new ProductProjection(SESSION_ID, "epoch-d13");
}

function withTempDir(run) {
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-mc-usage-"));
    try {
      return await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

// ── A: schema 向后兼容 ───────────────────────────────────────────────────────

test("A1: a usage payload without the magic-context key still parses (old wire shape)", () => {
  const legacy = {
    contextWindow: null,
    cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
  const parsed = sessionUsageStateSchema.parse(legacy);
  assert.deepEqual(parsed, legacy);
  assert.equal("magicContext" in parsed, false, "缺席必须真的是缺席，而不是补一个 undefined 键");
});

test("A2: the new field parses, is optional, and rejects a malformed shape", () => {
  const parsed = sessionUsageStateSchema.parse({
    contextWindow: { usedTokens: 10, maxTokens: 100 },
    cumulative: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    magicContext: SAMPLE,
  });
  assert.deepEqual(parsed.magicContext, SAMPLE);

  // budgetTokens 必须允许 null（这条会话从未冻结过底线），但不允许负数。
  assert.doesNotThrow(() =>
    sessionUsageStateSchema.parse({
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      magicContext: { ...SAMPLE, budgetTokens: null },
    }),
  );
  assert.throws(() =>
    sessionUsageStateSchema.parse({
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      magicContext: { ...SAMPLE, droppedTagCount: -1 },
    }),
  );
});

// ── B: projection 的缺席 / conflation / delta ────────────────────────────────

test("B1: an off session never gets the key — not even a zeroed object", () => {
  const snapshot = projection().getSnapshot();
  assert.equal("magicContext" in snapshot.usage, false);
  assert.deepEqual(snapshot.usage, {
    contextWindow: null,
    cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
});

test("B2: pushing a summary writes the field and emits exactly one usage delta", () => {
  const p = projection();
  const deltas = p.applyMagicContextUsage(SAMPLE);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].op, "state.updated");
  assert.deepEqual(deltas[0].patch.usage.magicContext, SAMPLE);
  assert.deepEqual(p.getSnapshot().usage.magicContext, SAMPLE);
  // 整份快照仍然过 schema（UI 侧解析的就是它）。
  assert.doesNotThrow(() => conversationSnapshotSchema.parse(p.getSnapshot()));
});

test("B3: an unchanged summary emits nothing (conflation), a changed one does", () => {
  const p = projection();
  p.applyMagicContextUsage(SAMPLE);
  assert.deepEqual(p.applyMagicContextUsage({ ...SAMPLE }), [], "逐字段相等必须被吸收");
  assert.deepEqual(p.applyMagicContextUsage({ ...SAMPLE, cache: { m0: false, m1: true } }), [
    {
      op: "state.updated",
      patch: { usage: { ...p.getSnapshot().usage, magicContext: { ...SAMPLE, cache: { m0: false, m1: true } } } },
    },
  ]);
  // cache 的两个布尔各自独立：只翻 m0 也算变化。
  assert.equal(p.applyMagicContextUsage({ ...SAMPLE, cache: { m0: false, m1: false } }).length, 1);
});

test("B4: a null summary REMOVES the key instead of zeroing it", () => {
  const p = projection();
  p.applyMagicContextUsage(SAMPLE);
  const deltas = p.applyMagicContextUsage(null);
  assert.equal(deltas.length, 1);
  assert.equal("magicContext" in deltas[0].patch.usage, false);
  assert.equal("magicContext" in p.getSnapshot().usage, false);
  // 已经缺席时再推 null 是空操作。
  assert.deepEqual(p.applyMagicContextUsage(null), []);
  assert.doesNotThrow(() => conversationSnapshotSchema.parse(p.getSnapshot()));
});

test("B5: the emitted delta round-trips through the client-side applier", () => {
  const p = projection();
  const withData = applyConversationDeltas(p.getSnapshot(), p.applyMagicContextUsage(SAMPLE));
  assert.deepEqual(withData.usage.magicContext, SAMPLE);

  const cleared = applyConversationDeltas(withData, p.applyMagicContextUsage(null));
  assert.equal("magicContext" in cleared.usage, false);
  assert.equal("magicContext" in conversationSnapshotSchema.parse(cleared).usage, false);
});

// ── C: reader 真读一份临时 db ────────────────────────────────────────────────

test("C1: the summary is read out of a real magic-context.db, not a placeholder", withTempDir(async (dir) => {
  const db = openDatabase(join(dir, "magic-context.db"));
  assert.ok(db, "openDatabase must succeed against the temp store");
  try {
    updateSessionMeta(db, SESSION_ID, {
      lastContextPercentage: 37.4,
      lastInputTokens: 48_120,
      lastUsageContextLimit: 128_000,
    });
    db.prepare("UPDATE session_meta SET protected_tokens_effective = ? WHERE session_id = ?").run(
      32_000,
      SESSION_ID,
    );
    db.prepare(
      "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ? WHERE session_id = ?",
    ).run(new Uint8Array([1, 2, 3]), null, SESSION_ID);
    db.prepare(
      "INSERT INTO tags (session_id, status, token_count) VALUES (?, 'dropped', ?)",
    ).run(SESSION_ID, 12_400);

    const { usage } = await readMagicContextUsageSummary(db, SESSION_ID);
    assert.ok(usage, "a session with a meta row must produce a summary");
    assert.equal(usage.budgetTokens, 32_000);
    assert.equal(usage.usedTokens, 48_120);
    assert.equal(Math.round(usage.usedPercent * 10) / 10, 37.4);
    assert.equal(usage.droppedTagCount, 1);
    assert.equal(usage.droppedTagTokens, 12_400);
    // m0 有字节 = 命中；m1 是 NULL = 本轮重建过。
    assert.deepEqual(usage.cache, { m0: true, m1: false });
    // 投影层与 UI 层都必须吃得下这份形状。
    assert.doesNotThrow(() => sessionUsageStateSchema.parse({ contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, magicContext: usage }));
  } finally {
    db.close?.();
  }
}));

test("C2: a session that was never transformed reports unknown budget / cache, not zeros", withTempDir(async (dir) => {
  const db = openDatabase(join(dir, "magic-context.db"));
  assert.ok(db);
  try {
    const { usage } = await readMagicContextUsageSummary(db, "ses_never_seen");
    assert.ok(usage, "getOrCreateSessionMeta 建行后仍应给出可展示的形状");
    assert.equal(usage.budgetTokens, null, "从未冻结底线 ⇒ null，不是 0");
    assert.equal(usage.compartmentCount, 0);
    assert.equal(usage.droppedTagCount, 0);
    // 缓存两列都没有值 ⇒ 「没命中」，而不是「读不到」。
    assert.deepEqual(usage.cache, { m0: false, m1: false });
  } finally {
    db.close?.();
  }
}));

test("C3: without a store the summary is null — the panel must collapse, not show zeros", async () => {
  // 这一条同时钉住 reader 的 nullish 守卫：`readMagicContextStatusSnapshot` 的
  // `options.db ?? …` 在 db 为 null 时会回退去开**用户真实的默认存储**，而这里要的
  // 是「没有库 ⇒ 没有读数」。守卫缺失时本测试会去碰用户目录。
  const { usage } = await readMagicContextUsageSummary(null, SESSION_ID);
  assert.equal(usage, null);
  // null ⇒ 投影层删键 ⇒ UI 空数组。整条链的「关着」语义在这里闭合。
  const p = projection();
  p.applyMagicContextUsage(usage);
  assert.equal("magicContext" in p.getSnapshot().usage, false);
  assert.deepEqual(rowsFor(p.getSnapshot().usage.magicContext), []);
});

test("C4: a store that throws mid-read degrades to null instead of propagating", async () => {
  const broken = {
    prepare() {
      throw new Error("database is locked");
    },
  };
  const { usage } = await readMagicContextUsageSummary(broken, SESSION_ID);
  assert.equal(usage, null);
});

// ── D: UI 纯函数的缺席语义 ──────────────────────────────────────────────────

const LABELS = {
  budget: "Protected budget",
  cache: "Injected blocks",
  cacheHit: "cached",
  cacheMiss: "rebuilt",
  compartments: "Compartments",
  dropped: "Dropped tags",
  used: "Context used",
};

function rowsFor(magicContext, locale = "en-US") {
  return buildMagicContextUsageRows({ labels: LABELS, locale, magicContext });
}

test("D1: an absent summary produces no rows at all (the whole section stays unrendered)", () => {
  assert.deepEqual(rowsFor(undefined), []);
  assert.deepEqual(rowsFor(null), []);
});

test("D2: present data yields the five budget rows in a stable order", () => {
  const rows = rowsFor(SAMPLE);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["budget", "used", "compartments", "dropped", "cache"],
  );
  assert.equal(rows[0].value, "32K");
  assert.match(rows[1].value, /^48\.1K \(37\.4%\)$/);
  assert.equal(rows[2].value, "7");
  assert.equal(rows[3].value, "3 (12.4K)");
  assert.equal(rows[4].value, "m[0] cached · m[1] rebuilt");
});

test("D3: unknown budget and unknown cache render as an em dash, never as 0", () => {
  const rows = rowsFor({ ...SAMPLE, budgetTokens: null, cache: null });
  assert.equal(rows[0].value, "—");
  assert.equal(rows[4].value, "—");
  // 「0 compartments」是真事实，必须仍然显示 0。
  assert.equal(rowsFor({ ...SAMPLE, compartmentCount: 0, droppedTagCount: 0 })[2].value, "0");
});