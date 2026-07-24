import { describe, it, expect } from "bun:test";
import {
  currentApp,
  mockAttachment,
  mockConfig,
  mockDbCreateShareLink,
  mockDbDelete,
  mockDbFindAll,
  mockDbFindById,
  mockDbInsert,
  mockDbMarkReady,
  mockS3CompleteMultipartUpload,
  mockS3CreateMultipartUpload,
  mockS3Head,
  mockS3PresignPut,
  mockS3PresignUploadPart,
} from "./server.test-harness.test";

describe("REST API server direct upload flows", () => {
  describe("direct multipart upload API", () => {
    it("creates a pending multipart upload", async () => {
      const res = await currentApp().request("/api/attachments/multipart", {
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
      const res = await currentApp().request("/api/attachments/att_test00001/multipart/part", {
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
      const res = await currentApp().request("/api/attachments/att_test00001/multipart/complete", {
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

  describe("POST /api/attachments/presign-upload", () => {
    it("returns 201 with presigned upload URL", async () => {
      const res = await currentApp().request("/api/attachments/presign-upload", {
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
      const res = await currentApp().request("/api/attachments/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("filename is required");
    });

    it("returns 400 when body is missing", async () => {
      const res = await currentApp().request("/api/attachments/presign-upload", {
        method: "POST",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it("returns 400 for invalid expiry format", async () => {
      const res = await currentApp().request("/api/attachments/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "test.txt", expiry: "invalid" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid expiry format");
    });

    it("uses custom content_type when provided", async () => {
      const res = await currentApp().request("/api/attachments/presign-upload", {
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
      await currentApp().request("/api/attachments/presign-upload", {
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
      await currentApp().request("/api/attachments/presign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "file.txt" }),
      });

      expect(mockS3PresignPut).toHaveBeenCalledTimes(1);
      const [, , expiresIn] = mockS3PresignPut.mock.calls[0] as [string, string, number];
      expect(expiresIn).toBe(3600);
    });

    it("rejects presigned PUT creation when declared size exceeds the configured max", async () => {
      const res = await currentApp().request("/api/attachments/presign-upload", {
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
      const res = await currentApp().request("/api/attachments/att_test00001/presign-upload/complete", {
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
      const res = await currentApp().request("/api/attachments/att_test00001/presign-upload/complete", {
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
      const res = await currentApp().request("/api/attachments/att_test00001/presign-upload/complete", {
        method: "POST",
      });

      expect(res.status).toBe(413);
      expect(mockDbDelete).toHaveBeenCalledWith("att_test00001");
      expect(mockDbMarkReady).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/report", () => {
    it("returns 200 with correct report shape", async () => {
      const res = await currentApp().request("/api/report");
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
      const res = await currentApp().request("/api/report");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period.days).toBe(7);
    });

    it("respects ?days= query param", async () => {
      const res = await currentApp().request("/api/report?days=30");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period.days).toBe(30);
    });

    it("returns 400 for non-positive days", async () => {
      const res = await currentApp().request("/api/report?days=0");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it("passes tag query param to db.findAll", async () => {
      await currentApp().request("/api/report?tag=project:foo");
      const [opts] = mockDbFindAll.mock.calls[0] as [{ tag?: string }];
      expect(opts?.tag).toBe("project:foo");
    });

    it("passes includeExpired: true to db.findAll", async () => {
      await currentApp().request("/api/report");
      const [opts] = mockDbFindAll.mock.calls[0] as [{ includeExpired?: boolean }];
      expect(opts?.includeExpired).toBe(true);
    });
  });
});
