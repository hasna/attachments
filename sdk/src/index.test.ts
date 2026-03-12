import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { AttachmentsClient } from "./index";

// ── Fixtures ──────────────────────────────────────────────────────────────

const BASE_URL = "http://localhost:3457";

const rawAttachment = {
  id: "abc123",
  filename: "photo.jpg",
  s3_key: "uploads/photo.jpg",
  bucket: "my-bucket",
  size: 12345,
  content_type: "image/jpeg",
  link: "https://example.com/link",
  expires_at: 9999999999,
  created_at: 1700000000,
};

const expectedAttachment = {
  id: "abc123",
  filename: "photo.jpg",
  s3Key: "uploads/photo.jpg",
  bucket: "my-bucket",
  size: 12345,
  contentType: "image/jpeg",
  link: "https://example.com/link",
  expiresAt: 9999999999,
  createdAt: 1700000000,
};

// ── Fetch mock helpers ────────────────────────────────────────────────────

function mockFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  const responseHeaders = new Headers({
    "content-type": "application/json",
    ...headers,
  });

  const isText = typeof body === "string";

  const response = new Response(isText ? body : JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });

  // @ts-expect-error — replacing global fetch in test
  globalThis.fetch = mock(async () => response);
}

function mockFetchBinary(
  status: number,
  buffer: Buffer,
  headers: Record<string, string> = {}
) {
  const responseHeaders = new Headers({
    "content-type": "application/octet-stream",
    ...headers,
  });

  const response = new Response(buffer, { status, headers: responseHeaders });
  // @ts-expect-error — replacing global fetch in test
  globalThis.fetch = mock(async () => response);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("AttachmentsClient", () => {
  let client: AttachmentsClient;

  beforeEach(() => {
    client = new AttachmentsClient({ serverUrl: BASE_URL });
  });

  // ── constructor ──────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("strips trailing slash from serverUrl", async () => {
      const c = new AttachmentsClient({ serverUrl: "http://localhost:3457/" });
      mockFetch(200, [rawAttachment]);
      await c.list();
      // @ts-expect-error — accessing mock
      const [calledUrl] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(calledUrl).toStartWith("http://localhost:3457/api/");
      expect(calledUrl).not.toContain("//api");
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────

  describe("list()", () => {
    it("calls GET /api/attachments with no params by default", async () => {
      mockFetch(200, [rawAttachment]);
      const result = await client.list();
      // @ts-expect-error
      const [url, init] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/attachments`);
      expect(init).toBeUndefined();
      expect(result).toEqual([expectedAttachment]);
    });

    it("appends limit query param", async () => {
      mockFetch(200, [rawAttachment]);
      await client.list({ limit: 5 });
      // @ts-expect-error
      const [url] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(url).toContain("limit=5");
    });

    it("appends fields query param", async () => {
      mockFetch(200, [rawAttachment]);
      await client.list({ fields: ["id", "filename"] });
      // @ts-expect-error
      const [url] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(url).toContain("fields=id%2Cfilename");
    });

    it("appends format=compact and parses newline-delimited JSON", async () => {
      const ndjson = JSON.stringify(rawAttachment) + "\n" + JSON.stringify(rawAttachment);
      mockFetch(200, ndjson, { "content-type": "text/plain" });
      const result = await client.list({ format: "compact" });
      // @ts-expect-error
      const [url] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(url).toContain("format=compact");
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(expectedAttachment);
    });

    it("throws on non-200 response", async () => {
      mockFetch(500, { error: "internal error" });
      await expect(client.list()).rejects.toThrow("internal error");
    });
  });

  // ── get ──────────────────────────────────────────────────────────────────

  describe("get()", () => {
    it("calls GET /api/attachments/:id", async () => {
      mockFetch(200, rawAttachment);
      const result = await client.get("abc123");
      // @ts-expect-error
      const [url] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/attachments/abc123`);
      expect(result).toEqual(expectedAttachment);
    });

    it("throws on 404", async () => {
      mockFetch(404, { error: "Not found" });
      await expect(client.get("nope")).rejects.toThrow("Not found");
    });

    it("throws with HTTP status when body has no error field", async () => {
      mockFetch(503, "Service Unavailable");
      await expect(client.get("x")).rejects.toThrow("HTTP 503");
    });
  });

  // ── delete ───────────────────────────────────────────────────────────────

  describe("delete()", () => {
    it("calls DELETE /api/attachments/:id", async () => {
      mockFetch(200, "deleted: abc123", { "content-type": "text/plain" });
      await client.delete("abc123");
      // @ts-expect-error
      const [url, init] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/attachments/abc123`);
      expect(init.method).toBe("DELETE");
    });

    it("throws on 404", async () => {
      mockFetch(404, { error: "Not found" });
      await expect(client.delete("nope")).rejects.toThrow("Not found");
    });

    it("resolves void on success", async () => {
      mockFetch(200, "deleted: abc123", { "content-type": "text/plain" });
      const result = await client.delete("abc123");
      expect(result).toBeUndefined();
    });
  });

  // ── getLink ──────────────────────────────────────────────────────────────

  describe("getLink()", () => {
    it("calls GET /api/attachments/:id/link and returns link string", async () => {
      mockFetch(200, { link: "https://cdn.example.com/file.jpg", expires_at: 9999 });
      const link = await client.getLink("abc123");
      // @ts-expect-error
      const [url] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/attachments/abc123/link`);
      expect(link).toBe("https://cdn.example.com/file.jpg");
    });

    it("throws on 404", async () => {
      mockFetch(404, { error: "Not found" });
      await expect(client.getLink("nope")).rejects.toThrow("Not found");
    });
  });

  // ── regenerateLink ───────────────────────────────────────────────────────

  describe("regenerateLink()", () => {
    it("calls POST /api/attachments/:id/link with empty body by default", async () => {
      mockFetch(200, { link: "https://cdn.example.com/new-link.jpg", expires_at: null });
      const link = await client.regenerateLink("abc123");
      // @ts-expect-error
      const [url, init] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/attachments/abc123/link`);
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(init.body)).toEqual({});
      expect(link).toBe("https://cdn.example.com/new-link.jpg");
    });

    it("sends expiry in the request body", async () => {
      mockFetch(200, { link: "https://cdn.example.com/new.jpg", expires_at: 99999 });
      await client.regenerateLink("abc123", { expiry: "7d" });
      // @ts-expect-error
      const [, init] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ expiry: "7d" });
    });

    it("throws on non-200 response", async () => {
      mockFetch(404, { error: "Not found" });
      await expect(client.regenerateLink("bad")).rejects.toThrow("Not found");
    });
  });

  // ── upload ───────────────────────────────────────────────────────────────

  describe("upload()", () => {
    it("calls POST /api/attachments with FormData when given a Blob", async () => {
      mockFetch(201, rawAttachment);
      const blob = new Blob(["hello"], { type: "text/plain" });
      const result = await client.upload(blob);
      // @ts-expect-error
      const [url, init] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/attachments`);
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);
      expect(result).toEqual(expectedAttachment);
    });

    it("calls POST /api/attachments with FormData when given a File", async () => {
      mockFetch(201, rawAttachment);
      const file = new File(["content"], "test.txt", { type: "text/plain" });
      await client.upload(file);
      // @ts-expect-error
      const [, init] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);
    });

    it("appends expiry and tag to FormData when provided (Blob)", async () => {
      mockFetch(201, rawAttachment);
      const blob = new Blob(["hi"]);
      await client.upload(blob, { expiry: "24h", tag: "test-tag" });
      // @ts-expect-error
      const [, init] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      const form = init.body as FormData;
      expect(form.get("expiry")).toBe("24h");
      expect(form.get("tag")).toBe("test-tag");
    });

    it("throws on non-201 response", async () => {
      mockFetch(400, { error: "file field is required" });
      await expect(client.upload(new Blob([]))).rejects.toThrow("file field is required");
    });
  });

  // ── download ─────────────────────────────────────────────────────────────

  describe("download()", () => {
    it("builds correct download URL from attachment ID and writes file", async () => {
      const fileContent = "file content here";
      const buf = Buffer.from(fileContent);
      mockFetchBinary(200, buf, {
        "content-disposition": 'attachment; filename="photo.jpg"',
      });

      const outPath = `/tmp/sdk-test-download-${Date.now()}.jpg`;
      const result = await client.download("abc123", outPath);

      // @ts-expect-error
      const [url] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/attachments/abc123/download`);
      expect(result.filename).toBe("photo.jpg");
      expect(result.size).toBe(buf.length);
      expect(result.path).toBe(outPath);

      // Verify the file was actually written
      const { readFileSync, unlinkSync } = await import("fs");
      const written = readFileSync(outPath);
      expect(written.toString()).toBe(fileContent);
      unlinkSync(outPath);
    });

    it("uses full URL directly when idOrUrl starts with http", async () => {
      const buf = Buffer.from("data bytes");
      mockFetchBinary(200, buf, {
        "content-disposition": 'attachment; filename="file.txt"',
      });

      const outPath = `/tmp/sdk-test-download-http-${Date.now()}.txt`;
      await client.download("https://cdn.example.com/download/123", outPath);

      // @ts-expect-error
      const [url] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
      expect(url).toBe("https://cdn.example.com/download/123");

      const { unlinkSync } = await import("fs");
      unlinkSync(outPath);
    });

    it("writes to cwd/filename when no destPath provided", async () => {
      const buf = Buffer.from("cwd content");
      mockFetchBinary(200, buf, {
        "content-disposition": 'attachment; filename="cwd-file.txt"',
      });

      // We need to know where process.cwd() is to clean up
      const { join } = await import("path");
      const expectedPath = join(process.cwd(), "cwd-file.txt");

      const result = await client.download("abc123");
      expect(result.filename).toBe("cwd-file.txt");
      expect(result.path).toBe(expectedPath);

      const { unlinkSync } = await import("fs");
      try { unlinkSync(expectedPath); } catch { /* may not exist if test dir is weird */ }
    });

    it("throws on non-200 response", async () => {
      mockFetch(404, { error: "Not found" });
      await expect(client.download("bad-id")).rejects.toThrow("Not found");
    });
  });

  // ── mapAttachment fallbacks ───────────────────────────────────────────────

  describe("field mapping fallbacks", () => {
    it("defaults s3Key and bucket to empty string when absent in response", async () => {
      const minimal = {
        id: "min1",
        filename: "file.txt",
        size: 100,
        link: null,
        expires_at: null,
        created_at: 1700000000,
      };
      mockFetch(200, minimal);
      const result = await client.get("min1");
      expect(result.s3Key).toBe("");
      expect(result.bucket).toBe("");
      expect(result.contentType).toBe("");
    });
  });
});
