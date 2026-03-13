import { describe, it, expect, beforeAll, beforeEach, mock, spyOn, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { setConfigPath, setConfig } from "../../core/config";

// ---------------------------------------------------------------------------
// Mock DB and S3 for command-level tests
// ---------------------------------------------------------------------------

type MockAttachment = {
  id: string; filename: string; s3Key: string; bucket: string; size: number;
  contentType: string; link: string | null; expiresAt: number | null; createdAt: number;
};

const mockFindAll = mock((_opts?: unknown) => [] as MockAttachment[]);
const mockDeleteDb = mock((_id: string) => {});
const mockDbClose = mock(() => {});

mock.module("../../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    constructor(_path?: string) {}
    findAll = mockFindAll;
    delete = mockDeleteDb;
    close = mockDbClose;
    findById = mock((_id: string) => null);
    insert = mock((_att: unknown) => {});
    updateLink = mock(() => {});
    deleteExpired = mock(() => 0);
  },
}));

const mockS3Delete = mock(async (_key: string) => {});

mock.module("../../core/s3", () => ({
  S3Client: class MockS3Client {
    constructor(_cfg: unknown) {}
    delete = mockS3Delete;
    upload = mock(async () => {});
    download = mock(async () => Buffer.from(""));
    presign = mock(async () => "https://presigned");
  },
}));

// Use real config module — set up a temp config directory
let _cleanTestConfigDir: string;
beforeAll(() => {
  _cleanTestConfigDir = join(tmpdir(), `clean-test-cfg-${Date.now()}`);
  mkdirSync(_cleanTestConfigDir, { recursive: true });
  setConfigPath(join(_cleanTestConfigDir, "config.json"));
  setConfig({
    s3: { bucket: "test-bucket", region: "us-east-1", accessKeyId: "K", secretAccessKey: "S" },
    server: { port: 3457, baseUrl: "http://localhost:3457" },
    defaults: { expiry: "7d", linkType: "presigned" },
  });
});

afterAll(() => {
  mock.restore();
  try { rmSync(_cleanTestConfigDir, { recursive: true, force: true }); } catch {}
});

