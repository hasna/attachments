import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS_KIT_VERSION, scannerCommand, scanPackedArtifact } from "./scan-artifact";

const repoRoot = join(import.meta.dir, "..");

function readText(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(readText(relativePath));
}

/** Strip comments so a doc line naming an env API cannot mask a real read of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Strip a leading range operator so "^0.8.4" and "0.8.4" compare equal. */
function rangeBaseVersion(range: string): string {
  return range.replace(/^[\^~=v]+/, "");
}

/**
 * Scripts reachable from `entry` through the pre/post lifecycle and `bun run` /
 * `npm run` references. Mirrors the graph `@hasna/contracts repo-conformance`
 * walks for its published_artifact_gate check, so the wiring is proven on every
 * `bun run test` and not only when a human remembers to type the conformance
 * CLI.
 */
function scriptsReachedBy(scripts: Record<string, string>, entry: string): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [entry];
  const enqueue = (name: string | undefined) => {
    if (name && name in scripts) queue.push(name);
  };
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (reached.has(name)) continue;
    reached.add(name);
    enqueue(`pre${name}`);
    enqueue(`post${name}`);
    const body = scripts[name];
    if (!body) continue;
    for (const match of body.matchAll(
      /\b(?:bun|bunx|npm|pnpm|yarn)\s+(?:(?:--\S+|-\w)\s+)*(?:run\s+)?([a-zA-Z0-9_][\w:.-]*)/g,
    )) {
      enqueue(match[1]);
    }
  }
  return reached;
}

describe("scan:artifact release gate", () => {
  it("resolves the pinned scanner from source alone — the module reads no environment", () => {
    // Setting one env name and asserting the argv is unchanged only proves the
    // names we happened to think of; a bypass added under any other name stays
    // green. Assert the invariant the module header claims instead: there is no
    // environment input path at all, so there is nothing to override at publish
    // time.
    const source = stripComments(readText("scripts/scan-artifact.ts"));
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/Bun\.env/);
    expect(source).not.toMatch(/import\.meta\.env/);
    expect(source).not.toMatch(/from\s+["']node:process["']/);

    expect(scannerCommand("/tmp/pkg.tgz")).toEqual([
      "bunx",
      `@hasna/contracts@${CONTRACTS_KIT_VERSION}`,
      "artifact-scan",
      "/tmp/pkg.tgz",
    ]);
  });

  it("keeps prepack and prepublishOnly wired to the declared packed-artifact scan", () => {
    // The deliverable here is the wiring, not the script. Drop `prepack`, or
    // drop `scan:artifact` out of `verify:release`, and the scanner still runs
    // clean in isolation while `bun publish` ships an unscanned artifact.
    const scripts = readJson("package.json").scripts as Record<string, string>;
    const declared = readJson("hasna.contract.json").metadata?.release?.artifactScan?.script;

    expect(declared).toBe("scan:artifact");
    expect(scripts[declared]).toBe("bun scripts/scan-artifact.ts");
    expect(scripts["verify:release"]).toContain("bun run scan:artifact");

    // npm/bun run `prepack` for `pm pack` and `prepublishOnly` for `publish`;
    // a gate reachable from only one of them still has a publish-time hole.
    for (const entry of ["prepack", "prepublishOnly"]) {
      expect(scripts[entry]).toBeString();
      expect([...scriptsReachedBy(scripts, entry)]).toContain(declared);
    }
  });

  it("enforces the conformance and release gates in CI, not only on a reviewer's laptop", () => {
    // `contracts repo-conformance` is what checks published_artifact_gate. With
    // no workflow it runs when someone types it, which is not a gate.
    const workflow = readText(".github/workflows/ci.yml");
    expect(workflow).toContain(`bunx @hasna/contracts@${CONTRACTS_KIT_VERSION} repo-conformance .`);
    expect(workflow).toContain(`bunx @hasna/contracts@${CONTRACTS_KIT_VERSION} vendor-kit --check .`);
    expect(workflow).toContain("bun run verify:release");
    // The live-PG gate declared in the contract has to actually execute.
    expect(workflow).toContain("HASNA_ATTACHMENTS_TEST_DATABASE_URL");
    expect(workflow).toContain("ATTACHMENTS_REQUIRE_POSTGRES");
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
    expect(readText("pnpm-workspace.yaml")).toContain(`'@hasna/contracts@${CONTRACTS_KIT_VERSION}'`);
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
