import { Hono } from "hono";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { nanoid } from "nanoid";
import { uploadFile } from "../core/upload";
import { streamAttachment } from "../core/download";
import { AttachmentsDB } from "../core/db";
import { getConfig, parseExpiry } from "../core/config";
import { generatePresignedLink, generateServerLink } from "../core/links";
import { S3Client } from "../core/s3";

export function createApp(): Hono {
  const app = new Hono();

  // POST /api/attachments — multipart file upload
  app.post("/api/attachments", async (c) => {
    let tmpPath: string | null = null;
    try {
      const body = await c.req.parseBody();
      const file = body["file"];

      if (!file || typeof file === "string") {
        return c.json({ error: "file field is required" }, 400);
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

  // GET /api/attachments — list attachments
  app.get("/api/attachments", (c) => {
    const limitParam = c.req.query("limit");
    const fieldsParam = c.req.query("fields");
    const format = c.req.query("format");
    const expiredParam = c.req.query("expired");

    const limit = limitParam ? parseInt(limitParam, 10) : 20;
    const includeExpired = expiredParam === "true";

    const db = new AttachmentsDB();
    let attachments;
    try {
      attachments = db.findAll({ limit, includeExpired });
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

export function startServer(port: number): void {
  const app = createApp();
  const config = getConfig();
  const resolvedPort = port ?? config.server.port;

  // Use Bun.serve if available, otherwise @hono/node-server
  if (typeof Bun !== "undefined") {
    Bun.serve({
      port: resolvedPort,
      fetch: app.fetch,
    });
    console.log(`Attachments server running on http://localhost:${resolvedPort}`);
  } else {
    // Fallback for Node.js environments
    import("@hono/node-server").then(({ serve }) => {
      serve({ fetch: app.fetch, port: resolvedPort });
      console.log(`Attachments server running on http://localhost:${resolvedPort}`);
    });
  }
}
