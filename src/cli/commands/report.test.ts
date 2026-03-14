import { describe, it, expect, beforeEach, mock, spyOn, afterAll } from "bun:test";
import type { Attachment } from "../../core/db";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

const mockFindAll = mock((_opts?: unknown) => [] as Attachment[]);
const mockDbClose = mock(() => {});

mock.module("../../core/db", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    constructor(_path?: string) {}
    findAll = mockFindAll;
    close = mockDbClose;
    findById = mock((_id: string) => null);
    insert = mock((_att: unknown) => {});
    delete = mock((_id: string) => {});
    updateLink = mock((_id: string, _link: string) => {});
    deleteExpired = mock(() => 0);
  },
}));

afterAll(() => mock.restore());

// Import under test AFTER mock registration
const { computeReport, formatCompact, formatMarkdown, formatJson, registerReport } =
  await import("./report");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed "now" for deterministic tests
const DAY = 24 * 60 * 60 * 1000;

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att_default",
    filename: "file.txt",
    s3Key: "uploads/file.txt",
    bucket: "test-bucket",
    size: 1024,
    contentType: "text/plain",
    link: null,
    tag: null,
    expiresAt: null,
    createdAt: NOW - DAY, // 1 day ago by default
    ...overrides,
  };
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
    get stdout() { return out.join(""); },
    get stderr() { return err.join(""); },
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

function buildReportCmd() {
  const { Command } = require("commander") as typeof import("commander");
  const program = new Command();
  program.exitOverride();
  registerReport(program);
  return program;
}

// ---------------------------------------------------------------------------
// computeReport unit tests
// ---------------------------------------------------------------------------

