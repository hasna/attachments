import { describe, it, expect, mock, beforeAll, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import * as configModule from "../core/config";

// ---------------------------------------------------------------------------
// Mock all core modules before importing the server
// ---------------------------------------------------------------------------

const mockUploadFile = mock(async (_path: string, _opts: object) => ({
  id: "att_test001",
  filename: "test.txt",
  s3Key: "attachments/2024-01-01/att_test001/test.txt",
  bucket: "my-bucket",
  size: 1024,
  contentType: "text/plain",
  link: "https://example.com/presigned-url",
  expiresAt: 1700000000000,
  createdAt: 1699000000000,
}));

const mockDownloadAttachment = mock(
  async (_idOrUrl: string, _dest?: string) => ({
    path: "/tmp/test.txt",
    filename: "test.txt",
    size: 1024,
  })
);

const mockFindAll = mock(() => [
  {
    id: "att_test001",
    filename: "test.txt",
    s3Key: "attachments/2024-01-01/att_test001/test.txt",
    bucket: "my-bucket",
    size: 2048,
    contentType: "text/plain",
    link: "https://example.com/link",
    expiresAt: 1700000000000,
    createdAt: 1699000000000,
  },
]);

const mockFindById = mock((_id: string) => ({
  id: "att_test001",
  filename: "test.txt",
  s3Key: "attachments/2024-01-01/att_test001/test.txt",
  bucket: "my-bucket",
  size: 2048,
  contentType: "text/plain",
  link: "https://example.com/link",
  expiresAt: 1700000000000,
  createdAt: 1699000000000,
}));

const mockDelete = mock((_id: string) => {});
const mockUpdateLink = mock((_id: string, _link: string, _expiresAt?: number | null) => {});
const mockClose = mock(() => {});

// Use real config module with temp config file — avoids module cache pollution
let _mcpTestConfigDir: string;
const mockSetConfig = spyOn(configModule, "setConfig").mockImplementation((_partial: object) => {});

const mockGeneratePresignedLink = mock(
  async (_s3: object, _key: string, _expiryMs: number | null) =>
    "https://example.com/new-presigned-url"
);
const mockGenerateServerLink = mock(
  (_id: string, _baseUrl: string) => "http://localhost:3457/d/att_test001"
);
const mockGetLinkType = mock(() => "presigned" as const);

const mockDbInsert = mock((_att: unknown) => {});

const mockS3ClientInstance = {
  upload: mock(async () => {}),
  download: mock(async () => Buffer.from("data")),
  delete: mock(async () => {}),
  presign: mock(async () => "https://presigned"),
  presignPut: mock(async (_key: string, _contentType: string, _expiresIn: number) => "https://example.com/presigned-put-url"),
};

const mockUploadFromUrl = mock(async (_url: string, _opts: object) => ({
  id: "att_url001",
  filename: "remote.txt",
  s3Key: "attachments/2024-01-01/att_url001/remote.txt",
  bucket: "my-bucket",
  size: 2048,
  contentType: "text/plain",
  link: "https://example.com/presigned-url-from-url",
  expiresAt: 1700000000000,
  createdAt: 1699000000000,
}));

mock.module("../core/upload.js", () => ({ uploadFile: mockUploadFile, uploadFromUrl: mockUploadFromUrl }));
mock.module("../core/download.js", () => ({
  downloadAttachment: mockDownloadAttachment,
}));
mock.module("../core/db.js", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    findAll = mockFindAll;
    findById = mockFindById;
    delete = mockDelete;
    updateLink = mockUpdateLink;
    close = mockClose;
    insert = mockDbInsert;
  },
}));
// Set up real config with test values
beforeAll(() => {
  _mcpTestConfigDir = join(tmpdir(), `mcp-test-cfg-${Date.now()}`);
  mkdirSync(_mcpTestConfigDir, { recursive: true });
  configModule.setConfigPath(join(_mcpTestConfigDir, "config.json"));
  configModule.setConfig({
    s3: { bucket: "my-bucket", region: "us-east-1", accessKeyId: "AKIATEST", secretAccessKey: "secret" },
    server: { port: 3457, baseUrl: "http://localhost:3457" },
    defaults: { expiry: "7d", linkType: "presigned" },
  });
});
mock.module("../core/links.js", () => ({
  generatePresignedLink: mockGeneratePresignedLink,
  generateServerLink: mockGenerateServerLink,
  getLinkType: mockGetLinkType,
}));
mock.module("../core/s3.js", () => ({
  S3Client: class MockS3Client {
    constructor(_config: object) {}
    upload = mockS3ClientInstance.upload;
    download = mockS3ClientInstance.download;
    delete = mockS3ClientInstance.delete;
    presign = mockS3ClientInstance.presign;
    presignPut = mockS3ClientInstance.presignPut;
  },
}));

