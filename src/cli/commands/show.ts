import { Command } from "commander";
import { AttachmentsDB, type Attachment } from "../../core/db";
import { getCloudAttachment } from "../../core/api-client";
import { getConfig, isCloudClientMode } from "../../core/config";
import { formatBytes, formatExpiry, linkState } from "../utils";

function formatHuman(att: Attachment): string {
  const lines = [
    `ID:       ${att.id}`,
    `File:     ${att.filename}`,
    `Size:     ${formatBytes(att.size)} (${att.size} bytes)`,
    `Type:     ${att.contentType}`,
    `Status:   ${att.status ?? "ready"}`,
    `Storage:  ${att.storageBackend ?? "s3"}`,
    `Tag:      ${att.tag ?? "(none)"}`,
    `Link:     ${att.link ?? "(no link)"}`,
    `LinkState:${" ".repeat(1)}${linkState(att.link, att.expiresAt)}`,
    `Expires:  ${formatExpiry(att.expiresAt)}`,
    `Created:  ${new Date(att.createdAt).toLocaleString()}`,
  ];

  if (att.downloads !== undefined) {
    lines.push(`Downloads:${" ".repeat(1)}${att.downloads}`);
  }

  return lines.join("\n");
}

export function showCommand(): Command {
  return new Command("show")
    .description("Show full metadata for one attachment")
    .argument("<id>", "Attachment ID")
    .option("--format <format>", "Output format: human or json", "human")
    .action(async (id: string, options: { format?: string }) => {
      const format = options.format ?? "human";
      if (!["human", "json"].includes(format)) {
        process.stderr.write("Error: --format must be one of: human, json\n");
        process.exit(1);
      }

      let db: AttachmentsDB | null = null;
      try {
        const attachment = isCloudClientMode(getConfig())
          ? await getCloudAttachment(id)
          : (() => {
              db = new AttachmentsDB();
              return db.findById(id);
            })();

        if (!attachment) {
          process.stderr.write(`Error: Attachment not found: ${id}\n`);
          process.exit(1);
        }

        if (format === "json") {
          process.stdout.write(JSON.stringify(attachment, null, 2) + "\n");
        } else {
          process.stdout.write(formatHuman(attachment) + "\n");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      } finally {
        db?.close();
      }
    });
}
