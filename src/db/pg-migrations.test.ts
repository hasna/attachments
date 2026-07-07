import { describe, expect, it } from "bun:test";
import { ATTACHMENTS_MIGRATIONS } from "./migrations";
import { PG_MIGRATIONS } from "./pg-migrations";

describe("feedback Postgres migrations", () => {
  it("creates canonical feedback fields for fresh storage-sync databases", () => {
    const createFeedback = PG_MIGRATIONS.find((sql) => /CREATE TABLE IF NOT EXISTS feedback/i.test(sql));

    expect(createFeedback).toContain("service TEXT NOT NULL DEFAULT 'attachments'");
    expect(createFeedback).toContain("version TEXT NOT NULL DEFAULT 'unknown'");
    expect(createFeedback).toContain("message TEXT NOT NULL");
    expect(createFeedback).toContain("email TEXT");
    expect(createFeedback).toContain("timestamp TEXT NOT NULL DEFAULT NOW()::text");
  });

  it("backfills and tightens feedback fields for existing storage-sync databases", () => {
    const sql = PG_MIGRATIONS.join(";\n");

    expect(sql).toContain("ALTER TABLE feedback ADD COLUMN IF NOT EXISTS service TEXT");
    expect(sql).toContain("ALTER TABLE feedback ADD COLUMN IF NOT EXISTS timestamp TEXT");
    expect(sql).toContain("UPDATE feedback SET service = 'attachments'");
    expect(sql).toContain("UPDATE feedback SET version = 'unknown'");
    expect(sql).toContain("UPDATE feedback SET timestamp = COALESCE");
    expect(sql).toContain("ALTER TABLE feedback ALTER COLUMN service SET NOT NULL");
    expect(sql).toContain("ALTER TABLE feedback ALTER COLUMN version SET NOT NULL");
    expect(sql).toContain("ALTER TABLE feedback ALTER COLUMN timestamp SET NOT NULL");
  });

  it("backfills and tightens feedback fields in the cloud serve migration ledger", () => {
    const migrations = ATTACHMENTS_MIGRATIONS as Array<{ id: string; sql: string }>;
    const create = migrations.find((migration) => migration.id === "attachments_0006_feedback")?.sql;
    const contract = migrations.find((migration) => migration.id === "attachments_0007_feedback_contract_fields")?.sql;

    expect(create).toContain("service TEXT NOT NULL DEFAULT 'attachments'");
    expect(create).toContain("timestamp TEXT NOT NULL DEFAULT NOW()::text");
    expect(contract).toContain("ALTER TABLE feedback ADD COLUMN IF NOT EXISTS service TEXT");
    expect(contract).toContain("UPDATE feedback");
    expect(contract).toContain("ALTER TABLE feedback ALTER COLUMN service SET NOT NULL");
    expect(contract).toContain("ALTER TABLE feedback ALTER COLUMN timestamp SET NOT NULL");
  });
});
