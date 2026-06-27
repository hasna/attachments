import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { cpSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { buildPasswordHash, generateShareToken, hashShareToken } from "./security";

export interface Attachment {
  id: string;
  filename: string;
  s3Key: string;
  bucket: string;
  size: number;
  contentType: string;
  link: string | null;
  tag: string | null;
  expiresAt: number | null; // unix timestamp in ms, null = no expiry
  createdAt: number; // unix timestamp in ms
  storageBackend?: "local" | "s3";
  status?: "ready" | "pending";
  encryptionAlgorithm?: string | null;
  encryptionSalt?: string | null;
  encryptionIv?: string | null;
  encryptionTag?: string | null;
  downloads?: number;
}

export interface ShareLink {
  id: string;
  attachmentId: string;
  tokenHash: string;
  expiresAt: number | null;
  createdAt: number;
  revokedAt: number | null;
  passwordHash: string | null;
  maxUses: number | null;
  usedCount: number;
}

interface AttachmentRow {
  id: string;
  filename: string;
  s3_key: string;
  bucket: string;
  size: number;
  content_type: string;
  link: string | null;
  tag: string | null;
  expires_at: number | null;
  created_at: number;
  storage_backend?: "local" | "s3";
  status?: "ready" | "pending";
  encryption_algorithm?: string | null;
  encryption_salt?: string | null;
  encryption_iv?: string | null;
  encryption_tag?: string | null;
  downloads?: number;
}

interface ShareLinkRow {
  id: string;
  attachment_id: string;
  token_hash: string;
  expires_at: number | null;
  created_at: number;
  revoked_at: number | null;
  password_hash: string | null;
  max_uses: number | null;
  used_count: number;
}

function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    s3Key: row.s3_key,
    bucket: row.bucket,
    size: row.size,
    contentType: row.content_type,
    link: row.link,
    tag: row.tag,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    storageBackend: row.storage_backend ?? "s3",
    status: row.status ?? "ready",
    encryptionAlgorithm: row.encryption_algorithm ?? null,
    encryptionSalt: row.encryption_salt ?? null,
    encryptionIv: row.encryption_iv ?? null,
    encryptionTag: row.encryption_tag ?? null,
    downloads: row.downloads ?? 0,
  };
}

function rowToShareLink(row: ShareLinkRow): ShareLink {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    passwordHash: row.password_hash,
    maxUses: row.max_uses,
    usedCount: row.used_count,
  };
}

export class AttachmentsDB {
  private db: Database;

