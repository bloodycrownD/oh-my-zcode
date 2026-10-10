/**
 * Step 12 — E-group prompt-surface runtime 真身（壳缝①）。
 *
 * 上游逐字来自 `.reference/magic-context/packages/plugin/src/shared/prompt-surface-runtime.ts`
 * （284 行），**内容整体替换**原先 `deferred/prompt-surface-runtime.ts` 的裁剪壳（45 行，
 * 只摘了 `PromptSurfaceGuidanceSelection` / `PromptSurfaceRegistrationSelection` /
 * `PromptSurfaceRuntime` 三个 type，`resolveRegistration` / `resolveGuidance` 两个方法槽
 * 没有实现）。
 *
 * WHAT CHANGED VS THE SEAM IT REPLACED
 * ────────────────────────────────────
 * 壳里三个同名 type 由真身覆盖（逐字相同）；壳自陈「no fork code calls them」的两个方法槽
 * 现在有了真实现——Step 13 的 211 行段装配读 guidance/preset，Step 14 的工具描述分档读
 * registration，这是本次移植的全部理由。
 *
 * WHAT CHANGED VS UPSTREAM（ZCode 适配，逐字纪律内的显式差异）
 * ────────────────────────────────────────────────────────────
 * 1. `resolveUserConfigDirectory` 折叠为一行。上游走 cortexkit/jsonc 配置家族
 *    （`cortexKitUserConfigBasePath` + `resolveLegacyConfigSourcesForHarness` +
 *    `detectConfigFile`），本 fork 的配置真源只有一个用户级文件
 *    `~/.omz/cli/config.json`（D-12），没有项目级层、没有 OpenCode/Pi/OMP 的 legacy
 *    布局，因此这三个上游依赖（含 `config/migrate-config-location` 与 `jsonc-parser`
 *    两个上游模块）一并去掉，改由 {@link getDataDir} 派生同一个目录。
 * 2. `CreatePromptSurfaceRuntimeOptions.harness` / `directory` 删除：它们只服务上游那套
 *    legacy 目录探测，折叠后无读者。`userConfigDirectory` 与 `warn` 原样保留（前者是测试
 *    注入缝，后者是共享告警去重）。
 * 3. `ACTIVE_TOOL_IDS` / `LIGHT_TOOL_DESCRIPTIONS` 去掉 `ctx_note`：N2 终局不做
 *    （ZCode D 组工具面只登记 ctx_reduce / ctx_expand / ctx_search / ctx_memory）。
 *
 * `src/core/**` 是逐字移植区，除本注与上述三处显式差异外零改动。
 *
 * MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import {
    CTX_EXPAND_LIGHT_DESCRIPTION,
    CTX_MEMORY_LIGHT_DESCRIPTION,
    CTX_REDUCE_LIGHT_DESCRIPTION,
    CTX_SEARCH_LIGHT_DESCRIPTION,
} from "../tools/light-descriptions.js";
import { getDataDir } from "./data-path.js";
import { piModelRefToCanonical } from "./harness-provider-map.js";
import {
    type PromptSurfaceConfig,
    type PromptSurfacePreset,
    resolvePromptSurface,
} from "./prompt-surface.js";

const GUIDANCE_MARKER = "## Magic Context";
const GUIDANCE_MARKER_LINE = /^## Magic Context[\t ]*\r?$/gm;

/**
 * The single source of truth for the ctx_* tools exposed by the prompt surface.
 * Consumers derive their registries and light-description catalogs from this list
 * so adding a tool cannot silently skip one prompt-surface integration point.
 *
 * FORK(Step 12)：上游列出五条（含 `ctx_note`）；ctx_note 工具按 spec N2 终局不做
 * （ZCode D 组工具面只登记 ctx_reduce / ctx_expand / ctx_search / ctx_memory），本表是
 * 「已知 ctx_* 工具」的唯一权威，缺席即不搬——`resolveRegistration` 的未知 id 告警与
 * `prompt_surface.tool_descriptions.<id>` 覆盖校验都读它，两条缝一起收口。
 */
