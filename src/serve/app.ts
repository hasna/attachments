/**
 * Attachments serve HTTP app.
 *
 * Surfaces the standard health/ready/version probes plus a versioned `/v1`
 * REST API guarded by @hasna/contracts API-key auth. PURE REMOTE (Amendment
 * A1): all metadata reads/writes go through the injected Postgres store; object
 * bytes live in S3 (or a local store in dev). No sync or cache in the service.
 */

import { Hono, type Context } from "hono";
import { nanoid } from "nanoid";
import { Readable } from "stream";
import { lookup as mimeLookup } from "mime-types";
import { verifyApiKey, type ApiKeyVerifier } from "@hasna/contracts/auth";
import type { PoolQueryClient } from "../generated/storage-kit/query.js";
import { checkHealth, checkReady } from "../generated/storage-kit/health.js";
import { PgAttachmentsStore } from "../db/pg-store.js";
import { ATTACHMENTS_MIGRATIONS } from "../db/migrations.js";
import type { Attachment } from "../core/db.js";
import type { AttachmentsConfig } from "../core/config.js";
import {
  getPublicBaseUrl,
  parseExpiryStrict,
  resolveStorageBackend,
} from "../core/config.js";
import { createObjectStore } from "../core/object-storage.js";
import { S3Client } from "../core/s3.js";
import { openAttachmentStream, isExpired } from "../core/download.js";
import { generatePresignedLink, generateShareLink, getLinkType } from "../core/links.js";
import { createObjectKey, sanitizeFilename, contentDispositionAttachment } from "../core/security.js";
import { buildOpenApiDocument } from "./openapi.js";

export interface ServeAppDeps {
  client: PoolQueryClient;
  store: PgAttachmentsStore;
  config: AttachmentsConfig;
  version: string;
  mode: string;
  signingSecret: string;
  isRevoked?: (kid: string) => boolean | Promise<boolean>;
  audit?: (event: unknown) => void;
}

const APP_SLUG = "attachments";

function toApiAttachment(a: Attachment) {
  return {
    id: a.id,
    filename: a.filename,
    size: a.size,
    content_type: a.contentType,
    link: a.link,
    tag: a.tag,
    expires_at: a.expiresAt,
    created_at: a.createdAt,
  };
}

async function uploadBufferToStore(
  config: AttachmentsConfig,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const store = createObjectStore(config);
  if (store instanceof S3Client) {
    await store.upload(key, body, contentType);
  } else {
    await store.uploadBuffer(key, body, contentType);
  }
}

