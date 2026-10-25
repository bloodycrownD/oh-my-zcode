import type { DatabaseSync } from "node:sqlite";
import type {
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  PartId,
  SessionId,
  SessionMessageIndexEntry,
  SessionStorePort,
} from "@zcode/contracts";
import { decodeMessageRow, decodePartRow, partCreatedAt } from "../codecs.js";
import { encodeJson } from "../json.js";
import type { MessageIndexRow, MessageRow, PartRow } from "../rows.js";
import { touchSession } from "./sessions.js";

// 只补回旧版快照字段，不合并整个 JSON：递归 merge 会让已清空的 metadata/options 残留。
function preserveLegacyMembers(table: "message" | "part", keys: readonly string[]): string {
  return keys.reduce(
    (sql, key) =>
      `(select case when json_type(${table}.data, '$.${key}') is not null
      then json_set(previous.data, '$.${key}', json_extract(${table}.data, '$.${key}')) else previous.data end
      from (select ${sql} as data) as previous)`,
    "excluded.data",
  );
}

const MESSAGE_DATA_UPDATE = preserveLegacyMembers("message", [
  "model",
  "providerID",
  "modelID",
  "variant",
]);
const PART_DATA_UPDATE = preserveLegacyMembers("part", ["fromModel", "toModel", "model"]);

// on-conflict 的 sequence 规则：
// 同 scope 再保存必须原样保留现有 sequence——包括 NULL。coalesce(existing, excluded)
// 会把 NULL 历史行（迁移遗漏/旧版本二进制写入）在任何一次再保存时重排到队尾（excluded=max+1），
// assistant 完成后的二次 save 就足以触发，造成时间线漂移；NULL 由 0015 backfill 统一修复。
// 跨 scope 改绑（id 冲突但 session/message 不同，仅导入 upsert 场景）才取 excluded 的新 scope 队尾。
export async function saveMessage(
  db: DatabaseSync,
  input: MessageInfo,
  copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
): Promise<void> {
  const { id, sessionID, ...data } = input;
  // 冻结旧版协议 mapper 无条件读取 user.model；缺少整个对象会让正文也无法打开。
  // 只补必需对象；旧行的原 model 仍由冲突更新/复制逻辑保留，新版 Reader 不使用它。
  const storedData =
    input.role === "user"
      ? {
          ...data,
          model: input.modelSelection
            ? {
                providerID: input.modelSelection.providerId,
                modelID: input.modelSelection.modelId,
                ...(input.modelSelection.options?.reasoningLevel
                  ? { variant: input.modelSelection.options.reasoningLevel }
                  : {}),
              }
            : {},
        }
      : data;
  const timeCreated = input.time.created;
  const timeUpdated =
    input.role === "assistant" ? (input.time.completed ?? Date.now()) : timeCreated;

  db.prepare(
    `
      insert into message (id, session_id, time_created, time_updated, data, sequence)
      values (
        ?,
        ?,
        ?,
        ?,
        ?,
        (
          select coalesce(max(sequence), -1) + 1
          from message
          where session_id = ?
        )
      )
      on conflict(id) do update set
        session_id = excluded.session_id,
        time_updated = excluded.time_updated,
        -- 旧字段是回滚快照，不能因新版 Reader 隐藏了它们而在普通更新时丢掉。
        data = case when message.session_id = excluded.session_id then ${MESSAGE_DATA_UPDATE} else excluded.data end,
        sequence = case
          when message.session_id = excluded.session_id then message.sequence
          else excluded.sequence
        end
      `,
  ).run(
    id,
    sessionID,
    timeCreated,
    timeUpdated,
    encodeJson(copyLegacyMembers(db, "message", storedData, copyFrom)),
    sessionID,
  );
  touchSession(db, sessionID, timeUpdated);
}

export async function removeMessage(
  db: DatabaseSync,
  input: { sessionID: SessionId; messageID: MessageId },
): Promise<void> {
  db.prepare("delete from message where id = ? and session_id = ?").run(
    input.messageID,
    input.sessionID,
  );
}

export async function savePart(
  db: DatabaseSync,
  input: MessagePart,
  copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
): Promise<void> {
  const { id, sessionID, messageID, ...data } = input;
  let storedData: Record<string, unknown> = data;
  if (input.type === "timeline" && input.timelineType === "model_change") {
    const { fromModel, toModel, ...part } = data as typeof input;
    // 冻结旧版 Reader 直接访问 toModel.providerID；只为这一个必需对象做最小兼容写入。
    // 当前 Reader 不读它，更新同一旧行时 SQL 保留原快照，不持续反向同步。
    const oldToModel = toModel
      ? {
          providerID: toModel.providerId,
          modelID: toModel.modelId,
          ...(toModel.options?.reasoningLevel ? { variant: toModel.options.reasoningLevel } : {}),
          label: toModel.label,
        }
      : {};
    storedData = {
      ...part,
      toModel: oldToModel,
      fromModelSelection: fromModel,
      toModelSelection: toModel,
    };
  } else if (input.type === "subtask") {
    const { model, ...part } = data as typeof input;
    storedData = { ...part, modelSelection: model };
  }
  const now = Date.now();

  db.prepare(
    `
      insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
      values (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        (
          select coalesce(max(sequence), -1) + 1
          from part
          where message_id = ?
        )
      )
      on conflict(id) do update set
        message_id = excluded.message_id,
        session_id = excluded.session_id,
        time_updated = excluded.time_updated,
        data = case when part.message_id = excluded.message_id and part.session_id = excluded.session_id
          then ${PART_DATA_UPDATE} else excluded.data end,
        sequence = case
          when part.message_id = excluded.message_id and part.session_id = excluded.session_id
            then part.sequence
          else excluded.sequence
        end
      `,
  ).run(
    id,
    messageID,
    sessionID,
    partCreatedAt(input, now),
    now,
    encodeJson(copyLegacyMembers(db, "part", storedData, copyFrom)),
    messageID,
  );
  touchSession(db, sessionID, now);
}

