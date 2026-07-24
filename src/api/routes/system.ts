import type { Hono } from "hono";
import { AttachmentsDB } from "../../core/db";
import {
  getConfig,
  getPublicBaseUrl,
  hasS3Config,
  resolveStorageBackend,
} from "../../core/config";
import { buildDeploymentPlan } from "../../core/deployment";
import { computeReport } from "../../cli/commands/report";
import { getApiToken } from "../auth";

function deploymentPlan() {
  const config = getConfig();
  return {
    ...buildDeploymentPlan(config),
    storage_backend: resolveStorageBackend(config),
  };
}

export function registerSystemRoutes(app: Hono): void {
  app.get("/api/health", (c) => {
    const db = new AttachmentsDB();
    try {
      const all = db.findAll({ includeExpired: true });
      const expired = all.filter(a => a.expiresAt !== null && a.expiresAt <= Date.now()).length;
      const config = (() => { try { return getConfig(); } catch { return null; } })();
      return c.json({
        status: "ok",
        attachments: all.length,
        expired,
        s3_configured: config ? hasS3Config(config) : false,
        api_auth_required: !!getApiToken(),
        storage_backend: config ? resolveStorageBackend(config) : "local",
        public_base_url: config ? getPublicBaseUrl(config) : `http://localhost:3459`,
        public_path: config?.server?.publicPath ?? "/a",
        server: config?.server?.baseUrl ?? `http://localhost:${config?.server?.port ?? 3459}`,
        timestamp: new Date().toISOString(),
      });
    } finally {
      db.close();
    }
  });

  app.get("/api/deployment", (c) => c.json(deploymentPlan()));

  app.get("/api/context", (c) => {
    const db = new AttachmentsDB();
    try {
      const all = db.findAll({ includeExpired: true });
      const active = all.filter(a => !a.expiresAt || a.expiresAt > Date.now());
      const expiringSoon = all.filter(a => a.expiresAt && a.expiresAt > Date.now() && a.expiresAt - Date.now() < 24 * 60 * 60 * 1000);
      const expired = all.filter(a => a.expiresAt && a.expiresAt <= Date.now());
      const lines: string[] = [`Attachments: ${all.length} total (${active.length} active, ${expired.length} expired)`];
      if (expiringSoon.length > 0) lines.push(`⚠ Expiring in 24h: ${expiringSoon.length} (${expiringSoon.map(a => a.filename).join(", ")})`);
      if (all.length > 0) {
        const recent = all.slice(0, 3).map(a => `${a.filename} (${a.id})`).join(", ");
        lines.push(`Recent: ${recent}`);
      }
      const format = c.req.query("format") ?? "text";
      if (format === "json") return c.json({ attachments: all.length, active: active.length, expired: expired.length, expiring_soon: expiringSoon.length, summary: lines.join("\n") });
      return c.text(lines.join("\n"));
    } finally {
      db.close();
    }
  });

  app.get("/api/report", (c) => {
    const days = parseInt(c.req.query("days") ?? "7", 10);
    const tag = c.req.query("tag") || undefined;

    if (isNaN(days) || days < 1) {
      return c.json({ error: "days must be a positive integer" }, 400);
    }

    const nowMs = Date.now();
    const sinceMs = nowMs - days * 24 * 60 * 60 * 1000;
    const db = new AttachmentsDB();
    let all;
    try {
      all = db.findAll({ includeExpired: true, tag });
    } finally {
      db.close();
    }
    return c.json(computeReport(all, sinceMs, nowMs));
  });
}
