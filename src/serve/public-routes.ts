/**
 * Public share-link routes (`/a/:token`) for the CLOUD service.
 *
 * D3 root cause: `createServeApp` only ever exposed `/health`, `/ready`,
 * `/version` and `/v1/*`, yet it hands out `<public base>/a/<token>` links —
 * including every password-protected link, because passwords force a
 * server-hosted link. Those links 404'd because the route did not exist in this
 * service at all.
 *
 * These handlers mirror the on-box routes in `src/api/routes/public.ts` but run
 * against the injected Postgres store. The access policy, the rendered pages and
 * the password throttle are all shared modules — this file only wires them to
 * the async store, it does not restate any rule.
 *
 * Not supported here: email-gated links (`require_email`). The cloud API refuses
 * to create them, so a link that carries the flag can only come from an on-box
 * database; we fail closed with an explicit page instead of serving bytes.
 */

import type { Context, Hono } from "hono";
import type { Attachment } from "../core/db.js";
import type { AttachmentsConfig } from "../core/config.js";
import { normalizePublicPath } from "../core/config.js";
import { openAttachmentStream } from "../core/download.js";
import { contentDispositionAttachment } from "../core/security.js";
import {
  ShareAccessError,
  resolveShareAccessAsync,
  type AsyncShareAccessSource,
  type ShareAccessResult,
} from "../core/share.js";
import {
  PasswordThrottle,
  clientIdentity,
  parseTrustedProxies,
  passwordFailureKey,
} from "../core/password-throttle.js";
import {
  renderDownloadPage,
  renderPublicErrorPage,
  renderShareAccessError,
  sharePagePath,
} from "../api/public-pages.js";
import { toWebBody } from "../api/streams.js";

export interface CloudPublicRoutesDeps {
  store: AsyncShareAccessSource;
  config: AttachmentsConfig;
  /**
   * Trust `x-forwarded-for` & friends when identifying a caller for throttling.
   * The cloud service always sits behind an ALB (and usually a Caddy in front of
   * that), so it defaults to on; set ATTACHMENTS_TRUST_PROXY=0 to disable.
   */
  trustProxy?: boolean;
  /**
   * Addresses of proxies we operate in front of this service (the Caddy that
   * fronts the public attachment domain). Hops matching these are stepped over
   * when identifying a caller, so a shared edge does not bucket every visitor
   * together. Defaults to ATTACHMENTS_TRUSTED_PROXIES (comma separated).
   */
  trustedProxies?: readonly string[];
  throttle?: PasswordThrottle;
}

function resolveTrustProxy(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  return process.env["ATTACHMENTS_TRUST_PROXY"] !== "0";
}

function directAddress(c: Context): string | null {
  const server = (c.env as { server?: { requestIP?: (req: Request) => { address?: string } | null } } | undefined)
    ?.server;
  try {
    return server?.requestIP?.(c.req.raw)?.address ?? null;
  } catch {
    return null;
  }
}

function isConfirmedDownloadRequest(c: Context): boolean {
  return c.req.header("x-attachments-download") === "1" || c.req.query("download") === "1";
}

const EMAIL_GATE_UNSUPPORTED = "Email-gated links are not available on this deployment";

