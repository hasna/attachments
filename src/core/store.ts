// Unified storage abstraction for the attachments client (CLI / MCP / SDK).
//
// LOCKED ARCHITECTURE: there is ONE `Store` interface with exactly two client
// transports behind it:
//   - LocalStore  — on-box: SQLite metadata (AttachmentsDB) + S3/local object
//                   bytes. Fully first-class, works with zero cloud config.
//   - ApiStore    — HTTP `<API_URL>/v1` + bearer key, via @hasna/contracts. Used
//                   for BOTH `self_hosted` (our AWS) and `cloud` (SaaS); the two
//                   differ only by URL/key, which is a server-side tenancy detail,
//                   not client code.
//
// The mode is resolved purely from env by `resolveStore` (delegating to the
// contracts client-flip): presence of HASNA_ATTACHMENTS_API_URL +
// HASNA_ATTACHMENTS_API_KEY (and/or HASNA_ATTACHMENTS_STORAGE_MODE) => ApiStore;
// otherwise LocalStore. This is the ONLY place that decision is made, so every
// command/tool/method routes through the same interface and no caller ever
// touches sqlite (`bun:sqlite`) or a raw `fetch` directly. That is the
// split-brain bug this module exists to eliminate.
//
// SAFETY: the bearer key lives only inside the contracts transport (ApiStore).
// A raw DB DSN is NEVER used on the client. LocalStore never sees a key.

import { basename } from "path";
import { nanoid } from "nanoid";
import { lookup as mimeLookup } from "mime-types";
import type { Attachment } from "./db";
import { AttachmentsDB } from "./db";
import { S3Client } from "./s3";
import { LocalObjectStore } from "./object-storage";
import {
  getConfig,
  getPublicBaseUrl,
  parseExpiryStrict,
  validateS3Config,
  validateStorageConfig,
  type AttachmentsConfig,
} from "./config";
import { generatePresignedLink, generateShareLink, getLinkType } from "./links";
import { createObjectKey, sanitizeFilename } from "./security";
import {
  uploadFile as coreUploadFile,
  uploadFromUrl as coreUploadFromUrl,
  uploadFromBuffer as coreUploadFromBuffer,
  uploadStreamAttachment as coreUploadStream,
  type UploadOptions,
} from "./upload";
import { downloadAttachment, type DownloadResult } from "./download";
import { resolveAttachmentsV1, type AttachmentsV1Store, type V1UploadOptions } from "./cloud-v1";

export type { UploadOptions } from "./upload";

/** Result of a link read / regeneration. `expires_at` is a unix ms timestamp. */
export interface LinkResult {
  link: string | null;
  expires_at: number | null;
}

export interface ListOptions {
  limit?: number;
  includeExpired?: boolean;
  tag?: string;
}

export interface RegenerateLinkOptions {
  expiry?: string;
  password?: string;
  maxDownloads?: number;
  linkType?: "presigned" | "server";
}

/**
 * The single storage surface every CLI command, MCP tool and SDK method uses.
 * Both {@link LocalStore} and {@link ApiStore} implement it identically so a
 * caller never branches on transport.
 */
export interface Store {
  /** Which transport backs this store — for diagnostics only, not for branching logic. */
  readonly transport: "local" | "cloud-http";
  /** `<origin>/v1` base URL for ApiStore; null for LocalStore. */
  readonly baseUrl: string | null;

  list(options?: ListOptions): Promise<Attachment[]>;
  get(id: string): Promise<Attachment | null>;

  uploadFile(path: string, options?: UploadOptions): Promise<Attachment>;
  uploadUrl(url: string, options?: UploadOptions): Promise<Attachment>;
  uploadBuffer(buffer: Buffer | Uint8Array, filename: string, options?: UploadOptions): Promise<Attachment>;
  uploadStream(
    stream: NodeJS.ReadableStream,
    filename: string,
    contentType: string | undefined,
    options?: UploadOptions,
  ): Promise<Attachment>;

  delete(id: string): Promise<void>;
  deleteExpired(): Promise<number>;

  getLink(id: string): Promise<LinkResult>;
  regenerateLink(id: string, options: RegenerateLinkOptions): Promise<LinkResult>;

