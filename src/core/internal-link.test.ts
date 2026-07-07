import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { normalizeConfig } from "./config";

let spawnResult: { status: number | null; stdout: string };
const spawnSyncMock = mock(() => spawnResult);
let netIfaces: Record<string, Array<{ internal: boolean; family: string; address: string }>>;
const networkInterfacesMock = mock(() => netIfaces);
let machineRoute: { ok?: boolean; target?: string | null; route?: string } | null;
let machineTopology:
  | { machine_id?: string; tailscale?: { dns_name?: string | null; ips?: string[] }; hostname?: string | null }
  | null;

mock.module("child_process", () => ({
  spawnSync: spawnSyncMock,
}));

mock.module("os", () => ({
  networkInterfaces: networkInterfacesMock,
}));

mock.module("@hasna/machines/consumer", () => ({
  resolveMachineRoute: () => machineRoute,
  getLocalMachineTopology: () => machineTopology,
}));

const { resolveInternalBaseUrl, resolveInternalBindHost } = await import("./internal-link");

const ORIGINAL_ENV = new Map<string, string | undefined>([
  ["ATTACHMENTS_ALLOW_LAN_INTERNAL", process.env["ATTACHMENTS_ALLOW_LAN_INTERNAL"]],
  ["ATTACHMENTS_INTERNAL_BIND_HOST", process.env["ATTACHMENTS_INTERNAL_BIND_HOST"]],
  ["ATTACHMENTS_INTERNAL_URL", process.env["ATTACHMENTS_INTERNAL_URL"]],
  ["HASNA_ATTACHMENTS_INTERNAL_URL", process.env["HASNA_ATTACHMENTS_INTERNAL_URL"]],
]);

function restoreEnv() {
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  spawnResult = { status: 1, stdout: "" };
  netIfaces = {};
  machineRoute = null;
  machineTopology = null;
  spawnSyncMock.mockClear();
  networkInterfacesMock.mockClear();
  restoreEnv();
});

afterEach(() => {
  restoreEnv();
});

describe("resolveInternalBaseUrl", () => {
  it("uses configured internal base URL first", async () => {
    const cfg = normalizeConfig({
      client: { internalBaseUrl: "http://station.ts.net:3459/" },
      server: { port: 4567 },
    });

    await expect(resolveInternalBaseUrl(cfg)).resolves.toEqual({
      baseUrl: "http://station.ts.net:3459",
      source: "config",
      target: "station.ts.net:3459",
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("uses Tailscale CLI self DNS or IP", async () => {
    spawnResult = {
      status: 0,
      stdout: JSON.stringify({ Self: { DNSName: "spark.ts.net.", TailscaleIPs: ["100.64.10.20"] } }),
    };

    await expect(resolveInternalBaseUrl(normalizeConfig({ server: { port: 3459 } }))).resolves.toEqual({
      baseUrl: "http://spark.ts.net:3459",
      source: "tailscale",
      target: "spark.ts.net",
    });
  });

  it("falls back to open-machines when the route resolves to a Tailscale target", async () => {
    machineRoute = { ok: true, target: "100.64.10.20" };
    machineTopology = { hostname: "localhost" };

    await expect(
      resolveInternalBaseUrl(
        normalizeConfig({
          client: { internalMachineId: "machine-1" },
          server: { port: 4567 },
        }),
      ),
    ).resolves.toEqual({
      baseUrl: "http://100.64.10.20:4567",
      source: "open-machines",
      target: "100.64.10.20",
    });
  });

  it("uses local open-machines topology when an explicit route is absent", async () => {
    machineTopology = { tailscale: { dns_name: "local.ts.net.", ips: ["100.64.1.2"] } };

    await expect(resolveInternalBaseUrl(normalizeConfig({ server: { port: 3459 } }))).resolves.toEqual({
      baseUrl: "http://local.ts.net:3459",
      source: "open-machines",
      target: "local.ts.net.",
    });
  });

  it("ignores malformed Tailscale JSON", async () => {
    spawnResult = { status: 0, stdout: "not-json" };

    await expect(resolveInternalBaseUrl(normalizeConfig({}))).rejects.toThrow("Could not resolve a Tailscale internal address");
  });

  it("uses LAN only when explicitly allowed", async () => {
    process.env["ATTACHMENTS_ALLOW_LAN_INTERNAL"] = "1";
    netIfaces = {
      lo: [{ internal: true, family: "IPv4", address: "127.0.0.1" }],
      eth0: [{ internal: false, family: "IPv4", address: "192.168.1.22" }],
    };

    await expect(resolveInternalBaseUrl(normalizeConfig({ server: { port: 9999 } }))).resolves.toEqual({
      baseUrl: "http://192.168.1.22:9999",
      source: "lan",
      target: "192.168.1.22",
    });
  });

  it("throws when no internal address source is available", async () => {
    await expect(resolveInternalBaseUrl(normalizeConfig({}))).rejects.toThrow("Could not resolve a Tailscale internal address");
  });
});

describe("resolveInternalBindHost", () => {
  it("uses configured bind host and brackets IPv6 hosts in base URL", () => {
    process.env["ATTACHMENTS_INTERNAL_BIND_HOST"] = "fd7a:115c:a1e0::1";

    expect(resolveInternalBindHost(normalizeConfig({ server: { port: 3459 } }))).toEqual({
      host: "fd7a:115c:a1e0::1",
      source: "config",
      baseUrl: "http://[fd7a:115c:a1e0::1]:3459",
    });
  });

  it("uses Tailscale self IPv4 for bind host and DNS for base URL", () => {
    spawnResult = {
      status: 0,
      stdout: JSON.stringify({ Self: { DNSName: "station.ts.net.", TailscaleIPs: ["100.80.1.2"] } }),
    };

    expect(resolveInternalBindHost(normalizeConfig({ server: { port: 3459 } }))).toEqual({
      host: "100.80.1.2",
      source: "tailscale",
      baseUrl: "http://station.ts.net:3459",
    });
  });

  it("throws when no bind source is available", () => {
    expect(() => resolveInternalBindHost(normalizeConfig({}))).toThrow("Could not resolve a Tailscale bind address");
  });

  it("ignores malformed Tailscale self JSON", () => {
    spawnResult = { status: 0, stdout: "not-json" };

    expect(() => resolveInternalBindHost(normalizeConfig({}))).toThrow("Could not resolve a Tailscale bind address");
  });
});
