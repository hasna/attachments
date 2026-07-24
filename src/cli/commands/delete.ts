import { Command } from "commander";
import { resolveStore } from "../../core/store";

export function deleteCommand(): Command {
  const cmd = new Command("delete")
    .description("Delete an attachment by ID")
    .argument("<id>", "Attachment ID to delete")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .option("--brief", "Compact one-line output")
    .action(async (id: string, options) => {
      const store = resolveStore();
      try {
        const att = await store.get(id);
        if (!att) {
          process.stderr.write(`Error: Attachment not found: ${id}\n`);
          process.exit(1);
        }

        if (!options.yes) {
          process.stdout.write(
            `Delete ${att.id} (${att.filename})? This cannot be undone. [y/N] `
          );
          const answer = await readLine();
          if (answer.trim().toLowerCase() !== "y") {
            process.stdout.write("Aborted.\n");
            process.exit(0);
          }
        }

        await store.delete(id);
        if (options.brief) {
          process.stdout.write(`deleted ${att.id}\n`);
        } else {
          process.stdout.write(`✓ Deleted ${att.id} (${att.filename})\n`);
        }
      } finally {
        store.close();
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
