// FORK-DEFERRED(E)(N1 终局 / Step 17 / bugfix-batch-20261011): `features/magic-context/memory/embedding-synapse.ts` 的 SynapseMaxTokensSource / SynapseLaneDescriptor / formatSynapseLaneDescriptor、`features/magic-context/project-embedding-registry.ts` 的 EmbeddingCoverageStatus、`features/magic-context/shadow-backfill-state.ts` 的 ShadowScope / ShadowBackfillStopReason / ShadowBackfillWriteRefusalReason / PersistedShadowBackfillState / ShadowBackfillStall / describeShadowBackfillWriteRefusal 摘录，N1 终局不做，保留本壳并以此头注登记
//
// WHY A SEAM AND NOT THE MODULE. Three embedding-status modules, one seam. They
// are grouped because they form a single closed type ring: the coverage status
// embeds a Synapse lane descriptor and a list of shadow-backfill stalls, and the
// formatter and the refusal describer are the only two runtime members the B
// group reaches — both from `format-embed-status.ts`, which renders the
// `/ctx-embed` status block.
//
// The runtime half of all three is a provider client (`@cortexkit/subc-client`,
// a git-commit sweep coordinator, an OpenAI-compatible HTTP provider) that the
// fork does not take. What is reproduced verbatim:
//
//   - `formatSynapseLaneDescriptor` — a pure string formatter with no imports.
//   - `describeShadowBackfillWriteRefusal` — a pure switch over a string union.
//
// Both are USER-VISIBLE diagnostic text; paraphrasing them would change what
// `/ctx-embed` prints. The types are structural and are reproduced verbatim so
// `EmbeddingCoverageStatus.synapseDescriptor` and `.shadowBackfillStalls` keep
// their exact shape.
//
// N1 终局裁定（spec Step 17，不做）：embedding 运行时面终局不做——理由=三 provider
// 两家依赖外部服务/被排除依赖（subc-client=fork spec L114 依赖排除令；
// openai-compatible 需用户配 key），本地 provider=@huggingface/transformers+
// onnxruntime-node/web（SEA 4 平台原生二进制+~90MB HF 模型下载离线必挂+
// import.meta.url cjs worker 路径坑），上游 provider enum 本含 "off"、缺席=
// 合法配置态；不影响使用=记忆链完整不依赖向量（D13 写入/ctx_memory pin（D14）、
// memory-selection 选择、ctx_search FTS5 检索），format-embed-status 诚实显示
// off。本壳保留：type 面 + `format-embed-status.ts` 消费的两个 formatter 运行
// 时值（formatSynapseLaneDescriptor / describeShadowBackfillWriteRefusal）是
// `/ctx-embed` 状态块的唯一载体；头注即终局登记，docs/.iteration-state.yaml
// bugfix-batch-20261011 节同步。

/** Verbatim: `embedding-synapse.ts:59-64`. */
export type SynapseMaxTokensSource =
    | "runtime_bucket"
    | "worker_bucket"
    | "catalog_default"
    | "user_override";

/** Verbatim: `embedding-synapse.ts` (`SynapseLaneDescriptor`). */
export interface SynapseLaneDescriptor {
    lane: string;
    device_class?: string;
    max_tokens: number;
    max_tokens_source: SynapseMaxTokensSource;
    bucket_ladder?: number[];
    dims?: number;
    dtype?: string;
    certified?: boolean;
    warm_load_cost_hint_ms?: number;
    recommended_batch?: { rows: number; token_budget?: number };
    /** True only when the ceiling came from a loaded runtime or worker bucket. */
    warm: boolean;
}

/** Verbatim: `embedding-synapse.ts:152-160`. */
export function formatSynapseLaneDescriptor(descriptor: SynapseLaneDescriptor): string {
    const certified = descriptor.certified === undefined ? "unknown" : String(descriptor.certified);
    return (
        `lane=${descriptor.lane}; device_class=${descriptor.device_class ?? "unknown"}; ` +
        `max_tokens=${descriptor.max_tokens} (${descriptor.max_tokens_source}); ` +
        `certified=${certified}; warm=${descriptor.warm ? "yes" : "no"}; ` +
        `warm_load_cost_hint_ms=${descriptor.warm_load_cost_hint_ms ?? "unknown"}`
    );
}

