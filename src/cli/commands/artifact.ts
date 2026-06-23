import { Command } from "commander";
import { AttachmentsDB, type Artifact, type Attachment } from "../../core/db";
import {
  BROWSERPLAN_DEFAULT_FLEET,
  BROWSERPLAN_DEFAULT_FLEET_EXCLUDES,
  artifactTag,
  artifactToJson,
  buildFleetInstallPlan,
  buildMacArtifactInstallPlan,
  downloadArtifact,
  inferArtifactKind,
  publishArtifact,
  registerArtifact,
  resolveArtifact,
  sha256File,
  verifyFileSha256,
  type ArtifactJson,
  type ResolvedArtifact,
} from "../../core/artifacts";
import {
  downloadFromCloud,
  getCloudArtifact,
  getCloudLatestArtifact,
  listCloudArtifacts,
  registerCloudArtifact,
  uploadFileToCloudApi,
  type ApiArtifact,
  type CloudArtifactFilters,
} from "../../core/api-client";
import { getConfig, isCloudClientMode } from "../../core/config";
import { formatBytes, exitError } from "../utils";

type OutputFormat = "human" | "json" | "shell";

function processArch(): string {
  return process.arch === "x64" || process.arch === "arm64" ? process.arch : "universal";
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseMetadata(values?: string[]): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const value of values ?? []) {
    const index = value.indexOf("=");
    if (index <= 0) throw new Error(`Invalid metadata entry '${value}'. Use key=value.`);
    metadata[value.slice(0, index)] = value.slice(index + 1);
  }
  return metadata;
}

function cloudToResolved(api: ApiArtifact): ResolvedArtifact {
  if (!api.attachment) throw new Error(`Artifact ${api.id} has no attachment metadata`);
  const artifact: Artifact = {
    id: api.id,
    attachmentId: api.attachment_id,
    name: api.name,
    version: api.version,
    channel: api.channel,
    platform: api.platform,
    arch: api.arch,
    kind: api.kind,
    filename: api.filename,
    size: api.size,
    checksumSha256: api.checksum_sha256,
    signature: api.signature,
    signatureType: api.signature_type,
    appName: api.app_name,
    metadata: api.metadata,
    createdAt: api.created_at,
  };
  const attachment: Attachment = {
    id: api.attachment.id,
    filename: api.attachment.filename,
    s3Key: "",
    bucket: "cloud",
    size: api.attachment.size,
    contentType: api.attachment.content_type,
    link: api.attachment.link,
    tag: null,
    expiresAt: api.attachment.expires_at,
    createdAt: api.attachment.created_at,
    storageBackend: "s3",
    status: "ready",
  };
  return { artifact, attachment };
}

function filtersFromOptions(options: {
  name?: string;
  version?: string;
  channel?: string;
  platform?: string;
  arch?: string;
  kind?: string;
  expired?: boolean;
  limit?: string;
}): CloudArtifactFilters {
  const limit = options.limit ? parseInt(options.limit, 10) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  return {
    name: options.name,
    version: options.version,
    channel: options.channel,
    platform: options.platform,
    arch: options.arch,
    kind: options.kind,
    includeExpired: options.expired,
    limit,
  };
}

function requireNameFilter(filters: CloudArtifactFilters, command: string): void {
  if (!filters.name) throw new Error(`${command} requires --name when no artifact id is provided`);
}

