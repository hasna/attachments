import { readFileSync, statSync } from "fs";
import { basename } from "path";
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
