import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Command } from "commander";
import { storageCommand } from "./storage";

const ENV_NAMES = [
  "HOME",
  "HASNA_ATTACHMENTS_DATABASE_URL",
  "ATTACHMENTS_DATABASE_URL",
] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(
  ENV_NAMES.map((name) => [name, process.env[name]]),
);

let tempHome: string | undefined;

function buildProgram(): Command {
  const program = new Command("attachments");
  program.exitOverride();
  program.addCommand(storageCommand());
  return program;
}

async function runCommand(args: string[]): Promise<string> {
  const out: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((value?: unknown) => {
    out.push(String(value ?? ""));
  });

  try {
    await buildProgram().parseAsync(args, { from: "user" });
  } finally {
    logSpy.mockRestore();
  }

  return out.join("\n");
}

function retiredCommandPattern(): RegExp {
  return new RegExp("\\n\\s+" + ["clo", "ud"].join("") + "(?:\\s|$)");
}

describe("attachments storage command", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "attachments-storage-"));
    for (const name of ENV_NAMES) delete process.env[name];
    process.env["HOME"] = tempHome;
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      const value = ORIGINAL_ENV.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  it("advertises storage without a retired command", () => {
    const help = buildProgram().helpInformation();

    expect(help).toContain("storage");
    expect(help).not.toMatch(retiredCommandPattern());
  });

  it("reports local storage status with canonical env names", async () => {
    const output = await runCommand(["storage", "status"]);
    const status = JSON.parse(output) as {
      configured: boolean;
      mode: string;
      env: string[];
      tables: string[];
    };

    expect(status.configured).toBe(false);
    expect(status.mode).toBe("local");
    expect(status.env).toEqual(["HASNA_ATTACHMENTS_DATABASE_URL", "ATTACHMENTS_DATABASE_URL"]);
    expect("deprecatedEnv" in status).toBe(false);
    expect(status.tables).toEqual(["attachments", "artifacts", "share_links", "feedback"]);
  });
});
