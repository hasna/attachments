import { readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import { createCipheriv, randomBytes, scryptSync } from "crypto";
import { nanoid } from "nanoid";
import { lookup as mimeLookup } from "mime-types";
import { Readable, Transform } from "stream";
import { S3Client } from "./s3";
import { AttachmentsDB, Attachment } from "./db";
import {
  getConfig,
  getPublicBaseUrl,
  normalizeConfig,
  parseExpiryStrict,
  resolveStorageBackend,
} from "./config";
import { generatePresignedLink, generateShareLink, getLinkType } from "./links";
import { trackUploadCost } from "./economy";
import { createObjectKey, sanitizeFilename } from "./security";
import { LocalObjectStore, createObjectStore } from "./object-storage";

export interface UploadOptions {
  expiry?: string;       // e.g. "24h", "7d", "never" — overrides config default
  tag?: string;
  linkType?: "presigned" | "server";
  password?: string;
  encrypt?: boolean;
  maxDownloads?: number;
  baseUrl?: string;
}

export interface UploadDeps {
  s3?: InstanceType<typeof S3Client>;
  objectStore?: InstanceType<typeof S3Client> | InstanceType<typeof LocalObjectStore>;
  db?: InstanceType<typeof AttachmentsDB>;
  config?: ReturnType<typeof getConfig>;
}

function buildEncryptionTransform(password: string): {
  transform: (stream: NodeJS.ReadableStream) => NodeJS.ReadableStream;
  algorithm: string;
  salt: string;
  iv: string;
  tag: () => string | null;
} {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  return {
    algorithm: "aes-256-gcm",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    transform: (stream) => stream.pipe(cipher),
    tag: () => {
      try {
        return cipher.getAuthTag().toString("hex");
      } catch {
        return null;
      }
    },
  };
}

function countBytes(limit: number, onCount: (bytes: number) => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += Buffer.byteLength(chunk);
      if (total > limit) {
        callback(new Error(`File too large. Maximum size is ${limit} bytes.`));
        return;
      }
      onCount(total);
      callback(null, chunk);
    },
  });
}

async function uploadObject(
  key: string,
  filePath: string,
  contentType: string,
  storageBackend: "local" | "s3",
  deps: UploadDeps,
  transform?: (stream: NodeJS.ReadableStream) => NodeJS.ReadableStream
): Promise<void> {
  if (deps.objectStore && "uploadFile" in deps.objectStore) {
    await deps.objectStore.uploadFile(key, filePath, contentType, transform ? { transform } : {});
    return;
  }

  if (storageBackend === "s3") {
    const s3 = deps.s3 ?? new S3Client((deps.config ?? getConfig()).s3);
    if ("uploadFile" in s3) {
      await s3.uploadFile(key, filePath, contentType, { transform });
      return;
    }
    await (s3 as unknown as { upload(key: string, body: Buffer, contentType: string): Promise<void> }).upload(key, readFileSync(filePath), contentType);
    return;
  }

  const store = new LocalObjectStore(deps.config ?? getConfig());
  await store.uploadFile(key, filePath, contentType, transform ? { transform } : {});
}

async function uploadObjectStream(
  key: string,
  stream: NodeJS.ReadableStream,
  contentType: string,
  storageBackend: "local" | "s3",
  deps: UploadDeps,
  transform?: (stream: NodeJS.ReadableStream) => NodeJS.ReadableStream
): Promise<void> {
  if (deps.objectStore && "uploadStream" in deps.objectStore) {
    await deps.objectStore.uploadStream(key, stream, contentType, transform ? { transform } : {});
    return;
  }

  if (storageBackend === "s3") {
    const s3 = deps.s3 ?? new S3Client((deps.config ?? getConfig()).s3);
    await s3.uploadStream(key, transform ? transform(stream) : stream, contentType);
    return;
  }

  const store = new LocalObjectStore(deps.config ?? getConfig());
  await store.uploadStream(key, stream, contentType, transform ? { transform } : {});
}

