#!/usr/bin/env node
/**
 * fork 子会话继承 magic-context 折叠状态与摘要（node:test，零新依赖）。
 *
 * 钉死什么（docs/iterations/magic-context-fork-inherit/spec.md）
 * ────────
 * fork 只复制消息行，子会话首轮会给全部历史新建 active 的 tag，既没有 dropped 也
 * 没有 compartment：历史明显超窗时主 transform 走 unmanaged 拒发，子会话无法自救。
 *
 * 判据：父会话有 dropped tag 与 compartments 时，fork 子会话首轮 turn 入口把它们
 * 继承过来——dropped 状态按内容套到子会话自己的 tag 上，摘要块原样复制、只有末舱
 * 边界写成子会话坐标；首轮请求里历史是占位符 + 摘要，而不是全量原文。
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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_HOME = mkdtempSync(join(tmpdir(), "zcode-mc-fork-inherit-"));
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
    openDatabase,
} = await import("@zcode/magic-context");
const { createMagicContextTurnTransform } = await import(
    new URL("../dist/app/magic-context-turn-transform.js", import.meta.url).href
);
const { noteForkedSession, takePendingForkParent, clearForkRegistryForTests } = await import(
    new URL("../dist/app/session-fork-registry.js", import.meta.url).href
);
const { inheritForkedSessionStateAtTurnStart } = await import(
    new URL("../dist/app/magic-context-fork-inherit.js", import.meta.url).href
);

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

/** 对话：交替 user/assistant，中间夹一组「assistant 发起调用 → tool 结果」。 */
function conversation(label, { withTool = false, callId = "call_a" } = {}) {
    const entries = [];
    for (let index = 1; index <= 12; index += 1) {
        const role = index % 2 === 1 ? "user" : "assistant";
        if (withTool && index === 6) {
            entries.push({
                kind: "message",
                message: {
                    role: "assistant",
                    content: "",
                    toolCalls: [{ id: callId, name: "read_file", input: { path: "a.txt" } }],
                },
            });
            entries.push({
                kind: "message",
                message: {
                    role: "tool",
                    toolCallId: callId,
                    toolName: "read_file",
                    content: `${label} file body line one\nline two`,
                },
            });
            continue;
        }
        entries.push({
            kind: "message",
            message: { role, content: `${label} ${role} message number ${index}` },
            ...(role === "user" ? { metadata: { source: "real_user" } } : {}),
        });
    }
    return entries;
}

function textOfEntries(entries) {
    return entries
        .map((entry) =>
            entry.kind === "attachment"
                ? entry.content
                : typeof entry.message?.content === "string"
                  ? entry.message.content
                  : JSON.stringify(entry.message?.content ?? ""),
        )
        .join("\n");
}

