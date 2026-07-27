import { Command } from "commander";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getConfig, normalizePublicPath, setConfig, type AttachmentsConfig } from "../../core/config";
import { buildDeploymentPlan, classifyAttachmentRouteProbe } from "../../core/deployment";
import {
  buildEdgeRoutingArtifacts,
  describeInvalidOrigin,
  EdgeRoutingConfigError,
  type EdgeRoutingArtifacts,
} from "../../core/edge-routing";

function trimOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed || undefined;
}

// Reject an unroutable origin at write time as well as at render time. Trimming
// alone accepts `<attachments-origin>` and scheme-less hosts, and a config that
// holds one only fails later, at the edge, on every share link.
function reportInvalidOrigin(flag: string, value: string | undefined): boolean {
  const reason = value ? describeInvalidOrigin(value) : null;
  if (!reason) return false;
  process.stderr.write(`Error: ${flag} ${reason}\n`);
  return true;
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
      const attachmentsOrigin = trimOrigin(options.attachmentsOrigin);
      const fallbackOrigin = trimOrigin(options.fallbackOrigin) ?? trimOrigin(options.shortlinksOrigin);
      const fallbackFlag = trimOrigin(options.fallbackOrigin) ? "--fallback-origin" : "--shortlinks-origin";

      // Report both flags rather than short-circuiting, so one run names every
      // origin the operator has to fix.
      const badAttachmentsOrigin = reportInvalidOrigin("--attachments-origin", attachmentsOrigin);
      const badFallbackOrigin = reportInvalidOrigin(fallbackFlag, fallbackOrigin);
      if (badAttachmentsOrigin || badFallbackOrigin) {
        process.exitCode = 1;
        return;
      }

      const config = getConfig();
      const dns: AttachmentsConfig["deployment"]["dns"] = {};
      const routing: AttachmentsConfig["deployment"]["routing"] = {};

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

function renderCommand(): Command {
  return new Command("render")
    .description("Render the deployable edge worker + routes that put the attachment prefix ahead of the fallback route")
    .option("--format <format>", "json, wrangler, or worker", "json")
    .option("--out <dir>", "Write wrangler.toml and worker.js into this directory instead of stdout")
    .action((options) => {
      const format = String(options.format ?? "json");
      if (format !== "json" && format !== "wrangler" && format !== "worker") {
        process.stderr.write("Error: --format must be json, wrangler, or worker\n");
        process.exitCode = 1;
        return;
      }

      let artifacts: EdgeRoutingArtifacts;
      try {
        artifacts = buildEdgeRoutingArtifacts();
      } catch (err) {
        // A placeholder artifact deploys cleanly and leaves the prefix dead, so
        // refuse to emit one and name the config the operator still owes us.
        if (err instanceof EdgeRoutingConfigError) {
          process.stderr.write(`Error: ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      if (options.out) {
        const dir = String(options.out);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "wrangler.toml"), artifacts.wrangler_toml, "utf-8");
        writeFileSync(join(dir, "worker.js"), artifacts.worker_script, "utf-8");
        process.stdout.write(
          `Wrote ${join(dir, "wrangler.toml")} and ${join(dir, "worker.js")}.\n` +
            `Deploy with 'wrangler deploy', then run 'attachments domain verify'.\n`
        );
        return;
      }

      if (format === "wrangler") {
        process.stdout.write(artifacts.wrangler_toml);
        return;
      }
      if (format === "worker") {
        process.stdout.write(artifacts.worker_script);
        return;
      }
      process.stdout.write(JSON.stringify(artifacts, null, 2) + "\n");
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
  cmd.addCommand(renderCommand());
  cmd.addCommand(verifyCommand());
  return cmd;
}