export function createServeApp(deps: ServeAppDeps): Hono {
  const app = new Hono();
  const { store, client, config, version, mode } = deps;
  const publicBaseUrl = getPublicBaseUrl(config);

  const verifier: ApiKeyVerifier = verifyApiKey({
    app: APP_SLUG,
    signingSecret: deps.signingSecret,
    ...(deps.isRevoked ? { isRevoked: deps.isRevoked } : {}),
    ...(deps.audit ? { audit: deps.audit as never } : {}),
  });

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  });

  // Authenticate + enforce scopes for a /v1 request. Returns a Response on
  // failure (caller should return it), or null on success.
  async function requireScopes(c: Context, scopes: string[]): Promise<Response | null> {
    const decision = await verifier.authenticate(c.req.raw.headers, {
      method: c.req.method,
      path: c.req.path,
      requiredScopes: scopes,
    });
    if (!decision.ok) {
      return c.json({ error: decision.message, reason: decision.reason }, decision.status);
    }
    c.set("apiKey", decision.principal);
    return null;
  }

  // ── Health / ready / version ────────────────────────────────────────────
  app.get("/health", async (c) => {
    const health = await checkHealth(client);
    return c.json(
      { status: health.ok ? "ok" : "degraded", version, mode, db_latency_ms: health.latencyMs },
      health.ok ? 200 : 503,
    );
  });

  app.get("/ready", async (c) => {
    const ready = await checkReady(client, ATTACHMENTS_MIGRATIONS);
    return c.json(
      {
        status: ready.ok ? "ready" : "not_ready",
        version,
        mode,
        pending_migrations: ready.pendingMigrations,
        ...(ready.error ? { error: ready.error } : {}),
      },
      ready.ok ? 200 : 503,
    );
  });

  app.get("/version", (c) => c.json({ status: "ok", version, mode, name: `@hasna/${APP_SLUG}` }));

  app.get("/openapi.json", (c) => c.json(buildOpenApiDocument(version)));

  // ── /v1 API ──────────────────────────────────────────────────────────────
  app.get("/v1/attachments", async (c) => {
    const denied = await requireScopes(c, [`${APP_SLUG}:read`]);
    if (denied) return denied;
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 50;
    const includeExpired = c.req.query("expired") === "true";
    const tag = c.req.query("tag") || undefined;
    const rows = await store.findAll({ limit, includeExpired, tag });
    return c.json(rows.map(toApiAttachment));
  });

  app.post("/v1/attachments", async (c) => {
    const denied = await requireScopes(c, [`${APP_SLUG}:write`]);
    if (denied) return denied;

    const contentType = c.req.header("content-type") ?? "";
    let filename: string;
    let buffer: Buffer;
    let opts: {
      expiry?: string;
      tag?: string;
      password?: string;
      maxDownloads?: number;
      linkType?: "presigned" | "server";
    } = {};

    if (contentType.includes("application/json")) {
      const body = (await c.req.json().catch(() => null)) as
        | {
            filename?: string;
            content_base64?: string;
            expiry?: string;
            tag?: string;
            password?: string;
            max_downloads?: number;
            link_type?: "presigned" | "server";
          }
        | null;
      if (!body?.filename || typeof body.content_base64 !== "string") {
        return c.json({ error: "filename and content_base64 are required" }, 400);
      }
      filename = sanitizeFilename(body.filename);
      buffer = Buffer.from(body.content_base64, "base64");
      opts = {
        expiry: body.expiry,
        tag: body.tag,
        password: body.password,
        maxDownloads: body.max_downloads,
        linkType: body.link_type,
      };
    } else {
      // Raw streaming upload: bytes in the request body.
      filename = sanitizeFilename(
        c.req.query("filename") ?? c.req.header("x-filename") ?? `upload_${nanoid(8)}`,
      );
      const ab = await c.req.arrayBuffer();
      buffer = Buffer.from(ab);
      opts = {
        expiry: c.req.query("expiry") ?? undefined,
        tag: c.req.query("tag") ?? undefined,
        password: c.req.header("x-attachments-password") ?? undefined,
        maxDownloads: c.req.query("max_downloads") ? parseInt(c.req.query("max_downloads")!, 10) : undefined,
        linkType:
          c.req.query("link_type") === "presigned" || c.req.query("link_type") === "server"
            ? (c.req.query("link_type") as "presigned" | "server")
            : undefined,
      };
    }

    if (buffer.byteLength > config.storage.maxSizeBytes) {
      return c.json(
        { error: `File too large. Maximum size is ${config.storage.maxSizeBytes} bytes.` },
        413,
      );
    }

    const resolvedType =
      (mimeLookup(filename) || "application/octet-stream") as string;
    const id = `att_${nanoid(10)}`;
    const objectKey = createObjectKey(id, filename);
    const backend = resolveStorageBackend(config);
    const { milliseconds: expiryMs } = parseExpiryStrict(opts.expiry ?? config.defaults.expiry);
    const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;

    let linkType = opts.linkType ?? getLinkType(config);
    if (backend === "local" || opts.password || opts.maxDownloads) linkType = "server";

    await uploadBufferToStore(config, objectKey, buffer, resolvedType);

    let link: string | null = null;
    if (linkType === "presigned" && backend === "s3") {
      link = await generatePresignedLink(new S3Client(config.s3), objectKey, expiryMs);
    }

    const attachment: Attachment = {
      id,
      filename,
      s3Key: objectKey,
      bucket: backend === "s3" ? config.s3.bucket : "local",
      size: buffer.byteLength,
      contentType: resolvedType,
      link,
      tag: opts.tag ?? null,
      expiresAt,
      createdAt: Date.now(),
      storageBackend: backend,
      status: "ready",
      encryptionAlgorithm: null,
      encryptionSalt: null,
      encryptionIv: null,
      encryptionTag: null,
      downloads: 0,
    };
    await store.insert(attachment);

    if (linkType === "server") {
      const { token } = await store.createShareLink({
        attachmentId: id,
        expiresAt,
        password: opts.password,
        maxUses: opts.maxDownloads ?? null,
      });
      link = generateShareLink(token, publicBaseUrl, config.server.publicPath);
      await store.updateLink(id, link, expiresAt);
      attachment.link = link;
    }

    return c.json(toApiAttachment(attachment), 201);
  });

  app.get("/v1/attachments/:id", async (c) => {
    const denied = await requireScopes(c, [`${APP_SLUG}:read`]);
    if (denied) return denied;
    const attachment = await store.findById(c.req.param("id"));
    if (!attachment) return c.json({ error: "Not found" }, 404);
    return c.json(toApiAttachment(attachment));
  });

  app.delete("/v1/attachments/:id", async (c) => {
    const denied = await requireScopes(c, [`${APP_SLUG}:write`]);
    if (denied) return denied;
    const id = c.req.param("id");
    const attachment = await store.findById(id);
    if (!attachment) return c.json({ error: "Not found" }, 404);
    try {
      await createObjectStore(config).delete(attachment.s3Key);
    } catch {
      // Object deletion failure is non-fatal for metadata cleanup.
    }
    await store.delete(id);
    return c.json({ deleted: true, id });
  });

  app.get("/v1/attachments/:id/download", async (c) => {
    const denied = await requireScopes(c, [`${APP_SLUG}:read`]);
    if (denied) return denied;
    const attachment = await store.findById(c.req.param("id"));
    if (!attachment) return c.json({ error: "Not found" }, 404);
    if (isExpired(attachment)) return c.json({ error: "Attachment has expired" }, 410);
    const result = await openAttachmentStream(attachment, {
      config,
      rangeHeader: c.req.header("range"),
    });
    c.header("Content-Disposition", contentDispositionAttachment(attachment.filename));
    c.header("Content-Type", result.contentType ?? attachment.contentType);
    if (result.contentLength !== undefined) c.header("Content-Length", String(result.contentLength));
    const body =
      typeof (result.body as Readable).pipe === "function"
        ? (Readable.toWeb(result.body as Readable) as unknown as ReadableStream<Uint8Array>)
        : (result.body as ReadableStream<Uint8Array>);
    await store.incrementDownloads(attachment.id);
    return c.body(body as never, result.status);
  });

  app.get("/v1/attachments/:id/link", async (c) => {
    const denied = await requireScopes(c, [`${APP_SLUG}:read`]);
    if (denied) return denied;
    const attachment = await store.findById(c.req.param("id"));
    if (!attachment) return c.json({ error: "Not found" }, 404);
    return c.json({ link: attachment.link, expires_at: attachment.expiresAt });
  });

  app.post("/v1/attachments/:id/link", async (c) => {
    const denied = await requireScopes(c, [`${APP_SLUG}:write`]);
    if (denied) return denied;
    const id = c.req.param("id");
    const attachment = await store.findById(id);
    if (!attachment) return c.json({ error: "Not found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      expiry?: string;
      password?: string;
      max_downloads?: number;
      link_type?: "presigned" | "server";
    };
    const { milliseconds: expiryMs } = parseExpiryStrict(body.expiry ?? config.defaults.expiry);
    const newExpiresAt = expiryMs !== null ? Date.now() + expiryMs : null;
    const linkType = body.link_type ?? config.defaults.linkType;

    let newLink: string;
    if (linkType === "presigned" && (attachment.storageBackend ?? "s3") === "s3" && !body.password) {
      newLink = await generatePresignedLink(new S3Client(config.s3), attachment.s3Key, expiryMs);
    } else {
      const { token } = await store.createShareLink({
        attachmentId: id,
        expiresAt: newExpiresAt,
        password: body.password,
        maxUses: body.max_downloads ?? null,
      });
      newLink = generateShareLink(token, publicBaseUrl, config.server.publicPath);
    }
    await store.updateLink(id, newLink, newExpiresAt);
    return c.json({ link: newLink, expires_at: newExpiresAt });
  });

  return app;
}
