import type { Hono } from "hono";
import { nanoid } from "nanoid";
import { format } from "date-fns";
import { lookup as mimeLookup } from "mime-types";
import { Readable } from "stream";
import { uploadStreamAttachment } from "../../core/upload";
import { isExpired, openAttachmentStream } from "../../core/download";
import { AttachmentsDB } from "../../core/db";
import {
  getConfig,
  getPublicBaseUrl,
  parseExpiryStrict,
  resolveStorageBackend,
} from "../../core/config";
import { generatePresignedLink, generateShareLink } from "../../core/links";
import { S3Client } from "../../core/s3";
import { contentDispositionAttachment, createObjectKey, sanitizeFilename } from "../../core/security";
import { createObjectStore } from "../../core/object-storage";
import {
  DIRECT_MULTIPART_PART_SIZE,
  FORM_UPLOAD_SOFT_LIMIT,
  firstNonEmpty,
  maxUploadBytes,
  requestUploadOptions,
} from "../request";
import { toWebBody } from "../streams";

function serializeAttachment(attachment: {
  id: string;
  filename: string;
  size: number;
  contentType?: string;
  link: string | null;
  tag?: string | null;
  expiresAt: number | null;
  createdAt: number;
}) {
  return {
    id: attachment.id,
    filename: attachment.filename,
    size: attachment.size,
    content_type: attachment.contentType,
    link: attachment.link,
    tag: attachment.tag,
    expires_at: attachment.expiresAt,
    created_at: attachment.createdAt,
  };
}

export function registerAttachmentRoutes(app: Hono): void {
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
      const allowedEmails =
        typeof body["allowed_emails"] === "string" && body["allowed_emails"].trim()
          ? body["allowed_emails"].split(",").map((e) => e.trim()).filter(Boolean)
          : null;
      const requireEmail =
        body["require_email"] === "true" || body["require_email"] === "1" || (allowedEmails !== null && allowedEmails.length > 0);

      const fileObj = file as File;
      const filename = sanitizeFilename(fileObj.name || `upload_${nanoid(8)}`);
      const contentType = fileObj.type || (mimeLookup(filename) || "application/octet-stream");
      const attachment = await uploadStreamAttachment(
        Readable.fromWeb(fileObj.stream() as never),
        filename,
        typeof contentType === "string" ? contentType : "application/octet-stream",
        { expiry, tag, password, encrypt, maxDownloads, linkType, requireEmail, allowedEmails, size: fileSize }
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

    const items = attachments.map(serializeAttachment);

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

    return c.json(serializeAttachment(attachment));
  });

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
      // Object delete failure is non-fatal for DB cleanup.
    }

    const db2 = new AttachmentsDB();
    try {
      db2.delete(id);
    } finally {
      db2.close();
    }

    return c.text(`deleted: ${id}`);
  });

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
      // Body is optional.
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

      const contentType =
        body.content_type ?? (mimeLookup(filename) || "application/octet-stream");

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
      const id = `att_${nanoid(11)}`;
      const datePrefix = format(new Date(), "yyyy-MM-dd");
      const s3Key = `attachments/${datePrefix}/${id}/${filename}`;
      const s3 = new S3Client(config.s3);
      const uploadUrl = await s3.presignPut(s3Key, contentType, expirySeconds);

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
}
