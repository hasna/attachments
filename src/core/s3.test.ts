import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

// --- Mock setup ---
// We need to intercept the AWS SDK calls. We do this by mocking the module
// before importing S3Client so that the constructor picks up the mock.

const mockSend = mock(async (_cmd: unknown) => ({}));

mock.module("@aws-sdk/client-s3", () => {
  return {
    S3Client: class MockAWSS3Client {
      send = mockSend;
    },
    PutObjectCommand: class PutObjectCommand {
      constructor(public input: Record<string, unknown>) {}
    },
    GetObjectCommand: class GetObjectCommand {
      constructor(public input: Record<string, unknown>) {}
    },
    DeleteObjectCommand: class DeleteObjectCommand {
      constructor(public input: Record<string, unknown>) {}
    },
    CreateMultipartUploadCommand: class CreateMultipartUploadCommand {
      constructor(public input: Record<string, unknown>) {}
    },
    UploadPartCommand: class UploadPartCommand {
      constructor(public input: Record<string, unknown>) {}
    },
    CompleteMultipartUploadCommand: class CompleteMultipartUploadCommand {
      constructor(public input: Record<string, unknown>) {}
    },
  };
});

const mockGetSignedUrl = mock(async (_client: unknown, _cmd: unknown, _opts: unknown) => "https://presigned.url/test-key?sig=abc");

mock.module("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

// Import after mocks are registered
const { S3Client } = await import("./s3");

// Restore all mocks after this file's tests complete so they don't leak into other test files
afterAll(() => mock.restore());

// --- Config ---
const baseConfig = {
  bucket: "test-bucket",
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

function makeClient(extra?: Partial<typeof baseConfig & { endpoint?: string }>) {
  return new S3Client({ ...baseConfig, ...extra });
}

// --- Tests ---

describe("S3Client constructor", () => {
  it("creates a client without endpoint", () => {
    expect(() => makeClient()).not.toThrow();
  });

  it("creates a client with a custom endpoint", () => {
    expect(() => makeClient({ endpoint: "http://localhost:4566" })).not.toThrow();
  });
});

describe("S3Client.upload (small file — single PutObject)", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockImplementation(async () => ({}));
  });

  it("calls PutObjectCommand for files <= 5 MB", async () => {
    const client = makeClient();
    const body = Buffer.alloc(1024, "a"); // 1 KB
    await client.upload("files/small.txt", body, "text/plain");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [cmd] = mockSend.mock.calls[0] as [{ input: Record<string, unknown>; constructor: { name: string } }];
    expect(cmd.constructor.name).toBe("PutObjectCommand");
    expect(cmd.input["Bucket"]).toBe("test-bucket");
    expect(cmd.input["Key"]).toBe("files/small.txt");
    expect(cmd.input["ContentType"]).toBe("text/plain");
    expect(cmd.input["Body"]).toBe(body);
  });

  it("calls PutObjectCommand for a Uint8Array body", async () => {
    const client = makeClient();
    const body = new Uint8Array(512);
    await client.upload("files/tiny.bin", body, "application/octet-stream");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [cmd] = mockSend.mock.calls[0] as [{ input: Record<string, unknown>; constructor: { name: string } }];
    expect(cmd.constructor.name).toBe("PutObjectCommand");
  });

  it("uses exactly the bucket from config", async () => {
    const client = makeClient({ bucket: "my-special-bucket" });
    await client.upload("k", Buffer.from("hi"), "text/plain");

    const [cmd] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(cmd.input["Bucket"]).toBe("my-special-bucket");
  });
});

