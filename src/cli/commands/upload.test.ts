import { describe, it, expect, mock, beforeEach, spyOn, afterAll } from "bun:test";
import { Command } from "commander";
import * as configModule from "../../core/config";
import * as childProcess from "child_process";

// ---------------------------------------------------------------------------
// Mock core/upload and core/config before importing the command
// ---------------------------------------------------------------------------
const mockUploadFile = mock(async (_filePath: string, _opts: unknown) => ({
  id: "att_testid1234",
  filename: "test.txt",
  s3Key: "attachments/2026-01-01/att_testid1234/test.txt",
  bucket: "my-bucket",
  size: 1258291, // ~1.2 MB
  contentType: "text/plain",
  link: "https://s3.example.com/presigned?sig=abc",
  expiresAt: 1742000000000,
  createdAt: 1741913600000,
}));

const mockUploadFromBuffer = mock(async (_buffer: Buffer, _filename: string, _opts: unknown) => ({
  id: "att_stdin00001",
  filename: "stdin-file.txt",
  s3Key: "attachments/2026-01-01/att_stdin00001/stdin-file.txt",
  bucket: "my-bucket",
  size: 512,
  contentType: "text/plain",
  link: "https://s3.example.com/presigned?sig=stdin",
  expiresAt: 1742000000000,
  createdAt: 1741913600000,
}));

const mockUploadStreamAttachment = mock(async (_stream: unknown, _filename: string, _contentType: string, _opts: unknown) => ({
  id: "att_stdin00001",
  filename: "stdin-file.txt",
  s3Key: "attachments/2026-01-01/att_stdin00001/stdin-file.txt",
  bucket: "my-bucket",
  size: 512,
  contentType: "text/plain",
  link: "https://s3.example.com/presigned?sig=stdin",
  expiresAt: 1742000000000,
  createdAt: 1741913600000,
}));

const mockUploadFromUrl = mock(async (_url: string, _opts: unknown) => ({
  id: "att_fromurl001",
  filename: "remote-file.txt",
  s3Key: "attachments/2026-01-01/att_fromurl001/remote-file.txt",
  bucket: "my-bucket",
  size: 2048,
  contentType: "text/plain",
  link: "https://s3.example.com/presigned?sig=url",
  expiresAt: 1742000000000,
  createdAt: 1741913600000,
}));

const testConfig = {
  s3: { bucket: "my-bucket", region: "us-east-1", accessKeyId: "AKIATEST", secretAccessKey: "secret" },
  storage: { backend: "s3" as const, localDir: "~/.hasna/attachments/test-objects", maxSizeBytes: 10 * 1024 * 1024 * 1024 },
  server: { port: 3459, host: "localhost", baseUrl: "http://localhost:3459", publicPath: "/a" },
  defaults: { expiry: "7d", linkType: "presigned" as const },
  client: { mode: "local" as const, apiBaseUrl: "", apiToken: "", apiTokenEnv: "ATTACHMENTS_API_TOKEN", preferInternal: false },
  domains: [],
  deployment: {},
};

mock.module("../../core/upload", () => ({
  uploadFile: mockUploadFile,
  uploadFromBuffer: mockUploadFromBuffer,
  uploadFromUrl: mockUploadFromUrl,
  uploadStreamAttachment: mockUploadStreamAttachment,
}));

const mockV1Store = {
  uploadStream: mock(async (_stream: unknown, filename: string, _opts: unknown) => ({
    id: "att_v1stream",
    filename,
    s3Key: "",
    bucket: "cloud",
    size: 10,
    contentType: "application/octet-stream",
    link: "https://v1.example/stream",
    expiresAt: null,
    createdAt: Date.now(),
  })),
  uploadUrl: mock(async (_url: string, _opts: unknown) => ({
    id: "att_v1url",
    filename: "v1-url.txt",
    s3Key: "",
    bucket: "cloud",
    size: 20,
    contentType: "text/plain",
    link: "https://v1.example/url",
    expiresAt: null,
    createdAt: Date.now(),
  })),
  uploadFile: mock(async (_path: string, _opts: unknown) => ({
    id: "att_v1file",
    filename: "v1-file.txt",
    s3Key: "",
    bucket: "cloud",
    size: 30,
    contentType: "text/plain",
    link: "https://v1.example/file",
    expiresAt: null,
    createdAt: Date.now(),
  })),
};
const mockResolveAttachmentsV1 = mock(() => ({ transport: "local" as const, store: null }));

