// turn 行清单（row manifest）：全序计数的持久权威，取代「从全量投影行现算」。
//
// 两条持久结构各司其职，不能合并：
//   session_turn_manifest       —— 每个 turn 一行，出 totalCount / firstRowId 与 rowId base；
//   session_turn_query_manifest —— 每个 realUser query 一行，出 turnDirectory 条目。
// 目录粒度是 **realUser query 行**（同一 turn 的多条 steer 各自成条），turn 粒度表达不了，
// 所以必须是两张表。
//
// 几条刻意为之的设计：
// 1) 不加 `references session(id)`：detached live 会话（workflow actor / subagent child）
//    会产出真实 turn 却没有 session 行，而 runner 开着 pragma foreign_keys = on——真加 FK
//    会把合法的 manifest 写入挡在门外（同 dwf_* 的处理）。
// 2) rowId 不落库：它由「前序 active turn 的 row_count 累加」确定性推导。落库会与投影规则
//    形成第二个事实源，投影规则一变就整体漂移，症状是翻页错位而不是报错。
// 3) 主键带 branch_generation：rewind 复制保留前缀到新代次时 ordinals 从 0 重排，
//    旧代次的行不能与新代次撞键。
// 4) query 表的 unique 不设 (session_id, branch_generation, query_row_id) 的唯一约束：
//    投影 rowId 在 rewind 后由 manifest base 复用，同一 query_row_id 可能先后属于不同 turn
//    （旧 turn 的行已被删，但保留前缀内的 rowId 仍应唯一——留索引而不是唯一约束，
//    是为了让「账目修正」能在不一致时先修后查，而不是写入即失败）。

export const SESSION_TURN_MANIFEST_MIGRATION_SQL = `
      create table if not exists session_turn_manifest (
        session_id text not null,
        branch_generation integer not null check(branch_generation >= 0),
        ordinal integer not null check(ordinal >= 0),
        turn_id text not null,
        first_message_id text,
        last_message_id text,
        message_ids_json text not null,
        row_count integer not null check(row_count >= 0),
        row_count_source text not null check(row_count_source in ('live', 'cold')),
        projection_schema_version integer not null check(projection_schema_version >= 0),
        time_created integer not null,
        time_updated integer not null,
        primary key(session_id, branch_generation, ordinal),
        unique(session_id, branch_generation, turn_id)
      );

      create index if not exists session_turn_manifest_session_idx
        on session_turn_manifest(session_id, branch_generation);

      create table if not exists session_turn_query_manifest (
        session_id text not null,
        branch_generation integer not null check(branch_generation >= 0),
        turn_id text not null,
        query_ordinal_in_turn integer not null check(query_ordinal_in_turn >= 0),
        query_message_id text,
        query_row_id integer not null check(query_row_id > 0),
        row_count integer not null check(row_count >= 0),
        query_preview text not null,
        assistant_preview text not null,
        assistant_preview_kind text not null
          check(assistant_preview_kind in ('text', 'running', 'empty')),
        time_created integer not null,
        time_updated integer not null,
        primary key(session_id, branch_generation, turn_id, query_ordinal_in_turn)
      );

      create index if not exists session_turn_query_manifest_row_idx
        on session_turn_query_manifest(session_id, branch_generation, query_row_id);

      create index if not exists session_turn_query_manifest_turn_idx
        on session_turn_query_manifest(session_id, branch_generation, turn_id);
    `;
