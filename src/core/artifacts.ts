import { createHash } from "crypto";
import { createReadStream } from "fs";
import { basename, isAbsolute, join, normalize } from "path";
import { nanoid } from "nanoid";
import { uploadFile, type UploadOptions } from "./upload";
import { downloadAttachment, type DownloadOptions, type DownloadResult } from "./download";
import { AttachmentsDB, type Artifact, type ArtifactFilters, type Attachment } from "./db";

export const ARTIFACT_CONTRACT_VERSION = 1;
export const BROWSERPLAN_DEFAULT_FLEET = "machine001-machine011";
export const BROWSERPLAN_DEFAULT_FLEET_EXCLUDES = ["spark01", "spark02"];

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHECKSUM_RE = /^[a-fA-F0-9]{64}$/;
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,126}\.app$/;

export interface ArtifactAttachmentJson {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  link: string | null;
  expires_at: number | null;
  created_at: number;
}

export interface ArtifactJson {
  contract_version: number;
  id: string;
  attachment_id: string;
  name: string;
  version: string;
  channel: string;
  platform: string;
  arch: string;
  kind: string;
  filename: string;
  size: number;
  checksum_sha256: string;
  signature: string | null;
  signature_type: string | null;
  app_name: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  attachment: ArtifactAttachmentJson | null;
}

export interface ArtifactDeps {
  db?: InstanceType<typeof AttachmentsDB>;
}

export interface ArtifactIdentity {
  name: string;
  version: string;
  channel?: string;
  platform: string;
  arch: string;
  kind: string;
}

export interface RegisterArtifactOptions extends ArtifactIdentity {
  attachmentId: string;
  checksumSha256: string;
  signature?: string | null;
  signatureType?: string | null;
  appName?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PublishArtifactOptions extends ArtifactIdentity {
  expiry?: string;
  linkType?: UploadOptions["linkType"];
  password?: string;
  maxDownloads?: number;
  baseUrl?: string;
  signature?: string | null;
  signatureType?: string | null;
  appName?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ResolvedArtifact {
  artifact: Artifact;
  attachment: Attachment;
}

export interface DownloadArtifactOptions extends ArtifactFilters {
  id?: string;
  output?: string;
  verify?: boolean;
  password?: string;
}

export interface DownloadedArtifact {
  artifact: Artifact;
  attachment: Attachment;
  download: DownloadResult;
}

export interface InstallStep {
  id: string;
  description: string;
  command: string;
  mutates: boolean;
  requires_sudo: boolean;
}

export interface ArtifactInstallPlan {
  contract_version: number;
  os: "macos";
  artifact: ArtifactJson;
  app_name: string | null;
  install_dir: string;
  target_path: string | null;
  attachments_bin: string;
  install_script: string;
  steps: InstallStep[];
}

export interface FleetInstallPlan {
  contract_version: number;
  target_machines: string[];
  excluded_machines: string[];
  install_plan: ArtifactInstallPlan;
  open_machines: {
    command_template: string;
    commands: Array<{
      machine_id: string;
      remote_command: string;
      route_command: string;
    }>;
  };
}

export interface BuildInstallPlanOptions {
  appName?: string;
  installDir?: string;
  attachmentsBin?: string;
}

function normalizeSlug(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SLUG_RE.test(trimmed)) {
    throw new Error(`${label} must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens`);
  }
  return trimmed;
}

function normalizeArtifactIdentity(input: ArtifactIdentity): Required<ArtifactIdentity> {
  const version = input.version.trim();
  if (!version) throw new Error("version is required");
  if (!SEMVER_RE.test(version)) {
    throw new Error("version must be a semantic version like 1.2.3, 1.2.3-beta.1, or v1.2.3");
  }
  return {
    name: normalizeSlug(input.name, "name"),
    version,
    channel: normalizeSlug(input.channel ?? "stable", "channel"),
    platform: normalizeSlug(input.platform, "platform"),
    arch: normalizeSlug(input.arch, "arch"),
    kind: normalizeSlug(input.kind, "kind"),
  };
}

function normalizeChecksum(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!CHECKSUM_RE.test(trimmed)) {
    throw new Error("checksum_sha256 must be a 64-character hex SHA-256 digest");
  }
  return trimmed;
}

export function artifactTag(input: {
  name: string;
  channel: string;
  platform: string;
  arch: string;
}): string {
  return `artifact:${input.name}:${input.channel}:${input.platform}:${input.arch}`;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return hash.digest("hex");
}

