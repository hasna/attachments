import { Command } from "commander";
import { AttachmentsDB } from "../../core/db";
import { S3Client } from "../../core/s3";
import { getConfig, parseExpiry } from "../../core/config";
import { generatePresignedLink, generateServerLink, getLinkType } from "../../core/links";
import { formatExpiry } from "../utils";

export function linkCommand(): Command {
  const cmd = new Command("link")
    .description("Show or regenerate the link for an attachment")
    .argument("<id>", "Attachment ID")
    .option("--regenerate", "Generate a fresh presigned URL", false)
    .option("--expiry <time>", "Expiry duration for regenerated link (e.g. 7d, 24h, 30m, never)")
    .option("--format <format>", "Output format: human or json", "human")
    .option("--brief", "Compact one-line output")
    .action(async (id: string, options) => {
      const format = options.format as string;
      if (!["human", "json"].includes(format)) {
        process.stderr.write(`Error: --format must be one of: human, json\n`);
        process.exit(1);
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
          const config = getConfig();
          const linkType = getLinkType(config);

          let expiryMs: number | null;
          if (options.expiry) {
            expiryMs = parseExpiry(options.expiry as string);
            if (expiryMs === null && options.expiry !== "never") {
              process.stderr.write(
                `Error: Invalid expiry format "${options.expiry}". Use e.g. 7d, 24h, 30m, never\n`
              );
              process.exit(1);
            }
          } else {
            expiryMs = parseExpiry(config.defaults.expiry);
          }

          if (linkType === "presigned") {
            const s3 = new S3Client(config.s3);
            link = await generatePresignedLink(s3, att.s3Key, expiryMs);
          } else {
            link = generateServerLink(att.id, config.server.baseUrl);
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
