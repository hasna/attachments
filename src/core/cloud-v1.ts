// HTTP storage backend for the attachments CLI when server data is selected.
//
// LOCKED ARCHITECTURE: when `HASNA_ATTACHMENTS_API_URL` + `HASNA_ATTACHMENTS_API_KEY`
// are set, every read and write routes to the app's cloud HTTP API at
// `<API_URL>/v1` with the bearer key — never the local SQLite store, never a raw
// DSN. This uses a small in-repo JSON HTTP client for the attachments `/v1`
// surface so the CLI does not depend on unpublished contracts package exports.
//
// The toggle is the presence of the two env vars (that is what the fleet flip
// tool writes): both set -> HTTP; either unset -> SQLite. An explicit
// `HASNA_ATTACHMENTS_STORAGE_MODE=sqlite` forces SQLite even when the vars are set.
//
// SAFETY: the API key never appears in logs or return values. It lives only
// inside the contracts transport (and, for the binary download stream that the
// JSON transport can't carry, a single scoped fetch below).

import { createWriteStream, existsSync, statSync } from "fs";
import { basename, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { lookup as mimeLookup } from "mime-types";
import type { Attachment } from "./db";
import { normalizeStorageMode } from "../generated/storage-kit/mode.js";

const APP_SLUG = "attachments";

type JsonFetch = typeof fetch;

type ResolveStorageClientOverrides = {
  fetchImpl?: JsonFetch;
};

type StorageClientResolution =
  | { transport: "cloud-http"; client: HasnaStorageClient }
  | { transport: "local"; client: null };

type ListResult<T> = { items: T[] };

interface HasnaStorageClient {
  readonly baseUrl: string;
  readonly transport: {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body: unknown): Promise<T>;
  };
  list<T>(resource: string, options?: { query?: Record<string, string> }): Promise<ListResult<T>>;
  get<T>(resource: string, id: string): Promise<T | null>;
  create<T>(resource: string, body: unknown): Promise<T>;
  delete(resource: string, id: string): Promise<void>;
}

/** The `/v1` attachment envelope (snake_case) returned by the serve API. */
type ApiAttachment = {
  id: string;
  filename: string;
  size: number;
  content_type?: string;
  link: string | null;
  tag?: string | null;
  expires_at?: number | null;
  created_at?: number;
};

export interface V1UploadOptions {
  expiry?: string;
  tag?: string;
  password?: string;
  maxDownloads?: number;
  linkType?: "presigned" | "server";
  filename?: string;
}

export interface V1ListOptions {
  limit?: number;
  includeExpired?: boolean;
  tag?: string;
}

export interface V1DownloadResult {
  path: string;
  filename: string;
  size: number;
}

/** The record-level storage surface the CLI needs, backed by `<API_URL>/v1`. */
export interface AttachmentsV1Store {
  readonly baseUrl: string;
  list(options?: V1ListOptions): Promise<Attachment[]>;
  get(id: string): Promise<Attachment | null>;
  uploadBuffer(filename: string, bytes: Uint8Array, options?: V1UploadOptions): Promise<Attachment>;
  uploadFile(path: string, options?: V1UploadOptions): Promise<Attachment>;
  uploadStream(stream: NodeJS.ReadableStream, filename: string, options?: V1UploadOptions): Promise<Attachment>;
  uploadUrl(url: string, options?: V1UploadOptions): Promise<Attachment>;
  delete(id: string): Promise<void>;
  getLink(id: string): Promise<{ link: string | null; expires_at: number | null }>;
  regenerateLink(
    id: string,
    options: { expiry?: string; password?: string; maxDownloads?: number; linkType?: "presigned" | "server" },
  ): Promise<{ link: string | null; expires_at: number | null }>;
  download(id: string, output: string | undefined, options?: { password?: string }): Promise<V1DownloadResult>;
  saveFeedback(input: { message: string; email?: string | null; category?: string; version?: string | null }): Promise<void>;
}

export type ResolveAttachmentsV1Result =
  | { transport: "cloud-http"; store: AttachmentsV1Store }
  | { transport: "local"; store: null };

function toAttachment(input: ApiAttachment): Attachment {
  return {
    id: input.id,
    filename: input.filename,
    s3Key: "",
    bucket: "cloud",
    size: input.size,
    contentType: input.content_type ?? "application/octet-stream",
    link: input.link,
    tag: input.tag ?? null,
    expiresAt: input.expires_at ?? null,
    createdAt: input.created_at ?? Date.now(),
    storageBackend: "s3",
    status: "ready",
  };
}

