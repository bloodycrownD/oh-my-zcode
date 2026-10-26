import type { DatabaseSync } from "node:sqlite";
import type {
  FileChangeSummaryReadInput,
  FileChangeSummaryWriteInput,
} from "@zcode/contracts";
import { decodeJson, encodeJson } from "../json.js";

/**
 * 冷开文件变更摘要缓存仓储（`session_file_change_summaries`）。
 *
 * 只做持久与回读，**不解释**摘要内容：`payload_json` 原样存取（形状由 bootstrap 侧
 * `TurnFileChangeSummary` 决定）。这样 adapters 不反向依赖 bootstrap，投影口径变动只需
 * 提升 `summaryVersion`，不必改仓储。
 *
 * SQLite 的绑定变量上限在旧构建上是 999，窗口化首屏一次可带上千条 messageId，
 * 因此按 `MESSAGE_ID_CHUNK` 分批查，最后合并——分批而不是截断，因为截断会静默少读，
 * 表现成「部分轮次角标莫名消失」。
 */
const MESSAGE_ID_CHUNK = 400;

interface SummaryRow {
  message_id: string;
  payload_json: string;
}

/** 缺省摘要口径版本。形状或聚合规则一变就 +1（旧行读不到，由后台重新填）。 */
export const DEFAULT_FILE_CHANGE_SUMMARY_VERSION = 1;

export function readFileChangeSummaries(
  db: DatabaseSync,
  input: FileChangeSummaryReadInput,
  summaryVersion: number = DEFAULT_FILE_CHANGE_SUMMARY_VERSION,
): Map<string, unknown> {
  const summaries = new Map<string, unknown>();
  const uniqueIds = [...new Set(input.messageIds)];
  if (uniqueIds.length === 0) return summaries;
  for (let offset = 0; offset < uniqueIds.length; offset += MESSAGE_ID_CHUNK) {
    const chunk = uniqueIds.slice(offset, offset + MESSAGE_ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `select message_id, payload_json from session_file_change_summaries
          where session_id = ? and summary_version = ? and message_id in (${placeholders})`,
      )
      .all(input.sessionId, summaryVersion, ...chunk) as unknown as SummaryRow[];
    for (const row of rows) {
      summaries.set(row.message_id, decodeJson<unknown>(row.payload_json));
    }
  }
  return summaries;
}

export function upsertFileChangeSummaries(
  db: DatabaseSync,
  input: FileChangeSummaryWriteInput,
  summaryVersion: number = DEFAULT_FILE_CHANGE_SUMMARY_VERSION,
): void {
  if (input.records.length === 0) return;
  const statement = db.prepare(
    `insert into session_file_change_summaries
       (session_id, message_id, summary_version, payload_json, computed_at)
     values (?, ?, ?, ?, ?)
     on conflict(session_id, message_id, summary_version) do update set
       payload_json = excluded.payload_json,
       computed_at = excluded.computed_at`,
  );
  for (const record of input.records) {
    statement.run(
      input.sessionId,
      record.messageId,
      summaryVersion,
      // 负缓存（`summary === null`）必须落成字面量 `"null"`：`encodeJson` 在入参为
      // null/undefined 时给不出合法 JSON 文本，而这种行恰恰是多数（没有 checkpoint 的轮次），
      // 写失败会让整批 upsert 抛 NOT NULL constraint——症状是角标一直不出现且每次重算。
      record.summary === null ? "null" : encodeJson(record.summary),
      record.computedAt,
    );
  }
}
