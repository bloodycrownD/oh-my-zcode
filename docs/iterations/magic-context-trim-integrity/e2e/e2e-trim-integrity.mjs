#!/usr/bin/env node
/* oxlint-disable max-lines -- e2e 过程产物：真实库拷贝 + T-E1~T-E4 断言矩阵 + source_contents 快照比对，拆分无收益（先例：docs/iterations/magic-context-fork-inherit/e2e/e2e-fork-inherit.mjs） */
/**
 * e2e-trim-integrity — magic-context-trim-integrity 真机数据验证（spec Step 13 / 变更点 #13）。
 *
 * 唯一事实来源：docs/iterations/magic-context-trim-integrity/spec.md「测试策略·问题四」。
 * 用真实库的只读拷贝回答四个问题（T-E1 ~ T-E4），用机器上最长的两个会话各跑一遍，
 * 并记录每次 pass 的请求条数、字符量、耗时作为基线。
 *
 * 每个会话的 pass 序列（同一个 port 实例，sessionId = 真实会话 id）：
 *   V0  对照基线（k=0）：[...会话条目, 新 user]。输入开头没有 system 段——修复对
 *       k=0 的裁剪结果逐条不变（spec T-S4 的语义），所以 V0 是「修复前请求形态」的
 *       当时代理；V1 相对 V0 的头部平移也正好让位置命中的旧 tag 走一遍内容校验。
 *   V1  主断言（k=1）：[system, ...会话条目, 新 user]。T-E1 / T-E2 落在它身上。
 *   P3  平移 pass 1（T-E3）：[system, context 条目, ...会话条目, 新 user]——模拟重启
 *       后前缀重建在 system 段之后多出的 context 附件条目（与真实前缀重建同形）。
 *   P4  平移 pass 2：同 P3 输入再跑一遍，与 P3 构成「连续两个 pass」。
 *   E4  T-E4：抽 ≤30 个有存量原文的 dropped tag，ctx_expand tag 模式逐字比对。
 *
 * 断言与 spec 的对应（v2 修订）：
 *   T-E1  两个最长的**裁剪形态**真实会话（先按 session_meta.cached_m0_last_baseline_
 *         end_message_id 非空过滤，再按 tags 总数取前二；不足两个时如实记录、不悄悄
 *         换口径——未裁剪形态的对照没有意义）：父会话自身的首轮请求以 system prompt
 *         起头（system在=true）；修复的增量恰为 system 段——基线取同会话的 V0（k=0
 *         时修复前后逐条相同，即修复前形态的当时代理）。裁剪形态下裁点是位置串，
 *         按绝对位置切：头部平移会把边缘对话条目拖进保留窗口（既有位置语义，fork-
 *         inherit 记忆 :116 书面确认），所以裁剪且投影稳定时断言「V1 对话序列 =
 *         ≤1 条边缘条目 + V0 对话序列逐条相等（剥 §N§/占位符号）」，其余形态断言
 *         条数差恰为 k。fork-inherit 记录的历史基线（父 389 / 853，
 *         docs/apm/memory/20261125-magic-context-fork-inherit.md:124）打印对照。
 *         V1 不抛 MC-H04 / 超窗。
 *   T-E2  摘要块数不变；heal 没有清账；system 条目的 tag 存在且没有被置为 compacted
 *         （先断言存在，T-S6 的教训）；工具弧改为「V1 相对 V0 没有新增的孤立调用」
 *         （V0 自身可能因既有「位置裁剪劈弧」带孤立调用/孤立结果——见 spec 已知
 *         限制，单独立项，不算本次引入）。
 *   T-E3  模拟重启平移（system 段后插一条 role=user 的 context 条目）连续两个 pass：
 *         **硬闸门**——第二个 pass 之后，全部有存量原文的文本 tag 中被改写的数量
 *         为 0（V1 后 vs P4 后 source_contents 快照；v2 把范围从「文本唯一的 tag」
 *         扩大到全部有原文的 tag——v1 的唯一性过滤恰好漏掉真实数据上主要的失效
 *         面，初版实测 1/1445 与 92/662，不能以「比修复前好」放过）；没有任何存量
 *         原文被改写成 system prompt 文本。P3/P4 的工具弧成对降为观察项（与 V0
 *         对照并列打印）。观察项（不作断言）：识别出的 d*、平移相符 / 不符 / 落空
 *         三分支各自的 part 数、平移后窗口内保号的 part 占比、system 行因平移拿到
 *         新号的个数、搁浅的旧 system tag 数。
 *   T-E4  ctx_expand 输出剥掉 `  [text]\n` 包装后与该 tag 存量原文逐字相等。
 *
 * 平移观察项的取数（MC_TRIM_E2E_SHIFT=1 开启）：包内没有 d* 与三分支计数的可读
 * 出口——port 返回值只有 { entries, outcome, syntheticHeadPositions }
 * （bootstrap/src/app/magic-context-turn-transform.ts:2215/2279/2311）；d*
 * （driftShift）是 buildTagContentPlans 的闭包局部变量，三分支计划只在内部消费；
 * sessionLog 仅输出防御 warn（tag-messages.ts:1018/1035）。脚本侧也无法按
 * spec (b′) 复算：posIdx 查表需要包内打标输入的绝对 mc 坐标（m0/m1 注入后的
 * 编号不经 port 暴露），坐标对不齐则查表错位。故 d* 与三分支计数按任务约定以
 * 0 占位并注明不可得；保号占比由脚本侧按请求 wire 的 §N§ 对比计算（以剥章文本
 * 为键、跳过样板歧义键的宽松口径，见 keptRatio）。
 *
 * 约束（仿 docs/iterations/magic-context-fork-inherit/e2e/e2e-fork-inherit.mjs）：
 *   - 真实库只作为 copyFileSync 的源，绝不打开、绝不写入；
 *   - MAGIC_CONTEXT_DB_DIR / MAGIC_CONTEXT_LOG_PATH 在 dynamic import dist 之前设置；
 *   - 不调用任何模型；可重复执行，每次 mkdtemp 独立目录；跑完删除（Windows 上 sqlite
 *     句柄未释放时 EPERM，残留目录在 tmpdir 下，交给 OS 回收）。
 *   - MC_TRIM_E2E_KEEP=1 保留现场；MC_TRIM_E2E_REUSE=<目录> 复用已拷贝的库（迭代用）；
 *     MC_TRIM_E2E_DUMP=1 把每次 pass 的请求条目清单写进现场目录（失败诊断用）；
 *     MC_TRIM_E2E_SHIFT=1 输出 v2 平移观察项（d* / 三分支计数 / 保号占比，见上文
 *     「平移观察项的取数」）。
 *
 * 用法（编排脚本从仓库根运行）：
 *   node --import tsx docs/iterations/magic-context-trim-integrity/e2e/e2e-trim-integrity.mjs
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

const KEEP = process.env.MC_TRIM_E2E_KEEP === "1";
const REUSE = process.env.MC_TRIM_E2E_REUSE ?? "";
const DUMP = process.env.MC_TRIM_E2E_DUMP === "1";
const SHIFT = process.env.MC_TRIM_E2E_SHIFT === "1";
const WORK =
    REUSE !== "" && existsSync(REUSE) ? REUSE : mkdtempSync(join(tmpdir(), "zcode-mc-e2e-trim-"));
process.env.MAGIC_CONTEXT_DB_DIR = WORK;
process.env.MAGIC_CONTEXT_LOG_PATH = join(WORK, "magic-context.log");
process.on("exit", () => {
    if (KEEP || (REUSE !== "" && existsSync(REUSE))) return;
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
// e2e-fork-inherit.mjs 同一手法指到 dist。
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

// E1.3 的序列对照要剥掉 wire 文本里的 §N§ 前缀（同一条目在两个 pass 会被编不同的号）。
const { stripTagPrefix } = await import(
    new URL("apps/zcode-cli/packages/magic-context/dist/core/hooks/magic-context/tag-content-primitives.js", REPO)
        .href,
);

// ── 断言账本 ─────────────────────────────────────────────────────────────────

const cases = [];
let failed = 0;

function check(id, name, pass, detail) {
    if (!pass) failed += 1;
    cases.push({ id, name, pass });
    console.log(`  ${pass ? "ok  " : "FAIL"} ${id} ${name}${detail === undefined ? "" : `  (${detail})`}`);
}

/** 线上形态检查（与 e2e-fork-inherit.mjs 同款）：每个工具调用必须有结果，每个结果必须有调用。 */
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