function copyLegacyMembers(
  db: DatabaseSync,
  table: "message" | "part",
  data: Record<string, unknown>,
  source: Parameters<SessionStorePort["saveMessage"]>[1],
): Record<string, unknown> {
  if (!source) return data;
  // 复制只搬运存储快照；运行层不读取旧字段，也不能凭当前选择重建旧值。
  const row = db
    .prepare(`SELECT data FROM ${table} WHERE id=? AND session_id=?`)
    .get(source.id, source.sessionID);
  if (!row) throw new Error(`Storage copy source missing: ${table}/${source.id}`);
  const original = JSON.parse(String(row.data)) as Record<string, unknown>;
  const result = { ...data };
  const keys =
    table === "message"
      ? ["model", "providerID", "modelID", "variant"]
      : ["fromModel", "toModel", "model"];
  for (const key of keys) if (Object.hasOwn(original, key)) result[key] = original[key];
  return result;
}

export async function removePart(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  },
): Promise<void> {
  db.prepare("delete from part where id = ? and message_id = ? and session_id = ?").run(
    input.partID,
    input.messageID,
    input.sessionID,
  );
}

/**
 * 全序消息索引（IS2 的「id 必须全序」读面）：只读排序键，**不读 `data`**。
 *
 * 排序必须与 `messages()` 逐字一致（`order by sequence is null, sequence, time_created, rowid`）：
 * - `sequence is null` 的结果集是 0/1，**null 行排在非空之后**（0015 backfill 的注释也是这个口径）；
 * - `time_created` 与 `rowid` 是同级 tiebreaker，不能省——sequence 相同的行（旧库/导入）
 *   否则顺序不稳定，索引序与全量序就会出现「同序但不同列」的静默漂移。
 *
 * 不读 `data` 是设计约束（message 表没有 role 列，role 在 data JSON 里）：一旦这里
 * `select *` 或读 data，冷开就退回全量正文读，Step 5/7 的窗口化收益归零。
 */
export async function listSessionMessageIndex(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): Promise<SessionMessageIndexEntry[]> {
  const rows = db
    .prepare(
      `
      select id, sequence, time_created, rowid as storage_row_id from message
      where session_id = ?
      order by sequence is null, sequence, time_created, rowid
      `,
    )
    .all(input.sessionID) as unknown as MessageIndexRow[];
  return rows.map((row) => ({
    id: row.id as MessageId,
    sequence: row.sequence,
    timeCreated: row.time_created,
    storageRowId: row.storage_row_id,
  }));
}

/**
 * 单条 SQL 的 `in (...)` 参数上限。SQLite 默认变量上限 999，500 留一倍余量：
 * 冷窗口（≤400 行对应的消息）一条语句就够，整条分支最多分几条。
 */
const MESSAGE_READ_CHUNK_SIZE = 500;

function placeholdersFor(count: number): string {
  return new Array(count).fill("?").join(", ");
}

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** 尾窗读的输入。`activeMessageIds` 必须是**全序** active 分支 id 序（见函数注释）。 */
export interface ReadActiveBranchTailInput {
  sessionID: SessionId;
  /**
   * 调用方用「消息索引 + `selectActiveConversationBranchIds`」算出的 active 分支 id 序
   * （**全序**，不是窗口）。分支归属与顺序都由它决定：本函数不做任何裁断，也不按
   * `time_created` 自行取 N 条——那两条路都会在 revert 过的会话上复活旧分支或清空历史。
   */
  activeMessageIds: readonly MessageId[];
  /**
   * 窗口下界（**含**）：该 id 之前（更早）的消息不读。缺省 = 读到分支头部。
   * 值由 manifest 给出（窗口首轮的首条 messageId，见 `selectColdTailWindow`）。
   *
   * 游标不在 `activeMessageIds` 里 = 清单与索引不同步：退化为整条分支（多读，绝不少读）。
   * 宁可多付一次全量正文读，也不能因为一个找不到的游标让首屏空白。
   */
  limitBefore?: MessageId | null;
}

