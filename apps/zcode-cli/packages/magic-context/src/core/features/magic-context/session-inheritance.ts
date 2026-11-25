/**
 * FORK（magic-context-fork-inherit）：fork 子会话继承父会话的折叠状态与摘要。
 *
 * 上游为克隆会话准备的是 `copySessionStateForClone`（按消息 id 映射换算坐标）。
 * ZCode 的 fork 走不通那条路：子会话的消息全部换新 ID，而 live 模式下包看到的
 * id 是 `mc<序号>`——序号是运行时条目数组的位置，父子两个数组形状不同（前缀
 * 长度会变、父会话未落库的附件不在子会话里），同一个 `mc<N>` 在子会话里指向
 * 别的条目。原样搬边界要么解析不到（不裁前缀，装不下即拒发），要么落到别的
 * 条目上（裁错位置，静默丢上下文）。
 *
 * 所以这里不搬坐标，改为：
 *   - tags：按「内容等值 + 单调对齐」把父会话 dropped 的状态套到子会话自己的
 *     part 上，预置成 `status = 'dropped'` 的行。tagger 的 `initFromDb` 与 DB fast
 *     path 不过滤 status，首轮 transform 会重绑到这些行并照常重放占位。
 *   - compartments：正文与坐标无关，原样复制；数值区间按舱序压成 1..M 的连续区间
 *     （M = 裁前缀的位置；historian 的增量起点与连续性校验只看数值）。父会话的常态
 *     是把摘要边界之前的条目整体裁掉、只留摘要头与末端未折叠的消息（真实长会话
 *     实测：8981 个条目只发 853 条），子会话必须同形才装得进窗口，所以末舱边界写成
 *     子会话坐标让它同样裁前缀：末端长度照搬父会话未裁的末端，再加安全余量。
 *     算不出可靠的末端时边界留空，退回「不裁、以占位符呈现」。
 *
 * 全部规则集中在本文件，宿主只负责判断「这是 fork 子会话的首轮」并调用。
 */

import {
    buildFileSourceContent,
    isTextPart,
    isToolPartWithOutput,
    stripTagPrefix,
} from "../../hooks/magic-context/tag-part-guards.js";
import { validateStoredCompartments } from "../../hooks/magic-context/compartment-runner-validation.js";
import type { Database } from "../../shared/sqlite.js";
import {
    appendCompartmentsInTransaction,
    type CompartmentInput,
    getCompartments,
} from "./compartment-storage.js";
import { getSourceContents, saveSourceContent } from "./storage-source.js";
import {
    getTagsBySession,
    insertTag,
    stampTagMessageRole,
    updateTagDropMode,
    updateTagStatus,
    type TagEntry,
} from "./storage-tags.js";

/** 宿主投影后的子会话 live 消息。结构上兼容 `MessageLike`，不反向依赖 hooks 层类型。 */
export interface InheritedMessageLike {
    info: { id?: string; role?: string; syntheticHead?: boolean };
    parts: unknown[];
}

/** 父会话某个工具调用的结果。tool 类 tag 在 `source_contents` 里没有原文，只能由宿主从消息行取。 */
export interface ParentToolOutput {
    toolName: string;
    output: string;
}

export interface InheritForkedSessionStateInput {
    db: Database;
    parentSessionId: string;
    childSessionId: string;
    /** 子会话首轮的 live 投影，必须与 transform 用的是同一份（同样的 `mc<N>` 编号）。 */
    childMessages: readonly InheritedMessageLike[];
    /** 父会话 callID → 工具结果。缺席时 tool 类 tag 全部不继承。 */
    parentToolOutputs?: ReadonlyMap<string, ParentToolOutput>;
}

export type InheritForkedSessionStateResult =
    | {
          kind: "inherited";
          tags: number;
          compartments: number;
          boundaryOrdinal: number;
          /** 子会话是否像父会话一样裁前缀（只留摘要头与末端未折叠的消息）。 */
          trims: boolean;
          /** `trims` 为 false 时的原因；为 true 时是边界的换算依据。 */
          reason?: string;
          trimDetail?: string;
      }
    | { kind: "tags-only"; tags: number; reason: string }
    | { kind: "skipped"; reason: string };

