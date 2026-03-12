import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We override CONFIG_PATH before importing the module's functions by using
// the exported setConfigPath helper.
import {
  getConfig,
  setConfig,
  validateS3Config,
  parseExpiry,
  setConfigPath,
  type AttachmentsConfig,
} from "./config";

// Unique temp dir per test run
const TEST_DIR = join(tmpdir(), `attachments-test-${Date.now()}`);
const TEST_CONFIG_PATH = join(TEST_DIR, "config.json");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setConfigPath(TEST_CONFIG_PATH);
  // Remove config file before each test for isolation
  if (existsSync(TEST_CONFIG_PATH)) {
    rmSync(TEST_CONFIG_PATH);
  }
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ── getConfig ─────────────────────────────────────────────────────────────────

describe("getConfig", () => {
  it("returns full defaults when no config file exists", () => {
    const cfg = getConfig();
    expect(cfg.s3.bucket).toBe("");
    expect(cfg.s3.region).toBe("");
    expect(cfg.s3.accessKeyId).toBe("");
    expect(cfg.s3.secretAccessKey).toBe("");
    expect(cfg.server.port).toBe(3457);
    expect(cfg.server.baseUrl).toBe("http://localhost:3457");
    expect(cfg.defaults.expiry).toBe("7d");
    expect(cfg.defaults.linkType).toBe("presigned");
  });

  it("merges saved config over defaults", () => {
    setConfig({ s3: { bucket: "my-bucket", region: "us-east-1" } });
    const cfg = getConfig();
    expect(cfg.s3.bucket).toBe("my-bucket");
    expect(cfg.s3.region).toBe("us-east-1");
    // Other fields remain at defaults
    expect(cfg.server.port).toBe(3457);
    expect(cfg.defaults.expiry).toBe("7d");
  });

  it("does not expose s3.endpoint in defaults (optional field)", () => {
    const cfg = getConfig();
    expect(cfg.s3.endpoint).toBeUndefined();
  });

  it("returns endpoint when saved", () => {
    setConfig({ s3: { endpoint: "https://s3.custom.example.com" } });
    const cfg = getConfig();
    expect(cfg.s3.endpoint).toBe("https://s3.custom.example.com");
  });

  it("returns defaults when config file contains invalid JSON", () => {
    // Write malformed JSON to the config path
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(TEST_CONFIG_PATH, "{ this is not valid json }", "utf-8");
    // getConfig should fall back to defaults without throwing
    const cfg = getConfig();
    expect(cfg.s3.bucket).toBe("");
    expect(cfg.server.port).toBe(3457);
  });
});

// ── setConfig ─────────────────────────────────────────────────────────────────

describe("setConfig", () => {
  it("creates config file on first call", () => {
    setConfig({ server: { port: 9000 } });
    expect(existsSync(TEST_CONFIG_PATH)).toBe(true);
  });

  it("persists partial s3 config without overwriting other keys", () => {
    setConfig({ s3: { bucket: "bucket-one", region: "eu-west-1" } });
    setConfig({ s3: { accessKeyId: "AKID" } });
    const cfg = getConfig();
    expect(cfg.s3.bucket).toBe("bucket-one");
    expect(cfg.s3.region).toBe("eu-west-1");
    expect(cfg.s3.accessKeyId).toBe("AKID");
  });

  it("overwrites a value when called twice", () => {
    setConfig({ server: { port: 8000 } });
    setConfig({ server: { port: 9999 } });
    const cfg = getConfig();
    expect(cfg.server.port).toBe(9999);
  });

  it("handles deep nested overrides correctly", () => {
    setConfig({ defaults: { linkType: "server" } });
    const cfg = getConfig();
    expect(cfg.defaults.linkType).toBe("server");
    expect(cfg.defaults.expiry).toBe("7d"); // default still intact
  });

  it("handles full config objects", () => {
    const full: AttachmentsConfig = {
      s3: {
        bucket: "b",
        region: "us-west-2",
        accessKeyId: "key",
        secretAccessKey: "secret",
        endpoint: "https://ep.example.com",
      },
      server: { port: 4000, baseUrl: "https://attachments.example.com" },
      defaults: { expiry: "30d", linkType: "server" },
    };
    setConfig(full);
    const cfg = getConfig();
    expect(cfg).toEqual(full);
  });
});

