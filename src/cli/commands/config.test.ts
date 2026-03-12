import { describe, it, expect, beforeEach, afterEach, mock, spyOn, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getConfig,
  setConfig,
  validateS3Config,
  setConfigPath,
  type AttachmentsConfig,
} from "../../core/config";

// ---------------------------------------------------------------------------
// Mock @aws-sdk/client-s3 for configTestCommand (to avoid real AWS calls)
// ---------------------------------------------------------------------------

const mockS3Send = mock(async (_cmd: unknown) => ({ KeyCount: 0 }));

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class MockAWSS3Client {
    constructor(_config: unknown) {}
    send = mockS3Send;
  },
  ListObjectsV2Command: class ListObjectsV2Command {
    constructor(public input: Record<string, unknown>) {}
  },
  // Include other exports used by s3.ts to avoid breaking it
  PutObjectCommand: class PutObjectCommand { constructor(public input: Record<string, unknown>) {} },
  GetObjectCommand: class GetObjectCommand { constructor(public input: Record<string, unknown>) {} },
  DeleteObjectCommand: class DeleteObjectCommand { constructor(public input: Record<string, unknown>) {} },
  CreateMultipartUploadCommand: class CreateMultipartUploadCommand { constructor(public input: Record<string, unknown>) {} },
  UploadPartCommand: class UploadPartCommand { constructor(public input: Record<string, unknown>) {} },
  CompleteMultipartUploadCommand: class CompleteMultipartUploadCommand { constructor(public input: Record<string, unknown>) {} },
}));

// Restore mocks after tests
afterAll(() => mock.restore());

// Import configCommand after mocks
const { configCommand } = await import("./config");

// ─── test-scoped config path ──────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `config-cmd-test-${Date.now()}`);
const TEST_CONFIG_PATH = join(TEST_DIR, "config.json");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setConfigPath(TEST_CONFIG_PATH);
  if (existsSync(TEST_CONFIG_PATH)) {
    rmSync(TEST_CONFIG_PATH);
  }
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ─── maskSecret helper ────────────────────────────────────────────────────────

function maskSecret(value: string): string {
  if (!value) return "";
  return "****";
}

describe("maskSecret", () => {
  it("returns **** for any non-empty string", () => {
    expect(maskSecret("super-secret-key")).toBe("****");
    expect(maskSecret("a")).toBe("****");
  });

  it("returns empty string for empty input", () => {
    expect(maskSecret("")).toBe("");
  });
});

// ─── config show ─────────────────────────────────────────────────────────────

describe("config show — masked output", () => {
  it("masks secretAccessKey in output", () => {
    setConfig({
      s3: {
        bucket: "my-bucket",
        region: "us-east-1",
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG",
      },
    });

    const config = getConfig();
    const masked = {
      s3: {
        ...config.s3,
        secretAccessKey: maskSecret(config.s3.secretAccessKey),
      },
      server: config.server,
      defaults: config.defaults,
    };

    expect(masked.s3.secretAccessKey).toBe("****");
    expect(masked.s3.accessKeyId).toBe("AKIDEXAMPLE");
    expect(masked.s3.bucket).toBe("my-bucket");
    expect(masked.s3.region).toBe("us-east-1");
  });

  it("outputs valid JSON", () => {
    const config = getConfig();
    const masked = {
      s3: { ...config.s3, secretAccessKey: maskSecret(config.s3.secretAccessKey) },
      server: config.server,
      defaults: config.defaults,
    };
    expect(() => JSON.stringify(masked, null, 2)).not.toThrow();
  });

  it("shows defaults when no config file exists", () => {
    const config = getConfig();
    expect(config.server.port).toBe(3457);
    expect(config.defaults.expiry).toBe("7d");
    expect(config.defaults.linkType).toBe("presigned");
  });
});

// ─── config set ──────────────────────────────────────────────────────────────

