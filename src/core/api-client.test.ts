import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { Readable } from "stream";
import {
  deleteCloudAttachment,
  downloadFromCloud,
  getCloudAttachmentLink,
  getCloudHealth,
  listCloudAttachments,
  regenerateCloudAttachmentLink,
  uploadFileToCloudApi,
  uploadStreamToCloudApi,
  uploadUrlToCloudApi,
} from "./api-client";

const BASE_URL = "https://attachments.example.test";
const TOKEN = "test-token";
const ORIGINAL_FETCH = globalThis.fetch;
const tempDirs: string[] = [];
const API_ENV_NAMES = [
  "ATTACHMENTS_API_URL",
  "HASNA_ATTACHMENTS_API_URL",
  "ATTACHMENTS_API_TOKEN",
  "HASNA_ATTACHMENTS_API_TOKEN",
  "ATTACHMENTS_API_KEY",
  "HASNA_ATTACHMENTS_API_KEY",
] as const;

function tempFile(name: string, content = "hello"): string {
  const dir = join(tmpdir(), `attachments-api-client-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function clearApiEnv(): void {
  for (const name of API_ENV_NAMES) delete process.env[name];
}

beforeEach(() => {
  clearApiEnv();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearApiEnv();
  mock.restore();
});

describe("cloud API client", () => {
  it("requires a cloud API URL and token", async () => {
    await expect(listCloudAttachments({}, { token: TOKEN })).rejects.toThrow("Cloud API URL is not configured");
    await expect(listCloudAttachments({}, { baseUrl: BASE_URL })).rejects.toThrow("Cloud API token is not configured");
  });

  it("sends upload passwords in headers instead of query strings", async () => {
    const path = tempFile("secret.txt");
    const fetchMock = mock(async () => new Response(JSON.stringify({
      id: "att_1",
      filename: "secret.txt",
      size: 5,
      content_type: "text/plain",
      link: "https://has.na/a/token",
      expires_at: null,
      created_at: Date.now(),
    }), { status: 201, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await uploadFileToCloudApi(path, {
      password: "not-in-url",
      encrypt: true,
      multipartThresholdBytes: Number.MAX_SAFE_INTEGER,
    }, { baseUrl: BASE_URL, token: TOKEN });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).not.toContain("password=");
    expect(url.searchParams.get("encrypt")).toBe("1");
    expect((init.headers as Record<string, string>)["x-attachments-password"]).toBe("not-in-url");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(existsSync(dirname(path))).toBe(true);
  });

  it("uses multipart upload for files above the configured threshold", async () => {
    const path = tempFile("large.txt", "abcdef");
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/api/attachments/multipart")) {
        return new Response(JSON.stringify({ id: "att_multi", upload_id: "upload_1", part_size: 3 }), { status: 201 });
      }
      if (href.includes("/multipart/part")) {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ upload_url: `https://upload.example.test/part-${body.part_number}` }), { status: 201 });
      }
      if (href.startsWith("https://upload.example.test/part-")) {
        return new Response(null, { status: 200, headers: { etag: `"${href.split("-").pop()}"` } });
      }
      if (href.endsWith("/multipart/complete")) {
        return new Response(JSON.stringify({
          id: "att_multi",
          filename: "large.txt",
          size: 6,
          link: null,
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await uploadFileToCloudApi(path, {
      multipartThresholdBytes: 1,
      expiry: "24h",
      password: "pw",
      maxDownloads: 2,
    }, { baseUrl: BASE_URL, token: TOKEN });

    expect(result.id).toBe("att_multi");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const complete = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/multipart/complete"))!;
    expect(JSON.parse(String((complete[1] as RequestInit).body))).toMatchObject({
      upload_id: "upload_1",
      expiry: "24h",
      password: "pw",
      max_downloads: 2,
      size: 6,
      parts: [
        { ETag: '"1"', PartNumber: 1 },
        { ETag: '"2"', PartNumber: 2 },
      ],
    });
  });

  it("aborts multipart uploads when a part upload fails", async () => {
    const path = tempFile("large.txt", "abcdef");
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/api/attachments/multipart")) {
        return new Response(JSON.stringify({ id: "att_multi", upload_id: "upload_1", part_size: 3 }), { status: 201 });
      }
      if (href.includes("/multipart/part")) {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ upload_url: `https://upload.example.test/part-${body.part_number}` }), { status: 201 });
      }
      if (href.startsWith("https://upload.example.test/part-")) {
        return new Response(null, { status: 500 });
      }
      if (href.endsWith("/multipart/abort")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${href}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(uploadFileToCloudApi(path, { multipartThresholdBytes: 1 }, { baseUrl: BASE_URL, token: TOKEN }))
      .rejects.toThrow("Part 1 upload failed");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/multipart/abort"))).toBe(true);
  });

  it("uploads streams, URLs, and lists cloud attachments", async () => {
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://source.example.test/report.txt") {
        return new Response("report", { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (href.startsWith(`${BASE_URL}/api/attachments?filename=report.txt`)) {
        return new Response(JSON.stringify({ id: "att_url", filename: "report.txt", size: 6, link: null }), { status: 201 });
      }
      if (href.startsWith(`${BASE_URL}/api/attachments?filename=stream.txt`)) {
        expect((init?.headers as Record<string, string>)["content-type"]).toBe("text/plain");
        return new Response(JSON.stringify({ id: "att_stream", filename: "stream.txt", size: 6, link: null }), { status: 201 });
      }
      if (href === `${BASE_URL}/api/attachments?limit=2&expired=true&tag=task%3A1`) {
        return new Response(JSON.stringify([{ id: "att_list", filename: "a.bin", size: 1, link: null }]), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(uploadUrlToCloudApi("https://source.example.test/report.txt", {}, { baseUrl: BASE_URL, token: TOKEN }))
      .resolves.toMatchObject({ id: "att_url", filename: "report.txt", contentType: "application/octet-stream" });
    await expect(uploadStreamToCloudApi(Readable.from(["stream"]), "stream.txt", "text/plain", {}, { baseUrl: BASE_URL, token: TOKEN }))
      .resolves.toMatchObject({ id: "att_stream" });
    await expect(listCloudAttachments({ limit: 2, includeExpired: true, tag: "task:1" }, { baseUrl: BASE_URL, token: TOKEN }))
      .resolves.toEqual([expect.objectContaining({ id: "att_list", bucket: "cloud" })]);
  });

  it("handles URL upload fetch failures", async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

    await expect(uploadUrlToCloudApi("https://source.example.test/missing", {}, { baseUrl: BASE_URL, token: TOKEN }))
      .rejects.toThrow("Could not fetch https://source.example.test/missing: HTTP 404");
  });

  it("deletes, gets, regenerates links, and reads health", async () => {
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/api/attachments/att_1") && init?.method === "DELETE") {
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }
      if (href.endsWith("/api/attachments/att_1/link") && init?.method !== "POST") {
        return new Response(JSON.stringify({ link: "https://x", expires_at: null }), { status: 200 });
      }
      if (href.endsWith("/api/attachments/att_1/link") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          expiry: "30m",
          password: "pw",
          max_downloads: 1,
          link_type: "server",
        });
        return new Response(JSON.stringify({ link: "https://new", expires_at: 123 }), { status: 200 });
      }
      if (href.endsWith("/api/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(deleteCloudAttachment("att_1", { baseUrl: BASE_URL, token: TOKEN })).resolves.toBeUndefined();
    await expect(getCloudAttachmentLink("att_1", { baseUrl: BASE_URL, token: TOKEN })).resolves.toEqual({ link: "https://x", expires_at: null });
    await expect(regenerateCloudAttachmentLink("att_1", {
      expiry: "30m",
      password: "pw",
      maxDownloads: 1,
      linkType: "server",
    }, { baseUrl: BASE_URL, token: TOKEN })).resolves.toEqual({ link: "https://new", expires_at: 123 });
    await expect(getCloudHealth({ baseUrl: BASE_URL, token: TOKEN })).resolves.toEqual({ status: "ok" });
  });

  it("surfaces non-JSON error bodies", async () => {
    globalThis.fetch = mock(async () => new Response("plain failure", { status: 500 })) as unknown as typeof fetch;

    await expect(deleteCloudAttachment("att_1", { baseUrl: BASE_URL, token: TOKEN })).rejects.toThrow("plain failure");
  });

  it("sends protected API download passwords in headers", async () => {
    const fetchMock = mock(async () => new Response("contents", {
      status: 200,
      headers: {
        "content-disposition": "attachment; filename=\"secret.txt\"",
        "content-length": "8",
      },
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const outDir = join(tmpdir(), `attachments-api-client-download-${Date.now()}`);
    mkdirSync(outDir, { recursive: true });

    await downloadFromCloud("att_1", outDir, { password: "download-secret" }, { baseUrl: BASE_URL, token: TOKEN });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/attachments/att_1/download`);
    expect((init.headers as Record<string, string>)["x-attachments-password"]).toBe("download-secret");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("downloads public share URLs with password form data and decoded fallback filenames", async () => {
    const outDir = join(tmpdir(), `attachments-api-client-download-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(outDir, { recursive: true });
    tempDirs.push(outDir);
    const fetchMock = mock(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toBe("password=pw");
      return new Response("contents", {
        status: 200,
        headers: {
          "content-disposition": "attachment; filename*=UTF-8''report%20final.txt",
        },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(downloadFromCloud("https://files.example.test/a/share-token", outDir, { password: "pw" }))
      .resolves.toMatchObject({ filename: "report final.txt" });
    expect(fetchMock.mock.calls[0]![0].toString()).toBe("https://files.example.test/a/share-token/download");
  });

  it("downloads non-share URLs, recovers undecodable filenames, and handles directory-like outputs", async () => {
    const outDir = join(tmpdir(), `attachments-api-client-download-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(outDir, { recursive: true });
    tempDirs.push(outDir);
    const fetchMock = mock(async () => new Response("contents", {
      status: 200,
      headers: {
        "content-disposition": "attachment; filename*=UTF-8''bad%ZZname.txt",
      },
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await downloadFromCloud("https://cdn.example.test/files/original.txt", `${outDir}/`);

    expect(fetchMock.mock.calls[0]![0]).toBe("https://cdn.example.test/files/original.txt");
    expect(result.filename).toBe("bad%ZZname.txt");
    expect(result.path).toBe(join(`${outDir}/`, "bad%ZZname.txt"));
  });

  it("uses HTTP status when cloud download errors have no response text", async () => {
    globalThis.fetch = mock(async () => new Response("", { status: 503 })) as unknown as typeof fetch;

    await expect(downloadFromCloud("https://cdn.example.test/files/missing.txt")).rejects.toThrow("Download failed with HTTP 503");
  });
});
