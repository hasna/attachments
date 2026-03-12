import { describe, it, expect, beforeEach, mock, spyOn, afterAll } from "bun:test";

// ---------------------------------------------------------------------------
// Mock DB for command-level tests
// ---------------------------------------------------------------------------

const mockFindAll = mock((_opts?: unknown) => [] as Array<{
  id: string; filename: string; s3Key: string; bucket: string; size: number;
  contentType: string; link: string | null; expiresAt: number | null; createdAt: number;
}>);
const mockInsert = mock((_att: unknown) => {});
const mockDbClose = mock(() => {});

mock.module("../../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    constructor(_path?: string) {}
    findAll = mockFindAll;
    insert = mockInsert;
    close = mockDbClose;
    findById = mock((_id: string) => null);
    delete = mock((_id: string) => {});
    updateLink = mock((_id: string, _link: string) => {});
    deleteExpired = mock(() => 0);
  },
}));

// Restore mocks after this file's tests complete
afterAll(() => mock.restore());

// Import the actual listCommand under test
const { listCommand } = await import("./list");

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeAttachment(overrides: Partial<{
  id: string; filename: string; s3Key: string; bucket: string; size: number;
  contentType: string; link: string | null; expiresAt: number | null; createdAt: number;
}> = {}): {
  id: string; filename: string; s3Key: string; bucket: string; size: number;
  contentType: string; link: string | null; expiresAt: number | null; createdAt: number;
} {
  return {
    id: "att_test001",
    filename: "photo.png",
    s3Key: "uploads/photo.png",
    bucket: "my-bucket",
    size: 1024 * 1024, // 1 MB
    contentType: "image/png",
    link: "https://example.com/link",
    expiresAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

// ─── formatBytes helper (tested independently) ────────────────────────────────
import { formatBytes, formatExpiry, exitError } from "../utils";

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(2048)).toMatch(/KB/);
  });

  it("formats megabytes", () => {
    expect(formatBytes(1024 * 1024)).toMatch(/MB/);
  });

  it("formats large megabyte values", () => {
    // The existing formatBytes tops out at MB — 1 GB shows as "1024.0 MB"
    const result = formatBytes(1024 * 1024 * 1024);
    expect(result).toMatch(/MB/);
  });
});

