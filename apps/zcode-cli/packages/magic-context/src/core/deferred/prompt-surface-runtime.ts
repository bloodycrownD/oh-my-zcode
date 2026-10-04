// FORK-DEFERRED(E): `shared/prompt-surface-runtime.ts` 的 PromptSurfaceGuidanceSelection / PromptSurfaceRegistrationSelection / PromptSurfaceRuntime 摘录，S20 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. `prompt-surface-runtime.ts` is the E group's
// per-host runtime that resolves a prompt-surface preset AND owns the
// user-authored guidance override file (jsonc discovery through
// `config/migrate-config-location`, tool-description overrides from
// `tools/light-descriptions`). None of that exists on the ZCode side: S16 landed
// the config as `src/host/config/schema.ts`, and no ZCode host registers tools
// through this runtime.
//
// The B group names exactly one member here, as a type:
// `TransformDeps.promptSurface`. Reproduced verbatim. `resolveRegistration` /
// `resolveGuidance` are the runtime's two method slots; no fork code calls them,
// so no implementation is provided.
//
// Step 20: delete this file and repoint `transform.ts` back at
// `../../shared/prompt-surface-runtime.js`.

import type { PromptSurfaceConfig, PromptSurfacePreset } from "./prompt-surface.js";

/** Verbatim: `prompt-surface-runtime.ts:68-73`. */
export interface PromptSurfaceGuidanceSelection {
    /** The configured built-in preset. */
    preset: PromptSurfacePreset;
    /** Complete user-authored primary section captured when a model-key epoch starts. */
    primaryOverride?: string;
}

/** Verbatim: `prompt-surface-runtime.ts:75-78`. */
export interface PromptSurfaceRegistrationSelection {
    preset: PromptSurfacePreset;
    descriptionFor: (toolId: string, fullDescription: string) => string;
}

/** Verbatim: `prompt-surface-runtime.ts:80-89`. */
export interface PromptSurfaceRuntime {
    resolveRegistration: (
        config: PromptSurfaceConfig | undefined,
        modelKey?: string,
    ) => PromptSurfaceRegistrationSelection;
    resolveGuidance: (
        config: PromptSurfaceConfig | undefined,
        modelKey: string | undefined,
    ) => PromptSurfaceGuidanceSelection;
}