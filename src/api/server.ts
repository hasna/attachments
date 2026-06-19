import { Hono, type Context } from "hono";
import { nanoid } from "nanoid";
import { format } from "date-fns";
import { lookup as mimeLookup } from "mime-types";
import { Readable } from "stream";
import { timingSafeEqual } from "crypto";
import { uploadStreamAttachment } from "../core/upload";
import { isExpired, openAttachmentStream } from "../core/download";
import { AttachmentsDB } from "../core/db";
import {
  getConfig,
  getPublicBaseUrl,
  hasS3Config,
  parseExpiryStrict,
  resolveStorageBackend,
} from "../core/config";
import { generatePresignedLink, generateShareLink } from "../core/links";
import { S3Client } from "../core/s3";
import { computeReport } from "../cli/commands/report";
import { contentDispositionAttachment, createObjectKey, sanitizeFilename } from "../core/security";
import { ShareAccessError, resolveShareAccess } from "../core/share";
import { createObjectStore } from "../core/object-storage";
import { buildDeploymentPlan } from "../core/deployment";

function maxUploadBytes(): number {
  const config = getConfig();
  return parseInt(
    process.env.ATTACHMENTS_MAX_SIZE ?? String(config.storage.maxSizeBytes),
    10
  );
}

const DIRECT_MULTIPART_PART_SIZE = 64 * 1024 * 1024;
const FORM_UPLOAD_SOFT_LIMIT = 64 * 1024 * 1024;
const PASSWORD_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const PASSWORD_ATTEMPT_LIMIT = 10;

type UploadRequestOptions = {
  expiry?: string;
  tag?: string;
  password?: string;
  encrypt?: boolean;
  maxDownloads?: number;
  linkType?: "presigned" | "server";
};

const passwordFailures = new Map<string, { count: number; resetAt: number }>();

function toWebBody(body: Readable | ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (typeof (body as Readable).pipe === "function") {
    return Readable.toWeb(body as Readable) as unknown as ReadableStream<Uint8Array>;
  }
  return body as ReadableStream<Uint8Array>;
}

function toNodeBody(body: Readable | ReadableStream<Uint8Array>): Readable {
  if (typeof (body as Readable).pipe === "function") return body as Readable;
  return Readable.fromWeb(body as never);
}

