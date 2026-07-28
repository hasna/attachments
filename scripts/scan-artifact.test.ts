import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS_KIT_VERSION, scannerCommand, scanPackedArtifact } from "./scan-artifact";

const repoRoot = join(import.meta.dir, "..");

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

/** Strip a leading range operator so "^0.8.2" and "0.8.2" compare equal. */
function rangeBaseVersion(range: string): string {
  return range.replace(/^[\^~=v]+/, "");
}

describe("scan:artifact release gate", () => {
  afterEach(() => {
    delete process.env.HASNA_CONTRACTS_ARTIFACT_SCAN;
  });

  it("always resolves to the pinned scanner, with no environment bypass", () => {
    // A gate that any env var can replace at publish time is not a gate.
    process.env.HASNA_CONTRACTS_ARTIFACT_SCAN = "true";
    expect(scannerCommand("/tmp/pkg.tgz")).toEqual([
      "bunx",
      `@hasna/contracts@${CONTRACTS_KIT_VERSION}`,
      "artifact-scan",
      "/tmp/pkg.tgz",
    ]);
  });

  it("keeps the kit version in lockstep with the contract, vendored kit and dependency", () => {
    expect(readJson("hasna.contract.json").kitVersion).toBe(CONTRACTS_KIT_VERSION);
    expect(readJson("src/generated/storage-kit/.storage-kit-manifest.json").kitVersion).toBe(
      CONTRACTS_KIT_VERSION,
    );
    expect(rangeBaseVersion(readJson("package.json").dependencies["@hasna/contracts"])).toBe(
      CONTRACTS_KIT_VERSION,
    );
    // The pinned version must be quarantine-excluded or a fresh install stalls.
    expect(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8")).toContain(
      `'@hasna/contracts@${CONTRACTS_KIT_VERSION}'`,
    );
  });

  it("packs the artifact and passes the scan with the pinned kit", () => {
    // Proves the pin actually resolves on the registry: an unpublished version
    // makes bunx exit 1 here, exactly as it would in prepack.
    const { command, output } = scanPackedArtifact();
    expect(command[1]).toBe(`@hasna/contracts@${CONTRACTS_KIT_VERSION}`);
    expect(output).toContain("pass artifact-scan");
    expect(output).toContain("packed_artifact");
  }, 300_000);
});
