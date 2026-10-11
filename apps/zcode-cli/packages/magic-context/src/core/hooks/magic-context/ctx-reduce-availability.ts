/**
 * Step 16 真身归位（D10 / bugfix-batch-20261011）：本文件原先是
 * `core/deferred/ctx-reduce-availability.ts` 的「引用子集壳」（r4 P1-1 修正：
 * 该壳并非逐字真身，而是按 fork 引用面裁剪的摘录），现按 spec 裁定 git mv 保
 * rename 轨迹 + 内容整体替换为上游真身，并在文件头登记差异。
 *
 * 上游：`.reference/magic-context/packages/plugin/src/hooks/magic-context/
 * ctx-reduce-availability.ts`（569 行，路径与 fork 落位一致）。逐字保真的
 * 部分：工具表 fail-open 判定的完整状态机——`verdictFromToolsMap` /
 * `unfrozenVerdict` / `resolveToolAvailabilityFromMessages` /
 * `resolveCtxReduceAvailabilityFromMessages` /
 * `resolveTodowriteAvailabilityFromMessages`、首用户消息冻结与
 * `availabilityBySession` 缓存、spawn 权限预热链（`primeCtxReduceSpawnPermission`
 * → `ctxReduceSpawnPermissionDenied`，读失败 fail-open 逐字保留）、
 * `spawnAgentFromMessages`、`cachedToolPermissionDenied`、
 * `hasLoggedCtxReducePermissionDeny` / `markCtxReducePermissionDenyLogged`。
 *
 * 裁剪（壳中裁剪掉的 exports 按 fork 引用面不复活，spec D10）：
 * `resolveToolAvailability` / `resolveCtxReduceAvailability` /
 * `resolveTodowriteAvailability`（OpenCode DB 臂，宿主无 opencode.db 可读）、
 * `clearToolAvailability` / `clearCtxReduceAvailability` /
 * `clearTodowriteAvailability` / `clearToolPermissionDenied`（测试/重置助手）、
 * `setCtxReduceRegisteredGlobally` /
 * `resetCtxReduceRegisteredGloballyForTest`（上游 compaction-off 的全局注册
 * 覆盖器，fork 无 compaction 域，D-7/N5 终局不做）、
 * `spawnAgentFromOpenCodeDb`、`ctxReduceSpawnPermissionReadNeeded`（仅测试
 * 面消费者在 fork 不存在）。连带省略 `read-session-db` 的两个 DB 读取 import
 * 与 OpenCode 权限规则的解析/求值助手（`permissionRules` /
 * `permissionDisabled` / `PermissionRule` …——唯一上游消费者
 * `resolveToolPermissionDenied` 见下）。fork 引用面：
 *   - `transform.ts:79-86`、`transform-postprocess-phase.ts:89-99`
 *   - barrel `src/index.ts` 不导出本模块（无宿主当面）。
 *
 * THROW 臂契约（r5 P2-6 / spec Step 16）：上游 `resolveToolPermissionDenied`
 * 读 OpenCode 的 `app.agents()` / `session.get()` 权限 API，并对缺失桩
 * THROW；ZCode 客户端没有这对 API，且 ctx_reduce 的可调用真值判定已由宿主侧
 * 承担——core `magic-context-prompt-section.ts:89` 以**真实工具表**
 * （`runtime.getTools(model).some(name === "ctx_reduce")`）判定、
 * `runtime-tools.ts:132` 以 `resolveRuntimeDisallowedToolsWithMagicContext`
 * 结构禁用面一并收敛（Step 13 落地的先例），提示词不再可能介绍一个未注册
 * 或被禁用的工具。因此本函数不再 throw 也不再读远端权限，按 r5 裁定
 * `return false`（= 未拒绝），与两个调用点
 * （`transform-postprocess-phase.ts:344-349` todowrite、
 * `:2048-2062` ctx_reduce）既有的 try/catch fail-open 语义对齐，且不改变
 * 「保留旧裁决」行为（deny 从未在 fork 成立，`?? persisted ?? false` 链路
 * 的旧裁决仍是 false）。
 *
 * 相对导入一律补 `.js` 后缀（NodeNext）；其余与上游逐字一致。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import type { PluginContext } from "../../plugin/types.js";
import { BoundedSessionMap } from "../../shared/bounded-session-map.js";
import { sessionLog } from "../../shared/logger.js";

/**
 * Whether a given tool is actually CALLABLE in a session's tool set.
 *
 * Magic Context registers tools process-globally, but a parent agent (or the
 * user's OpenCode config) can spawn a session with an explicit allow-list
 * tools map ({"*": false, read: true, ...}) that filters a tool out. For such
 * sessions any surface that urges or replays that tool — ctx_reduce §N§
 * prefixes and nudges, or synthetic todowrite pairs — is pure overhead urging
 * a tool the model cannot call (plus cargo-cult risk with no benefit).
 *
 * CACHE STABILITY: the verdict is resolved ONCE per session per tool from the
 * FIRST user message's tools map and cached for the process lifetime. Per-turn
 * tool maps can differ (mode switches toggle edit tools), and a flapping
 * verdict would oscillate provider-visible bytes — a per-turn HARD bust. The
 * first-message map is fixed at session spawn, so the verdict is deterministic
 * across passes and restarts.
 *
 * OpenCode does not write agent or session permissions into the first user
 * message's tools map, so a session whose agent config (or session permission
 * overlay) denies ctx_reduce would otherwise freeze as "callable". To cover it,
 * whichever hook runs first on a session (the messages transform or the
 * system-prompt hook; OpenCode may run either first) reads those permissions
 * ONCE, before the ctx_reduce verdict first freezes (see
 * primeCtxReduceSpawnPermission). A deny recorded there makes
 * the frozen verdict "unavailable" from the session's first pass, so no
 * provider-visible byte ever flips.
 *
 * After the verdict freezes it never changes again, even when OpenCode's live
 * permission rules later deny the tool. Its value gates guidance and the
 * system-prompt hash; changing it mid-session would invalidate the provider
 * prefix for a permission change that is otherwise not part of the prompt. A
 * mid-session deny is only logged. Todowrite's synthetic pair has a separate
 * live permission check at cache-busting boundaries, so this asymmetry is
 * deliberate and load-bearing.
 *
 * Fail-open: no tools map (normal sessions), no wildcard-deny, no recorded
 * permission deny, or an unreadable OpenCode DB all resolve to "available" —
 * current behavior.
 */

