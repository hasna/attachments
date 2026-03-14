import { Command } from "commander";
import { AttachmentsDB } from "../../core/db";
import { checkAttachment, regenerateLink } from "./health-check";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchOptions {
  todosUrl?: string;
  events?: string;
  verbose?: boolean;
}

export interface TaskCompletedEvent {
  type: string;
  task_id?: string;
  id?: string;
  metadata?: {
    _evidence?: {
      attachments?: string[];
    };
  };
}

export interface HandleTaskEventResult {
  taskId: string;
  checked: number;
  regenerated: number;
}

// ---------------------------------------------------------------------------
// Core event handler (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Handle a `task.completed` event: look up each attachment_id in the local DB,
 * check if its link is expired or dead, regenerate if needed.
 *
 * Returns a summary: how many attachments were checked and how many regenerated.
 */
export async function handleTaskEvent(
  event: TaskCompletedEvent,
  opts: { verbose?: boolean } = {},
  dbFactory: () => AttachmentsDB = () => new AttachmentsDB()
): Promise<HandleTaskEventResult | null> {
  const taskId = event.task_id ?? event.id ?? "unknown";

  const attachmentIds = event.metadata?._evidence?.attachments;
  if (!attachmentIds || attachmentIds.length === 0) {
    if (opts.verbose) {
      process.stdout.write(`[watch] Task ${taskId} completed — no attachments\n`);
    }
    return null;
  }

  const db = dbFactory();
  let checked = 0;
  let regenerated = 0;

  try {
    const now = Date.now();

    for (const id of attachmentIds) {
      const att = db.findById(id);
      if (!att) {
        if (opts.verbose) {
          process.stdout.write(`[watch] Attachment ${id} not found in local DB — skipping\n`);
        }
        continue;
      }

      checked++;
      const result = await checkAttachment(att, now);

      if (result.status === "expired" || result.status === "dead") {
        try {
          await regenerateLink(att, db);
          regenerated++;
          if (opts.verbose) {
            process.stdout.write(
              `[watch] Regenerated link for ${id} (was ${result.status})\n`
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[watch] Failed to regenerate link for ${id}: ${msg}\n`);
        }
      }
    }
  } finally {
    db.close();
  }

  process.stdout.write(
    `[watch] Task ${taskId} completed — checked ${checked} attachment${checked === 1 ? "" : "s"}${regenerated > 0 ? ` (${regenerated} regenerated)` : ""}\n`
  );

  return { taskId, checked, regenerated };
}

// ---------------------------------------------------------------------------
// SSE stream consumer
// ---------------------------------------------------------------------------

/**
 * Parse a raw SSE text block (one or more "field: value\n" lines) into a
 * { event, data } pair. Returns null if the block has no `data:` field.
 */
export function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  let data = "";

  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data = line.slice("data:".length).trim();
    }
  }

  if (!data) return null;
  return { event, data };
}

/**
 * Connect to the todos SSE endpoint and process events until the signal is
 * aborted.  On network error, waits `backoffMs` before reconnecting (capped
 * at `maxBackoffMs`).
 */
export async function connectAndWatch(
  url: string,
  opts: { verbose?: boolean } = {},
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
  dbFactory: () => AttachmentsDB = () => new AttachmentsDB(),
  sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
  let backoffMs = 5000;
  const maxBackoffMs = 60_000;

  while (!signal?.aborted) {
    try {
      if (opts.verbose) {
        process.stdout.write(`[watch] Connecting to ${url}\n`);
      }

      const response = await fetchFn(url, { signal });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      // Reset backoff on successful connect
      backoffMs = 5000;

      process.stdout.write(`[watch] Connected — listening for task events\n`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!signal?.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE blocks are separated by double newlines
        const blocks = buffer.split(/\n\n/);
        // Keep the last (possibly incomplete) block in the buffer
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const trimmed = block.trim();
          if (!trimmed) continue;

          const parsed = parseSseBlock(trimmed);
          if (!parsed) continue;

          if (opts.verbose) {
            process.stdout.write(`[watch] Event: ${parsed.event} — ${parsed.data}\n`);
          }

          if (parsed.event === "task.completed") {
            try {
              const payload = JSON.parse(parsed.data) as TaskCompletedEvent;
              payload.type = parsed.event;
              await handleTaskEvent(payload, opts, dbFactory);
            } catch (parseErr) {
              const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
              process.stderr.write(`[watch] Failed to parse event data: ${msg}\n`);
            }
          }
        }
      }

      reader.cancel();
    } catch (err: unknown) {
      if (signal?.aborted) break;

      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[watch] Stream error: ${msg} — reconnecting in ${backoffMs / 1000}s\n`
      );

      await sleepFn(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

export function registerWatch(program: Command): void {
  program
    .command("watch")
    .description("Subscribe to todos SSE events and auto-validate attachment links")
    .option(
      "--todos-url <url>",
      "Todos REST server base URL",
      "http://localhost:3000"
    )
    .option(
      "--events <list>",
      "Comma-separated list of SSE events to subscribe to",
      "task.completed"
    )
    .option("--verbose", "Log all events received, not just ones with attachments", false)
    .action(async (options: WatchOptions) => {
      const todosUrl = options.todosUrl ?? "http://localhost:3000";
      const events = options.events ?? "task.completed";
      const verbose = !!options.verbose;

      const params = new URLSearchParams({ events });
      const url = `${todosUrl}/api/tasks/stream?${params.toString()}`;

      const controller = new AbortController();

      // Graceful shutdown on SIGINT / SIGTERM
      const onSignal = () => {
        process.stdout.write("\n[watch] Shutting down…\n");
        controller.abort();
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);

      try {
        await connectAndWatch(url, { verbose }, controller.signal);
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    });
}
