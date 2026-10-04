/**
 * Step 16 — E-group config port, reduced zod schema.
 *
 * The reference plugin's `config/schema/magic-context.ts` is 1644 lines and
 * embeds subtrees this fork never ports (dreamer + its task registry, mural,
 * memory/embedding, the OpenCode/Pi/OMP harness blocks, named profiles, the
 * jsonc config family). Per the spec's E group the file is NOT ported whole:
 * only the whitelisted fields' validators and defaults are carried over, and
 * `compaction.*` is explicitly excluded because D-7 removed native compaction
 * from the fork — a `compaction.enabled` gate there would describe a window
 * nobody manages.
 *
 * Deliberate deviations from the reference shape, all recorded in Step 16:
 * - `historian`'s per-harness execution blocks (`opencode` / `pi` / `omp`) are
 *   flattened into `model` / `fallback_models` / `variant`. D-2 keeps exactly
 *   one backend (zcode.z.ai), so three parallel model-resolution vocabularies
 *   have no second reader in the fork.
 * - `historian.runner` / `historian.host_runner` are dropped: they only select
 *   who answers a run queued by the `ck-mc` Rust module, and the Rust module is
 *   not ported (D-6 runs the historian in-process through
 *   `HiddenCompletionExecutor`).
 * - `thinking_level` is dropped with the Pi/OMP vocabulary it belongs to.
 *
 * Placement: this lives inside the package rather than in `adapters/src/config/`
 * (which is where the spec's E-group sentence points) because the package's own
 * transform/historian consumers must not reach back into a root-workspace
 * package for their own config type. Step 23 re-exports or thinly wraps it from
 * the adapters side where `config.json` validation is wired up.
 */

import { z } from "zod";

import { isValidLanguageCode } from "./language.js";

/** Source: `DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE`. */
export const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;

/** Source: `EXECUTE_THRESHOLD_CAP_MESSAGE`, verbatim. */
export const EXECUTE_THRESHOLD_CAP_MESSAGE =
  "execute_threshold is capped at 90% for cache safety: output capacity is reserved from the usable context window, and the remaining 10% absorbs mid-turn growth before the absolute 95% emergency wall. Use a value between 20 and 90.";

/** Source: `DEFAULT_HISTORY_BUDGET_PERCENTAGE`. */
export const DEFAULT_HISTORY_BUDGET_PERCENTAGE = 0.15;

/** Source: `PROTECTED_TOKENS_MIN` — one source of truth for the `.min()` and the warning. */
export const PROTECTED_TOKENS_MIN = 4000;

/** Source: `DEFAULT_HISTORIAN_TIMEOUT_MS` is not ported (no hot-reload timeout knob in the whitelist). */

/**
 * Reported when magic context is on but the historian has no model to run with.
 * Kept out of the schema on purpose: the parse must still succeed for a bare
 * `{}` so the config surface has a complete default (and so the UI can render
 * the form), while "enabled without a historian model" is a runtime readiness
 * failure the historian call path must surface. `findConfigReadinessError` is
 * the single place that decides it.
 */
export const HISTORIAN_MODEL_REQUIRED_MESSAGE =
  'magicContext 已启用但未配置 historian 模型，无法运行上下文分舱折叠（historian）。请在用户级 config.json 的 magicContext.historian.model 字段写入旁路模型 ID（形如 "provider/model"），例如 { "magicContext": { "historian": { "model": "zcode/glm-4.6" } } }。若暂不需要该功能，可将 magicContext.enabled 设为 false。';

const ThresholdPercentageSchema = z.number().min(20).max(90, EXECUTE_THRESHOLD_CAP_MESSAGE);

/**
 * Historian sub-object. Whitelist of the reference's `HistorianConfigSchema`
 * (agent metadata via `AgentOverrideConfigSchema.pick` + the harness-independent
 * knobs), with the model-resolution block flattened as described in the file
 * header. Every validator is copied from the source, defaults included.
 */
export const HistorianConfigSchema = z.object({
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Primary historian model ID (e.g. 'provider/model')."),
  fallback_models: z
    .array(z.string().trim().min(1))
    .default([])
    .describe("Ordered fallback model IDs if the primary is unavailable."),
  variant: z
    .string()
    .optional()
    .describe("Reasoning variant for the primary model (e.g. for extended thinking)."),
  // --- agent metadata (source: AgentMetadataSchema) ---
  temperature: z.number().min(0).max(2).optional().describe("Sampling temperature (0-2)"),
  top_p: z.number().min(0).max(1).optional().describe("Nucleus sampling top_p (0-1)"),
  prompt: z.string().optional().describe("Additional system prompt text"),
  tools: z.record(z.string(), z.boolean()).optional().describe("Tool enable/disable overrides"),
  disable: z.boolean().optional().describe("Disable this agent"),
  description: z.string().optional().describe("Agent description"),
  mode: z
    .enum(["subagent", "primary", "all"])
    .optional()
    .describe("Agent mode (subagent, primary, or all)"),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional()
    .describe("Hex color for the agent (e.g. '#a1b2c3')"),
  maxSteps: z.number().optional().describe("Maximum tool-call steps per invocation"),
  permission: z
    .object({
      edit: z.enum(["ask", "allow", "deny"]).optional(),
      bash: z
        .union([
          z.enum(["ask", "allow", "deny"]),
          z.record(z.string(), z.enum(["ask", "allow", "deny"])),
        ])
        .optional(),
      webfetch: z.enum(["ask", "allow", "deny"]).optional(),
      doom_loop: z.enum(["ask", "allow", "deny"]).optional(),
      external_directory: z.enum(["ask", "allow", "deny"]).optional(),
    })
    .optional()
    .describe("Per-tool permission overrides"),
  maxTokens: z.number().optional().describe("Maximum output tokens"),
  // --- harness-independent historian knobs ---
  two_pass: z
    .boolean()
    .default(false)
    .describe(
      "Run a second editor pass over historian output to clean low-signal U: lines and cross-compartment duplicates. (default: false)",
    ),
  disallowed_tools: z
    .array(z.enum(["*", "read", "aft_outline", "aft_zoom", "aft_search"]))
    .default([])
    .describe(
      "Legacy compatibility setting. Historians, recomp and editor passes always run with zero tools and locked permissions; this list no longer changes their tool surface. (default: [])",
    ),
});
export type HistorianConfig = z.infer<typeof HistorianConfigSchema>;

