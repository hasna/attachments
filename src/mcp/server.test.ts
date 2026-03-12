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

const mockS3ClientInstance = {
  upload: mock(async () => {}),
  download: mock(async () => Buffer.from("data")),
  delete: mock(async () => {}),
  presign: mock(async () => "https://presigned"),
};

mock.module("../core/upload.js", () => ({ uploadFile: mockUploadFile }));
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
  it("returns 8 lean tools", async () => {
    const server = createServer();
    const result = (await listTools(server)) as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(8);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("upload_attachment");
    expect(names).toContain("download_attachment");
    expect(names).toContain("list_attachments");
    expect(names).toContain("delete_attachment");
    expect(names).toContain("get_link");
    expect(names).toContain("configure_s3");
    expect(names).toContain("describe_tools");
    expect(names).toContain("search_tools");
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

    expect(mockFindAll).toHaveBeenCalledWith({ limit: 5 });
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
    expect(Object.keys(parsed)).toHaveLength(8);
    expect(parsed.upload_attachment).toBeDefined();
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
    expect(lines).toContain("download_attachment");
    expect(lines).toContain("list_attachments");
    expect(lines).toContain("delete_attachment");
    // get_link and configure_s3 don't contain "attachment"
    expect(lines).not.toContain("get_link");
    expect(lines).not.toContain("configure_s3");
  });

  it("returns empty string when no matches", async () => {
    const server = createServer();
    const result = (await callTool(server, "search_tools", {
      query: "zzz_no_match",
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe("");
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