function trackShareDownloadCompletion(
  body: Readable | ReadableStream<Uint8Array>,
  shareLinkId: string,
  attachmentId: string
): Readable {
  const stream = toNodeBody(body);
  let ended = false;
  let settled = false;
  const settle = (ok: boolean) => {
    if (settled) return;
    settled = true;
    const db = new AttachmentsDB();
    try {
      if (ok) db.incrementDownloads(attachmentId);
      else db.releaseShareLink(shareLinkId);
    } finally {
      db.close();
    }
  };
  stream.once("end", () => {
    ended = true;
    settle(true);
  });
  stream.once("error", () => settle(false));
  stream.once("close", () => {
    if (!ended) settle(false);
  });
  return stream;
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseBooleanOption(value: string | undefined | null): boolean {
  return value === "true" || value === "1" || value === "yes";
}

function parsePositiveInteger(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function requestUploadOptions(c: Context): UploadRequestOptions {
  const linkTypeInput = firstNonEmpty(c.req.query("link_type"), c.req.header("x-attachments-link-type"));
  const linkType = linkTypeInput === "presigned" || linkTypeInput === "server" ? linkTypeInput : undefined;
  return {
    expiry: firstNonEmpty(c.req.query("expiry"), c.req.header("x-attachments-expiry")),
    tag: firstNonEmpty(c.req.query("tag"), c.req.header("x-attachments-tag")),
    password: firstNonEmpty(c.req.header("x-attachments-password"), c.req.header("x-attachment-password")),
    encrypt: parseBooleanOption(firstNonEmpty(c.req.query("encrypt"), c.req.header("x-attachments-encrypt"))),
    maxDownloads: parsePositiveInteger(firstNonEmpty(c.req.query("max_downloads"), c.req.header("x-attachments-max-downloads"))),
    linkType,
  };
}

function clientAddress(c: Context): string {
  if (process.env["ATTACHMENTS_TRUST_PROXY"] !== "1") return "remote";
  const forwarded = c.req.header("cf-connecting-ip") || c.req.header("x-real-ip") || c.req.header("x-forwarded-for") || "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

function passwordFailureKey(c: Context, token: string): string {
  return `${token}:${clientAddress(c)}`;
}

function isPasswordLimited(c: Context, token: string): boolean {
  const key = passwordFailureKey(c, token);
  const entry = passwordFailures.get(key);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    passwordFailures.delete(key);
    return false;
  }
  return entry.count >= PASSWORD_ATTEMPT_LIMIT;
}

function recordPasswordFailure(c: Context, token: string): void {
  const key = passwordFailureKey(c, token);
  const now = Date.now();
  const current = passwordFailures.get(key);
  if (!current || current.resetAt <= now) {
    passwordFailures.set(key, { count: 1, resetAt: now + PASSWORD_ATTEMPT_WINDOW_MS });
    return;
  }
  current.count += 1;
}

function clearPasswordFailures(c: Context, token: string): void {
  passwordFailures.delete(passwordFailureKey(c, token));
}

function getApiToken(): string | null {
  const token =
    process.env.ATTACHMENTS_API_TOKEN?.trim() ||
    process.env.HASNA_ATTACHMENTS_API_TOKEN?.trim() ||
    "";
  return token || null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestApiToken(c: Context): string | null {
  const auth = c.req.header("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  return bearer || c.req.header("x-attachments-token") || c.req.header("x-api-key") || null;
}

function requireApiAuth(c: Context): Response | null {
  const expected = getApiToken();
  if (!expected) return null;
  const actual = requestApiToken(c);
  if (actual && safeEqual(actual, expected)) return null;
  return c.json({ error: "Unauthorized" }, 401);
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDownloadPage(input: {
  token: string;
  filename: string;
  size: number;
  expiresAt: number | null;
  requiresPassword: boolean;
  maxUses?: number | null;
  usedCount?: number;
  error?: string;
}): string {
  const publicPath = getConfig().server.publicPath.replace(/\/+$/, "") || "/a";
  const expiry = input.expiresAt
    ? new Date(input.expiresAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })
    : "Never";
  const remaining = input.maxUses === null || input.maxUses === undefined
    ? null
    : Math.max(0, input.maxUses - (input.usedCount ?? 0));
  const downloadsRow = input.maxUses === null || input.maxUses === undefined
    ? ""
    : `<dt>Downloads</dt><dd>${remaining} of ${input.maxUses} remaining</dd>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(input.filename)} - Attachment</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f7f8; color: #172026; }
    main { width: min(92vw, 520px); border: 1px solid #d7dee3; border-radius: 8px; background: #fff; padding: 28px; box-shadow: 0 18px 48px rgb(23 32 38 / 10%); }
    h1 { margin: 0 0 12px; font-size: 22px; line-height: 1.2; overflow-wrap: anywhere; }
    dl { display: grid; grid-template-columns: 88px 1fr; gap: 8px 14px; margin: 18px 0 22px; color: #46545f; }
    dt { font-weight: 650; }
    dd { margin: 0; overflow-wrap: anywhere; }
    form { display: grid; gap: 12px; }
    label { font-size: 14px; font-weight: 650; }
    input { min-height: 42px; border: 1px solid #b9c3ca; border-radius: 6px; padding: 0 12px; font: inherit; }
    button { min-height: 44px; border: 0; border-radius: 6px; background: #1e6f5c; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    .error { margin: 0 0 14px; color: #9f1d1d; font-weight: 650; }
    @media (prefers-color-scheme: dark) {
      body { background: #101417; color: #f4f7f8; }
      main { background: #171d21; border-color: #2b363d; box-shadow: none; }
      dl { color: #bac6cc; }
      input { background: #101417; border-color: #46545f; color: #f4f7f8; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${htmlEscape(input.filename)}</h1>
    ${input.error ? `<p class="error">${htmlEscape(input.error)}</p>` : ""}
    <dl>
      <dt>Size</dt><dd>${input.size.toLocaleString()} bytes</dd>
      <dt>Expires</dt><dd>${htmlEscape(expiry)}</dd>
      ${downloadsRow}
    </dl>
    <form method="post" action="${htmlEscape(publicPath)}/${encodeURIComponent(input.token)}/download">
      ${input.requiresPassword ? `<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>` : ""}
      <button type="submit">Download</button>
    </form>
  </main>
</body>
</html>`;
}

function renderPublicErrorPage(input: {
  title: string;
  message: string;
  detail?: string;
  status?: number;
  actionHref?: string;
  actionLabel?: string;
}): string {
  const status = input.status ? String(input.status) : "Unavailable";
  const action = input.actionHref && input.actionLabel
    ? `<a class="button" href="${htmlEscape(input.actionHref)}">${htmlEscape(input.actionLabel)}</a>`
    : "";
  const detail = input.detail ? `<p class="detail">${htmlEscape(input.detail)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(input.title)} - Attachment</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f7f8; color: #172026; }
    main { width: min(92vw, 520px); border: 1px solid #d7dee3; border-radius: 8px; background: #fff; padding: 28px; box-shadow: 0 18px 48px rgb(23 32 38 / 10%); }
    .status { display: inline-flex; align-items: center; min-height: 28px; padding: 0 10px; border-radius: 999px; background: #eef2f5; color: #46545f; font-size: 13px; font-weight: 700; }
    h1 { margin: 18px 0 10px; font-size: 24px; line-height: 1.2; letter-spacing: 0; }
    p { margin: 0; color: #46545f; line-height: 1.55; }
    .detail { margin-top: 12px; color: #6a7780; font-size: 14px; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; margin-top: 22px; padding: 0 16px; border-radius: 6px; background: #1e6f5c; color: #fff; text-decoration: none; font-weight: 700; }
    @media (prefers-color-scheme: dark) {
      body { background: #101417; color: #f4f7f8; }
      main { background: #171d21; border-color: #2b363d; box-shadow: none; }
      .status { background: #263139; color: #cbd5db; }
      p { color: #bac6cc; }
      .detail { color: #8c9aa3; }
    }
  </style>
</head>
<body>
  <main>
    <div class="status">${htmlEscape(status)}</div>
    <h1>${htmlEscape(input.title)}</h1>
    <p>${htmlEscape(input.message)}</p>
    ${detail}
    ${action}
  </main>
</body>
</html>`;
}

function renderShareAccessError(token: string, err: ShareAccessError): string {
  if (err.message.includes("already been used") || err.message.includes("no longer available")) {
    return renderPublicErrorPage({
      title: "This attachment link has already been used",
      message: "The sender limited this link to a fixed number of downloads, and that limit has been reached.",
      detail: "Ask the sender for a new link if you still need the file.",
      status: err.status,
    });
  }
  if (err.message.includes("expired")) {
    return renderPublicErrorPage({
      title: "This attachment link has expired",
      message: "The sender set an expiration time for this attachment, and the link is no longer available.",
      detail: "Ask the sender to create a fresh link.",
      status: err.status,
    });
  }
  if (err.message.includes("revoked")) {
    return renderPublicErrorPage({
      title: "This attachment link was revoked",
      message: "The sender has turned this attachment link off.",
      detail: "Ask the sender for a new link if access is still needed.",
      status: err.status,
    });
  }
  if (err.status === 401) {
    return renderPublicErrorPage({
      title: "Password required",
      message: "This attachment is protected. Open the attachment page and enter the password from the sender.",
      status: err.status,
      actionHref: sharePagePath(token),
      actionLabel: "Open Attachment Page",
    });
  }
  return renderPublicErrorPage({
    title: "Attachment unavailable",
    message: "This attachment link cannot be opened.",
    detail: err.message,
    status: err.status,
  });
}

function deploymentPlan() {
  const config = getConfig();
  return {
    ...buildDeploymentPlan(config),
    storage_backend: resolveStorageBackend(config),
  };
}

function sharePagePath(token: string): string {
  const publicPath = getConfig().server.publicPath.replace(/\/+$/, "") || "/a";
  return `${publicPath}/${encodeURIComponent(token)}`;
}

function isConfirmedDownloadRequest(c: Context): boolean {
  return c.req.header("x-attachments-download") === "1" || c.req.query("download") === "1";
}

export function createApp(): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const config = getConfig();
    const forwardedProto = c.req.header("x-forwarded-proto");
    if (forwardedProto === "https" || config.server.baseUrl.startsWith("https://") || getPublicBaseUrl(config).startsWith("https://")) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (c.req.path.startsWith("/a/") || c.req.path.startsWith(config.server.publicPath.replace(/\/+$/, "") + "/")) {
      c.header("Cache-Control", "no-store");
    }
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") {
      await next();
      return;
    }
    const unauthorized = requireApiAuth(c);
    if (unauthorized) return unauthorized;
    await next();
  });

  // GET /api/health — quick status check
  app.get("/api/health", (c) => {
    const db = new AttachmentsDB();
    try {
      const all = db.findAll({ includeExpired: true });
      const expired = all.filter(a => a.expiresAt !== null && a.expiresAt <= Date.now()).length;
      const config = (() => { try { return getConfig(); } catch { return null; } })();
      return c.json({
        status: "ok",
        attachments: all.length,
        expired,
        s3_configured: config ? hasS3Config(config) : false,
        api_auth_required: !!getApiToken(),
        storage_backend: config ? resolveStorageBackend(config) : "local",
        public_base_url: config ? getPublicBaseUrl(config) : `http://localhost:3459`,
        public_path: config?.server?.publicPath ?? "/a",
        server: config?.server?.baseUrl ?? `http://localhost:${config?.server?.port ?? 3459}`,
        timestamp: new Date().toISOString(),
      });
    } finally {
      db.close();
    }
  });

  app.get("/api/deployment", (c) => c.json(deploymentPlan()));

  // POST /api/attachments — multipart file upload
  app.post("/api/attachments", async (c) => {
    const maxBytes = maxUploadBytes();
    const contentLength = parseInt(c.req.header("content-length") ?? "0", 10);
    if (contentLength > maxBytes) {
      return c.json({ error: `File too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)}MB` }, 413);
    }
    if (contentLength > FORM_UPLOAD_SOFT_LIMIT) {
      return c.json({
        error: `Multipart form uploads are capped at ${Math.round(FORM_UPLOAD_SOFT_LIMIT / 1024 / 1024)}MB. Use PUT /api/attachments or the direct multipart API for large files.`,
      }, 413);
    }

    try {
      const body = await c.req.parseBody();
      const file = body["file"];

      if (!file || typeof file === "string") {
        return c.json({ error: "file field is required" }, 400);
      }

      // Post-parse size check (Content-Length may be absent)
      const fileSize = file instanceof File ? file.size : 0;
      if (fileSize > maxBytes) {
        return c.json({ error: `File too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)}MB` }, 413);
      }
      if (fileSize > FORM_UPLOAD_SOFT_LIMIT) {
        return c.json({
          error: `Multipart form uploads are capped at ${Math.round(FORM_UPLOAD_SOFT_LIMIT / 1024 / 1024)}MB. Use PUT /api/attachments or the direct multipart API for large files.`,
        }, 413);
      }

      const expiry = typeof body["expiry"] === "string" ? body["expiry"] : undefined;
      const tag = typeof body["tag"] === "string" ? body["tag"] : undefined;
      const password = typeof body["password"] === "string"
        ? body["password"]
        : firstNonEmpty(c.req.header("x-attachments-password"), c.req.header("x-attachment-password"));
      const encrypt = body["encrypt"] === "true" || body["encrypt"] === "1";
      const maxDownloads =
        typeof body["max_downloads"] === "string"
          ? parseInt(body["max_downloads"], 10)
          : undefined;
      const linkType =
        body["link_type"] === "presigned" || body["link_type"] === "server"
          ? body["link_type"]
          : undefined;

      const fileObj = file as File;
      const filename = sanitizeFilename(fileObj.name || `upload_${nanoid(8)}`);
      const contentType = fileObj.type || (mimeLookup(filename) || "application/octet-stream");
      const attachment = await uploadStreamAttachment(
        Readable.fromWeb(fileObj.stream() as never),
        filename,
        typeof contentType === "string" ? contentType : "application/octet-stream",
        { expiry, tag, password, encrypt, maxDownloads, linkType, size: fileSize }
      );

      return c.json(
        {
          id: attachment.id,
          filename: attachment.filename,
          size: attachment.size,
          link: attachment.link,
          tag: attachment.tag,
          expires_at: attachment.expiresAt,
          created_at: attachment.createdAt,
        },
        201
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.put("/api/attachments", async (c) => {
    const maxBytes = maxUploadBytes();
    const contentLengthHeader = c.req.header("content-length");
    const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;
    if (contentLength !== undefined && contentLength > maxBytes) {
      return c.json({ error: `File too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)}MB` }, 413);
    }

    const filename = sanitizeFilename(c.req.query("filename") ?? c.req.header("x-filename") ?? `upload_${nanoid(8)}`);
    const uploadOptions = requestUploadOptions(c);
    const contentType = c.req.header("content-type") ?? (mimeLookup(filename) || "application/octet-stream");

    try {
      if (!c.req.raw.body) {
        return c.json({ error: "Request body is required" }, 400);
      }
      const attachment = await uploadStreamAttachment(
        Readable.fromWeb(c.req.raw.body as never),
        filename,
        typeof contentType === "string" ? contentType : "application/octet-stream",
        { ...uploadOptions, size: contentLength }
      );
      return c.json(
        {
          id: attachment.id,
          filename: attachment.filename,
          size: attachment.size,
          link: attachment.link,
          tag: attachment.tag,
          expires_at: attachment.expiresAt,
          created_at: attachment.createdAt,
        },
        201
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // GET /api/context — compact text summary for agent system prompt injection
  // Set ATTACHMENTS_URL=http://localhost:3459 in your agent to enable automatic context
  app.get("/api/context", (c) => {
    const db = new AttachmentsDB();
    try {
      const all = db.findAll({ includeExpired: true });
      const active = all.filter(a => !a.expiresAt || a.expiresAt > Date.now());
      const expiringSoon = all.filter(a => a.expiresAt && a.expiresAt > Date.now() && a.expiresAt - Date.now() < 24 * 60 * 60 * 1000);
      const expired = all.filter(a => a.expiresAt && a.expiresAt <= Date.now());
      const lines: string[] = [`Attachments: ${all.length} total (${active.length} active, ${expired.length} expired)`];
      if (expiringSoon.length > 0) lines.push(`⚠ Expiring in 24h: ${expiringSoon.length} (${expiringSoon.map(a => a.filename).join(", ")})`);
      if (all.length > 0) {
        const recent = all.slice(0, 3).map(a => `${a.filename} (${a.id})`).join(", ");
        lines.push(`Recent: ${recent}`);
      }
      const format = c.req.query("format") ?? "text";
      if (format === "json") return c.json({ attachments: all.length, active: active.length, expired: expired.length, expiring_soon: expiringSoon.length, summary: lines.join("\n") });
      return c.text(lines.join("\n"));
    } finally {
      db.close();
    }
  });

  // GET /api/report — activity/storage report
  app.get("/api/report", (c) => {
    const days = parseInt(c.req.query("days") ?? "7", 10);
    const tag = c.req.query("tag") || undefined;

    if (isNaN(days) || days < 1) {
      return c.json({ error: "days must be a positive integer" }, 400);
    }

    const nowMs = Date.now();
    const sinceMs = nowMs - days * 24 * 60 * 60 * 1000;
    const db = new AttachmentsDB();
    let all;
    try {
      all = db.findAll({ includeExpired: true, tag });
    } finally {
      db.close();
    }
    return c.json(computeReport(all, sinceMs, nowMs));
  });

  // GET /api/attachments — list attachments
  app.get("/api/attachments", (c) => {
    const limitParam = c.req.query("limit");
    const fieldsParam = c.req.query("fields");
    const format = c.req.query("format");
    const expiredParam = c.req.query("expired");
    const tagParam = c.req.query("tag");

    const limit = limitParam ? parseInt(limitParam, 10) : 20;
    const includeExpired = expiredParam === "true";
    const tag = tagParam || undefined;

    const db = new AttachmentsDB();
    let attachments;
    try {
      attachments = db.findAll({ limit, includeExpired, tag });
    } finally {
      db.close();
    }

    // Map to plain objects
    const items = attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      content_type: a.contentType,
      link: a.link,
      tag: a.tag,
      expires_at: a.expiresAt,
      created_at: a.createdAt,
    }));

    // Field selection
    if (fieldsParam) {
      const fields = fieldsParam.split(",").map((f) => f.trim());
      const filtered = items.map((item) => {
        const picked: Record<string, unknown> = {};
        for (const f of fields) {
          if (f in item) {
            picked[f] = (item as Record<string, unknown>)[f];
          }
        }
        return picked;
      });

      if (format === "compact") {
        const lines = filtered.map((item) => JSON.stringify(item)).join("\n");
        return c.text(lines);
      }
      return c.json(filtered);
    }

    if (format === "compact") {
      const lines = items.map((item) => JSON.stringify(item)).join("\n");
      return c.text(lines);
    }

    return c.json(items);
  });

  // GET /api/attachments/:id — get attachment metadata
  app.get("/api/attachments/:id", (c) => {
    const id = c.req.param("id");
    const db = new AttachmentsDB();
    let attachment;
    try {
      attachment = db.findById(id);
    } finally {
      db.close();
    }

    if (!attachment) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({
      id: attachment.id,
      filename: attachment.filename,
      size: attachment.size,
      content_type: attachment.contentType,
      link: attachment.link,
      tag: attachment.tag,
      expires_at: attachment.expiresAt,
      created_at: attachment.createdAt,
    });
  });

  // DELETE /api/attachments/:id — delete attachment
  app.delete("/api/attachments/:id", async (c) => {
    const id = c.req.param("id");
    const db = new AttachmentsDB();
    let attachment;
    try {
      attachment = db.findById(id);
    } finally {
      db.close();
    }

    if (!attachment) {
      return c.json({ error: "Not found" }, 404);
    }

    try {
      const config = getConfig();
      const store = createObjectStore(config);
      await store.delete(attachment.s3Key);
    } catch {
      // Object delete failure is non-fatal for DB cleanup
    }

    const db2 = new AttachmentsDB();
    try {
      db2.delete(id);
    } finally {
      db2.close();
    }

    return c.text(`deleted: ${id}`);
  });

  // GET /api/attachments/:id/download — download or redirect
  app.get("/api/attachments/:id/download", async (c) => {
    const id = c.req.param("id");
    const db = new AttachmentsDB();
    let attachment;
    try {
      attachment = db.findById(id);
    } finally {
      db.close();
    }

    if (!attachment) {
      return c.json({ error: "Not found" }, 404);
    }

    if (isExpired(attachment)) {
      return c.json({ error: "Attachment has expired" }, 410);
    }

    try {
      const result = await openAttachmentStream(attachment, {
        rangeHeader: c.req.header("range"),
        password: firstNonEmpty(c.req.header("x-attachments-password"), c.req.header("x-attachment-password")),
      });
      c.header("Content-Disposition", contentDispositionAttachment(attachment.filename));
      c.header("Accept-Ranges", attachment.encryptionAlgorithm ? "none" : "bytes");
      c.header("Content-Type", result.contentType ?? attachment.contentType);
      if (result.contentLength !== undefined) c.header("Content-Length", String(result.contentLength));
      if (result.contentRange) c.header("Content-Range", result.contentRange);
      return c.body(toWebBody(result.body) as never, result.status);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // GET /api/attachments/:id/link — get shareable link
  app.get("/api/attachments/:id/link", (c) => {
    const id = c.req.param("id");
    const db = new AttachmentsDB();
    let attachment;
    try {
      attachment = db.findById(id);
    } finally {
      db.close();
    }

    if (!attachment) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({
      link: attachment.link,
      expires_at: attachment.expiresAt,
    });
  });

  // POST /api/attachments/:id/link — regenerate link
  app.post("/api/attachments/:id/link", async (c) => {
    const id = c.req.param("id");
    const db = new AttachmentsDB();
    let attachment;
    try {
      attachment = db.findById(id);
    } finally {
      db.close();
    }

    if (!attachment) {
      return c.json({ error: "Not found" }, 404);
    }

    let body: { expiry?: string; password?: string; max_downloads?: number; link_type?: "presigned" | "server" } = {};
    try {
      body = await c.req.json();
    } catch {
      // body is optional
    }

    const config = getConfig();
    const expiryStr = body.expiry ?? config.defaults.expiry;
    const { milliseconds: expiryMs } = parseExpiryStrict(expiryStr);
    const newExpiresAt = expiryMs !== null ? Date.now() + expiryMs : null;

    let newLink: string;
    const linkType = body.link_type ?? config.defaults.linkType;
    if (linkType === "presigned" && (attachment.storageBackend ?? "s3") === "s3") {
      const s3 = new S3Client(config.s3);
      newLink = await generatePresignedLink(s3, attachment.s3Key, expiryMs);
    } else {
      const db3 = new AttachmentsDB();
      try {
        const { token } = db3.createShareLink({
          attachmentId: id,
          expiresAt: newExpiresAt,
          password: body.password,
          maxUses: body.max_downloads ?? null,
        });
        newLink = generateShareLink(token, getPublicBaseUrl(config), config.server.publicPath);
      } finally {
        db3.close();
      }
    }

    const db2 = new AttachmentsDB();
    try {
      db2.updateLink(id, newLink, newExpiresAt);
    } finally {
      db2.close();
    }

    return c.json({
      link: newLink,
      expires_at: newExpiresAt,
    });
  });

  // POST /api/attachments/presign-upload — generate presigned PUT URL
  app.post("/api/attachments/multipart", async (c) => {
    try {
      let body: {
        filename?: string;
        content_type?: string;
        size?: number;
        upload_expiry?: string;
        tag?: string;
      } = {};
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Request body is required" }, 400);
      }

      if (!body.filename) {
        return c.json({ error: "filename is required" }, 400);
      }

      const config = getConfig();
      if (resolveStorageBackend(config) !== "s3") {
        return c.json({ error: "Direct multipart upload requires S3 storage" }, 400);
      }

      const size = typeof body.size === "number" ? body.size : undefined;
      if (size !== undefined && size > config.storage.maxSizeBytes) {
        return c.json({ error: `File too large. Maximum size is ${config.storage.maxSizeBytes} bytes.` }, 413);
      }

      const filename = sanitizeFilename(body.filename);
      const contentType = body.content_type ?? (mimeLookup(filename) || "application/octet-stream");
      const id = `att_${nanoid(10)}`;
      const s3Key = createObjectKey(id, filename);
      const uploadExpiry = parseExpiryStrict(body.upload_expiry ?? "1h").milliseconds;
      if (uploadExpiry === null) {
        return c.json({ error: "Multipart upload expiry cannot be never" }, 400);
      }

      const s3 = new S3Client(config.s3);
      const uploadId = await s3.createMultipartUpload(s3Key, contentType);
      const now = Date.now();
      const db = new AttachmentsDB();
      try {
        db.insert({
          id,
          filename,
          s3Key,
          bucket: config.s3.bucket,
          size: size ?? 0,
          contentType,
          link: null,
          tag: body.tag ?? null,
          expiresAt: now + uploadExpiry,
          createdAt: now,
          storageBackend: "s3",
          status: "pending",
        });
      } finally {
        db.close();
      }

      return c.json({
        id,
        upload_id: uploadId,
        part_size: DIRECT_MULTIPART_PART_SIZE,
        expires_at: now + uploadExpiry,
      }, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/attachments/:id/multipart/part", async (c) => {
    const id = c.req.param("id");
    let body: { upload_id?: string; part_number?: number; expiry?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body is required" }, 400);
    }
    if (!body.upload_id) return c.json({ error: "upload_id is required" }, 400);
    if (!Number.isInteger(body.part_number) || Number(body.part_number) < 1 || Number(body.part_number) > 10000) {
      return c.json({ error: "part_number must be an integer from 1 to 10000" }, 400);
    }

    const db = new AttachmentsDB();
    let attachment;
    try {
      attachment = db.findById(id);
    } finally {
      db.close();
    }
    if (!attachment || attachment.status !== "pending") {
      return c.json({ error: "Pending attachment not found" }, 404);
    }

    const expiryMs = parseExpiryStrict(body.expiry ?? "1h").milliseconds;
    if (expiryMs === null) return c.json({ error: "Part URL expiry cannot be never" }, 400);
    const s3 = new S3Client(getConfig().s3);
    const uploadUrl = await s3.presignUploadPart(
      attachment.s3Key,
      body.upload_id,
      Number(body.part_number),
      Math.floor(expiryMs / 1000)
    );
    return c.json({ upload_url: uploadUrl, part_number: body.part_number });
  });

  app.post("/api/attachments/:id/multipart/complete", async (c) => {
    const id = c.req.param("id");
    let body: {
      upload_id?: string;
      parts?: Array<{ ETag?: string; etag?: string; PartNumber?: number; part_number?: number }>;
      expiry?: string;
      password?: string;
      max_downloads?: number;
      size?: number;
    } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body is required" }, 400);
    }
    if (!body.upload_id) return c.json({ error: "upload_id is required" }, 400);
    if (!Array.isArray(body.parts) || body.parts.length === 0) {
      return c.json({ error: "parts are required" }, 400);
    }

    const db = new AttachmentsDB();
    let attachment;
    try {
      attachment = db.findById(id);
    } finally {
      db.close();
    }
    if (!attachment || attachment.status !== "pending") {
      return c.json({ error: "Pending attachment not found" }, 404);
    }

    const parts = body.parts.map((part) => ({
      ETag: String(part.ETag ?? part.etag ?? ""),
      PartNumber: Number(part.PartNumber ?? part.part_number),
    }));
    if (parts.some((part) => !part.ETag || !Number.isInteger(part.PartNumber) || part.PartNumber < 1)) {
      return c.json({ error: "Every part must include ETag and PartNumber" }, 400);
    }

    const config = getConfig();
    const s3 = new S3Client(config.s3);
    try {
      await s3.completeMultipartUpload(attachment.s3Key, body.upload_id, parts);
      const info = await s3.head(attachment.s3Key);
      const size = info.contentLength ?? body.size ?? attachment.size;
      if (size > config.storage.maxSizeBytes) {
        await s3.delete(attachment.s3Key);
        return c.json({ error: `File too large. Maximum size is ${config.storage.maxSizeBytes} bytes.` }, 413);
      }

      const { milliseconds: expiryMs } = parseExpiryStrict(body.expiry ?? config.defaults.expiry);
      const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;
      const db2 = new AttachmentsDB();
      let link: string;
      try {
        const { token } = db2.createShareLink({
          attachmentId: attachment.id,
          expiresAt,
          password: body.password,
          maxUses: body.max_downloads ?? null,
        });
        link = generateShareLink(token, getPublicBaseUrl(config), config.server.publicPath);
        db2.markReady({
          id: attachment.id,
          size,
          contentType: info.contentType ?? attachment.contentType,
          link,
          expiresAt,
        });
      } finally {
        db2.close();
      }

      return c.json({
        id: attachment.id,
        filename: attachment.filename,
        size,
        link,
        expires_at: expiresAt,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/attachments/:id/multipart/abort", async (c) => {
    const id = c.req.param("id");
    let body: { upload_id?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body is required" }, 400);
    }
    if (!body.upload_id) return c.json({ error: "upload_id is required" }, 400);
    const db = new AttachmentsDB();
    let attachment;
    try {
      attachment = db.findById(id);
      if (attachment) db.delete(id);
    } finally {
      db.close();
    }
    if (!attachment) return c.json({ error: "Pending attachment not found" }, 404);
    await new S3Client(getConfig().s3).abortMultipart(attachment.s3Key, body.upload_id);
    return c.json({ aborted: true, id });
  });

  // POST /api/attachments/presign-upload — generate presigned PUT URL
  app.post("/api/attachments/presign-upload", async (c) => {
    try {
      let body: { filename?: string; expiry?: string; content_type?: string; size?: number } = {};
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Request body is required" }, 400);
      }

      if (!body.filename) {
        return c.json({ error: "filename is required" }, 400);
      }

      const config = getConfig();
      const filename = body.filename;
      if (typeof body.size === "number" && body.size > config.storage.maxSizeBytes) {
        return c.json({ error: `File too large. Maximum size is ${config.storage.maxSizeBytes} bytes.` }, 413);
      }

      // Determine content type
      const contentType =
        body.content_type ?? (mimeLookup(filename) || "application/octet-stream");

      // Parse expiry (default 1h)
      const expiryStr = body.expiry ?? "1h";
      let expiryMs: number | null;
      try {
        expiryMs = parseExpiryStrict(expiryStr).milliseconds;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 400);
      }
      if (expiryMs === null) {
        return c.json({ error: "Presigned upload expiry cannot be never" }, 400);
      }

      const expirySeconds = Math.floor(expiryMs / 1000);

      // Generate ID and S3 key
      const id = `att_${nanoid(11)}`;
      const datePrefix = format(new Date(), "yyyy-MM-dd");
      const s3Key = `attachments/${datePrefix}/${id}/${filename}`;

      // Generate presigned PUT URL
      const s3 = new S3Client(config.s3);
      const uploadUrl = await s3.presignPut(s3Key, contentType, expirySeconds);

      // Create DB record with size 0 (pending upload)
      const now = Date.now();
      const expiresAt = now + expiryMs;
      const db = new AttachmentsDB();
      try {
        db.insert({
          id,
          filename,
          s3Key,
          bucket: config.s3.bucket,
          size: 0,
          contentType,
          link: null,
          tag: null,
          expiresAt,
          createdAt: now,
          storageBackend: "s3",
          status: "pending",
        });
      } finally {
        db.close();
      }

      return c.json(
        {
          upload_url: uploadUrl,
          id,
          expires_at: expiresAt,
          finalize_url: `/api/attachments/${id}/presign-upload/complete`,
          warning: "Finalize and verify the object before sharing this attachment.",
        },
        201
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/attachments/:id/presign-upload/complete", async (c) => {
    const id = c.req.param("id");
    let body: { expiry?: string; password?: string; max_downloads?: number; link_type?: "presigned" | "server" } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional; defaults come from config.
    }

    const db = new AttachmentsDB();
    let attachment;
    try {
      attachment = db.findById(id);
    } finally {
      db.close();
    }
    if (!attachment) return c.json({ error: "Pending attachment not found" }, 404);
    if (attachment.status !== "pending") return c.json({ error: "Attachment upload is already complete" }, 409);

    try {
      const config = getConfig();
      const info = await new S3Client(config.s3).head(attachment.s3Key);
      if (info.contentLength !== undefined && info.contentLength > config.storage.maxSizeBytes) {
        try {
          await createObjectStore(config).delete(attachment.s3Key);
        } catch {
          // Best-effort cleanup; the attachment must not be finalized either way.
        }
        const dbDelete = new AttachmentsDB();
        try {
          dbDelete.delete(id);
        } finally {
          dbDelete.close();
        }
        return c.json({ error: `File too large. Maximum size is ${config.storage.maxSizeBytes} bytes.` }, 413);
      }
      const expiryStr = body.expiry ?? config.defaults.expiry;
      const { milliseconds: expiryMs } = parseExpiryStrict(expiryStr);
      const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;
      const maxDownloads = typeof body.max_downloads === "number" && body.max_downloads > 0
        ? Math.floor(body.max_downloads)
        : null;
      const linkType = body.link_type ?? config.defaults.linkType;
      const mustUseServerLink = !!body.password || maxDownloads !== null || linkType !== "presigned";

      let link: string;
      if (!mustUseServerLink && (attachment.storageBackend ?? "s3") === "s3") {
        link = await generatePresignedLink(new S3Client(config.s3), attachment.s3Key, expiryMs);
      } else {
        const dbLinks = new AttachmentsDB();
        try {
          const { token } = dbLinks.createShareLink({
            attachmentId: id,
            expiresAt,
            password: body.password,
            maxUses: maxDownloads,
          });
          link = generateShareLink(token, getPublicBaseUrl(config), config.server.publicPath);
        } finally {
          dbLinks.close();
        }
      }

      const dbReady = new AttachmentsDB();
      try {
        dbReady.markReady({
          id,
          size: info.contentLength ?? attachment.size,
          contentType: info.contentType ?? attachment.contentType,
          link,
          expiresAt,
        });
      } finally {
        dbReady.close();
      }

      return c.json({
        id,
        filename: attachment.filename,
        size: info.contentLength ?? attachment.size,
        link,
        expires_at: expiresAt,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  const publicRoutePrefixes = Array.from(new Set([
    "/a",
    getConfig().server.publicPath.replace(/\/+$/, "") || "/a",
  ]));

  const sharePageHandler = (c: Context) => {
    const token = c.req.param("token")!;
    const db = new AttachmentsDB();
    try {
      const access = resolveShareAccess(db, token, { consume: false });
      return c.html(renderDownloadPage({
        token,
        filename: access.attachment.filename,
        size: access.attachment.size,
        expiresAt: access.shareLink.expiresAt ?? access.attachment.expiresAt,
        requiresPassword: !!access.shareLink.passwordHash,
        maxUses: access.shareLink.maxUses,
        usedCount: access.shareLink.usedCount,
      }));
    } catch (err) {
      if (err instanceof ShareAccessError) {
        return c.html(renderShareAccessError(token, err), err.status);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    } finally {
      db.close();
    }
  };

  async function serveShareDownload(c: Context, password?: string) {
    const token = c.req.param("token")!;
    if (isPasswordLimited(c, token)) {
      return c.html(renderPublicErrorPage({
        title: "Too many password attempts",
        message: "This attachment is temporarily locked because the password was entered incorrectly too many times.",
        detail: "Try again later or ask the sender to create a fresh link.",
        status: 429,
        actionHref: sharePagePath(token),
        actionLabel: "Back to Attachment",
      }), 429);
    }

    const db = new AttachmentsDB();
    let access;
    try {
      access = resolveShareAccess(db, token, { password, consume: false, requirePassword: true });
      if (password) clearPasswordFailures(c, token);
    } catch (err) {
      if (err instanceof ShareAccessError) {
        if (err.status === 401) recordPasswordFailure(c, token);
        if (err.status === 401) {
          try {
            const retryAccess = resolveShareAccess(db, token, { consume: false });
            return c.html(renderDownloadPage({
              token,
              filename: retryAccess.attachment.filename,
              size: retryAccess.attachment.size,
              expiresAt: retryAccess.shareLink.expiresAt ?? retryAccess.attachment.expiresAt,
              requiresPassword: true,
              maxUses: retryAccess.shareLink.maxUses,
              usedCount: retryAccess.shareLink.usedCount,
              error: "Enter the correct password to download this attachment.",
            }), 401);
          } catch {
            return c.html(renderShareAccessError(token, err), err.status);
          }
        }
        return c.html(renderShareAccessError(token, err), err.status);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    } finally {
      db.close();
    }

    try {
      const result = await openAttachmentStream(access.attachment, {
        rangeHeader: c.req.header("range"),
        password,
      });
      const consumeDb = new AttachmentsDB();
      try {
        const consumed = consumeDb.consumeShareLink(access.shareLink.id);
        if (!consumed) {
          return c.html(renderShareAccessError(
            token,
            new ShareAccessError("Share link is no longer available", 410)
          ), 410);
        }
      } finally {
        consumeDb.close();
      }
      const body = trackShareDownloadCompletion(result.body, access.shareLink.id, access.attachment.id);
      c.header("Content-Disposition", contentDispositionAttachment(access.attachment.filename));
      c.header("Accept-Ranges", access.attachment.encryptionAlgorithm ? "none" : "bytes");
      c.header("Content-Type", result.contentType ?? access.attachment.contentType);
      if (result.contentLength !== undefined) c.header("Content-Length", String(result.contentLength));
      if (result.contentRange) c.header("Content-Range", result.contentRange);
      return c.body(toWebBody(body) as never, result.status);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  }

  const sharePageHeadHandler = (c: Context) => {
    const token = c.req.param("token")!;
    const db = new AttachmentsDB();
    try {
      const access = resolveShareAccess(db, token, { consume: false });
      c.header("Content-Type", "text/html; charset=UTF-8");
      c.header("Content-Length", "0");
      c.header("X-Attachment-Filename", access.attachment.filename);
      return c.body(null, 200);
    } catch (err) {
      if (err instanceof ShareAccessError) return c.body(null, err.status);
      return c.body(null, 500);
    } finally {
      db.close();
    }
  };

  const shareDownloadHeadHandler = (c: Context) => {
    const token = c.req.param("token")!;
    const db = new AttachmentsDB();
    try {
      const access = resolveShareAccess(db, token, { consume: false });
      c.header("Content-Disposition", contentDispositionAttachment(access.attachment.filename));
      c.header("Accept-Ranges", access.attachment.encryptionAlgorithm ? "none" : "bytes");
      c.header("Content-Type", access.attachment.contentType);
      c.header("Content-Length", String(access.attachment.size));
      return c.body(null, 200);
    } catch (err) {
      if (err instanceof ShareAccessError) return c.body(null, err.status);
      return c.body(null, 500);
    } finally {
      db.close();
    }
  };

  const shareDownloadGetHandler = async (c: Context) => {
    const token = c.req.param("token")!;
    const db = new AttachmentsDB();
    try {
      const access = resolveShareAccess(db, token, { consume: false });
      if (c.req.raw.method.toUpperCase() === "HEAD") {
        c.header("Content-Disposition", contentDispositionAttachment(access.attachment.filename));
        c.header("Accept-Ranges", access.attachment.encryptionAlgorithm ? "none" : "bytes");
        c.header("Content-Type", access.attachment.contentType);
        c.header("Content-Length", String(access.attachment.size));
        return c.body(null, 200);
      }
      if (access.shareLink.maxUses !== null && !isConfirmedDownloadRequest(c)) {
        return c.redirect(sharePagePath(token), 303);
      }
    } catch (err) {
      if (err instanceof ShareAccessError) return c.html(renderShareAccessError(token, err), err.status);
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    } finally {
      db.close();
    }
    return serveShareDownload(c);
  };

  const shareDownloadPostHandler = async (c: Context) => {
    let password: string | undefined;
    try {
      const body = await c.req.parseBody();
      password = typeof body["password"] === "string" ? body["password"] : undefined;
    } catch {
      password = undefined;
    }
    return serveShareDownload(c, password);
  };

  for (const prefix of publicRoutePrefixes) {
    app.get(`${prefix}/:token`, sharePageHandler);
    app.on("HEAD", `${prefix}/:token`, sharePageHeadHandler);
    app.on("HEAD", `${prefix}/:token/download`, shareDownloadHeadHandler);
    app.get(`${prefix}/:token/download`, shareDownloadGetHandler);
    app.post(`${prefix}/:token/download`, shareDownloadPostHandler);
  }

  // GET /d/:id — legacy public route for old server links.
  app.get("/d/:id", async (c) => {
    const id = c.req.param("id");
    const db = new AttachmentsDB();
    let attachment;
    try {
      attachment = db.findById(id);
      if (!attachment) {
        return c.json({ error: "Not found" }, 404);
      }
      if (isExpired(attachment)) {
        return c.json({ error: "Attachment has expired" }, 410);
      }
      const latestShare = db.findShareLinksByAttachmentId(id)[0];
      if (latestShare) {
        return c.redirect(attachment.link ?? `/api/attachments/${id}/download`, 302);
      }
    } finally {
      db.close();
    }

    try {
      const result = await openAttachmentStream(attachment, { rangeHeader: c.req.header("range") });
      c.header("Content-Disposition", contentDispositionAttachment(attachment.filename));
      c.header("Accept-Ranges", attachment.encryptionAlgorithm ? "none" : "bytes");
      c.header("Content-Type", result.contentType ?? attachment.contentType);
      if (result.contentLength !== undefined) c.header("Content-Length", String(result.contentLength));
      if (result.contentRange) c.header("Content-Range", result.contentRange);
      return c.body(toWebBody(result.body) as never, result.status);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}

const activeServers: unknown[] = [];

export function startServer(port: number, hostname = "localhost"): void {
  const app = createApp();
  const config = getConfig();
  const resolvedPort = port ?? config.server.port;
  const resolvedHostname = hostname ?? config.server.host;

  // Use Bun.serve if available, otherwise @hono/node-server
  if (typeof Bun !== "undefined") {
    const server = Bun.serve({
      port: resolvedPort,
      hostname: resolvedHostname,
      fetch: app.fetch,
    });
    activeServers.push(server);
    console.log(`Attachments server running on http://${resolvedHostname}:${resolvedPort}`);
  } else {
    // Fallback for Node.js environments
    import("@hono/node-server").then(({ serve }) => {
      const server = serve({ fetch: app.fetch, port: resolvedPort, hostname: resolvedHostname });
      activeServers.push(server);
      console.log(`Attachments server running on http://${resolvedHostname}:${resolvedPort}`);
    });
  }
}
