import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const ENV_NAMES = [
  "HASNA_ATTACHMENTS_DATABASE_URL",
  "ATTACHMENTS_DATABASE_URL",
  "HASNA_ATTACHMENTS_STORAGE_MODE",
  "ATTACHMENTS_STORAGE_MODE",
] as const;

type Row = Record<string, unknown>;

let localRows: Record<string, Row[]>;
let localColumns: Record<string, string[]>;
let remoteRows: Record<string, Row[]>;
let remoteColumns: Record<string, string[]>;
let localPrepareError: Error | null;
let remoteAllError: Error | null;
const localStatementRuns: unknown[][] = [];
const remoteRunCalls: Array<{ sql: string; params: unknown[] }> = [];
const remoteClose = mock(async () => {});
const localClose = mock(() => {});

function tableFromSelect(sql: string): string {
  const match = /FROM\s+"?([a-z_]+)"?/i.exec(sql);
  return match?.[1] ?? "attachments";
}

function makeLocalDb() {
  return {
    prepare(sql: string) {
      return {
        all() {
          if (localPrepareError) throw localPrepareError;
          if (/PRAGMA table_info/i.test(sql)) {
            const table = /\("([^"]+)"\)/.exec(sql)?.[1] ?? "attachments";
            return (localColumns[table] ?? []).map((name) => ({ name }));
          }
          if (/SELECT \*/i.test(sql)) return localRows[tableFromSelect(sql)] ?? [];
          if (/SELECT table_name/i.test(sql)) return [];
          return [];
        },
        run(...args: unknown[]) {
          localStatementRuns.push(args);
        },
      };
    },
    transaction(fn: (batch: Row[]) => void) {
      return (batch: Row[]) => fn(batch);
    },
    exec: mock((_sql: string) => {}),
  };
}

mock.module("../core/db.js", () => ({
  AttachmentsDB: class MockAttachmentsDB {
    raw = makeLocalDb();
    close = localClose;
  },
}));

mock.module("./remote-storage.js", () => ({
  PgAdapterAsync: class MockPgAdapterAsync {
    constructor(public url: string) {}

    async run(sql: string, ...params: unknown[]) {
      remoteRunCalls.push({ sql, params });
    }

    async all(sql: string, ..._params: unknown[]) {
      if (remoteAllError) throw remoteAllError;
      if (/information_schema\.columns/i.test(sql)) {
        const table = String(_params[0]);
        return (remoteColumns[table] ?? []).map((column_name) => ({ column_name }));
      }
      if (/SELECT \*/i.test(sql)) return remoteRows[tableFromSelect(sql)] ?? [];
      return [];
    }

    close = remoteClose;
  },
}));

const storage = await import("./storage-sync");

function clearEnv() {
  for (const name of ENV_NAMES) delete process.env[name];
}

beforeEach(() => {
  clearEnv();
  localRows = {
    attachments: [{ id: "att_1", filename: "a.txt", ignored: "x" }],
    share_links: [],
    feedback: [],
  };
  localColumns = {
    attachments: ["id", "filename"],
    share_links: ["id"],
    feedback: ["id"],
  };
  remoteRows = {
    attachments: [{ id: "att_2", filename: "b.txt", extra: { nested: true } }],
    share_links: [],
    feedback: [],
  };
  remoteColumns = {
    attachments: ["id", "filename"],
    share_links: ["id"],
    feedback: ["id"],
  };
  localPrepareError = null;
  remoteAllError = null;
  localStatementRuns.length = 0;
  remoteRunCalls.length = 0;
  remoteClose.mockClear();
  localClose.mockClear();
});

afterEach(() => {
  clearEnv();
});

