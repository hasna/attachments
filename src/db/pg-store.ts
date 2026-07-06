/**
 * Postgres-backed metadata store for the attachments serve service.
 *
 * PURE REMOTE (Amendment A1): every read and write hits the cloud Postgres
 * directly through the vendored storage kit's TypedQueryClient. There is no
 * cache, mirror, or sync engine in the service.
 *
 * Mirrors the operational surface of the local SQLite `AttachmentsDB` used by
 * the CLI, re-implemented as async against Postgres so the HTTP API can wrap
 * the same object-storage + link core without the local database.
 */

import type { TypedQueryClient } from "../generated/storage-kit/query.js";
import type { Attachment, ShareLink } from "../core/db.js";
import { buildPasswordHash, generateShareToken, hashShareToken } from "../core/security.js";

type AttachmentRow = {
  id: string;
  filename: string;
  s3_key: string;
  bucket: string;
  size: string | number;
  content_type: string;
  link: string | null;
  tag: string | null;
  expires_at: string | number | null;
  created_at: string | number;
  storage_backend: string | null;
  status: string | null;
  encryption_algorithm: string | null;
  encryption_salt: string | null;
  encryption_iv: string | null;
  encryption_tag: string | null;
  downloads: string | number | null;
};

type ShareLinkRow = {
  id: string;
  attachment_id: string;
  token_hash: string;
  expires_at: string | number | null;
  created_at: string | number;
  revoked_at: string | number | null;
  password_hash: string | null;
  max_uses: string | number | null;
  used_count: string | number;
  require_email: number | null;
  allowed_emails: string | null;
};

function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function numOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : Number(value);
}

function parseAllowedEmails(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed.map((e) => String(e));
    return null;
  } catch {
    return null;
  }
}

function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    s3Key: row.s3_key,
    bucket: row.bucket,
    size: num(row.size),
    contentType: row.content_type,
    link: row.link,
    tag: row.tag,
    expiresAt: numOrNull(row.expires_at),
    createdAt: num(row.created_at),
    storageBackend: (row.storage_backend as "local" | "s3") ?? "s3",
    status: (row.status as "ready" | "pending") ?? "ready",
    encryptionAlgorithm: row.encryption_algorithm ?? null,
    encryptionSalt: row.encryption_salt ?? null,
    encryptionIv: row.encryption_iv ?? null,
    encryptionTag: row.encryption_tag ?? null,
    downloads: num(row.downloads),
  };
}

function rowToShareLink(row: ShareLinkRow): ShareLink {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    tokenHash: row.token_hash,
    expiresAt: numOrNull(row.expires_at),
    createdAt: num(row.created_at),
    revokedAt: numOrNull(row.revoked_at),
    passwordHash: row.password_hash,
    maxUses: numOrNull(row.max_uses),
    usedCount: num(row.used_count),
    requireEmail: row.require_email === 1,
    allowedEmails: parseAllowedEmails(row.allowed_emails),
  };
}

export class PgAttachmentsStore {
  constructor(private readonly client: TypedQueryClient) {}

