import { describe, expect, test } from "bun:test";
import { describeApiFailure, resolveAttachmentsV1 } from "./cloud-v1";

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
});

// ---------------------------------------------------------------------------
// D1(a) — CLI errors must be diagnosable without reading CloudWatch
// ---------------------------------------------------------------------------

describe("describeApiFailure", () => {
  test("names the route and the HTTP status", () => {
    expect(describeApiFailure("post", "/attachments", 500, "")).toBe(
      "POST /v1/attachments failed: HTTP 500",
    );
  });

  test("surfaces the server's JSON error instead of an opaque body", () => {
    const message = describeApiFailure(
      "POST",
      "/attachments",
      400,
      JSON.stringify({ error: "Invalid expiry format: 604800s" }),
    );
    expect(message).toContain("POST /v1/attachments");
    expect(message).toContain("HTTP 400");
    expect(message).toContain("Invalid expiry format: 604800s");
  });

  test("keeps the server detail alongside a generic error label", () => {
    const message = describeApiFailure(
      "POST",
      "/attachments",
      500,
      JSON.stringify({ error: "Internal Server Error", detail: "presign failed" }),
    );
    expect(message).toContain("Internal Server Error");
    expect(message).toContain("presign failed");
    // The old behaviour was exactly this string and nothing else.
    expect(message).not.toBe("Internal Server Error");
  });

  test("falls back to the raw body for non-JSON responses", () => {
    expect(describeApiFailure("GET", "/attachments", 502, "Bad Gateway")).toContain("Bad Gateway");
  });

  test("truncates a very long body", () => {
    const message = describeApiFailure("GET", "/attachments", 500, "x".repeat(5000));
    expect(message.length).toBeLessThan(600);
  });
});

describe("cloud upload failures reach the caller with context", () => {
  test("a 500 from the upload route is reported with route and status", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 500, body: { error: "Internal Server Error" } }));
    const resolved = resolveAttachmentsV1(
      { HASNA_ATTACHMENTS_API_URL: BASE, HASNA_ATTACHMENTS_API_KEY: KEY },
      { fetchImpl },
    );
    if (resolved.transport !== "cloud-http") throw new Error("expected cloud transport");
    const error = await resolved.store
      .uploadBuffer("x.txt", new Uint8Array([1, 2, 3]), { expiry: "30d" })
      .then(() => null)
      .catch((err: Error) => err);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("POST /v1/attachments");
    expect(error!.message).toContain("HTTP 500");
    expect(error!.message).not.toBe("Internal Server Error");
    expect(error!.message).not.toContain(KEY);
  });
});
