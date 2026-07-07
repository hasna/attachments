import { describe, it, expect } from "bun:test";
import { setConfig } from "../core/config";
import {
  currentApp,
  mockAttachment,
  mockDbCreateShareLink,
  mockDbDelete,
  mockDbFindById,
  mockDbUpdateLink,
  mockGeneratePresignedLink,
  mockGenerateServerLink,
  mockOpenAttachmentStream,
  mockS3Delete,
} from "./server.test-harness.test";

describe("REST API server attachment routes", () => {
  describe("GET /api/attachments/:id", () => {
    it("returns 200 with attachment metadata for valid id", async () => {
      const res = await currentApp().request("/api/attachments/att_test00001");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("att_test00001");
      expect(body.filename).toBe("test.txt");
      expect(body).toHaveProperty("size");
      expect(body).toHaveProperty("content_type");
    });

    it("returns 404 when attachment not found", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await currentApp().request("/api/attachments/att_missing");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Not found");
    });
  });

  describe("DELETE /api/attachments/:id", () => {
    it("returns 200 with compact 'deleted: id' text", async () => {
      const res = await currentApp().request("/api/attachments/att_test00001", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("deleted: att_test00001");
    });

    it("calls s3.delete and db.delete", async () => {
      await currentApp().request("/api/attachments/att_test00001", { method: "DELETE" });
      expect(mockS3Delete).toHaveBeenCalledTimes(1);
      expect(mockDbDelete).toHaveBeenCalledTimes(1);
    });

    it("returns 404 when attachment not found", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await currentApp().request("/api/attachments/att_missing", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/attachments/:id/download", () => {
    it("streams through the app even when the stored link is presigned", async () => {
      const res = await currentApp().request("/api/attachments/att_test00001/download");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
    });

    it("returns 404 when attachment not found", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await currentApp().request("/api/attachments/att_missing/download");
      expect(res.status).toBe(404);
    });

    it("streams file when link is a server link (no amazonaws.com)", async () => {
      mockDbFindById.mockImplementation(() => ({
        ...mockAttachment,
        link: "http://localhost:3459/d/att_test00001",
      }));

      const res = await currentApp().request("/api/attachments/att_test00001/download");
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

      const res = await currentApp().request("/api/attachments/att_test00001/download");
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("S3 download failed");
    });
  });

  describe("GET /api/attachments/:id/link", () => {
    it("returns 200 with link and expires_at", async () => {
      const res = await currentApp().request("/api/attachments/att_test00001/link");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("link");
      expect(body).toHaveProperty("expires_at");
    });

    it("returns 404 when attachment not found", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await currentApp().request("/api/attachments/att_missing/link");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/attachments/:id/link — regenerate link", () => {
    it("returns 200 with new link and expires_at", async () => {
      const res = await currentApp().request("/api/attachments/att_test00001/link", {
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
      await currentApp().request("/api/attachments/att_test00001/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiry: "7d" }),
      });
      expect(mockGeneratePresignedLink).toHaveBeenCalledTimes(1);
    });

    it("calls db.updateLink with new link", async () => {
      await currentApp().request("/api/attachments/att_test00001/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(mockDbUpdateLink).toHaveBeenCalledTimes(1);
    });

    it("returns 404 when attachment not found", async () => {
      mockDbFindById.mockImplementation(() => null);
      const res = await currentApp().request("/api/attachments/att_missing/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });

    it("works with no body (uses default expiry)", async () => {
      const res = await currentApp().request("/api/attachments/att_test00001/link", {
        method: "POST",
      });
      expect(res.status).toBe(200);
    });

    it("creates a share link when linkType is server", async () => {
      setConfig({ defaults: { linkType: "server" } });
      mockGenerateServerLink.mockReset();

      try {
        const res = await currentApp().request("/api/attachments/att_test00001/link", {
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
});
