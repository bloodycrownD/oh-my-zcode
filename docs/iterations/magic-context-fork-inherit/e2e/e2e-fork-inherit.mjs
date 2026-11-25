#!/usr/bin/env node
/* oxlint-disable max-lines -- e2e 过程产物：真实库拷贝 + 三场景断言矩阵，拆分无收益 */
/**
 * e2e-fork-inherit — magic-context-fork-inherit 真机数据验证。
 *
 * 用真实数据回答一个问题：对一个已经折叠了很多的长会话做 fork，子会话的首轮请求
 * 是否和父会话的常态同形（折叠内容变成占位符 + 摘要，system prompt 与未折叠的近期
 * 消息都在），而不是把全部历史原文发出去。
 *
 * 场景（同一个隔离临时目录，按顺序执行）：
 *
 *   准备  真实库只读拷贝：magic-context.db 三件套 + db.sqlite 三件套 → 临时目录。
 *         用真实 sqlite session store 读出父会话的消息行，用真实 hydrator 还原成
 *         运行时条目，前面加一条 system、后面加一条新的 user，当作 fork 子会话首轮
 *         交给 transform 的条目。
 *   E2E-0  基线（今天的行为，不登记 fork）：同一个子会话跑一轮，记录请求的条数、
 *         字符量、是否被拒发。这是用来对照的「未修复」形态。
 *   E2E-1  继承（登记 fork）：另一个全新子会话跑一轮，断言：继承成功；请求里 system
 *         在、新问题在、父会话已折叠的原文不在、占位符数量与父会话 dropped 的
 *         message/file tag 数量相当；请求字符量远小于基线。
 *   E2E-2  账本自洽：子会话的 compartments 从 1 起逐舱无缝，末端 ≤ 条目数；heal 没有
 *         清账；子会话的 source_contents 已由首轮回填（ctx_expand 有原文可取）。
 *
 * 约束：
 *   - 真实库只作为 copyFileSync 的源，绝不打开、绝不写入；
 *   - MAGIC_CONTEXT_DB_DIR / MAGIC_CONTEXT_LOG_PATH 在 dynamic import dist 之前设置；
 *   - 不调用任何模型；可重复执行，每次 mkdtemp 生成独立目录（MC_E2E_KEEP=1 保留）。
 *
 * 用法：
 *   node docs/iterations/magic-context-fork-inherit/e2e/e2e-fork-inherit.mjs
 *   MC_E2E_PARENT=<sessionId> MC_E2E_KEEP=1 node ...
 *   MC_E2E_DEBUG_ALIGN=1 node ...   // 额外打印父会话原文与子会话文本为何对不上 
 *
 * 退出码：0 = 全部断言通过；1 = 存在失败断言 / 致命错误。
 */

import {
    copyFileSync,
    existsSync,
    mkdtempSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KEEP = process.env.MC_E2E_KEEP === "1";
const WORK = mkdtempSync(join(tmpdir(), "zcode-mc-e2e-fork-"));
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
const distUrl = (pkg, relative) => new URL(`${pkg}/dist/${relative}`, CLI).href;
const SHARED_ROOT = new URL("packages/", REPO);
const TS_SOURCE_PACKAGES = new Set(["@zcode/shared", "@zcode/model-option-map"]);

// @zcode/shared / @zcode/model-option-map 的入口发布的是原始 TypeScript，与
// bootstrap/scripts/test-magic-context-session-isolation.mjs 同一手法指到 dist。
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
                if (existsSync(new URL(candidate))) return { url: candidate, shortCircuit: true };
            }
            throw new Error(`no compiled dist for "${specifier}"`);
        }
        return nextResolve(specifier, context);
    },
});

// ── 断言账本 ─────────────────────────────────────────────────────────────────

const cases = [];
let failed = 0;

function check(id, name, pass, detail) {
    if (!pass) failed += 1;
    cases.push({ id, name, pass });
    console.log(`  ${pass ? "ok  " : "FAIL"} ${id} ${name}${detail === undefined ? "" : `  (${detail})`}`);
}

