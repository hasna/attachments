import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

export interface Attachment {
  id: string;
  filename: string;
  s3Key: string;
  bucket: string;
  size: number;
  contentType: string;
  link: string | null;
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
        const dir = join(homedir(), ".attachments");
        mkdirSync(dir, { recursive: true });
        return join(dir, "db.sqlite");
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
        expires_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
  }

  insert(attachment: Attachment): void {
    this.db
      .prepare(
        `INSERT INTO attachments
          (id, filename, s3_key, bucket, size, content_type, link, expires_at, created_at)
         VALUES
          ($id, $filename, $s3_key, $bucket, $size, $content_type, $link, $expires_at, $created_at)`
      )
      .run({
        $id: attachment.id,
        $filename: attachment.filename,
        $s3_key: attachment.s3Key,
        $bucket: attachment.bucket,
        $size: attachment.size,
        $content_type: attachment.contentType,
        $link: attachment.link,
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
  }): Attachment[] {
    const includeExpired = opts?.includeExpired ?? false;
    const limit = opts?.limit;
    const now = Date.now();

    let sql = `SELECT * FROM attachments`;
    const params: (number | string)[] = [];

    if (!includeExpired) {
      sql += ` WHERE (expires_at IS NULL OR expires_at > ?)`;
      params.push(now);
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

  close(): void {
    this.db.close();
  }
}
