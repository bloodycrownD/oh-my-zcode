// FORK-NOTE(Step 15 / bugfix-batch-20261011): upstream
// `features/magic-context/mural/storage-mural.ts` (103 lines) — NEW PORT.
//
// The `mural_manifest` table store. The fork's migration state already carries
// the table (storage-db / migrations v-line, same schema as upstream, fork and
// upstream symbol names identical), so no migration work is needed — this file
// is the first reader/writer of it in the fork. `getMural`/`getMuralIdentity`
// degrade to null on a pre-table database ("no such table"), matching the rest
// of the fork's storage modules.
//
// Import adaptation: `../../../shared/sqlite` → `../../../shared/sqlite.js`.
// The `db.prepare<[string], RawMuralRow>(…)` tuple-generic form already matches
// the fork's better-sqlite3-typed `Database` (the fork's own
// `storage-mural-cues` port registers the one place where upstream's scalar
// generic had to be adapted; this file needs none). No behavioral adaptation.
//
// MIT, Copyright (c) 2025 Ufuk Altinok (magic-context). Modified for oh-my-zcode.
import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite.js";

export interface MuralManifestRow {
    projectPath: string;
    image: Buffer;
    contentHash: string;
    renderedAt: number;
    model: string | null;
    memoryIds: number[];
    width: number;
    height: number;
}

interface RawMuralRow {
    project_path: string;
    image: Buffer | Uint8Array;
    content_hash: string;
    rendered_at: number;
    model: string | null;
    memory_ids_json: string;
    width: number;
    height: number;
}

export interface MuralManifestIdentity {
    contentHash: string;
    renderedAt: number;
}

interface RawMuralIdentityRow {
    content_hash: string;
    rendered_at: number;
}

const muralIdentityStatements = new WeakMap<Database, PreparedStatement>();

export function getMuralIdentity(db: Database, projectPath: string): MuralManifestIdentity | null {
    try {
        let statement = muralIdentityStatements.get(db);
        if (!statement) {
            statement = db.prepare(
                "SELECT content_hash, rendered_at FROM mural_manifest WHERE project_path = ?",
            );
            muralIdentityStatements.set(db, statement);
        }
        const row = statement.get(projectPath) as RawMuralIdentityRow | undefined;
        return row ? { contentHash: row.content_hash, renderedAt: row.rendered_at } : null;
    } catch (error) {
        if (String(error).includes("no such table")) return null;
        throw error;
    }
}

export function getMural(db: Database, projectPath: string): MuralManifestRow | null {
    try {
        const row = db
            .prepare<[string], RawMuralRow>(
                "SELECT project_path, image, content_hash, rendered_at, model, memory_ids_json, width, height FROM mural_manifest WHERE project_path = ?",
            )
            .get(projectPath);
        if (!row) return null;
        let memoryIds: number[] = [];
        try {
            const parsed = JSON.parse(row.memory_ids_json);
            if (Array.isArray(parsed))
                memoryIds = parsed.filter((id): id is number => typeof id === "number");
        } catch {
            // A malformed sidecar must not make m0 injection fail closed.
        }
        return {
            projectPath: row.project_path,
            image: Buffer.from(row.image),
            contentHash: row.content_hash,
            renderedAt: row.rendered_at,
            model: row.model,
            memoryIds,
            width: row.width,
            height: row.height,
        };
    } catch (error) {
        if (String(error).includes("no such table")) return null;
        throw error;
    }
}

export function upsertMural(
    db: Database,
    input: Omit<MuralManifestRow, "projectPath"> & { projectPath: string },
): void {
    db.prepare(
        "INSERT INTO mural_manifest (project_path, image, content_hash, rendered_at, model, memory_ids_json, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_path) DO UPDATE SET image = excluded.image, content_hash = excluded.content_hash, rendered_at = excluded.rendered_at, model = excluded.model, memory_ids_json = excluded.memory_ids_json, width = excluded.width, height = excluded.height",
    ).run(
        input.projectPath,
        input.image,
        input.contentHash,
        input.renderedAt,
        input.model,
        JSON.stringify(input.memoryIds),
        input.width,
        input.height,
    );
}
