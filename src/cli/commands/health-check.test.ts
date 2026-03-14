import { describe, it, expect, beforeAll, beforeEach, mock, spyOn, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { setConfigPath, setConfig } from "../../core/config";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

type MockAttachment = {
  id: string;
  filename: string;
  s3Key: string;
  bucket: string;
  size: number;
  contentType: string;
  link: string | null;
  tag: string | null;
  expiresAt: number | null;
  createdAt: number;
};

const mockFindAll = mock((_opts?: unknown) => [] as MockAttachment[]);
const mockUpdateLink = mock((_id: string, _link: string, _expiresAt?: number | null) => {});
const mockDbClose = mock(() => {});

mock.module("../../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    constructor(_path?: string) {}
    findAll = mockFindAll;
    updateLink = mockUpdateLink;
    close = mockDbClose;
    findById = mock((_id: string) => null);
    insert = mock((_att: unknown) => {});
    delete = mock((_id: string) => {});
    deleteExpired = mock(() => 0);
  },
}));

// ---------------------------------------------------------------------------
// Mock S3
// ---------------------------------------------------------------------------

const mockPresign = mock(async (_key: string, _secs: number) => "https://s3.example.com/new-presigned");

mock.module("../../core/s3", () => ({
  S3Client: class MockS3Client {
    constructor(_cfg: unknown) {}
    presign = mockPresign;
    presignPut = mock(async () => "https://put");
    upload = mock(async () => {});
    download = mock(async () => Buffer.from(""));
    delete = mock(async () => {});
  },
}));

// ---------------------------------------------------------------------------
// Mock fetch for HEAD checks
// ---------------------------------------------------------------------------

let fetchMock = mock(async (_url: string, _opts?: unknown): Promise<Response> => {
  return new Response(null, { status: 200 });
});

// Override global fetch
(globalThis as Record<string, unknown>).fetch = fetchMock;

// ---------------------------------------------------------------------------
// Test config setup
// ---------------------------------------------------------------------------

let _testConfigDir: string;
beforeAll(() => {
  _testConfigDir = join(tmpdir(), `health-check-test-cfg-${Date.now()}`);
  mkdirSync(_testConfigDir, { recursive: true });
  setConfigPath(join(_testConfigDir, "config.json"));
  setConfig({
    s3: { bucket: "test-bucket", region: "us-east-1", accessKeyId: "K", secretAccessKey: "S" },
    server: { port: 3459, baseUrl: "http://localhost:3459" },
    defaults: { expiry: "7d", linkType: "presigned" },
  });
});

afterAll(() => {
  mock.restore();
  try { rmSync(_testConfigDir, { recursive: true, force: true }); } catch {}
});

// Import after mocks
const { checkAttachment, isLinkAlive, runHealthCheck, registerHealthCheck } = await import("./health-check");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAttachment(overrides: Partial<MockAttachment> = {}): MockAttachment {
  return {
    id: "att_test001",
    filename: "report.pdf",
    s3Key: "attachments/2024-01-01/att_test001/report.pdf",
    bucket: "test-bucket",
    size: 1024 * 10,
    contentType: "application/pdf",
    link: "https://s3.example.com/link",
    tag: null,
    expiresAt: Date.now() + 1000 * 60 * 60 * 24, // 24h from now
    createdAt: Date.now() - 1000 * 60 * 60,
    ...overrides,
  };
}

