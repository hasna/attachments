import { writeFileSync, mkdirSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import { S3Client } from "./s3";
import { AttachmentsDB, type Attachment } from "./db";
import { getConfig } from "./config";

export interface DownloadResult {
  path: string;
  filename: string;
  size: number;
}

/**
 * Extract attachment ID from a /d/:id URL or return as-is if already an ID.
 * Handles:
 *   - "att_abc123"                          → "att_abc123"
 *   - "/d/att_abc123"                       → "att_abc123"
 *   - "http://localhost:3459/d/att_abc123"  → "att_abc123"
 *   - "https://example.com/d/att_abc123"   → "att_abc123"
 */
export function extractId(idOrUrl: string): string {
  const match = /\/d\/([^/?#]+)/.exec(idOrUrl);
  if (match) {
    return match[1]!;
  }
  return idOrUrl;
}

/**
 * Returns true if the attachment has an expiresAt timestamp that is in the past.
 * Returns false if expiresAt is null (never expires) or is in the future.
 */
export function isExpired(attachment: Attachment): boolean {
  if (attachment.expiresAt === null) return false;
  return attachment.expiresAt <= Date.now();
}

/**
 * Download an attachment from S3 to local disk.
 *
 * @param idOrUrl  - Attachment ID or a /d/:id URL
 * @param destPath - Destination directory or full file path (defaults to process.cwd())
 * @returns        - { path, filename, size }
 */
export interface DownloadDeps {
  db?: InstanceType<typeof AttachmentsDB>;
  s3?: InstanceType<typeof S3Client>;
}

export async function downloadAttachment(
  idOrUrl: string,
  destPath?: string,
  _deps: DownloadDeps = {}
): Promise<DownloadResult> {
  const id = extractId(idOrUrl);

  const db = _deps.db ?? new AttachmentsDB();
  const attachment = db.findById(id);
  if (!_deps.db) db.close();

  if (!attachment) {
    throw new Error("Attachment not found");
  }

  if (isExpired(attachment)) {
    throw new Error("Attachment has expired");
  }

  const config = getConfig();
  const s3 = _deps.s3 ?? new S3Client(config.s3);
  const buffer = await s3.download(attachment.s3Key);

  // Determine the final file path
  const dest = destPath ?? process.cwd();
  let finalPath: string;

  try {
    const stat = statSync(dest);
    if (stat.isDirectory()) {
      finalPath = join(dest, attachment.filename);
    } else {
      // dest is an existing file — overwrite it
      finalPath = dest;
    }
  } catch {
    // dest does not exist yet; treat as a full file path if it looks like a path
    // ending with a separator → directory; otherwise assume full file path
    if (dest.endsWith("/") || dest.endsWith("\\")) {
      mkdirSync(dest, { recursive: true });
      finalPath = join(dest, attachment.filename);
    } else {
      // Assume it's a full target path; ensure its parent directory exists
      const dir = dirname(dest);
      mkdirSync(dir, { recursive: true });
      finalPath = dest;
    }
  }

  writeFileSync(finalPath, buffer);

  return {
    path: finalPath,
    filename: basename(finalPath),
    size: buffer.length,
  };
}

/**
 * Fetch an attachment from S3 and return its raw buffer together with the
 * attachment metadata — useful for REST API proxying without writing to disk.
 */
export async function streamAttachment(
  id: string,
  _deps: DownloadDeps = {}
): Promise<{ buffer: Buffer; attachment: Attachment }> {
  const db = _deps.db ?? new AttachmentsDB();
  const attachment = db.findById(id);
  if (!_deps.db) db.close();

  if (!attachment) {
    throw new Error("Attachment not found");
  }

  if (isExpired(attachment)) {
    throw new Error("Attachment has expired");
  }

  const config = getConfig();
  const s3 = _deps.s3 ?? new S3Client(config.s3);
  const buffer = await s3.download(attachment.s3Key);

  return { buffer, attachment };
}