export async function uploadFile(
  filePath: string,
  opts: UploadOptions = {},
  _deps: UploadDeps = {}
): Promise<Attachment> {
  const config = _deps.config ? normalizeConfig(_deps.config) : getConfig();

  const fileSize = statSync(filePath).size;
  if (fileSize > config.storage.maxSizeBytes) {
    throw new Error(`File too large. Maximum size is ${config.storage.maxSizeBytes} bytes.`);
  }

  const filename = sanitizeFilename(basename(filePath));
  const detectedMime = mimeLookup(filename);
  const contentType = detectedMime !== false ? detectedMime : "application/octet-stream";

  const id = `att_${nanoid(10)}`;
  const objectKey = createObjectKey(id, filename);
  const storageBackend = resolveStorageBackend(config);

  // 4. Resolve expiry
  const expiryStr = opts.expiry ?? config.defaults.expiry;
  const { milliseconds: expiryMs } = parseExpiryStrict(expiryStr);
  const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;

  // 5. Resolve link type
  let resolvedLinkType = opts.linkType ?? getLinkType(config);
  if (storageBackend === "local" || opts.password || opts.encrypt || opts.maxDownloads) {
    resolvedLinkType = "server";
  }

  if (opts.encrypt && !opts.password) {
    throw new Error("--encrypt requires a password so the file can be decrypted later");
  }

  const encryption = opts.encrypt && opts.password ? buildEncryptionTransform(opts.password) : null;

  await uploadObject(
    objectKey,
    filePath,
    contentType,
    storageBackend,
    { ..._deps, config },
    encryption?.transform
  );

  // 7. Generate link
  let link: string | null = null;
  if (resolvedLinkType === "presigned") {
    const s3 = _deps.s3 ?? new S3Client(config.s3);
    link = await generatePresignedLink(s3, objectKey, expiryMs);
  }

  // 8. Build attachment record
  const attachment: Attachment = {
    id,
    filename,
    s3Key: objectKey,
    bucket: storageBackend === "s3" ? config.s3.bucket : "local",
    size: fileSize,
    contentType,
    link,
    tag: opts.tag ?? null,
    expiresAt,
    createdAt: Date.now(),
    storageBackend,
    status: "ready",
    encryptionAlgorithm: encryption?.algorithm ?? null,
    encryptionSalt: encryption?.salt ?? null,
    encryptionIv: encryption?.iv ?? null,
    encryptionTag: encryption?.tag() ?? null,
    downloads: 0,
  };

  // 9. Insert into DB
  const db = _deps.db ?? new AttachmentsDB();
  try {
    db.insert(attachment);
    if (resolvedLinkType === "server") {
      const { token } =
        "createShareLink" in db
          ? db.createShareLink({
              attachmentId: id,
              expiresAt,
              password: opts.password,
              maxUses: opts.maxDownloads ?? null,
            })
          : { token: id };
      link = generateShareLink(token, opts.baseUrl ?? getPublicBaseUrl(config), config.server.publicPath);
      if ("updateLink" in db) db.updateLink(id, link, expiresAt);
      attachment.link = link;
    }
  } finally {
    if (!_deps.db) db.close();
  }

  // 10. Optionally track upload cost to economy server (non-blocking, silent failure)
  void trackUploadCost({ filename, sizeBytes: fileSize, operation: "upload" });

  return attachment;
}

