import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";

// ---------------------------------------------------------------------------
// Mock core/db before importing the command
// ---------------------------------------------------------------------------

type MockAttachment = {
  id: string;
  filename: string;
  s3Key: string;
  bucket: string;
  size: number;
  contentType: string;
  link: string | null;
  expiresAt: number | null;
  createdAt: number;
};

const mockFindById = mock((_id: string): MockAttachment | null => null);
const mockDbClose = mock(() => {});

mock.module("../../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    constructor(_path?: string) {}
    findById = mockFindById;
    close = mockDbClose;
    findAll = mock(() => []);
    insert = mock(() => {});
    delete = mock(() => {});
    updateLink = mock(() => {});
    deleteExpired = mock(() => 0);
  },
}));

// Import after mocks
const { linkAttachmentToTask, registerLinkTask } = await import("./link-task");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAttachment(overrides: Partial<MockAttachment> = {}): MockAttachment {
  return {
    id: "att_abc123",
    filename: "report.pdf",
    s3Key: "attachments/2024-01-01/att_abc123/report.pdf",
    bucket: "test-bucket",
    size: 102400,
    contentType: "application/pdf",
    link: "https://example.com/link/att_abc123",
    expiresAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeFetch(status: number, body: string = ""): typeof fetch {
  return mock(async (_url: unknown, _opts: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  })) as unknown as typeof fetch;
}

function buildProgram() {
  const { Command } = require("commander") as typeof import("commander");
  const program = new Command();
  program.exitOverride();
  registerLinkTask(program);
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
// linkAttachmentToTask unit tests
// ---------------------------------------------------------------------------

describe("linkAttachmentToTask", () => {
  beforeEach(() => {
    mockFindById.mockReset();
    mockDbClose.mockReset();
  });

  it("calls PATCH /api/tasks/:taskId with attachment info", async () => {
    const att = makeAttachment();
    mockFindById.mockImplementation(() => att);

    const fakeFetch = makeFetch(200);
    await linkAttachmentToTask("att_abc123", "TASK-001", "http://localhost:3000", fakeFetch);

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (fakeFetch as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/tasks/TASK-001");
    expect(opts.method).toBe("PATCH");

    const body = JSON.parse(opts.body as string);
    expect(body.metadata._attachments).toHaveLength(1);
    expect(body.metadata._attachments[0].id).toBe("att_abc123");
    expect(body.metadata._attachments[0].filename).toBe("report.pdf");
    expect(body.metadata._attachments[0].link).toBe("https://example.com/link/att_abc123");
    expect(body.metadata._attachments[0].size).toBe(102400);
  });

  it("throws when attachment not found in DB", async () => {
    mockFindById.mockImplementation(() => null);
    const fakeFetch = makeFetch(200);

    await expect(
      linkAttachmentToTask("att_missing", "TASK-001", "http://localhost:3000", fakeFetch)
    ).rejects.toThrow("Attachment not found: att_missing");

    // fetch should not be called if attachment doesn't exist
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("throws when task not found (404)", async () => {
    const att = makeAttachment();
    mockFindById.mockImplementation(() => att);

    const fakeFetch = makeFetch(404, "Task not found");
    await expect(
      linkAttachmentToTask("att_abc123", "TASK-999", "http://localhost:3000", fakeFetch)
    ).rejects.toThrow("Task not found: TASK-999");
  });

  it("throws with HTTP status when server returns non-200 non-404", async () => {
    const att = makeAttachment();
    mockFindById.mockImplementation(() => att);

    const fakeFetch = makeFetch(500, "Internal error");
    await expect(
      linkAttachmentToTask("att_abc123", "TASK-001", "http://localhost:3000", fakeFetch)
    ).rejects.toThrow("HTTP 500");
  });

  it("handles attachment with null link", async () => {
    const att = makeAttachment({ link: null });
    mockFindById.mockImplementation(() => att);

    const fakeFetch = makeFetch(200);
    await linkAttachmentToTask("att_abc123", "TASK-001", "http://localhost:3000", fakeFetch);

    const [, opts] = (fakeFetch as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.metadata._attachments[0].link).toBeNull();
  });

  it("closes the DB whether or not an error occurs", async () => {
    mockFindById.mockImplementation(() => null);
    const fakeFetch = makeFetch(200);

    await expect(
      linkAttachmentToTask("att_missing", "TASK-001", "http://localhost:3000", fakeFetch)
    ).rejects.toThrow();

    expect(mockDbClose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CLI command tests
// ---------------------------------------------------------------------------

describe("link-task CLI command", () => {
  beforeEach(() => {
    mockFindById.mockReset();
    mockDbClose.mockReset();
  });

  it("outputs success message on successful link", async () => {
    const att = makeAttachment();
    mockFindById.mockImplementation(() => att);

    // Patch global fetch for the CLI test
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(200);

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["link-task", "att_abc123", "TASK-001"], { from: "user" });
      expect(capture.out.join("")).toContain("✓ Linked att_abc123 → task TASK-001");
    } finally {
      capture.restore();
      globalThis.fetch = originalFetch;
    }
  });

  it("uses custom --todos-url when provided", async () => {
    const att = makeAttachment();
    mockFindById.mockImplementation(() => att);

    let capturedUrl = "";
    globalThis.fetch = mock(async (url: unknown) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(
        ["link-task", "att_abc123", "TASK-001", "--todos-url", "http://localhost:4000"],
        { from: "user" }
      );
      expect(capturedUrl).toContain("http://localhost:4000");
    } finally {
      capture.restore();
    }
  });

  it("writes error to stderr and exits when attachment not found", async () => {
    mockFindById.mockImplementation(() => null);

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["link-task", "att_missing", "TASK-001"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("not found");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("writes error to stderr and exits when task not found (404)", async () => {
    const att = makeAttachment();
    mockFindById.mockImplementation(() => att);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(404);

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["link-task", "att_abc123", "TASK-999"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("TASK-999");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });
});
