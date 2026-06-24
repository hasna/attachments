import { Command } from "commander";
import { AttachmentsDB } from "../../core/db";
import type { Attachment } from "../../core/db";
import { linkState, truncateMiddle } from "../utils";

export interface TaskJournalOptions {
  todosUrl?: string;
  format?: "markdown" | "compact" | "json";
  limit?: string;
  verbose?: boolean;
}

export interface TaskHistoryEntry {
  timestamp: string;
  action: string;
  actor?: string;
  details?: string;
  progress?: number;
}

export interface TaskMeta {
  id: string;
  subject?: string;
  status?: string;
  assignee?: string;
  created_at?: string;
}

export interface TaskJournal {
  task: TaskMeta;
  history: TaskHistoryEntry[];
  attachments: Attachment[];
}

/**
 * Fetch task metadata from todos REST API.
 * Returns null if todos is unreachable or task not found.
 */
export async function fetchTaskMeta(
  taskId: string,
  todosUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<TaskMeta | null> {
  try {
    const response = await fetchFn(`${todosUrl}/api/tasks/${taskId}`);
    if (response.status === 404) return null;
    if (!response.ok) return null;
    const data = await response.json() as Record<string, unknown>;
    return {
      id: taskId,
      subject: (data.subject as string) ?? (data.title as string) ?? taskId,
      status: (data.status as string) ?? undefined,
      assignee: (data.assignee as string) ?? (data.assigned_to as string) ?? undefined,
      created_at: (data.created_at as string) ?? undefined,
    };
  } catch {
    // Todos unreachable — return minimal meta
    return null;
  }
}

/**
 * Fetch task history from todos REST API.
 * Returns empty array if todos is unreachable.
 */
export async function fetchTaskHistory(
  taskId: string,
  todosUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<TaskHistoryEntry[]> {
  try {
    const response = await fetchFn(`${todosUrl}/api/tasks/${taskId}/history`);
    if (!response.ok) return [];
    const data = await response.json() as unknown;
    if (!Array.isArray(data)) return [];
    return data.map((entry: Record<string, unknown>) => ({
      timestamp: (entry.timestamp as string) ?? (entry.created_at as string) ?? "",
      action: (entry.action as string) ?? (entry.type as string) ?? "unknown",
      actor: (entry.actor as string) ?? (entry.agent as string) ?? undefined,
      details: (entry.details as string) ?? (entry.message as string) ?? undefined,
      progress: typeof entry.progress === "number" ? entry.progress : undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Query local DB for attachments associated with a task.
 * Checks tag = "task:TASK-ID" format.
 */
export function findTaskAttachments(
  taskId: string,
  db: AttachmentsDB
): Attachment[] {
  const tag = `task:${taskId}`;
  return db.findAll({ tag, includeExpired: true });
}

/**
 * Build the full task journal by aggregating todos history + local attachments.
 */
export async function buildTaskJournal(
  taskId: string,
  options: {
    todosUrl?: string;
    dbPath?: string;
  },
  fetchFn: typeof fetch = fetch,
  dbFactory?: () => AttachmentsDB
): Promise<{ journal: TaskJournal; todosReachable: boolean }> {
  const todosUrl = options.todosUrl ?? "http://localhost:3000";

  // Fetch from todos (parallel)
  const [meta, history] = await Promise.all([
    fetchTaskMeta(taskId, todosUrl, fetchFn),
    fetchTaskHistory(taskId, todosUrl, fetchFn),
  ]);

  const todosReachable = meta !== null || history.length > 0;

  const task: TaskMeta = meta ?? { id: taskId };

  // Query local DB
  const db = dbFactory ? dbFactory() : new AttachmentsDB(options.dbPath);
  let attachments: Attachment[] = [];
  try {
    attachments = findTaskAttachments(taskId, db);
  } finally {
    db.close();
  }

  return {
    journal: { task, history, attachments },
    todosReachable,
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function formatTimestamp(ts: string): string {
  if (!ts) return "??:??";
  try {
    const d = new Date(ts);
    return d.toISOString().slice(11, 16); // HH:MM
  } catch {
    return ts.slice(0, 5);
  }
}

function formatExpiry(expiresAt: number | null): string {
  if (!expiresAt) return "no expiry";
  return `expires: ${new Date(expiresAt).toISOString().slice(0, 10)}`;
}

function takeWithHidden<T>(items: T[], limit: number, verbose: boolean): { visible: T[]; hidden: number } {
  if (verbose) return { visible: items, hidden: 0 };
  return { visible: items.slice(0, limit), hidden: Math.max(0, items.length - limit) };
}

export function formatMarkdown(
  journal: TaskJournal,
  todosReachable: boolean,
  options: { limit?: number; verbose?: boolean } = {}
): string {
  const { task, history, attachments } = journal;
  const limit = options.limit ?? 20;
  const verbose = !!options.verbose;
  const shownHistory = takeWithHidden(history, limit, verbose);
  const shownAttachments = takeWithHidden(attachments, limit, verbose);

  const title = task.subject ?? task.id;
  const lines: string[] = [];

  lines.push(`# Task Journal: ${task.id} — ${title}`);

  const metaParts: string[] = [];
  if (task.status) metaParts.push(`Status: ${task.status}`);
  if (task.assignee) metaParts.push(`Assigned: ${task.assignee}`);
  if (task.created_at) metaParts.push(`Created: ${task.created_at.slice(0, 10)}`);
  if (metaParts.length > 0) lines.push(metaParts.join(" | "));

  if (!todosReachable) {
    lines.push("\n> Note: todos server unreachable — history unavailable");
  }

  lines.push("\n## History");
  if (history.length === 0) {
    lines.push("_(no history available)_");
  } else {
    for (const entry of shownHistory.visible) {
      const time = formatTimestamp(entry.timestamp);
      let line = `${time} [${entry.action}]`;
      if (entry.actor) line += ` ${entry.actor}`;
      if (verbose && entry.details) line += ` ${entry.details}`;
      if (entry.progress !== undefined) line += ` (${entry.progress}%)`;
      lines.push(line);
    }
    if (shownHistory.hidden > 0) {
      lines.push(`_(${shownHistory.hidden} more history entries hidden; use --limit or --verbose)_`);
    }
  }

  lines.push("\n## Attachments");
  if (attachments.length === 0) {
    lines.push("_(no attachments found)_");
  } else {
    for (const att of shownAttachments.visible) {
      const link = verbose ? att.link ?? "(no link)" : `link:${linkState(att.link, att.expiresAt)}`;
      const expiry = formatExpiry(att.expiresAt);
      lines.push(`${att.id}  ${truncateMiddle(att.filename, verbose ? 120 : 56)}  ${formatSize(att.size)}  ${link}  (${expiry})`);
    }
    if (shownAttachments.hidden > 0) {
      lines.push(`_(${shownAttachments.hidden} more attachments hidden; use --limit or --verbose)_`);
    }
    if (!verbose) {
      lines.push("_Links hidden; use `attachments link <id>` or `--verbose` for full URLs._");
    }
  }

  return lines.join("\n");
}

export function formatCompact(
  journal: TaskJournal,
  todosReachable: boolean,
  options: { limit?: number; verbose?: boolean } = {}
): string {
  const { task, history, attachments } = journal;
  const limit = options.limit ?? 20;
  const verbose = !!options.verbose;
  const shownHistory = takeWithHidden(history, limit, verbose);
  const shownAttachments = takeWithHidden(attachments, limit, verbose);
  const lines: string[] = [];

  const title = task.subject ?? task.id;
  lines.push(`[${task.id}] ${truncateMiddle(title, 80)}${task.status ? ` (${task.status})` : ""}`);

  if (!todosReachable) lines.push("  todos: unreachable");

  for (const entry of shownHistory.visible) {
    const time = formatTimestamp(entry.timestamp);
    let line = `  ${time} ${entry.action}`;
    if (entry.actor) line += ` by ${entry.actor}`;
    if (verbose && entry.details) line += `: ${truncateMiddle(entry.details, 120)}`;
    lines.push(line);
  }
  if (shownHistory.hidden > 0) lines.push(`  ... ${shownHistory.hidden} more history entries hidden`);

  for (const att of shownAttachments.visible) {
    const link = verbose ? ` ${att.link ?? "(no link)"}` : ` link:${linkState(att.link, att.expiresAt)}`;
    lines.push(`  att: ${att.id} ${truncateMiddle(att.filename, verbose ? 120 : 48)} ${formatSize(att.size)}${link}`);
  }
  if (shownAttachments.hidden > 0) lines.push(`  ... ${shownAttachments.hidden} more attachments hidden`);

  if (!verbose && (history.length > limit || attachments.length > limit || attachments.some((att) => att.link))) {
    lines.push("  hint: use --limit, --verbose, --format markdown, or --format json for details");
  }

  return lines.join("\n");
}

export function formatJson(journal: TaskJournal): string {
  return JSON.stringify(journal, null, 2);
}

// ---------------------------------------------------------------------------
// CLI registration
// ---------------------------------------------------------------------------

export function registerTaskJournal(program: Command): void {
  program
    .command("task-journal")
    .description("Show full story of a task: history from todos + local attachments")
    .argument("<task-id>", "Task ID (e.g. TASK-001)")
    .option(
      "--todos-url <url>",
      "Todos REST server base URL",
      "http://localhost:3000"
    )
    .option(
      "--format <format>",
      "Output format: markdown, compact, json",
      "compact"
    )
    .option("--limit <n>", "Maximum history and attachment rows in human output", "20")
    .option("--verbose", "Include full links and history details in human output", false)
    .action(async (taskId: string, options: TaskJournalOptions) => {
      const todosUrl = options.todosUrl ?? "http://localhost:3000";
      const format = options.format ?? "compact";
      const limit = parseInt(options.limit ?? "20", 10);

      if (!["markdown", "compact", "json"].includes(format)) {
        process.stderr.write("Error: --format must be one of: markdown, compact, json\n");
        process.exit(1);
      }
      if (!Number.isInteger(limit) || limit < 1) {
        process.stderr.write("Error: --limit must be a positive integer\n");
        process.exit(1);
      }

      try {
        const { journal, todosReachable } = await buildTaskJournal(taskId, { todosUrl });

        // 404: task not found in todos AND no attachments
        if (!todosReachable && journal.attachments.length === 0 && !journal.task.subject) {
          // Attempt a direct 404 check
          try {
            const response = await fetch(`${todosUrl}/api/tasks/${taskId}`);
            if (response.status === 404) {
              process.stderr.write(`Error: Task not found: ${taskId}\n`);
              process.exit(1);
              return;
            }
          } catch {
            // todos unreachable, not a 404
          }
        }

        let output: string;
        if (format === "json") {
          output = formatJson(journal);
        } else if (format === "compact") {
          output = formatCompact(journal, todosReachable, { limit, verbose: options.verbose });
        } else {
          output = formatMarkdown(journal, todosReachable, { limit, verbose: options.verbose });
        }

        process.stdout.write(output + "\n");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}
