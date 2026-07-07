import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { checkHealth, checkReady } from "./storage-kit/health";
import {
  checksumSql,
  createMigrationLedger,
  defineMigration,
  MigrationLedger,
  type AppliedMigration,
} from "./storage-kit/migrations";
import {
  envToken,
  normalizeStorageMode,
  resolveDatabaseUrl,
  resolveStorageMode,
  storageEnvKeys,
} from "./storage-kit/mode";
import { createQueryClient, wrapExecutor } from "./storage-kit/query";

const STORAGE_ENV_NAMES = [
  "HASNA_ATTACHMENTS_DATABASE_URL",
  "ATTACHMENTS_DATABASE_URL",
  "HASNA_ATTACHMENTS_STORAGE_MODE",
  "ATTACHMENTS_STORAGE_MODE",
] as const;

function clearStorageEnv(): void {
  for (const name of STORAGE_ENV_NAMES) delete process.env[name];
}

beforeEach(() => {
  clearStorageEnv();
});

afterEach(() => {
  clearStorageEnv();
});

function ledgerClient(applied: AppliedMigration[] = []) {
  const rows = [...applied];
  const executed: Array<{ sql: string; params?: readonly unknown[] }> = [];
  return {
    executed,
    client: {
      execute: mock(async (sql: string, params?: readonly unknown[]) => {
        executed.push({ sql, params });
        if (sql.startsWith("INSERT INTO")) {
          rows.push({
            id: String(params?.[0]),
            checksum: String(params?.[1]),
            appliedAt: "2026-01-01T00:00:00.000Z",
          });
        }
      }),
      many: mock(async () => rows),
    },
  };
}

describe("generated storage kit mode helpers", () => {
  it("normalizes supported, deprecated, and invalid storage modes", () => {
    expect(normalizeStorageMode(" LOCAL ")).toEqual({ mode: "local", deprecatedAlias: null });
    expect(normalizeStorageMode("cloud")).toEqual({ mode: "cloud", deprecatedAlias: null });
    expect(normalizeStorageMode("self-hosted")).toEqual({ mode: "cloud", deprecatedAlias: "self_hosted" });
    expect(() => normalizeStorageMode("cache")).toThrow("Unknown storage mode");
  });

  it("derives env keys and resolves mode/database env precedence", () => {
    expect(envToken("open-attachments")).toBe("OPEN_ATTACHMENTS");
    expect(storageEnvKeys("attachments")).toEqual({
      modeKeys: ["HASNA_ATTACHMENTS_STORAGE_MODE", "ATTACHMENTS_STORAGE_MODE"],
      databaseUrlKeys: ["HASNA_ATTACHMENTS_DATABASE_URL", "ATTACHMENTS_DATABASE_URL"],
    });

    expect(resolveStorageMode("attachments", {})).toEqual({
      mode: "local",
      source: "default",
      deprecatedAlias: null,
      databaseUrlPresent: false,
      databaseUrlSource: null,
      warning: null,
    });

    const cloudWithoutDatabase = resolveStorageMode("attachments", {
      HASNA_ATTACHMENTS_STORAGE_MODE: "cloud",
    });
    expect(cloudWithoutDatabase.mode).toBe("cloud");
    expect(cloudWithoutDatabase.warning).toContain("needs HASNA_ATTACHMENTS_DATABASE_URL");

    const deprecatedAlias = resolveStorageMode("attachments", {
      ATTACHMENTS_STORAGE_MODE: "remote",
      ATTACHMENTS_DATABASE_URL: "postgres://alias",
    });
    expect(deprecatedAlias).toMatchObject({
      mode: "cloud",
      source: "ATTACHMENTS_STORAGE_MODE",
      deprecatedAlias: "remote",
      databaseUrlPresent: true,
      databaseUrlSource: "ATTACHMENTS_DATABASE_URL",
    });
    expect(deprecatedAlias.warning).toContain("Deprecated storage mode");
    expect(deprecatedAlias.warning).toContain("Using alias env");

    expect(resolveDatabaseUrl("attachments", {
      HASNA_ATTACHMENTS_DATABASE_URL: " postgres://canonical ",
      ATTACHMENTS_DATABASE_URL: "postgres://alias",
    })).toBe("postgres://canonical");
    expect(resolveDatabaseUrl("attachments", {})).toBeNull();
  });
});