/**
 * 分支感知的尾窗正文读（IS2 / IS6 的读面，Step 5）。
 *
 * 为什么不能是「按 `time_created desc` 取 N 条再裁断」：revert 过的会话里，旧分支的消息
 * 仍在 append-only store 里，按时间取尾 N 条会把**已回滚分支**当成历史；反过来，若窗口
 * 里找不到 target/cut，裁断函数会原样返回窗口（复活）或整段清空。分支归属只能由全序 id
 * 决定，因此本函数吃调用方裁好的 `activeMessageIds`，只负责「按这份序读正文」。
 *
 * 两段查询（避免 N+1）：
 *   1. message 段：`where session_id = ? and id in (...)`，**不带 order by**——顺序由
 *      `activeMessageIds` 的下标决定（裁断可以给出与 DB 序不同的 kept 顺序）；
 *   2. part 段：只对**第 1 段真的读到的** messageId 查，ORDER BY 逐字复刻
 *      `messages()` 的 `order by message_id, sequence is null, sequence, time_created, id`
 *      （`sequence is null` 的 0/1 让 NULL 行排在非空之后，两个 tiebreaker 不能省）。
 *
 * 只读这一窗口的正文：更早消息的 `data` 与 part 一条都不读，这是冷开读放大比的来源。
 */
export async function readActiveBranchTail(
  db: DatabaseSync,
  input: ReadActiveBranchTailInput,
): Promise<MessageWithParts[]> {
  // 窗口下界：`limitBefore` 是窗口**首条** id（含）。找不到游标 → 读整条分支。
  const startIndex = input.limitBefore ? input.activeMessageIds.indexOf(input.limitBefore) : 0;
  const windowIds = startIndex > 0 ? input.activeMessageIds.slice(startIndex) : input.activeMessageIds;

  // 同一 id 可能出现两次（rewind 的 kept + cut 后缀可以重叠）：按首现去重但保留给定顺序，
  // 与 `messages()` 的「一行一条」对齐。
  const orderedIds: MessageId[] = [];
  const seen = new Set<string>();
  for (const messageId of windowIds) {
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    orderedIds.push(messageId);
  }

  const positionById = new Map<string, number>();
  orderedIds.forEach((messageId, index) => positionById.set(messageId, index));

  const messageRows: MessageRow[] = [];
  for (const chunk of chunksOf(orderedIds, MESSAGE_READ_CHUNK_SIZE)) {
    messageRows.push(
      ...(db
        .prepare(
          `select * from message where session_id = ? and id in (${placeholdersFor(chunk.length)})`,
        )
        .all(input.sessionID, ...chunk) as unknown as MessageRow[]),
    );
  }
  messageRows.sort((left, right) => positionById.get(left.id)! - positionById.get(right.id)!);

  const foundIds = messageRows.map((row) => row.id as MessageId);
  const partRows: PartRow[] = [];
  for (const chunk of chunksOf(foundIds, MESSAGE_READ_CHUNK_SIZE)) {
    partRows.push(
      ...(db
        .prepare(
          `
          select * from part
          where session_id = ? and message_id in (${placeholdersFor(chunk.length)})
          order by message_id, sequence is null, sequence, time_created, id
          `,
        )
        .all(input.sessionID, ...chunk) as unknown as PartRow[]),
    );
  }
  const partsByMessage = new Map<string, MessagePart[]>();
  for (const row of partRows) {
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(decodePartRow(row));
    partsByMessage.set(row.message_id, list);
  }

  return messageRows.map((row) => ({
    info: decodeMessageRow(row),
    parts: partsByMessage.get(row.id) ?? [],
  }));
}

export async function messages(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): Promise<MessageWithParts[]> {
  const messageRows = db
    .prepare(
      `
      select * from message
      where session_id = ?
      order by sequence is null, sequence, time_created, rowid
      `,
    )
    .all(input.sessionID) as unknown as MessageRow[];

  const partRows = db
    .prepare(
      `
      select * from part
      where session_id = ?
      order by message_id, sequence is null, sequence, time_created, id
      `,
    )
    .all(input.sessionID) as unknown as PartRow[];
  const partsByMessage = new Map<string, MessagePart[]>();

  for (const row of partRows) {
    const part = decodePartRow(row);
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(part);
    partsByMessage.set(row.message_id, list);
  }

  return messageRows.map((row) => ({
    info: decodeMessageRow(row),
    parts: partsByMessage.get(row.id) ?? [],
  }));
}

export async function messageWithParts(
  db: DatabaseSync,
  input: { sessionID: SessionId; messageID: MessageId },
): Promise<MessageWithParts | null> {
  const messageRow = db
    .prepare("select * from message where id = ? and session_id = ?")
    .get(input.messageID, input.sessionID) as unknown as MessageRow | undefined;
  if (!messageRow) return null;

  const partRows = db
    .prepare(
      `
      select * from part
      where message_id = ? and session_id = ?
      order by sequence is null, sequence, time_created, id
      `,
    )
    .all(input.messageID, input.sessionID) as unknown as PartRow[];
  return {
    info: decodeMessageRow(messageRow),
    parts: partRows.map(decodePartRow),
  };
}