export const ACTIVE_TOOL_IDS = [
    "ctx_reduce",
    "ctx_expand",
    "ctx_memory",
    "ctx_search",
] as const;

/** @deprecated Use ACTIVE_TOOL_IDS. Kept as an alias for existing consumers. */
export const PROMPT_SURFACE_TOOL_IDS = ACTIVE_TOOL_IDS;

export type PromptSurfaceToolId = (typeof ACTIVE_TOOL_IDS)[number];

export const LIGHT_TOOL_DESCRIPTIONS = {
    ctx_reduce: CTX_REDUCE_LIGHT_DESCRIPTION,
    ctx_expand: CTX_EXPAND_LIGHT_DESCRIPTION,
    ctx_memory: CTX_MEMORY_LIGHT_DESCRIPTION,
    ctx_search: CTX_SEARCH_LIGHT_DESCRIPTION,
} as const satisfies Readonly<Record<PromptSurfaceToolId, string>>;

/**
 * Preserve the existing full-preset hash exactly while giving other presets a
 * distinct semantic cache identity, including during any future asset fallback.
 */
export function promptSurfaceHashMaterial(
    systemContent: string,
    preset: PromptSurfacePreset = "full",
): string {
    return preset === "full"
        ? systemContent
        : `${systemContent}\n\0magic-context-prompt-surface:${preset}`;
}

const PROMPT_SURFACE_TOOL_ID_SET = new Set<string>(ACTIVE_TOOL_IDS);

export interface PromptSurfaceGuidanceSelection {
    /** The configured built-in preset. */
    preset: PromptSurfacePreset;
    /** Complete user-authored primary section captured when a model-key epoch starts. */
    primaryOverride?: string;
}

export interface PromptSurfaceRegistrationSelection {
    preset: PromptSurfacePreset;
    descriptionFor: (toolId: string, fullDescription: string) => string;
}

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

export interface CreatePromptSurfaceRuntimeOptions {
    /** Explicit test/integration seam; production derives the ZCode config directory. */
    userConfigDirectory?: string;
    warn: (message: string) => void;
}

/**
 * FORK(Step 12)：上游这一函数是 cortexkit/jsonc 配置家族的发现器（共享基路径 → harness
 * legacy 源 → dirname 兜底）。本 fork 只认一个用户级配置目录（`~/.omz/cli`，D-12 的
 * `config.json` 所在），显式 seam 优先、其余直接派生，见文件头差异 1。
 */
function resolveUserConfigDirectory(options: CreatePromptSurfaceRuntimeOptions): string {
    if (options.userConfigDirectory) return resolve(options.userConfigDirectory);
    return dirname(resolve(getDataDir(), "cli", "config.json"));
}

function markerCount(content: string): number {
    return content.match(GUIDANCE_MARKER_LINE)?.length ?? 0;
}

/**
 * Create one host-registration runtime. Its warning set is shared by tool
 * registration and every guidance epoch, so invalid overrides are reported once
 * instead of on every model call.
 */
