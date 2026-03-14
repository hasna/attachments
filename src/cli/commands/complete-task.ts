import { Command } from "commander";
import { uploadFile } from "../../core/upload";

export interface CompleteTaskOptions {
  file?: string[];
  todosUrl?: string;
  expiry?: string;
  notes?: string;
}

export interface CompleteTaskResult {
  task_id: string;
  attachment_ids: string[];
  links: Array<string | null>;
}

/**
 * Uploads files and completes a todos task with those attachment IDs as evidence.
 * Uses native fetch — no todos-sdk dependency required.
 */
export async function completeTaskWithFiles(
  taskId: string,
  filePaths: string[],
  options: {
    todosUrl?: string;
    expiry?: string;
    notes?: string;
  },
  uploadFileFn: typeof uploadFile = uploadFile,
  fetchFn: typeof fetch = fetch
): Promise<CompleteTaskResult> {
  const todosUrl = options.todosUrl ?? "http://localhost:3000";

  // Upload each file and collect attachment IDs + links
  const attachment_ids: string[] = [];
  const links: Array<string | null> = [];

  for (const filePath of filePaths) {
    const attachment = await uploadFileFn(filePath, { expiry: options.expiry });
    attachment_ids.push(attachment.id);
    links.push(attachment.link);
  }

  // Complete the task via todos REST API
  const url = `${todosUrl}/api/tasks/${taskId}/complete`;
  const body: Record<string, unknown> = { attachment_ids };
  if (options.notes !== undefined) {
    body.notes = options.notes;
  }

  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const responseBody = await response.text().catch(() => "");
    throw new Error(
      `Failed to complete task ${taskId}: HTTP ${response.status}${responseBody ? ` — ${responseBody}` : ""}`
    );
  }

  return { task_id: taskId, attachment_ids, links };
}

export function registerCompleteTask(program: Command): void {
  program
    .command("complete-task")
    .description("Upload files and complete a todos task with them as evidence")
    .argument("<task-id>", "Task ID to complete (e.g. TASK-001)")
    .requiredOption("--file <path>", "File to upload (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option(
      "--todos-url <url>",
      "Todos REST server base URL",
      "http://localhost:3000"
    )
    .option("--expiry <time>", "Link expiry: e.g. 24h, 7d, never")
    .option("--notes <text>", "Completion notes to attach")
    .action(async (taskId: string, options: CompleteTaskOptions) => {
      const files = options.file ?? [];
      if (files.length === 0) {
        process.stderr.write("Error: at least one --file is required\n");
        process.exit(1);
      }

      const todosUrl = options.todosUrl ?? "http://localhost:3000";

      try {
        const result = await completeTaskWithFiles(taskId, files, {
          todosUrl,
          expiry: options.expiry,
          notes: options.notes,
        });
        process.stdout.write(
          `✓ Uploaded ${result.attachment_ids.length} file${result.attachment_ids.length === 1 ? "" : "s"} and completed task ${taskId}\n`
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}