  download(idOrUrl: string, output?: string, options?: { password?: string }): Promise<DownloadResult>;

  /** Release any held resources (DB handles). Always safe to call. */
  close(): void;
}

/** Options that ApiStore (self_hosted / cloud) cannot honor client-side. */
function assertApiSupported(options: UploadOptions | undefined): void {
  if (!options) return;
  if (options.encrypt) {
    throw new Error(
      "--encrypt is not supported in self_hosted/cloud mode (it encrypts bytes on the client before an on-box store). Run against local mode to encrypt at rest.",
    );
  }
  if (options.requireEmail || (options.allowedEmails && options.allowedEmails.length > 0)) {
    throw new Error(
      "email-gated links (--require-email / --allowed-email) are only available in local mode.",
    );
  }
  if (options.baseUrl) {
    throw new Error("--internal / custom base URL links are only available in local mode.");
  }
}

function toV1UploadOptions(options: UploadOptions = {}): V1UploadOptions {
  assertApiSupported(options);
  return {
    expiry: options.expiry,
    tag: options.tag,
    password: options.password,
    maxDownloads: options.maxDownloads,
    linkType: options.linkType,
  };
}

/**
 * On-box store: SQLite metadata + S3/local object bytes. First-class; works with
 * no cloud configuration. A single {@link AttachmentsDB} handle is reused across
 * calls and released by {@link LocalStore.close}.
 */
export class LocalStore implements Store {
  readonly transport = "local" as const;
  readonly baseUrl = null;

  private _db: AttachmentsDB | null = null;
  private readonly config: AttachmentsConfig;

  constructor(config?: AttachmentsConfig) {
    this.config = config ?? getConfig();
  }

  private db(): AttachmentsDB {
    if (!this._db) this._db = new AttachmentsDB();
    return this._db;
  }

  async list(options: ListOptions = {}): Promise<Attachment[]> {
    return this.db().findAll(options);
  }

  async get(id: string): Promise<Attachment | null> {
    return this.db().findById(id);
  }

  async uploadFile(path: string, options: UploadOptions = {}): Promise<Attachment> {
    validateStorageConfig(this.config);
    return coreUploadFile(path, options, { db: this.db(), config: this.config });
  }

  async uploadUrl(url: string, options: UploadOptions = {}): Promise<Attachment> {
    validateStorageConfig(this.config);
    return coreUploadFromUrl(url, options, { db: this.db(), config: this.config });
  }

  async uploadBuffer(buffer: Buffer | Uint8Array, filename: string, options: UploadOptions = {}): Promise<Attachment> {
    validateStorageConfig(this.config);
    return coreUploadFromBuffer(Buffer.from(buffer), filename, options, { db: this.db(), config: this.config });
  }

  async uploadStream(
    stream: NodeJS.ReadableStream,
    filename: string,
    contentType: string | undefined,
    options: UploadOptions = {},
  ): Promise<Attachment> {
    validateStorageConfig(this.config);
    return coreUploadStream(stream, filename, contentType, options, { db: this.db(), config: this.config });
  }

  async delete(id: string): Promise<void> {
    const db = this.db();
    const att = db.findById(id);
    if (!att) throw new Error(`Attachment not found: ${id}`);
    await this.deleteObjectBytes(att);
    db.delete(id);
  }

  async deleteExpired(): Promise<number> {
    const db = this.db();
    const now = Date.now();
    const expired = db.findAll({ includeExpired: true }).filter((a) => a.expiresAt !== null && a.expiresAt <= now);
    for (const att of expired) {
      await this.deleteObjectBytes(att).catch(() => undefined);
      db.delete(att.id);
    }
    return expired.length;
  }

  private async deleteObjectBytes(att: Attachment): Promise<void> {
    const backend = att.storageBackend ?? (att.bucket === "local" ? "local" : "s3");
    if (backend === "local") {
      await new LocalObjectStore(this.config).delete(att.s3Key);
    } else {
      await new S3Client(this.config.s3).delete(att.s3Key);
    }
  }

  async getLink(id: string): Promise<LinkResult> {
    const att = this.db().findById(id);
    if (!att) throw new Error(`Attachment not found: ${id}`);
    return { link: att.link, expires_at: att.expiresAt };
  }

