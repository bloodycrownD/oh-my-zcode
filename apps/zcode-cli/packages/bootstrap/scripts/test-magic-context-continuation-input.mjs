#!/usr/bin/env node
/**
 * 续写输入不得回灌折叠产物（node:test，零新依赖）。
 *
 * 钉死什么（docs/iterations/magic-context-trim-integrity/spec.md 问题二 / Step 7）
 * ────────
 * core 修复之后，输出续写的第二次 transform 输入恒为「全量历史 + 追加条目」。
 * 本文件在 bootstrap 层用真实端口（createMagicContextTurnTransform + 临时目录
 * 真库）钉住：
 *
 *   T-C3 —— 冷重建裁前缀的折叠状态下，把「全量历史 + 追加条目」交给端口：输出里
 *           每个工具调用都有结果、每个结果都有调用（0 / 0），摘要块数不减少。
 *           前提：夹具的工具弧落在裁剪边界之后的保留窗口内。
 *   T-C4 —— 对照（非 blocking）：证明 T-C3 的 0 / 0 断言确实能抓住缺陷形态。
 *
 * T-C4 的处置记录（spec Step 7 允许的放宽，实测依据见用例注释）
 * ─────────────────────────────────────────────
 * spec 字面的缺陷形态是「弧整体在保留窗口内、折叠产物回灌后位置前移把弧劈断」。
 * 在当前已修复的代码（core 4bb0b8ca 不再写回 + magic-context 2db1848d 内容校验）
 * 上两次实测（折叠占位符形态、冷重建裁前缀形态）该形态均不复现：回灌后弧仍成对，
 * tags 表可见位置命中的旧 dropped tag 已按内容校验墓碑化（__mc_drifted__:*）并给
 * 入站消息分配新号——dropped 状态不再错绑重放到保留窗口内的弧上。因此按 spec
 * Step 7 的处置放宽：改用「折叠边界恰好劈在工具弧中间」的布置直接构造不成对形态
 * （孤立 tool 结果，0 调用 / 1 结果），断言折叠产物及其再投影在工具弧成对性上与
 * T-C3 的正确输入（成对，0 / 0）存在差异——0 / 0 断言对劈弧形态有判别力。
 *
 * 隔离声明
 * ────────
 * 绝不写真实 `~/.omz`：在 import 任何被测模块**之前**把 `MAGIC_CONTEXT_DB_DIR` /
 * `MAGIC_CONTEXT_LOG_PATH` 指到 `os.tmpdir()` 下的一次性目录。
 *
 * dist 前置构建
 * ─────────────
 * `pnpm --filter @zcode/magic-context build`、`pnpm --filter @zcode/bootstrap build`。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_HOME = mkdtempSync(join(tmpdir(), "zcode-mc-continuation-input-"));
process.env.MAGIC_CONTEXT_DB_DIR = TEST_HOME;
process.env.MAGIC_CONTEXT_LOG_PATH = join(TEST_HOME, "magic-context.log");
process.on("exit", () => {
    try {
        rmSync(TEST_HOME, { recursive: true, force: true });
    } catch {
        /* Windows 上 sqlite 句柄未释放时 EPERM：残留目录在 tmpdir 下，交给 OS 回收 */
    }
});

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
        if (packageName !== null) {
            const distRoot = `${REPO_ROOT}packages/${packageName.slice("@zcode/".length)}/dist/`;
            const subpath =
                specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
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

const { getCompartments, getMagicContextDatabasePath, openDatabase } = await import(
    "@zcode/magic-context"
);
const { createMagicContextTurnTransform } = await import(
    new URL("../dist/app/magic-context-turn-transform.js", import.meta.url).href
);

// ── 夹具 ────────────────────────────────────────────────────────────────────

function recordingLogger() {
    const lines = [];
    const logger = {
        lines,
        info(message, context) {
            lines.push({ level: "info", message, context });
        },
        warn(message, context) {
            lines.push({ level: "warn", message, context });
        },
        error(message, context) {
            lines.push({ level: "error", message, context });
        },
        debug() {},
        child() {
            return this;
        },
    };
    return logger;
}

async function makePort(sessionId, logger, sessionStore) {
    const closeHooks = [];
    const port = await createMagicContextTurnTransform({
        enabled: true,
        configDomain: {},
        sessionId,
        workingDirectory: TEST_HOME,
        logger,
        sessionStore,
        processExitsAfterTurn: false,
        registerClose: (close) => {
            closeHooks.push(close);
        },
    });
    assert.ok(port, "flag on 且库开得出来时必须拿到端口");
    return {
        port,
        close: async () => {
            for (const close of closeHooks) await close();
        },
    };
}

const runPort = (port, sessionId, entries) =>
    port({
        entries,
        model: { providerId: "zcode", modelId: "glm-4.6" },
        sessionId,
        workingDirectory: TEST_HOME,
    });

/**
 * 单会话夹具：system + 前缀对话 + 工具弧（assistant 调用 + tool 结果）+ 末端对话。
 * `callText` 是弧 assistant 的正文：非空才有 message tag，才能按 mc 序号折叠——
 * T-C4 靠它把折叠边界精确劈在调用与结果之间。
 */
function sessionFixture({ label, prefixCount, tailCount, callText = "" }) {
    const toolCallId = `${label}_call`;
    const entries = [
        { kind: "message", message: { role: "system", content: `you are the ${label} assistant` } },
    ];
    const conversation = (from, to, tag) => {
        const list = [];
        for (let index = from; index <= to; index += 1) {
            const role = index % 2 === 1 ? "user" : "assistant";
            list.push({
                kind: "message",
                message: { role, content: `${tag} ${role} message number ${index}` },
            });
        }
        return list;
    };
    entries.push(...conversation(1, prefixCount, `${label} prefix`));
    entries.push({
        kind: "message",
        message: {
            role: "assistant",
            content: callText,
            toolCalls: [{ id: toolCallId, name: "read_file", input: { path: `${label}.txt` } }],
        },
    });
    entries.push({
        kind: "message",
        message: {
            role: "tool",
            toolCallId,
            toolName: "read_file",
            content: `${label} file body that must stay paired`,
        },
    });
    entries.push(...conversation(prefixCount + 1, prefixCount + tailCount, `${label} tail`));
    const store = {
        // 持久历史快照桩：工具结果落在 assistant 行的 tool part 上（与真实库同形）。
        async messages({ sessionID }) {
            if (sessionID !== sessionIdOf(label)) return [];
            return entries
                .filter((entry) => entry.message?.toolCalls?.length > 0)
                .flatMap((entry) =>
                    entry.message.toolCalls.map((call) => {
                        const result = entries.find(
                            (candidate) => candidate.message?.toolCallId === call.id,
                        );
                        return {
                            info: { id: `row_${call.id}`, role: "assistant" },
                            parts: [
                                {
                                    type: "tool",
                                    callID: call.id,
                                    tool: call.name,
                                    state: { status: "completed", output: result.message.content },
                                },
                            ],
                        };
                    }),
                );
        },
    };
    return { entries, store, toolCallId };
}

const SESSION_IDS = {};
const sessionIdOf = (label) => SESSION_IDS[label];

/** 把指定 mc 序号（含）之前的消息折叠：message tag 标 dropped 并写入覆盖到该位置的摘要。 */
function foldThrough(db, sessionId, through, title) {
    const rows = db
        .prepare(
            "SELECT tag_number AS tagNumber, message_id AS messageId FROM tags WHERE session_id = ?",
        )
        .all(sessionId);
    for (const row of rows) {
        const match = /^mc(\d+):/.exec(row.messageId);
        if (match === null) continue;
        if (Number(match[1]) <= through) {
            db.prepare(
                "UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?",
            ).run(sessionId, row.tagNumber);
        }
    }
    db.prepare(
        `INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness, start_block_index, end_block_index)
         VALUES (?, ?, 1, ?, 'mc1', ?, ?, ?, ?, NULL, NULL, NULL, 50, NULL, 0, ?, 'zcode', NULL, NULL)`,
    ).run(sessionId, through, through, `mc${through}`, title, `${title} body`, `${title} body`, Date.now());
}

/** 缓存作废 → 下一轮走冷重建裁前缀（fork-inherit 同款手法）。 */
function bustMaterializedPrefix(db, sessionId) {
    db.prepare(
        "UPDATE session_meta SET cached_m0_bytes = NULL, cached_m1_bytes = NULL WHERE session_id = ?",
    ).run(sessionId);
}

/** 输出 entries 上的工具弧成对性统计。 */
function toolArcStats(entries) {
    const calls = new Map();
    const results = new Set();
    for (const entry of entries) {
        const message = entry.message;
        if (!message) continue;
        for (const call of message.toolCalls ?? []) {
            calls.set(call.id, { hasResult: false });
        }
        if (message.role === "tool" && typeof message.toolCallId === "string") {
            results.add(message.toolCallId);
            const call = calls.get(message.toolCallId);
            if (call) call.hasResult = true;
        }
    }
    return {
        callCount: calls.size,
        resultCount: results.size,
        callsWithoutResult: [...calls.entries()].filter(([, call]) => !call.hasResult).map(([id]) => id),
        resultsWithoutCall: [...results].filter((id) => !calls.has(id)),
    };
}

function summaryHeadCount(entries) {
    return entries.filter(
        (entry) => entry.kind === "attachment" && entry.metadata?.source === "magic_context",
    ).length;
}

/** 续写形态的追加条目：assistant 部分输出 + 续写 user。 */
function continuationEntries(label) {
    return [
        {
            kind: "message",
            message: { role: "assistant", content: `${label} partial answer cut by output limit` },
        },
        {
            kind: "message",
            message: { role: "user", content: "Output token limit hit. Continue." },
        },
    ];
}

// ── T-C3（blocking）─────────────────────────────────────────────────────────

test("T-C3: 冷重建裁前缀下，全量历史 + 追加条目再进端口，工具弧成对、摘要块不减少", async (t) => {
    const label = "cont";
    const sessionId = `ses_continuation_input_${label}`;
    SESSION_IDS[label] = sessionId;
    const { entries, store } = sessionFixture({ label, prefixCount: 12, tailCount: 4, callText: "Let me read the file." });
    const { port, close } = await makePort(sessionId, recordingLogger(), store);
    t.after(close);

    // 第一轮：无折叠，tag 落库并物化 m[0]/m[1] 基线。
    await runPort(port, sessionId, entries);
    const db = openDatabase(getMagicContextDatabasePath());
    // 折叠到 mc13（前缀对话末条）：工具弧（mc14 调用 / mc15 结果）整体落在裁剪边界之后。
    foldThrough(db, sessionId, 13, "cont continuation summary");
    bustMaterializedPrefix(db, sessionId);

    // 折叠 + 冷重建下的正确输入轮：基线形态（裁前缀、弧在保留窗口内成对）。
    const baseline = await runPort(port, sessionId, entries);
    const baselineStats = toolArcStats(baseline.entries);
    const baselineCompartments = getCompartments(db, sessionId).length;
    assert.equal(baselineCompartments, 1, "夹具：折叠状态下必须有一份摘要块");
    assert.ok(
        baselineStats.callCount > 0 && baselineStats.callsWithoutResult.length === 0 && baselineStats.resultsWithoutCall.length === 0,
        `夹具前提：工具弧必须落在保留窗口内且成对（${JSON.stringify(baselineStats)}）`,
    );
    assert.ok(
        baseline.entries.length < entries.length,
        `夹具前提：必须真的发生裁前缀（${baseline.entries.length} vs ${entries.length}）`,
    );

    // T-C3：第二次输入 = 全量历史 + 追加（assistant 部分输出 + 续写 user）。
    const second = await runPort(port, sessionId, [...entries, ...continuationEntries(label)]);
    const secondStats = toolArcStats(second.entries);
    const secondCompartments = getCompartments(db, sessionId).length;

    assert.equal(secondStats.callsWithoutResult.length, 0, "每个工具调用都必须有结果");
    assert.equal(secondStats.resultsWithoutCall.length, 0, "每个工具结果都必须有调用");
    assert.ok(secondStats.callCount > 0, "工具弧必须在保留窗口内（否则 0/0 空转）");
    assert.ok(
        secondCompartments >= baselineCompartments,
        `摘要块数不得减少（${secondCompartments} < ${baselineCompartments}）`,
    );
    assert.ok(summaryHeadCount(second.entries) > 0, "折叠状态下第二次输出必须仍带摘要头");
    t.diagnostic(
        `baseline 条数=${baseline.entries.length}（裁前缀前 ${entries.length}）弧=${JSON.stringify(baselineStats)}；second 弧=${JSON.stringify(secondStats)} 舱=${secondCompartments}`,
    );
});

// ── T-C4（对照，非 blocking）────────────────────────────────────────────────

test("T-C4 对照: 折叠边界劈在弧中间的产物不成对，再进端口也不会自愈", async (t) => {
    const label = "split";
    const sessionId = `ses_continuation_replay_${label}`;
    SESSION_IDS[label] = sessionId;
    // 折叠边界落在弧 assistant 与 tool 结果之间：mc 序号 = system(mc1) + 前缀 11 条
    // （mc2..mc12）+ 弧 assistant(mc13) + tool 结果(mc14) + 末端 3 条（mc15..mc17）。
    const { entries, store } = sessionFixture({ label, prefixCount: 11, tailCount: 3, callText: "Let me read the file." });
    const { port, close } = await makePort(sessionId, recordingLogger(), store);
    t.after(close);

    await runPort(port, sessionId, entries);
    const db = openDatabase(getMagicContextDatabasePath());
    // 劈弧布置：折叠到弧 assistant 的 mc 序号（tool tag 的 owner 即调用侧条目），
    // tool 结果留在窗口内。会话里只有一条工具弧，按 type 直接取 tool tag。
    const arcOwnerOrdinal = Number(
        /mc(\d+)/.exec(
            db
                .prepare(
                    "SELECT tool_owner_message_id AS owner FROM tags WHERE session_id = ? AND type = 'tool'",
                )
                .get(sessionId).owner,
        )?.[1],
    );
    foldThrough(db, sessionId, arcOwnerOrdinal, "split continuation summary");
    bustMaterializedPrefix(db, sessionId);

    // 正确投影（全量喂端口）：折叠产物把调用侧裁出请求，留下孤立 tool 结果。
    const folded = await runPort(port, sessionId, entries);
    const foldedStats = toolArcStats(folded.entries);
    assert.equal(
        foldedStats.callsWithoutResult.length,
        0,
        `劈弧布置下调用侧必须被整体移出（${JSON.stringify(foldedStats)}）`,
    );
    assert.ok(
        foldedStats.resultsWithoutCall.length > 0,
        `劈弧布置必须产生孤立 tool 结果（${JSON.stringify(foldedStats)}）`,
    );

    // 把折叠产物（修复前的写回输入）直接再喂一次端口：调用侧已物理移出，不成对不得自愈。
    const replayed = await runPort(port, sessionId, folded.entries);
    const replayedStats = toolArcStats(replayed.entries);
    assert.ok(
        replayedStats.resultsWithoutCall.length > 0,
        `折叠产物再进端口后孤立结果必须仍在（${JSON.stringify(replayedStats)}）`,
    );

    // 与 T-C3 的正确输入（成对 0/0）在工具弧成对性上存在差异：0/0 断言对劈弧形态有判别力。
    assert.notDeepEqual(
        [foldedStats.callsWithoutResult.length, foldedStats.resultsWithoutCall.length],
        [0, 0],
        "对照输出必须与正确输入的 0/0 形态存在差异（spec Step 7 放宽断言）",
    );
    t.diagnostic(
        `弧 owner=mc${arcOwnerOrdinal}；folded 弧=${JSON.stringify(foldedStats)}；replayed 弧=${JSON.stringify(replayedStats)}`,
    );
});
