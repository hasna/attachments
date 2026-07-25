/**
 * The share-access policy is shared by the on-box SQLite server and the cloud
 * Postgres service. These tests pin the policy itself (the pure guards) and the
 * async resolver the cloud service uses, so the two deployments cannot drift.
 */
import { describe, expect, test } from "bun:test";
import type { Attachment, ShareLink } from "./db";
import { buildPasswordHash } from "./security";
import {
  ShareAccessError,
  assertAttachmentUsable,
  assertShareLinkUsable,
  resolveShareAccessAsync,
  type AsyncShareAccessSource,
} from "./share";

const NOW = 1_800_000_000_000;

function link(over: Partial<ShareLink> = {}): ShareLink {
  return {
    id: "share_1",
    attachmentId: "att_1",
    tokenHash: "hash",
    expiresAt: NOW + 60_000,
    createdAt: NOW - 60_000,
    revokedAt: null,
    passwordHash: null,
    maxUses: null,
    usedCount: 0,
    requireEmail: false,
    allowedEmails: null,
    ...over,
  };
}

function attachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: "att_1",
    filename: "f.txt",
    s3Key: "k",
    bucket: "b",
    size: 3,
    contentType: "text/plain",
    link: null,
    tag: null,
    expiresAt: NOW + 60_000,
    createdAt: NOW - 60_000,
    storageBackend: "s3",
    status: "ready",
    encryptionAlgorithm: null,
    encryptionSalt: null,
    encryptionIv: null,
    encryptionTag: null,
    downloads: 0,
    ...over,
  };
}

function statusOf(fn: () => unknown): number | string {
  try {
    fn();
    return "ok";
  } catch (err) {
    return err instanceof ShareAccessError ? err.status : "other";
  }
}

describe("assertShareLinkUsable", () => {
  test("accepts a live link", () => {
    expect(statusOf(() => assertShareLinkUsable(link(), { now: NOW, consume: false }))).toBe("ok");
  });

  test("404 for a missing token, 410 for revoked / expired / exhausted", () => {
    expect(statusOf(() => assertShareLinkUsable(null, { now: NOW }))).toBe(404);
    expect(statusOf(() => assertShareLinkUsable(link({ revokedAt: NOW }), { now: NOW }))).toBe(410);
    expect(statusOf(() => assertShareLinkUsable(link({ expiresAt: NOW }), { now: NOW }))).toBe(410);
    expect(statusOf(() => assertShareLinkUsable(link({ maxUses: 1, usedCount: 1 }), { now: NOW }))).toBe(410);
  });

  test("a never-expiring link stays usable", () => {
    expect(statusOf(() => assertShareLinkUsable(link({ expiresAt: null }), { now: NOW, consume: false }))).toBe("ok");
  });

  test("401 for a wrong password, ok for the right one", () => {
    const protectedLink = link({ passwordHash: buildPasswordHash("Parola-Test-1") });
    expect(statusOf(() => assertShareLinkUsable(protectedLink, { now: NOW, requirePassword: true }))).toBe(401);
    expect(
      statusOf(() => assertShareLinkUsable(protectedLink, { now: NOW, requirePassword: true, password: "nope" })),
    ).toBe(401);
    expect(
      statusOf(() =>
        assertShareLinkUsable(protectedLink, { now: NOW, requirePassword: true, password: "Parola-Test-1" }),
      ),
    ).toBe("ok");
  });

  test("metadata reads (consume:false, no password given) do not demand the password", () => {
    const protectedLink = link({ passwordHash: buildPasswordHash("Parola-Test-1") });
    expect(statusOf(() => assertShareLinkUsable(protectedLink, { now: NOW, consume: false }))).toBe("ok");
  });
});

describe("assertAttachmentUsable", () => {
  test("404 missing, 410 expired, 404 still uploading", () => {
    expect(statusOf(() => assertAttachmentUsable(null, { now: NOW }))).toBe(404);
    expect(statusOf(() => assertAttachmentUsable(attachment({ expiresAt: NOW }), { now: NOW }))).toBe(410);
    expect(statusOf(() => assertAttachmentUsable(attachment({ status: "pending" }), { now: NOW }))).toBe(404);
    expect(statusOf(() => assertAttachmentUsable(attachment(), { now: NOW }))).toBe("ok");
  });
});

function source(over: Partial<AsyncShareAccessSource> & { link?: ShareLink | null } = {}): AsyncShareAccessSource & {
  consumed: string[];
  incremented: string[];
} {
  const consumed: string[] = [];
  const incremented: string[] = [];
  return {
    consumed,
    incremented,
    async findShareLinkByToken() {
      return over.link === undefined ? link() : over.link;
    },
    async findById() {
      return attachment();
    },
    async consumeShareLink(id: string) {
      consumed.push(id);
      return true;
    },
    async incrementDownloads(id: string) {
      incremented.push(id);
    },
    ...over,
  };
}

describe("resolveShareAccessAsync", () => {
  test("returns the attachment and link for a usable token", async () => {
    const result = await resolveShareAccessAsync(source(), "tok", { now: NOW, consume: false });
    expect(result.attachment.id).toBe("att_1");
    expect(result.shareLink.id).toBe("share_1");
  });

  test("propagates the policy error for an unknown token", async () => {
    const err = await resolveShareAccessAsync(source({ link: null }), "tok", { now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(ShareAccessError);
    expect((err as ShareAccessError).status).toBe(404);
  });

  test("consume:true burns exactly one use and counts one download", async () => {
    const src = source();
    await resolveShareAccessAsync(src, "tok", { now: NOW, consume: true });
    expect(src.consumed).toEqual(["share_1"]);
    expect(src.incremented).toEqual(["att_1"]);
  });

  test("a lost race on consume becomes 410, not a silent success", async () => {
    const src = source({ async consumeShareLink() { return false; } });
    const err = await resolveShareAccessAsync(src, "tok", { now: NOW, consume: true }).catch((e) => e);
    expect((err as ShareAccessError).status).toBe(410);
  });

  test("does not consume anything when the password is wrong", async () => {
    const src = source({ link: link({ passwordHash: buildPasswordHash("Parola-Test-1") }) });
    const err = await resolveShareAccessAsync(src, "tok", {
      now: NOW,
      consume: true,
      password: "gresit",
    }).catch((e) => e);
    expect((err as ShareAccessError).status).toBe(401);
    expect(src.consumed).toEqual([]);
  });
});
