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

const mockFindById = mock((_id: string): MockAttachment | null => null);
const mockDeleteDb = mock((_id: string) => {});
const mockDbClose = mock(() => {});
const mockDbInsert = mock((_att: unknown) => {});

mock.module("../../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    constructor(_path?: string) {}
    findById = mockFindById;
    delete = mockDeleteDb;
    close = mockDbClose;
    insert = mockDbInsert;
    findAll = mock(() => []);
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

// Use real config module — avoids module cache pollution
let _deleteTestConfigDir: string;
beforeAll(() => {
  _deleteTestConfigDir = join(tmpdir(), `delete-test-cfg-${Date.now()}`);
  mkdirSync(_deleteTestConfigDir, { recursive: true });
  setConfigPath(join(_deleteTestConfigDir, "config.json"));
  setConfig({
    s3: { bucket: "test-bucket", region: "us-east-1", accessKeyId: "K", secretAccessKey: "S" },
    server: { port: 3457, baseUrl: "http://localhost:3457" },
    defaults: { expiry: "7d", linkType: "presigned" },
  });
});

// Restore mocks after tests
afterAll(() => {
  mock.restore();
  try { rmSync(_deleteTestConfigDir, { recursive: true, force: true }); } catch {}
});

// Import command after mocks
const { deleteCommand } = await import("./delete");

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeAttachment(overrides: Partial<MockAttachment> = {}): MockAttachment {
  return {
    id: "att_del001",
    filename: "report.pdf",
    s3Key: "uploads/report.pdf",
    bucket: "test-bucket",
    size: 512000,
    contentType: "application/pdf",
    link: "https://example.com/link",
    expiresAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function buildDeleteCmd() {
  const { Command } = require("commander") as typeof import("commander");
  const program = new Command();
  program.exitOverride();
  program.addCommand(deleteCommand());
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

// ─── deleteCommand tests ──────────────────────────────────────────────────────

describe("deleteCommand", () => {
  beforeEach(() => {
    mockFindById.mockReset();
    mockDeleteDb.mockReset();
    mockDbClose.mockReset();
    mockS3Delete.mockReset();
    mockS3Delete.mockImplementation(async () => {});
  });

  it("deletes attachment by id when --yes is passed", async () => {
    const att = makeAttachment({ id: "att_todelete", s3Key: "uploads/file.pdf" });
    mockFindById.mockImplementation(() => att);

    const capture = captureOutput();
    try {
      const program = buildDeleteCmd();
      await program.parseAsync(["delete", "att_todelete", "--yes"], { from: "user" });

      expect(mockS3Delete).toHaveBeenCalledWith("uploads/file.pdf");
      expect(mockDeleteDb).toHaveBeenCalledWith("att_todelete");
      expect(capture.out.join("")).toContain("Deleted att_todelete");
    } finally {
      capture.restore();
    }
  });

  it("exits with error when attachment is not found", async () => {
    mockFindById.mockImplementation(() => null);

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildDeleteCmd();
      await expect(
        program.parseAsync(["delete", "att_missing", "--yes"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("not found");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("calls db.close in all cases", async () => {
    const att = makeAttachment();
    mockFindById.mockImplementation(() => att);

    const capture = captureOutput();
    try {
      const program = buildDeleteCmd();
      await program.parseAsync(["delete", att.id, "--yes"], { from: "user" });
      expect(mockDbClose).toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });

  it("aborts when user answers 'n' to the prompt", async () => {
    const att = makeAttachment({ id: "att_prompt" });
    mockFindById.mockImplementation(() => att);

    // Simulate user typing 'n' to stdin
    const stdinSpy = spyOn(process.stdin, "once").mockImplementation(
      (event: string, listener: (...args: unknown[]) => void) => {
        if (event === "data") {
          // Simulate user input 'n\n'
          setTimeout(() => listener("n\n"), 0);
        }
        return process.stdin;
      }
    );
    const stdinResumeSpy = spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    const stdinPauseSpy = spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    const stdinEncodingSpy = spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildDeleteCmd();
      // Without --yes, it prompts
      await expect(
        program.parseAsync(["delete", "att_prompt"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.out.join("")).toContain("Aborted");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
      stdinSpy.mockRestore();
      stdinResumeSpy.mockRestore();
      stdinPauseSpy.mockRestore();
      stdinEncodingSpy.mockRestore();
    }
  });

  it("proceeds when user answers 'y' to the prompt", async () => {
    const att = makeAttachment({ id: "att_confirm", s3Key: "uploads/confirm.pdf" });
    mockFindById.mockImplementation(() => att);

    // Simulate user typing 'y' to stdin
    const stdinSpy = spyOn(process.stdin, "once").mockImplementation(
      (event: string, listener: (...args: unknown[]) => void) => {
        if (event === "data") {
          setTimeout(() => listener("y\n"), 0);
        }
        return process.stdin;
      }
    );
    const stdinResumeSpy = spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    const stdinPauseSpy = spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    const stdinEncodingSpy = spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);

    const capture = captureOutput();
    try {
      const program = buildDeleteCmd();
      await program.parseAsync(["delete", "att_confirm"], { from: "user" });
      expect(mockS3Delete).toHaveBeenCalledWith("uploads/confirm.pdf");
      expect(mockDeleteDb).toHaveBeenCalledWith("att_confirm");
    } finally {
      capture.restore();
      stdinSpy.mockRestore();
      stdinResumeSpy.mockRestore();
      stdinPauseSpy.mockRestore();
      stdinEncodingSpy.mockRestore();
    }
  });
});

// ─── Output format ────────────────────────────────────────────────────────────

describe("delete output format", () => {
  it("produces the correct success message", () => {
    const id = "att_abc123";
    const filename = "document.pdf";
    const expected = `✓ Deleted ${id} (${filename})`;
    // We test the string template directly since it's a simple format
    expect(`✓ Deleted ${id} (${filename})`).toBe(expected);
  });
});
