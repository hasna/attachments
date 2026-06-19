/**
 * @hasna/attachments-sdk
 * Zero-dependency TypeScript client for the @hasna/attachments REST API.
 * Works in Node.js, Bun, Deno, and browser environments.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface Attachment {
  id: string;
  filename: string;
  s3Key: string;
  bucket: string;
  size: number;
  contentType: string;
  tag: string | null;
  link: string | null;
  expiresAt: number | null;
  createdAt: number;
}

export interface AttachmentsClientOptions {
  /** Base URL of the attachments server, e.g. "http://localhost:3459" */
  serverUrl: string;
  /** Optional bearer token for protected API endpoints. Public share URLs do not use it. */
  token?: string;
}

export interface UploadOptions {
  expiry?: string;
  tag?: string;
  password?: string;
  encrypt?: boolean;
  maxDownloads?: number;
  linkType?: "presigned" | "server";
}

// Raw API response shape (snake_case from the server)
interface RawAttachment {
  id: string;
  filename: string;
  s3_key?: string;
  bucket?: string;
  size: number;
  content_type?: string;
  tag?: string | null;
  link: string | null;
  expires_at: number | null;
  created_at: number;
}

interface RawLinkResponse {
  link: string;
  expires_at: number | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mapAttachment(raw: RawAttachment): Attachment {
  return {
    id: raw.id,
    filename: raw.filename,
    s3Key: raw.s3_key ?? "",
    bucket: raw.bucket ?? "",
    size: raw.size,
    contentType: raw.content_type ?? "",
    tag: raw.tag ?? null,
    link: raw.link,
    expiresAt: raw.expires_at,
    createdAt: raw.created_at,
  };
}

async function checkResponse(res: Response): Promise<void> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore JSON parse errors — use status code message
    }
    throw new Error(message);
  }
}

function appendUploadParams(url: URL, opts?: UploadOptions): void {
  if (opts?.expiry) url.searchParams.set("expiry", opts.expiry);
  if (opts?.tag) url.searchParams.set("tag", opts.tag);
  if (opts?.encrypt) url.searchParams.set("encrypt", "1");
  if (opts?.maxDownloads) url.searchParams.set("max_downloads", String(opts.maxDownloads));
  if (opts?.linkType) url.searchParams.set("link_type", opts.linkType);
}

