import { describe, it, expect, mock, beforeEach, spyOn, afterAll } from "bun:test";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock core/download before importing the command
// ---------------------------------------------------------------------------
const mockDownloadAttachment = mock(async (_idOrUrl: string, _destPath?: string) => ({
  path: "/tmp/hello.txt",
  filename: "hello.txt",
  size: 556032, // ~543 KB
}));

mock.module("../../core/download", () => ({
  downloadAttachment: mockDownloadAttachment,
}));

// Import after mocks
const { registerDownload } = await import("./download");

// Restore all mocks after this file's tests complete so they don't leak into other test files
afterAll(() => mock.restore());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  registerDownload(program);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("download command", () => {
  beforeEach(() => {
    mockDownloadAttachment.mockReset();
    mockDownloadAttachment.mockImplementation(async () => ({
      path: "/tmp/hello.txt",
      filename: "hello.txt",
      size: 556032,
    }));
  });

  it("calls downloadAttachment with the given ID", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["download", "att_abc123xyz"], { from: "user" });
      expect(mockDownloadAttachment).toHaveBeenCalledTimes(1);
      const [calledId] = mockDownloadAttachment.mock.calls[0] as [string, string | undefined];
      expect(calledId).toBe("att_abc123xyz");
    } finally {
      capture.restore();
    }
  });

  it("calls downloadAttachment with a /d/:id URL", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(
        ["download", "http://localhost:3457/d/att_abc123xyz"],
        { from: "user" }
      );
      const [calledId] = mockDownloadAttachment.mock.calls[0] as [string, string | undefined];
      expect(calledId).toBe("http://localhost:3457/d/att_abc123xyz");
    } finally {
      capture.restore();
    }
  });

  it("passes --output path to downloadAttachment", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(
        ["download", "att_abc123xyz", "--output", "/downloads/"],
        { from: "user" }
      );
      const [, calledDest] = mockDownloadAttachment.mock.calls[0] as [string, string | undefined];
      expect(calledDest).toBe("/downloads/");
    } finally {
      capture.restore();
    }
  });

  it("does not pass output path when --output is not provided", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["download", "att_abc123xyz"], { from: "user" });
      const [, calledDest] = mockDownloadAttachment.mock.calls[0] as [string, string | undefined];
      expect(calledDest).toBeUndefined();
    } finally {
      capture.restore();
    }
  });

  it("outputs success message with filename, path, and size", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["download", "att_abc123xyz"], { from: "user" });
      const combined = capture.out.join("");
      expect(combined).toContain("✓ Downloaded hello.txt");
      expect(combined).toContain("/tmp/hello.txt");
      expect(combined).toContain("543 KB");
    } finally {
      capture.restore();
    }
  });

  it("exits with error when attachment is not found", async () => {
    mockDownloadAttachment.mockImplementation(async () => {
      throw new Error("Attachment not found");
    });

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["download", "att_missing"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("Attachment not found");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with error when attachment has expired", async () => {
    mockDownloadAttachment.mockImplementation(async () => {
      throw new Error("Attachment has expired");
    });

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["download", "att_expired"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("Attachment has expired");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("formats byte sizes correctly: bytes for small files", async () => {
    mockDownloadAttachment.mockImplementation(async () => ({
      path: "/tmp/tiny.txt",
      filename: "tiny.txt",
      size: 12,
    }));

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["download", "att_tiny"], { from: "user" });
      expect(capture.out.join("")).toContain("12 B");
    } finally {
      capture.restore();
    }
  });

  it("formats byte sizes correctly: MB for large files", async () => {
    mockDownloadAttachment.mockImplementation(async () => ({
      path: "/tmp/big.zip",
      filename: "big.zip",
      size: 5242880, // 5 MB exactly
    }));

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["download", "att_big"], { from: "user" });
      expect(capture.out.join("")).toContain("5.0 MB");
    } finally {
      capture.restore();
    }
  });
});
