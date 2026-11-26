import type { ContextDatabase } from "../../features/magic-context/storage.js";
import {
    getSourceContents,
    replaceSourceContent,
    saveSourceContent,
} from "../../features/magic-context/storage.js";
import { getSourceContentIndexBySession } from "../../features/magic-context/storage-source.js";
import {
    adoptNullOwnerToolTag,
    DRIFTED_TAG_MESSAGE_PREFIX,
    getCandidateToolOwners,
    getInertWhitespaceAssistantTags,
    getNullOwnerToolTag,
    getTagById,
    getTagNumberByMessageId,
    getToolTagNumberByOwner,
    listTagRowsBySession,
    markWhitespaceAssistantTagInert,
    pickNearestPriorOwner,
    rebindTagMessageIdFenced,
    stampTagMessageRole,
    tombstoneTagMessageId,
    WHITESPACE_ASSISTANT_INERT_MESSAGE_PREFIX,
    type SessionTagRow,
} from "../../features/magic-context/storage-tags.js";
import { makeToolCompositeKey, type Tagger } from "../../features/magic-context/tagger.js";
import { sessionLog } from "../../shared/logger.js";
import { textMentionsRecentCommit } from "../../shared/commit-detection.js";
import { isRecord } from "../../shared/record-type-guard.js";
import { isReduceToolPart } from "./drop-stale-reduce-calls.js";
import {
    estimateImageTokensFromDataUrl,
    estimateToolAttachmentImageTokens,
} from "./image-token-estimate.js";
import { getMessageTimesFromOpenCodeDb } from "./read-session-db.js";
import { estimateTokens } from "./read-session-formatting.js";
import { neutralizeDroppedReasoningPart } from "./sentinel.js";
import { byteSize, isThinkingPart, prependTag } from "./tag-content-primitives.js";
import { createExistingTagResolver } from "./tag-id-fallback.js";
import {
    buildFileSourceContent,
    isFilePart,
    isTextPart,
    isToolPartWithOutput,
    stripTagPrefix,
} from "./tag-part-guards.js";
import {
    createToolDropTarget,
    extractToolCallObservation,
    partHasCompletedResult,
    type ToolCallIndex,
    type ToolDropResult,
    ToolMutationBatch,
    type ToolSweepVariantResolver,
} from "./tool-drop-target.js";
import { logTransformTiming } from "./transform-stage-logger.js";

interface ToolOwnerDerivationCache {
    candidateOwnersByCallId: Map<string, string[]>;
    messageTimesById: Map<string, number | null>;
}

type ToolOwnerFallbackLookup =
    | { kind: "candidates"; callId: string }
    | { kind: "messageTimes"; messageIds: readonly string[] };

const TOOL_OWNER_CACHE_KEY_SEP = "\x00";

type InertWhitespaceTag = ReturnType<typeof getInertWhitespaceAssistantTags>[number];
const inertWhitespaceCache = new WeakMap<
    ContextDatabase,
    Map<string, { tagsVersion: number; ownersKey: string; tags: InertWhitespaceTag[] }>
>();

function getCachedInertWhitespaceAssistantTags(
    db: ContextDatabase,
    sessionId: string,
    tagger: Tagger,
    messages: readonly MessageLike[],
): InertWhitespaceTag[] {
    const messageIds = messages.flatMap((message) =>
        typeof message.info.id === "string" ? [message.info.id] : [],
    );
    const ownersKey = JSON.stringify(messageIds);
    const tagsVersion = tagger.getLoadedTagsVersion?.(sessionId, db);
    if (tagsVersion === undefined)
        return getInertWhitespaceAssistantTags(db, sessionId, messageIds);

    let bySession = inertWhitespaceCache.get(db);
    if (!bySession) {
        bySession = new Map();
        inertWhitespaceCache.set(db, bySession);
    }
    const cached = bySession.get(sessionId);
    if (cached?.tagsVersion === tagsVersion && cached.ownersKey === ownersKey) return cached.tags;

    const tags = getInertWhitespaceAssistantTags(db, sessionId, messageIds);
    bySession.set(sessionId, { tagsVersion, ownersKey, tags });
    return tags;
}

function makeToolOwnerCacheKey(sessionId: string, callId: string): string {
    return `${sessionId}${TOOL_OWNER_CACHE_KEY_SEP}${callId}`;
}

function getCachedCandidateToolOwners(
    db: ContextDatabase,
    sessionId: string,
    callId: string,
    cache: ToolOwnerDerivationCache,
    onLookup?: (lookup: ToolOwnerFallbackLookup) => void,
): string[] {
    const key = makeToolOwnerCacheKey(sessionId, callId);
    const cached = cache.candidateOwnersByCallId.get(key);
    if (cached !== undefined) return cached;

    onLookup?.({ kind: "candidates", callId });
    const candidates = getCandidateToolOwners(db, sessionId, callId);
    cache.candidateOwnersByCallId.set(key, candidates);
    return candidates;
}

function getCachedMessageTimesFromOpenCodeDb(
    sessionId: string,
    messageIds: readonly string[],
    cache: ToolOwnerDerivationCache,
    onLookup?: (lookup: ToolOwnerFallbackLookup) => void,
): Map<string, number> {
    const uncached = [...new Set(messageIds)].filter((id) => !cache.messageTimesById.has(id));
    if (uncached.length > 0) {
        onLookup?.({ kind: "messageTimes", messageIds: uncached });
        const resolved = getMessageTimesFromOpenCodeDb(sessionId, uncached);
        for (const id of uncached) {
            cache.messageTimesById.set(id, resolved.get(id) ?? null);
        }
    }

    const times = new Map<string, number>();
    for (const id of messageIds) {
        const time = cache.messageTimesById.get(id);
        if (typeof time === "number") times.set(id, time);
    }
    return times;
}

function invalidateCachedCandidateToolOwnersIfNewOwner(
    cache: ToolOwnerDerivationCache,
    sessionId: string,
    callId: string,
    ownerMsgId: string,
): void {
    const key = makeToolOwnerCacheKey(sessionId, callId);
    const cached = cache.candidateOwnersByCallId.get(key);
    if (cached !== undefined && !cached.includes(ownerMsgId)) {
        cache.candidateOwnersByCallId.delete(key);
    }
}

/**
 * v3.3.1 Layer C: derive `tool_owner_message_id` for a tool observation.
 *
 * - invocation parts: owner = current message id (the assistant message
 *   hosting the invocation)
 * - result parts: pop the FIFO queue for this callId; if empty, attempt
 *   the persisted-nearest-prior fallback (covers result-only windows
 *   where the invocation has been compacted away); if that fails too,
 *   fall back to the result's own message id (last-resort: ensures owner
 *   is always non-null and tag identity stays stable).
 *
 * The FIFO queue is keyed by callId so two invocations of the same callId
 * across two assistant messages produce two distinct owner ids — that's
 * the whole point of composite identity.
 */
function deriveToolOwnerMessageId(
    sessionId: string,
    db: ContextDatabase,
    message: MessageLike,
    obs: { callId: string; kind: "invocation" | "result" },
    unpaired: Map<string, string[]>,
    cache: ToolOwnerDerivationCache,
    onFallbackLookup?: (lookup: ToolOwnerFallbackLookup) => void,
): string {
    const messageId = typeof message.info.id === "string" ? message.info.id : "";

    if (obs.kind === "invocation") {
        if (messageId) {
            const queue = unpaired.get(obs.callId) ?? [];
            queue.push(messageId);
            unpaired.set(obs.callId, queue);
            return messageId;
        }
        // Synthetic message id missing — degrade gracefully. Use the
        // callId itself as owner so the composite key is unique. This
        // is rare (transcripts where assistant message has no id at
        // all); the alternative is to drop the tool entirely, which
        // would break aggregation.
        return obs.callId;
    }

    // Result part — pop FIFO
    const queue = unpaired.get(obs.callId);
    if (queue && queue.length > 0) {
        const popped = queue.shift();
        if (queue.length === 0) unpaired.delete(obs.callId);
        if (popped !== undefined) return popped;
    }

    // Result-only window: invocation was compacted away. Look up the
    // persisted nearest-prior owner whose time_created precedes the
    // current result's message.
    //
    // Two-phase lookup that splits the MC and OC reads:
    //   1. `getCandidateToolOwners` queries the MC tags table for every
    //      tag with a non-NULL owner under (sessionId, callId).
    //   2. `getMessageTimesFromOpenCodeDb` resolves wall-clock times for
    //      the candidates and the current message via the shared OC
    //      read-only handle. Returns an empty map when the OC DB can't
    //      be opened (Pi-only install, missing file).
    //   3. `pickNearestPriorOwner` selects the most recent candidate
    //      strictly preceding `messageId` in OC time.
    //
    // All three steps are fail-soft: any of them returning empty/null
    // collapses to the `messageId` fallback below, which keeps the
    // composite key stable even when the OC DB is unavailable.
    if (messageId) {
        const candidates = getCachedCandidateToolOwners(
            db,
            sessionId,
            obs.callId,
            cache,
            onFallbackLookup,
        );
        if (candidates.length > 0) {
            const ids = [...candidates, messageId];
            const times = getCachedMessageTimesFromOpenCodeDb(
                sessionId,
                ids,
                cache,
                onFallbackLookup,
            );
            const persisted = pickNearestPriorOwner(candidates, messageId, times);
            if (persisted !== null) return persisted;
        }
        return messageId;
    }
    return obs.callId;
}

export type MessageInfo = {
    id?: string;
    role?: string;
    sessionID?: string;
    summary?: boolean;
    /** Marks one of the two m[0]/m[1] messages prepended by compartment injection. */
    syntheticHead?: boolean;
    finish?: string;
    error?: unknown;
};

