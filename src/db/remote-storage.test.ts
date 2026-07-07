import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const queryMock = mock(async (_sql: string, _params: unknown[]) => ({ rowCount: 0, rows: [] }));
const endMock = mock(async () => {});
const poolConstructors: Array<Record<string, unknown>> = [];
let queryResponses: Array<{ rowCount: number; rows: unknown[] }> = [];

mock.module("pg", () => ({
  default: {
    Pool: class MockPool {
      constructor(options: Record<string, unknown>) {
        poolConstructors.push(options);
      }

      query = queryMock;
      end = endMock;
    },
  },
}));

const { PgAdapterAsync } = await import("./remote-storage");

const ORIGINAL_INSECURE = process.env["ATTACHMENTS_PG_SSL_INSECURE"];

beforeEach(() => {
  delete process.env["ATTACHMENTS_PG_SSL_INSECURE"];
  queryMock.mockReset();
  queryResponses = [];
  queryMock.mockImplementation(async () => queryResponses.shift() ?? { rowCount: 0, rows: [] });
  endMock.mockReset();
  endMock.mockImplementation(async () => {});
  poolConstructors.length = 0;
});

afterEach(() => {
  if (ORIGINAL_INSECURE === undefined) delete process.env["ATTACHMENTS_PG_SSL_INSECURE"];
  else process.env["ATTACHMENTS_PG_SSL_INSECURE"] = ORIGINAL_INSECURE;
});

describe("PgAdapterAsync", () => {
  it("translates placeholders and normalizes undefined parameters for run/get/all", async () => {
    queryResponses = [
      { rowCount: 2, rows: [] },
      { rowCount: 1, rows: [{ id: 1 }] },
      { rowCount: 2, rows: [{ id: 1 }, { id: 2 }] },
    ];
    const adapter = new PgAdapterAsync("postgres://db");

    await expect(adapter.run("UPDATE t SET a = ? WHERE id = ?", "x", undefined)).resolves.toEqual({ changes: 2 });
    await expect(adapter.get("SELECT * FROM t WHERE id = ?", [1])).resolves.toEqual({ id: 1 });
    await expect(adapter.all("SELECT * FROM t WHERE a = ? AND b = ?", "x", "y")).resolves.toEqual([{ id: 1 }, { id: 2 }]);

    expect(queryMock.mock.calls[0]).toEqual(["UPDATE t SET a = $1 WHERE id = $2", ["x", null]]);
    expect(queryMock.mock.calls[1]).toEqual(["SELECT * FROM t WHERE id = $1", [1]]);
    expect(queryMock.mock.calls[2]).toEqual(["SELECT * FROM t WHERE a = $1 AND b = $2", ["x", "y"]]);
  });

  it("returns null for missing get rows and closes the pool", async () => {
    const adapter = new PgAdapterAsync("postgres://db");

    await expect(adapter.get("SELECT 1")).resolves.toBeNull();
    await adapter.close();

    expect(endMock).toHaveBeenCalledTimes(1);
  });

  it("configures SSL from connection string flags", () => {
    new PgAdapterAsync("postgres://db?sslmode=disable");
    new PgAdapterAsync("postgres://db?sslmode=require");
    process.env["ATTACHMENTS_PG_SSL_INSECURE"] = "1";
    new PgAdapterAsync("postgres://db?ssl=true");

    expect(poolConstructors[0]).toMatchObject({ connectionString: "postgres://db?sslmode=disable", ssl: undefined });
    expect(poolConstructors[1]).toMatchObject({
      connectionString: "postgres://db?sslmode=require",
      ssl: { rejectUnauthorized: true },
    });
    expect(poolConstructors[2]).toMatchObject({
      connectionString: "postgres://db?ssl=true",
      ssl: { rejectUnauthorized: false },
    });
  });
});
