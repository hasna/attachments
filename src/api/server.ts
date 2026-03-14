import { Hono } from "hono";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { nanoid } from "nanoid";
import { format } from "date-fns";
import { lookup as mimeLookup } from "mime-types";
import { uploadFile } from "../core/upload";
import { streamAttachment } from "../core/download";
import { AttachmentsDB } from "../core/db";
import { getConfig, parseExpiry } from "../core/config";
import { generatePresignedLink, generateServerLink } from "../core/links";
import { S3Client } from "../core/s3";
import { computeReport } from "../cli/commands/report";

export function createApp(): Hono {
  const app = new Hono();

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
        s3_configured: !!(config?.s3?.bucket && config?.s3?.accessKeyId),
        server: `http://localhost:${config?.server?.port ?? 3459}`,
        timestamp: new Date().toISOString(),
      });
    } finally {
      db.close();
    }
  });

  // POST /api/attachments — multipart file upload
  app.post("/api/attachments", async (c) => {
    // Configurable file size limit (default 5GB, override with ATTACHMENTS_MAX_SIZE env var)
    const maxBytes = parseInt(process.env.ATTACHMENTS_MAX_SIZE ?? String(5 * 1024 * 1024 * 1024), 10);
    const contentLength = parseInt(c.req.header("content-length") ?? "0", 10);
    if (contentLength > maxBytes) {
      return c.json({ error: `File too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)}MB` }, 413);
    }

    let tmpPath: string | null = null;
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

      const expiry = typeof body["expiry"] === "string" ? body["expiry"] : undefined;
      const tag = typeof body["tag"] === "string" ? body["tag"] : undefined;

      // Write the uploaded file to a temp path so uploadFile() can read it
      const fileObj = file as File;
      const arrayBuf = await fileObj.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      const ext = fileObj.name ? fileObj.name.split(".").pop() : "";
      const tmpName = `upload_${nanoid(8)}${ext ? `.${ext}` : ""}`;
      tmpPath = join(tmpdir(), tmpName);
      writeFileSync(tmpPath, buffer);

      // Use the original filename — rename tmpPath to a path with the right filename
      const finalTmpPath = join(tmpdir(), fileObj.name || tmpName);
      writeFileSync(finalTmpPath, buffer);
      if (finalTmpPath !== tmpPath) {
        unlinkSync(tmpPath);
        tmpPath = finalTmpPath;
      }

      const attachment = await uploadFile(tmpPath, { expiry, tag });

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
    } finally {
      if (tmpPath) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // ignore cleanup errors
        }
      }
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
      const s3 = new S3Client(config.s3);
      await s3.delete(attachment.s3Key);
    } catch {
      // S3 delete failure is non-fatal for DB cleanup
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

    // If the link is a presigned S3 URL, redirect
    if (attachment.link && attachment.link.includes("amazonaws.com")) {
      return c.redirect(attachment.link, 302);
    }

    // Otherwise stream the file from S3
    try {
      const { buffer, attachment: att } = await streamAttachment(id);
      c.header("Content-Disposition", `attachment; filename="${att.filename}"`);
      c.header("Content-Type", att.contentType);
      c.header("Content-Length", String(buffer.length));
      return c.body(buffer as unknown as BodyInit);
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

    let body: { expiry?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // body is optional
    }

    const config = getConfig();
    const expiryStr = body.expiry ?? config.defaults.expiry;
    const expiryMs = parseExpiry(expiryStr);
    const newExpiresAt = expiryMs !== null ? Date.now() + expiryMs : null;

    let newLink: string;
    if (config.defaults.linkType === "presigned") {
      const s3 = new S3Client(config.s3);
      newLink = await generatePresignedLink(s3, attachment.s3Key, expiryMs);
    } else {
      newLink = generateServerLink(id, config.server.baseUrl);
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
  app.post("/api/attachments/presign-upload", async (c) => {
    try {
      let body: { filename?: string; expiry?: string; content_type?: string } = {};
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

      // Determine content type
      const contentType =
        body.content_type ?? (mimeLookup(filename) || "application/octet-stream");

      // Parse expiry (default 1h)
      const expiryStr = body.expiry ?? "1h";
      const expiryMs = parseExpiry(expiryStr);
      if (expiryMs === null) {
        return c.json({ error: `Invalid expiry format: ${expiryStr}` }, 400);
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
        });
      } finally {
        db.close();
      }

      return c.json(
        {
          upload_url: uploadUrl,
          id,
          s3_key: s3Key,
          expires_at: expiresAt,
        },
        201
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // GET /d/:id — public shortlink → redirect to download
  app.get("/d/:id", async (c) => {
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

    if (attachment.link && attachment.link.includes("amazonaws.com")) {
      return c.redirect(attachment.link, 302);
    }

    // Regenerate a presigned URL on the fly for server-link type
    try {
      const config = getConfig();
      const s3 = new S3Client(config.s3);
      const presignedUrl = await generatePresignedLink(s3, attachment.s3Key, null);
      return c.redirect(presignedUrl, 302);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}

export function startServer(port: number, hostname = "localhost"): void {
  const app = createApp();
  const config = getConfig();
  const resolvedPort = port ?? config.server.port;

  // Use Bun.serve if available, otherwise @hono/node-server
  if (typeof Bun !== "undefined") {
    Bun.serve({
      port: resolvedPort,
      hostname,
      fetch: app.fetch,
    });
    console.log(`Attachments server running on http://${hostname}:${resolvedPort}`);
  } else {
    // Fallback for Node.js environments
    import("@hono/node-server").then(({ serve }) => {
      serve({ fetch: app.fetch, port: resolvedPort, hostname });
      console.log(`Attachments server running on http://${hostname}:${resolvedPort}`);
    });
  }
}