describe("config set — partial updates", () => {
  it("sets bucket and region without affecting other fields", () => {
    setConfig({ s3: { bucket: "new-bucket", region: "eu-west-1" } });
    const cfg = getConfig();
    expect(cfg.s3.bucket).toBe("new-bucket");
    expect(cfg.s3.region).toBe("eu-west-1");
    expect(cfg.server.port).toBe(3457);
  });

  it("sets access key and secret key", () => {
    setConfig({
      s3: { accessKeyId: "AKIDTEST", secretAccessKey: "supersecret" },
    });
    const cfg = getConfig();
    expect(cfg.s3.accessKeyId).toBe("AKIDTEST");
    expect(cfg.s3.secretAccessKey).toBe("supersecret");
  });

  it("sets server port and base URL", () => {
    setConfig({ server: { port: 9000, baseUrl: "http://localhost:9000" } });
    const cfg = getConfig();
    expect(cfg.server.port).toBe(9000);
    expect(cfg.server.baseUrl).toBe("http://localhost:9000");
  });

  it("sets default expiry", () => {
    setConfig({ defaults: { expiry: "30d" } });
    const cfg = getConfig();
    expect(cfg.defaults.expiry).toBe("30d");
  });

  it("sets link type to server", () => {
    setConfig({ defaults: { linkType: "server" } });
    const cfg = getConfig();
    expect(cfg.defaults.linkType).toBe("server");
  });

  it("sets custom S3 endpoint", () => {
    setConfig({ s3: { endpoint: "https://minio.example.com" } });
    const cfg = getConfig();
    expect(cfg.s3.endpoint).toBe("https://minio.example.com");
  });

  it("overwrites values on second call", () => {
    setConfig({ s3: { bucket: "bucket-v1" } });
    setConfig({ s3: { bucket: "bucket-v2" } });
    expect(getConfig().s3.bucket).toBe("bucket-v2");
  });

  it("persists full config correctly", () => {
    const full: AttachmentsConfig = {
      s3: {
        bucket: "prod-bucket",
        region: "us-west-2",
        accessKeyId: "AKID",
        secretAccessKey: "secret",
      },
      server: { port: 4567, baseUrl: "https://attachments.example.com" },
      defaults: { expiry: "1h", linkType: "server" },
    };
    setConfig(full);
    expect(getConfig()).toEqual(full);
  });
});

// ─── config test — validateS3Config ──────────────────────────────────────────