export async function verifyFileSha256(path: string, expectedSha256: string): Promise<string> {
  const expected = normalizeChecksum(expectedSha256);
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${path}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

export function artifactToJson(artifact: Artifact, attachment?: Attachment | null): ArtifactJson {
  return {
    contract_version: ARTIFACT_CONTRACT_VERSION,
    id: artifact.id,
    attachment_id: artifact.attachmentId,
    name: artifact.name,
    version: artifact.version,
    channel: artifact.channel,
    platform: artifact.platform,
    arch: artifact.arch,
    kind: artifact.kind,
    filename: artifact.filename,
    size: artifact.size,
    checksum_sha256: artifact.checksumSha256,
    signature: artifact.signature,
    signature_type: artifact.signatureType,
    app_name: artifact.appName,
    metadata: artifact.metadata,
    created_at: artifact.createdAt,
    attachment: attachment
      ? {
          id: attachment.id,
          filename: attachment.filename,
          size: attachment.size,
          content_type: attachment.contentType,
          link: attachment.link,
          expires_at: attachment.expiresAt,
          created_at: attachment.createdAt,
        }
      : null,
  };
}

export async function publishArtifact(
  path: string,
  options: PublishArtifactOptions,
  deps: ArtifactDeps = {}
): Promise<ResolvedArtifact> {
  const identity = normalizeArtifactIdentity(options);
  const checksumSha256 = await sha256File(path);
  const db = deps.db ?? new AttachmentsDB();
  try {
    const attachment = await uploadFile(
      path,
      {
        expiry: options.expiry ?? "never",
        linkType: options.linkType ?? "server",
        password: options.password,
        maxDownloads: options.maxDownloads,
        baseUrl: options.baseUrl,
        tag: artifactTag(identity),
      },
      { db }
    );
    const artifact = registerArtifactRecord(attachment, {
      ...identity,
      checksumSha256,
      signature: options.signature ?? null,
      signatureType: options.signatureType ?? null,
      appName: options.appName ?? null,
      metadata: options.metadata ?? {},
    });
    db.insertArtifact(artifact);
    return { artifact, attachment };
  } finally {
    if (!deps.db) db.close();
  }
}

export function registerArtifact(
  options: RegisterArtifactOptions,
  deps: ArtifactDeps = {}
): ResolvedArtifact {
  const identity = normalizeArtifactIdentity(options);
  const checksumSha256 = normalizeChecksum(options.checksumSha256);
  const db = deps.db ?? new AttachmentsDB();
  try {
    const attachment = db.findById(options.attachmentId);
    if (!attachment) throw new Error(`Attachment not found: ${options.attachmentId}`);
    const artifact = registerArtifactRecord(attachment, {
      ...identity,
      checksumSha256,
      signature: options.signature ?? null,
      signatureType: options.signatureType ?? null,
      appName: options.appName ?? null,
      metadata: options.metadata ?? {},
    });
    db.insertArtifact(artifact);
    return { artifact, attachment };
  } finally {
    if (!deps.db) db.close();
  }
}

function registerArtifactRecord(
  attachment: Attachment,
  input: Required<ArtifactIdentity> & {
    checksumSha256: string;
    signature: string | null;
    signatureType: string | null;
    appName: string | null;
    metadata: Record<string, unknown>;
  }
): Artifact {
  return {
    id: `art_${nanoid(10)}`,
    attachmentId: attachment.id,
    name: input.name,
    version: input.version,
    channel: input.channel,
    platform: input.platform,
    arch: input.arch,
    kind: input.kind,
    filename: attachment.filename,
    size: attachment.size,
    checksumSha256: normalizeChecksum(input.checksumSha256),
    signature: input.signature,
    signatureType: input.signatureType,
    appName: normalizeAppName(input.appName),
    metadata: input.metadata,
    createdAt: Date.now(),
  };
}

function parseSemver(value: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
} | null {
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

function comparePrerelease(left: string[] | null, right: string[] | null): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const a = left[i];
    const b = right[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumber = /^\d+$/.test(a) ? Number(a) : null;
    const bNumber = /^\d+$/.test(b) ? Number(b) : null;
    if (aNumber !== null && bNumber !== null && aNumber !== bNumber) return aNumber - bNumber;
    if (aNumber !== null && bNumber === null) return -1;
    if (aNumber === null && bNumber !== null) return 1;
    const lexical = a.localeCompare(b);
    if (lexical !== 0) return lexical;
  }
  return 0;
}

export function compareArtifactVersions(left: string, right: string): number {
  const semverLeft = parseSemver(left);
  const semverRight = parseSemver(right);
  if (!semverLeft || !semverRight) {
    throw new Error("Artifact versions must be semantic versions");
  }
  for (const key of ["major", "minor", "patch"] as const) {
    const diff = semverLeft[key] - semverRight[key];
    if (diff !== 0) return diff;
  }
  return comparePrerelease(semverLeft.prerelease, semverRight.prerelease);
}

export function chooseLatestArtifact(artifacts: Artifact[]): Artifact | null {
  return [...artifacts].sort((left, right) => {
    const version = compareArtifactVersions(right.version, left.version);
    if (version !== 0) return version;
    return right.createdAt - left.createdAt;
  })[0] ?? null;
}

export function resolveArtifact(options: ArtifactFilters & { id?: string }, deps: ArtifactDeps = {}): ResolvedArtifact {
  const db = deps.db ?? new AttachmentsDB();
  try {
    const artifact = options.id
      ? db.findArtifactById(options.id)
      : chooseLatestArtifact(db.findArtifacts(options));
    if (!artifact) throw new Error("Artifact not found");
    const attachment = db.findById(artifact.attachmentId);
    if (!attachment) throw new Error(`Artifact attachment not found: ${artifact.attachmentId}`);
    return { artifact, attachment };
  } finally {
    if (!deps.db) db.close();
  }
}

export async function downloadArtifact(
  options: DownloadArtifactOptions,
  deps: ArtifactDeps = {}
): Promise<DownloadedArtifact> {
  const db = deps.db ?? new AttachmentsDB();
  try {
    const { artifact, attachment } = resolveArtifact(options, { db });
    const download = await downloadAttachment(
      attachment.id,
      options.output,
      { db },
      { password: options.password } satisfies DownloadOptions
    );
    if (options.verify !== false) {
      await verifyFileSha256(download.path, artifact.checksumSha256);
    }
    return { artifact, attachment, download };
  } finally {
    if (!deps.db) db.close();
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeInstallDir(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) {
    throw new Error("install_dir must be a non-empty absolute path without control characters");
  }
  if (!isAbsolute(trimmed)) {
    throw new Error("install_dir must be an absolute path");
  }
  if (trimmed.split("/").includes("..")) {
    throw new Error("install_dir must not contain parent-directory segments");
  }
  const normalized = normalize(trimmed);
  if (normalized === "/" || normalized.includes("/../") || normalized.endsWith("/..")) {
    throw new Error("install_dir must not resolve outside its target directory");
  }
  return normalized;
}

function normalizeAppName(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().endsWith(".app") ? value.trim() : `${value.trim()}.app`;
  if (basename(normalized) !== normalized || !APP_NAME_RE.test(normalized)) {
    throw new Error("app_name must be a safe app bundle basename like BrowserPlan.app");
  }
  return normalized;
}

function appTargetPath(appName: string | null, installDir: string): string | null {
  const safeAppName = normalizeAppName(appName);
  if (!safeAppName) return null;
  return join(normalizeInstallDir(installDir), safeAppName);
}

function normalizeAttachmentsBin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) {
    throw new Error("attachments_bin must be a non-empty command or path without control characters");
  }
  return trimmed;
}

