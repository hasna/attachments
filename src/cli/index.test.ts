import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "../../src/cli/index.ts");

function runCli(args: string): string {
  try {
    return execSync(`bun ${CLI_PATH} ${args} 2>&1`, { encoding: "utf-8" });
  } catch (err: unknown) {
    return (err as { stdout: string; stderr: string }).stdout || (err as { message: string }).message || "";
  }
}

describe("CLI --help", () => {
  it("shows all expected subcommands in --help output", () => {
    const help = runCli("--help");

    // Core commands
    expect(help).toContain("upload");
    expect(help).toContain("download");
    expect(help).toContain("list");
    expect(help).toContain("delete");
    expect(help).toContain("link");
    expect(help).toContain("config");

    // Status/info commands
    expect(help).toContain("status");
    expect(help).toContain("whoami");
    expect(help).toContain("report");

    // Maintenance commands
    expect(help).toContain("clean");
    expect(help).toContain("health-check");
    expect(help).toContain("watch");

    // Integration commands
    expect(help).toContain("link-task");
    expect(help).toContain("complete-task");
    expect(help).toContain("snapshot-session");
    expect(help).toContain("task-journal");
    expect(help).toContain("presign-upload");

    // Server/MCP
    expect(help).toContain("serve");
    expect(help).toContain("mcp");
  });

  it("shows the correct version", () => {
    const version = runCli("--version");
    // Should be semantic version, not hardcoded 0.1.0
    expect(version.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version.trim()).not.toBe("0.1.0");
  });
});