mock.module("../../core/cloud-v1", () => ({
  resolveAttachmentsV1: mockResolveAttachmentsV1,
}));

const mockUploadStreamToCloudApi = mock(async (_stream: unknown, filename: string, _contentType: string, _opts: unknown) => ({
  id: "att_cloudstream",
  filename,
  s3Key: "",
  bucket: "cloud",
  size: 40,
  contentType: "application/octet-stream",
  link: "https://cloud.example/stream",
  expiresAt: null,
  createdAt: Date.now(),
}));
const mockUploadUrlToCloudApi = mock(async (_url: string, _opts: unknown) => ({
  id: "att_cloudurl",
  filename: "cloud-url.txt",
  s3Key: "",
  bucket: "cloud",
  size: 50,
  contentType: "text/plain",
  link: "https://cloud.example/url",
  expiresAt: null,
  createdAt: Date.now(),
}));
const mockUploadFileToCloudApi = mock(async (_path: string, _opts: unknown) => ({
  id: "att_cloudfile",
  filename: "cloud-file.txt",
  s3Key: "",
  bucket: "cloud",
  size: 60,
  contentType: "text/plain",
  link: "https://cloud.example/file",
  expiresAt: null,
  createdAt: Date.now(),
}));

mock.module("../../core/api-client", () => ({
  uploadStreamToCloudApi: mockUploadStreamToCloudApi,
  uploadUrlToCloudApi: mockUploadUrlToCloudApi,
  uploadFileToCloudApi: mockUploadFileToCloudApi,
}));

const mockResolveInternalBaseUrl = mock(async (_config: unknown) => ({ baseUrl: "http://internal.local:3459" }));

mock.module("../../core/internal-link", () => ({
  resolveInternalBaseUrl: mockResolveInternalBaseUrl,
}));

// spyOn validateStorageConfig to avoid mock.module cache pollution
const mockGetConfig = spyOn(configModule, "getConfig").mockImplementation(() => testConfig);
const mockIsCloudClientMode = spyOn(configModule, "isCloudClientMode").mockImplementation(() => false);
const mockValidateStorageConfig = spyOn(configModule, "validateStorageConfig").mockImplementation(() => {});

// spyOn execSync for clipboard tests
const mockExecSync = spyOn(childProcess, "execSync").mockImplementation(() => Buffer.from(""));

// Import after mocks
const { registerUpload } = await import("./upload");

// Restore all mocks after this file's tests complete so they don't leak into other test files
afterAll(() => mock.restore());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh Commander program with the upload command registered,
 * then parse the given argv array.
 * Returns captured stdout/stderr output.
 */
function buildProgram() {
  const program = new Command();
  program.exitOverride(); // prevent process.exit from actually exiting
  registerUpload(program);
  return program;
}