/** Verbatim: `shadow-backfill-state.ts:3-6`. */
export type ShadowScope = "memory" | "commit" | "chunk";
/** Verbatim: `shadow-backfill-state.ts:4`. */
export type ShadowBackfillStopReason = "drained" | "stalled_no_progress";
/** Verbatim: `shadow-backfill-state.ts:5-17`. */
export type ShadowBackfillWriteRefusalReason =
    | "provider_returned_no_vectors"
    | "memory_hash_guard_rejected"
    | "candidate_rows_changed"
    | "registration_retired_during_embed"
    | "chunk_fts_mapping_incomplete"
    | "chunk_empty_canonical_text"
    | "chunk_partial_vector_set"
    | "chunk_window_contract_mismatch"
    | "duplicate_submission_budget"
    | "unknown_write_rejection";

/** Verbatim: `shadow-backfill-state.ts:19-27`. */
export interface PersistedShadowBackfillState {
    version: 1;
    stopReason?: ShadowBackfillStopReason;
    candidateSignature?: string;
    writeRefusalReason?: ShadowBackfillWriteRefusalReason;
    stoppedAt?: number;
    budgetLogRequestKey?: string;
    budgetLoggedAt?: number;
}

/** Verbatim: `shadow-backfill-state.ts:29-36`. */
export interface ShadowBackfillStall {
    projectIdentity: string;
    scope: ShadowScope;
    modelId: string;
    candidateSignature: string;
    writeRefusalReason: ShadowBackfillWriteRefusalReason;
    stoppedAt: number;
}

/** Verbatim: `shadow-backfill-state.ts:69-94`. */
export function describeShadowBackfillWriteRefusal(
    reason: ShadowBackfillWriteRefusalReason,
): string {
    switch (reason) {
        case "provider_returned_no_vectors":
            return "the provider returned no vectors";
        case "memory_hash_guard_rejected":
            return "the memory normalized-hash guard rejected vectors because content changed in flight";
        case "candidate_rows_changed":
            return "the selected source rows changed before the writer loaded them";
        case "registration_retired_during_embed":
            return "the shadow registration was retired or replaced while the provider call was in flight, so the vectors were discarded";
        case "chunk_fts_mapping_incomplete":
            return "the chunk writer refused rows whose transcript ordinals are not fully mapped in FTS";
        case "chunk_empty_canonical_text":
            return "the chunk writer produced no canonical windows";
        case "chunk_partial_vector_set":
            return "the chunk writer refused a partial provider result so it would not replace a compartment incompletely";
        case "chunk_window_contract_mismatch":
            return "written chunk window keys or hashes did not satisfy the selector's window contract";
        case "duplicate_submission_budget":
            return "the same content batch was already submitted within the one-hour provider budget";
        default:
            return "the write completed without satisfying the selected candidate";
    }
}

/** Verbatim: `project-embedding-registry.ts:3443-3461`. */
export interface EmbeddingCoverageStatus {
    /** Whether embedding is active at all for this project. */
    enabled: boolean;
    /** Friendly configured model name, or "off"/"disabled". */
    model: string;
    /** Configured provider kind ("local" / "openai-compatible" / "ollama" / "off"). */
    provider: string;
    /** Live Synapse lane capabilities, when Synapse is active. */
    synapseDescriptor?: SynapseLaneDescriptor;
    /** This session's compartment-chunk coverage. */
    session: { embedded: number; total: number };
    /** Project-wide active-memory coverage. `memoryEnabled: false` means memory
     *  is turned off, so no memory rows are embedded. */
    memories: { embedded: number; total: number; memoryEnabled?: boolean };
    /** Project-wide git-commit coverage (only meaningful when gitEnabled). */
    commits: { embedded: number; total: number; gitEnabled: boolean };
    /** Durable write-side reasons for current shadow scopes that stopped without progress. */
    shadowBackfillStalls: ShadowBackfillStall[];
}