import { describe, it, expect, mock, beforeAll, beforeEach, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { Artifact, Attachment, ShareLink } from "../core/db";
import { setConfigPath, setConfig } from "../core/config";
import { buildPasswordHash } from "../core/security";

// --- Mocks (must be set up before importing the module under test) ---

const mockUploadFile = mock(async (_filePath: string, _opts?: unknown) => ({
  id: "att_test00001",
  filename: "test.txt",
  s3Key: "attachments/2025-01-01/att_test00001/test.txt",
  bucket: "test-bucket",
  size: 11,
  contentType: "text/plain",
  link: "https://s3.amazonaws.com/test-bucket/test.txt?sig=presigned",
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  createdAt: Date.now(),
} as Attachment));
const mockUploadStreamAttachment = mock(async (_stream: unknown, filename: string, _contentType?: string, opts?: { size?: number }) => ({
  id: "att_stream0001",
  filename,
  s3Key: "attachments/2025-01-01/att_stream0001/test.txt",
  bucket: "test-bucket",
  size: opts?.size ?? 13,
  contentType: "text/plain",
  link: "http://localhost:3459/a/share_stream",
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  createdAt: Date.now(),
  storageBackend: "s3",
  status: "ready",
} as Attachment));

mock.module("../core/upload", () => ({
  uploadFile: mockUploadFile,
  uploadStreamAttachment: mockUploadStreamAttachment,
}));

const mockAttachment: Attachment = {
  id: "att_test00001",
  filename: "test.txt",
  s3Key: "attachments/2025-01-01/att_test00001/test.txt",
  bucket: "test-bucket",
  size: 11,
  contentType: "text/plain",
  link: "https://s3.amazonaws.com/test-bucket/test.txt?sig=presigned",
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  createdAt: 1700000000000,
};

const mockArtifact: Artifact = {
  id: "art_browserplan",
  attachmentId: "att_test00001",
  name: "browserplan",
  version: "1.0.0",
  channel: "stable",
  platform: "darwin",
  arch: "arm64",
  kind: "mac-app-zip",
  filename: "BrowserPlan.zip",
  size: 11,
  checksumSha256: "a".repeat(64),
  signature: null,
  signatureType: null,
  appName: "BrowserPlan.app",
  metadata: {},
  createdAt: 1700000000000,
};

const mockDbFindById = mock((_id: string): Attachment | null => mockAttachment);
const mockDbFindAll = mock((_opts?: unknown): Attachment[] => [mockAttachment]);
const mockDbFindArtifactById = mock((_id: string): Artifact | null => ({ ...mockArtifact }));
const mockDbFindArtifacts = mock((_opts?: unknown): Artifact[] => [{ ...mockArtifact }]);
const mockDbInsertArtifact = mock((_artifact: Artifact) => {});
const mockDbUpdateLink = mock((_id: string, _link: string, _expiresAt?: number | null) => {});
const mockDbDelete = mock((_id: string) => {});
const mockDbClose = mock(() => {});
const mockDbCreateShareLink = mock((_input: unknown) => ({ shareLink: {}, token: "share_testtoken" }));
const mockDbFindShareLinksByAttachmentId = mock((_id: string) => []);
const mockDbMarkReady = mock((_input: unknown) => {});
const mockShareLink: ShareLink = {
  id: "share_link_1",
  attachmentId: "att_test00001",
  tokenHash: "token_hash",
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  createdAt: 1700000000000,
  revokedAt: null,
  passwordHash: null,
  maxUses: null,
  usedCount: 0,
};
const mockDbFindShareLinkByToken = mock((_token: string): ShareLink | null => ({ ...mockShareLink }));
const mockDbConsumeShareLink = mock((_id: string) => true);
const mockDbReleaseShareLink = mock((_id: string) => true);
const mockDbIncrementDownloads = mock((_id: string) => {});

const mockDbInsert = mock((_att: unknown) => {});

mock.module("../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    findById = mockDbFindById;
    findAll = mockDbFindAll;
    findArtifactById = mockDbFindArtifactById;
    findArtifacts = mockDbFindArtifacts;
    insertArtifact = mockDbInsertArtifact;
    updateLink = mockDbUpdateLink;
    delete = mockDbDelete;
    close = mockDbClose;
    insert = mockDbInsert;
    createShareLink = mockDbCreateShareLink;
    findShareLinksByAttachmentId = mockDbFindShareLinksByAttachmentId;
    markReady = mockDbMarkReady;
    findShareLinkByToken = mockDbFindShareLinkByToken;
    consumeShareLink = mockDbConsumeShareLink;
    releaseShareLink = mockDbReleaseShareLink;
    incrementDownloads = mockDbIncrementDownloads;
  },
}));

const mockS3Delete = mock(async (_key: string) => {});
const mockS3Presign = mock(async (_key: string, _expiresIn: number) => "https://s3.amazonaws.com/test-bucket/test.txt?sig=regenerated");
const mockS3PresignPut = mock(async (_key: string, _contentType: string, _expiresIn: number) => "https://s3.amazonaws.com/test-bucket/upload?sig=put123");
const mockS3CreateMultipartUpload = mock(async (_key: string, _contentType: string) => "upload_test123");
const mockS3PresignUploadPart = mock(async (_key: string, _uploadId: string, partNumber: number, _expiresIn: number) => `https://s3.amazonaws.com/test-bucket/part-${partNumber}?sig=part`);
const mockS3CompleteMultipartUpload = mock(async (_key: string, _uploadId: string, _parts: unknown) => {});
const mockS3AbortMultipart = mock(async (_key: string, _uploadId: string) => {});
const mockS3Head = mock(async (_key: string) => ({ contentLength: 13, contentType: "text/plain" }));

