import { Command } from "commander";
import {
  type SyncResult,
  getStorageStatus,
  storagePull,
  storagePush,
  storageSync,
} from "../../db/storage-sync";

function parseTables(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((table) => table.trim()).filter(Boolean);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

type StorageStatus = ReturnType<typeof getStorageStatus>;

function formatStatus(status: StorageStatus): string {
  const syncSummary = status.sync.length === 0
    ? "none"
    : status.sync.map((item) => `${item.table_name}:${item.direction}:${item.last_synced_at ?? "never"}`).join(", ");
  return [
    `Storage: ${status.mode}${status.configured ? " (remote configured)" : " (local only)"}`,
    `Env: ${status.activeEnv ?? "none"}`,
    `Tables: ${status.tables.join(", ")}`,
    `Sync: ${syncSummary}`,
    "Use --format json for full storage metadata.",
  ].join("\n");
}

function formatSyncResult(results: SyncResult[]): string {
  if (results.length === 0) return "No storage sync results.";
  return results
    .map((result) => {
      const status = result.errors.length > 0 ? ` errors:${result.errors.length}` : "";
      return `${result.table}: read ${result.rowsRead}, wrote ${result.rowsWritten}${status}`;
    })
    .join("\n");
}

function formatSyncPair(result: { push: SyncResult[]; pull: SyncResult[] }): string {
  return [
    "Push:",
    formatSyncResult(result.push),
    "Pull:",
    formatSyncResult(result.pull),
  ].join("\n");
}

export function storageCommand(): Command {
  return new Command("storage")
    .description("Sync local attachment tables with configured remote Postgres storage")
    .argument("[action]", "status | push | pull | sync", "status")
    .option("--tables <tables>", "comma-separated table list")
    .option("--format <format>", "Output format: compact or json", "compact")
    .action(async (action: string, options: { tables?: string; format?: string }) => {
      const tables = parseTables(options.tables);
      const syncOptions = tables ? { tables } : undefined;
      const format = options.format ?? "compact";
      if (!["compact", "json"].includes(format)) {
        console.error("Error: --format must be one of: compact, json");
        process.exit(1);
      }
      try {
        switch (action) {
          case "status":
            if (format === "json") printJson(getStorageStatus());
            else console.log(formatStatus(getStorageStatus()));
            break;
          case "push":
            if (format === "json") printJson(await storagePush(syncOptions));
            else console.log(formatSyncResult(await storagePush(syncOptions)));
            break;
          case "pull":
            if (format === "json") printJson(await storagePull(syncOptions));
            else console.log(formatSyncResult(await storagePull(syncOptions)));
            break;
          case "sync":
            if (format === "json") printJson(await storageSync(syncOptions));
            else console.log(formatSyncPair(await storageSync(syncOptions)));
            break;
          default:
            console.error(`Unknown storage action: ${action}. Valid actions: status, push, pull, sync`);
            process.exit(1);
        }
      } catch (error) {
        console.error(`Storage ${action} failed: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
