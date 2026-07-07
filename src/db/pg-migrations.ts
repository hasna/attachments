/**
 * PostgreSQL migrations for open-attachments remote storage sync.
 *
 * Equivalent to the SQLite schema in core/db.ts, translated for PostgreSQL.
 */

export const PG_MIGRATIONS: string[] = [
  // Migration 0: UUID helper for feedback rows
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,

  // Migration 1: attachments table
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    bucket TEXT NOT NULL,
    size BIGINT NOT NULL,
    content_type TEXT NOT NULL,
    link TEXT,
    tag TEXT,
    expires_at BIGINT,
    created_at BIGINT NOT NULL,
    storage_backend TEXT NOT NULL DEFAULT 's3',
    status TEXT NOT NULL DEFAULT 'ready',
    encryption_algorithm TEXT,
    encryption_salt TEXT,
    encryption_iv TEXT,
    downloads BIGINT NOT NULL DEFAULT 0
  )`,

  // Migration 2: feedback table
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    service TEXT NOT NULL DEFAULT 'attachments',
    version TEXT NOT NULL DEFAULT 'unknown',
    message TEXT NOT NULL,
    email TEXT,
    timestamp TEXT NOT NULL DEFAULT NOW()::text,
    category TEXT DEFAULT 'general',
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 3: share links
  `CREATE TABLE IF NOT EXISTS share_links (
    id TEXT PRIMARY KEY,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at BIGINT,
    created_at BIGINT NOT NULL,
    revoked_at BIGINT,
    password_hash TEXT,
    max_uses BIGINT,
    used_count BIGINT NOT NULL DEFAULT 0
  )`,

  `ALTER TABLE attachments ALTER COLUMN size TYPE BIGINT`,
  `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS storage_backend TEXT NOT NULL DEFAULT 's3'`,
  `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready'`,
  `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS encryption_algorithm TEXT`,
  `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS encryption_salt TEXT`,
  `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS encryption_iv TEXT`,
  `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS downloads BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS service TEXT`,
  `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS version TEXT`,
  `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS timestamp TEXT`,
  `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS email TEXT`,
  `ALTER TABLE feedback ALTER COLUMN service SET DEFAULT 'attachments'`,
  `ALTER TABLE feedback ALTER COLUMN version SET DEFAULT 'unknown'`,
  `ALTER TABLE feedback ALTER COLUMN timestamp SET DEFAULT NOW()::text`,
  `UPDATE feedback SET service = 'attachments' WHERE service IS NULL OR btrim(service) = ''`,
  `UPDATE feedback SET version = 'unknown' WHERE version IS NULL OR btrim(version) = ''`,
  `UPDATE feedback SET timestamp = COALESCE(NULLIF(timestamp, ''), created_at, NOW()::text) WHERE timestamp IS NULL OR btrim(timestamp) = ''`,
  `ALTER TABLE feedback ALTER COLUMN service SET NOT NULL`,
  `ALTER TABLE feedback ALTER COLUMN version SET NOT NULL`,
  `ALTER TABLE feedback ALTER COLUMN timestamp SET NOT NULL`,
];
