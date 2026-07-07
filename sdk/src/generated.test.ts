import { describe, expect, it, mock } from "bun:test";
import { ApiError, AttachmentsApiClient } from "./generated";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("generated AttachmentsApiClient", () => {
  it("requires a base URL", () => {
    expect(() => new AttachmentsApiClient({ baseUrl: "" })).toThrow("requires a baseUrl");
  });

  it("sends base headers, API keys, query params, request init, and JSON bodies", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchMock = mock(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return json({ ok: true, link: "https://files.example/a/t", expires_at: null });
    });
    const client = new AttachmentsApiClient({
      baseUrl: "https://api.example.test/",
      apiKey: "api-key",
      fetch: fetchMock as unknown as typeof fetch,
      headers: { "x-base": "base" },
    });

    await client.getHealth({ headers: { "x-extra": "extra" } });
    await client.listAttachments({ limit: 2, tag: "task:1", expired: false });
    await client.createAttachment({ filename: "a.txt", content_base64: "YQ==", link_type: "server" });
    await client.regenerateAttachmentLink("att/1", { expiry: "30m", password: "pw", max_downloads: 1 });

    expect(calls[0]).toEqual([
      "https://api.example.test/health",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          "x-api-key": "api-key",
          "x-base": "base",
          "x-extra": "extra",
        }),
      }),
    ]);
    expect(calls[1]![0]).toBe("https://api.example.test/v1/attachments?limit=2&tag=task%3A1&expired=false");
    expect(calls[2]![1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ filename: "a.txt", content_base64: "YQ==", link_type: "server" }),
    });
    expect(calls[3]![0]).toBe("https://api.example.test/v1/attachments/att%2F1/link");
  });

  it("covers metadata, delete, link, ready, and version endpoints", async () => {
    const paths: string[] = [];
    const fetchMock = mock(async (url: string) => {
      paths.push(new URL(url).pathname);
      return json({ id: "att_1", deleted: true, link: null, status: "ok", version: "1", mode: "cloud" });
    });
    const client = new AttachmentsApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.getReady();
    await client.getAttachment("att 1");
    await client.deleteAttachment("att 1");
    await client.getAttachmentLink("att 1");
    await client.getVersion();

    expect(paths).toEqual([
      "/ready",
      "/v1/attachments/att%201",
      "/v1/attachments/att%201",
      "/v1/attachments/att%201/link",
      "/version",
    ]);
  });

  it("throws ApiError with parsed JSON or text bodies for failed responses", async () => {
    const jsonClient = new AttachmentsApiClient({
      baseUrl: "https://api.example.test",
      fetch: mock(async () => json({ error: "nope" }, 418)) as unknown as typeof fetch,
    });
    await expect(jsonClient.getHealth()).rejects.toMatchObject({
      name: "ApiError",
      status: 418,
      message: "GET /health failed: 418",
      body: { error: "nope" },
    } satisfies Partial<ApiError>);

    const textClient = new AttachmentsApiClient({
      baseUrl: "https://api.example.test",
      fetch: mock(async () => new Response("plain failure", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(textClient.getVersion()).rejects.toMatchObject({
      status: 500,
      body: "plain failure",
    } satisfies Partial<ApiError>);
  });
});
