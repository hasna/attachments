import { describe, expect, it, mock, beforeEach } from "bun:test";
import { PgAttachmentsStore } from "./pg-store";
import type { Attachment } from "../core/db";

type Call = { sql: string; params: unknown[] };

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att_1",
    filename: "file.txt",
    s3Key: "attachments/2026-01-01/att_1/file.txt",
    bucket: "bucket",
    size: 12,
    contentType: "text/plain",
    link: null,
    tag: null,
    expiresAt: null,
    createdAt: 1_700_000_000_000,
    storageBackend: "s3",
    status: "ready",
    encryptionAlgorithm: null,
    encryptionSalt: null,
    encryptionIv: null,
    encryptionTag: null,
    downloads: 0,
    ...overrides,
  };
}

function attachmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "att_1",
    filename: "file.txt",
    s3_key: "attachments/2026-01-01/att_1/file.txt",
    bucket: "bucket",
    size: "12",
    content_type: "text/plain",
    link: null,
    tag: null,
    expires_at: null,
    created_at: "1700000000000",
    storage_backend: null,
    status: null,
    encryption_algorithm: null,
    encryption_salt: null,
    encryption_iv: null,
    encryption_tag: null,
    downloads: null,
    ...overrides,
  };
}

function shareRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "share_1",
    attachment_id: "att_1",
    token_hash: "hash",
    expires_at: null,
    created_at: "1700000000000",
    revoked_at: null,
    password_hash: null,
    max_uses: null,
    used_count: "0",
    require_email: 0,
    allowed_emails: null,
    ...overrides,
  };
}

function makeClient() {
  const calls: Call[] = [];
  const client = {
    execute: mock(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
    }),
    query: mock(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    }),
    get: mock(async (_sql: string, _params: unknown[] = []) => null as unknown),
    many: mock(async (_sql: string, _params: unknown[] = []) => [] as unknown[]),
  };
  return { client: client as never, calls };
}

describe("PgAttachmentsStore", () => {
  let setup: ReturnType<typeof makeClient>;

  beforeEach(() => {
    setup = makeClient();
  });

  it("inserts attachment metadata with defaults for optional columns", async () => {
    const store = new PgAttachmentsStore(setup.client);

    await store.insert(attachment({ storageBackend: undefined, status: undefined }));

    expect(setup.client.execute).toHaveBeenCalledTimes(1);
    expect(setup.calls[0]!.sql).toContain("INSERT INTO attachments");
    expect(setup.calls[0]!.params.slice(0, 6)).toEqual([
      "att_1",
      "file.txt",
      "attachments/2026-01-01/att_1/file.txt",
      "bucket",
      12,
      "text/plain",
    ]);
    expect(setup.calls[0]!.params[10]).toBe("s3");
    expect(setup.calls[0]!.params[11]).toBe("ready");
    expect(setup.calls[0]!.params[16]).toBe(0);
  });

  it("marks pending attachments ready", async () => {
    const store = new PgAttachmentsStore(setup.client);

    await store.markReady({ id: "att_1", size: 42, contentType: "image/png", link: "https://x", expiresAt: 123 });

    expect(setup.calls[0]!.sql).toContain("SET status = 'ready'");
    expect(setup.calls[0]!.params).toEqual(["att_1", 42, "image/png", "https://x", 123]);
  });

  it("maps attachment rows and returns null for missing ids", async () => {
    const store = new PgAttachmentsStore(setup.client);
    setup.client.get = mock(async () => attachmentRow({ storage_backend: "local", status: "pending", downloads: "3" }));

    await expect(store.findById("att_1")).resolves.toMatchObject({
      id: "att_1",
      s3Key: "attachments/2026-01-01/att_1/file.txt",
      size: 12,
      storageBackend: "local",
      status: "pending",
      downloads: 3,
    });

    setup.client.get = mock(async () => null);
    await expect(store.findById("missing")).resolves.toBeNull();
  });

  it("finds attachments with expiry, tag, and limit filters", async () => {
    const store = new PgAttachmentsStore(setup.client);
    setup.client.many = mock(async () => [attachmentRow({ tag: "task:x" })]);

    const rows = await store.findAll({ limit: 10, tag: "task:x" });

    expect(rows).toHaveLength(1);
    const [sql, params] = setup.client.many.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("expires_at IS NULL OR expires_at > $1");
    expect(sql).toContain("tag = $2");
    expect(sql).toContain("LIMIT $3");
    expect(params[1]).toBe("task:x");

    await store.findAll({ includeExpired: true });
    expect((setup.client.many.mock.calls[1] as [string, unknown[]])[0]).not.toContain("expires_at");
  });

  it("updates, increments, deletes, and removes expired rows", async () => {
    const store = new PgAttachmentsStore(setup.client);

    await store.updateLink("att_1", "https://link", 123);
    await store.incrementDownloads("att_1");
    await store.delete("att_1");
    const deleted = await store.deleteExpired();

    expect(deleted).toBe(1);
    expect(setup.calls.map((call) => call.sql)).toEqual([
      "UPDATE attachments SET link = $2, expires_at = $3 WHERE id = $1",
      "UPDATE attachments SET downloads = downloads + 1 WHERE id = $1",
      "DELETE FROM attachments WHERE id = $1",
      "DELETE FROM attachments WHERE expires_at IS NOT NULL AND expires_at <= $1",
    ]);
  });

  it("creates share links with hashed password and allowed emails", async () => {
    const store = new PgAttachmentsStore(setup.client);

    const result = await store.createShareLink({
      attachmentId: "att_1",
      expiresAt: 123,
      password: "pw",
      maxUses: 2,
      requireEmail: true,
      allowedEmails: ["a@example.test"],
    });

    expect(result.token).toBeTruthy();
    expect(result.shareLink.id.startsWith("share_")).toBe(true);
    expect(result.shareLink.passwordHash?.startsWith("scrypt$")).toBe(true);
    expect(setup.calls[0]!.sql).toContain("INSERT INTO share_links");
    expect(setup.calls[0]!.params[9]).toBe(1);
    expect(setup.calls[0]!.params[10]).toBe(JSON.stringify(["a@example.test"]));
  });

  it("maps share link rows including invalid or empty allowed email JSON", async () => {
    const store = new PgAttachmentsStore(setup.client);
    setup.client.get = mock(async () => shareRow({ require_email: 1, allowed_emails: "[\"a@example.test\"]" }));

    await expect(store.findShareLinkByToken("token")).resolves.toMatchObject({
      id: "share_1",
      attachmentId: "att_1",
      requireEmail: true,
      allowedEmails: ["a@example.test"],
      usedCount: 0,
    });

    setup.client.many = mock(async () => [
      shareRow({ id: "share_2", allowed_emails: "not-json" }),
      shareRow({ id: "share_3", allowed_emails: "[]" }),
    ]);
    await expect(store.findShareLinksByAttachmentId("att_1")).resolves.toEqual([
      expect.objectContaining({ id: "share_2", allowedEmails: null }),
      expect.objectContaining({ id: "share_3", allowedEmails: null }),
    ]);

    setup.client.get = mock(async () => null);
    await expect(store.findShareLinkByToken("missing")).resolves.toBeNull();
  });

  it("returns boolean results for share link consumption and release", async () => {
    const store = new PgAttachmentsStore(setup.client);

    await expect(store.consumeShareLink("share_1")).resolves.toBe(true);
    setup.client.query = mock(async () => ({ rowCount: 0, rows: [] }));
    await expect(store.releaseShareLink("share_1")).resolves.toBe(false);
  });
});
