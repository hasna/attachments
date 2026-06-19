import { Command } from "commander";
import { AttachmentsDB } from "../../core/db";
import { S3Client } from "../../core/s3";
import { getConfig, getPublicBaseUrl, isCloudClientMode, parseExpiryStrict } from "../../core/config";
import { generatePresignedLink, generateShareLink, getLinkType } from "../../core/links";
import { getCloudAttachmentLink, regenerateCloudAttachmentLink } from "../../core/api-client";
import { formatExpiry } from "../utils";

export function linkCommand(): Command {
  const cmd = new Command("link")
    .description("Show or regenerate the link for an attachment")
    .argument("<id>", "Attachment ID")
    .option("--regenerate", "Generate a fresh share link", false)
    .option("--expiry <time>", "Expiry duration for regenerated link (e.g. 7d, 24h, 30m, never)")
    .option("--password <password>", "Require a password for the regenerated link")
    .option("--max-downloads <count>", "Maximum successful downloads for the regenerated link")
    .option("--format <format>", "Output format: human or json", "human")
    .option("--brief", "Compact one-line output")
    .action(async (id: string, options) => {
      const format = options.format as string;
      if (!["human", "json"].includes(format)) {
        process.stderr.write(`Error: --format must be one of: human, json\n`);
        process.exit(1);
      }

      const config = getConfig();
      if (isCloudClientMode(config)) {
        const maxDownloads = options.maxDownloads ? parseInt(options.maxDownloads as string, 10) : undefined;
        if (maxDownloads !== undefined && (!Number.isInteger(maxDownloads) || maxDownloads <= 0)) {
          process.stderr.write("Error: --max-downloads must be a positive integer\n");
          process.exit(1);
        }
        const result = options.regenerate
          ? await regenerateCloudAttachmentLink(id, {
              expiry: options.expiry,
              password: options.password as string | undefined,
              maxDownloads,
              linkType: config.defaults.linkType,
            })
          : await getCloudAttachmentLink(id);

        if (options.brief) {
          process.stdout.write(`${result.link ?? "no link"}\n`);
        } else if (format === "json") {
          process.stdout.write(JSON.stringify({ id, link: result.link, expiresAt: result.expires_at }, null, 2) + "\n");
        } else {
          process.stdout.write(`ID:       ${id}\n`);
          process.stdout.write(`Link:     ${result.link ?? "(no link)"}\n`);
          process.stdout.write(`Expiry:   ${formatExpiry(result.expires_at)}\n`);
        }
        return;
      }

      const db = new AttachmentsDB();
      try {
        const att = db.findById(id);
        if (!att) {
          process.stderr.write(`Error: Attachment not found: ${id}\n`);
          process.exit(1);
        }

        let link = att.link;
        let expiresAt = att.expiresAt;

        if (options.regenerate) {
          const linkType = getLinkType(config);

          let expiryMs: number | null;
          try {
            expiryMs = parseExpiryStrict(options.expiry ?? config.defaults.expiry).milliseconds;
          } catch (err) {
            process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
          }

          const maxDownloads = options.maxDownloads ? parseInt(options.maxDownloads as string, 10) : undefined;
          if (maxDownloads !== undefined && (!Number.isInteger(maxDownloads) || maxDownloads <= 0)) {
            process.stderr.write("Error: --max-downloads must be a positive integer\n");
            process.exit(1);
          }

          if (linkType === "presigned" && (att.storageBackend ?? "s3") === "s3" && !options.password && !maxDownloads) {
            const s3 = new S3Client(config.s3);
            link = await generatePresignedLink(s3, att.s3Key, expiryMs);
          } else {
            const { token } =
              "createShareLink" in db
                ? db.createShareLink({
                    attachmentId: att.id,
                    expiresAt: expiryMs !== null ? Date.now() + expiryMs : null,
                    password: options.password as string | undefined,
                    maxUses: maxDownloads ?? null,
                  })
                : { token: att.id };
            link = generateShareLink(token, getPublicBaseUrl(config), config.server.publicPath);
          }

          expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;
          db.updateLink(att.id, link ?? "", expiresAt);
        }

        if (options.brief) {
          process.stdout.write(`${link ?? "no link"}\n`);
        } else if (format === "json") {
          process.stdout.write(
            JSON.stringify({ id: att.id, filename: att.filename, link, expiresAt }, null, 2) +
              "\n"
          );
        } else {
          process.stdout.write(`ID:       ${att.id}\n`);
          process.stdout.write(`File:     ${att.filename}\n`);
          process.stdout.write(`Link:     ${link ?? "(no link)"}\n`);
          process.stdout.write(`Expiry:   ${formatExpiry(expiresAt)}\n`);
        }
      } finally {
        db.close();
      }
    });

  return cmd;
}
