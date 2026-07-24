import { Command } from "commander";
import { resolveStore } from "../../core/store";
import { formatBytes, exitError } from "../utils";

export function registerClean(program: Command): void {
  program
    .command("clean")
    .description("Delete expired attachments from object storage and the database")
    .option("--dry-run", "Show what would be deleted without actually deleting")
    .action(async (options: { dryRun?: boolean }) => {
      const store = resolveStore();
      try {
        const now = Date.now();
        const expired = (await store.list({ includeExpired: true })).filter(
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

        const removed = await store.deleteExpired();
        process.stdout.write(
          `\u2713 Cleaned ${removed} expired attachment${removed === 1 ? "" : "s"} (${formatBytes(totalSize)} freed)\n`
        );
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      } finally {
        store.close();
      }
    });
}
