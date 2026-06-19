import { Command } from "commander";
import {
  getConfig,
  setConfig,
  validateS3Config,
  type AttachmentsConfig,
  type DeepPartial,
} from "../../core/config";
import {
  S3Client as AWSS3Client,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

function maskSecret(value: string): string {
  if (!value) return "";
  return "****";
}

function configShowCommand(): Command {
  return new Command("show")
    .description("Print current configuration (secrets masked)")
    .action(() => {
      const config = getConfig();
      const masked = {
        s3: {
          ...config.s3,
          secretAccessKey: maskSecret(config.s3.secretAccessKey),
        },
        storage: config.storage,
        server: config.server,
        defaults: config.defaults,
        client: {
          ...config.client,
          apiToken: maskSecret(config.client.apiToken),
        },
        domains: config.domains,
        deployment: config.deployment,
      };
      process.stdout.write(JSON.stringify(masked, null, 2) + "\n");
    });
}

function configSetCommand(): Command {
  return new Command("set")
    .description("Update configuration values")
    .option("--bucket <bucket>", "S3 bucket name")
    .option("--region <region>", "AWS region")
    .option("--access-key <accessKeyId>", "AWS access key ID")
    .option("--secret-key <secretAccessKey>", "AWS secret access key")
    .option("--endpoint <endpoint>", "Custom S3 endpoint URL (for MinIO / LocalStack)")
    .option("--storage-backend <backend>", "Storage backend: auto, local, or s3")
    .option("--local-dir <path>", "Local object storage directory")
    .option("--max-size <bytes>", "Maximum upload size in bytes")
    .option("--port <port>", "Server port")
    .option("--host <host>", "Server bind host")
    .option("--base-url <baseUrl>", "Server base URL")
    .option("--public-path <path>", "Public attachment route prefix, e.g. /a")
    .option("--expiry <expiry>", "Default link expiry (e.g. 7d, 24h, 30m, never)")
    .option("--link-type <linkType>", "Default link type: presigned or server")
    .option("--client-mode <mode>", "Client mode: local or cloud")
    .option("--api-url <url>", "Cloud attachments API base URL")
    .option("--api-token <token>", "Cloud attachments API token")
    .option("--api-token-env <name>", "Environment variable name that contains the API token")
    .option("--internal-base-url <url>", "Internal LAN/Tailscale attachments base URL")
    .option("--internal-machine <id>", "Machine id to resolve for internal links")
    .option("--prefer-internal", "Prefer internal links when generating local server links")
    .action((options) => {
      const partial: DeepPartial<AttachmentsConfig> = {};

      if (
        options.bucket ||
        options.region ||
        options.accessKey ||
        options.secretKey ||
        options.endpoint
      ) {
        partial.s3 = {};
        if (options.bucket) partial.s3.bucket = options.bucket as string;
        if (options.region) partial.s3.region = options.region as string;
        if (options.accessKey) partial.s3.accessKeyId = options.accessKey as string;
        if (options.secretKey) partial.s3.secretAccessKey = options.secretKey as string;
        if (options.endpoint) partial.s3.endpoint = options.endpoint as string;
      }

      if (options.port || options.baseUrl) {
        partial.server = {};
        if (options.port) {
          const port = parseInt(options.port as string, 10);
          if (isNaN(port) || port < 1 || port > 65535) {
            process.stderr.write(`Error: --port must be a valid port number (1-65535)\n`);
            process.exit(1);
          }
          partial.server.port = port;
        }
        if (options.host) partial.server.host = options.host as string;
        if (options.baseUrl) partial.server.baseUrl = options.baseUrl as string;
        if (options.publicPath) partial.server.publicPath = options.publicPath as string;
      } else if (options.host || options.publicPath) {
        partial.server = {};
        if (options.host) partial.server.host = options.host as string;
        if (options.publicPath) partial.server.publicPath = options.publicPath as string;
      }

      if (options.storageBackend || options.localDir || options.maxSize) {
        partial.storage = {};
        if (options.storageBackend) {
          const backend = options.storageBackend as string;
          if (!["auto", "local", "s3"].includes(backend)) {
            process.stderr.write(`Error: --storage-backend must be one of: auto, local, s3\n`);
            process.exit(1);
          }
          partial.storage.backend = backend as "auto" | "local" | "s3";
        }
        if (options.localDir) partial.storage.localDir = options.localDir as string;
        if (options.maxSize) {
          const maxSize = parseInt(options.maxSize as string, 10);
          if (!Number.isFinite(maxSize) || maxSize <= 0) {
            process.stderr.write(`Error: --max-size must be a positive byte count\n`);
            process.exit(1);
          }
          partial.storage.maxSizeBytes = maxSize;
        }
      }

      if (options.expiry || options.linkType) {
        partial.defaults = {};
        if (options.expiry) partial.defaults.expiry = options.expiry as string;
        if (options.linkType) {
          const lt = options.linkType as string;
          if (lt !== "presigned" && lt !== "server") {
            process.stderr.write(`Error: --link-type must be one of: presigned, server\n`);
            process.exit(1);
          }
          partial.defaults.linkType = lt;
        }
      }

      if (
        options.clientMode ||
        options.apiUrl ||
        options.apiToken ||
        options.apiTokenEnv ||
        options.internalBaseUrl ||
        options.internalMachine ||
        options.preferInternal
      ) {
        partial.client = {};
        if (options.clientMode) {
          const mode = String(options.clientMode).toLowerCase();
          if (mode !== "local" && mode !== "cloud") {
            process.stderr.write(`Error: --client-mode must be one of: local, cloud\n`);
            process.exit(1);
          }
          partial.client.mode = mode as "local" | "cloud";
        }
        if (options.apiUrl) partial.client.apiBaseUrl = String(options.apiUrl).replace(/\/+$/, "");
        if (options.apiToken) partial.client.apiToken = String(options.apiToken);
        if (options.apiTokenEnv) partial.client.apiTokenEnv = String(options.apiTokenEnv);
        if (options.internalBaseUrl) partial.client.internalBaseUrl = String(options.internalBaseUrl).replace(/\/+$/, "");
        if (options.internalMachine) partial.client.internalMachineId = String(options.internalMachine);
        if (options.preferInternal) partial.client.preferInternal = true;
      }

      if (Object.keys(partial).length === 0) {
        process.stdout.write("No options provided. Use --help to see available options.\n");
        return;
      }

      setConfig(partial);
      process.stdout.write("✓ Configuration updated.\n");
    });
}

function configTestCommand(): Command {
  return new Command("test")
    .description("Test S3 connection by validating config and listing bucket objects")
    .action(async () => {
      let config;
      try {
        config = getConfig();
        validateS3Config(config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }

      process.stdout.write(`Testing S3 connection to bucket "${config.s3.bucket}"...\n`);

      try {
        const s3 = new AWSS3Client({
          region: config.s3.region,
          ...(config.s3.accessKeyId && config.s3.secretAccessKey
            ? {
                credentials: {
                  accessKeyId: config.s3.accessKeyId,
                  secretAccessKey: config.s3.secretAccessKey,
                },
              }
            : {}),
          ...(config.s3.endpoint !== undefined
            ? { endpoint: config.s3.endpoint, forcePathStyle: true }
            : {}),
        });

        const resp = await s3.send(
          new ListObjectsV2Command({
            Bucket: config.s3.bucket,
            Prefix: "attachments/",
            MaxKeys: 1,
          })
        );

        const count = resp.KeyCount ?? 0;
        process.stdout.write(
          `✓ Connection successful. Bucket "${config.s3.bucket}" is accessible ` +
            `(${count} object(s) checked).\n`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: S3 connection failed: ${message}\n`);
        process.exit(1);
      }
    });
}

export function configCommand(): Command {
  const cmd = new Command("config").description("Manage configuration");

  cmd.addCommand(configShowCommand());
  cmd.addCommand(configSetCommand());
  cmd.addCommand(configTestCommand());

  return cmd;
}
