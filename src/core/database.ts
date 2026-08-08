/**
 * Database — SQLite 薄封装。
 *
 * 双后端适配（确定性，无配置）：
 *   - bun 运行时（bun test / pi 用 bun 加载）→ bun:sqlite
 *   - node 运行时 (>= 22.5)              → node:sqlite (DatabaseSync)
 * 两者 prepare/run/get/all API 兼容。
 *
 * Core 保持独立：这里只定义最小接口，未来可替换为
 * sidecar daemon / 其他存储后端而不影响上层逻辑。
 *
 * PLACEHOLDER: StorageAdapter interface（未来多后端）
 *   interface StorageAdapter { prepare(...), exec(...), close() }
 */

// node:sqlite 的 @types 可能缺失，声明最小结构以保持可编译。
type SqliteValue = string | number | bigint | Uint8Array | null;

interface StatementLike {
  run(...params: SqliteValue[]): unknown;
  get(...params: SqliteValue[]): Record<string, SqliteValue> | undefined;
  all(...params: SqliteValue[]): Record<string, SqliteValue>[];
}

interface DatabaseLike {
  prepare(sql: string): StatementLike;
  exec(sql: string): void;
  close(): void;
}

function openSqlite(filePath: string): DatabaseLike {
  // bun 运行时：bun 未实现 node:sqlite，使用原生 bun:sqlite
  if ((globalThis as { Bun?: unknown }).Bun) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bunMod = require("bun:sqlite") as { Database: new (path: string) => DatabaseLike };
    return new bunMod.Database(filePath);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseLike };
  return new mod.DatabaseSync(filePath);
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    blob_hash TEXT NOT NULL,
    mime_type TEXT,
    byte_size INTEGER,
    summary TEXT,
    source TEXT,
    status TEXT DEFAULT 'active',
    created_at INTEGER
);
CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    size INTEGER,
    created_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    active_artifacts TEXT,
    updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_blob ON artifacts(blob_hash);
`;

export class Database {
  private readonly db: DatabaseLike;

  constructor(filePath: string) {
    this.db = openSqlite(filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  // ---- blobs ----

  upsertBlob(hash: string, relPath: string, size: number, createdAt: number): void {
    this.db
      .prepare(
        "INSERT INTO blobs (hash, path, size, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING",
      )
      .run(hash, relPath, size, createdAt);
  }

  getBlob(hash: string): { hash: string; path: string; size: number } | undefined {
    const row = this.db.prepare("SELECT hash, path, size FROM blobs WHERE hash = ?").get(hash);
    if (!row) return undefined;
    return { hash: String(row.hash), path: String(row.path), size: Number(row.size) };
  }

  blobCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM blobs").get();
    return Number(row?.n ?? 0);
  }

  // ---- artifacts ----

  insertArtifact(a: {
    id: string;
    blobHash: string;
    mimeType: string | null;
    byteSize: number;
    summary: string | null;
    source: string;
    status: string;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, blob_hash, mime_type, byte_size, summary, source, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(a.id, a.blobHash, a.mimeType, a.byteSize, a.summary, a.source, a.status, a.createdAt);
  }

  getArtifact(id: string):
    | { id: string; blobHash: string; mimeType: string | null; byteSize: number; summary: string | null; source: string; status: string; createdAt: number }
    | undefined {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE id = ?")
      .get(id);
    if (!row) return undefined;
    return {
      id: String(row.id),
      blobHash: String(row.blob_hash),
      mimeType: row.mime_type == null ? null : String(row.mime_type),
      byteSize: Number(row.byte_size ?? 0),
      summary: row.summary == null ? null : String(row.summary),
      source: String(row.source ?? "unknown"),
      status: String(row.status ?? "active"),
      createdAt: Number(row.created_at ?? 0),
    };
  }

  findArtifactByHash(blobHash: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM artifacts WHERE blob_hash = ? ORDER BY created_at LIMIT 1").get(blobHash);
    return row ? String(row.id) : undefined;
  }

  updateArtifactStatus(id: string, status: string): void {
    this.db.prepare("UPDATE artifacts SET status = ? WHERE id = ?").run(status, id);
  }

  listArtifacts(includeArchived: boolean): {
    id: string; blobHash: string; mimeType: string | null; byteSize: number;
    summary: string | null; source: string; status: string; createdAt: number;
  }[] {
    const rows = includeArchived
      ? this.db.prepare("SELECT * FROM artifacts ORDER BY created_at").all()
      : this.db.prepare("SELECT * FROM artifacts WHERE status != 'archived' ORDER BY created_at").all();
    return rows.map((row) => ({
      id: String(row.id),
      blobHash: String(row.blob_hash),
      mimeType: row.mime_type == null ? null : String(row.mime_type),
      byteSize: Number(row.byte_size ?? 0),
      summary: row.summary == null ? null : String(row.summary),
      source: String(row.source ?? "unknown"),
      status: String(row.status ?? "active"),
      createdAt: Number(row.created_at ?? 0),
    }));
  }

  artifactCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get();
    return Number(row?.n ?? 0);
  }

  totalArtifactBytes(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(byte_size), 0) AS s FROM artifacts").get();
    return Number(row?.s ?? 0);
  }

  // ---- sessions ----

  upsertSession(sessionId: string, activeArtifacts: string[], updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, active_artifacts, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET active_artifacts = excluded.active_artifacts, updated_at = excluded.updated_at`,
      )
      .run(sessionId, JSON.stringify(activeArtifacts), updatedAt);
  }

  getSession(sessionId: string): { activeArtifacts: string[] } | undefined {
    const row = this.db.prepare("SELECT active_artifacts FROM sessions WHERE session_id = ?").get(sessionId);
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(String(row.active_artifacts ?? "[]"));
      return { activeArtifacts: Array.isArray(parsed) ? parsed.map(String) : [] };
    } catch {
      return { activeArtifacts: [] };
    }
  }

  close(): void {
    this.db.close();
  }
}
