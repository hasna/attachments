import { describe, it, expect, mock, beforeEach, afterAll, beforeAll, spyOn } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { setConfigPath, setConfig } from "../../core/config";

// ---------------------------------------------------------------------------
// Mock DB
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
const mockUpdateLink = mock((_id: string, _link: string, _expiresAt?: number | null) => {});
const mockDbClose = mock(() => {});
const mockFindAll = mock((_opts?: unknown) => [] as MockAttachment[]);

mock.module("../../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    constructor(_path?: string) {}
    findById = mockFindById;
    updateLink = mockUpdateLink;
    close = mockDbClose;
    findAll = mockFindAll;
    insert = mock((_att: unknown) => {});
    delete = mock((_id: string) => {});
    deleteExpired = mock(() => 0);
  },
}));

// ---------------------------------------------------------------------------
// Mock S3
// ---------------------------------------------------------------------------

const mockPresign = mock(async (_key: string, _secs: number) => "https://s3.example.com/new-presigned");

mock.module("../../core/s3", () => ({
  S3Client: class MockS3Client {
    constructor(_cfg: unknown) {}
    presign = mockPresign;
    presignPut = mock(async () => "https://put");
    upload = mock(async () => {});
    download = mock(async () => Buffer.from(""));
    delete = mock(async () => {});
  },
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

let fetchMock = mock(async (_url: unknown, _opts?: unknown): Promise<Response> => {
  return new Response(null, { status: 200 });
});

(globalThis as Record<string, unknown>).fetch = fetchMock;

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

let _testConfigDir: string;
beforeAll(() => {
  _testConfigDir = join(tmpdir(), `watch-test-cfg-${Date.now()}`);
  mkdirSync(_testConfigDir, { recursive: true });
  setConfigPath(join(_testConfigDir, "config.json"));
  setConfig({
    s3: { bucket: "test-bucket", region: "us-east-1", accessKeyId: "K", secretAccessKey: "S" },
    server: { port: 3458, baseUrl: "http://localhost:3458" },
    defaults: { expiry: "7d", linkType: "presigned" },
  });
});

afterAll(() => {
  mock.restore();
  try { rmSync(_testConfigDir, { recursive: true, force: true }); } catch {}
});

// Import after mocks
const { handleTaskEvent, parseSseBlock, connectAndWatch, registerWatch } = await import("./watch");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAttachment(overrides: Partial<MockAttachment> = {}): MockAttachment {
  const now = Date.now();
  return {
    id: "att_001",
    filename: "report.pdf",
    s3Key: "attachments/2024-01-01/att_001/report.pdf",
    bucket: "test-bucket",
    size: 1024 * 10,
    contentType: "application/pdf",
    link: "https://s3.example.com/link",
    tag: null,
    expiresAt: now + 1000 * 60 * 60 * 24,
    createdAt: now - 1000 * 60 * 60,
    ...overrides,
  };
}

function makeDbFactory(attachments: Record<string, MockAttachment | null> = {}) {
  return () => ({
    findById: (id: string) => attachments[id] ?? null,
    updateLink: mockUpdateLink,
    close: mockDbClose,
    findAll: mockFindAll,
  }) as unknown as import("../../core/db").AttachmentsDB;
}

// ---------------------------------------------------------------------------
// parseSseBlock tests
// ---------------------------------------------------------------------------

describe("parseSseBlock", () => {
  it("parses a simple data block", () => {
    const result = parseSseBlock('data: {"hello":"world"}');
    expect(result).not.toBeNull();
    expect(result!.data).toBe('{"hello":"world"}');
    expect(result!.event).toBe("message");
  });

  it("parses event + data block", () => {
    const result = parseSseBlock('event: task.completed\ndata: {"task_id":"TASK-001"}');
    expect(result).not.toBeNull();
    expect(result!.event).toBe("task.completed");
    expect(result!.data).toBe('{"task_id":"TASK-001"}');
  });

  it("returns null when no data field", () => {
    const result = parseSseBlock("event: task.completed\n: comment");
    expect(result).toBeNull();
  });

  it("returns null for empty block", () => {
    expect(parseSseBlock("")).toBeNull();
    expect(parseSseBlock("   ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleTaskEvent tests
// ---------------------------------------------------------------------------

describe("handleTaskEvent", () => {
  beforeEach(() => {
    mockFindById.mockReset();
    mockUpdateLink.mockReset();
    mockDbClose.mockReset();
    mockPresign.mockReset();
    mockPresign.mockImplementation(async () => "https://s3.example.com/new-presigned");
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
  });

  it("returns null and does nothing when event has no attachments", async () => {
    const event = {
      type: "task.completed",
      task_id: "TASK-001",
      metadata: { _evidence: { attachments: [] } },
    };
    const result = await handleTaskEvent(event, {}, makeDbFactory());
    expect(result).toBeNull();
  });

  it("returns null when metadata._evidence is missing", async () => {
    const event = { type: "task.completed", task_id: "TASK-002" };
    const result = await handleTaskEvent(event, {}, makeDbFactory());
    expect(result).toBeNull();
  });

  it("checks healthy attachment and does not regenerate", async () => {
    const now = Date.now();
    const att = makeAttachment({ id: "att_h", expiresAt: now + 100_000 });
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));

    const event = {
      type: "task.completed",
      task_id: "TASK-003",
      metadata: { _evidence: { attachments: ["att_h"] } },
    };

    const result = await handleTaskEvent(event, {}, makeDbFactory({ att_h: att }));
    expect(result).not.toBeNull();
    expect(result!.checked).toBe(1);
    expect(result!.regenerated).toBe(0);
    expect(mockUpdateLink).not.toHaveBeenCalled();
  });

  it("regenerates expired attachment link", async () => {
    const now = Date.now();
    const att = makeAttachment({ id: "att_exp", expiresAt: now - 5000 });

    const event = {
      type: "task.completed",
      task_id: "TASK-004",
      metadata: { _evidence: { attachments: ["att_exp"] } },
    };

    const result = await handleTaskEvent(event, {}, makeDbFactory({ att_exp: att }));
    expect(result).not.toBeNull();
    expect(result!.checked).toBe(1);
    expect(result!.regenerated).toBe(1);
    expect(mockUpdateLink).toHaveBeenCalledTimes(1);
    expect(mockUpdateLink).toHaveBeenCalledWith(
      "att_exp",
      expect.stringContaining("https://"),
      expect.any(Number)
    );
  });

  it("regenerates dead attachment link", async () => {
    const now = Date.now();
    const att = makeAttachment({ id: "att_dead", expiresAt: now + 100_000 });
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));

    const event = {
      type: "task.completed",
      task_id: "TASK-005",
      metadata: { _evidence: { attachments: ["att_dead"] } },
    };

    const result = await handleTaskEvent(event, {}, makeDbFactory({ att_dead: att }));
    expect(result).not.toBeNull();
    expect(result!.checked).toBe(1);
    expect(result!.regenerated).toBe(1);
  });

  it("skips attachment IDs not found in local DB", async () => {
    const event = {
      type: "task.completed",
      task_id: "TASK-006",
      metadata: { _evidence: { attachments: ["att_missing"] } },
    };

    const result = await handleTaskEvent(event, {}, makeDbFactory({}));
    expect(result).not.toBeNull();
    expect(result!.checked).toBe(0);
    expect(result!.regenerated).toBe(0);
  });

  it("handles multiple attachments: mixed healthy and expired", async () => {
    const now = Date.now();
    const attGood = makeAttachment({ id: "att_good", expiresAt: now + 100_000 });
    const attExpired = makeAttachment({ id: "att_bad", expiresAt: now - 5000 });

    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));

    const event = {
      type: "task.completed",
      task_id: "TASK-007",
      metadata: { _evidence: { attachments: ["att_good", "att_bad"] } },
    };

    const result = await handleTaskEvent(
      event,
      {},
      makeDbFactory({ att_good: attGood, att_bad: attExpired })
    );
    expect(result).not.toBeNull();
    expect(result!.checked).toBe(2);
    expect(result!.regenerated).toBe(1);
  });

  it("logs task ID and counts to stdout", async () => {
    const now = Date.now();
    const att = makeAttachment({ id: "att_log", expiresAt: now + 100_000 });
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));

    const out: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

    try {
      const event = {
        type: "task.completed",
        task_id: "TASK-008",
        metadata: { _evidence: { attachments: ["att_log"] } },
      };
      await handleTaskEvent(event, {}, makeDbFactory({ att_log: att }));
      const output = out.join("");
      expect(output).toContain("TASK-008");
      expect(output).toContain("1 attachment");
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("uses event.id as fallback task identifier", async () => {
    const out: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

    try {
      const event = {
        type: "task.completed",
        id: "TASK-ALT-001",
        metadata: { _evidence: { attachments: [] } },
      };
      await handleTaskEvent(event, { verbose: true }, makeDbFactory());
      const output = out.join("");
      expect(output).toContain("TASK-ALT-001");
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// connectAndWatch — reconnect logic tests
// ---------------------------------------------------------------------------

describe("connectAndWatch reconnect logic", () => {
  it("reconnects after stream error with backoff", async () => {
    let callCount = 0;
    const controller = new AbortController();
    const sleepCalls: number[] = [];

    const mockFetch = mock(async (_url: unknown, _opts?: unknown): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        throw new Error("ECONNREFUSED");
      }
      // On second call, abort so we don't loop forever
      controller.abort();
      throw new Error("aborted");
    });

    const sleepFn = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const err: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
    const out: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

    try {
      await connectAndWatch(
        "http://localhost:3000/api/tasks/stream",
        { verbose: false },
        controller.signal,
        mockFetch as unknown as typeof fetch,
        makeDbFactory(),
        sleepFn
      );
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }

    expect(callCount).toBe(2);
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBe(5000);
    const errOutput = err.join("");
    expect(errOutput).toContain("reconnecting in 5s");
  });

  it("doubles backoff on repeated failures (capped at 60s)", async () => {
    let callCount = 0;
    const controller = new AbortController();
    const sleepCalls: number[] = [];

    const mockFetch = mock(async (_url: unknown, _opts?: unknown): Promise<Response> => {
      callCount++;
      if (callCount >= 4) {
        controller.abort();
      }
      throw new Error("connection refused");
    });

    const sleepFn = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await connectAndWatch(
        "http://localhost:3000/api/tasks/stream",
        {},
        controller.signal,
        mockFetch as unknown as typeof fetch,
        makeDbFactory(),
        sleepFn
      );
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }

    // Backoff should double: 5000, 10000, 20000
    expect(sleepCalls[0]).toBe(5000);
    expect(sleepCalls[1]).toBe(10000);
    expect(sleepCalls[2]).toBe(20000);
  });

  it("processes task.completed events from SSE stream", async () => {
    const now = Date.now();
    const att = makeAttachment({ id: "att_stream", expiresAt: now + 100_000 });
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));

    const controller = new AbortController();

    // Build a ReadableStream that emits one SSE event and then closes
    const sseBody = [
      "event: task.completed\n",
      'data: {"task_id":"TASK-SSE-001","metadata":{"_evidence":{"attachments":["att_stream"]}}}\n',
      "\n",
    ].join("");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(sseBody));
        ctrl.close();
      },
    });

    let callCount = 0;
    const customFetch = mock(
      async (_url: unknown, _opts?: unknown): Promise<Response> => {
        callCount++;
        if (callCount === 1) {
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        // On reconnect attempt, abort so the loop exits
        controller.abort();
        throw new Error("aborted");
      }
    );

    const out: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await connectAndWatch(
        "http://localhost:3000/api/tasks/stream",
        { verbose: true },
        controller.signal,
        customFetch as unknown as typeof fetch,
        makeDbFactory({ att_stream: att }),
        async () => {}
      );
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    const output = out.join("");
    expect(output).toContain("TASK-SSE-001");
    expect(output).toContain("1 attachment");
  });

  it("ignores non-task.completed events", async () => {
    const controller = new AbortController();

    const sseBody = [
      "event: task.assigned\n",
      'data: {"task_id":"TASK-ASSIGN-001"}\n',
      "\n",
    ].join("");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(sseBody));
        ctrl.close();
      },
    });

    let callCount = 0;
    const customFetch = mock(
      async (_url: unknown, _opts?: unknown): Promise<Response> => {
        callCount++;
        if (callCount === 1) {
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        controller.abort();
        throw new Error("aborted");
      }
    );

    const out: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await connectAndWatch(
        "http://localhost:3000/api/tasks/stream",
        {},
        controller.signal,
        customFetch as unknown as typeof fetch,
        makeDbFactory(),
        async () => {}
      );
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    // No task output since we only got a non-completed event
    const output = out.join("");
    expect(output).not.toContain("TASK-ASSIGN-001");
  });
});
