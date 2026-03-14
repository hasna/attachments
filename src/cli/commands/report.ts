import { Command } from "commander";
import { AttachmentsDB, type Attachment } from "../../core/db";
import { formatBytes } from "../utils";

export interface ReportData {
  period: {
    days: number;
    since: number; // unix ms
  };
  uploads: {
    count: number;
    totalSize: number;
  };
  total: {
    count: number;
    totalSize: number;
  };
  expiringSoon: number; // within next 24h
  alreadyExpired: number;
  topTags: Array<{ tag: string; count: number }>;
  largestUploads: Array<{ id: string; filename: string; size: number }>;
}

export function computeReport(
  all: Attachment[],
  sinceMs: number,
  nowMs: number
): ReportData {
  const days = Math.round((nowMs - sinceMs) / (24 * 60 * 60 * 1000));
  const in24h = nowMs + 24 * 60 * 60 * 1000;

  // Period uploads
  const recent = all.filter((a) => a.createdAt >= sinceMs);
  const uploadsCount = recent.length;
  const uploadsTotalSize = recent.reduce((s, a) => s + a.size, 0);

  // Total
  const totalCount = all.length;
  const totalSize = all.reduce((s, a) => s + a.size, 0);

  // Expiring soon (within 24h from now, but not already expired)
  const expiringSoon = all.filter(
    (a) => a.expiresAt !== null && a.expiresAt > nowMs && a.expiresAt <= in24h
  ).length;

  // Already expired
  const alreadyExpired = all.filter(
    (a) => a.expiresAt !== null && a.expiresAt <= nowMs
  ).length;

  // Top 5 tags by count
  const tagCounts: Record<string, number> = {};
  for (const a of all) {
    if (a.tag) {
      tagCounts[a.tag] = (tagCounts[a.tag] ?? 0) + 1;
    }
  }
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag, count]) => ({ tag, count }));

  // Top 3 largest uploads (from all, not just recent)
  const largestUploads = [...all]
    .sort((a, b) => b.size - a.size)
    .slice(0, 3)
    .map((a) => ({ id: a.id, filename: a.filename, size: a.size }));

  return {
    period: { days, since: sinceMs },
    uploads: { count: uploadsCount, totalSize: uploadsTotalSize },
    total: { count: totalCount, totalSize },
    expiringSoon,
    alreadyExpired,
    topTags,
    largestUploads,
  };
}

export function formatCompact(report: ReportData): string {
  const lines: string[] = [];

  lines.push(
    `Last ${report.period.days} days: ${report.uploads.count} uploads (${formatBytes(report.uploads.totalSize)})`
  );
  lines.push(
    `Total stored: ${report.total.count} files (${formatBytes(report.total.totalSize)})`
  );
  lines.push(
    `Expiring in 24h: ${report.expiringSoon} | Already expired: ${report.alreadyExpired}`
  );

  if (report.topTags.length > 0) {
    const tagStr = report.topTags.map((t) => `${t.tag} (${t.count})`).join(", ");
    lines.push(`Top tags: ${tagStr}`);
  }

  if (report.largestUploads.length > 0) {
    const largestStr = report.largestUploads
      .map((u) => `${u.filename} (${formatBytes(u.size)})`)
      .join(", ");
    lines.push(`Largest: ${largestStr}`);
  }

  return lines.join("\n");
}

export function formatMarkdown(report: ReportData): string {
  const lines: string[] = [];
  const since = new Date(report.period.since).toISOString().slice(0, 10);

  lines.push(`## Attachments Report`);
  lines.push(``);
  lines.push(`### Activity (last ${report.period.days} days, since ${since})`);
  lines.push(``);
  lines.push(
    `- **Uploads**: ${report.uploads.count} files (${formatBytes(report.uploads.totalSize)})`
  );
  lines.push(``);
  lines.push(`### Storage`);
  lines.push(``);
  lines.push(
    `- **Total stored**: ${report.total.count} files (${formatBytes(report.total.totalSize)})`
  );
  lines.push(`- **Expiring in 24h**: ${report.expiringSoon}`);
  lines.push(`- **Already expired**: ${report.alreadyExpired}`);

  if (report.topTags.length > 0) {
    lines.push(``);
    lines.push(`### Top Tags`);
    lines.push(``);
    for (const t of report.topTags) {
      lines.push(`- \`${t.tag}\`: ${t.count} file${t.count !== 1 ? "s" : ""}`);
    }
  }

  if (report.largestUploads.length > 0) {
    lines.push(``);
    lines.push(`### Largest Uploads`);
    lines.push(``);
    for (const u of report.largestUploads) {
      lines.push(`- \`${u.id}\` — ${u.filename} (${formatBytes(u.size)})`);
    }
  }

  return lines.join("\n");
}

export function formatJson(report: ReportData): string {
  return JSON.stringify(report, null, 2);
}

export function registerReport(program: Command): void {
  program
    .command("report")
    .description("Show attachment activity report for a recent time window")
    .option("--days <n>", "Number of days to look back", "7")
    .option("--tag <tag>", "Filter by tag (e.g. project:open-attachments)")
    .option("--project <name>", "Shorthand for --tag project:<name>")
    .option(
      "--format <format>",
      "Output format: compact, json, or markdown",
      "compact"
    )
    .action((options) => {
      const days = parseInt(options.days as string, 10);
      const format = options.format as string;
      const tagFilter = options.project
        ? `project:${options.project as string}`
        : (options.tag as string | undefined);

      if (isNaN(days) || days < 1) {
        process.stderr.write(`Error: --days must be a positive integer\n`);
        process.exit(1);
      }

      if (!["compact", "json", "markdown"].includes(format)) {
        process.stderr.write(
          `Error: --format must be one of: compact, json, markdown\n`
        );
        process.exit(1);
      }

      const nowMs = Date.now();
      const sinceMs = nowMs - days * 24 * 60 * 60 * 1000;

      const db = new AttachmentsDB();
      try {
        // Fetch all including expired (we categorise them ourselves)
        const all = db.findAll({ includeExpired: true, tag: tagFilter });
        const report = computeReport(all, sinceMs, nowMs);

        let output: string;
        if (format === "json") {
          output = formatJson(report);
        } else if (format === "markdown") {
          output = formatMarkdown(report);
        } else {
          output = formatCompact(report);
        }

        process.stdout.write(output + "\n");
      } finally {
        db.close();
      }
    });
}
