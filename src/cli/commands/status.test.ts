import { describe, it, expect, beforeEach, mock, spyOn, afterAll } from "bun:test";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

const mockFindAll = mock((_opts?: unknown) => [] as Array<{
  id: string; filename: string; s3Key: string; bucket: string; size: number;
  contentType: string; link: string | null; expiresAt: number | null; createdAt: number;
}>);
const mockDbClose = mock(() => {});

mock.module("../../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    constructor(_path?: string) {}
    findAll = mockFindAll;
    insert = mock((_att: unknown) => {});
    close = mockDbClose;
    findById = mock((_id: string) => null);
    delete = mock((_id: string) => {});
    updateLink = mock((_id: string, _link: string) => {});
    deleteExpired = mock(() => 0);
  },
}));

// ---------------------------------------------------------------------------
// Mock S3 — mock the @aws-sdk/client-s3 module
// ---------------------------------------------------------------------------

const mockS3Send = mock(async (_cmd: unknown) => ({ Contents: [] }));

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class MockS3Client {
    constructor(_config: unknown) {}
    send = mockS3Send;
  },
  ListObjectsV2Command: class MockListObjectsV2Command {
    constructor(public input: unknown) {}
  },
}));

afterAll(() => mock.restore());

// ---------------------------------------------------------------------------
// Config — use setConfigPath + setConfig to control config for tests
// ---------------------------------------------------------------------------

import { setConfigPath, setConfig, CONFIG_PATH } from "../../core/config";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";

const testDir = join(tmpdir(), `attachments-status-test-${Date.now()}`);
const testConfigPath = join(testDir, "config.json");

// Point config to our temp dir
mkdirSync(testDir, { recursive: true });
setConfigPath(testConfigPath);

// Now import the module under test (after mocks are set up)
const { registerStatus } = await import("./status");

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeAttachment(overrides: Partial<{
  id: string; filename: string; s3Key: string; bucket: string; size: number;
  contentType: string; link: string | null; expiresAt: number | null; createdAt: number;
}> = {}) {
  return {
    id: "att_test001",
    filename: "photo.png",
    s3Key: "uploads/photo.png",
    bucket: "my-bucket",
    size: 1024 * 1024,
    contentType: "image/png",
    link: "https://example.com/link",
    expiresAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function buildStatusCmd() {
  const { Command } = require("commander") as typeof import("commander");
  const program = new Command();
  program.exitOverride();
  registerStatus(program);
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

describe("status command", () => {
  beforeEach(() => {
    mockFindAll.mockReset();
    mockFindAll.mockImplementation(() => []);
    mockDbClose.mockReset();
    mockS3Send.mockReset();
    mockS3Send.mockImplementation(async () => ({ Contents: [] }));
    // Reset config to configured state
    setConfig({
      s3: {
        bucket: "my-bucket",
        region: "us-east-1",
        accessKeyId: "AKIA_TEST",
        secretAccessKey: "secret_test",
      },
    });
  });

  it("shows connected S3 status when S3 is reachable", async () => {
    const capture = captureOutput();
    try {
      const program = buildStatusCmd();
      await program.parseAsync(["status"], { from: "user" });
      const output = capture.out.join("");
      expect(output).toContain("S3: \u2713 connected (my-bucket, us-east-1)");
    } finally {
      capture.restore();
    }
  });

  it("shows not configured when S3 config is missing", async () => {
    // Write empty config (no S3 credentials)
    setConfigPath(join(testDir, "config-empty.json"));
    setConfig({ s3: { bucket: "", region: "", accessKeyId: "", secretAccessKey: "" } });

    const capture = captureOutput();
    try {
      const program = buildStatusCmd();
      await program.parseAsync(["status"], { from: "user" });
      const output = capture.out.join("");
      expect(output).toContain("S3: \u2717 not configured");
    } finally {
      capture.restore();
      // Restore config path
      setConfigPath(testConfigPath);
    }
  });

  it("shows connection failed when S3 send throws", async () => {
    mockS3Send.mockImplementation(async () => {
      throw new Error("Network error");
    });

    const capture = captureOutput();
    try {
      const program = buildStatusCmd();
      await program.parseAsync(["status"], { from: "user" });
      const output = capture.out.join("");
      expect(output).toContain("S3: \u2717 connection failed (my-bucket, us-east-1)");
    } finally {
      capture.restore();
    }
  });

  it("shows attachment count with no expired", async () => {
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_1", size: 1024 }),
      makeAttachment({ id: "att_2", size: 2048 }),
    ]);

    const capture = captureOutput();
    try {
      const program = buildStatusCmd();
      await program.parseAsync(["status"], { from: "user" });
      const output = capture.out.join("");
      expect(output).toContain("Attachments: 2");
      expect(output).not.toContain("expired");
    } finally {
      capture.restore();
    }
  });

  it("shows attachment count with expired count", async () => {
    const pastTime = Date.now() - 1000; // expired 1 second ago
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_1", size: 1024, expiresAt: null }),
      makeAttachment({ id: "att_2", size: 2048, expiresAt: pastTime }),
      makeAttachment({ id: "att_3", size: 4096, expiresAt: pastTime }),
    ]);

    const capture = captureOutput();
    try {
      const program = buildStatusCmd();
      await program.parseAsync(["status"], { from: "user" });
      const output = capture.out.join("");
      expect(output).toContain("Attachments: 3 (2 expired)");
    } finally {
      capture.restore();
    }
  });

  it("formats total size correctly", async () => {
    // 128.5 MB = 128.5 * 1024 * 1024
    const size = Math.round(128.5 * 1024 * 1024);
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_1", size }),
    ]);

    const capture = captureOutput();
    try {
      const program = buildStatusCmd();
      await program.parseAsync(["status"], { from: "user" });
      const output = capture.out.join("");
      expect(output).toContain("Total size: 128.5 MB");
    } finally {
      capture.restore();
    }
  });

  it("shows 0 B total size when no attachments", async () => {
    const capture = captureOutput();
    try {
      const program = buildStatusCmd();
      await program.parseAsync(["status"], { from: "user" });
      const output = capture.out.join("");
      expect(output).toContain("Total size: 0 B");
    } finally {
      capture.restore();
    }
  });

  it("shows config and DB paths", async () => {
    const capture = captureOutput();
    try {
      const program = buildStatusCmd();
      await program.parseAsync(["status"], { from: "user" });
      const output = capture.out.join("");
      expect(output).toContain("Config:");
      expect(output).toContain("DB:");
      expect(output).toContain("db.sqlite");
    } finally {
      capture.restore();
    }
  });

  it("closes the database", async () => {
    const capture = captureOutput();
    try {
      const program = buildStatusCmd();
      await program.parseAsync(["status"], { from: "user" });
      expect(mockDbClose).toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });
});
