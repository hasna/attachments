import { Command } from "commander";
import { AttachmentsDB } from "../../core/db";
import type { Attachment } from "../../core/db";

export interface TaskJournalOptions {
  todosUrl?: string;
  format?: "markdown" | "compact" | "json";
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

export function formatMarkdown(journal: TaskJournal, todosReachable: boolean): string {
  const { task, history, attachments } = journal;

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
    for (const entry of history) {
      const time = formatTimestamp(entry.timestamp);
      let line = `${time} [${entry.action}]`;
      if (entry.actor) line += ` ${entry.actor}`;
      if (entry.details) line += ` ${entry.details}`;
      if (entry.progress !== undefined) line += ` (${entry.progress}%)`;
      lines.push(line);
    }
  }

  lines.push("\n## Attachments");
  if (attachments.length === 0) {
    lines.push("_(no attachments found)_");
  } else {
    for (const att of attachments) {
      const link = att.link ?? "(no link)";
      const expiry = formatExpiry(att.expiresAt);
      lines.push(`${att.id}  ${att.filename}  ${formatSize(att.size)}  ${link}  (${expiry})`);
    }
  }

  return lines.join("\n");
}

export function formatCompact(journal: TaskJournal, todosReachable: boolean): string {
  const { task, history, attachments } = journal;
  const lines: string[] = [];

  const title = task.subject ?? task.id;
  lines.push(`[${task.id}] ${title}${task.status ? ` (${task.status})` : ""}`);

  if (!todosReachable) lines.push("  todos: unreachable");

  for (const entry of history) {
    const time = formatTimestamp(entry.timestamp);
    let line = `  ${time} ${entry.action}`;
    if (entry.actor) line += ` by ${entry.actor}`;
    lines.push(line);
  }

  for (const att of attachments) {
    lines.push(`  att: ${att.id} ${att.filename} ${formatSize(att.size)}`);
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
      "markdown"
    )
    .action(async (taskId: string, options: TaskJournalOptions) => {
      const todosUrl = options.todosUrl ?? "http://localhost:3000";
      const format = options.format ?? "markdown";

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
          output = formatCompact(journal, todosReachable);
        } else {
          output = formatMarkdown(journal, todosReachable);
        }

        process.stdout.write(output + "\n");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}
