import { describe, expect, test } from "bun:test";
import { mintApiKey } from "@hasna/contracts/auth";
import { normalizeConfig } from "../core/config.js";
import type { Attachment } from "../core/db.js";
import { createServeApp } from "./app.js";
import { InMemoryAttachmentsStore, stubQueryClient } from "./serve.test-harness.test.js";

const SIGNING_SECRET = "friendly-slug-test-signing-secret";
const FRIENDLY_SLUG = "company-closing-packet";

function attachment(): Attachment {
  return {
    id: "att_friendly",
    filename: "closing-packet.pdf",
    s3Key: "attachments/att_friendly/closing-packet.pdf",
    bucket: "local",
    size: 128,
    contentType: "application/pdf",
    link: null,
    tag: "legal",
    expiresAt: null,
    createdAt: Date.now(),
    storageBackend: "local",
    status: "ready",
    downloads: 0,
  };
}

function auth(scopes: string[]): Record<string, string> {
  const { token } = mintApiKey({
    app: "attachments",
    scopes,
    signingSecret: SIGNING_SECRET,
  });
  return {
    "content-type": "application/json",
    "x-api-key": token,
  };
}

function makeApp() {
  const store = new InMemoryAttachmentsStore();
  store.attachments.push(attachment());
  const app = createServeApp({
    client: stubQueryClient(),
    store: store as never,
    config: normalizeConfig({
      storage: { backend: "local" },
      server: { baseUrl: "https://has.na", publicPath: "/a" },
    }),
    version: "test",
    mode: "self_hosted",
    signingSecret: SIGNING_SECRET,
  });
  return { app, store };
}

describe("friendly attachment slugs", () => {
  test("rejects malformed, passwordless, and duplicate aliases", async () => {
    const { app } = makeApp();

    const malformed = await app.request("/v1/slugs/Not-Friendly", {
      headers: auth(["attachments:read"]),
    });
    expect(malformed.status).toBe(400);

    const passwordless = await app.request("/v1/attachments/att_friendly/link", {
      method: "POST",
      headers: auth(["attachments:write"]),
      body: JSON.stringify({ slug: FRIENDLY_SLUG }),
    });
    expect(passwordless.status).toBe(400);

    const first = await app.request("/v1/attachments/att_friendly/link", {
      method: "POST",
      headers: auth(["attachments:write"]),
      body: JSON.stringify({ slug: FRIENDLY_SLUG, password: "passphrase" }),
    });
    expect(first.status).toBe(200);

    const duplicate = await app.request("/v1/attachments/att_friendly/link", {
      method: "POST",
      headers: auth(["attachments:write"]),
      body: JSON.stringify({ slug: FRIENDLY_SLUG, password: "different-passphrase" }),
    });
    expect(duplicate.status).toBe(409);
  });

  test("reports availability, creates a password-protected alias, and reserves it", async () => {
    const { app } = makeApp();

    const before = await app.request(`/v1/slugs/${FRIENDLY_SLUG}`, {
      headers: auth(["attachments:read"]),
    });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({
      slug: FRIENDLY_SLUG,
      available: true,
    });

    const created = await app.request("/v1/attachments/att_friendly/link", {
      method: "POST",
      headers: auth(["attachments:write"]),
      body: JSON.stringify({
        slug: FRIENDLY_SLUG,
        password: "offline-test-password",
        expiry: "7d",
      }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({
      link: `https://has.na/a/${FRIENDLY_SLUG}`,
      link_type: "server",
      slug: FRIENDLY_SLUG,
    });

    const after = await app.request(`/v1/slugs/${FRIENDLY_SLUG}`, {
      headers: auth(["attachments:read"]),
    });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({
      slug: FRIENDLY_SLUG,
      available: false,
    });

    const publicPage = await app.request(`/a/${FRIENDLY_SLUG}`);
    expect(publicPage.status).toBe(200);
    expect(await publicPage.text()).toContain('name="password"');
  });
});