// Import command after mocks
const { registerClean } = await import("./clean");

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeAttachment(overrides: Partial<MockAttachment> = {}): MockAttachment {
  return {
    id: "att_clean001",
    filename: "old-file.pdf",
    s3Key: "uploads/old-file.pdf",
    bucket: "test-bucket",
    size: 512000,
    contentType: "application/pdf",
    link: "https://example.com/link",
    expiresAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function buildCleanCmd() {
  const { Command } = require("commander") as typeof import("commander");
  const program = new Command();
  program.exitOverride();
  registerClean(program);
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

// ─── clean command tests ─────────────────────────────────────────────────────

describe("clean command", () => {
  beforeEach(() => {
    mockFindAll.mockReset();
    mockDeleteDb.mockReset();
    mockDbClose.mockReset();
    mockS3Delete.mockReset();
    mockS3Delete.mockImplementation(async () => {});
  });

  it("deletes expired attachments from S3 and DB", async () => {
    const expired1 = makeAttachment({
      id: "att_exp1",
      s3Key: "uploads/exp1.pdf",
      size: 1024 * 1024, // 1 MB
      expiresAt: Date.now() - 1000,
    });
    const expired2 = makeAttachment({
      id: "att_exp2",
      s3Key: "uploads/exp2.pdf",
      size: 2 * 1024 * 1024, // 2 MB
      expiresAt: Date.now() - 5000,
    });

    mockFindAll.mockImplementation(() => [expired1, expired2]);

    const capture = captureOutput();
    try {
      const program = buildCleanCmd();
      await program.parseAsync(["clean"], { from: "user" });

      expect(mockS3Delete).toHaveBeenCalledTimes(2);
      expect(mockS3Delete).toHaveBeenCalledWith("uploads/exp1.pdf");
      expect(mockS3Delete).toHaveBeenCalledWith("uploads/exp2.pdf");
      expect(mockDeleteDb).toHaveBeenCalledTimes(2);
      expect(mockDeleteDb).toHaveBeenCalledWith("att_exp1");
      expect(mockDeleteDb).toHaveBeenCalledWith("att_exp2");

      const output = capture.out.join("");
      expect(output).toContain("Cleaned 2 expired attachments");
      expect(output).toContain("freed");
    } finally {
      capture.restore();
    }
  });

  it("reports no expired attachments when none exist", async () => {
    // Return only non-expired attachments
    const valid = makeAttachment({
      id: "att_valid",
      expiresAt: Date.now() + 60000, // expires in the future
    });
    mockFindAll.mockImplementation(() => [valid]);

    const capture = captureOutput();
    try {
      const program = buildCleanCmd();
      await program.parseAsync(["clean"], { from: "user" });

      expect(mockS3Delete).not.toHaveBeenCalled();
      expect(mockDeleteDb).not.toHaveBeenCalled();
      expect(capture.out.join("")).toContain("No expired attachments found.");
    } finally {
      capture.restore();
    }
  });

  it("reports no expired attachments when DB is empty", async () => {
    mockFindAll.mockImplementation(() => []);

    const capture = captureOutput();
    try {
      const program = buildCleanCmd();
      await program.parseAsync(["clean"], { from: "user" });

      expect(capture.out.join("")).toContain("No expired attachments found.");
    } finally {
      capture.restore();
    }
  });

  it("does not delete when --dry-run is passed", async () => {
    const expired = makeAttachment({
      id: "att_dry",
      s3Key: "uploads/dry.pdf",
      size: 512000,
      expiresAt: Date.now() - 1000,
    });
    mockFindAll.mockImplementation(() => [expired]);

    const capture = captureOutput();
    try {
      const program = buildCleanCmd();
      await program.parseAsync(["clean", "--dry-run"], { from: "user" });

      expect(mockS3Delete).not.toHaveBeenCalled();
      expect(mockDeleteDb).not.toHaveBeenCalled();

      const output = capture.out.join("");
      expect(output).toContain("Would clean 1 expired attachment");
      expect(output).toContain("500");
    } finally {
      capture.restore();
    }
  });

  it("skips attachments with null expiresAt (never expire)", async () => {
    const neverExpires = makeAttachment({
      id: "att_never",
      expiresAt: null,
    });
    const expired = makeAttachment({
      id: "att_gone",
      s3Key: "uploads/gone.pdf",
      size: 2048,
      expiresAt: Date.now() - 1000,
    });
    mockFindAll.mockImplementation(() => [neverExpires, expired]);

    const capture = captureOutput();
    try {
      const program = buildCleanCmd();
      await program.parseAsync(["clean"], { from: "user" });

      expect(mockS3Delete).toHaveBeenCalledTimes(1);
      expect(mockS3Delete).toHaveBeenCalledWith("uploads/gone.pdf");
      expect(mockDeleteDb).toHaveBeenCalledTimes(1);
      expect(mockDeleteDb).toHaveBeenCalledWith("att_gone");

      const output = capture.out.join("");
      expect(output).toContain("Cleaned 1 expired attachment");
    } finally {
      capture.restore();
    }
  });

  it("handles S3 delete errors gracefully", async () => {
    const expired = makeAttachment({
      id: "att_s3err",
      s3Key: "uploads/s3err.pdf",
      expiresAt: Date.now() - 1000,
    });
    mockFindAll.mockImplementation(() => [expired]);
    mockS3Delete.mockImplementation(async () => {
      throw new Error("S3 network error");
    });

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildCleanCmd();
      await expect(
        program.parseAsync(["clean"], { from: "user" })
      ).rejects.toThrow();
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("calls db.close in all cases", async () => {
    mockFindAll.mockImplementation(() => []);

    const capture = captureOutput();
    try {
      const program = buildCleanCmd();
      await program.parseAsync(["clean"], { from: "user" });
      expect(mockDbClose).toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });

  it("uses singular form for 1 attachment", async () => {
    const expired = makeAttachment({
      id: "att_single",
      s3Key: "uploads/single.pdf",
      size: 1024,
      expiresAt: Date.now() - 1000,
    });
    mockFindAll.mockImplementation(() => [expired]);

    const capture = captureOutput();
    try {
      const program = buildCleanCmd();
      await program.parseAsync(["clean"], { from: "user" });

      const output = capture.out.join("");
      expect(output).toContain("1 expired attachment ");
      expect(output).not.toContain("attachments");
    } finally {
      capture.restore();
    }
  });
});
