import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const CONTRACTS_KIT_VERSION = "0.8.3";

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${command.join(" ")} exited ${result.exitCode}\n${stdout}\n${stderr}`);
  }
  return stdout;
}

function scannerCommand(archive: string): string[] {
  const override = process.env.HASNA_CONTRACTS_ARTIFACT_SCAN?.trim();
  if (override) return [...override.split(/\s+/), archive];
  return ["bunx", `@hasna/contracts@${CONTRACTS_KIT_VERSION}`, "artifact-scan", archive];
}

const repoRoot = join(import.meta.dir, "..");
const workspace = mkdtempSync(join(tmpdir(), "attachments-artifact-scan-"));

try {
  const packed = run(["bun", "pm", "pack", "--destination", workspace, "--ignore-scripts", "--quiet"], repoRoot);
  const archive = isAbsolute(packed) ? packed : join(workspace, packed);
  console.log(run(scannerCommand(archive), repoRoot));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
