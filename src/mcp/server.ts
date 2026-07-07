#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isStdioMode, resolveMcpHttpPort, startMcpHttpServer } from "./http.js";
import { handleToolCall } from "./tool-handlers.js";
import { getToolsForProfile } from "./tools.js";
import { getMcpVersion } from "./version.js";

export { getToolsForProfile } from "./tools.js";
export { getMcpVersion } from "./version.js";

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

export function buildServer(): Server {
  const server = new Server(
    { name: "attachments-mcp", version: getMcpVersion() },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolsForProfile(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs = {} } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    try {
      const result = await handleToolCall(name, args);

      return {
        content: [
          {
            type: "text" as const,
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/** @deprecated Use buildServer() */
export const createServer = buildServer;

function hasFlag(...flags: string[]): boolean {
  return process.argv.some((arg) => flags.includes(arg));
}

function printHelp(): void {
  process.stdout.write(
    `Usage: attachments-mcp [options]

Attachments MCP server (stdio transport by default)

Options:
  --http           Serve MCP over Streamable HTTP (127.0.0.1)
  --port <number>  HTTP port (default: 8800, env: MCP_HTTP_PORT)
  -h, --help       Show help
  -V, --version    Show version
`,
  );
}

async function main(): Promise<void> {
  if (hasFlag("--help", "-h")) {
    printHelp();
    return;
  }

  if (hasFlag("--version", "-V")) {
    process.stdout.write(`${getMcpVersion()}\n`);
    return;
  }

  if (isStdioMode()) {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  // Default: shared Streamable HTTP server (one process per MCP, many agents).
  const handle = await startMcpHttpServer(buildServer, {
    port: resolveMcpHttpPort(),
  });
  process.on("SIGINT", () => {
    void handle.close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void handle.close().finally(() => process.exit(0));
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  main().catch((error) => {
    console.error("MCP server error:", error);
    process.exit(1);
  });
}
