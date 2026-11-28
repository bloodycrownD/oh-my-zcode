#!/usr/bin/env node
/**
 * e2e-tool-media — magic-context-tool-media-roundtrip 的真实链路验证（不调模型）。
 *
 * 单测里宿主侧全走桩 transform、包侧只验 core 层，两半的衔接没有自动覆盖；
 * 这里用真实的 port（bootstrap 的 createMagicContextTurnTransform）+ 真实 transform
 * + 真实 sqlite tag 存储，把一条 Read 图片的工具结果送进去，回答三件事：
 *
 *   T-E1  上路：发给模型的 tool_result 里带 image 块，且与原块 JSON.stringify 逐字节相同。
 *   T-E2  复用：同一输入再跑一遍，带图条目的上路内容与上一轮逐字节相同，图片块仍与原块相同
 *         （打标会给 output 加 §N§ 前缀，所以带图条目每轮都会重建，这里断言的是稳定而不是不重建）。
 *   T-E3  drop：占用压到执行阈值之上，并给该 tag 排一条用户 ctx_reduce 的 pending drop（与真实 ctx_reduce 落
 *         pending_ops 同一张表、同一读取路径），下一 pass 把带图条目 drop 掉：上路内容
 *         只剩 `[dropped §N§]` 文本、没有媒体；tags 行的 drop 模式为 skeleton_stripped；
 *         再跑一遍仍是 drop 形态（持久化模式回放）。
 *
 * 占用读数由脚本自报（先低，drop 阶段压到 95%）；不装 historian 模型（createSidecarModel
 * 缺席），drop 走 pending_ops，不需要 historian。
 * 约束：不碰真实 ~/.omz（每次 mkdtemp 独立目录，跑完删除）；不调任何模型。
 * 用法：node docs/iterations/magic-context-tool-media-roundtrip/e2e/e2e-tool-media.mjs
 * MC_TM_E2E_KEEP=1 保留现场；MC_TM_E2E_DUMP=1 打印每次 pass 的上路条目与日志。
 * 退出码：0 = 全部断言通过；1 = 有失败断言 / 致命错误。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const KEEP = process.env.MC_TM_E2E_KEEP === "1";
const DUMP = process.env.MC_TM_E2E_DUMP === "1";
const WORK = mkdtempSync(join(tmpdir(), "zcode-mc-e2e-toolmedia-"));
if (KEEP || DUMP) console.log(`workdir: ${WORK}`);
process.env.MAGIC_CONTEXT_DB_DIR = WORK;
process.env.MAGIC_CONTEXT_LOG_PATH = join(WORK, "magic-context.log");
process.on("exit", () => {
  if (KEEP) return;
  try {
    rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* sqlite 句柄未释放时 EPERM：残留目录在 tmpdir 下，交给 OS 回收 */
  }
});

const REPO = new URL("../../../../", import.meta.url);
const CLI = new URL("apps/zcode-cli/packages/", REPO);
const SHARED_ROOT = new URL("packages/", REPO);
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const segments = specifier.split("/");
    const name = TS_SOURCE_PACKAGES.has(specifier)
      ? specifier
      : TS_SOURCE_PACKAGES.has(segments.slice(0, 2).join("/"))
        ? segments.slice(0, 2).join("/")
        : null;
    if (name !== null) {
      const sub = specifier === name ? "index" : specifier.slice(name.length + 1);
      for (const candidate of [
        new URL(`${name.slice(7)}/dist/${sub}.js`, SHARED_ROOT).href,
        new URL(`${name.slice(7)}/dist/${sub}/index.js`, SHARED_ROOT).href,
      ]) {
        const existsSync = fsExistsSync;
        if (existsSync(new URL(candidate))) return { url: candidate, shortCircuit: true };
      }
      throw new Error(`no compiled dist for "${specifier}"`);
    }
    return nextResolve(specifier, context);
  },
});
import { existsSync as fsExistsSync } from "node:fs";

