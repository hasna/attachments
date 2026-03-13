import { describe, it, expect, beforeAll, beforeEach, mock, spyOn, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { setConfigPath, setConfig } from "../../core/config";

// ---------------------------------------------------------------------------
// Mock modules for command-level tests
// ---------------------------------------------------------------------------

const mockDbInsert = mock((_att: unknown) => {});
const mockDbClose = mock(() => {});

mock.module("../../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    constructor(_path?: string) {}
    insert = mockDbInsert;
    close = mockDbClose;
    findById = mock(() => null);
    findAll = mock(() => []);
    updateLink = mock(() => {});
    delete = mock(() => {});
    deleteExpired = mock(() => 0);
  },
}));

const mockPresignPut = mock(async (_key: string, _contentType: string, _expiresIn: number) =>
  "https://s3.example.com/put-presigned?sig=abc"
);

mock.module("../../core/s3", () => ({
  S3Client: class MockS3Client {
    constructor(_cfg: unknown) {}
    presignPut = mockPresignPut;
    presign = mock(async () => "https://presigned");
    upload = mock(async () => {});
    download = mock(async () => Buffer.from(""));
    delete = mock(async () => {});
  },
}));

// Use real config module pointed at a temp file
let _presignTestConfigDir: string;
beforeAll(() => {
  _presignTestConfigDir = join(tmpdir(), `presign-test-cfg-${Date.now()}`);
  mkdirSync(_presignTestConfigDir, { recursive: true });
  setConfigPath(join(_presignTestConfigDir, "config.json"));
  setConfig({
    s3: { bucket: "test-bucket", region: "us-east-1", accessKeyId: "K", secretAccessKey: "S" },
    server: { port: 3457, baseUrl: "http://localhost:3457" },
    defaults: { expiry: "7d", linkType: "presigned" },
  });
});

afterAll(() => {
  mock.restore();
  try { rmSync(_presignTestConfigDir, { recursive: true, force: true }); } catch {}
});

// Import after mocks
const { presignUploadCommand } = await import("./presign");

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildPresignCmd() {
  const { Command } = require("commander") as typeof import("commander");
  const program = new Command();
  program.exitOverride();
  program.addCommand(presignUploadCommand());
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

describe("presign-upload command", () => {
  beforeEach(() => {
    mockDbInsert.mockReset();
    mockDbClose.mockReset();
    mockPresignPut.mockReset();
    mockPresignPut.mockImplementation(async () => "https://s3.example.com/put-presigned?sig=abc");
  });

  it("generates presigned URL and outputs upload info", async () => {
    const capture = captureOutput();
    try {
      const program = buildPresignCmd();
      await program.parseAsync(["presign-upload", "report.pdf"], { from: "user" });
      const out = capture.out.join("");
      expect(out).toContain("Upload URL:");
      expect(out).toContain("https://s3.example.com/put-presigned?sig=abc");
      expect(out).toContain("ID: att_");
      expect(out).toContain("curl -X PUT");
    } finally {
      capture.restore();
    }
  });

  it("calls s3.presignPut with correct parameters", async () => {
    const capture = captureOutput();
    try {
      const program = buildPresignCmd();
      await program.parseAsync(["presign-upload", "report.pdf", "--expiry", "2h"], { from: "user" });
      expect(mockPresignPut).toHaveBeenCalledTimes(1);
      const [key, contentType, expiresIn] = mockPresignPut.mock.calls[0] as [string, string, number];
      expect(key).toContain("report.pdf");
      expect(contentType).toBe("application/pdf");
      expect(expiresIn).toBe(7200); // 2h in seconds
    } finally {
      capture.restore();
    }
  });

  it("inserts a DB record with size 0", async () => {
    const capture = captureOutput();
    try {
      const program = buildPresignCmd();
      await program.parseAsync(["presign-upload", "data.csv"], { from: "user" });
      expect(mockDbInsert).toHaveBeenCalledTimes(1);
      const [att] = mockDbInsert.mock.calls[0] as [{ size: number; filename: string; contentType: string }];
      expect(att.size).toBe(0);
      expect(att.filename).toBe("data.csv");
      expect(att.contentType).toBe("text/csv");
    } finally {
      capture.restore();
    }
  });

  it("uses custom content-type when provided", async () => {
    const capture = captureOutput();
    try {
      const program = buildPresignCmd();
      await program.parseAsync(["presign-upload", "file.bin", "--content-type", "application/octet-stream"], { from: "user" });
      const [key, contentType] = mockPresignPut.mock.calls[0] as [string, string, number];
      expect(contentType).toBe("application/octet-stream");
    } finally {
      capture.restore();
    }
  });

  it("defaults expiry to 1h", async () => {
    const capture = captureOutput();
    try {
      const program = buildPresignCmd();
      await program.parseAsync(["presign-upload", "file.txt"], { from: "user" });
      const [, , expiresIn] = mockPresignPut.mock.calls[0] as [string, string, number];
      expect(expiresIn).toBe(3600); // 1h in seconds
    } finally {
      capture.restore();
    }
  });

  it("exits with error for invalid expiry format", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildPresignCmd();
      await expect(
        program.parseAsync(["presign-upload", "file.txt", "--expiry", "invalid"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("Invalid expiry format");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("closes the database after insert", async () => {
    const capture = captureOutput();
    try {
      const program = buildPresignCmd();
      await program.parseAsync(["presign-upload", "test.png"], { from: "user" });
      expect(mockDbClose).toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });
});
