import { nanoid } from "nanoid";
import { AttachmentsDB, type Feedback } from "./db";
import {
  getClientApiBaseUrl,
  getClientApiToken,
  getConfig,
  type AttachmentsConfig,
} from "./config";
import { isValidEmail, normalizeEmail } from "./security";

type FeedbackTimestamp = string | number | Date;

export interface FeedbackInput {
  service?: string;
  version?: string;
  message: string;
  email?: string | null;
  timestamp?: FeedbackTimestamp;
}

export interface FeedbackDeliveryOptions {
  endpoint?: string | null;
  baseUrl?: string;
  token?: string | null;
  config?: AttachmentsConfig;
  fetchImpl?: typeof fetch;
  allowHttp?: boolean;
}

export interface SendFeedbackOptions extends FeedbackDeliveryOptions {
  db?: AttachmentsDB;
  now?: () => Date;
  skipCloud?: boolean;
}

export interface FeedbackCloudResult {
  attempted: boolean;
  ok: boolean;
  endpoint?: string;
  status?: number;
  error?: string;
}

export interface SendFeedbackResult {
  feedback: Feedback;
  local: { saved: true };
  cloud: FeedbackCloudResult;
}

interface FeedbackDefaults {
  service?: string;
  version?: string;
  now?: () => Date;
}

function getPackageVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("../../package.json") as { version?: string }).version ?? "unknown";
  } catch {
    return process.env.npm_package_version ?? "unknown";
  }
}

function normalizeTimestamp(input: FeedbackTimestamp | undefined, now: () => Date): string {
  const value = input ?? now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("timestamp must be a valid date or ISO timestamp");
  }
  return date.toISOString();
}

export function normalizeFeedbackInput(input: FeedbackInput, defaults: FeedbackDefaults = {}): Feedback {
  const message = input.message?.trim();
  if (!message) throw new Error("message is required");

  const service = (input.service ?? defaults.service ?? "attachments").trim();
  if (!service) throw new Error("service is required");

  const version = (input.version ?? defaults.version ?? getPackageVersion()).trim();
  if (!version) throw new Error("version is required");

  let email: string | null = null;
  if (input.email !== undefined && input.email !== null && input.email.trim() !== "") {
    email = normalizeEmail(input.email);
    if (!isValidEmail(email)) throw new Error("email must be a valid email address");
  }

  return {
    id: `fb_${nanoid(12)}`,
    service,
    version,
    message,
    email,
    timestamp: normalizeTimestamp(input.timestamp, defaults.now ?? (() => new Date())),
  };
}

function configuredFeedbackUrl(): string | null {
  const direct =
    process.env["ATTACHMENTS_FEEDBACK_URL"]?.trim() ||
    process.env["HASNA_ATTACHMENTS_FEEDBACK_URL"]?.trim() ||
    "";
  return direct || null;
}

function endpointFromBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (/\/(?:api|v1)\/feedback$/i.test(normalized)) return normalized;
  if (/\/(?:api|v1)$/i.test(normalized)) return `${normalized}/feedback`;
  return `${normalized}/api/feedback`;
}

export function resolveFeedbackEndpoint(options: FeedbackDeliveryOptions = {}): string | null {
  const endpoint = options.endpoint ?? configuredFeedbackUrl();
  if (endpoint) return endpoint.replace(/\/+$/, "");

  const baseUrl =
    options.baseUrl ||
    getClientApiBaseUrl(options.config ?? getConfig()) ||
    "";
  return baseUrl ? endpointFromBaseUrl(baseUrl) : null;
}

function isLocalHttpEndpoint(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function assertAllowedFeedbackEndpoint(endpoint: string, allowHttp?: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("feedback endpoint must be a valid URL");
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && (allowHttp || isLocalHttpEndpoint(parsed))) return;
  throw new Error("feedback endpoint must use HTTPS unless it targets localhost");
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    return String(parsed.error ?? parsed.message ?? `HTTP ${response.status}`);
  } catch {
    return text.slice(0, 300);
  }
}

export async function postFeedbackToCloud(
  feedback: Feedback,
  options: FeedbackDeliveryOptions = {},
): Promise<FeedbackCloudResult> {
  const endpoint = resolveFeedbackEndpoint(options);
  if (!endpoint) {
    return {
      attempted: false,
      ok: false,
      error: "Cloud feedback endpoint is not configured. Set ATTACHMENTS_API_URL or ATTACHMENTS_FEEDBACK_URL.",
    };
  }

  try {
    assertAllowedFeedbackEndpoint(endpoint, options.allowHttp);
    const authHeaderValue = options.token !== undefined
      ? options.token
      : getClientApiToken(options.config ?? getConfig());
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authHeaderValue) headers.authorization = `Bearer ${authHeaderValue}`;

    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        service: feedback.service,
        version: feedback.version,
        message: feedback.message,
        email: feedback.email,
        timestamp: feedback.timestamp,
      }),
    });

    if (!response.ok) {
      return {
        attempted: true,
        ok: false,
        endpoint,
        status: response.status,
        error: await responseError(response),
      };
    }
    return { attempted: true, ok: true, endpoint, status: response.status };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function sendFeedback(
  input: FeedbackInput,
  options: SendFeedbackOptions = {},
): Promise<SendFeedbackResult> {
  const feedback = normalizeFeedbackInput(input, {
    now: options.now,
  });

  const ownsDb = !options.db;
  const db = options.db ?? new AttachmentsDB();
  try {
    db.insertFeedback(feedback);
  } finally {
    if (ownsDb) db.close();
  }

  const cloud = options.skipCloud
    ? { attempted: false, ok: false, error: "Cloud feedback delivery was skipped." }
    : await postFeedbackToCloud(feedback, options);

  return {
    feedback,
    local: { saved: true },
    cloud,
  };
}
