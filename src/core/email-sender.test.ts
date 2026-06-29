import { describe, it, expect, mock, afterEach } from "bun:test";
import { resolveEmailSender, ResendSender, SesSender } from "./email-sender";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("resolveEmailSender", () => {
  it("returns null when no sender is configured", () => {
    expect(resolveEmailSender({})).toBeNull();
    expect(resolveEmailSender({ ATTACHMENTS_EMAIL_FROM: "x@y.com" })).toBeNull();
  });

  it("prefers Resend when its key is set", () => {
    const s = resolveEmailSender({
      ATTACHMENTS_EMAIL_FROM: "x@y.com",
      ATTACHMENTS_RESEND_API_KEY: "re_123",
    });
    expect(s).toBeInstanceOf(ResendSender);
  });

  it("falls back to SES when AWS creds + region are present", () => {
    const s = resolveEmailSender({
      ATTACHMENTS_EMAIL_FROM: "x@y.com",
      ATTACHMENTS_SES_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test-key",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(s).toBeInstanceOf(SesSender);
  });

  it("returns null for SES if region is set but creds are missing", () => {
    expect(
      resolveEmailSender({ ATTACHMENTS_EMAIL_FROM: "x@y.com", ATTACHMENTS_SES_REGION: "us-east-1" })
    ).toBeNull();
  });
});

describe("ResendSender", () => {
  it("POSTs to the Resend API with from/to/subject and throws on failure", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const sender = new ResendSender("re_key", "andrei@hasna.com");
    await sender.send({ to: "bcr@bcr.ro", subject: "Hi", text: "body", html: "<p>body</p>" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const sentBody = JSON.parse(String(calls[0]!.init.body));
    expect(sentBody).toMatchObject({
      from: "andrei@hasna.com",
      to: "bcr@bcr.ro",
      subject: "Hi",
      text: "body",
      html: "<p>body</p>",
    });
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer re_key");
  });

  it("throws when Resend returns a non-2xx status", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 422 })) as unknown as typeof fetch;
    const sender = new ResendSender("re_key", "x@y.com");
    await expect(sender.send({ to: "a@b.com", subject: "s", text: "t" })).rejects.toThrow(/422/);
  });
});

describe("SesSender", () => {
  it("signs and POSTs to the SES outbound endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const sender = new SesSender({
      region: "us-east-1",
      accessKeyId: "test-access-key",
      secretAccessKey: "secretkey",
      from: "andrei@hasna.com",
    });
    await sender.send({ to: "bcr@bcr.ro", subject: "Hi", text: "body" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toContain("AWS4-HMAC-SHA256");
    expect(headers["Authorization"]).toContain("test-access-key");
    expect(headers["X-Amz-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
  });
});