function writeArtifact(artifact: ArtifactJson | ApiArtifact, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(JSON.stringify(artifact, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    `${artifact.id} ${artifact.name}@${artifact.version} ${artifact.platform}/${artifact.arch} ` +
      `${artifact.kind} ${formatBytes(artifact.size)} ${artifact.checksum_sha256}\n`
  );
}

async function resolveForPlan(id: string | undefined, options: {
  name?: string;
  channel?: string;
  platform?: string;
  arch?: string;
  kind?: string;
}): Promise<ResolvedArtifact> {
  if (isCloudClientMode(getConfig())) {
    const api = id
      ? await getCloudArtifact(id)
      : await getCloudLatestArtifact({
          name: options.name,
          channel: options.channel,
          platform: options.platform,
          arch: options.arch,
          kind: options.kind,
        });
    return cloudToResolved(api);
  }
  return resolveArtifact({
    id,
    name: options.name,
    channel: options.channel,
    platform: options.platform,
    arch: options.arch,
    kind: options.kind,
  });
}

export function artifactCommand(): Command {
  const cmd = new Command("artifact")
    .description("Publish, resolve, download, and plan installs for versioned artifacts");

  cmd
    .command("publish <path>")
    .description("Upload a file and register it as a versioned artifact")
    .requiredOption("--name <name>", "Artifact name, e.g. browserplan")
    .requiredOption("--version <version>", "Artifact version")
    .option("--channel <channel>", "Release channel", "stable")
    .option("--platform <platform>", "Target platform", "darwin")
    .option("--arch <arch>", "Target architecture", processArch())
    .option("--kind <kind>", "Artifact kind: mac-app-zip, dmg, pkg, zip")
    .option("--app-name <name>", "Installed macOS app bundle name, e.g. BrowserPlan.app")
    .option("--expiry <time>", "Backing attachment link expiry", "never")
    .option("--link-type <type>", "Backing attachment link type: presigned or server", "server")
    .option("--signature <value>", "Expected signature identity or fingerprint")
    .option("--signature-type <type>", "Signature verifier type, e.g. codesign")
    .option("--metadata <key=value>", "Artifact metadata entry", collect, [] as string[])
    .option("--format <format>", "Output format: human or json", "human")
    .action(async (path: string, options) => {
      try {
        const kind = options.kind ?? inferArtifactKind(path);
        const metadata = parseMetadata(options.metadata);
        if (isCloudClientMode(getConfig())) {
          const channel = options.channel ?? "stable";
          const checksumSha256 = await sha256File(path);
          const attachment = await uploadFileToCloudApi(path, {
            expiry: options.expiry,
            linkType: options.linkType,
            tag: artifactTag({
              name: options.name,
              channel,
              platform: options.platform,
              arch: options.arch,
            }),
          });
          const artifact = await registerCloudArtifact({
            attachmentId: attachment.id,
            name: options.name,
            version: options.version,
            channel,
            platform: options.platform,
            arch: options.arch,
            kind,
            checksumSha256,
            signature: options.signature ?? null,
            signatureType: options.signatureType ?? null,
            appName: options.appName ?? null,
            metadata,
          });
          writeArtifact(artifact, options.format);
          return;
        }
        const resolved = await publishArtifact(path, {
          name: options.name,
          version: options.version,
          channel: options.channel,
          platform: options.platform,
          arch: options.arch,
          kind,
          appName: options.appName ?? null,
          expiry: options.expiry,
          linkType: options.linkType,
          signature: options.signature ?? null,
          signatureType: options.signatureType ?? null,
          metadata,
        });
        writeArtifact(artifactToJson(resolved.artifact, resolved.attachment), options.format);
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      }
    });

  cmd
    .command("register")
    .description("Register an existing attachment as a versioned artifact")
    .requiredOption("--attachment-id <id>", "Backing attachment id")
    .requiredOption("--name <name>", "Artifact name")
    .requiredOption("--version <version>", "Artifact version")
    .option("--channel <channel>", "Release channel", "stable")
    .option("--platform <platform>", "Target platform", "darwin")
    .option("--arch <arch>", "Target architecture", processArch())
    .requiredOption("--kind <kind>", "Artifact kind")
    .requiredOption("--checksum-sha256 <sha>", "Expected SHA-256 checksum")
    .option("--app-name <name>", "Installed macOS app bundle name")
    .option("--signature <value>", "Expected signature identity or fingerprint")
    .option("--signature-type <type>", "Signature verifier type")
    .option("--metadata <key=value>", "Artifact metadata entry", collect, [] as string[])
    .option("--format <format>", "Output format: human or json", "human")
    .action(async (options) => {
      try {
        const metadata = parseMetadata(options.metadata);
        if (isCloudClientMode(getConfig())) {
          const artifact = await registerCloudArtifact({
            attachmentId: options.attachmentId,
            name: options.name,
            version: options.version,
            channel: options.channel,
            platform: options.platform,
            arch: options.arch,
            kind: options.kind,
            checksumSha256: options.checksumSha256,
            signature: options.signature ?? null,
            signatureType: options.signatureType ?? null,
            appName: options.appName ?? null,
            metadata,
          });
          writeArtifact(artifact, options.format);
          return;
        }
        const resolved = registerArtifact({
          attachmentId: options.attachmentId,
          name: options.name,
          version: options.version,
          channel: options.channel,
          platform: options.platform,
          arch: options.arch,
          kind: options.kind,
          checksumSha256: options.checksumSha256,
          signature: options.signature ?? null,
          signatureType: options.signatureType ?? null,
          appName: options.appName ?? null,
          metadata,
        });
        writeArtifact(artifactToJson(resolved.artifact, resolved.attachment), options.format);
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      }
    });

  cmd
    .command("list")
    .description("List registered artifacts")
    .option("--name <name>", "Filter by artifact name")
    .option("--version <version>", "Filter by version")
    .option("--channel <channel>", "Filter by channel")
    .option("--platform <platform>", "Filter by platform")
    .option("--arch <arch>", "Filter by architecture")
    .option("--kind <kind>", "Filter by kind")
    .option("--expired", "Include expired backing attachments", false)
    .option("--limit <n>", "Maximum number of artifacts", "20")
    .option("--format <format>", "Output format: human or json", "human")
    .action(async (options) => {
      try {
        const filters = filtersFromOptions(options);
        if (isCloudClientMode(getConfig())) {
          const artifacts = await listCloudArtifacts(filters);
          if (options.format === "json") process.stdout.write(JSON.stringify(artifacts, null, 2) + "\n");
          else for (const artifact of artifacts) writeArtifact(artifact, "human");
          return;
        }
        const db = new AttachmentsDB();
        try {
          const artifacts = db.findArtifacts(filters);
          const json = artifacts.map((artifact) => artifactToJson(artifact, db.findById(artifact.attachmentId)));
          if (options.format === "json") process.stdout.write(JSON.stringify(json, null, 2) + "\n");
          else for (const artifact of json) writeArtifact(artifact, "human");
        } finally {
          db.close();
        }
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      }
    });

  cmd
    .command("latest")
    .description("Resolve the latest artifact for a name/channel/platform/arch")
    .requiredOption("--name <name>", "Artifact name")
    .option("--channel <channel>", "Release channel", "stable")
    .option("--platform <platform>", "Target platform", "darwin")
    .option("--arch <arch>", "Target architecture", processArch())
    .option("--kind <kind>", "Artifact kind")
    .option("--format <format>", "Output format: human or json", "human")
    .action(async (options) => {
      try {
        if (isCloudClientMode(getConfig())) {
          const artifact = await getCloudLatestArtifact(filtersFromOptions(options));
          writeArtifact(artifact, options.format);
          return;
        }
        const resolved = resolveArtifact(filtersFromOptions(options));
        writeArtifact(artifactToJson(resolved.artifact, resolved.attachment), options.format);
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      }
    });

  cmd
    .command("download [artifact-id]")
    .description("Download an artifact and verify its checksum by default")
    .option("--name <name>", "Artifact name for latest resolution")
    .option("--channel <channel>", "Release channel", "stable")
    .option("--platform <platform>", "Target platform", "darwin")
    .option("--arch <arch>", "Target architecture", processArch())
    .option("--kind <kind>", "Artifact kind")
    .option("--output <path>", "Destination directory or filename")
    .option("--password <password>", "Password for protected backing attachments")
    .option("--no-verify", "Skip SHA-256 verification")
    .option("--brief", "Print only the downloaded path")
    .option("--format <format>", "Output format: human or json", "human")
    .action(async (id: string | undefined, options) => {
      try {
        if (!id) requireNameFilter(filtersFromOptions(options), "artifact download");
        if (isCloudClientMode(getConfig())) {
          const artifact = id
            ? await getCloudArtifact(id)
            : await getCloudLatestArtifact(filtersFromOptions(options));
          const result = await downloadFromCloud(artifact.attachment_id, options.output, { password: options.password });
          if (options.verify !== false) await verifyFileSha256(result.path, artifact.checksum_sha256);
          if (options.brief) {
            process.stdout.write(`${result.path}\n`);
          } else if (options.format === "json") {
            process.stdout.write(JSON.stringify({ artifact, download: result }, null, 2) + "\n");
          } else {
            process.stdout.write(`Downloaded ${artifact.name}@${artifact.version} -> ${result.path} (${formatBytes(result.size)})\n`);
          }
          return;
        }
        const downloaded = await downloadArtifact({
          id,
          ...filtersFromOptions(options),
          output: options.output,
          verify: options.verify,
          password: options.password,
        });
        if (options.brief) {
          process.stdout.write(`${downloaded.download.path}\n`);
        } else if (options.format === "json") {
          process.stdout.write(JSON.stringify({
            artifact: artifactToJson(downloaded.artifact, downloaded.attachment),
            download: downloaded.download,
          }, null, 2) + "\n");
        } else {
          process.stdout.write(
            `Downloaded ${downloaded.artifact.name}@${downloaded.artifact.version} -> ` +
              `${downloaded.download.path} (${formatBytes(downloaded.download.size)})\n`
          );
        }
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      }
    });

  cmd
    .command("install-plan [artifact-id]")
    .description("Generate a macOS install/update plan and optional open-machines fleet commands")
    .option("--name <name>", "Artifact name for latest resolution")
    .option("--channel <channel>", "Release channel", "stable")
    .option("--platform <platform>", "Target platform", "darwin")
    .option("--arch <arch>", "Target architecture", processArch())
    .option("--kind <kind>", "Artifact kind")
    .option("--app-name <name>", "Installed macOS app bundle name")
    .option("--install-dir <path>", "Install directory", "/Applications")
    .option("--attachments-bin <path>", "attachments binary to use on target machines", "attachments")
    .option("--machines <targets>", "Comma-separated machines or ranges, e.g. machine001-machine011")
    .option("--exclude <targets>", "Comma-separated machines or ranges to exclude")
    .option("--browserplan-fleet", "Use BrowserPlan fleet default: machine001-machine011 excluding spark01/spark02", false)
    .option("--format <format>", "Output format: json or shell", "json")
    .action(async (id: string | undefined, options) => {
      try {
        if (!id) requireNameFilter(filtersFromOptions(options), "artifact install-plan");
        const resolved = await resolveForPlan(id, options);
        const installPlan = buildMacArtifactInstallPlan(resolved, {
          appName: options.appName,
          installDir: options.installDir,
          attachmentsBin: options.attachmentsBin,
        });
        const machines = options.browserplanFleet ? BROWSERPLAN_DEFAULT_FLEET : options.machines;
        if (options.format === "shell") {
          process.stdout.write(`${installPlan.install_script}\n`);
          return;
        }
        if (machines) {
          const exclude = options.browserplanFleet
            ? BROWSERPLAN_DEFAULT_FLEET_EXCLUDES
            : options.exclude;
          process.stdout.write(JSON.stringify(buildFleetInstallPlan(installPlan, { machines, exclude }), null, 2) + "\n");
          return;
        }
        process.stdout.write(JSON.stringify(installPlan, null, 2) + "\n");
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      }
    });

  return cmd;
}
