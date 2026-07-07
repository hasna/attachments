import { describe, it, expect, beforeEach } from "bun:test";
import {
  callTool,
  createServer,
  getToolsForProfile,
  listTools,
  mockDbCreateShareLink,
  mockDelete,
  mockDownloadAttachment,
  mockFindAll,
  mockFindById,
  mockGeneratePresignedLink,
  mockGenerateShareLink,
  mockGetLinkType,
  mockSetConfig,
  mockUpdateLink,
  mockUploadFile,
  mockUploadFromUrl,
  retiredToolName,
} from "./server.test-harness";

describe("MCP Server — tools/list", () => {
  it("returns 13 standard tools by default (no ATTACHMENTS_PROFILE set)", async () => {
    delete process.env.ATTACHMENTS_PROFILE;
    const server = createServer();
    const result = (await listTools(server)) as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(13);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("upload_attachment");
    expect(names).toContain("download_attachment");
    expect(names).toContain("get_link");
    expect(names).toContain("list_attachments");
    expect(names).toContain("delete_attachment");
    expect(names).toContain("complete_task_with_files");
    expect(names).toContain("save_session");
    expect(names).toContain("report_stats");
    expect(names).toContain("get_context");
  });
});

describe("ATTACHMENTS_PROFILE — getToolsForProfile()", () => {
  it("minimal profile returns exactly 3 tools", () => {
    const tools = getToolsForProfile("minimal");
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain("upload_attachment");
    expect(names).toContain("download_attachment");
    expect(names).toContain("get_link");
  });

  it("standard profile returns exactly 13 tools", () => {
    const tools = getToolsForProfile("standard");
    expect(tools).toHaveLength(13);
    const names = tools.map((t) => t.name);
    expect(names).toContain("upload_attachment");
    expect(names).toContain("download_attachment");
    expect(names).toContain("get_link");
    expect(names).toContain("list_attachments");
    expect(names).toContain("delete_attachment");
    expect(names).toContain("complete_task_with_files");
    expect(names).toContain("save_session");
    expect(names).toContain("report_stats");
    expect(names).toContain("get_context");
  });

  it("full profile returns all 26 tools", () => {
    const tools = getToolsForProfile("full");
    expect(tools).toHaveLength(26);
    const names = tools.map((t) => t.name);
    expect(names).toContain("upload_attachment");
    expect(names).toContain("upload_attachments");
    expect(names).toContain("download_attachment");
    expect(names).toContain("list_attachments");
    expect(names).toContain("delete_attachment");
    expect(names).toContain("get_link");
    expect(names).toContain("configure_s3");
    expect(names).toContain("presign_upload");
    expect(names).toContain("complete_presigned_upload");
    expect(names).toContain("describe_tools");
    expect(names).toContain("search_tools");
    expect(names).toContain("link_to_task");
    expect(names).toContain("complete_task_with_files");
    expect(names).toContain("save_session");
    expect(names).toContain("check_attachment_health");
    expect(names).toContain("storage_status");
    expect(names).toContain("storage_push");
    expect(names).toContain("storage_pull");
    expect(names).toContain("storage_sync");
    expect(names).not.toContain(retiredToolName("_status"));
    expect(names).not.toContain(retiredToolName("_push"));
    expect(names).not.toContain(retiredToolName("_pull"));
    expect(names).not.toContain(retiredToolName("_sync"));
  });

  it("no argument (reads process.env.ATTACHMENTS_PROFILE) defaults to standard (13 tools)", () => {
    delete process.env.ATTACHMENTS_PROFILE;
    const tools = getToolsForProfile();
    expect(tools).toHaveLength(13);
  });

  it("ATTACHMENTS_PROFILE=minimal env var returns 3 tools", () => {
    process.env.ATTACHMENTS_PROFILE = "minimal";
    const tools = getToolsForProfile();
    expect(tools).toHaveLength(3);
    delete process.env.ATTACHMENTS_PROFILE;
  });

  it("ATTACHMENTS_PROFILE=full env var returns 26 tools", () => {
    process.env.ATTACHMENTS_PROFILE = "full";
    const tools = getToolsForProfile();
    expect(tools).toHaveLength(26);
    delete process.env.ATTACHMENTS_PROFILE;
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
      id_or_url: "https://localhost:3459/d/att_test001",
    });

    expect(mockDownloadAttachment).toHaveBeenCalledWith(
      "https://localhost:3459/d/att_test001",
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
    mockDbCreateShareLink.mockClear();
    mockGeneratePresignedLink.mockClear();
    mockGenerateShareLink.mockClear();
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

  it("creates a share link when linkType is server", async () => {
    mockGetLinkType.mockImplementation(() => "server" as const);

    const server = createServer();
    const result = (await callTool(server, "get_link", {
      id: "att_test001",
      regenerate: true,
    })) as { content: Array<{ text: string }> };

    expect(mockDbCreateShareLink).toHaveBeenCalledTimes(1);
    expect(mockGenerateShareLink).toHaveBeenCalledTimes(1);
    expect(mockGeneratePresignedLink).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.link).toBe("http://localhost:3459/a/share_test001");
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

  it("allows bucket and region without static keys for default credential-chain auth", async () => {
    const server = createServer();
    const result = (await callTool(server, "configure_s3", {
      bucket: "role-bucket",
      region: "us-east-1",
    })) as { content: Array<{ text: string }> };

    expect(mockSetConfig).toHaveBeenCalledWith({
      s3: {
        bucket: "role-bucket",
        region: "us-east-1",
      },
    });
    expect(result.content[0]!.text).toBe("ok");
  });

  it("rejects partial static key configuration", async () => {
    const server = createServer();
    const result = (await callTool(server, "configure_s3", {
      bucket: "role-bucket",
      region: "us-east-1",
      access_key: "KEY",
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("must be provided together");
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
    expect(Object.keys(parsed)).toHaveLength(17);
    expect(parsed.upload_attachment).toBeDefined();
    expect(parsed.upload_attachments).toBeDefined();
    expect(parsed.presign_upload).toBeDefined();
    expect(parsed.complete_presigned_upload).toBeDefined();
    expect(parsed.describe_tools).toBeDefined();
    expect(parsed.complete_task_with_files).toBeDefined();
    expect(parsed.save_session).toBeDefined();
    expect(parsed.report_stats).toBeDefined();
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
    expect(lines).toContain("complete_presigned_upload");
  });

  it("returns empty string when no matches", async () => {
    const server = createServer();
    const result = (await callTool(server, "search_tools", {
      query: "zzz_no_match",
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe("");
  });
});