describe("S3Client.upload (large file — multipart)", () => {
  const FIVE_MB = 5 * 1024 * 1024;

  beforeEach(() => {
    mockSend.mockReset();
    // Provide ordered responses: CreateMultipartUpload → UploadPart(s) → CompleteMultipartUpload
    let callCount = 0;
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      callCount++;
      if (cmd.constructor.name === "CreateMultipartUploadCommand") {
        return { UploadId: "upload-id-123" };
      }
      if (cmd.constructor.name === "UploadPartCommand") {
        return { ETag: `"etag-${callCount}"` };
      }
      if (cmd.constructor.name === "CompleteMultipartUploadCommand") {
        return {};
      }
      return {};
    });
  });

  it("uses multipart for a 6 MB file (2 parts)", async () => {
    const client = makeClient();
    const body = Buffer.alloc(FIVE_MB + 512 * 1024); // ~5.5 MB
    await client.upload("files/large.bin", body, "application/octet-stream");

    // CreateMultipartUpload + 2 × UploadPart + CompleteMultipartUpload = 4 calls
    expect(mockSend).toHaveBeenCalledTimes(4);

    const names = (mockSend.mock.calls as [{ constructor: { name: string } }][]).map(
      ([cmd]) => cmd.constructor.name
    );
    expect(names[0]).toBe("CreateMultipartUploadCommand");
    expect(names[1]).toBe("UploadPartCommand");
    expect(names[2]).toBe("UploadPartCommand");
    expect(names[3]).toBe("CompleteMultipartUploadCommand");
  });

  it("passes UploadId and part numbers correctly", async () => {
    const client = makeClient();
    const body = Buffer.alloc(FIVE_MB + 1024); // just over 5 MB
    await client.upload("files/video.mp4", body, "video/mp4");

    const uploadPartCalls = (mockSend.mock.calls as [{ constructor: { name: string }; input: Record<string, unknown> }][]).filter(
      ([cmd]) => cmd.constructor.name === "UploadPartCommand"
    );
    expect(uploadPartCalls.length).toBe(2);

    const [firstPart] = uploadPartCalls[0]!;
    expect(firstPart.input["UploadId"]).toBe("upload-id-123");
    expect(firstPart.input["PartNumber"]).toBe(1);
    expect(firstPart.input["Bucket"]).toBe("test-bucket");
    expect(firstPart.input["Key"]).toBe("files/video.mp4");

    const [secondPart] = uploadPartCalls[1]!;
    expect(secondPart.input["PartNumber"]).toBe(2);
  });

  it("passes collected ETags to CompleteMultipartUpload", async () => {
    // Re-set known ETags
    let partCallIdx = 0;
    mockSend.mockReset();
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "CreateMultipartUploadCommand") return { UploadId: "uid-abc" };
      if (cmd.constructor.name === "UploadPartCommand") {
        partCallIdx++;
        return { ETag: `"etag-part-${partCallIdx}"` };
      }
      return {};
    });

    const client = makeClient();
    const body = Buffer.alloc(FIVE_MB + 1024);
    await client.upload("files/big.bin", body, "application/octet-stream");

    const completeCalls = (mockSend.mock.calls as [{ constructor: { name: string }; input: Record<string, unknown> }][]).filter(
      ([cmd]) => cmd.constructor.name === "CompleteMultipartUploadCommand"
    );
    expect(completeCalls.length).toBe(1);

    const [completeCmd] = completeCalls[0]!;
    const multipart = completeCmd.input["MultipartUpload"] as { Parts: { ETag: string; PartNumber: number }[] };
    expect(multipart.Parts).toHaveLength(2);
    expect(multipart.Parts[0]?.ETag).toBe('"etag-part-1"');
    expect(multipart.Parts[0]?.PartNumber).toBe(1);
    expect(multipart.Parts[1]?.ETag).toBe('"etag-part-2"');
    expect(multipart.Parts[1]?.PartNumber).toBe(2);
  });

  it("throws if CreateMultipartUpload returns no UploadId", async () => {
    mockSend.mockReset();
    mockSend.mockImplementation(async () => ({})); // no UploadId

    const client = makeClient();
    const body = Buffer.alloc(FIVE_MB + 1024);
    await expect(client.upload("k", body, "application/octet-stream")).rejects.toThrow(
      "Failed to initiate multipart upload"
    );
  });

  it("throws if UploadPart returns no ETag", async () => {
    mockSend.mockReset();
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "CreateMultipartUploadCommand") return { UploadId: "uid-xyz" };
      if (cmd.constructor.name === "UploadPartCommand") return {}; // no ETag
      return {};
    });

    const client = makeClient();
    const body = Buffer.alloc(FIVE_MB + 1024);
    await expect(client.upload("k", body, "application/octet-stream")).rejects.toThrow(
      "Missing ETag for part 1"
    );
  });
});

