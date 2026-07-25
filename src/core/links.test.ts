import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import {
  AWS_MAX_PRESIGN_SECONDS,
  PresignExpiryError,
  exceedsPresignLimit,
  generatePresignedLink,
  generateServerLink,
  generateShareLink,
  getLinkType,
  resolveDeliverableLinkType,
  resolveLocalShareBaseUrl,
} from "./links";
import { normalizeConfig } from "./config";

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
  it("returns baseUrl/a/token format", () => {
    expect(generateServerLink("share_abc123", "http://localhost:3459")).toBe("http://localhost:3459/a/share_abc123");
  });

  it("works with https base URL", () => {
    expect(generateServerLink("share_xyz789", "https://attachments.example.com")).toBe("https://attachments.example.com/a/share_xyz789");
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

// ---------------------------------------------------------------------------
// D2 — the AWS presign ceiling
// ---------------------------------------------------------------------------

describe("presign expiry ceiling", () => {
  beforeEach(() => {
    mockPresign.mockReset();
    mockPresign.mockImplementation(async () => "https://presigned.url/key?sig=test");
  });

  it("exposes the AWS limit as 604800 seconds", () => {
    expect(AWS_MAX_PRESIGN_SECONDS).toBe(604800);
  });

  it("flags anything longer than 7 days, and 'never', as un-presignable", () => {
    expect(exceedsPresignLimit(7 * 86_400_000)).toBe(false);
    expect(exceedsPresignLimit(7 * 86_400_000 + 1000)).toBe(true);
    expect(exceedsPresignLimit(30 * 86_400_000)).toBe(true);
    expect(exceedsPresignLimit(null)).toBe(true);
  });

  it("throws a typed, actionable error instead of calling S3 past the limit", async () => {
    await expect(generatePresignedLink(fakeS3, "k", 30 * 86_400_000)).rejects.toThrow(PresignExpiryError);
    await expect(generatePresignedLink(fakeS3, "k", 30 * 86_400_000)).rejects.toThrow(/link_type/);
    expect(mockPresign).toHaveBeenCalledTimes(0);
  });

  it("still signs exactly at the limit", async () => {
    await generatePresignedLink(fakeS3, "k", 604_800_000);
    expect(mockPresign.mock.calls[0]![1]).toBe(604800);
  });
});

// ---------------------------------------------------------------------------
// D2 — a single deliverable-link-type decision
// ---------------------------------------------------------------------------

describe("resolveDeliverableLinkType", () => {
  const base = { requested: "presigned" as const, backend: "s3" as const, expiryMs: 86_400_000 };

  it("keeps presigned for a plain, short-lived S3 link", () => {
    expect(resolveDeliverableLinkType(base)).toBe("presigned");
  });

  it("falls back to a server link past the AWS ceiling", () => {
    expect(resolveDeliverableLinkType({ ...base, expiryMs: 30 * 86_400_000 })).toBe("server");
    expect(resolveDeliverableLinkType({ ...base, expiryMs: null })).toBe("server");
  });

  it("falls back to a server link for anything S3 cannot express", () => {
    expect(resolveDeliverableLinkType({ ...base, password: "x" })).toBe("server");
    expect(resolveDeliverableLinkType({ ...base, maxDownloads: 1 })).toBe("server");
    expect(resolveDeliverableLinkType({ ...base, requireEmail: true })).toBe("server");
    expect(resolveDeliverableLinkType({ ...base, encrypt: true })).toBe("server");
    expect(resolveDeliverableLinkType({ ...base, backend: "local" })).toBe("server");
    expect(resolveDeliverableLinkType({ ...base, requested: "server" })).toBe("server");
  });
});

// ---------------------------------------------------------------------------
// D1(b) — a local upload must never mint a link to the remote service
// ---------------------------------------------------------------------------

describe("resolveLocalShareBaseUrl", () => {
  const config = (over: Record<string, unknown> = {}) =>
    normalizeConfig({
      server: { host: "localhost", port: 3459, baseUrl: "https://attachments.example.com", publicPath: "/a" },
      domains: [{ hostname: "attachments.example.com", baseUrl: "https://attachments.example.com", primary: true }],
      ...over,
    });

  it("keeps the configured public base URL when no remote API is configured", () => {
    const resolved = resolveLocalShareBaseUrl(config(), {});
    expect(resolved.baseUrl).toBe("https://attachments.example.com");
    expect(resolved.rejectedBaseUrl).toBeUndefined();
  });

  it("keeps it when the remote API is a different origin", () => {
    const resolved = resolveLocalShareBaseUrl(config(), {
      HASNA_ATTACHMENTS_API_URL: "https://other.example.com",
    });
    expect(resolved.baseUrl).toBe("https://attachments.example.com");
  });

  it("rejects it when that host IS the remote API — the link would 404", () => {
    const resolved = resolveLocalShareBaseUrl(config(), {
      HASNA_ATTACHMENTS_API_URL: "https://attachments.example.com/",
    });
    expect(resolved.rejectedBaseUrl).toBe("https://attachments.example.com");
    expect(resolved.baseUrl).toBe("http://localhost:3459");
  });

  it("prefers a configured internal base URL over loopback", () => {
    const resolved = resolveLocalShareBaseUrl(
      config({ client: { internalBaseUrl: "http://box.tailnet.ts.net:3459", preferInternal: true } }),
      { HASNA_ATTACHMENTS_API_URL: "https://attachments.example.com" },
    );
    expect(resolved.baseUrl).toBe("http://box.tailnet.ts.net:3459");
  });

  it("never produces a share link on the remote host", () => {
    const resolved = resolveLocalShareBaseUrl(config(), {
      HASNA_ATTACHMENTS_API_URL: "https://attachments.example.com",
    });
    expect(generateShareLink("tok", resolved.baseUrl, "/a")).toBe("http://localhost:3459/a/tok");
    expect(generateShareLink("tok", resolved.baseUrl, "/a")).not.toContain("attachments.example.com");
  });
});
