import { readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import { nanoid } from "nanoid";
import { lookup as mimeLookup } from "mime-types";
import { format } from "date-fns";
import { S3Client } from "./s3";
import { AttachmentsDB, Attachment } from "./db";
import { getConfig, parseExpiry } from "./config";
import { generatePresignedLink, generateServerLink, getLinkType } from "./links";

export interface UploadOptions {
  expiry?: string;       // e.g. "24h", "7d", "never" — overrides config default
  tag?: string;
  linkType?: "presigned" | "server";
}

export interface UploadDeps {
  s3?: InstanceType<typeof S3Client>;
  db?: InstanceType<typeof AttachmentsDB>;
  config?: ReturnType<typeof getConfig>;
}

export async function uploadFile(
  filePath: string,
  opts: UploadOptions = {},
  _deps: UploadDeps = {}
): Promise<Attachment> {
  const config = _deps.config ?? getConfig();

  // 1. Read file and detect content type
  const fileBuffer = readFileSync(filePath);
  const fileSize = statSync(filePath).size;
  const filename = basename(filePath);
  const detectedMime = mimeLookup(filename);
  const contentType = detectedMime !== false ? detectedMime : "application/octet-stream";

  // 2. Generate attachment id
  const id = `att_${nanoid(10)}`;

  // 3. Generate s3Key
  const dateStr = format(new Date(), "yyyy-MM-dd");
  const s3Key = `attachments/${dateStr}/${id}/${filename}`;

  // 4. Resolve expiry
  const expiryStr = opts.expiry ?? config.defaults.expiry;
  const expiryMs = parseExpiry(expiryStr);
  const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;

  // 5. Resolve link type
  const resolvedLinkType = opts.linkType ?? getLinkType(config);

  // 6. Upload to S3
  const s3 = _deps.s3 ?? new S3Client(config.s3);
  await s3.upload(s3Key, fileBuffer, contentType);

  // 7. Generate link
  let link: string | null = null;
  if (resolvedLinkType === "presigned") {
    link = await generatePresignedLink(s3, s3Key, expiryMs);
  } else {
    link = generateServerLink(id, config.server.baseUrl);
  }

  // 8. Build attachment record
  const attachment: Attachment = {
    id,
    filename,
    s3Key,
    bucket: config.s3.bucket,
    size: fileSize,
    contentType,
    link,
    tag: opts.tag ?? null,
    expiresAt,
    createdAt: Date.now(),
  };

  // 9. Insert into DB
  const db = _deps.db ?? new AttachmentsDB();
  try {
    db.insert(attachment);
  } finally {
    if (!_deps.db) db.close();
  }

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
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }

  const contentDisposition = response.headers.get("content-disposition");
  const filename = extractFilenameFromUrl(url, contentDisposition);

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const tempDir = join(tmpdir(), "open-attachments-url");
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