const clone = (entry) => structuredClone(entry);
const isOverWindow = (p) =>
    !p.ok && (p.error.includes("MC-H04") || p.error.includes("UNMANAGED_OVER_WINDOW"));

function makeLogger(logs) {
    return {
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
    };
}

async function main() {
    const realDbDir = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".omz", "cli", "db");
    if (REUSE === "" || !existsSync(REUSE)) {
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
    } else {
        console.log(`复用已拷贝的库：${REUSE}`);
    }

    const mc = await import(distUrl("magic-context", "index.js"));
    const core = await import(distUrl("core", "index.js"));
    const adapters = await import(distUrl("adapters", "index.js"));
    const { createMagicContextTurnTransform } = await import(
        distUrl("bootstrap", "app/magic-context-turn-transform.js"),
    );

    const db = mc.openDatabase(mc.getMagicContextDatabasePath());
    const store = adapters.createSqliteSessionStore({ dbPath: join(WORK, "db.sqlite") });

    // ── 选会话（v2）：先按裁剪形态过滤——session_meta.cached_m0_last_baseline_
    //    end_message_id 非空（存在可解析的基线边界，即真实运行裁过前缀）——再按
    //    tags 总数取前两个。spec T-E1 v2 修订：未裁剪形态的对照没有意义。找不到
    //    两个时如实记录（check 失败 + 打印候选），不悄悄换回旧口径。
    const sessions = db
        .prepare(
            `SELECT t.session_id AS id, COUNT(*) AS tags, SUM(t.status = 'dropped') AS dropped
               FROM tags t
              WHERE t.session_id IN (
                        SELECT session_id FROM session_meta
                         WHERE cached_m0_last_baseline_end_message_id IS NOT NULL
                           AND cached_m0_last_baseline_end_message_id != ''
                    )
                AND t.session_id NOT LIKE 'sess_e2e%' AND t.session_id NOT LIKE 'sess_dwf-%'
              GROUP BY t.session_id ORDER BY tags DESC LIMIT 2`,
        )
        .all();
    console.log(
        `\n最长两个裁剪形态会话（基线边界非空，按 tags 总数）：${sessions.map((s) => `${s.id}（tags=${s.tags} dropped=${s.dropped}）`).join("、") || "无"}`,
    );
    check(
        "pick",
        "按裁剪形态过滤后找到两个最长会话",
        sessions.length === 2,
        sessions.length === 2
            ? sessions.map((s) => s.id).join("、")
            : `只找到 ${sessions.length} 个，不回退旧口径，仅跑找到的`,
    );

    const closeHooks = [];
    for (const { id: sessionId } of sessions) {
        await verifySession({ mc, core, db, store, sessionId, closeHooks, createMagicContextTurnTransform });
    }

    for (const close of closeHooks) await close();
    db.close?.();
    await store.close?.();
}