describe("computeReport", () => {
  it("counts uploads in period correctly", () => {
    const sinceMs = NOW - 7 * DAY;
    const recent = makeAttachment({ id: "att_recent", createdAt: NOW - 2 * DAY });
    const old = makeAttachment({ id: "att_old", createdAt: NOW - 10 * DAY });
    const report = computeReport([recent, old], sinceMs, NOW);
    expect(report.uploads.count).toBe(1);
  });

  it("sums upload sizes for period only", () => {
    const sinceMs = NOW - 7 * DAY;
    const recent = makeAttachment({ createdAt: NOW - DAY, size: 2000 });
    const old = makeAttachment({ createdAt: NOW - 10 * DAY, size: 5000 });
    const report = computeReport([recent, old], sinceMs, NOW);
    expect(report.uploads.totalSize).toBe(2000);
  });

  it("counts total across all attachments", () => {
    const sinceMs = NOW - 7 * DAY;
    const items = [
      makeAttachment({ id: "a1", createdAt: NOW - DAY }),
      makeAttachment({ id: "a2", createdAt: NOW - 10 * DAY }),
      makeAttachment({ id: "a3", createdAt: NOW - 20 * DAY }),
    ];
    const report = computeReport(items, sinceMs, NOW);
    expect(report.total.count).toBe(3);
  });

  it("sums total size across all attachments", () => {
    const sinceMs = NOW - 7 * DAY;
    const items = [
      makeAttachment({ size: 1000 }),
      makeAttachment({ size: 2000 }),
    ];
    const report = computeReport(items, sinceMs, NOW);
    expect(report.total.totalSize).toBe(3000);
  });

  it("counts expiring soon (within 24h, not yet expired)", () => {
    const sinceMs = NOW - 7 * DAY;
    const expiringSoon = makeAttachment({ expiresAt: NOW + 12 * 60 * 60 * 1000 }); // 12h
    const expiresLater = makeAttachment({ expiresAt: NOW + 2 * DAY }); // 2 days
    const alreadyExpired = makeAttachment({ expiresAt: NOW - 60 * 1000 }); // 1 min ago
    const report = computeReport(
      [expiringSoon, expiresLater, alreadyExpired],
      sinceMs,
      NOW
    );
    expect(report.expiringSoon).toBe(1);
  });

  it("counts already expired attachments", () => {
    const sinceMs = NOW - 7 * DAY;
    const expired1 = makeAttachment({ id: "e1", expiresAt: NOW - DAY });
    const expired2 = makeAttachment({ id: "e2", expiresAt: NOW - 2 * DAY });
    const active = makeAttachment({ id: "a1", expiresAt: null });
    const report = computeReport([expired1, expired2, active], sinceMs, NOW);
    expect(report.alreadyExpired).toBe(2);
  });

  it("computes top tags sorted by count", () => {
    const sinceMs = NOW - 7 * DAY;
    const items = [
      makeAttachment({ tag: "project:alpha" }),
      makeAttachment({ tag: "project:alpha" }),
      makeAttachment({ tag: "project:alpha" }),
      makeAttachment({ tag: "session:xyz" }),
      makeAttachment({ tag: "session:xyz" }),
      makeAttachment({ tag: "task:001" }),
    ];
    const report = computeReport(items, sinceMs, NOW);
    expect(report.topTags[0].tag).toBe("project:alpha");
    expect(report.topTags[0].count).toBe(3);
    expect(report.topTags[1].tag).toBe("session:xyz");
    expect(report.topTags[1].count).toBe(2);
    expect(report.topTags[2].tag).toBe("task:001");
  });

  it("caps top tags at 5", () => {
    const sinceMs = NOW - 7 * DAY;
    const tags = ["t1", "t2", "t3", "t4", "t5", "t6"];
    const items = tags.map((tag, i) =>
      makeAttachment({ id: `att_${i}`, tag })
    );
    const report = computeReport(items, sinceMs, NOW);
    expect(report.topTags.length).toBeLessThanOrEqual(5);
  });

  it("returns top 3 largest uploads", () => {
    const sinceMs = NOW - 7 * DAY;
    const items = [
      makeAttachment({ id: "small", size: 100 }),
      makeAttachment({ id: "medium", size: 5000 }),
      makeAttachment({ id: "large", size: 100_000 }),
      makeAttachment({ id: "tiny", size: 50 }),
    ];
    const report = computeReport(items, sinceMs, NOW);
    expect(report.largestUploads.length).toBe(3);
    expect(report.largestUploads[0].id).toBe("large");
    expect(report.largestUploads[1].id).toBe("medium");
    expect(report.largestUploads[2].id).toBe("small");
  });

  it("handles empty attachment list", () => {
    const report = computeReport([], NOW - 7 * DAY, NOW);
    expect(report.uploads.count).toBe(0);
    expect(report.total.count).toBe(0);
    expect(report.expiringSoon).toBe(0);
    expect(report.alreadyExpired).toBe(0);
    expect(report.topTags).toEqual([]);
    expect(report.largestUploads).toEqual([]);
  });

  it("stores period.days correctly", () => {
    const report = computeReport([], NOW - 7 * DAY, NOW);
    expect(report.period.days).toBe(7);
  });

  it("excludes attachments with null tag from topTags", () => {
    const items = [
      makeAttachment({ tag: null }),
      makeAttachment({ tag: null }),
      makeAttachment({ tag: "work" }),
    ];
    const report = computeReport(items, NOW - 7 * DAY, NOW);
    expect(report.topTags.length).toBe(1);
    expect(report.topTags[0].tag).toBe("work");
  });
});

// ---------------------------------------------------------------------------
// formatCompact
// ---------------------------------------------------------------------------