  constructor(dbPath?: string) {
    const resolvedPath =
      dbPath ??
      (() => {
        const home = process.env["HOME"] || process.env["USERPROFILE"] || homedir();
        const newDir = join(home, ".hasna", "attachments");
        const oldDirs = [join(home, ".open-attachments"), join(home, ".attachments")];

        // Auto-migrate: if a legacy dir exists and new doesn't, copy contents over.
        for (const oldDir of oldDirs) {
          if (!existsSync(oldDir) || existsSync(newDir)) continue;
          try {
            mkdirSync(join(home, ".hasna"), { recursive: true });
            cpSync(oldDir, newDir, { recursive: true, force: false });
            break;
          } catch {
            // If we can't read/copy the old directory, continue.
          }
        }

        mkdirSync(newDir, { recursive: true });
        const oldDb = join(newDir, "attachments.db");
        const newDb = join(newDir, "db.sqlite");
        if (existsSync(oldDb) && !existsSync(newDb)) {
          copyFileSync(oldDb, newDb);
        }
        return newDb;
      })();

    this.db = new Database(resolvedPath);
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA foreign_keys = ON;");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        s3_key TEXT NOT NULL,
        bucket TEXT NOT NULL,
        size INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        link TEXT,
        tag TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        storage_backend TEXT NOT NULL DEFAULT 's3',
        status TEXT NOT NULL DEFAULT 'ready',
        encryption_algorithm TEXT,
        encryption_salt TEXT,
        encryption_iv TEXT,
        encryption_tag TEXT,
        downloads INTEGER NOT NULL DEFAULT 0
      );
    `);

    this.addColumnIfMissing("attachments", "tag", "TEXT");
    this.addColumnIfMissing("attachments", "storage_backend", "TEXT NOT NULL DEFAULT 's3'");
    this.addColumnIfMissing("attachments", "status", "TEXT NOT NULL DEFAULT 'ready'");
    this.addColumnIfMissing("attachments", "encryption_algorithm", "TEXT");
    this.addColumnIfMissing("attachments", "encryption_salt", "TEXT");
    this.addColumnIfMissing("attachments", "encryption_iv", "TEXT");
    this.addColumnIfMissing("attachments", "encryption_tag", "TEXT");
    this.addColumnIfMissing("attachments", "downloads", "INTEGER NOT NULL DEFAULT 0");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS share_links (
        id TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        password_hash TEXT,
        max_uses INTEGER,
        used_count INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Feedback table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        message TEXT NOT NULL,
        email TEXT,
        category TEXT DEFAULT 'general',
        version TEXT,
        machine_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    try {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch {
      // Column already exists.
    }
  }

  insert(attachment: Attachment): void {
    this.db
      .prepare(
        `INSERT INTO attachments
          (id, filename, s3_key, bucket, size, content_type, link, tag, expires_at, created_at)
         VALUES
          ($id, $filename, $s3_key, $bucket, $size, $content_type, $link, $tag, $expires_at, $created_at)`
      )
      .run({
        $id: attachment.id,
        $filename: attachment.filename,
        $s3_key: attachment.s3Key,
        $bucket: attachment.bucket,
        $size: attachment.size,
        $content_type: attachment.contentType,
        $link: attachment.link,
        $tag: attachment.tag,
        $expires_at: attachment.expiresAt,
        $created_at: attachment.createdAt,
      });

    this.db
      .prepare(
        `UPDATE attachments
         SET storage_backend = $storage_backend,
             status = $status,
             encryption_algorithm = $encryption_algorithm,
             encryption_salt = $encryption_salt,
             encryption_iv = $encryption_iv,
             encryption_tag = $encryption_tag,
             downloads = $downloads
         WHERE id = $id`
      )
      .run({
        $id: attachment.id,
        $storage_backend: attachment.storageBackend ?? "s3",
        $status: attachment.status ?? "ready",
        $encryption_algorithm: attachment.encryptionAlgorithm ?? null,
        $encryption_salt: attachment.encryptionSalt ?? null,
        $encryption_iv: attachment.encryptionIv ?? null,
        $encryption_tag: attachment.encryptionTag ?? null,
        $downloads: attachment.downloads ?? 0,
      });
  }

  markReady(input: {
    id: string;
    size: number;
    contentType?: string;
    link?: string | null;
    expiresAt?: number | null;
  }): void {
    this.db
      .prepare(
        `UPDATE attachments
         SET status = 'ready',
             size = $size,
             content_type = COALESCE($content_type, content_type),
             link = COALESCE($link, link),
             expires_at = $expires_at
         WHERE id = $id`
      )
      .run({
        $id: input.id,
        $size: input.size,
        $content_type: input.contentType ?? null,
        $link: input.link ?? null,
        $expires_at: input.expiresAt !== undefined ? input.expiresAt : null,
      });
  }

  findById(id: string): Attachment | null {
    const row = this.db
      .prepare<AttachmentRow, string>(
        `SELECT * FROM attachments WHERE id = ?`
      )
      .get(id);
    return row ? rowToAttachment(row) : null;
  }

  findAll(opts?: {
    limit?: number;
    includeExpired?: boolean;
    tag?: string;
  }): Attachment[] {
    const includeExpired = opts?.includeExpired ?? false;
    const limit = opts?.limit;
    const tag = opts?.tag;
    const now = Date.now();

    let sql = `SELECT * FROM attachments`;
    const params: (number | string)[] = [];
    const conditions: string[] = [];

    if (!includeExpired) {
      conditions.push(`(expires_at IS NULL OR expires_at > ?)`);
      params.push(now);
    }

    if (tag != null) {
      conditions.push(`tag = ?`);
      params.push(tag);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    sql += ` ORDER BY created_at DESC`;

    if (limit != null) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = this.db
      .prepare<AttachmentRow, (number | string)[]>(sql)
      .all(...params);
    return rows.map(rowToAttachment);
  }

  updateLink(id: string, link: string, expiresAt?: number | null): void {
    this.db
      .prepare(
        `UPDATE attachments SET link = $link, expires_at = $expires_at WHERE id = $id`
      )
      .run({
        $id: id,
        $link: link,
        $expires_at: expiresAt !== undefined ? expiresAt : null,
      });
  }

  incrementDownloads(id: string): void {
    this.db.prepare(`UPDATE attachments SET downloads = downloads + 1 WHERE id = ?`).run(id);
  }

  createShareLink(input: {
    attachmentId: string;
    expiresAt: number | null;
    password?: string;
    maxUses?: number | null;
  }): { shareLink: ShareLink; token: string } {
    const token = generateShareToken();
    const now = Date.now();
    const shareLink: ShareLink = {
      id: `share_${generateShareToken().slice(0, 16)}`,
      attachmentId: input.attachmentId,
      tokenHash: hashShareToken(token),
      expiresAt: input.expiresAt,
      createdAt: now,
      revokedAt: null,
      passwordHash: input.password ? buildPasswordHash(input.password) : null,
      maxUses: input.maxUses ?? null,
      usedCount: 0,
    };

    this.db
      .prepare(
        `INSERT INTO share_links
          (id, attachment_id, token_hash, expires_at, created_at, revoked_at, password_hash, max_uses, used_count)
         VALUES
          ($id, $attachment_id, $token_hash, $expires_at, $created_at, $revoked_at, $password_hash, $max_uses, $used_count)`
      )
      .run({
        $id: shareLink.id,
        $attachment_id: shareLink.attachmentId,
        $token_hash: shareLink.tokenHash,
        $expires_at: shareLink.expiresAt,
        $created_at: shareLink.createdAt,
        $revoked_at: shareLink.revokedAt,
        $password_hash: shareLink.passwordHash,
        $max_uses: shareLink.maxUses,
        $used_count: shareLink.usedCount,
      });

    return { shareLink, token };
  }

  findShareLinkByToken(token: string): ShareLink | null {
    const row = this.db
      .prepare<ShareLinkRow, string>(`SELECT * FROM share_links WHERE token_hash = ?`)
      .get(hashShareToken(token));
    return row ? rowToShareLink(row) : null;
  }

  findShareLinksByAttachmentId(attachmentId: string): ShareLink[] {
    const rows = this.db
      .prepare<ShareLinkRow, string>(
        `SELECT * FROM share_links WHERE attachment_id = ? ORDER BY created_at DESC`
      )
      .all(attachmentId);
    return rows.map(rowToShareLink);
  }

  consumeShareLink(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE share_links
         SET used_count = used_count + 1
         WHERE id = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND (max_uses IS NULL OR used_count < max_uses)`
      )
      .run(id, Date.now());
    return result.changes > 0;
  }

  releaseShareLink(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE share_links
         SET used_count = used_count - 1
         WHERE id = ?
           AND used_count > 0`
      )
      .run(id);
    return result.changes > 0;
  }

  delete(id: string): void {
    this.db
      .prepare(`DELETE FROM attachments WHERE id = ?`)
      .run(id);
  }

  deleteExpired(): number {
    const now = Date.now();
    const result = this.db
      .prepare<unknown, number>(
        `DELETE FROM attachments WHERE expires_at IS NOT NULL AND expires_at <= ?`
      )
      .run(now);
    return result.changes;
  }

  run(sql: string, params?: unknown[]): void {
    if (params) {
      this.db.prepare(sql).run(...(params as never[]));
    } else {
      this.db.run(sql);
    }
  }

  get raw(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
