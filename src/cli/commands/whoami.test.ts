import { describe, it, expect, beforeEach, afterEach, mock, spyOn, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setConfigPath, setConfig } from "../../core/config";

// ---------------------------------------------------------------------------
// Mock bun:sqlite (AttachmentsDB) to avoid real DB access
// ---------------------------------------------------------------------------

let mockAttachments: Array<{
  id: string;
  filename: string;
  s3Key: string;
  bucket: string;
  size: number;
  contentType: string;
  link: string | null;
  expiresAt: number | null;
  createdAt: number;
}> = [];

mock.module("../../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    constructor(_path?: string) {}
    findAll(_opts?: { includeExpired?: boolean }) {
      return mockAttachments;
    }
    close() {}
  },
}));

afterAll(() => mock.restore());

// Import after mocks
const { registerWhoami } = await import("./whoami");

// ─── test-scoped config path ──────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `whoami-cmd-test-${Date.now()}`);
const TEST_CONFIG_PATH = join(TEST_DIR, "config.json");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setConfigPath(TEST_CONFIG_PATH);
  if (existsSync(TEST_CONFIG_PATH)) {
    rmSync(TEST_CONFIG_PATH);
  }
  mockAttachments = [];
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildWhoamiCmd() {
  const { Command } = require("commander") as typeof import("commander");
  const program = new Command();
  program.exitOverride();
  registerWhoami(program);
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

// ─── tests ───────────────────────────────────────────────────────────────────

describe("whoami — full output with valid config", () => {
  it("shows version, config path, S3, server, link type, and attachment counts", async () => {
    setConfig({
      s3: {
        bucket: "my-bucket",
        region: "us-east-1",
        accessKeyId: "AKID",
        secretAccessKey: "secret",
      },
      server: { port: 3457, baseUrl: "http://localhost:3457" },
      defaults: { expiry: "7d", linkType: "presigned" },
    });

    const now = Date.now();
    mockAttachments = [
      {
        id: "a1",
        filename: "file1.txt",
        s3Key: "k1",
        bucket: "my-bucket",
        size: 100,
        contentType: "text/plain",
        link: "https://example.com/1",
        expiresAt: now + 86400000, // future — not expired
        createdAt: now,
      },
      {
        id: "a2",
        filename: "file2.txt",
        s3Key: "k2",
        bucket: "my-bucket",
        size: 200,
        contentType: "text/plain",
        link: "https://example.com/2",
        expiresAt: now - 1000, // past — expired
        createdAt: now - 100000,
      },
      {
        id: "a3",
        filename: "file3.txt",
        s3Key: "k3",
        bucket: "my-bucket",
        size: 300,
        contentType: "text/plain",
        link: null,
        expiresAt: null, // no expiry — not expired
        createdAt: now - 200000,
      },
    ];

    const capture = captureOutput();
    try {
      const program = buildWhoamiCmd();
      await program.parseAsync(["whoami"], { from: "user" });
      const output = capture.out.join("");

      expect(output).toContain("@hasna/attachments v1.0.1");
      expect(output).toContain(`Config: ${TEST_CONFIG_PATH}`);
      expect(output).toContain("\u2713"); // checkmark
      expect(output).toContain("S3: my-bucket (us-east-1)");
      expect(output).toContain("Server: http://localhost:3457");
      expect(output).toContain("Link type: presigned (default expiry: 7d)");
      expect(output).toContain("Attachments: 3 total, 1 expired");
    } finally {
      capture.restore();
    }
  });
});

describe("whoami — missing config", () => {
  it("shows 'not found' when config file does not exist", async () => {
    // Don't create any config file
    const capture = captureOutput();
    try {
      const program = buildWhoamiCmd();
      await program.parseAsync(["whoami"], { from: "user" });
      const output = capture.out.join("");

      expect(output).toContain("@hasna/attachments v1.0.1");
      expect(output).toContain("Config: not found");
      expect(output).toContain("\u2717"); // cross mark
      expect(output).toContain("S3: not configured");
      expect(output).toContain("Attachments: 0 total, 0 expired");
    } finally {
      capture.restore();
    }
  });
});

describe("whoami — S3 not configured", () => {
  it("shows 'not configured' when S3 bucket/region are empty", async () => {
    // Create config without S3 fields
    setConfig({
      server: { port: 9000, baseUrl: "http://localhost:9000" },
      defaults: { expiry: "1d", linkType: "server" },
    });

    const capture = captureOutput();
    try {
      const program = buildWhoamiCmd();
      await program.parseAsync(["whoami"], { from: "user" });
      const output = capture.out.join("");

      expect(output).toContain(`Config: ${TEST_CONFIG_PATH}`);
      expect(output).toContain("S3: not configured");
      expect(output).toContain("Server: http://localhost:9000");
      expect(output).toContain("Link type: server (default expiry: 1d)");
    } finally {
      capture.restore();
    }
  });
});

describe("whoami — attachment counts", () => {
  it("shows 0 total when no attachments exist", async () => {
    setConfig({
      s3: { bucket: "b", region: "r", accessKeyId: "k", secretAccessKey: "s" },
    });
    mockAttachments = [];

    const capture = captureOutput();
    try {
      const program = buildWhoamiCmd();
      await program.parseAsync(["whoami"], { from: "user" });
      const output = capture.out.join("");

      expect(output).toContain("Attachments: 0 total, 0 expired");
    } finally {
      capture.restore();
    }
  });

  it("counts all expired attachments correctly", async () => {
    setConfig({
      s3: { bucket: "b", region: "r", accessKeyId: "k", secretAccessKey: "s" },
    });

    const now = Date.now();
    mockAttachments = [
      { id: "1", filename: "a", s3Key: "k", bucket: "b", size: 1, contentType: "t", link: null, expiresAt: now - 1000, createdAt: now },
      { id: "2", filename: "b", s3Key: "k", bucket: "b", size: 1, contentType: "t", link: null, expiresAt: now - 2000, createdAt: now },
      { id: "3", filename: "c", s3Key: "k", bucket: "b", size: 1, contentType: "t", link: null, expiresAt: now - 3000, createdAt: now },
    ];

    const capture = captureOutput();
    try {
      const program = buildWhoamiCmd();
      await program.parseAsync(["whoami"], { from: "user" });
      const output = capture.out.join("");

      expect(output).toContain("Attachments: 3 total, 3 expired");
    } finally {
      capture.restore();
    }
  });
});