/** Availability verdict plus whether it is final for the session's lifetime. */
export interface ToolAvailabilityVerdict {
    callable: boolean;
    /** True when resolved from the session's first user message (cached).
     *  False when the verdict is a provisional fail-open default — consumers
     *  that PERSIST state derived from the verdict (e.g. the system-prompt
     *  hash) must skip persistence until a frozen verdict exists, or a later
     *  final verdict flips the persisted bytes and busts the prompt cache. */
    frozen: boolean;
}

/** Historical alias. ctx_reduce was the first consumer of this resolver; the
 * verdict shape is identical for every tool, so the name is kept so existing
 * ctx_reduce call sites stay untouched.
 */
export type CtxReduceAvailabilityVerdict = ToolAvailabilityVerdict;

const CTX_REDUCE_TOOL = "ctx_reduce";
const TODOWRITE_TOOL = "todowrite";

/**
 * Verdicts are cached per (tool, session). Two tools resolve independently for
 * the same session, so the key is a composite. The NUL separator cannot appear
 * in either a tool name or an OpenCode session id. Cap covers ~500 sessions
 * across the two tools we currently resolve (ctx_reduce + todowrite).
 */
const availabilityBySession = new BoundedSessionMap<boolean>(1000);

/** The cached permission verdict is updated only during cache-busting passes;
 * defer passes reuse it without performing a live permission read. */
const permissionDeniedBySession = new BoundedSessionMap<boolean>(2000);
const ctxReducePermissionDenyLogged = new BoundedSessionMap<boolean>(1000);

/**
 * ctx_reduce permission read taken before the session's verdict froze (true =
 * the agent or session permissions deny the tool). Only consulted while the
 * verdict is still unfrozen; once `availabilityBySession` holds a value this
 * map is never read again for that session.
 */
const ctxReduceSpawnPermissionDenied = new BoundedSessionMap<boolean>(1000);
/** Concurrent passes for one session share a single in-flight permission read. */
const ctxReduceSpawnPermissionReads = new Map<string, Promise<void>>();

function permissionCacheKey(toolName: string, sessionId: string): string {
    return `${toolName}\u0000${sessionId}`;
}

