import type { Context, Hono } from "hono";
import { isExpired, openAttachmentStream } from "../../core/download";
import { AttachmentsDB } from "../../core/db";
import { getConfig, getPublicBaseUrl } from "../../core/config";
import { contentDispositionAttachment } from "../../core/security";
import { ShareAccessError, resolveShareAccess } from "../../core/share";
import {
  EmailGateError,
  requestAccessGrant,
  verifyAccessGrant,
} from "../../core/email-gate";
import { resolveEmailSender } from "../../core/email-sender";
import {
  renderDownloadPage,
  renderPublicErrorPage,
  renderShareAccessError,
  sharePagePath,
} from "../public-pages";
import { toWebBody, trackShareDownloadCompletion } from "../streams";
import {
  PasswordThrottle,
  clientIdentity,
  parseTrustedProxies,
  passwordFailureKey,
} from "../../core/password-throttle";

const passwordThrottle = new PasswordThrottle();

function directAddress(c: Context): string | null {
  const server = (c.env as { server?: { requestIP?: (req: Request) => { address?: string } | null } } | undefined)
    ?.server;
  try {
    return server?.requestIP?.(c.req.raw)?.address ?? null;
  } catch {
    return null;
  }
}

function throttleKey(c: Context, token: string): string {
  const trustProxy = process.env["ATTACHMENTS_TRUST_PROXY"] === "1";
  const trustedProxies = parseTrustedProxies(process.env["ATTACHMENTS_TRUSTED_PROXIES"]);
  return passwordFailureKey(
    token,
    clientIdentity(c.req, { trustProxy, trustedProxies, directAddress: directAddress(c) })
  );
}

function isPasswordLimited(c: Context, token: string): boolean {
  return passwordThrottle.isLimited(throttleKey(c, token));
}

function recordPasswordFailure(c: Context, token: string): void {
  passwordThrottle.recordFailure(throttleKey(c, token));
}

function clearPasswordFailures(c: Context, token: string): void {
  passwordThrottle.clear(throttleKey(c, token));
}

function isConfirmedDownloadRequest(c: Context): boolean {
  return c.req.header("x-attachments-download") === "1" || c.req.query("download") === "1";
}

const sharePageHandler = (c: Context) => {
  const token = c.req.param("token")!;
  const db = new AttachmentsDB();
  try {
    const access = resolveShareAccess(db, token, { consume: false });
    let validGrant: string | undefined;
    if (access.shareLink.requireEmail) {
      const grantToken = c.req.query("grant");
      if (grantToken) {
        try {
          verifyAccessGrant(db, token, grantToken);
          validGrant = grantToken;
        } catch {
          validGrant = undefined;
        }
      }
    }
    return c.html(renderDownloadPage({
      token,
      filename: access.attachment.filename,
      size: access.attachment.size,
      expiresAt: access.shareLink.expiresAt ?? access.attachment.expiresAt,
      requiresPassword: !!access.shareLink.passwordHash,
      requiresEmail: access.shareLink.requireEmail,
      grantToken: validGrant,
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

const requestAccessHandler = async (c: Context) => {
  const token = c.req.param("token")!;
  let email = "";
  try {
    const body = await c.req.parseBody();
    email = typeof body["email"] === "string" ? body["email"] : "";
  } catch {
    email = "";
  }
  const sender = resolveEmailSender();
  const db = new AttachmentsDB();
  try {
    if (!sender) {
      return c.html(renderPublicErrorPage({
        title: "Email access unavailable",
        message: "This link requires email access, but the server is not configured to send email.",
        detail: "Ask the sender to share the file another way.",
        status: 503,
        actionHref: sharePagePath(token),
        actionLabel: "Back to Attachment",
      }), 503);
    }
    const access = resolveShareAccess(db, token, { consume: false });
    await requestAccessGrant({
      db,
      token,
      email,
      sender,
      filename: access.attachment.filename,
      buildAccessUrl: (grant) =>
        `${getPublicBaseUrl(getConfig())}${sharePagePath(token)}?grant=${encodeURIComponent(grant)}`,
    });
    return c.html(renderDownloadPage({
      token,
      filename: access.attachment.filename,
      size: access.attachment.size,
      expiresAt: access.shareLink.expiresAt ?? access.attachment.expiresAt,
      requiresPassword: !!access.shareLink.passwordHash,
      requiresEmail: true,
      notice: "Check your inbox — we emailed you an access link.",
    }));
  } catch (err) {
    if (err instanceof EmailGateError || err instanceof ShareAccessError) {
      try {
        const access = resolveShareAccess(db, token, { consume: false });
        return c.html(renderDownloadPage({
          token,
          filename: access.attachment.filename,
          size: access.attachment.size,
          expiresAt: access.shareLink.expiresAt ?? access.attachment.expiresAt,
          requiresPassword: !!access.shareLink.passwordHash,
          requiresEmail: true,
          error: err.message,
        }), err.status);
      } catch {
        return c.html(renderShareAccessError(token, err as ShareAccessError), (err as ShareAccessError).status ?? 400);
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  } finally {
    db.close();
  }
};

async function serveShareDownload(c: Context, password?: string, grantToken?: string) {
  const token = c.req.param("token")!;
  {
    const gateDb = new AttachmentsDB();
    try {
      const link = gateDb.findShareLinkByToken(token);
      if (link?.requireEmail) {
        if (!grantToken) {
          return c.redirect(sharePagePath(token), 303);
        }
        try {
          verifyAccessGrant(gateDb, token, grantToken);
        } catch (err) {
          const status = err instanceof EmailGateError ? err.status : 401;
          return c.html(renderShareAccessError(token, new ShareAccessError("Invalid or expired access link", status as 401 | 404 | 410)), status);
        }
      }
    } finally {
      gateDb.close();
    }
  }
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
      // Only a submitted-and-wrong password counts toward the lockout; a bare
      // GET must not be able to lock the link for everyone.
      if (err.status === 401 && password !== undefined) recordPasswordFailure(c, token);
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
  return serveShareDownload(c, undefined, c.req.query("grant"));
};

const shareDownloadPostHandler = async (c: Context) => {
  let password: string | undefined;
  let grantToken: string | undefined;
  try {
    const body = await c.req.parseBody();
    password = typeof body["password"] === "string" ? body["password"] : undefined;
    grantToken = typeof body["grant"] === "string" ? body["grant"] : undefined;
  } catch {
    password = undefined;
  }
  return serveShareDownload(c, password, grantToken ?? c.req.query("grant"));
};

export function registerPublicRoutes(app: Hono): void {
  const publicRoutePrefixes = Array.from(new Set([
    "/a",
    getConfig().server.publicPath.replace(/\/+$/, "") || "/a",
  ]));

  for (const prefix of publicRoutePrefixes) {
    app.get(`${prefix}/:token`, sharePageHandler);
    app.on("HEAD", `${prefix}/:token`, sharePageHeadHandler);
    app.on("HEAD", `${prefix}/:token/download`, shareDownloadHeadHandler);
    app.get(`${prefix}/:token/download`, shareDownloadGetHandler);
    app.post(`${prefix}/:token/download`, shareDownloadPostHandler);
    app.post(`${prefix}/:token/request-access`, requestAccessHandler);
  }

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
}
