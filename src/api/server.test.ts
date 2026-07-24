import { describe, it, expect } from "bun:test";
import {
  createApp,
  currentApp,
  makeFormData,
  mockAttachment,
  mockDbFindAll,
  mockUploadStreamAttachment,
} from "./server.test-harness.test";

describe("REST API server", () => {
  describe("GET /api/health", () => {
    it("returns 200 with correct shape", async () => {
      mockDbFindAll.mockImplementation(() => [
        { ...mockAttachment, expiresAt: Date.now() - 1000 },
        { ...mockAttachment, id: "att_test00002", expiresAt: Date.now() + 1000 },
      ]);

      const res = await currentApp().request("/api/health");
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
      const res = await currentApp().request("/api/health");
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
      const res = await currentApp().request("/api/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.api_auth_required).toBe(true);
    });

    it("rejects operational API requests without the configured token", async () => {
      process.env.ATTACHMENTS_API_TOKEN = "secret-token";
      const res = await currentApp().request("/api/attachments");
      expect(res.status).toBe(401);
    });

    it("accepts bearer tokens for operational API requests", async () => {
      process.env.ATTACHMENTS_API_TOKEN = "secret-token";
      const res = await currentApp().request("/api/attachments", {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/attachments", () => {
    it("returns 201 with attachment data on successful upload", async () => {
      const fd = makeFormData("test.txt", "hello world");
      const res = await currentApp().request("/api/attachments", {
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
      const res = await currentApp().request("/api/attachments", {
        method: "POST",
        body: fd,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it("passes expiry option to uploadFile", async () => {
      const fd = makeFormData("test.txt", "hello", { expiry: "24h" });
      await currentApp().request("/api/attachments", {
        method: "POST",
        body: fd,
      });

      expect(mockUploadStreamAttachment).toHaveBeenCalledTimes(1);
      const [, , , opts] = mockUploadStreamAttachment.mock.calls[0] as [
        unknown,
        string,
        string,
        { expiry?: string },
      ];
      expect(opts?.expiry).toBe("24h");
    });

    it("passes tag option to uploadFile", async () => {
      const fd = makeFormData("test.txt", "hello", { tag: "important" });
      await currentApp().request("/api/attachments", {
        method: "POST",
        body: fd,
      });

      expect(mockUploadStreamAttachment).toHaveBeenCalledTimes(1);
      const [, , , opts] = mockUploadStreamAttachment.mock.calls[0] as [
        unknown,
        string,
        string,
        { tag?: string },
      ];
      expect(opts?.tag).toBe("important");
    });

    it("returns 413 when Content-Length exceeds ATTACHMENTS_MAX_SIZE", async () => {
      process.env.ATTACHMENTS_MAX_SIZE = "100";
      const localApp = createApp();
      const fd = makeFormData("test.txt", "hello");
      const res = await localApp.request("/api/attachments", {
        method: "POST",
        body: fd,
        headers: { "content-length": "200" },
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
      const res = await currentApp().request("/api/attachments", {
        method: "POST",
        body: fd,
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("S3 upload failed");
    });
  });

  describe("PUT /api/attachments", () => {
    it("streams the request body through uploadStreamAttachment", async () => {
      const res = await currentApp().request("/api/attachments?filename=stream.txt&expiry=24h&encrypt=1", {
        method: "PUT",
        headers: {
          "content-type": "text/plain",
          "content-length": "13",
          "x-attachments-password": "pw",
        },
        body: "file contents",
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("att_stream0001");
      expect(body.link).toContain("/a/");
      expect(mockUploadStreamAttachment).toHaveBeenCalledTimes(1);
      const [, filename, contentType, opts] = mockUploadStreamAttachment.mock.calls[0] as [
        unknown,
        string,
        string,
        { expiry?: string; password?: string; encrypt?: boolean; size?: number },
      ];
      expect(filename).toBe("stream.txt");
      expect(contentType).toBe("text/plain");
      expect(opts.expiry).toBe("24h");
      expect(opts.password).toBe("pw");
      expect(opts.encrypt).toBe(true);
      expect(opts.size).toBe(13);
    });

    it("rejects PUT uploads above the configured max by Content-Length", async () => {
      process.env.ATTACHMENTS_MAX_SIZE = "5";
      const res = await currentApp().request("/api/attachments?filename=big.txt", {
        method: "PUT",
        headers: { "content-type": "text/plain", "content-length": "13" },
        body: "file contents",
      });
      expect(res.status).toBe(413);
      expect(mockUploadStreamAttachment).not.toHaveBeenCalled();
      delete process.env.ATTACHMENTS_MAX_SIZE;
    });
  });

  describe("GET /api/attachments", () => {
    it("returns 200 with a JSON array", async () => {
      const res = await currentApp().request("/api/attachments");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
      expect(body[0].id).toBe("att_test00001");
    });

    it("passes limit query param to db.findAll", async () => {
      await currentApp().request("/api/attachments?limit=5");
      const [opts] = mockDbFindAll.mock.calls[0] as [{ limit?: number }];
      expect(opts?.limit).toBe(5);
    });

    it("passes expired=true to db.findAll as includeExpired", async () => {
      await currentApp().request("/api/attachments?expired=true");
      const [opts] = mockDbFindAll.mock.calls[0] as [{ includeExpired?: boolean }];
      expect(opts?.includeExpired).toBe(true);
    });

    it("passes tag query param to db.findAll", async () => {
      await currentApp().request("/api/attachments?tag=session-123");
      const [opts] = mockDbFindAll.mock.calls[0] as [{ tag?: string }];
      expect(opts?.tag).toBe("session-123");
    });

    it("does not pass tag when query param is missing", async () => {
      await currentApp().request("/api/attachments");
      const [opts] = mockDbFindAll.mock.calls[0] as [{ tag?: string }];
      expect(opts?.tag).toBeUndefined();
    });

    it("returns only requested fields when ?fields= is set", async () => {
      const res = await currentApp().request("/api/attachments?fields=id,filename");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body[0]).toHaveProperty("id");
      expect(body[0]).toHaveProperty("filename");
      expect(body[0]).not.toHaveProperty("size");
      expect(body[0]).not.toHaveProperty("link");
    });

    it("returns compact newline-separated strings when ?format=compact", async () => {
      const res = await currentApp().request("/api/attachments?format=compact");
      expect(res.status).toBe(200);
      const text = await res.text();
      const line = text.split("\n")[0]!;
      const parsed = JSON.parse(line);
      expect(parsed.id).toBe("att_test00001");
    });

    it("combines ?fields= and ?format=compact", async () => {
      const res = await currentApp().request("/api/attachments?fields=id,filename&format=compact");
      expect(res.status).toBe(200);
      const text = await res.text();
      const line = text.split("\n")[0]!;
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("filename");
      expect(parsed).not.toHaveProperty("size");
    });
  });
});
