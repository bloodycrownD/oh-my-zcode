// FORK-DEFERRED(S21): `shared/model-cache-ttl.ts` 的 CacheTtlConfig / CacheTtlSource / ResolvedCacheTtl / resolveModelCacheTtl 摘录，Step 21 移植真身后删除本文件
//
// WHY A SEAM AND NOT THE MODULE. The provider cache-TTL resolver is E/D surface:
// it reads the `cache_ttl` config block and applies the OpenAI GPT-5.6+
// documented lifetime table. The B group reaches it from two directions
// (`transform.ts` types `TransformDeps.cacheTtlConfig`, and
// `resolveSessionCacheTtl` below calls it), so the resolver and its types are
// reproduced verbatim. It has one upstream import,
// `./prompt-surface`'s `resolveModelConfigValue`, which is inlined below as a
// verbatim excerpt of the same model-key walk so the per-model override lookup
// behaves identically.
//
// NOT reproduced: `prompt-surface`'s preset/registration surface (E group,
// reached through `host/config/schema.ts` on the ZCode side) — only the
// `resolveModelConfigValue` helper this file actually calls.
//
// Step 21: delete this file and repoint `transform.ts` back at
// `../../shared/model-cache-ttl.js`.

import { canonicalModelIdentity, modelRefLookupOrder } from "../shared/harness-provider-map.js";

/** Verbatim: `model-cache-ttl.ts:4`. */
export type CacheTtlConfig = string | Record<string, string>;

/** Verbatim: `model-cache-ttl.ts:5`. */
export type CacheTtlSource = "config" | "default" | "OpenAI GPT-5.6+ default";

/** Verbatim: `model-cache-ttl.ts:6-10`. */
export interface ResolvedCacheTtl {
    value: string;
    source: CacheTtlSource;
    modelKey: string | undefined;
}

/**
 * Verbatim: `prompt-surface.ts:120-134`. Kept here (rather than imported from a
 * `prompt-surface` seam) because this is the ONLY prompt-surface member the
 * cache-TTL path calls, and duplicating it avoids making the E group's prompt
 * surface a dependency of the D group's TTL resolver.
 */
export function resolveModelConfigValue<T>(
    values: Readonly<Record<string, T>> | undefined,
    modelKey: string | undefined,
): { value: T; source: "exact" | "bare" | "wildcard" } | undefined {
    if (!values) return undefined;

    for (const candidate of modelKeyLookupOrder(modelKey)) {
        const value = values[candidate.key];
        if (value !== undefined) {
            return { value, source: candidate.source };
        }
    }

    return undefined;
}

/** Verbatim: `prompt-surface.ts:81-117` (the candidate generator, unchanged). */
function modelKeyLookupOrder(modelKey: string | undefined): {
    key: string;
    source: "exact" | "bare" | "wildcard";
}[] {
    if (!modelKey) return [];

    const slash = modelKey.indexOf("/");
    if (slash <= 0 || slash === modelKey.length - 1) return [];

    const provider = modelKey.slice(0, slash);
    let modelID = modelKey.slice(slash + 1);
    const providerRefs = modelRefLookupOrder(`${provider}/${modelID}`);
    const candidates: { key: string; source: "exact" | "bare" | "wildcard" }[] = [];

    while (modelID.length > 0) {
        for (const providerRef of providerRefs) {
            const providerSlash = providerRef.indexOf("/");
            const providerPrefix = providerRef.slice(0, providerSlash);
            candidates.push({ key: `${providerPrefix}/${modelID}`, source: "exact" });
        }
        candidates.push({ key: modelID, source: "bare" });

        const lastDash = modelID.lastIndexOf("-");
        if (lastDash <= 0) break;
        modelID = modelID.slice(0, lastDash);
    }

    for (const providerRef of providerRefs) {
        const providerSlash = providerRef.indexOf("/");
        const providerPrefix = providerRef.slice(0, providerSlash);
        candidates.push({ key: `${providerPrefix}/*`, source: "wildcard" });
    }

    const seen = new Set<string>();
    return candidates.filter((candidate) => {
        if (seen.has(candidate.key)) return false;
        seen.add(candidate.key);
        return true;
    });
}

/**
 * Provider documentation: https://developers.openai.com/api/docs/guides/prompt-caching
 * Cache lifetime / Summary of model differences: at least 30 minutes since write or reuse.
 */
/** Verbatim: `model-cache-ttl.ts:13-27`. */
const MODEL_CACHE_LIFETIMES = [
    {
        source: "OpenAI GPT-5.6+ default" as const,
        value: "30m",
        matches(model: string): boolean {
            const version = /^gpt-(\d+)(?:\.(\d+))?(?:$|[^\d.])/.exec(model);
            if (!version) return false;
            const major = Number(version[1]);
            const minor = Number(version[2] ?? 0);
            return major > 5 || (major === 5 && minor >= 6);
        },
    },
];

/** Verbatim: `model-cache-ttl.ts:29-57`. */
export function resolveModelCacheTtl(
    config: CacheTtlConfig | undefined,
    modelKey: string | undefined,
): ResolvedCacheTtl {
    if (config && typeof config !== "string") {
        const match =
            modelKey &&
            !modelKey.includes("/") &&
            Object.hasOwn(config, modelKey) &&
            modelKey !== "default"
                ? config[modelKey]
                : resolveModelConfigValue(config, modelKey)?.value;
        if (match !== undefined) return { value: match, source: "config", modelKey };
    }
    // A non-5m global string is an explicit policy. The generic 5m default is
    // not evidence of provider eviction: documented lifetimes avoid paid rewrites.
    if (typeof config === "string" && config !== "5m")
        return { value: config, source: "config", modelKey };
    const model =
        canonicalModelIdentity(modelKey ?? "")
            .toLowerCase()
            .split("/")
            .at(-1) ?? "";
    const known = MODEL_CACHE_LIFETIMES.find((entry) => entry.matches(model));
    if (known) return { value: known.value, source: known.source, modelKey };
    return {
        value: (typeof config === "object" ? config.default : config) ?? "5m",
        source: "default",
        modelKey,
    };
}