function captureOutput() {
  const out: string[] = [];
  const err: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

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
      void origStdout; // suppress unused warning
      void origStderr;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upload command", () => {
  beforeEach(() => {
    mockGetConfig.mockReset();
    mockGetConfig.mockImplementation(() => testConfig);
    mockIsCloudClientMode.mockReset();
    mockIsCloudClientMode.mockImplementation(() => false);
    mockUploadFile.mockReset();
    mockUploadFile.mockImplementation(async () => ({
      id: "att_testid1234",
      filename: "test.txt",
      s3Key: "attachments/2026-01-01/att_testid1234/test.txt",
      bucket: "my-bucket",
      size: 1258291,
      contentType: "text/plain",
      link: "https://s3.example.com/presigned?sig=abc",
      expiresAt: 1742000000000,
      createdAt: 1741913600000,
    }));
    mockUploadFromBuffer.mockReset();
    mockUploadFromBuffer.mockImplementation(async () => ({
      id: "att_stdin00001",
      filename: "stdin-file.txt",
      s3Key: "attachments/2026-01-01/att_stdin00001/stdin-file.txt",
      bucket: "my-bucket",
      size: 512,
      contentType: "text/plain",
      link: "https://s3.example.com/presigned?sig=stdin",
      expiresAt: 1742000000000,
      createdAt: 1741913600000,
    }));
    mockUploadStreamAttachment.mockReset();
    mockUploadStreamAttachment.mockImplementation(async () => ({
      id: "att_stdin00001",
      filename: "stdin-file.txt",
      s3Key: "attachments/2026-01-01/att_stdin00001/stdin-file.txt",
      bucket: "my-bucket",
      size: 512,
      contentType: "text/plain",
      link: "https://s3.example.com/presigned?sig=stdin",
      expiresAt: 1742000000000,
      createdAt: 1741913600000,
    }));
    mockUploadFromUrl.mockReset();
    mockUploadFromUrl.mockImplementation(async () => ({
      id: "att_fromurl001",
      filename: "remote-file.txt",
      s3Key: "attachments/2026-01-01/att_fromurl001/remote-file.txt",
      bucket: "my-bucket",
      size: 2048,
      contentType: "text/plain",
      link: "https://s3.example.com/presigned?sig=url",
      expiresAt: 1742000000000,
      createdAt: 1741913600000,
    }));
    mockValidateStorageConfig.mockReset();
    mockValidateStorageConfig.mockImplementation(() => {});
    mockExecSync.mockReset();
    mockExecSync.mockImplementation(() => Buffer.from(""));
    mockResolveAttachmentsV1.mockReset();
    mockResolveAttachmentsV1.mockImplementation(() => ({ transport: "local" as const, store: null }));
    for (const fn of [mockV1Store.uploadStream, mockV1Store.uploadUrl, mockV1Store.uploadFile]) fn.mockClear();
    mockUploadStreamToCloudApi.mockClear();
    mockUploadUrlToCloudApi.mockClear();
    mockUploadFileToCloudApi.mockClear();
    mockResolveInternalBaseUrl.mockClear();
  });

  it("calls uploadFile with the given file path", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "photo.png"], { from: "user" });
      expect(mockUploadFile).toHaveBeenCalledTimes(1);
      const [calledPath] = mockUploadFile.mock.calls[0] as [string, unknown];
      expect(calledPath).toBe("photo.png");
    } finally {
      capture.restore();
    }
  });

  it("passes expiry option to uploadFile", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "file.txt", "--expiry", "24h"], { from: "user" });
      const [, opts] = mockUploadFile.mock.calls[0] as [string, { expiry?: string }];
      expect(opts.expiry).toBe("24h");
    } finally {
      capture.restore();
    }
  });

  it("passes link-type option to uploadFile", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "file.txt", "--link-type", "server"], { from: "user" });
      const [, opts] = mockUploadFile.mock.calls[0] as [string, { linkType?: string }];
      expect(opts.linkType).toBe("server");
    } finally {
      capture.restore();
    }
  });

  it("passes tag option to uploadFile", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "file.txt", "--tag", "session-42"], { from: "user" });
      const [, opts] = mockUploadFile.mock.calls[0] as [string, { tag?: string }];
      expect(opts.tag).toBe("session-42");
    } finally {
      capture.restore();
    }
  });

  it("outputs human-readable format by default", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "test.txt"], { from: "user" });
      const combined = capture.out.join("");
      expect(combined).toContain("✓ Uploaded test.txt");
      expect(combined).toContain("https://s3.example.com/presigned?sig=abc");
      expect(combined).toContain("att_testid1234");
      expect(combined).toContain("1.2 MB");
    } finally {
      capture.restore();
    }
  });

  it("outputs JSON format when --format json is passed", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "test.txt", "--format", "json"], { from: "user" });
      const combined = capture.out.join("");
      const parsed = JSON.parse(combined);
      expect(parsed.id).toBe("att_testid1234");
      expect(parsed.filename).toBe("test.txt");
      expect(parsed.size).toBe(1258291);
    } finally {
      capture.restore();
    }
  });

  it("exits with an error when storage config is invalid", async () => {
    mockValidateStorageConfig.mockImplementation(() => {
      throw new Error("storage.maxSizeBytes must be a positive number");
    });

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["upload", "file.txt"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("storage.maxSizeBytes");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with an error when uploadFile throws", async () => {
    mockUploadFile.mockImplementation(async () => {
      throw new Error("Network failure");
    });

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["upload", "file.txt"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("Network failure");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("shows (none) as link when attachment.link is null", async () => {
    mockUploadFile.mockImplementation(async () => ({
      id: "att_nolink0001",
      filename: "nope.txt",
      s3Key: "attachments/2026-01-01/att_nolink0001/nope.txt",
      bucket: "my-bucket",
      size: 100,
      contentType: "text/plain",
      link: null,
      expiresAt: null,
      createdAt: Date.now(),
    }));

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "nope.txt"], { from: "user" });
      const combined = capture.out.join("");
      expect(combined).toContain("(none)");
      expect(combined).toContain("Never");
    } finally {
      capture.restore();
    }
  });

  it("copies link to clipboard when --copy is passed", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "test.txt", "--copy"], { from: "user" });
      expect(mockExecSync).toHaveBeenCalledTimes(1);
      const [cmd, opts] = mockExecSync.mock.calls[0] as [string, { input: string }];
      expect(cmd).toContain(process.platform === "darwin" ? "pbcopy" : "xclip");
      expect(opts.input).toBe("https://s3.example.com/presigned?sig=abc");
      const combined = capture.out.join("");
      expect(combined).toContain("(copied to clipboard)");
    } finally {
      capture.restore();
    }
  });

  it("does not show copied message when --copy is not passed", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "test.txt"], { from: "user" });
      expect(mockExecSync).not.toHaveBeenCalled();
      const combined = capture.out.join("");
      expect(combined).not.toContain("(copied to clipboard)");
    } finally {
      capture.restore();
    }
  });

  it("does not fail upload when clipboard copy fails", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("pbcopy not found");
    });
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "test.txt", "--copy"], { from: "user" });
      // Upload should still succeed
      const combined = capture.out.join("");
      expect(combined).toContain("✓ Uploaded test.txt");
      expect(combined).not.toContain("(copied to clipboard)");
    } finally {
      capture.restore();
    }
  });

  it("does not attempt clipboard copy when link is null with --copy", async () => {
    mockUploadFile.mockImplementation(async () => ({
      id: "att_nolink0001",
      filename: "nope.txt",
      s3Key: "attachments/2026-01-01/att_nolink0001/nope.txt",
      bucket: "my-bucket",
      size: 100,
      contentType: "text/plain",
      link: null,
      expiresAt: null,
      createdAt: Date.now(),
    }));
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "nope.txt", "--copy"], { from: "user" });
      expect(mockExecSync).not.toHaveBeenCalled();
      const combined = capture.out.join("");
      expect(combined).not.toContain("(copied to clipboard)");
    } finally {
      capture.restore();
    }
  });

  it("outputs brief one-line format when --brief is passed", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "test.txt", "--brief"], { from: "user" });
      const combined = capture.out.join("");
      expect(combined).toBe("att_testid1234 https://s3.example.com/presigned?sig=abc 1.2 MB\n");
    } finally {
      capture.restore();
    }
  });

  it("outputs brief format with (none) when link is null and --brief is passed", async () => {
    mockUploadFile.mockImplementation(async () => ({
      id: "att_nolink0001",
      filename: "nope.txt",
      s3Key: "attachments/2026-01-01/att_nolink0001/nope.txt",
      bucket: "my-bucket",
      size: 100,
      contentType: "text/plain",
      link: null,
      expiresAt: null,
      createdAt: Date.now(),
    }));

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "nope.txt", "--brief"], { from: "user" });
      const combined = capture.out.join("");
      expect(combined).toBe("att_nolink0001 (none) 100 B\n");
    } finally {
      capture.restore();
    }
  });

  it("exits with an error when --stdin is used without --filename", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["upload", "--stdin"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("--filename is required when using --stdin");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with an error when no file path is provided", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(program.parseAsync(["upload"], { from: "user" })).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("A file path is required");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("validates client mode, max downloads, encryption, and allowed emails", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(program.parseAsync(["upload", "file.txt", "--client-mode", "remote"], { from: "user" })).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("--client-mode");

      capture.err.length = 0;
      await expect(program.parseAsync(["upload", "file.txt", "--max-downloads", "0"], { from: "user" })).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("--max-downloads");

      capture.err.length = 0;
      await expect(program.parseAsync(["upload", "file.txt", "--encrypt"], { from: "user" })).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("--encrypt requires --password");

      capture.err.length = 0;
      await expect(program.parseAsync(["upload", "file.txt", "--allowed-email", "not-an-email"], { from: "user" })).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("Invalid --allowed-email");

      capture.err.length = 0;
      await expect(program.parseAsync(["upload", "file.txt", "--internal", "--client-mode", "cloud"], { from: "user" })).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("--internal requires local client mode");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("routes stdin and internal local uploads through local storage", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "--stdin", "--filename", "stdin.bin"], { from: "user" });
      expect(mockUploadStreamAttachment).toHaveBeenCalledWith(process.stdin, "stdin.bin", "application/octet-stream", expect.any(Object));

      await program.parseAsync(["upload", "file.txt", "--internal", "--allowed-email", "person@example.com"], { from: "user" });
      const [, opts] = mockUploadFile.mock.calls.at(-1) as [string, { baseUrl?: string; allowedEmails?: string[]; requireEmail?: boolean }];
      expect(opts.baseUrl).toBe("http://internal.local:3459");
      expect(opts.allowedEmails).toEqual(["person@example.com"]);
      expect(opts.requireEmail).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it("routes uploads through legacy cloud API mode", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "file.txt", "--client-mode", "cloud"], { from: "user" });
      await program.parseAsync(["upload", "https://example.com/file.txt", "--client-mode", "cloud"], { from: "user" });
      await program.parseAsync(["upload", "--stdin", "--filename", "stdin.bin", "--client-mode", "cloud"], { from: "user" });
      expect(mockUploadFileToCloudApi).toHaveBeenCalledWith("file.txt", expect.any(Object));
      expect(mockUploadUrlToCloudApi).toHaveBeenCalledWith("https://example.com/file.txt", expect.any(Object));
      expect(mockUploadStreamToCloudApi).toHaveBeenCalledWith(process.stdin, "stdin.bin", "application/octet-stream", expect.any(Object));
    } finally {
      capture.restore();
    }
  });

  it("routes uploads through self-hosted v1 mode and rejects unsupported encrypted v1 uploads", async () => {
    mockResolveAttachmentsV1.mockImplementation(() => ({
      transport: "cloud-http" as const,
      store: mockV1Store,
    }));

    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "file.txt"], { from: "user" });
      await program.parseAsync(["upload", "https://example.com/file.txt"], { from: "user" });
      await program.parseAsync(["upload", "--stdin", "--filename", "stdin.bin"], { from: "user" });
      expect(mockV1Store.uploadFile).toHaveBeenCalledWith("file.txt", expect.any(Object));
      expect(mockV1Store.uploadUrl).toHaveBeenCalledWith("https://example.com/file.txt", expect.any(Object));
      expect(mockV1Store.uploadStream).toHaveBeenCalledWith(process.stdin, "stdin.bin", expect.any(Object));
    } finally {
      capture.restore();
    }

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const errorCapture = captureOutput();
    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["upload", "file.txt", "--encrypt", "--password", "pw"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(errorCapture.err.join("")).toContain("not supported in self_hosted");
    } finally {
      errorCapture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with an error when --link-type has an invalid value", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["upload", "file.txt", "--link-type", "invalid-type"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("'presigned' or 'server'");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("calls uploadFromUrl when argument starts with https://", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "https://example.com/file.txt"], { from: "user" });
      expect(mockUploadFromUrl).toHaveBeenCalledTimes(1);
      expect(mockUploadFile).not.toHaveBeenCalled();
      const [calledUrl] = mockUploadFromUrl.mock.calls[0] as [string, unknown];
      expect(calledUrl).toBe("https://example.com/file.txt");
    } finally {
      capture.restore();
    }
  });

  it("calls uploadFromUrl when argument starts with http://", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "http://example.com/file.txt"], { from: "user" });
      expect(mockUploadFromUrl).toHaveBeenCalledTimes(1);
      expect(mockUploadFile).not.toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });

  it("prints 'Fetching URL...' to stderr when uploading a URL", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "https://example.com/file.txt"], { from: "user" });
      const stderrOutput = capture.err.join("");
      expect(stderrOutput).toContain("Fetching URL...");
    } finally {
      capture.restore();
    }
  });

  it("calls uploadFile (not uploadFromUrl) for regular file paths", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["upload", "/tmp/local-file.txt"], { from: "user" });
      expect(mockUploadFile).toHaveBeenCalledTimes(1);
      expect(mockUploadFromUrl).not.toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });
});
