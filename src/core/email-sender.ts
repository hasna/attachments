import type { EmailSender } from "./email-gate";

/**
 * Resend HTTP sender. Zero-dependency — uses fetch against the Resend API.
 */
export class ResendSender implements EmailSender {
  constructor(
    private apiKey: string,
    private from: string
  ) {}

  async send(input: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Resend send failed (${res.status}): ${detail.slice(0, 200)}`);
    }
  }
}

/**
 * AWS SES v2 sender via the SendEmail REST endpoint, signed with SigV4.
 * Uses fetch + the Web Crypto API — no aws-sdk dependency.
 */
export class SesSender implements EmailSender {
  constructor(
    private opts: { region: string; accessKeyId: string; secretAccessKey: string; from: string }
  ) {}

  async send(input: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    const { region, from } = this.opts;
    const host = `email.${region}.amazonaws.com`;
    const path = "/v2/email/outbound-emails";
    const payload = JSON.stringify({
      FromEmailAddress: from,
      Destination: { ToAddresses: [input.to] },
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: input.text, Charset: "UTF-8" },
            ...(input.html ? { Html: { Data: input.html, Charset: "UTF-8" } } : {}),
          },
        },
      },
    });
    const headers = await signSigV4({
      method: "POST",
      host,
      path,
      region,
      service: "ses",
      payload,
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
    });
    const res = await fetch(`https://${host}${path}`, { method: "POST", headers, body: payload });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`SES send failed (${res.status}): ${detail.slice(0, 200)}`);
    }
  }
}

/**
 * Resolve an EmailSender from environment, or null if email-gating is not
 * configured. Resend takes precedence; SES is used if its creds are present.
 *   ATTACHMENTS_EMAIL_FROM       — sender address (required for either)
 *   ATTACHMENTS_RESEND_API_KEY   — enables Resend
 *   ATTACHMENTS_SES_REGION + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY — enables SES
 */
export function resolveEmailSender(env: Record<string, string | undefined> = process.env): EmailSender | null {
  const from = env["ATTACHMENTS_EMAIL_FROM"];
  if (!from) return null;
  const resendKey = env["ATTACHMENTS_RESEND_API_KEY"];
  if (resendKey) return new ResendSender(resendKey, from);
  const region = env["ATTACHMENTS_SES_REGION"];
  const accessKeyId = env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = env["AWS_SECRET_ACCESS_KEY"];
  if (region && accessKeyId && secretAccessKey) {
    return new SesSender({ region, accessKeyId, secretAccessKey, from });
  }
  return null;
}

// --- Minimal SigV4 signer (SES) ---

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return toHex(new Uint8Array(buf));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signSigV4(input: {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  payload: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
}): Promise<Record<string, string>> {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(input.payload);

  const canonicalHeaders =
    `content-type:application/json\nhost:${input.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    input.method,
    input.path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(new TextEncoder().encode(`AWS4${input.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, input.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(new Uint8Array(await hmac(kSigning, stringToSign)));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    "Content-Type": "application/json",
    Host: input.host,
    "X-Amz-Content-Sha256": payloadHash,
    "X-Amz-Date": amzDate,
    Authorization: authorization,
  };
}
