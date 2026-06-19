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

export function resolveShareAccess(
  db: AttachmentsDB,
  token: string,
  opts: { password?: string; consume?: boolean; requirePassword?: boolean } = {}
): ShareAccessResult {
  const shareLink = db.findShareLinkByToken(token);
  if (!shareLink) {
    throw new ShareAccessError("Share link not found", 404);
  }
  if (shareLink.revokedAt !== null) {
    throw new ShareAccessError("Share link has been revoked", 410);
  }
  if (shareLink.expiresAt !== null && shareLink.expiresAt <= Date.now()) {
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

  const attachment = db.findById(shareLink.attachmentId);
  if (!attachment) {
    throw new ShareAccessError("Attachment not found", 404);
  }
  if (attachment.expiresAt !== null && attachment.expiresAt <= Date.now()) {
    throw new ShareAccessError("Attachment has expired", 410);
  }
  if (attachment.status === "pending") {
    throw new ShareAccessError("Attachment upload is not complete", 404);
  }

  if (opts.consume) {
    const consumed = db.consumeShareLink(shareLink.id);
    if (!consumed) {
      throw new ShareAccessError("Share link is no longer available", 410);
    }
    db.incrementDownloads(attachment.id);
  }

  return { attachment, shareLink };
}
