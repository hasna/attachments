import { Command } from "commander";
import { existsSync } from "fs";
import { getConfig, CONFIG_PATH } from "../../core/config";
import { AttachmentsDB } from "../../core/db";

export function resolveWhoamiPackageVersion(
  requireFn: (id: string) => { version?: string } = require,
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    return requireFn("../../../package.json").version ?? env.npm_package_version ?? "unknown";
  } catch {
    return env.npm_package_version ?? "unknown";
  }
}

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("Show setup summary and environment status")
    .action(() => {
      const version = resolveWhoamiPackageVersion();

      const lines: string[] = [];
      lines.push(`@hasna/attachments v${version}`);

      // Config status
      const configExists = existsSync(CONFIG_PATH);
      if (!configExists) {
        lines.push(`Config: not found \u2717`);
        lines.push(`S3: not configured \u2717`);
        lines.push(`Server: http://localhost:3459`);
        lines.push(`Link type: presigned (default expiry: 7d)`);
        lines.push(`Attachments: 0 total, 0 expired`);
        process.stdout.write(lines.join("\n") + "\n");
        return;
      }

      const config = getConfig();
      lines.push(`Config: ${CONFIG_PATH} \u2713`);

      // S3 status
      if (config.s3.bucket && config.s3.region) {
        lines.push(`S3: ${config.s3.bucket} (${config.s3.region}) \u2713`);
      } else {
        lines.push(`S3: not configured \u2717`);
      }

      // Server
      lines.push(`Server: ${config.server.baseUrl}`);

      // Defaults
      lines.push(
        `Link type: ${config.defaults.linkType} (default expiry: ${config.defaults.expiry})`
      );

      // Attachment counts from DB
      try {
        const db = new AttachmentsDB();
        const all = db.findAll({ includeExpired: true });
        const now = Date.now();
        const expired = all.filter(
          (a) => a.expiresAt !== null && a.expiresAt <= now
        ).length;
        lines.push(`Attachments: ${all.length} total, ${expired} expired`);
        db.close();
      } catch {
        lines.push(`Attachments: unable to read database`);
      }

      process.stdout.write(lines.join("\n") + "\n");
    });
}
