import { Command } from "commander";
import { uploadFile } from "../../core/upload";
import { validateS3Config } from "../../core/config";
import { formatBytes, formatExpiry, exitError } from "../utils";

export function registerUpload(program: Command): void {
  program
    .command("upload <file>")
    .description("Upload a file to S3 and get a shareable link")
    .option("--expiry <time>", "Link expiry: e.g. 24h, 7d, never (overrides config default)")
    .option(
      "--link-type <type>",
      "Link type: presigned or server",
      (value: string) => {
        if (value !== "presigned" && value !== "server") {
          exitError(`--link-type must be 'presigned' or 'server', got '${value}'`);
        }
        return value as "presigned" | "server";
      }
    )
    .option("--format <fmt>", "Output format: human or json", "human")
    .action(async (file: string, options: { expiry?: string; linkType?: "presigned" | "server"; format?: string }) => {
      // Validate S3 config before attempting upload
      try {
        validateS3Config();
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      }

      try {
        const attachment = await uploadFile(file, {
          expiry: options.expiry,
          linkType: options.linkType,
        });

        if (options.format === "json") {
          process.stdout.write(JSON.stringify(attachment) + "\n");
        } else {
          process.stdout.write(
            `\u2713 Uploaded ${attachment.filename}\n` +
              `  Link:    ${attachment.link ?? "(none)"}\n` +
              `  ID:      ${attachment.id}\n` +
              `  Size:    ${formatBytes(attachment.size)}\n` +
              `  Expires: ${formatExpiry(attachment.expiresAt)}\n`
          );
        }
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      }
    });
}
