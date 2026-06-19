import { join } from "path";
import { homedir } from "os";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "fs";

export interface AttachmentsConfig {
  s3: {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint?: string;
  };
  storage: {
    backend: "auto" | "local" | "s3";
    localDir: string;
    maxSizeBytes: number;
  };
  server: {
    port: number;
    host: string;
    baseUrl: string;
    publicPath: string;
  };
  defaults: {
    expiry: string;
    linkType: "presigned" | "server";
  };
  client: {
    mode: "local" | "cloud";
    apiBaseUrl: string;
    apiToken: string;
    apiTokenEnv: string;
    internalBaseUrl?: string;
    internalMachineId?: string;
    preferInternal: boolean;
  };
  domains: Array<{
    hostname: string;
    baseUrl?: string;
    pathPrefix?: string;
    primary?: boolean;
  }>;
  deployment: {
    publicHostname?: string;
    provider?: "manual" | "cloudflare" | "opendomains" | "external";
    managedBy?: "manual" | "opendomains" | "external";
    dns?: {
      zone?: string;
      recordType?: "A" | "AAAA" | "CNAME";
      name?: string;
      target?: string;
      proxied?: boolean;
    };
    routing?: {
      attachmentsOrigin?: string;
      fallbackOrigin?: string;
    };
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

const DEFAULT_CONFIG: AttachmentsConfig = {
  s3: {
    bucket: "",
    region: "",
    accessKeyId: "",
    secretAccessKey: "",
  },
  storage: {
    backend: "auto",
    localDir: "~/.hasna/attachments/objects",
    maxSizeBytes: 10 * 1024 * 1024 * 1024,
  },
  server: {
    port: 3459,
    host: "localhost",
    baseUrl: "http://localhost:3459",
    publicPath: "/a",
  },
  defaults: {
    expiry: "7d",
    linkType: "server",
  },
  client: {
    mode: "local",
    apiBaseUrl: "",
    apiToken: "",
    apiTokenEnv: "ATTACHMENTS_API_TOKEN",
    preferInternal: false,
  },
  domains: [],
  deployment: {},
};

function resolveConfigPath(): string {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || homedir();
  const newDir = join(home, ".hasna", "attachments");
  const oldDir = join(home, ".attachments");

  // Auto-migrate: if old dir exists and new doesn't, copy files over
  if (existsSync(oldDir) && !existsSync(newDir)) {
    mkdirSync(newDir, { recursive: true });
    try {
      for (const file of readdirSync(oldDir)) {
        const oldPath = join(oldDir, file);
        const newPath = join(newDir, file);
        try {
          const stat = require("fs").statSync(oldPath);
          if (stat.isFile()) {
            copyFileSync(oldPath, newPath);
          }
        } catch {
          // Skip files that can't be copied
        }
      }
    } catch {
      // If we can't read the old directory, continue with new
    }
  }

  mkdirSync(newDir, { recursive: true });
  return join(newDir, "config.json");
}

export let CONFIG_PATH = resolveConfigPath();

export function setConfigPath(path: string): void {
  CONFIG_PATH = path;
}

function deepMerge<T extends object>(base: T, override: DeepPartial<T>): T {
  const result = { ...base } as T;
  for (const key in override) {
    const k = key as keyof T;
    const overrideVal = override[k];
    if (overrideVal === undefined) continue;
    const baseVal = base[k];
    if (
      baseVal !== null &&
      baseVal !== undefined &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal)
    ) {
      result[k] = deepMerge(baseVal as object, overrideVal as DeepPartial<object>) as T[keyof T];
    } else {
      result[k] = overrideVal as T[keyof T];
    }
  }
  return result;
}

function loadRawConfig(): DeepPartial<AttachmentsConfig> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as DeepPartial<AttachmentsConfig>;
  } catch {
    return {};
  }
}

