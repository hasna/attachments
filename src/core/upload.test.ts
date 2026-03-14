import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Import the real modules — no mock.module needed thanks to deps injection
import { uploadFile, uploadFromBuffer, uploadFromUrl } from "./upload";
import type { UploadDeps } from "./upload";

// --- Mock helpers ---

function makeMockS3() {
  return {
    upload: mock(async () => {}),
    presign: mock(async (_key: string, _exp: number) => "https://s3.example.com/presigned?sig=test"),
    download: mock(async () => Buffer.from("")),
    delete: mock(async () => {}),
  };
}

function makeMockDB() {
  return {
    insert: mock((_a: unknown) => {}),
    close: mock(() => {}),
    findById: mock(() => null),
    findAll: mock(() => []),
    updateLink: mock(() => {}),
    delete: mock(() => {}),
    deleteExpired: mock(() => 0),
  };
}

const mockConfig = {
  s3: { bucket: "test-bucket", region: "us-east-1", accessKeyId: "AKIATEST", secretAccessKey: "secret" },
  server: { port: 3459, baseUrl: "http://localhost:3459" },
  defaults: { expiry: "7d", linkType: "presigned" as const },
};

// --- Helpers ---

let tempFiles: string[] = [];

function createTempFile(name: string, content: string = "hello world"): string {
  const dir = join(tmpdir(), "upload-test");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(filePath, content, "utf-8");
  tempFiles.push(filePath);
  return filePath;
}

// --- Tests ---

