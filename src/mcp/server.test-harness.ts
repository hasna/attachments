import { mock, beforeAll, afterAll, spyOn } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import * as configModule from "../core/config";

// ---------------------------------------------------------------------------
// Mock all core modules before importing the server
// ---------------------------------------------------------------------------

export const mockUploadFile = mock(async (_path: string, _opts: object) => ({
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

export const mockDownloadAttachment = mock(
  async (_idOrUrl: string, _dest?: string) => ({
    path: "/tmp/test.txt",
    filename: "test.txt",
    size: 1024,
  })
);

export const mockFindAll = mock(() => [
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

export const mockFindById = mock((_id: string) => ({
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

export function resetMockFindById(): void {
  mockFindById.mockImplementation((_id: string) => ({
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
}

export const mockDelete = mock((_id: string) => {});
export const mockUpdateLink = mock((_id: string, _link: string, _expiresAt?: number | null) => {});
export const mockMarkReady = mock((_input: unknown) => {});
export const mockClose = mock(() => {});

// Use real config module with temp config file — avoids module cache pollution
let _mcpTestConfigDir: string;
export const mockSetConfig = spyOn(configModule, "setConfig").mockImplementation((_partial: object) => {});
export const mockValidateS3Config = spyOn(configModule, "validateS3Config").mockImplementation(() => {});

export const mockGeneratePresignedLink = mock(
  async (_s3: object, _key: string, _expiryMs: number | null) =>
    "https://example.com/new-presigned-url"
);
export const mockGenerateServerLink = mock(
  (_id: string, _baseUrl: string) => "http://localhost:3459/a/att_test001"
);
export const mockGenerateShareLink = mock(
  (_token: string, _baseUrl: string) => "http://localhost:3459/a/share_test001"
);
export const mockGetLinkType = mock(() => "presigned" as const);

export const mockDbInsert = mock((_att: unknown) => {});
export const mockDbCreateShareLink = mock((_input: unknown) => ({ shareLink: {}, token: "share_test001" }));

export const mockS3ClientInstance = {
  upload: mock(async () => {}),
  download: mock(async () => Buffer.from("data")),
  delete: mock(async () => {}),
  head: mock(async (_key: string) => ({ contentLength: 4096, contentType: "application/pdf" })),
  presign: mock(async () => "https://presigned"),
  presignPut: mock(async (_key: string, _contentType: string, _expiresIn: number) => "https://example.com/presigned-put-url"),
};

export const mockUploadFromUrl = mock(async (_url: string, _opts: object) => ({
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

export const mockUploadFromBuffer = mock(async (_buffer: Buffer, filename: string, _opts: object) => ({
  id: "att_buf001",
  filename,
  s3Key: `attachments/2024-01-01/att_buf001/${filename}`,
  bucket: "my-bucket",
  size: 512,
  contentType: "text/markdown",
  link: "https://example.com/presigned-buf",
  expiresAt: 1700000000000,
  createdAt: 1699000000000,
}));

mock.module("../core/upload.js", () => ({ uploadFile: mockUploadFile, uploadFromUrl: mockUploadFromUrl, uploadFromBuffer: mockUploadFromBuffer }));
mock.module("../core/download.js", () => ({
  downloadAttachment: mockDownloadAttachment,
}));
mock.module("../core/db.js", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    findAll = mockFindAll;
    findById = mockFindById;
    delete = mockDelete;
    updateLink = mockUpdateLink;
    markReady = mockMarkReady;
    close = mockClose;
    insert = mockDbInsert;
    createShareLink = mockDbCreateShareLink;
  },
}));
// Set up real config with test values
beforeAll(() => {
  _mcpTestConfigDir = join(tmpdir(), `mcp-test-cfg-${Date.now()}`);
  mkdirSync(_mcpTestConfigDir, { recursive: true });
  configModule.setConfigPath(join(_mcpTestConfigDir, "config.json"));
  configModule.setConfig({
    s3: { bucket: "my-bucket", region: "us-east-1", accessKeyId: "AKIATEST", secretAccessKey: "secret" },
    server: { port: 3459, baseUrl: "http://localhost:3459" },
    defaults: { expiry: "7d", linkType: "presigned" },
  });
});
mock.module("../core/links.js", () => ({
  generatePresignedLink: mockGeneratePresignedLink,
  generateServerLink: mockGenerateServerLink,
  generateShareLink: mockGenerateShareLink,
  getLinkType: mockGetLinkType,
}));
mock.module("../core/s3.js", () => ({
  S3Client: class MockS3Client {
    constructor(_config: object) {}
    upload = mockS3ClientInstance.upload;
    download = mockS3ClientInstance.download;
    delete = mockS3ClientInstance.delete;
    head = mockS3ClientInstance.head;
    presign = mockS3ClientInstance.presign;
    presignPut = mockS3ClientInstance.presignPut;
  },
}));

// Import server AFTER mocks are set up
const serverModule = await import("./server.js");

export const createServer = serverModule.createServer;
export const getToolsForProfile = serverModule.getToolsForProfile;

// Restore all mocks after this file's tests complete
afterAll(() => {
  mock.restore();
  try { rmSync(_mcpTestConfigDir, { recursive: true, force: true }); } catch {}
});

export function retiredToolName(suffix: string): string {
  return ["clo", "ud", suffix].join("");
}

// ---------------------------------------------------------------------------
// Helper: simulate a tool call via the server's request handler
// ---------------------------------------------------------------------------

export async function callTool(
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

export async function listTools(server: ReturnType<typeof createServer>) {
  const handler = (server as unknown as {
    _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
  })._requestHandlers.get("tools/list");

  if (!handler) throw new Error("No tools/list handler registered");
  return handler({ method: "tools/list", params: {} });
}