function saveRawConfig(config: DeepPartial<AttachmentsConfig>): void {
  const dir = join(CONFIG_PATH, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function getConfig(): AttachmentsConfig {
  const saved = loadRawConfig();
  return normalizeConfig(saved);
}

export function normalizeConfig(config: DeepPartial<AttachmentsConfig>): AttachmentsConfig {
  return deepMerge(DEFAULT_CONFIG, config);
}

export function setConfig(partial: DeepPartial<AttachmentsConfig>): void {
  const current = loadRawConfig();
  const merged = deepMerge(current as DeepPartial<AttachmentsConfig>, partial) as DeepPartial<AttachmentsConfig>;
  saveRawConfig(merged);
}

export function validateS3Config(config?: AttachmentsConfig): void {
  const cfg = config ?? getConfig();
  const missing: string[] = [];
  if (!cfg.s3.bucket) missing.push("bucket");
  if (!cfg.s3.region) missing.push("region");
  if (!!cfg.s3.accessKeyId !== !!cfg.s3.secretAccessKey) {
    if (!cfg.s3.accessKeyId) missing.push("accessKeyId");
    if (!cfg.s3.secretAccessKey) missing.push("secretAccessKey");
  }
  if (missing.length > 0) {
    throw new Error(
      `S3 configuration incomplete. Missing: ${missing.join(", ")}. ` +
        `Run 'attachments config set --bucket <bucket> --region <region>' and optionally static access keys.`
    );
  }
}

export function hasS3Config(config?: AttachmentsConfig): boolean {
  const cfg = config ?? getConfig();
  return !!(cfg.s3.bucket && cfg.s3.region && (!!cfg.s3.accessKeyId === !!cfg.s3.secretAccessKey));
}

export function resolveStorageBackend(config?: AttachmentsConfig): "local" | "s3" {
  const cfg = config ?? getConfig();
  if (cfg.storage.backend === "local") return "local";
  if (cfg.storage.backend === "s3") {
    validateS3Config(cfg);
    return "s3";
  }
  return hasS3Config(cfg) ? "s3" : "local";
}

export function validateStorageConfig(config?: AttachmentsConfig): void {
  const cfg = config ?? getConfig();
  if (cfg.storage.maxSizeBytes <= 0 || !Number.isFinite(cfg.storage.maxSizeBytes)) {
    throw new Error("storage.maxSizeBytes must be a positive number");
  }
  if (resolveStorageBackend(cfg) === "s3") {
    validateS3Config(cfg);
  }
}

export function normalizePublicPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/a";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "") || "/a";
}

export function getPublicBaseUrl(config?: AttachmentsConfig): string {
  const cfg = config ?? getConfig();
  const primaryDomain = cfg.domains.find((domain) => domain.primary) ?? cfg.domains[0];
  return primaryDomain?.baseUrl ?? cfg.server.baseUrl;
}

export function getClientApiBaseUrl(config?: AttachmentsConfig): string | null {
  const cfg = config ?? getConfig();
  const baseUrl = cfg.client.apiBaseUrl || process.env["ATTACHMENTS_API_URL"] || process.env["HASNA_ATTACHMENTS_API_URL"] || "";
  return baseUrl ? baseUrl.replace(/\/+$/, "") : null;
}

export function getClientApiToken(config?: AttachmentsConfig): string | null {
  const cfg = config ?? getConfig();
  const envName = cfg.client.apiTokenEnv || "ATTACHMENTS_API_TOKEN";
  const token =
    process.env[envName] ||
    process.env["ATTACHMENTS_API_TOKEN"] ||
    process.env["HASNA_ATTACHMENTS_API_TOKEN"] ||
    cfg.client.apiToken ||
    "";
  return token || null;
}

export function isCloudClientMode(config?: AttachmentsConfig): boolean {
  const cfg = config ?? getConfig();
  const envMode = process.env["ATTACHMENTS_MODE"] || process.env["ATTACHMENTS_CLIENT_MODE"];
  const mode = (envMode || cfg.client.mode || "local").toLowerCase();
  return mode === "cloud" || mode === "api" || mode === "remote";
}

export function getInternalBaseUrl(config?: AttachmentsConfig): string | null {
  const cfg = config ?? getConfig();
  const baseUrl =
    cfg.client.internalBaseUrl ||
    process.env["ATTACHMENTS_INTERNAL_URL"] ||
    process.env["HASNA_ATTACHMENTS_INTERNAL_URL"] ||
    "";
  return baseUrl ? baseUrl.replace(/\/+$/, "") : null;
}

/**
 * Parse an expiry string into milliseconds.
 * Supports: Nm (minutes), Nh (hours), Nd (days), "never" → null
 * Returns null for "never", a positive number (ms) otherwise.
 * Returns null for invalid/unrecognized formats.
 */
export function parseExpiry(expiry: string): number | null {
  if (expiry === "never") return null;

  const match = /^(\d+)(m|h|d)$/.exec(expiry.trim());
  if (!match) return null;

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  if (value <= 0) return null;

  switch (unit) {
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

export function parseExpiryStrict(expiry: string): { milliseconds: number | null; never: boolean } {
  const trimmed = expiry.trim();
  if (trimmed === "never") return { milliseconds: null, never: true };
  const milliseconds = parseExpiry(trimmed);
  if (milliseconds === null) {
    throw new Error(`Invalid expiry format: ${expiry}. Use values like 30m, 24h, 7d, or never.`);
  }
  return { milliseconds, never: false };
}
