import { Command } from "commander";
import { AttachmentsDB } from "../../core/db";

export interface ResolveEvidenceOptions {
  todosUrl?: string;
  format?: "compact" | "json";
}

export interface EvidenceAttachmentEntry {
  id: string;
  link: string | null;
  filename: string;
  size: number;
}

export interface ResolvedAttachment {
  id: string;
  filename: string;
  link: string | null;
  size: number;
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
        });
      } else {
        // Fall back to whatever was stored in the task evidence
        resolved.push({
          id: entry.id,
          filename: entry.filename,
          link: entry.link,
          size: entry.size,
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
    .action(async (taskId: string, options: ResolveEvidenceOptions) => {
      const todosUrl = options.todosUrl ?? "http://localhost:3000";
      const format = options.format ?? "compact";

      try {
        const resolved = await resolveEvidence(taskId, { todosUrl });

        if (resolved.length === 0) {
          process.stdout.write(`No attachments found in evidence for task ${taskId}\n`);
          return;
        }

        if (format === "json") {
          process.stdout.write(JSON.stringify(resolved, null, 2) + "\n");
        } else {
          for (const att of resolved) {
            const link = att.link ?? "(no link)";
            process.stdout.write(`${att.id} ${att.filename} ${link} (${formatSize(att.size)})\n`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}
