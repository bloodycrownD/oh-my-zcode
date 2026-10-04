/**
 * Deferred seam — `hooks/magic-context/tool-sweep-policy.ts` (upstream).
 *
 * The upstream module is part of the B group (transform core): its remaining
 * exports pull `lkg-slot`, `tag-messages`, `tool-drop-target` and the whole
 * read-session chain, which Step 18 ports. Only the two declarations the A
 * group's `storage-clone.ts` needs are reproduced here, verbatim, so the
 * reasoning-replay ledger filter behaves identically.
 *
 * Step 18: delete this file and point `storage-clone.ts` back at
 * `../../hooks/magic-context/tool-sweep-policy.js`.
 */

import { THINKING_BINDING_STRIP_ORDER_END_MARKER } from "../features/magic-context/storage-meta-persisted.js";

// This reserved non-message ID shares the session-owned reasoning replay ledger.
// Older readers ignore unknown entries, so no schema migration is necessary.
export const TOOL_SWEEP_SCOPED_MARKER = "@tool-sweep-scoped";

/**
 * Ledger entries that are session-wide control flags rather than message ids.
 * The reasoning replay ledger is a plain set of strings, so every consumer that
 * filters it by message identity (session clone, in particular) has to copy
 * these through verbatim instead of discarding them as undecodable ids.
 */
export const RESERVED_LEDGER_CONTROL_ENTRIES: readonly string[] = [
    TOOL_SWEEP_SCOPED_MARKER,
    THINKING_BINDING_STRIP_ORDER_END_MARKER,
];

export function isReservedLedgerControlEntry(entry: string): boolean {
    return RESERVED_LEDGER_CONTROL_ENTRIES.includes(entry);
}
