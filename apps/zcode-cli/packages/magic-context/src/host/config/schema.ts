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
 * FORK（impl-historian-inherit）：`historian.model` 三态化（缺失/"inherit" =
 * 继承会话模型，"" = 显式关闭），详见 {@link HistorianConfigSchema} 上方的
 * 登记块。随该决策一并失效的是上游「enabled 但未配 historian 模型」这条
 * readiness 概念——缺省即继承，不再有「未配置」态，故 `HISTORIAN_MODEL_REQUIRED_MESSAGE`
 * 与 `findConfigReadinessError` 在此删除（bootstrap 装配期不再调用它；模型此刻
 * 造不造得出来由 historian host 的 `historian_model_unavailable` 诊断负责，
 * 那是运行期事实，不是配置 readiness）。
 *
 * FORK（bugfix-batch-20261011 / Step 11）：E 组白名单扩三个子树——
 * `memory.enabled`、`prompt_surface.*`、`mural.enabled`（SPEC D4/D13/D14 的配套
 * 配置面：记忆读写链与提示词面开关此前没有任何配置入口，只能永远默认开/关）。
 * 默认值对齐上游：memory 默认 **on**（上游同款，见下）、prompt_surface 默认
 * `{ default: "full" }`、mural 默认 **off**（mural 渲染本体是 Step 15 的事，
 * 这里只落配置面，运行时消费方后续接线）。上游 memory 子树其余字段
 * （injection_budget_tokens / auto_promote / auto_search / git_commit_indexing …）
 * 与 mural.model（compress-cues dreamer 旋钮，N3 终局不做）**不搬**：本批的
 * 注入链不消费它们，白名单只登记有消费者的字段。
 *
 * Placement: this lives inside the package rather than in `adapters/src/config/`
 * (which is where the spec's E-group sentence points) because the package's own
 * transform/historian consumers must not reach back into a root-workspace
 * package for their own config type. Step 23 re-exports or thinly wraps it from
 * the adapters side where `config.json` validation is wired up.
 */

import { z } from "zod";

import { isValidPromptSurfaceModelKey } from "../../core/shared/prompt-surface.js";
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

const ThresholdPercentageSchema = z.number().min(20).max(90, EXECUTE_THRESHOLD_CAP_MESSAGE);

/**
 * FORK（impl-historian-inherit）：historian 模型三态（用户拍板的产品决策）。
 *
 *   - 字段**缺失 / `undefined`**：缺省「继承会话模型」——折叠模型 = 会话当前
 *     生效模型（live 绑定）。分舱折叠因此永不因「未配置」静默关闭。
 *   - `"inherit"`：与上一行等价的显式哨兵（设置页下拉的「继承会话模型（默认）」）。
 *   - `"provider/model"`：显式旁路模型（上游语义，逐字保留）。
 *   - `""`（显式清空）：关闭分舱折叠。上游这里只有
 *     `z.string().trim().min(1)`，空串一律拒绝；本 fork 把空串放行成一个**有
 *     含义的哨兵值**，否则「用户显式选择关闭」与「字段缺失」在配置面上无法
 *     区分，而两者的语义正好相反。本源是本次改动面。
 *
 * `"inherit"` 是**配置面**哨兵：bootstrap 侧（`magic-context-historian.ts`）
 * 负责把它解析成具体 key，绝不能透到包内——`derive-budgets` 对没有 `/` 前缀的
 * 串只会 warn 后走默认窗口。
 *
 * 保留 `.min(1)` 于空白串：`"  "` 依旧被拒（trim 后为空、但不带显式关闭意图），
 * 只有字面空串代表「关闭」。
 */
export const HistorianConfigSchema = z.object({
  model: z
    .union([z.literal(""), z.string().trim().min(1)])
    .optional()
    .describe(
      'Historian model ID ("provider/model"), the sentinel "inherit" to follow the session model (the default when the field is missing), or "" to turn compartment folding off.',
    ),
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
 * FORK（Step 11 / Step 12）：`prompt_surface` 路由 key 校验的直接消费者。
 *
 * 上游该校验是 `shared/prompt-surface.ts` 的 `isValidPromptSurfaceModelKey`（bare model
 * ID / provider/model / provider/* 三种形态，大小写敏感，model ID 可含额外斜杠）。Step 11
 * 落地 `prompt_surface` 白名单时该文件还是 `deferred/` 的裁剪壳、路径即将随 Step 12 换位，
 * 因此按同款规则内联了一份并在原址登记「Step 12 真身落位后改指 import」；Step 12 git mv
 * 把真身放到 `core/shared/prompt-surface.ts`，本处即那次改指——本地副本删除，规则回归
 * 单一来源（包内逐字区）。
 *
 * 为什么值得校验：坏 key（空段、双斜杠、provider 带 *）不会报运行时错，只会**永远不
 * 匹配**——用户给某个模型配了 light 却发现毫无效果，且没有任何线索。
 */

/**
 * FORK（Step 11）：记忆总开关。上游 memory 子树的 reduced 版——只登记本批有
 * 消费者的 `enabled`（消费方：211 行段 MEMORY_GUIDANCE 装配（Step 13）、ctx_memory /
 * ctx_search 的语义边界、promotion 写入链的门）。上游其余字段
 * （injection_budget_tokens / auto_promote / retrieval_count_promotion_threshold /
 * auto_search / git_commit_indexing）不搬：本批注入链不读它们，白名单只登记
 * 有消费者的字段。默认 **true**（与上游一致：记忆链默认在场，用户显式关才退场）。
 */
export const MemoryConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Enable cross-session project memory: the memory store, ctx_memory/ctx_search, and the memory guidance in the prompt surface. Default true; turning it off keeps Magic Context's context reclamation working without any memory features.",
      ),
  })
  .describe(
    "Cross-session project memory (rules, architecture facts, constraints, config values, naming).",
  );
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/**
 * FORK（Step 11）：prompt-surface 预设备份路由。字段与上游
 * `PromptSurfaceConfigSchema` 一致（default / models / guidance_override_path /
 * tool_descriptions），但只落**配置面**：真正的 preset 解析与 guidance 覆盖
 * 文件读取是 Step 12 的职责（`shared/prompt-surface.ts` 真身 + JSONC 宽松解析），
 * 本批先把白名单与默认值立起来，让设置页与 config.json 有处可写。
 *
 * `guidance_override_path` / `tool_descriptions` 在上游是 **USER-LEVEL ONLY**：
 * 本 fork 的配置真源只有一个用户级文件（`~/.omz/cli/config.json`，D-12），没有
 * 项目级层，因此该限制在本 fork 自动成立，无需额外分层校验。
 */
