import type { TagEntry } from "../../features/magic-context/types.js";
import { stripSystemInjection } from "./system-injection-stripper.js";
import { stripTagPrefix } from "./tag-part-guards.js";
import type { TagTarget } from "./tag-messages.js";

/**
 * Re-apply the system-injection strip on EVERY transform pass, so the wire never
 * carries a `<system-reminder>` block that `applyHeuristicCleanup` would have
 * removed on a routine pass.
 *
 * Why this exists (FORK: source 恒 pristine):
 * `source_contents` must only ever hold the host's pristine message text —
 * `caveman-cleanup.ts` relies on that ("compression always starts from the
 * pristine original") and `tag-messages` relies on it to tell a `rewind`
 * (position now points at a different message ⇒ persisted source no longer
 * matches the inbound text) from a same-message rewrite. `applyHeuristicCleanup`
 * used to write the stripped text back into `source_contents`, which violated
 * both contracts; it now leaves `source_contents` alone and the strip is
 * replayed here instead.
 *
 * Idempotent: `stripSystemInjection` returns `null` once the markers are gone,
 * so on a routine pass (where the heuristic already stripped) this is a no-op.
 *
 * Whole-message injections are deliberately NOT dropped here: dropping requires
 * `updateTagStatus` + the `[dropped §N§]` placeholder contract, which only the
 * routine heuristic owns. We leave the pass untouched and let the next routine
 * pass drop it, so this walk can never emit an empty text block or a bare tag.
 */
export function replaySystemInjectionStrips(
    targets: Map<number, TagTarget>,
    tags: TagEntry[],
    protectedCutoff: number | null,
): number {
    let replayed = 0;
    for (const tag of tags) {
        if (tag.type !== "message" || tag.status !== "active") continue;
        if (tag.messageRole === "system") continue;
        if (protectedCutoff !== null && tag.tagNumber >= protectedCutoff) continue;

        const target = targets.get(tag.tagNumber);
        if (!target) continue;
        // Same defensive exemption as the heuristic: `messageRole` may be NULL on
        // rows written by older versions, so also consult the live message.
        if (target.message?.info.role === "system") continue;

        const content = target.getContent?.();
        if (!content) continue;

        const stripped = stripSystemInjection(content);
        if (stripped === null) continue;
        if (stripTagPrefix(stripped).trim().length === 0) continue;

        if (target.setContent?.(stripped, { keepReasoning: true })) replayed += 1;
    }
    return replayed;
}