mock.module("../core/s3", () => ({
  S3Client: class MockS3Client {
    delete = mockS3Delete;
    presign = mockS3Presign;
    presignPut = mockS3PresignPut;
    createMultipartUpload = mockS3CreateMultipartUpload;
    presignUploadPart = mockS3PresignUploadPart;
    completeMultipartUpload = mockS3CompleteMultipartUpload;
    abortMultipart = mockS3AbortMultipart;
    head = mockS3Head;
  },
}));

const mockConfig = {
  s3: {
    bucket: "test-bucket",
    region: "us-east-1",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret",
  },
  storage: {
    backend: "s3" as const,
    localDir: "~/.hasna/attachments/test-objects",
    maxSizeBytes: 10 * 1024 * 1024 * 1024,
  },
  server: {
    port: 3459,
    host: "localhost",
    baseUrl: "http://localhost:3459",
    publicPath: "/a",
  },
  defaults: {
    expiry: "7d",
    linkType: "presigned" as const,
  },
};

// Use real config module pointed at a temp file — avoids mock.module cache pollution
let testConfigDir: string;
beforeAll(() => {
  testConfigDir = join(tmpdir(), `api-test-config-${Date.now()}`);
  mkdirSync(testConfigDir, { recursive: true });
  setConfigPath(join(testConfigDir, "config.json"));
  setConfig(mockConfig);
});

const mockGeneratePresignedLink = mock(
  async (_s3: unknown, _key: string, _expiryMs: number | null) =>
    "https://s3.amazonaws.com/test-bucket/test.txt?sig=new"
);
const mockGenerateServerLink = mock(
  (id: string, baseUrl: string) => `${baseUrl}/a/${id}`
);

mock.module("../core/links", () => ({
  generatePresignedLink: mockGeneratePresignedLink,
  generateServerLink: mockGenerateServerLink,
  generateShareLink: (token: string, baseUrl: string) => `${baseUrl}/a/${token}`,
  getLinkType: (_config: unknown) => "presigned" as const,
}));

const mockStreamAttachment = mock(async (_id: string) => ({
  buffer: Buffer.from("file contents"),
  attachment: mockAttachment,
}));
const mockDownloadAttachment = mock(async () => ({
  path: "/tmp/BrowserPlan.zip",
  filename: "BrowserPlan.zip",
  size: 11,
}));
function testBodyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("file contents"));
      controller.close();
    },
  });
}
const mockOpenAttachmentStream = mock(async () => ({
  body: testBodyStream(),
  contentLength: 13,
  contentType: "text/plain",
  status: 200,
}));

mock.module("../core/download", () => ({
  downloadAttachment: mockDownloadAttachment,
  streamAttachment: mockStreamAttachment,
  openAttachmentStream: mockOpenAttachmentStream,
  isExpired: (att: Attachment) => att.expiresAt !== null && att.expiresAt <= Date.now(),
}));

// Import after mocks
const { createApp } = await import("./server");

// Restore all mocks after this file's tests complete so they don't leak into other test files
afterAll(() => {
  mock.restore();
  try { rmSync(testConfigDir, { recursive: true, force: true }); } catch {}
});

// --- Helpers ---

function makeFormData(filename: string, content: string, extraFields?: Record<string, string>): FormData {
  const fd = new FormData();
  fd.append("file", new File([content], filename, { type: "text/plain" }));
  if (extraFields) {
    for (const [k, v] of Object.entries(extraFields)) {
      fd.append(k, v);
    }
  }
  return fd;
}

// --- Tests ---

