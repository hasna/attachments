import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { AttachmentsDB, type Attachment } from "./db";
import {
  requestAccessGrant,
  verifyAccessGrant,
  EmailGateError,
  type EmailSender,
} from "./email-gate";

let counter = 0;
function makeDb(): { db: AttachmentsDB; path: string } {
  const path = join(tmpdir(), `att-emailgate-${process.pid}-${++counter}-${Date.now()}.sqlite`);
  return { db: new AttachmentsDB(path), path };
}

function makeAttachment(): Attachment {
  return {
    id: `att_eg_${++counter}`,
    filename: "FUNDATIA-HASNA-documente-semnate.zip",
    s3Key: "attachments/2026-06-29/att_eg/x.zip",
    bucket: "cloud",
    size: 1234,
    contentType: "application/zip",
    link: null,
    tag: null,
    expiresAt: null,
    createdAt: Date.now(),
  };
}

function seedRequireEmailLink(db: AttachmentsDB, allowedEmails: string[] | null = null): string {
  const att = makeAttachment();
  db.insert(att);
  const { token } = db.createShareLink({
    attachmentId: att.id,
    expiresAt: null,
    requireEmail: true,
    allowedEmails,
  });
  return token;
}

function makeSender() {
  const sent: Array<{ to: string; subject: string; text: string; html?: string }> = [];
  const sender: EmailSender = {
    send: async (m) => {
      sent.push(m);
    },
  };
  return { sender, sent };
}

describe("email-gate", () => {
  let dbHandle: { db: AttachmentsDB; path: string };
  beforeEach(() => {
    dbHandle = makeDb();
  });
  afterEach(() => {
    try {
      rmSync(dbHandle.path, { force: true });
    } catch {}
  });

  it("createShareLink persists requireEmail + allowedEmails", () => {
    const token = seedRequireEmailLink(dbHandle.db, ["a@bcr.ro", "B@BCR.RO"]);
    const link = dbHandle.db.findShareLinkByToken(token);
    expect(link?.requireEmail).toBe(true);
    expect(link?.allowedEmails).toEqual(["a@bcr.ro", "B@BCR.RO"]);
  });

  it("requestAccessGrant emails a unique access link for a valid email", async () => {
    const token = seedRequireEmailLink(dbHandle.db);
    const { sender, sent } = makeSender();
    let grantToken = "";
    const res = await requestAccessGrant({
      db: dbHandle.db,
      token,
      email: "Ionut.Babos@BCR.ro",
      sender,
      buildAccessUrl: (g) => {
        grantToken = g;
        return `https://has.na/a/${token}?grant=${g}`;
      },
      filename: "docs.zip",
    });
    expect(res.email).toBe("ionut.babos@bcr.ro"); // normalized
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ionut.babos@bcr.ro");
    expect(sent[0]!.text).toContain(grantToken);
    // the emailed grant must verify against this link
    const verified = verifyAccessGrant(dbHandle.db, token, grantToken);
    expect(verified.email).toBe("ionut.babos@bcr.ro");
  });

  it("rejects an invalid email with 400 and sends nothing", async () => {
    const token = seedRequireEmailLink(dbHandle.db);
    const { sender, sent } = makeSender();
    await expect(
      requestAccessGrant({ db: dbHandle.db, token, email: "not-an-email", sender, buildAccessUrl: (g) => g })
    ).rejects.toMatchObject({ status: 400 });
    expect(sent).toHaveLength(0);
  });

  it("enforces the allowlist (403 for disallowed, ok for allowed, case-insensitive)", async () => {
    const token = seedRequireEmailLink(dbHandle.db, ["Digital.Inbox@bcr.ro"]);
    const { sender, sent } = makeSender();
    await expect(
      requestAccessGrant({ db: dbHandle.db, token, email: "stranger@evil.com", sender, buildAccessUrl: (g) => g })
    ).rejects.toMatchObject({ status: 403 });
    expect(sent).toHaveLength(0);
    const ok = await requestAccessGrant({
      db: dbHandle.db,
      token,
      email: "DIGITAL.INBOX@BCR.RO",
      sender,
      buildAccessUrl: (g) => g,
    });
    expect(ok.email).toBe("digital.inbox@bcr.ro");
    expect(sent).toHaveLength(1);
  });

  it("refuses to gate a link that does not require email", async () => {
    const att = makeAttachment();
    dbHandle.db.insert(att);
    const { token } = dbHandle.db.createShareLink({ attachmentId: att.id, expiresAt: null });
    const { sender } = makeSender();
    await expect(
      requestAccessGrant({ db: dbHandle.db, token, email: "x@y.com", sender, buildAccessUrl: (g) => g })
    ).rejects.toBeInstanceOf(EmailGateError);
  });

  it("verifyAccessGrant rejects a wrong/foreign grant token (401) and expired grants (410)", async () => {
    const token = seedRequireEmailLink(dbHandle.db);
    expect(() => verifyAccessGrant(dbHandle.db, token, "bogus-grant")).toThrow(EmailGateError);
    try {
      verifyAccessGrant(dbHandle.db, token, "bogus-grant");
    } catch (e) {
      expect((e as EmailGateError).status).toBe(401);
    }
    // expired grant
    const { sender } = makeSender();
    let g = "";
    await requestAccessGrant({
      db: dbHandle.db,
      token,
      email: "a@b.com",
      sender,
      buildAccessUrl: (t) => (g = t),
      ttlMs: -1000,
    });
    try {
      verifyAccessGrant(dbHandle.db, token, g);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as EmailGateError).status).toBe(410);
    }
  });
});
