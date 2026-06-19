import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { downloadFromCloud, uploadFileToCloudApi } from "./api-client";

const BASE_URL = "https://attachments.example.test";
const TOKEN = "test-token";

function tempFile(name: string, content = "hello"): string {
  const dir = join(tmpdir(), `attachments-api-client-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  mock.restore();
});

describe("cloud API client", () => {
  it("sends upload passwords in headers instead of query strings", async () => {
    const path = tempFile("secret.txt");
    const fetchMock = mock(async () => new Response(JSON.stringify({
      id: "att_1",
      filename: "secret.txt",
      size: 5,
      content_type: "text/plain",
      link: "https://has.na/a/token",
      expires_at: null,
      created_at: Date.now(),
    }), { status: 201, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await uploadFileToCloudApi(path, {
      password: "not-in-url",
      encrypt: true,
      multipartThresholdBytes: Number.MAX_SAFE_INTEGER,
    }, { baseUrl: BASE_URL, token: TOKEN });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).not.toContain("password=");
    expect(url.searchParams.get("encrypt")).toBe("1");
    expect((init.headers as Record<string, string>)["x-attachments-password"]).toBe("not-in-url");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);

    rmSync(dirname(path), { recursive: true, force: true });
  });

  it("sends protected API download passwords in headers", async () => {
    const fetchMock = mock(async () => new Response("contents", {
      status: 200,
      headers: {
        "content-disposition": "attachment; filename=\"secret.txt\"",
        "content-length": "8",
      },
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const outDir = join(tmpdir(), `attachments-api-client-download-${Date.now()}`);
    mkdirSync(outDir, { recursive: true });

    await downloadFromCloud("att_1", outDir, { password: "download-secret" }, { baseUrl: BASE_URL, token: TOKEN });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/attachments/att_1/download`);
    expect((init.headers as Record<string, string>)["x-attachments-password"]).toBe("download-secret");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);

    rmSync(outDir, { recursive: true, force: true });
  });
});