/**
 * Resolve the attachments storage backend for this process. Returns a
 * `cloud-http` store wired to `<API_URL>/v1` when the postgres backend is
 * selected, otherwise `{ transport: 'local' }` so the caller uses SQLite.
 * Throws if postgres is explicitly requested but misconfigured, so a client
 * never silently reads the wrong dataset.
 */
export function resolveAttachmentsV1(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: ResolveStorageClientOverrides,
): ResolveAttachmentsV1Result {
  const resolved = resolveStorageClient(APP_SLUG, env, overrides);
  if (resolved.transport !== "cloud-http") return { transport: "local", store: null };
  return { transport: "cloud-http", store: makeStore(resolved.client, env) };
}

function resolveStorageClient(
  _appName: string,
  env: NodeJS.ProcessEnv,
  overrides: ResolveStorageClientOverrides = {},
): StorageClientResolution {
  const apiUrl = env.HASNA_ATTACHMENTS_API_URL || env.ATTACHMENTS_API_URL;
  const apiKey = env.HASNA_ATTACHMENTS_API_KEY || env.ATTACHMENTS_API_KEY;
  const explicitMode =
    env.HASNA_ATTACHMENTS_STORAGE_MODE ||
    env.HASNA_ATTACHMENTS_MODE ||
    env.ATTACHMENTS_STORAGE_MODE ||
    env.ATTACHMENTS_MODE;
  const mode = explicitMode
    ? normalizeStorageMode(explicitMode).mode
    : apiUrl && apiKey
      ? "postgres"
      : "sqlite";

  if (mode === "sqlite") return { transport: "local", client: null };
  if (!apiUrl || !apiKey) {
    throw new Error(
      "Postgres-backed attachments require HASNA_ATTACHMENTS_API_URL and HASNA_ATTACHMENTS_API_KEY on the client",
    );
  }

  return { transport: "cloud-http", client: createStorageClient(apiUrl, apiKey, overrides.fetchImpl ?? fetch) };
}

/**
 * Build a diagnosable client-side error for a failed API call.
 *
 * D1(a): the previous message was just the raw response body, so a server that
 * answered `Internal Server Error` produced a CLI error of exactly
 * "Internal Server Error" — no status, no route, no server-side reason. Every
 * failure then required CloudWatch to identify. The API key is never included.
 */
export function describeApiFailure(
  method: string,
  path: string,
  status: number,
  body: string,
): string {
  const route = `${method.toUpperCase()} /v1${path}`;
  let reason = body.trim();
  if (reason.startsWith("{")) {
    try {
      const parsed = JSON.parse(reason) as { error?: unknown; detail?: unknown; message?: unknown };
      const parts = [parsed.error, parsed.detail ?? parsed.message]
        .filter((v): v is string => typeof v === "string" && v.trim() !== "");
      if (parts.length > 0) reason = Array.from(new Set(parts)).join(" — ");
    } catch {
      /* keep the raw body */
    }
  }
  if (reason.length > 500) reason = `${reason.slice(0, 500)}…`;
  return reason
    ? `${route} failed: HTTP ${status} — ${reason}`
    : `${route} failed: HTTP ${status}`;
}