function cacheKey(toolName: string, sessionId: string): string {
    return `${toolName}\u0000${sessionId}`;
}

/** Verdict for one tool from one tools map; null = map carries no signal. */
function verdictFromToolsMap(tools: unknown, toolName: string): boolean | null {
    if (tools === null || typeof tools !== "object" || Array.isArray(tools)) return null;
    const map = tools as Record<string, unknown>;
    if (map[toolName] === true) return true;
    if (map[toolName] === false) return false;
    // Explicit allow-list (wildcard deny) without this tool → filtered out.
    if (map["*"] === false) return false;
    return null;
}

/**
 * Final verdict for a session whose verdict has not frozen yet. A ctx_reduce
 * deny read from the agent/session permissions before the freeze wins over the
 * tools map, because OpenCode never offers a permission-denied tool to the model.
 */
function unfrozenVerdict(sessionId: string, toolName: string, mapVerdict: boolean | null): boolean {
    if (toolName === CTX_REDUCE_TOOL && ctxReduceSpawnPermissionDenied.get(sessionId) === true) {
        return false;
    }
    return mapVerdict ?? true;
}

/**
 * Resolve from the in-memory transform message array (preferred — free).
 * Caches the verdict on first resolution.
 */
export function resolveToolAvailabilityFromMessages(
    sessionId: string,
    toolName: string,
    messages: ReadonlyArray<{ info?: { role?: string; tools?: unknown } }>,
): ToolAvailabilityVerdict {
    const key = cacheKey(toolName, sessionId);
    const cached = availabilityBySession.get(key);
    if (cached !== undefined) return { callable: cached, frozen: true };

    for (const message of messages) {
        if (message.info?.role !== "user") continue;
        // First user message decides: explicit signal, or no-signal → available.
        // Either way the verdict is final — freeze it.
        const verdict = unfrozenVerdict(
            sessionId,
            toolName,
            verdictFromToolsMap(message.info.tools, toolName),
        );
        availabilityBySession.set(key, verdict);
        return { callable: verdict, frozen: true };
    }
    // No user message in the array at all (not a real prompt — e.g. a stray
    // pass on an empty session). Fail open but do NOT freeze: caching true here
    // would lock a deny-list session into the tool's surface before its first
    // user message ever arrives to say otherwise.
    return { callable: true, frozen: false };
}

// --- ctx_reduce convenience wrappers (behavior-identical to the original) ---

export function resolveCtxReduceAvailabilityFromMessages(
    sessionId: string,
    messages: ReadonlyArray<{ info?: { role?: string; tools?: unknown } }>,
): CtxReduceAvailabilityVerdict {
    return resolveToolAvailabilityFromMessages(sessionId, CTX_REDUCE_TOOL, messages);
}

/**
 * ZCode 侧 ctx_reduce 权限判定契约（r5 P2-6 / spec Step 16）。
 *
 * 上游在此读 OpenCode 的 `app.agents()` / `session.get()` 权限面并对缺失桩
 * THROW；fork 没有这对 API。ctx_reduce 的「是否可调用」真值在宿主侧已经用
 * **真实工具表**（core `magic-context-prompt-section.ts:89`：
 * `runtime.getTools(model).some(name === "ctx_reduce")`）加**结构禁用面**
 * （`runtime-tools.ts:132` `resolveRuntimeDisallowedToolsWithMagicContext`）
 * 收敛，本包不再复制一份远端权限读。按 r5 裁定返回 `false`（= 未拒绝：
 * fork 从未记录过 deny，fail-open 与 `?? persisted ?? false` 旧裁决一致）；
 * 两个 caller（transform-postprocess-phase.ts:344-349 todowrite / :2048-2062
 * ctx_reduce）各自 try/catch 且语义是「保留旧裁决」，返回 false 不改变其行为。
 */
export async function resolveToolPermissionDenied(
    _client: PluginContext["client"],
    _sessionId: string,
    _toolName: string,
    _activeAgent?: string,
): Promise<boolean> {
    // FORK (Step 16 / bugfix-batch-20261011)：替代契约 = return false（未拒绝）。
    // ZCode 真值判定面见上方注释：工具注册表 + 结构禁用由宿主 runtime 侧承担。
    return false;
}

