import { Command } from "commander";
import { AttachmentsDB, type Attachment } from "../../core/db";
import { S3Client } from "../../core/s3";
import { getConfig, parseExpiry } from "../../core/config";
import { generatePresignedLink, generateServerLink, getLinkType } from "../../core/links";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AttachmentStatus = "healthy" | "expired" | "dead" | "no-link";

export interface AttachmentHealthResult {
  id: string;
  filename: string;
  status: AttachmentStatus;
  link: string | null;
  expiresAt: number | null;
  /** ms since epoch when the link expired (only if status=expired) */
  expiredAgoMs?: number;
  /** whether it was fixed by --fix */
  fixed?: boolean;
  newLink?: string;
}

export interface HealthCheckSummary {
  healthy: number;
  expired: number;
  dead: number;
  noLink: number;
  fixed: number;
  total: number;
  results: AttachmentHealthResult[];
}

// ---------------------------------------------------------------------------
// Core logic (exported for MCP tool reuse)
// ---------------------------------------------------------------------------

/**
 * Check whether a URL is reachable via HEAD request.
 * Returns true if 2xx/3xx, false for 4xx/5xx or network error.
 */
export async function isLinkAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok || (res.status >= 300 && res.status < 400);
  } catch {
    return false;
  }
}

/**
 * Determine the status of a single attachment.
 */
export async function checkAttachment(
  att: Attachment,
  now: number
): Promise<AttachmentHealthResult> {
  // No link stored
  if (!att.link) {
    return { id: att.id, filename: att.filename, status: "no-link", link: null, expiresAt: att.expiresAt };
  }

  // Expired by timestamp
  if (att.expiresAt !== null && att.expiresAt <= now) {
    return {
      id: att.id,
      filename: att.filename,
      status: "expired",
      link: att.link,
      expiresAt: att.expiresAt,
      expiredAgoMs: now - att.expiresAt,
    };
  }

  // Live HEAD check
  const alive = await isLinkAlive(att.link);
  return {
    id: att.id,
    filename: att.filename,
    status: alive ? "healthy" : "dead",
    link: att.link,
    expiresAt: att.expiresAt,
  };
}

/**
 * Regenerate a presigned link for an attachment and update the DB.
 * Returns the new link.
 */
export async function regenerateLink(att: Attachment, db: AttachmentsDB): Promise<string> {
  const config = getConfig();
  const linkType = getLinkType(config);
  const expiryStr = config.defaults.expiry;
  const expiryMs = parseExpiry(expiryStr);
  const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;

  let link: string;
  if (linkType === "presigned") {
    const s3 = new S3Client(config.s3);
    link = await generatePresignedLink(s3, att.s3Key, expiryMs);
  } else {
    link = generateServerLink(att.id, config.server.baseUrl);
  }

  db.updateLink(att.id, link, expiresAt);
  return link;
}

/**
 * Run a full health check across all attachments.
 * If fix=true, regenerates expired links.
 */
export async function runHealthCheck(opts: { fix?: boolean } = {}): Promise<HealthCheckSummary> {
  const db = new AttachmentsDB();
  let attachments: Attachment[];
  try {
    attachments = db.findAll({ includeExpired: true });
  } catch (err) {
    db.close();
    throw err;
  }

  const now = Date.now();
  const results: AttachmentHealthResult[] = [];

  for (const att of attachments) {
    const result = await checkAttachment(att, now);

    if (opts.fix && result.status === "expired") {
      try {
        const newLink = await regenerateLink(att, db);
        result.fixed = true;
        result.newLink = newLink;
        result.status = "healthy";
      } catch {
        // If regeneration fails, keep as expired
      }
    }

    results.push(result);
  }

  db.close();

  const summary: HealthCheckSummary = {
    healthy: results.filter((r) => r.status === "healthy").length,
    expired: results.filter((r) => r.status === "expired").length,
    dead: results.filter((r) => r.status === "dead").length,
    noLink: results.filter((r) => r.status === "no-link").length,
    fixed: results.filter((r) => r.fixed).length,
    total: results.length,
    results,
  };

  return summary;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatExpiredAgo(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function compactOutput(summary: HealthCheckSummary): string {
  const parts: string[] = [];
  if (summary.healthy > 0) parts.push(`${summary.healthy} healthy`);
  if (summary.expired > 0) parts.push(`${summary.expired} expired`);
  if (summary.dead > 0) parts.push(`${summary.dead} dead`);
  if (summary.noLink > 0) parts.push(`${summary.noLink} no-link`);

  const lines: string[] = [];
  lines.push(`Attachment health: ${parts.join(", ") || "0 attachments"}`);

  for (const r of summary.results) {
    if (r.status === "expired" || r.fixed) {
      const ago = r.expiredAgoMs != null ? ` (expired ${formatExpiredAgo(r.expiredAgoMs)})` : "";
      const fixedNote = r.fixed ? " → regenerated" : "";
      lines.push(`  Expired: ${r.id} ${r.filename}${ago}${fixedNote}`);
    }
    if (r.status === "dead") {
      lines.push(`  Dead: ${r.id} ${r.filename} (link 404)`);
    }
    if (r.status === "no-link") {
      lines.push(`  No link: ${r.id} ${r.filename}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

export function registerHealthCheck(program: Command): void {
  program
    .command("health-check")
    .description("Validate attachment links — find expired, dead, or missing links")
    .option("--fix", "Regenerate presigned links for expired attachments", false)
    .option("--format <format>", "Output format: compact or json", "compact")
    .action(async (options: { fix?: boolean; format?: string }) => {
      const fix = !!options.fix;
      const format = (options.format ?? "compact") as string;

      if (!["compact", "json"].includes(format)) {
        process.stderr.write(`Error: --format must be one of: compact, json\n`);
        process.exit(1);
      }

      try {
        const summary = await runHealthCheck({ fix });

        if (format === "json") {
          process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
        } else {
          process.stdout.write(compactOutput(summary) + "\n");
        }

        // Exit with code 1 if there are dead or expired links (unfixed)
        if (summary.dead > 0 || summary.expired > 0) {
          process.exit(1);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}
