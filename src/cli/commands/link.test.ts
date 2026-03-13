import { describe, it, expect, beforeAll, beforeEach, mock, spyOn, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { setConfigPath, setConfig } from "../../core/config";

// ---------------------------------------------------------------------------
// Mock modules for command-level tests
// ---------------------------------------------------------------------------

type MockAttachment = {
  id: string; filename: string; s3Key: string; bucket: string; size: number;
  contentType: string; link: string | null; expiresAt: number | null; createdAt: number;
};

const mockFindById = mock((_id: string): MockAttachment | null => null);
const mockUpdateLink = mock((_id: string, _link: string, _expiresAt?: number | null) => {});
const mockDbClose = mock(() => {});

mock.module("../../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    constructor(_path?: string) {}
    findById = mockFindById;
    updateLink = mockUpdateLink;
    close = mockDbClose;
    findAll = mock(() => []);
    insert = mock((_att: unknown) => {});
    delete = mock((_id: string) => {});
    deleteExpired = mock(() => 0);
  },
}));

const mockS3Presign = mock(async (_key: string, _expiresIn: number) => "https://s3.example.com/presigned?sig=fresh");

mock.module("../../core/s3", () => ({
  S3Client: class MockS3Client {
    constructor(_cfg: unknown) {}
    presign = mockS3Presign;
    upload = mock(async () => {});
    download = mock(async () => Buffer.from(""));
    delete = mock(async () => {});
  },
}));

const mockGetLinkType = mock(() => "presigned" as const);

// Use real config module pointed at a temp file — avoids module cache pollution
let _linkTestConfigDir: string;
beforeAll(() => {
  _linkTestConfigDir = join(tmpdir(), `link-test-cfg-${Date.now()}`);
  mkdirSync(_linkTestConfigDir, { recursive: true });
  setConfigPath(join(_linkTestConfigDir, "config.json"));
  setConfig({
    s3: { bucket: "test-bucket", region: "us-east-1", accessKeyId: "K", secretAccessKey: "S" },
    server: { port: 3457, baseUrl: "http://localhost:3457" },
    defaults: { expiry: "7d", linkType: "presigned" },
  });
});

const mockGeneratePresignedLink = mock(async (_s3: unknown, _key: string, _expiryMs: number | null) => "https://s3.example.com/presigned?sig=new");
const mockGenerateServerLink = mock((id: string, baseUrl: string) => `${baseUrl}/d/${id}`);

mock.module("../../core/links", () => ({
  generatePresignedLink: mockGeneratePresignedLink,
  generateServerLink: mockGenerateServerLink,
  getLinkType: mockGetLinkType,
}));

// Restore mocks after tests
afterAll(() => {
  mock.restore();
  try { rmSync(_linkTestConfigDir, { recursive: true, force: true }); } catch {}
});

// Import after mocks
const { linkCommand } = await import("./link");
const { generateServerLink } = await import("../../core/links");
const { parseExpiry } = await import("../../core/config"); // real module — no mock.module needed
const { formatExpiry } = await import("../utils");

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeAttachment(overrides: Partial<MockAttachment> = {}): MockAttachment {
  return {
    id: "att_link001",
    filename: "image.jpg",
    s3Key: "uploads/image.jpg",
    bucket: "test-bucket",
    size: 204800,
    contentType: "image/jpeg",
    link: "https://example.com/presigned-link",
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    createdAt: Date.now(),
    ...overrides,
  };
}

function buildLinkCmd() {
  const { Command } = require("commander") as typeof import("commander");
  const program = new Command();
  program.exitOverride();
  program.addCommand(linkCommand());
  return program;
}

function captureOutput() {
  const out: string[] = [];
  const err: string[] = [];
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
    },
  };
}

// ─── generateServerLink ───────────────────────────────────────────────────────

describe("generateServerLink", () => {
  it("returns the expected server link URL", () => {
    expect(generateServerLink("att_abc", "http://localhost:3457")).toBe(
      "http://localhost:3457/d/att_abc"
    );
  });

  it("handles custom base URLs", () => {
    expect(generateServerLink("att_xyz", "https://files.example.com")).toBe(
      "https://files.example.com/d/att_xyz"
    );
  });
});

// ─── parseExpiry ─────────────────────────────────────────────────────────────