/** Delegates to `resolveToolPermissionDenied`; see the note there. */
export function todowritePermissionDenied(
    client: PluginContext["client"],
    sessionId: string,
    activeAgent?: string,
): Promise<boolean> {
    return resolveToolPermissionDenied(client, sessionId, TODOWRITE_TOOL, activeAgent);
}

/**
 * Read the agent and session permissions for ctx_reduce ONCE, before the
 * session's ctx_reduce verdict first freezes, so a permission deny makes that
 * first frozen verdict "unavailable" (no §N§ tags, no reduce guidance, no
 * reduce nudges). OpenCode keeps these permissions on the agent config and the
 * session, not in the first user message's tools map, so the tools-map resolver
 * alone cannot see them.
 *
 * Callers must await this before calling a resolveCtxReduceAvailability*
 * function on a pass that may freeze the verdict. Once the verdict is frozen
 * this is a no-op: a later permission change must not flip provider-visible
 * bytes. `spawnAgent` should be the agent named on the session's FIRST user
 * message, so a restart re-reads the same agent even if the user has since
 * switched agents. A failed read records nothing and the verdict fails open to
 * "available", exactly as before permissions were considered.
 *
 * FORK (Step 16 / bugfix-batch-20261011)：本 fork 的读即
 * `resolveToolPermissionDenied` 的 `return false`（不记录 deny），预热链因此
 * 恒以 fail-open 收口；逐字保留是为了调用点时序与上游一致，且一旦宿主将来
 * 提供等价权限面，只需替换那一个函数的读取实现。
 */
export function primeCtxReduceSpawnPermission(
    client: PluginContext["client"],
    sessionId: string,
    spawnAgent?: string,
): Promise<void> {
    // 上游门 `ctxReduceSpawnPermissionReadNeeded`（fork 无测试面消费者，随裁剪
    // 省略）的内联等价：裁决已冻结或权限已记录过就不再读。
    if (
        availabilityBySession.get(cacheKey(CTX_REDUCE_TOOL, sessionId)) !== undefined ||
        ctxReduceSpawnPermissionDenied.get(sessionId) !== undefined
    ) {
        return Promise.resolve();
    }
    const inFlight = ctxReduceSpawnPermissionReads.get(sessionId);
    if (inFlight) return inFlight;
    const read = (async () => {
        try {
            const denied = await resolveToolPermissionDenied(
                client,
                sessionId,
                CTX_REDUCE_TOOL,
                spawnAgent,
            );
            ctxReduceSpawnPermissionDenied.set(sessionId, denied);
            if (denied) {
                sessionLog(
                    sessionId,
                    `ctx_reduce permission is denied for agent=${spawnAgent ?? "(session default)"}; session freezes without ctx_reduce tags, guidance, or nudges`,
                );
            }
        } catch (error) {
            sessionLog(
                sessionId,
                "ctx_reduce permission read before freeze failed (fail-open):",
                error,
            );
        } finally {
            ctxReduceSpawnPermissionReads.delete(sessionId);
        }
    })();
    ctxReduceSpawnPermissionReads.set(sessionId, read);
    return read;
}

/** Agent named on the session's first user message (the agent it was spawned with). */
export function spawnAgentFromMessages(
    messages: ReadonlyArray<{ info?: { role?: string; agent?: unknown } }>,
): string | undefined {
    for (const message of messages) {
        if (message.info?.role !== "user") continue;
        const agent = message.info.agent;
        return typeof agent === "string" && agent.length > 0 ? agent : undefined;
    }
    return undefined;
}

/** Cached live verdict used by defer passes; undefined means no bust has read it yet. */
export function cachedToolPermissionDenied(
    sessionId: string,
    toolName: string,
): boolean | undefined {
    return permissionDeniedBySession.get(permissionCacheKey(toolName, sessionId));
}

export function hasLoggedCtxReducePermissionDeny(sessionId: string): boolean {
    return ctxReducePermissionDenyLogged.get(sessionId) === true;
}

export function markCtxReducePermissionDenyLogged(sessionId: string): void {
    ctxReducePermissionDenyLogged.set(sessionId, true);
}

// --- todowrite convenience wrappers ---

export function resolveTodowriteAvailabilityFromMessages(
    sessionId: string,
    messages: ReadonlyArray<{ info?: { role?: string; tools?: unknown } }>,
): ToolAvailabilityVerdict {
    return resolveToolAvailabilityFromMessages(sessionId, TODOWRITE_TOOL, messages);
}
