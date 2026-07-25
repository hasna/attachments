import { AttachmentsDB, type Attachment, type ShareLink } from "./db";
import { verifyPasswordHash } from "./security";

export class ShareAccessError extends Error {
  constructor(message: string, public status: 401 | 404 | 410) {
    super(message);
    this.name = "ShareAccessError";
  }
}

export interface ShareAccessResult {
  attachment: Attachment;
  shareLink: ShareLink;
}

export interface ShareAccessOptions {
  password?: string;
  consume?: boolean;
  requirePassword?: boolean;
  /** Injectable clock (ms) — keeps the policy pure and testable. */
  now?: number;
}

/**
 * Store-agnostic access policy for a share link.
 *
 * This is the SINGLE definition of "may this token be used right now?". Both
 * the on-box SQLite server (`src/api/routes/public.ts`) and the cloud Postgres
 * service (`src/serve/public-routes.ts`) consume it, so the two deployments can
 * never drift apart on revocation, expiry, use counts or password checks.
 *
 * Throws {@link ShareAccessError}; returns the link when access is allowed.
 */
export function assertShareLinkUsable(
  shareLink: ShareLink | null | undefined,
  opts: ShareAccessOptions = {}
): ShareLink {
  const now = opts.now ?? Date.now();
  if (!shareLink) {
    throw new ShareAccessError("Share link not found", 404);
  }
  if (shareLink.revokedAt !== null) {
    throw new ShareAccessError("Share link has been revoked", 410);
  }
  if (shareLink.expiresAt !== null && shareLink.expiresAt <= now) {
    throw new ShareAccessError("Share link has expired", 410);
  }
  if (shareLink.maxUses !== null && shareLink.usedCount >= shareLink.maxUses) {
    throw new ShareAccessError("Share link has already been used", 410);
  }
  const shouldVerifyPassword =
    !!shareLink.passwordHash &&
    (opts.consume !== false || opts.requirePassword === true || opts.password !== undefined);
  if (shouldVerifyPassword && !verifyPasswordHash(opts.password ?? "", shareLink.passwordHash)) {
    throw new ShareAccessError("Password required", 401);
  }
  return shareLink;
}

/**
 * Store-agnostic access policy for the attachment behind a usable share link.
 * Throws {@link ShareAccessError}; returns the attachment when access is allowed.
 */
export function assertAttachmentUsable(
  attachment: Attachment | null | undefined,
  opts: { now?: number } = {}
): Attachment {
  const now = opts.now ?? Date.now();
  if (!attachment) {
    throw new ShareAccessError("Attachment not found", 404);
  }
  if (attachment.expiresAt !== null && attachment.expiresAt <= now) {
    throw new ShareAccessError("Attachment has expired", 410);
  }
  if (attachment.status === "pending") {
    throw new ShareAccessError("Attachment upload is not complete", 404);
  }
  return attachment;
}

/**
 * The async side of the same policy, for stores whose reads are promises
 * (`PgAttachmentsStore` in the cloud service). Structurally typed so no store
 * has to implement an interface it does not already satisfy.
 */
export interface AsyncShareAccessSource {
  findShareLinkByToken(token: string): Promise<ShareLink | null>;
  findById(id: string): Promise<Attachment | null>;
  consumeShareLink(id: string): Promise<boolean>;
  incrementDownloads(id: string): Promise<void>;
}

export async function resolveShareAccessAsync(
  source: AsyncShareAccessSource,
  token: string,
  opts: ShareAccessOptions = {}
): Promise<ShareAccessResult> {
  const shareLink = assertShareLinkUsable(await source.findShareLinkByToken(token), opts);
  const attachment = assertAttachmentUsable(await source.findById(shareLink.attachmentId), opts);

  if (opts.consume) {
    const consumed = await source.consumeShareLink(shareLink.id);
    if (!consumed) {
      throw new ShareAccessError("Share link is no longer available", 410);
    }
    await source.incrementDownloads(attachment.id);
  }

  return { attachment, shareLink };
}

export function resolveShareAccess(
  db: AttachmentsDB,
  token: string,
  opts: ShareAccessOptions = {}
): ShareAccessResult {
  const shareLink = assertShareLinkUsable(db.findShareLinkByToken(token), opts);
  const attachment = assertAttachmentUsable(db.findById(shareLink.attachmentId), opts);

  if (opts.consume) {
    const consumed = db.consumeShareLink(shareLink.id);
    if (!consumed) {
      throw new ShareAccessError("Share link is no longer available", 410);
    }
    db.incrementDownloads(attachment.id);
  }

  return { attachment, shareLink };
}
