import { afterAll, beforeAll, beforeEach, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Attachment, ShareLink } from "../core/db";
import { setConfig, setConfigPath } from "../core/config";

export const mockUploadFile = mock(async (_filePath: string, _opts?: unknown) => ({
  id: "att_test00001",
  filename: "test.txt",
  s3Key: "attachments/2025-01-01/att_test00001/test.txt",
  bucket: "test-bucket",
  size: 11,
  contentType: "text/plain",
  link: "https://s3.amazonaws.com/test-bucket/test.txt?sig=presigned",
  tag: null,
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  createdAt: Date.now(),
} as Attachment));

export const mockUploadStreamAttachment = mock(
  async (_stream: unknown, filename: string, _contentType?: string, opts?: { size?: number }) => ({
    id: "att_stream0001",
    filename,
    s3Key: "attachments/2025-01-01/att_stream0001/test.txt",
    bucket: "test-bucket",
    size: opts?.size ?? 13,
    contentType: "text/plain",
    link: "http://localhost:3459/a/share_stream",
    tag: null,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    createdAt: Date.now(),
    storageBackend: "s3",
    status: "ready",
  } as Attachment)
);

mock.module("../core/upload", () => ({
  uploadFile: mockUploadFile,
  uploadStreamAttachment: mockUploadStreamAttachment,
  // store.ts statically imports these too; stub them so the mocked module
  // satisfies every named import in the dependency graph.
  uploadFromUrl: mock(async () => ({})),
  uploadFromBuffer: mock(async () => ({})),
}));

export const mockAttachment: Attachment = {
  id: "att_test00001",
  filename: "test.txt",
  s3Key: "attachments/2025-01-01/att_test00001/test.txt",
  bucket: "test-bucket",
  size: 11,
  contentType: "text/plain",
  link: "https://s3.amazonaws.com/test-bucket/test.txt?sig=presigned",
  tag: null,
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  createdAt: 1700000000000,
};

export const mockDbFindById = mock((_id: string): Attachment | null => mockAttachment);
export const mockDbFindAll = mock((_opts?: unknown): Attachment[] => [mockAttachment]);
export const mockDbUpdateLink = mock((_id: string, _link: string, _expiresAt?: number | null) => {});
export const mockDbDelete = mock((_id: string) => {});
export const mockDbClose = mock(() => {});
export const mockDbCreateShareLink = mock((_input: unknown) => ({ shareLink: {}, token: "share_testtoken" }));
export const mockDbFindShareLinksByAttachmentId = mock((_id: string) => []);
export const mockDbMarkReady = mock((_input: unknown) => {});

export const mockShareLink: ShareLink = {
  id: "share_link_1",
  attachmentId: "att_test00001",
  tokenHash: "token_hash",
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  createdAt: 1700000000000,
  revokedAt: null,
  passwordHash: null,
  maxUses: null,
  usedCount: 0,
  requireEmail: false,
  allowedEmails: null,
};

export const mockDbFindShareLinkByToken = mock((_token: string): ShareLink | null => ({ ...mockShareLink }));
export const mockDbConsumeShareLink = mock((_id: string) => true);
export const mockDbReleaseShareLink = mock((_id: string) => true);
export const mockDbIncrementDownloads = mock((_id: string) => {});
export const mockDbInsert = mock((_att: unknown) => {});

mock.module("../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    findById = mockDbFindById;
    findAll = mockDbFindAll;
    updateLink = mockDbUpdateLink;
    delete = mockDbDelete;
    close = mockDbClose;
    insert = mockDbInsert;
    createShareLink = mockDbCreateShareLink;
    findShareLinksByAttachmentId = mockDbFindShareLinksByAttachmentId;
    markReady = mockDbMarkReady;
    findShareLinkByToken = mockDbFindShareLinkByToken;
    consumeShareLink = mockDbConsumeShareLink;
    releaseShareLink = mockDbReleaseShareLink;
    incrementDownloads = mockDbIncrementDownloads;
  },
}));

