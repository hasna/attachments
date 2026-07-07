// Self-hosted (`mode=self_hosted`) storage backend for the attachments CLI.
//
// LOCKED ARCHITECTURE: when `HASNA_ATTACHMENTS_API_URL` + `HASNA_ATTACHMENTS_API_KEY`
// are set, every read and write routes to the app's cloud HTTP API at
// `<API_URL>/v1` with the bearer key — never the local SQLite store, never a raw
// DSN. This uses the published `@hasna/contracts` storage-mode resolver and a
// narrow HTTP client for the attachments `/v1` API surface.
//
// The toggle is the presence of the two env vars (that is what the fleet flip
// tool writes): both set -> cloud; either unset -> local. An explicit
// `HASNA_ATTACHMENTS_STORAGE_MODE=local` forces local even when the vars are set.
//
// SAFETY: the API key never appears in logs or return values. It lives only
// inside scoped request headers.

import { randomUUID } from "crypto";
import { createWriteStream, existsSync, statSync } from "fs";
import { basename, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { resolveStorageMode } from "@hasna/contracts/mode";
import type { Attachment } from "./db";

const APP_SLUG = "attachments";

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
}

export type ResolveAttachmentsV1Result =
  | { transport: "cloud-http"; store: AttachmentsV1Store }
  | { transport: "local"; store: null };

type FetchLike = typeof fetch;

interface StorageClientOverrides {
  fetchImpl?: FetchLike;
}

interface StorageTransport {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

interface HasnaStorageClient {
  readonly baseUrl: string;
  readonly transport: StorageTransport;
  list<T>(resource: string, options?: { query?: Record<string, string> }): Promise<{ items: T[] }>;
  get<T>(resource: string, id: string): Promise<T | null>;
  create<T>(resource: string, body: unknown): Promise<T>;
  delete(resource: string, id: string): Promise<void>;
}

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
 * Bridge the fleet flip's two-var convention to the contracts resolver: when both
 * `HASNA_ATTACHMENTS_API_URL` and `HASNA_ATTACHMENTS_API_KEY` are present (and the
 * mode is not explicitly forced to `local`), treat the client as `self_hosted`
 * so the storage-mode resolver returns the cloud-http transport.
 */
function deriveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const url = env.HASNA_ATTACHMENTS_API_URL || env.ATTACHMENTS_API_URL;
  const key = env.HASNA_ATTACHMENTS_API_KEY || env.ATTACHMENTS_API_KEY;
  const legacyClientMode = (env.ATTACHMENTS_CLIENT_MODE || env.ATTACHMENTS_MODE || "").toLowerCase();
  const explicitMode = env.HASNA_ATTACHMENTS_STORAGE_MODE
    || env.HASNA_ATTACHMENTS_MODE
    || (legacyClientMode === "local" ? "local" : "");
  if (explicitMode) {
    return { ...env, HASNA_ATTACHMENTS_STORAGE_MODE: explicitMode };
  }
  if (url && key) {
    return { ...env, HASNA_ATTACHMENTS_STORAGE_MODE: "self_hosted" };
  }
  return env;
}

function normalizeBaseUrl(apiUrl: string): string {
  const trimmed = apiUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function resolveRequiredCloudConfig(env: NodeJS.ProcessEnv): { baseUrl: string; apiKey: string } {
  const apiUrl = env.HASNA_ATTACHMENTS_API_URL || env.ATTACHMENTS_API_URL;
  const apiKey = env.HASNA_ATTACHMENTS_API_KEY || env.ATTACHMENTS_API_KEY;
  if (!apiUrl || !apiKey) {
    throw new Error("HASNA_ATTACHMENTS_API_URL and HASNA_ATTACHMENTS_API_KEY are required for self_hosted attachments storage");
  }
  return { baseUrl: normalizeBaseUrl(apiUrl), apiKey };
}

function createStorageClient(
  env: NodeJS.ProcessEnv,
  overrides: StorageClientOverrides = {},
): HasnaStorageClient {
  const { baseUrl, apiKey } = resolveRequiredCloudConfig(env);
  const fetchImpl = overrides.fetchImpl ?? fetch;

  async function request<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string>; idempotencyKey?: string } = {},
  ): Promise<T> {
    const url = new URL(path.replace(/^\/+/, ""), `${baseUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
    };
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    const response = await fetchImpl(url.toString(), {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  return {
    baseUrl,
    transport: {
      get: (path) => request("GET", path),
      post: (path, body) => request("POST", path, { body }),
    },
    async list<T>(resource: string, options: { query?: Record<string, string> } = {}) {
      const result = await request<T[] | { items: T[] }>("GET", resource, { query: options.query });
      return Array.isArray(result) ? { items: result } : result;
    },
    async get<T>(resource: string, id: string) {
      try {
        return await request<T>("GET", `${resource}/${encodeURIComponent(id)}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("HTTP 404")) return null;
        throw error;
      }
    },
    async create<T>(resource: string, body: unknown) {
      return request<T>("POST", resource, {
        body,
        idempotencyKey: `${APP_SLUG}:${resource}:create:${randomUUID()}`,
      });
    },
    async delete(resource: string, id: string) {
      try {
        await request("DELETE", `${resource}/${encodeURIComponent(id)}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("HTTP 404")) return;
        throw error;
      }
    },
  };
}

/**
 * Resolve the attachments storage backend for this process. Returns a
 * `cloud-http` store wired to `<API_URL>/v1` when self_hosted is configured,
 * otherwise `{ transport: 'local' }` so the caller uses the local SQLite store.
 * Throws (via the contracts resolver) if cloud is requested but misconfigured, so
 * a client never silently drifts back to local.
 */
export function resolveAttachmentsV1(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: StorageClientOverrides,
): ResolveAttachmentsV1Result {
  const derivedEnv = deriveEnv(env);
  const resolved = resolveStorageMode(APP_SLUG, derivedEnv);
  if (resolved.mode !== "cloud") return { transport: "local", store: null };
  const client = createStorageClient(derivedEnv, overrides);
  return { transport: "cloud-http", store: makeStore(client, derivedEnv) };
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
      const { baseUrl, apiKey } = resolveRequiredCloudConfig(env);
      const response = await fetch(`${baseUrl}/attachments/${encodeURIComponent(id)}/download`, {
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
  };
  return store;
}

function resolveDownloadPath(output: string | undefined, filename: string): string {
  if (!output) return join(process.cwd(), filename);
  if (existsSync(output) && statSync(output).isDirectory()) return join(output, filename);
  if (output.endsWith("/") || output.endsWith("\\")) return join(output, filename);
  return output;
}
