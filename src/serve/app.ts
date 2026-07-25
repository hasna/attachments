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
  normalizePublicPath,
  parseExpiryStrict,
  resolveStorageBackend,
} from "../core/config.js";
import { createObjectStore } from "../core/object-storage.js";
import { S3Client } from "../core/s3.js";
import { openAttachmentStream, isExpired } from "../core/download.js";
import {
  PresignExpiryError,
  generatePresignedLink,
  generateShareLink,
  getLinkType,
  resolveDeliverableLinkType,
} from "../core/links.js";
import { createObjectKey, sanitizeFilename, contentDispositionAttachment } from "../core/security.js";
import { buildOpenApiDocument } from "./openapi.js";
import { registerCloudPublicRoutes } from "./public-routes.js";

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

/** Thrown for caller mistakes that must surface as HTTP 400, never a bare 500. */
class BadRequestError extends Error {}

/**
 * Turn a handler failure into a response. Caller mistakes become 400 with the
 * reason; anything else is logged in full and answered with a 500 that still
 * carries the message — these routes are API-key authenticated, and the opaque
 * "Internal Server Error" was exactly what made D1/D2 undiagnosable from the CLI.
 */
function badRequestOrRethrow(c: Context, err: unknown): Response {
  if (err instanceof BadRequestError || err instanceof PresignExpiryError) {
    return c.json({ error: err.message }, 400);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("[v1]", c.req.method, c.req.path, message);
  return c.json({ error: "Internal Server Error", detail: message }, 500);
}

function parseExpiryOr400(expiry: string): { milliseconds: number | null; never: boolean } {
  try {
    return parseExpiryStrict(expiry);
  } catch (err) {
    throw new BadRequestError(err instanceof Error ? err.message : String(err));
  }
}

interface ParsedMultipartUpload {
  filename: string;
  buffer: Buffer;
  contentType?: string;
  fields: Record<string, string>;
}

/**
 * Parse a `multipart/form-data` upload.
 *
 * D1(c): the old code had no multipart branch at all — it fell through to the
 * raw-body reader and stored the whole encoded envelope (boundary + part
 * headers) as the file, corrupting every multipart upload while also losing the
 * filename and content type.
 */
async function parseMultipartUpload(c: Context): Promise<ParsedMultipartUpload> {
  const form = await c.req.raw.formData();
  const fields: Record<string, string> = {};
  let file: File | null = null;
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields[key] = value;
    } else if (!file || key === "file") {
      file = value;
    }
  }
  if (!file) throw new BadRequestError("multipart/form-data upload requires a file part");
  const declaredName = file.name && file.name !== "blob" ? file.name : undefined;
  const filename = sanitizeFilename(
    declaredName ?? fields["filename"] ?? c.req.query("filename") ?? `upload_${nanoid(8)}`,
  );
  return {
    filename,
    buffer: Buffer.from(await file.arrayBuffer()),
    ...(file.type && file.type !== "application/octet-stream" ? { contentType: file.type } : {}),
    fields,
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

  const publicPath = normalizePublicPath(config.server.publicPath);

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (c.req.path === publicPath || c.req.path.startsWith(`${publicPath}/`)) {
      // Same policy the on-box server applies to its public pages. `form-action
      // 'self'` is what lets the password form post back through whatever host
      // fronts this service.
      c.header(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
      c.header("Cache-Control", "no-store");
      if (publicBaseUrl.startsWith("https://") || c.req.header("x-forwarded-proto") === "https") {
        c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      }
    }
  });

  // Public share links (`/a/:token`). Registered before /v1 so the service that
  // MINTS these links is also the service that SERVES them (D3).
  registerCloudPublicRoutes(app, { store, config });

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
    let declaredContentType: string | undefined;
    let opts: {
      expiry?: string;
      tag?: string;
      password?: string;
      maxDownloads?: number;
      linkType?: "presigned" | "server";
    } = {};

    const parseLinkType = (value: string | undefined): "presigned" | "server" | undefined =>
      value === "presigned" || value === "server" ? value : undefined;
    const parseCount = (value: string | undefined): number | undefined => {
      if (value === undefined || value === "") return undefined;
      const parsed = parseInt(value, 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    };

    try {
    if (contentType.includes("multipart/form-data")) {
      const parsed = await parseMultipartUpload(c);
      filename = parsed.filename;
      buffer = parsed.buffer;
      declaredContentType = parsed.contentType;
      opts = {
        expiry: parsed.fields["expiry"] ?? c.req.query("expiry") ?? undefined,
        tag: parsed.fields["tag"] ?? c.req.query("tag") ?? undefined,
        password: parsed.fields["password"] ?? c.req.header("x-attachments-password") ?? undefined,
        maxDownloads: parseCount(parsed.fields["max_downloads"] ?? c.req.query("max_downloads") ?? undefined),
        linkType: parseLinkType(parsed.fields["link_type"] ?? c.req.query("link_type") ?? undefined),
      };
    } else if (contentType.includes("application/json")) {
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
      declaredContentType ?? ((mimeLookup(filename) || "application/octet-stream") as string);
    const id = `att_${nanoid(10)}`;
    const objectKey = createObjectKey(id, filename);
    const backend = resolveStorageBackend(config);
    const { milliseconds: expiryMs } = parseExpiryOr400(opts.expiry ?? config.defaults.expiry);
    const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;

    const linkType = resolveDeliverableLinkType({
      requested: opts.linkType ?? getLinkType(config),
      backend,
      expiryMs,
      password: opts.password,
      maxDownloads: opts.maxDownloads,
    });

    await uploadBufferToStore(config, objectKey, buffer, resolvedType);

    let link: string | null = null;
    if (linkType === "presigned") {
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
    } catch (err) {
      return badRequestOrRethrow(c, err);
    }
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
    try {
      const { milliseconds: expiryMs } = parseExpiryOr400(body.expiry ?? config.defaults.expiry);
      const newExpiresAt = expiryMs !== null ? Date.now() + expiryMs : null;
      const linkType = resolveDeliverableLinkType({
        requested: body.link_type ?? config.defaults.linkType,
        backend: attachment.storageBackend ?? "s3",
        expiryMs,
        password: body.password,
        maxDownloads: body.max_downloads,
      });

      let newLink: string;
      if (linkType === "presigned") {
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
      return c.json({ link: newLink, expires_at: newExpiresAt, link_type: linkType });
    } catch (err) {
      return badRequestOrRethrow(c, err);
    }
  });

  app.post("/v1/feedback", async (c) => {
    const denied = await requireScopes(c, [`${APP_SLUG}:write`]);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as {
      message?: string;
      email?: string | null;
      category?: string;
      version?: string | null;
    };
    if (!body.message || typeof body.message !== "string" || body.message.trim() === "") {
      return c.json({ error: "message is required" }, 400);
    }
    await store.saveFeedback({
      message: body.message,
      email: typeof body.email === "string" ? body.email : null,
      category: typeof body.category === "string" ? body.category : "general",
      version: typeof body.version === "string" ? body.version : null,
    });
    return c.json({ ok: true });
  });

  return app;
}
