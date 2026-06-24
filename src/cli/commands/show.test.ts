import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Command } from "commander";
import { AttachmentsDB, type Attachment } from "../../core/db";
import { showCommand } from "./show";

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_MODE = process.env["ATTACHMENTS_CLIENT_MODE"];
let tempHome: string | undefined;

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att_show001",
    filename: "report.pdf",
    s3Key: "attachments/report.pdf",
    bucket: "test-bucket",
    size: 2048,
    contentType: "application/pdf",
    link: "https://example.com/full-link",
    tag: "task:TASK-001",
    expiresAt: null,
    createdAt: new Date("2026-06-24T10:00:00Z").getTime(),
    storageBackend: "s3",
    status: "ready",
    downloads: 2,
    ...overrides,
  };
}

function seedAttachment(att: Attachment = makeAttachment()): void {
  const db = new AttachmentsDB();
  try {
    db.insert(att);
  } finally {
    db.close();
  }
}

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.addCommand(showCommand());
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

describe("showCommand", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "attachments-show-"));
    process.env["HOME"] = tempHome;
    process.env["ATTACHMENTS_CLIENT_MODE"] = "local";
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = ORIGINAL_HOME;
    if (ORIGINAL_MODE === undefined) delete process.env["ATTACHMENTS_CLIENT_MODE"];
    else process.env["ATTACHMENTS_CLIENT_MODE"] = ORIGINAL_MODE;
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  it("prints full attachment metadata in human output", async () => {
    seedAttachment();
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["show", "att_show001"], { from: "user" });
      const output = capture.out.join("");
      expect(output).toContain("att_show001");
      expect(output).toContain("report.pdf");
      expect(output).toContain("https://example.com/full-link");
      expect(output).toContain("LinkState: ready");
    } finally {
      capture.restore();
    }
  });

  it("prints full JSON when requested", async () => {
    seedAttachment();
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["show", "att_show001", "--format", "json"], { from: "user" });
      const parsed = JSON.parse(capture.out.join(""));
      expect(parsed.id).toBe("att_show001");
      expect(parsed.link).toBe("https://example.com/full-link");
    } finally {
      capture.restore();
    }
  });
});
