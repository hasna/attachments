import { Command } from "commander";
import { AttachmentsDB } from "../../core/db";
import { S3Client } from "../../core/s3";
import { getConfig, validateS3Config } from "../../core/config";
import { formatBytes, exitError } from "../utils";

export function registerClean(program: Command): void {
  program
    .command("clean")
    .description("Delete expired attachments from S3 and the local database")
    .option("--dry-run", "Show what would be deleted without actually deleting")
    .action(async (options: { dryRun?: boolean }) => {
      try {
        validateS3Config();
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      }

      const db = new AttachmentsDB();
      try {
        const all = db.findAll({ includeExpired: true });
        const now = Date.now();
        const expired = all.filter(
          (a) => a.expiresAt !== null && a.expiresAt <= now
        );

        if (expired.length === 0) {
          process.stdout.write("No expired attachments found.\n");
          return;
        }

        const totalSize = expired.reduce((sum, a) => sum + a.size, 0);

        if (options.dryRun) {
          process.stdout.write(
            `Would clean ${expired.length} expired attachment${expired.length === 1 ? "" : "s"} (${formatBytes(totalSize)})\n`
          );
          return;
        }

        const config = getConfig();
        const s3 = new S3Client(config.s3);

        for (const att of expired) {
          await s3.delete(att.s3Key);
          db.delete(att.id);
        }

        process.stdout.write(
          `\u2713 Cleaned ${expired.length} expired attachment${expired.length === 1 ? "" : "s"} (${formatBytes(totalSize)} freed)\n`
        );
      } finally {
        db.close();
      }
    });
}
