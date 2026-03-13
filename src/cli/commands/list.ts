import { Command } from "commander";
import { AttachmentsDB, type Attachment } from "../../core/db";
import { formatBytes, formatExpiry } from "../utils";

function compactLine(att: Attachment): string {
  const bytes = formatBytes(att.size);
  const expiry = formatExpiry(att.expiresAt);
  const link = att.link ?? "(no link)";
  return `${att.id}  ${att.filename}  ${bytes}  ${link}  ${expiry}`;
}

function tableLines(attachments: Attachment[]): string {
  if (attachments.length === 0) return "No attachments found.";

  // Compute column widths
  const idW = Math.max(4, ...attachments.map((a) => a.id.length));
  const nameW = Math.max(8, ...attachments.map((a) => a.filename.length));
  const sizeW = Math.max(4, ...attachments.map((a) => formatBytes(a.size).length));
  const expiryW = Math.max(7, ...attachments.map((a) => formatExpiry(a.expiresAt).length));

  const pad = (s: string, w: number) => s.padEnd(w);

  const header =
    `${pad("ID", idW)}  ${pad("Filename", nameW)}  ${pad("Size", sizeW)}  ` +
    `Link  ${pad("Expiry", expiryW)}`;
  const sep = "-".repeat(header.length);

  const rows = attachments.map((att) => {
    const link = att.link ?? "(no link)";
    return (
      `${pad(att.id, idW)}  ${pad(att.filename, nameW)}  ${pad(formatBytes(att.size), sizeW)}  ` +
      `${link}  ${pad(formatExpiry(att.expiresAt), expiryW)}`
    );
  });

  return [header, sep, ...rows].join("\n");
}

export function listCommand(): Command {
  const cmd = new Command("list")
    .description("List uploaded attachments")
    .option("--format <format>", "Output format: compact, json, or table", "compact")
    .option("--expired", "Include expired attachments", false)
    .option("--limit <n>", "Maximum number of results", "20")
    .option("--brief", "Compact one-line output per attachment")
    .option("--tag <tag>", "Filter by tag")
    .action((options) => {
      const format = options.format as string;
      const includeExpired = options.expired as boolean;
      const limit = parseInt(options.limit as string, 10);
      const tag = options.tag as string | undefined;

      if (!["compact", "json", "table"].includes(format)) {
        process.stderr.write(`Error: --format must be one of: compact, json, table\n`);
        process.exit(1);
      }

      if (isNaN(limit) || limit < 1) {
        process.stderr.write(`Error: --limit must be a positive integer\n`);
        process.exit(1);
      }

      const brief = !!options.brief;

      const db = new AttachmentsDB();
      try {
        const attachments = db.findAll({ limit, includeExpired, tag });

        if (brief) {
          if (attachments.length === 0) {
            process.stdout.write("No attachments found.\n");
          } else {
            for (const att of attachments) {
              const date = att.createdAt
                ? new Date(att.createdAt).toISOString().slice(0, 10)
                : "unknown";
              process.stdout.write(
                `${att.id} ${att.filename} ${formatBytes(att.size)} ${date}\n`
              );
            }
          }
        } else if (format === "json") {
          process.stdout.write(JSON.stringify(attachments, null, 2) + "\n");
        } else if (format === "table") {
          process.stdout.write(tableLines(attachments) + "\n");
        } else {
          // compact
          if (attachments.length === 0) {
            process.stdout.write("No attachments found.\n");
          } else {
            for (const att of attachments) {
              process.stdout.write(compactLine(att) + "\n");
            }
          }
        }
      } finally {
        db.close();
      }
    });

  return cmd;
}