function commandNeedsSudo(installDir: string): boolean {
  return installDir === "/Applications" || installDir.startsWith("/Applications/");
}

function sudoPrefix(needsSudo: boolean): string {
  return needsSudo ? "sudo " : "";
}

function signatureIsCodesign(artifact: Artifact): boolean {
  return artifact.signatureType === "codesign" || artifact.signatureType === "apple-codesign";
}

function codesignVerifyCommand(pathExpression: string, signature: string | null): string {
  const verify = `codesign --verify --deep --strict --verbose=2 ${pathExpression}`;
  if (!signature) return verify;
  return `${verify} && codesign -dv --verbose=4 ${pathExpression} 2>&1 | grep -F -- ${shellQuote(signature)}`;
}

function pkgSignatureVerifyCommand(pathExpression: string, signature: string | null): string {
  const verify = `pkgutil --check-signature ${pathExpression}`;
  if (!signature) return verify;
  return `${verify} | grep -F -- ${shellQuote(signature)}`;
}

function appInstallCommand(targetPath: string, sudo: string): string {
  const quotedTarget = shellQuote(targetPath);
  return [
    `target_path=${quotedTarget}`,
    'new_path="$tmpdir/new-app"',
    'backup_path="$tmpdir/previous-app"',
    'rm -rf "$new_path" "$backup_path"',
    'ditto "$app_source" "$new_path"',
    'if [ -d "$target_path" ]; then ditto "$target_path" "$backup_path"; fi',
    `if ! (${sudo}rm -rf "$target_path" && ${sudo}ditto "$new_path" "$target_path"); then status=$?; if [ -d "$backup_path" ]; then ${sudo}rm -rf "$target_path"; ${sudo}ditto "$backup_path" "$target_path"; fi; exit "$status"; fi`,
  ].join("; ");
}