describe("uploadFile", () => {
  let mockS3: ReturnType<typeof makeMockS3>;
  let mockDb: ReturnType<typeof makeMockDB>;
  let deps: UploadDeps;

  beforeEach(() => {
    mockS3 = makeMockS3();
    mockDb = makeMockDB();
    deps = { s3: mockS3 as any, db: mockDb as any, config: mockConfig };
  });

  afterEach(() => {
    for (const f of tempFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    tempFiles = [];
  });

  it("returns an Attachment with correct shape on successful upload", async () => {
    const filePath = createTempFile("test.txt", "hello world");
    const result = await uploadFile(filePath, {}, deps);

    expect(result.id).toMatch(/^att_[A-Za-z0-9_-]{10}$/);
    expect(result.filename).toBe("test.txt");
    expect(result.bucket).toBe("test-bucket");
    expect(result.contentType).toBe("text/plain");
    expect(typeof result.size).toBe("number");
    expect(result.size).toBeGreaterThan(0);
    expect(typeof result.createdAt).toBe("number");
    expect(result.createdAt).toBeGreaterThan(0);
  });

  it("formats s3Key as attachments/YYYY-MM-DD/att_.../filename", async () => {
    const filePath = createTempFile("report.pdf", "fake pdf content");
    const result = await uploadFile(filePath, {}, deps);
    expect(result.s3Key).toMatch(/^attachments\/\d{4}-\d{2}-\d{2}\/att_[A-Za-z0-9_-]{10}\/report\.pdf$/);
  });

  it("s3Key contains the generated attachment id", async () => {
    const filePath = createTempFile("image.png", "fake png");
    const result = await uploadFile(filePath, {}, deps);
    expect(result.s3Key).toContain(result.id);
  });

  it("s3Key contains the filename at the end", async () => {
    const filePath = createTempFile("document.docx", "fake docx");
    const result = await uploadFile(filePath, {}, deps);
    expect(result.s3Key.endsWith("/document.docx")).toBe(true);
  });

  it("parses expiry option and sets expiresAt correctly (24h)", async () => {
    const before = Date.now();
    const filePath = createTempFile("file.txt", "data");
    const result = await uploadFile(filePath, { expiry: "24h" }, deps);
    const after = Date.now();
    const expectedDelta = 24 * 60 * 60 * 1000;
    expect(result.expiresAt).not.toBeNull();
    expect(result.expiresAt!).toBeGreaterThanOrEqual(before + expectedDelta);
    expect(result.expiresAt!).toBeLessThanOrEqual(after + expectedDelta);
  });

  it("parses expiry option and sets expiresAt correctly (7d default)", async () => {
    const before = Date.now();
    const filePath = createTempFile("file.txt", "data");
    const result = await uploadFile(filePath, {}, deps);
    const after = Date.now();
    const expectedDelta = 7 * 24 * 60 * 60 * 1000;
    expect(result.expiresAt).not.toBeNull();
    expect(result.expiresAt!).toBeGreaterThanOrEqual(before + expectedDelta);
    expect(result.expiresAt!).toBeLessThanOrEqual(after + expectedDelta);
  });

  it("sets expiresAt to null when expiry is 'never'", async () => {
    const filePath = createTempFile("forever.txt", "data");
    const result = await uploadFile(filePath, { expiry: "never" }, deps);
    expect(result.expiresAt).toBeNull();
  });

  it("calls S3 upload with the correct key and content type", async () => {
    const filePath = createTempFile("upload-verify.txt", "some content");
    const result = await uploadFile(filePath, {}, deps);
    expect(mockS3.upload).toHaveBeenCalledTimes(1);
    const [calledKey, , calledContentType] = mockS3.upload.mock.calls[0] as [string, Buffer, string];
    expect(calledKey).toBe(result.s3Key);
    expect(calledContentType).toBe("text/plain");
  });

  it("generates presigned link when linkType is presigned", async () => {
    mockS3.presign.mockImplementation(async () => "https://s3.example.com/presigned?sig=test");
    const filePath = createTempFile("secure.zip", "binary data");
    const result = await uploadFile(filePath, { expiry: "7d", linkType: "presigned" }, deps);
    expect(result.link).toContain("https://");
  });

  it("generates server link when linkType is server", async () => {
    const filePath = createTempFile("hosted.txt", "hosted data");
    const result = await uploadFile(filePath, { linkType: "server" }, deps);
    expect(result.link).toContain(`/d/${result.id}`);
  });

  it("inserts the attachment into the DB", async () => {
    const filePath = createTempFile("db-test.txt", "data");
    const result = await uploadFile(filePath, {}, deps);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    const [inserted] = mockDb.insert.mock.calls[0] as [typeof result];
    expect(inserted.id).toBe(result.id);
    expect(inserted.filename).toBe("db-test.txt");
    expect(inserted.bucket).toBe("test-bucket");
  });

  it("passes tag through to the attachment record", async () => {
    const filePath = createTempFile("tagged.txt", "tagged content");
    const result = await uploadFile(filePath, { tag: "my-tag" }, deps);
    expect(result.tag).toBe("my-tag");
  });

  it("sets tag to null when not provided", async () => {
    const filePath = createTempFile("untagged.txt", "no tag");
    const result = await uploadFile(filePath, {}, deps);
    expect(result.tag).toBeNull();
  });

  it("detects content type for .png files", async () => {
    const filePath = createTempFile("photo.png", "fake png bytes");
    const result = await uploadFile(filePath, {}, deps);
    expect(result.contentType).toBe("image/png");
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    const filePath = createTempFile("data.unknownext999", "raw bytes");
    const result = await uploadFile(filePath, {}, deps);
    expect(result.contentType).toBe("application/octet-stream");
  });
});

describe("uploadFromBuffer", () => {
  let mockS3: ReturnType<typeof makeMockS3>;
  let mockDb: ReturnType<typeof makeMockDB>;
  let deps: UploadDeps;

  beforeEach(() => {
    mockS3 = makeMockS3();
    mockDb = makeMockDB();
    deps = { s3: mockS3 as any, db: mockDb as any, config: mockConfig };
  });

  it("uploads a buffer with the given filename and returns an Attachment", async () => {
    const buffer = Buffer.from("stdin content here");
    const result = await uploadFromBuffer(buffer, "stdin-file.txt", {}, deps);

    expect(result.id).toMatch(/^att_[A-Za-z0-9_-]{10}$/);
    expect(result.filename).toBe("stdin-file.txt");
    expect(result.contentType).toBe("text/plain");
    expect(result.size).toBe(buffer.length);
    expect(mockS3.upload).toHaveBeenCalledTimes(1);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it("cleans up the temp file after upload", async () => {
    const buffer = Buffer.from("temp data");
    const expectedTempPath = join(tmpdir(), "open-attachments-stdin", "cleanup-test.txt");

    await uploadFromBuffer(buffer, "cleanup-test.txt", {}, deps);

    expect(existsSync(expectedTempPath)).toBe(false);
  });

  it("cleans up the temp file even when upload fails", async () => {
    mockS3.upload.mockImplementation(async () => {
      throw new Error("S3 failure");
    });

    const buffer = Buffer.from("will fail");
    const expectedTempPath = join(tmpdir(), "open-attachments-stdin", "fail-test.txt");

    await expect(uploadFromBuffer(buffer, "fail-test.txt", {}, deps)).rejects.toThrow("S3 failure");

    expect(existsSync(expectedTempPath)).toBe(false);
  });

  it("detects content type from the filename extension", async () => {
    const buffer = Buffer.from("fake png");
    const result = await uploadFromBuffer(buffer, "image.png", {}, deps);
    expect(result.contentType).toBe("image/png");
  });

  it("passes upload options through to uploadFile", async () => {
    const buffer = Buffer.from("data");
    const result = await uploadFromBuffer(buffer, "file.txt", { expiry: "never" }, deps);
    expect(result.expiresAt).toBeNull();
  });
});

describe("uploadFromUrl", () => {
  let mockS3: ReturnType<typeof makeMockS3>;
  let mockDb: ReturnType<typeof makeMockDB>;
  let deps: UploadDeps;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockS3 = makeMockS3();
    mockDb = makeMockDB();
    deps = { s3: mockS3 as any, db: mockDb as any, config: mockConfig };
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const f of tempFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    tempFiles = [];
  });

  it("fetches URL, writes temp file, uploads, and cleans up", async () => {
    const body = "hello from url";
    globalThis.fetch = mock(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as any;

    const result = await uploadFromUrl("https://example.com/files/document.txt", {}, deps);

    expect(result.filename).toBe("document.txt");
    expect(result.contentType).toBe("text/plain");
    expect(result.size).toBe(body.length);
    expect(mockS3.upload).toHaveBeenCalledTimes(1);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);

    // Temp file should be cleaned up
    const tempDir = join(tmpdir(), "open-attachments-url");
    const tempPath = join(tempDir, "document.txt");
    expect(existsSync(tempPath)).toBe(false);
  });

  it("extracts filename from Content-Disposition header", async () => {
    globalThis.fetch = mock(async () => new Response("data", {
      status: 200,
      headers: {
        "content-disposition": 'attachment; filename="report.pdf"',
        "content-type": "application/pdf",
      },
    })) as any;

    const result = await uploadFromUrl("https://example.com/download?id=123", {}, deps);
    expect(result.filename).toBe("report.pdf");
  });

  it("falls back to URL path segment for filename", async () => {
    globalThis.fetch = mock(async () => new Response("img data", {
      status: 200,
      headers: { "content-type": "image/png" },
    })) as any;

    const result = await uploadFromUrl("https://cdn.example.com/images/photo.png", {}, deps);
    expect(result.filename).toBe("photo.png");
  });

  it("generates a fallback filename when URL has no file extension", async () => {
    globalThis.fetch = mock(async () => new Response("binary", {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })) as any;

    const result = await uploadFromUrl("https://example.com/api/data", {}, deps);
    // Should get a generated name like download_XXXXXX
    expect(result.filename).toMatch(/^download_[A-Za-z0-9_-]+$/);
  });

  it("throws on non-OK HTTP response", async () => {
    globalThis.fetch = mock(async () => new Response("Not Found", {
      status: 404,
      statusText: "Not Found",
    })) as any;

    await expect(uploadFromUrl("https://example.com/missing.txt", {}, deps))
      .rejects.toThrow("Failed to fetch URL: 404 Not Found");
  });

  it("passes upload options through to uploadFile", async () => {
    globalThis.fetch = mock(async () => new Response("data", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as any;

    const result = await uploadFromUrl(
      "https://example.com/file.txt",
      { expiry: "24h", linkType: "server" },
      deps
    );

    expect(result.link).toContain(`/d/${result.id}`);
  });
});
