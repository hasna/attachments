import { afterEach, describe, expect, it, mock } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { AttachmentsDB } from "./db";
import {
  FEEDBACK_LIMITS,
  normalizeFeedbackInput,
  postFeedbackToCloud,
  resolveFeedbackEndpoint,
  sendFeedback,
} from "./feedback";

const originalFetch = globalThis.fetch;

function makeTempPath(): string {
  return join(tmpdir(), `open-attachments-feedback-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ATTACHMENTS_FEEDBACK_URL;
  delete process.env.HASNA_ATTACHMENTS_FEEDBACK_URL;
  delete process.env.ATTACHMENTS_API_URL;
  delete process.env.HASNA_ATTACHMENTS_API_URL;
  delete process.env.ATTACHMENTS_API_TOKEN;
  delete process.env.HASNA_ATTACHMENTS_API_TOKEN;
  mock.restore();
});

describe("feedback core", () => {
  it("normalizes feedback fields and lowercases email", () => {
    const feedback = normalizeFeedbackInput({
      service: " attachments ",
      version: " 1.2.3 ",
      message: "  Works well ",
      email: "User@Example.com",
      timestamp: "2026-07-07T10:11:12Z",
    });

    expect(feedback.id.startsWith("fb_")).toBe(true);
    expect(feedback.service).toBe("attachments");
    expect(feedback.version).toBe("1.2.3");
    expect(feedback.message).toBe("Works well");
    expect(feedback.email).toBe("user@example.com");
    expect(feedback.timestamp).toBe("2026-07-07T10:11:12.000Z");
  });

  it("enforces field limits and valid email", () => {
    expect(() => normalizeFeedbackInput({
      message: "hello",
      email: "not-an-email",
    })).toThrow("email must be a valid email address");
    expect(() => normalizeFeedbackInput({
      message: "x".repeat(FEEDBACK_LIMITS.maxMessageLength + 1),
    })).toThrow("message must be at most");
    expect(() => normalizeFeedbackInput({
      message: "hello",
      service: "s".repeat(FEEDBACK_LIMITS.maxServiceLength + 1),
    })).toThrow("service must be at most");
  });

  it("resolves hosted API base URLs to the versioned feedback endpoint", () => {
    expect(resolveFeedbackEndpoint({ baseUrl: "https://attachments.example.com" }))
      .toBe("https://attachments.example.com/v1/feedback");
    expect(resolveFeedbackEndpoint({ baseUrl: "https://attachments.example.com/" }))
      .toBe("https://attachments.example.com/v1/feedback");
    expect(resolveFeedbackEndpoint({ baseUrl: "https://attachments.example.com/v1" }))
      .toBe("https://attachments.example.com/v1/feedback");
    expect(resolveFeedbackEndpoint({ baseUrl: "https://attachments.example.com/v1/feedback" }))
      .toBe("https://attachments.example.com/v1/feedback");
    expect(resolveFeedbackEndpoint({ baseUrl: "https://attachments.example.com/api" }))
      .toBe("https://attachments.example.com/v1/feedback");
  });

  it("preserves explicit feedback endpoint overrides", () => {
    expect(resolveFeedbackEndpoint({
      endpoint: "https://attachments.example.com/api/feedback/",
      baseUrl: "https://attachments.example.com",
    })).toBe("https://attachments.example.com/api/feedback");
  });

  it("keeps localhost API bases on the local feedback route", () => {
    expect(resolveFeedbackEndpoint({ baseUrl: "http://localhost:3459" }))
      .toBe("http://localhost:3459/api/feedback");
    expect(resolveFeedbackEndpoint({ baseUrl: "http://localhost:3459/api" }))
      .toBe("http://localhost:3459/api/feedback");
  });

  it("stores locally first and posts canonical fields to the cloud endpoint", async () => {
    const dbPath = makeTempPath();
    const db = new AttachmentsDB(dbPath);
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 202 }));

    try {
      const result = await sendFeedback({
        service: "attachments",
        version: "1.2.3",
        message: "Please add larger file progress",
        email: "user@example.com",
        timestamp: "2026-07-07T10:11:12.000Z",
      }, {
        db,
        endpoint: "https://feedback.example.test/v1/feedback",
        token: "test-token",
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      expect(result.local.saved).toBe(true);
      expect(result.cloud.ok).toBe(true);
      expect(result.cloud.status).toBe(202);
      expect(db.listFeedback()).toHaveLength(1);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://feedback.example.test/v1/feedback");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
      const payload = JSON.parse(String(init.body));
      expect(payload).toEqual({
        service: "attachments",
        version: "1.2.3",
        message: "Please add larger file progress",
        email: "user@example.com",
        timestamp: "2026-07-07T10:11:12.000Z",
      });
    } finally {
      db.close();
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });

  it("preserves local feedback when cloud delivery fails", async () => {
    const dbPath = makeTempPath();
    const db = new AttachmentsDB(dbPath);
    const fetchMock = mock(async () => new Response(JSON.stringify({ error: "nope" }), { status: 503 }));

    try {
      const result = await sendFeedback({
        message: "Cloud is down",
        timestamp: "2026-07-07T10:11:12.000Z",
      }, {
        db,
        endpoint: "https://feedback.example.test/v1/feedback",
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      expect(result.local.saved).toBe(true);
      expect(result.cloud.ok).toBe(false);
      expect(result.cloud.status).toBe(503);
      expect(result.cloud.error).toBe("nope");
      expect(db.listFeedback()).toHaveLength(1);
    } finally {
      db.close();
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });

  it("requires HTTPS for non-local feedback endpoints", async () => {
    const feedback = normalizeFeedbackInput({ message: "hello" });
    const result = await postFeedbackToCloud(feedback, {
      endpoint: "http://feedback.example.test/v1/feedback",
      fetchImpl: mock(async () => new Response("{}")) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("must use HTTPS");
  });

  it("allows HTTP feedback delivery to localhost", async () => {
    const feedback = normalizeFeedbackInput({ message: "hello" });
    const fetchMock = mock(async () => new Response("{}", { status: 201 }));
    const result = await postFeedbackToCloud(feedback, {
      endpoint: "http://localhost:3459/api/feedback",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