  async regenerateLink(id: string, options: RegenerateLinkOptions): Promise<LinkResult> {
    const db = this.db();
    const att = db.findById(id);
    if (!att) throw new Error(`Attachment not found: ${id}`);

    const linkType = options.linkType ?? getLinkType(this.config);
    const { milliseconds: expiryMs } = parseExpiryStrict(options.expiry ?? this.config.defaults.expiry);
    const expiresAt = expiryMs !== null ? Date.now() + expiryMs : null;

    let link: string;
    if (
      linkType === "presigned" &&
      (att.storageBackend ?? "s3") === "s3" &&
      !options.password &&
      !options.maxDownloads
    ) {
      link = await generatePresignedLink(new S3Client(this.config.s3), att.s3Key, expiryMs);
    } else {
      const { token } = db.createShareLink({
        attachmentId: att.id,
        expiresAt,
        password: options.password,
        maxUses: options.maxDownloads ?? null,
      });
      link = generateShareLink(token, getPublicBaseUrl(this.config), this.config.server.publicPath);
    }
    db.updateLink(att.id, link, expiresAt);
    return { link, expires_at: expiresAt };
  }

  async download(idOrUrl: string, output?: string, options: { password?: string } = {}): Promise<DownloadResult> {
    return downloadAttachment(idOrUrl, output, { db: this.db(), config: this.config }, { password: options.password });
  }

  /**
   * Create a presigned S3 PUT URL for a direct client->S3 upload plus a pending
   * DB record. Local/S3 only (the caller holds S3 creds). expiryMs must be > 0.
   */
  async presignUpload(
    filenameInput: string,
    contentTypeInput: string | undefined,
    expiryMs: number,
  ): Promise<{ id: string; uploadUrl: string; contentType: string; filename: string }> {
    validateS3Config(this.config);
    const filename = sanitizeFilename(filenameInput);
    const detected = mimeLookup(filename);
    const contentType = contentTypeInput ?? (detected !== false ? detected : "application/octet-stream");
    const id = `att_${nanoid(11)}`;
    const s3Key = createObjectKey(id, filename);
    const uploadUrl = await new S3Client(this.config.s3).presignPut(s3Key, contentType, Math.floor(expiryMs / 1000));
    const now = Date.now();
    this.db().insert({
      id,
      filename,
      s3Key,
      bucket: this.config.s3.bucket,
      size: 0,
      contentType,
      link: null,
      tag: null,
      expiresAt: now + expiryMs,
      createdAt: now,
      storageBackend: "s3",
      status: "pending",
    });
    return { id, uploadUrl, contentType, filename };
  }

  /** Finalize a presigned direct upload: verify size, generate the link, mark ready. */
  async presignComplete(
    id: string,
    options: { expiryMs: number | null; password?: string; maxDownloads?: number; linkType: "presigned" | "server" },
  ): Promise<{ attachment: Attachment; link: string; size: number }> {
    validateS3Config(this.config);
    const db = this.db();
    const attachment = db.findById(id);
    if (!attachment) throw new Error(`Pending attachment not found: ${id}`);
    if (attachment.status !== "pending") throw new Error(`Attachment upload is already complete: ${id}`);

    const s3 = new S3Client(this.config.s3);
    const info = await s3.head(attachment.s3Key);
    const size = info.contentLength ?? attachment.size;
    if (size > this.config.storage.maxSizeBytes) {
      await s3.delete(attachment.s3Key).catch(() => undefined);
      db.delete(id);
      throw new Error(`File too large. Maximum size is ${this.config.storage.maxSizeBytes} bytes.`);
    }

    const expiresAt = options.expiryMs !== null ? Date.now() + options.expiryMs : null;
    const mustUseServerLink = !!options.password || options.maxDownloads !== undefined || options.linkType !== "presigned";
    let link: string;
    if (!mustUseServerLink && (attachment.storageBackend ?? "s3") === "s3") {
      link = await generatePresignedLink(s3, attachment.s3Key, options.expiryMs);
    } else {
      const { token } = db.createShareLink({
        attachmentId: attachment.id,
        expiresAt,
        password: options.password,
        maxUses: options.maxDownloads ?? null,
      });
      link = generateShareLink(token, getPublicBaseUrl(this.config), this.config.server.publicPath);
    }
    db.markReady({ id: attachment.id, size, contentType: info.contentType ?? attachment.contentType, link, expiresAt });
    return { attachment, link, size };
  }

