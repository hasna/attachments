import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

  test("ATTACHMENTS_CLIENT_MODE=local keeps unit tests and local CLI paths hermetic", () => {
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

  test("link helpers use the /v1 link routes", async () => {
    const { calls, fetchImpl } = mockFetch((call) => {
      if (call.method === "GET") return { status: 200, body: { link: "https://x/a", expires_at: 123 } };
      const body = JSON.parse(call.body!);
      expect(body.expiry).toBe("24h");
      expect(body.password).toBe("pw");
      expect(body.max_downloads).toBe(2);
      expect(body.link_type).toBe("server");
      return { status: 200, body: { link: "https://x/b", expires_at: 456 } };
    });
    const r = resolveAttachmentsV1(cloudEnv, { fetchImpl });
    if (r.transport !== "cloud-http") throw new Error("expected cloud");
    expect(await r.store.getLink("att_link")).toEqual({ link: "https://x/a", expires_at: 123 });
    expect(await r.store.regenerateLink("att_link", {
      expiry: "24h",
      password: "pw",
      maxDownloads: 2,
      linkType: "server",
    })).toEqual({ link: "https://x/b", expires_at: 456 });
    expect(calls[0]!.url).toBe(`${BASE}/v1/attachments/att_link/link`);
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.url).toBe(`${BASE}/v1/attachments/att_link/link`);
  });

  test("HTTP errors do not echo response bodies that may contain credentials", async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 500,
      body: { error: `upstream echoed ${KEY}` },
    }));
    const r = resolveAttachmentsV1(cloudEnv, { fetchImpl });
    if (r.transport !== "cloud-http") throw new Error("expected cloud");
    try {
      await r.store.list();
      throw new Error("expected list to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("HTTP 500");
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  test("download uses the normalized /v1 base URL without duplicating the suffix", async () => {
    const calls: Call[] = [];
    const originalFetch = globalThis.fetch;
    const outDir = mkdtempSync(join(tmpdir(), "attachments-cloud-v1-"));
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
      calls.push({ method: init?.method ?? "GET", url: String(input), headers, body: (init?.body as string) ?? null });
      return new Response("hello", {
        status: 200,
        headers: {
          "content-disposition": "attachment; filename=\"hello.txt\"",
          "content-length": "5",
        },
      });
    }) as typeof fetch;
    try {
      const r = resolveAttachmentsV1({ ...cloudEnv, HASNA_ATTACHMENTS_API_URL: `${BASE}/v1` } as NodeJS.ProcessEnv);
      if (r.transport !== "cloud-http") throw new Error("expected cloud");
      const result = await r.store.download("att_download", outDir);
      expect(calls[0]!.url).toBe(`${BASE}/v1/attachments/att_download/download`);
      expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
      expect(result.filename).toBe("hello.txt");
      expect(readFileSync(result.path, "utf-8")).toBe("hello");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
