import { Command } from "commander";
import { AttachmentsDB, type Attachment } from "../../core/db";
import { listCloudAttachments } from "../../core/api-client";
import { getConfig, isCloudClientMode } from "../../core/config";
import { formatBytes, formatDateShort, formatExpiry, linkState, truncateMiddle } from "../utils";

export function compactLine(att: Attachment, options: { verbose?: boolean } = {}): string {
  const bytes = formatBytes(att.size);
  const expiry = options.verbose ? formatExpiry(att.expiresAt) : formatDateShort(att.expiresAt);
  const filename = options.verbose ? att.filename : truncateMiddle(att.filename, 48);
  const link = options.verbose ? att.link ?? "(no link)" : `link:${linkState(att.link, att.expiresAt)}`;
  const tag = att.tag ? `  tag:${truncateMiddle(att.tag, 32)}` : "";
  return `${att.id}  ${filename}  ${bytes}  ${link}  exp:${expiry}${tag}`;
}

export function tableLines(attachments: Attachment[], options: { verbose?: boolean } = {}): string {
  if (attachments.length === 0) return "No attachments found.";

  const rowsForWidth = attachments.map((a) => ({
    id: a.id,
    filename: options.verbose ? a.filename : truncateMiddle(a.filename, 48),
    size: formatBytes(a.size),
    link: options.verbose ? a.link ?? "(no link)" : linkState(a.link, a.expiresAt),
    expiry: options.verbose ? formatExpiry(a.expiresAt) : formatDateShort(a.expiresAt),
    tag: a.tag ? truncateMiddle(a.tag, 24) : "",
  }));

  // Compute column widths
  const idW = Math.max(4, ...rowsForWidth.map((a) => a.id.length));
  const nameW = Math.max(8, ...rowsForWidth.map((a) => a.filename.length));
  const sizeW = Math.max(4, ...rowsForWidth.map((a) => a.size.length));
  const linkW = Math.max(4, ...rowsForWidth.map((a) => a.link.length));
  const expiryW = Math.max(7, ...rowsForWidth.map((a) => a.expiry.length));
  const tagW = Math.max(3, ...rowsForWidth.map((a) => a.tag.length));

  const pad = (s: string, w: number) => s.padEnd(w);

  const header =
    `${pad("ID", idW)}  ${pad("Filename", nameW)}  ${pad("Size", sizeW)}  ` +
    `${pad("Link", linkW)}  ${pad("Expiry", expiryW)}  ${pad("Tag", tagW)}`;
  const sep = "-".repeat(header.length);

  const rows = rowsForWidth.map((att) => {
    return (
      `${pad(att.id, idW)}  ${pad(att.filename, nameW)}  ${pad(att.size, sizeW)}  ` +
      `${pad(att.link, linkW)}  ${pad(att.expiry, expiryW)}  ${pad(att.tag, tagW)}`
    );
  });

  return [header, sep, ...rows].join("\n");
}

function detailHint(count: number, limit: number): string {
  const more = count >= limit ? " Increase --limit to scan more." : "";
  return `Showing ${count} attachment${count === 1 ? "" : "s"} (limit ${limit}). Links hidden; use 'attachments link <id>', 'attachments show <id>', 'attachments list --verbose', or '--format json' for details.${more}`;
}

export function listCommand(): Command {
  const cmd = new Command("list")
    .description("List uploaded attachments")
    .option("--format <format>", "Output format: compact, json, or table", "compact")
    .option("--expired", "Include expired attachments", false)
    .option("--limit <n>", "Maximum number of results", "20")
    .option("--brief", "Compact one-line output per attachment")
    .option("--tag <tag>", "Filter by tag")
    .option("--verbose", "Include full links and untruncated fields")
    .action(async (options) => {
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
      const verbose = !!options.verbose;

      let db: AttachmentsDB | null = null;
      try {
        const attachments = isCloudClientMode(getConfig())
          ? await listCloudAttachments({ limit, includeExpired, tag })
          : (() => {
              db = new AttachmentsDB();
              return db.findAll({ limit, includeExpired, tag });
            })();

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
          process.stdout.write(tableLines(attachments, { verbose }) + "\n");
          if (!verbose && attachments.length > 0) {
            process.stdout.write(detailHint(attachments.length, limit) + "\n");
          }
        } else {
          // compact
          if (attachments.length === 0) {
            process.stdout.write("No attachments found.\n");
          } else {
            for (const att of attachments) {
              process.stdout.write(compactLine(att, { verbose }) + "\n");
            }
            if (!verbose) {
              process.stdout.write(detailHint(attachments.length, limit) + "\n");
            }
          }
        }
      } finally {
        db?.close();
      }
    });

  return cmd;
}