export interface ThinkingLikePart {
    type: string;
    thinking?: string;
    text?: string;
}

export type MessageLike = { info: MessageInfo; parts: unknown[] };

export interface TagNormalizationTarget {
    tagNumber: number;
    message: MessageLike;
    part: unknown;
    field: "text" | "tool_state_output" | "tool_result_content";
}

export type TagTarget = {
    /** Non-mutating count of current and replacement token-bearing fields for a planned drop. */
    measureReclaim?: (skeleton: boolean) => {
        beforeTools: number;
        afterTools: number;
        beforeProse: number;
        afterProse: number;
    };
    /**
     * Replace the part's text. A text target treats this as a drop by default
     * and also takes the reasoning of its message off the wire, since that
     * reasoning answered the text that left. `keepReasoning` marks an in-place
     * rewrite that keeps the text's meaning (caveman compression, a partial
     * system-injection strip): the reasoning stays, because removing it would
     * leave a gap in the middle of the history that prefix-bound models reject
     * for every later thinking block.
     */
    setContent: (content: string, options?: { keepReasoning?: boolean }) => boolean;
    getContent?: () => string | null;
    /**
     * Text targets: the `§N§ ` prefix this pass puts in front of the text, or
     * "" when prefixes are not injected. A rewrite computed from the stored
     * source (which never carries the prefix) puts it back with this.
     */
    textPrefix?: string;
    drop?: () => ToolDropResult;
    /** Legacy skeleton: arguments replaced by the `{"dropped": …}` marker.
     * Replay-only, for `drop_mode = 'truncated'` tags not yet converted. */
    truncate?: () => ToolDropResult;
    /** Real-argument skeleton: the call keeps the arguments the host gave it,
     * only the output becomes `[dropped §N§]` (`drop_mode = 'skeleton_real'`). */
    skeletonReal?: () => ToolDropResult;
    /** New attachment-bearing skeletons omit media; legacy skeletons retain it. */
    skeletonStripped?: () => ToolDropResult;
    hasAttachments?: () => boolean;
    /** Total UTF-8 bytes of the string values in the call's input (see
     * tool-input-size.ts); null when the call is not on this pass's wire. */
    inputStringBytes?: () => number | null;
    /** Non-mutating: would removing this call leave the request ending on an
     * assistant turn (given what this pass already removed)? */
    wouldStrandConversationEnd?: () => boolean;
    /** Non-mutating: the host adapter cannot remove this call structurally, so
     * drop() would keep a paired shell instead. A new drop then keeps the real
     * arguments (skeletonReal) rather than any placeholder. */
    cannotRemove?: () => boolean;
    /** Edit-marker compression for an edit/write superseded by a later edit to
     * the same file: keep the call + filePath + a region hint of the diff,
     * output → [dropped §N§]. Used by smart-drops. */
    editMarker?: () => ToolDropResult;
    editMarkerStripped?: () => ToolDropResult;
    /** Non-mutating: would drop()/truncate() actually reclaim bytes? Tool
     * targets only; absent on message/file targets. */
    canDrop?: () => boolean;
    /** A full arc removal would strand or merge native reasoning, so keep a paired skeleton. */
    requiresToolArcSkeleton?: boolean;
    /** Non-mutating read of the tool invocation's input object (e.g. to read
     * `ctx_note`'s action or an edit's filePath for supersession selection).
     * Tool targets only; null when no invocation part is present. */
    readInput?: () => Record<string, unknown> | null;
    message?: MessageLike;
};

export interface TagMessagesResult {
    targets: Map<number, TagTarget>;
    reasoningByMessage: Map<MessageLike, ThinkingLikePart[]>;
    messageTagNumbers: Map<MessageLike, number>;
    toolCallIndex: ToolCallIndex;
    batch: ToolMutationBatch;
    hasRecentReduceCall: boolean;
    /** Whether recent assistant messages contain git commit hash patterns */
    hasRecentCommit: boolean;
    /** Exact part references that received a Magic Context tag prefix while tagMessages processed them. */
    normalizationTargets: TagNormalizationTarget[];
}

function collectRelevantSourceTagIds(
    messages: MessageLike[],
    assignments: ReadonlyMap<string, number>,
): number[] {
    const currentMessageIds = new Set(
        messages.flatMap((message) =>
            typeof message.info.id === "string" ? [message.info.id] : [],
        ),
    );

    const relevantTagIds = new Set<number>();
    for (const [contentId, tagId] of assignments) {
        const match = /^(.*):(p|file)\d+$/.exec(contentId);
        if (!match) continue;
        if (!currentMessageIds.has(match[1])) continue;
        relevantTagIds.add(tagId);
    }

    return Array.from(relevantTagIds);
}

// FORK（tag-drift-content-verify）：tag 身份是位置字符串 `mc<N>:p<下标>`，重启后
// context 前缀长度变化 d 会让整个窗口平移，而 resolver 精确命中（tag-id-fallback.ts
// 的 assignments.get）与 DB fast path（getAssignableTagNumberByMessageId）都只按
// 位置、不比对内容——位置 N 上的新消息文本会被原文比对处的 replaceSourceContent
// 写进旧 tag 的原文（「同一位置换成另一条消息 → 以入站为准」是编辑重发刻意修的
// 行为，位置身份在结构上无法区分「用户改了这条消息」与「重启漂移」，必须用内容
// 信号区分）。
//
// 方案是「预扫描出计划，再就地执行」：判定所需数据全部来自 pass 开始时的静态
// 快照（inbound 文本、source_contents 反查索引、tags 行索引），不依赖 pass 内的
// 处理顺序。pass 级惰性构建一次（首个参与判定的文本 part 触发），主循环走到该
// part 时按计划执行。两条硬契约：
//  1. 计划必须在该 part 进入 resolver.resolve 之前执行——resolver 的精确命中只
//     按位置、accept 只挡 inert；若先 resolve，T 已被当成 existingTagId 捕获，
//     后面的墓碑化与内存重绑全部白做，流程会继续用 X 覆盖 S(T)，恰好复现要禁止
//     的行为。
//  2. 漂移类分支（v1 漂移、平移不符 / 平移落空、认领围栏未命中）以
//     accept: () => false 调用 resolve 屏蔽 scoped fallback——不屏蔽的话，c 在同
//     消息桶里让出的空位会让兄弟 text part 的旧 tag 落到当前 part 上
//     （claimedContentIds 只挡本 pass 已 resolve 过的 part，挡不住同消息后序 part
//     的旧绑定），当前 part 抢到兄弟的号并覆盖兄弟的原文。
// 判定域：只给「带正文的文本 part」与「入站 system 行（无论空白与否）」制定计划；
// whitespace-only assistant part 与 file part 照旧走各自分支。inbound 覆盖全部带
// message id 的文本 part（与打标入口的口径一致，否则「X 只出现一次」会因口径
// 漂移）。
//
// v2 修订（真实数据 e2e 后新增）：v1 的逐条判据在真实库上只能识别 2.0%–4.1% 的
// 漂移——「sourceIdx[S(T)] 恰为 [T]」要求原文全库唯一持有，而真实会话里子代理
// 通知、措辞相近的报告大量重复；「S(T) 还活在入站里」在裁剪形态下对窗口外 tag
// 恒不成立。识别不了的全部落「编辑重发」桶覆盖原文（实测一次平移改写 92 条）。
// 因此预扫描先识别窗口整体平移 d*（候选集、计分、判定，见 buildTagContentPlans），
// 平移成立时对每个非 system 文本 part 按「位置 − d*」找回真身（平移相符 /
// 平移不符 / 平移落空三分支，优先于 v1 的表）；d* = 0 时完全按 v1 判定。system
// 行不进平移层（system 段在 canonical 头部，跨代位置稳定，仍走专门规则）。
interface TagContentPlan {
    kind: "existing" | "claim" | "drift" | "system-assign";
    /**
     * drift / system-assign / claim-with-position-hit：需要墓碑化的位置命中 tag。
     * v2 平移不符 / 平移落空允许缺省（位置上没有任何 tag 时不墓碑化，直接拿新号）。
     */
    tombstoneTarget?: number;
    /** claim（含 v2 平移相符，T′ 视作 R）：rebindTagMessageIdFenced 的 tagId。 */
    claimTagNumber?: number;
    /** claim：WHERE 围栏旧键 = { 预扫描时的 message_id, 墓碑键 }。 */
    claimFromKeys?: string[];
    /** claim：预扫描时认领目标的旧 contentId，内存侧仅当 getTag(旧键) === R 才 unbind。 */
    claimOldContentId?: string;
    /** claim：判定时的入站文本；认领/平移相符的原文与它恒相等，据此跳过幂等重写。 */
    claimText?: string;
}

const DRIFT_PLAN_KINDS: ReadonlySet<TagContentPlan["kind"]> = new Set([
    "claim",
    "drift",
    "system-assign",
]);

