import { createWriteStream, existsSync, statSync } from "fs";
import { basename, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { lookup as mimeLookup } from "mime-types";
import type { Attachment } from "./db";
import {
  getClientApiBaseUrl,
  getClientApiToken,
  getConfig,
  type AttachmentsConfig,
} from "./config";

type HeadersInit = Record<string, string>;

export interface CloudClientOptions {
  baseUrl?: string;
  token?: string;
  config?: AttachmentsConfig;
}

export interface CloudUploadOptions {
  expiry?: string;
  linkType?: "presigned" | "server";
  tag?: string;
  password?: string;
  encrypt?: boolean;
  maxDownloads?: number;
  filename?: string;
  multipartThresholdBytes?: number;
}

export interface CloudDownloadResult {
  path: string;
  filename: string;
  size: number;
}

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

const DEFAULT_MULTIPART_THRESHOLD = 64 * 1024 * 1024;

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function requireBaseUrl(options: CloudClientOptions): string {
  const baseUrl = options.baseUrl || getClientApiBaseUrl(options.config ?? getConfig());
  if (!baseUrl) {
    throw new Error("Cloud API URL is not configured. Run `attachments config set --client-mode cloud --api-url <url>` or set ATTACHMENTS_API_URL.");
  }
  return normalizeBaseUrl(baseUrl);
}

function requireToken(options: CloudClientOptions): string {
  const token = options.token || getClientApiToken(options.config ?? getConfig());
  if (!token) {
    throw new Error("Cloud API token is not configured. Set ATTACHMENTS_API_TOKEN or run `attachments config set --api-token-env <name>`.");
  }
  return token;
}

function authHeaders(options: CloudClientOptions, extra?: HeadersInit): HeadersInit {
  return {
    authorization: `Bearer ${requireToken(options)}`,
    ...(extra ?? {}),
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed as T;
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

function appendUploadQuery(url: URL, options: CloudUploadOptions): void {
  if (options.expiry) url.searchParams.set("expiry", options.expiry);
  if (options.linkType) url.searchParams.set("link_type", options.linkType);
  if (options.tag) url.searchParams.set("tag", options.tag);
  if (options.encrypt) url.searchParams.set("encrypt", "1");
  if (options.maxDownloads) url.searchParams.set("max_downloads", String(options.maxDownloads));
}

function uploadOptionHeaders(options: CloudUploadOptions, extra?: HeadersInit): HeadersInit {
  return {
    ...(extra ?? {}),
    ...(options.password ? { "x-attachments-password": options.password } : {}),
  };
}

async function uploadFileByPut(path: string, options: CloudUploadOptions, client: CloudClientOptions): Promise<Attachment> {
  const filename = options.filename || basename(path);
  const url = new URL(`${requireBaseUrl(client)}/api/attachments`);
  url.searchParams.set("filename", filename);
  appendUploadQuery(url, options);

  const file = Bun.file(path);
  const response = await fetch(url, {
    method: "PUT",
    headers: authHeaders(client, uploadOptionHeaders(options, {
      "content-type": mimeLookup(filename) || "application/octet-stream",
      "content-length": String(file.size),
    })),
    body: file.stream(),
  });
  return toAttachment(await readJson<ApiAttachment>(response));
}

async function uploadFileByMultipart(path: string, options: CloudUploadOptions, client: CloudClientOptions): Promise<Attachment> {
  const filename = options.filename || basename(path);
  const file = Bun.file(path);
  const contentType = mimeLookup(filename) || "application/octet-stream";
  const createResponse = await fetch(`${requireBaseUrl(client)}/api/attachments/multipart`, {
    method: "POST",
    headers: authHeaders(client, { "content-type": "application/json" }),
    body: JSON.stringify({
      filename,
      content_type: contentType,
      size: file.size,
      tag: options.tag,
    }),
  });
  const created = await readJson<{ id: string; upload_id: string; part_size: number }>(createResponse);

  const parts: Array<{ ETag: string; PartNumber: number }> = [];
  try {
    for (let start = 0, partNumber = 1; start < file.size; start += created.part_size, partNumber++) {
      const end = Math.min(start + created.part_size, file.size);
      const partResponse = await fetch(`${requireBaseUrl(client)}/api/attachments/${encodeURIComponent(created.id)}/multipart/part`, {
        method: "POST",
        headers: authHeaders(client, { "content-type": "application/json" }),
        body: JSON.stringify({ upload_id: created.upload_id, part_number: partNumber }),
      });
      const signed = await readJson<{ upload_url: string }>(partResponse);
      const putResponse = await fetch(signed.upload_url, {
        method: "PUT",
        body: file.slice(start, end),
      });
      if (!putResponse.ok) throw new Error(`Part ${partNumber} upload failed with HTTP ${putResponse.status}`);
      const etag = putResponse.headers.get("etag");
      if (!etag) throw new Error(`Part ${partNumber} upload did not return an ETag`);
      parts.push({ ETag: etag, PartNumber: partNumber });
    }

    const completeResponse = await fetch(`${requireBaseUrl(client)}/api/attachments/${encodeURIComponent(created.id)}/multipart/complete`, {
      method: "POST",
      headers: authHeaders(client, { "content-type": "application/json" }),
      body: JSON.stringify({
        upload_id: created.upload_id,
        parts,
        expiry: options.expiry,
        password: options.password,
        max_downloads: options.maxDownloads,
        size: file.size,
      }),
    });
    return toAttachment(await readJson<ApiAttachment>(completeResponse));
  } catch (error) {
    await fetch(`${requireBaseUrl(client)}/api/attachments/${encodeURIComponent(created.id)}/multipart/abort`, {
      method: "POST",
      headers: authHeaders(client, { "content-type": "application/json" }),
      body: JSON.stringify({ upload_id: created.upload_id }),
    }).catch(() => undefined);
    throw error;
  }
}

export async function uploadFileToCloudApi(path: string, options: CloudUploadOptions = {}, client: CloudClientOptions = {}): Promise<Attachment> {
  const size = statSync(path).size;
  const threshold = options.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD;
  if (!options.encrypt && size >= threshold) {
    return uploadFileByMultipart(path, options, client);
  }
  return uploadFileByPut(path, options, client);
}

export async function uploadStreamToCloudApi(
  stream: NodeJS.ReadableStream,
  filename: string,
  contentType: string,
  options: CloudUploadOptions = {},
  client: CloudClientOptions = {}
): Promise<Attachment> {
  const url = new URL(`${requireBaseUrl(client)}/api/attachments`);
  url.searchParams.set("filename", filename);
  appendUploadQuery(url, options);
  const response = await fetch(url, {
    method: "PUT",
    headers: authHeaders(client, uploadOptionHeaders(options, {
      "content-type": contentType,
    })),
    body: stream as never,
  });
  return toAttachment(await readJson<ApiAttachment>(response));
}

export async function uploadUrlToCloudApi(sourceUrl: string, options: CloudUploadOptions = {}, client: CloudClientOptions = {}): Promise<Attachment> {
  const response = await fetch(sourceUrl);
  if (!response.ok || !response.body) throw new Error(`Could not fetch ${sourceUrl}: HTTP ${response.status}`);
  const parsed = new URL(sourceUrl);
  const filename = options.filename || decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "download");
  const url = new URL(`${requireBaseUrl(client)}/api/attachments`);
  url.searchParams.set("filename", filename);
  appendUploadQuery(url, options);
  const uploadResponse = await fetch(url, {
    method: "PUT",
    headers: authHeaders(client, uploadOptionHeaders(options, {
      "content-type": response.headers.get("content-type") || "application/octet-stream",
    })),
    body: response.body,
  });
  return toAttachment(await readJson<ApiAttachment>(uploadResponse));
}

export async function listCloudAttachments(options: { limit?: number; includeExpired?: boolean; tag?: string } = {}, client: CloudClientOptions = {}): Promise<Attachment[]> {
  const url = new URL(`${requireBaseUrl(client)}/api/attachments`);
  if (options.limit) url.searchParams.set("limit", String(options.limit));
  if (options.includeExpired) url.searchParams.set("expired", "true");
  if (options.tag) url.searchParams.set("tag", options.tag);
  const response = await fetch(url, { headers: authHeaders(client) });
  return (await readJson<ApiAttachment[]>(response)).map(toAttachment);
}

export async function getCloudAttachment(id: string, client: CloudClientOptions = {}): Promise<Attachment> {
  const response = await fetch(`${requireBaseUrl(client)}/api/attachments/${encodeURIComponent(id)}`, {
    headers: authHeaders(client),
  });
  return toAttachment(await readJson<ApiAttachment>(response));
}

export async function deleteCloudAttachment(id: string, client: CloudClientOptions = {}): Promise<void> {
  const response = await fetch(`${requireBaseUrl(client)}/api/attachments/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(client),
  });
  await readJson<unknown>(response);
}

export async function getCloudAttachmentLink(id: string, client: CloudClientOptions = {}): Promise<{ link: string | null; expires_at: number | null }> {
  const response = await fetch(`${requireBaseUrl(client)}/api/attachments/${encodeURIComponent(id)}/link`, {
    headers: authHeaders(client),
  });
  return readJson(response);
}

export async function regenerateCloudAttachmentLink(
  id: string,
  options: { expiry?: string; password?: string; maxDownloads?: number; linkType?: "presigned" | "server" },
  client: CloudClientOptions = {}
): Promise<{ link: string | null; expires_at: number | null }> {
  const response = await fetch(`${requireBaseUrl(client)}/api/attachments/${encodeURIComponent(id)}/link`, {
    method: "POST",
    headers: authHeaders(client, { "content-type": "application/json" }),
    body: JSON.stringify({
      expiry: options.expiry,
      password: options.password,
      max_downloads: options.maxDownloads,
      link_type: options.linkType,
    }),
  });
  return readJson(response);
}

function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(value);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!.replace(/^"|"$/g, ""));
  } catch {
    return match[1]!.replace(/^"|"$/g, "");
  }
}

function resolveDownloadPath(output: string | undefined, filename: string): string {
  if (!output) return join(process.cwd(), filename);
  if (existsSync(output) && statSync(output).isDirectory()) return join(output, filename);
  if (output.endsWith("/") || output.endsWith("\\")) return join(output, filename);
  return output;
}

export async function downloadFromCloud(
  idOrUrl: string,
  output?: string,
  options: { password?: string } = {},
  client: CloudClientOptions = {}
): Promise<CloudDownloadResult> {
  let response: Response;
  if (/^https?:\/\//.test(idOrUrl)) {
    const url = new URL(idOrUrl);
    const tokenMatch = url.pathname.match(/\/a\/([^/]+)/);
    if (tokenMatch) {
      const downloadUrl = new URL(`${url.origin}/a/${encodeURIComponent(tokenMatch[1]!)}/download`);
      response = await fetch(downloadUrl, {
        method: options.password ? "POST" : "GET",
        headers: options.password
          ? { "content-type": "application/x-www-form-urlencoded", "x-attachments-download": "1" }
          : { "x-attachments-download": "1" },
        body: options.password ? new URLSearchParams({ password: options.password }) : undefined,
      });
    } else {
      response = await fetch(idOrUrl);
    }
  } else {
    response = await fetch(`${requireBaseUrl(client)}/api/attachments/${encodeURIComponent(idOrUrl)}/download`, {
      headers: authHeaders(client, options.password ? { "x-attachments-password": options.password } : undefined),
    });
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Download failed with HTTP ${response.status}`);
  }

  const filename = filenameFromDisposition(response.headers.get("content-disposition")) || basename(new URL(response.url).pathname) || "attachment";
  const path = resolveDownloadPath(output, filename);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path));
  return {
    path,
    filename,
    size: Number(response.headers.get("content-length") || statSync(path).size),
  };
}

export async function getCloudHealth(client: CloudClientOptions = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`${requireBaseUrl(client)}/api/health`);
  return readJson(response);
}
