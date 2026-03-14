import { describe, it, expect, mock, beforeEach, spyOn, afterAll } from "bun:test";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock fetch before importing the command
// ---------------------------------------------------------------------------
const mockFetch = mock(async (_url: string) => ({
  ok: true,
  status: 200,
  json: async () => [
    { role: "user", content: "Hello", timestamp: 1700000000000 },
    { role: "assistant", content: "Hi there", timestamp: 1700000001000 },
  ],
}));

// Replace global fetch
(global as unknown as Record<string, unknown>).fetch = mockFetch;

// ---------------------------------------------------------------------------
// Mock uploadFromBuffer
// ---------------------------------------------------------------------------
const mockUploadFromBuffer = mock(
  async (_buffer: Buffer, _filename: string, _opts: unknown) => ({
    id: "att_snap00001",
    filename: "session-abc123.md",
    s3Key: "attachments/2026-01-01/att_snap00001/session-abc123.md",
    bucket: "my-bucket",
    size: 256,
    contentType: "text/markdown",
    link: "https://s3.example.com/presigned?sig=snap",
    expiresAt: 1742000000000,
    createdAt: 1741913600000,
  })
);

mock.module("../../core/upload", () => ({
  uploadFromBuffer: mockUploadFromBuffer,
  uploadFile: mock(async () => ({})),
  uploadFromUrl: mock(async () => ({})),
}));

// Import after mocks
const { registerSnapshotSession } = await import("./snapshot-session");

afterAll(() => mock.restore());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  registerSnapshotSession(program);
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

describe("snapshot-session command", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => [
        { role: "user", content: "Hello", timestamp: 1700000000000 },
        { role: "assistant", content: "Hi there", timestamp: 1700000001000 },
      ],
    }));
    mockUploadFromBuffer.mockReset();
    mockUploadFromBuffer.mockImplementation(async (_buffer: Buffer, filename: string, _opts: unknown) => ({
      id: "att_snap00001",
      filename,
      s3Key: `attachments/2026-01-01/att_snap00001/${filename}`,
      bucket: "my-bucket",
      size: 256,
      contentType: "text/markdown",
      link: "https://s3.example.com/presigned?sig=snap",
      expiresAt: 1742000000000,
      createdAt: 1741913600000,
    }));
  });

  it("calls sessions API with the correct URL", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["snapshot-session", "abc123"], { from: "user" });
      const calledUrl = (mockFetch.mock.calls[0] as [string])[0];
      expect(calledUrl).toContain("abc123");
      expect(calledUrl).toContain("localhost:3458");
    } finally {
      capture.restore();
    }
  });

  it("uses custom --sessions-url when provided", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(
        ["snapshot-session", "sess99", "--sessions-url", "http://localhost:9000"],
        { from: "user" }
      );
      const calledUrl = (mockFetch.mock.calls[0] as [string])[0];
      expect(calledUrl).toContain("localhost:9000");
    } finally {
      capture.restore();
    }
  });

  it("uploads as markdown by default", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["snapshot-session", "abc123"], { from: "user" });
      const [_buf, filename] = mockUploadFromBuffer.mock.calls[0] as [Buffer, string, unknown];
      expect(filename).toEndWith(".md");
      const content = _buf.toString("utf-8");
      expect(content).toContain("# Session Snapshot");
      expect(content).toContain("### user");
      expect(content).toContain("Hello");
    } finally {
      capture.restore();
    }
  });

  it("uploads as HTML when --format html is passed", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["snapshot-session", "abc123", "--format", "html"], { from: "user" });
      const [_buf, filename] = mockUploadFromBuffer.mock.calls[0] as [Buffer, string, unknown];
      expect(filename).toEndWith(".html");
      const content = _buf.toString("utf-8");
      expect(content).toContain("<!DOCTYPE html>");
      expect(content).toContain("Hello");
    } finally {
      capture.restore();
    }
  });

  it("passes expiry option to uploadFromBuffer", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["snapshot-session", "abc123", "--expiry", "7d"], { from: "user" });
      const [, , opts] = mockUploadFromBuffer.mock.calls[0] as [Buffer, string, { expiry?: string }];
      expect(opts.expiry).toBe("7d");
    } finally {
      capture.restore();
    }
  });

  it("passes tag option to uploadFromBuffer", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["snapshot-session", "abc123", "--tag", "qa"], { from: "user" });
      const [, , opts] = mockUploadFromBuffer.mock.calls[0] as [Buffer, string, { tag?: string }];
      expect(opts.tag).toBe("qa");
    } finally {
      capture.restore();
    }
  });

  it("outputs success message with link and ID", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["snapshot-session", "abc123"], { from: "user" });
      const combined = capture.out.join("");
      expect(combined).toContain("✓ Snapshot of session abc123");
      expect(combined).toContain("https://s3.example.com/presigned?sig=snap");
      expect(combined).toContain("att_snap00001");
    } finally {
      capture.restore();
    }
  });

  it("falls back to /api/sessions/:id when messages endpoint fails", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if ((url as string).includes("/messages")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [{ role: "user", content: "Fallback" }] }),
      };
    });

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["snapshot-session", "fallback99"], { from: "user" });
      const [_buf] = mockUploadFromBuffer.mock.calls[0] as [Buffer, string, unknown];
      const content = _buf.toString("utf-8");
      expect(content).toContain("Fallback");
    } finally {
      capture.restore();
    }
  });

  it("exits with error when both endpoints fail", async () => {
    mockFetch.mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["snapshot-session", "bad-session"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("Failed to fetch session");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("handles wrapped { messages: [...] } response shape", async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [{ role: "system", content: "You are helpful" }],
      }),
    }));

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["snapshot-session", "wrapped99"], { from: "user" });
      const [_buf] = mockUploadFromBuffer.mock.calls[0] as [Buffer, string, unknown];
      expect(_buf.toString("utf-8")).toContain("You are helpful");
    } finally {
      capture.restore();
    }
  });
});