/**
 * 线上形态检查：请求里每个工具调用都必须有对应的工具结果，每个工具结果都必须有调用。
 * 模型提供方对「有调用没结果」的请求直接拒收（Tool results are missing for tool calls）。
 */
function danglingToolArcs(entries) {
    const openCalls = new Set();
    const orphanResults = [];
    for (const entry of entries) {
        if (entry.kind === "attachment") continue;
        const message = entry.message;
        if (!message) continue;
        for (const call of message.toolCalls ?? []) openCalls.add(call.id);
        if (message.role === "tool") {
            if (openCalls.has(message.toolCallId)) openCalls.delete(message.toolCallId);
            else orphanResults.push(message.toolCallId);
        }
    }
    return { missingResults: [...openCalls], orphanResults };
}

function textOf(entries) {
    let text = "";
    for (const entry of entries) {
        if (entry.kind === "attachment") text += `\n${entry.content}`;
        else {
            const content = entry.message?.content;
            text += `\n${typeof content === "string" ? content : JSON.stringify(content ?? "")}`;
        }
    }
    return text;
}

async function main() {
    const realDbDir = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".omz", "cli", "db");
    for (const file of [
        "magic-context.db",
        "magic-context.db-wal",
        "magic-context.db-shm",
        "db.sqlite",
        "db.sqlite-wal",
        "db.sqlite-shm",
    ]) {
        const source = join(realDbDir, file);
        if (!existsSync(source)) continue;
        const startedAt = Date.now();
        copyFileSync(source, join(WORK, file));
        console.log(`copy ${file} ${(statSync(source).size / 1048576).toFixed(0)}MB ${Date.now() - startedAt}ms`);
    }

    const mc = await import(distUrl("magic-context", "index.js"));
    const core = await import(distUrl("core", "index.js"));
    const adapters = await import(distUrl("adapters", "index.js"));
    const { createMagicContextTurnTransform } = await import(
        distUrl("bootstrap", "app/magic-context-turn-transform.js"),
    );
    const { noteForkedSession } = await import(distUrl("bootstrap", "app/session-fork-registry.js"));

    // ── 选父会话：dropped 最多的那个 ────────────────────────────────────────
    const db = mc.openDatabase(mc.getMagicContextDatabasePath());
    const parent = (
        process.env.MC_E2E_PARENT
            ? [{ id: process.env.MC_E2E_PARENT }]
            : db
                  .prepare(
                      `SELECT session_id AS id FROM tags GROUP BY session_id
                       ORDER BY SUM(status = 'dropped') DESC LIMIT 1`,
                  )
                  .all()
    )[0];
    const parentId = parent.id;
    const parentStats = db
        .prepare(
            `SELECT
                 (SELECT COUNT(*) FROM tags WHERE session_id = ? AND status = 'dropped') AS dropped,
                 (SELECT COUNT(*) FROM tags WHERE session_id = ? AND status = 'dropped' AND type != 'tool') AS droppedText,
                 (SELECT COUNT(*) FROM compartments WHERE session_id = ?) AS compartments,
                 (SELECT COALESCE(MAX(end_message), 0) FROM compartments WHERE session_id = ?) AS lastEnd`,
        )
        .get(parentId, parentId, parentId, parentId);
    console.log(`\n父会话 ${parentId}`);
    console.log(
        `  dropped tag ${parentStats.dropped}（其中文本类 ${parentStats.droppedText}），摘要块 ${parentStats.compartments}，末端 ${parentStats.lastEnd}`,
    );

    // ── 真实 store + 真实 hydrator：父会话的消息行 → 运行时条目 ─────────────
    const store = adapters.createSqliteSessionStore({ dbPath: join(WORK, "db.sqlite") });
    // MC_E2E_ROWS_SESSION：条目可以取自另一个会话的消息行（例如真实 fork 出的子会话）。
    const rowsSessionId = process.env.MC_E2E_ROWS_SESSION ?? parentId;
    const messages = await store.messages({ sessionID: rowsSessionId });
    const history = core.createMessageHistory();
    const hydrated = await core.hydrateMessageHistoryFromSession({ history, messages });
    const conversation = history.borrowReadOnlyRuntimeEntries();
    console.log(`  消息行 ${messages.length} → 运行时条目 ${conversation.length}（${hydrated.partCount} parts）`);
    if (process.env.MC_E2E_DUMP_AROUND) {
        const describe = (entry) => {
            const m = entry.message;
            if (!m) return `[${entry.kind}] ${String(entry.content).slice(0, 40)}`;
            const parts = [];
            if (m.toolCalls?.length) parts.push(`calls=${m.toolCalls.map((c) => c.id.slice(0, 14) + ":" + c.name).join(",")}`);
            if (m.role === "tool") parts.push(`result=${String(m.toolCallId).slice(0, 14)}:${m.toolName} len=${String(m.content).length}`);
            const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
            return `[${m.role}] ${parts.join(" ")} ${c.slice(0, 46).replace(/\n/g, "\\n")}`;
        };
        const [from, to] = process.env.MC_E2E_DUMP_AROUND.split("-").map(Number);
        const dump = [
            `rows session ${rowsSessionId}: rows=${messages.length} entries=${conversation.length}`,
            ...conversation.slice(from - 1, to).map((entry, index) => `  mc${from + index} ${describe(entry)}`),
        ];
        const results = new Map();
        for (const entry of conversation) if (entry.message?.role === "tool") results.set(entry.message.toolCallId, (results.get(entry.message.toolCallId) ?? 0) + 1);
        const calls = new Set();
        for (const entry of conversation) for (const call of entry.message?.toolCalls ?? []) calls.add(call.id);
        dump.push(
            `  result entries=${[...results.values()].reduce((a, b) => a + b, 0)} distinct=${results.size} with2plus=${[...results.values()].filter((n) => n > 1).length}`,
            `  invocation callIds=${calls.size}; result callIds not invoked=${[...results.keys()].filter((c) => !calls.has(c)).length}`,
        );
        const by = {};
        for (const m of messages) for (const p of m.parts) if (p.type === "tool") { const k = `${m.info.role}/${p.state?.status}/${typeof p.state?.output === "string"}`; by[k] = (by[k] ?? 0) + 1; }
        dump.push(`  persisted tool parts role/status/hasOutput: ${JSON.stringify(by)}`);
        writeFileSync(join(WORK, "entries-debug.txt"), dump.join("\n"), "utf8");
        console.log(`  条目诊断已写入 ${join(WORK, "entries-debug.txt")}`);
    }

    const SYSTEM_MARKER = "e2e: you are the system prompt of the forked child";
    const NEW_QUESTION = "e2e: this is the first question in the forked child session";
    const childEntries = [
        { kind: "message", message: { role: "system", content: SYSTEM_MARKER } },
        ...conversation,
        { kind: "message", message: { role: "user", content: NEW_QUESTION } },
    ];
    const rawChars = textOf(childEntries).length;

    const closeHooks = [];
    const logs = [];
    const makeLogger = () => ({
        info(message, context) {
            logs.push({ level: "info", message, context });
        },
        warn(message, context) {
            logs.push({ level: "warn", message, context });
        },
        error(message, context) {
            logs.push({ level: "error", message, context });
        },
        debug() {},
        child() {
            return this;
        },
    });
    const runChildFor = async (sessionId, entriesForRun) => {
        const logger = makeLogger();
        const port = await createMagicContextTurnTransform({
            enabled: true,
            configDomain: {},
            sessionId,
            workingDirectory: WORK,
            logger,
            sessionStore: store,
            processExitsAfterTurn: false,
            registerClose: (close) => closeHooks.push(close),
        });
        if (!port) throw new Error("magic-context port unavailable");
        const startedAt = performance.now();
        try {
            const result = await port({
                entries: entriesForRun.map((entry) => structuredClone(entry)),
                model: { providerId: "zcode", modelId: "glm-4.6" },
                sessionId,
                workingDirectory: WORK,
            });
            const text = textOf(result.entries);
            lastText = text;
            lastShape = danglingToolArcs(result.entries);
            if (process.env.MC_E2E_SECOND_PASS === "1") {
                const second = await port({
                    entries: result.entries.map((entry) => structuredClone(entry)),
                    model: { providerId: "zcode", modelId: "glm-4.6" },
                    sessionId,
                    workingDirectory: WORK,
                });
                const secondShape = danglingToolArcs(second.entries);
                console.log(
                    `  [second pass] ${sessionId}：请求 ${second.entries.length} 条，有调用没结果 ${secondShape.missingResults.length}，有结果没调用 ${secondShape.orphanResults.length}；compartments=${mc.getCompartments(db, sessionId).length}`,
                );
                if (secondShape.missingResults.length > 0) {
                    console.log(`    [second pass] 孤儿调用样本：${JSON.stringify(secondShape.missingResults.slice(0, 4))}`);
                }
            }
            return {
                ok: true,
                outcome: result.outcome,
                ms: Math.round(performance.now() - startedAt),
                entries: result.entries.length,
                chars: text.length,
                tokensEstimate: Math.round(text.length / 3),
                hasSystem: text.includes(SYSTEM_MARKER),
                hasQuestion: text.includes(NEW_QUESTION),
                placeholders: (text.match(/\[dropped §\d+§\]/g) ?? []).length,
                shape: lastShape,
                logs,
            };
        } catch (error) {
            return {
                ok: false,
                ms: Math.round(performance.now() - startedAt),
                error: `${error?.constructor?.name ?? "Error"}: ${error?.message ?? error}`,
                logs,
            };
        }
    };

    const runChild = (sessionId) => runChildFor(sessionId, childEntries);

    // ── E2E-0 基线：不登记 fork ──────────────────────────────────────────────
    console.log("\nE2E-0 基线（不登记 fork，今天的行为）");
    const baselineId = "sess_e2e_fork_baseline";
    const baseline = await runChild(baselineId);
    if (baseline.ok) {
        console.log(
            `  请求 ${baseline.entries} 条，约 ${baseline.chars} 字符（≈${baseline.tokensEstimate} tokens），占位符 ${baseline.placeholders}，${baseline.ms}ms，outcome=${baseline.outcome}`,
        );
    } else {
        console.log(`  被拒发（${baseline.ms}ms）：${baseline.error}`);
    }

    // ── 调试：父会话原文 vs 子会话文本，为什么对不上 ────────────────────────
    if (process.env.MC_E2E_DEBUG_ALIGN === "1") {
        const { stripTagPrefix } = await import(
            distUrl("magic-context", "core/hooks/magic-context/tag-content-primitives.js"),
        );
        const childTexts = [];
        const stampedOnly = [];
        for (const entry of childEntries) {
            const content = entry.message?.content;
            const blocks = typeof content === "string" ? [{ text: content }] : Array.isArray(content) ? content : [];
            for (const block of blocks) {
                if (block?.type !== "text" || typeof block.text !== "string") continue;
                const stripped = stripTagPrefix(block.text);
                if (stripped.trim()) childTexts.push(stripped);
                else if (block.text.trim()) stampedOnly.push({ role: entry.message.role, raw: block.text.slice(0, 80) });
            }
        }
        const samples = db.prepare(
            `SELECT t.tag_number AS n, t.message_id AS mid, t.status AS st, t.message_role AS role, s.content AS content
              FROM tags t JOIN source_contents s ON s.session_id = t.session_id AND s.tag_id = t.tag_number
             WHERE t.session_id = ? AND t.type = 'message' ORDER BY t.tag_number ASC`,
        ).all(parentId);
        console.log(`  父会话 message 类原文 ${samples.length} 条；子会话文本 part（剥章后）${childTexts.length} 条；剥章后为空 ${stampedOnly.length} 条`);
        if (stampedOnly.length) console.log(`  剥章后为空的样本：${JSON.stringify(stampedOnly.slice(0, 3))}`);
        let exact = 0; const misses = [];
        for (const row of samples) {
            if (childTexts.includes(row.content)) exact += 1;
            else misses.push(row);
        }
        console.log(`  逐字相等：${exact} / ${samples.length}`);
        const byRole = {}; for (const m of misses) byRole[m.role ?? "null"] = (byRole[m.role ?? "null"] ?? 0) + 1;
        console.log(`  未命中按 role：${JSON.stringify(byRole)}`);
        const sourceSet = new Set(samples.map((x) => x.content));
        const childUnmatched = [];
        childEntries.forEach((entry, index) => {
            const content = entry.message?.content;
            const blocks =
                typeof content === "string"
                    ? [{ text: content }]
                    : Array.isArray(content)
                      ? content.filter((x) => x?.type === "text")
                      : [];
            for (const block of blocks) {
                if (typeof block.text === "string" && block.text.trim() && !sourceSet.has(stripTagPrefix(block.text))) {
                    childUnmatched.push({ index, role: entry.message.role, len: block.text.length, head: block.text.slice(0, 200) });
                }
            }
        });
        const childRoleCount = {};
        for (const u of childUnmatched) childRoleCount[u.role] = (childRoleCount[u.role] ?? 0) + 1;
        console.log(`  子会话文本 part 不在父原文集合里：${childUnmatched.length}；按 role：${JSON.stringify(childRoleCount)}`);
        const mid = Math.floor(misses.length / 2);
        const pick = (role, from) =>
            childUnmatched.filter((u) => u.role === role).slice(from, from + 4)
                .map((u) => `CHILD ${role} idx ${u.index} [${u.len}] ${JSON.stringify(u.head)}`);
        const debugFile = join(WORK, "align-debug.txt");
        writeFileSync(
            debugFile,
            [
                ...misses.slice(mid, mid + 5).map((m) => `PARENT tag ${m.n} status=${m.st} [${m.content.length}] ${JSON.stringify(m.content.slice(0, 260))}`),
                ...pick("user", 200),
                ...pick("assistant", 400),
            ].join("\n"),
            "utf8",
        );
        console.log(`  样本已写入 ${debugFile}`);
        for (const m of misses.slice(mid, mid + 2)) {
            const head = m.content.slice(0, 30);
            const near = childTexts.find((t) => t.slice(0, 20) === head.slice(0, 20)) ?? childTexts.find((t) => t.includes(head.slice(0, 12)));
            console.log(`  --- tag ${m.n} role=${m.role} status=${m.st} id=${m.mid}`);
            console.log(`      父原文[${m.content.length}]: ${JSON.stringify(m.content.slice(0, 110))}`);
            console.log(`      子近似[${near?.length ?? -1}]: ${JSON.stringify(near?.slice(0, 110) ?? null)}`);
        }
    }

    // ── E2E-1 继承：登记 fork ────────────────────────────────────────────────
    console.log("\nE2E-1 继承（登记 fork）");
    const childId = "sess_e2e_fork_child";
    noteForkedSession(parentId, childId);
    const child = await runChild(childId);
    if (!child.ok) {
        check("1.0", "子会话首轮请求成功发出", false, child.error);
    } else {
        console.log(
            `  请求 ${child.entries} 条，约 ${child.chars} 字符（≈${child.tokensEstimate} tokens），占位符 ${child.placeholders}，${child.ms}ms，outcome=${child.outcome}`,
        );
        const inherit = child.logs.find((line) => line.message.includes("fork inherit"));
        console.log(`  继承结果：${JSON.stringify(inherit?.context ?? null)}`);
        check("1.0", "子会话首轮请求成功发出", true);
        check("1.1", "继承结果为 inherited", inherit?.context?.kind === "inherited", inherit?.context?.kind);
        check("1.3", "新问题留在请求里", child.hasQuestion);
        // 折叠的消息不一定各留一个占位符：只剩工具调用的空壳消息会被整条移出，
        // 同一条消息里的多个 part 也可能并成一个占位符。所以只断言「有占位符」
        // 与「请求条数明显少于基线」，逐 tag 的覆盖由 1.5 的原文抽样与 E2E-2 的账本把关。
        check(
            "1.4",
            "请求里有折叠占位符",
            child.placeholders > 0,
            `${child.placeholders}`,
        );

        // 父会话已折叠的原文：抽 30 条 dropped 的 source_contents，正文（取前 60 个字符）
        // 不得出现在子会话请求里。
        const droppedSources = db
            .prepare(
                `SELECT s.content AS content,
                        (SELECT COUNT(*) FROM tags t2 JOIN source_contents s2 ON s2.session_id = t2.session_id AND s2.tag_id = t2.tag_number
                          WHERE t2.session_id = t.session_id AND substr(s2.content, 1, 60) = substr(s.content, 1, 60)) AS copies
                   FROM tags t JOIN source_contents s
                     ON s.session_id = t.session_id AND s.tag_id = t.tag_number
                 WHERE t.session_id = ? AND t.status = 'dropped' AND t.type = 'message' AND LENGTH(s.content) >= 60
                 ORDER BY RANDOM() LIMIT 30`,
            )
            .all(parentId);
        const childText = lastText;
        const leaked = droppedSources.filter((row) => childText.includes(row.content.slice(0, 60)));
        const leakedUnique = leaked.filter((row) => row.copies === 1);
        const leakedBoilerplate = leaked.filter((row) => row.copies > 1);
        console.log(
            `  原文抽样 ${droppedSources.length} 条：泄漏 ${leaked.length}（其中父会话里独一份的 ${leakedUnique.length}，重复出现的样板 ${leakedBoilerplate.length}）`,
        );
        writeFileSync(
            join(WORK, "leak-debug.txt"),
            [
                ...leakedUnique.slice(0, 5).map((row) => `UNIQUE copies=${row.copies} [${row.content.length}] ${JSON.stringify(row.content.slice(0, 200))}`),
                ...leakedBoilerplate.slice(0, 3).map((row) => `BOILERPLATE copies=${row.copies} [${row.content.length}] ${JSON.stringify(row.content.slice(0, 160))}`),
            ].join("\n"),
            "utf8",
        );
        check(
            "1.5",
            "父会话里独一份的已折叠原文不在请求里（抽样）",
            leakedUnique.length === 0,
            `泄漏 ${leakedUnique.length} 条`,
        );
        const toolLedger = db
            .prepare(
                `SELECT
                     (SELECT COUNT(*) FROM tags WHERE session_id = ? AND type = 'tool' AND status = 'dropped') AS parentTools,
                     (SELECT COUNT(*) FROM tags WHERE session_id = ? AND type = 'tool' AND status = 'dropped') AS childTools,
                     (SELECT COUNT(*) FROM tags WHERE session_id = ? AND type = 'message' AND status = 'dropped') AS parentTexts,
                     (SELECT COUNT(*) FROM tags WHERE session_id = ? AND type = 'message' AND status = 'dropped') AS childTexts`,
            )
            .get(parentId, childId, parentId, childId);
        console.log(
            `  覆盖：文本 ${toolLedger.childTexts}/${toolLedger.parentTexts}，工具 ${toolLedger.childTools}/${toolLedger.parentTools}`,
        );
        // 子会话继承范围之内仍是 active 的文本：按开头 50 字符归并，看未折叠的体积花在了哪里。
        const activeGroups = db
            .prepare(
                `SELECT substr(s.content, 1, 50) AS head, COUNT(*) AS n, SUM(LENGTH(s.content)) AS chars
                     FROM tags t JOIN source_contents s ON s.session_id = t.session_id AND s.tag_id = t.tag_number
                  WHERE t.session_id = ? AND t.status = 'active' AND t.type = 'message'
                  GROUP BY head ORDER BY chars DESC LIMIT 8`,
            )
            .all(childId);
        const totalActiveChars = db
            .prepare(
                `SELECT COALESCE(SUM(LENGTH(s.content)), 0) AS chars FROM tags t JOIN source_contents s
                     ON s.session_id = t.session_id AND s.tag_id = t.tag_number
                  WHERE t.session_id = ? AND t.status = 'active' AND t.type = 'message'`,
            )
            .get(childId).chars;
        console.log(`  子会话 active 文本共 ${totalActiveChars} 字符；构成（前 8 组）：`);
        for (const g of activeGroups) console.log(`    ${String(g.n).padStart(5)} 条 ${String(g.chars).padStart(7)} 字符  ${JSON.stringify(g.head.slice(0, 44))}`);
        writeFileSync(
            join(WORK, "active-groups.txt"),
            activeGroups.map((g) => `${g.n}\t${g.chars}\t${g.head}`).join("\n"),
            "utf8",
        );

        if (baseline.ok) {
            check(
                "1.6",
                "请求字符量远小于基线（≤ 50%）",
                child.chars <= baseline.chars * 0.5,
                `${child.chars} vs ${baseline.chars}`,
            );
        } else {
            check("1.6", "基线被拒发而继承后请求成功发出", true);
        }
    }

    // ── E2E-2 账本自洽 ──────────────────────────────────────────────────────
    console.log("\nE2E-2 账本自洽");
    const ledger = db
        .prepare(
            `SELECT COUNT(*) AS compartments,
                    COALESCE(MAX(end_message), 0) AS lastEnd,
                    COALESCE(MIN(start_message), 0) AS firstStart,
                    SUM(CASE WHEN prev_end IS NOT NULL AND start_message != prev_end + 1 THEN 1 ELSE 0 END) AS gaps
             FROM (SELECT c.*, LAG(end_message) OVER (ORDER BY sequence) AS prev_end
                     FROM compartments c WHERE session_id = ?)`,
        )
        .get(childId);
    const childDropped = db
        .prepare(`SELECT COUNT(*) AS count FROM tags WHERE session_id = ? AND status = 'dropped'`)
        .get(childId).count;
    const childSources = db
        .prepare(`SELECT COUNT(*) AS count FROM source_contents WHERE session_id = ?`)
        .get(childId).count;
    console.log(`  摘要块 ${ledger.compartments}，区间 ${ledger.firstStart}..${ledger.lastEnd}，空洞 ${ledger.gaps}；dropped tag ${childDropped}；source_contents ${childSources}`);
    check("2.0", "摘要块全部继承", ledger.compartments === parentStats.compartments, `${ledger.compartments} / ${parentStats.compartments}`);
    check("2.1", "区间从 1 起逐舱无缝", ledger.firstStart === 1 && ledger.gaps === 0);
    check(
        "2.2",
        "末端是子会话坐标且不超过条目数",
        ledger.lastEnd > 0 && ledger.lastEnd <= childEntries.length,
        `${ledger.lastEnd} ≤ ${childEntries.length}`,
    );
    check(
        "2.3",
        "heal 没有清账（末端相对父会话原值被换算过）",
        ledger.lastEnd !== parentStats.lastEnd,
        `${ledger.lastEnd} vs 父 ${parentStats.lastEnd}`,
    );
    check("2.4", "子会话已有 dropped tag", childDropped > 0, String(childDropped));
    check("2.5", "子会话的 source_contents 已回填（ctx_expand 有原文）", childSources > 0, String(childSources));

    // ── 参照：父会话自己的请求（用它自己的 magic-context 状态，即日常运行形态）
    {
        const selfEntries = [
            { kind: "message", message: { role: "system", content: SYSTEM_MARKER } },
            ...conversation,
            { kind: "message", message: { role: "user", content: NEW_QUESTION } },
        ];
        const self = await runChildFor(parentId, selfEntries);
        if (self.ok) {
            console.log(
                `  父会话自身：请求 ${self.entries} 条（原始 ${selfEntries.length}），约 ${self.chars} 字符，占位符 ${self.placeholders}，有调用没结果 ${self.shape.missingResults.length}；system在=${lastText.includes(SYSTEM_MARKER)}，新问题在=${lastText.includes(NEW_QUESTION)}，摘要头=${lastText.includes("<session-history>")}，基线边界=${JSON.stringify(db.prepare("SELECT cached_m0_last_baseline_end_message_id AS b, cached_m0_bytes IS NOT NULL AS m0 FROM session_meta WHERE session_id = ?").get(parentId))}，${self.ms}ms`,
            );
            console.log(
                `  父会话自身：system 在=${lastText.includes(SYSTEM_MARKER)}，摘要头=${lastText.includes("<session-history>")}，新问题在=${lastText.includes(NEW_QUESTION)}；基线边界=${JSON.stringify(db.prepare("SELECT cached_m0_last_baseline_end_message_id AS b, cached_m0_bytes IS NOT NULL AS m0 FROM session_meta WHERE session_id = ?").get(parentId))}`,
            );
        if (child.ok) {
            const inheritContext = child.logs.find((line) => line.message.includes("fork inherit"))?.context;
            // 父会话裁前缀时连 system prompt 一起裁掉（既有行为，见 spec 末尾）；子会话只要求与它一致。
            check(
                "1.2",
                "system prompt 的去留与父会话自身一致",
                child.hasSystem === self.hasSystem,
                `父=${self.hasSystem} 子=${child.hasSystem}`,
            );
            if (inheritContext?.trims === true) {
                check(
                    "1.7",
                    "继承后的请求与父会话自身同量级（条数与字符量都不超过 1.5 倍）",
                    child.entries <= self.entries * 1.5 && child.chars <= self.chars * 1.5,
                    `${child.entries} 条 / ${child.chars} 字符 vs 父 ${self.entries} 条 / ${self.chars} 字符`,
                );
            } else {
                console.log(`  继承结果未裁前缀：${JSON.stringify(inheritContext)}`);
            }
        }
    } else console.log(`  父会话自身：失败 ${self.error}`);
    }


    // ── E2E-3 线上形态 ──────────────────────────────────────────────────────
    console.log("\nE2E-3 线上形态（工具调用与结果成对）");
    const shapeOf = (run, label) => {
        const missing = run.shape?.missingResults.length ?? -1;
        const orphan = run.shape?.orphanResults.length ?? -1;
        console.log(`  ${label}：有调用没结果 ${missing}，有结果没调用 ${orphan}`);
        if (missing > 0) {
            const sample = run.shape.missingResults.slice(0, 3);
            const rows = sample.flatMap((callId) =>
                db
                    .prepare(
                        `SELECT tag_number AS n, status AS s, tool_owner_message_id AS o FROM tags WHERE session_id = ? AND message_id = ?`,
                    )
                    .all(run.sessionId, callId),
            );
            console.log(`    样本调用 ${JSON.stringify(sample.map((id) => id.slice(0, 18)))}；子会话里的 tag：${JSON.stringify(rows)}`);
        }
        return missing === 0;
    };
    baseline.sessionId = baselineId;
    child.sessionId = childId;
    if (baseline.ok) shapeOf(baseline, "基线（不继承）");
    check("3.0", "继承后的请求里没有「有调用没结果」的孤儿", child.ok && shapeOf(child, "继承后"));

    for (const close of closeHooks) await close();
    db.close?.();
    await store.close?.();
}

let lastText = "";
let lastShape = { missingResults: [], orphanResults: [] };

try {
    await main();
} catch (error) {
    failed += 1;
    console.error("\n致命错误：", error?.stack ?? error);
}

console.log(`\n${cases.filter((c) => c.pass).length}/${cases.length} 通过，失败 ${failed}`);
if (KEEP) console.log(`现场保留：${WORK}`);
process.exit(failed === 0 ? 0 : 1);
