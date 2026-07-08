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
  uploadStreamAttachment: mock(async () => ({})),
}));

// Import after mocks
const { completeTaskWithFiles, registerCompleteTask } = await import("./complete-task");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchSequenceOptions {
  /** Task object returned by the initial GET /api/tasks/:id. */
  task?: Record<string, unknown>;
  getStatus?: number;
  patchStatus?: number;
  completeStatus?: number;
  patchBody?: string;
  completeBody?: string;
  getBody?: string;
}

/**
 * A fetch mock that understands the GET -> PATCH -> POST /complete sequence the
 * command performs. Routes each call by method + URL suffix.
 */
function makeFetch(opts: FetchSequenceOptions = {}): typeof fetch {
  const task = opts.task ?? { id: "TASK-001", version: 1, metadata: {} };
  const getStatus = opts.getStatus ?? 200;
  const patchStatus = opts.patchStatus ?? 200;
  const completeStatus = opts.completeStatus ?? 200;

  return mock(async (url: unknown, init?: unknown) => {
    const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    const u = String(url);

    if (method === "GET") {
      return {
        ok: getStatus >= 200 && getStatus < 300,
        status: getStatus,
        json: async () => task,
        text: async () => opts.getBody ?? JSON.stringify(task),
      };
    }
    if (method === "PATCH") {
      return {
        ok: patchStatus >= 200 && patchStatus < 300,
        status: patchStatus,
        json: async () => ({ ...task, ...JSON.parse(((init as RequestInit).body as string) || "{}") }),
        text: async () => opts.patchBody ?? "",
      };
    }
    // POST /complete
    if (u.endsWith("/complete")) {
      return {
        ok: completeStatus >= 200 && completeStatus < 300,
        status: completeStatus,
        json: async () => task,
        text: async () => opts.completeBody ?? "",
      };
    }
    throw new Error(`Unexpected fetch: ${method} ${u}`);
  }) as unknown as typeof fetch;
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

// completeTaskWithFiles takes a Store factory; wrap an uploadFile mock in a
// minimal Store so the command routes uploads through the Store abstraction.
function makeStoreFactory(uploadFile: (path: string, opts?: object) => Promise<MockAttachment>) {
  return (() => ({
    uploadFile,
    close: () => {},
  })) as unknown as () => import("../../core/store").Store;
}

/** Extract the parsed body of the first call matching the given HTTP method. */
function bodyForMethod(fakeFetch: ReturnType<typeof mock>, method: string): Record<string, unknown> | undefined {
  for (const call of fakeFetch.mock.calls as Array<[string, RequestInit | undefined]>) {
    const m = (call[1]?.method ?? "GET").toUpperCase();
    if (m === method && call[1]?.body) {
      return JSON.parse(call[1].body as string);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// completeTaskWithFiles unit tests
// ---------------------------------------------------------------------------

describe("completeTaskWithFiles", () => {
  beforeEach(() => {
    mockUploadFile.mockReset();
  });

  it("uploads files, PATCHes evidence into task metadata, then completes", async () => {
    const upload = makeUpload("att_001", "https://example.com/att_001");
    const fakeFetch = makeFetch();

    const result = await completeTaskWithFiles(
      "TASK-001",
      ["/tmp/file.txt"],
      { todosUrl: "http://localhost:3000" },
      makeStoreFactory(upload),
      fakeFetch
    );

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith("/tmp/file.txt", { expiry: undefined });

    const calls = (fakeFetch as ReturnType<typeof mock>).mock.calls as Array<[string, RequestInit | undefined]>;
    // GET -> PATCH -> POST /complete
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toBe("http://localhost:3000/api/tasks/TASK-001");
    expect((calls[0][1]?.method ?? "GET").toUpperCase()).toBe("GET");
    expect(calls[1][0]).toBe("http://localhost:3000/api/tasks/TASK-001");
    expect(calls[1][1]?.method).toBe("PATCH");
    expect(calls[2][0]).toBe("http://localhost:3000/api/tasks/TASK-001/complete");
    expect(calls[2][1]?.method).toBe("POST");

    // Evidence persisted in the exact shape resolve-evidence reads.
    const patchBody = bodyForMethod(fakeFetch as ReturnType<typeof mock>, "PATCH")!;
    const evidence = (patchBody.metadata as Record<string, unknown>)._evidence as Record<string, unknown>;
    expect(evidence.attachments).toEqual([
      { id: "att_001", link: "https://example.com/att_001", filename: "file.txt", size: 1024 },
    ]);

    expect(result.task_id).toBe("TASK-001");
    expect(result.attachment_ids).toEqual(["att_001"]);
    expect(result.links).toEqual(["https://example.com/att_001"]);
  });

  it("merges evidence with existing metadata and prior attachments", async () => {
    const upload = makeUpload("att_new", "https://example.com/att_new");
    const fakeFetch = makeFetch({
      task: {
        id: "TASK-001",
        version: 3,
        metadata: {
          fingerprint: "abc",
          _evidence: {
            attachments: [
              { id: "att_old", link: "https://old.example.com", filename: "old.txt", size: 10 },
            ],
          },
        },
      },
    });

    await completeTaskWithFiles(
      "TASK-001",
      ["/tmp/new.txt"],
      { todosUrl: "http://localhost:3000" },
      makeStoreFactory(upload),
      fakeFetch
    );

    const patchBody = bodyForMethod(fakeFetch as ReturnType<typeof mock>, "PATCH")!;
    const metadata = patchBody.metadata as Record<string, unknown>;
    // Existing top-level metadata preserved (not clobbered).
    expect(metadata.fingerprint).toBe("abc");
    // Optimistic-concurrency version forwarded.
    expect(patchBody.version).toBe(3);
    const evidence = metadata._evidence as Record<string, unknown>;
    expect(evidence.attachments).toEqual([
      { id: "att_old", link: "https://old.example.com", filename: "old.txt", size: 10 },
      { id: "att_new", link: "https://example.com/att_new", filename: "file.txt", size: 1024 },
    ]);
  });

  it("uploads multiple files and records all as evidence", async () => {
    let callCount = 0;
    const upload = mock(async (_path: string, _opts?: object): Promise<MockAttachment> => {
      callCount++;
      return {
        id: `att_00${callCount}`,
        filename: `file${callCount}.txt`,
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

    const fakeFetch = makeFetch();

    const result = await completeTaskWithFiles(
      "TASK-002",
      ["/tmp/file1.txt", "/tmp/file2.txt"],
      { todosUrl: "http://localhost:3000" },
      makeStoreFactory(upload),
      fakeFetch
    );

    expect(upload).toHaveBeenCalledTimes(2);
    expect(result.attachment_ids).toEqual(["att_001", "att_002"]);
    expect(result.links).toEqual([
      "https://example.com/att_001",
      "https://example.com/att_002",
    ]);

    const patchBody = bodyForMethod(fakeFetch as ReturnType<typeof mock>, "PATCH")!;
    const evidence = (patchBody.metadata as Record<string, unknown>)._evidence as Record<string, unknown>;
    expect((evidence.attachments as unknown[]).map((a: any) => a.id)).toEqual(["att_001", "att_002"]);
  });

  it("stores notes in the evidence metadata when provided", async () => {
    const upload = makeUpload("att_001");
    const fakeFetch = makeFetch();

    await completeTaskWithFiles(
      "TASK-001",
      ["/tmp/file.txt"],
      { todosUrl: "http://localhost:3000", notes: "All tests passed" },
      makeStoreFactory(upload),
      fakeFetch
    );

    const patchBody = bodyForMethod(fakeFetch as ReturnType<typeof mock>, "PATCH")!;
    const evidence = (patchBody.metadata as Record<string, unknown>)._evidence as Record<string, unknown>;
    expect(evidence.notes).toBe("All tests passed");
  });

  it("passes expiry to uploadFile", async () => {
    const upload = makeUpload("att_001");
    const fakeFetch = makeFetch();

    await completeTaskWithFiles(
      "TASK-001",
      ["/tmp/file.txt"],
      { todosUrl: "http://localhost:3000", expiry: "7d" },
      makeStoreFactory(upload),
      fakeFetch
    );

    expect(upload).toHaveBeenCalledWith("/tmp/file.txt", { expiry: "7d" });
  });

  it("throws when task not found (404 on the initial GET)", async () => {
    const upload = makeUpload("att_001");
    const fakeFetch = makeFetch({ getStatus: 404 });

    await expect(
      completeTaskWithFiles(
        "TASK-999",
        ["/tmp/file.txt"],
        { todosUrl: "http://localhost:3000" },
        makeStoreFactory(upload),
        fakeFetch
      )
    ).rejects.toThrow("Task not found: TASK-999");
  });

  it("throws with HTTP status when persisting evidence fails", async () => {
    const upload = makeUpload("att_001");
    const fakeFetch = makeFetch({ patchStatus: 409, patchBody: "Version conflict" });

    await expect(
      completeTaskWithFiles(
        "TASK-001",
        ["/tmp/file.txt"],
        { todosUrl: "http://localhost:3000" },
        makeStoreFactory(upload),
        fakeFetch
      )
    ).rejects.toThrow("HTTP 409");
  });

  it("throws with HTTP status when the complete call fails", async () => {
    const upload = makeUpload("att_001");
    const fakeFetch = makeFetch({ completeStatus: 500, completeBody: "Internal Server Error" });

    await expect(
      completeTaskWithFiles(
        "TASK-001",
        ["/tmp/file.txt"],
        { todosUrl: "http://localhost:3000" },
        makeStoreFactory(upload),
        fakeFetch
      )
    ).rejects.toThrow("HTTP 500");
  });

  it("defaults todos-url to http://localhost:3000", async () => {
    const upload = makeUpload("att_001");
    const fakeFetch = makeFetch();

    await completeTaskWithFiles(
      "TASK-001",
      ["/tmp/file.txt"],
      {},
      makeStoreFactory(upload),
      fakeFetch
    );

    const [url] = (fakeFetch as ReturnType<typeof mock>).mock.calls[0] as [string];
    expect(url).toContain("http://localhost:3000");
  });

  it("handles attachment with null link", async () => {
    const upload = makeUpload("att_001", null);
    const fakeFetch = makeFetch();

    const result = await completeTaskWithFiles(
      "TASK-001",
      ["/tmp/file.txt"],
      { todosUrl: "http://localhost:3000" },
      makeStoreFactory(upload),
      fakeFetch
    );

    expect(result.links).toEqual([null]);
    const patchBody = bodyForMethod(fakeFetch as ReturnType<typeof mock>, "PATCH")!;
    const evidence = (patchBody.metadata as Record<string, unknown>)._evidence as Record<string, unknown>;
    expect((evidence.attachments as any[])[0].link).toBeNull();
  });

  it("throws if upload fails before touching the todos API", async () => {
    const upload = mock(async () => {
      throw new Error("S3 upload failed");
    });
    const fakeFetch = makeFetch();

    await expect(
      completeTaskWithFiles(
        "TASK-001",
        ["/tmp/file.txt"],
        { todosUrl: "http://localhost:3000" },
        makeStoreFactory(upload),
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
    globalThis.fetch = makeFetch();

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
    globalThis.fetch = makeFetch();

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
    const seen: string[] = [];
    const base = makeFetch();
    globalThis.fetch = mock(async (url: unknown, init?: unknown) => {
      seen.push(String(url));
      return (base as unknown as (u: unknown, i?: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(
        ["complete-task", "TASK-001", "--file", "/tmp/report.pdf", "--todos-url", "http://localhost:4000"],
        { from: "user" }
      );
      expect(seen.every((u) => u.startsWith("http://localhost:4000"))).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it("writes error to stderr and exits when task not found (404)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch({ getStatus: 404 });

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
    globalThis.fetch = makeFetch();

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
