import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, writeFileSync } from "fs";
import type { Artifact, Attachment } from "./db";

let artifacts: typeof import("./artifacts");

beforeAll(async () => {
  mock.restore();
  artifacts = await import("./artifacts");
});

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att_browserplan",
    filename: "BrowserPlan.zip",
    s3Key: "attachments/2026-06-23/att_browserplan/BrowserPlan.zip",
    bucket: "local",
    size: 128,
    contentType: "application/zip",
    link: "http://localhost:3459/a/token",
    tag: "artifact:browserplan:stable:darwin:arm64",
    expiresAt: null,
    createdAt: 1782200000000,
    storageBackend: "local",
    status: "ready",
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_browserplan",
    attachmentId: "att_browserplan",
    name: "browserplan",
    version: "1.0.0",
    channel: "stable",
    platform: "darwin",
    arch: "arm64",
    kind: "mac-app-zip",
    filename: "BrowserPlan.zip",
    size: 128,
    checksumSha256: "a".repeat(64),
    signature: null,
    signatureType: null,
    appName: "BrowserPlan.app",
    metadata: {},
    createdAt: 1782200000000,
    ...overrides,
  };
}

function fakeDb(inserted: Artifact[] = []): import("./db").AttachmentsDB {
  return {
    findById: (id: string) => id === "att_browserplan" ? makeAttachment() : null,
    insertArtifact: (artifact: Artifact) => {
      inserted.push(artifact);
    },
  } as unknown as import("./db").AttachmentsDB;
}

describe("artifact registry", () => {
  let inserted: Artifact[];

  beforeEach(() => {
    inserted = [];
  });

  it("registers an existing attachment as a versioned artifact", () => {
    const resolved = artifacts.registerArtifact({
      attachmentId: "att_browserplan",
      name: "browserplan",
      version: "1.2.3",
      channel: "stable",
      platform: "darwin",
      arch: "arm64",
      kind: "mac-app-zip",
      checksumSha256: "b".repeat(64),
      signature: "Developer ID Application: Hasna",
      signatureType: "codesign",
      appName: "BrowserPlan.app",
      metadata: { build: "20260623" },
    }, { db: fakeDb(inserted) });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.id).toBe(resolved.artifact.id);
    expect(inserted[0]!.attachmentId).toBe("att_browserplan");
    expect(inserted[0]!.version).toBe("1.2.3");
    expect(inserted[0]!.checksumSha256).toBe("b".repeat(64));
    expect(inserted[0]!.metadata.build).toBe("20260623");
  });

  it("rejects invalid artifact checksums during registration", () => {
    expect(() => artifacts.registerArtifact({
      attachmentId: "att_browserplan",
      name: "browserplan",
      version: "1.0.0",
      platform: "darwin",
      arch: "arm64",
      kind: "mac-app-zip",
      checksumSha256: "not-a-sha",
    }, { db: fakeDb(inserted) })).toThrow("checksum_sha256");
    expect(inserted).toHaveLength(0);
  });

  it("rejects non-semver artifact versions during registration", () => {
    expect(() => artifacts.registerArtifact({
      attachmentId: "att_browserplan",
      name: "browserplan",
      version: "release-latest",
      platform: "darwin",
      arch: "arm64",
      kind: "mac-app-zip",
      checksumSha256: "b".repeat(64),
    }, { db: fakeDb(inserted) })).toThrow("semantic version");
    expect(inserted).toHaveLength(0);
  });

  it("resolves latest by semver and creation time", () => {
    const now = Date.now();
    const latest = artifacts.chooseLatestArtifact([
      makeArtifact({ id: "art_old", version: "1.9.0", createdAt: now - 3000 }),
      makeArtifact({ id: "art_new", version: "1.10.0", createdAt: now - 2000 }),
      makeArtifact({ id: "art_same_newer", version: "1.10.0", createdAt: now - 1000 }),
    ]);

    expect(artifacts.compareArtifactVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(latest!.id).toBe("art_same_newer");
  });
});