async function verifySession({ mc, core, db, store, sessionId, closeHooks, createMagicContextTurnTransform }) {
    const s8 = sessionId.replace(/^sess_/, "").slice(0, 8);
    console.log(`\n──── 会话 ${sessionId} ────`);

    // 真实 store + 真实 hydrator：会话消息行 → 运行时条目（与 e2e-fork-inherit.mjs 同款）
    const messages = await store.messages({ sessionID: sessionId });
    const history = core.createMessageHistory();
    await core.hydrateMessageHistoryFromSession({ history, messages });
    const conversation = history.borrowReadOnlyRuntimeEntries();
    console.log(`  消息行 ${messages.length} → 运行时条目 ${conversation.length}`);

    const SYSTEM_MARKER = `e2e-trim: system prompt of ${s8}`;
    const CONTEXT_MARKER = `e2e-trim: context attachment inserted after the system block to simulate a restart prefix shift (${s8})`;
    const NEW_QUESTION = `e2e-trim: first question of this verification pass (${s8})`;
    const sysEntry = { kind: "message", message: { role: "system", content: SYSTEM_MARKER } };
    const ctxEntry = { kind: "message", message: { role: "user", content: CONTEXT_MARKER } };
    const askEntry = { kind: "message", message: { role: "user", content: NEW_QUESTION } };
    const build = (...head) => [...head.map(clone), ...conversation.map(clone), clone(askEntry)];

    const initialCompartments = db
        .prepare(`SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?`)
        .get(sessionId).n;

    const logs = [];
    const port = await createMagicContextTurnTransform({
        enabled: true,
        configDomain: {},
        sessionId,
        workingDirectory: WORK,
        logger: makeLogger(logs),
        sessionStore: store,
        processExitsAfterTurn: false,
        registerClose: (close) => closeHooks.push(close),
    });
    if (!port) throw new Error("magic-context port unavailable");

    const runPass = async (label, entries) => {
        const startedAt = performance.now();
        try {
            const result = await port({
                entries,
                model: { providerId: "zcode", modelId: "glm-4.6" },
                sessionId,
                workingDirectory: WORK,
            });
            const text = textOf(result.entries);
            return {
                label,
                ok: true,
                ms: Math.round(performance.now() - startedAt),
                entries: result.entries,
                count: result.entries.length,
                chars: text.length,
                text,
                placeholders: (text.match(/\[dropped §\d+§\]/g) ?? []).length,
                shape: danglingToolArcs(result.entries),
                outcome: result.outcome,
            };
        } catch (error) {
            return {
                label,
                ok: false,
                ms: Math.round(performance.now() - startedAt),
                error: `${error?.constructor?.name ?? "Error"}: ${error?.message ?? error}`,
            };
        }
    };

    const snapshotSources = () =>
        new Map(
            db
                .prepare(`SELECT tag_id AS tagId, content FROM source_contents WHERE session_id = ?`)
                .all(sessionId)
                .map((r) => [r.tagId, r.content]),
        );
    const dumpEntries = (label, entries) => {
        if (!DUMP) return;
        const describe = (entry, index) => {
            if (entry.kind === "attachment") return `#${index} [attachment] ${String(entry.content).slice(0, 120).replace(/\n/g, "\\n")}`;
            const m = entry.message ?? {};
            const calls = (m.toolCalls ?? []).map((c) => `call ${c.id.slice(0, 16)}:${c.name}`).join(",");
            const result = m.role === "tool" ? `result ${String(m.toolCallId).slice(0, 16)}` : "";
            const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
            return `#${index} [${m.role ?? entry.kind}] ${calls} ${result} ${c.slice(0, 120).replace(/\n/g, "\\n")}`;
        };
        writeFileSync(join(WORK, `dump-${s8}-${label}.txt`), entries.map(describe).join("\n"), "utf8");
    };
    const systemTagRows = () =>
        db
            .prepare(
                `SELECT tag_number AS n, status AS st, message_id AS mid FROM tags
                  WHERE session_id = ? AND message_role = 'system' ORDER BY tag_number ASC`,
            )
            .all(sessionId);

    // ── pass 序列：V0（k=0 基线）→ V1（k=1 主断言）→ P3 / P4（平移两个 pass）──
    const conversationShape = danglingToolArcs(conversation);
    console.log(
        `  输入对话自身的弧形态（既有基线）：有调用没结果 ${conversationShape.missingResults.length}，有结果没调用 ${conversationShape.orphanResults.length}`,
    );
    const v0 = await runPass("V0", build());
    const v1 = await runPass("V1", build(sysEntry));
    const snapA = snapshotSources();
    const sysBefore = systemTagRows();
    const p3 = await runPass("P3", build(sysEntry, ctxEntry));
    const p4 = await runPass("P4", build(sysEntry, ctxEntry));
    const snapB = snapshotSources();
    const sysAfter = systemTagRows();
    for (const [label, entries] of [["V0", v0.entries], ["V1", v1.entries], ["P3", p3.entries], ["P4", p4.entries]]) {
        if (entries) dumpEntries(label, entries);
    }

    console.log(`  基线（请求条数 / 字符量 / 耗时）：`);
    for (const p of [v0, v1, p3, p4]) {
        if (p.ok)
            console.log(
                `    ${p.label}  条数=${String(p.count).padStart(6)}  字符=${String(p.chars).padStart(9)}  耗时=${String(p.ms).padStart(6)}ms  outcome=${p.outcome}  弧=${p.shape.missingResults.length}/${p.shape.orphanResults.length}`,
            );
        else console.log(`    ${p.label}  被拒发（${p.ms}ms）：${p.error}`);
    }

    // ── T-E1 ────────────────────────────────────────────────────────────────
    const firstMessage = v1.ok ? v1.entries.find((e) => e.kind !== "attachment")?.message : null;
    check(
        `${s8}·E1.0`,
        "V0 对照 pass（k=0，修复前形态的当时代理）成功发出",
        v0.ok,
        v0.ok ? `${v0.count} 条` : v0.error,
    );
    check(
        `${s8}·E1.1`,
        "V1 主 pass 成功发出，不抛 MC-H04 / 超窗",
        v1.ok,
        v1.ok ? `outcome=${v1.outcome}` : isOverWindow(v1) ? `超窗拒发：${v1.error}` : v1.error,
    );
    check(
        `${s8}·E1.2`,
        "V1 请求以 system prompt 起头（system在=true）",
        firstMessage?.role === "system" && v1.text.includes(SYSTEM_MARKER),
        firstMessage ? `首条 message role=${firstMessage.role}` : "无 message 条目",
    );
    // E1.3 的基线对照：修复的增量必须恰为 system 段。裁剪会话的裁点是位置串
    // （compartments 边界 / cached baseline），按绝对位置切——头部平移 d 条会把
    // d 条边缘对话条目拖进保留窗口（既有位置语义，fork-inherit 记忆 :116 书面确认、
    // 本迭代未触碰）。所以裁剪形态断言「V1 对话序列 = ≤1 条边缘条目 + V0 对话序列
    // 逐条相等（剥 §N§/占位符号）」——钉死修复的增量恰为 system 段，没有任何别的
    // 差异；不裁剪形态（无裁点可解析）保留原条数断言。
    const seqKey = (entry) => {
        const m = entry.message ?? {};
        // 同一条目在两个 pass 的投影差异都是打标噪声：§N§ 前缀随编号重排、
        // [dropped §N§] 占位符号随轮次变、whitespace-only text part 的呈现随轮次
        // 浮动、content 形态在 string 与 [{type:"text"}] blocks 之间随轮次变化
        // （V0 带 §9422§ 章前缀的 blocks、V1 纯 string）——统一归一成拼接文本对照。
        const normText = (t) =>
            stripTagPrefix(String(t)).replace(/\[dropped §\d+§\]/g, "[dropped]");
        const normContent = (content) => {
            if (content == null || typeof content === "string") return normText(content ?? "");
            if (Array.isArray(content)) {
                return content
                    .filter(
                        (b) =>
                            !(
                                b &&
                                b.type === "text" &&
                                typeof b.text === "string" &&
                                normText(b.text).trim() === ""
                            ),
                    )
                    .map((b) =>
                        b && b.type === "text" && typeof b.text === "string"
                            ? normText(b.text)
                            : JSON.stringify(b),
                    )
                    .join("\n");
            }
            return normText(JSON.stringify(content));
        };
        const calls = (m.toolCalls ?? []).map((c) => `call:${c.id}:${c.name}`).join(",");
        const result = m.role === "tool" ? `res:${m.toolCallId}` : "";
        return `${m.role ?? entry.kind}|${calls}|${result}|${normContent(m.content)}`;
    };
    const seqOf = (run) =>
        run.ok ? (run.entries ?? []).filter((e) => e.kind !== "attachment").map(seqKey) : [];
    const sv0 = seqOf(v0);
    const sv1raw = seqOf(v1);
    const sv1 = sv1raw[0]?.startsWith("system|") ? sv1raw.slice(1) : sv1raw;
    const trimmedAway = conversation.length + 1 - sv0.length;
    // 内容对照只在「两轮折叠投影形态一致」时可用：占位符计数不等说明 dropped 状态
    // 的位置重放在两轮间错位不同（合成全量重放形态的固有噪声，如 65700b26 的
    // 9 vs 10），逐条对照会被投影噪声淹没——该形态退回条数断言（不裁剪/同构裁点
    // 下条数差恰为 k 本身就是可测事实）。
    const placeholdersStable = v0.ok && v1.ok && v0.placeholders === v1.placeholders;
    if (v0.ok && v1.ok && trimmedAway > 0 && placeholdersStable) {
        const L = sv1.length - sv0.length;
        check(
            `${s8}·E1.3a`,
            "V1 相对 V0 的对话条目差 = 位置裁点拖入的边缘条数 L∈{0,1}",
            L === 0 || L === 1,
            `L=${L}（V1 对话 ${sv1.length} vs V0 ${sv0.length}，裁掉 ${trimmedAway}）`,
        );
        let firstDiff = -1;
        const tailEqual =
            L >= 0 &&
            sv1.slice(L).every((x, i) => {
                const same = x === sv0[i];
                if (!same && firstDiff < 0) firstDiff = i;
                return same;
            });
        check(
            `${s8}·E1.3b`,
            "V1 对话序列 = 边缘条目(≤1) + V0 对话序列逐条相等（修复的增量恰为 system 段）",
            tailEqual,
            tailEqual
                ? `L=${L}`
                : `首个不等 @${firstDiff}：V1=${JSON.stringify(String(sv1[L + firstDiff]).slice(0, 100))} V0=${JSON.stringify(String(sv0[firstDiff]).slice(0, 100))}`,
        );
    } else {
        check(
            `${s8}·E1.3`,
            "V1 条数相对基线只多出 system 段条数 k=1（±0；条数形态）",
            v1.ok && v0.ok && v1.count === v0.count + 1,
            v0.ok && v1.ok
                ? `V1=${v1.count} vs V0=${v0.count}+1（裁掉 ${trimmedAway}、占位符 ${v0.placeholders}/${v1.placeholders}${placeholdersStable ? "" : "，投影噪声大退条数断言"}）`
                : "pass 失败",
        );
    }
    console.log(
        `  fork-inherit e2e 历史基线（2026-11-25，docs/apm/memory/20261125-magic-context-fork-inherit.md:124）：` +
            `父会话自身 389 / 853 条（修复前形态）；本次 V0=${v0.ok ? v0.count : "拒发"}。V0 命中历史值时 V1 应为其 +1。`,
    );

    // ── T-E2 ────────────────────────────────────────────────────────────────
    // 工具弧的绝对成对性是既有「位置裁剪劈弧」（spec 已知限制：裁点按绝对位置取，
    // 落在调用与结果之间时请求里出现孤立调用或孤立结果；单独立项「裁剪边界的工具
    // 弧完整性」）——V0 自身就可能带孤立调用/孤立结果，不算本次引入。v2 硬断言只
    // 要求 V1 相对 V0 没有新增的孤立调用；P3/P4 的成对性降为观察项（见 T-E3 段）。
    const arcCounts = (p) =>
        p.ok
            ? { missing: p.shape.missingResults.length, orphan: p.shape.orphanResults.length }
            : null;
    check(
        `${s8}·E2.0`,
        "V1 相对 V0 没有新增的孤立调用（有调用没结果不增加）",
        v1.ok && v0.ok && v1.shape.missingResults.length <= v0.shape.missingResults.length,
        v1.ok && v0.ok
            ? `孤立调用 V1=${v1.shape.missingResults.length} vs V0=${v0.shape.missingResults.length}（孤立结果 V1=${v1.shape.orphanResults.length} / V0=${v0.shape.orphanResults.length}）`
            : "pass 失败",
    );
    const compartmentsAfterV1 = db
        .prepare(`SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?`)
        .get(sessionId).n;
    check(
        `${s8}·E2.1`,
        "摘要块数不变",
        compartmentsAfterV1 === initialCompartments,
        `${compartmentsAfterV1} / 初始 ${initialCompartments}`,
    );
    if (initialCompartments > 0) {
        const ledger = db
            .prepare(
                `SELECT COALESCE(MAX(end_message), 0) AS lastEnd, COALESCE(MIN(start_message), 0) AS firstStart,
                        SUM(CASE WHEN prev_end IS NOT NULL AND start_message != prev_end + 1 THEN 1 ELSE 0 END) AS gaps
                   FROM (SELECT c.*, LAG(end_message) OVER (ORDER BY sequence) AS prev_end
                           FROM compartments c WHERE session_id = ?)`,
            )
            .get(sessionId);
        check(
            `${s8}·E2.2`,
            "heal 没有清账（区间从 1 起无缝、末端 > 0）",
            ledger.firstStart === 1 && ledger.gaps === 0 && ledger.lastEnd > 0,
            `1..${ledger.lastEnd} 空洞 ${ledger.gaps}`,
        );
    } else {
        check(`${s8}·E2.2`, "heal 没有清账（初始无摘要块，无账可清）", true, "compartments=0");
    }
    check(
        `${s8}·E2.3`,
        "system 条目的 tag 存在",
        sysAfter.length > 0,
        `${sysAfter.length} 行（message_role='system'）`,
    );
    const compactedSystem = sysAfter.filter((r) => r.st === "compacted");
    check(
        `${s8}·E2.4`,
        "system 条目的 tag 没有被置为 compacted",
        sysAfter.length > 0 && compactedSystem.length === 0,
        `compacted ${compactedSystem.length}`,
    );

    // ── T-E3 ────────────────────────────────────────────────────────────────
    check(`${s8}·E3.0`, "P3 平移 pass 成功发出", p3.ok, p3.ok ? `${p3.count} 条` : p3.error);
    check(`${s8}·E3.1`, "P4 平移 pass 成功发出", p4.ok, p4.ok ? `${p4.count} 条` : p4.error);
    let rewritten = 0;
    const rewriteSamples = [];
    // v2 硬闸门：范围从「文本唯一的 tag」扩大到全部有存量原文的 tag（快照全表，
    // 不再按唯一性过滤——v1 的唯一性过滤恰好漏掉真实数据上主要的失效面，初版
    // 实测 1/1445 与 92/662，不能以「比修复前好」放过）。新增行（新号落库）不算
    // 改写，只比对快照 A 中已有 tag 的原文是否变化。
    for (const [tagId, before] of snapA) {
        const after = snapB.get(tagId);
        if (after !== before) {
            rewritten += 1;
            if (rewriteSamples.length < 3)
                rewriteSamples.push(
                    `tag ${tagId}: ${JSON.stringify(String(before).slice(0, 60))} → ${after === undefined ? "<行消失>" : JSON.stringify(String(after).slice(0, 60))}`,
                );
        }
    }
    // 空转防护：P3/P4 被拒发时打标根本没跑，快照比对恒为「零改写」——这个 ok
    // 不构成 v2 硬闸门的证据（T-S6 的同款教训），pass 失败时本断言一并失败。
    const shiftPassesRan = p3.ok && p4.ok;
    check(
        `${s8}·E3.2`,
        "平移两个 pass 后，有存量原文的文本 tag 零改写（v2 硬闸门：全部有原文的 tag）",
        shiftPassesRan && rewritten === 0,
        shiftPassesRan
            ? `${rewritten} / ${snapA.size}${rewriteSamples.length ? `；${rewriteSamples.join("；")}` : ""}`
            : `P3/P4 被拒发（打标未执行），零改写未获验证——不可计为通过`,
    );
    const rewrittenToSystem = [...snapA]
        .filter(([tagId, before]) => before !== SYSTEM_MARKER && snapB.get(tagId) === SYSTEM_MARKER)
        .map(([tagId]) => tagId);
    check(
        `${s8}·E3.3`,
        "没有任何存量原文被改写成 system prompt 的文本",
        shiftPassesRan && rewrittenToSystem.length === 0,
        shiftPassesRan
            ? `${rewrittenToSystem.length} 行${rewrittenToSystem.length ? `：${rewrittenToSystem.slice(0, 5).join(",")}` : ""}`
            : "P3/P4 被拒发，未获验证",
    );
    // P3/P4 的工具弧成对性：既有「位置裁剪劈弧」（spec 已知限制——裁点按绝对位置
    // 取，落在调用与结果之间时请求里出现孤立调用或孤立结果；孤立调用会被模型拒收。
    // 单独立项「裁剪边界的工具弧完整性」，三项修复都不处理它），v2 修订降为观察项：
    // 与 V0（修复前形态）对照并列打印，不作断言。
    const arcLine = (label, p) => {
        const c = arcCounts(p);
        return c ? `${label} 孤立调用 ${c.missing} / 孤立结果 ${c.orphan}` : `${label} pass 失败`;
    };
    console.log(
        `  观察项（既有「位置裁剪劈弧」，单独立项「裁剪边界的工具弧完整性」，不作断言）：` +
            [arcLine("V0", v0), arcLine("V1", v1), arcLine("P3", p3), arcLine("P4", p4)].join("；") +
            "——V0 是修复前形态的对照基线",
    );
    // ── v2 平移观察项（不作断言；MC_TRIM_E2E_SHIFT=1 输出）──
    // d* 与三分支计数（平移相符 / 不符 / 落空的 part 数）：包内没有可读出口——
    // port 返回值只有 { entries, outcome, syntheticHeadPositions }；driftShift 是
    // buildTagContentPlans 的闭包局部变量；sessionLog 只输出防御 warn。脚本侧也无法
    // 按 spec (b′) 复算：posIdx 查表需要包内打标输入的绝对 mc 坐标（m0/m1 注入后的
    // 编号不经 port 暴露，坐标对不齐查表会错位）。按任务约定以 0 占位并注明不可得。
    // 保号占比脚本侧可测：对比两个 pass 请求 wire 的 §N§——以剥章文本为键、跳过
    // 样板歧义键（同文本多号）的宽松口径，样板键的高估被歧义跳过抵消大半。
    const tagNumbersByText = (run) => {
        const map = new Map();
        for (const entry of run.entries ?? []) {
            const message = entry.message;
            if (!message) continue;
            const texts =
                typeof message.content === "string"
                    ? [message.content]
                    : Array.isArray(message.content)
                      ? message.content
                            .filter((b) => b && b.type === "text" && typeof b.text === "string")
                            .map((b) => b.text)
                      : [];
            for (const raw of texts) {
                const tag = /§(\d+)§/.exec(raw);
                if (!tag) continue;
                const key = stripTagPrefix(raw);
                if (!map.has(key)) map.set(key, new Set());
                map.get(key).add(Number(tag[1]));
            }
        }
        return map;
    };
    const keptRatio = (baseRun, targetRun) => {
        const base = tagNumbersByText(baseRun);
        let comparable = 0;
        let kept = 0;
        let ambiguous = 0;
        for (const [text, numbers] of tagNumbersByText(targetRun)) {
            const baseNumbers = base.get(text);
            if (!baseNumbers || baseNumbers.size === 0) continue;
            if (baseNumbers.size !== 1 || numbers.size !== 1) {
                ambiguous += 1;
                continue;
            }
            comparable += 1;
            if ([...baseNumbers][0] === [...numbers][0]) kept += 1;
        }
        return {
            comparable,
            kept,
            ambiguous,
            ratio: comparable > 0 ? `${kept}/${comparable} = ${((kept / comparable) * 100).toFixed(1)}%` : "无可比键",
        };
    };
    if (SHIFT) {
        const shifted = keptRatio(v1, p3);
        const stable = keptRatio(p3, p4);
        console.log(
            `  平移观察项（不作断言）：识别出的 d* = 0（占位——包内无可读出口，见上方注释）；` +
                `平移相符 / 不符 / 落空 = 0 / 0 / 0（占位，同前）；` +
                `保号占比 P3 相对 V1（平移一轮）= ${shifted.ratio}（跳过歧义键 ${shifted.ambiguous}）；` +
                `P4 相对 P3（同输入稳定性）= ${stable.ratio}（跳过歧义键 ${stable.ambiguous}）`,
        );
    } else {
        console.log(
            `  平移观察项：未开启 MC_TRIM_E2E_SHIFT=1——d* / 三分支计数 / 保号占比未采集（包内无 d* 出口，开启后 d* 与三分支仍以 0 占位，仅保号占比按 wire §N§ 实算）`,
        );
    }
    const newSystemTags = sysAfter.filter((r) => !sysBefore.some((b) => b.n === r.n));
    const stranded = sysAfter.filter((r) => r.st === "active" && !/^mc1:p/.test(r.mid ?? ""));
    console.log(
        `  观察项（不作断言）：system-role tag V1后=${sysBefore.length} → P4后=${sysAfter.length}；` +
            `平移拿新号 ${newSystemTags.map((r) => r.n).join(",") || "无"}；` +
            `疑似搁浅 active 旧 system tag ${stranded.length}（样本 ${stranded.slice(0, 4).map((r) => `${r.n}@${r.mid}`).join(",") || "无"}）`,
    );

    // ── T-E4 ────────────────────────────────────────────────────────────────
    const dropped = db
        .prepare(
            `SELECT t.tag_number AS n, s.content AS c
               FROM tags t JOIN source_contents s
                 ON s.session_id = t.session_id AND s.tag_id = t.tag_number
              WHERE t.session_id = ? AND t.status = 'dropped' AND t.type = 'message'
                AND LENGTH(COALESCE(s.content, '')) > 0 AND TRIM(s.content) != ''
              ORDER BY t.tag_number LIMIT 30`,
        )
        .all(sessionId);
    if (dropped.length === 0) {
        check(
            `${s8}·E4.0`,
            "ctx_expand 存量原文抽样（无带存量原文的 dropped tag，跳过并记录）",
            true,
            "样本 0 条",
        );
    } else {
        const tools = mc.createCtxExpandTools({ db });
        let mismatch = 0;
        const samples = [];
        for (const row of dropped) {
            const out = await tools.ctx_expand.execute({ tag: row.n }, { sessionID: sessionId });
            if (out !== `  [text]\n${row.c}`) {
                mismatch += 1;
                if (samples.length < 3)
                    samples.push(
                        `tag ${row.n}: got ${JSON.stringify(out.slice(0, 70))} want ${JSON.stringify(row.c.slice(0, 70))}`,
                    );
            }
        }
        check(
            `${s8}·E4.0`,
            "ctx_expand tag 模式剥掉 [text] 包装后与存量原文逐字相等",
            mismatch === 0,
            `${dropped.length - mismatch}/${dropped.length}${samples.length ? `；${samples.join("；")}` : ""}`,
        );
    }

    // 失败时的现场附件（诊断用，不改变断言）
    if (failed > 0) {
        const dump = [
            `session ${sessionId}`,
            ...[v0, v1, p3, p4].map((p) =>
                p.ok
                    ? `${p.label} ok count=${p.count} chars=${p.chars} outcome=${p.outcome}`
                    : `${p.label} FAILED ${p.error}`,
            ),
            `logs: ${JSON.stringify(logs.slice(-30), null, 1)}`,
        ].join("\n");
        writeFileSync(join(WORK, `debug-${s8}.txt`), dump, "utf8");
    }
}

let exitCode = 0;
try {
    await main();
} catch (error) {
    failed += 1;
    exitCode = 1;
    console.error("\n致命错误：", error?.stack ?? error);
}

console.log(`\n${cases.filter((c) => c.pass).length}/${cases.length} 通过，失败 ${failed}`);
if (KEEP || REUSE !== "") console.log(`现场保留：${WORK}`);
process.exit(failed === 0 && exitCode === 0 ? 0 : 1);
