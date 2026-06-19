import { Command } from "commander";
import { nanoid } from "nanoid";
import { lookup as mimeLookup } from "mime-types";
import { AttachmentsDB } from "../../core/db";
import { S3Client } from "../../core/s3";
import { getConfig, getPublicBaseUrl, parseExpiryStrict, validateS3Config } from "../../core/config";
import { generatePresignedLink, generateShareLink } from "../../core/links";
import { createObjectKey, sanitizeFilename } from "../../core/security";
import { formatExpiry } from "../utils";

export function presignUploadCommand(): Command {
  const cmd = new Command("presign-upload")
    .description("Generate a presigned PUT URL for direct S3 upload")
    .argument("<filename>", "Filename for the upload (e.g. report.pdf)")
    .option("--expiry <time>", "URL expiry duration (e.g. 1h, 30m, 7d)", "1h")
    .option("--content-type <type>", "Content type for the upload")
    .action(async (filename: string, options) => {
      const config = getConfig();
      validateS3Config(config);
      const safeFilename = sanitizeFilename(filename);

      // Determine content type
      const contentType =
        (options.contentType as string | undefined) ??
        (mimeLookup(safeFilename) || "application/octet-stream");

      // Parse expiry
      let expiryMs: number | null;
      try {
        expiryMs = parseExpiryStrict(options.expiry as string).milliseconds;
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
      if (expiryMs === null) {
        process.stderr.write(
          `Error: Presigned upload expiry cannot be never\n`
        );
        process.exit(1);
      }

      const expirySeconds = Math.floor(expiryMs / 1000);

      // Generate ID and S3 key
      const id = `att_${nanoid(11)}`;
      const s3Key = createObjectKey(id, safeFilename);

      // Generate presigned PUT URL
      const s3 = new S3Client(config.s3);
      const uploadUrl = await s3.presignPut(s3Key, contentType, expirySeconds);

      // Create DB record with size 0 (pending upload)
      const now = Date.now();
      const db = new AttachmentsDB();
      try {
        db.insert({
          id,
          filename: safeFilename,
          s3Key,
          bucket: config.s3.bucket,
          size: 0,
          contentType,
          link: null,
          tag: null,
          expiresAt: now + expiryMs,
          createdAt: now,
          storageBackend: "s3",
          status: "pending",
        });
      } finally {
        db.close();
      }

      process.stdout.write(`Upload URL: ${uploadUrl} (expires in ${options.expiry})\n`);
      process.stdout.write(`ID: ${id}\n`);
      process.stdout.write(`Finalize: attachments presign-complete ${id}\n`);
      process.stdout.write(`Usage: curl -X PUT -H "Content-Type: ${contentType}" -T ${safeFilename} "${uploadUrl}"\n`);
    });

  return cmd;
}

export function presignCompleteCommand(): Command {
  const cmd = new Command("presign-complete")
    .description("Finalize a direct S3 upload created by presign-upload")
    .argument("<id>", "Pending attachment ID")
    .option("--expiry <time>", "Share link expiry duration (e.g. 7d, 24h, never)")
    .option("--password <password>", "Require a password before public download")
    .option("--max-downloads <count>", "Maximum successful downloads for the generated share link")
    .option("--link-type <type>", "Link type: presigned or server")
    .option("--format <format>", "Output format: human or json", "human")
    .option("--brief", "Only print the generated link")
    .action(async (id: string, options) => {
      const config = getConfig();
      validateS3Config(config);

      const format = String(options.format ?? "human");
      if (!["human", "json"].includes(format)) {
        process.stderr.write("Error: --format must be one of: human, json\n");
        process.exit(1);
      }

      const linkType = (options.linkType ?? config.defaults.linkType) as "presigned" | "server";
      if (linkType !== "presigned" && linkType !== "server") {
        process.stderr.write("Error: --link-type must be one of: presigned, server\n");
        process.exit(1);
      }

      const maxDownloads = options.maxDownloads ? parseInt(options.maxDownloads as string, 10) : undefined;
      if (maxDownloads !== undefined && (!Number.isInteger(maxDownloads) || maxDownloads <= 0)) {
        process.stderr.write("Error: --max-downloads must be a positive integer\n");
        process.exit(1);
      }

      const db = new AttachmentsDB();
      try {
        const attachment = db.findById(id);
        if (!attachment) {
          process.stderr.write(`Error: Pending attachment not found: ${id}\n`);
          process.exit(1);
        }
        if (attachment.status !== "pending") {
          process.stderr.write(`Error: Attachment upload is already complete: ${id}\n`);
          process.exit(1);
        }

        const s3 = new S3Client(config.s3);
        const info = await s3.head(attachment.s3Key);
        const size = info.contentLength ?? attachment.size;
        if (size > config.storage.maxSizeBytes) {
          try {
            await s3.delete(attachment.s3Key);
          } catch {
            // Best-effort cleanup; the pending record is removed either way.
          }
          db.delete(id);
          process.stderr.write(`Error: File too large. Maximum size is ${config.storage.maxSizeBytes} bytes.\n`);
          process.exit(1);
        }

        let expiryMs: number | null;
        try {
          expiryMs = parseExpiryStrict(options.expiry ?? config.defaults.expiry).milliseconds;
        } catch (err) {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }
        const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;

        const mustUseServerLink = !!options.password || maxDownloads !== undefined || linkType !== "presigned";
        let link: string;
        if (!mustUseServerLink && (attachment.storageBackend ?? "s3") === "s3") {
          link = await generatePresignedLink(s3, attachment.s3Key, expiryMs);
        } else {
          const { token } = db.createShareLink({
            attachmentId: attachment.id,
            expiresAt,
            password: options.password as string | undefined,
            maxUses: maxDownloads ?? null,
          });
          link = generateShareLink(token, getPublicBaseUrl(config), config.server.publicPath);
        }

        db.markReady({
          id: attachment.id,
          size,
          contentType: info.contentType ?? attachment.contentType,
          link,
          expiresAt,
        });

        if (options.brief) {
          process.stdout.write(`${link}\n`);
        } else if (format === "json") {
          process.stdout.write(
            JSON.stringify({
              id: attachment.id,
              filename: attachment.filename,
              size,
              link,
              expiresAt,
            }, null, 2) + "\n"
          );
        } else {
          process.stdout.write(`ID:       ${attachment.id}\n`);
          process.stdout.write(`File:     ${attachment.filename}\n`);
          process.stdout.write(`Size:     ${size}\n`);
          process.stdout.write(`Link:     ${link}\n`);
          process.stdout.write(`Expiry:   ${formatExpiry(expiresAt)}\n`);
        }
      } finally {
        db.close();
      }
    });

  return cmd;
}

export function registerPresign(program: Command): void {
  program.addCommand(presignUploadCommand());
  program.addCommand(presignCompleteCommand());
}
