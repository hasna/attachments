import { createWriteStream, writeFileSync, mkdirSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import { createDecipheriv, scryptSync } from "crypto";
import type { DecipherGCM } from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { S3Client } from "./s3";
import { AttachmentsDB, type Attachment } from "./db";
import { getConfig } from "./config";
import {
  LocalObjectStore,
  createObjectStore,
  parseRangeHeader,
  type ObjectStreamResult,
} from "./object-storage";
import { resolveShareAccess } from "./share";

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
  objectStore?: InstanceType<typeof S3Client> | InstanceType<typeof LocalObjectStore>;
  config?: ReturnType<typeof getConfig>;
}

export interface DownloadOptions {
  password?: string;
}

export function extractShareToken(idOrUrl: string): string | null {
  const match = /\/a\/([^/?#]+)/.exec(idOrUrl);
  return match ? match[1]! : null;
}

function toNodeReadable(body: Readable | ReadableStream<Uint8Array>): Readable {
  if (typeof (body as Readable).pipe === "function") return body as Readable;
  return Readable.fromWeb(body as never);
}

function decryptIfNeeded(
  attachment: Attachment,
  stream: Readable,
  password?: string
): Readable {
  if (!attachment.encryptionAlgorithm) return stream;
  if (attachment.encryptionAlgorithm !== "aes-256-gcm" && attachment.encryptionAlgorithm !== "aes-256-ctr") {
    throw new Error(`Unsupported encryption algorithm: ${attachment.encryptionAlgorithm}`);
  }
  if (!password) {
    throw new Error("Attachment is encrypted and requires a password");
  }
  if (!attachment.encryptionSalt || !attachment.encryptionIv) {
    throw new Error("Attachment encryption metadata is incomplete");
  }
  const key = scryptSync(password, Buffer.from(attachment.encryptionSalt, "hex"), 32);
  const iv = Buffer.from(attachment.encryptionIv, "hex");
  const decipher = createDecipheriv(attachment.encryptionAlgorithm, key, iv);
  if (attachment.encryptionAlgorithm === "aes-256-gcm") {
    if (!attachment.encryptionTag) {
      throw new Error("Attachment encryption metadata is incomplete");
    }
    (decipher as DecipherGCM).setAuthTag(Buffer.from(attachment.encryptionTag, "hex"));
  }
  return stream.pipe(decipher);
}

export async function downloadAttachment(
  idOrUrl: string,
  destPath?: string,
  _deps: DownloadDeps = {},
  options: DownloadOptions = {}
): Promise<DownloadResult> {
  const token = extractShareToken(idOrUrl);
  const id = token ? null : extractId(idOrUrl);

  const db = _deps.db ?? new AttachmentsDB();
  let shareLinkId: string | null = null;
  const attachment = token
    ? (() => {
        const access = resolveShareAccess(db, token, {
          password: options.password,
          consume: false,
          requirePassword: true,
        });
        shareLinkId = access.shareLink.id;
        return access.attachment;
      })()
    : db.findById(id!);

  if (!attachment) {
    if (!_deps.db) db.close();
    throw new Error("Attachment not found");
  }

  if (isExpired(attachment)) {
    if (!_deps.db) db.close();
    throw new Error("Attachment has expired");
  }

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

  const config = _deps.config ?? getConfig();
  if (_deps.s3 && !("downloadToFile" in _deps.s3)) {
    const buffer = await (_deps.s3 as unknown as { download(key: string): Promise<Buffer> }).download(attachment.s3Key);
    writeFileSync(finalPath, buffer);
    return {
      path: finalPath,
      filename: basename(finalPath),
      size: buffer.length,
    };
  }

  let stream: ObjectStreamResult;
  try {
    stream = await openAttachmentStream(attachment, {
      ..._deps,
      config,
      password: options.password,
    });
  } catch (err) {
    if (!_deps.db) db.close();
    throw err;
  }
  mkdirSync(dirname(finalPath), { recursive: true });
  let reservedShareLink = false;
  if (shareLinkId) {
    reservedShareLink = db.consumeShareLink(shareLinkId);
    if (!reservedShareLink) {
      if (!_deps.db) db.close();
      throw new Error("Share link is no longer available");
    }
  }
  try {
    await pipeline(toNodeReadable(stream.body), createWriteStream(finalPath));
    if (shareLinkId && reservedShareLink) {
      db.incrementDownloads(attachment.id);
    }
  } catch (err) {
    if (shareLinkId && reservedShareLink) db.releaseShareLink(shareLinkId);
    throw err;
  } finally {
    if (!_deps.db) db.close();
  }
  const written = statSync(finalPath).size;

  return {
    path: finalPath,
    filename: basename(finalPath),
    size: written,
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

  if (_deps.s3 && !("downloadStream" in _deps.s3)) {
    const buffer = await (_deps.s3 as unknown as { download(key: string): Promise<Buffer> }).download(attachment.s3Key);
    return { buffer, attachment };
  }

  const stream = await openAttachmentStream(attachment, _deps);
  const chunks: Buffer[] = [];
  for await (const chunk of toNodeReadable(stream.body)) {
    chunks.push(Buffer.from(chunk));
  }

  return { buffer: Buffer.concat(chunks), attachment };
}

export async function openAttachmentStream(
  attachment: Attachment,
  deps: DownloadDeps & { rangeHeader?: string; password?: string } = {}
): Promise<ObjectStreamResult> {
  if (isExpired(attachment)) {
    throw new Error("Attachment has expired");
  }

  const config = deps.config ?? getConfig();
  const encrypted = !!attachment.encryptionAlgorithm;
  const range = encrypted ? null : parseRangeHeader(deps.rangeHeader, attachment.size);
  const backend = attachment.storageBackend ?? (attachment.bucket === "local" ? "local" : "s3");

  let result: ObjectStreamResult;
  if (deps.objectStore && "getStream" in deps.objectStore && backend === "local") {
    result = deps.objectStore.getStream(attachment.s3Key, attachment.contentType, range);
  } else if (backend === "local") {
    const store = new LocalObjectStore(config);
    result = store.getStream(attachment.s3Key, attachment.contentType, range);
  } else {
    const s3 = deps.s3 ?? (createObjectStore(config) as S3Client);
    if (!("downloadStream" in s3)) {
      const buffer = await (s3 as unknown as { download(key: string): Promise<Buffer> }).download(attachment.s3Key);
      result = {
        body: Readable.from(buffer),
        contentLength: buffer.length,
        contentType: attachment.contentType,
        status: 200,
      };
    } else {
      const s3Range = range
        ? `bytes=${range.start}-${range.end ?? ""}`
        : undefined;
      result = await s3.downloadStream(attachment.s3Key, s3Range);
      result.contentType = result.contentType ?? attachment.contentType;
    }
  }

  if (encrypted) {
    return {
      ...result,
      body: decryptIfNeeded(attachment, toNodeReadable(result.body), deps.password),
      status: 200,
      contentRange: undefined,
      contentLength: attachment.size,
    };
  }

  return result;
}
