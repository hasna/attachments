import { Command } from "commander";
import { AttachmentsDB } from "../../core/db";
import { linkState, truncateMiddle } from "../utils";

export interface ResolveEvidenceOptions {
  todosUrl?: string;
  format?: "compact" | "json";
  verbose?: boolean;
  limit?: string;
}

export interface EvidenceAttachmentEntry {
  id: string;
  link: string | null;
  filename: string;
  size: number;
  expiresAt?: number | null;
  expires_at?: number | null;
}

export interface ResolvedAttachment {
  id: string;
  filename: string;
  link: string | null;
  size: number;
  expiresAt: number | null;
}

/**
 * Fetches a task from the todos REST API and extracts evidence attachment IDs,
 * then resolves each ID to the current link in the local DB.
 */
export async function resolveEvidence(
  taskId: string,
  options: {
    todosUrl?: string;
  },
  fetchFn: typeof fetch = fetch
): Promise<ResolvedAttachment[]> {
  const todosUrl = options.todosUrl ?? "http://localhost:3000";
  const url = `${todosUrl}/api/tasks/${taskId}`;

  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach todos server at ${todosUrl}: ${message}`);
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch task ${taskId}: HTTP ${response.status}${body ? ` — ${body}` : ""}`
    );
  }

  const task = await response.json() as Record<string, unknown>;

  // Extract metadata._evidence.attachments
  const metadata = task.metadata as Record<string, unknown> | undefined;
  const evidence = metadata?._evidence as Record<string, unknown> | undefined;
  const attachments = evidence?.attachments as EvidenceAttachmentEntry[] | undefined;

  if (!attachments || attachments.length === 0) {
    return [];
  }

  // Resolve each attachment ID in the local DB to get a current link
  const db = new AttachmentsDB();
  const resolved: ResolvedAttachment[] = [];
  try {
    for (const entry of attachments) {
      const dbRecord = db.findById(entry.id);
      if (dbRecord) {
        resolved.push({
          id: dbRecord.id,
          filename: dbRecord.filename,
          link: dbRecord.link,
          size: dbRecord.size,
          expiresAt: dbRecord.expiresAt,
        });
      } else {
        // Fall back to whatever was stored in the task evidence
        resolved.push({
          id: entry.id,
          filename: entry.filename,
          link: entry.link,
          size: entry.size,
          expiresAt: entry.expiresAt ?? entry.expires_at ?? null,
        });
      }
    }
  } finally {
    db.close();
  }

  return resolved;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function registerResolveEvidence(program: Command): void {
  program
    .command("resolve-evidence")
    .description("Resolve attachment links from a completed todos task's evidence")
    .argument("<task-id>", "Task ID (e.g. TASK-001)")
    .option(
      "--todos-url <url>",
      "Todos REST server base URL",
      "http://localhost:3000"
    )
    .option(
      "--format <format>",
      "Output format: compact or json",
      "compact"
    )
    .option("--verbose", "Include full links in compact output", false)
    .option("--limit <n>", "Maximum attachment rows in compact output", "20")
    .action(async (taskId: string, options: ResolveEvidenceOptions) => {
      const todosUrl = options.todosUrl ?? "http://localhost:3000";
      const format = options.format ?? "compact";
      const limit = parseInt(options.limit ?? "20", 10);

      if (!["compact", "json"].includes(format)) {
        process.stderr.write("Error: --format must be one of: compact, json\n");
        process.exit(1);
      }
      if (!Number.isInteger(limit) || limit < 1) {
        process.stderr.write("Error: --limit must be a positive integer\n");
        process.exit(1);
      }

      try {
        const resolved = await resolveEvidence(taskId, { todosUrl });

        if (resolved.length === 0) {
          process.stdout.write(`No attachments found in evidence for task ${taskId}\n`);
          return;
        }

        if (format === "json") {
          process.stdout.write(JSON.stringify(resolved, null, 2) + "\n");
        } else {
          const visible = resolved.slice(0, limit);
          for (const att of visible) {
            const link = options.verbose ? att.link ?? "(no link)" : `link:${linkState(att.link, att.expiresAt)}`;
            process.stdout.write(`${att.id} ${truncateMiddle(att.filename, options.verbose ? 120 : 48)} ${link} (${formatSize(att.size)})\n`);
          }
          const hidden = resolved.length - visible.length;
          if (hidden > 0) {
            process.stdout.write(`${hidden} more attachment${hidden === 1 ? "" : "s"} hidden; use --limit or --format json for details.\n`);
          }
          if (!options.verbose && resolved.some((att) => att.link)) {
            process.stdout.write("Links hidden; use --verbose or --format json for full URLs.\n");
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}
