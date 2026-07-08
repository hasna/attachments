import { Command } from "commander";
import { resolveStore, type Store } from "../../core/store";

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
 * One evidence entry as persisted into the todos task metadata. This is the
 * exact shape `resolve-evidence` reads back from `metadata._evidence.attachments`,
 * so the two commands share a single contract.
 */
interface EvidenceAttachmentEntry {
  id: string;
  link: string | null;
  filename: string;
  size: number;
}

/**
 * Uploads files and completes a todos task with those attachments recorded as
 * retrievable evidence. Uses native fetch — no todos-sdk dependency required.
 *
 * The todos `POST /api/tasks/:id/complete` endpoint does NOT read a request body,
 * so attachment IDs sent there are silently discarded. To make the evidence
 * durable and retrievable (by `resolve-evidence`), we explicitly persist the full
 * attachment entries into the task's `metadata._evidence.attachments` via a PATCH,
 * merging with any existing metadata, before marking the task complete.
 */
export async function completeTaskWithFiles(
  taskId: string,
  filePaths: string[],
  options: {
    todosUrl?: string;
    expiry?: string;
    notes?: string;
  },
  storeFactory: () => Store = () => resolveStore(),
  fetchFn: typeof fetch = fetch
): Promise<CompleteTaskResult> {
  const todosUrl = options.todosUrl ?? "http://localhost:3000";

  // 1. Upload each file (via the Store) and collect the evidence entries.
  const attachment_ids: string[] = [];
  const links: Array<string | null> = [];
  const evidence: EvidenceAttachmentEntry[] = [];

  const store = storeFactory();
  try {
    for (const filePath of filePaths) {
      const attachment = await store.uploadFile(filePath, { expiry: options.expiry });
      attachment_ids.push(attachment.id);
      links.push(attachment.link);
      evidence.push({
        id: attachment.id,
        link: attachment.link,
        filename: attachment.filename,
        size: attachment.size,
      });
    }
  } finally {
    store.close();
  }

  const taskUrl = `${todosUrl}/api/tasks/${taskId}`;

  // 2. Read the current task so we can merge (not clobber) its metadata and honor
  //    optimistic concurrency via its version.
  const getResponse = await fetchFn(taskUrl);
  if (!getResponse.ok) {
    if (getResponse.status === 404) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const responseBody = await getResponse.text().catch(() => "");
    throw new Error(
      `Failed to fetch task ${taskId}: HTTP ${getResponse.status}${responseBody ? ` — ${responseBody}` : ""}`
    );
  }
  const task = (await getResponse.json()) as Record<string, unknown>;

  const existingMetadata =
    task.metadata && typeof task.metadata === "object"
      ? (task.metadata as Record<string, unknown>)
      : {};
  const existingEvidence =
    existingMetadata._evidence && typeof existingMetadata._evidence === "object"
      ? (existingMetadata._evidence as Record<string, unknown>)
      : {};
  const priorAttachments = Array.isArray(existingEvidence.attachments)
    ? (existingEvidence.attachments as EvidenceAttachmentEntry[])
    : [];

  const mergedMetadata: Record<string, unknown> = {
    ...existingMetadata,
    _evidence: {
      ...existingEvidence,
      attachments: [...priorAttachments, ...evidence],
      completed_at: new Date().toISOString(),
      ...(options.notes !== undefined ? { notes: options.notes } : {}),
    },
  };

  // 3. Persist the evidence into the task metadata.
  const patchBody: Record<string, unknown> = { metadata: mergedMetadata };
  if (typeof task.version === "number") {
    patchBody.version = task.version;
  }
  const patchResponse = await fetchFn(taskUrl, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patchBody),
  });
  if (!patchResponse.ok) {
    const responseBody = await patchResponse.text().catch(() => "");
    throw new Error(
      `Failed to persist attachment evidence for task ${taskId}: HTTP ${patchResponse.status}${responseBody ? ` — ${responseBody}` : ""}`
    );
  }

  // 4. Mark the task complete.
  const completeResponse = await fetchFn(`${taskUrl}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!completeResponse.ok) {
    if (completeResponse.status === 404) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const responseBody = await completeResponse.text().catch(() => "");
    throw new Error(
      `Failed to complete task ${taskId}: HTTP ${completeResponse.status}${responseBody ? ` — ${responseBody}` : ""}`
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
