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
  server: {
    port: number;
    baseUrl: string;
  };
  defaults: {
    expiry: string;
    linkType: "presigned" | "server";
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
  server: {
    port: 3459,
    baseUrl: "http://localhost:3459",
  },
  defaults: {
    expiry: "7d",
    linkType: "presigned",
  },
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
  return deepMerge(DEFAULT_CONFIG, saved);
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
  if (!cfg.s3.accessKeyId) missing.push("accessKeyId");
  if (!cfg.s3.secretAccessKey) missing.push("secretAccessKey");
  if (missing.length > 0) {
    throw new Error(
      `S3 configuration incomplete. Missing: ${missing.join(", ")}. ` +
        `Run 'attachments config set s3.${missing[0]} <value>' to configure.`
    );
  }
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