export function createPromptSurfaceRuntime(
    options: CreatePromptSurfaceRuntimeOptions,
): PromptSurfaceRuntime {
    const userConfigDirectory = resolveUserConfigDirectory(options);
    const warned = new Set<string>();

    const warnOnce = (key: string, message: string): void => {
        if (warned.has(key)) return;
        warned.add(key);
        options.warn(message);
    };

    const readGuidanceOverride = (configuredPath: string | undefined): string | undefined => {
        if (!configuredPath) return undefined;
        const path = isAbsolute(configuredPath)
            ? configuredPath
            : resolve(userConfigDirectory, configuredPath);

        let content: string;
        try {
            if (!statSync(path).isFile()) {
                warnOnce(
                    `guidance-not-file:${path}`,
                    `prompt_surface.guidance_override_path (${path}) is not a file; using built-in guidance.`,
                );
                return undefined;
            }
            content = readFileSync(path, "utf8");
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            warnOnce(
                `guidance-unreadable:${path}:${reason}`,
                `prompt_surface.guidance_override_path (${path}) could not be read (${reason}); using built-in guidance.`,
            );
            return undefined;
        }

        if (content.trim().length === 0) {
            warnOnce(
                `guidance-empty:${path}`,
                `prompt_surface.guidance_override_path (${path}) is empty; using built-in guidance.`,
            );
            return undefined;
        }

        const markers = markerCount(content);
        if (markers !== 1) {
            warnOnce(
                `guidance-marker-count:${path}:${markers}`,
                `prompt_surface.guidance_override_path (${path}) must contain exactly one ${JSON.stringify(GUIDANCE_MARKER)} section marker; found ${markers}. Using built-in guidance.`,
            );
            return undefined;
        }

        return content;
    };

    return {
        resolveRegistration(config, modelKey) {
            // OpenCode 1.x and Pi expose one immutable provider tool map per host
            // registration, so callers omit modelKey and only the default preset
            // can choose text. OpenCode 2 rewrites draft.tools per request and
            // passes the draft model so the same resolver honors model routes.
            const { preset } = resolvePromptSurface(config, modelKey);

            const overrides = config?.tool_descriptions ?? {};
            for (const [toolId, description] of Object.entries(overrides)) {
                if (!PROMPT_SURFACE_TOOL_ID_SET.has(toolId)) {
                    warnOnce(
                        `unknown-tool:${toolId}`,
                        `prompt_surface.tool_descriptions.${toolId} is not a known ctx_* tool ID; the override was ignored.`,
                    );
                } else if (description.trim().length === 0) {
                    warnOnce(
                        `empty-tool:${toolId}`,
                        `prompt_surface.tool_descriptions.${toolId} is empty; the override was ignored.`,
                    );
                }
            }

            return {
                preset,
                descriptionFor(toolId, fullDescription) {
                    if (!PROMPT_SURFACE_TOOL_ID_SET.has(toolId)) return fullDescription;
                    const override = overrides[toolId];
                    if (override !== undefined && override.trim().length > 0) return override;
                    return preset === "light"
                        ? LIGHT_TOOL_DESCRIPTIONS[toolId as PromptSurfaceToolId]
                        : fullDescription;
                },
            };
        },

        resolveGuidance(config, modelKey) {
            const { preset } = resolvePromptSurface(config, modelKey);
            return {
                preset,
                primaryOverride: readGuidanceOverride(config?.guidance_override_path),
            };
        },
    };
}

interface GuidanceEpoch {
    config: PromptSurfaceConfig | undefined;
    modelKey: string | undefined;
    selection: PromptSurfaceGuidanceSelection;
}

export interface PromptSurfaceGuidanceEpochCache {
    resolve: (
        sessionId: string,
        config: PromptSurfaceConfig | undefined,
        modelKey: string | undefined,
    ) => PromptSurfaceGuidanceSelection;
    clear: (sessionId: string) => void;
}

const guidanceEpochCacheByRuntime = new WeakMap<
    PromptSurfaceRuntime,
    PromptSurfaceGuidanceEpochCache
>();

/**
 * Freeze preset selection and materialized override bytes for one model-key epoch.
 * Every hook using the same runtime also shares this cache, so a file edit cannot
 * make the system hook and Rust adapter observe different bytes within one epoch.
 */
export function createPromptSurfaceGuidanceEpochCache(
    runtime: PromptSurfaceRuntime,
): PromptSurfaceGuidanceEpochCache {
    const shared = guidanceEpochCacheByRuntime.get(runtime);
    if (shared) return shared;

    const epochs = new Map<string, GuidanceEpoch>();
    const cache: PromptSurfaceGuidanceEpochCache = {
        resolve(sessionId, config, modelKey) {
            const canonicalModelKey = modelKey ? piModelRefToCanonical(modelKey) : undefined;
            const cached = epochs.get(sessionId);
            if (cached && cached.config === config && cached.modelKey === canonicalModelKey) {
                return cached.selection;
            }

            const selection = runtime.resolveGuidance(config, canonicalModelKey);
            epochs.set(sessionId, { config, modelKey: canonicalModelKey, selection });
            return selection;
        },
        clear(sessionId) {
            epochs.delete(sessionId);
        },
    };
    guidanceEpochCacheByRuntime.set(runtime, cache);
    return cache;
}
