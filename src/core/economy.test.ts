import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { estimateUploadCostUsd, trackUploadCost } from "./economy"

// ---- Cost calculation tests ----

describe("estimateUploadCostUsd", () => {
  it("charges PUT cost for zero-byte file", () => {
    const cost = estimateUploadCostUsd(0)
    // Only PUT cost ($0.000005), no storage
    expect(cost).toBeCloseTo(0.000005, 9)
  })

  it("calculates cost for 1 MB file", () => {
    const oneMb = 1024 * 1024
    const cost = estimateUploadCostUsd(oneMb)
    const expected = (oneMb / (1024 * 1024 * 1024)) * 0.023 + 0.000005
    expect(cost).toBeCloseTo(expected, 9)
  })

  it("calculates cost for 1 GB file", () => {
    const oneGb = 1024 * 1024 * 1024
    const cost = estimateUploadCostUsd(oneGb)
    // 1 GB * 0.023 + 0.000005
    expect(cost).toBeCloseTo(0.023005, 6)
  })

  it("cost increases with file size", () => {
    const small = estimateUploadCostUsd(1024)
    const large = estimateUploadCostUsd(1024 * 1024 * 100)
    expect(large).toBeGreaterThan(small)
  })
})

// ---- trackUploadCost tests ----
// All tests use injected _fetch to avoid interfering with other test files.

describe("trackUploadCost", () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {
      ATTACHMENTS_TRACK_COSTS: process.env["ATTACHMENTS_TRACK_COSTS"],
      ATTACHMENTS_ECONOMY_URL: process.env["ATTACHMENTS_ECONOMY_URL"],
    }
    // Ensure clean state for each test
    delete process.env["ATTACHMENTS_TRACK_COSTS"]
    delete process.env["ATTACHMENTS_ECONOMY_URL"]
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = val
      }
    }
  })

  it("does nothing when ATTACHMENTS_TRACK_COSTS is not set", async () => {
    const mockFetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await trackUploadCost({ filename: "test.txt", sizeBytes: 1024, _fetch: mockFetch })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("does nothing when ATTACHMENTS_TRACK_COSTS=0", async () => {
    process.env["ATTACHMENTS_TRACK_COSTS"] = "0"
    const mockFetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await trackUploadCost({ filename: "test.txt", sizeBytes: 1024, _fetch: mockFetch })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("does nothing when ATTACHMENTS_TRACK_COSTS=false", async () => {
    process.env["ATTACHMENTS_TRACK_COSTS"] = "false"
    const mockFetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await trackUploadCost({ filename: "test.txt", sizeBytes: 1024, _fetch: mockFetch })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("POSTs to economy server when ATTACHMENTS_TRACK_COSTS=1", async () => {
    process.env["ATTACHMENTS_TRACK_COSTS"] = "1"

    const mockFetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await trackUploadCost({
      filename: "photo.jpg",
      sizeBytes: 2 * 1024 * 1024,
      economyUrl: "http://localhost:3456",
      _fetch: mockFetch,
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://localhost:3456/api/costs")
    expect(init.method).toBe("POST")

    const body = JSON.parse(init.body as string)
    expect(body.total_cost_usd).toBeGreaterThan(0)
    expect(body.metadata.filename).toBe("photo.jpg")
    expect(body.metadata.size_bytes).toBe(2 * 1024 * 1024)
    expect(body.metadata.operation).toBe("upload")
  })

  it("uses ATTACHMENTS_ECONOMY_URL env var", async () => {
    process.env["ATTACHMENTS_TRACK_COSTS"] = "1"
    process.env["ATTACHMENTS_ECONOMY_URL"] = "http://economy.internal:9000"

    const mockFetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await trackUploadCost({ filename: "doc.pdf", sizeBytes: 512, _fetch: mockFetch })

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://economy.internal:9000/api/costs")
  })

  it("economyUrl option overrides env var", async () => {
    process.env["ATTACHMENTS_TRACK_COSTS"] = "1"
    process.env["ATTACHMENTS_ECONOMY_URL"] = "http://wrong-url:1234"

    const mockFetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await trackUploadCost({
      filename: "file.bin",
      sizeBytes: 100,
      economyUrl: "http://custom:5678",
      _fetch: mockFetch,
    })

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://custom:5678/api/costs")
  })

  it("fails silently when fetch throws (economy server down)", async () => {
    process.env["ATTACHMENTS_TRACK_COSTS"] = "1"

    const mockFetch = mock(async () => { throw new Error("ECONNREFUSED") })

    // Must NOT throw
    await expect(
      trackUploadCost({ filename: "file.txt", sizeBytes: 1024, economyUrl: "http://localhost:3456", _fetch: mockFetch })
    ).resolves.toBeUndefined()
  })

  it("fails silently when fetch returns non-200 status", async () => {
    process.env["ATTACHMENTS_TRACK_COSTS"] = "1"

    const mockFetch = mock(async () => new Response("Not Found", { status: 404 }))

    // Must NOT throw
    await expect(
      trackUploadCost({ filename: "file.txt", sizeBytes: 1024, economyUrl: "http://localhost:3456", _fetch: mockFetch })
    ).resolves.toBeUndefined()
  })

  it("sets agent from agentId option", async () => {
    process.env["ATTACHMENTS_TRACK_COSTS"] = "1"

    const mockFetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await trackUploadCost({
      filename: "img.png",
      sizeBytes: 512,
      agentId: "my-agent",
      economyUrl: "http://localhost:3456",
      _fetch: mockFetch,
    })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.agent).toBe("my-agent")
  })

  it("defaults agent to s3 when agentId not provided", async () => {
    process.env["ATTACHMENTS_TRACK_COSTS"] = "1"

    const mockFetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await trackUploadCost({ filename: "x.bin", sizeBytes: 100, economyUrl: "http://localhost:3456", _fetch: mockFetch })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.agent).toBe("s3")
  })

  it("sets operation to download when specified", async () => {
    process.env["ATTACHMENTS_TRACK_COSTS"] = "1"

    const mockFetch = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await trackUploadCost({
      filename: "x.bin",
      sizeBytes: 100,
      operation: "download",
      economyUrl: "http://localhost:3456",
      _fetch: mockFetch,
    })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.metadata.operation).toBe("download")
  })
})
