import { describe, expect, mock, test } from "bun:test";
import { mintApiKey } from "@hasna/contracts/auth";
import { createServeApp } from "./app.js";
import { buildOpenApiDocument } from "./openapi.js";
import { normalizeConfig } from "../core/config.js";
import type { PoolQueryClient } from "../generated/storage-kit/query.js";
import { PgAttachmentsStore } from "../db/pg-store.js";

const SIGNING = "test-signing-secret";

// Minimal in-memory query client: enough to satisfy /health and /ready probes.
function stubClient(): PoolQueryClient {
  const rows: Record<string, unknown[]> = { schema_migrations: [] };
  const client = {
    async query(sql: string) {
      if (/SELECT 1/.test(sql)) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (/schema_migrations/i.test(sql) && /SELECT/i.test(sql)) {
        return { rows: rows.schema_migrations, rowCount: rows.schema_migrations.length };
      }
      return { rows: [], rowCount: 0 };
    },
    async many(sql: string) {
      return (await client.query(sql)).rows;
    },
    async get(sql: string) {
      return (await client.query(sql)).rows[0] ?? null;
    },
    async one(sql: string) {
      return (await client.query(sql)).rows[0];
    },
    async execute() {},
    pool: {} as never,
    async transaction<T>(fn: (c: unknown) => Promise<T>) {
      return fn(client);
    },
    async close() {},
  } as unknown as PoolQueryClient;
  return client;
}

function makeApp(overrides: { store?: PgAttachmentsStore } = {}) {
  const client = stubClient();
  return createServeApp({
    client,
    store: overrides.store ?? new PgAttachmentsStore(client),
    config: normalizeConfig({ storage: { backend: "local" } }),
    version: "test",
    mode: "cloud",
    signingSecret: SIGNING,
  });
}

function oversizedFeedbackJsonStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('{"message":"'));
      controller.enqueue(encoder.encode("x".repeat(20_000)));
      controller.enqueue(encoder.encode('"}'));
      controller.close();
    },
  });
}

describe("attachments serve app", () => {
  test("GET /version returns status/version/mode", async () => {
    const res = await makeApp().request("/version");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("test");
    expect(body.mode).toBe("cloud");
  });

  test("GET /health probes the database", async () => {
    const res = await makeApp().request("/health");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  test("GET /openapi.json is served", async () => {
    const res = await makeApp().request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.paths["/v1/attachments"]).toBeDefined();
  });

  test("GET /v1/attachments without a key is 401", async () => {
    const res = await makeApp().request("/v1/attachments");
    expect(res.status).toBe(401);
  });

  test("read-only key cannot write (403)", async () => {
    const { token } = mintApiKey({ app: "attachments", scopes: ["attachments:read"], signingSecret: SIGNING });
    const res = await makeApp().request("/v1/attachments", {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify({ filename: "x.txt", content_base64: "eA==" }),
    });
    expect(res.status).toBe(403);
  });

  test("wrong-app key is rejected (401)", async () => {
    const { token } = mintApiKey({ app: "todos", scopes: ["todos:read"], signingSecret: SIGNING });
    const res = await makeApp().request("/v1/attachments", { headers: { "x-api-key": token } });
    expect(res.status).toBe(401);
  });

  test("POST /v1/feedback stores canonical feedback fields", async () => {
    const insertFeedback = mock(async (_feedback: unknown) => {});
    const { token } = mintApiKey({ app: "attachments", scopes: ["attachments:write"], signingSecret: SIGNING });
    const res = await makeApp({
      store: { insertFeedback } as unknown as PgAttachmentsStore,
    }).request("/v1/feedback", {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify({
        service: "attachments",
        version: "1.2.3",
        message: "The upload page needs better progress",
        email: "User@Example.com",
        timestamp: "2026-07-07T12:00:00.000Z",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.service).toBe("attachments");
    expect(body.version).toBe("1.2.3");
    expect(body.email).toBe("user@example.com");
    expect(insertFeedback).toHaveBeenCalledTimes(1);
  });

  test("POST /v1/feedback rejects oversized bodies", async () => {
    const insertFeedback = mock(async (_feedback: unknown) => {});
    const { token } = mintApiKey({ app: "attachments", scopes: ["attachments:write"], signingSecret: SIGNING });
    const res = await makeApp({
      store: { insertFeedback } as unknown as PgAttachmentsStore,
    }).request("/v1/feedback", {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(20_000) }),
    });

    expect(res.status).toBe(413);
    expect(insertFeedback).not.toHaveBeenCalled();
  });

  test("POST /v1/feedback rejects oversized streamed bodies while reading", async () => {
    const insertFeedback = mock(async (_feedback: unknown) => {});
    const { token } = mintApiKey({ app: "attachments", scopes: ["attachments:write"], signingSecret: SIGNING });
    const res = await makeApp({
      store: { insertFeedback } as unknown as PgAttachmentsStore,
    }).request("/v1/feedback", {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: oversizedFeedbackJsonStream(),
    });

    expect(res.status).toBe(413);
    expect(insertFeedback).not.toHaveBeenCalled();
  });

  test("openapi document declares the v1 surface", () => {
    const doc = buildOpenApiDocument("0.0.0") as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/health",
      "/ready",
      "/v1/attachments",
      "/v1/attachments/{id}",
      "/v1/attachments/{id}/link",
      "/v1/feedback",
      "/version",
    ]);
  });
});
