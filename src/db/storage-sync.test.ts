import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  getStorageDatabaseEnv,
  getStorageDatabaseUrl,
  getStorageMode,
  parseStorageTables,
} from "./storage-sync";

const ENV_NAMES = [
  "HASNA_ATTACHMENTS_DATABASE_URL",
  "ATTACHMENTS_DATABASE_URL",
  "HASNA_ATTACHMENTS_STORAGE_MODE",
  "ATTACHMENTS_STORAGE_MODE",
] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(
  ENV_NAMES.map((name) => [name, process.env[name]]),
);

describe("attachments storage sync configuration", () => {
  beforeEach(() => {
    for (const name of ENV_NAMES) delete process.env[name];
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      const value = ORIGINAL_ENV.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("uses the canonical storage database envs", () => {
    process.env["HASNA_ATTACHMENTS_DATABASE_URL"] = "postgres://canonical";

    expect(getStorageDatabaseUrl()).toBe("postgres://canonical");
    expect(getStorageDatabaseEnv()).toEqual({
      name: "HASNA_ATTACHMENTS_DATABASE_URL",
    });
  });

  it("ignores retired database env aliases", () => {
    const retiredName = ["OPEN", "ATTACHMENTS", "CLO", "UD", "DATABASE", "URL"].join("_");
    process.env[retiredName] = "postgres://legacy";

    expect(getStorageDatabaseUrl()).toBeNull();
    expect(getStorageDatabaseEnv()).toBeNull();

    delete process.env[retiredName];
  });

  it("resolves local, hybrid, and explicit storage modes", () => {
    expect(getStorageMode()).toBe("local");

    process.env["ATTACHMENTS_DATABASE_URL"] = "postgres://remote";
    expect(getStorageMode()).toBe("hybrid");

    process.env["HASNA_ATTACHMENTS_STORAGE_MODE"] = "remote";
    expect(getStorageMode()).toBe("remote");
  });

  it("parses and validates storage table filters", () => {
    expect(parseStorageTables()).toEqual(["attachments", "artifacts", "share_links", "feedback"]);
    expect(parseStorageTables([" attachments ", "feedback"])).toEqual(["attachments", "feedback"]);
    expect(() => parseStorageTables(["missing"])).toThrow("Unknown attachments sync table");
  });

  it("exports the storage sync surface from the storage subpath source", async () => {
    const storage = await import("../storage");

    expect(storage.STORAGE_TABLES).toEqual(["attachments", "artifacts", "share_links", "feedback"]);
    expect(storage.getStorageDatabaseUrl()).toBeNull();
    expect(storage.getStorageMode()).toBe("local");
    expect(storage.PG_MIGRATIONS.length).toBeGreaterThan(0);
    expect(typeof storage.PgAdapterAsync).toBe("function");
  });
});
