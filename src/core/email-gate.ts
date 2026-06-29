import { AttachmentsDB, type ShareLink } from "./db";
import { isValidEmail, normalizeEmail } from "./security";

/**
 * Pluggable email sender. The package ships a Resend adapter (see resendSender)
 * but any transport (SMTP, SES, a hosted mail service) can implement this.
 */
export interface EmailSender {
  send(input: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}

export class EmailGateError extends Error {
  constructor(
    message: string,
    public status: 400 | 401 | 403 | 404 | 410
  ) {
    super(message);
    this.name = "EmailGateError";
  }
}

export interface RequestAccessInput {
  db: AttachmentsDB;
  /** Plaintext share-link token from the public URL. */
  token: string;
  email: string;
  sender: EmailSender;
  /** Builds the absolute access URL the recipient clicks (receives the grant token). */
  buildAccessUrl: (grantToken: string) => string;
  filename?: string;
  ttlMs?: number;
}

/**
 * Email-gated access: a visitor enters their email, we mint a single-window
 * grant and email them a unique access link. Returns the (normalized) email.
 * Throws EmailGateError for invalid links, bad emails, or disallowed addresses.
 */
export async function requestAccessGrant(input: RequestAccessInput): Promise<{ email: string }> {
  const shareLink = input.db.findShareLinkByToken(input.token);
  if (!shareLink) throw new EmailGateError("Share link not found", 404);
  if (shareLink.revokedAt !== null) throw new EmailGateError("Share link has been revoked", 410);
  if (shareLink.expiresAt !== null && shareLink.expiresAt <= Date.now()) {
    throw new EmailGateError("Share link has expired", 410);
  }
  if (!shareLink.requireEmail) {
    throw new EmailGateError("This link does not require email access", 400);
  }

  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw new EmailGateError("A valid email address is required", 400);
  if (
    shareLink.allowedEmails &&
    !shareLink.allowedEmails.map(normalizeEmail).includes(email)
  ) {
    // Generic message — do not reveal who is on the allowlist.
    throw new EmailGateError("This email is not authorized for this document", 403);
  }

  const { token: grantToken } = input.db.createAccessGrant({
    shareLinkId: shareLink.id,
    email,
    ttlMs: input.ttlMs,
  });
  const url = input.buildAccessUrl(grantToken);
  const fname = input.filename ?? "the requested file";
  await input.sender.send({
    to: email,
    subject: `Your access link for ${fname}`,
    text:
      `You requested access to ${fname}.\n\n` +
      `Open this link to download (valid for a limited time):\n${url}\n\n` +
      `If you did not request this, you can safely ignore this email.`,
    html:
      `<p>You requested access to <strong>${escapeHtml(fname)}</strong>.</p>` +
      `<p><a href="${escapeAttr(url)}">Download the file</a> — valid for a limited time.</p>` +
      `<p style="color:#888;font-size:13px">If you did not request this, you can ignore this email.</p>`,
  });
  return { email };
}

export interface VerifyGrantResult {
  shareLink: ShareLink;
  email: string;
}

/**
 * Validate a grant token against a share link. Used when serving the download
 * after the recipient clicks their emailed link. Throws if missing, mismatched,
 * expired, or revoked.
 */
export function verifyAccessGrant(
  db: AttachmentsDB,
  token: string,
  grantToken: string
): VerifyGrantResult {
  const shareLink = db.findShareLinkByToken(token);
  if (!shareLink) throw new EmailGateError("Share link not found", 404);
  if (shareLink.revokedAt !== null) throw new EmailGateError("Share link has been revoked", 410);
  const grant = db.findAccessGrantByToken(grantToken);
  if (!grant || grant.shareLinkId !== shareLink.id) {
    throw new EmailGateError("Invalid access link", 401);
  }
  if (grant.expiresAt <= Date.now()) {
    throw new EmailGateError("This access link has expired", 410);
  }
  return { shareLink, email: grant.email };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