// ── 断言账本 ─────────────────────────────────────────────────────────────────
let failed = 0;
function check(id, title, ok, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${title}${detail ? `  — ${detail}` : ""}`);
}

/** 一张 2×2 的不透明 PNG，base64 后几十字节，用来当 Read 图片的输出。 */
function makePng() {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.from([0, 200, 30, 30, 200, 30, 30, 0, 200, 30, 30, 200, 30, 30]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const SESSION = "sess_e2e-toolmedia-1";
const PNG = makePng();
const IMAGE_BLOCK = {
  type: "image",
  mediaType: "image/png",
  dataUrl: `data:image/png;base64,${PNG}`,
  source: {
    id: "read-image",
    kind: "inline",
    mimeType: "image/png",
    placeholder: "Read image",
    sizeBytes: 70,
  },
};
const WINDOW = 20_000;

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** 构造一轮对话：一段填充历史（制造占用）→ Read 图片 → 追问。 */
function buildEntries() {
  const filler = [];
  for (let i = 0; i < 40; i++) {
    filler.push({
      kind: "message",
      message: { role: "user", content: `filler question ${i} ${"x".repeat(600)}` },
    });
    filler.push({
      kind: "message",
      message: { role: "assistant", content: `filler answer ${i} ${"y".repeat(1400)}` },
    });
  }
  return [
    { kind: "message", message: { role: "user", content: "read a.png and describe it" } },
    {
      kind: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "reading" }],
        toolCalls: [{ id: "call_read_1", name: "Read", input: { file_path: "a.png" } }],
      },
    },
    {
      kind: "message",
      message: { role: "tool", toolCallId: "call_read_1", content: [clone(IMAGE_BLOCK)] },
    },
    ...filler,
    { kind: "message", message: { role: "user", content: "what was in the picture?" } },
  ];
}

function findToolResult(entries) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        (entry.kind ?? "message") === "message" &&
        entry.message?.role === "tool" &&
        entry.message.toolCallId === "call_read_1",
    );
}

/** 修复前的上路内容是字符串；非数组一律当作「没有媒体块」。 */
function nonTextBlocks(content) {
  return Array.isArray(content) ? content.filter((b) => b?.type !== "text") : [];
}

function describeToolContent(content) {
  if (typeof content === "string") return `string ${JSON.stringify(content)}`;
  return `[${(content ?? []).map((b) => (b?.type === "text" ? `text ${JSON.stringify(b.text)}` : b?.type)).join(", ")}]`;
}

async function main() {
  const mc = await import(new URL("magic-context/dist/index.js", CLI).href);
  const adapters = await import(new URL("adapters/dist/index.js", CLI).href);
  const { createMagicContextTurnTransform } = await import(
    new URL("bootstrap/dist/app/magic-context-turn-transform.js", CLI).href
  );

  const db = mc.openDatabase(mc.getMagicContextDatabasePath());
  const store = adapters.createSqliteSessionStore({ dbPath: join(WORK, "db.sqlite") });

  // 占用读数由测试自报；不装 historian 模型（createSidecarModel 缺席）。
  const contextUsageMap = new Map();
  const usageRecorder = {
    contextUsageMap,
    prime() {},
    noteLiveModel() {},
    record() {},
    readUsage: () => contextUsageMap.get(SESSION)?.usage ?? null,
    onUsageRecorded() {},
  };
  const setUsage = (inputTokens, percentage) => {
    const now = Date.now();
    contextUsageMap.set(SESSION, {
      hasUsageTokens: true,
      lastResponseTime: now,
      updatedAt: now,
      usage: { inputTokens, percentage },
    });
  };

  const logs = [];
  // 任意级别都收：port 用哪些方法以实际调用为准。
  const logger = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "child"
          ? () => logger
          : (...args) => {
              logs.push({
                level: String(key),
                args: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))),
              });
            },
    },
  );
  const closeHooks = [];
  const port = await createMagicContextTurnTransform({
    enabled: true,
    configDomain: {},
    sessionId: SESSION,
    workingDirectory: WORK,
    logger,
    sessionStore: store,
    processExitsAfterTurn: false,
    usageRecorder,
    registerClose: (close) => closeHooks.push(close),
  });
  if (!port) throw new Error("magic-context port unavailable");

  const model = {
    providerId: "e2e",
    modelId: "e2e-no-network",
    properties: { contextWindow: WINDOW },
  };
  const runPass = async (label, entries) => {
    const startedAt = performance.now();
    try {
      const result = await port({ entries, model, sessionId: SESSION, workingDirectory: WORK });
      const tools = findToolResult(result.entries);
      console.log(
        `\n[${label}] ${Math.round(performance.now() - startedAt)}ms outcome=${result.outcome} entries=${result.entries.length} tool_results=${tools.length}`,
      );
      for (const { index, entry } of tools) {
        console.log(`  #${index} ${describeToolContent(entry.message.content)}`);
      }
      const tags = db
        .prepare(
          `SELECT tag_number AS n, status, drop_mode, message_role AS role FROM tags WHERE session_id = ? ORDER BY tag_number ASC`,
        )
        .all(SESSION);
      const dropped = tags.filter((t) => t.drop_mode && t.drop_mode !== "full");
      console.log(
        `  tags=${tags.length} dropped=${dropped.length} modes=${[...new Set(dropped.map((t) => t.drop_mode))].join("/") || "-"}`,
      );
      if (DUMP) {
        writeFileSync(
          join(WORK, `entries-${label}.json`),
          JSON.stringify(result.entries, null, 1),
          "utf8",
        );
        writeFileSync(join(WORK, `tags-${label}.json`), JSON.stringify(tags, null, 1), "utf8");
        writeFileSync(
          join(WORK, `log-${label}.json`),
          JSON.stringify(logs.splice(0), null, 1),
          "utf8",
        );
      } else {
        logs.length = 0;
      }
      return { label, ok: true, entries: result.entries, outcome: result.outcome, tools, tags };
    } catch (error) {
      console.log(`\n[${label}] threw ${error?.constructor?.name}: ${error?.message}`);
      if (DUMP) console.log(error?.stack);
      return { label, ok: false, error: `${error?.constructor?.name}: ${error?.message}` };
    }
  };

  setUsage(1000, 5);
  // 运行时的 canonical 历史在同一会话内是同一份数组：两次 pass 喂同一个输入对象。
  const entries = buildEntries();
  const pass1 = await runPass("P1-上路", entries);
  const pass2 = await runPass("P2-复用", entries);

  // 占用压到执行阈值之上：pending ops 只在 scheduler 判 execute 的 pass 才应用。
  setUsage(WINDOW * 0.95, 95);
  // 用户 ctx_reduce 的 pending drop：与 storage-ops.ts 的 queuePendingOp 同一条 INSERT。
  const harness =
    db.prepare("SELECT DISTINCT harness AS h FROM tags WHERE session_id = ?").get(SESSION)?.h ??
    "opencode";
  const toolTag = db
    .prepare(
      "SELECT tag_number AS n FROM tags WHERE session_id = ? AND message_role IS NULL ORDER BY tag_number ASC LIMIT 1",
    )
    .get(SESSION);
  console.log(`
排 pending drop：harness=${harness} tool_tag=${toolTag?.n ?? "未找到"}`);
  if (toolTag) {
    db.prepare(
      "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, ?)",
    ).run(SESSION, toolTag.n, Date.now(), harness);
  }
  const pass3 = await runPass("P3-drop", entries);
  const pass4 = await runPass("P4-drop-again", entries);

  console.log("");
  if (pass1.ok) {
    const tool = pass1.tools[0]?.entry?.message;
    check(
      "T-E1a",
      "上路：tool_result 仍在请求里且恰有一条",
      pass1.tools.length === 1,
      `count=${pass1.tools.length}`,
    );
    check(
      "T-E1b",
      "上路：tool_result 的 content 是 image 块，与原块逐字节相同",
      JSON.stringify(nonTextBlocks(tool?.content)) === JSON.stringify([IMAGE_BLOCK]),
      describeToolContent(tool?.content),
    );
  } else check("T-E1", "上路：pass 没有抛错", false, pass1.error);

  if (pass1.ok && pass2.ok) {
    const a = pass1.tools[0]?.entry;
    const b = pass2.tools[0]?.entry;
    check(
      "T-E2a",
      "复用：第二次 pass 的带图条目上路内容与第一次逐字节相同",
      JSON.stringify(a?.message?.content) === JSON.stringify(b?.message?.content),
      describeToolContent(b?.message?.content),
    );
    check(
      "T-E2b",
      "复用：第二次 pass 里图片块仍与原块逐字节相同",
      JSON.stringify(nonTextBlocks(b?.message?.content)) === JSON.stringify([IMAGE_BLOCK]),
    );
  } else check("T-E2", "复用：pass 没有抛错", false, pass2.error ?? pass1.error);

  const last = pass4.ok ? pass4 : pass3;
  if (last.ok) {
    const tool = last.tools[0]?.entry?.message;
    const content = tool?.content;
    const texts = Array.isArray(content) ? content.filter((b) => b?.type === "text") : [];
    const media = nonTextBlocks(content);
    const row = last.tags.find((t) => t.n === toolTag?.n);
    check(
      "T-E3a",
      "drop：带图条目被 drop，上路只剩一条 `[dropped §N§]` 文本",
      texts.length === 1 && /^\[dropped §\d+§\]$/.test(texts[0]?.text ?? ""),
      describeToolContent(content),
    );
    check(
      "T-E3b",
      "drop：上路内容里没有媒体块",
      media.length === 0,
      `${media.length} 个非 text 块`,
    );
    check(
      "T-E3c",
      "drop：tags 行的 drop 模式是 skeleton_stripped",
      row?.drop_mode === "skeleton_stripped",
      `drop_mode=${row?.drop_mode ?? "无"}`,
    );
  } else check("T-E3", "drop：pass 没有抛错", false, last.error);

  for (const close of closeHooks) await close();
  db.close?.();
  await store.close?.();
  console.log(failed === 0 ? "\n全部通过" : `\n${failed} 条失败`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
