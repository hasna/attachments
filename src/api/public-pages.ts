import { getConfig } from "../core/config";
import { ShareAccessError } from "../core/share";

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Resolve the public route prefix. Callers that own their config (the cloud
 * `attachments-serve` service) MUST pass it explicitly — the service runs with
 * an env-built config and must never fall back to reading the operator's
 * on-disk `config.json`.
 */
function resolvePublicPath(publicPath?: string): string {
  const raw = publicPath ?? getConfig().server.publicPath;
  return raw.replace(/\/+$/, "") || "/a";
}

export function sharePagePath(token: string, publicPath?: string): string {
  return `${resolvePublicPath(publicPath)}/${encodeURIComponent(token)}`;
}

export function renderDownloadPage(input: {
  token: string;
  filename: string;
  size: number;
  expiresAt: number | null;
  requiresPassword: boolean;
  requiresEmail?: boolean;
  grantToken?: string;
  notice?: string;
  maxUses?: number | null;
  usedCount?: number;
  error?: string;
  /** Route prefix for the form actions; defaults to the on-disk config. */
  publicPath?: string;
}): string {
  const publicPath = resolvePublicPath(input.publicPath);
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
    .notice { margin: 0 0 14px; color: #1e6f5c; font-weight: 650; }
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
    ${input.notice ? `<p class="notice">${htmlEscape(input.notice)}</p>` : ""}
    <dl>
      <dt>Size</dt><dd>${input.size.toLocaleString()} bytes</dd>
      <dt>Expires</dt><dd>${htmlEscape(expiry)}</dd>
      ${downloadsRow}
    </dl>
    ${
      input.requiresEmail && !input.grantToken
        ? `<form method="post" action="${htmlEscape(publicPath)}/${encodeURIComponent(input.token)}/request-access">
      <label for="email">Enter your email to receive an access link</label>
      <input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required>
      <button type="submit">Email me an access link</button>
    </form>`
        : `<form method="post" action="${htmlEscape(publicPath)}/${encodeURIComponent(input.token)}/download">
      ${input.requiresPassword ? `<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>` : ""}
      ${input.grantToken ? `<input type="hidden" name="grant" value="${htmlEscape(input.grantToken)}">` : ""}
      <button type="submit">Download</button>
    </form>`
    }
  </main>
</body>
</html>`;
}

export function renderPublicErrorPage(input: {
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

export function renderShareAccessError(
  token: string,
  err: ShareAccessError,
  publicPath?: string
): string {
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
      actionHref: sharePagePath(token, publicPath),
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
