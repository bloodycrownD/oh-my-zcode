/**
 * Step 17 — host adapter types: ZCode ↔ magic-context message conversion.
 *
 * Two structural vocabularies meet here, and neither side may be modified:
 *
 *   1. magic-context's *consumed* message shape — `{ info, parts }`, spelled
 *      `MessageLike`. Every B/C-group module (tag-messages, transform,
 *      inject-compartments, historian) is written against it. Upstream it came
 *      from `@opencode-ai/sdk`'s `Message` + `Part[]` pair; this fork has no
 *      OpenCode SDK, so the shape is declared here structurally.
 *   2. ZCode's *produced* entry shape — `RuntimeMessageEntry` from
 *      `core/src/agent/message-history.ts`, borrowed zero-copy from
 *      `MessageHistory.borrowReadOnlyRuntimeEntries()`.
 *
 * The gap between them is NOT cosmetic and every rule below is load-bearing:
 *
 *   - ZCode runtime entries carry **no id and no timestamp**. `MessageLike.info.id`
 *     is load-bearing (tag anchors, LKG entry identity, ordinal-by-id lookups), so
 *     the projection synthesizes a stable ordinal-derived id per pass.
 *   - ZCode carries a tool **invocation** on the assistant message
 *     (`message.toolCalls`) and its **result** as a separate `role: "tool"`
 *     entry. magic-context (and OpenCode) carry both on ONE tool part whose
 *     `state.status` moves pending → running → completed/error. The projection
 *     therefore emits a `running` tool part for the invocation and a `user`-role
 *     message carrying a `completed`/`error` tool part for the result, which is
 *     exactly the shape OpenCode's provider serializer produces.
 *   - ZCode attachments (`kind: "attachment"`) are request-time system-reminder
 *     fragments with no message role of their own; they project as synthetic
 *     `user` messages carrying one synthetic text part.
 *
 * FORK (structural contract, S19b): every ZCode type below is a LOCAL structural
 * copy — this package never imports `@zcode/contracts` or `@zcode/core`, so it
 * stays importable from tests, from the migration worker, and from any host
 * without dragging the ZCode package graph in. The copies MUST stay
 * structurally compatible with:
 *   - `core/src/agent/message-history.ts:26-66`  (ModelInputMessage, RuntimeMessageEntry)
 *   - `contracts/src/model/index.ts:335-407`      (ModelToolCall, ModelMessageContent*)
 *   - `contracts/src/interfaces/session-store.port.ts:346-418` (persisted MessageInfo)
 * S19b wiring re-checks that compatibility by assigning the real types to these
 * shapes (a structural assignability check); if a ZCode field is added to
 * `RuntimeMessageEntry`, add it here in the same commit.
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. magic-context's consumed message shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FORK structural copy of `hooks/magic-context/tag-messages.ts:236-245`
 * (`MessageInfo`). Field-for-field, comments included; `time` is ADDED — it is
 * absent upstream because OpenCode's `Message` carries it, and this fork's
 * ZCode projection has to supply it (see `lkg-replay.ts:131-142`, which reads
 * `info.time.created` off the wider real type).
 */
export type MessageInfo = {
  id?: string;
  role?: string;
  sessionID?: string;
  summary?: boolean;
  /** Marks one of the two m[0]/m[1] messages prepended by compartment injection. */
  syntheticHead?: boolean;
  finish?: string;
  error?: unknown;
  /** FORK: read by `lkg-replay` for the entry's wall-clock stamp. */
  time?: { created?: number; completed?: number };
};

/**
 * FORK structural copy of `hooks/magic-context/tag-messages.ts:253`.
 * `{ info, parts }` is the exact shape the spec's architecture note calls
 * "适配层转 MessageLike"; `parts` stays `unknown[]` because tag/drop code
 * narrows with its own guards (`tag-part-guards.ts`) rather than a closed union.
 */
export type MessageLike = { info: MessageInfo; parts: unknown[] };

/**
 * FORK structural copy of `hooks/magic-context/tag-messages.ts:247-251`. The
 * reasoning-part shape the transform strips and the tag map re-attaches.
 */