function macInstallSteps(resolved: ResolvedArtifact, options: BuildInstallPlanOptions = {}): InstallStep[] {
  const artifact = resolved.artifact;
  const attachment = resolved.attachment;
  const appName = normalizeAppName(options.appName ?? artifact.appName);
  const installDir = normalizeInstallDir(options.installDir ?? "/Applications");
  const targetPath = appTargetPath(appName, installDir);
  const needsSudo = commandNeedsSudo(installDir);
  const sudo = sudoPrefix(needsSudo);
  const kind = artifact.kind.toLowerCase();
  const attachmentsBin = normalizeAttachmentsBin(options.attachmentsBin ?? "attachments");
  const downloadRef = attachment.link ?? attachment.id;
  const steps: InstallStep[] = [
    {
      id: "download",
      description: "Download the artifact through the attachments CLI",
      command: `artifact_path="$tmpdir"/${shellQuote(artifact.filename)} && ${shellQuote(attachmentsBin)} download ${shellQuote(downloadRef)} --output "$artifact_path" >/dev/null`,
      mutates: false,
      requires_sudo: false,
    },
    {
      id: "checksum",
      description: "Verify the artifact SHA-256 checksum",
      command: `printf '%s  %s\\n' ${shellQuote(artifact.checksumSha256)} "$artifact_path" | shasum -a 256 -c -`,
      mutates: false,
      requires_sudo: false,
    },
  ];

  if (kind === "pkg" || kind === "mac-pkg") {
    if (signatureIsCodesign(artifact)) {
      steps.push({
        id: "verify-pkg-signature",
        description: "Verify the package signature before install",
        command: pkgSignatureVerifyCommand('"$artifact_path"', artifact.signature),
        mutates: false,
        requires_sudo: false,
      });
    }
    steps.push({
      id: "install-pkg",
      description: "Install the macOS package",
      command: `${sudo}installer -pkg "$artifact_path" -target /`,
      mutates: true,
      requires_sudo: needsSudo,
    });
    return steps;
  }

  if (!appName || !targetPath) {
    throw new Error("app_name is required for mac app zip or dmg install plans");
  }

  if (kind === "dmg" || kind === "mac-dmg") {
    steps.push(
      {
        id: "mount-dmg",
        description: "Mount the DMG read-only",
        command: `mount_dir="$(mktemp -d "$tmpdir/dmg.XXXXXX")" && hdiutil attach "$artifact_path" -nobrowse -readonly -mountpoint "$mount_dir" >/dev/null`,
        mutates: false,
        requires_sudo: false,
      },
      {
        id: "find-app",
        description: "Locate the app bundle in the mounted image",
        command: `app_source="$(find "$mount_dir" -maxdepth 3 -name ${shellQuote(appName)} -type d | head -n 1)" && test -n "$app_source"`,
        mutates: false,
        requires_sudo: false,
      }
    );
  } else if (kind === "zip" || kind === "mac-app-zip") {
    steps.push(
      {
        id: "extract-zip",
        description: "Extract the app archive",
        command: `staging_dir="$tmpdir/staging" && mkdir -p "$staging_dir" && ditto -x -k "$artifact_path" "$staging_dir"`,
        mutates: false,
        requires_sudo: false,
      },
      {
        id: "find-app",
        description: "Locate the app bundle in the extracted archive",
        command: `app_source="$(find "$staging_dir" -maxdepth 4 -name ${shellQuote(appName)} -type d | head -n 1)" && test -n "$app_source"`,
        mutates: false,
        requires_sudo: false,
      }
    );
  } else {
    throw new Error(`Unsupported macOS artifact kind: ${artifact.kind}`);
  }

  steps.push(
    ...(signatureIsCodesign(artifact)
      ? [{
          id: "verify-staged-codesign",
          description: "Verify the staged app code signature before install",
          command: codesignVerifyCommand('"$app_source"', artifact.signature),
          mutates: false,
          requires_sudo: false,
        }]
      : []),
    {
      id: "install-app",
      description: "Replace the installed app bundle",
      command: appInstallCommand(targetPath, sudo),
      mutates: true,
      requires_sudo: needsSudo,
    },
    {
      id: "clear-quarantine",
      description: "Clear macOS quarantine attributes if present",
      command: `${sudo}xattr -dr com.apple.quarantine ${shellQuote(targetPath)} 2>/dev/null || true`,
      mutates: true,
      requires_sudo: needsSudo,
    }
  );

  if (signatureIsCodesign(artifact)) {
    steps.push({
      id: "verify-codesign",
      description: "Verify the installed app code signature",
      command: codesignVerifyCommand(shellQuote(targetPath), artifact.signature),
      mutates: false,
      requires_sudo: false,
    });
  }

  if (kind === "dmg" || kind === "mac-dmg") {
    steps.push({
      id: "detach-dmg",
      description: "Detach the mounted image",
      command: `hdiutil detach "$mount_dir" >/dev/null`,
      mutates: false,
      requires_sudo: false,
    });
  }

  return steps;
}

