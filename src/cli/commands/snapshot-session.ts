import { Command } from "commander";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { uploadFromBuffer } from "../../core/upload";
import { exitError } from "../utils";

const DEFAULT_SESSIONS_URL = "http://localhost:3458";

interface SessionMessage {
  role?: string;
  content?: string;
  text?: string;
  timestamp?: string | number;
  created_at?: string | number;
  [key: string]: unknown;
}

function formatAsMarkdown(sessionId: string, messages: SessionMessage[]): string {
  const lines: string[] = [`# Session Snapshot: ${sessionId}`, ""];
  for (const msg of messages) {
    const role = msg.role ?? "unknown";
    const content = msg.content ?? msg.text ?? JSON.stringify(msg);
    const ts = msg.timestamp ?? msg.created_at;
    const header = ts ? `### ${role} (${new Date(ts as string).toISOString()})` : `### ${role}`;
    lines.push(header, "", String(content), "");
  }
  return lines.join("\n");
}

function formatAsHtml(sessionId: string, messages: SessionMessage[]): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const body = messages
    .map((msg) => {
      const role = msg.role ?? "unknown";
      const content = String(msg.content ?? msg.text ?? JSON.stringify(msg));
      const ts = msg.timestamp ?? msg.created_at;
      const timeStr = ts ? ` <small>${new Date(ts as string).toISOString()}</small>` : "";
      return `<div class="message ${escape(role)}"><strong>${escape(role)}</strong>${timeStr}<p>${escape(content)}</p></div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Session: ${escape(sessionId)}</title>
<style>body{font-family:sans-serif;max-width:800px;margin:2rem auto}.message{border-bottom:1px solid #eee;padding:1rem}</style>
</head>
<body>
<h1>Session Snapshot: ${escape(sessionId)}</h1>
${body}
</body>
</html>`;
}

async function fetchSessionMessages(sessionId: string, sessionsUrl: string): Promise<SessionMessage[]> {
  // Try /api/sessions/:id/messages first, fall back to /api/sessions/:id
  const messagesUrl = `${sessionsUrl}/api/sessions/${sessionId}/messages`;
  const res = await fetch(messagesUrl);

  if (res.ok) {
    const data = await res.json() as unknown;
    if (Array.isArray(data)) return data as SessionMessage[];
    // Some APIs wrap in { messages: [...] } or { data: [...] }
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.messages)) return obj.messages as SessionMessage[];
    if (Array.isArray(obj.data)) return obj.data as SessionMessage[];
    return [{ role: "raw", content: JSON.stringify(data) }];
  }

  // Fallback: fetch the session itself
  const sessionUrl = `${sessionsUrl}/api/sessions/${sessionId}`;
  const res2 = await fetch(sessionUrl);
  if (!res2.ok) {
    throw new Error(`Failed to fetch session ${sessionId}: HTTP ${res2.status}`);
  }
  const data2 = await res2.json() as unknown;
  const obj2 = data2 as Record<string, unknown>;
  if (Array.isArray(obj2.messages)) return obj2.messages as SessionMessage[];
  return [{ role: "raw", content: JSON.stringify(data2) }];
}

export function registerSnapshotSession(program: Command): void {
  program
    .command("snapshot-session <session-id>")
    .description("Fetch a session transcript and upload it as an attachment")
    .option("--sessions-url <url>", "Sessions REST API base URL", DEFAULT_SESSIONS_URL)
    .option("--format <fmt>", "Output format: markdown or html", "markdown")
    .option("--expiry <time>", "Link expiry: e.g. 7d, 24h, never")
    .option("--tag <tag>", "Tag/label for the attachment")
    .action(
      async (
        sessionId: string,
        options: {
          sessionsUrl: string;
          format: string;
          expiry?: string;
          tag?: string;
        }
      ) => {
        const fmt = options.format === "html" ? "html" : "markdown";

        let messages: SessionMessage[];
        try {
          messages = await fetchSessionMessages(sessionId, options.sessionsUrl);
        } catch (err: unknown) {
          exitError(err instanceof Error ? err.message : String(err));
          return;
        }

        const content = fmt === "html"
          ? formatAsHtml(sessionId, messages)
          : formatAsMarkdown(sessionId, messages);

        const ext = fmt === "html" ? "html" : "md";
        const filename = `session-${sessionId}.${ext}`;
        const buffer = Buffer.from(content, "utf-8");

        let attachment;
        try {
          attachment = await uploadFromBuffer(buffer, filename, {
            expiry: options.expiry,
            tag: options.tag,
          });
        } catch (err: unknown) {
          exitError(err instanceof Error ? err.message : String(err));
          return;
        }

        process.stdout.write(
          `\u2713 Snapshot of session ${sessionId} \u2192 ${attachment.link ?? "(none)"} (${attachment.id})\n`
        );
      }
    );
}
