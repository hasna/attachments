import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Command } from "commander";

const mockSendFeedback = mock(async (_input: unknown, _options: unknown) => ({
  feedback: {
    id: "fb_test001",
    service: "attachments",
    version: "1.2.3",
    message: "Great upload flow",
    email: "user@example.com",
    timestamp: "2026-07-07T10:11:12.000Z",
  },
  local: { saved: true },
  cloud: {
    attempted: true,
    ok: true,
    endpoint: "https://feedback.example.test/v1/feedback",
    status: 201,
  },
}));

mock.module("../../core/feedback", () => ({
  sendFeedback: mockSendFeedback,
}));

const { feedbackCommand } = await import("./feedback");

afterAll(() => mock.restore());

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.addCommand(feedbackCommand());
  return program;
}

function buildRootProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.enablePositionalOptions();
  program.version("root-version");
  program.addCommand(feedbackCommand());
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

describe("feedback command", () => {
  beforeEach(() => {
    mockSendFeedback.mockReset();
    mockSendFeedback.mockImplementation(async () => ({
      feedback: {
        id: "fb_test001",
        service: "attachments",
        version: "1.2.3",
        message: "Great upload flow",
        email: "user@example.com",
        timestamp: "2026-07-07T10:11:12.000Z",
      },
      local: { saved: true },
      cloud: {
        attempted: true,
        ok: true,
        endpoint: "https://feedback.example.test/v1/feedback",
        status: 201,
      },
    }));
  });

  it("sends feedback using positional message text", async () => {
    const capture = captureOutput();
    try {
      await buildProgram().parseAsync([
        "feedback",
        "send",
        "Great",
        "upload",
        "flow",
        "--service",
        "attachments",
        "--version",
        "1.2.3",
        "--email",
        "user@example.com",
        "--timestamp",
        "2026-07-07T10:11:12.000Z",
        "--endpoint",
        "https://feedback.example.test/v1/feedback",
      ], { from: "user" });

      expect(mockSendFeedback).toHaveBeenCalledWith({
        service: "attachments",
        version: "1.2.3",
        message: "Great upload flow",
        email: "user@example.com",
        timestamp: "2026-07-07T10:11:12.000Z",
      }, {
        endpoint: "https://feedback.example.test/v1/feedback",
        skipCloud: undefined,
      });
      expect(capture.out.join("")).toContain("Feedback saved locally.");
      expect(capture.out.join("")).toContain("Cloud: delivered (201)");
    } finally {
      capture.restore();
    }
  });

  it("prints JSON output for automation", async () => {
    const capture = captureOutput();
    try {
      await buildProgram().parseAsync([
        "feedback",
        "send",
        "--message",
        "Great upload flow",
        "--format",
        "json",
      ], { from: "user" });

      const parsed = JSON.parse(capture.out.join(""));
      expect(parsed.feedback.id).toBe("fb_test001");
      expect(parsed.cloud.ok).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it("keeps --version scoped to feedback send under the root CLI", async () => {
    const capture = captureOutput();
    try {
      await buildRootProgram().parseAsync([
        "feedback",
        "send",
        "Great upload flow",
        "--version",
        "1.2.3",
        "--format",
        "json",
      ], { from: "user" });

      expect(mockSendFeedback).toHaveBeenCalledWith({
        service: "attachments",
        version: "1.2.3",
        message: "Great upload flow",
        email: undefined,
        timestamp: undefined,
      }, {
        endpoint: undefined,
        skipCloud: undefined,
      });
      expect(capture.out.join("")).not.toBe("root-version\n");
    } finally {
      capture.restore();
    }
  });
});
