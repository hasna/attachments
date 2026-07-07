import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { Readable } from "stream";
import { createCipheriv, randomBytes, scryptSync } from "crypto";

// Import real modules — no mock.module needed thanks to deps injection
import {
  extractId,
  extractShareToken,
  isExpired,
  downloadAttachment,
  openAttachmentStream,
  streamAttachment,
} from "./download";
import type { DownloadDeps } from "./download";
import { AttachmentsDB, type Attachment, type ShareLink } from "./db";

// --- Helpers ---

function makeFakeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att_test001",
    filename: "test.txt",
    s3Key: "attachments/2026-01-01/att_test001/test.txt",
    bucket: "my-bucket",
    size: 12,
    contentType: "text/plain",
    link: null,
    expiresAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeMockDB(attachment: Attachment | null = null) {
  const shareLink: ShareLink = {
    id: "share_1",
    attachmentId: attachment?.id ?? "att_test001",
    tokenHash: "hash",
    expiresAt: null,
    createdAt: Date.now(),
    revokedAt: null,
    passwordHash: null,
    maxUses: null,
    usedCount: 0,
    requireEmail: false,
    allowedEmails: null,
  };
  return {
    findById: mock((_id: string) => attachment),
    findShareLinkByToken: mock((_token: string) => shareLink),
    close: mock(() => {}),
    insert: mock(() => {}),
    findAll: mock(() => []),
    updateLink: mock(() => {}),
    delete: mock(() => {}),
    deleteExpired: mock(() => 0),
    consumeShareLink: mock(() => true),
    releaseShareLink: mock(() => true),
    incrementDownloads: mock(() => {}),
  };
}

