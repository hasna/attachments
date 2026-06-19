import { describe, expect, it } from "bun:test";
import { buildDeploymentPlan, classifyAttachmentRouteProbe } from "./deployment";
import type { AttachmentsConfig } from "./config";

function baseConfig(overrides: Partial<AttachmentsConfig> = {}): AttachmentsConfig {
  return {
    s3: {
      bucket: "",
      region: "",
      accessKeyId: "",
      secretAccessKey: "",
    },
    storage: {
      backend: "local",
      localDir: "~/.hasna/attachments/objects",
      maxSizeBytes: 10 * 1024 * 1024 * 1024,
    },
    server: {
      port: 3459,
      host: "localhost",
      baseUrl: "https://has.na",
      publicPath: "/a",
    },
    defaults: {
      expiry: "7d",
      linkType: "server",
    },
    domains: [
      {
        hostname: "has.na",
        baseUrl: "https://has.na",
        pathPrefix: "/a",
        primary: true,
      },
    ],
    deployment: {
      publicHostname: "has.na",
      provider: "cloudflare",
      managedBy: "external",
      routing: {
        attachmentsOrigin: "https://attachments-origin.example.com",
        fallbackOrigin: "https://shortlinks-origin.example.com",
      },
    },
    ...overrides,
  };
}

describe("buildDeploymentPlan", () => {
  it("describes the /a route before the fallback shortlinks route", () => {
    const plan = buildDeploymentPlan(baseConfig());

    expect(plan.attachment_url_template).toBe("https://has.na/a/:token");
    expect(plan.routing.attachment_route_pattern).toBe("has.na/a/*");
    expect(plan.routing.fallback_route_pattern).toBe("has.na/*");
    expect(plan.routing.required_route_order[0]?.target).toBe("https://attachments-origin.example.com");
    expect(plan.routing.required_route_order[1]?.target).toBe("https://shortlinks-origin.example.com");
    expect(plan.cloudflare.route_patterns[0]?.pattern).toBe("has.na/a/*");
    expect(plan.routing.missing).toEqual([]);
  });

  it("reports a missing attachments origin when only the public domain is configured", () => {
    const plan = buildDeploymentPlan(baseConfig({
      deployment: {
        publicHostname: "has.na",
        provider: "cloudflare",
        managedBy: "external",
      },
    }));

    expect(plan.routing.missing).toContain("deployment.routing.attachmentsOrigin");
    expect(plan.cloudflare.worker_environment.ATTACHMENTS_ORIGIN).toBe("<attachments-origin>");
  });
});

describe("classifyAttachmentRouteProbe", () => {
  it("detects the current shortlinks slug-a route conflict", () => {
    const result = classifyAttachmentRouteProbe({
      status: 404,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ error: "Shortlink not found.", slug: "a", host: "has.na" }),
    });

    expect(result.ok).toBe(false);
    expect(result.service).toBe("shortlinks");
  });

  it("accepts the attachments unavailable page as a successful route hit", () => {
    const result = classifyAttachmentRouteProbe({
      status: 404,
      contentType: "text/html; charset=UTF-8",
      body: "<html><h1>Attachment unavailable</h1><p>Share link not found</p></html>",
    });

    expect(result.ok).toBe(true);
    expect(result.service).toBe("attachments");
  });
});
