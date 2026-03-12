import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";

// Import real modules — no mock.module needed thanks to deps injection
import { extractId, isExpired, downloadAttachment, streamAttachment } from "./download";
import type { DownloadDeps } from "./download";
import type { Attachment } from "./db";

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
  return {
    findById: mock((_id: string) => attachment),
    close: mock(() => {}),
    insert: mock(() => {}),
    findAll: mock(() => []),
    updateLink: mock(() => {}),
    delete: mock(() => {}),
    deleteExpired: mock(() => 0),
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
    expect(extractId("http://localhost:3457/d/att_abc123")).toBe("att_abc123");
  });

  it("extracts ID from https URL", () => {
    expect(extractId("https://example.com/d/att_abc123")).toBe("att_abc123");
  });

  it("stops at query string", () => {
    expect(extractId("http://localhost:3457/d/att_abc123?foo=bar")).toBe("att_abc123");
  });

  it("stops at hash fragment", () => {
    expect(extractId("http://localhost:3457/d/att_abc123#section")).toBe("att_abc123");
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

  it("extracts ID from URL before looking up", async () => {
    const att = makeFakeAttachment();
    const mockDb = makeMockDB(att);
    const deps: DownloadDeps = { db: mockDb as any, s3: makeMockS3() as any };
    const dir = makeTempDir();

    await downloadAttachment("http://localhost:3457/d/att_test001", dir, deps);

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
});