describe("formatCompact", () => {
  it("includes upload count and size", () => {
    const report = computeReport(
      [makeAttachment({ size: 1024 * 1024, createdAt: NOW - DAY })],
      NOW - 7 * DAY,
      NOW
    );
    const out = formatCompact(report);
    expect(out).toContain("1 uploads");
    expect(out).toContain("MB");
  });

  it("includes total stored", () => {
    const report = computeReport(
      [makeAttachment({ size: 2048 })],
      NOW - 7 * DAY,
      NOW
    );
    const out = formatCompact(report);
    expect(out).toContain("Total stored:");
    expect(out).toContain("1 files");
  });

  it("includes expiry info", () => {
    const items = [
      makeAttachment({ expiresAt: NOW + 60 * 60 * 1000 }), // 1h → expiring soon
      makeAttachment({ expiresAt: NOW - 1000 }), // already expired
    ];
    const report = computeReport(items, NOW - 7 * DAY, NOW);
    const out = formatCompact(report);
    expect(out).toContain("Expiring in 24h: 1");
    expect(out).toContain("Already expired: 1");
  });

  it("includes top tags when present", () => {
    const items = [
      makeAttachment({ tag: "project:foo" }),
      makeAttachment({ tag: "project:foo" }),
    ];
    const report = computeReport(items, NOW - 7 * DAY, NOW);
    const out = formatCompact(report);
    expect(out).toContain("Top tags:");
    expect(out).toContain("project:foo (2)");
  });

  it("omits top tags line when no tags", () => {
    const report = computeReport([], NOW - 7 * DAY, NOW);
    const out = formatCompact(report);
    expect(out).not.toContain("Top tags:");
  });

  it("includes largest upload filenames", () => {
    const items = [makeAttachment({ filename: "bigfile.zip", size: 50 * 1024 * 1024 })];
    const report = computeReport(items, NOW - 7 * DAY, NOW);
    const out = formatCompact(report);
    expect(out).toContain("bigfile.zip");
  });
});

// ---------------------------------------------------------------------------
// formatMarkdown
// ---------------------------------------------------------------------------

describe("formatMarkdown", () => {
  it("has markdown headers", () => {
    const report = computeReport([], NOW - 7 * DAY, NOW);
    const out = formatMarkdown(report);
    expect(out).toContain("## Attachments Report");
    expect(out).toContain("### Activity");
    expect(out).toContain("### Storage");
  });

  it("includes upload count", () => {
    const items = [makeAttachment({ size: 500 })];
    const report = computeReport(items, NOW - 7 * DAY, NOW);
    const out = formatMarkdown(report);
    expect(out).toContain("**Uploads**:");
  });

  it("includes top tags section when tags present", () => {
    const items = [makeAttachment({ tag: "session:abc" })];
    const report = computeReport(items, NOW - 7 * DAY, NOW);
    const out = formatMarkdown(report);
    expect(out).toContain("### Top Tags");
    expect(out).toContain("`session:abc`");
  });

  it("omits top tags section when no tags", () => {
    const report = computeReport([], NOW - 7 * DAY, NOW);
    const out = formatMarkdown(report);
    expect(out).not.toContain("### Top Tags");
  });

  it("includes largest uploads section when present", () => {
    const items = [makeAttachment({ filename: "large.tar.gz", size: 1024 * 1024 * 10 })];
    const report = computeReport(items, NOW - 7 * DAY, NOW);
    const out = formatMarkdown(report);
    expect(out).toContain("### Largest Uploads");
    expect(out).toContain("large.tar.gz");
  });
});

// ---------------------------------------------------------------------------
// formatJson
// ---------------------------------------------------------------------------

