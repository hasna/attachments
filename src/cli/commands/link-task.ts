import { Command } from "commander";
import { AttachmentsDB } from "../../core/db";

export interface LinkTaskOptions {
  todosUrl?: string;
}

export interface AttachmentMetaEntry {
  id: string;
  link: string | null;
  filename: string;
  size: number;
}

/**
 * Calls the todos REST API to patch task metadata with attachment info.
 * Uses native fetch — no todos-sdk dependency required.
 */
export async function linkAttachmentToTask(
  attachmentId: string,
  taskId: string,
  todosUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const db = new AttachmentsDB();
  let att: ReturnType<AttachmentsDB["findById"]>;
  try {
    att = db.findById(attachmentId);
  } finally {
    db.close();
  }

  if (!att) {
    throw new Error(`Attachment not found: ${attachmentId}`);
  }

  const entry: AttachmentMetaEntry = {
    id: att.id,
    link: att.link,
    filename: att.filename,
    size: att.size,
  };

  const url = `${todosUrl}/api/tasks/${taskId}`;
  const response = await fetchFn(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      metadata: {
        _attachments: [entry],
      },
    }),
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to update task ${taskId}: HTTP ${response.status}${body ? ` — ${body}` : ""}`
    );
  }
}

export function registerLinkTask(program: Command): void {
  program
    .command("link-task")
    .description("Link an attachment to a todos task")
    .argument("<attachment-id>", "Attachment ID (att_xxx)")
    .argument("<task-id>", "Task ID (e.g. TASK-001)")
    .option(
      "--todos-url <url>",
      "Todos REST server base URL",
      "http://localhost:3000"
    )
    .action(async (attachmentId: string, taskId: string, options: LinkTaskOptions) => {
      const todosUrl = options.todosUrl ?? "http://localhost:3000";

      try {
        await linkAttachmentToTask(attachmentId, taskId, todosUrl);
        process.stdout.write(`✓ Linked ${attachmentId} → task ${taskId}\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}