  /** Persist a feedback note to the on-box feedback table. */
  saveFeedback(input: { message: string; email?: string | null; category?: string; version?: string | null }): void {
    this.db().run(
      "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
      [input.message, input.email ?? null, input.category ?? "general", input.version ?? null],
    );
  }

  close(): void {
    this._db?.close();
    this._db = null;
  }
}

/**
 * Self_hosted / cloud store: every read and write goes to `<API_URL>/v1` with the
 * bearer key, via the @hasna/contracts HTTP storage client. Never touches sqlite,
 * never sees a DSN.
 */
export class ApiStore implements Store {
  readonly transport = "cloud-http" as const;
  readonly baseUrl: string;

  constructor(private readonly v1: AttachmentsV1Store) {
    this.baseUrl = v1.baseUrl;
  }

  list(options: ListOptions = {}): Promise<Attachment[]> {
    return this.v1.list(options);
  }

  get(id: string): Promise<Attachment | null> {
    return this.v1.get(id);
  }

  uploadFile(path: string, options: UploadOptions = {}): Promise<Attachment> {
    return this.v1.uploadFile(path, toV1UploadOptions(options));
  }

  uploadUrl(url: string, options: UploadOptions = {}): Promise<Attachment> {
    return this.v1.uploadUrl(url, toV1UploadOptions(options));
  }

  uploadBuffer(buffer: Buffer | Uint8Array, filename: string, options: UploadOptions = {}): Promise<Attachment> {
    return this.v1.uploadBuffer(filename, buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), toV1UploadOptions(options));
  }

  uploadStream(
    stream: NodeJS.ReadableStream,
    filename: string,
    _contentType: string | undefined,
    options: UploadOptions = {},
  ): Promise<Attachment> {
    return this.v1.uploadStream(stream, filename, toV1UploadOptions(options));
  }

  delete(id: string): Promise<void> {
    return this.v1.delete(id);
  }

  async deleteExpired(): Promise<number> {
    // The self_hosted/cloud server enforces expiry server-side; there is no bulk
    // purge route, so remove the expired records the API still reports.
    const all = await this.v1.list({ includeExpired: true });
    const now = Date.now();
    const expired = all.filter((a) => a.expiresAt !== null && a.expiresAt <= now);
    for (const att of expired) await this.v1.delete(att.id).catch(() => undefined);
    return expired.length;
  }

  getLink(id: string): Promise<LinkResult> {
    return this.v1.getLink(id);
  }

  regenerateLink(id: string, options: RegenerateLinkOptions): Promise<LinkResult> {
    return this.v1.regenerateLink(id, options);
  }

  download(idOrUrl: string, output?: string, options: { password?: string } = {}): Promise<DownloadResult> {
    return this.v1.download(idOrUrl, output, options);
  }

  close(): void {
    /* no persistent client-side resource to release */
  }
}

export interface ResolveStoreOptions {
  /** Force the on-box LocalStore even when cloud env is present (e.g. `--local`). */
  forceLocal?: boolean;
}

/**
 * The one call every command/tool/method makes to get its store. Resolves the
 * client-flip env for `attachments`; returns an {@link ApiStore} when
 * self_hosted/cloud is configured, otherwise a {@link LocalStore}. Throws (via the
 * contracts resolver) if cloud was requested but misconfigured, so a client never
 * silently reads the wrong dataset.
 */
export function resolveStore(env: NodeJS.ProcessEnv = process.env, options: ResolveStoreOptions = {}): Store {
  if (!options.forceLocal) {
    const resolved = resolveAttachmentsV1(env);
    if (resolved.transport === "cloud-http") return new ApiStore(resolved.store);
  }
  return new LocalStore();
}

/** Convenience: filename from a path, matching the CLI's display behavior. */
export function displayName(path: string): string {
  return basename(path);
}
