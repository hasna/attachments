/**
 * Economy integration — optionally track S3 upload costs to open-economy server.
 * Uses native fetch and fails silently if the economy server is not running.
 */

// S3 Standard pricing (us-east-1, 2024):
//   PUT/COPY/POST/LIST requests: $0.005 per 1,000 requests
//   Storage: $0.023 per GB per month (not tracked here — per-upload basis)
//   Data transfer out: $0.09/GB (not tracked here)
// We charge PUT cost + storage cost estimate for first month.
const S3_PUT_COST_USD = 0.000005           // $0.005 / 1000
const S3_STORAGE_PER_GB_USD = 0.023        // per GB per month

/** Cost estimate for a single S3 upload in USD. */
export function estimateUploadCostUsd(sizeBytes: number): number {
  const sizeGb = sizeBytes / (1024 * 1024 * 1024)
  const storageCost = sizeGb * S3_STORAGE_PER_GB_USD
  return S3_PUT_COST_USD + storageCost
}

export interface TrackUploadCostOptions {
  filename: string
  sizeBytes: number
  operation?: "upload" | "download"
  agentId?: string
  /** Economy server base URL. Defaults to ATTACHMENTS_ECONOMY_URL env var or http://localhost:3456 */
  economyUrl?: string
  /** Injectable fetch function (for testing). Defaults to globalThis.fetch */
  _fetch?: typeof fetch
}

/**
 * Post a cost record to the open-economy server.
 * Fails silently — never throws.
 */
export async function trackUploadCost(opts: TrackUploadCostOptions): Promise<void> {
  const trackCosts = process.env["ATTACHMENTS_TRACK_COSTS"]
  if (!trackCosts || trackCosts === "0" || trackCosts === "false") return

  const baseUrl =
    opts.economyUrl ??
    process.env["ATTACHMENTS_ECONOMY_URL"] ??
    "http://localhost:3456"

  const operation = opts.operation ?? "upload"
  const costUsd = estimateUploadCostUsd(opts.sizeBytes)
  const now = new Date().toISOString()
  const sessionId = `s3-${operation}-${Date.now()}`

  // We model S3 operations as economy sessions with a synthetic agent "s3"
  // using the /api/sessions endpoint to insert a session directly.
  // Since the economy server may not have a dedicated S3 endpoint,
  // we POST to /api/costs (a best-effort endpoint) and fall back silently.
  const payload = {
    id: sessionId,
    agent: opts.agentId ?? "s3",
    project_path: "",
    project_name: "open-attachments",
    started_at: now,
    ended_at: now,
    total_cost_usd: costUsd,
    total_tokens: 0,
    request_count: 1,
    metadata: {
      filename: opts.filename,
      size_bytes: opts.sizeBytes,
      operation,
    },
  }

  const fetchFn = opts._fetch ?? fetch

  try {
    await fetchFn(`${baseUrl}/api/costs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    // Economy server not running or unreachable — silently ignore
  }
}
