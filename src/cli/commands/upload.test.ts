import { describe, it, expect, mock, beforeEach, spyOn, afterAll } from "bun:test";
import { Command } from "commander";
import * as configModule from "../../core/config";

// ---------------------------------------------------------------------------
// Mock core/upload and core/config before importing the command
// ---------------------------------------------------------------------------
const mockUploadFile = mock(async (_filePath: string, _opts: unknown) => ({
  id: "att_testid1234",
  filename: "test.txt",
  s3Key: "attachments/2026-01-01/att_testid1234/test.txt",
  bucket: "my-bucket",
  size: 1258291, // ~1.2 MB
  contentType: "text/plain",
  link: "https://s3.example.com/presigned?sig=abc",
  expiresAt: 1742000000000,
  createdAt: 1741913600000,
}));

mock.module("../../core/upload", () => ({
  uploadFile: mockUploadFile,
}));

// spyOn validateS3Config to avoid mock.module cache pollution
const mockValidateS3Config = spyOn(configModule, "validateS3Config").mockImplementation(() => {});

// Import after mocks
const { registerUpload } = await import("./upload");

// Restore all mocks after this file's tests complete so they don't leak into other test files
afterAll(() => mock.restore());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh Commander program with the upload command registered,
 * then parse the given argv array.
 * Returns captured stdout/stderr output.
 */
function buildProgram() {
  const program = new Command();
  program.exitOverride(); // prevent process.exit from actually exiting
  registerUpload(program);
  return program;
}

function captureOutput() {
  const out: string[] = [];
  const err: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

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
      void origStdout; // suppress unused warning
      void origStderr;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upload command", () => {
  beforeEach(() => {
    mockUploadFile.mockReset();
    mockUploadFile.mockImplementation(async () => ({
      id: "att_testid1234",
      filename: "test.txt",
      s3Key: "attachments/2026-01-01/att_testid1234/test.txt",
      bucket: "my-bucket",
      size: 1258291,
      contentType: "text/plain",
      link: "https://s3.example.com/presigned?sig=abc",
      expiresAt: 1742000000000,
      createdAt: 1741913600000,
    }));
    mockValidateS3Config.mockReset();
    mockValidateS3Config.mockImplementation(() => {});
  });

  it("calls uploadFile with the given file path", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "photo.png"], { from: "user" });
      expect(mockUploadFile).toHaveBeenCalledTimes(1);
      const [calledPath] = mockUploadFile.mock.calls[0] as [string, unknown];
      expect(calledPath).toBe("photo.png");
    } finally {
      capture.restore();
    }
  });

  it("passes expiry option to uploadFile", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "file.txt", "--expiry", "24h"], { from: "user" });
      const [, opts] = mockUploadFile.mock.calls[0] as [string, { expiry?: string }];
      expect(opts.expiry).toBe("24h");
    } finally {
      capture.restore();
    }
  });

  it("passes link-type option to uploadFile", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "file.txt", "--link-type", "server"], { from: "user" });
      const [, opts] = mockUploadFile.mock.calls[0] as [string, { linkType?: string }];
      expect(opts.linkType).toBe("server");
    } finally {
      capture.restore();
    }
  });

  it("outputs human-readable format by default", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "test.txt"], { from: "user" });
      const combined = capture.out.join("");
      expect(combined).toContain("✓ Uploaded test.txt");
      expect(combined).toContain("https://s3.example.com/presigned?sig=abc");
      expect(combined).toContain("att_testid1234");
      expect(combined).toContain("1.2 MB");
    } finally {
      capture.restore();
    }
  });

  it("outputs JSON format when --format json is passed", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "test.txt", "--format", "json"], { from: "user" });
      const combined = capture.out.join("");
      const parsed = JSON.parse(combined);
      expect(parsed.id).toBe("att_testid1234");
      expect(parsed.filename).toBe("test.txt");
      expect(parsed.size).toBe(1258291);
    } finally {
      capture.restore();
    }
  });

  it("exits with an error when S3 config is invalid", async () => {
    mockValidateS3Config.mockImplementation(() => {
      throw new Error("S3 configuration incomplete. Missing: bucket");
    });

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["upload", "file.txt"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("S3 configuration incomplete");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with an error when uploadFile throws", async () => {
    mockUploadFile.mockImplementation(async () => {
      throw new Error("Network failure");
    });

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["upload", "file.txt"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("Network failure");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("shows (none) as link when attachment.link is null", async () => {
    mockUploadFile.mockImplementation(async () => ({
      id: "att_nolink0001",
      filename: "nope.txt",
      s3Key: "attachments/2026-01-01/att_nolink0001/nope.txt",
      bucket: "my-bucket",
      size: 100,
      contentType: "text/plain",
      link: null,
      expiresAt: null,
      createdAt: Date.now(),
    }));

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "nope.txt"], { from: "user" });
      const combined = capture.out.join("");
      expect(combined).toContain("(none)");
      expect(combined).toContain("Never");
    } finally {
      capture.restore();
    }
  });

  it("exits with an error when --link-type has an invalid value", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["upload", "file.txt", "--link-type", "invalid-type"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("'presigned' or 'server'");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });
});