export interface ThinkingLikePart {
  type: string;
  thinking?: string;
  text?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. raw-session message shape (the historian / chunk reader's input)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FORK structural copy of `hooks/magic-context/read-session-raw.ts:3-11`.
 * Step 17 lands this copy BEFORE the B group ports `read-session-raw.ts` into
 * `core/`, because `raw-message-provider.ts` needs the types to declare its
 * provider. B-group owns the canonical definitions; when they land, switch the
 * imports here to the core module (structurally identical, so nothing else
 * moves).
 */
export interface RawMessageParts {
  id: string;
  role: string;
  parts: unknown[];
  createdAt?: number | null;
  version?: string | number | null;
  /** Native store row type when the host exposes one; intentionally absent on v1. */
  storeType?: string;
}

/** FORK structural copy of `read-session-raw.ts:13-15`. */
export interface RawMessage extends RawMessageParts {
  ordinal: number;
}

/** FORK structural copy of `read-session-raw.ts:40-43` — the pagination cursor. */
export interface RawMessageOrdinalAnchor {
  timeCreated: number;
  id: string;
}

/** FORK structural copy of `read-session-raw.ts:45-48`. */
export interface RawMessageOrdinalEntry extends RawMessageOrdinalAnchor {
  contributesOrdinal: boolean;
  hasValidInfo: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ZCode runtime entry shape (structural copies — see the FORK block above)
// ─────────────────────────────────────────────────────────────────────────────

/** FORK copy of `contracts/src/model/index.ts:366-397` (image/video/file/resource). */
export interface ZCodeOpaqueContentBlock {
  type: "image" | "video" | "file" | "resource_link" | (string & {});
  [key: string]: unknown;
}

/** FORK copy of `contracts/src/model/index.ts:352-364` + `399-407`. */
export type ZCodeModelMessageContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; providerOptions?: Record<string, unknown> }
  | ZCodeOpaqueContentBlock;

/** FORK copy of `contracts/src/model/index.ts:335-340`. */
export interface ZCodeModelToolCall {
  id: string;
  name: string;
  input: unknown;
  providerExecuted?: boolean;
}

/** FORK copy of `core/src/agent/message-history.ts:26-36`. */
export interface ZCodeModelInputMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | readonly ZCodeModelMessageContentBlock[];
  cacheControl?: { type: "ephemeral"; ttl?: "5m" | "1h"; scope?: "global" | "org" };
  toolCalls?: readonly ZCodeModelToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  providerId?: string;
  modelId?: string;
}

/** FORK copy of `core/src/agent/message-history.ts:44-47` (values kept opaque). */
export interface ZCodeRuntimeMessageMetadata {
  source?: string;
  inputPresentation?: string;
}

/** FORK copy of `core/src/agent/message-history.ts:49-57`. */
export interface ZCodeRuntimeMessageEntry {
  kind?: "message";
  message: ZCodeModelInputMessage;
  metadata?: ZCodeRuntimeMessageMetadata;
  /** Committed provider tokens; never sent to the provider. */
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  /** Valid only inside the current query; must not reach persistence. */
  queryScope?: "output_token_continuation";
}

/**
 * FORK copy of `core/src/agent/message-history.ts:59-77` — with the Step 15
 * (bugfix-batch-20261011 / D5) `mediaBlocks` extension mirrored 1:1: attachments
 * carry provider-neutral media blocks (the mural PNG the m0 path renders) next
 * to their text. Same rules as core: optional, request-scoped, never persisted.
 */
export interface ZCodeRuntimeAttachmentEntry {
  kind: "attachment";
  content: string;
  mediaBlocks?: readonly ZCodeModelMessageContentBlock[];
  cacheControl?: { type: "ephemeral"; ttl?: "5m" | "1h"; scope?: "global" | "org" };
  metadata: ZCodeRuntimeMessageMetadata;
}

/** FORK copy of `core/src/agent/message-history.ts:66`. */
export type ZCodeRuntimeEntry = ZCodeRuntimeMessageEntry | ZCodeRuntimeAttachmentEntry;

// ─────────────────────────────────────────────────────────────────────────────
// 4. conversion
// ─────────────────────────────────────────────────────────────────────────────

/** Inputs the projection cannot recover from the entry itself. */
export interface RuntimeProjectionOptions {
  /** Carried onto `info.sessionID`; helps session-scoped consumers stay honest. */
  sessionId?: string;
  /** id prefix for synthesized ids. Must be unique per projection pass. */
  idPrefix?: string;
  /** First synthesized ordinal. Defaults to 1. */
  startOrdinal?: number;
  /**
   * Monotonic clock seed for `info.time.created`. Runtime entries carry no
   * timestamp; without a seed `info.time` is left off entirely (LKG then reads
   * `timeCreated`/`createdAt`, also absent, and stores `null`).
   */
  createdAt?: number;
}

const DEFAULT_ID_PREFIX = "mc";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `true` for the `kind: "attachment"` variant (`message-history.ts:476-480`). */
export function isRuntimeAttachmentEntry(
  entry: ZCodeRuntimeEntry,
): entry is ZCodeRuntimeAttachmentEntry {
  return isRecord(entry) && (entry as { kind?: unknown }).kind === "attachment";
}

/** Narrow to the message variant; mirrors `isRuntimeMessageEntry` upstream. */
export function isRuntimeMessageEntry(entry: ZCodeRuntimeEntry): entry is ZCodeRuntimeMessageEntry {
  return isRecord(entry) && "message" in entry && isRecord(entry.message);
}

/**
 * Synchronous SHALLOW snapshot of a borrowed entries array.
 *
 * `MessageHistory.borrowReadOnlyRuntimeEntries()` hands back the live internal
 * array ("借用当前权威 entries，只允许同步只读；跨异步边界时由调用方做数组浅快照").
 * Copying the ARRAY synchronously — and only the array, never the nested entries
 * — is exactly the contract the core comment states, and it is what
 * `raw-message-provider.ts` does before any conversion so a later `await`
 * cannot observe a reordered or shortened history.
 */
export function snapshotRuntimeEntries(entries: readonly ZCodeRuntimeEntry[]): ZCodeRuntimeEntry[] {
  return entries.slice();
}

/** A tool part in the shape `tag-part-guards.ts:27-33` and the drop code expect. */
export interface ToolLikePart {
  type: "tool";
  callID: string;
  tool: string;
  declarationIndex?: number;
  providerExecuted?: boolean;
  state: {
    status: "pending" | "running" | "completed" | "error";
    input?: unknown;
    /**
     * FORK（toolsearch / native tool references，偏离上游）：上游 magic-context
     * 把 `state.output` 当作纯字符串（OpenCode 的 tool part 就是这么序列化的），
     * 本 fork 的 `role:"tool"` 条目却可能是**块数组**。历史上这里经 `contentText`
     * 一律文本化，于是 `{type:"tool_reference", toolName}` 块（没有 text/content
     * 字段）被压成空串——native ToolSearch 的引用在 MC pass 后必失
     * （docs/iterations/upstream-v316-fullsync/toolsearch-seam-proof.md §3.3）。
     *
     * 因此：块数组里**存在 tool_reference** 时，`output` 保留原块数组（浅拷贝，
     * 顺序不变），不再文本化；其余任何输入仍走 `contentText`，字符串输出逐字节
     * 不变。这与 adapters 侧的同款保护对齐
     * （`packages/adapters/src/model/transform.ts:174-192`：只要块数组含
     * tool_reference 就跳过文本化）。
     *
     * 包内按 `typeof output === "string"` 判断「结果可打标/可 drop」的地方会
     * **有意**跳过这类 part——这不是遗漏，而是 fork 的绕过策略：块数组结果对
     * Magic Context 整体不透明（opaque）。
     *
     *   - 打标：`tag-part-guards.ts` 的 `isToolPartWithOutput` 只认字符串
     *     （改它之前先读该函数的注释：下游 byteSize/stripTagPrefix/prependTag
     *     全是字符串面，放宽会在打标点写坏块数组）；
     *   - 治理：`tool-drop-target.ts` 的 `entryHasStructuredOutput` 把整条 tool
     *     弧标记为 `structuredOutputOpaque`，drop / skeleton / edit_marker
     *     全部返回 `"bypassed"`、`canDrop()` 为 false、tool target 不提供 `setContent`；
     *     `apply-operations.ts` 对真实 pending op 只排空队列，不落 drop 状态。
     *
     * 为什么必须绕过而不是「度量后 clamp」：`tool_reference` 块没有 text/content
     * 字段，任何字符串写回（哪怕只是 `[dropped §N§]`）都等于删除引用，native
     * ToolSearch 的定义随后无法在服务端展开；这类结果本身很小，压缩它没有收益。
     * 唯一写回点是宿主本侧反投影
     * （`apps/zcode-cli/packages/bootstrap/src/app/magic-context/projection.ts` 的
     * `toolOutputOf` / `toolOutputContentOf`），它按原序把块数组写回
     * `role:"tool"` entry。需要字符串的下游（read-session-formatting /
     * tail-hygiene / ctx-expand / final-wire-token-estimate）已有 non-string
     * 兜底（JSON.stringify 或忽略）。
     *
     * 升级 magic-context 时**必须 rebase 本改动**：上游若把 tool part 的 output
     * 改成别的承载形状或引入结构化 output，上面的「块数组 = 绕过」不变量与
     * `toolResultToPart` 的结构保留逻辑要一起迁移；若改为治理，则必须同时
     * 实现块感知的度量与反投影写回，不能退化成字符串哨兵。
     */
    output?: string | readonly ZCodeModelMessageContentBlock[];
    error?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
}

function contentBlocks(content: ZCodeModelInputMessage["content"]): readonly unknown[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** Flatten ZCode content blocks into magic-context parts, preserving order. */
function contentToParts(content: ZCodeModelInputMessage["content"]): unknown[] {
  const parts: unknown[] = [];
  for (const block of contentBlocks(content)) {
    if (!isRecord(block)) continue;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    if (type === "reasoning" && typeof block.text === "string") {
      parts.push({
        type: "reasoning",
        text: block.text,
        ...(isRecord(block.providerOptions) ? { providerOptions: block.providerOptions } : {}),
      });
      continue;
    }
    // image / video / file / resource_link / anything a newer ZCode adds: passed
    // through untouched. magic-context narrows by `type`, so an unknown part is
    // inert rather than lossy.
    parts.push({ ...block });
  }
  return parts;
}

/** Tool invocation parts for an assistant entry's declared calls. */
function toolCallsToParts(toolCalls: readonly ZCodeModelToolCall[] | undefined): unknown[] {
  if (!toolCalls) return [];
  return toolCalls.map((call, index) => {
    const part: ToolLikePart = {
      type: "tool",
      callID: call.id,
      tool: call.name,
      // FORK: ZCode has no declarationIndex on runtime calls; the persisted
      // ToolPart does (`contracts/.../session-store.port.ts:755`). Mirroring it
      // lets the same code read both sources.
      declarationIndex: index,
      state: { status: "running", input: call.input },
    };
    if (call.providerExecuted === true) part.providerExecuted = true;
    return part;
  });
}

/**
 * `true` for a block that is a native tool-search reference
 * (`{ type: "tool_reference", toolName }`, see `contracts/src/tools/tool-search.ts`).
 *
 * FORK（toolsearch）：块数组里只要出现这种块，就**不能**把整个结果文本化——
 * 它没有 text/content 字段，`contentText` 会把它静默压没，native 模式下
 * Anthropic 服务端因此无法展开已发现的工具定义。
 */
function isToolReferenceBlock(block: unknown): boolean {
  return isRecord(block) && block.type === "tool_reference";
}

/**
 * Tool result part for a `role: "tool"` entry (OpenCode's tool-result shape).
 *
 * FORK（toolsearch / native tool references）：块数组含 `tool_reference` 时，
 * `state.output` 保留块数组（逐块浅拷贝，顺序与内容不变），不再走 `contentText`。
 * 其余输入（字符串、纯文本块数组、媒体块数组、不含 tool_reference 的错误结果）
 * 行为与改动前逐字节相同；没有 ToolSearch 时永远不会出现 `tool_reference`，
 * 因此 mode off 零差异。与 adapters `transform.ts:174-192` 的保护同构。
 *
 * 保留成块数组即意味着该 arc 对 MC 不透明：它仍按闭合结果参与 pairing
 * （`partHasCompletedResult`），但打标/治理侧整体绕过（见 `ToolLikePart.state.output`
 * 的注释），写回只发生在宿主反投影的 `toolOutputOf`。
 * 升级 magic-context 时 rebase。
 */
function toolResultToPart(message: ZCodeModelInputMessage): ToolLikePart | null {
  if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) return null;
  const output: string | readonly ZCodeModelMessageContentBlock[] =
    typeof message.content === "string"
      ? message.content
      : message.content.some(isToolReferenceBlock)
        ? message.content.map((block) => ({ ...block }))
        : contentText(message.content);
  const part: ToolLikePart = {
    type: "tool",
    callID: message.toolCallId,
    tool: message.toolName ?? "",
    state: {
      status: message.isError === true ? "error" : "completed",
      output,
      // 结构化输出（引用块）没有可复制的错误文本；error 仍只承载字符串结果，
      // 与改动前的类型和 wire 语义一致。状态本身已由 `status: "error"` 表达。
      ...(message.isError === true && typeof output === "string" ? { error: output } : {}),
    },
  };
  return part;
}

function contentText(content: ZCodeModelInputMessage["content"]): string {
  const chunks: string[] = [];
  for (const block of contentBlocks(content)) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") chunks.push(block.text);
    else if (typeof block.content === "string") chunks.push(block.content);
    else if (typeof block.text === "string") chunks.push(block.text);
  }
  return chunks.join("\n\n");
}

/**
 * Project ONE ZCode runtime entry onto `MessageLike`.
 *
 * Exported for the tests and for `raw-message-provider.ts`, which needs the
 * per-entry mapping with the ordinal it assigned. `ordinal` is 1-based and is
 * the ONLY identity a runtime entry has.
 */
export function projectRuntimeEntry(
  entry: ZCodeRuntimeEntry,
  ordinal: number,
  options: RuntimeProjectionOptions = {},
): MessageLike {
  const id = `${options.idPrefix ?? DEFAULT_ID_PREFIX}${ordinal}`;
  const time = options.createdAt === undefined ? {} : { created: options.createdAt };

  if (isRuntimeAttachmentEntry(entry)) {
    return {
      info: {
        id,
        role: "user",
        syntheticHead: true,
        ...(options.sessionId === undefined ? {} : { sessionID: options.sessionId }),
        ...(Object.keys(time).length === 0 ? {} : { time }),
      },
      // FORK: ZCode attachments are request-time system-reminder fragments. They
      // reach magic-context as synthetic text so the tag/drop machinery can see
      // and drop them like any other injected prose; `synthetic` mirrors OpenCode's
      // marker for "the host put this here, the user did not".
      //
      // FORK（Step 15 / D5）：`mediaBlocks`（mural PNG 等图片块）随附件一起投影为
      // synthetic part，正反投影对称——没有这一步，宿主侧已经渲染好的壁画会在
      // 正投影里被静默丢掉，transform 看到的就只剩文本。块按原样透传
      // （包内按 `type` 收窄，未知 type 惰性忽略），与 content blocks 的既有
      // 透传语义一致。
      parts: [
        { type: "text", text: entry.content, synthetic: true },
        ...(entry.mediaBlocks ?? []).map((block) => ({ ...block, synthetic: true })),
      ],
    };
  }

  if (!isRuntimeMessageEntry(entry)) {
    return { info: { id, role: "unknown" }, parts: [] };
  }

  const message = entry.message;
  const base = {
    id,
    ...(options.sessionId === undefined ? {} : { sessionID: options.sessionId }),
    ...(Object.keys(time).length === 0 ? {} : { time }),
  };

  if (message.role === "tool") {
    const resultPart = toolResultToPart(message);
    return {
      info: { ...base, role: "user" },
      parts: resultPart ? [resultPart] : contentToParts(message.content),
    };
  }

  return {
    info: { ...base, role: message.role },
    parts: [...contentToParts(message.content), ...toolCallsToParts(message.toolCalls)],
  };
}

/**
 * Project a whole borrowed runtime-entry array onto `MessageLike[]`.
 *
 * Ordinals are 1-based and dense. A `createdAt` seed, when supplied, advances
 * by 1 ms per entry so `info.time.created` is strictly increasing and stable —
 * LKG digests and `## start-end · date` headings depend on determinism, not on
 * wall-clock truth (runtime entries have no timestamps at all).
 */
export function projectRuntimeEntries(
  entries: readonly ZCodeRuntimeEntry[],
  options: RuntimeProjectionOptions = {},
): MessageLike[] {
  const snapshot = snapshotRuntimeEntries(entries);
  const startOrdinal = Number.isFinite(options.startOrdinal)
    ? Math.floor(options.startOrdinal as number)
    : 1;
  const seed = options.createdAt;
  return snapshot.map((entry, index) =>
    projectRuntimeEntry(entry, startOrdinal + index, {
      ...options,
      ...(seed === undefined ? {} : { createdAt: seed + index }),
    }),
  );
}

/**
 * Project a PERSISTED ZCode store row (`message.data` + ordered `part.data`)
 * onto `MessageLike`, and back onto `RawMessage`.
 *
 * The persisted store needs no reshaping: the real `db.sqlite` keeps the
 * OpenCode-shaped `{type,text}` / `{type,tool,callID,tool,state}` parts on the
 * assistant row itself, so the persisted path passes the decoded parts through
 * untouched. `sessionId` fills `info.sessionID`, `id` is the REAL persisted id.
 */
export function projectStoredMessage(args: {
  id: string;
  role: string;
  parts: readonly unknown[];
  sessionId?: string;
  createdAt?: number | null;
  completedAt?: number | null;
  summary?: boolean;
  finish?: string;
  error?: unknown;
}): MessageLike {
  const time: { created?: number; completed?: number } = {};
  if (typeof args.createdAt === "number") time.created = args.createdAt;
  if (typeof args.completedAt === "number") time.completed = args.completedAt;
  return {
    info: {
      id: args.id,
      role: args.role,
      ...(args.sessionId === undefined ? {} : { sessionID: args.sessionId }),
      ...(args.summary === undefined ? {} : { summary: args.summary }),
      ...(args.finish === undefined ? {} : { finish: args.finish }),
      ...(args.error === undefined ? {} : { error: args.error }),
      ...(Object.keys(time).length === 0 ? {} : { time }),
    },
    parts: [...args.parts],
  };
}

/** `MessageLike` → `RawMessage` for the provider's borrow-backed reads. */
export function messageLikeToRawMessage(
  message: MessageLike,
  ordinal: number,
  idOverride?: string,
): RawMessage {
  const createdAt =
    typeof message.info.time?.created === "number" ? message.info.time.created : null;
  const id = idOverride ?? message.info.id ?? `${DEFAULT_ID_PREFIX}${ordinal}`;
  const raw: RawMessage = {
    ordinal,
    id,
    role: message.info.role ?? "unknown",
    parts: message.parts,
    createdAt,
  };
  const completedAt = message.info.time?.completed;
  if (typeof completedAt === "number") raw.version = completedAt;
  return raw;
}

/**
 * Whether a projected message still matches the entry it came from, i.e. the
 * transform left it alone. Step 18/19b uses this to decide whether a message may
 * reuse the ORIGINAL host entry object (byte-identical replay) or must be
 * rebuilt from the projected parts.
 */
export function projectMessageUnchanged(
  message: MessageLike,
  original: ZCodeRuntimeEntry,
): boolean {
  // FORK（Step 15 / D5）：attachment 的正投影现在是「1 个 text part +
  // 每条 mediaBlock 一个 synthetic part」。判定随之从「parts.length === 1」改为
  // 「恰好一个 text part 且其余都是随附件透传的 media part」——否则宿主侧渲染过
  // 壁画的附件每次 pass 都会被误判成「transform 改过它」，白白重建条目。
  if (isRuntimeAttachmentEntry(original)) {
    const expectedMediaCount = original.mediaBlocks?.length ?? 0;
    if (message.parts.length !== 1 + expectedMediaCount) return false;
    const head = message.parts[0];
    if (!isRecord(head) || head.type !== "text") return false;
    // 其余 part 必须是随附件透传的 media part（绝不能又是 text——那说明
    // transform 往附件里追加了文本，条目已被改写）。
    return message.parts.every(
      (part, index) => index === 0 || !isRecord(part) || part.type !== "text",
    );
  }
  if (!isRuntimeMessageEntry(original)) return false;
  const role = message.info.role;
  // A `role: "tool"` entry projects onto a `user`-role message (OpenCode's
  // tool-result shape); that flip alone is not a change the transform made.
  const expectedRole = original.message.role === "tool" ? "user" : original.message.role;
  if (role !== expectedRole) return false;
  if (original.message.toolCalls && original.message.toolCalls.length > 0) return false;
  return true;
}
