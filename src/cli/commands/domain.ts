import { Command } from "commander";
import { getConfig, normalizePublicPath, setConfig, type AttachmentsConfig } from "../../core/config";
import { buildDeploymentPlan, classifyAttachmentRouteProbe } from "../../core/deployment";

function trimOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed || undefined;
}

function configureCommand(): Command {
  return new Command("configure")
    .description("Store public domain metadata without mutating DNS")
    .requiredOption("--hostname <hostname>", "Public hostname, e.g. files.example.com")
    .option("--base-url <url>", "Public base URL, defaults to https://<hostname>")
    .option("--path-prefix <path>", "Attachment route prefix", "/a")
    .option("--provider <provider>", "Provider metadata: manual, cloudflare, opendomains, external", "manual")
    .option("--managed-by <manager>", "Manager metadata: manual, opendomains, external", "manual")
    .option("--zone <zone>", "DNS zone metadata")
    .option("--record <type>", "DNS record type: A, AAAA, CNAME")
    .option("--name <name>", "DNS record name")
    .option("--target <target>", "DNS record target")
    .option("--proxied", "Cloudflare proxied metadata", false)
    .option("--attachments-origin <url>", "Origin URL that serves the attachments app, used by deployment plans")
    .option("--fallback-origin <url>", "Existing origin URL for non-attachment paths, e.g. shortlinks")
    .option("--shortlinks-origin <url>", "Alias for --fallback-origin")
    .option("--primary", "Mark this as the primary link domain", true)
    .action((options) => {
      const hostname = String(options.hostname).trim();
      const pathPrefix = normalizePublicPath(String(options.pathPrefix));
      const baseUrl = String(options.baseUrl ?? `https://${hostname}`).replace(/\/+$/, "");
      const provider = options.provider as AttachmentsConfig["deployment"]["provider"];
      const managedBy = options.managedBy as AttachmentsConfig["deployment"]["managedBy"];
      const recordType = options.record as "A" | "AAAA" | "CNAME" | undefined;
      const config = getConfig();
      const dns: AttachmentsConfig["deployment"]["dns"] = {};
      const routing: AttachmentsConfig["deployment"]["routing"] = {};
      const attachmentsOrigin = trimOrigin(options.attachmentsOrigin);
      const fallbackOrigin = trimOrigin(options.fallbackOrigin) ?? trimOrigin(options.shortlinksOrigin);

      if (options.zone) dns.zone = String(options.zone);
      if (recordType) dns.recordType = recordType;
      if (options.name) dns.name = String(options.name);
      if (options.target) dns.target = String(options.target);
      if (options.proxied) dns.proxied = true;
      if (attachmentsOrigin) routing.attachmentsOrigin = attachmentsOrigin;
      if (fallbackOrigin) routing.fallbackOrigin = fallbackOrigin;

      const domains = [
        ...config.domains.filter((domain) => domain.hostname !== hostname),
        { hostname, baseUrl, pathPrefix, primary: !!options.primary },
      ].map((domain) => ({
        ...domain,
        primary: domain.hostname === hostname ? !!options.primary : options.primary ? false : domain.primary,
      }));

      setConfig({
        server: { baseUrl, publicPath: pathPrefix },
        domains,
        deployment: {
          publicHostname: hostname,
          provider,
          managedBy,
          ...(Object.keys(dns).length > 0 ? { dns } : {}),
          ...(Object.keys(routing).length > 0 ? { routing } : {}),
        },
      });

      process.stdout.write(`Configured ${baseUrl}${pathPrefix} as the attachment public route.\n`);
    });
}

function planCommand(): Command {
  return new Command("plan")
    .description("Print provider-neutral DNS/deployment metadata")
    .option("--format <format>", "json, opendomains, or cloudflare", "json")
    .action((options) => {
      const plan = buildDeploymentPlan();
      if (options.format === "opendomains") {
        process.stdout.write(JSON.stringify({
          tool: "opendomains",
          action: "upsert_dns_records",
          records: plan.dns_records,
          health_url: `${plan.public_base_url}/api/health`,
          public_route: plan.attachment_url_template,
          routing: plan.routing,
        }, null, 2) + "\n");
        return;
      }
      if (options.format === "cloudflare") {
        process.stdout.write(JSON.stringify({
          provider: "cloudflare",
          public_route: plan.attachment_url_template,
          route_patterns: plan.cloudflare.route_patterns,
          worker_environment: plan.cloudflare.worker_environment,
          validation: plan.routing.validation,
          missing: plan.routing.missing,
        }, null, 2) + "\n");
        return;
      }
      if (options.format !== "json") {
        process.stderr.write("Error: --format must be json, opendomains, or cloudflare\n");
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    });
}

function verifyCommand(): Command {
  return new Command("verify")
    .description("Probe the public attachment prefix and verify it reaches the attachments app")
    .option("--url <url>", "Probe URL; defaults to the configured /a/__attachments_probe__ URL")
    .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
    .option("--format <format>", "human or json", "human")
    .action(async (options) => {
      const plan = buildDeploymentPlan();
      const probeUrl = String(options.url ?? plan.routing.validation.attachment_probe_url);
      const timeoutMs = parseInt(String(options.timeout), 10);
      const format = String(options.format ?? "human");

      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        process.stderr.write("Error: --timeout must be a positive millisecond count\n");
        process.exitCode = 1;
        return;
      }
      if (format !== "human" && format !== "json") {
        process.stderr.write("Error: --format must be human or json\n");
        process.exitCode = 1;
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let output;

      try {
        const response = await fetch(probeUrl, {
          signal: controller.signal,
          redirect: "manual",
        });
        const body = await response.text();
        const classification = classifyAttachmentRouteProbe({
          status: response.status,
          contentType: response.headers.get("content-type"),
          body: body.slice(0, 4096),
        });
        output = {
          ok: classification.ok,
          service: classification.service,
          reason: classification.reason,
          url: probeUrl,
          status: response.status,
          content_type: response.headers.get("content-type"),
          expected: plan.routing.validation.expected_probe,
          route_patterns: plan.cloudflare.route_patterns,
          missing: plan.routing.missing,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output = {
          ok: false,
          service: "unknown",
          reason: `Probe failed: ${message}`,
          url: probeUrl,
          expected: plan.routing.validation.expected_probe,
          route_patterns: plan.cloudflare.route_patterns,
          missing: plan.routing.missing,
        };
      } finally {
        clearTimeout(timeout);
      }

      if (format === "json") {
        process.stdout.write(JSON.stringify(output, null, 2) + "\n");
      } else if (output.ok) {
        process.stdout.write(`OK: ${output.reason}\n${output.url}\n`);
      } else {
        process.stdout.write(
          `FAIL: ${output.reason}\n` +
            `URL: ${output.url}\n` +
            `Expected: ${output.expected}\n` +
            `Required route: ${output.route_patterns[0]?.pattern} -> ${output.route_patterns[0]?.origin}\n`
        );
      }

      if (!output.ok) process.exitCode = 1;
    });
}

export function domainCommand(): Command {
  const cmd = new Command("domain").description("Manage public domain metadata");
  cmd.addCommand(configureCommand());
  cmd.addCommand(planCommand());
  cmd.addCommand(verifyCommand());
  return cmd;
}