/**
 * 对齐后，首个与末个命中之间的子会话候选至少要有这个比例被命中。
 *
 * 贪心的「从游标起找第一个相等」最坏时会跳过一大段、提前对上后面的重复文本，
 * 留下一段中间的子会话内容无人认领。这一段若被裁前缀带走就是静默丢上下文，
 * 所以命中率低于阈值时整体放弃。短内容（空白 part、父会话没存原文的 tag）
 * 本来就对不上，阈值留出一成余量。
 */
const MIN_INTERIOR_MATCH_RATIO = 0.9;

type CandidateKind = "text" | "tool" | "file";

interface ChildCandidate {
    kind: CandidateKind;
    messageIndex: number;
    partIndex: number;
    /** `null` = 没有可比对的内容。 */
    key: string | null;
}

interface ParentTag {
    tag: TagEntry;
    kind: CandidateKind;
    key: string | null;
}

interface Match {
    parent: ParentTag;
    child: ChildCandidate;
}

function partType(part: unknown): string {
    return typeof part === "object" && part !== null
        ? String((part as { type?: unknown }).type)
        : "";
}

function partField(part: unknown, field: "callID" | "tool"): unknown {
    return typeof part === "object" && part !== null
        ? (part as Record<string, unknown>)[field]
        : undefined;
}

function toolKey(toolName: string, output: string): string {
    return `${toolName}\u0000${output}`;
}

function isWhitespace(text: string): boolean {
    return text.trim().length === 0;
}

function childCandidates(
    messages: readonly InheritedMessageLike[],
    includeTool: boolean,
): ChildCandidate[] {
    const candidates: ChildCandidate[] = [];
    messages.forEach((message, messageIndex) => {
        message.parts.forEach((part, partIndex) => {
            if (isTextPart(part)) {
                const text = stripTagPrefix(part.text);
                candidates.push({
                    kind: "text",
                    messageIndex,
                    partIndex,
                    key: isWhitespace(text) ? null : text,
                });
            } else if (includeTool && isToolPartWithOutput(part)) {
                candidates.push({
                    kind: "tool",
                    messageIndex,
                    partIndex,
                    key: toolKey(String(partField(part, "tool")), part.state.output),
                });
            }
        });
        // file 类 tag 的 content 是整条消息全部 text part 的拼接（`buildFileSourceContent`），
        // 所以每个带 file part 的消息额外产生一个候选，落在它首个 file part 上。
        const firstFile = message.parts.findIndex((part) => partType(part) === "file");
        const content = firstFile < 0 ? null : buildFileSourceContent(message.parts);
        if (firstFile >= 0 && content !== null) {
            candidates.push({ kind: "file", messageIndex, partIndex: firstFile, key: content });
        }
    });
    return candidates;
}

function findToolOwner(
    messages: readonly InheritedMessageLike[],
    callId: string,
): string | undefined {
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const declares = message.parts.some(
            (part) => partType(part) === "tool" && partField(part, "callID") === callId,
        );
        if (declares) return message.info.id;
    }
    return undefined;
}

/**
 * 把父 tag 对到子候选上；`distrust` 非空表示对齐不可信，原因可直接进日志。
 *
 * 不用「从游标起找第一个相等」的全局贪心。真实会话里有大量重复的样板（todo 提醒、
 * 输出相同的工具结果），父会话在某处多出几份重复（回滚掉的分支、没落库的临时附件）
 * 就会让贪心提前消耗子会话靠后的同名候选，游标跳过去之后中间的内容全部对不上
 * （实测：父 tag 命中 830、落在游标之后 8416）。改为 patience diff 的思路：
 *
 *   1. 两边各只出现一次的内容作为**锚点**直接配对，再取其中保持顺序的最长子序列；
 *   2. 相邻锚点之间的小区间内按顺序贪心匹配，重复的样板只在区间内消费，
 *      父会话多出来的份数自然落空。
 *
 * 最后用子会话侧的命中率把关：首个与末个命中之间，同类候选至少 90% 被命中。
 */
