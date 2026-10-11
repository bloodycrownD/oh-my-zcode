/**
 * FORK-NOTE(N1 终局 / Step 17 / bugfix-batch-20261011)：embedding 运行时面终局
 * 不做——`features/magic-context/compartment-chunk-embedding.ts`（upstream）保留
 * 本壳并以此头注登记。
 *
 * Chunk embeddings are C group and the upstream module reaches the embedding
 * providers (`@cortexkit/subc-client`), which this fork does not take. The A
 * group's `storage-session-tables.ts` only needs the per-session cleanup of the
 * recorded backoff/window keys, so that statement and its two key prefixes are
 * reproduced here verbatim.
 *
 * 终局裁定（spec 裁定表 N1，不做）：
 * - 理由：① 三 provider 两家依赖外部服务/被排除依赖（subc-client 是 fork spec
 *   L114 依赖排除令；openai-compatible 需用户配 key）；② 本地 provider
 *   =@huggingface/transformers+onnxruntime-node/web：SEA blob 膨胀（4 平台
 *   原生二进制）+ 运行期 ~90MB HF 模型下载（离线必挂）+ `import.meta.url`
 *   cjs worker 路径坑；③ 上游 provider enum 本含 `"off"`，缺席=合法配置态。
 * - 不影响使用论证：记忆链完整不依赖向量——写入（historian 分舱
 *   `promoteSessionFactsDurable`（D13）→storage-memory；模型显式 pin 走
 *   ctx_memory（D14））→选择（memory-selection 排序）→注入（m0/m1 文本+mural
 *   cue）→检索（ctx_search FTS5 关键词）；缺席仅损失「语义召回」增强，
 *   format-embed-status 诚实显示 off。
 * - 收口动作：本壳保留（A 组 cleanup 语句的唯一载体），头注即终局登记；
 *   同族缝 compartment-chunk-embedding / auto-search-runner /
 *   embedding-status-tables 同批登记，embed-session-state 已删（Step 17）；
 *   docs/.iteration-state.yaml bugfix-batch-20261011 节同步。
 */

import type { Database } from "../shared/sqlite.js";

const BACKOFF_PREFIX = "chunk_embed_backoff:";
const WINDOW_SOURCE_PREFIX = "chunk_embed_windows:";

/** Also removes the session's recorded window sources (see recordChunkWindowSource). */
export function deleteChunkEmbedBackoffForSession(db: Database, sessionId: string): void {
    db.prepare(`DELETE FROM schema_migrations_meta WHERE key IN (
        SELECT ? || id FROM compartments WHERE session_id = ?
        UNION ALL
        SELECT ? || id FROM compartments WHERE session_id = ?
    )`).run(BACKOFF_PREFIX, sessionId, WINDOW_SOURCE_PREFIX, sessionId);
}