/** 父会话消息行桩：工具结果落在 assistant 行的 tool part 上（与真实库同形）。 */
function parentStore(parentId, parentEntries, extraRows = []) {
    return {
        async messages({ sessionID }) {
            if (sessionID !== parentId) return extraRows;
            return parentEntries
                .filter((entry) => entry.message?.toolCalls?.length > 0)
                .flatMap((entry) =>
                    entry.message.toolCalls.map((call) => {
                        const result = parentEntries.find(
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
 * 把父会话折叠到第 `through` 条对话消息：这些消息上的 tag 标成 dropped，
 * 并写入 `compartmentCount` 个覆盖到该位置的摘要块（边界是父会话自己的 mc 序号）。
 */
function foldParentThrough(db, parentId, parentPrefix, through, compartmentCount = 3) {
    const rows = db
        .prepare("SELECT tag_number AS tagNumber, message_id AS messageId FROM tags WHERE session_id = ?")
        .all(parentId);
    for (const row of rows) {
        const match = /^mc(\d+):/.exec(row.messageId);
        if (match === null) continue;
        const ordinal = Number(match[1]);
        if (ordinal > parentPrefix && ordinal <= through) {
            db.prepare("UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?").run(
                parentId,
                row.tagNumber,
            );
        }
    }
    const span = Math.floor((through - 1) / compartmentCount);
    for (let index = 0; index < compartmentCount; index += 1) {
        const start = index * span + 1;
        const end = index === compartmentCount - 1 ? through : (index + 1) * span;
        db.prepare(
            `INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness, start_block_index, end_block_index)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 50, NULL, 0, ?, 'zcode', NULL, NULL)`,
        ).run(
            parentId,
            index + 1,
            start,
            end,
            `mc${start}`,
            `mc${end}`,
            `parent summary ${index + 1}`,
            `parent compartment body ${index + 1}`,
            `parent compartment body ${index + 1}`,
            Date.now(),
        );
    }
}

function droppedTagCount(db, sessionId) {
    return db
        .prepare("SELECT COUNT(*) AS count FROM tags WHERE session_id = ? AND status = 'dropped'")
        .get(sessionId).count;
}

function assertContiguousFromOne(compartments) {
    let expected = 1;
    for (const compartment of compartments) {
        assert.equal(compartment.startMessage, expected, "舱区间必须从 1 起逐舱无缝");
        assert.ok(compartment.endMessage >= compartment.startMessage);
        expected = compartment.endMessage + 1;
    }
}

test("fork 子会话首轮继承 dropped 状态与摘要块", async (t) => {
    clearForkRegistryForTests();
    const parentId = "ses_fork_inherit_parent";
    const childId = "ses_fork_inherit_child";
    const parentPrefix = 1;
    const parentEntries = [
        { kind: "message", message: { role: "system", content: "you are the parent" } },
        ...conversation("shared"),
    ];
    const store = parentStore(parentId, parentEntries);
    const parentLogger = recordingLogger();
    const parent = await makePort(parentId, parentLogger, store);
    const childLogger = recordingLogger();
    const child = await makePort(childId, childLogger, store);
    t.after(async () => {
        await parent.close();
        await child.close();
    });

    await runPort(parent.port, parentId, parentEntries);
    const db = openDatabase(getMagicContextDatabasePath());
    // 父会话已折叠到第 9 条对话消息（父数组里是 mc10）。
    const through = 10;
    foldParentThrough(db, parentId, parentPrefix, through);
    const parentDropped = droppedTagCount(db, parentId);
    assert.ok(parentDropped > 0, "夹具：父会话必须有 dropped tag");

    // 父会话在「已折叠」状态下的一轮，用来做同条件对照。
    // 父会话在「已折叠」状态下的常态一轮，用来确认对照基线：system prompt 在。
    const parentAfterFold = await runPort(parent.port, parentId, parentEntries);

    // 子会话：同样的对话原文，但前缀多一条恢复期附件，整体后移一格。
    const childEntries = [
        { kind: "message", message: { role: "system", content: "you are the child" } },
        { kind: "attachment", content: "resumed session reminder", metadata: { source: "shell" } },
        ...conversation("shared"),
        { kind: "message", message: { role: "user", content: "child new question" } },
    ];
    noteForkedSession(parentId, childId);
    const result = await runPort(child.port, childId, childEntries);

    const childDropped = droppedTagCount(db, childId);
    assert.equal(childDropped, parentDropped, "子会话必须继承到同样多的 dropped tag");
    const compartments = getCompartments(db, childId);
    assert.equal(compartments.length, 3, "三舱摘要必须原样复制");
    assertContiguousFromOne(compartments);
    // 第 9 条对话在子数组里是第 11 条（system + 恢复期附件 + 9）：数值末端是子会话坐标。
    assert.equal(compartments.at(-1).endMessage, 11);
    // 边界 id 一律留空，包括末舱：可解析的边界会让冷重建裁前缀，把 system prompt 等
    // context 前缀一起裁掉并且此后每轮如此。父会话的常态不裁前缀。
    assert.ok(
        compartments.every(
            (compartment) => compartment.endMessageId === "" && compartment.startMessageId === "",
        ),
        "任何一舱都不得留下可解析的边界 id",
    );

    const text = textOfEntries(result.entries);
    assert.ok(text.includes("parent compartment body"), "首轮请求必须带上继承的摘要");
    // 「number 1」是「number 11」的前缀，所以用整词匹配而不是子串。
    assert.ok(
        !/message number [1-9](?!\d)/.test(text),
        "已折叠的历史原文不得留在首轮请求里",
    );
    assert.ok(text.includes("[dropped"), "已折叠的历史必须以占位符呈现");
    assert.ok(text.includes("child new question"), "折叠范围之外的新消息必须保留");

    // 与父会话常态同形：条目一个不少（折叠的换成占位符），system prompt 与前缀都在。
    assert.equal(
        result.entries.length,
        childEntries.length + 2,
        "子会话首轮请求应保留全部条目，外加两个摘要头",
    );
    // T-S3：不触发裁前缀的会话（末端不足 MIN_TAIL_FOR_TRIM 的退路）行为不变——
    // 请求仍以 system 段起头，context 前缀 attachment 与 system 都在。
    assert.equal(result.entries[0]?.message?.role, "system", "不裁剪时请求必须以 system 段起头");
    assert.ok(
        result.entries.some((entry) => entry.message?.role === "system"),
        "子会话的 system prompt 必须留在请求里",
    );
    assert.ok(
        text.includes("resumed session reminder"),
        "子会话的 context 前缀必须留在请求里",
    );
    const parentHasSystem = parentAfterFold.entries.some(
        (entry) => entry.message?.role === "system",
    );
    assert.equal(parentHasSystem, true, "夹具：父会话常态下 system prompt 在请求里");
});

test("重复的样板文本不会把对齐带偏", async (t) => {
    clearForkRegistryForTests();
    const parentId = "ses_fork_inherit_boiler_parent";
    const childId = "ses_fork_inherit_boiler_child";
    const reminder = () => ({
        kind: "attachment",
        content: "The TodoWrite tool has not been used recently. Consider cleaning up the list.",
        metadata: { source: "shell" },
    });
    const messages = conversation("shared");
    // 真实会话的形态：每轮都插一份一字不差的提醒；父会话还多出几份子会话里没有的
    // 副本（回滚掉的分支、没落库的临时附件）。全局贪心会被这些多出来的副本把游标
    // 带到后面，之后的内容全部对不上（真实数据实测：命中 830、落在游标后 8416）。
    // 每条消息前面：子会话有一份提醒，父会话有两份（多出的那份紧挨着）。
    const withReminders = (perMessage) => [
        { kind: "message", message: { role: "system", content: "you are the parent" } },
        ...messages.flatMap((message) => [
            ...Array.from({ length: perMessage }, () => reminder()),
            message,
        ]),
    ];
    const parentEntries = withReminders(2);
    const childEntries = [
        { kind: "message", message: { role: "system", content: "you are the child" } },
        ...withReminders(1).slice(1),
    ];
    const store = parentStore(parentId, parentEntries);
    const parent = await makePort(parentId, recordingLogger(), store);
    const childLogger = recordingLogger();
    const child = await makePort(childId, childLogger, store);
    t.after(async () => {
        await parent.close();
        await child.close();
    });

    await runPort(parent.port, parentId, parentEntries);
    const db = openDatabase(getMagicContextDatabasePath());
    // 折叠到第 8 条对话在父数组里的位置。
    const through = parentEntries.findIndex(
        (entry) => entry.message?.content === messages[7].message.content,
    ) + 1;
    foldParentThrough(db, parentId, 1, through);

    noteForkedSession(parentId, childId);
    const result = await runPort(child.port, childId, childEntries);

    assert.ok(
        childLogger.lines.some(
            (line) => line.level === "info" && line.context?.kind === "inherited",
        ),
        `必须完整继承，而不是判定对齐不可信：${JSON.stringify(childLogger.lines.filter((line) => line.message.includes("fork inherit")).map((line) => line.context))}`,
    );
    const text = textOfEntries(result.entries);
    assert.ok(
        !/message number [1-8](?!\d)/.test(text),
        "父会话多出的重复副本不得让后面的内容逃过折叠",
    );
    assert.ok(text.includes("shared user message number 11"), "未折叠的近期消息必须保留");
});

test("父会话末端足够长时，子会话像父会话一样裁前缀", async (t) => {
    clearForkRegistryForTests();
    const parentId = "ses_fork_inherit_trim_parent";
    const childId = "ses_fork_inherit_trim_child";
    // 600 条对话，父会话已折叠到第 150 条对话（父数组里是第 151 条）：末端 = 601 − 151 = 450 条，足够长。
    // 子夹具头部（裁剪边界之前）补一条 attachment（T-S2）：它在裁剪范围内、不随请求发出。
    const longConversation = Array.from({ length: 600 }, (_, index) => ({
        kind: "message",
        message: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: `long ${index % 2 === 0 ? "user" : "assistant"} message number ${index + 1}`,
        },
    }));
    const parentEntries = [
        { kind: "message", message: { role: "system", content: "you are the parent" } },
        ...longConversation,
    ];
    const store = parentStore(parentId, parentEntries);
    const parent = await makePort(parentId, recordingLogger(), store);
    const childLogger = recordingLogger();
    const child = await makePort(childId, childLogger, store);
    t.after(async () => {
        await parent.close();
        await child.close();
    });

    await runPort(parent.port, parentId, parentEntries);
    const db = openDatabase(getMagicContextDatabasePath());
    foldParentThrough(db, parentId, 1, 151);

    const childEntries = [
        { kind: "message", message: { role: "system", content: "you are the child" } },
        { kind: "attachment", content: "trim fixture attachment", metadata: { source: "shell" } },
        ...longConversation,
        { kind: "message", message: { role: "user", content: "child new question" } },
    ];
    noteForkedSession(parentId, childId);
    const result = await runPort(child.port, childId, childEntries);

    const inherit = childLogger.lines.find((line) => line.message.includes("fork inherit"));
    assert.equal(inherit?.context?.kind, "inherited");
    assert.equal(inherit?.context?.trims, true, "父会话末端足够长时必须裁前缀");
    // 603 条 − 末端 450 − 余量 100 = 第 53 条是裁剪位置。mc53 = 对话 51（mc1 是
    // system、mc2 是夹具 attachment，对话 i 在 mc(i+2)）；末端 450 由父会话折叠
    // 边界按内容对齐换算，attachment 不改变它。
    assert.equal(inherit?.context?.boundaryOrdinal, 53);
    const compartments = getCompartments(db, childId);
    assert.equal(compartments.length, 3, "摘要块必须继承");
    assert.equal(compartments.at(-1).endMessageId, "mc53", "末舱边界必须是子会话坐标");
    assertContiguousFromOne(compartments);

    const text = textOfEntries(result.entries);
    // number 1..150 = 父会话折叠上限内的对话原文：1..51 被裁掉（裁剪边界 mc53 = 对话
    // 51），52..150 是 dropped 占位符。这个上限锚定父会话的折叠范围，不随 mc 序号
    // 前移；对话 151 是 active、原文必须出现在请求里，所以不得把 151 加进正则。
    assert.ok(!/number (?:[1-9]|[1-9]\d|1[0-4]\d|150)(?!\d)/.test(text), "裁剪范围内的原文不得留在请求里");
    assert.ok(text.includes("parent compartment body"), "请求必须带上继承的摘要");
    assert.ok(text.includes("number 400"), "末端未折叠的消息必须保留");
    assert.ok(text.includes("child new question"), "新问题必须保留");
    // T-S1（顺序 + 条数）：请求的前 k 条是输入里的 system 条目，其后依次是 m[0]、
    // m[1]，再其后是裁剪点之后的全部条目。k = 1（一条 system）。
    assert.equal(result.entries.length, 1 + 2 + (childEntries.length - 53),
        "请求 = system 段(k=1) + 两个摘要头 + 裁剪位置之后的全部条目");
    assert.equal(result.entries[0]?.message?.role, "system", "请求必须以 system 段起头");
    // system 行照常参与打标（wire 上带 §N§ 前缀）；rebuild 后 content 是 parts
    // 数组形态，正文去前缀后必须与输入一致。
    const systemWireText = Array.isArray(result.entries[0]?.message?.content)
        ? result.entries[0].message.content[0]?.text
        : result.entries[0]?.message?.content;
    assert.match(
        String(systemWireText ?? ""),
        /^§\d+§ you are the child$/,
        "system 段正文必须原样保留（§N§ 是打标前缀）",
    );
    assert.equal(result.entries[1]?.metadata?.source, "magic_context", "system 段之后必须是 m[0] 摘要头");
    assert.equal(result.entries[2]?.metadata?.source, "magic_context", "m[0] 之后必须是 m[1] 摘要头");
    // T-S2：夹具 attachment（裁剪边界之前）不随请求发出，与修复前一致。
    assert.ok(!text.includes("trim fixture attachment"), "裁剪范围内的 attachment 不得随请求发出");
    // 裁剪位置之后的条目：active 原文条目由 transform 复用原对象（isUnchanged），
    // 逐项引用相等；继承的 dropped 条目（对话 52..150）wire 被中和成占位符、条目
    // 被重建，引用相等不成立——按 spec T-S1 的处置，对这些条目断言位置 + role +
    // 占位符文本。
    const kept = result.entries.slice(3);
    const expectedKept = childEntries.slice(53);
    assert.equal(kept.length, expectedKept.length, "保留段条数必须一致");
    const asWireText = (entry) =>
        Array.isArray(entry?.message?.content)
            ? entry.message.content[0]?.text
            : entry?.message?.content;
    // 条目被重建（引用不等）只有两种合法形态：继承的 dropped 占位符，或 active
    // 原文被 §N§ 打标改写（正文不变）。
    const stripTag = (text) => text.replace(/^§\d+§ /, "");
    for (let index = 0; index < kept.length; index += 1) {
        if (kept[index] === expectedKept[index]) continue;
        assert.equal(
            kept[index]?.message?.role,
            expectedKept[index]?.message?.role,
            `保留条目 ${index} 的 role 必须与输入一致`,
        );
        const wire = String(asWireText(kept[index]) ?? "");
        const inputText = expectedKept[index].message?.content;
        const isPlaceholder = /^\[dropped(?: §\d+§)?\]$/.test(wire);
        const isTaggedOriginal =
            typeof inputText === "string" && stripTag(wire) === inputText;
        assert.ok(
            isPlaceholder || isTaggedOriginal,
            `被重建的保留条目 ${index} 既不是 dropped 占位符也不是打标原文：${wire}`,
        );
    }

    // 父会话在同样条件（缓存作废后的冷重建）下也是这样裁的：形态一致。
    db.prepare(
        "UPDATE session_meta SET cached_m0_bytes = NULL, cached_m1_bytes = NULL WHERE session_id = ?",
    ).run(parentId);
    const parentAfterFold = await runPort(parent.port, parentId, parentEntries);
    assert.equal(
        result.entries.some((entry) => entry.message?.role === "system"),
        parentAfterFold.entries.some((entry) => entry.message?.role === "system"),
        "system prompt 的去留必须与同样条件下的父会话一致",
    );

    // 继承来的原文随 tag 一起带过来：裁掉的条目不经过子会话的打标流程，否则 ctx_expand 取不回。
    const inheritedSources = db
        .prepare(
            `SELECT COUNT(*) AS count FROM tags t JOIN source_contents s
                 ON s.session_id = t.session_id AND s.tag_id = t.tag_number
             WHERE t.session_id = ? AND t.type = 'message' AND t.status = 'dropped' AND t.message_id LIKE 'mc5_:%'`,
        )
        .get(childId).count;
    assert.ok(inheritedSources > 0, "被裁掉的继承 tag 必须带着父会话的原文");

    // T-S5：缓存回放分支（S0）的切片。第一轮的 m[0]/m[1] 首渲染（first_render）
    // 会清掉包内 injection 缓存，所以全量 childEntries 要再进两次：第一次在缓存
    // 空的情况下走 rebuild 分支并重建缓存（m[0]/m[1] 已落库、走 cache_hit 不再清
    // 缓存），第二次才落入缓存回放分支，且缓存边界 mc53 在全量投影里可解析——
    // S0 的 splice 真正执行。下方「折叠产物重进」喂的是已折叠条目，投影重编号后
    // 缓存边界不再指向裁剪位置，不能作为 S0 裁剪断言的载体（spec T-S5）。
    const replayWarmup = await runPort(child.port, childId, childEntries);
    const replay = await runPort(child.port, childId, childEntries);
    assert.ok(replay, "S0 回放轮必须成功");
    assert.equal(
        replay.entries.length,
        replayWarmup.entries.length,
        "S0 回放轮与 rebuild 轮的输出条数必须一致（豁免行为同构）",
    );
    assert.equal(replay.entries.length, result.entries.length, "S0 回放轮不得改变请求条数");
    assert.equal(replay.entries[0]?.message?.role, "system", "S0 切片后请求仍以 system 段起头");
    assert.equal(replay.entries[1]?.metadata?.source, "magic_context", "S0 切片后 system 段之后是 m[0]");
    assert.equal(replay.entries[2]?.metadata?.source, "magic_context", "S0 切片后 m[0] 之后是 m[1]");
    // S0 的「缓存边界不可解析」子分支会记 "cached boundary ... not in messages"；
    // 它不出现说明本轮真正执行了 splice，而不是走了不切片的旁路。
    const logText = readFileSync(join(TEST_HOME, "magic-context.log"), "utf8");
    assert.ok(
        logText.includes("reason=cache_hit"),
        "夹具前置：m[0]/m[1] 必须已命中落库缓存（cache_hit）——否则 prepared 路径不清 injection 缓存的前提不成立，S0 到不了",
    );
    assert.ok(
        !logText.includes("cached boundary"),
        "S0 必须真的执行了缓存边界的切片（日志不得出现边界不可解析的旁路记录）",
    );

    // T-S6：system 行照常打标，且没有被持久翻成 compacted。豁免后 system 行仍在
    // 每轮请求里；若它落进「压缩边界之前的消息」切片，每次 cache-busting +
    // deferred pending 的 pass 都会把它的 tag 翻成 compacted。先断言存在，否则
    // 「不是 compacted」恒真、空转通过。
    const systemTags = db
        .prepare(
            `SELECT tag_number AS tagNumber, status FROM tags
             WHERE session_id = ? AND message_id LIKE 'mc1:%' AND type = 'message'`,
        )
        .all(childId);
    assert.ok(systemTags.length > 0, "system 条目的 message tag 必须存在（否则下面的断言空转）");
    assert.ok(
        systemTags.every((tag) => tag.status !== "compacted"),
        `system tag 不得被置为 compacted：${JSON.stringify(systemTags)}`,
    );

    // 同一轮里再次进入 transform（续写、重试路径）拿的是折叠后的条目：heal 不得据此清账。
    const again = await runPort(child.port, childId, result.entries);
    assert.ok(again, "再次进入必须成功");
    assert.equal(
        getCompartments(db, childId).length,
        3,
        "用折叠后的条目再次进入时不得清掉继承来的账本",
    );
});

// T-S4：输入开头没有 system 段（k = 0）时，裁剪行为与修复前逐条相同——豁免逻辑
// 在 k = 0 时退化为上游原样（从头部整体裁掉边界之前的条目），请求形态不得漂移。
test("输入开头没有 system 段时，裁剪与修复前逐条相同", async (t) => {
    clearForkRegistryForTests();
    const parentId = "ses_fork_inherit_nosys_parent";
    const childId = "ses_fork_inherit_nosys_child";
    const longConversation = Array.from({ length: 600 }, (_, index) => ({
        kind: "message",
        message: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: `long ${index % 2 === 0 ? "user" : "assistant"} message number ${index + 1}`,
        },
    }));
    const parentEntries = [
        { kind: "message", message: { role: "system", content: "you are the parent" } },
        ...longConversation,
    ];
    const store = parentStore(parentId, parentEntries);
    const parent = await makePort(parentId, recordingLogger(), store);
    const childLogger = recordingLogger();
    const child = await makePort(childId, childLogger, store);
    t.after(async () => {
        await parent.close();
        await child.close();
    });

    await runPort(parent.port, parentId, parentEntries);
    const db = openDatabase(getMagicContextDatabasePath());
    foldParentThrough(db, parentId, 1, 151);

    // 子会话没有 system 段：对话直接开头，mc(i) = 对话 i，question 是 mc601。
    const childEntries = [
        ...longConversation,
        { kind: "message", message: { role: "user", content: "child new question" } },
    ];
    noteForkedSession(parentId, childId);
    const result = await runPort(child.port, childId, childEntries);

    const inherit = childLogger.lines.find((line) => line.message.includes("fork inherit"));
    assert.equal(inherit?.context?.trims, true, "夹具：必须触发裁前缀");
    // 601 条 − 末端 450 − 余量 100 = 第 51 条（mc51 = 对话 51）是裁剪位置；boundary
    // 行本身被裁（非 partial），保留从 mc52 = 对话 52 起。
    assert.equal(inherit?.context?.boundaryOrdinal, 51);
    assert.equal(getCompartments(db, childId).at(-1).endMessageId, "mc51");
    // k = 0：请求 = 两个摘要头 + 裁剪位置之后的全部条目（与修复前同值同形）。
    assert.equal(result.entries.length, 2 + (childEntries.length - 51));
    assert.equal(result.entries[0]?.metadata?.source, "magic_context", "没有 system 段时摘要头直接在最前");
    assert.equal(result.entries[1]?.metadata?.source, "magic_context");
    // 裁剪窗口与修复前一致：从对话 52 起逐条保留。active 原文条目引用相等；
    // 继承的 dropped 条目（对话 52..150）被中和成占位符并重建，按位置 + role +
    // 占位符文本断言（「与修复前逐条相同」的可操作形态）。
    const kept = result.entries.slice(2);
    const expectedKept = childEntries.slice(51);
    assert.equal(kept.length, expectedKept.length);
    const asWireText = (entry) =>
        Array.isArray(entry?.message?.content)
            ? entry.message.content[0]?.text
            : entry?.message?.content;
    // 条目被重建（引用不等）只有两种合法形态：dropped 占位符，或 active 原文被
    // §N§ 打标改写（正文不变）——「与修复前逐条相同」的可操作形态。
    const stripTag = (text) => text.replace(/^§\d+§ /, "");
    for (let index = 0; index < kept.length; index += 1) {
        if (kept[index] === expectedKept[index]) continue;
        assert.equal(kept[index]?.message?.role, expectedKept[index]?.message?.role);
        const wire = String(asWireText(kept[index]) ?? "");
        const inputText = expectedKept[index].message?.content;
        const isPlaceholder = /^\[dropped(?: §\d+§)?\]$/.test(wire);
        const isTaggedOriginal = typeof inputText === "string" && stripTag(wire) === inputText;
        assert.ok(
            isPlaceholder || isTaggedOriginal,
            `被重建的保留条目 ${index} 既不是 dropped 占位符也不是打标原文：${wire}`,
        );
    }
    const text = textOfEntries(result.entries);
    assert.ok(!/number (?:[1-9]|[1-9]\d|1[0-4]\d|150)(?!\d)/.test(text), "折叠与裁剪范围内的原文不得出现");
    assert.ok(text.includes("number 400"), "末端未折叠的消息必须保留");
    assert.ok(
        !result.entries.some((entry) => entry.message?.role === "system"),
        "输入没有 system 段时请求也不得凭空出现 system 条目",
    );
});

test("稳定 fork 改写了 callID，工具结果仍按内容继承", async (t) => {
    clearForkRegistryForTests();
    const parentId = "ses_fork_inherit_tool_parent";
    const childId = "ses_fork_inherit_tool_child";
    const parentEntries = [
        { kind: "message", message: { role: "system", content: "you are the parent" } },
        ...conversation("shared", { withTool: true, callId: "call_parent" }),
    ];
    const store = parentStore(parentId, parentEntries);
    const parent = await makePort(parentId, recordingLogger(), store);
    const child = await makePort(childId, recordingLogger(), store);
    t.after(async () => {
        await parent.close();
        await child.close();
    });

    await runPort(parent.port, parentId, parentEntries);
    const db = openDatabase(getMagicContextDatabasePath());
    foldParentThrough(db, parentId, 1, 12);
    db.prepare(
        "UPDATE tags SET status = 'dropped', drop_mode = 'full' WHERE session_id = ? AND type = 'tool'",
    ).run(parentId);
    const parentToolDropped = db
        .prepare(
            "SELECT COUNT(*) AS count FROM tags WHERE session_id = ? AND type = 'tool' AND status = 'dropped'",
        )
        .get(parentId).count;
    assert.equal(parentToolDropped, 1, "夹具：父会话的工具 tag 必须是 dropped");

    const childEntries = [
        { kind: "message", message: { role: "system", content: "you are the child" } },
        ...conversation("shared", { withTool: true, callId: "call_renamed" }),
    ];
    noteForkedSession(parentId, childId);
    await runPort(child.port, childId, childEntries);

    const childTool = db
        .prepare(
            "SELECT message_id AS messageId, tool_owner_message_id AS owner, status FROM tags WHERE session_id = ? AND type = 'tool'",
        )
        .get(childId);
    assert.equal(childTool.status, "dropped", "工具 tag 必须按工具名 + 输出文本继承");
    assert.equal(childTool.messageId, "call_renamed", "tool tag 的身份必须是子会话的 callID");
    assert.ok(
        /^mc\d+$/.test(childTool.owner),
        "tool tag 的 owner 必须是子会话里发起调用的 assistant 条目",
    );
});

test("父会话里没折叠的消息在子会话里原样保留", async (t) => {
    clearForkRegistryForTests();
    const parentId = "ses_fork_inherit_partial_parent";
    const childId = "ses_fork_inherit_partial_child";
    const parentEntries = [
        { kind: "message", message: { role: "system", content: "you are the parent" } },
        ...conversation("shared"),
    ];
    const store = parentStore(parentId, parentEntries);
    const parent = await makePort(parentId, recordingLogger(), store);
    const childLogger = recordingLogger();
    const child = await makePort(childId, childLogger, store);
    t.after(async () => {
        await parent.close();
        await child.close();
    });

    await runPort(parent.port, parentId, parentEntries);
    const db = openDatabase(getMagicContextDatabasePath());
    foldParentThrough(db, parentId, 1, 10);
    // 第 5 条对话在父会话里仍然是 active（mc6）。
    db.prepare(
        "UPDATE tags SET status = 'active' WHERE session_id = ? AND message_id LIKE 'mc6:%'",
    ).run(parentId);

    const childEntries = [
        { kind: "message", message: { role: "system", content: "you are the child" } },
        ...conversation("shared"),
    ];
    noteForkedSession(parentId, childId);
    const result = await runPort(child.port, childId, childEntries);

    const text = textOfEntries(result.entries);
    assert.ok(droppedTagCount(db, childId) > 0, "dropped 状态必须继承");
    assert.equal(getCompartments(db, childId).length, 3, "摘要块必须继承");
    assert.ok(
        text.includes("shared user message number 5"),
        "父会话里没折叠的那条消息必须原样保留",
    );
    assert.ok(
        !/message number [1-4](?!\d)/.test(text),
        "父会话里已折叠的消息在子会话里也必须是占位符",
    );
    assert.ok(
        childLogger.lines.some(
            (line) => line.level === "info" && line.context?.kind === "inherited",
        ),
        "完整继承是一条 info，不是告警",
    );
});

test("没有 fork 登记的会话不触发继承", async (t) => {
    clearForkRegistryForTests();
    const sessionId = "ses_fork_inherit_plain";
    const logger = recordingLogger();
    const { port, close } = await makePort(sessionId, logger, {
        async messages() {
            return [];
        },
    });
    t.after(close);

    await runPort(port, sessionId, [
        { kind: "message", message: { role: "system", content: "you are plain" } },
        ...conversation("plain"),
    ]);

    const db = openDatabase(getMagicContextDatabasePath());
    assert.equal(droppedTagCount(db, sessionId), 0, "普通会话不得出现 dropped tag");
    assert.equal(getCompartments(db, sessionId).length, 0);
    assert.ok(
        !logger.lines.some((line) => line.message.includes("fork inherit")),
        "没有登记时不得进入继承逻辑",
    );
});

test("继承只在首轮发生一次", async (t) => {
    clearForkRegistryForTests();
    const parentId = "ses_fork_inherit_once_parent";
    const childId = "ses_fork_inherit_once_child";
    const parentEntries = [
        { kind: "message", message: { role: "system", content: "you are the parent" } },
        ...conversation("shared"),
    ];
    const store = parentStore(parentId, parentEntries);
    const parent = await makePort(parentId, recordingLogger(), store);
    const childLogger = recordingLogger();
    const child = await makePort(childId, childLogger, store);
    t.after(async () => {
        await parent.close();
        await child.close();
    });

    await runPort(parent.port, parentId, parentEntries);
    const db = openDatabase(getMagicContextDatabasePath());
    foldParentThrough(db, parentId, 1, 10);

    const childEntries = [
        { kind: "message", message: { role: "system", content: "you are the child" } },
        ...conversation("shared"),
    ];
    noteForkedSession(parentId, childId);
    await runPort(child.port, childId, childEntries);
    const afterFirst = droppedTagCount(db, childId);

    noteForkedSession(parentId, childId);
    await runPort(child.port, childId, [
        ...childEntries,
        { kind: "message", message: { role: "user", content: "second turn" } },
    ]);
    assert.equal(
        droppedTagCount(db, childId),
        afterFirst,
        "子会话已有 tag 之后再登记也不得重复继承",
    );
});

test("已折叠消息的随行 reasoning 与父会话同去向", async (t) => {
    clearForkRegistryForTests();
    const parentId = "ses_fork_inherit_reasoning_parent";
    const childId = "ses_fork_inherit_reasoning_child";
    // 第 2 条（会被折叠）与第 12 条（不会）各带一段 reasoning。
    const withReasoning = conversation("shared").map((entry, index) =>
        index === 1 || index === 11
            ? {
                  kind: "message",
                  message: {
                      role: "assistant",
                      content: [
                          { type: "reasoning", text: `reasoning trace ${index === 1 ? "folded" : "kept"}` },
                          { type: "text", text: entry.message.content },
                      ],
                  },
              }
            : entry,
    );
    const parentEntries = [
        { kind: "message", message: { role: "system", content: "you are the parent" } },
        ...withReasoning,
    ];
    const store = parentStore(parentId, parentEntries);
    const parent = await makePort(parentId, recordingLogger(), store);
    const child = await makePort(childId, recordingLogger(), store);
    t.after(async () => {
        await parent.close();
        await child.close();
    });

    await runPort(parent.port, parentId, parentEntries);
    const db = openDatabase(getMagicContextDatabasePath());
    foldParentThrough(db, parentId, 1, 10);
    const parentText = textOfEntries((await runPort(parent.port, parentId, parentEntries)).entries);

    const childEntries = [
        { kind: "message", message: { role: "system", content: "you are the child" } },
        ...withReasoning,
    ];
    noteForkedSession(parentId, childId);
    const childText = textOfEntries((await runPort(child.port, childId, childEntries)).entries);

    assert.ok(childText.includes("reasoning trace kept"), "未折叠消息的 reasoning 必须保留");
    assert.equal(
        childText.includes("reasoning trace folded"),
        parentText.includes("reasoning trace folded"),
        "已折叠消息的 reasoning 去留必须与父会话一致",
    );
    t.diagnostic(
        `已折叠消息的 reasoning 留在请求里：父=${parentText.includes("reasoning trace folded")} 子=${childText.includes("reasoning trace folded")}`,
    );
});

test("包调用抛错时本轮 transform 照常完成", async () => {
    clearForkRegistryForTests();
    const parentId = "ses_fork_inherit_throw_parent";
    const childId = "ses_fork_inherit_throw_child";
    noteForkedSession(parentId, childId);
    const logger = recordingLogger();
    const throwingDb = {
        prepare() {
            throw new Error("database is locked");
        },
    };

    await inheritForkedSessionStateAtTurnStart({
        db: throwingDb,
        sessionId: childId,
        childMessages: [],
        sessionStore: undefined,
        logger,
    });

    assert.ok(
        logger.lines.some(
            (line) => line.level === "warn" && line.message.includes("failed"),
        ),
        "必须记一条 warn",
    );
    assert.equal(
        takePendingForkParent(childId),
        undefined,
        "失败后登记已取走，不会每轮重试",
    );
});
