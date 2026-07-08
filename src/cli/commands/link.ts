import { Command } from "commander";
import { getConfig } from "../../core/config";
import { resolveStore } from "../../core/store";
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
      const maxDownloads = options.maxDownloads ? parseInt(options.maxDownloads as string, 10) : undefined;
      if (maxDownloads !== undefined && (!Number.isInteger(maxDownloads) || maxDownloads <= 0)) {
        process.stderr.write("Error: --max-downloads must be a positive integer\n");
        process.exit(1);
      }

      const store = resolveStore();
      try {
        const att = await store.get(id);
        if (!att) {
          process.stderr.write(`Error: Attachment not found: ${id}\n`);
          process.exit(1);
        }

        let result: { link: string | null; expires_at: number | null };
        if (options.regenerate) {
          result = await store.regenerateLink(id, {
            expiry: options.expiry,
            password: options.password as string | undefined,
            maxDownloads,
            linkType: config.defaults.linkType,
          });
        } else {
          result = await store.getLink(id);
        }

        if (options.brief) {
          process.stdout.write(`${result.link ?? "no link"}\n`);
        } else if (format === "json") {
          process.stdout.write(
            JSON.stringify({ id: att.id, filename: att.filename, link: result.link, expiresAt: result.expires_at }, null, 2) +
              "\n"
          );
        } else {
          process.stdout.write(`ID:       ${att.id}\n`);
          process.stdout.write(`File:     ${att.filename}\n`);
          process.stdout.write(`Link:     ${result.link ?? "(no link)"}\n`);
          process.stdout.write(`Expiry:   ${formatExpiry(result.expires_at)}\n`);
        }
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      } finally {
        store.close();
      }
    });

  return cmd;
}