describe("S3Client.download", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("returns a Buffer with the object contents", async () => {
    const content = Buffer.from("hello world");
    mockSend.mockImplementation(async () => ({
      Body: {
        transformToByteArray: async () => new Uint8Array(content),
      },
    }));

    const client = makeClient();
    const result = await client.download("files/hello.txt");

    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe("hello world");
  });

  it("calls GetObjectCommand with correct bucket and key", async () => {
    mockSend.mockImplementation(async () => ({
      Body: { transformToByteArray: async () => new Uint8Array(0) },
    }));

    const client = makeClient();
    await client.download("path/to/file.pdf");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [cmd] = mockSend.mock.calls[0] as [{ constructor: { name: string }; input: Record<string, unknown> }];
    expect(cmd.constructor.name).toBe("GetObjectCommand");
    expect(cmd.input["Bucket"]).toBe("test-bucket");
    expect(cmd.input["Key"]).toBe("path/to/file.pdf");
  });

  it("throws when Body is missing", async () => {
    mockSend.mockImplementation(async () => ({ Body: undefined }));

    const client = makeClient();
    await expect(client.download("missing.txt")).rejects.toThrow(
      "No body returned for key: missing.txt"
    );
  });

  it("returns empty Buffer for empty object", async () => {
    mockSend.mockImplementation(async () => ({
      Body: { transformToByteArray: async () => new Uint8Array(0) },
    }));

    const client = makeClient();
    const result = await client.download("empty.bin");
    expect(result.length).toBe(0);
  });
});

describe("S3Client.delete", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockImplementation(async () => ({}));
  });

  it("calls DeleteObjectCommand with correct params", async () => {
    const client = makeClient();
    await client.delete("files/to-delete.txt");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [cmd] = mockSend.mock.calls[0] as [{ constructor: { name: string }; input: Record<string, unknown> }];
    expect(cmd.constructor.name).toBe("DeleteObjectCommand");
    expect(cmd.input["Bucket"]).toBe("test-bucket");
    expect(cmd.input["Key"]).toBe("files/to-delete.txt");
  });

  it("resolves without error on successful delete", async () => {
    const client = makeClient();
    await expect(client.delete("any-key")).resolves.toBeUndefined();
  });

  it("propagates errors from the SDK", async () => {
    mockSend.mockImplementation(async () => {
      throw new Error("NoSuchKey");
    });

    const client = makeClient();
    await expect(client.delete("ghost-key")).rejects.toThrow("NoSuchKey");
  });
});

describe("S3Client.presign", () => {
  beforeEach(() => {
    mockGetSignedUrl.mockReset();
    mockGetSignedUrl.mockImplementation(
      async (_c: unknown, _cmd: unknown, _opts: unknown) => "https://presigned.url/key?sig=abc"
    );
  });

  it("returns the presigned URL from getSignedUrl", async () => {
    const client = makeClient();
    const url = await client.presign("files/secret.pdf", 3600);

    expect(url).toBe("https://presigned.url/key?sig=abc");
  });

  it("passes expiresIn to getSignedUrl", async () => {
    const client = makeClient();
    await client.presign("k", 7200);

    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    const [, , opts] = mockGetSignedUrl.mock.calls[0] as [unknown, unknown, { expiresIn: number }];
    expect(opts.expiresIn).toBe(7200);
  });

  it("passes a GetObjectCommand to getSignedUrl", async () => {
    const client = makeClient();
    await client.presign("secret/file.zip", 300);

    const [, cmd] = mockGetSignedUrl.mock.calls[0] as [unknown, { constructor: { name: string }; input: Record<string, unknown> }, unknown];
    expect(cmd.constructor.name).toBe("GetObjectCommand");
    expect(cmd.input["Bucket"]).toBe("test-bucket");
    expect(cmd.input["Key"]).toBe("secret/file.zip");
  });

  it("propagates errors from getSignedUrl", async () => {
    mockGetSignedUrl.mockImplementation(async () => {
      throw new Error("SignatureExpired");
    });

    const client = makeClient();
    await expect(client.presign("k", 10)).rejects.toThrow("SignatureExpired");
  });
});