// Import server AFTER mocks are set up
const { createServer } = await import("./server.js");

// Restore all mocks after this file's tests complete
afterAll(() => {
  mock.restore();
  try { rmSync(_mcpTestConfigDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Helper: simulate a tool call via the server's request handler
// ---------------------------------------------------------------------------

async function callTool(
  server: ReturnType<typeof createServer>,
  toolName: string,
  toolArgs: Record<string, unknown> = {}
) {
  // Access the internal request handler registered for CallToolRequest
  // We do this by emitting the request through the handler directly.
  // The Server class stores handlers via setRequestHandler — we test it
  // through the public API by manually invoking the registered handler.
  const handler = (server as unknown as {
    _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
  })._requestHandlers.get("tools/call");

  if (!handler) throw new Error("No tools/call handler registered");

  return handler({
    method: "tools/call",
    params: { name: toolName, arguments: toolArgs },
  });
}

async function listTools(server: ReturnType<typeof createServer>) {
  const handler = (server as unknown as {
    _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
  })._requestHandlers.get("tools/list");

  if (!handler) throw new Error("No tools/list handler registered");
  return handler({ method: "tools/list", params: {} });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP Server — tools/list", () => {
  it("returns 11 lean tools", async () => {
    const server = createServer();
    const result = (await listTools(server)) as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(11);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("upload_attachment");
    expect(names).toContain("upload_attachments");
    expect(names).toContain("download_attachment");
    expect(names).toContain("list_attachments");
    expect(names).toContain("delete_attachment");
    expect(names).toContain("get_link");
    expect(names).toContain("configure_s3");
    expect(names).toContain("presign_upload");
    expect(names).toContain("describe_tools");
    expect(names).toContain("search_tools");
    expect(names).toContain("link_to_task");
  });
});

describe("MCP Server — upload_attachment", () => {
  beforeEach(() => mockUploadFile.mockClear());

  it("calls uploadFile with path and opts", async () => {
    const server = createServer();
    const result = (await callTool(server, "upload_attachment", {
      path: "/tmp/file.txt",
      expiry: "24h",
      tag: "test-tag",
    })) as { content: Array<{ text: string }> };

    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockUploadFile).toHaveBeenCalledWith("/tmp/file.txt", {
      expiry: "24h",
      tag: "test-tag",
    });

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.id).toBe("att_test001");
    expect(parsed.filename).toBe("test.txt");
    expect(parsed.size).toBe(1024);
    expect(parsed.link).toBe("https://example.com/presigned-url");
  });

  it("calls uploadFile with only path when no optional args", async () => {
    const server = createServer();
    await callTool(server, "upload_attachment", { path: "/tmp/file.txt" });

    expect(mockUploadFile).toHaveBeenCalledWith("/tmp/file.txt", {
      expiry: undefined,
      tag: undefined,
    });
  });

  it("calls uploadFromUrl when url is provided instead of path", async () => {
    mockUploadFromUrl.mockClear();
    const server = createServer();
    const result = (await callTool(server, "upload_attachment", {
      url: "https://example.com/remote-file.txt",
      expiry: "24h",
    })) as { content: Array<{ text: string }> };

    expect(mockUploadFromUrl).toHaveBeenCalledTimes(1);
    expect(mockUploadFromUrl).toHaveBeenCalledWith("https://example.com/remote-file.txt", {
      expiry: "24h",
      tag: undefined,
    });
    expect(mockUploadFile).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.id).toBe("att_url001");
    expect(parsed.filename).toBe("remote.txt");
  });

  it("returns error when neither path nor url is provided", async () => {
    const server = createServer();
    const result = (await callTool(server, "upload_attachment", {
      expiry: "24h",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Either 'path' or 'url' must be provided");
  });

  it("returns error when both path and url are provided", async () => {
    const server = createServer();
    const result = (await callTool(server, "upload_attachment", {
      path: "/tmp/file.txt",
      url: "https://example.com/file.txt",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Provide either 'path' or 'url', not both");
  });
});

describe("MCP Server — upload_attachments (batch)", () => {
  let callCount: number;

  beforeEach(() => {
    mockUploadFile.mockClear();
    callCount = 0;
  });

  it("uploads 2 files and returns compact results for each", async () => {
    // Return distinct results per call
    mockUploadFile
      .mockImplementationOnce(async () => ({
        id: "att_batch01",
        filename: "a.txt",
        s3Key: "attachments/2024-01-01/att_batch01/a.txt",
        bucket: "my-bucket",
        size: 100,
        contentType: "text/plain",
        link: "https://example.com/a",
        expiresAt: null,
        createdAt: 1699000000000,
      }))
      .mockImplementationOnce(async () => ({
        id: "att_batch02",
        filename: "b.txt",
        s3Key: "attachments/2024-01-01/att_batch02/b.txt",
        bucket: "my-bucket",
        size: 200,
        contentType: "text/plain",
        link: "https://example.com/b",
        expiresAt: null,
        createdAt: 1699000000000,
      }));

    const server = createServer();
    const result = (await callTool(server, "upload_attachments", {
      paths: ["/tmp/a.txt", "/tmp/b.txt"],
      expiry: "7d",
      tag: "batch-tag",
    })) as { content: Array<{ text: string }> };

    expect(mockUploadFile).toHaveBeenCalledTimes(2);
    expect(mockUploadFile).toHaveBeenCalledWith("/tmp/a.txt", { expiry: "7d", tag: "batch-tag" });
    expect(mockUploadFile).toHaveBeenCalledWith("/tmp/b.txt", { expiry: "7d", tag: "batch-tag" });

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("att_batch01");
    expect(parsed[0].filename).toBe("a.txt");
    expect(parsed[0].size).toBe(100);
    expect(parsed[0].link).toBe("https://example.com/a");
    expect(parsed[1].id).toBe("att_batch02");
    expect(parsed[1].filename).toBe("b.txt");
  });

  it("includes per-file error when one file fails", async () => {
    mockUploadFile
      .mockImplementationOnce(async () => ({
        id: "att_ok",
        filename: "ok.txt",
        s3Key: "attachments/2024-01-01/att_ok/ok.txt",
        bucket: "my-bucket",
        size: 50,
        contentType: "text/plain",
        link: "https://example.com/ok",
        expiresAt: null,
        createdAt: 1699000000000,
      }))
      .mockImplementationOnce(async () => {
        throw new Error("File not found: /tmp/missing.txt");
      });

    const server = createServer();
    const result = (await callTool(server, "upload_attachments", {
      paths: ["/tmp/ok.txt", "/tmp/missing.txt"],
    })) as { content: Array<{ text: string }>; isError?: boolean };

    // The batch itself should NOT be an error — errors are per-file
    expect(result.isError).toBeUndefined();

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("att_ok");
    expect(parsed[1].path).toBe("/tmp/missing.txt");
    expect(parsed[1].error).toContain("File not found");
  });

  it("returns empty array for empty paths", async () => {
    const server = createServer();
    const result = (await callTool(server, "upload_attachments", {
      paths: [],
    })) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual([]);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });
});

describe("MCP Server — download_attachment", () => {
  beforeEach(() => mockDownloadAttachment.mockClear());

  it("calls downloadAttachment with id_or_url and dest", async () => {
    const server = createServer();
    const result = (await callTool(server, "download_attachment", {
      id_or_url: "att_test001",
      dest: "/tmp/downloads/",
    })) as { content: Array<{ text: string }> };

    expect(mockDownloadAttachment).toHaveBeenCalledTimes(1);
    expect(mockDownloadAttachment).toHaveBeenCalledWith(
      "att_test001",
      "/tmp/downloads/"
    );

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.path).toBe("/tmp/test.txt");
    expect(parsed.filename).toBe("test.txt");
    expect(parsed.size).toBe(1024);
  });

  it("calls downloadAttachment without dest when not provided", async () => {
    const server = createServer();
    await callTool(server, "download_attachment", {
      id_or_url: "https://localhost:3457/d/att_test001",
    });

    expect(mockDownloadAttachment).toHaveBeenCalledWith(
      "https://localhost:3457/d/att_test001",
      undefined
    );
  });
});

describe("MCP Server — list_attachments", () => {
  beforeEach(() => mockFindAll.mockClear());

  it("returns compact string by default", async () => {
    const server = createServer();
    const result = (await callTool(server, "list_attachments", {})) as {
      content: Array<{ text: string }>;
    };

    expect(mockFindAll).toHaveBeenCalledTimes(1);
    // compact string contains the attachment id
    expect(result.content[0]!.text).toContain("att_test001");
    expect(result.content[0]!.text).toContain("test.txt");
  });

  it("returns JSON array when format=json", async () => {
    const server = createServer();
    const result = (await callTool(server, "list_attachments", {
      format: "json",
    })) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe("att_test001");
  });

  it("passes limit to findAll", async () => {
    const server = createServer();
    await callTool(server, "list_attachments", { limit: 5 });

    expect(mockFindAll).toHaveBeenCalledWith({ limit: 5, tag: undefined });
  });

  it("passes tag to findAll when provided", async () => {
    const server = createServer();
    await callTool(server, "list_attachments", { tag: "session-123" });

    expect(mockFindAll).toHaveBeenCalledWith({ limit: undefined, tag: "session-123" });
  });
});

describe("MCP Server — delete_attachment", () => {
  beforeEach(() => mockDelete.mockClear());

  it("calls db.delete with the given id", async () => {
    const server = createServer();
    const result = (await callTool(server, "delete_attachment", {
      id: "att_test001",
    })) as { content: Array<{ text: string }> };

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith("att_test001");
    expect(result.content[0]!.text).toBe("deleted: att_test001");
  });
});

describe("MCP Server — get_link", () => {
  beforeEach(() => {
    mockFindById.mockClear();
    mockUpdateLink.mockClear();
    mockGeneratePresignedLink.mockClear();
  });

  it("returns existing link without regenerating", async () => {
    const server = createServer();
    const result = (await callTool(server, "get_link", {
      id: "att_test001",
    })) as { content: Array<{ text: string }> };

    expect(mockFindById).toHaveBeenCalledWith("att_test001");
    expect(mockGeneratePresignedLink).not.toHaveBeenCalled();
    expect(mockUpdateLink).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.link).toBe("https://example.com/link");
  });

  it("regenerates presigned link when regenerate=true", async () => {
    const server = createServer();
    const result = (await callTool(server, "get_link", {
      id: "att_test001",
      regenerate: true,
      expiry: "24h",
    })) as { content: Array<{ text: string }> };

    expect(mockGeneratePresignedLink).toHaveBeenCalledTimes(1);
    expect(mockUpdateLink).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.link).toBe("https://example.com/new-presigned-url");
  });

  it("returns error for unknown attachment", async () => {
    mockFindById.mockReturnValueOnce(null as unknown as ReturnType<typeof mockFindById>);
    const server = createServer();
    const result = (await callTool(server, "get_link", {
      id: "att_unknown",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("uses generateServerLink when linkType is server", async () => {
    mockGetLinkType.mockImplementation(() => "server" as const);
    mockGenerateServerLink.mockClear();

    const server = createServer();
    const result = (await callTool(server, "get_link", {
      id: "att_test001",
      regenerate: true,
    })) as { content: Array<{ text: string }> };

    expect(mockGenerateServerLink).toHaveBeenCalledTimes(1);
    expect(mockGeneratePresignedLink).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.link).toBe("http://localhost:3457/d/att_test001");
  });
});

describe("MCP Server — configure_s3", () => {
  beforeEach(() => mockSetConfig.mockClear());

  it("calls setConfig with s3 credentials", async () => {
    const server = createServer();
    const result = (await callTool(server, "configure_s3", {
      bucket: "my-bucket",
      region: "eu-west-1",
      access_key: "AKIATEST",
      secret_key: "supersecret",
    })) as { content: Array<{ text: string }> };

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    expect(mockSetConfig).toHaveBeenCalledWith({
      s3: {
        bucket: "my-bucket",
        region: "eu-west-1",
        accessKeyId: "AKIATEST",
        secretAccessKey: "supersecret",
      },
    });
    expect(result.content[0]!.text).toBe("ok");
  });

  it("includes endpoint when base_url is provided", async () => {
    const server = createServer();
    await callTool(server, "configure_s3", {
      bucket: "my-bucket",
      region: "us-east-1",
      access_key: "KEY",
      secret_key: "SECRET",
      base_url: "https://minio.example.com",
    });

    expect(mockSetConfig).toHaveBeenCalledWith({
      s3: {
        bucket: "my-bucket",
        region: "us-east-1",
        accessKeyId: "KEY",
        secretAccessKey: "SECRET",
        endpoint: "https://minio.example.com",
      },
    });
  });
});

describe("MCP Server — describe_tools", () => {
  it("returns full schema for a specific tool", async () => {
    const server = createServer();
    const result = (await callTool(server, "describe_tools", {
      tool_name: "upload_attachment",
    })) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.name).toBe("upload_attachment");
    expect(parsed.description).toBeTruthy();
    expect(parsed.inputSchema.properties.path.description).toBeTruthy();
  });

  it("returns all schemas when tool_name is omitted", async () => {
    const server = createServer();
    const result = (await callTool(server, "describe_tools", {})) as {
      content: Array<{ text: string }>;
    };

    const parsed = JSON.parse(result.content[0]!.text);
    expect(Object.keys(parsed)).toHaveLength(11);
    expect(parsed.upload_attachment).toBeDefined();
    expect(parsed.upload_attachments).toBeDefined();
    expect(parsed.presign_upload).toBeDefined();
    expect(parsed.describe_tools).toBeDefined();
  });

  it("returns error for unknown tool_name", async () => {
    const server = createServer();
    const result = (await callTool(server, "describe_tools", {
      tool_name: "nonexistent_tool",
    })) as { content: Array<{ text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unknown tool");
  });
});

describe("MCP Server — search_tools", () => {
  it("returns matching tool names as newline-separated string", async () => {
    const server = createServer();
    const result = (await callTool(server, "search_tools", {
      query: "attachment",
    })) as { content: Array<{ text: string }> };

    const lines = result.content[0]!.text.split("\n").filter(Boolean);
    expect(lines).toContain("upload_attachment");
    expect(lines).toContain("upload_attachments");
    expect(lines).toContain("download_attachment");
    expect(lines).toContain("list_attachments");
    expect(lines).toContain("delete_attachment");
    // get_link and configure_s3 don't contain "attachment"
    expect(lines).not.toContain("get_link");
    expect(lines).not.toContain("configure_s3");
  });

  it("finds presign_upload when searching for 'presign'", async () => {
    const server = createServer();
    const result = (await callTool(server, "search_tools", {
      query: "presign",
    })) as { content: Array<{ text: string }> };

    const lines = result.content[0]!.text.split("\n").filter(Boolean);
    expect(lines).toContain("presign_upload");
  });

  it("returns empty string when no matches", async () => {
    const server = createServer();
    const result = (await callTool(server, "search_tools", {
      query: "zzz_no_match",
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe("");
  });
});

describe("MCP Server — presign_upload", () => {
  beforeEach(() => {
    mockS3ClientInstance.presignPut.mockClear();
    mockS3ClientInstance.presignPut.mockImplementation(
      async () => "https://example.com/presigned-put-url"
    );
    mockDbInsert.mockClear();
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
  });

  it("calls s3.presignPut with correct expiry in seconds", async () => {
    const server = createServer();
    await callTool(server, "presign_upload", {
      filename: "data.csv",
      expiry: "1h",
    });

    expect(mockS3ClientInstance.presignPut).toHaveBeenCalledTimes(1);
    const [key, contentType, expiresIn] = mockS3ClientInstance.presignPut.mock.calls[0] as [string, string, number];
    expect(key).toContain("data.csv");
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
});

describe("MCP Server — link_to_task", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    mockFindById.mockClear();
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
