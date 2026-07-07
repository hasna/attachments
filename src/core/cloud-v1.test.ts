import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { resolveAttachmentsV1 } from "./cloud-v1";

const BASE = "https://attachments.hasna.xyz";
const KEY = "hasna_attachments_testkey_0000";

type Call = { method: string; url: string; headers: Record<string, string>; body: string | null };

function mockFetch(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const call: Call = { method: init?.method ?? "GET", url, headers, body: (init?.body as string) ?? null };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const cloudEnv = { HASNA_ATTACHMENTS_API_URL: BASE, HASNA_ATTACHMENTS_API_KEY: KEY } as NodeJS.ProcessEnv;

describe("resolveAttachmentsV1", () => {
  test("returns local when env unset", () => {
    const r = resolveAttachmentsV1({} as NodeJS.ProcessEnv);
    expect(r.transport).toBe("local");
    expect(r.store).toBeNull();
  });

  test("returns local when only URL set (key missing)", () => {
    const r = resolveAttachmentsV1({ HASNA_ATTACHMENTS_API_URL: BASE } as NodeJS.ProcessEnv);
    expect(r.transport).toBe("local");
  });

  test("returns cloud-http when URL+KEY set (mode implied self_hosted)", () => {
    const r = resolveAttachmentsV1(cloudEnv);
    expect(r.transport).toBe("cloud-http");
    if (r.transport === "cloud-http") expect(r.store.baseUrl).toBe(`${BASE}/v1`);
  });

  test("explicit STORAGE_MODE=local forces local even with URL+KEY", () => {
    const r = resolveAttachmentsV1({ ...cloudEnv, HASNA_ATTACHMENTS_STORAGE_MODE: "local" } as NodeJS.ProcessEnv);
    expect(r.transport).toBe("local");
  });

  test("ATTACHMENTS_CLIENT_MODE=local forces local even with URL+KEY", () => {
    const r = resolveAttachmentsV1({ ...cloudEnv, ATTACHMENTS_CLIENT_MODE: "local" } as NodeJS.ProcessEnv);
    expect(r.transport).toBe("local");
  });

  test("list routes GET /v1/attachments with bearer key and maps the envelope", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({
      status: 200,
      body: [{ id: "att_1", filename: "a.txt", size: 3, content_type: "text/plain", link: "https://x/a", tag: "t", expires_at: 111, created_at: 222 }],
    }));
    const r = resolveAttachmentsV1(cloudEnv, { fetchImpl });
    expect(r.transport).toBe("cloud-http");
    if (r.transport !== "cloud-http") return;
    const rows = await r.store.list({ limit: 5, includeExpired: true, tag: "t" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("att_1");
    expect(rows[0]!.bucket).toBe("cloud");
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toContain(`${BASE}/v1/attachments`);
    expect(call.url).toContain("limit=5");
    expect(call.url).toContain("expired=true");
    expect(call.url).toContain("tag=t");
    expect(call.headers["authorization"]).toBe(`Bearer ${KEY}`);
  });

  test("get returns null on 404", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 404, body: { error: "Not found" } }));
    const r = resolveAttachmentsV1(cloudEnv, { fetchImpl });
    if (r.transport !== "cloud-http") throw new Error("expected cloud");
    expect(await r.store.get("missing")).toBeNull();
  });

  test("uploadBuffer POSTs base64 JSON to /v1/attachments and maps result", async () => {
    const { calls, fetchImpl } = mockFetch((c) => {
      expect(c.method).toBe("POST");
      const body = JSON.parse(c.body!);
      expect(body.filename).toBe("hello.txt");
      expect(Buffer.from(body.content_base64, "base64").toString()).toBe("hello");
      expect(body.tag).toBe("demo");
      return { status: 201, body: { id: "att_new", filename: "hello.txt", size: 5, link: null } };
    });
    const r = resolveAttachmentsV1(cloudEnv, { fetchImpl });
    if (r.transport !== "cloud-http") throw new Error("expected cloud");
    const att = await r.store.uploadBuffer("hello.txt", new TextEncoder().encode("hello"), { tag: "demo" });
    expect(att.id).toBe("att_new");
    expect(calls[0]!.headers["idempotency-key"]).toBeDefined();
  });

  test("delete DELETEs /v1/attachments/:id and tolerates 404", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({ status: 404, body: { error: "Not found" } }));
    const r = resolveAttachmentsV1(cloudEnv, { fetchImpl });
    if (r.transport !== "cloud-http") throw new Error("expected cloud");
    await r.store.delete("att_x");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`${BASE}/v1/attachments/att_x`);
  });

  test("uploads files and streams through the /v1 JSON envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "attachments-v1-upload-"));
    try {
      const filePath = join(dir, "disk.txt");
      writeFileSync(filePath, "from disk");
      const { calls, fetchImpl } = mockFetch((c) => {
        const body = JSON.parse(c.body!);
        return { status: 201, body: { id: `att_${body.filename}`, filename: body.filename, size: 9, link: null } };
      });
      const r = resolveAttachmentsV1(cloudEnv, { fetchImpl });
      if (r.transport !== "cloud-http") throw new Error("expected cloud");

      await r.store.uploadFile(filePath);
      await r.store.uploadFile(filePath, { filename: "override.txt" });
      await r.store.uploadStream(Readable.from(["from stream"]), "stream.txt", { filename: "named.txt" });

      const bodies = calls.map((call) => JSON.parse(call.body!));
      expect(bodies.map((body) => body.filename)).toEqual(["disk.txt", "override.txt", "named.txt"]);
      expect(Buffer.from(bodies[0]!.content_base64, "base64").toString()).toBe("from disk");
      expect(Buffer.from(bodies[2]!.content_base64, "base64").toString()).toBe("from stream");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uploads URLs and surfaces remote fetch failures", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("missing")) return new Response("missing", { status: 404 });
        return new Response("remote bytes", { status: 200 });
      }) as typeof fetch;
      const { calls, fetchImpl } = mockFetch((c) => {
        const body = JSON.parse(c.body!);
        return { status: 201, body: { id: "att_url", filename: body.filename, size: 12, link: null } };
      });
      const r = resolveAttachmentsV1(cloudEnv, { fetchImpl });
      if (r.transport !== "cloud-http") throw new Error("expected cloud");

      await r.store.uploadUrl("https://example.com/files/remote%20name.txt");
      await r.store.uploadUrl("https://example.com/files/ignored.txt", { filename: "chosen.txt" });

      const bodies = calls.map((call) => JSON.parse(call.body!));
      expect(bodies.map((body) => body.filename)).toEqual(["remote name.txt", "chosen.txt"]);
      expect(Buffer.from(bodies[0]!.content_base64, "base64").toString()).toBe("remote bytes");
      await expect(r.store.uploadUrl("https://example.com/missing.txt")).rejects.toThrow("HTTP 404");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("gets and regenerates links through transport helpers", async () => {
    const { calls, fetchImpl } = mockFetch((c) => ({
      status: 200,
      body: c.method === "POST"
        ? { link: "https://x/new", expires_at: 456 }
        : { link: "https://x/old", expires_at: 123 },
    }));
    const r = resolveAttachmentsV1(cloudEnv, { fetchImpl });
    if (r.transport !== "cloud-http") throw new Error("expected cloud");

    expect(await r.store.getLink("att/link id")).toEqual({ link: "https://x/old", expires_at: 123 });
    expect(await r.store.regenerateLink("att/link id", {
      expiry: "24h",
      password: "pw",
      maxDownloads: 2,
      linkType: "server",
    })).toEqual({ link: "https://x/new", expires_at: 456 });
    expect(calls[0]!.url).toBe(`${BASE}/v1/attachments/att%2Flink%20id/link`);
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      expiry: "24h",
      password: "pw",
      max_downloads: 2,
      link_type: "server",
    });
  });

  test("downloads binary responses to files, directories, cwd, and trailing slash outputs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "attachments-v1-download-"));
    mkdirSync(join(dir, "nested"));
    const originalFetch = globalThis.fetch;
    const seenHeaders: HeadersInit[] = [];
    try {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenHeaders.push(init?.headers ?? {});
        return new Response("downloaded", {
          status: 200,
          headers: {
            "content-disposition": "attachment; filename=\"served.txt\"",
            "content-length": "10",
          },
        });
      }) as typeof fetch;
      const r = resolveAttachmentsV1(cloudEnv);
      if (r.transport !== "cloud-http") throw new Error("expected cloud");

      const explicit = join(dir, "explicit.txt");
      expect((await r.store.download("att_dl", explicit, { password: "pw" })).path).toBe(explicit);
      expect(readFileSync(explicit, "utf8")).toBe("downloaded");

      expect((await r.store.download("att_dl", dir)).path).toBe(join(dir, "served.txt"));
      const trailing = join(dir, "nested") + "/";
      expect((await r.store.download("att_dl", trailing)).path).toBe(join(dir, "nested", "served.txt"));
      expect((await r.store.download("att_dl", undefined)).filename).toBe("served.txt");
      expect(String((seenHeaders[0] as Record<string, string>)["x-attachments-password"])).toBe("pw");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(process.cwd(), "served.txt"), { force: true });
    }
  });

  test("download surfaces response text or status for failed binary responses", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("gone", { status: 410 })) as typeof fetch;
      const r = resolveAttachmentsV1(cloudEnv);
      if (r.transport !== "cloud-http") throw new Error("expected cloud");
      await expect(r.store.download("att_missing", undefined)).rejects.toThrow("gone");

      globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
      await expect(r.store.download("att_missing", undefined)).rejects.toThrow("HTTP 500");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
