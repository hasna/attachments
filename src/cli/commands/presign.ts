import { Command } from "commander";
import { nanoid } from "nanoid";
import { format } from "date-fns";
import { basename } from "path";
import { lookup as mimeLookup } from "mime-types";
import { AttachmentsDB } from "../../core/db";
import { S3Client } from "../../core/s3";
import { getConfig, parseExpiry } from "../../core/config";

export function presignUploadCommand(): Command {
  const cmd = new Command("presign-upload")
    .description("Generate a presigned PUT URL for direct S3 upload")
    .argument("<filename>", "Filename for the upload (e.g. report.pdf)")
    .option("--expiry <time>", "URL expiry duration (e.g. 1h, 30m, 7d)", "1h")
    .option("--content-type <type>", "Content type for the upload")
    .action(async (filename: string, options) => {
      const config = getConfig();

      // Determine content type
      const contentType =
        (options.contentType as string | undefined) ??
        (mimeLookup(filename) || "application/octet-stream");

      // Parse expiry
      const expiryMs = parseExpiry(options.expiry as string);
      if (expiryMs === null) {
        process.stderr.write(
          `Error: Invalid expiry format "${options.expiry}". Use e.g. 1h, 30m, 7d\n`
        );
        process.exit(1);
      }

      const expirySeconds = Math.floor(expiryMs / 1000);

      // Generate ID and S3 key
      const id = `att_${nanoid(11)}`;
      const datePrefix = format(new Date(), "yyyy-MM-dd");
      const s3Key = `attachments/${datePrefix}/${id}/${filename}`;

      // Generate presigned PUT URL
      const s3 = new S3Client(config.s3);
      const uploadUrl = await s3.presignPut(s3Key, contentType, expirySeconds);

      // Create DB record with size 0 (pending upload)
      const now = Date.now();
      const db = new AttachmentsDB();
      try {
        db.insert({
          id,
          filename,
          s3Key,
          bucket: config.s3.bucket,
          size: 0,
          contentType,
          link: null,
          tag: null,
          expiresAt: now + expiryMs,
          createdAt: now,
        });
      } finally {
        db.close();
      }

      process.stdout.write(`Upload URL: ${uploadUrl} (expires in ${options.expiry})\n`);
      process.stdout.write(`ID: ${id}\n`);
      process.stdout.write(`Usage: curl -X PUT -H "Content-Type: ${contentType}" -T ${filename} "${uploadUrl}"\n`);
    });

  return cmd;
}

export function registerPresign(program: Command): void {
  program.addCommand(presignUploadCommand());
}
