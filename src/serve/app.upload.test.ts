/**
 * D2 + D1(c) regression suite for the cloud upload surface.
 *
 * Before the fix:
 *   - any expiry beyond the AWS 7-day presign ceiling reached
 *     `getSignedUrl`, which throws, and the route answered a bare HTTP 500;
 *   - an unparsable expiry did the same;
 *   - `multipart/form-data` had no branch at all, so the whole MIME envelope
 *     (boundary + part headers) was stored as the file contents and both the
 *     filename and the content type were lost.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "crypto";
import { mintApiKey } from "@hasna/contracts/auth";

const AWS_LIMIT = 7 * 24 * 60 * 60;

const uploads: Array<{ key: string; body: Buffer; contentType: string }> = [];
const presignCalls: number[] = [];

class MockS3Client {
  constructor(_config: unknown) {}
  async upload(key: string, body: Buffer, contentType: string) {
    uploads.push({ key, body: Buffer.from(body), contentType });
  }
  async presign(key: string, expiresIn: number) {
    presignCalls.push(expiresIn);
    // Same failure mode as @aws-sdk/s3-request-presigner.
    if (expiresIn > AWS_LIMIT) {
      throw new Error(
        "Signature version 4 presigned URLs must have an expiration date less than one week in the future",
      );
    }
    return `https://bucket.s3.amazonaws.com/${key}?X-Amz-Expires=${expiresIn}`;
  }
  async delete(_key: string) {}
}

mock.module("../core/s3.js", () => ({ S3Client: MockS3Client }));
afterAll(() => mock.restore());

const { createServeApp } = await import("./app.js");
const { normalizeConfig } = await import("../core/config.js");
const { InMemoryAttachmentsStore, stubQueryClient } = await import("./serve.test-harness.test");

const SIGNING = "test-signing-secret";
const PUBLIC_BASE = "https://has.na";

let store: InstanceType<typeof InMemoryAttachmentsStore>;

function makeApp() {
  store = new InMemoryAttachmentsStore();
  return createServeApp({
    client: stubQueryClient() as never,
    store: store as never,
    config: normalizeConfig({
      s3: { bucket: "test-bucket", region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "s" },
      storage: { backend: "s3" },
      server: { baseUrl: PUBLIC_BASE, publicPath: "/a" },
      domains: [{ hostname: "has.na", baseUrl: PUBLIC_BASE, primary: true }],
      defaults: { linkType: "presigned", expiry: "7d" },
    }),
    version: "test",
    mode: "postgres",
    signingSecret: SIGNING,
  });
}

function key() {
  return mintApiKey({ app: "attachments", scopes: ["attachments:read", "attachments:write"], signingSecret: SIGNING })
    .token;
}

async function jsonUpload(app: ReturnType<typeof makeApp>, body: Record<string, unknown>) {
  const res = await app.request("/v1/attachments", {
    method: "POST",
    headers: { "x-api-key": key(), "content-type": "application/json" },
    body: JSON.stringify({ filename: "note.txt", content_base64: Buffer.from("hello").toString("base64"), ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("D2 — expiry beyond the AWS presign ceiling", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    uploads.length = 0;
    presignCalls.length = 0;
    app = makeApp();
  });

  test("7d still gets a presigned link signed for exactly the AWS maximum", async () => {
    const { status, body } = await jsonUpload(app, { expiry: "7d" });
    expect(status).toBe(201);
    expect(String(body.link)).toContain("X-Amz-Expires=604800");
    expect(presignCalls).toEqual([AWS_LIMIT]);
  });

  for (const expiry of ["8d", "14d", "30d", "60d", "720h"]) {
    test(`${expiry} returns 201 with a server link instead of HTTP 500`, async () => {
      const { status, body } = await jsonUpload(app, { expiry });
      expect(status).toBe(201);
      expect(String(body.link).startsWith(`${PUBLIC_BASE}/a/`)).toBe(true);
      expect(presignCalls).toEqual([]);
      expect(store.shareLinks).toHaveLength(1);
    });
  }

  test("expiry=never gets a genuinely non-expiring server link, not a 7-day presign", async () => {
    const { status, body } = await jsonUpload(app, { expiry: "never" });
    expect(status).toBe(201);
    expect(body.expires_at).toBeNull();
    expect(String(body.link).startsWith(`${PUBLIC_BASE}/a/`)).toBe(true);
    expect(presignCalls).toEqual([]);
  });

  test("an unparsable expiry is a 400 with the reason, not a 500", async () => {
    const { status, body } = await jsonUpload(app, { expiry: "604800s" });
    expect(status).toBe(400);
    expect(String(body.error)).toContain("Invalid expiry format");
  });

  test("30d + password still yields one usable server link", async () => {
    const { status, body } = await jsonUpload(app, { expiry: "30d", password: "Parola-Test-1" });
    expect(status).toBe(201);
    expect(String(body.link).startsWith(`${PUBLIC_BASE}/a/`)).toBe(true);
    expect(store.shareLinks[0]!.passwordHash).not.toBeNull();
  });

  test("POST /v1/attachments/:id/link with 30d falls back to a server link", async () => {
    const created = await jsonUpload(app, { expiry: "7d" });
    const res = await app.request(`/v1/attachments/${created.body.id}/link`, {
      method: "POST",
      headers: { "x-api-key": key(), "content-type": "application/json" },
      body: JSON.stringify({ expiry: "30d" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.link_type).toBe("server");
    expect(String(body.link).startsWith(`${PUBLIC_BASE}/a/`)).toBe(true);
  });

  test("POST /v1/attachments/:id/link with a bad expiry is 400", async () => {
    const created = await jsonUpload(app, { expiry: "7d" });
    const res = await app.request(`/v1/attachments/${created.body.id}/link`, {
      method: "POST",
      headers: { "x-api-key": key(), "content-type": "application/json" },
      body: JSON.stringify({ expiry: "tomorrow" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("D1(c) — multipart/form-data upload", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    uploads.length = 0;
    presignCalls.length = 0;
    app = makeApp();
  });

  const CONTENT = "%PDF-1.4 fake pdf body\nline two\n";
  const SHA = createHash("sha256").update(CONTENT).digest("hex");

  function form(extra: Record<string, string> = {}, filename = "raport.pdf", type = "application/pdf") {
    const fd = new FormData();
    fd.append("file", new File([CONTENT], filename, { type }));
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fd;
  }

  test("keeps the filename, the content type and the exact bytes", async () => {
    const res = await app.request("/v1/attachments", {
      method: "POST",
      headers: { "x-api-key": key() },
      body: form(),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.filename).toBe("raport.pdf");
    expect(body.content_type).toBe("application/pdf");
    expect(body.size).toBe(Buffer.byteLength(CONTENT));
    expect(uploads).toHaveLength(1);
    expect(createHash("sha256").update(uploads[0]!.body).digest("hex")).toBe(SHA);
  });

  test("does not store the MIME envelope as the file body", async () => {
    await app.request("/v1/attachments", { method: "POST", headers: { "x-api-key": key() }, body: form() });
    const stored = uploads[0]!.body.toString();
    expect(stored).toBe(CONTENT);
    expect(stored).not.toContain("Content-Disposition");
    expect(stored).not.toContain("WebKitFormBoundary");
  });

  test("honours expiry / password / tag form fields", async () => {
    const res = await app.request("/v1/attachments", {
      method: "POST",
      headers: { "x-api-key": key() },
      body: form({ expiry: "30d", password: "Parola-Test-1", tag: "kpmg" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tag).toBe("kpmg");
    expect(String(body.link).startsWith(`${PUBLIC_BASE}/a/`)).toBe(true);
    expect(store.shareLinks[0]!.passwordHash).not.toBeNull();
  });

  test("a multipart body without a file part is 400", async () => {
    const fd = new FormData();
    fd.append("expiry", "7d");
    const res = await app.request("/v1/attachments", {
      method: "POST",
      headers: { "x-api-key": key() },
      body: fd,
    });
    expect(res.status).toBe(400);
  });

  test("raw body uploads keep working", async () => {
    const res = await app.request("/v1/attachments?filename=plain.txt", {
      method: "POST",
      headers: { "x-api-key": key(), "content-type": "application/octet-stream" },
      body: CONTENT,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.filename).toBe("plain.txt");
    expect(body.content_type).toBe("text/plain");
    expect(createHash("sha256").update(uploads[0]!.body).digest("hex")).toBe(SHA);
  });
});