describe("config test — S3 validation", () => {
  it("throws when S3 config is incomplete", () => {
    expect(() => validateS3Config()).toThrow(/S3 configuration incomplete/);
  });

  it("throws listing the missing field", () => {
    setConfig({ s3: { bucket: "b", region: "r", accessKeyId: "id" } });
    expect(() => validateS3Config()).toThrow(/secretAccessKey/);
  });

  it("throws for multiple missing fields", () => {
    expect(() => validateS3Config()).toThrow(/bucket/);
  });

  it("passes validation when all S3 fields are present", () => {
    const valid: AttachmentsConfig = {
      s3: {
        bucket: "b",
        region: "r",
        accessKeyId: "id",
        secretAccessKey: "secret",
      },
      server: { port: 3457, baseUrl: "http://localhost:3457" },
      defaults: { expiry: "7d", linkType: "presigned" },
    };
    expect(() => validateS3Config(valid)).not.toThrow();
  });

  it("passes validation with optional endpoint", () => {
    const valid: AttachmentsConfig = {
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
    expect(() => validateS3Config(valid)).not.toThrow();
  });

  it("uses saved config when no argument provided", () => {
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

// ─── configCommand integration tests ─────────────────────────────────────────

function buildConfigCmd() {
  const { Command } = require("commander") as typeof import("commander");
  const program = new Command();
  program.exitOverride();
  program.addCommand(configCommand());
  return program;
}

function captureOutput() {
  const out: string[] = [];
  const err: string[] = [];
  const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  return {
    out,
    err,
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

describe("configCommand show", () => {
  it("outputs masked JSON config", async () => {
    setConfig({
      s3: {
        bucket: "my-bucket",
        region: "us-east-1",
        accessKeyId: "AKID",
        secretAccessKey: "super-secret",
      },
    });

    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "show"], { from: "user" });
      const parsed = JSON.parse(capture.out.join(""));
      expect(parsed.s3.bucket).toBe("my-bucket");
      expect(parsed.s3.secretAccessKey).toBe("****");
      expect(parsed.s3.accessKeyId).toBe("AKID");
    } finally {
      capture.restore();
    }
  });

  it("outputs empty string for empty secretAccessKey", async () => {
    setConfig({ s3: { secretAccessKey: "" } });

    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "show"], { from: "user" });
      const parsed = JSON.parse(capture.out.join(""));
      expect(parsed.s3.secretAccessKey).toBe("");
    } finally {
      capture.restore();
    }
  });
});

describe("configCommand set", () => {
  it("sets bucket via --bucket", async () => {
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "set", "--bucket", "new-bucket"], { from: "user" });
      expect(getConfig().s3.bucket).toBe("new-bucket");
      expect(capture.out.join("")).toContain("Configuration updated");
    } finally {
      capture.restore();
    }
  });

  it("sets region via --region", async () => {
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "set", "--region", "eu-west-1"], { from: "user" });
      expect(getConfig().s3.region).toBe("eu-west-1");
    } finally {
      capture.restore();
    }
  });

  it("sets access key via --access-key", async () => {
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "set", "--access-key", "AKID123"], { from: "user" });
      expect(getConfig().s3.accessKeyId).toBe("AKID123");
    } finally {
      capture.restore();
    }
  });

  it("sets secret key via --secret-key", async () => {
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "set", "--secret-key", "mysecret"], { from: "user" });
      expect(getConfig().s3.secretAccessKey).toBe("mysecret");
    } finally {
      capture.restore();
    }
  });

  it("sets endpoint via --endpoint", async () => {
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "set", "--endpoint", "https://minio.example.com"], { from: "user" });
      expect(getConfig().s3.endpoint).toBe("https://minio.example.com");
    } finally {
      capture.restore();
    }
  });

  it("sets port via --port", async () => {
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "set", "--port", "8080"], { from: "user" });
      expect(getConfig().server.port).toBe(8080);
    } finally {
      capture.restore();
    }
  });

  it("sets base-url via --base-url", async () => {
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "set", "--base-url", "https://example.com"], { from: "user" });
      expect(getConfig().server.baseUrl).toBe("https://example.com");
    } finally {
      capture.restore();
    }
  });

  it("sets expiry via --expiry", async () => {
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "set", "--expiry", "30d"], { from: "user" });
      expect(getConfig().defaults.expiry).toBe("30d");
    } finally {
      capture.restore();
    }
  });

  it("sets link-type via --link-type", async () => {
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "set", "--link-type", "server"], { from: "user" });
      expect(getConfig().defaults.linkType).toBe("server");
    } finally {
      capture.restore();
    }
  });

  it("exits with error for invalid --link-type", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await expect(
        program.parseAsync(["config", "set", "--link-type", "invalid"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("--link-type must be one of");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with error for invalid --port", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await expect(
        program.parseAsync(["config", "set", "--port", "99999"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("valid port number");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("outputs 'No options provided' when no options are given", async () => {
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "set"], { from: "user" });
      expect(capture.out.join("")).toContain("No options provided");
    } finally {
      capture.restore();
    }
  });
});

describe("configCommand test", () => {
  it("outputs success when S3 connection works", async () => {
    setConfig({
      s3: {
        bucket: "test-bucket",
        region: "us-east-1",
        accessKeyId: "KEY",
        secretAccessKey: "SECRET",
      },
    });
    mockS3Send.mockImplementation(async () => ({ KeyCount: 3 }));

    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await program.parseAsync(["config", "test"], { from: "user" });
      expect(capture.out.join("")).toContain("Connection successful");
      expect(capture.out.join("")).toContain("test-bucket");
    } finally {
      capture.restore();
    }
  });

  it("exits with error when validateS3Config fails", async () => {
    // No config set → will fail validation
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await expect(
        program.parseAsync(["config", "test"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("S3 configuration incomplete");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with error when S3 connection fails", async () => {
    setConfig({
      s3: {
        bucket: "test-bucket",
        region: "us-east-1",
        accessKeyId: "KEY",
        secretAccessKey: "SECRET",
      },
    });
    mockS3Send.mockImplementation(async () => {
      throw new Error("Connection timeout");
    });

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();
    try {
      const program = buildConfigCmd();
      await expect(
        program.parseAsync(["config", "test"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("S3 connection failed");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });
});
