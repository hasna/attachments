/**
 * Harness for the live-PostgreSQL gate declared in hasna.contract.json
 * (storage.pgTestGate).
 *
 * These are the only tests in the repo that open a real Postgres connection.
 * Everything under src/serve runs against `InMemoryAttachmentsStore`, so it
 * proves nothing about migrations.ts or pg-store.ts — the two modules that are
 * the entire reason `postgres` is a declared storage engine.
 *
 * Isolation: each run gets its own schema, scoped through the connection
 * string's libpq `options=-c search_path=…`, so HASNA_ATTACHMENTS_TEST_DATABASE_URL
 * may point at a shared throwaway database without runs colliding, and teardown
 * drops only what the run created.
 *
 * The gate must not be able to pass without a database:
 *   - URL set                                   -> connect for real; an
 *     unreachable database fails the suite.
 *   - URL unset, ATTACHMENTS_REQUIRE_POSTGRES=1 -> throw. The declared gate
 *     command exports that flag, so a vacuous green run is impossible.
 *   - URL unset, flag unset                     -> skip loudly, so `bun run
 *     test` stays green on a machine with no Postgres.
 *
 * Named `*.test-harness.test.ts` to match the existing convention in this repo
 * (the runner tolerates a file with no tests).
 */

import { randomBytes } from "node:crypto";
import { createPgPool, createServerPoolFromEnv } from "../generated/storage-kit/pool.js";
import { createQueryClient, type PoolQueryClient } from "../generated/storage-kit/query.js";

const APP_SLUG = "attachments";

/** Env var an operator points at a throwaway Postgres to run the gate. */
export const LIVE_PG_URL_ENV = "HASNA_ATTACHMENTS_TEST_DATABASE_URL";
/** Set to `1` by the declared gate command: a missing database is then a failure, not a skip. */
export const REQUIRE_PG_ENV = "ATTACHMENTS_REQUIRE_POSTGRES";

export interface LivePgGate {
  /** Connection string for the throwaway database, or null when not supplied. */
  url: string | null;
  /** Whether the caller engaged the gate and therefore forbids skipping. */
  required: boolean;
}

/**
 * Resolve the gate from an environment. Throws when the gate is engaged but no
 * database was supplied — the failure mode that stops a gate reporting green
 * against nothing.
 */
export function resolveLivePgGate(env: Record<string, string | undefined>): LivePgGate {
  const url = env[LIVE_PG_URL_ENV]?.trim();
  const required = env[REQUIRE_PG_ENV]?.trim() === "1";
  if (url) return { url, required };
  if (required) {
    throw new Error(
      `${REQUIRE_PG_ENV}=1 but ${LIVE_PG_URL_ENV} is unset: the live-PostgreSQL gate declared in ` +
        `hasna.contract.json (storage.pgTestGate) refuses to report a pass without a database.`,
    );
  }
  return { url: null, required };
}

function announceSkip(): void {
  console.warn(
    `[live-pg] SKIPPED — ${LIVE_PG_URL_ENV} is unset, so src/db/migrations.ts and ` +
      `src/db/pg-store.ts are NOT covered by this run. Point it at a throwaway Postgres ` +
      `to run the gate declared in hasna.contract.json (storage.pgTestGate).`,
  );
}

export const LIVE_PG_GATE: LivePgGate = resolveLivePgGate(process.env);
if (LIVE_PG_GATE.url === null) announceSkip();

/** True when this process has a database and the live suites should run. */
export const LIVE_PG_ENABLED = LIVE_PG_GATE.url !== null;

/** Scope every connection built from this URL to one schema, libpq style. */
export function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

export interface LiveSchema {
  /** Name of the throwaway schema every table in this run lands in. */
  readonly schema: string;
  /** Kit query client bound to that schema, built the way the service builds it. */
  readonly client: PoolQueryClient;
  /** Close the pools and drop the schema. */
  drop(): Promise<void>;
}

/**
 * Create an isolated schema and a kit client scoped to it.
 *
 * The scoped client is built through `createServerPoolFromEnv`, the same
 * entrypoint `attachments-serve` uses, so mode resolution, TLS handling and the
 * pool wiring are all exercised rather than bypassed.
 */
export async function createLiveSchema(label: string, baseUrl?: string): Promise<LiveSchema> {
  const connectionString = baseUrl ?? LIVE_PG_GATE.url;
  if (!connectionString) {
    throw new Error(`createLiveSchema needs ${LIVE_PG_URL_ENV} or an explicit connection string.`);
  }
  const schema = `att_gate_${label}_${randomBytes(6).toString("hex")}`;

  const admin = createQueryClient(
    createPgPool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 10_000,
      applicationName: "attachments-pg-gate-admin",
    }),
  );

  let client: PoolQueryClient | null = null;
  try {
    await admin.execute(`CREATE SCHEMA "${schema}"`);
    client = createServerPoolFromEnv(APP_SLUG, {
      env: {
        ...process.env,
        HASNA_ATTACHMENTS_STORAGE_MODE: "postgres",
        HASNA_ATTACHMENTS_DATABASE_URL: withSearchPath(connectionString, schema),
      },
      max: 4,
      connectionTimeoutMillis: 10_000,
      applicationName: "attachments-pg-gate",
    }).client;
  } catch (error) {
    if (client) await client.close().catch(() => {});
    await admin.close().catch(() => {});
    throw error;
  }

  const scoped = client;
  return {
    schema,
    client: scoped,
    async drop(): Promise<void> {
      await scoped.close().catch(() => {});
      try {
        await admin.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.close().catch(() => {});
      }
    },
  };
}