describe("parseExpiry via link tests", () => {
  it("converts expiry strings correctly", () => {
    expect(parseExpiry("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseExpiry("24h")).toBe(24 * 60 * 60 * 1000);
    expect(parseExpiry("30m")).toBe(30 * 60 * 1000);
    expect(parseExpiry("never")).toBeNull();
    expect(parseExpiry("invalid")).toBeNull();
  });
});

// ─── human output format ──────────────────────────────────────────────────────

describe("link human output format", () => {
  it("formats expiry correctly for null", () => {
    expect(formatExpiry(null)).toBe("Never");
  });

  it("formats expiry for future timestamp", () => {
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const result = formatExpiry(future);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── JSON output format ───────────────────────────────────────────────────────

describe("link JSON output format", () => {
  it("produces valid JSON with expected fields", () => {
    const id = "att_json";
    const filename = "test.txt";
    const link = "https://example.com/link";
    const expiresAt = Date.now() + 3600000;

    const output = JSON.stringify({ id, filename, link, expiresAt }, null, 2);
    const parsed = JSON.parse(output);

    expect(parsed.id).toBe(id);
    expect(parsed.filename).toBe(filename);
    expect(parsed.link).toBe(link);
    expect(parsed.expiresAt).toBe(expiresAt);
  });
});

// ─── linkCommand tests ────────────────────────────────────────────────────────

describe("linkCommand", () => {
  beforeEach(() => {
    mockFindById.mockReset();
    mockUpdateLink.mockReset();
    mockDbClose.mockReset();
    mockS3Presign.mockReset();
    mockGeneratePresignedLink.mockReset();
    mockGeneratePresignedLink.mockImplementation(async () => "https://s3.example.com/presigned?sig=new");
    mockGetLinkType.mockImplementation(() => "presigned" as const);
  });

  it("shows existing link in human format by default", async () => {
    const att = makeAttachment({ id: "att_show", link: "https://cdn.example.com/file" });
    mockFindById.mockImplementation(() => att);

    const capture = captureOutput();
    try {
      const program = buildLinkCmd();
      await program.parseAsync(["link", "att_show"], { from: "user" });
      const out = capture.out.join("");
      expect(out).toContain("att_show");
      expect(out).toContain("https://cdn.example.com/file");
    } finally {
      capture.restore();
    }
  });

  it("outputs JSON format when --format json is passed", async () => {
    const att = makeAttachment({ id: "att_jsonout" });
    mockFindById.mockImplementation(() => att);

    const capture = captureOutput();
    try {
      const program = buildLinkCmd();
      await program.parseAsync(["link", "att_jsonout", "--format", "json"], { from: "user" });
      const parsed = JSON.parse(capture.out.join(""));
      expect(parsed.id).toBe("att_jsonout");
    } finally {
      capture.restore();
    }
  });

  it("exits with error for invalid format", async () => {
    const att = makeAttachment();
    mockFindById.mockImplementation(() => att);

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildLinkCmd();
      await expect(
        program.parseAsync(["link", att.id, "--format", "invalid"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("--format must be one of");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with error when attachment not found", async () => {
    mockFindById.mockImplementation(() => null);

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildLinkCmd();
      await expect(
        program.parseAsync(["link", "att_missing"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("not found");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("regenerates presigned link when --regenerate is passed", async () => {
    const att = makeAttachment({ id: "att_regen", s3Key: "uploads/image.jpg" });
    mockFindById.mockImplementation(() => att);

    const capture = captureOutput();
    try {
      const program = buildLinkCmd();
      await program.parseAsync(["link", "att_regen", "--regenerate", "--expiry", "24h"], { from: "user" });
      expect(mockGeneratePresignedLink).toHaveBeenCalledTimes(1);
      expect(mockUpdateLink).toHaveBeenCalledTimes(1);
    } finally {
      capture.restore();
    }
  });

  it("uses server link type when getLinkType returns server", async () => {
    const att = makeAttachment({ id: "att_server" });
    mockFindById.mockImplementation(() => att);
    mockGetLinkType.mockImplementation(() => "server" as const);
    mockGenerateServerLink.mockReset();
    mockGenerateServerLink.mockImplementation((id: string, baseUrl: string) => `${baseUrl}/d/${id}`);

    const capture = captureOutput();
    try {
      const program = buildLinkCmd();
      await program.parseAsync(["link", "att_server", "--regenerate"], { from: "user" });
      expect(mockGenerateServerLink).toHaveBeenCalled();
      expect(mockGeneratePresignedLink).not.toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });

  it("regenerates with default expiry when --expiry not specified", async () => {
    const att = makeAttachment({ id: "att_default_expiry" });
    mockFindById.mockImplementation(() => att);

    const capture = captureOutput();
    try {
      const program = buildLinkCmd();
      await program.parseAsync(["link", "att_default_expiry", "--regenerate"], { from: "user" });
      expect(mockGeneratePresignedLink).toHaveBeenCalledTimes(1);
    } finally {
      capture.restore();
    }
  });

  it("exits with error for invalid expiry format", async () => {
    const att = makeAttachment({ id: "att_bad_expiry" });
    mockFindById.mockImplementation(() => att);
    // Real parseExpiry already returns null for "badformat" (doesn't match regex)

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildLinkCmd();
      await expect(
        program.parseAsync(["link", "att_bad_expiry", "--regenerate", "--expiry", "badformat"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("Invalid expiry format");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("shows (no link) in human format when link is null", async () => {
    const att = makeAttachment({ id: "att_nolink", link: null });
    mockFindById.mockImplementation(() => att);

    const capture = captureOutput();
    try {
      const program = buildLinkCmd();
      await program.parseAsync(["link", "att_nolink"], { from: "user" });
      expect(capture.out.join("")).toContain("(no link)");
    } finally {
      capture.restore();
    }
  });

  it("outputs just the URL when --brief is passed", async () => {
    const att = makeAttachment({ id: "att_brief", link: "https://cdn.example.com/file" });
    mockFindById.mockImplementation(() => att);

    const capture = captureOutput();
    try {
      const program = buildLinkCmd();
      await program.parseAsync(["link", "att_brief", "--brief"], { from: "user" });
      const combined = capture.out.join("");
      expect(combined).toBe("https://cdn.example.com/file\n");
    } finally {
      capture.restore();
    }
  });

  it("outputs 'no link' when --brief is passed and link is null", async () => {
    const att = makeAttachment({ id: "att_brief_nolink", link: null });
    mockFindById.mockImplementation(() => att);

    const capture = captureOutput();
    try {
      const program = buildLinkCmd();
      await program.parseAsync(["link", "att_brief_nolink", "--brief"], { from: "user" });
      const combined = capture.out.join("");
      expect(combined).toBe("no link\n");
    } finally {
      capture.restore();
    }
  });

  it("calls db.close in all cases", async () => {
    const att = makeAttachment();
    mockFindById.mockImplementation(() => att);

    const capture = captureOutput();
    try {
      const program = buildLinkCmd();
      await program.parseAsync(["link", att.id], { from: "user" });
      expect(mockDbClose).toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });
});