/**
 * Historian defaults, derived from the schema itself rather than restated, so a
 * new historian field cannot drift out of sync with `DEFAULT_MAGIC_CONTEXT_CONFIG`.
 */
export const DEFAULT_HISTORIAN_CONFIG: HistorianConfig = HistorianConfigSchema.parse({});

/**
 * The reduced `magicContext` domain schema. Unknown keys (notably `compaction`,
 * plus every sub-tree this fork does not port) are stripped rather than
 * rejected, matching the reference's `z.object` default — so a config file
 * written for the reference plugin still loads here, minus the keys the fork
 * has no meaning for.
 */
export const MagicContextConfigSchema = z.object({
  enabled: z.boolean().default(true).describe("Enable magic context (default: true)"),
  execute_threshold_percentage: z
    .union([
      ThresholdPercentageSchema,
      z.object({ default: ThresholdPercentageSchema }).catchall(ThresholdPercentageSchema),
    ])
    .default(DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE)
    .describe(
      'Context percentage that forces queued operations to execute. Number or per-model object ({ default: 65, "provider/model": 45 }). Values above 90 are rejected because the runtime caps at 90% of the output-reserved safe window.',
    ),
  execute_threshold_tokens: z
    .object({
      default: z.number().min(5_000).max(2_000_000).optional(),
    })
    .catchall(z.number().min(5_000).max(2_000_000))
    .optional()
    .describe(
      "Absolute token thresholds per model. When matched, overrides execute_threshold_percentage for that model. Accepts `default` for all models or per-model keys. Min 5_000, max 2_000_000.",
    ),
  protected_tokens: z
    .number()
    .int()
    .min(PROTECTED_TOKENS_MIN)
    .max(1_000_000)
    .optional()
    .describe(
      "Positive integer token floor to protect from automatic reclaim (min: 4_000, max: 1_000_000).",
    ),
  history_budget_percentage: z
    .number()
    .min(0.05)
    .max(0.5)
    .default(DEFAULT_HISTORY_BUDGET_PERCENTAGE)
    .describe(
      "Fraction of usable context (context_limit × execute_threshold) reserved for the session history block (default: 0.15)",
    ),
  cache_ttl: z
    .union([z.string(), z.object({ default: z.string() }).catchall(z.string())])
    .default("5m")
    .describe(
      'How long Magic Context assumes the provider\'s cached prefix stays valid. String (e.g. "5m", "1h", "30s") or per-model object ({ default: "5m", "provider/model": "1h", "provider/*": "never" }); keys resolve most-specific first. Set to "never" to mean MC never assumes expiry.',
    ),
  historian: HistorianConfigSchema.default(() => DEFAULT_HISTORIAN_CONFIG).describe(
    "Historian model resolution and metadata.",
  ),
  smart_drops: z
    .boolean()
    .default(false)
    .describe(
      "Content-aware reclaim of provably-superseded tool output, layered on the existing execute-pass auto-drop. Experimental: opt-in, default off until cache stability is proven; when off the wire is byte-identical to the positional-only reclaim.",
    ),
  fail_closed_blocking: z
    .boolean()
    .default(true)
    .describe(
      "When Magic Context cannot operate (schema fence mismatch, storage open/migration failure), block the primary-session prompt with a loud recovery error instead of silently degrading. Default true. Set false only to restore the old degrade-silently behavior (not recommended).",
    ),
  language: z
    .string()
    .trim()
    .toLowerCase()
    .refine(
      (s) => isValidLanguageCode(s),
      'language must be a 2-letter ISO 639-1 code (e.g. "tr", "es", "de")',
    )
    .optional()
    .describe(
      'Output language for Magic Context\'s generated content and guidance, as a 2-letter ISO 639-1 code (e.g. "tr", "es", "de", "ja", "pt"). Unset = the model mirrors the conversation.',
    ),
});
export type MagicContextConfig = z.infer<typeof MagicContextConfigSchema>;

/**
 * The complete default configuration, transcribed field by field from the
 * reference schema's `.default()` calls. `MagicContextConfigSchema.parse({})`
 * must equal this object; `scripts/test-config.mjs` asserts it.
 */
export const DEFAULT_MAGIC_CONTEXT_CONFIG: MagicContextConfig = MagicContextConfigSchema.parse({});

/**
 * Keys this fork refuses to carry, recorded so a reviewer can see the reduction
 * without diffing against the reference. Not enforced at runtime — `z.object`
 * strips them — but asserted by the Step 16 test so a future edit cannot
 * reintroduce one silently.
 */
export const EXCLUDED_CONFIG_KEYS = ["compaction"] as const;

/**
 * Runtime readiness check for a parsed configuration: returns a human-readable
 * error when the feature is on but cannot run, `null` when it can. Kept out of
 * the schema on purpose (see `HISTORIAN_MODEL_REQUIRED_MESSAGE`).
 */
export function findConfigReadinessError(config: MagicContextConfig): string | null {
  if (config.enabled && !config.historian.model) return HISTORIAN_MODEL_REQUIRED_MESSAGE;
  return null;
}
