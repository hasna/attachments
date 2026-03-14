import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";

// ---------------------------------------------------------------------------
// Mock core/upload before importing the command
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
  tag?: string | null;
};

const mockUploadFile = mock(async (_path: string, _opts?: object): Promise<MockAttachment> => ({
  id: "att_abc123",
  filename: "report.pdf",
  s3Key: "attachments/2024-01-01/att_abc123/report.pdf",
  bucket: "test-bucket",
  size: 102400,
  contentType: "application/pdf",
  link: "https://example.com/link/att_abc123",
  expiresAt: null,
  createdAt: Date.now(),
  tag: null,
}));

mock.module("../../core/upload", () => ({
  uploadFile: mockUploadFile,
  uploadFromBuffer: mock(async () => ({})),
  uploadFromUrl: mock(async () => ({})),
}));

// Import after mocks
const { completeTaskWithFiles, registerCompleteTask } = await import("./complete-task");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  registerCompleteTask(program);
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

function makeUpload(id: string, link: string | null = null) {
  return mock(async (_path: string, _opts?: object): Promise<MockAttachment> => ({
    id,
    filename: "file.txt",
    s3Key: `attachments/2024-01-01/${id}/file.txt`,
    bucket: "test-bucket",
    size: 1024,
    contentType: "text/plain",
    link,
    expiresAt: null,
    createdAt: Date.now(),
    tag: null,
  }));
}

// ---------------------------------------------------------------------------
// completeTaskWithFiles unit tests
// ---------------------------------------------------------------------------

