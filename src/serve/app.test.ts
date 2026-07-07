import { afterEach, describe, expect, test } from "bun:test";
import { mintApiKey } from "@hasna/contracts/auth";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServeApp } from "./app.js";
import { buildOpenApiDocument } from "./openapi.js";
import { normalizeConfig } from "../core/config.js";
import type { PoolQueryClient } from "../generated/storage-kit/query.js";
import { PgAttachmentsStore } from "../db/pg-store.js";
import type { Attachment } from "../core/db.js";

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

function makeApp() {
  const client = stubClient();
  return createServeApp({
    client,
    store: new PgAttachmentsStore(client),
    config: normalizeConfig({ storage: { backend: "local" } }),
    version: "test",
    mode: "cloud",
    signingSecret: SIGNING,
  });
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = join(tmpdir(), `attachments-serve-app-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function authHeaders(scopes: string[]) {
  const { token } = mintApiKey({ app: "attachments", scopes, signingSecret: SIGNING });
  return { "x-api-key": token };
}

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att_1",
    filename: "file.txt",
    s3Key: "objects/file.txt",
    bucket: "local",
    size: 4,
    contentType: "text/plain",
    link: null,
    tag: null,
    expiresAt: null,
    createdAt: 1_700_000_000_000,
    storageBackend: "local",
    status: "ready",
    downloads: 0,
    ...overrides,
  };
}

function makeStore(initial: Attachment[] = [attachment()]) {
  const rows = [...initial];
  const store = {
    findAll: async (opts?: { limit?: number; includeExpired?: boolean; tag?: string }) => {
      const filtered = rows.filter((row) => (opts?.tag ? row.tag === opts.tag : true));
      return opts?.limit ? filtered.slice(0, opts.limit) : filtered;
    },
    findById: async (id: string) => rows.find((row) => row.id === id) ?? null,
    insert: async (row: Attachment) => {
      rows.push(row);
    },
    updateLink: async (id: string, link: string, expiresAt?: number | null) => {
      const row = rows.find((item) => item.id === id);
      if (row) {
        row.link = link;
        row.expiresAt = expiresAt ?? null;
      }
    },
    delete: async (id: string) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
    },
    incrementDownloads: async (id: string) => {
      const row = rows.find((item) => item.id === id);
      if (row) row.downloads = (row.downloads ?? 0) + 1;
    },
    createShareLink: async () => ({ shareLink: {}, token: "share_token" }),
    rows,
  };
  return store;
}

function makeV1App(options: { store?: ReturnType<typeof makeStore>; maxSizeBytes?: number } = {}) {
  const dir = tempDir();
  const store = options.store ?? makeStore();
  const app = createServeApp({
    client: stubClient(),
    store: store as unknown as PgAttachmentsStore,
    config: normalizeConfig({
      storage: { backend: "local", localDir: dir, maxSizeBytes: options.maxSizeBytes ?? 1024 },
      server: { baseUrl: "https://files.example.test", publicPath: "/a" },
      defaults: { expiry: "24h", linkType: "server" },
    }),
    version: "test",
    mode: "cloud",
    signingSecret: SIGNING,
  });
  return { app, store, dir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

  test("GET /ready reports pending migrations", async () => {
    const res = await makeApp().request("/ready");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("not_ready");
    expect(body.pending_migrations.length).toBeGreaterThan(0);
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

  test("openapi document declares the v1 surface", () => {
    const doc = buildOpenApiDocument("0.0.0") as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/health",
      "/ready",
      "/v1/attachments",
      "/v1/attachments/{id}",
      "/v1/attachments/{id}/link",
      "/version",
    ]);
  });

  test("GET /v1/attachments maps store rows and forwards query filters", async () => {
    const store = makeStore([
      attachment({ id: "att_1", tag: "task:1" }),
      attachment({ id: "att_2", tag: "other" }),
    ]);
    const { app } = makeV1App({ store });

    const res = await app.request("/v1/attachments?limit=1&expired=true&tag=task:1", {
      headers: authHeaders(["attachments:read"]),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({
        id: "att_1",
        content_type: "text/plain",
        created_at: 1_700_000_000_000,
      }),
    ]);
  });

  test("POST /v1/attachments rejects malformed JSON uploads", async () => {
    const { app } = makeV1App();

    const res = await app.request("/v1/attachments", {
      method: "POST",
      headers: { ...authHeaders(["attachments:write"]), "content-type": "application/json" },
      body: JSON.stringify({ filename: "missing-content.txt" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "filename and content_base64 are required" });
  });

  test("POST /v1/attachments stores JSON uploads and creates server links for local storage", async () => {
    const store = makeStore([]);
    const { app } = makeV1App({ store });

    const res = await app.request("/v1/attachments", {
      method: "POST",
      headers: { ...authHeaders(["attachments:write"]), "content-type": "application/json" },
      body: JSON.stringify({
        filename: "../unsafe name.txt",
        content_base64: Buffer.from("body").toString("base64"),
        tag: "task:1",
        password: "pw",
        max_downloads: 2,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.filename).toBe("unsafe name.txt");
    expect(body.link).toBe("https://files.example.test/a/share_token");
    expect(store.rows[0]).toMatchObject({
      bucket: "local",
      size: 4,
      tag: "task:1",
      storageBackend: "local",
    });
  });

  test("POST /v1/attachments rejects raw uploads above configured max size", async () => {
    const { app } = makeV1App({ maxSizeBytes: 2 });

    const res = await app.request("/v1/attachments?filename=too-big.txt", {
      method: "POST",
      headers: authHeaders(["attachments:write"]),
      body: "abc",
    });

    expect(res.status).toBe(413);
  });

  test("GET, DELETE, and link regeneration handle found and missing attachments", async () => {
    const store = makeStore([attachment()]);
    const { app } = makeV1App({ store });

    const getRes = await app.request("/v1/attachments/att_1", {
      headers: authHeaders(["attachments:read"]),
    });
    expect(getRes.status).toBe(200);

    const linkRes = await app.request("/v1/attachments/att_1/link", {
      method: "POST",
      headers: { ...authHeaders(["attachments:write"]), "content-type": "application/json" },
      body: JSON.stringify({ expiry: "30m", link_type: "server", max_downloads: 1 }),
    });
    expect(linkRes.status).toBe(200);
    await expect(linkRes.json()).resolves.toEqual(expect.objectContaining({ link: "https://files.example.test/a/share_token" }));

    const deleteRes = await app.request("/v1/attachments/att_1", {
      method: "DELETE",
      headers: authHeaders(["attachments:write"]),
    });
    expect(deleteRes.status).toBe(200);

    const missing = await app.request("/v1/attachments/att_1", {
      headers: authHeaders(["attachments:read"]),
    });
    expect(missing.status).toBe(404);
  });

  test("GET /v1/attachments/:id/download streams local objects and increments downloads", async () => {
    const store = makeStore([attachment({ s3Key: "objects/file.txt", size: 5 })]);
    const { app, dir } = makeV1App({ store });
    mkdirSync(join(dir, "objects"), { recursive: true });
    writeFileSync(join(dir, "objects", "file.txt"), "hello");

    const res = await app.request("/v1/attachments/att_1/download", {
      headers: authHeaders(["attachments:read"]),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("file.txt");
    expect(await res.text()).toBe("hello");
    expect(store.rows[0]!.downloads).toBe(1);
  });

  test("GET /v1/attachments/:id/download rejects expired attachments", async () => {
    const { app } = makeV1App({ store: makeStore([attachment({ expiresAt: Date.now() - 1 })]) });

    const res = await app.request("/v1/attachments/att_1/download", {
      headers: authHeaders(["attachments:read"]),
    });

    expect(res.status).toBe(410);
  });
});
