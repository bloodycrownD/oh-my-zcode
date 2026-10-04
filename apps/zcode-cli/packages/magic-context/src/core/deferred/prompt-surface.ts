// FORK-DEFERRED(E): `shared/prompt-surface.ts` 的 PromptSurfacePreset / PromptSurfaceConfig / promptSurfaceConfigIdentity 摘录，S20 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. `prompt-surface.ts` is the E group's prompt
// surface resolver: it maps a model key onto a `full`/`light` preset and owns the
// user-authored guidance override. The preset SELECTION half
// (`resolvePromptSurface`, `modelKeyLookupOrder`, `resolveModelConfigValue`) is
// consumed by the fork's own `src/host/config/schema.ts` path, not by the B
// group; the model-key walk that `deferred/model-cache-ttl.ts` needs is
// reproduced there so this seam does not have to own it twice.
//
// The B group names exactly one member here, as a type:
// `TransformDeps` carries a `PromptSurfaceConfig`. Reproduced verbatim.
//
// Step 20: delete this file and repoint `transform.ts` back at
// `../../shared/prompt-surface.js`.

/** Verbatim: `prompt-surface.ts:4`. */
export type PromptSurfacePreset = "full" | "light";

/**
 * The configuration consumed by prompt-surface resolution. The schema adds
 * validation and defaults; this structural type keeps the resolver usable by
 * every host without importing a config loader.
 *
 * Verbatim: `prompt-surface.ts:11-16`.
 */
export interface PromptSurfaceConfig {
    default?: PromptSurfacePreset;
    models?: Readonly<Record<string, PromptSurfacePreset>>;
    guidance_override_path?: string;
    tool_descriptions?: Readonly<Record<string, string>>;
}

/** Stable wire identity for the config fields that can alter a served prompt surface. */
export function promptSurfaceConfigIdentity(config: PromptSurfaceConfig | undefined): string {
    return JSON.stringify({
        default: config?.default ?? "full",
        models: Object.entries(config?.models ?? {}).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
        ),
        guidanceOverridePath: config?.guidance_override_path ?? null,
        toolDescriptions: Object.entries(config?.tool_descriptions ?? {}).sort(
            ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
        ),
    });
}