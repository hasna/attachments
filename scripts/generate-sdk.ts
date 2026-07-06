#!/usr/bin/env bun
/**
 * Generate the typed SDK client from the serve OpenAPI document.
 *
 * Source of truth: src/serve/openapi.ts. Output: sdk/src/generated.ts.
 * Run: bun run sdk:generate
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { generateSdkFromOpenApi } from "@hasna/contracts/sdk";
import { buildOpenApiDocument } from "../src/serve/openapi.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// Use a placeholder version — the generated file is source, not release-pinned.
const spec = buildOpenApiDocument("0.0.0");
const { code, operations, warnings } = generateSdkFromOpenApi(spec, {
  className: "AttachmentsApiClient",
  apiKeyHeader: "x-api-key",
});

const header = `// @generated from src/serve/openapi.ts by scripts/generate-sdk.ts — DO NOT EDIT.\n// Regenerate: bun run sdk:generate\n\n`;
const out = join(repoRoot, "sdk", "src", "generated.ts");
writeFileSync(out, header + code);

console.log(`Generated ${operations.length} operations -> sdk/src/generated.ts`);
for (const op of operations) console.log(`  ${op.method.toUpperCase().padEnd(6)} ${op.path} -> ${op.functionName}`);
if (warnings.length) {
  console.log("Warnings:");
  for (const w of warnings) console.log(`  - ${w}`);
}
