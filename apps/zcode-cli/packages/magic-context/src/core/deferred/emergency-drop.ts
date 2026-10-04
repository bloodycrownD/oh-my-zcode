/**
 * Deferred seam — `hooks/magic-context/emergency-drop.ts` (upstream).
 *
 * Emergency tool-output drop is B group (Step 18). The A group's
 * `storage-tags.ts` only needs the pure tier classifier to order tool tags
 * deterministically, so the classifier and its two tool-name sets are
 * reproduced here verbatim. Everything else in the upstream module (selection,
 * reclaim arithmetic) stays unported.
 *
 * Step 18: delete this file and point `storage-tags.ts` back at
 * `../../hooks/magic-context/emergency-drop.js`.
 */

export type Tier = 1 | 2 | 3;

// Tier keys are matched against the normalized (lowercased, `mcp_`-stripped)
// tool name. Verified against the production tag corpus: stored `tool_name`
// values are bare (`read`, `edit`, `bash`, …) with no `mcp_` prefix; the strip
// is defensive insurance for environments that surface MCP-prefixed names.
const T1_TOOLS = new Set(["read", "todowrite", "task", "aft_outline", "aft_zoom"]);
const T2_TOOLS = new Set(["edit", "write", "apply_patch", "grep", "glob", "aft_search"]);

/** Normalize a stored tool name for tier matching. */
function normalizeToolName(toolName: string | null): string {
    if (!toolName) return "";
    let name = toolName.toLowerCase();
    if (name.startsWith("mcp_")) name = name.slice(4);
    return name;
}

/**
 * Classify a tool into its drop tier. T1 (keep longest) = navigation/structure
 * the agent re-uses; T2 (medium) = edit-class continuation context; T3 (drop
 * first) = everything else (the default — bash, ctx_reduce, inspect, web, …).
 */
export function resolveToolTier(toolName: string | null): Tier {
    const name = normalizeToolName(toolName);
    if (T1_TOOLS.has(name)) return 1;
    if (T2_TOOLS.has(name)) return 2;
    return 3;
}
