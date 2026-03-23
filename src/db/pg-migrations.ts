/**
 * PostgreSQL migrations for open-attachments cloud sync.
 *
 * Equivalent to the SQLite schema in core/db.ts, translated for PostgreSQL.
 */

export const PG_MIGRATIONS: string[] = [
  // Migration 1: attachments table
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    s3_key TEXT NOT NULL,
    bucket TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    link TEXT,
    tag TEXT,
    expires_at BIGINT,
    created_at BIGINT NOT NULL
  )`,

  // Migration 2: feedback table
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,
];