function createStorageClient(apiUrl: string, apiKey: string, fetchImpl: JsonFetch): HasnaStorageClient {
  const baseUrl = `${apiUrl.replace(/\/+$/, "")}/v1`;
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    });
    if (response.status === 404) throw Object.assign(new Error("Not found"), { status: 404 });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw Object.assign(new Error(describeApiFailure(init.method ?? "GET", path, response.status, text)), {
        status: response.status,
        body: text,
      });
    }
    const text = await response.text();
    if (!text) return undefined as T;
    if (!response.headers.get("content-type")?.includes("application/json")) return text as T;
    return JSON.parse(text) as T;
  };

  return {
    baseUrl,
    transport: {
      get: (path) => request(path),
      post: (path, body) => request(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
    },
    async list<T>(resource: string, options: { query?: Record<string, string> } = {}) {
      const query = new URLSearchParams(options.query ?? {});
      const suffix = query.size ? `?${query.toString()}` : "";
      const body = await request<T[] | { items: T[] }>(`/${resource}${suffix}`);
      return Array.isArray(body) ? { items: body } : body;
    },
    async get<T>(resource: string, id: string) {
      try {
        return await request<T>(`/${resource}/${encodeURIComponent(id)}`);
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    },
    create: <T>(resource: string, body: unknown) => request<T>(`/${resource}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "idempotency-key": crypto.randomUUID() },
    }),
    async delete(resource: string, id: string) {
      try {
        await request(`/${resource}/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
    },
  };
}

function makeStore(client: HasnaStorageClient, env: NodeJS.ProcessEnv): AttachmentsV1Store {
  const uploadBody = (filename: string, bytes: Uint8Array, options: V1UploadOptions) => ({
    filename,
    content_base64: Buffer.from(bytes).toString("base64"),
    ...(options.expiry ? { expiry: options.expiry } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
    ...(options.password ? { password: options.password } : {}),
    ...(options.maxDownloads ? { max_downloads: options.maxDownloads } : {}),
    ...(options.linkType ? { link_type: options.linkType } : {}),
  });

  const store: AttachmentsV1Store = {
    baseUrl: client.baseUrl,

    async list(options: V1ListOptions = {}): Promise<Attachment[]> {
      const query: Record<string, string> = {};
      if (options.limit) query.limit = String(options.limit);
      if (options.includeExpired) query.expired = "true";
      if (options.tag) query.tag = options.tag;
      const result = await client.list<ApiAttachment>("attachments", { query });
      return result.items.map(toAttachment);
    },

    async get(id: string): Promise<Attachment | null> {
      const row = await client.get<ApiAttachment>("attachments", id);
      return row ? toAttachment(row) : null;
    },

    async uploadBuffer(filename: string, bytes: Uint8Array, options: V1UploadOptions = {}): Promise<Attachment> {
      const created = await client.create<ApiAttachment>("attachments", uploadBody(filename, bytes, options));
      return toAttachment(created);
    },

    async uploadFile(path: string, options: V1UploadOptions = {}): Promise<Attachment> {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      return store.uploadBuffer(options.filename || basename(path), bytes, options);
    },

    async uploadStream(stream: NodeJS.ReadableStream, filename: string, options: V1UploadOptions = {}): Promise<Attachment> {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return store.uploadBuffer(options.filename || filename, Buffer.concat(chunks), options);
    },

    async uploadUrl(url: string, options: V1UploadOptions = {}): Promise<Attachment> {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const parsed = new URL(url);
      const filename = options.filename || decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "download");
      return store.uploadBuffer(filename, bytes, options);
    },

    async delete(id: string): Promise<void> {
      await client.delete("attachments", id);
    },

    async getLink(id: string): Promise<{ link: string | null; expires_at: number | null }> {
      return client.transport.get(`/attachments/${encodeURIComponent(id)}/link`);
    },

    async regenerateLink(id, options): Promise<{ link: string | null; expires_at: number | null }> {
      return client.transport.post(`/attachments/${encodeURIComponent(id)}/link`, {
        expiry: options.expiry,
        password: options.password,
        max_downloads: options.maxDownloads,
        link_type: options.linkType,
      });
    },

    async download(id: string, output: string | undefined, options: { password?: string } = {}): Promise<V1DownloadResult> {
      // The JSON transport can't carry a binary stream, so hit the download route
      // directly with a scoped fetch using the same env creds. The key is read
      // here only; it is never logged or returned.
      const apiUrl = (env.HASNA_ATTACHMENTS_API_URL || env.ATTACHMENTS_API_URL || "").replace(/\/+$/, "");
      const apiKey = env.HASNA_ATTACHMENTS_API_KEY || env.ATTACHMENTS_API_KEY || "";
      const response = await fetch(`${apiUrl}/v1/attachments/${encodeURIComponent(id)}/download`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "x-api-key": apiKey,
          ...(options.password ? { "x-attachments-password": options.password } : {}),
        },
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `Download failed with HTTP ${response.status}`);
      }
      const disposition = response.headers.get("content-disposition");
      const match = disposition ? /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition) : null;
      const filename = (match ? decodeURIComponent(match[1]!.replace(/^"|"$/g, "")) : null)
        || basename(new URL(response.url).pathname)
        || "attachment";
      const path = resolveDownloadPath(output, filename);
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path));
      return { path, filename, size: Number(response.headers.get("content-length") || statSync(path).size) };
    },

    async saveFeedback(input): Promise<void> {
      await client.transport.post("/feedback", {
        message: input.message,
        email: input.email ?? null,
        category: input.category ?? "general",
        version: input.version ?? null,
      });
    },
  };
  return store;
}

function resolveDownloadPath(output: string | undefined, filename: string): string {
  if (!output) return join(process.cwd(), filename);
  if (existsSync(output) && statSync(output).isDirectory()) return join(output, filename);
  if (output.endsWith("/") || output.endsWith("\\")) return join(output, filename);
  return output;
}
