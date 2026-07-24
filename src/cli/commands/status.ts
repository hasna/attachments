import { Command } from "commander";
import { ListObjectsV2Command, S3Client as AWSS3Client } from "@aws-sdk/client-s3";
import type { Attachment } from "../../core/db";
import { getConfig, hasS3Config, CONFIG_PATH } from "../../core/config";
import { resolveStore } from "../../core/store";
import { formatBytes } from "../utils";
import { join } from "path";
import { homedir } from "os";

async function checkS3Connection(config: ReturnType<typeof getConfig>): Promise<{
  connected: boolean;
  bucket: string;
  region: string;
}> {
  const { s3 } = config;
  if (!hasS3Config(config)) {
    return { connected: false, bucket: s3.bucket, region: s3.region };
  }

  try {
    const staticCredentials =
      s3.accessKeyId && s3.secretAccessKey
        ? {
            credentials: {
              accessKeyId: s3.accessKeyId,
              secretAccessKey: s3.secretAccessKey,
            },
          }
        : {};
    const client = new AWSS3Client({
      region: s3.region,
      ...staticCredentials,
      ...(s3.endpoint ? { endpoint: s3.endpoint, forcePathStyle: true } : {}),
    });

    await client.send(
      new ListObjectsV2Command({
        Bucket: s3.bucket,
        Prefix: "attachments/",
        MaxKeys: 1,
      })
    );

    return { connected: true, bucket: s3.bucket, region: s3.region };
  } catch {
    return { connected: false, bucket: s3.bucket, region: s3.region };
  }
}

function computeStats(all: Attachment[]): { total: number; expired: number; totalSize: number } {
  const now = Date.now();
  let expired = 0;
  let totalSize = 0;
  for (const att of all) {
    totalSize += att.size;
    if (att.expiresAt !== null && att.expiresAt <= now) expired++;
  }
  return { total: all.length, expired, totalSize };
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show system status: S3 connection, attachment stats, config paths")
    .action(async () => {
      const config = getConfig();
      const store = resolveStore();
      if (store.transport === "cloud-http") {
        try {
          const rows = await store.list({ limit: 1 });
          process.stdout.write(`Mode: self_hosted/cloud (/v1)\n`);
          process.stdout.write(`API: ${store.baseUrl}\n`);
          process.stdout.write(`Health: reachable (list ok, ${rows.length >= 0 ? "authorized" : "unknown"})\n`);
          process.stdout.write(`Config: ${CONFIG_PATH}\n`);
        } catch (error) {
          process.stdout.write(`Mode: self_hosted/cloud (/v1)\n`);
          process.stdout.write(`API: ${store.baseUrl}\n`);
          process.stdout.write(`Health: connection failed (${error instanceof Error ? error.message : String(error)})\n`);
          process.stdout.write(`Config: ${CONFIG_PATH}\n`);
        } finally {
          store.close();
        }
        return;
      }

      // S3 status
      const s3Status = await checkS3Connection(config);
      if (s3Status.connected) {
        process.stdout.write(
          `S3: \u2713 connected (${s3Status.bucket}, ${s3Status.region})\n`
        );
      } else if (!hasS3Config(config)) {
        process.stdout.write(`S3: \u2717 not configured\n`);
      } else {
        process.stdout.write(
          `S3: \u2717 connection failed (${s3Status.bucket}, ${s3Status.region})\n`
        );
      }

      // Attachment stats
      const dbPath = join(homedir(), ".hasna", "attachments", "db.sqlite");
      try {
        const stats = computeStats(await store.list({ includeExpired: true }));
        if (stats.expired > 0) {
          process.stdout.write(
            `Attachments: ${stats.total} (${stats.expired} expired)\n`
          );
        } else {
          process.stdout.write(`Attachments: ${stats.total}\n`);
        }
        process.stdout.write(`Total size: ${formatBytes(stats.totalSize)}\n`);
      } finally {
        store.close();
      }

      // Paths
      process.stdout.write(`Config: ${CONFIG_PATH}\n`);
      process.stdout.write(`DB: ${dbPath}\n`);
    });
}
