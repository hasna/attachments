import { describe, it, expect, mock, beforeAll, beforeEach, spyOn, afterAll } from "bun:test";
import { Command } from "commander";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import * as configModule from "../../core/config";
const { setConfigPath, setConfig } = configModule;

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the command
// ---------------------------------------------------------------------------

const mockStartServer = mock((_port: number) => {});

mock.module("../../api/server", () => ({
  startServer: mockStartServer,
}));

// Use real config module with temp config file — avoids module cache pollution
let _serveTestConfigDir: string;
// spyOn so serve.ts's live binding sees the spy without mock.module
const mockValidateS3Config = spyOn(configModule, "validateS3Config").mockImplementation(() => {});

beforeAll(() => {
  _serveTestConfigDir = join(tmpdir(), `serve-test-cfg-${Date.now()}`);
  mkdirSync(_serveTestConfigDir, { recursive: true });
  setConfigPath(join(_serveTestConfigDir, "config.json"));
  setConfig({
    s3: { bucket: "b", region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" },
    server: { port: 3459, baseUrl: "http://localhost:3459" },
    defaults: { expiry: "7d", linkType: "presigned" },
  });
});

// Import after mocks
const { registerServe } = await import("./serve");

// Restore all mocks after this file's tests complete so they don't leak into other test files
afterAll(() => {
  mock.restore();
  try { rmSync(_serveTestConfigDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  registerServe(program);
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
// Tests
// ---------------------------------------------------------------------------

describe("serve command", () => {
  beforeEach(() => {
    mockStartServer.mockReset();
    mockValidateS3Config.mockReset();
    mockValidateS3Config.mockImplementation(() => {});
  });

  it("starts the server on the default config port when no --port given", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["serve"], { from: "user" });
      expect(mockStartServer).toHaveBeenCalledTimes(1);
      const [calledPort] = mockStartServer.mock.calls[0] as [number];
      expect(calledPort).toBe(3459);
    } finally {
      capture.restore();
    }
  });

  it("starts the server on the port provided via --port", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["serve", "--port", "8080"], { from: "user" });
      expect(mockStartServer).toHaveBeenCalledTimes(1);
      const [calledPort] = mockStartServer.mock.calls[0] as [number];
      expect(calledPort).toBe(8080);
    } finally {
      capture.restore();
    }
  });

  it("outputs the running URL with correct port", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["serve", "--port", "4000"], { from: "user" });
      expect(capture.out.join("")).toContain("http://localhost:4000");
    } finally {
      capture.restore();
    }
  });

  it("outputs the running URL with custom host", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["serve", "--port", "3459", "--host", "0.0.0.0"], { from: "user" });
      expect(capture.out.join("")).toContain("http://0.0.0.0:3459");
    } finally {
      capture.restore();
    }
  });

  it("uses localhost as default host", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["serve"], { from: "user" });
      expect(capture.out.join("")).toContain("http://localhost:3459");
    } finally {
      capture.restore();
    }
  });

  it("outputs a success checkmark in the message", async () => {
    const capture = captureOutput();
    try {
      const program = buildProgram();
      await program.parseAsync(["serve"], { from: "user" });
      expect(capture.out.join("")).toContain("\u2713 attachments server running at");
    } finally {
      capture.restore();
    }
  });

  it("exits with error when S3 config is invalid", async () => {
    mockValidateS3Config.mockImplementation(() => {
      throw new Error("S3 configuration incomplete. Missing: bucket");
    });

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["serve"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("S3 configuration incomplete");
      expect(mockStartServer).not.toHaveBeenCalled();
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with error when port is not a valid number", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["serve", "--port", "notanumber"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("Invalid port");
      expect(mockStartServer).not.toHaveBeenCalled();
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });
});
