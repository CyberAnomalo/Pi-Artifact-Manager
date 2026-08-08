-- pi-artifact-manager SQLite schema (MVP)
-- 设计原则：第一版只保留必要字段，确定性优先。

CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,            -- artifact_<short_hash>
    blob_hash TEXT NOT NULL,        -- sha256 of blob content (FK -> blobs.hash, logical)
    mime_type TEXT,
    byte_size INTEGER,

    summary TEXT,                   -- PLACEHOLDER: 未来由 SemanticClassifier 填充，MVP 留空/人工

    source TEXT,                    -- 'user-input' | 'tool-result' | 'unknown'
    status TEXT DEFAULT 'active',   -- lifecycle: created|active|consumed|archived

    created_at INTEGER              -- unix ms
);

CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY,          -- sha256 hex; 去重保证 100 次上传 = 1 份 blob
    path TEXT NOT NULL,             -- 相对 .visual-artifacts/ 的路径
    size INTEGER,
    created_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    active_artifacts TEXT,          -- JSON array of artifact ids
    updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);
CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_blob ON artifacts(blob_hash);

-- ===========================================================================
-- PLACEHOLDER: 未来扩展表（明确不实现，保留设计位）
-- ===========================================================================
--
-- CREATE TABLE artifact_revisions (...);   -- Revision DAG
-- CREATE TABLE artifact_branches (...);    -- Branch 管理
-- CREATE TABLE artifact_tags (...);        -- 标签
-- CREATE TABLE artifact_relations (...);   -- 关联关系
--
-- artifacts 表未来扩展列：
--   semantic_key TEXT        -- homepage/desktop/default/main
--   revision INTEGER
--   branch TEXT
