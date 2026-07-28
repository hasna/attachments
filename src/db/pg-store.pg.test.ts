/**
 * Live-PostgreSQL coverage for PgAttachmentsStore — the store `attachments-serve`
 * actually runs on. Part of the gate declared in hasna.contract.json
 * (storage.pgTestGate).
 *
 * The src/serve suites swap this class for `InMemoryAttachmentsStore`, so the
 * SQL below — placeholder numbering, BIGINT round-tripping, the share-link
 * consume/release race guards — has no other coverage anywhere in the repo.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MigrationLedger } from "../generated/storage-kit/migrations.js";
import type { Attachment } from "../core/db.js";
import { ATTACHMENTS_MIGRATIONS } from "./migrations.js";
import { PgAttachmentsStore } from "./pg-store.js";
import { LIVE_PG_ENABLED, createLiveSchema, type LiveSchema } from "./pg-live.test-harness.test.js";

function attachmentFixture(id: string, overrides: Partial<Attachment> = {}): Attachment {
  return {
    id,
    filename: `${id}.pdf`,
    s3Key: `uploads/${id}.pdf`,
    bucket: "attachments-test",
    size: 4_294_967_296, // > 2^32: proves BIGINT survives the round trip
    contentType: "application/pdf",
    link: null,
    tag: null,
    expiresAt: null,
    createdAt: Date.now(),
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

describe.skipIf(!LIVE_PG_ENABLED)("PgAttachmentsStore against live PostgreSQL", () => {
  let live: LiveSchema;
  let store: PgAttachmentsStore;

  beforeAll(async () => {
    live = await createLiveSchema("store");
    await new MigrationLedger(live.client, ATTACHMENTS_MIGRATIONS).migrate();
    store = new PgAttachmentsStore(live.client);
  }, 60_000);

  afterAll(async () => {
    await live?.drop();
  });

  it("round-trips an attachment through insert, find, update and delete", async () => {
    const attachment = attachmentFixture("att_roundtrip", { tag: "invoices" });
    await store.insert(attachment);

    const found = await store.findById(attachment.id);
    expect(found).toEqual(attachment);

    await store.updateLink(attachment.id, "https://example.test/a/xyz", attachment.createdAt + 60_000);
    await store.incrementDownloads(attachment.id);
    const updated = await store.findById(attachment.id);
    expect(updated?.link).toBe("https://example.test/a/xyz");
    expect(updated?.expiresAt).toBe(attachment.createdAt + 60_000);
    expect(updated?.downloads).toBe(1);

    expect(await store.findAll({ tag: "invoices" })).toHaveLength(1);
    expect(await store.findAll({ tag: "receipts" })).toHaveLength(0);

    await store.delete(attachment.id);
    expect(await store.findById(attachment.id)).toBeNull();
  });

  it("marks a pending upload ready without clobbering the stored content type", async () => {
    const attachment = attachmentFixture("att_pending", { size: 0, status: "pending" });
    await store.insert(attachment);

    await store.markReady({ id: attachment.id, size: 2048, expiresAt: null });
    const ready = await store.findById(attachment.id);
    expect(ready?.status).toBe("ready");
    expect(ready?.size).toBe(2048);
    expect(ready?.contentType).toBe("application/pdf");

    await store.delete(attachment.id);
  });

  it("hides expired rows from findAll and sweeps them on deleteExpired", async () => {
    const expired = attachmentFixture("att_expired", { expiresAt: Date.now() - 60_000 });
    const live_ = attachmentFixture("att_live", { expiresAt: Date.now() + 3_600_000 });
    await store.insert(expired);
    await store.insert(live_);

    const visible = (await store.findAll()).map((row) => row.id);
    expect(visible).toContain(live_.id);
    expect(visible).not.toContain(expired.id);
    expect((await store.findAll({ includeExpired: true })).map((row) => row.id)).toContain(expired.id);

    expect(await store.deleteExpired()).toBe(1);
    expect(await store.findById(expired.id)).toBeNull();
    expect(await store.findById(live_.id)).not.toBeNull();

    await store.delete(live_.id);
  });

  it("enforces share-link max uses and releases a reserved use", async () => {
    const attachment = attachmentFixture("att_share");
    await store.insert(attachment);

    const { shareLink, token } = await store.createShareLink({
      attachmentId: attachment.id,
      expiresAt: null,
      maxUses: 1,
      allowedEmails: ["ops@example.test"],
    });

    const byToken = await store.findShareLinkByToken(token);
    expect(byToken?.id).toBe(shareLink.id);
    expect(byToken?.allowedEmails).toEqual(["ops@example.test"]);
    expect(byToken?.requireEmail).toBe(false);
    expect(await store.findShareLinkByToken("not-a-real-token")).toBeNull();

    expect(await store.consumeShareLink(shareLink.id)).toBe(true);
    expect(await store.consumeShareLink(shareLink.id)).toBe(false); // max_uses reached
    expect(await store.releaseShareLink(shareLink.id)).toBe(true);
    expect(await store.consumeShareLink(shareLink.id)).toBe(true);

    expect(await store.findShareLinksByAttachmentId(attachment.id)).toHaveLength(1);

    // The FK cascades, so deleting the attachment must take the link with it.
    await store.delete(attachment.id);
    expect(await store.findShareLinkByToken(token)).toBeNull();
  });

  it("refuses to consume an expired share link", async () => {
    const attachment = attachmentFixture("att_share_expired");
    await store.insert(attachment);
    const { shareLink } = await store.createShareLink({
      attachmentId: attachment.id,
      expiresAt: Date.now() - 1_000,
    });

    expect(await store.consumeShareLink(shareLink.id)).toBe(false);
    await store.delete(attachment.id);
  });

  it("stores feedback using the server-side id and timestamp defaults", async () => {
    await store.saveFeedback({ message: "gate works", email: null, category: "bug", version: "1.1.5" });

    const row = await live.client.get<{ id: string; message: string; created_at: string }>(
      `SELECT id, message, created_at FROM feedback WHERE message = $1`,
      ["gate works"],
    );
    expect(row?.id).toBeString();
    expect(row?.created_at).toBeString();
  });
});
