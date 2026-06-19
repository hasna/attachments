import { Command } from "commander";
import { downloadAttachment } from "../../core/download";
import { downloadFromCloud } from "../../core/api-client";
import { getConfig, isCloudClientMode } from "../../core/config";
import { formatBytes, exitError } from "../utils";

export function registerDownload(program: Command): void {
  program
    .command("download <id-or-url>")
    .description("Download an attachment by ID, /d/:id URL, or local /a/:token URL")
    .option("--output <path>", "Destination directory or filename (defaults to current directory)")
    .option("--password <password>", "Password for encrypted/protected attachments")
    .option("--brief", "Compact one-line output")
    .action(async (idOrUrl: string, options: { output?: string; password?: string; brief?: boolean }) => {
      try {
        const result = isCloudClientMode(getConfig())
          ? await downloadFromCloud(idOrUrl, options.output, { password: options.password })
          : await downloadAttachment(idOrUrl, options.output, {}, { password: options.password });
        if (options.brief) {
          process.stdout.write(`${result.path} ${formatBytes(result.size)}\n`);
        } else {
          process.stdout.write(
            `\u2713 Downloaded ${result.filename} \u2192 ${result.path} (${formatBytes(result.size)})\n`
          );
        }
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      }
    });
}
