#!/usr/bin/env node
/**
 * MC 跨会话污染回归（node:test，零新依赖）。
 *
 * 钉死什么
 * ────────
 * 一个 AgentRuntime 进程既服务父会话，也服务它派生的每个子代理会话，而
 * `createMagicContextTurnTransform` 的原始历史 provider 是**进程级**的。历史上这里
 * 只有一份 `currentSnapshot` 和一个 `providerRegistered` 布尔：
 *
 *   ① 子代理的 transform 会覆盖父会话的快照，于是异步触发的父会话 historian pass
 *      读到子代理的 entries（子代理历史 = 父历史 + 子代理新增，必然更长），把
 *      `mc<N>` 边界写进父会话的 compartments。父会话自己的消息数远小于 N，边界再也
 *      解析不到 → 前缀裁剪 refused → 请求超过窗口时抛 MC-H04（请求未发出）。
 *   ② provider 只给第一个 sessionId 注册，其余会话永远读不到原始历史。
 *
 * 判据：父会话 turn 之后紧接一个更大的子代理 turn，父会话的 provider 必须仍然返回
 * **父会话自己的**条数，且子代理也拿到自己的 provider。
 *
 * 隔离声明
 * ────────
 * 绝不写真实 `~/.omz`：在 import 任何被测模块**之前**把 `MAGIC_CONTEXT_DB_DIR` /
 * `MAGIC_CONTEXT_LOG_PATH` 指到 `os.tmpdir()` 下的一次性目录。
 *
 * dist 前置构建
 * ─────────────
 * `pnpm --filter @zcode/magic-context build`、`pnpm --filter @zcode/bootstrap build`。
 * `@zcode/shared` 与 `@zcode/model-option-map` 必须有 dist（包入口发布的是原始
 * TypeScript），下面的 resolve 钩子与 test-settle-background.mjs 同一手法。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_HOME = mkdtempSync(join(tmpdir(), "zcode-mc-isolation-"));
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

const {
    getCompartments,
    getMagicContextDatabasePath,
    hasRawMessageProvider,
    openDatabase,
    readRawSessionMessages,
} = await import("@zcode/magic-context");
const { createMagicContextTurnTransform } = await import(
    new URL("../dist/app/magic-context-turn-transform.js", import.meta.url).href
);

const NOOP_LOGGER = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
        return this;
    },
};

/** 造 n 条真实形态的 request entries（system + 交替 user/assistant）。 */
function entriesOf(n, label) {
    const entries = [
        { kind: "message", message: { role: "system", content: `you are ${label}` } },
    ];
    for (let index = 1; index < n; index += 1) {
        const role = index % 2 === 1 ? "user" : "assistant";
        entries.push({
            kind: "message",
            message: { role, content: `${label} ${role} ${index}` },
            ...(role === "user" ? { metadata: { source: "real_user" } } : {}),
        });
    }
    return entries;
}

/** 只读 session store 桩：provider 有 live borrow 时用不到它，给一个空实现即可。 */
function emptySessionStore() {
    return {
        async messages() {
            return [];
        },
    };
}

test("父会话与子代理各自持有原始历史快照（跨会话不污染）", async (t) => {
    const parentId = "ses_mc_isolation_parent";
    const childId = "sess_subagent_agent_isolation";
    const parentEntries = entriesOf(5, "parent");
    const childEntries = entriesOf(20, "child");
    const closeHooks = [];
    const port = await createMagicContextTurnTransform({
        enabled: true,
        configDomain: {},
        sessionId: parentId,
        workingDirectory: TEST_HOME,
        logger: NOOP_LOGGER,
        sessionStore: emptySessionStore(),
        processExitsAfterTurn: false,
        registerClose: (close) => {
            closeHooks.push(close);
        },
    });
    assert.ok(port, "flag on 且库开得出来时必须拿到端口");
    t.after(async () => {
        for (const close of closeHooks) await close();
    });

    const run = (sessionId, entries) =>
        port({
            entries,
            model: { providerId: "zcode", modelId: "glm-4.6" },
            sessionId,
            workingDirectory: TEST_HOME,
        });

    await run(parentId, parentEntries);
    assert.equal(
        readRawSessionMessages(parentId).length,
        parentEntries.length,
        "父会话 turn 之后，provider 必须返回父会话自己的条数",
    );

    // 子代理的一轮：entries 更长（父历史 + 子代理新增的生产形态）。
    await run(childId, childEntries);

    assert.equal(
        readRawSessionMessages(parentId).length,
        parentEntries.length,
        "子代理 turn 之后，父会话的 provider 不得被覆盖成子代理的 entries",
    );
    assert.equal(
        readRawSessionMessages(childId).length,
        childEntries.length,
        "子代理必须拿到自己的 provider，而不是回落到空的持久历史",
    );
    assert.equal(hasRawMessageProvider(parentId), true);
    assert.equal(hasRawMessageProvider(childId), true);
});

test("边界 ordinal 超出会话消息数时重建 compaction 账本", async (t) => {
    const sessionId = "ses_mc_isolation_heal";
    const entries = entriesOf(4, "heal");
    const closeHooks = [];
    const port = await createMagicContextTurnTransform({
        enabled: true,
        configDomain: {},
        sessionId,
        workingDirectory: TEST_HOME,
        logger: NOOP_LOGGER,
        sessionStore: emptySessionStore(),
        processExitsAfterTurn: false,
        registerClose: (close) => {
            closeHooks.push(close);
        },
    });
    assert.ok(port);
    t.after(async () => {
        for (const close of closeHooks) await close();
    });
    const run = () =>
        port({
            entries,
            model: { providerId: "zcode", modelId: "glm-4.6" },
            sessionId,
            workingDirectory: TEST_HOME,
        });

    // 先跑一轮：session_meta 行落地，此时账本是干净的。
    await run();
    const db = openDatabase(getMagicContextDatabasePath());
    // 模拟旧版本跨会话污染：一条覆盖到 ordinal 999 的分区（会话只有 4 条消息），
    // 以及指向它的边界。
    db.prepare(
        `INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness, start_block_index, end_block_index)
         VALUES (?, 1, 1, 999, 'mc1', 'mc999', 'stale', 'stale content', NULL, NULL, NULL, NULL, 50, NULL, 1, ?, 'zcode', NULL, NULL)`,
    ).run(sessionId, Date.now());
    db.prepare(
        "UPDATE session_meta SET prior_boundary_ordinal = 1000, cached_m0_last_baseline_end_message_id = 'mc999' WHERE session_id = ?",
    ).run(sessionId);
    assert.equal(getCompartments(db, sessionId).length, 1, "夹具先确认污染行已写入");

    await run();

    assert.equal(getCompartments(db, sessionId).length, 0, "越界账本必须被清掉");
    const meta = db
        .prepare(
            "SELECT prior_boundary_ordinal AS boundary, cached_m0_last_baseline_end_message_id AS baseline FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId);
    assert.equal(meta.boundary, 1, "保护尾边界必须复位");
    assert.equal(meta.baseline, null, "M0 基线必须失效，让摘要重新生成");
});
