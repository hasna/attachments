import { describe, it, expect, mock, beforeAll, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import type { Attachment } from "./db";

// AttachmentsDB is dynamically imported after mock.restore() so we always get the real class,
// even when other test files (upload.test.ts, download.test.ts) have mocked "./db".
let AttachmentsDB: import("./db").AttachmentsDB extends object
  ? typeof import("./db").AttachmentsDB
  : never;

type AttachmentsDBCtor = new (path?: string) => import("./db").AttachmentsDB;
let DB: AttachmentsDBCtor;

beforeAll(async () => {
  mock.restore();
  const mod = await import("./db");
  DB = mod.AttachmentsDB as AttachmentsDBCtor;
});

function makeTempPath(): string {
  return join(tmpdir(), `open-attachments-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att_test001",
    filename: "photo.png",
    s3Key: "uploads/photo.png",
    bucket: "my-bucket",
    size: 1024,
    contentType: "image/png",
    link: null,
    expiresAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("AttachmentsDB", () => {
  let db: import("./db").AttachmentsDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTempPath();
    db = new DB(dbPath);
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(dbPath);
      rmSync(dbPath + "-wal", { force: true });
      rmSync(dbPath + "-shm", { force: true });
    } catch {}
  });

  describe("insert & findById", () => {
    it("inserts an attachment and retrieves it by id", () => {
      const att = makeAttachment();
      db.insert(att);
      const found = db.findById(att.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(att.id);
      expect(found!.filename).toBe(att.filename);
      expect(found!.s3Key).toBe(att.s3Key);
      expect(found!.bucket).toBe(att.bucket);
      expect(found!.size).toBe(att.size);
      expect(found!.contentType).toBe(att.contentType);
      expect(found!.link).toBeNull();
      expect(found!.expiresAt).toBeNull();
      expect(found!.createdAt).toBe(att.createdAt);
    });

    it("returns null for a non-existent id", () => {
      expect(db.findById("att_missing")).toBeNull();
    });

    it("preserves link and expiresAt when set on insert", () => {
      const att = makeAttachment({ link: "https://example.com/file", expiresAt: 9999999999999 });
      db.insert(att);
      const found = db.findById(att.id);
      expect(found!.link).toBe("https://example.com/file");
      expect(found!.expiresAt).toBe(9999999999999);
    });
  });

  describe("findAll", () => {
    it("returns all non-expired attachments by default", () => {
      const now = Date.now();
      const future = now + 10_000;
      const past = now - 10_000;

      db.insert(makeAttachment({ id: "att_a", createdAt: now, expiresAt: null }));
      db.insert(makeAttachment({ id: "att_b", createdAt: now - 1, expiresAt: future }));
      db.insert(makeAttachment({ id: "att_c", createdAt: now - 2, expiresAt: past }));

      const results = db.findAll();
      const ids = results.map((r) => r.id);
      expect(ids).toContain("att_a");
      expect(ids).toContain("att_b");
      expect(ids).not.toContain("att_c");
    });

    it("includes expired when includeExpired=true", () => {
      const past = Date.now() - 10_000;
      db.insert(makeAttachment({ id: "att_expired", expiresAt: past }));

      const withExpired = db.findAll({ includeExpired: true });
      const withoutExpired = db.findAll({ includeExpired: false });

      expect(withExpired.map((r) => r.id)).toContain("att_expired");
      expect(withoutExpired.map((r) => r.id)).not.toContain("att_expired");
    });

    it("respects the limit option", () => {
      for (let i = 0; i < 5; i++) {
        db.insert(makeAttachment({ id: `att_${i}`, createdAt: Date.now() - i * 1000 }));
      }
      const results = db.findAll({ limit: 3 });
      expect(results.length).toBe(3);
    });

    it("returns empty array when no attachments", () => {
      expect(db.findAll()).toEqual([]);
    });

    it("orders by createdAt descending", () => {
      const base = Date.now();
      db.insert(makeAttachment({ id: "att_old", createdAt: base - 2000 }));
      db.insert(makeAttachment({ id: "att_mid", createdAt: base - 1000 }));
      db.insert(makeAttachment({ id: "att_new", createdAt: base }));

      const results = db.findAll();
      expect(results[0].id).toBe("att_new");
      expect(results[1].id).toBe("att_mid");
      expect(results[2].id).toBe("att_old");
    });
  });

  describe("updateLink", () => {
    it("updates link and expiresAt for existing attachment", () => {
      const att = makeAttachment();
      db.insert(att);

      const expiresAt = Date.now() + 3600_000;
      db.updateLink(att.id, "https://cdn.example.com/file", expiresAt);

      const found = db.findById(att.id);
      expect(found!.link).toBe("https://cdn.example.com/file");
      expect(found!.expiresAt).toBe(expiresAt);
    });

    it("sets expiresAt to null when not provided", () => {
      const att = makeAttachment({ expiresAt: 9999999999 });
      db.insert(att);

      db.updateLink(att.id, "https://cdn.example.com/file");

      const found = db.findById(att.id);
      expect(found!.link).toBe("https://cdn.example.com/file");
      expect(found!.expiresAt).toBeNull();
    });

    it("sets expiresAt to null when explicitly passed null", () => {
      const att = makeAttachment({ expiresAt: 9999999999 });
      db.insert(att);

      db.updateLink(att.id, "https://cdn.example.com/file", null);

      const found = db.findById(att.id);
      expect(found!.expiresAt).toBeNull();
    });
  });

  describe("delete", () => {
    it("removes the attachment from the database", () => {
      const att = makeAttachment();
      db.insert(att);
      db.delete(att.id);
      expect(db.findById(att.id)).toBeNull();
    });

    it("does not throw when deleting a non-existent id", () => {
      expect(() => db.delete("att_nonexistent")).not.toThrow();
    });
  });

  describe("deleteExpired", () => {
    it("deletes only expired attachments and returns count", () => {
      const now = Date.now();
      db.insert(makeAttachment({ id: "att_active", expiresAt: now + 10_000 }));
      db.insert(makeAttachment({ id: "att_no_expiry", expiresAt: null }));
      db.insert(makeAttachment({ id: "att_expired1", expiresAt: now - 1 }));
      db.insert(makeAttachment({ id: "att_expired2", expiresAt: now - 5000 }));

      const deleted = db.deleteExpired();
      expect(deleted).toBe(2);

      expect(db.findById("att_active")).not.toBeNull();
      expect(db.findById("att_no_expiry")).not.toBeNull();
      expect(db.findById("att_expired1")).toBeNull();
      expect(db.findById("att_expired2")).toBeNull();
    });

    it("returns 0 when nothing is expired", () => {
      db.insert(makeAttachment({ id: "att_future", expiresAt: Date.now() + 99999999 }));
      expect(db.deleteExpired()).toBe(0);
    });
  });
});

describe("AttachmentsDB default path constructor", () => {
  it("creates a DB at the default ~/.attachments/db.sqlite path when no path given", () => {
    let db: import("./db").AttachmentsDB | null = null;
    expect(() => {
      db = new DB();
    }).not.toThrow();
    expect(db).not.toBeNull();
    expect(() => (db as import("./db").AttachmentsDB).findAll()).not.toThrow();
    (db as import("./db").AttachmentsDB).close();
  });
});
