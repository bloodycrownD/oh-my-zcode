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

/** FORK copy of `core/src/agent/message-history.ts:59-64`. */
export interface ZCodeRuntimeAttachmentEntry {
  kind: "attachment";
  content: string;
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
    output?: string;
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

/** Tool result part for a `role: "tool"` entry (OpenCode's tool-result shape). */
function toolResultToPart(message: ZCodeModelInputMessage): ToolLikePart | null {
  if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) return null;
  const output =
    typeof message.content === "string" ? message.content : contentText(message.content);
  const part: ToolLikePart = {
    type: "tool",
    callID: message.toolCallId,
    tool: message.toolName ?? "",
    state: {
      status: message.isError === true ? "error" : "completed",
      output,
      ...(message.isError === true ? { error: output } : {}),
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
      parts: [{ type: "text", text: entry.content, synthetic: true }],
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
  if (isRuntimeAttachmentEntry(original)) return message.parts.length === 1;
  if (!isRuntimeMessageEntry(original)) return false;
  const role = message.info.role;
  // A `role: "tool"` entry projects onto a `user`-role message (OpenCode's
  // tool-result shape); that flip alone is not a change the transform made.
  const expectedRole = original.message.role === "tool" ? "user" : original.message.role;
  if (role !== expectedRole) return false;
  if (original.message.toolCalls && original.message.toolCalls.length > 0) return false;
  return true;
}