describe("storage sync operations", () => {
  it("throws when no storage database URL is configured", async () => {
    await expect(storage.getStoragePg()).rejects.toThrow("Missing HASNA_ATTACHMENTS_DATABASE_URL");
  });

  it("reports configured status with sync metadata", () => {
    process.env["ATTACHMENTS_DATABASE_URL"] = "postgres://remote";

    expect(storage.getStorageStatus()).toMatchObject({
      configured: true,
      mode: "hybrid",
      activeEnv: "ATTACHMENTS_DATABASE_URL",
      tables: ["attachments", "share_links", "feedback"],
    });
    expect(localClose).toHaveBeenCalled();
  });

  it("runs migrations against the remote adapter", async () => {
    const remote = await storage.getStoragePg().catch(() => null);
    expect(remote).toBeNull();

    process.env["HASNA_ATTACHMENTS_DATABASE_URL"] = "postgres://canonical";
    const configured = await storage.getStoragePg();
    await storage.runStorageMigrations(configured);

    expect(remoteRunCalls.length).toBeGreaterThan(0);
    expect(remoteRunCalls.some((call) => call.sql.includes("CREATE TABLE"))).toBe(true);
  });

  it("pushes local rows through remote column filtering and records sync metadata", async () => {
    process.env["HASNA_ATTACHMENTS_DATABASE_URL"] = "postgres://canonical";

    const results = await storage.storagePush({ tables: ["attachments"] });

    expect(results).toEqual([{ table: "attachments", rowsRead: 1, rowsWritten: 1, errors: [] }]);
    const upsert = remoteRunCalls.find((call) => /INSERT INTO "attachments"/.test(call.sql))!;
    expect(upsert.sql).toContain('"id", "filename"');
    expect(upsert.sql).not.toContain("ignored");
    expect(upsert.params).toEqual(["att_1", "a.txt"]);
    expect(localStatementRuns.some((args) => args[0] === "attachments" && args[2] === "push")).toBe(true);
    expect(localClose).toHaveBeenCalled();
    expect(remoteClose).toHaveBeenCalled();
  });

  it("pulls remote rows into SQLite with local column filtering", async () => {
    process.env["ATTACHMENTS_DATABASE_URL"] = "postgres://remote";

    const results = await storage.storagePull({ tables: ["attachments"] });

    expect(results).toEqual([{ table: "attachments", rowsRead: 1, rowsWritten: 1, errors: [] }]);
    expect(localStatementRuns).toContainEqual(["att_2", "b.txt"]);
    expect(localStatementRuns.some((args) => args[0] === "attachments" && args[2] === "pull")).toBe(true);
  });

  it("coerces Date, buffer, object, and symbol values for SQLite pulls", async () => {
    process.env["ATTACHMENTS_DATABASE_URL"] = "postgres://remote";
    const when = new Date("2026-07-07T12:00:00.000Z");
    const bytes = Buffer.from("bytes");
    remoteRows.attachments = [{
      id: "att_coerce",
      filename: "coerce.txt",
      created_at: when,
      raw: bytes,
      metadata: { nested: true },
      marker: Symbol("marker"),
    }];
    localColumns.attachments = ["id", "filename", "created_at", "raw", "metadata", "marker"];
    remoteColumns.attachments = ["id", "filename", "created_at", "raw", "metadata", "marker"];

    await storage.storagePull({ tables: ["attachments"] });

    expect(localStatementRuns).toContainEqual([
      "att_coerce",
      "coerce.txt",
      "2026-07-07T12:00:00.000Z",
      bytes,
      JSON.stringify({ nested: true }),
      "Symbol(marker)",
    ]);
  });

  it("runs push then pull for full sync", async () => {
    process.env["ATTACHMENTS_DATABASE_URL"] = "postgres://remote";

    const result = await storage.storageSync({ tables: ["share_links"] });

    expect(result.push).toEqual([{ table: "share_links", rowsRead: 0, rowsWritten: 0, errors: [] }]);
    expect(result.pull).toEqual([{ table: "share_links", rowsRead: 0, rowsWritten: 0, errors: [] }]);
  });

  it("captures push and pull table errors without throwing", async () => {
    process.env["ATTACHMENTS_DATABASE_URL"] = "postgres://remote";
    localPrepareError = new Error("local failed");
    await expect(storage.storagePush({ tables: ["attachments"] })).resolves.toEqual([
      { table: "attachments", rowsRead: 0, rowsWritten: 0, errors: ["local failed"] },
    ]);

    localPrepareError = null;
    remoteAllError = new Error("remote failed");
    await expect(storage.storagePull({ tables: ["attachments"] })).resolves.toEqual([
      { table: "attachments", rowsRead: 0, rowsWritten: 0, errors: ["remote failed"] },
    ]);
  });
});
