/**
 * Cloud Postgres migrations for the attachments serve service.
 *
 * PURE REMOTE (Amendment A1): these run against the shared RDS Postgres via the
 * vendored storage kit's MigrationLedger. The service reads and writes the same
 * cloud database — there is no local mirror, cache, or sync engine here.
 *
 * The api_keys table migrations come from @hasna/contracts/auth so the
 * API-key middleware and issuer share one schema.
 */

import { apiKeyMigrations } from "@hasna/contracts/auth";
import { defineMigration, type Migration } from "../generated/storage-kit/migrations.js";

const CORE_MIGRATIONS: Migration[] = [
  defineMigration(
    "attachments_0001_pgcrypto",
    `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
  ),
  defineMigration(
    "attachments_0002_attachments",
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
       encryption_tag TEXT,
       downloads BIGINT NOT NULL DEFAULT 0
     )`,
  ),
  defineMigration(
    "attachments_0003_attachments_indexes",
    `CREATE INDEX IF NOT EXISTS idx_attachments_created_at ON attachments(created_at DESC);
     CREATE INDEX IF NOT EXISTS idx_attachments_tag ON attachments(tag)`,
  ),
  defineMigration(
    "attachments_0004_share_links",
    `CREATE TABLE IF NOT EXISTS share_links (
       id TEXT PRIMARY KEY,
       attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
       token_hash TEXT NOT NULL UNIQUE,
       expires_at BIGINT,
       created_at BIGINT NOT NULL,
       revoked_at BIGINT,
       password_hash TEXT,
       max_uses BIGINT,
       used_count BIGINT NOT NULL DEFAULT 0,
       require_email INTEGER NOT NULL DEFAULT 0,
       allowed_emails TEXT
     );
     CREATE INDEX IF NOT EXISTS idx_share_links_attachment ON share_links(attachment_id)`,
  ),
  defineMigration(
    "attachments_0005_access_grants",
    `CREATE TABLE IF NOT EXISTS access_grants (
       id TEXT PRIMARY KEY,
       share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
       email TEXT NOT NULL,
       token_hash TEXT NOT NULL UNIQUE,
       created_at BIGINT NOT NULL,
       expires_at BIGINT NOT NULL,
       consumed_at BIGINT
     );
     CREATE INDEX IF NOT EXISTS idx_access_grants_share_link ON access_grants(share_link_id)`,
  ),
  defineMigration(
    "attachments_0006_feedback",
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
  ),
  defineMigration(
    "attachments_0007_feedback_contract_fields",
    `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS service TEXT;
     ALTER TABLE feedback ADD COLUMN IF NOT EXISTS version TEXT;
     ALTER TABLE feedback ADD COLUMN IF NOT EXISTS timestamp TEXT;
     ALTER TABLE feedback ADD COLUMN IF NOT EXISTS email TEXT;
     ALTER TABLE feedback ALTER COLUMN service SET DEFAULT 'attachments';
     ALTER TABLE feedback ALTER COLUMN version SET DEFAULT 'unknown';
     ALTER TABLE feedback ALTER COLUMN timestamp SET DEFAULT NOW()::text;
     UPDATE feedback
       SET service = 'attachments'
       WHERE service IS NULL OR btrim(service) = '';
     UPDATE feedback
       SET version = 'unknown'
       WHERE version IS NULL OR btrim(version) = '';
     UPDATE feedback
       SET timestamp = COALESCE(NULLIF(timestamp, ''), created_at, NOW()::text)
       WHERE timestamp IS NULL OR btrim(timestamp) = '';
     ALTER TABLE feedback ALTER COLUMN service SET NOT NULL;
     ALTER TABLE feedback ALTER COLUMN version SET NOT NULL;
     ALTER TABLE feedback ALTER COLUMN timestamp SET NOT NULL`,
  ),
];

/**
 * Ordered migrations for the attachments cloud schema, including the shared
 * api_keys table from @hasna/contracts. Feed straight into the kit's
 * MigrationLedger.
 */
export const ATTACHMENTS_MIGRATIONS: readonly Migration[] = [
  ...CORE_MIGRATIONS,
  ...apiKeyMigrations().map((m) => defineMigration(m.id, m.sql)),
];
