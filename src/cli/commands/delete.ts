import { Command } from "commander";
import { AttachmentsDB } from "../../core/db";
import { S3Client } from "../../core/s3";
import { getConfig, isCloudClientMode } from "../../core/config";
import { deleteCloudAttachment } from "../../core/api-client";
import { resolveAttachmentsV1 } from "../../core/cloud-v1";
import { LocalObjectStore } from "../../core/object-storage";

function abortDelete(): never { process.stdout.write("Aborted.\n"); return process.exit(0); }

export function deleteCommand(): Command {
  const cmd = new Command("delete")
    .description("Delete an attachment by ID")
    .argument("<id>", "Attachment ID to delete")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .option("--brief", "Compact one-line output")
    .action(async (id: string, options) => {
      const v1 = resolveAttachmentsV1();
      if (v1.transport === "cloud-http") {
        if (!options.yes) {
          process.stdout.write(`Delete ${id}? This cannot be undone. [y/N] `);
          const answer = await readLine();
          if (answer.trim().toLowerCase() !== "y") return abortDelete();
        }
        await v1.store.delete(id);
        process.stdout.write(options.brief ? `deleted ${id}\n` : `✓ Deleted ${id}\n`);
        return;
      }
      if (isCloudClientMode(getConfig())) {
        if (!options.yes) {
          process.stdout.write(`Delete ${id}? This cannot be undone. [y/N] `);
          const answer = await readLine();
          if (answer.trim().toLowerCase() !== "y") return abortDelete();
        }
        await deleteCloudAttachment(id);
        process.stdout.write(options.brief ? `deleted ${id}\n` : `✓ Deleted ${id}\n`);
        return;
      }

      const db = new AttachmentsDB();
      try {
        const att = db.findById(id);
        if (!att) {
          process.stderr.write(`Error: Attachment not found: ${id}\n`);
          process.exit(1);
        }

        if (!options.yes) {
          // Prompt for confirmation
          process.stdout.write(
            `Delete ${att.id} (${att.filename})? This cannot be undone. [y/N] `
          );
          const answer = await readLine();
          if (answer.trim().toLowerCase() !== "y") {
            process.stdout.write("Aborted.\n");
            process.exit(0);
          }
        }

        const config = getConfig();
        const storageBackend = att.storageBackend ?? (att.bucket === "local" ? "local" : "s3");
        if (storageBackend === "local") {
          const store = new LocalObjectStore(config);
          await store.delete(att.s3Key);
        } else {
          const s3 = new S3Client(config.s3);
          await s3.delete(att.s3Key);
        }

        db.delete(id);
        if (options.brief) {
          process.stdout.write(`deleted ${att.id}\n`);
        } else {
          process.stdout.write(`✓ Deleted ${att.id} (${att.filename})\n`);
        }
      } finally {
        db.close();
      }
    });

  return cmd;
}

/**
 * Read a single line from stdin.
 */
async function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.once("data", (chunk) => {
      input += chunk.toString();
      process.stdin.pause();
      resolve(input.split("\n")[0] ?? "");
    });
  });
}
