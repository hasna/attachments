import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { generatePresignedLink, generateServerLink, getLinkType } from "./links";

// ---------------------------------------------------------------------------
// generatePresignedLink
// NOTE: generatePresignedLink takes an s3 instance directly — no mock.module needed
// ---------------------------------------------------------------------------

const mockPresign = mock(async (_key: string, _expiresIn: number) => "https://presigned.url/key?sig=test");

const fakeS3 = { presign: mockPresign } as any;

afterAll(() => mock.restore());

describe("generatePresignedLink", () => {
  beforeEach(() => {
    mockPresign.mockReset();
    mockPresign.mockImplementation(async () => "https://presigned.url/key?sig=test");
  });

  it("calls s3.presign with the given key and converts ms to seconds", async () => {
    const expiresInMs = 3600_000; // 1 hour in ms
    await generatePresignedLink(fakeS3, "uploads/file.txt", expiresInMs);

    expect(mockPresign).toHaveBeenCalledTimes(1);
    const [key, expiresInSeconds] = mockPresign.mock.calls[0] as [string, number];
    expect(key).toBe("uploads/file.txt");
    expect(expiresInSeconds).toBe(3600);
  });

  it("uses 7-day default when expiresInMs is null", async () => {
    await generatePresignedLink(fakeS3, "uploads/file.txt", null);

    expect(mockPresign).toHaveBeenCalledTimes(1);
    const [, expiresInSeconds] = mockPresign.mock.calls[0] as [string, number];
    expect(expiresInSeconds).toBe(7 * 24 * 60 * 60);
  });

  it("returns the presigned URL from s3.presign", async () => {
    mockPresign.mockImplementation(async () => "https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc");
    const url = await generatePresignedLink(fakeS3, "docs/report.pdf", 86_400_000);
    expect(url).toBe("https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc");
  });

  it("floors the expiry to integer seconds", async () => {
    await generatePresignedLink(fakeS3, "file.bin", 1500); // 1.5 seconds
    const [, expiresInSeconds] = mockPresign.mock.calls[0] as [string, number];
    expect(expiresInSeconds).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// generateServerLink
// ---------------------------------------------------------------------------

describe("generateServerLink", () => {
  it("returns baseUrl/d/id format", () => {
    expect(generateServerLink("att_abc123", "http://localhost:3459")).toBe("http://localhost:3459/d/att_abc123");
  });

  it("works with https base URL", () => {
    expect(generateServerLink("att_xyz789", "https://attachments.example.com")).toBe("https://attachments.example.com/d/att_xyz789");
  });

  it("preserves the full attachment ID", () => {
    const id = "att_AbCdEfGhIj";
    expect(generateServerLink(id, "http://localhost:3459")).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// getLinkType
// ---------------------------------------------------------------------------

describe("getLinkType", () => {
  it("returns 'presigned' when config defaults to presigned", () => {
    const config = {
      s3: { bucket: "b", region: "r", accessKeyId: "k", secretAccessKey: "s" },
      server: { port: 3459, baseUrl: "http://localhost:3459" },
      defaults: { expiry: "7d", linkType: "presigned" as const },
    };
    expect(getLinkType(config)).toBe("presigned");
  });

  it("returns 'server' when config defaults to server", () => {
    const config = {
      s3: { bucket: "b", region: "r", accessKeyId: "k", secretAccessKey: "s" },
      server: { port: 3459, baseUrl: "http://localhost:3459" },
      defaults: { expiry: "7d", linkType: "server" as const },
    };
    expect(getLinkType(config)).toBe("server");
  });
});
