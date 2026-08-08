import { Command } from "commander";
import { parseFriendlySlug } from "../../core/friendly-slug";
import { resolveStore, type Store } from "../../core/store";

export function slugCommand(resolve: () => Pick<Store, "isSlugAvailable" | "close"> = resolveStore): Command {
  return new Command("slug")
    .description("Check whether a friendly /a/<slug> link is available")
    .argument("<slug>", "Lowercase letters, numbers, and single hyphens")
    .option("--format <format>", "Output format: human or json", "human")
    .option("--brief", "Print only available or unavailable")
    .action(async (slugInput: string, options: { format: string; brief?: boolean }) => {
      if (!["human", "json"].includes(options.format)) {
        process.stderr.write("Error: --format must be one of: human, json\n");
        process.exitCode = 1;
        return;
      }

      const store = resolve();
      try {
        const slug = parseFriendlySlug(slugInput);
        const available = await store.isSlugAvailable(slug);
        if (options.brief) {
          process.stdout.write(`${available ? "available" : "unavailable"}\n`);
        } else if (options.format === "json") {
          process.stdout.write(`${JSON.stringify({ slug, available })}\n`);
        } else {
          process.stdout.write(`${slug}: ${available ? "available" : "unavailable"}\n`);
        }
        if (!available) process.exitCode = 2;
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      } finally {
        store.close();
      }
    });
}
