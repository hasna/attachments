import { SqliteAdapter as Database } from "@hasna/cloud";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, readdirSync, copyFileSync } from "fs";

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
        const oldDir = join(home, ".attachments");

        // Auto-migrate: if old dir exists and new doesn't, copy files over
        if (existsSync(oldDir) && !existsSync(newDir)) {
          mkdirSync(newDir, { recursive: true });
          try {
            for (const file of readdirSync(oldDir)) {
              const oldPath = join(oldDir, file);
              const newPath = join(newDir, file);
              try {
                const stat = require("fs").statSync(oldPath);
                if (stat.isFile()) {
                  copyFileSync(oldPath, newPath);
                }
              } catch {
                // Skip files that can't be copied
              }
            }
          } catch {
            // If we can't read the old directory, continue
          }
        }

        mkdirSync(newDir, { recursive: true });
        return join(newDir, "db.sqlite");
      })();

    this.db = new Database(resolvedPath);
    this.db.run("PRAGMA journal_mode = WAL;");
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
        created_at INTEGER NOT NULL
      );
    `);

    // Migration: add tag column if it doesn't exist (for existing databases)
    try {
      this.db.run(`ALTER TABLE attachments ADD COLUMN tag TEXT`);
    } catch {
      // Column already exists — ignore
    }

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
      this.db.prepare(sql).run(...params);
    } else {
      this.db.run(sql);
    }
  }

  close(): void {
    this.db.close();
  }
}
