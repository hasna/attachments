/**
 * Regression suite for the outage this branch is named after: on a shared
 * hostname whose `*` route belongs to the shortlinks worker, `<host>/a/<token>`
 * resolved to shortlinks and every server-hosted share link 404'd.
 *
 * These tests run the EMITTED worker, not a description of it: the generated
 * script is written to disk and imported, so a route table or dispatch rule that
 * would leave the prefix on the fallback origin fails here.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildEdgeRoutingArtifacts, EdgeRoutingConfigError } from "./edge-routing";
import type { AttachmentsConfig } from "./config";

const workDir = mkdtempSync(join(tmpdir(), "attachments-edge-routing-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function baseConfig(overrides: Partial<AttachmentsConfig> = {}): AttachmentsConfig {
  return {
    s3: { bucket: "", region: "", accessKeyId: "", secretAccessKey: "" },
    storage: {
      backend: "local",
      localDir: "~/.hasna/attachments/objects",
      maxSizeBytes: 10 * 1024 * 1024 * 1024,
    },
    server: {
      port: 3459,
      host: "localhost",
      baseUrl: "https://attachments.example.com",
      publicPath: "/a",
    },
    defaults: { expiry: "7d", linkType: "server" },
    client: { preferInternal: false },
    domains: [
      {
        hostname: "attachments.example.com",
        baseUrl: "https://attachments.example.com",
        pathPrefix: "/a",
        primary: true,
      },
    ],
    deployment: {
      publicHostname: "attachments.example.com",
      provider: "cloudflare",
      managedBy: "external",
      dns: { zone: "example.com" },
      routing: {
        attachmentsOrigin: "https://attachments-origin.example.net",
        fallbackOrigin: "https://shortlinks-origin.example.net",
      },
    },
    ...overrides,
  };
}

interface WorkerModule {
  default: { fetch(request: Request, env?: Record<string, string>): Promise<Response> };
  resolveOrigin(pathname: string, env?: Record<string, string>): string;
}

let moduleSeq = 0;

async function loadEmittedWorker(script: string): Promise<WorkerModule> {
  const file = join(workDir, `worker-${moduleSeq++}.mjs`);
  writeFileSync(file, script, "utf-8");
  return (await import(file)) as unknown as WorkerModule;
}

describe("buildEdgeRoutingArtifacts", () => {
  it("puts the attachment prefix route ahead of the generic fallback route", () => {
    const artifacts = buildEdgeRoutingArtifacts(baseConfig());

    expect(artifacts.routes.map((route) => route.pattern)).toEqual([
      "attachments.example.com/a/*",
      "attachments.example.com/*",
    ]);
    expect(artifacts.routes[0]?.origin).toBe("https://attachments-origin.example.net");
    expect(artifacts.routes[1]?.origin).toBe("https://shortlinks-origin.example.net");
    expect(artifacts.routes[0]?.zone_name).toBe("example.com");
  });

  it("never emits a placeholder artifact when the attachments origin is unconfigured", () => {
    const config = baseConfig();
    config.deployment.routing = {};

    expect(() => buildEdgeRoutingArtifacts(config)).toThrow(EdgeRoutingConfigError);
    try {
      buildEdgeRoutingArtifacts(config);
    } catch (err) {
      expect((err as EdgeRoutingConfigError).missing).toContain("deployment.routing.attachmentsOrigin");
    }
  });

  it("leaves the catch-all route alone when no fallback origin is configured", () => {
    const config = baseConfig();
    config.deployment.routing = { attachmentsOrigin: "https://attachments-origin.example.net" };
    const artifacts = buildEdgeRoutingArtifacts(config);

    // Claiming <host>/* without somewhere to forward it would 502 the shortlinks
    // traffic — a wider outage than the one being fixed.
    expect(artifacts.routes).toHaveLength(1);
    expect(artifacts.routes[0]?.pattern).toBe("attachments.example.com/a/*");
    expect(artifacts.wrangler_toml).not.toContain('pattern = "attachments.example.com/*"');
  });

  it("declares both routes and the origins in the emitted wrangler.toml", () => {
    const toml = buildEdgeRoutingArtifacts(baseConfig()).wrangler_toml;
    const attachmentRouteAt = toml.indexOf('pattern = "attachments.example.com/a/*"');
    const fallbackRouteAt = toml.indexOf('pattern = "attachments.example.com/*"');

    expect(attachmentRouteAt).toBeGreaterThan(-1);
    expect(fallbackRouteAt).toBeGreaterThan(attachmentRouteAt);
    expect(toml).toContain('ATTACHMENTS_ORIGIN = "https://attachments-origin.example.net"');
    expect(toml).toContain('zone_name = "example.com"');
    expect(toml).not.toContain("<attachments-origin>");
  });
});

describe("the emitted edge worker", () => {
  it("forwards /a/<token> to the attachments origin, not the shortlinks origin", async () => {
    const artifacts = buildEdgeRoutingArtifacts(baseConfig());
    const worker = await loadEmittedWorker(artifacts.worker_script);

    expect(worker.resolveOrigin("/a/tok_123")).toBe("https://attachments-origin.example.net");
    expect(worker.resolveOrigin("/a")).toBe("https://attachments-origin.example.net");
  });

  it("leaves every other path on the fallback origin", async () => {
    const artifacts = buildEdgeRoutingArtifacts(baseConfig());
    const worker = await loadEmittedWorker(artifacts.worker_script);

    expect(worker.resolveOrigin("/abc")).toBe("https://shortlinks-origin.example.net");
    expect(worker.resolveOrigin("/")).toBe("https://shortlinks-origin.example.net");
    expect(worker.resolveOrigin("/some-shortlink")).toBe("https://shortlinks-origin.example.net");
  });

  it("proxies the share-link request to the attachments origin preserving path and query", async () => {
    const artifacts = buildEdgeRoutingArtifacts(baseConfig());
    const worker = await loadEmittedWorker(artifacts.worker_script);
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL) => {
      seen.push(input instanceof Request ? input.url : String(input));
      return new Response("upstream", { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const res = await worker.default.fetch(
        new Request("https://attachments.example.com/a/tok_123/download?x=1", { method: "POST" })
      );
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(seen).toEqual(["https://attachments-origin.example.net/a/tok_123/download?x=1"]);
  });
});