function align(parentTags: readonly ParentTag[], candidates: readonly ChildCandidate[]): {
    matches: Match[];
    droppedUnmatched: number;
    distrust: string | null;
} {
    const matches: Match[] = [];
    const stats = { parentMatched: 0, parentAbsent: 0 };
    let droppedUnmatched = 0;

    for (const kind of ["text", "tool", "file"] as const) {
        const parents = parentTags.filter((parent) => parent.kind === kind);
        const childIndexes: number[] = [];
        candidates.forEach((candidate, index) => {
            if (candidate.kind === kind && candidate.key !== null) childIndexes.push(index);
        });
        const childKeys = childIndexes.map((index) => candidates[index]!.key!);
        const parentKeys = parents.map((parent) => parent.key ?? "");

        const countBy = (keys: readonly string[]): Map<string, number> => {
            const counts = new Map<string, number>();
            for (const key of keys) if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
            return counts;
        };
        const parentCounts = countBy(parentKeys);
        const childCounts = countBy(childKeys);

        // 1. 锚点：两边都唯一的 key。按父序遍历，子侧下标用 patience sorting 取最长递增子序列。
        const rawAnchors: Array<{ parentIndex: number; childIndex: number }> = [];
        const childIndexOfUnique = new Map<string, number>();
        childKeys.forEach((key, index) => {
            if (key && childCounts.get(key) === 1) childIndexOfUnique.set(key, index);
        });
        parents.forEach((parent, parentIndex) => {
            const key = parent.key;
            if (key === null || parentCounts.get(key) !== 1) return;
            const childIndex = childIndexOfUnique.get(key);
            if (childIndex !== undefined) rawAnchors.push({ parentIndex, childIndex });
        });
        const tails: number[] = [];
        const tailsAnchor: number[] = [];
        const previous: number[] = [];
        for (let index = 0; index < rawAnchors.length; index += 1) {
            const childIndex = rawAnchors[index]!.childIndex;
            let low = 0;
            let high = tails.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (tails[middle]! < childIndex) low = middle + 1;
                else high = middle;
            }
            previous[index] = low > 0 ? tailsAnchor[low - 1]! : -1;
            tails[low] = childIndex;
            tailsAnchor[low] = index;
        }
        const anchors: Array<{ parentIndex: number; childIndex: number }> = [];
        for (
            let cursor = tailsAnchor.length > 0 ? tailsAnchor[tailsAnchor.length - 1]! : -1;
            cursor >= 0;
            cursor = previous[cursor]!
        ) {
            anchors.push(rawAnchors[cursor]!);
        }
        anchors.reverse();

        // 2. 锚点配对，并在相邻锚点的开区间内按顺序贪心。
        const parentMatched = new Set<number>();
        const childMatched = new Set<number>();
        const matchInInterval = (parentFrom: number, parentTo: number, childFrom: number, childTo: number) => {
            let cursor = childFrom;
            for (let parentIndex = parentFrom; parentIndex < parentTo; parentIndex += 1) {
                const key = parentKeys[parentIndex]!;
                if (!key) continue;
                let found = -1;
                for (let childIndex = cursor; childIndex < childTo; childIndex += 1) {
                    if (childKeys[childIndex] === key) {
                        found = childIndex;
                        break;
                    }
                }
                if (found < 0) continue;
                cursor = found + 1;
                parentMatched.add(parentIndex);
                childMatched.add(found);
                matches.push({ parent: parents[parentIndex]!, child: candidates[childIndexes[found]!]! });
            }
        };
        let previousParent = -1;
        let previousChild = -1;
        for (const anchor of anchors) {
            matchInInterval(previousParent + 1, anchor.parentIndex, previousChild + 1, anchor.childIndex);
            parentMatched.add(anchor.parentIndex);
            childMatched.add(anchor.childIndex);
            matches.push({
                parent: parents[anchor.parentIndex]!,
                child: candidates[childIndexes[anchor.childIndex]!]!,
            });
            previousParent = anchor.parentIndex;
            previousChild = anchor.childIndex;
        }
        matchInInterval(previousParent + 1, parents.length, previousChild + 1, childKeys.length);

        for (const [parentIndex, parent] of parents.entries()) {
            if (parentMatched.has(parentIndex)) continue;
            if (parent.key === null) continue;
            if (parentCounts.get(parent.key) === undefined) stats.parentAbsent += 1;
            if (parent.tag.status === "dropped") droppedUnmatched += 1;
        }
        stats.parentMatched += parentMatched.size;

        // 3. 子会话侧命中率。
        // childMatched 里是同类候选在 childKeys 里的序号；区间按这个序号算，不看全局下标。
        const hitPositions = [...childMatched].sort((x, y) => x - y);
        if (hitPositions.length < 2) continue;
        const first = hitPositions[0]!;
        const last = hitPositions[hitPositions.length - 1]!;
        const interior = last - first + 1;
        const hit = hitPositions.length;
        if (hit / interior < MIN_INTERIOR_MATCH_RATIO) {
            return {
                matches,
                droppedUnmatched,
                distrust: `${kind} interior hit ${hit}/${interior} of ${childKeys.length}; parent matched ${stats.parentMatched}, absent ${stats.parentAbsent}; anchors ${anchors.length}`,
            };
        }
    }
    return { matches, droppedUnmatched, distrust: null };
}