export const PromptSurfaceConfigSchema = z
  .object({
    default: z
      .enum(["full", "light"])
      .default("full")
      .describe(
        'Fallback prompt-surface preset ("full" or "light"). "full" serves the complete tool descriptions; "light" serves the compact ones.',
      ),
    models: z
      .record(
        z.string().refine(isValidPromptSurfaceModelKey, {
          message:
            "Use a non-empty bare model key, provider/model key, or the literal provider/* wildcard; model IDs may contain additional slashes and matching is case-sensitive.",
        }),
        z.enum(["full", "light"]),
      )
      .optional()
      .describe(
        "Literal per-model routing. Keys are bare model IDs, provider/model, or provider/*; matching is case-sensitive and preserves additional slashes in model IDs.",
      ),
    guidance_override_path: z
      .string()
      .refine((value) => value.trim().length > 0, {
        message: "guidance_override_path must not be empty or whitespace-only",
      })
      .optional()
      .describe(
        "Path to a complete primary guidance section that replaces the built-in one. The file is read and parsed when the prompt surface materializes (Step 12).",
      ),
    tool_descriptions: z
      .record(
        z.string().refine((value) => value.trim().length > 0, {
          message: "tool description keys must not be empty or whitespace-only",
        }),
        z.string().refine((value) => value.trim().length > 0, {
          message: "tool description values must not be empty or whitespace-only",
        }),
      )
      .optional()
      .describe(
        "Top-level description overrides keyed by ctx_* tool ID; parameter schemas and descriptions are unchanged.",
      ),
  })
  .describe("Prompt-surface preset routing for the Magic Context agent-facing surfaces.");
export type PromptSurfaceConfig = z.infer<typeof PromptSurfaceConfigSchema>;

/**
 * FORK（Step 11）：mural 总开关。mural 渲染本体（render-trigger / resolve-mural /
 * render-mural / mural-selection / storage-mural 五件套）是 Step 15 的事，本批
 * 只把配置面立起来；默认 **false**（与上游一致：实验特性，opt-in）。上游的
 * `mural.model`（compress-cues dreamer 任务旋钮）不搬——dreamer 按 N3 终局不做。
 */
export const MuralConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Enable the experimental mural image for project memories that did not fit the context budget. Default false; the rendering path lands with the mural port.",
      ),
  })
  .describe("Experimental mural: a single deterministically-rendered image of project memories.");
export type MuralConfig = z.infer<typeof MuralConfigSchema>;

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
  // FORK（Step 11 / bugfix-batch-20261011）：E 组白名单扩字段。三个子树的默认值
  // 全部对齐上游（memory on / prompt_surface full / mural off），注册这里的字段
  // 意味着 config.json 与设置页对它们可写，运行期消费方按各自 Step 接线
  // （memory.enabled → Step 13 段装配；prompt_surface → Step 12 解析；
  //  mural.enabled → Step 15 渲染）。
  memory: MemoryConfigSchema.default({ enabled: true }).describe(
    "Cross-session project memory settings.",
  ),
  // `as const`：缺省对象必须收敛到字面量 "full"，否则工厂/对象的返回类型会被 widening
  // 成 string，与 z.enum(["full", "light"]) 的输入类型不匹配（tsc 直接拒）。
  prompt_surface: PromptSurfaceConfigSchema.default({ default: "full" as const }).describe(
    "Prompt-surface preset routing.",
  ),
  mural: MuralConfigSchema.default({ enabled: false }).describe("Experimental mural settings."),
});
export type MagicContextConfig = z.infer<typeof MagicContextConfigSchema>;

/**
 * The complete default configuration, **derived** from the schema rather than
 * transcribed: `MagicContextConfigSchema.parse({})` is the single source, so a
 * new field with a `.default()` shows up here automatically and a field whose
 * default is dropped shows up as a removal. Hand-transcribing the defaults
 * would make this object a second copy that silently drifts.
 *
 * `scripts/test-config.mjs` asserts the top-level key set both ways (every key
 * present here has a default, every defaulted key is present here) plus the
 * absence of excluded keys — a hand-written copy passes the spot checks that a
 * derived one would not.
 */
export const DEFAULT_MAGIC_CONTEXT_CONFIG: MagicContextConfig = MagicContextConfigSchema.parse({});

/**
 * Keys this fork refuses to carry, recorded so a reviewer can see the reduction
 * without diffing against the reference. Not enforced at runtime — `z.object`
 * strips them — but asserted by the Step 16 test so a future edit cannot
 * reintroduce one silently.
 */
export const EXCLUDED_CONFIG_KEYS = ["compaction"] as const;
