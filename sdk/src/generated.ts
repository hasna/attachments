// @generated from src/serve/openapi.ts by scripts/generate-sdk.ts — DO NOT EDIT.
// Regenerate: bun run sdk:generate

// @generated from OpenAPI by @hasna/contracts SDK generator — DO NOT EDIT.
// Source: AttachmentsApi 0.0.0

export interface Attachment { "id": string; "filename": string; "size": number; "content_type"?: string; "link"?: string | null; "tag"?: string | null; "expires_at"?: number | null; "created_at": number }

export interface HealthStatus { "status": string; "version": string; "mode": string }

export interface ReadyStatus { "status": string; "version": string; "mode": string; "pending_migrations"?: Array<string> }

export interface VersionInfo { "status": string; "version": string; "mode": string }

export interface CreateAttachmentRequest { "filename": string; "content_base64": string; "expiry"?: string; "tag"?: string; "password"?: string; "max_downloads"?: number; "link_type"?: "presigned" | "server" }

export interface CreateFeedbackRequest { "service"?: string; "version"?: string; "message": string; "email"?: string | null; "timestamp"?: string }

export interface Feedback { "id": string; "service": string; "version": string; "message": string; "email"?: string | null; "timestamp": string }

export interface LinkResponse { "link": string | null; "expires_at"?: number | null }

export interface RegenerateLinkRequest { "expiry"?: string; "password"?: string; "max_downloads"?: number; "link_type"?: "presigned" | "server" }

export interface DeleteResponse { "deleted": boolean; "id": string }

export type AttachmentList = Array<{ "id": string; "filename": string; "size": number; "content_type"?: string; "link"?: string | null; "tag"?: string | null; "expires_at"?: number | null; "created_at": number }>;

export interface ErrorResponse { "error": string }

export interface AttachmentsApiClientOptions {
  /** Base URL, e.g. process.env.APP_API_URL. */
  baseUrl: string;
  /** API key, e.g. process.env.APP_API_KEY. Sent as the 'x-api-key' header. */
  apiKey?: string;
  /** Custom fetch (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export class AttachmentsApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseHeaders: Record<string, string>;

  constructor(options: AttachmentsApiClientOptions) {
    if (!options.baseUrl) throw new Error("AttachmentsApiClient requires a baseUrl.");
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseHeaders = options.headers ?? {};
  }

  private async request<T>(method: string, path: string, opts: { body?: unknown; query?: Record<string, unknown>; init?: RequestInit }): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = { Accept: "application/json", ...this.baseHeaders, ...(opts.init?.headers as Record<string, string> | undefined) };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    let payload: BodyInit | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }
    const response = await this.fetchImpl(url.toString(), { ...opts.init, method, headers, body: payload });
    const text = await response.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
    if (!response.ok) {
      throw new ApiError(response.status, `${method} ${path} failed: ${response.status}`, data);
    }
    return data as T;
  }

    /** Liveness probe. */
    async getHealth(init?: RequestInit): Promise<HealthStatus> {
      return this.request("GET", `/health`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Readiness probe (DB reachable and schema migrated). */
    async getReady(init?: RequestInit): Promise<ReadyStatus> {
      return this.request("GET", `/ready`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** List attachments. */
    async listAttachments(query?: { "limit"?: number; "tag"?: string; "expired"?: boolean }, init?: RequestInit): Promise<AttachmentList> {
      return this.request("GET", `/v1/attachments`, {
        body: undefined,
        query,
        init,
      });
    }

    /** Create an attachment from base64 content. */
    async createAttachment(body: CreateAttachmentRequest, init?: RequestInit): Promise<Attachment> {
      return this.request("POST", `/v1/attachments`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Get attachment metadata. */
    async getAttachment(id: string, init?: RequestInit): Promise<Attachment> {
      return this.request("GET", `/v1/attachments/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Delete an attachment. */
    async deleteAttachment(id: string, init?: RequestInit): Promise<DeleteResponse> {
      return this.request("DELETE", `/v1/attachments/${encodeURIComponent(String(id))}`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Get the current share link. */
    async getAttachmentLink(id: string, init?: RequestInit): Promise<LinkResponse> {
      return this.request("GET", `/v1/attachments/${encodeURIComponent(String(id))}/link`, {
        body: undefined,
        query: undefined,
        init,
      });
    }

    /** Regenerate the share link. */
    async regenerateAttachmentLink(id: string, body?: RegenerateLinkRequest, init?: RequestInit): Promise<LinkResponse> {
      return this.request("POST", `/v1/attachments/${encodeURIComponent(String(id))}/link`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Create a feedback record. */
    async createFeedback(body: CreateFeedbackRequest, init?: RequestInit): Promise<Feedback> {
      return this.request("POST", `/v1/feedback`, {
        body,
        query: undefined,
        init,
      });
    }

    /** Service version and mode. */
    async getVersion(init?: RequestInit): Promise<VersionInfo> {
      return this.request("GET", `/version`, {
        body: undefined,
        query: undefined,
        init,
      });
    }
}