/**
 * 问题三：为每个参与判定的入站文本 part 制定计划（纯内存计算）。
 *
 * v2 先识别窗口整体平移 d*（spec 问题三 (b′)，优先于逐条判据）：
 *  - 候选集：0，加每个满足「sourceIdx[X] 恰有一个 type='message' 持有者 R，且
 *    R.messageId 是同 part 下标的位置键 mc<q>:p<i>」的非 system 文本 part 的
 *    d = p − q（候选由数据给出，不设固定范围）。
 *  - 计分：score(d) = 非 system 文本 part 中「posIdx[mc<p−d>:p<i>] 存在且其
 *    S === X」的个数（按内容在平移后的位置上验证，重复样板只增加真阳性）。
 *  - 判定：取 score 最大的 d*；score 相同取 |d| 小者，再相同取正者（确定性）。
 *    score(d*) ≥ 3 且 d* ≠ 0 才算平移成立；否则 d = 0。窗口里能验证的 part 不足
 *    3 个（极短窗口）或候选集只有 0（全样板窗口）时识别不出 → v1，写入已知限制。
 *  - 位置键必须匹配 ^mc(\d+):p(\d+)$：file 键（mc9:file0）不是位置键——fork 继
 *    承用的 /^mc(\d+)/ 会把 file 键也匹配进来，不能照搬（T-T7 的 type_file 场景
 *    依赖此口径）。
 *
 * 平移成立时，对每个非 system 文本 part（c、X；位置候选 T = posIdx[c]；真身
 * T′ = posIdx[mc<p−d*>:p<i>]）三分支：
 *  - 平移相符：T′ 存在、不是 whitespace-inert 行（inert 行从不写原文，「S 不存
 *    在」不能把它当成真身）、且 S(T′) 不存在或 === X → 绑定到 T′（结构上与认领
 *    R 同款）：T 存在且 ≠ T′ 时先墓碑化 T；rebindTagMessageIdFenced(T′, {预扫描
 *    时 T′ 的 message_id, 墓碑键(T′)} → c)；changes > 0 才 bindTag；不改 status
 *    （dropped 的主人平移后仍是 dropped，未裁剪形态的会话不会因此解折叠）。
 *  - 平移不符：T′ 存在且（是 inert 行或 S(T′) 有定义且 ≠ X）→ T′ 不动；T 存在
 *    则墓碑化；accept: () => false 的 resolve 后 assignTag 新号；不覆盖任何原文。
 *  - 平移落空：T′ 不存在（含 c 不是 mc 位置键）→ 同平移不符。**不跳过
 *    resolve**：跳过意味着该 contentId 不进 resolver 闭包私有的 claimedContentIds
 *    集合；这样调用零成本，且与「认领围栏未命中」「v1 漂移」两个先例同构。
 *  三个分支都不写 source_contents：平移相符的原文与 X 恒相等（claimedSourceEcho
 *  跳过幂等写），其余两个分支不沿用任何旧号（新号的原文由主循环既有写入路径新增，
 *  不触碰存量行）。墓碑化 T 时 changes = 0（T 已被它自己的主人——位置
 *  mc<p+d*>:p<i> 上的 part——重绑走）视为已被处理、不报错，且这正是正确行为：
 *  T 已归位，不该再墓碑化。
 *
 * d = 0 时按 v1 的表逐条判定：
 *  - 相符：位置候选 T 不存在；或 T 存在且 S(T) 不存在 / S(T) === X / X 去章后空白
 *    → 沿用今天的行为（existing，主循环走既有 resolve 流程）。
 *  - 内容认领：存在唯一候选 R（sourceIdx[X] 恰一个元素、X 在 inbound 值里只出现
 *    一次、R ≠ T、R.type='message'、R.status='active'、R.messageRole 非 NULL 且
 *    ≠ 'system'、R.messageId 非 inert / 墓碑前缀）→ 使用 R；T 存在时先墓碑化 T。
 *    认领同时覆盖「位置命中了别的 tag」与「位置上没有任何 tag」（窗口末端的消息
 *    平移后必然是后者）两种情况——只在位置命中时认领会让末端消息每次前缀增长都
 *    换新号，并留下搁浅的 active 旧号被 sidebar / protected-tail 双计。
 *  - 漂移：T 存在、S(T) 有定义且 ≠ X、X 非空白、认领不成立、sourceIdx[S(T)] 恰为
 *    [T] 且有另一个入站 part 的文本等于 S(T) → 墓碑化 T、为 X 分配新号、不覆盖
 *    S(T)。
 *  - 编辑重发：T 存在、S(T) ≠ X、非空白，以上都不成立 → 保持 b5：沿用 T、覆盖
 *    原文（existing，交回既有流程）。
 *
 * 入站 system 行的专门规则（两个档位共用，不进平移层——system 段在 canonical 头
 * 部，跨代位置稳定）：位置命中的 T 只有在 T 自己的 messageRole === 'system' 时才
 * 可沿用（内容不同也沿用并覆盖——system 槽位换内容是正常情形）；否则视为没有位
 * 置候选：墓碑化 T（只挪位置键、不改 status、不改 T 的 role）、跳过
 * resolver.resolve 直接 assignTag 新号。不跳过 resolve 的话 scoped fallback 可
 * 能把 mc1:* 桶里上一代 synthetic head 的旧 tag 重绑到 system 行上。代价（写入
 * 已知限制）：system 行的旧号以 active 搁浅，上界约为「触发次数 × system 段条数」。
 *
 * S(T) 经 getSourceContents 单查并缓存；v1 认领只取 active 候选的理由：dropped
 * 被认领等于把活消息交给折叠状态（applyFlushedStatuses 会折成占位符）、compacted
 * 是退役号、system / NULL-role 行可能是 system prompt 且 stampTagMessageRole 会
 * 改写它们的 role、type='file' 的原文是同消息文本 part 的去章拼接（fork 继承扩
 * 大了反查集合，这层过滤不可省）。v2 平移相符不受这层过滤约束——T′ 由位置直接
 * 给出（「按位置找回」正是 v2 的核心），dropped 保 status 是明确要求。
 */