describe("completeTaskWithFiles", () => {
  beforeEach(() => {
    mockUploadFile.mockReset();
  });

  it("uploads files and calls POST /api/tasks/:id/complete with attachment_ids", async () => {
    const upload = makeUpload("att_001", "https://example.com/att_001");
    const fakeFetch = makeFetch(200);

    const result = await completeTaskWithFiles(
      "TASK-001",
      ["/tmp/file.txt"],
      { todosUrl: "http://localhost:3000" },
      upload as unknown as typeof import("../../core/upload").uploadFile,
      fakeFetch
    );

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith("/tmp/file.txt", { expiry: undefined });

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (fakeFetch as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/tasks/TASK-001/complete");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body as string);
    expect(body.attachment_ids).toEqual(["att_001"]);
    expect(body.notes).toBeUndefined();

    expect(result.task_id).toBe("TASK-001");
    expect(result.attachment_ids).toEqual(["att_001"]);
    expect(result.links).toEqual(["https://example.com/att_001"]);
  });

  it("uploads multiple files and collects all attachment IDs", async () => {
    let callCount = 0;
    const upload = mock(async (_path: string, _opts?: object): Promise<MockAttachment> => {
      callCount++;
      return {
        id: `att_00${callCount}`,
        filename: "file.txt",
        s3Key: `key_${callCount}`,
        bucket: "test-bucket",
        size: 1024,
        contentType: "text/plain",
        link: `https://example.com/att_00${callCount}`,
        expiresAt: null,
        createdAt: Date.now(),
        tag: null,
      };
    });

    const fakeFetch = makeFetch(200);

    const result = await completeTaskWithFiles(
      "TASK-002",
      ["/tmp/file1.txt", "/tmp/file2.txt"],
      { todosUrl: "http://localhost:3000" },
      upload as unknown as typeof import("../../core/upload").uploadFile,
      fakeFetch
    );

    expect(upload).toHaveBeenCalledTimes(2);
    expect(result.attachment_ids).toEqual(["att_001", "att_002"]);
    expect(result.links).toEqual([
      "https://example.com/att_001",
      "https://example.com/att_002",
    ]);

    const [, opts] = (fakeFetch as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.attachment_ids).toEqual(["att_001", "att_002"]);
  });

  it("includes notes in the request body when provided", async () => {
    const upload = makeUpload("att_001");
    const fakeFetch = makeFetch(200);

    await completeTaskWithFiles(
      "TASK-001",
      ["/tmp/file.txt"],
      { todosUrl: "http://localhost:3000", notes: "All tests passed" },
      upload as unknown as typeof import("../../core/upload").uploadFile,
      fakeFetch
    );

    const [, opts] = (fakeFetch as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.notes).toBe("All tests passed");
  });

  it("passes expiry to uploadFile", async () => {
    const upload = makeUpload("att_001");
    const fakeFetch = makeFetch(200);

    await completeTaskWithFiles(
      "TASK-001",
      ["/tmp/file.txt"],
      { todosUrl: "http://localhost:3000", expiry: "7d" },
      upload as unknown as typeof import("../../core/upload").uploadFile,
      fakeFetch
    );

    expect(upload).toHaveBeenCalledWith("/tmp/file.txt", { expiry: "7d" });
  });

  it("throws when task not found (404)", async () => {
    const upload = makeUpload("att_001");
    const fakeFetch = makeFetch(404);

    await expect(
      completeTaskWithFiles(
        "TASK-999",
        ["/tmp/file.txt"],
        { todosUrl: "http://localhost:3000" },
        upload as unknown as typeof import("../../core/upload").uploadFile,
        fakeFetch
      )
    ).rejects.toThrow("Task not found: TASK-999");
  });

  it("throws with HTTP status on non-200 non-404 response", async () => {
    const upload = makeUpload("att_001");
    const fakeFetch = makeFetch(500, "Internal Server Error");

    await expect(
      completeTaskWithFiles(
        "TASK-001",
        ["/tmp/file.txt"],
        { todosUrl: "http://localhost:3000" },
        upload as unknown as typeof import("../../core/upload").uploadFile,
        fakeFetch
      )
    ).rejects.toThrow("HTTP 500");
  });

  it("defaults todos-url to http://localhost:3000", async () => {
    const upload = makeUpload("att_001");
    const fakeFetch = makeFetch(200);

    await completeTaskWithFiles(
      "TASK-001",
      ["/tmp/file.txt"],
      {},
      upload as unknown as typeof import("../../core/upload").uploadFile,
      fakeFetch
    );

    const [url] = (fakeFetch as ReturnType<typeof mock>).mock.calls[0] as [string];
    expect(url).toContain("http://localhost:3000");
  });

  it("handles attachment with null link", async () => {
    const upload = makeUpload("att_001", null);
    const fakeFetch = makeFetch(200);

    const result = await completeTaskWithFiles(
      "TASK-001",
      ["/tmp/file.txt"],
      { todosUrl: "http://localhost:3000" },
      upload as unknown as typeof import("../../core/upload").uploadFile,
      fakeFetch
    );

    expect(result.links).toEqual([null]);
  });

  it("throws if upload fails before calling the todos API", async () => {
    const upload = mock(async () => {
      throw new Error("S3 upload failed");
    });
    const fakeFetch = makeFetch(200);

    await expect(
      completeTaskWithFiles(
        "TASK-001",
        ["/tmp/file.txt"],
        { todosUrl: "http://localhost:3000" },
        upload as unknown as typeof import("../../core/upload").uploadFile,
        fakeFetch
      )
    ).rejects.toThrow("S3 upload failed");

    // fetch should not be called if upload fails
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CLI command tests
// ---------------------------------------------------------------------------

describe("complete-task CLI command", () => {
  beforeEach(() => {
    mockUploadFile.mockReset();
    mockUploadFile.mockImplementation(async (_path: string, _opts?: object) => ({
      id: "att_abc123",
      filename: "report.pdf",
      s3Key: "attachments/2024-01-01/att_abc123/report.pdf",
      bucket: "test-bucket",
      size: 102400,
      contentType: "application/pdf",
      link: "https://example.com/link/att_abc123",
      expiresAt: null,
      createdAt: Date.now(),
      tag: null,
    }));
  });

  it("outputs success message on completing task with one file", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(200);

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(
        ["complete-task", "TASK-001", "--file", "/tmp/report.pdf"],
        { from: "user" }
      );
      expect(capture.out.join("")).toContain("✓ Uploaded 1 file and completed task TASK-001");
    } finally {
      capture.restore();
      globalThis.fetch = originalFetch;
    }
  });

  it("outputs plural 'files' when multiple files are uploaded", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(200);

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(
        ["complete-task", "TASK-001", "--file", "/tmp/file1.txt", "--file", "/tmp/file2.txt"],
        { from: "user" }
      );
      expect(capture.out.join("")).toContain("✓ Uploaded 2 files and completed task TASK-001");
    } finally {
      capture.restore();
      globalThis.fetch = originalFetch;
    }
  });

  it("uses custom --todos-url when provided", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: unknown) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(
        ["complete-task", "TASK-001", "--file", "/tmp/report.pdf", "--todos-url", "http://localhost:4000"],
        { from: "user" }
      );
      expect(capturedUrl).toContain("http://localhost:4000");
    } finally {
      capture.restore();
    }
  });

  it("writes error to stderr and exits when task not found (404)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(404);

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(
          ["complete-task", "TASK-999", "--file", "/tmp/report.pdf"],
          { from: "user" }
        )
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("TASK-999");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("writes error and exits when upload fails", async () => {
    mockUploadFile.mockImplementation(async () => {
      throw new Error("S3 connection failed");
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(200);

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(
          ["complete-task", "TASK-001", "--file", "/tmp/report.pdf"],
          { from: "user" }
        )
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("S3 connection failed");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });
});
