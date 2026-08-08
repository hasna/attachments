import { describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AttachmentsDB, type Attachment } from "./db";
import { FriendlySlugError, parseFriendlySlug, requireFriendlySlugPassword } from "./friendly-slug";

describe("friendly slug validation", () => {
  test("accepts canonical lowercase dashed slugs", () => {
    expect(parseFriendlySlug("company-closing-packet")).toBe("company-closing-packet");
  });

  test("rejects malformed and reserved slugs", () => {
    for (const slug of ["ABCD", "two--hyphens", "-leading", "trailing-", "__attachments_probe__"]) {
      expect(() => parseFriendlySlug(slug)).toThrow(FriendlySlugError);
    }
  });

  test("requires a password only when a friendly slug is requested", () => {
    expect(() => requireFriendlySlugPassword("company-closing-packet", undefined)).toThrow(
      "Friendly links require a password",
    );
    expect(() => requireFriendlySlugPassword("company-closing-packet", "passphrase")).not.toThrow();
    expect(() => requireFriendlySlugPassword(undefined, undefined)).not.toThrow();
  });

  test("stores only the slug hash and lets the unique index reserve it", () => {
    const path = join(tmpdir(), `attachments-friendly-slug-${process.pid}-${Date.now()}.sqlite`);
    const db = new AttachmentsDB(path);
    const attachment: Attachment = {
      id: "att_friendly_db",
      filename: "packet.pdf",
      s3Key: "attachments/packet.pdf",
      bucket: "local",
      size: 1,
      contentType: "application/pdf",
      link: null,
      tag: null,
      expiresAt: null,
      createdAt: Date.now(),
    };
    try {
      db.insert(attachment);
      db.createShareLink({
        attachmentId: attachment.id,
        expiresAt: null,
        token: "company-closing-packet",
        password: "passphrase",
      });
      expect(db.findShareLinkByToken("company-closing-packet")).not.toBeNull();
      expect(() =>
        db.createShareLink({
          attachmentId: attachment.id,
          expiresAt: null,
          token: "company-closing-packet",
          password: "different-passphrase",
        }),
      ).toThrow();
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });
});