describe("formatJson", () => {
  it("returns valid JSON", () => {
    const report = computeReport([], NOW - 7 * DAY, NOW);
    const out = formatJson(report);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("includes all top-level keys", () => {
    const report = computeReport([], NOW - 7 * DAY, NOW);
    const parsed = JSON.parse(formatJson(report));
    expect(parsed).toHaveProperty("period");
    expect(parsed).toHaveProperty("uploads");
    expect(parsed).toHaveProperty("total");
    expect(parsed).toHaveProperty("expiringSoon");
    expect(parsed).toHaveProperty("alreadyExpired");
    expect(parsed).toHaveProperty("topTags");
    expect(parsed).toHaveProperty("largestUploads");
  });

  it("serializes tag data correctly", () => {
    const items = [makeAttachment({ tag: "task:OPE-001" }), makeAttachment({ tag: "task:OPE-001" })];
    const report = computeReport(items, NOW - 7 * DAY, NOW);
    const parsed = JSON.parse(formatJson(report));
    expect(parsed.topTags[0].tag).toBe("task:OPE-001");
    expect(parsed.topTags[0].count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// registerReport (integration tests via Commander)
// ---------------------------------------------------------------------------

describe("registerReport command", () => {
  beforeEach(() => {
    mockFindAll.mockReset();
    mockFindAll.mockImplementation(() => []);
    mockDbClose.mockReset();
  });

  it("outputs compact report by default", async () => {
    const capture = captureOutput();
    try {
      const program = buildReportCmd();
      await program.parseAsync(["report"], { from: "user" });
      expect(capture.stdout).toContain("Last 7 days:");
      expect(capture.stdout).toContain("Total stored:");
    } finally {
      capture.restore();
    }
  });

  it("respects --days option", async () => {
    const capture = captureOutput();
    try {
      const program = buildReportCmd();
      await program.parseAsync(["report", "--days", "30"], { from: "user" });
      expect(capture.stdout).toContain("Last 30 days:");
    } finally {
      capture.restore();
    }
  });

  it("outputs JSON when --format json", async () => {
    const capture = captureOutput();
    try {
      const program = buildReportCmd();
      await program.parseAsync(["report", "--format", "json"], { from: "user" });
      expect(() => JSON.parse(capture.stdout)).not.toThrow();
    } finally {
      capture.restore();
    }
  });

  it("outputs markdown when --format markdown", async () => {
    const capture = captureOutput();
    try {
      const program = buildReportCmd();
      await program.parseAsync(["report", "--format", "markdown"], { from: "user" });
      expect(capture.stdout).toContain("## Attachments Report");
    } finally {
      capture.restore();
    }
  });

  it("handles empty DB gracefully (empty state)", async () => {
    mockFindAll.mockImplementation(() => []);
    const capture = captureOutput();
    try {
      const program = buildReportCmd();
      await program.parseAsync(["report"], { from: "user" });
      expect(capture.stdout).toContain("0 uploads");
      expect(capture.stdout).toContain("0 files");
    } finally {
      capture.restore();
    }
  });

  it("passes includeExpired: true to findAll to count all attachments", async () => {
    const capture = captureOutput();
    try {
      const program = buildReportCmd();
      await program.parseAsync(["report"], { from: "user" });
      const [opts] = mockFindAll.mock.calls[0] as [{ includeExpired: boolean }];
      expect(opts.includeExpired).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it("calls db.close()", async () => {
    const capture = captureOutput();
    try {
      const program = buildReportCmd();
      await program.parseAsync(["report"], { from: "user" });
      expect(mockDbClose).toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });

  it("exits with error for invalid --days", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();
    try {
      const program = buildReportCmd();
      await expect(
        program.parseAsync(["report", "--days", "abc"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.stderr).toContain("--days must be a positive integer");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with error for invalid --format", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();
    try {
      const program = buildReportCmd();
      await expect(
        program.parseAsync(["report", "--format", "xml"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.stderr).toContain("--format must be one of");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("shows upload data from period in compact output", async () => {
    const now = Date.now();
    mockFindAll.mockImplementation(() => [
      makeAttachment({ size: 1024 * 1024 * 5, createdAt: now - DAY }),
    ]);
    const capture = captureOutput();
    try {
      const program = buildReportCmd();
      await program.parseAsync(["report", "--days", "7"], { from: "user" });
      expect(capture.stdout).toContain("1 uploads");
      expect(capture.stdout).toContain("MB");
    } finally {
      capture.restore();
    }
  });
});