describe("artifact verification and install plans", () => {
  it("verifies SHA-256 checksums and reports mismatches", async () => {
    const path = join(tmpdir(), `browserplan-${Date.now()}.zip`);
    writeFileSync(path, "browserplan-build");
    try {
      const checksum = await artifacts.sha256File(path);
      await expect(artifacts.verifyFileSha256(path, checksum)).resolves.toBe(checksum);
      await expect(artifacts.verifyFileSha256(path, "0".repeat(64))).rejects.toThrow("Checksum mismatch");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("generates checksum, copy, quarantine, and codesign install commands", () => {
    const artifact = makeArtifact({
      signature: "Developer ID Application: Hasna",
      signatureType: "codesign",
    });
    const attachment = makeAttachment();
    const plan = artifacts.buildMacArtifactInstallPlan(
      { artifact, attachment },
      { attachmentsBin: "attachments; touch /tmp/browserplan-pwned" }
    );

    expect(plan.install_script).toContain("'attachments; touch /tmp/browserplan-pwned' download 'http://localhost:3459/a/token'");
    expect(plan.install_script).toContain("shasum -a 256 -c -");
    expect(plan.install_script).toContain("hdiutil detach \"$mount_dir\"");
    expect(plan.install_script).toContain("ditto \"$app_source\" \"$new_path\"");
    expect(plan.install_script).toContain("if ! (sudo rm -rf \"$target_path\" && sudo ditto \"$new_path\" \"$target_path\")");
    expect(plan.install_script).toContain("xattr -dr com.apple.quarantine");
    expect(plan.install_script).toContain("codesign --verify");
    expect(plan.steps.findIndex((step) => step.id === "verify-staged-codesign"))
      .toBeLessThan(plan.steps.findIndex((step) => step.id === "install-app"));
    expect(plan.target_path).toBe("/Applications/BrowserPlan.app");
  });

  it("rejects unsafe app names and install directories", () => {
    expect(() => artifacts.buildMacArtifactInstallPlan({
      artifact: makeArtifact({ appName: "../BrowserPlan.app" }),
      attachment: makeAttachment(),
    })).toThrow("app_name");

    expect(() => artifacts.buildMacArtifactInstallPlan({
      artifact: makeArtifact(),
      attachment: makeAttachment(),
    }, { installDir: "Applications" })).toThrow("install_dir");

    expect(() => artifacts.buildMacArtifactInstallPlan({
      artifact: makeArtifact(),
      attachment: makeAttachment(),
    }, { installDir: "/Applications/../tmp" })).toThrow("install_dir");
  });

  it("verifies package signatures before installing signed PKG artifacts", () => {
    const plan = artifacts.buildMacArtifactInstallPlan({
      artifact: makeArtifact({
        kind: "pkg",
        filename: "BrowserPlan.pkg",
        appName: null,
        signature: "Developer ID Installer: Hasna",
        signatureType: "codesign",
      }),
      attachment: makeAttachment({ filename: "BrowserPlan.pkg" }),
    });

    expect(plan.steps.map((step) => step.id)).toContain("verify-pkg-signature");
    expect(plan.install_script).toContain("pkgutil --check-signature");
    expect(plan.steps.findIndex((step) => step.id === "verify-pkg-signature"))
      .toBeLessThan(plan.steps.findIndex((step) => step.id === "install-pkg"));
  });

  it("rejects unsupported macOS artifact kinds", () => {
    expect(() => artifacts.buildMacArtifactInstallPlan({
      artifact: makeArtifact({ kind: "tarball" }),
      attachment: makeAttachment(),
    })).toThrow("Unsupported macOS artifact kind");
  });

  it("expands machine001-machine011 and builds open-machines route commands", () => {
    const artifact = makeArtifact();
    const attachment = makeAttachment();
    const installPlan = artifacts.buildMacArtifactInstallPlan({ artifact, attachment });
    const fleet = artifacts.buildFleetInstallPlan(installPlan, {
      machines: artifacts.BROWSERPLAN_DEFAULT_FLEET,
      exclude: [...artifacts.BROWSERPLAN_DEFAULT_FLEET_EXCLUDES, "machine005"],
    });

    expect(artifacts.expandMachineTargets(artifacts.BROWSERPLAN_DEFAULT_FLEET)).toHaveLength(11);
    expect(fleet.target_machines).toContain("machine001");
    expect(fleet.target_machines).toContain("machine011");
    expect(fleet.target_machines).not.toContain("machine005");
    expect(fleet.excluded_machines).toContain("spark01");
    expect(fleet.excluded_machines).toContain("spark02");
    expect(fleet.open_machines.commands[0]!.route_command).toContain("machines ssh --machine 'machine001'");
  });

  it("rejects machine ranges with mismatched prefixes", () => {
    expect(() => artifacts.expandMachineTargets("machine001-node002")).toThrow("prefixes do not match");
  });
});
