import { Command } from "commander";
import {
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

export function storageCommand(): Command {
  return new Command("storage")
    .description("Sync local attachment tables with configured remote Postgres storage")
    .argument("[action]", "status | push | pull | sync", "status")
    .option("--tables <tables>", "comma-separated table list")
    .action(async (action: string, options: { tables?: string }) => {
      const tables = parseTables(options.tables);
      const syncOptions = tables ? { tables } : undefined;
      try {
        switch (action) {
          case "status":
            printJson(getStorageStatus());
            break;
          case "push":
            printJson(await storagePush(syncOptions));
            break;
          case "pull":
            printJson(await storagePull(syncOptions));
            break;
          case "sync":
            printJson(await storageSync(syncOptions));
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
