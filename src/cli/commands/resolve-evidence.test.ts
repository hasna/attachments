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
  tag: string | null;
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
const { resolveEvidence, registerResolveEvidence } = await import("./resolve-evidence");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDbAttachment(overrides: Partial<MockAttachment> = {}): MockAttachment {
  return {
    id: "att_abc123",
    filename: "report.pdf",
    s3Key: "attachments/2024-01-01/att_abc123/report.pdf",
    bucket: "test-bucket",
    size: 1258291, // ~1.2MB
    contentType: "application/pdf",
    link: "https://s3.example.com/fresh-link/att_abc123",
    tag: null,
    expiresAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeTaskResponse(attachments: Array<{ id: string; link: string | null; filename: string; size: number }>) {
  return {
    id: "TASK-001",
    subject: "Test task",
    metadata: {
      _evidence: {
        attachments,
      },
    },
  };
}

function makeFetch(status: number, body: unknown = {}): typeof fetch {
  return mock(async (_url: unknown, _opts?: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

function makeFetchError(message: string): typeof fetch {
  return mock(async (_url: unknown, _opts?: unknown) => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

function buildProgram() {
  const { Command } = require("commander") as typeof import("commander");
  const program = new Command();
  program.exitOverride();
  registerResolveEvidence(program);
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
// resolveEvidence unit tests
// ---------------------------------------------------------------------------

describe("resolveEvidence", () => {
  beforeEach(() => {
    mockFindById.mockReset();
    mockDbClose.mockReset();
  });

  it("returns resolved attachments from DB for each evidence entry", async () => {
    const dbAtt = makeDbAttachment();
    mockFindById.mockImplementation(() => dbAtt);

    const task = makeTaskResponse([
      { id: "att_abc123", link: "https://stale-link.example.com", filename: "report.pdf", size: 1258291 },
    ]);
    const fakeFetch = makeFetch(200, task);

    const result = await resolveEvidence("TASK-001", { todosUrl: "http://localhost:3000" }, fakeFetch);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("att_abc123");
    // Should use the DB link (fresh), not the stale one stored in the task
    expect(result[0].link).toBe("https://s3.example.com/fresh-link/att_abc123");
    expect(result[0].filename).toBe("report.pdf");
    expect(result[0].size).toBe(1258291);
  });

  it("returns empty array when task has no evidence attachments", async () => {
    const task = { id: "TASK-001", metadata: {} };
    const fakeFetch = makeFetch(200, task);

    const result = await resolveEvidence("TASK-001", {}, fakeFetch);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when _evidence.attachments is empty array", async () => {
    const task = makeTaskResponse([]);
    const fakeFetch = makeFetch(200, task);

    const result = await resolveEvidence("TASK-001", {}, fakeFetch);
    expect(result).toHaveLength(0);
  });

  it("falls back to evidence data when attachment not found in DB", async () => {
    mockFindById.mockImplementation(() => null);

    const task = makeTaskResponse([
      { id: "att_orphan", link: "https://fallback-link.example.com", filename: "orphan.txt", size: 512 },
    ]);
    const fakeFetch = makeFetch(200, task);

    const result = await resolveEvidence("TASK-001", {}, fakeFetch);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("att_orphan");
    expect(result[0].link).toBe("https://fallback-link.example.com");
    expect(result[0].filename).toBe("orphan.txt");
    expect(result[0].size).toBe(512);
  });

  it("resolves multiple attachments, mixing DB hits and misses", async () => {
    const dbAtt = makeDbAttachment({ id: "att_found", link: "https://fresh.example.com/att_found" });
    mockFindById.mockImplementation((id: string) => {
      if (id === "att_found") return dbAtt;
      return null;
    });

    const task = makeTaskResponse([
      { id: "att_found", link: "https://stale.example.com/att_found", filename: "report.pdf", size: 1024 },
      { id: "att_missing", link: "https://stale.example.com/att_missing", filename: "data.csv", size: 256 },
    ]);
    const fakeFetch = makeFetch(200, task);

    const result = await resolveEvidence("TASK-001", {}, fakeFetch);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("att_found");
    expect(result[0].link).toBe("https://fresh.example.com/att_found");
    expect(result[1].id).toBe("att_missing");
    expect(result[1].link).toBe("https://stale.example.com/att_missing");
  });

  it("throws when task not found (404)", async () => {
    const fakeFetch = makeFetch(404, "Not found");

    await expect(
      resolveEvidence("TASK-999", {}, fakeFetch)
    ).rejects.toThrow("Task not found: TASK-999");
  });

  it("throws with HTTP status on non-200 non-404 response", async () => {
    const fakeFetch = makeFetch(500, "Internal error");

    await expect(
      resolveEvidence("TASK-001", {}, fakeFetch)
    ).rejects.toThrow("HTTP 500");
  });

  it("throws with friendly message when todos server is unreachable", async () => {
    const fakeFetch = makeFetchError("ECONNREFUSED");

    await expect(
      resolveEvidence("TASK-001", { todosUrl: "http://localhost:3000" }, fakeFetch)
    ).rejects.toThrow("Could not reach todos server at http://localhost:3000");
  });

  it("uses custom todosUrl for the fetch request", async () => {
    const task = makeTaskResponse([]);
    let capturedUrl = "";
    const fakeFetch = mock(async (url: unknown) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => task, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    await resolveEvidence("TASK-001", { todosUrl: "http://localhost:9999" }, fakeFetch);

    expect(capturedUrl).toBe("http://localhost:9999/api/tasks/TASK-001");
  });

  it("closes DB after successful resolution", async () => {
    mockFindById.mockImplementation(() => makeDbAttachment());
    const task = makeTaskResponse([
      { id: "att_abc123", link: null, filename: "file.txt", size: 100 },
    ]);
    const fakeFetch = makeFetch(200, task);

    await resolveEvidence("TASK-001", {}, fakeFetch);

    expect(mockDbClose).toHaveBeenCalled();
  });

  it("closes DB even when DB throws", async () => {
    mockFindById.mockImplementation(() => {
      throw new Error("DB exploded");
    });

    const task = makeTaskResponse([
      { id: "att_abc123", link: null, filename: "file.txt", size: 100 },
    ]);
    const fakeFetch = makeFetch(200, task);

    await expect(
      resolveEvidence("TASK-001", {}, fakeFetch)
    ).rejects.toThrow("DB exploded");

    expect(mockDbClose).toHaveBeenCalled();
  });

  it("handles null link in DB record gracefully", async () => {
    mockFindById.mockImplementation(() => makeDbAttachment({ link: null }));

    const task = makeTaskResponse([
      { id: "att_abc123", link: "https://stale.example.com", filename: "report.pdf", size: 1024 },
    ]);
    const fakeFetch = makeFetch(200, task);

    const result = await resolveEvidence("TASK-001", {}, fakeFetch);

    expect(result[0].link).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLI command tests
// ---------------------------------------------------------------------------

describe("resolve-evidence CLI command", () => {
  beforeEach(() => {
    mockFindById.mockReset();
    mockDbClose.mockReset();
  });

  it("outputs compact format by default", async () => {
    mockFindById.mockImplementation(() => makeDbAttachment());

    const task = makeTaskResponse([
      { id: "att_abc123", link: "https://stale.example.com", filename: "report.pdf", size: 1258291 },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(200, task);

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["resolve-evidence", "TASK-001"], { from: "user" });
      const output = capture.out.join("");
      expect(output).toContain("att_abc123");
      expect(output).toContain("report.pdf");
      expect(output).toContain("https://s3.example.com/fresh-link/att_abc123");
      expect(output).toContain("1.2MB");
    } finally {
      capture.restore();
      globalThis.fetch = originalFetch;
    }
  });

  it("outputs JSON format when --format json", async () => {
    mockFindById.mockImplementation(() => makeDbAttachment());

    const task = makeTaskResponse([
      { id: "att_abc123", link: null, filename: "report.pdf", size: 1024 },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(200, task);

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["resolve-evidence", "TASK-001", "--format", "json"], { from: "user" });
      const output = capture.out.join("");
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].id).toBe("att_abc123");
      expect(parsed[0].filename).toBe("report.pdf");
    } finally {
      capture.restore();
      globalThis.fetch = originalFetch;
    }
  });

  it("outputs message when no attachments in evidence", async () => {
    const task = makeTaskResponse([]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(200, task);

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["resolve-evidence", "TASK-001"], { from: "user" });
      expect(capture.out.join("")).toContain("No attachments found");
    } finally {
      capture.restore();
      globalThis.fetch = originalFetch;
    }
  });

  it("uses custom --todos-url", async () => {
    const task = makeTaskResponse([]);
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: unknown) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => task, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(
        ["resolve-evidence", "TASK-001", "--todos-url", "http://localhost:4444"],
        { from: "user" }
      );
      expect(capturedUrl).toContain("http://localhost:4444");
    } finally {
      capture.restore();
    }
  });

  it("writes error and exits when task not found", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(404);

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["resolve-evidence", "TASK-999"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("TASK-999");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("writes error and exits when todos server is unreachable", async () => {
    globalThis.fetch = makeFetchError("ECONNREFUSED");

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["resolve-evidence", "TASK-001"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("Could not reach todos server");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("formats file sizes correctly: bytes, KB, MB", async () => {
    const cases: Array<[number, string]> = [
      [512, "512B"],
      [2048, "2.0KB"],
      [1258291, "1.2MB"],
    ];

    for (const [size, expectedSuffix] of cases) {
      mockFindById.mockImplementation(() => makeDbAttachment({ size }));

      const task = makeTaskResponse([
        { id: "att_abc123", link: null, filename: "file.txt", size },
      ]);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = makeFetch(200, task);

      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["resolve-evidence", "TASK-001"], { from: "user" });
        expect(capture.out.join("")).toContain(expectedSuffix);
      } finally {
        capture.restore();
        globalThis.fetch = originalFetch;
        mockFindById.mockReset();
      }
    }
  });

  it("shows (no link) in compact output when link is null", async () => {
    mockFindById.mockImplementation(() => makeDbAttachment({ link: null }));

    const task = makeTaskResponse([
      { id: "att_abc123", link: null, filename: "report.pdf", size: 1024 },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(200, task);

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["resolve-evidence", "TASK-001"], { from: "user" });
      expect(capture.out.join("")).toContain("(no link)");
    } finally {
      capture.restore();
      globalThis.fetch = originalFetch;
    }
  });
});
