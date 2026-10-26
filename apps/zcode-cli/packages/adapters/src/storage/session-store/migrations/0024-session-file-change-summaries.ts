// 冷开文件变更摘要的持久缓存表。
//
// 为什么需要一张表（2026-10-26 真机取证）：`buildColdFileChangeSummaries` 在冷开必经路径上
// 按消息现算摘要，每个 workspace checkpoint 要读一次 artifact 并反序列化整份快照。
// 真机上 291 条物化消息 → 2088ms，占 `mergeMs` 的 94%、`uiViewReadyMs` 的 44%。
// 摘要是**不可变的派生事实**（checkpoint 生成即定稿、artifact 不会改写），所以算一次就该
// 落库：之后每次冷开只做一次 `session_id` 前缀的批量读，0 次 artifact 读。
//
// 几条刻意为之的设计：
// 1) `summary_version` 进主键，而不是写迁移去改历史行：摘要口径（文件聚合规则、行数统计）
//    一变就换版本号，旧行自然读不到、由后台重新填，回滚时旧行还在。
// 2) 不建 `references session(id)`：detached live 会话（workflow actor / subagent child）
//    会产生真实 turn 却没有 session 行，同 `session_turn_manifest` 的处理。
// 3) `payload_json` 对 adapters 是不透明 JSON：形状由 bootstrap 侧
//    `TurnFileChangeSummary` 决定，仓储只存整份、只按 message_id 取，不做字段级解释——
//    否则投影口径一变就要动两个包。
// 4) 主键就是 (session_id, message_id, summary_version)：读路径永远是
//    `where session_id = ? and message_id in (...)`，会话内全量读也能走同一个索引。

export const SESSION_FILE_CHANGE_SUMMARIES_MIGRATION_SQL = `
      create table if not exists session_file_change_summaries (
        session_id text not null,
        message_id text not null,
        summary_version integer not null check(summary_version >= 0),
        payload_json text not null,
        computed_at integer not null,
        primary key(session_id, message_id, summary_version)
      );
    `;