function uploadHeaders(opts?: UploadOptions, extra?: Record<string, string>): Record<string, string> {
  return {
    ...(extra ?? {}),
    ...(opts?.password ? { "x-attachments-password": opts.password } : {}),
  };
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

function toDownloadUrl(idOrUrl: string, baseUrl: string): string {
  if (!/^https?:\/\//.test(idOrUrl)) {
    return `${baseUrl}/api/attachments/${idOrUrl}/download`;
  }

  const url = new URL(idOrUrl);
  const legacyShare = url.pathname.match(/^\/a\/([^/]+)\/?$/);
  if (legacyShare) {
    return `${url.origin}/a/${encodeURIComponent(legacyShare[1]!)}/download`;
  }
  return idOrUrl;
}

function isLegacyShareDownloadUrl(value: string): boolean {
  if (!/^https?:\/\//.test(value)) return false;
  return /^\/a\/[^/]+\/download\/?$/.test(new URL(value).pathname);
}

// ── Client ─────────────────────────────────────────────────────────────────

export class AttachmentsClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(options: AttachmentsClientOptions) {
    // Strip trailing slash for consistent URL construction
    this.baseUrl = options.serverUrl.replace(/\/$/, "");
    this.token = options.token;
  }

  private headers(extra?: Record<string, string>): Record<string, string> | undefined {
    const headers = {
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(extra ?? {}),
    };
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  private fetchInit(extraHeaders?: Record<string, string>): RequestInit | undefined {
    const headers = this.headers(extraHeaders);
    return headers ? { headers } : undefined;
  }

  /**
   * Upload a file.
   * - In Node/Bun: pass a filesystem path (string) and the file is read with fs.readFileSync.
   * - In the browser: pass a File or Blob object directly.
   */
  async upload(
    filePathOrBlob: string | Blob | File,
    opts?: UploadOptions
  ): Promise<Attachment> {
    const url = new URL(`${this.baseUrl}/api/attachments`);

    if (typeof filePathOrBlob === "string") {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const filename = path.basename(filePathOrBlob);
      const stat = fs.statSync(filePathOrBlob);
      url.searchParams.set("filename", filename);
      appendUploadParams(url, opts);
      const init = {
        method: "PUT",
        headers: this.headers(uploadHeaders(opts, {
          "content-type": "application/octet-stream",
          "content-length": String(stat.size),
        })),
        body: fs.createReadStream(filePathOrBlob),
        duplex: "half",
      } as unknown as RequestInit & { duplex: "half" };
      const res = await fetch(url, init);
      await checkResponse(res);
      const raw = await res.json() as RawAttachment;
      return mapAttachment(raw);
    }

    const name = filePathOrBlob instanceof File ? filePathOrBlob.name : "upload";
    const contentType = filePathOrBlob.type || "application/octet-stream";
    url.searchParams.set("filename", name);
    appendUploadParams(url, opts);

    const res = await fetch(url, {
      method: "PUT",
      headers: this.headers(uploadHeaders(opts, { "content-type": contentType })),
      body: filePathOrBlob,
    });

    await checkResponse(res);
    const raw = await res.json() as RawAttachment;
    return mapAttachment(raw);
  }

  /**
   * Upload raw bytes (Buffer or Uint8Array) as an attachment.
   * Useful when you already have the file contents in memory.
   */
  async uploadBuffer(
    buffer: Buffer | Uint8Array,
    filename: string,
    opts?: UploadOptions
  ): Promise<Attachment> {
    const url = new URL(`${this.baseUrl}/api/attachments`);
    url.searchParams.set("filename", filename);
    appendUploadParams(url, opts);

    const res = await fetch(url, {
      method: "PUT",
      headers: this.headers(uploadHeaders(opts, {
        "content-type": "application/octet-stream",
        "content-length": String(buffer.byteLength),
      })),
      body: buffer as never,
    });

    await checkResponse(res);
    const raw = await res.json() as RawAttachment;
    return mapAttachment(raw);
  }

  /**
   * Download a file to the local filesystem (Node/Bun only).
   * @param idOrUrl - Attachment ID or a full download URL.
   * @param destPath - Directory or full file path to write to. Defaults to cwd.
   */
  async download(
    idOrUrl: string,
    destPath?: string,
    opts?: { password?: string }
  ): Promise<{ path: string; filename: string; size: number }> {
    const url = toDownloadUrl(idOrUrl, this.baseUrl);
    const isApiDownload = url.startsWith(`${this.baseUrl}/api/`);
    const isPublicShareDownload = isLegacyShareDownloadUrl(url);
    let init: RequestInit | undefined;
    if (isApiDownload) {
      const headers = this.headers(opts?.password ? { "x-attachments-password": opts.password } : undefined);
      init = headers ? { headers } : undefined;
    } else if (isPublicShareDownload && opts?.password) {
      init = {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-attachments-download": "1",
        },
        body: new URLSearchParams({ password: opts.password }),
      };
    } else if (isPublicShareDownload) {
      init = { headers: { "x-attachments-download": "1" } };
    } else if (opts?.password) {
      init = { headers: { "x-attachments-password": opts.password } };
    }
    const res = await fetch(url, init);
    await checkResponse(res);
    if (!res.body) throw new Error("Download response did not include a body");

    // Extract filename from Content-Disposition header
    const disposition = res.headers.get("content-disposition") ?? "";
    const filename = filenameFromDisposition(disposition) ?? idOrUrl.split("/").filter(Boolean).pop() ?? "download";

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const { Readable } = require("stream") as typeof import("stream");
    const { pipeline } = require("stream/promises") as typeof import("stream/promises");

    // Determine output path
    let outPath: string;
    if (!destPath) {
      outPath = path.join(process.cwd(), filename);
    } else {
      // If destPath is a directory, append the filename; otherwise use as-is
      let isDir = false;
      try {
        isDir = fs.statSync(destPath).isDirectory();
      } catch {
        // path doesn't exist — treat as a file path
      }
      outPath = isDir ? path.join(destPath, filename) : destPath;
    }

    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(outPath));
    const size = Number(res.headers.get("content-length") || fs.statSync(outPath).size);

    return { path: outPath, filename, size };
  }

  /**
   * List attachments.
   */
  async list(opts?: {
    limit?: number;
    fields?: string[];
    format?: "json" | "compact";
  }): Promise<Attachment[]> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.fields?.length) params.set("fields", opts.fields.join(","));
    if (opts?.format) params.set("format", opts.format);

    const query = params.toString();
    const url = `${this.baseUrl}/api/attachments${query ? `?${query}` : ""}`;

    const res = await fetch(url, this.fetchInit());
    await checkResponse(res);

    // compact format returns newline-delimited JSON
    if (opts?.format === "compact") {
      const text = await res.text();
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => mapAttachment(JSON.parse(line) as RawAttachment));
    }

    const raw = await res.json() as RawAttachment[];
    return raw.map(mapAttachment);
  }

  /**
   * Get a single attachment's metadata.
   */
  async get(id: string): Promise<Attachment> {
    const res = await fetch(`${this.baseUrl}/api/attachments/${id}`, this.fetchInit());
    await checkResponse(res);
    const raw = await res.json() as RawAttachment;
    return mapAttachment(raw);
  }

  /**
   * Delete an attachment (removes from S3 and database).
   */
  async delete(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/attachments/${id}`, {
      method: "DELETE",
      ...(this.headers() ? { headers: this.headers() } : {}),
    });
    await checkResponse(res);
  }

  /**
   * Get the current shareable link for an attachment.
   */
  async getLink(id: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/attachments/${id}/link`, this.fetchInit());
    await checkResponse(res);
    const body = await res.json() as RawLinkResponse;
    return body.link;
  }

  /**
   * Regenerate the shareable link for an attachment.
   */
  async regenerateLink(
    id: string,
    opts?: {
      expiry?: string;
      password?: string;
      maxDownloads?: number;
      linkType?: "presigned" | "server";
    }
  ): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/attachments/${id}/link`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        expiry: opts?.expiry,
        password: opts?.password,
        max_downloads: opts?.maxDownloads,
        link_type: opts?.linkType,
      }),
    });
    await checkResponse(res);
    const body = await res.json() as RawLinkResponse;
    return body.link;
  }

  /**
   * Get server health status.
   */
  async health(): Promise<{ status: string; attachments: number; expired: number; s3_configured: boolean; server: string; timestamp: string }> {
    const res = await fetch(`${this.baseUrl}/api/health`, this.fetchInit());
    await checkResponse(res);
    return res.json() as Promise<{ status: string; attachments: number; expired: number; s3_configured: boolean; server: string; timestamp: string }>;
  }

  /**
   * Get compact context text for agent system prompt injection.
   * Set ATTACHMENTS_URL env var to auto-inject into agent context.
   */
  async getContext(format?: "text" | "json"): Promise<string | { attachments: number; active: number; expired: number; expiring_soon: number; summary: string }> {
    const url = format === "json" ? `${this.baseUrl}/api/context?format=json` : `${this.baseUrl}/api/context`;
    const res = await fetch(url, this.fetchInit());
    await checkResponse(res);
    if (format === "json") return res.json() as Promise<{ attachments: number; active: number; expired: number; expiring_soon: number; summary: string }>;
    return res.text();
  }
}
