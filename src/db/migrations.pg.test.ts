/**
 * Live-PostgreSQL coverage for ATTACHMENTS_MIGRATIONS — the gate declared in
 * hasna.contract.json (storage.pgTestGate).
 *
 * `attachments-serve` runs these migrations on boot (src/serve/index.ts) and
 * gates /ready on them (src/serve/app.ts), and the api_keys half of them ships
 * from @hasna/contracts, so a dependency bump silently changes this schema.
 * Nothing here is stubbed: a run without a reachable database fails.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkHealth, checkReady } from "../generated/storage-kit/health.js";
import { MigrationLedger, defineMigration } from "../generated/storage-kit/migrations.js";
import { ATTACHMENTS_MIGRATIONS } from "./migrations.js";
import {
  LIVE_PG_ENABLED,
  LIVE_PG_URL_ENV,
  REQUIRE_PG_ENV,
  createLiveSchema,
  resolveLivePgGate,
  withSearchPath,
  type LiveSchema,
} from "./pg-live.test-harness.test.js";

/** A closed port: nothing listens on 127.0.0.1:1. */
const UNREACHABLE_DATABASE_URL = "postgres://nobody:nope@127.0.0.1:1/doesnotexist";

const repoRoot = join(import.meta.dir, "..", "..");

describe("live-PostgreSQL gate wiring", () => {
  it("is the command hasna.contract.json declares", () => {
    const gate = JSON.parse(readFileSync(join(repoRoot, "hasna.contract.json"), "utf8")).storage
      ?.pgTestGate;

    expect(gate?.envVar).toBe(LIVE_PG_URL_ENV);
    // Point the gate at the tests that connect. `src/serve` runs entirely on
    // InMemoryAttachmentsStore, so including it inflates the pass count without
    // touching Postgres.
    expect(gate?.command).toContain("bun test src/db");
    expect(gate?.command).not.toContain("src/serve");
    // `${VAR:?...}` makes the shell fail when the operator forgot the database,
    // and the flag makes the tests themselves refuse to skip.
    expect(gate?.command).toContain(`\${${LIVE_PG_URL_ENV}:?`);
    expect(gate?.command).toContain(`${REQUIRE_PG_ENV}=1`);
  });

  it("fails, rather than skipping, when engaged without a database", () => {
    expect(() => resolveLivePgGate({ [REQUIRE_PG_ENV]: "1" })).toThrow(
      /refuses to report a pass without a database/,
    );
    expect(resolveLivePgGate({})).toEqual({ url: null, required: false });
    expect(resolveLivePgGate({ [LIVE_PG_URL_ENV]: " postgres://x/y ", [REQUIRE_PG_ENV]: "1" })).toEqual({
      url: "postgres://x/y",
      required: true,
    });
  });

  it("fails against an unreachable database", async () => {
    // The whole point: exit status must differ with and without a live server.
    await expect(createLiveSchema("unreachable", UNREACHABLE_DATABASE_URL)).rejects.toThrow();
  }, 30_000);

  it("scopes each run to its own schema through the connection string", () => {
    const scoped = withSearchPath("postgres://u:p@host:5432/db?sslmode=require", "att_gate_x");
    expect(new URL(scoped).searchParams.get("options")).toBe("-c search_path=att_gate_x");
    expect(new URL(scoped).searchParams.get("sslmode")).toBe("require");
  });
});

describe.skipIf(!LIVE_PG_ENABLED)("ATTACHMENTS_MIGRATIONS against live PostgreSQL", () => {
  let live: LiveSchema;

  beforeAll(async () => {
    live = await createLiveSchema("migrations");
  });

  afterAll(async () => {
    await live?.drop();
  });

  it("reaches the database", async () => {
    const health = await checkHealth(live.client);
    expect(health.error).toBeUndefined();
    expect(health.ok).toBe(true);
  });

  it("applies every declared migration, api_keys included", async () => {
    const result = await new MigrationLedger(live.client, ATTACHMENTS_MIGRATIONS).migrate();

    expect(result.plan.map((item) => item.state)).toEqual(ATTACHMENTS_MIGRATIONS.map(() => "pending"));
    expect(result.applied.map((row) => row.id)).toEqual(
      ATTACHMENTS_MIGRATIONS.map((migration) => migration.id).sort(),
    );
    expect(result.applied.map((row) => row.id)).toContain("hasna_auth_0003_api_keys_tenant");
  }, 60_000);

  it("creates the api_keys.tid column the @hasna/contracts bump introduces", async () => {
    // hasna_auth_0003 arrived with the 0.5.2 -> 0.8.2 bump in this PR and flows
    // into ATTACHMENTS_MIGRATIONS; /ready reports not_ready until it applies.
    const column = await live.client.get<{ data_type: string }>(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'api_keys' AND column_name = 'tid'`,
      [live.schema],
    );
    expect(column?.data_type).toBe("text");

    const index = await live.client.get<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = 'api_keys_tid_idx'`,
      [live.schema],
    );
    expect(index?.indexname).toBe("api_keys_tid_idx");
  });

  it("reports ready with nothing pending and is idempotent on re-run", async () => {
    const ready = await checkReady(live.client, ATTACHMENTS_MIGRATIONS);
    expect(ready.error).toBeUndefined();
    expect(ready.pendingMigrations).toEqual([]);
    expect(ready.ok).toBe(true);

    const rerun = await new MigrationLedger(live.client, ATTACHMENTS_MIGRATIONS).migrate();
    expect(rerun.plan.map((item) => item.state)).toEqual(
      ATTACHMENTS_MIGRATIONS.map(() => "already_applied"),
    );
  }, 60_000);

  it("refuses a migration whose SQL changed after it was applied", async () => {
    // The ledger's checksum guard is what makes a contracts bump safe; it is
    // only real if the checksums were persisted in Postgres.
    const drifted = ATTACHMENTS_MIGRATIONS.map((migration, index) =>
      index === 0 ? defineMigration(migration.id, `${migration.sql} -- drift`) : migration,
    );
    await expect(new MigrationLedger(live.client, drifted).migrate()).rejects.toThrow(
      /checksum mismatch/,
    );
  });
});
