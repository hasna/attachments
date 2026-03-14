import { Command } from "commander";
import { startServer } from "../../api/server";
import { getConfig, validateS3Config } from "../../core/config";
import { exitError } from "../utils";

export function registerServe(program: Command): void {
  program
    .command("serve")
    .description("Start the REST API server")
    .option("--port <number>", "Port to listen on (overrides config)")
    .option("--host <string>", "Host to bind to", "localhost")
    .action((options: { port?: string; host?: string }) => {
      // Validate S3 config before starting
      try {
        validateS3Config();
      } catch (err: unknown) {
        exitError(err instanceof Error ? err.message : String(err));
      }

      const config = getConfig();
      const port = options.port ? parseInt(options.port, 10) : config.server.port;
      const host = options.host ?? "localhost";

      if (isNaN(port) || port <= 0 || port > 65535) {
        exitError(`Invalid port: ${options.port}`);
      }

      startServer(port, host);
    });
}
