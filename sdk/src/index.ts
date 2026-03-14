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

// ── Client ─────────────────────────────────────────────────────────────────

export class AttachmentsClient {
  private readonly baseUrl: string;

  constructor(options: AttachmentsClientOptions) {
    // Strip trailing slash for consistent URL construction
    this.baseUrl = options.serverUrl.replace(/\/$/, "");
  }

  /**
   * Upload a file.
   * - In Node/Bun: pass a filesystem path (string) and the file is read with fs.readFileSync.
   * - In the browser: pass a File or Blob object directly.
   */
  async upload(
    filePathOrBlob: string | Blob | File,
    opts?: { expiry?: string; tag?: string }
  ): Promise<Attachment> {
    const form = new FormData();

    if (typeof filePathOrBlob === "string") {
      // Node/Bun path — use synchronous fs read to stay zero-dependency
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const buffer = fs.readFileSync(filePathOrBlob);
      const filename = path.basename(filePathOrBlob);
      const blob = new Blob([buffer]);
      form.append("file", blob, filename);
    } else {
      // Browser File / Blob
      const name = filePathOrBlob instanceof File ? filePathOrBlob.name : "upload";
      form.append("file", filePathOrBlob, name);
    }

    if (opts?.expiry) form.append("expiry", opts.expiry);
    if (opts?.tag) form.append("tag", opts.tag);

    const res = await fetch(`${this.baseUrl}/api/attachments`, {
      method: "POST",
      body: form,
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
    opts?: { expiry?: string; tag?: string }
  ): Promise<Attachment> {
    const form = new FormData();
    const blob = new Blob([buffer]);
    form.append("file", blob, filename);

    if (opts?.expiry) form.append("expiry", opts.expiry);
    if (opts?.tag) form.append("tag", opts.tag);

    const res = await fetch(`${this.baseUrl}/api/attachments`, {
      method: "POST",
      body: form,
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
    destPath?: string
  ): Promise<{ path: string; filename: string; size: number }> {
    // Resolve URL — if it looks like a full URL use it, otherwise build from ID
    const url = idOrUrl.startsWith("http")
      ? idOrUrl
      : `${this.baseUrl}/api/attachments/${idOrUrl}/download`;

    const res = await fetch(url);
    await checkResponse(res);

    // Extract filename from Content-Disposition header
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : idOrUrl.split("/").pop() ?? "download";

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");

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

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(outPath, buffer);

    return { path: outPath, filename, size: buffer.length };
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

    const res = await fetch(url);
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
    const res = await fetch(`${this.baseUrl}/api/attachments/${id}`);
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
    });
    await checkResponse(res);
  }

  /**
   * Get the current shareable link for an attachment.
   */
  async getLink(id: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/attachments/${id}/link`);
    await checkResponse(res);
    const body = await res.json() as RawLinkResponse;
    return body.link;
  }

  /**
   * Regenerate the shareable link for an attachment.
   */
  async regenerateLink(id: string, opts?: { expiry?: string }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/attachments/${id}/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts ?? {}),
    });
    await checkResponse(res);
    const body = await res.json() as RawLinkResponse;
    return body.link;
  }
}
