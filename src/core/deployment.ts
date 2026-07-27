import { getConfig, normalizePublicPath, type AttachmentsConfig } from "./config";

function hostnameFromBaseUrl(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

export function buildDeploymentPlan(config: AttachmentsConfig = getConfig()) {
  const publicPath = normalizePublicPath(config.server.publicPath);
  const primaryDomain = config.domains.find((d) => d.primary) ?? config.domains[0];
  const publicBaseUrl = (primaryDomain?.baseUrl ?? config.server.baseUrl).replace(/\/+$/, "");
  const hostname = config.deployment.publicHostname ?? primaryDomain?.hostname ?? hostnameFromBaseUrl(publicBaseUrl) ?? null;
  const attachmentsOrigin = config.deployment.routing?.attachmentsOrigin ?? null;
  const fallbackOrigin = config.deployment.routing?.fallbackOrigin ?? null;
  const attachmentRoutePattern = hostname ? `${hostname}${publicPath}/*` : `${publicPath}/*`;
  const fallbackRoutePattern = hostname ? `${hostname}/*` : "*";
  const missing: string[] = [];

  if (!hostname) missing.push("deployment.publicHostname");
  if (!attachmentsOrigin) missing.push("deployment.routing.attachmentsOrigin");

  return {
    public_base_url: publicBaseUrl,
    public_hostname: hostname,
    public_path: publicPath,
    attachment_url_template: `${publicBaseUrl}${publicPath}/:token`,
    domains: config.domains,
    deployment: config.deployment,
    dns_records: config.deployment.dns ? [config.deployment.dns] : [],
    routing: {
      attachment_route_pattern: attachmentRoutePattern,
      fallback_route_pattern: fallbackRoutePattern,
      attachments_origin: attachmentsOrigin,
      fallback_origin: fallbackOrigin,
      required_route_order: [
        {
          match: attachmentRoutePattern,
          target: attachmentsOrigin ?? "<attachments-origin>",
          purpose: "Serve open-attachments public pages and downloads",
          precedence: "higher than the generic shortlinks route",
        },
        {
          match: fallbackRoutePattern,
          target: fallbackOrigin ?? "<existing-shortlinks-origin>",
          purpose: "Keep existing shortlinks/redirect traffic working outside the attachment prefix",
          precedence: "lower priority fallback",
        },
      ],
      validation: {
        health_url: `${publicBaseUrl}/api/health`,
        attachment_probe_url: `${publicBaseUrl}${publicPath}/__attachments_probe__`,
        expected_probe: "The attachment route should answer this path, not the shortlinks app resolving slug 'a'.",
      },
      missing,
    },
    cloudflare: {
      route_patterns: [
        {
          pattern: attachmentRoutePattern,
          origin: attachmentsOrigin ?? "<attachments-origin>",
          note: "Configure this as the more-specific /a/* route.",
        },
        {
          pattern: fallbackRoutePattern,
          origin: fallbackOrigin ?? "<existing-shortlinks-origin>",
          note: "Existing shortlinks fallback route; keep lower precedence than /a/*.",
        },
      ],
      worker_environment: {
        ATTACHMENTS_ORIGIN: attachmentsOrigin ?? "<attachments-origin>",
        FALLBACK_ORIGIN: fallbackOrigin ?? "<existing-shortlinks-origin>",
        ATTACHMENTS_PATH_PREFIX: publicPath,
      },
    },
  };
}

export interface AttachmentRouteProbeInput {
  status: number;
  contentType: string | null;
  body: string;
}

export interface AttachmentRouteProbeResult {
  ok: boolean;
  service: "attachments" | "shortlinks" | "unknown";
  reason: string;
}

export function classifyAttachmentRouteProbe(input: AttachmentRouteProbeInput): AttachmentRouteProbeResult {
  const contentType = input.contentType?.toLowerCase() ?? "";
  const body = input.body.trim();
  const lowerBody = body.toLowerCase();

  // Reaching the attachments app is necessary but not sufficient. The public
  // routes render the same "Attachment unavailable" page for a 500 as for a
  // missing token (public-routes.ts:fatal), so a probe that only looked at the
  // body would report OK while every share link was failing — the deploy gate
  // would go green on a dead service.
  const attachmentsHit = (): AttachmentRouteProbeResult =>
    input.status >= 500
      ? {
          ok: false,
          service: "attachments",
          reason: `The attachment prefix reaches the attachments app, but it answered HTTP ${input.status}. The route is right; the service is not healthy.`,
        }
      : {
          ok: true,
          service: "attachments",
          reason: "The attachment prefix is handled by the attachments app.",
        };

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; slug?: unknown };
      const error = typeof parsed.error === "string" ? parsed.error.toLowerCase() : "";
      const slug = typeof parsed.slug === "string" ? parsed.slug.toLowerCase() : "";
      if (slug === "a" || error.includes("shortlink")) {
        return {
          ok: false,
          service: "shortlinks",
          reason: "The attachment prefix is still being handled by the shortlinks app.",
        };
      }
      if (error.includes("share link not found") || error.includes("attachment")) {
        return attachmentsHit();
      }
    } catch {
      // Fall through to content-based classification.
    }
  }

  if (
    contentType.includes("text/html") &&
    (lowerBody.includes("attachment unavailable") || lowerBody.includes("share link not found"))
  ) {
    return attachmentsHit();
  }

  return {
    ok: false,
    service: "unknown",
    reason: `The probe did not match the expected attachments response (HTTP ${input.status}).`,
  };
}
