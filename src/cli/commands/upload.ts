import { Command } from "commander";
import { execSync } from "child_process";
import { getConfig } from "../../core/config";
import { resolveStore } from "../../core/store";
import { resolveInternalBaseUrl } from "../../core/internal-link";
import { isValidEmail } from "../../core/security";
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
    .command("upload [files...]")
    .description("Upload one or more files to S3 and get shareable links")
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
    .option("--password <password>", "Require a password before download")
    .option("--encrypt", "Encrypt stored bytes with the provided password")
    .option("--max-downloads <count>", "Maximum successful downloads for the generated link")
    .option("--require-email", "Gate the link: visitors enter their email and receive a one-time access link")
    .option("--allowed-email <email...>", "Restrict email-gated access to these address(es)")
    .option("--format <fmt>", "Output format: human or json", "human")
    .option("--copy", "Copy the link to clipboard after upload")
    .option("--brief", "Compact one-line output")
    .option("--stdin", "Read file content from stdin instead of a file path")
    .option("--filename <name>", "Filename to use when uploading from stdin")
    .option("--client-mode <mode>", "Override client mode for this upload: local or cloud")
    .option("--internal", "Generate a local-network/Tailscale server link")
    .action(async (files: string[], options: { expiry?: string; linkType?: "presigned" | "server"; tag?: string; password?: string; encrypt?: boolean; maxDownloads?: string; requireEmail?: boolean; allowedEmail?: string[]; format?: string; copy?: boolean; brief?: boolean; stdin?: boolean; filename?: string; clientMode?: string; internal?: boolean }) => {
      const config = getConfig();
      if (options.clientMode && options.clientMode !== "local" && options.clientMode !== "cloud") {
        exitError("--client-mode must be local or cloud");
      }
      // Env drives self_hosted/cloud vs local; `--client-mode local` pins on-box.
      const store = resolveStore(process.env, { forceLocal: options.clientMode === "local" });
      const cloudMode = store.transport === "cloud-http";

      const maxDownloads = options.maxDownloads ? parseInt(options.maxDownloads, 10) : undefined;
      if (maxDownloads !== undefined && (!Number.isInteger(maxDownloads) || maxDownloads <= 0)) {
        exitError("--max-downloads must be a positive integer");
      }
      if (options.encrypt && !options.password) {
        exitError("--encrypt requires --password");
      }
      const allowedEmails = options.allowedEmail && options.allowedEmail.length > 0 ? options.allowedEmail : null;
      const requireEmail = options.requireEmail === true || allowedEmails !== null;
      if (allowedEmails) {
        const bad = allowedEmails.filter((e) => !isValidEmail(e));
        if (bad.length > 0) exitError(`Invalid --allowed-email value(s): ${bad.join(", ")}`);
      }
      if (options.internal && cloudMode) {
        exitError("--internal requires local client mode. Use --client-mode local or set client.mode to local.");
      }
      if (cloudMode && options.encrypt) {
        exitError("--encrypt is not supported in self_hosted/cloud mode. Use --client-mode local to encrypt at rest.");
      }
      const internalBaseUrl = options.internal ? (await resolveInternalBaseUrl(config)).baseUrl : undefined;
      const uploadOptions = {
        expiry: options.expiry,
        linkType: options.linkType,
        tag: options.tag,
        password: options.password,
        encrypt: options.encrypt,
        maxDownloads,
        requireEmail,
        allowedEmails,
        baseUrl: internalBaseUrl,
      };

      // Helper to upload a single file/url/stdin and output result
      const uploadOne = async (file?: string) => {
        let attachment;
        if (options.stdin) {
          if (!options.filename) {
            exitError("--filename is required when using --stdin");
          }
          attachment = await store.uploadStream(process.stdin, options.filename!, "application/octet-stream", uploadOptions);
        } else if (!file) {
          exitError("A file path is required (or use --stdin)");
          return;
        } else {
          const isUrl = file.startsWith("http://") || file.startsWith("https://");
          if (isUrl) process.stderr.write("Fetching URL...\n");
          attachment = isUrl
            ? await store.uploadUrl(file, uploadOptions)
            : await store.uploadFile(file, uploadOptions);
        }

        let copied = false;
        if (options.copy && attachment.link) copied = copyToClipboard(attachment.link);

        if (options.brief) {
          process.stdout.write(`${attachment.id} ${attachment.link ?? "(none)"} ${formatBytes(attachment.size)}\n`);
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
      };

      try {
        if (options.stdin || files.length === 0) {
          await uploadOne();
        } else {
          for (const f of files) {
            await uploadOne(f);
          }
        }
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      } finally {
        store.close();
      }
    });
}