function buildTagContentPlans(
    sessionId: string,
    messages: MessageLike[],
    db: ContextDatabase,
    inertTagNumbers: ReadonlySet<number>,
): Map<string, TagContentPlan> {
    const plans = new Map<string, TagContentPlan>();
    const tScan = performance.now();
    try {
        // inbound：全部带 message id 的文本 part 的 contentId -> 去章文本，以及
        // 每个文本值的出现次数（「X 在入站里只出现一次」与漂移的「另一个 part
        // 文本等于 S(T)」都靠它判定）。
        const inbound = new Map<string, string>();
        const inboundTextCounts = new Map<string, number>();
        for (const message of messages) {
            const id = message.info.id;
            if (typeof id !== "string") continue;
            for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
                const part = message.parts[partIndex];
                if (!isTextPart(part)) continue;
                const text = stripTagPrefix(part.text);
                inbound.set(`${id}:p${partIndex}`, text);
                inboundTextCounts.set(text, (inboundTextCounts.get(text) ?? 0) + 1);
            }
        }

        const sourceIdx = getSourceContentIndexBySession(db, sessionId);
        const rowByTag = new Map<number, SessionTagRow>();
        const posIdx = new Map<string, SessionTagRow>();
        for (const row of listTagRowsBySession(db, sessionId)) {
            rowByTag.set(row.tagNumber, row);
            // posIdx 的过滤条件与 getAssignableTagNumberByMessageId 一致：排除
            // status='compacted' 且 entry_fingerprint 为 whitespace-inert 前缀的行；
            // 另显式排除 inert / 墓碑前缀的 message_id（墓碑键不可能等于合法
            // contentId，这里是防御）。同 messageId 挂多行取 tag_number 最小的
            // 一行——SQL 已按 tag_number ASC 返回，首个遇到的即最小。
            if (
                row.status === "compacted" &&
                row.entryFingerprint?.startsWith("mc:whitespace-assistant:")
            ) {
                continue;
            }
            if (
                row.messageId.startsWith(WHITESPACE_ASSISTANT_INERT_MESSAGE_PREFIX) ||
                row.messageId.startsWith(DRIFTED_TAG_MESSAGE_PREFIX)
            ) {
                continue;
            }
            if (!posIdx.has(row.messageId)) posIdx.set(row.messageId, row);
        }

        // FORK（magic-context-trim-integrity CR-11）：sourceOfTag 不再逐 tag 点查
        // getSourceContents——该函数每次调用都 db.prepare 且无语句缓存，计分对每个
        // 候选 × 每个位置命中都会触达不同 tag，点查数随窗口膨胀。本会话的全部
        // source_contents 行已由上方 getSourceContentIndexBySession 一次性载入
        // （同表同列、按 tag_id 升序），且 (session_id, tag_id) 唯一，反转成
        // 「tag 号 → 原文」与单查语义等价：查不到的 tag 同样得到 undefined。
        const sourceByTag = new Map<number, string>();
        for (const [content, holderTags] of sourceIdx) {
            for (const holderTag of holderTags) sourceByTag.set(holderTag, content);
        }
        const sourceOfTag = (tagNumber: number): string | undefined => sourceByTag.get(tagNumber);

        const findClaimCandidate = (
            text: string,
            positionTag: number | undefined,
        ): SessionTagRow | null => {
            if ((inboundTextCounts.get(text) ?? 0) !== 1) return null;
            const holders = sourceIdx.get(text);
            if (!holders || holders.length !== 1) return null;
            const row = rowByTag.get(holders[0] ?? -1);
            if (!row) return null;
            if (positionTag !== undefined && row.tagNumber === positionTag) return null;
            if (row.type !== "message" || row.status !== "active") return null;
            if (row.messageRole === null || row.messageRole === "system") return null;
            if (
                row.messageId.startsWith(WHITESPACE_ASSISTANT_INERT_MESSAGE_PREFIX) ||
                row.messageId.startsWith(DRIFTED_TAG_MESSAGE_PREFIX)
            ) {
                return null;
            }
            return row;
        };

        // —— v2：整体平移识别（纯内存，pass 级一次性；见上方 JSDoc）——
        // 位置键正则要求 :p<数字> 分隔；file 键不是位置键。候选采集与计分都排除
        // role=system 的入站 part（system prompt 有存量原文时会产出垃圾候选）。
        const POSITION_KEY = /^mc(\d+):p(\d+)$/;
        const shiftScoredParts: Array<{ contentId: string; text: string; p: number; i: number }> =
            [];
        const shiftCandidates = new Set<number>([0]);
        for (const message of messages) {
            if (message.info.role === "system") continue;
            const id = message.info.id;
            if (typeof id !== "string") continue;
            for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
                if (!isTextPart(message.parts[partIndex])) continue;
                const contentId = `${id}:p${partIndex}`;
                const keyMatch = POSITION_KEY.exec(contentId);
                if (!keyMatch) continue;
                const p = Number(keyMatch[1]);
                const i = Number(keyMatch[2]);
                shiftScoredParts.push({ contentId, text: inbound.get(contentId) ?? "", p, i });
                const holders = sourceIdx.get(inbound.get(contentId) ?? "");
                if (!holders || holders.length !== 1) continue;
                const holder = rowByTag.get(holders[0] ?? -1);
                if (!holder || holder.type !== "message") continue;
                const holderKey = POSITION_KEY.exec(holder.messageId);
                if (!holderKey || Number(holderKey[2]) !== i) continue;
                shiftCandidates.add(p - Number(holderKey[1]));
            }
        }
        let driftShift = 0;
        if (shiftScoredParts.length > 0) {
            const scores = new Map<number, number>();
            for (const d of shiftCandidates) scores.set(d, 0);
            for (const d of shiftCandidates) {
                let score = 0;
                for (const part of shiftScoredParts) {
                    const prime = posIdx.get(`mc${part.p - d}:p${part.i}`);
                    if (prime !== undefined && sourceOfTag(prime.tagNumber) === part.text) {
                        score += 1;
                    }
                }
                scores.set(d, score);
            }
            // argmax：score 最大；tie 取 |d| 小者，再相同取正者——排序 |d| 升序、
            // 同 |d| 正者在前，遍历时严格大于才替换，保证同分时保留排序更前者。
            const ordered = [...scores.keys()].sort(
                (left, right) => Math.abs(left) - Math.abs(right) || right - left,
            );
            let best = ordered[0] ?? 0;
            let bestScore = scores.get(best) ?? 0;
            for (const d of ordered) {
                const s = scores.get(d) ?? 0;
                if (s > bestScore) {
                    best = d;
                    bestScore = s;
                }
            }
            if (bestScore >= 3 && best !== 0) driftShift = best;
        }

        for (const message of messages) {
            const id = message.info.id;
            if (typeof id !== "string") continue;
            const isSystemMessage = message.info.role === "system";
            for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
                const part = message.parts[partIndex];
                if (!isTextPart(part)) continue;
                const contentId = `${id}:p${partIndex}`;
                const text = stripTagPrefix(part.text);
                const positionRow = posIdx.get(contentId);
                const positionTag = positionRow?.tagNumber;

                if (isSystemMessage) {
                    // 入站 system 行：T 是 system tag 才沿用；否则墓碑化 + 直接
                    // assignTag（跳过 resolve）。T 不存在时走今天的行为。
                    plans.set(contentId, {
                        kind:
                            positionTag !== undefined &&
                            rowByTag.get(positionTag)?.messageRole !== "system"
                                ? "system-assign"
                                : "existing",
                        tombstoneTarget:
                            positionTag !== undefined &&
                            rowByTag.get(positionTag)?.messageRole !== "system"
                                ? positionTag
                                : undefined,
                    });
                    continue;
                }
                // FORK（magic-context-trim-integrity CR-10）：空白判断必须先于平移
                // 分支——主循环的空白豁免只对 assistant 生效（whitespaceOnlyAssistant
                // 要求 role === 'assistant'），user 消息的空白 part 若先落进平移层，
                // 平移成立时会被消费成认领或漂移计划（墓碑化位置上的旧号 / 沿用错误
                // 真身）。任何非 system role 的空白 part 都不参与计划，照旧走既有分支；
                // system 规则保持在最前——spec 要求 system 行无论是否空白都走专门规则。
                if (text.trim().length === 0) {
                    plans.set(contentId, { kind: "existing" });
                    continue;
                }
                if (driftShift !== 0) {
                    // —— v2 平移层三分支（优先于 v1 的表；能走到这里的都已是带正文
                    // 的非 system 文本 part——system 行与空白 part 在上方已分别分流）——
                    const keyMatch = POSITION_KEY.exec(contentId);
                    const primeRow = keyMatch
                        ? posIdx.get(
                              `mc${Number(keyMatch[1]) - driftShift}:p${Number(keyMatch[2])}`,
                          )
                        : undefined;
                    const primeTag = primeRow?.tagNumber;
                    const primeIsInert =
                        primeTag !== undefined &&
                        (inertTagNumbers.has(primeTag) ||
                            primeRow?.entryFingerprint?.startsWith("mc:whitespace-assistant:") ===
                                true);
                    if (primeRow === undefined || primeTag === undefined || primeIsInert) {
                        // 平移落空（或 T′ 是 inert 行）：T′ 不动；T 存在则墓碑化；
                        // accept: () => false 的 resolve 后 assignTag 新号。
                        plans.set(contentId, { kind: "drift", tombstoneTarget: positionTag });
                        continue;
                    }
                    const primeStored = sourceOfTag(primeTag);
                    if (primeStored === undefined || primeStored === text) {
                        // 平移相符：绑定到 T′（claim 执行结构，R = T′）；T 存在且
                        // ≠ T′ 时先墓碑化 T；不改 status。
                        plans.set(contentId, {
                            kind: "claim",
                            tombstoneTarget:
                                positionTag !== undefined && positionTag !== primeTag
                                    ? positionTag
                                    : undefined,
                            claimTagNumber: primeTag,
                            claimFromKeys: [
                                primeRow.messageId,
                                `${DRIFTED_TAG_MESSAGE_PREFIX}${primeTag}`,
                            ],
                            claimOldContentId: primeRow.messageId,
                            claimText: text,
                        });
                        continue;
                    }
                    // 平移不符：T′ 不动；T 存在则墓碑化；新号；不覆盖任何原文。
                    plans.set(contentId, { kind: "drift", tombstoneTarget: positionTag });
                    continue;
                }
                if (positionTag === undefined) {
                    const claim = findClaimCandidate(text, undefined);
                    plans.set(
                        contentId,
                        claim
                            ? {
                                  kind: "claim",
                                  claimTagNumber: claim.tagNumber,
                                  claimFromKeys: [
                                      claim.messageId,
                                      `${DRIFTED_TAG_MESSAGE_PREFIX}${claim.tagNumber}`,
                                  ],
                                  claimOldContentId: claim.messageId,
                                  claimText: text,
                              }
                            : { kind: "existing" },
                    );
                    continue;
                }
                const stored = sourceOfTag(positionTag);
                if (stored === undefined || stored === text) {
                    // 相符（含 T 没有存量原文——无法判定，现状）。
                    plans.set(contentId, { kind: "existing" });
                    continue;
                }
                const claim = findClaimCandidate(text, positionTag);
                if (claim) {
                    plans.set(contentId, {
                        kind: "claim",
                        tombstoneTarget: positionTag,
                        claimTagNumber: claim.tagNumber,
                        claimFromKeys: [
                            claim.messageId,
                            `${DRIFTED_TAG_MESSAGE_PREFIX}${claim.tagNumber}`,
                        ],
                        claimOldContentId: claim.messageId,
                        claimText: text,
                    });
                    continue;
                }
                const storedHolders = sourceIdx.get(stored);
                if (
                    storedHolders?.length === 1 &&
                    storedHolders[0] === positionTag &&
                    (inboundTextCounts.get(stored) ?? 0) > 0
                ) {
                    // 漂移：S(T) 的唯一主人是 T，而 S(T) 还活在入站窗口里（必然是
                    // 另一个 part——X ≠ S(T) 已在上面排除）。不覆盖 S(T)。
                    plans.set(contentId, { kind: "drift", tombstoneTarget: positionTag });
                    continue;
                }
                // 编辑重发：保持 b5。
                plans.set(contentId, { kind: "existing" });
            }
        }
        return plans;
    } finally {
        logTransformTiming(sessionId, "tag.driftPlanScan", tScan);
    }
}

function getReasoningByteSize(parts: ThinkingLikePart[]): number {
    let reasoningBytes = 0;

    for (const part of parts) {
        const content = part.thinking ?? part.text ?? "";
        if (content && content !== "[cleared]") {
            reasoningBytes += byteSize(content);
        }
    }

    return reasoningBytes;
}

/**
 * Real-tokenizer mirror of {@link getReasoningByteSize}. Computed once per tag
 * (lazy thunk on fresh insert) and stored on the tag row so token-budget
 * consumers SUM stored counts instead of re-tokenizing raw history every pass.
 */
function getReasoningTokenCount(parts: ThinkingLikePart[]): number {
    let tokens = 0;
    for (const part of parts) {
        const content = part.thinking ?? part.text ?? "";
        if (content && content !== "[cleared]") {
            tokens += estimateTokens(content);
        }
    }
    return tokens;
}

function serializeToolInput(input: unknown): string | null {
    try {
        return JSON.stringify(input) ?? null;
    } catch {
        return null;
    }
}

function estimateInputByteSize(serializedInput: string | null): number {
    return serializedInput?.length ?? 0;
}

/** Real-tokenizer count for a tool input payload (string or JSON-serializable). */
function estimateInputTokenCount(input: unknown, serializedInput: string | null): number {
    if (input === undefined || input === null) return 0;
    const tokenText = typeof input === "string" ? input : serializedInput;
    return tokenText ? estimateTokens(tokenText) : 0;
}

/**
 * Real-tokenizer count for a text/file part's tag content. Images bill by
 * visual tokens (same heuristic as the sidebar breakdown); plain text tokenizes
 * directly. Mirrors the per-part logic so a tag's token_count matches what the
 * content actually costs on the wire.
 */
function estimateTextTagTokenCount(text: string): number {
    if (!text) return 0;
    if (text.startsWith("data:image/")) return estimateImageTokensFromDataUrl(text);
    return estimateTokens(text);
}