/**
 * 父会话裁前缀之后还留着多少条没裁。
 *
 * 父会话在自己的摘要边界处裁，边界之后的条目（占位符与未折叠的原文）照常发送。
 * 子会话要同形，就是照着留同样长的末端：`末端 = 父会话最大 tag 序号 − 摘要边界`
 * （真实会话验算：12868 − 12489 = 379，父会话实际发送 389 条）。
 *
 * 为什么不按 tag 上的 `mc<N>` 把边界逐条换算到子会话：长会话经历多次重启后前缀
 * 长度变过，tag 的序号混着不同时期的坐标系（实测父子序号差散成 71 / 43 / 89 / −4
 * 等若干簇），不存在可用的整体平移。
 *
 * 估算偏小的方向是危险的：父会话末端有少量没打标的条目（进行中的调用、空白 part），
 * 末端被低估就会多裁。所以调用方再减去一个固定的安全余量，宁可多发送、不多裁。
 * fork 点不在父会话末尾时这个估算只会让子会话裁得更少，同样是安全方向。
 */
function parentUntrimmedTailLength(
    parentCompartments: readonly { endMessage: number }[],
    parentTags: readonly TagEntry[],
): number | null {
    const parentEnd = Math.max(...parentCompartments.map((compartment) => compartment.endMessage));
    let maxOrdinal = 0;
    for (const tag of parentTags) {
        for (const id of [tag.messageId, tag.toolOwnerMessageId]) {
            if (id === null) continue;
            const parsed = /^mc(\d+)/.exec(id);
            if (parsed !== null) maxOrdinal = Math.max(maxOrdinal, Number(parsed[1]));
        }
    }
    const tail = maxOrdinal - parentEnd;
    return tail > 0 ? tail : null;
}

/** 末端估算的安全余量（条）：覆盖父会话末端没打标的条目，宁可多发送、不多裁。 */
const TRIM_TAIL_SAFETY_MARGIN = 100;

/**
 * 父会话未裁的末端短于这个数就不裁。末端很短时未裁的请求本来就小（折叠内容只剩占位符），
 * 而固定余量会盖过整个末端、把最近几轮也裁掉——那是最不能丢的部分。
 */
const MIN_TAIL_FOR_TRIM = 300;

/** 把 count 个舱压进 1..boundary 的连续区间。调用方保证 count ≤ boundary。 */
function compressRanges(count: number, boundary: number): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < count; index += 1) {
        const start = index === 0 ? 1 : ranges[index - 1]!.end + 1;
        const end = index === count - 1 ? boundary : Math.floor(((index + 1) * boundary) / count);
        ranges.push({ start, end });
    }
    return ranges;
}

interface InheritedTagRow {
    tag: TagEntry;
    messageId: string;
    ownerMessageId: string | null;
    /** 这一行折叠的是子会话的第几条消息（0 基）。 */
    messageIndex: number;
}

