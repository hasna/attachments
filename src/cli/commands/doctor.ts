import { Command } from "commander";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  S3Client as AWSS3Client,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getConfig, CONFIG_PATH } from "../../core/config";
import { AttachmentsDB } from "../../core/db";

// ---------------------------------------------------------------------------
// Check result types
// ---------------------------------------------------------------------------

export type CheckStatus = "ok" | "fail" | "warn";

export interface CheckResult {
  label: string;
  status: CheckStatus;
  message: string;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

export function checkConfigFile(): CheckResult {
  const exists = existsSync(CONFIG_PATH);
  return {
    label: "Config",
    status: exists ? "ok" : "fail",
    message: exists ? `${CONFIG_PATH} found` : `${CONFIG_PATH} not found`,
  };
}

export function checkS3Configured(): CheckResult {
  const config = getConfig();
  const { bucket, region, accessKeyId, secretAccessKey } = config.s3;
  const configured =
    !!bucket && !!region && !!accessKeyId && !!secretAccessKey;
  return {
    label: "S3",
    status: configured ? "ok" : "fail",
    message: configured
      ? `configured (${bucket}, ${region})`
      : "not configured (missing bucket, region, accessKeyId, or secretAccessKey)",
  };
}

export async function checkS3Connection(): Promise<CheckResult> {
  const config = getConfig();
  const { bucket, region, accessKeyId, secretAccessKey, endpoint } = config.s3;

  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    return {
      label: "S3 connection",
      status: "warn",
      message: "skipped (S3 not configured)",
    };
  }

  try {
    const s3 = new AWSS3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      ...(endpoint !== undefined
        ? { endpoint, forcePathStyle: true }
        : {}),
      requestHandler: {
        // 5 second timeout
        requestTimeout: 5000,
      } as unknown as ConstructorParameters<typeof AWSS3Client>[0]["requestHandler"],
    });

    await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 })
    );

    return {
      label: "S3 connection",
      status: "ok",
      message: "ok",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout =
      msg.toLowerCase().includes("timeout") ||
      msg.toLowerCase().includes("timed out") ||
      msg.toLowerCase().includes("timedout");
    return {
      label: "S3 connection",
      status: isTimeout ? "warn" : "fail",
      message: isTimeout ? `timeout reaching bucket "${bucket}"` : `failed: ${msg}`,
    };
  }
}

export function checkDatabase(): CheckResult {
  const dbPath = join(homedir(), ".hasna", "attachments", "db.sqlite");
  if (!existsSync(dbPath)) {
    return {
      label: "Database",
      status: "fail",
      message: `${dbPath} not found`,
    };
  }
  try {
    const db = new AttachmentsDB();
    const attachments = db.findAll({ includeExpired: true });
    db.close();
    return {
      label: "Database",
      status: "ok",
      message: `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      label: "Database",
      status: "fail",
      message: `query failed: ${msg}`,
    };
  }
}

export function checkExpiredLinks(): CheckResult {
  try {
    const db = new AttachmentsDB();
    const attachments = db.findAll({ includeExpired: true });
    db.close();
    const now = Date.now();
    const expired = attachments.filter(
      (a) => a.expiresAt !== null && a.expiresAt <= now
    );
    if (expired.length > 0) {
      return {
        label: "Expired links",
        status: "warn",
        message: `${expired.length} attachment${expired.length === 1 ? "" : "s"} have expired presigned links (run: attachments health-check --fix)`,
      };
    }
    return {
      label: "Expired links",
      status: "ok",
      message: "none",
    };
  } catch {
    return {
      label: "Expired links",
      status: "warn",
      message: "could not check (database unavailable)",
    };
  }
}

export async function checkMcpInstalled(): Promise<CheckResult> {
  try {
    const proc = Bun.spawn(["claude", "mcp", "list"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return {
        label: "MCP",
        status: "warn",
        message: "could not run 'claude mcp list' (is claude CLI installed?)",
      };
    }

    const registered =
      output.includes("attachments-mcp") || output.includes("attachments");
    return {
      label: "MCP",
      status: registered ? "ok" : "fail",
      message: registered
        ? "registered in Claude Code"
        : "not registered (run: attachments mcp --claude)",
    };
  } catch {
    return {
      label: "MCP",
      status: "warn",
      message: "could not check (claude CLI not found)",
    };
  }
}

export function checkVersion(version: string): CheckResult {
  return {
    label: "Version",
    status: "ok",
    message: version,
  };
}

export async function checkIntegration(name: string, urlEnvVar: string, defaultUrl: string): Promise<CheckResult> {
  const url = process.env[urlEnvVar] ?? defaultUrl;
  const isSet = !!process.env[urlEnvVar];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${url}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      return { label: `${name} integration (${urlEnvVar})`, status: "ok", message: `${url} — reachable` };
    }
    return { label: `${name} integration (${urlEnvVar})`, status: "warn", message: `${url} returned ${res.status}` };
  } catch {
    if (!isSet) {
      return { label: `${name} integration (${urlEnvVar})`, status: "warn", message: `not configured (set ${urlEnvVar} to enable)` };
    }
    return { label: `${name} integration (${urlEnvVar})`, status: "error", message: `${url} — unreachable` };
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

const ICONS: Record<CheckStatus, string> = {
  ok: "✓",
  fail: "✗",
  warn: "⚠",
};

export function formatResults(results: CheckResult[]): string {
  const lines = results.map(
    (r) => `  ${ICONS[r.status]} ${r.label}: ${r.message}`
  );
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI command
// ---------------------------------------------------------------------------

export function registerDoctor(program: Command): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkgVersion: string = (() => {
    try {
      return (require("../../../package.json") as { version: string }).version;
    } catch {
      return process.env.npm_package_version ?? "unknown";
    }
  })();

  program
    .command("doctor")
    .description("Run health checks and report the status of the attachments setup")
    .action(async () => {
      const results: CheckResult[] = [];

      results.push(checkConfigFile());
      results.push(checkS3Configured());
      results.push(await checkS3Connection());
      results.push(checkDatabase());
      results.push(checkExpiredLinks());
      results.push(await checkMcpInstalled());
      results.push(await checkIntegration("todos", "TODOS_URL", "http://localhost:19427"));
      results.push(await checkIntegration("sessions", "SESSIONS_URL", "http://localhost:3458"));
      results.push(checkVersion(pkgVersion));

      process.stdout.write(formatResults(results));

      const hasFail = results.some((r) => r.status === "fail");
      if (hasFail) {
        process.exit(1);
      }
    });
}
