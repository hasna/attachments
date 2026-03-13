import { Command } from "commander";
import { execSync } from "child_process";
import { uploadFile, uploadFromBuffer, uploadFromUrl } from "../../core/upload";
import { validateS3Config } from "../../core/config";
import { formatBytes, formatExpiry, exitError } from "../utils";

/**
 * Copy text to the system clipboard.
 * Returns true on success, false if clipboard is unavailable.
 */
function copyToClipboard(text: string): boolean {
  try {
    const cmd = process.platform === "darwin"
      ? "pbcopy"
      : "xclip -selection clipboard";
    execSync(cmd, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

export function registerUpload(program: Command): void {
  program
    .command("upload [file]")
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
    .option("--tag <tag>", "Tag/label to organize the attachment")
    .option("--format <fmt>", "Output format: human or json", "human")
    .option("--copy", "Copy the link to clipboard after upload")
    .option("--brief", "Compact one-line output")
    .option("--stdin", "Read file content from stdin instead of a file path")
    .option("--filename <name>", "Filename to use when uploading from stdin")
    .action(async (file: string | undefined, options: { expiry?: string; linkType?: "presigned" | "server"; tag?: string; format?: string; copy?: boolean; brief?: boolean; stdin?: boolean; filename?: string }) => {
      // Validate S3 config before attempting upload
      try {
        validateS3Config();
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      }

      try {
        let attachment;

        if (options.stdin) {
          if (!options.filename) {
            exitError("--filename is required when using --stdin");
          }
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
          }
          const buffer = Buffer.concat(chunks);
          attachment = await uploadFromBuffer(buffer, options.filename!, {
            expiry: options.expiry,
            linkType: options.linkType,
            tag: options.tag,
          });
        } else if (!file) {
          exitError("A file path is required (or use --stdin)");
          return; // unreachable but helps TS
        } else {
          const isUrl = file.startsWith("http://") || file.startsWith("https://");
          if (isUrl) {
            process.stderr.write("Fetching URL...\n");
          }
          attachment = isUrl
            ? await uploadFromUrl(file, {
                expiry: options.expiry,
                linkType: options.linkType,
                tag: options.tag,
              })
            : await uploadFile(file, {
                expiry: options.expiry,
                linkType: options.linkType,
                tag: options.tag,
              });
        }

        // Attempt clipboard copy if --copy flag is set and a link exists
        let copied = false;
        if (options.copy && attachment.link) {
          copied = copyToClipboard(attachment.link);
        }

        if (options.brief) {
          process.stdout.write(
            `${attachment.id} ${attachment.link ?? "(none)"} ${formatBytes(attachment.size)}\n`
          );
        } else if (options.format === "json") {
          process.stdout.write(JSON.stringify(attachment) + "\n");
        } else {
          const linkSuffix = copied ? " (copied to clipboard)" : "";
          process.stdout.write(
            `\u2713 Uploaded ${attachment.filename}\n` +
              `  Link:    ${attachment.link ?? "(none)"}${linkSuffix}\n` +
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
