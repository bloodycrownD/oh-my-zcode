export interface SessionRow {
  id: string;
  project_id: string;
  workspace_id: string | null;
  parent_id: string | null;
  trace_id: string | null;
  task_type: string;
  slug: string;
  directory: string;
  path: string | null;
  title: string;
  title_source: string | null;
  title_message_id: string | null;
  version: string;
  share_url: string | null;
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_files: number | null;
  summary_diffs: string | null;
  revert: string | null;
  permission: string | null;
  time_created: number;
  time_updated: number;
  time_title_updated: number | null;
  time_compacting: number | null;
  time_archived: number | null;
}

export interface MessageRow {
  id: string;
  session_id: string;
  sequence: number | null;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  sequence: number | null;
  time_created: number;
  time_updated: number;
  data: string;
}

/**
 * `listSessionMessageIndex` 的窄行：只有排序键与 rowid，**没有 `data`**。
 * 存在这一层是为了让「索引读」在类型上就无法退化成正文读（role 在 data JSON 里）。
 */
export interface MessageIndexRow {
  id: string;
  sequence: number | null;
  time_created: number;
  storage_row_id: number;
}

export interface SessionEntryRow {
  id: string;
  session_id: string;
  type: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface TodoRow {
  session_id: string;
  content: string;
  status: string;
  priority: string;
  position: number;
  time_created: number;
  time_updated: number;
}

export interface PermissionRow {
  project_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface LocalSettingRow {
  value: string;
}

export interface SchemaMigrationRow {
  checksum: string;
  id: string;
}

export interface InputHistoryRow {
  id: string;
  project_id: string;
  session_id: string | null;
  text: string;
  attachments: string | null;
  kind: string;
  time_created: number;
}

export interface TurnManifestRow {
  session_id: string;
  branch_generation: number;
  ordinal: number;
  turn_id: string;
  first_message_id: string | null;
  last_message_id: string | null;
  message_ids_json: string;
  row_count: number;
  row_count_source: "live" | "cold";
  projection_schema_version: number;
  time_created: number;
  time_updated: number;
}

export interface TurnQueryManifestRow {
  session_id: string;
  branch_generation: number;
  turn_id: string;
  query_ordinal_in_turn: number;
  query_message_id: string | null;
  query_row_id: number;
  row_count: number;
  query_preview: string;
  assistant_preview: string;
  assistant_preview_kind: "text" | "running" | "empty";
  time_created: number;
  time_updated: number;
}