describe("generated storage kit query helpers", () => {
  it("wraps an executor with typed query helpers", async () => {
    const executor = {
      query: mock(async (_sql: string, _params?: readonly unknown[]) => ({
        rows: [{ id: 1 }, { id: 2 }],
        rowCount: null,
      })),
    };
    const client = wrapExecutor(executor);

    await expect(client.query("SELECT * FROM items")).resolves.toEqual({
      rows: [{ id: 1 }, { id: 2 }],
      rowCount: 2,
    });
    await expect(client.many("SELECT * FROM items")).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    await expect(client.get("SELECT * FROM items")).resolves.toEqual({ id: 1 });
    await expect(client.execute("VACUUM")).resolves.toBeUndefined();

    executor.query.mockImplementationOnce(async () => ({ rows: [{ id: 1 }], rowCount: 1 }));
    await expect(client.one("SELECT 1")).resolves.toEqual({ id: 1 });
    executor.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
    await expect(client.one("SELECT 1")).rejects.toThrow("Expected exactly one row, got 0.");
    executor.query.mockImplementationOnce(async () => ({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }));
    await expect(client.one("SELECT 1")).rejects.toThrow("Expected exactly one row, got 2.");
  });

  it("runs pool transactions with commit, rollback, and close handling", async () => {
    const calls: string[] = [];
    const client = {
      query: mock(async (sql: string) => {
        calls.push(sql);
        return { rows: [{ ok: true }], rowCount: 1 };
      }),
      release: mock(() => calls.push("release")),
    };
    const pool = {
      query: mock(async () => ({ rows: [], rowCount: 0 })),
      connect: mock(async () => client),
      end: mock(async () => calls.push("end")),
    };
    const queryClient = createQueryClient(pool as never);

    await expect(queryClient.transaction(async (tx) => tx.one("SELECT ok"))).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["BEGIN", "SELECT ok", "COMMIT", "release"]);

    calls.length = 0;
    await expect(queryClient.transaction(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(calls).toEqual(["BEGIN", "ROLLBACK", "release"]);

    calls.length = 0;
    client.query.mockImplementationOnce(async (sql: string) => {
      calls.push(sql);
      return { rows: [], rowCount: 0 };
    }).mockImplementationOnce(async () => {
      throw new Error("rollback failed");
    });
    await expect(queryClient.transaction(async () => {
      throw new Error("original");
    })).rejects.toThrow("original");
    expect(calls).toEqual(["BEGIN", "release"]);

    await queryClient.close();
    expect(calls).toContain("end");
  });
});

describe("generated storage kit migration helpers", () => {
  it("checksums and freezes migration definitions", () => {
    const checksum = checksumSql("\r\nSELECT 1;\r\n");
    expect(checksum).toStartWith("sha256:");

    const migration = defineMigration("001_init", "\nSELECT 1;\n");
    expect(Object.isFrozen(migration)).toBe(true);
    expect(migration.sql).toBe("SELECT 1;");
    expect(migration.checksum).toBe(checksumSql("SELECT 1;"));
  });

  it("plans, applies, and lists migrations", async () => {
    const migration = defineMigration("001_init", "CREATE TABLE example(id text)");
    const { client, executed } = ledgerClient();
    const ledger = createMigrationLedger(client as never, [migration], { ledgerTable: "custom_migrations" });

    await expect(ledger.migrate({ dryRun: true })).resolves.toMatchObject({
      dryRun: true,
      applied: [],
      plan: [{ migration, state: "pending" }],
    });

    const result = await ledger.migrate();
    expect(result.dryRun).toBe(false);
    expect(result.plan).toEqual([{ migration, state: "pending" }]);
    expect(executed.some((entry) => entry.sql.includes("CREATE TABLE IF NOT EXISTS custom_migrations"))).toBe(true);
    expect(executed.some((entry) => entry.sql === migration.sql)).toBe(true);
    await expect(ledger.listApplied()).resolves.toHaveLength(1);
  });

  it("reports already-applied migrations and rejects drift", async () => {
    const migration = defineMigration("001_init", "SELECT 1");
    const applied = [{ id: migration.id, checksum: migration.checksum, appliedAt: "2026-01-01T00:00:00.000Z" }];
    const { client } = ledgerClient(applied);
    const ledger = new MigrationLedger(client as never, [migration]);

    await expect(ledger.migrate({ dryRun: true })).resolves.toMatchObject({
      plan: [{ migration, state: "already_applied" }],
    });

    const drift = ledgerClient([{ ...applied[0], checksum: "sha256:different" }]);
    await expect(new MigrationLedger(drift.client as never, [migration]).migrate({ dryRun: true }))
      .rejects.toThrow("Migration checksum mismatch");

    const unknown = ledgerClient([{ id: "000_old", checksum: "sha256:old", appliedAt: "2026-01-01T00:00:00.000Z" }]);
    await expect(new MigrationLedger(unknown.client as never, [migration]).migrate({ dryRun: true }))
      .rejects.toThrow("not recognized");

    expect(() => new MigrationLedger(client as never, [migration, migration])).toThrow("Duplicate migration id");
  });
});

describe("generated storage kit health helpers", () => {
  it("checks database health without throwing", async () => {
    const healthy = { get: mock(async () => ({ ok: 1 })) };
    await expect(checkHealth(healthy as never)).resolves.toMatchObject({ ok: true });

    const unhealthy = { get: mock(async () => { throw new Error("database down"); }) };
    await expect(checkHealth(unhealthy as never)).resolves.toMatchObject({
      ok: false,
      error: "database down",
    });
  });

  it("checks readiness from migration dry runs", async () => {
    const migration = defineMigration("001_init", "SELECT 1");
    const pending = ledgerClient();
    await expect(checkReady(pending.client as never, [migration])).resolves.toMatchObject({
      ok: false,
      pendingMigrations: ["001_init"],
    });

    const applied = ledgerClient([{ id: migration.id, checksum: migration.checksum, appliedAt: "2026-01-01T00:00:00.000Z" }]);
    await expect(checkReady(applied.client as never, [migration])).resolves.toMatchObject({
      ok: true,
      pendingMigrations: [],
    });

    const broken = {
      execute: mock(async () => {}),
      many: mock(async () => {
        throw new Error("ledger unavailable");
      }),
    };
    await expect(checkReady(broken as never, [migration])).resolves.toMatchObject({
      ok: false,
      pendingMigrations: [],
      error: "ledger unavailable",
    });
  });
});