export const mockS3Delete = mock(async (_key: string) => {});
export const mockS3Presign = mock(async (_key: string, _expiresIn: number) =>
  "https://s3.amazonaws.com/test-bucket/test.txt?sig=regenerated"
);
export const mockS3PresignPut = mock(async (_key: string, _contentType: string, _expiresIn: number) =>
  "https://s3.amazonaws.com/test-bucket/upload?sig=put123"
);
export const mockS3CreateMultipartUpload = mock(async (_key: string, _contentType: string) => "upload_test123");
export const mockS3PresignUploadPart = mock(
  async (_key: string, _uploadId: string, partNumber: number, _expiresIn: number) =>
    `https://s3.amazonaws.com/test-bucket/part-${partNumber}?sig=part`
);
export const mockS3CompleteMultipartUpload = mock(async (_key: string, _uploadId: string, _parts: unknown) => {});
export const mockS3AbortMultipart = mock(async (_key: string, _uploadId: string) => {});
export const mockS3Head = mock(async (_key: string) => ({ contentLength: 13, contentType: "text/plain" }));

mock.module("../core/s3", () => ({
  S3Client: class MockS3Client {
    delete = mockS3Delete;
    presign = mockS3Presign;
    presignPut = mockS3PresignPut;
    createMultipartUpload = mockS3CreateMultipartUpload;
    presignUploadPart = mockS3PresignUploadPart;
    completeMultipartUpload = mockS3CompleteMultipartUpload;
    abortMultipart = mockS3AbortMultipart;
    head = mockS3Head;
  },
}));

export const mockConfig = {
  s3: {
    bucket: "test-bucket",
    region: "us-east-1",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret",
  },
  storage: {
    backend: "s3" as const,
    localDir: "~/.hasna/attachments/test-objects",
    maxSizeBytes: 10 * 1024 * 1024 * 1024,
  },
  server: {
    port: 3459,
    host: "localhost",
    baseUrl: "http://localhost:3459",
    publicPath: "/a",
  },
  defaults: {
    expiry: "7d",
    linkType: "presigned" as const,
  },
};

let testConfigDir: string;

beforeAll(() => {
  testConfigDir = join(tmpdir(), `api-test-config-${Date.now()}`);
  mkdirSync(testConfigDir, { recursive: true });
  setConfigPath(join(testConfigDir, "config.json"));
  setConfig(mockConfig);
});

export const mockGeneratePresignedLink = mock(
  async (_s3: unknown, _key: string, _expiryMs: number | null) =>
    "https://s3.amazonaws.com/test-bucket/test.txt?sig=new"
);
export const mockGenerateServerLink = mock((id: string, baseUrl: string) => `${baseUrl}/a/${id}`);

const actualLinks = await import("../core/links");

mock.module("../core/links", () => ({
  ...actualLinks,
  generatePresignedLink: mockGeneratePresignedLink,
  generateServerLink: mockGenerateServerLink,
  generateShareLink: (token: string, baseUrl: string) => `${baseUrl}/a/${token}`,
  getLinkType: (_config: unknown) => "presigned" as const,
}));

export const mockStreamAttachment = mock(async (_id: string) => ({
  buffer: Buffer.from("file contents"),
  attachment: mockAttachment,
}));

function testBodyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("file contents"));
      controller.close();
    },
  });
}

export const mockOpenAttachmentStream = mock(async () => ({
  body: testBodyStream(),
  contentLength: 13,
  contentType: "text/plain",
  status: 200,
}));

mock.module("../core/download", () => ({
  streamAttachment: mockStreamAttachment,
  openAttachmentStream: mockOpenAttachmentStream,
  isExpired: (att: Attachment) => att.expiresAt !== null && att.expiresAt <= Date.now(),
  // store.ts statically imports downloadAttachment from this module.
  downloadAttachment: mock(async () => ({ path: "/tmp/x", filename: "x", size: 0 })),
}));

const serverModule = await import("./server");
export const createApp = serverModule.createApp;
export const startServer = serverModule.startServer;

type TestApp = ReturnType<typeof createApp>;
let app: TestApp | undefined;

export function currentApp(): TestApp {
  if (!app) {
    app = createApp();
  }
  return app;
}

