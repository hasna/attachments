/**
 * D3 regression suite: the cloud service must SERVE the `/a/:token` links it
 * MINTS, including password-protected ones.
 *
 * Before the fix `createServeApp` registered no public route at all, so every
 * one of these requests came back as Hono's bare `404 Not Found`.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mintApiKey } from "@hasna/contracts/auth";
import { createServeApp } from "./app.js";
import { normalizeConfig, type AttachmentsConfig } from "../core/config.js";
import { buildDeploymentPlan, classifyAttachmentRouteProbe } from "../core/deployment.js";
import type { PoolQueryClient } from "../generated/storage-kit/query.js";
import type { PgAttachmentsStore } from "../db/pg-store.js";
import { InMemoryAttachmentsStore, stubQueryClient } from "./serve.test-harness.test";

const SIGNING = "test-signing-secret";
const PUBLIC_BASE = "https://has.na";
const objectDir = mkdtempSync(join(tmpdir(), "attachments-public-routes-"));

afterAll(() => rmSync(objectDir, { recursive: true, force: true }));

function makeConfig(): AttachmentsConfig {
  return normalizeConfig({
    storage: { backend: "local", localDir: objectDir },
    server: { baseUrl: PUBLIC_BASE, publicPath: "/a" },
    domains: [{ hostname: "has.na", baseUrl: PUBLIC_BASE, primary: true }],
    defaults: { linkType: "presigned" },
  });
}

let store: InMemoryAttachmentsStore;

function makeApp() {
  store = new InMemoryAttachmentsStore();
  return createServeApp({
    client: stubQueryClient() as PoolQueryClient,
    store: store as unknown as PgAttachmentsStore,
    config: makeConfig(),
    version: "test",
    mode: "cloud",
    signingSecret: SIGNING,
  });
}

function writeKey() {
  return mintApiKey({ app: "attachments", scopes: ["attachments:write", "attachments:read"], signingSecret: SIGNING })
    .token;
}

const FILE_BODY = "raport TVA — conținut cu diacritice ăîșțâ\n";
const FILE_SHA = createHash("sha256").update(FILE_BODY).digest("hex");

async function upload(
  app: ReturnType<typeof makeApp>,
  body: Record<string, unknown>,
): Promise<{ id: string; link: string; filename: string }> {
  const res = await app.request("/v1/attachments", {
    method: "POST",
    headers: { "x-api-key": writeKey(), "content-type": "application/json" },
    body: JSON.stringify({
      filename: "raport.pdf",
      content_base64: Buffer.from(FILE_BODY).toString("base64"),
      ...body,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; link: string; filename: string };
}

function tokenOf(link: string): string {
  return link.split("/a/")[1]!;
}

// The path `attachments domain verify` actually requests, taken from the plan
// rather than restated, so the probe URL and the served route cannot drift.
function probePath(): string {
  return new URL(buildDeploymentPlan(makeConfig()).routing.validation.attachment_probe_url).pathname;
}

async function classifyResponse(res: Response) {
  return classifyAttachmentRouteProbe({
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: await res.text(),
  });
}

describe("cloud public share links", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  test("a password-protected upload mints a link on the configured public host", async () => {
    const created = await upload(app, { expiry: "30d", password: "Parola-Test-1" });
    expect(created.link.startsWith(`${PUBLIC_BASE}/a/`)).toBe(true);
  });

  test("GET /a/:token resolves (was 404: route did not exist)", async () => {
    const created = await upload(app, { expiry: "30d", password: "Parola-Test-1" });
    const res = await app.request(`/a/${tokenOf(created.link)}`);
    expect(res.status).toBe(200);
  });

  test("GET /a/:token asks for the password instead of returning the file", async () => {
    const created = await upload(app, { expiry: "30d", password: "Parola-Test-1" });
    const res = await app.request(`/a/${tokenOf(created.link)}`);
    const html = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(html).toContain('name="password"');
    expect(html).toContain("raport.pdf");
    expect(html).not.toContain(FILE_BODY);
  });

  test("GET /a/:token/download without a password re-renders the form with 401", async () => {
    const created = await upload(app, { expiry: "30d", password: "Parola-Test-1" });
    const res = await app.request(`/a/${tokenOf(created.link)}/download`);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('name="password"');
  });

  test("POST with the wrong password is 401 and does not consume the link", async () => {
    const created = await upload(app, { expiry: "30d", password: "Parola-Test-1" });
    const token = tokenOf(created.link);
    const res = await app.request(`/a/${token}/download`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "gresit" }).toString(),
    });
    expect(res.status).toBe(401);
    expect(store.shareLinks[0]!.usedCount).toBe(0);
  });

  test("POST with the correct password returns the bytes intact, named and typed", async () => {
    const created = await upload(app, { expiry: "30d", password: "Parola-Test-1" });
    const res = await app.request(`/a/${tokenOf(created.link)}/download`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "Parola-Test-1" }).toString(),
    });
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FILE_SHA);
    expect(res.headers.get("content-disposition")).toContain('filename="raport.pdf"');
    expect(res.headers.get("content-type")).toContain("application/pdf");
  });

  test("a filename with diacritics survives the round trip", async () => {
    const res = await app.request("/v1/attachments", {
      method: "POST",
      headers: { "x-api-key": writeKey(), "content-type": "application/json" },
      body: JSON.stringify({
        filename: "raport-anexă-șiț.txt",
        content_base64: Buffer.from(FILE_BODY).toString("base64"),
        expiry: "30d",
        password: "Parola-Test-1",
      }),
    });
    const created = (await res.json()) as { link: string };
    const download = await app.request(`/a/${tokenOf(created.link)}/download`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "Parola-Test-1" }).toString(),
    });
    expect(download.status).toBe(200);
    const disposition = download.headers.get("content-disposition")!;
    expect(disposition).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!)).toBe("raport-anexă-șiț.txt");
    expect(download.headers.get("content-type")).toContain("text/plain");
  });

  test("a link without a password downloads directly on GET", async () => {
    const created = await upload(app, { expiry: "30d", link_type: "server" });
    const res = await app.request(`/a/${tokenOf(created.link)}/download`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(FILE_BODY);
  });

  test("an unknown token renders the attachment-unavailable page, not a bare 404", async () => {
    const res = await app.request("/a/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Attachment unavailable");
  });

  test("the exact domain-verification probe is classified as the attachments service", async () => {
    const res = await app.request(probePath());
    const classification = await classifyResponse(res);

    expect(classification.ok).toBe(true);
    expect(classification.service).toBe("attachments");
  });

  test("the probe fails the deploy gate when the app itself is broken", async () => {
    // The route can be wired correctly and the service still be dead: `fatal`
    // answers 500 with the same "Attachment unavailable" page as a missing token.
    // If the probe passed that, `attachments domain verify` would exit 0 and the
    // incident would close while every share link kept failing.
    store.findShareLinkByToken = async () => {
      throw new Error("store unavailable");
    };

    const res = await app.request(probePath());
    const classification = await classifyResponse(res);

    expect(res.status).toBe(500);
    expect(classification.ok).toBe(false);
    expect(classification.service).toBe("attachments");
  });

  test("an expired share link is 410", async () => {
    const created = await upload(app, { expiry: "30d", password: "Parola-Test-1" });
    store.shareLinks[0]!.expiresAt = Date.now() - 1000;
    const res = await app.request(`/a/${tokenOf(created.link)}`);
    expect(res.status).toBe(410);
  });

  test("a revoked share link is 410", async () => {
    const created = await upload(app, { expiry: "30d", password: "Parola-Test-1" });
    store.shareLinks[0]!.revokedAt = Date.now();
    const res = await app.request(`/a/${tokenOf(created.link)}`);
    expect(res.status).toBe(410);
  });

  test("public pages are no-store and allow the password form to post back", async () => {
    const created = await upload(app, { expiry: "30d", password: "Parola-Test-1" });
    const res = await app.request(`/a/${tokenOf(created.link)}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
  });

  test("repeated wrong passwords lock the link out with 429", async () => {
    const created = await upload(app, { expiry: "30d", password: "Parola-Test-1" });
    const token = tokenOf(created.link);
    const attempt = () =>
      app.request(`/a/${token}/download`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "gresit" }).toString(),
      });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });

  test("bare GETs never lock the link — only submitted passwords count", async () => {
    const created = await upload(app, { expiry: "30d", password: "Parola-Test-1" });
    const token = tokenOf(created.link);
    for (let i = 0; i < 15; i++) {
      expect((await app.request(`/a/${token}/download`)).status).toBe(401);
    }
    const ok = await app.request(`/a/${token}/download`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "Parola-Test-1" }).toString(),
    });
    expect(ok.status).toBe(200);
  });

  test("a max-downloads link is not burned by a bare GET", async () => {
    const created = await upload(app, { expiry: "30d", max_downloads: 1 });
    const token = tokenOf(created.link);
    const preview = await app.request(`/a/${token}/download`, { redirect: "manual" });
    expect(preview.status).toBe(303);
    expect(store.shareLinks[0]!.usedCount).toBe(0);

    const real = await app.request(`/a/${token}/download?download=1`);
    expect(real.status).toBe(200);
    expect(store.shareLinks[0]!.usedCount).toBe(1);

    const second = await app.request(`/a/${token}/download?download=1`);
    expect(second.status).toBe(410);
  });

  test("HEAD /a/:token/download reports the stored name and size", async () => {
    const created = await upload(app, { expiry: "30d", password: "Parola-Test-1" });
    const res = await app.request(`/a/${tokenOf(created.link)}/download`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(FILE_BODY)));
    expect(res.headers.get("content-disposition")).toContain("raport.pdf");
  });

  test("an email-gated link fails closed instead of serving bytes", async () => {
    const created = await upload(app, { expiry: "30d", link_type: "server" });
    store.shareLinks[0]!.requireEmail = true;
    const page = await app.request(`/a/${tokenOf(created.link)}`);
    expect(page.status).toBe(501);
    const download = await app.request(`/a/${tokenOf(created.link)}/download`);
    expect(download.status).toBe(501);
  });
});
