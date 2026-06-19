import { networkInterfaces } from "os";
import { spawnSync } from "child_process";
import { getConfig, getInternalBaseUrl, type AttachmentsConfig } from "./config";

export interface InternalBaseUrlResult {
  baseUrl: string;
  source: "config" | "open-machines" | "tailscale" | "lan";
  target: string;
}

export interface InternalBindHostResult {
  host: string;
  source: "config" | "tailscale";
  baseUrl: string;
}

type MachinesConsumer = {
  resolveMachineRoute?: (machineId: string, options?: Record<string, unknown>) => {
    ok?: boolean;
    target?: string | null;
    route?: string;
  };
  getLocalMachineTopology?: (options?: Record<string, unknown>) => {
    machine_id?: string;
    tailscale?: { dns_name?: string | null; ips?: string[] };
    hostname?: string | null;
  };
};

function cleanHost(input: string): string {
  return input.replace(/\.$/, "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function baseUrlForTarget(target: string, port: number): string {
  const clean = cleanHost(target);
  const host = clean.includes(":") && !clean.startsWith("[") ? `[${clean}]` : clean;
  return `http://${host}:${port}`;
}

function isTailscaleTarget(target: string): boolean {
  const clean = cleanHost(target);
  if (clean.endsWith(".ts.net")) return true;
  const match = /^100\.(\d+)\.(\d+)\.(\d+)$/.exec(clean);
  return Boolean(match && Number(match[1]) >= 64 && Number(match[1]) <= 127);
}

async function fromMachines(config: AttachmentsConfig, port: number): Promise<InternalBaseUrlResult | null> {
  try {
    const pkg = "@hasna/machines/consumer";
    const machines = await import(pkg) as MachinesConsumer;
    if (config.client.internalMachineId && machines.resolveMachineRoute) {
      const route = machines.resolveMachineRoute(config.client.internalMachineId, { includeTailscale: true });
      if (route.ok && route.target && route.target !== "localhost" && isTailscaleTarget(route.target)) {
        return { baseUrl: baseUrlForTarget(route.target, port), source: "open-machines", target: route.target };
      }
    }
    if (machines.getLocalMachineTopology) {
      const local = machines.getLocalMachineTopology({ includeTailscale: true });
      const target = local.tailscale?.dns_name || local.tailscale?.ips?.[0] || local.hostname;
      if (target && target !== "localhost" && isTailscaleTarget(target)) {
        return { baseUrl: baseUrlForTarget(target, port), source: "open-machines", target };
      }
    }
  } catch {
    // @hasna/machines is optional for open-source users.
  }
  return null;
}

function fromTailscale(port: number): InternalBaseUrlResult | null {
  const result = spawnSync("tailscale", ["status", "--json"], { encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout) as {
      Self?: { DNSName?: string; TailscaleIPs?: string[] };
      TailscaleIPs?: string[];
    };
    const target = parsed.Self?.DNSName?.replace(/\.$/, "") || parsed.Self?.TailscaleIPs?.[0] || parsed.TailscaleIPs?.[0];
    return target ? { baseUrl: baseUrlForTarget(target, port), source: "tailscale", target } : null;
  } catch {
    return null;
  }
}

function tailscaleSelf(): { dnsName: string | null; ipv4: string | null } | null {
  const result = spawnSync("tailscale", ["status", "--json"], { encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout) as {
      Self?: { DNSName?: string; TailscaleIPs?: string[] };
      TailscaleIPs?: string[];
    };
    const ips = parsed.Self?.TailscaleIPs ?? parsed.TailscaleIPs ?? [];
    const ipv4 = ips.find((ip) => /^100\./.test(ip)) ?? null;
    const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "") ?? null;
    return ipv4 || dnsName ? { dnsName, ipv4 } : null;
  } catch {
    return null;
  }
}

function fromLan(port: number): InternalBaseUrlResult | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      if (entry.address.startsWith("127.") || entry.address.startsWith("169.254.")) continue;
      return { baseUrl: baseUrlForTarget(entry.address, port), source: "lan", target: entry.address };
    }
  }
  return null;
}

export async function resolveInternalBaseUrl(config: AttachmentsConfig = getConfig()): Promise<InternalBaseUrlResult> {
  const configured = getInternalBaseUrl(config);
  if (configured) {
    return { baseUrl: configured, source: "config", target: cleanHost(configured) };
  }

  const port = config.server.port || 3459;
  const tailscale = fromTailscale(port);
  if (tailscale) return tailscale;

  const machines = await fromMachines(config, port);
  if (machines) return machines;

  const lan = fromLan(port);
  if (process.env["ATTACHMENTS_ALLOW_LAN_INTERNAL"] === "1" && lan) return lan;

  throw new Error("Could not resolve a Tailscale internal address. Connect Tailscale or set `attachments config set --internal-base-url http://<tailscale-host>:3459`.");
}

export function resolveInternalBindHost(config: AttachmentsConfig = getConfig()): InternalBindHostResult {
  const configured = process.env["ATTACHMENTS_INTERNAL_BIND_HOST"];
  const port = config.server.port || 3459;
  if (configured) {
    return { host: configured, source: "config", baseUrl: baseUrlForTarget(configured, port) };
  }

  const self = tailscaleSelf();
  if (self?.ipv4) {
    return {
      host: self.ipv4,
      source: "tailscale",
      baseUrl: baseUrlForTarget(self.dnsName || self.ipv4, port),
    };
  }

  throw new Error("Could not resolve a Tailscale bind address. Start Tailscale or set ATTACHMENTS_INTERNAL_BIND_HOST to a Tailscale IP.");
}