// ── validateS3Config ──────────────────────────────────────────────────────────

describe("validateS3Config", () => {
  it("throws when all s3 fields are missing", () => {
    expect(() => validateS3Config()).toThrow(/S3 configuration incomplete/);
  });

  it("throws listing the specific missing field(s)", () => {
    setConfig({ s3: { bucket: "b", region: "r", accessKeyId: "id" } });
    expect(() => validateS3Config()).toThrow(/secretAccessKey/);
  });

  it("throws with multiple missing fields", () => {
    expect(() => validateS3Config()).toThrow(/bucket/);
  });

  it("does not throw when all required s3 fields are present", () => {
    const validConfig: AttachmentsConfig = {
      s3: {
        bucket: "my-bucket",
        region: "us-east-1",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      server: { port: 3457, baseUrl: "http://localhost:3457" },
      defaults: { expiry: "7d", linkType: "presigned" },
    };
    expect(() => validateS3Config(validConfig)).not.toThrow();
  });

  it("accepts config with optional endpoint", () => {
    const validConfig: AttachmentsConfig = {
      s3: {
        bucket: "b",
        region: "r",
        accessKeyId: "id",
        secretAccessKey: "secret",
        endpoint: "https://minio.example.com",
      },
      server: { port: 3457, baseUrl: "http://localhost:3457" },
      defaults: { expiry: "7d", linkType: "presigned" },
    };
    expect(() => validateS3Config(validConfig)).not.toThrow();
  });

  it("uses getConfig when no argument passed", () => {
    setConfig({
      s3: {
        bucket: "b",
        region: "r",
        accessKeyId: "id",
        secretAccessKey: "secret",
      },
    });
    expect(() => validateS3Config()).not.toThrow();
  });
});

// ── parseExpiry ───────────────────────────────────────────────────────────────

describe("parseExpiry", () => {
  it('returns null for "never"', () => {
    expect(parseExpiry("never")).toBeNull();
  });

  it("parses minutes correctly", () => {
    expect(parseExpiry("1m")).toBe(60_000);
    expect(parseExpiry("30m")).toBe(30 * 60_000);
    expect(parseExpiry("60m")).toBe(60 * 60_000);
  });

  it("parses hours correctly", () => {
    expect(parseExpiry("1h")).toBe(3_600_000);
    expect(parseExpiry("24h")).toBe(24 * 3_600_000);
    expect(parseExpiry("48h")).toBe(48 * 3_600_000);
  });

  it("parses days correctly", () => {
    expect(parseExpiry("1d")).toBe(86_400_000);
    expect(parseExpiry("7d")).toBe(7 * 86_400_000);
    expect(parseExpiry("30d")).toBe(30 * 86_400_000);
  });

  it("returns null for unknown units", () => {
    expect(parseExpiry("5w")).toBeNull();
    expect(parseExpiry("2y")).toBeNull();
    expect(parseExpiry("10s")).toBeNull();
  });

  it("returns null for invalid strings", () => {
    expect(parseExpiry("")).toBeNull();
    expect(parseExpiry("abc")).toBeNull();
    expect(parseExpiry("7")).toBeNull();
    expect(parseExpiry("d")).toBeNull();
    expect(parseExpiry("-1h")).toBeNull();
  });

  it("returns null for zero value", () => {
    expect(parseExpiry("0h")).toBeNull();
    expect(parseExpiry("0d")).toBeNull();
    expect(parseExpiry("0m")).toBeNull();
  });

  it("handles leading/trailing whitespace", () => {
    expect(parseExpiry(" 7d")).toBe(7 * 86_400_000);
    expect(parseExpiry("7d ")).toBe(7 * 86_400_000); // trim() handles both sides
    expect(parseExpiry("  24h  ")).toBe(24 * 3_600_000);
  });
});
