/**
 * Shared harness for the `attachments-serve` (cloud) tests.
 *
 * `InMemoryAttachmentsStore` implements the slice of `PgAttachmentsStore` the
 * serve app uses, so the HTTP surface can be exercised end to end — upload,
 * share-link creation, public download — without a Postgres instance. It is
 * deliberately a plain object graph: the tests assert on stored rows
 * (`usedCount`, `revokedAt`, …) to prove the routes really mutate state.
 *
 * Named `*.test.ts` to match the existing `server.test-harness.test.ts`
 * convention in this repo (the runner tolerates a file with no tests).
 */
import type { Attachment, ShareLink } from "../core/db.js";
import { buildPasswordHash, generateShareToken, hashShareToken } from "../core/security.js";

export class InMemoryAttachmentsStore {
  readonly attachments: Attachment[] = [];
  readonly shareLinks: ShareLink[] = [];
  readonly feedback: unknown[] = [];

  async insert(attachment: Attachment): Promise<void> {
    this.attachments.push({ ...attachment });
  }

  async findById(id: string): Promise<Attachment | null> {
    return this.attachments.find((a) => a.id === id) ?? null;
  }

  async findAll(opts?: { limit?: number; includeExpired?: boolean; tag?: string }): Promise<Attachment[]> {
    const now = Date.now();
    let rows = this.attachments.slice().reverse();
    if (!opts?.includeExpired) rows = rows.filter((a) => a.expiresAt === null || a.expiresAt > now);
    if (opts?.tag != null) rows = rows.filter((a) => a.tag === opts.tag);
    return opts?.limit != null ? rows.slice(0, opts.limit) : rows;
  }

  async updateLink(id: string, link: string, expiresAt?: number | null): Promise<void> {
    const row = this.attachments.find((a) => a.id === id);
    if (!row) return;
    row.link = link;
    row.expiresAt = expiresAt ?? null;
  }

  async incrementDownloads(id: string): Promise<void> {
    const row = this.attachments.find((a) => a.id === id);
    if (row) row.downloads = (row.downloads ?? 0) + 1;
  }

  async delete(id: string): Promise<void> {
    const index = this.attachments.findIndex((a) => a.id === id);
    if (index >= 0) this.attachments.splice(index, 1);
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
    const shareLink: ShareLink = {
      id: `share_${generateShareToken().slice(0, 16)}`,
      attachmentId: input.attachmentId,
      tokenHash: hashShareToken(token),
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
      revokedAt: null,
      passwordHash: input.password ? buildPasswordHash(input.password) : null,
      maxUses: input.maxUses ?? null,
      usedCount: 0,
      requireEmail: input.requireEmail === true,
      allowedEmails: input.allowedEmails ?? null,
    };
    this.shareLinks.push(shareLink);
    return { shareLink, token };
  }

  async findShareLinkByToken(token: string): Promise<ShareLink | null> {
    const hash = hashShareToken(token);
    return this.shareLinks.find((l) => l.tokenHash === hash) ?? null;
  }

  async consumeShareLink(id: string): Promise<boolean> {
    const link = this.shareLinks.find((l) => l.id === id);
    if (!link) return false;
    if (link.revokedAt !== null) return false;
    if (link.expiresAt !== null && link.expiresAt <= Date.now()) return false;
    if (link.maxUses !== null && link.usedCount >= link.maxUses) return false;
    link.usedCount += 1;
    return true;
  }

  async releaseShareLink(id: string): Promise<boolean> {
    const link = this.shareLinks.find((l) => l.id === id);
    if (!link || link.usedCount <= 0) return false;
    link.usedCount -= 1;
    return true;
  }

  async saveFeedback(input: unknown): Promise<void> {
    this.feedback.push(input);
  }
}

/** Minimal query client: enough for the /health and /ready probes. */
export function stubQueryClient() {
  const client = {
    async query(sql: string) {
      if (/SELECT 1/.test(sql)) return { rows: [{ ok: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async many(sql: string) {
      return (await client.query(sql)).rows;
    },
    async get(sql: string) {
      return (await client.query(sql)).rows[0] ?? null;
    },
    async one(sql: string) {
      return (await client.query(sql)).rows[0];
    },
    async execute() {},
    pool: {} as never,
    async transaction<T>(fn: (c: unknown) => Promise<T>) {
      return fn(client);
    },
    async close() {},
  };
  return client as unknown;
}