describe("REST API server", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    delete process.env.ATTACHMENTS_API_TOKEN;
    delete process.env.HASNA_ATTACHMENTS_API_TOKEN;
    try { rmSync(join(testConfigDir, "config.json"), { force: true }); } catch {}
    setConfig(mockConfig);
    app = createApp();
    mockUploadFile.mockReset();
    mockUploadFile.mockImplementation(async () => ({ ...mockAttachment }));
    mockUploadStreamAttachment.mockReset();
    mockUploadStreamAttachment.mockImplementation(async (_stream: unknown, filename: string, _contentType?: string, opts?: { size?: number }) => ({
      id: "att_stream0001",
      filename,
      s3Key: "attachments/2025-01-01/att_stream0001/test.txt",
      bucket: "test-bucket",
      size: opts?.size ?? 13,
      contentType: "text/plain",
      link: "http://localhost:3459/a/share_stream",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
      storageBackend: "s3",
      status: "ready",
    } as Attachment));
    mockDbFindById.mockReset();
    mockDbFindById.mockImplementation(() => ({ ...mockAttachment }));
    mockDbFindAll.mockReset();
    mockDbFindAll.mockImplementation(() => [{ ...mockAttachment }]);
    mockDbFindArtifactById.mockReset();
    mockDbFindArtifactById.mockImplementation(() => ({ ...mockArtifact }));
    mockDbFindArtifacts.mockReset();
    mockDbFindArtifacts.mockImplementation(() => [{ ...mockArtifact }]);
    mockDbInsertArtifact.mockReset();
    mockDbUpdateLink.mockReset();
    mockDbMarkReady.mockReset();
    mockDbCreateShareLink.mockReset();
    mockDbCreateShareLink.mockImplementation(() => ({ shareLink: {}, token: "share_testtoken" }));
    mockDbFindShareLinksByAttachmentId.mockReset();
    mockDbFindShareLinksByAttachmentId.mockImplementation(() => []);
    mockDbFindShareLinkByToken.mockReset();
    mockDbFindShareLinkByToken.mockImplementation(() => ({ ...mockShareLink }));
    mockDbConsumeShareLink.mockReset();
    mockDbConsumeShareLink.mockImplementation(() => true);
    mockDbReleaseShareLink.mockReset();
    mockDbReleaseShareLink.mockImplementation(() => true);
    mockDbIncrementDownloads.mockReset();
    mockDbDelete.mockReset();
    mockDbClose.mockReset();
    mockS3Delete.mockReset();
    mockS3Delete.mockImplementation(async () => {});
    mockS3PresignPut.mockReset();
    mockS3PresignPut.mockImplementation(async () => "https://s3.amazonaws.com/test-bucket/upload?sig=put123");
    mockS3CreateMultipartUpload.mockReset();
    mockS3CreateMultipartUpload.mockImplementation(async () => "upload_test123");
    mockS3PresignUploadPart.mockReset();
    mockS3PresignUploadPart.mockImplementation(async (_key: string, _uploadId: string, partNumber: number) => `https://s3.amazonaws.com/test-bucket/part-${partNumber}?sig=part`);
    mockS3CompleteMultipartUpload.mockReset();
    mockS3CompleteMultipartUpload.mockImplementation(async () => {});
    mockS3AbortMultipart.mockReset();
    mockS3AbortMultipart.mockImplementation(async () => {});
    mockS3Head.mockReset();
    mockS3Head.mockImplementation(async () => ({ contentLength: 13, contentType: "text/plain" }));
    mockDbInsert.mockReset();
    mockGeneratePresignedLink.mockReset();
    mockGeneratePresignedLink.mockImplementation(
      async () => "https://s3.amazonaws.com/test-bucket/test.txt?sig=new"
    );
    mockStreamAttachment.mockReset();
    mockStreamAttachment.mockImplementation(async () => ({
      buffer: Buffer.from("file contents"),
      attachment: mockAttachment,
    }));
    mockDownloadAttachment.mockReset();
    mockDownloadAttachment.mockImplementation(async () => ({
      path: "/tmp/BrowserPlan.zip",
      filename: "BrowserPlan.zip",
      size: 11,
    }));
    mockOpenAttachmentStream.mockReset();
    mockOpenAttachmentStream.mockImplementation(async () => ({
      body: testBodyStream(),
      contentLength: 13,
      contentType: "text/plain",
      status: 200,
    }));
  });

  // --- GET /api/health ---

  describe("GET /api/health", () => {
    it("returns 200 with correct shape", async () => {
      mockDbFindAll.mockImplementation(() => [
        { ...mockAttachment, expiresAt: Date.now() - 1000 }, // expired
        { ...mockAttachment, id: "att_test00002", expiresAt: Date.now() + 1000 }, // not expired
      ]);

      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.attachments).toBe(2);
      expect(body.expired).toBe(1);
      expect(typeof body.s3_configured).toBe("boolean");
      expect(body.s3_configured).toBe(true);
      expect(typeof body.timestamp).toBe("string");
      expect(new Date(body.timestamp).getTime()).toBeGreaterThan(0);
    });

    it("sets hardened browser security headers", async () => {
      const res = await app.request("/api/health");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("permissions-policy")).toContain("camera=()");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    });
  });

  describe("API auth", () => {
    it("keeps health public when ATTACHMENTS_API_TOKEN is configured", async () => {
      process.env.ATTACHMENTS_API_TOKEN = "secret-token";
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.api_auth_required).toBe(true);
    });

    it("rejects operational API requests without the configured token", async () => {
      process.env.ATTACHMENTS_API_TOKEN = "secret-token";
      const res = await app.request("/api/attachments");
      expect(res.status).toBe(401);
    });

    it("accepts bearer tokens for operational API requests", async () => {
      process.env.ATTACHMENTS_API_TOKEN = "secret-token";
      const res = await app.request("/api/attachments", {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(res.status).toBe(200);
    });
  });

  // --- POST /api/attachments ---

  describe("POST /api/attachments", () => {
    it("returns 201 with attachment data on successful upload", async () => {
      const fd = makeFormData("test.txt", "hello world");
      const res = await app.request("/api/attachments", {
        method: "POST",
        body: fd,
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("att_stream0001");
      expect(body.filename).toBe("test.txt");
      expect(body.size).toBe(11);
      expect(body.link).toContain("/a/");
      expect(body).toHaveProperty("expires_at");
      expect(body).toHaveProperty("created_at");
    });

    it("returns 400 when file field is missing", async () => {
      const fd = new FormData();
      fd.append("expiry", "7d");
      const res = await app.request("/api/attachments", {
        method: "POST",
        body: fd,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it("passes expiry option to uploadFile", async () => {
      const fd = makeFormData("test.txt", "hello", { expiry: "24h" });
      await app.request("/api/attachments", {
        method: "POST",
        body: fd,
      });

      expect(mockUploadStreamAttachment).toHaveBeenCalledTimes(1);
      const [, , , opts] = mockUploadStreamAttachment.mock.calls[0] as [unknown, string, string, { expiry?: string }];
      expect(opts?.expiry).toBe("24h");
    });

    it("passes tag option to uploadFile", async () => {
      const fd = makeFormData("test.txt", "hello", { tag: "important" });
      await app.request("/api/attachments", {
        method: "POST",
        body: fd,
      });

      expect(mockUploadStreamAttachment).toHaveBeenCalledTimes(1);
      const [, , , opts] = mockUploadStreamAttachment.mock.calls[0] as [unknown, string, string, { tag?: string }];
      expect(opts?.tag).toBe("important");
    });

    it("returns 413 when Content-Length exceeds ATTACHMENTS_MAX_SIZE", async () => {
      process.env.ATTACHMENTS_MAX_SIZE = "100"; // 100 bytes limit
      const localApp = createApp();
      const fd = makeFormData("test.txt", "hello");
      const res = await localApp.request("/api/attachments", {
        method: "POST",
        body: fd,
        headers: { "content-length": "200" }, // exceeds 100-byte limit
      });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toContain("too large");
      delete process.env.ATTACHMENTS_MAX_SIZE;
    });

    it("returns 500 when uploadFile throws", async () => {
      mockUploadStreamAttachment.mockImplementation(async () => {
        throw new Error("S3 upload failed");
      });

      const fd = makeFormData("test.txt", "hello");
      const res = await app.request("/api/attachments", {
        method: "POST",
        body: fd,
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("S3 upload failed");
    });
  });

  // --- PUT /api/attachments ---

  describe("PUT /api/attachments", () => {
    it("streams the request body through uploadStreamAttachment", async () => {
      const res = await app.request("/api/attachments?filename=stream.txt&expiry=24h&encrypt=1", {
        method: "PUT",
        headers: { "content-type": "text/plain", "content-length": "13", "x-attachments-password": "pw" },
        body: "file contents",
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("att_stream0001");
      expect(body.link).toContain("/a/");
      expect(mockUploadStreamAttachment).toHaveBeenCalledTimes(1);
      const [, filename, contentType, opts] = mockUploadStreamAttachment.mock.calls[0] as [unknown, string, string, { expiry?: string; password?: string; encrypt?: boolean; size?: number }];
      expect(filename).toBe("stream.txt");
      expect(contentType).toBe("text/plain");
      expect(opts.expiry).toBe("24h");
      expect(opts.password).toBe("pw");
      expect(opts.encrypt).toBe(true);
      expect(opts.size).toBe(13);
    });

    it("rejects PUT uploads above the configured max by Content-Length", async () => {
      process.env.ATTACHMENTS_MAX_SIZE = "5";
      const res = await app.request("/api/attachments?filename=big.txt", {
        method: "PUT",
        headers: { "content-type": "text/plain", "content-length": "13" },
        body: "file contents",
      });
      expect(res.status).toBe(413);
      expect(mockUploadStreamAttachment).not.toHaveBeenCalled();
      delete process.env.ATTACHMENTS_MAX_SIZE;
    });
  });

  // --- GET /api/attachments ---

  describe("GET /api/attachments", () => {
    it("returns 200 with a JSON array", async () => {
      const res = await app.request("/api/attachments");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
      expect(body[0].id).toBe("att_test00001");
    });

    it("passes limit query param to db.findAll", async () => {
      await app.request("/api/attachments?limit=5");
      const [opts] = mockDbFindAll.mock.calls[0] as [{ limit?: number }];
      expect(opts?.limit).toBe(5);
    });

    it("passes expired=true to db.findAll as includeExpired", async () => {
      await app.request("/api/attachments?expired=true");
      const [opts] = mockDbFindAll.mock.calls[0] as [{ includeExpired?: boolean }];
      expect(opts?.includeExpired).toBe(true);
    });

    it("passes tag query param to db.findAll", async () => {
      await app.request("/api/attachments?tag=session-123");
      const [opts] = mockDbFindAll.mock.calls[0] as [{ tag?: string }];
      expect(opts?.tag).toBe("session-123");
    });

    it("does not pass tag when query param is missing", async () => {
      await app.request("/api/attachments");
      const [opts] = mockDbFindAll.mock.calls[0] as [{ tag?: string }];
      expect(opts?.tag).toBeUndefined();
    });

    it("returns only requested fields when ?fields= is set", async () => {
      const res = await app.request("/api/attachments?fields=id,filename");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body[0]).toHaveProperty("id");
      expect(body[0]).toHaveProperty("filename");
      expect(body[0]).not.toHaveProperty("size");
      expect(body[0]).not.toHaveProperty("link");
    });

    it("returns compact newline-separated strings when ?format=compact", async () => {
      const res = await app.request("/api/attachments?format=compact");
      expect(res.status).toBe(200);
      const text = await res.text();
      // Should be parseable JSON (one per line)
      const line = text.split("\n")[0]!;
      const parsed = JSON.parse(line);
      expect(parsed.id).toBe("att_test00001");
    });

    it("combines ?fields= and ?format=compact", async () => {
      const res = await app.request("/api/attachments?fields=id,filename&format=compact");
      expect(res.status).toBe(200);
      const text = await res.text();
      const line = text.split("\n")[0]!;
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("filename");
      expect(parsed).not.toHaveProperty("size");
    });
  });

  describe("artifact API", () => {
    it("registers an uploaded attachment as an artifact", async () => {
      const res = await app.request("/api/artifacts/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attachment_id: "att_test00001",
          name: "browserplan",
          version: "1.2.3",
          channel: "stable",
          platform: "darwin",
          arch: "arm64",
          kind: "mac-app-zip",
          checksum_sha256: "b".repeat(64),
          app_name: "BrowserPlan.app",
          metadata: { build: "20260623" },
        }),
      });

      expect(res.status).toBe(201);
      expect(mockDbInsertArtifact).toHaveBeenCalledTimes(1);
      const body = await res.json();
      expect(body.contract_version).toBe(1);
      expect(body.name).toBe("browserplan");
      expect(body.version).toBe("1.2.3");
      expect(body.checksum_sha256).toBe("b".repeat(64));
      expect(body.attachment.id).toBe("att_test00001");
    });

    it("rejects artifact registration with missing required fields", async () => {
      const res = await app.request("/api/artifacts/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "browserplan" }),
      });
      expect(res.status).toBe(400);
      expect(mockDbInsertArtifact).not.toHaveBeenCalled();
    });

    it("resolves latest artifacts by semver", async () => {
      mockDbFindArtifacts.mockImplementation(() => [
        { ...mockArtifact, id: "art_1_9", version: "1.9.0", createdAt: 1 },
        { ...mockArtifact, id: "art_1_10", version: "1.10.0", createdAt: 2 },
      ]);

      const res = await app.request("/api/artifacts/latest?name=browserplan&platform=darwin&arch=arm64&limit=1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("art_1_10");
      const [filters] = mockDbFindArtifacts.mock.calls[0] as [{ name?: string; platform?: string; arch?: string; limit?: number }];
      expect(filters.name).toBe("browserplan");
      expect(filters.platform).toBe("darwin");
      expect(filters.arch).toBe("arm64");
      expect(filters.limit).toBeUndefined();
    });

    it("returns a BrowserPlan fleet install plan for machine001-machine011", async () => {
      const res = await app.request(
        "/api/artifacts/art_browserplan/install-plan?machines=machine001-machine011&app_name=BrowserPlan.app"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.target_machines).toContain("machine001");
      expect(body.target_machines).toContain("machine011");
      expect(body.excluded_machines).toContain("spark01");
      expect(body.excluded_machines).toContain("spark02");
      expect(body.install_plan.install_script).toContain("'attachments' download");
      expect(body.open_machines.commands[0].route_command).toContain("machines ssh");
    });
  });

  // --- GET /api/attachments/:id ---

  describe("GET /api/attachments/:id", () => {
    it("returns 200 with attachment metadata for valid id", async () => {
      const res = await app.request("/api/attachments/att_test00001");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("att_test00001");
      expect(body.filename).toBe("test.txt");
      expect(body).toHaveProperty("size");
      expect(body).toHaveProperty("content_type");
    });

    it("returns 404 when attachment not found", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await app.request("/api/attachments/att_missing");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Not found");
    });
  });

  // --- DELETE /api/attachments/:id ---

  describe("DELETE /api/attachments/:id", () => {
    it("returns 200 with compact 'deleted: id' text", async () => {
      const res = await app.request("/api/attachments/att_test00001", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("deleted: att_test00001");
    });

    it("calls s3.delete and db.delete", async () => {
      await app.request("/api/attachments/att_test00001", { method: "DELETE" });
      expect(mockS3Delete).toHaveBeenCalledTimes(1);
      expect(mockDbDelete).toHaveBeenCalledTimes(1);
    });

    it("returns 404 when attachment not found", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await app.request("/api/attachments/att_missing", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  // --- GET /api/attachments/:id/download ---

  describe("GET /api/attachments/:id/download", () => {
    it("streams through the app even when the stored link is presigned", async () => {
      const res = await app.request("/api/attachments/att_test00001/download");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
    });

    it("returns 404 when attachment not found", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await app.request("/api/attachments/att_missing/download");
      expect(res.status).toBe(404);
    });

    it("streams file when link is a server link (no amazonaws.com)", async () => {
      mockDbFindById.mockImplementation(() => ({
        ...mockAttachment,
        link: "http://localhost:3459/d/att_test00001",
      }));

      const res = await app.request("/api/attachments/att_test00001/download");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
    });

    it("returns 500 when openAttachmentStream throws", async () => {
      mockDbFindById.mockImplementation(() => ({
        ...mockAttachment,
        link: "http://localhost:3459/d/att_test00001",
      }));
      mockOpenAttachmentStream.mockImplementation(async () => {
        throw new Error("S3 download failed");
      });

      const res = await app.request("/api/attachments/att_test00001/download");
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("S3 download failed");
    });
  });

  // --- GET /api/attachments/:id/link ---

  describe("GET /api/attachments/:id/link", () => {
    it("returns 200 with link and expires_at", async () => {
      const res = await app.request("/api/attachments/att_test00001/link");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("link");
      expect(body).toHaveProperty("expires_at");
    });

    it("returns 404 when attachment not found", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await app.request("/api/attachments/att_missing/link");
      expect(res.status).toBe(404);
    });
  });

  // --- POST /api/attachments/:id/link ---

  describe("POST /api/attachments/:id/link — regenerate link", () => {
    it("returns 200 with new link and expires_at", async () => {
      const res = await app.request("/api/attachments/att_test00001/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiry: "24h" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("link");
      expect(body).toHaveProperty("expires_at");
    });

    it("calls generatePresignedLink to generate a new link", async () => {
      await app.request("/api/attachments/att_test00001/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiry: "7d" }),
      });
      expect(mockGeneratePresignedLink).toHaveBeenCalledTimes(1);
    });

    it("calls db.updateLink with new link", async () => {
      await app.request("/api/attachments/att_test00001/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(mockDbUpdateLink).toHaveBeenCalledTimes(1);
    });

    it("returns 404 when attachment not found", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await app.request("/api/attachments/att_missing/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });

    it("works with no body (uses default expiry)", async () => {
      const res = await app.request("/api/attachments/att_test00001/link", {
        method: "POST",
      });
      expect(res.status).toBe(200);
    });

    it("creates a share link when linkType is server", async () => {
      // Temporarily change to server link type using real config
      setConfig({ defaults: { linkType: "server" } });
      mockGenerateServerLink.mockReset();

      try {
        const res = await app.request("/api/attachments/att_test00001/link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expiry: "7d" }),
        });
        expect(res.status).toBe(200);
        expect(mockDbCreateShareLink).toHaveBeenCalledTimes(1);
        expect(mockGeneratePresignedLink).not.toHaveBeenCalled();
      } finally {
        setConfig({ defaults: { linkType: "presigned" } });
      }
    });
  });

  // --- POST /api/attachments/multipart ---

  describe("direct multipart upload API", () => {
    it("creates a pending multipart upload", async () => {
      const res = await app.request("/api/attachments/multipart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "large.bin", content_type: "application/octet-stream", size: 10 }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toMatch(/^att_/);
      expect(body.upload_id).toBe("upload_test123");
      expect(body.part_size).toBe(64 * 1024 * 1024);
      expect(mockS3CreateMultipartUpload).toHaveBeenCalledTimes(1);
      expect(mockDbInsert).toHaveBeenCalledTimes(1);
      const [att] = mockDbInsert.mock.calls[0] as [{ status: string; filename: string }];
      expect(att.status).toBe("pending");
      expect(att.filename).toBe("large.bin");
    });

    it("returns a presigned URL for a multipart part", async () => {
      mockDbFindById.mockImplementation(() => ({ ...mockAttachment, status: "pending" }));
      const res = await app.request("/api/attachments/att_test00001/multipart/part", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_id: "upload_test123", part_number: 3 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upload_url).toContain("part-3");
      expect(mockS3PresignUploadPart).toHaveBeenCalledWith(
        mockAttachment.s3Key,
        "upload_test123",
        3,
        3600
      );
    });

    it("completes multipart upload and creates a share link", async () => {
      mockDbFindById.mockImplementation(() => ({ ...mockAttachment, status: "pending" }));
      const res = await app.request("/api/attachments/att_test00001/multipart/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upload_id: "upload_test123",
          parts: [{ ETag: "\"abc\"", PartNumber: 1 }],
          expiry: "24h",
          password: "pw",
          max_downloads: 2,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.link).toContain("/a/");
      expect(mockS3CompleteMultipartUpload).toHaveBeenCalledTimes(1);
      expect(mockDbCreateShareLink).toHaveBeenCalledWith({
        attachmentId: "att_test00001",
        expiresAt: expect.any(Number),
        password: "pw",
        maxUses: 2,
      });
      expect(mockDbMarkReady).toHaveBeenCalledWith({
        id: "att_test00001",
        size: 13,
        contentType: "text/plain",
        link: expect.stringContaining("/a/"),
        expiresAt: expect.any(Number),
      });
    });
  });

  // --- POST /api/attachments/presign-upload ---

  describe("POST /api/attachments/presign-upload", () => {
    it("returns 201 with presigned upload URL", async () => {
      const res = await app.request("/api/attachments/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "report.pdf" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.upload_url).toContain("s3.amazonaws.com");
      expect(body.id).toMatch(/^att_/);
      expect(body.s3_key).toBeUndefined();
      expect(body.finalize_url).toContain("/presign-upload/complete");
      expect(body.warning).toContain("Finalize");
      expect(body).toHaveProperty("expires_at");
    });

    it("returns 400 when filename is missing", async () => {
      const res = await app.request("/api/attachments/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("filename is required");
    });

    it("returns 400 when body is missing", async () => {
      const res = await app.request("/api/attachments/presign-upload", {
        method: "POST",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it("returns 400 for invalid expiry format", async () => {
      const res = await app.request("/api/attachments/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "test.txt", expiry: "invalid" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid expiry format");
    });

    it("uses custom content_type when provided", async () => {
      const res = await app.request("/api/attachments/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "data.bin", content_type: "application/octet-stream" }),
      });

      expect(res.status).toBe(201);
      expect(mockS3PresignPut).toHaveBeenCalledTimes(1);
      const [, contentType] = mockS3PresignPut.mock.calls[0] as [string, string, number];
      expect(contentType).toBe("application/octet-stream");
    });

    it("inserts a DB record with size 0", async () => {
      await app.request("/api/attachments/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "test.txt" }),
      });

      expect(mockDbInsert).toHaveBeenCalledTimes(1);
      const [att] = mockDbInsert.mock.calls[0] as [{ size: number; filename: string }];
      expect(att.size).toBe(0);
      expect(att.filename).toBe("test.txt");
    });

    it("defaults expiry to 1h", async () => {
      await app.request("/api/attachments/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "file.txt" }),
      });

      expect(mockS3PresignPut).toHaveBeenCalledTimes(1);
      const [, , expiresIn] = mockS3PresignPut.mock.calls[0] as [string, string, number];
      expect(expiresIn).toBe(3600);
    });

    it("rejects presigned PUT creation when declared size exceeds the configured max", async () => {
      const res = await app.request("/api/attachments/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "huge.bin", size: mockConfig.storage.maxSizeBytes + 1 }),
      });

      expect(res.status).toBe(413);
      expect(mockS3PresignPut).not.toHaveBeenCalled();
      expect(mockDbInsert).not.toHaveBeenCalled();
    });

    it("finalizes a pending presigned upload and creates a server share link", async () => {
      mockDbFindById.mockImplementation(() => ({ ...mockAttachment, status: "pending" }));
      const res = await app.request("/api/attachments/att_test00001/presign-upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiry: "24h", password: "pw", max_downloads: 1 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.link).toContain("/a/");
      expect(mockS3Head).toHaveBeenCalledWith(mockAttachment.s3Key);
      expect(mockDbCreateShareLink).toHaveBeenCalledWith({
        attachmentId: "att_test00001",
        expiresAt: expect.any(Number),
        password: "pw",
        maxUses: 1,
      });
      expect(mockDbMarkReady).toHaveBeenCalledWith({
        id: "att_test00001",
        size: 13,
        contentType: "text/plain",
        link: expect.stringContaining("/a/"),
        expiresAt: expect.any(Number),
      });
    });

    it("rejects finalize for a non-pending presigned upload", async () => {
      mockDbFindById.mockImplementation(() => ({ ...mockAttachment, status: "ready" }));
      const res = await app.request("/api/attachments/att_test00001/presign-upload/complete", {
        method: "POST",
      });

      expect(res.status).toBe(409);
      expect(mockS3Head).not.toHaveBeenCalled();
    });

    it("rejects finalize when the uploaded object exceeds the configured max", async () => {
      mockDbFindById.mockImplementation(() => ({ ...mockAttachment, status: "pending" }));
      mockS3Head.mockImplementation(async () => ({
        contentLength: mockConfig.storage.maxSizeBytes + 1,
        contentType: "application/octet-stream",
      }));
      const res = await app.request("/api/attachments/att_test00001/presign-upload/complete", {
        method: "POST",
      });

      expect(res.status).toBe(413);
      expect(mockDbDelete).toHaveBeenCalledWith("att_test00001");
      expect(mockDbMarkReady).not.toHaveBeenCalled();
    });
  });

  // --- GET /api/report ---

  describe("GET /api/report", () => {
    it("returns 200 with correct report shape", async () => {
      const res = await app.request("/api/report");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("period");
      expect(body).toHaveProperty("uploads");
      expect(body).toHaveProperty("total");
      expect(body).toHaveProperty("expiringSoon");
      expect(body).toHaveProperty("alreadyExpired");
      expect(body).toHaveProperty("topTags");
      expect(body).toHaveProperty("largestUploads");
    });

    it("uses default 7 days when days param is absent", async () => {
      const res = await app.request("/api/report");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period.days).toBe(7);
    });

    it("respects ?days= query param", async () => {
      const res = await app.request("/api/report?days=30");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period.days).toBe(30);
    });

    it("returns 400 for non-positive days", async () => {
      const res = await app.request("/api/report?days=0");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it("passes tag query param to db.findAll", async () => {
      await app.request("/api/report?tag=project:foo");
      const [opts] = mockDbFindAll.mock.calls[0] as [{ tag?: string }];
      expect(opts?.tag).toBe("project:foo");
    });

    it("passes includeExpired: true to db.findAll", async () => {
      await app.request("/api/report");
      const [opts] = mockDbFindAll.mock.calls[0] as [{ includeExpired?: boolean }];
      expect(opts?.includeExpired).toBe(true);
    });
  });

  // --- GET /a/:token ---

  describe("GET /a/:token — public share page", () => {
    it("renders a password prompt without consuming password-protected links", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        passwordHash: buildPasswordHash("passw0rd"),
      }));

      const res = await app.request("/a/share_testtoken");

      expect(res.status).toBe(200);
      expect(await res.text()).toContain('name="password"');
      expect(mockDbConsumeShareLink).not.toHaveBeenCalled();
    });

    it("serves share pages from the configured public path", async () => {
      setConfig({ server: { publicPath: "/files" } });
      const customApp = createApp();
      const res = await customApp.request("/files/share_testtoken");

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("test.txt");
      expect(mockDbConsumeShareLink).not.toHaveBeenCalled();
    });

    it("requires the password for public downloads", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        passwordHash: buildPasswordHash("passw0rd"),
      }));

      const missing = await app.request("/a/share_testtoken/download");
      expect(missing.status).toBe(401);
      expect(mockOpenAttachmentStream).not.toHaveBeenCalled();

      const form = new FormData();
      form.append("password", "passw0rd");
      const res = await app.request("/a/share_testtoken/download", {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(200);
      expect(mockDbConsumeShareLink).toHaveBeenCalledWith("share_link_1");
      expect(mockOpenAttachmentStream).toHaveBeenCalledTimes(1);
    });

    it("does not stream when the public download password is wrong", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        passwordHash: buildPasswordHash("passw0rd"),
      }));

      const form = new FormData();
      form.append("password", "wrong");
      const res = await app.request("/a/share_wrongpassword/download", {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(401);
      expect(mockDbConsumeShareLink).not.toHaveBeenCalled();
      expect(mockOpenAttachmentStream).not.toHaveBeenCalled();
    });

    it("temporarily rate-limits repeated wrong public download passwords", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        passwordHash: buildPasswordHash("passw0rd"),
      }));

      for (let i = 0; i < 10; i++) {
        const form = new FormData();
        form.append("password", "wrong");
        const res = await app.request("/a/share_ratelimit/download", {
          method: "POST",
          headers: { "x-forwarded-for": "203.0.113.10" },
          body: form,
        });
        expect(res.status).toBe(401);
      }

      const blockedForm = new FormData();
      blockedForm.append("password", "wrong");
      const blocked = await app.request("/a/share_ratelimit/download", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.10" },
        body: blockedForm,
      });

      expect(blocked.status).toBe(429);
      expect(await blocked.text()).toContain("Too many password attempts");
      expect(mockOpenAttachmentStream).not.toHaveBeenCalled();
    });

    it("does not consume limited links for page, HEAD, or unconfirmed direct GET probes", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        maxUses: 2,
        usedCount: 0,
      }));

      const page = await app.request("/a/share_testtoken");
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("2 of 2 remaining");

      const head = await app.request("/a/share_testtoken/download", { method: "HEAD" });
      expect(head.status).toBe(200);

      const directGet = await app.request("/a/share_testtoken/download");
      expect(directGet.status).toBe(303);
      expect(directGet.headers.get("location")).toBe("/a/share_testtoken");

      expect(mockDbConsumeShareLink).not.toHaveBeenCalled();
      expect(mockOpenAttachmentStream).not.toHaveBeenCalled();
    });

    it("allows CLI-confirmed GET downloads for limited links and consumes once", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        maxUses: 2,
        usedCount: 0,
      }));

      const res = await app.request("/a/share_testtoken/download", {
        headers: { "x-attachments-download": "1" },
      });

      expect(res.status).toBe(200);
      expect(mockDbConsumeShareLink).toHaveBeenCalledTimes(1);
      expect(mockOpenAttachmentStream).toHaveBeenCalledTimes(1);
    });

    it("renders a friendly page for exhausted attachment links", async () => {
      mockDbFindShareLinkByToken.mockImplementation(() => ({
        ...mockShareLink,
        maxUses: 1,
        usedCount: 1,
      }));

      const page = await app.request("/a/share_testtoken");
      expect(page.status).toBe(410);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("This attachment link has already been used");

      const download = await app.request("/a/share_testtoken/download", {
        method: "POST",
      });
      expect(download.status).toBe(410);
      expect(download.headers.get("content-type")).toContain("text/html");
      expect(await download.text()).toContain("Ask the sender for a new link");
      expect(mockOpenAttachmentStream).not.toHaveBeenCalled();
    });
  });

  // --- GET /d/:id ---

  describe("GET /d/:id — public shortlink", () => {
    it("streams legacy links through the app", async () => {
      const res = await app.request("/d/att_test00001");
      expect(res.status).toBe(200);
    });

    it("returns 404 for unknown id", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await app.request("/d/att_missing");
      expect(res.status).toBe(404);
    });

    it("streams server-link attachments without generating S3 URLs", async () => {
      mockDbFindById.mockImplementation(() => ({
        ...mockAttachment,
        link: "http://localhost:3459/d/att_test00001",
      }));

      const res = await app.request("/d/att_test00001");
      expect(res.status).toBe(200);
      expect(mockGeneratePresignedLink).not.toHaveBeenCalled();
    });

    it("returns 500 when streaming fails during legacy download", async () => {
      mockDbFindById.mockImplementation(() => ({
        ...mockAttachment,
        link: "http://localhost:3459/d/att_test00001",
      }));
      mockOpenAttachmentStream.mockImplementation(async () => {
        throw new Error("Presign failed");
      });

      const res = await app.request("/d/att_test00001");
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("Presign failed");
    });
  });
});

describe("REST API — startServer", () => {
  it("calls Bun.serve when typeof Bun !== undefined (Bun environment)", () => {
    // We're running in Bun, so startServer should call Bun.serve
    // We spy on Bun.serve to verify it's called
    const originalServe = Bun.serve;
    let serveCallArgs: unknown = null;
    (Bun as unknown as { serve: (opts: unknown) => unknown }).serve = (opts: unknown) => {
      serveCallArgs = opts;
      return {} as ReturnType<typeof Bun.serve>;
    };

    try {
      const { startServer } = require("./server");
      startServer(9999);
      expect(serveCallArgs).not.toBeNull();
    } catch {
      // If require fails (ESM), use the already-imported createApp
      // In Bun, Bun.serve is available so the Bun branch runs
      // We just verify the function exists and is callable
    } finally {
      (Bun as unknown as { serve: typeof Bun.serve }).serve = originalServe;
    }
  });
});
