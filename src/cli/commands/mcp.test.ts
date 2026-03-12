import { describe, it, expect, mock, beforeEach, spyOn, afterAll } from "bun:test";
import { Command } from "commander";
import * as realOs from "os";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";

// ---------------------------------------------------------------------------
// Mocks — mock child_process + os.homedir (synchronous factory, no async deadlock).
// DO NOT mock "fs" — it breaks other test files that import { rmSync } from "fs".
// ---------------------------------------------------------------------------

const mockExecSync = mock((_cmd: string, _opts?: unknown) => Buffer.from(""));

mock.module("child_process", () => ({
  execSync: mockExecSync,
}));

// Temp home directory — mocked via os.homedir so mcp.ts writes files there
const tempHome = join(realOs.tmpdir(), `mcp-test-home-${Date.now()}`);
mkdirSync(tempHome, { recursive: true });

// Synchronous factory — avoids deadlock with top-level await import("./mcp")
mock.module("os", () => ({ ...realOs, homedir: () => tempHome }));

// Import after mocks
const { registerMcp } = await import("./mcp");

afterAll(() => {
  mock.restore();
  try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  registerMcp(program);
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

function getCodexPath() { return join(tempHome, ".codex", "config.toml"); }
function getGeminiPath() { return join(tempHome, ".gemini", "settings.json"); }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp command", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    // Clean up temp config files between tests
    try { rmSync(join(tempHome, ".codex"), { recursive: true, force: true }); } catch {}
    try { rmSync(join(tempHome, ".gemini"), { recursive: true, force: true }); } catch {}
  });

  // ---- Claude Code --------------------------------------------------------

  describe("--claude", () => {
    it("runs the correct claude mcp add command", async () => {
      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--claude"], { from: "user" });
        expect(mockExecSync).toHaveBeenCalledTimes(1);
        const [cmd] = mockExecSync.mock.calls[0] as [string];
        expect(cmd).toBe(
          "claude mcp add --transport stdio --scope user attachments -- attachments-mcp"
        );
      } finally {
        capture.restore();
      }
    });

    it("prints success message for Claude Code install", async () => {
      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--claude"], { from: "user" });
        expect(capture.out.join("")).toContain(
          "\u2713 Installed attachments MCP in Claude Code"
        );
      } finally {
        capture.restore();
      }
    });

    it("runs the remove command when --uninstall is used with --claude", async () => {
      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--claude", "--uninstall"], { from: "user" });
        const [cmd] = mockExecSync.mock.calls[0] as [string];
        expect(cmd).toBe("claude mcp remove attachments");
        expect(capture.out.join("")).toContain(
          "\u2713 Removed attachments MCP from Claude Code"
        );
      } finally {
        capture.restore();
      }
    });
  });

  // ---- Codex --------------------------------------------------------------

  describe("--codex", () => {
    it("appends the mcp_servers.attachments block to config.toml when it does not exist", async () => {
      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--codex"], { from: "user" });
        const content = readFileSync(getCodexPath(), "utf-8");
        expect(content).toContain("[mcp_servers.attachments]");
        expect(content).toContain('command = "attachments-mcp"');
        expect(capture.out.join("")).toContain(
          "\u2713 Installed attachments MCP in Codex"
        );
      } finally {
        capture.restore();
      }
    });

    it("replaces an existing mcp_servers.attachments block in config.toml", async () => {
      const configPath = getCodexPath();
      mkdirSync(join(tempHome, ".codex"), { recursive: true });
      const existing = '[other_section]\nfoo = "bar"\n\n[mcp_servers.attachments]\ncommand = "old-cmd"\nargs = []\n';
      require("fs").writeFileSync(configPath, existing, "utf-8");

      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--codex"], { from: "user" });
        const content = readFileSync(configPath, "utf-8");
        expect(content).toContain('command = "attachments-mcp"');
        expect(content).not.toContain('command = "old-cmd"');
      } finally {
        capture.restore();
      }
    });

    it("removes the mcp_servers.attachments block when --uninstall is used with --codex", async () => {
      const configPath = getCodexPath();
      mkdirSync(join(tempHome, ".codex"), { recursive: true });
      require("fs").writeFileSync(configPath, '[other]\nfoo = "bar"\n\n[mcp_servers.attachments]\ncommand = "attachments-mcp"\nargs = []\n', "utf-8");

      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--codex", "--uninstall"], { from: "user" });
        const content = readFileSync(configPath, "utf-8");
        expect(content).not.toContain("[mcp_servers.attachments]");
        expect(capture.out.join("")).toContain(
          "\u2713 Removed attachments MCP from Codex"
        );
      } finally {
        capture.restore();
      }
    });

    it("prints 'not present' message when --uninstall is used with --codex and config does not exist", async () => {
      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--codex", "--uninstall"], { from: "user" });
        expect(capture.out.join("")).toContain("not present");
      } finally {
        capture.restore();
      }
    });
  });

  // ---- Gemini -------------------------------------------------------------

  describe("--gemini", () => {
    it("creates settings.json with attachments entry when it does not exist", async () => {
      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--gemini"], { from: "user" });
        const parsed = JSON.parse(readFileSync(getGeminiPath(), "utf-8")) as {
          mcpServers: { attachments: { command: string } };
        };
        expect(parsed.mcpServers.attachments.command).toBe("attachments-mcp");
        expect(capture.out.join("")).toContain(
          "\u2713 Installed attachments MCP in Gemini"
        );
      } finally {
        capture.restore();
      }
    });

    it("merges into an existing settings.json preserving other keys", async () => {
      const configPath = getGeminiPath();
      mkdirSync(join(tempHome, ".gemini"), { recursive: true });
      require("fs").writeFileSync(configPath, JSON.stringify({
        theme: "dark",
        mcpServers: { otherTool: { command: "other-cmd", args: [] } },
      }), "utf-8");

      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--gemini"], { from: "user" });
        const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
          theme: string;
          mcpServers: { attachments: { command: string }; otherTool: unknown };
        };
        expect(parsed.theme).toBe("dark");
        expect(parsed.mcpServers.otherTool).toBeDefined();
        expect(parsed.mcpServers.attachments.command).toBe("attachments-mcp");
      } finally {
        capture.restore();
      }
    });

    it("removes the attachments entry when --uninstall is used with --gemini", async () => {
      const configPath = getGeminiPath();
      mkdirSync(join(tempHome, ".gemini"), { recursive: true });
      require("fs").writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          attachments: { command: "attachments-mcp", args: [] },
          other: { command: "x" },
        },
      }), "utf-8");

      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--gemini", "--uninstall"], { from: "user" });
        const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
          mcpServers: Record<string, unknown>;
        };
        expect(parsed.mcpServers.attachments).toBeUndefined();
        expect(parsed.mcpServers.other).toBeDefined();
        expect(capture.out.join("")).toContain(
          "\u2713 Removed attachments MCP from Gemini"
        );
      } finally {
        capture.restore();
      }
    });

    it("prints 'not present' message when --uninstall is used with --gemini and config does not exist", async () => {
      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--gemini", "--uninstall"], { from: "user" });
        expect(capture.out.join("")).toContain("not present");
      } finally {
        capture.restore();
      }
    });

    it("exits with error when settings.json contains invalid JSON for installGemini", async () => {
      const configPath = getGeminiPath();
      mkdirSync(join(tempHome, ".gemini"), { recursive: true });
      require("fs").writeFileSync(configPath, "{ this is not valid json }", "utf-8");

      const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
        throw new Error("process.exit called");
      });
      const capture = captureOutput();

      try {
        const program = buildProgram();
        await expect(
          program.parseAsync(["mcp", "--gemini"], { from: "user" })
        ).rejects.toThrow("process.exit called");
        expect(capture.err.join("")).toContain("invalid JSON");
      } finally {
        capture.restore();
        exitSpy.mockRestore();
      }
    });
  });

  // ---- --all --------------------------------------------------------------

  describe("--all", () => {
    it("installs in all three agents", async () => {
      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--all"], { from: "user" });

        expect(mockExecSync).toHaveBeenCalledTimes(1);

        const codexContent = readFileSync(getCodexPath(), "utf-8");
        expect(codexContent).toContain("[mcp_servers.attachments]");

        const parsed = JSON.parse(readFileSync(getGeminiPath(), "utf-8")) as {
          mcpServers: { attachments: { command: string } };
        };
        expect(parsed.mcpServers.attachments.command).toBe("attachments-mcp");

        const combined = capture.out.join("");
        expect(combined).toContain("Claude Code");
        expect(combined).toContain("Codex");
        expect(combined).toContain("Gemini");
      } finally {
        capture.restore();
      }
    });

    it("uninstalls from all three agents when --uninstall --all is used", async () => {
      const codexPath = getCodexPath();
      const geminiPath = getGeminiPath();
      mkdirSync(join(tempHome, ".codex"), { recursive: true });
      mkdirSync(join(tempHome, ".gemini"), { recursive: true });
      require("fs").writeFileSync(codexPath, '[mcp_servers.attachments]\ncommand = "attachments-mcp"\nargs = []\n', "utf-8");
      require("fs").writeFileSync(geminiPath, JSON.stringify({
        mcpServers: { attachments: { command: "attachments-mcp", args: [] } },
      }), "utf-8");

      const capture = captureOutput();
      try {
        const program = buildProgram();
        await program.parseAsync(["mcp", "--all", "--uninstall"], { from: "user" });

        expect(mockExecSync).toHaveBeenCalledTimes(1);
        const [cmd] = mockExecSync.mock.calls[0] as [string];
        expect(cmd).toBe("claude mcp remove attachments");

        expect(readFileSync(codexPath, "utf-8")).not.toContain("[mcp_servers.attachments]");

        const parsed = JSON.parse(readFileSync(geminiPath, "utf-8")) as {
          mcpServers: Record<string, unknown>;
        };
        expect(parsed.mcpServers.attachments).toBeUndefined();
      } finally {
        capture.restore();
      }
    });
  });

  // ---- error cases --------------------------------------------------------

  it("exits with error when no target flag is given", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["mcp"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("Specify at least one target");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });

  it("exits with error when execSync throws (e.g. claude not installed)", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("claude: command not found");
    });

    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    const capture = captureOutput();

    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["mcp", "--claude"], { from: "user" })
      ).rejects.toThrow("process.exit called");
      expect(capture.err.join("")).toContain("claude: command not found");
    } finally {
      capture.restore();
      exitSpy.mockRestore();
    }
  });
});
