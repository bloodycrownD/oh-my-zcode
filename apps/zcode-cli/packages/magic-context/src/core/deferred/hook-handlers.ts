// FORK-NOT-PORTED: `hooks/magic-context/hook-handlers.ts` 的 LiveModelBySession / LatestAssistantMessageIdBySession / VariantBySession / AgentBySession 类型摘录，Step 21 决定移植或删除后重写本文件
//
// WHY NOT PORTED. `hook-handlers.ts` is the OpenCode plugin event surface:
// `chat.message`, `message.updated`, `session.idle`, `permission.ask`, the
// tool-definition and tool-execute hooks, plus the process-local `*Sessions`
// cache-busting signal maps. ZCode's event wiring is the host adapter's job
// (`src/host/`), not this seam's.
//
// What the B group reaches is four TYPE ALIASES for the process-local maps
// `live-session-state.ts` declares — nothing constructs one here, and nothing in
// the fork writes to them (the transform reads `deps.liveModelBySession?.get(...)`
// only). All four are one-line `Map` aliases with no imports, so they are
// reproduced verbatim rather than inlined, so `live-session-state.ts`'s
// `LiveSessionState` interface keeps the exact upstream member types.
//
// Step 21: delete this file and repoint `live-session-state.ts` and
// `transform.ts` back at `./hook-handlers.js`, or — if the ZCode host supplies
// its own event wiring — delete the type imports and declare the four aliases in
// `live-session-state.ts`.

/** Verbatim: `hook-handlers.ts:67`. */
export type LiveModelBySession = Map<string, { providerID: string; modelID: string }>;

/** Verbatim: `hook-handlers.ts:68`. */
export type LatestAssistantMessageIdBySession = Map<string, string>;

/** Verbatim: `hook-handlers.ts:69`. */
export type VariantBySession = Map<string, string | undefined>;

/** Verbatim: `hook-handlers.ts:70`. */
export type AgentBySession = Map<string, string>;