  async insert(attachment: Attachment): Promise<void> {
    await this.client.execute(
      `INSERT INTO attachments
        (id, filename, s3_key, bucket, size, content_type, link, tag, expires_at, created_at,
         storage_backend, status, encryption_algorithm, encryption_salt, encryption_iv, encryption_tag, downloads)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        attachment.id,
        attachment.filename,
        attachment.s3Key,
        attachment.bucket,
        attachment.size,
        attachment.contentType,
        attachment.link,
        attachment.tag,
        attachment.expiresAt,
        attachment.createdAt,
        attachment.storageBackend ?? "s3",
        attachment.status ?? "ready",
        attachment.encryptionAlgorithm ?? null,
        attachment.encryptionSalt ?? null,
        attachment.encryptionIv ?? null,
        attachment.encryptionTag ?? null,
        attachment.downloads ?? 0,
      ],
    );
  }

  async markReady(input: {
    id: string;
    size: number;
    contentType?: string;
    link?: string | null;
    expiresAt?: number | null;
  }): Promise<void> {
    await this.client.execute(
      `UPDATE attachments
         SET status = 'ready',
             size = $2,
             content_type = COALESCE($3, content_type),
             link = COALESCE($4, link),
             expires_at = $5
       WHERE id = $1`,
      [input.id, input.size, input.contentType ?? null, input.link ?? null, input.expiresAt ?? null],
    );
  }

  async findById(id: string): Promise<Attachment | null> {
    const row = await this.client.get<AttachmentRow>(`SELECT * FROM attachments WHERE id = $1`, [id]);
    return row ? rowToAttachment(row) : null;
  }

  async findAll(opts?: { limit?: number; includeExpired?: boolean; tag?: string }): Promise<Attachment[]> {
    const includeExpired = opts?.includeExpired ?? false;
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (!includeExpired) {
      params.push(Date.now());
      conditions.push(`(expires_at IS NULL OR expires_at > $${params.length})`);
    }
    if (opts?.tag != null) {
      params.push(opts.tag);
      conditions.push(`tag = $${params.length}`);
    }
    let sql = `SELECT * FROM attachments`;
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += ` ORDER BY created_at DESC`;
    if (opts?.limit != null) {
      params.push(opts.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const rows = await this.client.many<AttachmentRow>(sql, params);
    return rows.map(rowToAttachment);
  }

  async updateLink(id: string, link: string, expiresAt?: number | null): Promise<void> {
    await this.client.execute(`UPDATE attachments SET link = $2, expires_at = $3 WHERE id = $1`, [
      id,
      link,
      expiresAt ?? null,
    ]);
  }

  async incrementDownloads(id: string): Promise<void> {
    await this.client.execute(`UPDATE attachments SET downloads = downloads + 1 WHERE id = $1`, [id]);
  }

  async delete(id: string): Promise<void> {
    await this.client.execute(`DELETE FROM attachments WHERE id = $1`, [id]);
  }

  async deleteExpired(): Promise<number> {
    const result = await this.client.query(
      `DELETE FROM attachments WHERE expires_at IS NOT NULL AND expires_at <= $1`,
      [Date.now()],
    );
    return result.rowCount;
  }

  async createShareLink(input: {
    attachmentId: string;
    expiresAt: number | null;
    password?: string;
    maxUses?: number | null;
    requireEmail?: boolean;
    allowedEmails?: string[] | null;
  }): Promise<{ shareLink: ShareLink; token: string }> {
    const token = generateShareToken();
    const now = Date.now();
    const allowedEmails =
      input.allowedEmails && input.allowedEmails.length > 0 ? input.allowedEmails : null;
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
      requireEmail: input.requireEmail === true,
      allowedEmails,
    };
    await this.client.execute(
      `INSERT INTO share_links
        (id, attachment_id, token_hash, expires_at, created_at, revoked_at, password_hash, max_uses, used_count, require_email, allowed_emails)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        shareLink.id,
        shareLink.attachmentId,
        shareLink.tokenHash,
        shareLink.expiresAt,
        shareLink.createdAt,
        shareLink.revokedAt,
        shareLink.passwordHash,
        shareLink.maxUses,
        shareLink.usedCount,
        shareLink.requireEmail ? 1 : 0,
        allowedEmails ? JSON.stringify(allowedEmails) : null,
      ],
    );
    return { shareLink, token };
  }

  async findShareLinkByToken(token: string): Promise<ShareLink | null> {
    const row = await this.client.get<ShareLinkRow>(`SELECT * FROM share_links WHERE token_hash = $1`, [
      hashShareToken(token),
    ]);
    return row ? rowToShareLink(row) : null;
  }

  async findShareLinksByAttachmentId(attachmentId: string): Promise<ShareLink[]> {
    const rows = await this.client.many<ShareLinkRow>(
      `SELECT * FROM share_links WHERE attachment_id = $1 ORDER BY created_at DESC`,
      [attachmentId],
    );
    return rows.map(rowToShareLink);
  }

  async consumeShareLink(id: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE share_links
         SET used_count = used_count + 1
       WHERE id = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > $2)
         AND (max_uses IS NULL OR used_count < max_uses)`,
      [id, Date.now()],
    );
    return result.rowCount > 0;
  }

  async releaseShareLink(id: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE share_links SET used_count = used_count - 1 WHERE id = $1 AND used_count > 0`,
      [id],
    );
    return result.rowCount > 0;
  }
}