/**
 * 把父会话的折叠状态与摘要继承给 fork 子会话。不抛错；任何一步不可信都不写行。
 *
 * 调用方保证：子会话尚无任何 tag / compartment（首轮 transform 之前），且传入的
 * `childMessages` 就是本轮 transform 要用的投影。
 */
export function inheritForkedSessionState(
    input: InheritForkedSessionStateInput,
): InheritForkedSessionStateResult {
    const { db, parentSessionId, childSessionId, childMessages } = input;
    if (getTagsBySession(db, childSessionId).length > 0) {
        return { kind: "skipped", reason: "child-already-tagged" };
    }
    if (getCompartments(db, childSessionId).length > 0) {
        return { kind: "skipped", reason: "child-already-compartmentalized" };
    }

    const parentTagsRaw = getTagsBySession(db, parentSessionId);
    if (parentTagsRaw.length === 0) {
        return { kind: "skipped", reason: "parent-has-no-tags" };
    }
    const sources = getSourceContents(
        db,
        parentSessionId,
        parentTagsRaw.map((tag) => tag.tagNumber),
    );
    const parentToolOutputs = input.parentToolOutputs;
    const parentTags: ParentTag[] = parentTagsRaw.map((tag) => {
        // system 段受保护、永不折叠；`applyFlushedStatuses` 会把它改回 active，显式跳过。
        if (tag.messageRole === "system") return { tag, kind: "text", key: null };
        if (tag.type === "message") {
            const content = sources.get(tag.tagNumber);
            return {
                tag,
                kind: "text",
                key: content === undefined || isWhitespace(content) ? null : content,
            };
        }
        if (tag.type === "file") {
            const content = sources.get(tag.tagNumber);
            return { tag, kind: "file", key: content ? content : null };
        }
        const output = parentToolOutputs?.get(tag.messageId);
        return {
            tag,
            kind: "tool",
            key: output === undefined ? null : toolKey(output.toolName, output.output),
        };
    });

    const candidates = childCandidates(childMessages, parentToolOutputs !== undefined);
    const aligned = align(parentTags, candidates);
    if (aligned.distrust !== null) {
        return { kind: "skipped", reason: `alignment-not-trusted: ${aligned.distrust}` };
    }

    const rows: InheritedTagRow[] = [];
    for (const match of aligned.matches) {
        const { tag } = match.parent;
        if (tag.status !== "dropped") continue;
        const childMessage = childMessages[match.child.messageIndex]!;
        const messageId = childMessage.info.id;
        if (messageId === undefined) continue;
        if (tag.type === "tool") {
            const callId = partField(childMessage.parts[match.child.partIndex], "callID");
            if (typeof callId !== "string") continue;
            const owner = findToolOwner(childMessages, callId);
            if (owner === undefined) continue;
            rows.push({ tag, messageId: callId, ownerMessageId: owner, messageIndex: match.child.messageIndex });
            continue;
        }
        const suffix = match.child.kind === "file" ? `:file${match.child.partIndex}` : `:p${match.child.partIndex}`;
        rows.push({
            tag,
            messageId: `${messageId}${suffix}`,
            ownerMessageId: null,
            messageIndex: match.child.messageIndex,
        });
    }
    if (rows.length === 0) {
        return { kind: "skipped", reason: "nothing-to-inherit" };
    }

    const lastDroppedIndex = Math.max(...rows.map((row) => row.messageIndex));
    const boundaryOrdinal = lastDroppedIndex + 1;

    let compartments: CompartmentInput[] = [];
    let withheld: string | null = null;
    // 子会话是否像父会话一样裁前缀，以及裁在哪（子会话序号）。末端取「父会话摘要边界
    // 换算到子会话坐标」；换算不可信时不裁，折叠内容以占位符呈现。
    let trims = false;
    let boundaryChild = boundaryOrdinal;
    let trimDetail: string | undefined;
    const parentCompartments = getCompartments(db, parentSessionId);
    if (parentCompartments.length === 0) {
        withheld = "parent-has-no-compartments";
    } else {
        // 末端长度照搬父会话，再留安全余量：子会话从末尾数这么多条不裁，其余裁掉。
        const firstDroppedIndex = Math.min(...rows.map((row) => row.messageIndex));
        const tail = parentUntrimmedTailLength(parentCompartments, parentTagsRaw);
        const candidate =
            tail === null ? -1 : childMessages.length - tail - TRIM_TAIL_SAFETY_MARGIN;
        if (tail === null) {
            withheld = "parent-tail-unknown";
        } else if (tail < MIN_TAIL_FOR_TRIM) {
            withheld = `parent-tail-short:${tail}`;
        } else if (candidate <= firstDroppedIndex) {
            // 留下的末端必须短于「第一个折叠条目之后」的范围，否则裁剪没有意义或会裁到
            // 折叠范围之外（fork 点远离父会话末尾时会出现）。
            withheld = `parent-tail-covers-folded-range:tail ${tail}`;
        } else if (parentCompartments.length > candidate) {
            withheld = "more-compartments-than-covered-entries";
        } else {
            trims = true;
            boundaryChild = candidate;
            trimDetail = `parent tail ${tail} + margin ${TRIM_TAIL_SAFETY_MARGIN} of ${childMessages.length}`;
        }
    }
    const ranges = compressRanges(parentCompartments.length, boundaryChild);
    if (
        parentCompartments.length > 0 &&
        validateStoredCompartments(
            ranges.map((range) => ({ startMessage: range.start, endMessage: range.end })),
        ) !== null
    ) {
        withheld = "compartment-ranges-invalid";
        trims = false;
        boundaryChild = boundaryOrdinal;
    }
    compartments = parentCompartments.map((compartment, index) => {
        const last = index === parentCompartments.length - 1;
        return {
            sequence: index + 1,
            startMessage: ranges[index]!.start,
            endMessage: ranges[index]!.end,
            // 数值区间是压缩后的子会话序号：historian 的增量起点、连续性校验、heal、
            // unmanaged 判定都只读数值。
            //
            // 边界 id：只有末舱、且仅在允许裁前缀时写入子会话坐标 `mc<M>`。其余一律
            // 空串——空串是 schema 默认值，所有边界读者都把它当「无 id」；NULL 会让
            // `getCompartments` 的行守卫整行丢弃，不能用。
            startMessageId: "",
            endMessageId: last && trims ? `mc${boundaryChild}` : "",
            title: compartment.title,
            content: compartment.content,
            p1: compartment.p1,
            p2: compartment.p2,
            p3: compartment.p3,
            p4: compartment.p4,
            importance: compartment.importance,
            episodeType: compartment.episodeType,
        };
    });

    db.transaction(() => {
        for (const row of rows) {
            const { tag } = row;
            insertTag(
                db,
                childSessionId,
                row.messageId,
                tag.type,
                tag.byteSize,
                tag.tagNumber,
                tag.reasoningByteSize,
                tag.toolName,
                tag.inputByteSize,
                row.ownerMessageId,
            );
            updateTagStatus(db, childSessionId, tag.tagNumber, "dropped");
            if (tag.dropMode !== "full") {
                updateTagDropMode(db, childSessionId, tag.tagNumber, tag.dropMode);
            }
            stampTagMessageRole(db, childSessionId, tag.tagNumber, tag.messageRole ?? null);
            // 父会话的原文一并带过来。子会话裁前缀之后，被裁掉的条目不会进入它的
            // 打标流程，也就不会有 source_contents；不带的话这些 tag 日后 ctx_expand
            // 取不回原文。tag 编号父子一致，直接按编号搬。
            if (tag.type !== "tool") {
                const content = sources.get(tag.tagNumber);
                if (content !== undefined) saveSourceContent(db, childSessionId, tag.tagNumber, content);
            }
        }
        appendCompartmentsInTransaction(db, childSessionId, compartments);
    }).immediate();

    if (compartments.length === 0) {
        return { kind: "tags-only", tags: rows.length, reason: withheld ?? "parent-has-no-compartments" };
    }
    return {
        kind: "inherited",
        tags: rows.length,
        compartments: compartments.length,
        boundaryOrdinal: boundaryChild,
        trims,
        ...(trims ? { trimDetail } : { reason: withheld ?? undefined }),
    };
}
