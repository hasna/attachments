#!/usr/bin/env bun
/**
 * `attachments-serve` — the cloud HTTP service entrypoint.
 *
 * PURE REMOTE (Amendment A1): reads/writes the shared RDS Postgres directly via
 * the vendored storage kit; object bytes live in S3. No sync engine, cache, or
 * local database in the service.
 *
 * Usage:
 *   attachments-serve            Run migrations (idempotent) then serve.
 *   attachments-serve migrate    Run migrations and exit (one-shot task).
 *   attachments-serve --no-migrate  Serve without running migrations on boot.
 */

import { createServerPoolFromEnv } from "../generated/storage-kit/pool.js";
import { MigrationLedger } from "../generated/storage-kit/migrations.js";
import type { TypedQueryClient } from "../generated/storage-kit/query.js";
import { ApiKeyStore } from "@hasna/contracts/auth";
import { resolveStorageMode } from "../generated/storage-kit/mode.js";
import { normalizeConfig, type AttachmentsConfig, type DeepPartial } from "../core/config.js";
import { ATTACHMENTS_MIGRATIONS } from "../db/migrations.js";
import { PgAttachmentsStore } from "../db/pg-store.js";
import { createServeApp } from "./app.js";

const APP_SLUG = "attachments";

function resolveSigningSecret(): string {
  const secret =
    process.env.HASNA_ATTACHMENTS_API_SIGNING_KEY?.trim() ||
    process.env.HASNA_API_SIGNING_KEY?.trim() ||
    "";
  if (!secret) {
    throw new Error(
      "Missing API signing secret. Set HASNA_ATTACHMENTS_API_SIGNING_KEY (or HASNA_API_SIGNING_KEY).",
    );
  }
  return secret;
}

function buildConfigFromEnv(): AttachmentsConfig {
  const bucket = process.env.ATTACHMENTS_S3_BUCKET?.trim() || "";
  const region =
    process.env.ATTACHMENTS_S3_REGION?.trim() || process.env.AWS_REGION?.trim() || "us-east-1";
  const publicBaseUrl =
    process.env.ATTACHMENTS_PUBLIC_BASE_URL?.trim() ||
    process.env.ATTACHMENTS_BASE_URL?.trim() ||
    "";
  const partial: DeepPartial<AttachmentsConfig> = {
    s3: {
      bucket,
      region,
      accessKeyId: process.env.ATTACHMENTS_S3_ACCESS_KEY_ID?.trim() || "",
      secretAccessKey: process.env.ATTACHMENTS_S3_SECRET_ACCESS_KEY?.trim() || "",
      ...(process.env.ATTACHMENTS_S3_ENDPOINT ? { endpoint: process.env.ATTACHMENTS_S3_ENDPOINT } : {}),
    },
    storage: {
      backend: bucket ? "s3" : "local",
      maxSizeBytes: process.env.ATTACHMENTS_MAX_SIZE
        ? parseInt(process.env.ATTACHMENTS_MAX_SIZE, 10)
        : 10 * 1024 * 1024 * 1024,
    },
    server: {
      port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3459,
      host: "0.0.0.0",
      baseUrl: publicBaseUrl || `http://0.0.0.0:${process.env.PORT ?? 3459}`,
      publicPath: "/a",
    },
    defaults: { linkType: bucket ? "presigned" : "server" },
    ...(publicBaseUrl
      ? { domains: [{ hostname: new URL(publicBaseUrl).host, baseUrl: publicBaseUrl, primary: true }] }
      : {}),
  };
  return normalizeConfig(partial);
}

async function runMigrations(client: TypedQueryClient) {
  const ledger = new MigrationLedger(client, ATTACHMENTS_MIGRATIONS);
  const result = await ledger.migrate();
  const applied = result.plan.filter((p) => p.state === "pending").length;
  console.log(`[migrate] ledger ok — ${result.applied.length} total, ${applied} newly applied`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const migrateOnly = args.includes("migrate");
  const skipMigrate = args.includes("--no-migrate") || process.env.ATTACHMENTS_SKIP_MIGRATE === "1";

  const modeResolution = resolveStorageMode(APP_SLUG);
  const { client, connectionSource } = createServerPoolFromEnv(APP_SLUG, {
    applicationName: "attachments-serve",
  });

  if (migrateOnly) {
    await runMigrations(client);
    await client.close();
    return;
  }

  if (!skipMigrate) {
    await runMigrations(client);
  }

  const signingSecret = resolveSigningSecret();
  const config = buildConfigFromEnv();
  const store = new PgAttachmentsStore(client);
  const keyStore = new ApiKeyStore(client);
  const version = process.env.ATTACHMENTS_VERSION || (await import("../../package.json")).version;

  const app = createServeApp({
    client,
    store,
    config,
    version,
    mode: modeResolution.mode,
    signingSecret,
    isRevoked: keyStore.isRevoked,
    audit: (e) => console.log("[api_auth]", JSON.stringify(e)),
  });

  const port = config.server.port;
  const hostname = config.server.host;
  Bun.serve({ port, hostname, fetch: app.fetch, idleTimeout: 120 });
  console.log(
    `attachments-serve listening on http://${hostname}:${port} (mode=${modeResolution.mode}, db_source=${connectionSource})`,
  );

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("[attachments-serve] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
