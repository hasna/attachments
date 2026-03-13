import { Command } from "commander";
import { downloadAttachment } from "../../core/download";
import { formatBytes, exitError } from "../utils";

export function registerDownload(program: Command): void {
  program
    .command("download <id-or-url>")
    .description("Download an attachment by ID or /d/:id URL")
    .option("--output <path>", "Destination directory or filename (defaults to current directory)")
    .option("--brief", "Compact one-line output")
    .action(async (idOrUrl: string, options: { output?: string; brief?: boolean }) => {
      try {
        const result = await downloadAttachment(idOrUrl, options.output);
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
