import { getHarness } from "../../shared/harness.js";
import type { Database } from "../../shared/sqlite.js";

interface SourceContentRow {
    tag_id: number;
    content: string;
}

function isSourceContentRow(row: unknown): row is SourceContentRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.tag_id === "number" && typeof r.content === "string";
}

export function saveSourceContent(
    db: Database,
    sessionId: string,
    tagId: number,
    content: string,
): void {
    db.prepare(
        "INSERT OR IGNORE INTO source_contents (tag_id, session_id, content, created_at, harness) VALUES (?, ?, ?, ?, ?)",
    ).run(tagId, sessionId, content, Date.now(), getHarness());
}

export function replaceSourceContent(
    db: Database,
    sessionId: string,
    tagId: number,
    content: string,
): void {
    db.prepare(
        `INSERT INTO source_contents (tag_id, session_id, content, created_at, harness)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, tag_id)
     DO UPDATE SET content = excluded.content, created_at = excluded.created_at`,
    ).run(tagId, sessionId, content, Date.now(), getHarness());
}

// FORK（tag-drift-content-verify）：上游没有「按会话反查原文」的需求——上游宿主
// 把 system prompt 放在消息数组之外、tag 身份也不依赖位置字符串，重启平移不会
// 让 tag 错绑。ZCode 的 tag 身份是位置串 `mc<N>:p<下标>`，重启后前缀长度变化会让
// 整个窗口平移；tag-messages 的内容校验需要一次拿全本会话的
// `content -> [tag_id]` 反查索引来判定「这段文本的存量原文主人是谁」。
// `content` 无索引（storage-db.ts 只有 session 索引），长会话数千行按 pass 惰性
// 读一次、同 pass 复用；key 直接引用行内字符串本体（文本 part 可为 data URL，
// 不复制、不规范化），value 按 tag_id 升序保证确定性。
export function getSourceContentIndexBySession(
    db: Database,
    sessionId: string,
): Map<string, number[]> {
    const rows = db
        .prepare(
            `SELECT tag_id, content FROM source_contents WHERE session_id = ? ORDER BY tag_id ASC`,
        )
        .all(sessionId)
        .filter(isSourceContentRow);

    const index = new Map<string, number[]>();
    for (const row of rows) {
        const holders = index.get(row.content);
        if (holders) holders.push(row.tag_id);
        else index.set(row.content, [row.tag_id]);
    }
    return index;
}

export function getSourceContents(
    db: Database,
    sessionId: string,
    tagIds: number[],
): Map<number, string> {
    if (tagIds.length === 0) {
        return new Map();
    }

    const placeholders = tagIds.map(() => "?").join(", ");
    const rows = db
        .prepare(
            `SELECT tag_id, content FROM source_contents WHERE session_id = ? AND tag_id IN (${placeholders})`,
        )
        .all(sessionId, ...tagIds)
        .filter(isSourceContentRow);

    const sources = new Map<number, string>();
    for (const row of rows) {
        sources.set(row.tag_id, row.content);
    }

    return sources;
}
