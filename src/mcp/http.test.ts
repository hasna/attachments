import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./server.js";
import {
  DEFAULT_MCP_HTTP_PORT,
  isHttpMode,
  resolveMcpHttpPort,
  startMcpHttpServer,
} from "./http.js";

describe("mcp http transport", () => {
  test("defaults port to 8850", () => {
    expect(DEFAULT_MCP_HTTP_PORT).toBe(8850);
    expect(resolveMcpHttpPort(["node"], {})).toBe(8850);
    expect(resolveMcpHttpPort(["node", "--port", "9001"], {})).toBe(9001);
    expect(resolveMcpHttpPort(["node"], { MCP_HTTP_PORT: "9002" })).toBe(9002);
  });

  test("isHttpMode detects flag and env", () => {
    expect(isHttpMode(["node"], {})).toBe(false);
    expect(isHttpMode(["node", "--http"], {})).toBe(true);
    expect(isHttpMode(["node"], { MCP_HTTP: "1" })).toBe(true);
  });
});

describe("mcp buildServer stdio registration", () => {
  test("registers tools over in-memory transport", async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "upload_attachment")).toBe(true);

    await client.close();
    await server.close();
  });
});

describe("mcp streamable http server", () => {
  let handle: Awaited<ReturnType<typeof startMcpHttpServer>>;
  let idleRssMb = 0;

  beforeAll(async () => {
    handle = await startMcpHttpServer(buildServer, { port: 0 });
    await Bun.sleep(100);
    idleRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  });

  afterAll(async () => {
    await handle.close();
  });

  test("GET /health returns ok", async () => {
    const res = await fetch(`http://${handle.host}:${handle.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", name: "attachments" });
  });

  test("initialize and call describe_tools over streamable HTTP", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${handle.host}:${handle.port}/mcp`),
    );
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "upload_attachment")).toBe(true);

    const result = await client.callTool({
      name: "describe_tools",
      arguments: { tool_name: "upload_attachment" },
    });
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);

    await client.close();
  });

  test("serves three concurrent clients from one process", async () => {
    const clients = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://${handle.host}:${handle.port}/mcp`),
        );
        const client = new Client({ name: "test", version: "0.0.0" });
        await client.connect(transport);
        const tools = await client.listTools();
        return { client, count: tools.tools.length };
      }),
    );

    expect(clients.every((entry) => entry.count > 0)).toBe(true);
    await Promise.all(clients.map((entry) => entry.client.close()));
  });

  test("idle RSS is stable after startup", () => {
    const currentRssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    expect(idleRssMb).toBeGreaterThan(0);
    expect(Math.abs(currentRssMb - idleRssMb)).toBeLessThan(100);
  });
});
