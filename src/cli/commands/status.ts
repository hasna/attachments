import { Command } from "commander";
import { ListObjectsV2Command, S3Client as AWSS3Client } from "@aws-sdk/client-s3";
import { AttachmentsDB } from "../../core/db";
import { getConfig, CONFIG_PATH } from "../../core/config";
import { formatBytes } from "../utils";
import { join } from "path";
import { homedir } from "os";

async function checkS3Connection(config: ReturnType<typeof getConfig>): Promise<{
  connected: boolean;
  bucket: string;
  region: string;
}> {
  const { s3 } = config;
  if (!s3.bucket || !s3.region || !s3.accessKeyId || !s3.secretAccessKey) {
    return { connected: false, bucket: s3.bucket, region: s3.region };
  }

  try {
    const client = new AWSS3Client({
      region: s3.region,
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
      ...(s3.endpoint ? { endpoint: s3.endpoint, forcePathStyle: true } : {}),
    });

    await client.send(
      new ListObjectsV2Command({
        Bucket: s3.bucket,
        MaxKeys: 1,
      })
    );

    return { connected: true, bucket: s3.bucket, region: s3.region };
  } catch {
    return { connected: false, bucket: s3.bucket, region: s3.region };
  }
}

function getAttachmentStats(db: AttachmentsDB): {
  total: number;
  expired: number;
  totalSize: number;
} {
  const all = db.findAll({ includeExpired: true });
  const now = Date.now();
  let expired = 0;
  let totalSize = 0;

  for (const att of all) {
    totalSize += att.size;
    if (att.expiresAt !== null && att.expiresAt <= now) {
      expired++;
    }
  }

  return { total: all.length, expired, totalSize };
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show system status: S3 connection, attachment stats, config paths")
    .action(async () => {
      const config = getConfig();

      // S3 status
      const s3Status = await checkS3Connection(config);
      if (s3Status.connected) {
        process.stdout.write(
          `S3: \u2713 connected (${s3Status.bucket}, ${s3Status.region})\n`
        );
      } else if (!config.s3.bucket || !config.s3.region || !config.s3.accessKeyId || !config.s3.secretAccessKey) {
        process.stdout.write(`S3: \u2717 not configured\n`);
      } else {
        process.stdout.write(
          `S3: \u2717 connection failed (${s3Status.bucket}, ${s3Status.region})\n`
        );
      }

      // Attachment stats
      const dbPath = join(homedir(), ".attachments", "db.sqlite");
      const db = new AttachmentsDB();
      try {
        const stats = getAttachmentStats(db);
        if (stats.expired > 0) {
          process.stdout.write(
            `Attachments: ${stats.total} (${stats.expired} expired)\n`
          );
        } else {
          process.stdout.write(`Attachments: ${stats.total}\n`);
        }
        process.stdout.write(`Total size: ${formatBytes(stats.totalSize)}\n`);
      } finally {
        db.close();
      }

      // Paths
      process.stdout.write(`Config: ${CONFIG_PATH}\n`);
      process.stdout.write(`DB: ${dbPath}\n`);
    });
}