function extractToolTagMetadata(part: unknown): {
    toolName: string | null;
    inputByteSize: number;
    inputTokenCount: number;
} {
    if (!isRecord(part)) {
        return { toolName: null, inputByteSize: 0, inputTokenCount: 0 };
    }

    const toolName =
        typeof part.tool === "string"
            ? part.tool
            : typeof part.toolName === "string"
              ? part.toolName
              : typeof part.name === "string"
                ? part.name
                : null;
    const state = isRecord(part.state) ? part.state : null;
    const input = state?.input ?? part.args ?? part.input ?? {};
    const serializedInput = serializeToolInput(input);

    return {
        toolName,
        inputByteSize: estimateInputByteSize(serializedInput),
        inputTokenCount: estimateInputTokenCount(input, serializedInput),
    };
}

export interface TagMessagesOptions {
    /**
     * When true, skip injecting §N§ prefix into message text/tool output parts.
     * DB-level tag records are still created normally — this flag only affects
     * whether the agent-visible part content gets the tag prefix. Used when
     * the session's tool allow-list denies ctx_reduce so agents don't see tag
     * markers they can't act on. Cache-safe: the availability verdict is frozen
     * per session, so message shape stays stable.
     */
    skipPrefixInjection?: boolean;
    /**
     * Prune only tool-drop owners; callers enable this after persisting
     * cache-safe session adoption. A resolver defers the choice to finalize
     * time, where both candidate arrays are known (see
     * `createPreAdoptionToolSweepResolver`).
     */
    scopedToolSweep?: boolean | ToolSweepVariantResolver;
    /**
     * The array that reaches the provider, when it is not `messages`. Passes
     * that trim a compaction prefix tag the pre-trim copy, and the sweep has to
     * remove its emptied rows from the served array as well.
     */
    servedMessages?: MessageLike[];
    /** @internal diagnostic hook used by cache-stability/perf tests. */
    onToolOwnerFallbackLookup?: (lookup: ToolOwnerFallbackLookup) => void;
}

const COMMIT_LOOKBACK = 5;

/**
 * Detect commit announcements in the same recent assistant window used by tagging.
 * Rust authority skips the host tag walk, so this pure scan lets both authorities
 * drive the shared durable note-nudge trigger without mirror-writing tag state.
 */
export function hasRecentAssistantCommit(messages: readonly MessageLike[]): boolean {
    const firstRecentIndex = Math.max(0, messages.length - COMMIT_LOOKBACK);
    for (let messageIndex = firstRecentIndex; messageIndex < messages.length; messageIndex += 1) {
        const message = messages[messageIndex];
        if (message?.info.role !== "assistant") continue;
        for (const part of message.parts) {
            if (isTextPart(part) && textMentionsRecentCommit((part as { text: string }).text)) {
                return true;
            }
        }
    }
    return false;
}

