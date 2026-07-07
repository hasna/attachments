import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  callTool,
  createServer,
  mockClose,
  mockDbCreateShareLink,
  mockDbInsert,
  mockDelete,
  mockFindAll,
  mockFindById,
  mockGeneratePresignedLink,
  mockMarkReady,
  mockS3ClientInstance,
  mockUploadFile,
  mockUploadFromBuffer,
  resetMockFindById,
} from "./server.test-harness";

describe("MCP Server — presign_upload", () => {
  beforeEach(() => {
    mockS3ClientInstance.presignPut.mockClear();
    mockS3ClientInstance.presignPut.mockImplementation(
      async () => "https://example.com/presigned-put-url"
    );
    mockS3ClientInstance.head.mockClear();
    mockS3ClientInstance.head.mockImplementation(async () => ({ contentLength: 4096, contentType: "application/pdf" }));
    mockS3ClientInstance.delete.mockClear();
    mockGeneratePresignedLink.mockClear();
    mockGeneratePresignedLink.mockImplementation(
      async () => "https://example.com/new-presigned-url"
    );
    mockDbCreateShareLink.mockClear();
    mockDbCreateShareLink.mockImplementation(() => ({ shareLink: {}, token: "share_test001" }));
    mockDbInsert.mockClear();
    mockFindById.mockClear();
    resetMockFindById();
    mockMarkReady.mockClear();
    mockDelete.mockClear();
    mockClose.mockClear();
  });

  it("returns presigned PUT URL with id and expires_at", async () => {
    const server = createServer();
    const result = (await callTool(server, "presign_upload", {
      filename: "report.pdf",
      expiry: "2h",
    })) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.upload_url).toBe("https://example.com/presigned-put-url");
    expect(parsed.id).toMatch(/^att_/);
    expect(parsed.expires_at).toBeGreaterThan(Date.now());
    expect(parsed.finalize_tool).toBe("complete_presigned_upload");
  });

  it("calls s3.presignPut with correct expiry in seconds", async () => {
    const server = createServer();
    await callTool(server, "presign_upload", {
      filename: "data.csv",
      expiry: "1h",
    });

    expect(mockS3ClientInstance.presignPut).toHaveBeenCalledTimes(1);
    const [key, contentType, expiresIn] = mockS3ClientInstance.presignPut.mock.calls[0] as [string, string, number];
    expect(key).toMatch(/^attachments\/\d{4}-\d{2}-\d{2}\/att_[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.csv$/);
    expect(contentType).toBe("text/csv");
    expect(expiresIn).toBe(3600);
  });

  it("inserts a DB record with size 0", async () => {
    const server = createServer();
    await callTool(server, "presign_upload", {
      filename: "test.txt",
    });

    expect(mockDbInsert).toHaveBeenCalledTimes(1);
    const [att] = mockDbInsert.mock.calls[0] as [{ size: number; filename: string }];
    expect(att.size).toBe(0);
    expect(att.filename).toBe("test.txt");
  });

  it("defaults expiry to 1h", async () => {
    const server = createServer();
    await callTool(server, "presign_upload", {
      filename: "file.txt",
    });

    const [, , expiresIn] = mockS3ClientInstance.presignPut.mock.calls[0] as [string, string, number];
    expect(expiresIn).toBe(3600);
  });

  it("uses custom content_type when provided", async () => {
    const server = createServer();
    await callTool(server, "presign_upload", {
      filename: "file.bin",
      content_type: "application/octet-stream",
    });

    const [, contentType] = mockS3ClientInstance.presignPut.mock.calls[0] as [string, string, number];
    expect(contentType).toBe("application/octet-stream");
  });

  it("returns error for invalid expiry", async () => {
    const server = createServer();
    const result = (await callTool(server, "presign_upload", {
      filename: "file.txt",
      expiry: "invalid",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Invalid expiry format");
  });

  it("finalizes a pending upload and generates a share link", async () => {
    mockFindById.mockImplementation(() => ({
      id: "att_pending",
      filename: "report.pdf",
      s3Key: "attachments/2026-06-19/att_pending/report.pdf",
      bucket: "my-bucket",
      size: 0,
      contentType: "application/pdf",
      link: null,
      tag: null,
      expiresAt: Date.now() + 3600000,
      createdAt: Date.now(),
      storageBackend: "s3",
      status: "pending",
    }));

    const server = createServer();
    const result = (await callTool(server, "complete_presigned_upload", {
      id: "att_pending",
      link_type: "presigned",
    })) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.id).toBe("att_pending");
    expect(parsed.size).toBe(4096);
    expect(parsed.link).toBe("https://example.com/new-presigned-url");
    expect(mockS3ClientInstance.head).toHaveBeenCalledWith("attachments/2026-06-19/att_pending/report.pdf");
    expect(mockMarkReady).toHaveBeenCalledWith(expect.objectContaining({
      id: "att_pending",
      size: 4096,
      contentType: "application/pdf",
      link: "https://example.com/new-presigned-url",
    }));
  });

  it("finalizes to a server link when max downloads are set", async () => {
    mockFindById.mockImplementation(() => ({
      id: "att_pending",
      filename: "report.pdf",
      s3Key: "attachments/2026-06-19/att_pending/report.pdf",
      bucket: "my-bucket",
      size: 0,
      contentType: "application/pdf",
      link: null,
      tag: null,
      expiresAt: Date.now() + 3600000,
      createdAt: Date.now(),
      storageBackend: "s3",
      status: "pending",
    }));

    const server = createServer();
    const result = (await callTool(server, "complete_presigned_upload", {
      id: "att_pending",
      max_downloads: 1,
    })) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.link).toBe("http://localhost:3459/a/share_test001");
    expect(mockDbCreateShareLink).toHaveBeenCalledWith(expect.objectContaining({
      attachmentId: "att_pending",
      maxUses: 1,
    }));
  });

  it("rejects and removes oversized completed uploads", async () => {
    mockFindById.mockImplementation(() => ({
      id: "att_pending",
      filename: "huge.bin",
      s3Key: "attachments/2026-06-19/att_pending/huge.bin",
      bucket: "my-bucket",
      size: 0,
      contentType: "application/octet-stream",
      link: null,
      tag: null,
      expiresAt: Date.now() + 3600000,
      createdAt: Date.now(),
      storageBackend: "s3",
      status: "pending",
    }));
    mockS3ClientInstance.head.mockImplementation(async () => ({ contentLength: 11 * 1024 * 1024 * 1024, contentType: "application/octet-stream" }));

    const server = createServer();
    const result = (await callTool(server, "complete_presigned_upload", {
      id: "att_pending",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("File too large");
    expect(mockS3ClientInstance.delete).toHaveBeenCalledWith("attachments/2026-06-19/att_pending/huge.bin");
    expect(mockDelete).toHaveBeenCalledWith("att_pending");
  });
});

describe("MCP Server — link_to_task", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    mockFindById.mockClear();
    resetMockFindById();
    mockClose.mockClear();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("links attachment to task and returns success message", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    })) as unknown as typeof fetch;

    const server = createServer();
    const result = (await callTool(server, "link_to_task", {
      attachment_id: "att_test001",
      task_id: "TASK-001",
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toContain("Linked att_test001 → task TASK-001");
  });

  it("calls PATCH on correct todos URL with attachment metadata", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = mock(async (url: unknown, opts: unknown) => {
      capturedUrl = String(url);
      capturedBody = (opts as RequestInit).body as string;
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    const server = createServer();
    await callTool(server, "link_to_task", {
      attachment_id: "att_test001",
      task_id: "TASK-001",
      todos_url: "http://localhost:4000",
    });

    expect(capturedUrl).toBe("http://localhost:4000/api/tasks/TASK-001");
    const body = JSON.parse(capturedBody);
    expect(body.metadata._attachments[0].id).toBe("att_test001");
    expect(body.metadata._attachments[0].filename).toBe("test.txt");
  });

  it("returns error when attachment not found", async () => {
    mockFindById.mockReturnValueOnce(null as unknown as ReturnType<typeof mockFindById>);

    const server = createServer();
    const result = (await callTool(server, "link_to_task", {
      attachment_id: "att_missing",
      task_id: "TASK-001",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("returns error when task not found (404)", async () => {
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 404,
      text: async () => "not found",
    })) as unknown as typeof fetch;

    const server = createServer();
    const result = (await callTool(server, "link_to_task", {
      attachment_id: "att_test001",
      task_id: "TASK-999",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("TASK-999");
  });

  it("defaults todos_url to http://localhost:3000", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: unknown) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    const server = createServer();
    await callTool(server, "link_to_task", {
      attachment_id: "att_test001",
      task_id: "TASK-001",
    });

    expect(capturedUrl).toContain("http://localhost:3000");
  });
});

describe("MCP Server — complete_task_with_files", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    mockUploadFile.mockClear();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uploads files and completes task with attachment_ids", async () => {
    mockUploadFile
      .mockImplementationOnce(async () => ({
        id: "att_ev001",
        filename: "screenshot.png",
        s3Key: "attachments/2024-01-01/att_ev001/screenshot.png",
        bucket: "my-bucket",
        size: 50000,
        contentType: "image/png",
        link: "https://example.com/att_ev001",
        expiresAt: null,
        createdAt: 1699000000000,
      }))
      .mockImplementationOnce(async () => ({
        id: "att_ev002",
        filename: "output.txt",
        s3Key: "attachments/2024-01-01/att_ev002/output.txt",
        bucket: "my-bucket",
        size: 1024,
        contentType: "text/plain",
        link: "https://example.com/att_ev002",
        expiresAt: null,
        createdAt: 1699000000000,
      }));

    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = mock(async (url: unknown, opts: unknown) => {
      capturedUrl = String(url);
      capturedBody = (opts as RequestInit).body as string;
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    const server = createServer();
    const result = (await callTool(server, "complete_task_with_files", {
      task_id: "TASK-001",
      paths: ["/tmp/screenshot.png", "/tmp/output.txt"],
      todos_url: "http://localhost:3000",
    })) as { content: Array<{ text: string }> };

    expect(mockUploadFile).toHaveBeenCalledTimes(2);
    expect(capturedUrl).toBe("http://localhost:3000/api/tasks/TASK-001/complete");

    const body = JSON.parse(capturedBody);
    expect(body.attachment_ids).toEqual(["att_ev001", "att_ev002"]);
    expect(body.notes).toBeUndefined();

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.task_id).toBe("TASK-001");
    expect(parsed.attachment_ids).toEqual(["att_ev001", "att_ev002"]);
    expect(parsed.links).toEqual(["https://example.com/att_ev001", "https://example.com/att_ev002"]);
  });

  it("includes notes in the POST body when provided", async () => {
    mockUploadFile.mockImplementationOnce(async () => ({
      id: "att_ev003",
      filename: "result.txt",
      s3Key: "key",
      bucket: "my-bucket",
      size: 100,
      contentType: "text/plain",
      link: null,
      expiresAt: null,
      createdAt: 1699000000000,
    }));

    let capturedBody = "";
    globalThis.fetch = mock(async (_url: unknown, opts: unknown) => {
      capturedBody = (opts as RequestInit).body as string;
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    const server = createServer();
    await callTool(server, "complete_task_with_files", {
      task_id: "TASK-002",
      paths: ["/tmp/result.txt"],
      notes: "All tests green",
    });

    const body = JSON.parse(capturedBody);
    expect(body.notes).toBe("All tests green");
  });

  it("returns error when task not found (404)", async () => {
    mockUploadFile.mockImplementationOnce(async () => ({
      id: "att_ev004",
      filename: "file.txt",
      s3Key: "key",
      bucket: "my-bucket",
      size: 100,
      contentType: "text/plain",
      link: null,
      expiresAt: null,
      createdAt: 1699000000000,
    }));

    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 404,
      text: async () => "not found",
    })) as unknown as typeof fetch;

    const server = createServer();
    const result = (await callTool(server, "complete_task_with_files", {
      task_id: "TASK-999",
      paths: ["/tmp/file.txt"],
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("TASK-999");
  });

  it("returns error when paths array is empty", async () => {
    const server = createServer();
    const result = (await callTool(server, "complete_task_with_files", {
      task_id: "TASK-001",
      paths: [],
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("non-empty array");
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it("defaults todos_url to http://localhost:3000", async () => {
    mockUploadFile.mockImplementationOnce(async () => ({
      id: "att_ev005",
      filename: "file.txt",
      s3Key: "key",
      bucket: "my-bucket",
      size: 100,
      contentType: "text/plain",
      link: null,
      expiresAt: null,
      createdAt: 1699000000000,
    }));

    let capturedUrl = "";
    globalThis.fetch = mock(async (url: unknown) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    const server = createServer();
    await callTool(server, "complete_task_with_files", {
      task_id: "TASK-001",
      paths: ["/tmp/file.txt"],
    });

    expect(capturedUrl).toContain("http://localhost:3000");
  });
});

describe("MCP Server — save_session", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    mockUploadFromBuffer.mockClear();
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: unknown) => ({
      ok: true,
      status: 200,
      json: async () => [
        { role: "user", content: "Hello", timestamp: 1700000000000 },
        { role: "assistant", content: "Hi there" },
      ],
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches session messages and uploads as markdown by default", async () => {
    const server = createServer();
    const result = (await callTool(server, "save_session", {
      session_id: "ses_abc",
    })) as { content: Array<{ text: string }> };

    expect(mockUploadFromBuffer).toHaveBeenCalledTimes(1);
    const [buf, filename] = mockUploadFromBuffer.mock.calls[0] as [Buffer, string, unknown];
    expect(filename).toEndWith(".md");
    const content = buf.toString("utf-8");
    expect(content).toContain("# Session Snapshot");
    expect(content).toContain("Hello");

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.id).toBe("att_buf001");
    expect(parsed.link).toBe("https://example.com/presigned-buf");
    expect(parsed.filename).toEndWith(".md");
  });

  it("uploads as HTML when format=html", async () => {
    const server = createServer();
    await callTool(server, "save_session", {
      session_id: "ses_html",
      format: "html",
    });

    const [buf, filename] = mockUploadFromBuffer.mock.calls[0] as [Buffer, string, unknown];
    expect(filename).toEndWith(".html");
    expect(buf.toString("utf-8")).toContain("<!DOCTYPE html>");
  });

  it("uses custom sessions_url when provided", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: unknown) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch;

    const server = createServer();
    await callTool(server, "save_session", {
      session_id: "ses_custom",
      sessions_url: "http://localhost:9999",
    });

    expect(capturedUrl).toContain("localhost:9999");
    expect(capturedUrl).toContain("ses_custom");
  });

  it("passes expiry and tag to uploadFromBuffer", async () => {
    const server = createServer();
    await callTool(server, "save_session", {
      session_id: "ses_opts",
      expiry: "7d",
      tag: "qa-run",
    });

    const [, , opts] = mockUploadFromBuffer.mock.calls[0] as [Buffer, string, { expiry?: string; tag?: string }];
    expect(opts.expiry).toBe("7d");
    expect(opts.tag).toBe("qa-run");
  });

  it("returns error when sessions API is unreachable", async () => {
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const server = createServer();
    const result = (await callTool(server, "save_session", {
      session_id: "ses_fail",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Failed to fetch session");
  });
});

describe("MCP Server — report_stats", () => {
  beforeEach(() => mockFindAll.mockClear());

  it("returns report with correct shape", async () => {
    const server = createServer();
    const result = (await callTool(server, "report_stats", {})) as {
      content: Array<{ text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toHaveProperty("period");
    expect(parsed).toHaveProperty("uploads");
    expect(parsed).toHaveProperty("total");
    expect(parsed).toHaveProperty("expiringSoon");
    expect(parsed).toHaveProperty("alreadyExpired");
    expect(parsed).toHaveProperty("topTags");
    expect(parsed).toHaveProperty("largestUploads");
  });

  it("uses default 7 days when days is not provided", async () => {
    const server = createServer();
    const result = (await callTool(server, "report_stats", {})) as {
      content: Array<{ text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.period.days).toBe(7);
  });

  it("respects custom days param", async () => {
    const server = createServer();
    const result = (await callTool(server, "report_stats", { days: 30 })) as {
      content: Array<{ text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.period.days).toBe(30);
  });

  it("passes tag to db.findAll when provided", async () => {
    const server = createServer();
    await callTool(server, "report_stats", { tag: "project:foo" });

    expect(mockFindAll).toHaveBeenCalledTimes(1);
    const [opts] = mockFindAll.mock.calls[0] as [{ tag?: string; includeExpired?: boolean }];
    expect(opts?.tag).toBe("project:foo");
  });

  it("passes includeExpired: true to db.findAll", async () => {
    const server = createServer();
    await callTool(server, "report_stats", {});

    const [opts] = mockFindAll.mock.calls[0] as [{ includeExpired?: boolean }];
    expect(opts?.includeExpired).toBe(true);
  });

  it("returns error for days < 1", async () => {
    const server = createServer();
    const result = (await callTool(server, "report_stats", { days: 0 })) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("positive integer");
  });
});

describe("MCP Server — get_context", () => {
  beforeEach(() => mockFindAll.mockClear());

  it("returns text summary by default", async () => {
    const server = createServer();
    const result = (await callTool(server, "get_context", {})) as {
      content: Array<{ text: string }>;
    };

    const text = result.content[0]!.text;
    expect(text).toContain("Attachments:");
    expect(text).toContain("total");
    expect(text).toContain("active");
    expect(text).toContain("expired");
  });

  it("returns JSON object when format=json", async () => {
    const server = createServer();
    const result = (await callTool(server, "get_context", { format: "json" })) as {
      content: Array<{ text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toHaveProperty("attachments");
    expect(parsed).toHaveProperty("active");
    expect(parsed).toHaveProperty("expired");
    expect(parsed).toHaveProperty("expiring_soon");
    expect(parsed).toHaveProperty("summary");
    expect(typeof parsed.attachments).toBe("number");
  });
});

describe("MCP Server — unknown tool", () => {
  it("returns an error for unknown tool name", async () => {
    const server = createServer();
    const result = (await callTool(server, "totally_unknown_tool", {})) as {
      content: Array<{ text: string }>;
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unknown tool");
  });
});
