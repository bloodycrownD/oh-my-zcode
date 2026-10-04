/**
 * Step 21 真身替换：`deferred/model-cache-ttl.ts` 的摘录在此归位为源文件本体。
 *
 * 逐字来自 `.reference/magic-context/packages/plugin/src/shared/model-cache-ttl.ts`
 * （58 行），唯一改动：`resolveModelConfigValue` 的上游 `./prompt-surface` 是 E 组
 * （D-12 缩减版走 `host/config/schema.ts`），因此那一个 model-key walk 助手按缝里
 * 同样的方式内联为逐字摘录，其余逐字不变。
 *
 * 为何值得逐字保真：provider cache-TTL 解析是 provider 文档化的寿命表；行为漂移会让
 * 缓存命中率与实际账单一起漂。
 *
 * Apache-2.0, (c) the magic-context authors. Modified for oh-my-zcode.
 */

import { canonicalModelIdentity, modelRefLookupOrder } from "./harness-provider-map.js";

export type CacheTtlConfig = string | Record<string, string>;

export type CacheTtlSource = "config" | "default" | "OpenAI GPT-5.6+ default";

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

// Provider documentation: https://developers.openai.com/api/docs/guides/prompt-caching
// Cache lifetime / Summary of model differences: at least 30 minutes since write or reuse.
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