function makeMockS3(content = "file-content") {
  return {
    upload: mock(async () => {}),
    download: mock(async (_key: string) => Buffer.from(content)),
    delete: mock(async () => {}),
    presign: mock(async () => "https://s3.example.com/presigned"),
  };
}

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `dl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  tempDirs = [];
});

// --- extractId ---

describe("extractId", () => {
  it("returns bare ID unchanged", () => {
    expect(extractId("att_abc123")).toBe("att_abc123");
  });

  it("extracts ID from /d/:id path", () => {
    expect(extractId("/d/att_abc123")).toBe("att_abc123");
  });

  it("extracts ID from full http URL", () => {
    expect(extractId("http://localhost:3459/d/att_abc123")).toBe("att_abc123");
  });

  it("extracts ID from https URL", () => {
    expect(extractId("https://example.com/d/att_abc123")).toBe("att_abc123");
  });

  it("stops at query string", () => {
    expect(extractId("http://localhost:3459/d/att_abc123?foo=bar")).toBe("att_abc123");
  });

  it("stops at hash fragment", () => {
    expect(extractId("http://localhost:3459/d/att_abc123#section")).toBe("att_abc123");
  });
});

describe("extractShareToken", () => {
  it("extracts tokens from public share URLs", () => {
    expect(extractShareToken("https://example.test/a/share_token?x=1")).toBe("share_token");
    expect(extractShareToken("/a/share_token#download")).toBe("share_token");
    expect(extractShareToken("att_1")).toBeNull();
  });
});

// --- isExpired ---

describe("isExpired", () => {
  it("returns false when expiresAt is null (never expires)", () => {
    expect(isExpired(makeFakeAttachment({ expiresAt: null }))).toBe(false);
  });

  it("returns true when expiresAt is in the past", () => {
    expect(isExpired(makeFakeAttachment({ expiresAt: Date.now() - 1000 }))).toBe(true);
  });

  it("returns false when expiresAt is in the future", () => {
    expect(isExpired(makeFakeAttachment({ expiresAt: Date.now() + 100_000 }))).toBe(false);
  });
});

// --- downloadAttachment ---

describe("downloadAttachment", () => {
  it("downloads and writes file, returns DownloadResult", async () => {
    const att = makeFakeAttachment({ filename: "hello.txt" });
    const mockDb = makeMockDB(att);
    const mockS3 = makeMockS3("hello world");
    const deps: DownloadDeps = { db: mockDb as any, s3: mockS3 as any };
    const dir = makeTempDir();

    const result = await downloadAttachment("att_test001", dir, deps);

    expect(result.filename).toBe("hello.txt");
    expect(result.path).toBe(join(dir, "hello.txt"));
    expect(result.size).toBe(11);
    expect(readFileSync(result.path, "utf-8")).toBe("hello world");
  });

  it("throws when attachment not found", async () => {
    const deps: DownloadDeps = { db: makeMockDB(null) as any, s3: makeMockS3() as any };
    await expect(downloadAttachment("att_missing", undefined, deps)).rejects.toThrow("Attachment not found");
  });

  it("throws when attachment is expired", async () => {
    const att = makeFakeAttachment({ expiresAt: Date.now() - 1000 });
    const deps: DownloadDeps = { db: makeMockDB(att) as any, s3: makeMockS3() as any };
    await expect(downloadAttachment("att_test001", undefined, deps)).rejects.toThrow("Attachment has expired");
  });

  it("closes an internally owned DB when opening the object stream fails", async () => {
    const previousHome = process.env.HOME;
    const home = makeTempDir();
    process.env.HOME = home;
    const db = new AttachmentsDB();
    db.insert(makeFakeAttachment({
      id: "att_owned_db",
      filename: "owned.txt",
      bucket: "local",
      storageBackend: "local",
    }));
    db.close();

    try {
      await expect(downloadAttachment("att_owned_db", makeTempDir(), {
        objectStore: {
          getStream: mock(() => {
            throw new Error("stream open failed");
          }),
        } as never,
        config: { storage: { localDir: makeTempDir() } } as never,
      })).rejects.toThrow("stream open failed");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("extracts ID from URL before looking up", async () => {
    const att = makeFakeAttachment();
    const mockDb = makeMockDB(att);
    const deps: DownloadDeps = { db: mockDb as any, s3: makeMockS3() as any };
    const dir = makeTempDir();

    await downloadAttachment("http://localhost:3459/d/att_test001", dir, deps);

    expect(mockDb.findById).toHaveBeenCalledWith("att_test001");
  });

  it("respects --output as a full file path", async () => {
    const att = makeFakeAttachment({ filename: "data.bin" });
    const deps: DownloadDeps = { db: makeMockDB(att) as any, s3: makeMockS3("bytes") as any };
    const dir = makeTempDir();
    const targetPath = join(dir, "renamed.bin");

    const result = await downloadAttachment("att_test001", targetPath, deps);

    expect(result.path).toBe(targetPath);
    expect(existsSync(targetPath)).toBe(true);
  });

  it("overwrites dest when dest is an existing file (not a directory)", async () => {
    const att = makeFakeAttachment({ filename: "new.txt" });
    const deps: DownloadDeps = { db: makeMockDB(att) as any, s3: makeMockS3("new-content") as any };
    const dir = makeTempDir();

    // Create an existing file at dest
    const existingFilePath = join(dir, "existing.txt");
    require("fs").writeFileSync(existingFilePath, "old-content", "utf-8");

    const result = await downloadAttachment("att_test001", existingFilePath, deps);

    // Should overwrite the file directly at existingFilePath
    expect(result.path).toBe(existingFilePath);
    expect(readFileSync(existingFilePath).toString()).toBe("new-content");
  });

  it("creates directory when dest path ends with '/' and doesn't exist", async () => {
    const att = makeFakeAttachment({ filename: "file.txt" });
    const deps: DownloadDeps = { db: makeMockDB(att) as any, s3: makeMockS3("content") as any };
    const dir = makeTempDir();
    const nonExistentDirWithSlash = join(dir, "new-subdir/");

    const result = await downloadAttachment("att_test001", nonExistentDirWithSlash, deps);

    expect(result.path).toBe(join(nonExistentDirWithSlash, "file.txt"));
    expect(readFileSync(result.path).toString()).toBe("content");
  });

  it("downloads through a share link and increments downloads after reservation", async () => {
    const att = makeFakeAttachment({ filename: "shared.txt", bucket: "local", storageBackend: "local" });
    const db = makeMockDB(att);
    const objectStore = {
      getStream: mock(() => ({
        body: Readable.from(["shared"]),
        contentLength: 6,
        contentType: "text/plain",
        status: 200 as const,
      })),
    };
    const dir = makeTempDir();

    const result = await downloadAttachment("https://example.test/a/share_token", dir, {
      db: db as any,
      objectStore: objectStore as any,
      config: { storage: { localDir: dir } } as any,
    });

    expect(result.filename).toBe("shared.txt");
    expect(readFileSync(result.path, "utf8")).toBe("shared");
    expect(db.consumeShareLink).toHaveBeenCalledWith("share_1");
    expect(db.incrementDownloads).toHaveBeenCalledWith("att_test001");
  });

  it("releases a reserved share link when streaming fails", async () => {
    const att = makeFakeAttachment({ bucket: "local", storageBackend: "local" });
    const db = makeMockDB(att);
    const failing = new Readable({
      read() {
        this.destroy(new Error("stream failed"));
      },
    });
    const objectStore = {
      getStream: mock(() => ({
        body: failing,
        contentLength: 0,
        contentType: "text/plain",
        status: 200 as const,
      })),
    };

    await expect(downloadAttachment("https://example.test/a/share_token", makeTempDir(), {
      db: db as any,
      objectStore: objectStore as any,
      config: { storage: { localDir: makeTempDir() } } as any,
    })).rejects.toThrow("stream failed");
    expect(db.releaseShareLink).toHaveBeenCalledWith("share_1");
  });

  it("throws when a reserved share link can no longer be consumed", async () => {
    const att = makeFakeAttachment({ bucket: "local", storageBackend: "local" });
    const db = makeMockDB(att);
    db.consumeShareLink.mockImplementation(() => false);

    await expect(downloadAttachment("https://example.test/a/share_token", makeTempDir(), {
      db: db as any,
      objectStore: {
        getStream: () => ({ body: Readable.from(["x"]), status: 200 as const }),
      } as any,
      config: { storage: { localDir: makeTempDir() } } as any,
    })).rejects.toThrow("Share link is no longer available");
  });

  it("rejects encrypted downloads with incomplete GCM metadata", async () => {
    const att = makeFakeAttachment({
      storageBackend: "s3",
      encryptionAlgorithm: "aes-256-gcm",
      encryptionSalt: Buffer.alloc(16).toString("hex"),
      encryptionIv: Buffer.alloc(12).toString("hex"),
      encryptionTag: null,
    });

    await expect(openAttachmentStream(att, {
      password: "pw",
      s3: {
        downloadStream: mock(async () => ({
          body: Readable.from(["encrypted"]),
          status: 200 as const,
        })),
      } as any,
      config: { storage: { backend: "s3" }, s3: {} } as any,
    })).rejects.toThrow("encryption metadata is incomplete");
  });

  it("decrypts AES-GCM attachment streams with complete metadata", async () => {
    const password = "pw";
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(password, salt, 32);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update("plain text"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const att = makeFakeAttachment({
      storageBackend: "s3",
      size: "plain text".length,
      encryptionAlgorithm: "aes-256-gcm",
      encryptionSalt: salt.toString("hex"),
      encryptionIv: iv.toString("hex"),
      encryptionTag: tag.toString("hex"),
    });

    const stream = await openAttachmentStream(att, {
      password,
      s3: {
        downloadStream: mock(async () => ({
          body: Readable.from([encrypted]),
          status: 200 as const,
        })),
      } as any,
      config: { storage: { backend: "s3" }, s3: {} } as any,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream.body as Readable) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks).toString("utf8")).toBe("plain text");
  });
});

// --- streamAttachment ---

describe("streamAttachment", () => {
  it("returns buffer and attachment metadata", async () => {
    const att = makeFakeAttachment();
    const deps: DownloadDeps = { db: makeMockDB(att) as any, s3: makeMockS3("stream content") as any };

    const result = await streamAttachment("att_test001", deps);

    expect(result.buffer.toString()).toBe("stream content");
    expect(result.attachment.id).toBe("att_test001");
  });

  it("throws when attachment not found", async () => {
    const deps: DownloadDeps = { db: makeMockDB(null) as any, s3: makeMockS3() as any };
    await expect(streamAttachment("att_missing", deps)).rejects.toThrow("Attachment not found");
  });

  it("throws when attachment is expired", async () => {
    const att = makeFakeAttachment({ expiresAt: Date.now() - 1000 });
    const deps: DownloadDeps = { db: makeMockDB(att) as any, s3: makeMockS3() as any };
    await expect(streamAttachment("att_test001", deps)).rejects.toThrow("Attachment has expired");
  });

  it("streams through openAttachmentStream when no legacy S3 download helper is injected", async () => {
    const att = makeFakeAttachment({ storageBackend: "s3" });
    const deps: DownloadDeps = {
      db: makeMockDB(att) as any,
      s3: {
        downloadStream: mock(async () => ({
          body: Readable.from(["streamed"]),
          contentType: "text/plain",
          status: 200 as const,
        })),
      } as any,
    };

    const result = await streamAttachment("att_test001", deps);

    expect(result.buffer.toString()).toBe("streamed");
  });
});

describe("openAttachmentStream", () => {
  it("rejects expired attachments before opening storage", async () => {
    await expect(openAttachmentStream(makeFakeAttachment({ expiresAt: Date.now() - 1 }))).rejects.toThrow("Attachment has expired");
  });

  it("uses injected local object stores with parsed ranges", async () => {
    const att = makeFakeAttachment({ bucket: "local", storageBackend: "local", size: 6 });
    const getStream = mock((_key: string, _type: string, range: unknown) => ({
      body: Readable.from(["bc"]),
      contentLength: 2,
      contentType: "text/plain",
      contentRange: "bytes 1-2/6",
      status: 206 as const,
      range,
    }));

    const result = await openAttachmentStream(att, {
      objectStore: { getStream } as any,
      rangeHeader: "bytes=1-2",
      config: { storage: { localDir: makeTempDir() } } as any,
    });

    expect(result.status).toBe(206);
    expect(getStream.mock.calls[0]![2]).toEqual({ start: 1, end: 2 });
  });

  it("converts web streams returned by object stores during downloads", async () => {
    const att = makeFakeAttachment({ bucket: "local", storageBackend: "local", size: 3, filename: "web.txt" });
    const dir = makeTempDir();
    const result = await downloadAttachment("att_test001", dir, {
      db: makeMockDB(att) as any,
      objectStore: {
        getStream: () => ({
          body: new Response("web").body!,
          contentLength: 3,
          contentType: "text/plain",
          status: 200 as const,
        }),
      } as any,
      config: { storage: { localDir: makeTempDir() } } as any,
    });

    expect(readFileSync(result.path, "utf8")).toBe("web");
  });

  it("streams S3 ranges and defaults missing content type to attachment metadata", async () => {
    const att = makeFakeAttachment({ storageBackend: "s3", size: 10, contentType: "text/plain" });
    const downloadStream = mock(async (_key: string, range?: string) => ({
      body: Readable.from(["range"]),
      contentLength: 5,
      status: 206 as const,
      range,
    }));

    const result = await openAttachmentStream(att, {
      s3: { downloadStream } as any,
      rangeHeader: "bytes=0-4",
    });

    expect(downloadStream).toHaveBeenCalledWith(att.s3Key, "bytes=0-4");
    expect(result.contentType).toBe("text/plain");
  });

  it("falls back to buffer downloads for legacy S3 clients", async () => {
    const att = makeFakeAttachment({ storageBackend: "s3" });

    const result = await openAttachmentStream(att, {
      s3: { download: mock(async () => Buffer.from("buffer")) } as any,
    });

    expect(result.status).toBe(200);
    expect(result.contentLength).toBe(6);
    expect(await new Response(Readable.toWeb(result.body as Readable) as never).text()).toBe("buffer");
  });

  it("rejects unsupported or incomplete encryption metadata", async () => {
    await expect(openAttachmentStream(makeFakeAttachment({ encryptionAlgorithm: "x" as any }), {
      s3: { download: mock(async () => Buffer.from("encrypted")) } as any,
    })).rejects.toThrow("Unsupported encryption algorithm");

    await expect(openAttachmentStream(makeFakeAttachment({ encryptionAlgorithm: "aes-256-ctr" }), {
      s3: { download: mock(async () => Buffer.from("encrypted")) } as any,
    })).rejects.toThrow("requires a password");

    await expect(openAttachmentStream(makeFakeAttachment({
      encryptionAlgorithm: "aes-256-ctr",
      encryptionSalt: null,
      encryptionIv: null,
    }), {
      password: "pw",
      s3: { download: mock(async () => Buffer.from("encrypted")) } as any,
    })).rejects.toThrow("metadata is incomplete");

    await expect(openAttachmentStream(makeFakeAttachment({
      encryptionAlgorithm: "aes-256-gcm",
      encryptionSalt: "00",
      encryptionIv: "00",
    }), {
      password: "pw",
      s3: { download: mock(async () => Buffer.from("encrypted")) } as any,
    })).rejects.toThrow("metadata is incomplete");
  });
});