export function registerCloudPublicRoutes(app: Hono, deps: CloudPublicRoutesDeps): void {
  const { store, config } = deps;
  const publicPath = normalizePublicPath(config.server.publicPath);
  const trustProxy = resolveTrustProxy(deps.trustProxy);
  const trustedProxies =
    deps.trustedProxies ?? parseTrustedProxies(process.env["ATTACHMENTS_TRUSTED_PROXIES"]);
  const throttle = deps.throttle ?? new PasswordThrottle();

  const identity = (c: Context, token: string) =>
    passwordFailureKey(
      token,
      clientIdentity(c.req, { trustProxy, trustedProxies, directAddress: directAddress(c) })
    );

  const errorPage = (c: Context, token: string, err: ShareAccessError) =>
    c.html(renderShareAccessError(token, err, publicPath), err.status);

  const downloadPage = (
    c: Context,
    token: string,
    access: ShareAccessResult,
    extra: { error?: string; status?: 200 | 401 } = {}
  ) =>
    c.html(
      renderDownloadPage({
        token,
        filename: access.attachment.filename,
        size: access.attachment.size,
        expiresAt: access.shareLink.expiresAt ?? access.attachment.expiresAt,
        requiresPassword: !!access.shareLink.passwordHash,
        maxUses: access.shareLink.maxUses,
        usedCount: access.shareLink.usedCount,
        publicPath,
        ...(extra.error ? { error: extra.error } : {}),
      }),
      extra.status ?? 200
    );

  const emailGatePage = (c: Context) =>
    c.html(
      renderPublicErrorPage({
        title: "Attachment unavailable",
        message: EMAIL_GATE_UNSUPPORTED,
        detail: "Ask the sender for a password-protected or plain link instead.",
        status: 501,
      }),
      501
    );

  // Unauthenticated surface: log the detail, never render it back to the visitor.
  function fatal(c: Context, err: unknown) {
    console.error("[public]", c.req.method, c.req.path, err instanceof Error ? err.stack : String(err));
    return c.html(
      renderPublicErrorPage({
        title: "Attachment unavailable",
        message: "Something went wrong while opening this attachment.",
        detail: "Try again in a moment, or ask the sender for a fresh link.",
        status: 500,
      }),
      500
    );
  }

  function setDownloadHeaders(c: Context, attachment: Attachment, contentType?: string) {
    c.header("Content-Disposition", contentDispositionAttachment(attachment.filename));
    c.header("Accept-Ranges", attachment.encryptionAlgorithm ? "none" : "bytes");
    c.header("Content-Type", contentType ?? attachment.contentType);
  }

  // Attachment landing page — never returns bytes, only metadata plus the form.
  app.get(`${publicPath}/:token`, async (c) => {
    const token = c.req.param("token")!;
    try {
      const access = await resolveShareAccessAsync(store, token, { consume: false });
      if (isHead(c)) {
        c.header("Content-Type", "text/html; charset=UTF-8");
        c.header("Content-Length", "0");
        c.header("X-Attachment-Filename", access.attachment.filename);
        return c.body(null, 200);
      }
      if (access.shareLink.requireEmail) return emailGatePage(c);
      return downloadPage(c, token, access);
    } catch (err) {
      if (err instanceof ShareAccessError) {
        return isHead(c) ? c.body(null, err.status) : errorPage(c, token, err);
      }
      return isHead(c) ? c.body(null, 500) : fatal(c, err);
    }
  });

  // Hono dispatches HEAD to the GET handler, so HEAD is handled inside the GET
  // handlers rather than through a separate registration.
  const isHead = (c: Context) => c.req.raw.method.toUpperCase() === "HEAD";

  async function serveDownload(c: Context, password?: string) {
    const token = c.req.param("token")!;
    const key = identity(c, token);
    if (throttle.isLimited(key)) {
      return c.html(
        renderPublicErrorPage({
          title: "Too many password attempts",
          message:
            "This attachment is temporarily locked because the password was entered incorrectly too many times.",
          detail: "Try again later or ask the sender to create a fresh link.",
          status: 429,
          actionHref: sharePagePath(token, publicPath),
          actionLabel: "Back to Attachment",
        }),
        429
      );
    }

    let access: ShareAccessResult;
    try {
      access = await resolveShareAccessAsync(store, token, {
        password,
        consume: false,
        requirePassword: true,
      });
      if (password) throttle.clear(key);
    } catch (err) {
      if (!(err instanceof ShareAccessError)) return fatal(c, err);
      if (err.status !== 401) return errorPage(c, token, err);
      // Only a submitted-and-wrong password counts. A bare GET (link preview,
      // prefetch, someone opening the page) must not be able to lock the link.
      if (password !== undefined) throttle.recordFailure(key);
      try {
        const retry = await resolveShareAccessAsync(store, token, { consume: false });
        return downloadPage(c, token, retry, {
          status: 401,
          error: "Enter the correct password to download this attachment.",
        });
      } catch {
        return errorPage(c, token, err);
      }
    }

    if (access.shareLink.requireEmail) return emailGatePage(c);

    try {
      const result = await openAttachmentStream(access.attachment, {
        config,
        rangeHeader: c.req.header("range"),
        password,
      });
      const consumed = await store.consumeShareLink(access.shareLink.id);
      if (!consumed) {
        return errorPage(
          c,
          token,
          new ShareAccessError("Share link is no longer available", 410)
        );
      }
      await store.incrementDownloads(access.attachment.id);
      setDownloadHeaders(c, access.attachment, result.contentType);
      if (result.contentLength !== undefined) c.header("Content-Length", String(result.contentLength));
      if (result.contentRange) c.header("Content-Range", result.contentRange);
      return c.body(toWebBody(result.body) as never, result.status);
    } catch (err) {
      return fatal(c, err);
    }
  }

  app.get(`${publicPath}/:token/download`, async (c) => {
    const token = c.req.param("token")!;
    try {
      const access = await resolveShareAccessAsync(store, token, { consume: false });
      if (isHead(c)) {
        // Metadata probe: report what a download would deliver without
        // consuming a use or requiring the password.
        setDownloadHeaders(c, access.attachment);
        c.header("Content-Length", String(access.attachment.size));
        return c.body(null, 200);
      }
      if (access.shareLink.requireEmail) return emailGatePage(c);
      // A limited-use link must not be burned by a link preview / prefetch.
      if (access.shareLink.maxUses !== null && !isConfirmedDownloadRequest(c)) {
        return c.redirect(sharePagePath(token, publicPath), 303);
      }
    } catch (err) {
      if (err instanceof ShareAccessError) {
        if (isHead(c)) return c.body(null, err.status);
        // 401 means the link is password protected: fall through so the shared
        // handler renders the form instead of a bare error page.
        if (err.status !== 401) return errorPage(c, token, err);
      } else {
        return isHead(c) ? c.body(null, 500) : fatal(c, err);
      }
    }
    return serveDownload(c);
  });

  app.post(`${publicPath}/:token/download`, async (c) => {
    let password: string | undefined;
    try {
      const body = await c.req.parseBody();
      password = typeof body["password"] === "string" ? body["password"] : undefined;
    } catch {
      password = undefined;
    }
    return serveDownload(c, password);
  });
}