function buildHealthCheckCmd() {
  const { Command } = require("commander") as typeof import("commander");
  const program = new Command();
  program.exitOverride();
  registerHealthCheck(program);
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

// ---------------------------------------------------------------------------
// isLinkAlive tests
// ---------------------------------------------------------------------------

describe("isLinkAlive", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
  });

  it("returns true for 200 OK", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    expect(await isLinkAlive("https://example.com/file")).toBe(true);
  });

  it("returns false for 404", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    expect(await isLinkAlive("https://example.com/dead")).toBe(false);
  });

  it("returns false for network error", async () => {
    fetchMock.mockImplementation(async () => { throw new Error("network error"); });
    expect(await isLinkAlive("https://example.com/unreachable")).toBe(false);
  });

  it("returns true for 301 redirect", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 301 }));
    expect(await isLinkAlive("https://example.com/redirect")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkAttachment tests
// ---------------------------------------------------------------------------

describe("checkAttachment", () => {
  const now = Date.now();

  beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
  });

  it("returns 'no-link' when attachment has no link", async () => {
    const att = makeAttachment({ link: null });
    const result = await checkAttachment(att as ReturnType<typeof makeAttachment>, now);
    expect(result.status).toBe("no-link");
    expect(result.id).toBe(att.id);
  });

  it("returns 'expired' when expiresAt is in the past", async () => {
    const att = makeAttachment({ expiresAt: now - 1000 * 60 * 60 * 2 }); // 2h ago
    const result = await checkAttachment(att as ReturnType<typeof makeAttachment>, now);
    expect(result.status).toBe("expired");
    expect(result.expiredAgoMs).toBeGreaterThan(0);
  });

  it("returns 'healthy' when link is alive and not expired", async () => {
    const att = makeAttachment({ expiresAt: now + 1000 * 60 * 60 }); // 1h future
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    const result = await checkAttachment(att as ReturnType<typeof makeAttachment>, now);
    expect(result.status).toBe("healthy");
  });

  it("returns 'dead' when link returns 404", async () => {
    const att = makeAttachment({ expiresAt: now + 1000 * 60 * 60 });
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    const result = await checkAttachment(att as ReturnType<typeof makeAttachment>, now);
    expect(result.status).toBe("dead");
  });

  it("returns 'healthy' for attachment with null expiresAt (never expires) and live link", async () => {
    const att = makeAttachment({ expiresAt: null });
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    const result = await checkAttachment(att as ReturnType<typeof makeAttachment>, now);
    expect(result.status).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// runHealthCheck tests
// ---------------------------------------------------------------------------

describe("runHealthCheck", () => {
  beforeEach(() => {
    mockFindAll.mockReset();
    mockUpdateLink.mockReset();
    mockDbClose.mockReset();
    mockPresign.mockReset();
    mockPresign.mockImplementation(async () => "https://s3.example.com/new-presigned");
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
  });

  it("returns all healthy when links are alive", async () => {
    const now = Date.now();
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_1", expiresAt: now + 1000 * 60 * 60 }),
      makeAttachment({ id: "att_2", expiresAt: now + 1000 * 60 * 60 }),
    ]);
    const summary = await runHealthCheck();
    expect(summary.healthy).toBe(2);
    expect(summary.expired).toBe(0);
    expect(summary.dead).toBe(0);
    expect(summary.total).toBe(2);
  });

  it("counts expired attachments correctly", async () => {
    const now = Date.now();
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_exp", expiresAt: now - 5000 }),
      makeAttachment({ id: "att_ok", expiresAt: now + 100000 }),
    ]);
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    const summary = await runHealthCheck();
    expect(summary.expired).toBe(1);
    expect(summary.healthy).toBe(1);
  });

  it("counts dead links correctly", async () => {
    const now = Date.now();
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_dead", expiresAt: now + 100000, link: "https://dead.example.com/file" }),
    ]);
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    const summary = await runHealthCheck();
    expect(summary.dead).toBe(1);
    expect(summary.healthy).toBe(0);
  });

  it("counts no-link attachments", async () => {
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_nolink", link: null }),
    ]);
    const summary = await runHealthCheck();
    expect(summary.noLink).toBe(1);
    expect(summary.healthy).toBe(0);
  });

  it("regenerates expired links when fix=true", async () => {
    const now = Date.now();
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_expired", expiresAt: now - 5000 }),
    ]);
    const summary = await runHealthCheck({ fix: true });
    expect(summary.fixed).toBe(1);
    expect(mockUpdateLink).toHaveBeenCalledTimes(1);
    expect(mockUpdateLink).toHaveBeenCalledWith(
      "att_expired",
      expect.stringContaining("https://"),
      expect.any(Number)
    );
  });

  it("does not regenerate links when fix=false", async () => {
    const now = Date.now();
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_expired2", expiresAt: now - 5000 }),
    ]);
    const summary = await runHealthCheck({ fix: false });
    expect(summary.fixed).toBe(0);
    expect(mockUpdateLink).not.toHaveBeenCalled();
  });

  it("handles mixed statuses", async () => {
    const now = Date.now();
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_h", expiresAt: now + 100000, link: "https://ok.com/f1" }),
      makeAttachment({ id: "att_e", expiresAt: now - 1000, link: "https://expired.com/f2" }),
      makeAttachment({ id: "att_d", expiresAt: now + 100000, link: "https://dead.com/f3" }),
      makeAttachment({ id: "att_n", link: null }),
    ]);
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("dead")) return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    });
    const summary = await runHealthCheck();
    expect(summary.healthy).toBe(1);
    expect(summary.expired).toBe(1);
    expect(summary.dead).toBe(1);
    expect(summary.noLink).toBe(1);
    expect(summary.total).toBe(4);
  });

  it("calls db.close", async () => {
    mockFindAll.mockImplementation(() => []);
    await runHealthCheck();
    expect(mockDbClose).toHaveBeenCalled();
  });

  it("returns empty summary when no attachments exist", async () => {
    mockFindAll.mockImplementation(() => []);
    const summary = await runHealthCheck();
    expect(summary.total).toBe(0);
    expect(summary.healthy).toBe(0);
    expect(summary.results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CLI command tests
// ---------------------------------------------------------------------------

describe("health-check command", () => {
  beforeEach(() => {
    mockFindAll.mockReset();
    mockUpdateLink.mockReset();
    mockDbClose.mockReset();
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
  });

  it("prints compact summary with all healthy", async () => {
    const now = Date.now();
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_h1", expiresAt: now + 100000 }),
      makeAttachment({ id: "att_h2", expiresAt: now + 200000 }),
    ]);

    const capture = captureOutput();
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });

    try {
      const program = buildHealthCheckCmd();
      await program.parseAsync(["health-check"], { from: "user" });
      const output = capture.out.join("");
      expect(output).toContain("2 healthy");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("outputs JSON when --format json", async () => {
    mockFindAll.mockImplementation(() => []);

    const capture = captureOutput();
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });

    try {
      const program = buildHealthCheckCmd();
      await program.parseAsync(["health-check", "--format", "json"], { from: "user" });
      const output = capture.out.join("");
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("healthy");
      expect(parsed).toHaveProperty("expired");
      expect(parsed).toHaveProperty("dead");
      expect(parsed).toHaveProperty("total");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with code 1 when there are expired attachments", async () => {
    const now = Date.now();
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_exp", expiresAt: now - 5000 }),
    ]);

    const capture = captureOutput();
    let exitCode: number | undefined;
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    });

    try {
      const program = buildHealthCheckCmd();
      await program.parseAsync(["health-check"], { from: "user" }).catch(() => {});
      expect(exitCode).toBe(1);
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with code 1 when there are dead links", async () => {
    const now = Date.now();
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_dead", expiresAt: now + 100000, link: "https://dead.example.com/f" }),
    ]);
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));

    const capture = captureOutput();
    let exitCode: number | undefined;
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    });

    try {
      const program = buildHealthCheckCmd();
      await program.parseAsync(["health-check"], { from: "user" }).catch(() => {});
      expect(exitCode).toBe(1);
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("includes Expired and Dead lines in compact output", async () => {
    const now = Date.now();
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_exp_c", filename: "expired.pdf", expiresAt: now - 7200000 }),
      makeAttachment({ id: "att_dead_c", filename: "dead.zip", expiresAt: now + 100000, link: "https://dead.example.com/z" }),
    ]);
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("dead")) return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    });

    const capture = captureOutput();
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });

    try {
      const program = buildHealthCheckCmd();
      await program.parseAsync(["health-check"], { from: "user" }).catch(() => {});
      const output = capture.out.join("");
      expect(output).toContain("Expired:");
      expect(output).toContain("Dead:");
      expect(output).toContain("expired.pdf");
      expect(output).toContain("dead.zip");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("passes --fix flag to runHealthCheck and notes regenerated links", async () => {
    const now = Date.now();
    mockFindAll.mockImplementation(() => [
      makeAttachment({ id: "att_fix_test", expiresAt: now - 5000 }),
    ]);

    const capture = captureOutput();
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });

    try {
      const program = buildHealthCheckCmd();
      await program.parseAsync(["health-check", "--fix"], { from: "user" }).catch(() => {});
      expect(mockUpdateLink).toHaveBeenCalled();
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });
});
