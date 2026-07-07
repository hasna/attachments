import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setConfigPath } from "../../core/config";
import { domainCommand } from "./domain";

const TEST_DIR = join(tmpdir(), `attachments-domain-test-${Date.now()}`);
const TEST_CONFIG_PATH = join(TEST_DIR, "config.json");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setConfigPath(TEST_CONFIG_PATH);
  if (existsSync(TEST_CONFIG_PATH)) rmSync(TEST_CONFIG_PATH);
  process.exitCode = 0;
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  process.exitCode = 0;
});

async function runDomainCommand(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  program.addCommand(domainCommand());

  const chunks: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });

  try {
    await program.parseAsync(["domain", ...args], { from: "user" });
  } finally {
    stdout.mockRestore();
  }

  return chunks.join("");
}

async function captureDomainCommand(args: string[]): Promise<{ out: string; err: string }> {
  const program = new Command();
  program.exitOverride();
  program.addCommand(domainCommand());

  const out: string[] = [];
  const err: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });

  try {
    await program.parseAsync(["domain", ...args], { from: "user" });
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }

  return { out: out.join(""), err: err.join("") };
}

describe("domain command", () => {
  it("stores path-routing origins and prints a Cloudflare route plan", async () => {
    await runDomainCommand([
      "configure",
      "--hostname",
      "has.na",
      "--base-url",
      "https://has.na",
      "--path-prefix",
      "/a",
      "--provider",
      "cloudflare",
      "--managed-by",
      "external",
      "--attachments-origin",
      "https://attachments-origin.example.com/",
      "--fallback-origin",
      "https://shortlinks-origin.example.com/",
    ]);

    const output = await runDomainCommand(["plan", "--format", "cloudflare"]);
    const plan = JSON.parse(output);

    expect(plan.public_route).toBe("https://has.na/a/:token");
    expect(plan.route_patterns[0]).toMatchObject({
      pattern: "has.na/a/*",
      origin: "https://attachments-origin.example.com",
    });
    expect(plan.route_patterns[1]).toMatchObject({
      pattern: "has.na/*",
      origin: "https://shortlinks-origin.example.com",
    });
    expect(plan.missing).toEqual([]);
  });

  it("stores DNS metadata and prints an opendomains plan", async () => {
    await runDomainCommand([
      "configure",
      "--hostname",
      "files.example.com",
      "--path-prefix",
      "files/",
      "--provider",
      "cloudflare",
      "--managed-by",
      "opendomains",
      "--zone",
      "example.com",
      "--record",
      "CNAME",
      "--name",
      "files",
      "--target",
      "lb.example.com",
      "--proxied",
      "--shortlinks-origin",
      "https://short.example.com/",
    ]);

    const output = await runDomainCommand(["plan", "--format", "opendomains"]);
    const plan = JSON.parse(output);
    expect(plan.tool).toBe("opendomains");
    expect(plan.health_url).toBe("https://files.example.com/api/health");
    expect(plan.public_route).toBe("https://files.example.com/files/:token");
    expect(plan.records[0]).toMatchObject({ recordType: "CNAME", name: "files", target: "lb.example.com", proxied: true });
  });

  it("reports a missing attachments origin when only the domain is configured", async () => {
    await runDomainCommand([
      "configure",
      "--hostname",
      "has.na",
      "--base-url",
      "https://has.na",
      "--path-prefix",
      "/a",
      "--provider",
      "cloudflare",
    ]);

    const output = await runDomainCommand(["plan", "--format", "json"]);
    const plan = JSON.parse(output);

    expect(plan.routing.attachment_route_pattern).toBe("has.na/a/*");
    expect(plan.routing.missing).toContain("deployment.routing.attachmentsOrigin");
  });

  it("verify detects a shortlinks slug-a response", async () => {
    await runDomainCommand([
      "configure",
      "--hostname",
      "has.na",
      "--base-url",
      "https://has.na",
      "--path-prefix",
      "/a",
      "--provider",
      "cloudflare",
    ]);

    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(mock(async () => new Response(
      JSON.stringify({ error: "Shortlink not found.", slug: "a", host: "has.na" }),
      { status: 404, headers: { "content-type": "application/json; charset=utf-8" } }
    )));

    try {
      const output = await runDomainCommand(["verify", "--format", "json"]);
      const result = JSON.parse(output);

      expect(result.ok).toBe(false);
      expect(result.service).toBe("shortlinks");
      expect(result.reason).toContain("shortlinks app");
      expect(process.exitCode).toBe(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("verify accepts the attachments unavailable page", async () => {
    await runDomainCommand([
      "configure",
      "--hostname",
      "has.na",
      "--base-url",
      "https://has.na",
      "--path-prefix",
      "/a",
      "--provider",
      "cloudflare",
    ]);

    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(mock(async () => new Response(
      "<html><h1>Attachment unavailable</h1><p>Share link not found</p></html>",
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }
    )));

    try {
      const output = await runDomainCommand(["verify", "--format", "json"]);
      const result = JSON.parse(output);

      expect(result.ok).toBe(true);
      expect(result.service).toBe("attachments");
      expect(process.exitCode).toBe(0);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects invalid plan and verify options", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    try {
      await expect(captureDomainCommand(["plan", "--format", "yaml"])).rejects.toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
    }

    const timeoutResult = await captureDomainCommand(["verify", "--timeout", "0"]);
    expect(timeoutResult.err).toContain("--timeout");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    const formatResult = await captureDomainCommand(["verify", "--format", "xml"]);
    expect(formatResult.err).toContain("--format must be human or json");
    expect(process.exitCode).toBe(1);
  });

  it("verify reports probe failures in human output", async () => {
    await runDomainCommand([
      "configure",
      "--hostname",
      "has.na",
      "--base-url",
      "https://has.na",
      "--path-prefix",
      "/a",
      "--provider",
      "cloudflare",
    ]);

    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(mock(async () => {
      throw new Error("network down");
    }));

    try {
      const output = await runDomainCommand(["verify"]);
      expect(output).toContain("FAIL: Probe failed: network down");
      expect(output).toContain("Required route:");
      expect(process.exitCode).toBe(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("verify prints ok human output", async () => {
    await runDomainCommand(["configure", "--hostname", "has.na"]);

    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(mock(async () => new Response(
      "<html><h1>Attachment unavailable</h1></html>",
      { status: 404, headers: { "content-type": "text/html" } },
    )));

    try {
      const output = await runDomainCommand(["verify"]);
      expect(output).toContain("OK:");
      expect(process.exitCode).toBe(0);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
