import { Hono } from "hono";
import { getConfig, getPublicBaseUrl } from "../core/config";
import { requireApiAuth } from "./auth";
import { registerAttachmentRoutes } from "./routes/attachments";
import { registerPublicRoutes } from "./routes/public";
import { registerSystemRoutes } from "./routes/system";

export function createApp(): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const config = getConfig();
    const forwardedProto = c.req.header("x-forwarded-proto");
    if (forwardedProto === "https" || config.server.baseUrl.startsWith("https://") || getPublicBaseUrl(config).startsWith("https://")) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (c.req.path.startsWith("/a/") || c.req.path.startsWith(config.server.publicPath.replace(/\/+$/, "") + "/")) {
      c.header("Cache-Control", "no-store");
    }
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") {
      await next();
      return;
    }
    const unauthorized = requireApiAuth(c);
    if (unauthorized) return unauthorized;
    await next();
  });

  registerSystemRoutes(app);
  registerAttachmentRoutes(app);
  registerPublicRoutes(app);

  return app;
}

const activeServers: unknown[] = [];

export function startServer(port: number, hostname = "localhost"): void {
  const app = createApp();
  const config = getConfig();
  const resolvedPort = port ?? config.server.port;
  const resolvedHostname = hostname ?? config.server.host;

  if (typeof Bun !== "undefined") {
    const server = Bun.serve({
      port: resolvedPort,
      hostname: resolvedHostname,
      fetch: app.fetch,
    });
    activeServers.push(server);
    console.log(`Attachments server running on http://${resolvedHostname}:${resolvedPort}`);
  } else {
    import("@hono/node-server").then(({ serve }) => {
      const server = serve({ fetch: app.fetch, port: resolvedPort, hostname: resolvedHostname });
      activeServers.push(server);
      console.log(`Attachments server running on http://${resolvedHostname}:${resolvedPort}`);
    });
  }
}