export async function uploadStreamAttachment(
  stream: NodeJS.ReadableStream,
  filenameInput: string,
  contentTypeInput?: string,
  opts: UploadOptions & { size?: number } = {},
  _deps: UploadDeps = {}
): Promise<Attachment> {
  const config = _deps.config ? normalizeConfig(_deps.config) : getConfig();
  if (opts.size !== undefined && opts.size > config.storage.maxSizeBytes) {
    throw new Error(`File too large. Maximum size is ${config.storage.maxSizeBytes} bytes.`);
  }

  const filename = sanitizeFilename(filenameInput);
  const detectedMime = mimeLookup(filename);
  const contentType = contentTypeInput ?? (detectedMime !== false ? detectedMime : "application/octet-stream");
  const id = `att_${nanoid(10)}`;
  const objectKey = createObjectKey(id, filename);
  const storageBackend = resolveStorageBackend(config);
  const expiryStr = opts.expiry ?? config.defaults.expiry;
  const { milliseconds: expiryMs } = parseExpiryStrict(expiryStr);
  const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;

  let resolvedLinkType = opts.linkType ?? getLinkType(config);
  if (storageBackend === "local" || opts.password || opts.encrypt || opts.maxDownloads) {
    resolvedLinkType = "server";
  }
  if (opts.encrypt && !opts.password) {
    throw new Error("--encrypt requires a password so the file can be decrypted later");
  }

  const encryption = opts.encrypt && opts.password ? buildEncryptionTransform(opts.password) : null;
  let actualSize = 0;
  const countedStream = stream.pipe(countBytes(config.storage.maxSizeBytes, (bytes) => {
    actualSize = bytes;
  }));

  await uploadObjectStream(
    objectKey,
    countedStream,
    contentType,
    storageBackend,
    { ..._deps, config },
    encryption?.transform
  );

  const size = opts.size ?? actualSize;
  let link: string | null = null;
  if (resolvedLinkType === "presigned") {
    const s3 = _deps.s3 ?? new S3Client(config.s3);
    link = await generatePresignedLink(s3, objectKey, expiryMs);
  }

  const attachment: Attachment = {
    id,
    filename,
    s3Key: objectKey,
    bucket: storageBackend === "s3" ? config.s3.bucket : "local",
    size,
    contentType,
    link,
    tag: opts.tag ?? null,
    expiresAt,
    createdAt: Date.now(),
    storageBackend,
    status: "ready",
    encryptionAlgorithm: encryption?.algorithm ?? null,
    encryptionSalt: encryption?.salt ?? null,
    encryptionIv: encryption?.iv ?? null,
    encryptionTag: encryption?.tag() ?? null,
    downloads: 0,
  };

  const db = _deps.db ?? new AttachmentsDB();
  try {
    db.insert(attachment);
    if (resolvedLinkType === "server") {
      const { token } = db.createShareLink({
        attachmentId: id,
        expiresAt,
        password: opts.password,
        maxUses: opts.maxDownloads ?? null,
      });
      link = generateShareLink(token, opts.baseUrl ?? getPublicBaseUrl(config), config.server.publicPath);
      db.updateLink(id, link, expiresAt);
      attachment.link = link;
    }
  } finally {
    if (!_deps.db) db.close();
  }

  void trackUploadCost({ filename, sizeBytes: size, operation: "upload" });
  return attachment;
}

export async function uploadFromBuffer(
  buffer: Buffer,
  filename: string,
  opts: UploadOptions = {},
  deps: UploadDeps = {}
): Promise<Attachment> {
  const tempDir = join(tmpdir(), "open-attachments-stdin");
  mkdirSync(tempDir, { recursive: true });
  const tempPath = join(tempDir, filename);

  try {
    writeFileSync(tempPath, buffer);
    return await uploadFile(tempPath, opts, deps);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Extract a filename from a URL, using Content-Disposition header if available,
 * otherwise falling back to the last path segment.
 */
function extractFilenameFromUrl(url: string, contentDisposition?: string | null): string {
  // Try Content-Disposition header first
  if (contentDisposition) {
    const match = contentDisposition.match(/filename[*]?=(?:UTF-8''|"?)([^";]+)"?/i);
    if (match?.[1]) {
      return decodeURIComponent(match[1].trim());
    }
  }

  // Fall back to last path segment from URL
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      const lastSegment = decodeURIComponent(segments[segments.length - 1]!);
      if (lastSegment && lastSegment.includes(".")) {
        return lastSegment;
      }
    }
  } catch {
    // invalid URL, fall through
  }

  return `download_${nanoid(6)}`;
}

export async function uploadFromUrl(
  url: string,
  opts: UploadOptions = {},
  deps: UploadDeps = {}
): Promise<Attachment> {
  const config = deps.config ? normalizeConfig(deps.config) : getConfig();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }
  const contentLength = response.headers.get("content-length");
  const size = contentLength ? parseInt(contentLength, 10) : undefined;
  if (size !== undefined && size > config.storage.maxSizeBytes) {
    throw new Error(`File too large. Maximum size is ${config.storage.maxSizeBytes} bytes.`);
  }

  const contentDisposition = response.headers.get("content-disposition");
  const filename = extractFilenameFromUrl(url, contentDisposition);
  if (!response.body) {
    throw new Error("URL response did not include a readable body");
  }
  return uploadStreamAttachment(
        Readable.fromWeb(response.body as never),
    filename,
    response.headers.get("content-type") ?? undefined,
    { ...opts, size },
    { ...deps, config }
  );
}