beforeEach(() => {
  delete process.env.ATTACHMENTS_API_TOKEN;
  delete process.env.HASNA_ATTACHMENTS_API_TOKEN;
  delete process.env.ATTACHMENTS_MAX_SIZE;
  try {
    rmSync(join(testConfigDir, "config.json"), { force: true });
  } catch {}
  setConfig(mockConfig);
  app = createApp();

  mockUploadFile.mockReset();
  mockUploadFile.mockImplementation(async () => ({ ...mockAttachment }));
  mockUploadStreamAttachment.mockReset();
  mockUploadStreamAttachment.mockImplementation(
    async (_stream: unknown, filename: string, _contentType?: string, opts?: { size?: number }) => ({
      id: "att_stream0001",
      filename,
      s3Key: "attachments/2025-01-01/att_stream0001/test.txt",
      bucket: "test-bucket",
      size: opts?.size ?? 13,
      contentType: "text/plain",
      link: "http://localhost:3459/a/share_stream",
      tag: null,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
      storageBackend: "s3",
      status: "ready",
    } as Attachment)
  );
  mockDbFindById.mockReset();
  mockDbFindById.mockImplementation(() => ({ ...mockAttachment }));
  mockDbFindAll.mockReset();
  mockDbFindAll.mockImplementation(() => [{ ...mockAttachment }]);
  mockDbUpdateLink.mockReset();
  mockDbMarkReady.mockReset();
  mockDbCreateShareLink.mockReset();
  mockDbCreateShareLink.mockImplementation(() => ({ shareLink: {}, token: "share_testtoken" }));
  mockDbFindShareLinksByAttachmentId.mockReset();
  mockDbFindShareLinksByAttachmentId.mockImplementation(() => []);
  mockDbFindShareLinkByToken.mockReset();
  mockDbFindShareLinkByToken.mockImplementation(() => ({ ...mockShareLink }));
  mockDbConsumeShareLink.mockReset();
  mockDbConsumeShareLink.mockImplementation(() => true);
  mockDbReleaseShareLink.mockReset();
  mockDbReleaseShareLink.mockImplementation(() => true);
  mockDbIncrementDownloads.mockReset();
  mockDbDelete.mockReset();
  mockDbClose.mockReset();
  mockS3Delete.mockReset();
  mockS3Delete.mockImplementation(async () => {});
  mockS3PresignPut.mockReset();
  mockS3PresignPut.mockImplementation(async () => "https://s3.amazonaws.com/test-bucket/upload?sig=put123");
  mockS3CreateMultipartUpload.mockReset();
  mockS3CreateMultipartUpload.mockImplementation(async () => "upload_test123");
  mockS3PresignUploadPart.mockReset();
  mockS3PresignUploadPart.mockImplementation(
    async (_key: string, _uploadId: string, partNumber: number) =>
      `https://s3.amazonaws.com/test-bucket/part-${partNumber}?sig=part`
  );
  mockS3CompleteMultipartUpload.mockReset();
  mockS3CompleteMultipartUpload.mockImplementation(async () => {});
  mockS3AbortMultipart.mockReset();
  mockS3AbortMultipart.mockImplementation(async () => {});
  mockS3Head.mockReset();
  mockS3Head.mockImplementation(async () => ({ contentLength: 13, contentType: "text/plain" }));
  mockDbInsert.mockReset();
  mockGeneratePresignedLink.mockReset();
  mockGeneratePresignedLink.mockImplementation(
    async () => "https://s3.amazonaws.com/test-bucket/test.txt?sig=new"
  );
  mockStreamAttachment.mockReset();
  mockStreamAttachment.mockImplementation(async () => ({
    buffer: Buffer.from("file contents"),
    attachment: mockAttachment,
  }));
  mockOpenAttachmentStream.mockReset();
  mockOpenAttachmentStream.mockImplementation(async () => ({
    body: testBodyStream(),
    contentLength: 13,
    contentType: "text/plain",
    status: 200,
  }));
});

afterAll(() => {
  mock.restore();
  try {
    rmSync(testConfigDir, { recursive: true, force: true });
  } catch {}
});

export function makeFormData(filename: string, content: string, extraFields?: Record<string, string>): FormData {
  const fd = new FormData();
  fd.append("file", new File([content], filename, { type: "text/plain" }));
  if (extraFields) {
    for (const [key, value] of Object.entries(extraFields)) {
      fd.append(key, value);
    }
  }
  return fd;
}