describe("formatExpiry", () => {
  it("returns 'Never' for null", () => {
    expect(formatExpiry(null)).toBe("Never");
  });

  it("returns a string for a future timestamp", () => {
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const result = formatExpiry(future);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("exitError", () => {
  it("writes error message to stderr and exits with code 1", () => {
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });

    try {
      expect(() => exitError("something went wrong")).toThrow("process.exit called");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const written = String((stderrSpy.mock.calls[0] as [string])[0]);
      expect(written).toContain("something went wrong");
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

// ─── list command output ──────────────────────────────────────────────────────

// We test the core formatting logic rather than invoking the Commander action
// directly (which would call process.exit). We extract the compact/table/json
// rendering functions by re-implementing the same logic used in list.ts.

function compactLine(att: ReturnType<typeof makeAttachment>): string {
  const bytes = formatBytes(att.size);
  const expiry = formatExpiry(att.expiresAt);
  const link = att.link ?? "(no link)";
  return `${att.id}  ${att.filename}  ${bytes}  ${link}  ${expiry}`;
}

describe("compact format line", () => {
  it("includes id, filename, size, link, expiry", () => {
    const att = makeAttachment({ id: "att_abc123", filename: "file.txt", size: 1258291 });
    const line = compactLine(att);
    expect(line).toContain("att_abc123");
    expect(line).toContain("file.txt");
    expect(line).toContain("MB");
    expect(line).toContain("https://example.com/link");
    expect(line).toContain("Never");
  });

  it("shows (no link) when link is null", () => {
    const att = makeAttachment({ link: null });
    const line = compactLine(att);
    expect(line).toContain("(no link)");
  });

  it("shows expiry date when expiresAt is set", () => {
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const att = makeAttachment({ expiresAt: future });
    const line = compactLine(att);
    expect(line).not.toContain("Never");
    expect(typeof line).toBe("string");
  });
});

// ─── listCommand integration tests ────────────────────────────────────────────

function buildListCmd() {
  const { Command } = require("commander") as typeof import("commander");
  const program = new Command();
  program.exitOverride();
  program.addCommand(listCommand());
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

describe("listCommand", () => {
  beforeEach(() => {
    mockFindAll.mockReset();
    mockFindAll.mockImplementation(() => []);
    mockDbClose.mockReset();
  });

  it("outputs 'No attachments found.' when list is empty (compact format)", async () => {
    const capture = captureOutput();
    try {
      const program = buildListCmd();
      await program.parseAsync(["list"], { from: "user" });
      expect(capture.out.join("")).toContain("No attachments found.");
    } finally {
      capture.restore();
    }
  });

  it("outputs compact lines for each attachment", async () => {
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_abc", filename: "test.txt", size: 1024 }),
    ]);
    const capture = captureOutput();
    try {
      const program = buildListCmd();
      await program.parseAsync(["list"], { from: "user" });
      expect(capture.out.join("")).toContain("att_abc");
      expect(capture.out.join("")).toContain("test.txt");
    } finally {
      capture.restore();
    }
  });

  it("outputs JSON when --format json is used", async () => {
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_json_test" }),
    ]);
    const capture = captureOutput();
    try {
      const program = buildListCmd();
      await program.parseAsync(["list", "--format", "json"], { from: "user" });
      const combined = capture.out.join("");
      const parsed = JSON.parse(combined);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].id).toBe("att_json_test");
    } finally {
      capture.restore();
    }
  });

  it("outputs table format when --format table is used", async () => {
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_tbl", filename: "table.txt", size: 512 }),
    ]);
    const capture = captureOutput();
    try {
      const program = buildListCmd();
      await program.parseAsync(["list", "--format", "table"], { from: "user" });
      const combined = capture.out.join("");
      expect(combined).toContain("att_tbl");
      expect(combined).toContain("table.txt");
    } finally {
      capture.restore();
    }
  });

  it("outputs table 'No attachments found.' when empty and format is table", async () => {
    mockFindAll.mockImplementation(() => []);
    const capture = captureOutput();
    try {
      const program = buildListCmd();
      await program.parseAsync(["list", "--format", "table"], { from: "user" });
      expect(capture.out.join("")).toContain("No attachments found.");
    } finally {
      capture.restore();
    }
  });

  it("passes --expired flag to findAll as includeExpired", async () => {
    const capture = captureOutput();
    try {
      const program = buildListCmd();
      await program.parseAsync(["list", "--expired"], { from: "user" });
      const [opts] = mockFindAll.mock.calls[0] as [{ includeExpired: boolean; limit: number }];
      expect(opts.includeExpired).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it("passes --limit to findAll", async () => {
    const capture = captureOutput();
    try {
      const program = buildListCmd();
      await program.parseAsync(["list", "--limit", "5"], { from: "user" });
      const [opts] = mockFindAll.mock.calls[0] as [{ limit: number }];
      expect(opts.limit).toBe(5);
    } finally {
      capture.restore();
    }
  });

  it("exits with error for invalid format", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();
    try {
      const program = buildListCmd();
      await expect(
        program.parseAsync(["list", "--format", "invalid"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("--format must be one of");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with error for invalid --limit", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();
    try {
      const program = buildListCmd();
      await expect(
        program.parseAsync(["list", "--limit", "notanumber"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("--limit must be a positive integer");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("calls db.close in all cases", async () => {
    const capture = captureOutput();
    try {
      const program = buildListCmd();
      await program.parseAsync(["list"], { from: "user" });
      expect(mockDbClose).toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });
});
