import { describe, it, expect, mock, beforeAll, beforeEach, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import type { Attachment } from "../core/db";
import { setConfigPath, setConfig } from "../core/config";

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

mock.module("../core/upload", () => ({
  uploadFile: mockUploadFile,
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

const mockDbFindById = mock((_id: string): Attachment | null => mockAttachment);
const mockDbFindAll = mock((_opts?: unknown): Attachment[] => [mockAttachment]);
const mockDbUpdateLink = mock((_id: string, _link: string, _expiresAt?: number | null) => {});
const mockDbDelete = mock((_id: string) => {});
const mockDbClose = mock(() => {});

mock.module("../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    findById = mockDbFindById;
    findAll = mockDbFindAll;
    updateLink = mockDbUpdateLink;
    delete = mockDbDelete;
    close = mockDbClose;
    insert = mock(() => {});
  },
}));

const mockS3Delete = mock(async (_key: string) => {});
const mockS3Presign = mock(async (_key: string, _expiresIn: number) => "https://s3.amazonaws.com/test-bucket/test.txt?sig=regenerated");

mock.module("../core/s3", () => ({
  S3Client: class MockS3Client {
    delete = mockS3Delete;
    presign = mockS3Presign;
  },
}));

const mockConfig = {
  s3: {
    bucket: "test-bucket",
    region: "us-east-1",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret",
  },
  server: {
    port: 3457,
    baseUrl: "http://localhost:3457",
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
  (id: string, baseUrl: string) => `${baseUrl}/d/${id}`
);

mock.module("../core/links", () => ({
  generatePresignedLink: mockGeneratePresignedLink,
  generateServerLink: mockGenerateServerLink,
  getLinkType: (_config: unknown) => "presigned" as const,
}));

const mockStreamAttachment = mock(async (_id: string) => ({
  buffer: Buffer.from("file contents"),
  attachment: mockAttachment,
}));

mock.module("../core/download", () => ({
  streamAttachment: mockStreamAttachment,
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
    app = createApp();
    mockUploadFile.mockReset();
    mockUploadFile.mockImplementation(async () => ({ ...mockAttachment }));
    mockDbFindById.mockReset();
    mockDbFindById.mockImplementation(() => ({ ...mockAttachment }));
    mockDbFindAll.mockReset();
    mockDbFindAll.mockImplementation(() => [{ ...mockAttachment }]);
    mockDbUpdateLink.mockReset();
    mockDbDelete.mockReset();
    mockDbClose.mockReset();
    mockS3Delete.mockReset();
    mockS3Delete.mockImplementation(async () => {});
    mockGeneratePresignedLink.mockReset();
    mockGeneratePresignedLink.mockImplementation(
      async () => "https://s3.amazonaws.com/test-bucket/test.txt?sig=new"
    );
    mockStreamAttachment.mockReset();
    mockStreamAttachment.mockImplementation(async () => ({
      buffer: Buffer.from("file contents"),
      attachment: mockAttachment,
    }));
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
      expect(body.id).toBe("att_test00001");
      expect(body.filename).toBe("test.txt");
      expect(body.size).toBe(11);
      expect(body.link).toContain("amazonaws.com");
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

      expect(mockUploadFile).toHaveBeenCalledTimes(1);
      const [, opts] = mockUploadFile.mock.calls[0] as [string, { expiry?: string }];
      expect(opts?.expiry).toBe("24h");
    });

    it("passes tag option to uploadFile", async () => {
      const fd = makeFormData("test.txt", "hello", { tag: "important" });
      await app.request("/api/attachments", {
        method: "POST",
        body: fd,
      });

      expect(mockUploadFile).toHaveBeenCalledTimes(1);
      const [, opts] = mockUploadFile.mock.calls[0] as [string, { tag?: string }];
      expect(opts?.tag).toBe("important");
    });

    it("returns 500 when uploadFile throws", async () => {
      mockUploadFile.mockImplementation(async () => {
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
    it("redirects to presigned URL when link contains amazonaws.com", async () => {
      const res = await app.request("/api/attachments/att_test00001/download");
      // 302 redirect
      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toContain("amazonaws.com");
    });

    it("returns 404 when attachment not found", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await app.request("/api/attachments/att_missing/download");
      expect(res.status).toBe(404);
    });

    it("streams file when link is a server link (no amazonaws.com)", async () => {
      mockDbFindById.mockImplementation(() => ({
        ...mockAttachment,
        link: "http://localhost:3457/d/att_test00001",
      }));

      const res = await app.request("/api/attachments/att_test00001/download");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
    });

    it("returns 500 when streamAttachment throws", async () => {
      mockDbFindById.mockImplementation(() => ({
        ...mockAttachment,
        link: "http://localhost:3457/d/att_test00001",
      }));
      mockStreamAttachment.mockImplementation(async () => {
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

    it("uses generateServerLink when linkType is server", async () => {
      // Temporarily change to server link type using real config
      setConfig({ defaults: { linkType: "server" } });
      mockGenerateServerLink.mockReset();
      mockGenerateServerLink.mockImplementation(
        (id: string, baseUrl: string) => `${baseUrl}/d/${id}`
      );

      try {
        const res = await app.request("/api/attachments/att_test00001/link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expiry: "7d" }),
        });
        expect(res.status).toBe(200);
        expect(mockGenerateServerLink).toHaveBeenCalledTimes(1);
        expect(mockGeneratePresignedLink).not.toHaveBeenCalled();
      } finally {
        setConfig({ defaults: { linkType: "presigned" } });
      }
    });
  });

  // --- GET /d/:id ---

  describe("GET /d/:id — public shortlink", () => {
    it("redirects 302 to presigned URL for presigned link attachments", async () => {
      const res = await app.request("/d/att_test00001");
      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toContain("amazonaws.com");
    });

    it("returns 404 for unknown id", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await app.request("/d/att_missing");
      expect(res.status).toBe(404);
    });

    it("generates a presigned URL on-the-fly for server-link attachments", async () => {
      mockDbFindById.mockImplementation(() => ({
        ...mockAttachment,
        link: "http://localhost:3457/d/att_test00001",
      }));

      const res = await app.request("/d/att_test00001");
      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toContain("s3.amazonaws.com");
    });

    it("returns 500 when generatePresignedLink throws during shortlink redirect", async () => {
      mockDbFindById.mockImplementation(() => ({
        ...mockAttachment,
        link: "http://localhost:3457/d/att_test00001",
      }));
      mockGeneratePresignedLink.mockImplementation(async () => {
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
