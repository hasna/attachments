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

export const FEEDBACK_LIMITS = {
  maxBodyBytes: 16 * 1024,
  maxServiceLength: 80,
  maxVersionLength: 80,
  maxMessageLength: 5_000,
  maxEmailLength: 254,
} as const;

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

export class FeedbackBodyError extends Error {
  constructor(message: string, readonly status: 400 | 413) {
    super(message);
    this.name = "FeedbackBodyError";
  }
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function normalizeTextField(value: unknown, field: string, maxLength: number): string {
  const trimmed = requireString(value, field).trim();
  if (!trimmed) throw new Error(`${field} is required`);
  if (trimmed.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function normalizeOptionalTextField(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = requireString(value, field).trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function normalizeTimestamp(input: FeedbackTimestamp | undefined, now: () => Date): string {
  const value = input ?? now();
  if (
    value !== undefined &&
    !(value instanceof Date) &&
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    throw new Error("timestamp must be a valid date or ISO timestamp");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("timestamp must be a valid date or ISO timestamp");
  }
  return date.toISOString();
}

export function normalizeFeedbackInput(input: FeedbackInput, defaults: FeedbackDefaults = {}): Feedback {
  const message = normalizeTextField(input.message, "message", FEEDBACK_LIMITS.maxMessageLength);

  const service =
    normalizeOptionalTextField(input.service, "service", FEEDBACK_LIMITS.maxServiceLength) ??
    normalizeOptionalTextField(defaults.service, "service", FEEDBACK_LIMITS.maxServiceLength) ??
    "attachments";

  const version =
    normalizeOptionalTextField(input.version, "version", FEEDBACK_LIMITS.maxVersionLength) ??
    normalizeOptionalTextField(defaults.version, "version", FEEDBACK_LIMITS.maxVersionLength) ??
    getPackageVersion();

  let email: string | null = null;
  const emailInput = normalizeOptionalTextField(input.email, "email", FEEDBACK_LIMITS.maxEmailLength);
  if (emailInput !== undefined) {
    email = normalizeEmail(emailInput);
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

export function assertFeedbackBodySize(byteLength: number): void {
  if (byteLength > FEEDBACK_LIMITS.maxBodyBytes) {
    throw new Error(`feedback body must be at most ${FEEDBACK_LIMITS.maxBodyBytes} bytes`);
  }
}

async function readLimitedBodyText(request: Request): Promise<string> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > 0) {
      try {
        assertFeedbackBodySize(contentLength);
      } catch (error) {
        throw new FeedbackBodyError(error instanceof Error ? error.message : String(error), 413);
      }
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    try {
      assertFeedbackBodySize(totalBytes);
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw new FeedbackBodyError(error instanceof Error ? error.message : String(error), 413);
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

export async function readFeedbackJsonBody(request: Request): Promise<FeedbackInput> {
  const text = await readLimitedBodyText(request);
  if (!text.trim()) {
    throw new FeedbackBodyError("JSON body is required", 400);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new FeedbackBodyError("JSON body is required", 400);
    }
    return parsed as FeedbackInput;
  } catch (error) {
    if (error instanceof FeedbackBodyError) throw error;
    throw new FeedbackBodyError("Invalid JSON body", 400);
  }
}

function configuredFeedbackUrl(): string | null {
  const direct =
    process.env["ATTACHMENTS_FEEDBACK_URL"]?.trim() ||
    process.env["HASNA_ATTACHMENTS_FEEDBACK_URL"]?.trim() ||
    "";
  return direct || null;
}

function isLocalUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function endpointFromBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");

  if (/\/(?:api|v1)\/feedback$/i.test(normalizedPath)) {
    parsed.pathname = normalizedPath;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  }

  if (/\/api$/i.test(normalizedPath)) {
    if (isLocalUrl(parsed)) {
      parsed.pathname = `${normalizedPath}/feedback`;
    } else {
      parsed.pathname = `${normalizedPath.slice(0, -4) || ""}/v1/feedback`;
    }
  } else if (/\/v1$/i.test(normalizedPath)) {
    parsed.pathname = `${normalizedPath}/feedback`;
  } else {
    parsed.pathname = `${normalizedPath}${isLocalUrl(parsed) ? "/api/feedback" : "/v1/feedback"}`;
  }

  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
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

function assertAllowedFeedbackEndpoint(endpoint: string, allowHttp?: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("feedback endpoint must be a valid URL");
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && (allowHttp || isLocalUrl(parsed))) return;
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