export function tagMessages(
    sessionId: string,
    messages: MessageLike[],
    tagger: Tagger,
    db: ContextDatabase,
    options: TagMessagesOptions = {},
): TagMessagesResult {
    const skipPrefixInjection = options.skipPrefixInjection === true;
    const onToolOwnerFallbackLookup = options.onToolOwnerFallbackLookup;
    const targets = new Map<number, TagTarget>();
    const normalizationTargets: TagNormalizationTarget[] = [];
    const reasoningByMessage = new Map<MessageLike, ThinkingLikePart[]>();
    const messageTagNumbers = new Map<MessageLike, number>();
    // v3.3.1 Layer C: keys are composite `<ownerMsgId>\x00<callId>`,
    // not bare callId. Two assistant turns reusing the same callId
    // produce distinct keys → distinct tags → distinct drops.
    const toolTagByCallId = new Map<string, number>();
    const toolThinkingByCallId = new Map<string, ThinkingLikePart[]>();
    const toolCallIndex: ToolCallIndex = new Map();
    // FIFO queue per callId of unpaired invocations. Result parts pop
    // from this to find their invocation owner. Cleared at the end of
    // each pass (function-scoped).
    const unpairedInvocations = new Map<string, string[]>();
    const ownerDerivationCache: ToolOwnerDerivationCache = {
        candidateOwnersByCallId: new Map(),
        messageTimesById: new Map(),
    };
    // Memo: for each part observed, what owner did we derive? Used by
    // the second tool-block (isToolPartWithOutput) so it doesn't re-run
    // FIFO logic and double-pop the queue. Parts are object references
    // (the same `unknown` instance walked twice in the loop).
    const ownerByPartKey = new Map<unknown, { ownerMsgId: string; callId: string }>();
    const batch = new ToolMutationBatch(messages, options.scopedToolSweep, options.servedMessages);
    // Inert whitespace rows are replayed by (message, whitespace rank), not by
    // session-wide number membership: after a part-id remap the ordinal fallback
    // offers whichever inert row sits at the current ordinal, and two inert parts
    // in one message would otherwise swap their `§N§` digits on the wire.
    const tInertWhitespace = performance.now();
    const inertWhitespaceTagNumbers = new Set<number>();
    const inertWhitespaceTagsByMessage = new Map<
        string,
        Array<{ partIndex: number; tagNumber: number }>
    >();
    for (const tag of getCachedInertWhitespaceAssistantTags(db, sessionId, tagger, messages)) {
        inertWhitespaceTagNumbers.add(tag.tagNumber);
        tagger.bindTag(sessionId, tag.contentId, tag.tagNumber);
        const scoped = /^(.*):p(\d+)$/.exec(tag.contentId);
        if (!scoped) continue;
        const list = inertWhitespaceTagsByMessage.get(scoped[1]) ?? [];
        list.push({ partIndex: Number(scoped[2]), tagNumber: tag.tagNumber });
        inertWhitespaceTagsByMessage.set(scoped[1], list);
    }
    for (const list of inertWhitespaceTagsByMessage.values()) {
        list.sort((left, right) => left.partIndex - right.partIndex);
    }
    logTransformTiming(sessionId, "tag.inertWhitespace", tInertWhitespace);
    const assignments = tagger.getAssignments(sessionId);
    const resolver = createExistingTagResolver(sessionId, tagger, db);
    // FORK（tag-drift-content-verify）：pass 级惰性预扫描（本 pass 首个参与判定的
    // 文本 part 触发，只做一次）+ 就地执行。计划必须早于该 part 的 resolver.resolve
    // ——见 buildTagContentPlans 注释里的硬契约。
    let tagContentPlans: Map<string, TagContentPlan> | undefined;
    const getTagContentPlans = (): Map<string, TagContentPlan> =>
        (tagContentPlans ??= buildTagContentPlans(
            sessionId,
            messages,
            db,
            inertWhitespaceTagNumbers,
        ));
    // 认领成功的 tag：其存量原文与入站文本恒相等（认领前提就是 sourceIdx[X] 含 R）。
    // pass 级的 sourceContents map 由 collectRelevantSourceTagIds 按「预扫描时的
    // assignments ∩ 当前消息 id」裁剪，窗口外的被认领 tag 不在 map 里，下方的
    // replaceSourceContent 会照常触发——写入值相同、幂等无害，但经预扫描索引判等
    // 后直接跳过这次写。
    const claimedSourceEcho = new Map<number, string>();
    const tombstonePositionTag = (tagNumber: number, contentId: string): void => {
        // DB：只改位置键、不改 status（WHERE 围栏 expectedKeys={contentId}，并发
        // 改键时 changes=0 视为已被处理）。内存：仅当 getTag(contentId) === tagNumber
        // 时 unbind——被主人认领回去的 tag 的 dropped 状态要原样重放，动了 status
        // 会让平移后的消息从 dropped 变回 active，上下文膨胀。
        tombstoneTagMessageId(db, sessionId, tagNumber, [contentId]);
        if (tagger.getTag(sessionId, contentId, "message") === tagNumber) {
            tagger.unbindTag(sessionId, contentId);
        }
    };
    const executeTagContentClaim = (
        plan: TagContentPlan,
        ownerMessageId: string,
        contentId: string,
        ordinal: number,
    ): number | undefined => {
        const claimTagNumber = plan.claimTagNumber ?? -1;
        if (plan.tombstoneTarget !== undefined) {
            tombstonePositionTag(plan.tombstoneTarget, contentId);
        }
        // 围栏含墓碑键：均匀平移的链里，位置 N 的 part 先把 T 墓碑化，位置 N+d 的
        // part（T 的主人）随后要把 T 认领回去，此时 T 的旧键已经是墓碑键。
        const claimed = rebindTagMessageIdFenced(
            db,
            sessionId,
            claimTagNumber,
            plan.claimFromKeys ?? [],
            contentId,
        );
        if (!claimed) {
            // 围栏未命中（并发改键）：「沿用 T」在该 part 上已不可达（T 此前已墓
            // 碑化），按漂移分支同口径处置——屏蔽 scoped fallback 后 resolve 必然
            // 返回 undefined，随后走 assignTag 拿新号。
            sessionLog(
                sessionId,
                `tag content-verify: claim fence missed for tag ${claimTagNumber} at ${contentId}; assigning a fresh number`,
            );
            tagger.unbindTag(sessionId, contentId);
            return resolver.resolve(ownerMessageId, "message", contentId, ordinal, {
                accept: () => false,
            });
        }
        // bindTag 是无条件 set：先读 getTag(contentId)，现存绑定既不是位置命中的 T
        // 也不是空时是内存与 DB 不一致的防御场景——warn 后继续 bind。
        const incumbent = tagger.getTag(sessionId, contentId, "message");
        if (
            incumbent !== undefined &&
            incumbent !== claimTagNumber &&
            incumbent !== plan.tombstoneTarget
        ) {
            sessionLog(
                sessionId,
                `tag content-verify: in-memory map held tag ${incumbent} on ${contentId} while claiming tag ${claimTagNumber}; rebinding over it`,
            );
        }
        // 对 R 的旧 contentId 不做无条件 unbind——旧键上此刻可能是本 pass 刚绑上去
        // 的别的 tag，仅当它仍指向 R 时才让出。
        const oldContentId = plan.claimOldContentId;
        if (oldContentId && tagger.getTag(sessionId, oldContentId, "message") === claimTagNumber) {
            tagger.unbindTag(sessionId, oldContentId);
        }
        tagger.bindTag(sessionId, contentId, claimTagNumber);
        if (plan.claimText !== undefined) claimedSourceEcho.set(claimTagNumber, plan.claimText);
        // 随后照常 resolve——此时 assignments 里 contentId 精确命中的就是 R。
        return resolver.resolve(ownerMessageId, "message", contentId, ordinal, {
            accept: (tagNumber) => !inertWhitespaceTagNumbers.has(tagNumber),
        });
    };
    const tGetSourceContents = performance.now();
    const sourceContents = getSourceContents(
        db,
        sessionId,
        collectRelevantSourceTagIds(messages, assignments),
    );
    logTransformTiming(sessionId, "tag.getSourceContents", tGetSourceContents);
    // Partial compartment ends (a compartment that stops inside a message at
    // end_block_index), read once per pass on first use. Every text and file
    // target's setContent needs this, and a per-call query on a large session
    // costs hundreds of milliseconds per pass. When several partial compartments
    // end in the same message, text and file targets keep the first row and tool
    // targets the last, which is what their former per-target queries returned.
    let partialEndsCache: { first: Map<string, number>; last: Map<string, number> } | undefined;
    const loadPartialEnds = (): { first: Map<string, number>; last: Map<string, number> } => {
        if (partialEndsCache) return partialEndsCache;
        const first = new Map<string, number>();
        const last = new Map<string, number>();
        const rows = db
            .prepare(
                "SELECT end_message_id, end_block_index FROM compartments WHERE session_id=? AND end_block_index IS NOT NULL ORDER BY rowid",
            )
            .all(sessionId) as Array<{ end_message_id: string; end_block_index: number }>;
        for (const row of rows) {
            if (!first.has(row.end_message_id)) first.set(row.end_message_id, row.end_block_index);
            last.set(row.end_message_id, row.end_block_index);
        }
        partialEndsCache = { first, last };
        return partialEndsCache;
    };
    const getPartialEnds = (): Map<string, number> => loadPartialEnds().first;
    let precedingThinkingParts: ThinkingLikePart[] = [];
    let lastReduceMessageIndex = -1;
    const RECENT_REDUCE_LOOKBACK = 10;
    const commitDetected = hasRecentAssistantCommit(messages);

    // Intentional: we deliberately do NOT wrap this walk in db.transaction(...).
    // Each tagger.assignTag() owns its own atomic SAVEPOINT (insert + counter
    // upsert). Wrapping the whole walk in an outer transaction was an old
    // cache-bust amplifier — one UNIQUE collision near the end of the walk
    // would roll back EVERY tag insert + saveSourceContent in this pass,
    // leaving the in-memory message mutations and §N§ prefixes already
    // applied while the DB had no record of them. The transform's catch
    // block then fell through with `targets={}` (empty), and the pass
    // emitted a message[0] whose stripped/dropped/cavemaned replays were
    // all skipped, resurfacing ~110k tokens of bulky content.
    //
    // Per-call SAVEPOINTs already give us the atomicity we actually need:
    // each (tag insert, counter upsert, source_contents save) succeeds or
    // fails independently. A single tag failing no longer corrupts the
    // surrounding work in the same pass.
    // Diagnostic accumulators (summed across the whole walk, logged once below).
    let accDerive = 0;
    let accGetToolTag = 0;
    let accAssignTag = 0;
    let accAssignToolTag = 0;
    let accSaveSource = 0;
    const tLoop = performance.now();
    for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
        const message = messages[msgIndex];
        const messageId = typeof message.info.id === "string" ? message.info.id : null;

        if (message.info.role === "user") {
            precedingThinkingParts = [];
        }

        const messageThinkingParts = message.parts.filter(isThinkingPart);
        if (messageThinkingParts.length > 0) {
            reasoningByMessage.set(message, messageThinkingParts);
        }
        const messageHasTextPart = message.parts.some(isTextPart);
        let textOrdinal = 0;
        let fileOrdinal = 0;
        let whitespaceRank = 0;

        for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
            const part = message.parts[partIndex];

            if (isReduceToolPart(part)) {
                lastReduceMessageIndex = msgIndex;
            }

            const toolObservation = extractToolCallObservation(part);
            if (toolObservation) {
                // v3.3.1 Layer C: derive composite owner via FIFO pairing.
                // - invocation parts: ownerMsgId = message hosting the part.
                // - result parts: pop the FIFO queue for this callId; if
                //   empty, fall back to nearest-prior persisted owner;
                //   ultimate fallback: result's own message id.
                const _tDerive = performance.now();
                // A completed OpenCode tool part is hosted by its invocation message.
                // Reuse that already-loaded composite binding before attempting the
                // result-only fallback, which otherwise performs two database probes
                // for every historical tool part on every replay pass.
                // 修复：复用宿主绑定仅限 assistant 宿主（OpenCode「调用/结果同
                // 消息」形态）。ZCode 拆分形态的 result 挂在 user 消息上，若也
                // 走这条快路径，owner 会被钉在 result 自己的消息上，与
                // invocation 侧分裂成两个 composite key，drop 只清 result 一侧、
                // invocation 成孤儿（AI_MissingToolResultsError）。user-role
                // 宿主必须交给 FIFO 配对（见
                // docs/specs/magic-context-tool-arc-pairing.md）。
                const boundToHostingMessage =
                    toolObservation.kind === "result" &&
                    message.info.role === "assistant" &&
                    messageId
                        ? tagger.getToolTag(sessionId, toolObservation.callId, messageId)
                        : undefined;
                const ownerMsgId =
                    boundToHostingMessage !== undefined && messageId
                        ? messageId
                        : deriveToolOwnerMessageId(
                              sessionId,
                              db,
                              message,
                              toolObservation,
                              unpairedInvocations,
                              ownerDerivationCache,
                              onToolOwnerFallbackLookup,
                          );
                accDerive += performance.now() - _tDerive;
                const compositeKey = makeToolCompositeKey(ownerMsgId, toolObservation.callId);
                const entry = toolCallIndex.get(compositeKey) ?? {
                    occurrences: [],
                    hasResult: false,
                };
                entry.occurrences.push({ message, part, kind: toolObservation.kind });
                // An OpenCode `{ type: "tool" }` part is observed as a "result" by
                // its TYPE even while the call is still pending/running, so gate
                // hasResult on an ACTUAL completed result (state.output present).
                // This keeps open arcs out of every drop/clamp selector — a live
                // task part's input must never become a reclaim target.
                if (toolObservation.kind === "result" && partHasCompletedResult(part))
                    entry.hasResult = true;
                toolCallIndex.set(compositeKey, entry);

                const _tGetTool = performance.now();
                let existingTagId = tagger.getToolTag(
                    sessionId,
                    toolObservation.callId,
                    ownerMsgId,
                );
                accGetToolTag += performance.now() - _tGetTool;

                // v3.3.1 Layer C: legacy NULL-owner adoption for the
                // invocation-only path. The second tool block
                // (isToolPartWithOutput) calls assignToolTag which
                // adopts NULL-owner rows automatically — but invocation
                // observations don't pass through that block. Without
                // this lazy adoption, an invocation-only message with a
                // pre-existing NULL-owner tag would never bind into
                // `targets`, so a queued drop op against that tag could
                // not be detected as "incomplete" (no result) and would
                // fall through to the "absent" branch in
                // applyPendingOperations, marking the tag dropped
                // prematurely.
                if (existingTagId === undefined) {
                    const orphan = getNullOwnerToolTag(db, sessionId, toolObservation.callId);
                    if (orphan !== null) {
                        const claimed = adoptNullOwnerToolTag(db, orphan.id, ownerMsgId);
                        if (claimed) {
                            invalidateCachedCandidateToolOwnersIfNewOwner(
                                ownerDerivationCache,
                                sessionId,
                                toolObservation.callId,
                                ownerMsgId,
                            );
                            tagger.bindToolTag(
                                sessionId,
                                toolObservation.callId,
                                ownerMsgId,
                                orphan.tagNumber,
                            );
                            existingTagId = orphan.tagNumber;
                        } else {
                            // Race lost — re-check composite path.
                            existingTagId = tagger.getToolTag(
                                sessionId,
                                toolObservation.callId,
                                ownerMsgId,
                            );
                        }
                    }
                }

                // Scoped-load self-heal for the invocation-only path: a tool tag
                // can exist in the DB under its exact composite (owner, callId)
                // key yet be absent from the in-memory map when the tagger load
                // was scoped to the live-wire floor and this tag's number is below
                // it (a tool RESULT in the wire whose invocation was compacted away
                // resolves to a persisted owner below the floor — tag-messages
                // pickNearestPriorOwner). The output-bearing path (assignToolTag)
                // already does this composite DB lookup; the invocation/native
                // tool_result observation path did not. Without it, the existing
                // tag would be missed and a queued drop mis-detected. Rebind the
                // EXACT persisted number so §N§ stays byte-identical.
                if (existingTagId === undefined) {
                    const persisted = getToolTagNumberByOwner(
                        db,
                        sessionId,
                        toolObservation.callId,
                        ownerMsgId,
                    );
                    if (persisted !== null) {
                        tagger.bindToolTag(
                            sessionId,
                            toolObservation.callId,
                            ownerMsgId,
                            persisted,
                        );
                        existingTagId = persisted;
                    }
                }

                if (existingTagId !== undefined) {
                    toolTagByCallId.set(compositeKey, existingTagId);
                    messageTagNumbers.set(
                        message,
                        Math.max(messageTagNumbers.get(message) ?? 0, existingTagId),
                    );
                    if (
                        message.info.role === "tool" &&
                        precedingThinkingParts.length > 0 &&
                        !toolThinkingByCallId.has(compositeKey)
                    ) {
                        toolThinkingByCallId.set(compositeKey, precedingThinkingParts);
                    }
                }
                ownerByPartKey.set(part, { ownerMsgId, callId: toolObservation.callId });
            }

            if (messageId && isTextPart(part)) {
                const textPart = part;
                const thinkingParts = messageThinkingParts;
                const contentId = `${messageId}:p${partIndex}`;
                const whitespaceOnlyAssistant =
                    message.info.role === "assistant" &&
                    stripTagPrefix(textPart.text).trim().length === 0;
                // New whitespace-only assistant parts are provider framing, not reclaimable
                // content. A pre-deploy row is different: replay its existing prefix forever
                // so deployment never changes signed-adjacent bytes, but retire the row from
                // active accounting because ctx_reduce cannot reclaim provider framing.
                let existingTagId: number | undefined;
                if (whitespaceOnlyAssistant) {
                    const persistedWhitespaceTag = getTagNumberByMessageId(
                        db,
                        sessionId,
                        contentId,
                    );
                    const rankedInertTag =
                        inertWhitespaceTagsByMessage.get(messageId)?.[whitespaceRank];
                    // Reuse a retired whitespace tag only at its original part index or
                    // next to a thinking part, where whitespace is provider framing. A
                    // blank added after a completed step must remain untagged instead of
                    // inheriting an older prefix.
                    const canReplayRankedTag =
                        rankedInertTag?.partIndex === partIndex ||
                        isThinkingPart(message.parts[partIndex - 1]) ||
                        isThinkingPart(message.parts[partIndex + 1]);
                    const inertForThisPart = canReplayRankedTag
                        ? rankedInertTag?.tagNumber
                        : undefined;
                    whitespaceRank += 1;
                    if (inertForThisPart !== undefined) {
                        // Bind by rank, bypassing the ordinal fallback: after a remap the
                        // fallback offers whichever row sits at the current text ordinal,
                        // which is the wrong inert row whenever a real text part moved.
                        tagger.bindTag(sessionId, contentId, inertForThisPart);
                        existingTagId = inertForThisPart;
                    } else {
                        existingTagId = resolver.resolve(
                            messageId,
                            "message",
                            contentId,
                            textOrdinal,
                            { accept: (tagNumber) => tagNumber === persistedWhitespaceTag },
                        );
                    }
                    if (existingTagId === undefined) {
                        const persisted = getTagNumberByMessageId(db, sessionId, contentId);
                        if (
                            persisted !== null &&
                            !getSourceContents(db, sessionId, [persisted]).has(persisted)
                        ) {
                            tagger.bindTag(sessionId, contentId, persisted);
                            existingTagId = persisted;
                        }
                    }
                    if (existingTagId === undefined) {
                        // Preserve text ordinals even when framing is not tagged. Otherwise an
                        // old whitespace row can be rebound to a later real text part by the
                        // part-id fallback on the next pass.
                        textOrdinal += 1;
                        continue;
                    }
                    const existingTag = getTagById(db, sessionId, existingTagId);
                    if (existingTag?.type !== "message") {
                        tagger.unbindTag(sessionId, contentId);
                        textOrdinal += 1;
                        continue;
                    }
                    if (existingTag.status === "active") {
                        markWhitespaceAssistantTagInert(db, sessionId, existingTagId, contentId);
                        inertWhitespaceTagNumbers.add(existingTagId);
                    }
                } else {
                    // Resolver pre-warms any tag-id-fallback bindings (e.g. when OpenCode
                    // re-assigns part IDs); the assigned tag below uses those bindings. Inert
                    // whitespace rows are replay-only and must never migrate onto real text.
                    // FORK（tag-drift-content-verify）：计划在该 part 进入 resolve 之前
                    // 就地执行（硬契约，见 buildTagContentPlans）。claim / drift /
                    // system-assign 三类计划执行后 existingTagId 有着落或必为 undefined；
                    // existing（相符 / 编辑重发 / 不参与判定）走既有流程，一个字都不动。
                    const plan = getTagContentPlans().get(contentId);
                    if (plan && DRIFT_PLAN_KINDS.has(plan.kind)) {
                        if (plan.kind === "claim") {
                            existingTagId = executeTagContentClaim(
                                plan,
                                messageId,
                                contentId,
                                textOrdinal,
                            );
                        } else if (plan.kind === "drift") {
                            // 墓碑化 T（若有）后无条件 unbind(contentId)：不屏蔽的话
                            // scoped fallback 会把同消息桶里让出的空位对应的兄弟旧
                            // tag 落到当前 part 上；accept 恒为 false 使精确命中与
                            // fallback 都不放行，resolve 必然返回 undefined，随后走
                            // assignTag，DB 与内存两层对 contentId 都已查不到 T，
                            // 正常分配。无条件 unbind 是硬要求——墓碑化的内存侧只是
                            // 条件 unbind（仅 getTag(c) === T 时），内存与 DB 不一致
                            // 的防御场景下挡不住 assignTag 的内存快路径把 c 上残留
                            // 的旧号送回来、再把 X 写进那个号的原文。v2 的平移不符 /
                            // 平移落空与本分支同构（位置上没有 tag 时不墓碑化）。
                            if (plan.tombstoneTarget !== undefined) {
                                tombstonePositionTag(plan.tombstoneTarget, contentId);
                            }
                            tagger.unbindTag(sessionId, contentId);
                            existingTagId = resolver.resolve(
                                messageId,
                                "message",
                                contentId,
                                textOrdinal,
                                { accept: () => false },
                            );
                        } else {
                            // 入站 system 行落在非 system 的旧 tag 上：墓碑化 T（不改
                            // status / role、不覆盖 S(T)），跳过 resolve 直接 assignTag
                            // ——不调用 resolve，scoped fallback 自然无从触发；不以默
                            // 认 accept 调用（mc1:* 桶里可能挂着上一代 synthetic head
                            // 的旧 tag，回退匹配会把它重绑到 system 行上）。
                            // FORK（magic-context-trim-integrity CR-3）：墓碑化之后
                            // 无条件 unbind(contentId)，与上方漂移分支同款——墓碑化的
                            // 内存侧只是条件解绑（仅 getTag(c) === T 时才放），挡不住
                            // assignTag 的内存快路径：本 pass 早前 inert 重放（pass 开头
                            // 把 inert 行的 contentId bindTag 进内存）或空白 assistant
                            // 分支已把该 contentId 绑到别的旧号上时，assignTag 会直接
                            // 返回那个旧号，随后 replaceSourceContent 把 system prompt
                            // 写进它的原文——正是专门规则要防的行为。
                            if (plan.tombstoneTarget !== undefined) {
                                tombstonePositionTag(plan.tombstoneTarget, contentId);
                            }
                            tagger.unbindTag(sessionId, contentId);
                        }
                    } else {
                        existingTagId = resolver.resolve(
                            messageId,
                            "message",
                            contentId,
                            textOrdinal,
                            {
                                accept: (tagNumber) =>
                                    !inertWhitespaceTagNumbers.has(tagNumber),
                            },
                        );
                        if (
                            existingTagId === undefined &&
                            inertWhitespaceTagNumbers.has(
                                tagger.getTag(sessionId, contentId, "message") ?? -1,
                            )
                        ) {
                            tagger.unbindTag(sessionId, contentId);
                        }
                    }
                }
                const _tAssignText = performance.now();
                const tagId =
                    existingTagId ??
                    tagger.assignTag(
                        sessionId,
                        contentId,
                        "message",
                        byteSize(textPart.text),
                        db,
                        textOrdinal === 0 ? getReasoningByteSize(thinkingParts) : 0,
                        null,
                        0,
                        null,
                        // Lazy: only fires on fresh insert. textPart.text is still the
                        // pre-prefix source here (prependTag runs after assign).
                        () => ({
                            tokenCount: estimateTextTagTokenCount(stripTagPrefix(textPart.text)),
                            inputTokenCount: null,
                            reasoningTokenCount:
                                textOrdinal === 0 ? getReasoningTokenCount(thinkingParts) : 0,
                        }),
                    );
                accAssignTag += performance.now() - _tAssignText;
                // FORK（magic-context-system-prompt-guard）：把消息 role 落到
                // tags.message_role，供 queue/apply/replay 三层识别 system 提示词段
                // （上游无此列，fork 车道 v10000 新增）。
                // 必须挂在 tagId 解析之后无条件执行：existingTagId 命中的存量 tag 与
                // assignTag 新分配的 tag 同样要写。每 pass 都写——mcN 是序数 id，system
                // 段数量变化会让同一 tag 改绑 role，重写兼做纠正；SQL 侧 `IS NOT` 守卫
                // 保证 role 稳定后零写。tool 打标点不写（tool part 不会出现在
                // role=system 消息上）。
                stampTagMessageRole(db, sessionId, tagId, message.info.role ?? null);
                // Prefer persisted source_contents over the existingTagId
                // signal: even if we just allocated a fresh tag (because in-
                // memory state was lost), the DB may still have the original
                // pre-tag content from a previous pass. Restoring from source
                // is the only way to keep message content stable across passes
                // when assignTag's recovery rebound a different tag number
                // than what the resolver expected.
                // FORK（edit-resend-stale-text / v1.0.30）：tag 身份是位置
                // （host 投影的 `mc<ordinal>`），rewind / 编辑重发会让同一位置换成另一条
                // 消息；无条件用持久 source 覆盖会把新正文换回被编辑掉的旧正文（用户症状：
                // 编辑后模型仍读到历史消息）。入站文本来自宿主 messageHistory，是权威原文，
                // 一旦与持久 source 不一致，只能说明该 tag 已指向另一条消息——以入站为准，
                // 并用 upsert 纠正 source；一致时仍恢复持久 source（保留 tag 号重绑时的
                // 字节稳定性）。
                const sourceContent = stripTagPrefix(textPart.text);
                const persistedSource = sourceContents.get(tagId);
                if (persistedSource !== undefined && persistedSource === sourceContent) {
                    textPart.text = persistedSource;
                } else if (
                    sourceContent.trim().length > 0 &&
                    // FORK（tag-drift-content-verify）：本 pass 认领的 tag 其存量原文
                    // 与 X 恒相等（认领前提就是 sourceIdx[X] 含 R）。sourceContents
                    // map 是预扫描时 assignments 的裁剪视图，窗口外的被认领 tag 不在
                    // map 里，会落到这个写分支——经预扫描索引判等后跳过这次幂等写。
                    claimedSourceEcho.get(tagId) !== sourceContent
                ) {
                    const _tSaveText = performance.now();
                    replaceSourceContent(db, sessionId, tagId, sourceContent);
                    accSaveSource += performance.now() - _tSaveText;
                }
                messageTagNumbers.set(
                    message,
                    Math.max(messageTagNumbers.get(message) ?? 0, tagId),
                );
                if (!skipPrefixInjection) {
                    textPart.text = prependTag(tagId, textPart.text);
                    normalizationTargets.push({
                        tagNumber: tagId,
                        message,
                        part: textPart,
                        field: "text",
                    });
                }
                targets.set(tagId, {
                    message,
                    textPrefix: skipPrefixInjection ? "" : prependTag(tagId, ""),
                    setContent: (content, options) => {
                        if (textPart.text === content) return false;
                        const partialEnd = messageId ? getPartialEnds().get(messageId) : undefined;
                        if (partialEnd !== undefined && partIndex > partialEnd) return false;
                        textPart.text = content;
                        if (options?.keepReasoning === true) return true;
                        for (const tp of thinkingParts) {
                            if (partialEnd !== undefined && message.parts.indexOf(tp) > partialEnd)
                                continue;
                            neutralizeDroppedReasoningPart(tp);
                        }
                        return true;
                    },
                    getContent: () => textPart.text,
                });
                textOrdinal += 1;
                continue;
            }

            if (isToolPartWithOutput(part)) {
                const toolPart = part;
                const thinkingParts = precedingThinkingParts;

                // v3.3.1 Layer C: derive owner from the FIFO memo set
                // earlier in this same loop iteration. The first tool
                // block (extractToolCallObservation) already paired this
                // part — reuse that owner so we don't double-pop the
                // queue (which would shift result-pairing for later
                // result parts of the same callId).
                const memo = ownerByPartKey.get(part);
                const ownerMsgId = memo?.ownerMsgId ?? messageId ?? toolPart.callID;
                const compositeKey = makeToolCompositeKey(ownerMsgId, toolPart.callID);

                const _tAssignTool = performance.now();
                // No growth-bump on the existing-tag path here (unlike Pi's
                // tag-transcript, which bumps byte_size/token_count when a later
                // occurrence is larger). The asymmetry is structural: OpenCode
                // only tags once `state.output` is a string — i.e. after the tool
                // completed — and OpenCode writes tool output exactly once, so a
                // tagged output never grows afterwards. Pi tags the INVOCATION
                // occurrence first (byte_size=0) and must bump when the result
                // lands. Verified empirically: 100,670 tool tags across the two
                // largest live sessions show zero byte_size drift vs the current
                // opencode.db output. Adding a per-part size compare here would
                // cost every hot pass to defend an unreachable case.
                const existingToolTag = tagger.getToolTag(sessionId, toolPart.callID, ownerMsgId);
                let tagId = existingToolTag;
                if (tagId === undefined) {
                    const reasoningBytes = getReasoningByteSize(thinkingParts);
                    const { toolName, inputByteSize, inputTokenCount } =
                        extractToolTagMetadata(toolPart);
                    tagId = tagger.assignToolTag(
                        sessionId,
                        toolPart.callID,
                        ownerMsgId,
                        byteSize(toolPart.state.output),
                        db,
                        reasoningBytes,
                        toolName,
                        inputByteSize,
                        // Lazy: fires only on fresh insert. token_count = output tokens
                        // (mirrors byte_size=output); input/reasoning stored separately.
                        () => ({
                            tokenCount:
                                estimateTextTagTokenCount(stripTagPrefix(toolPart.state.output)) +
                                estimateToolAttachmentImageTokens(toolPart.state),
                            inputTokenCount,
                            reasoningTokenCount: getReasoningTokenCount(thinkingParts),
                        }),
                    );
                }
                invalidateCachedCandidateToolOwnersIfNewOwner(
                    ownerDerivationCache,
                    sessionId,
                    toolPart.callID,
                    ownerMsgId,
                );
                accAssignToolTag += performance.now() - _tAssignTool;
                messageTagNumbers.set(
                    message,
                    Math.max(messageTagNumbers.get(message) ?? 0, tagId),
                );
                if (!skipPrefixInjection) {
                    toolPart.state.output = prependTag(tagId, toolPart.state.output);
                    normalizationTargets.push({
                        tagNumber: tagId,
                        message,
                        part: toolPart,
                        field: "tool_state_output",
                    });
                }
                toolTagByCallId.set(compositeKey, tagId);
                if (thinkingParts.length > 0 && !toolThinkingByCallId.has(compositeKey)) {
                    toolThinkingByCallId.set(compositeKey, thinkingParts);
                }
            }

            if (messageId && isFilePart(part)) {
                const filePart = part;
                const messageParts = message.parts;
                const contentId = `${messageId}:file${partIndex}`;
                const existingTagId = resolver.resolve(messageId, "file", contentId, fileOrdinal);
                const _tAssignFile = performance.now();
                const tagId =
                    existingTagId ??
                    tagger.assignTag(
                        sessionId,
                        contentId,
                        "file",
                        byteSize(filePart.url),
                        db,
                        0,
                        null,
                        0,
                        null,
                        () => ({
                            tokenCount: estimateTextTagTokenCount(filePart.url),
                            inputTokenCount: null,
                            reasoningTokenCount: null,
                        }),
                    );
                accAssignTag += performance.now() - _tAssignFile;
                // FORK（magic-context-system-prompt-guard）：与 text 打标点同口径——
                // tagId 解析后无条件写 message_role（存量命中与新分配都写，每 pass 纠正）。
                stampTagMessageRole(db, sessionId, tagId, message.info.role ?? null);
                if (existingTagId === undefined) {
                    const sourceContent = buildFileSourceContent(message.parts);
                    if (sourceContent) {
                        const _tSaveFile = performance.now();
                        saveSourceContent(db, sessionId, tagId, sourceContent);
                        accSaveSource += performance.now() - _tSaveFile;
                    }
                }
                messageTagNumbers.set(
                    message,
                    Math.max(messageTagNumbers.get(message) ?? 0, tagId),
                );
                targets.set(tagId, {
                    message,
                    setContent: (content) => {
                        const prev = messageParts[partIndex];
                        const prevText =
                            typeof prev === "object" && prev !== null && "text" in prev
                                ? (prev as { text: string }).text
                                : "";
                        if (prevText === content) return false;
                        if (messageId) {
                            const partialEnd = getPartialEnds().get(messageId);
                            if (partialEnd !== undefined && partIndex > partialEnd) return false;
                        }
                        messageParts[partIndex] = {
                            type: "text",
                            text: content,
                        } as MessageLike["parts"][number];
                        return true;
                    },
                });
                fileOrdinal += 1;
            }
        }

        if (message.info.role === "assistant" && !messageHasTextPart) {
            precedingThinkingParts = messageThinkingParts;
        }
    }

    logTransformTiming(sessionId, "tag.loop", tLoop);
    logTransformTiming(sessionId, "tag.deriveOwner", performance.now() - accDerive);
    logTransformTiming(sessionId, "tag.getToolTag", performance.now() - accGetToolTag);
    logTransformTiming(sessionId, "tag.assignTag", performance.now() - accAssignTag);
    logTransformTiming(sessionId, "tag.assignToolTag", performance.now() - accAssignToolTag);
    logTransformTiming(sessionId, "tag.saveSource", performance.now() - accSaveSource);

    const partialEnds =
        toolTagByCallId.size > 0 ? loadPartialEnds().last : new Map<string, number>();
    for (const [compositeKey, tagId] of toolTagByCallId) {
        const occurrences = toolCallIndex.get(compositeKey)?.occurrences ?? [];
        const touchesUncoveredPart = occurrences.some(({ message, part }) => {
            const messageId = message.info.id;
            if (typeof messageId !== "string") return false;
            const partialEnd = partialEnds.get(messageId);
            return partialEnd !== undefined && message.parts.indexOf(part) > partialEnd;
        });
        if (touchesUncoveredPart) continue;
        const thinkingParts = toolThinkingByCallId.get(compositeKey) ?? [];
        targets.set(
            tagId,
            createToolDropTarget(compositeKey, thinkingParts, toolCallIndex, batch, tagId),
        );
    }

    const hasRecentReduceCall =
        lastReduceMessageIndex >= 0 &&
        messages.length - lastReduceMessageIndex <= RECENT_REDUCE_LOOKBACK;

    return {
        targets,
        reasoningByMessage,
        messageTagNumbers,
        toolCallIndex,
        batch,
        hasRecentReduceCall,
        hasRecentCommit: commitDetected,
        normalizationTargets,
    };
}