function installScriptFromSteps(steps: InstallStep[]): string {
  return [
    "set -euo pipefail",
    'tmpdir="$(mktemp -d)"',
    'mount_dir=""',
    'cleanup() { if [ -n "${mount_dir:-}" ]; then hdiutil detach "$mount_dir" >/dev/null 2>&1 || true; fi; rm -rf "$tmpdir"; }',
    "trap cleanup EXIT",
    ...steps.map((step) => step.command),
  ].join("\n");
}

export function buildMacArtifactInstallPlan(
  resolved: ResolvedArtifact,
  options: BuildInstallPlanOptions = {}
): ArtifactInstallPlan {
  const installDir = normalizeInstallDir(options.installDir ?? "/Applications");
  const appName = normalizeAppName(options.appName ?? resolved.artifact.appName);
  const targetPath = appTargetPath(appName, installDir);
  const attachmentsBin = normalizeAttachmentsBin(options.attachmentsBin ?? "attachments");
  const steps = macInstallSteps(resolved, { ...options, appName: appName ?? undefined, installDir, attachmentsBin });
  return {
    contract_version: ARTIFACT_CONTRACT_VERSION,
    os: "macos",
    artifact: artifactToJson(resolved.artifact, resolved.attachment),
    app_name: appName,
    install_dir: installDir,
    target_path: targetPath,
    attachments_bin: attachmentsBin,
    install_script: installScriptFromSteps(steps),
    steps,
  };
}

export function expandMachineTargets(input: string | string[]): string[] {
  const parts = Array.isArray(input)
    ? input
    : input.split(",").map((part) => part.trim()).filter(Boolean);
  const machines: string[] = [];
  for (const part of parts) {
    const range = /^([A-Za-z_-]+)(\d+)-([A-Za-z_-]+)(\d+)$/.exec(part);
    if (!range) {
      machines.push(part);
      continue;
    }
    const prefixLeft = range[1]!;
    const startRaw = range[2]!;
    const prefixRight = range[3]!;
    const endRaw = range[4]!;
    if (prefixLeft !== prefixRight) {
      throw new Error(`Machine range prefixes do not match: ${part}`);
    }
    const start = Number(startRaw);
    const end = Number(endRaw);
    const width = startRaw.length;
    const direction = start <= end ? 1 : -1;
    for (let current = start; direction > 0 ? current <= end : current >= end; current += direction) {
      machines.push(`${prefixLeft}${String(current).padStart(width, "0")}`);
    }
  }
  return [...new Set(machines)];
}

export function buildFleetInstallPlan(
  installPlan: ArtifactInstallPlan,
  options: {
    machines: string | string[];
    exclude?: string | string[];
  }
): FleetInstallPlan {
  const excluded = new Set(expandMachineTargets(options.exclude ?? []));
  const targets = expandMachineTargets(options.machines).filter((machine) => !excluded.has(machine));
  const routeCommand = (machine: string) =>
    `machines ssh --machine ${shellQuote(machine)} --cmd ${shellQuote(installPlan.install_script)} --private-metadata --json`;
  return {
    contract_version: ARTIFACT_CONTRACT_VERSION,
    target_machines: targets,
    excluded_machines: [...excluded],
    install_plan: installPlan,
    open_machines: {
      command_template: "machines ssh --machine <machine-id> --cmd <install-script> --private-metadata --json",
      commands: targets.map((machine) => ({
        machine_id: machine,
        remote_command: installPlan.install_script,
        route_command: routeCommand(machine),
      })),
    },
  };
}

export function inferArtifactKind(path: string): string {
  const lower = basename(path).toLowerCase();
  if (lower.endsWith(".dmg")) return "dmg";
  if (lower.endsWith(".pkg")) return "pkg";
  return "mac-app-zip";
}
