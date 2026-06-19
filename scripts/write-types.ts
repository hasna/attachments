import { mkdirSync, writeFileSync } from "fs";

mkdirSync("dist", { recursive: true });

const indexTypes = `export interface Attachment {
  id: string;
  filename: string;
  s3Key: string;
  bucket: string;
  size: number;
  contentType: string;
  link: string | null;
  tag: string | null;
  expiresAt: number | null;
  createdAt: number;
  storageBackend?: "local" | "s3";
  status?: "ready" | "pending";
  encryptionAlgorithm?: string | null;
  encryptionSalt?: string | null;
  encryptionIv?: string | null;
  encryptionTag?: string | null;
  downloads?: number;
}

export interface ShareLink {
  id: string;
  attachmentId: string;
  tokenHash: string;
  expiresAt: number | null;
  createdAt: number;
  revokedAt: number | null;
  passwordHash: string | null;
  maxUses: number | null;
  usedCount: number;
}

export interface UploadOptions {
  expiry?: string;
  tag?: string;
  linkType?: "presigned" | "server";
  password?: string;
  encrypt?: boolean;
  maxDownloads?: number;
  baseUrl?: string;
}

export interface DownloadOptions {
  password?: string;
}

export interface DownloadResult {
  path: string;
  filename: string;
  size: number;
}

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
}

export interface AttachmentsConfig {
  s3: S3Config;
  storage: {
    backend: "auto" | "local" | "s3";
    localDir: string;
    maxSizeBytes: number;
  };
  server: {
    port: number;
    host: string;
    baseUrl: string;
    publicPath: string;
  };
  defaults: {
    expiry: string;
    linkType: "presigned" | "server";
  };
  client: {
    mode: "local" | "cloud";
    apiBaseUrl: string;
    apiToken: string;
    apiTokenEnv: string;
    internalBaseUrl?: string;
    internalMachineId?: string;
    preferInternal: boolean;
  };
  domains: Array<{
    hostname: string;
    baseUrl?: string;
    pathPrefix?: string;
    primary?: boolean;
  }>;
  deployment: Record<string, unknown>;
}

export declare function uploadFile(path: string, options?: UploadOptions): Promise<Attachment>;
export declare function uploadFromUrl(url: string, options?: UploadOptions): Promise<Attachment>;
export declare function uploadFromBuffer(buffer: Buffer, filename: string, options?: UploadOptions): Promise<Attachment>;
export declare function uploadStreamAttachment(stream: NodeJS.ReadableStream, filename: string, contentType?: string, options?: UploadOptions & { size?: number }): Promise<Attachment>;
export declare function downloadAttachment(idOrUrl: string, destPath?: string, deps?: unknown, options?: DownloadOptions): Promise<DownloadResult>;
export declare function openAttachmentStream(attachment: Attachment, deps?: unknown): Promise<unknown>;
export declare function streamAttachment(id: string, deps?: unknown): Promise<{ buffer: Buffer; attachment: Attachment }>;
export declare function extractId(idOrUrl: string): string;
export declare function extractShareToken(idOrUrl: string): string | null;
export declare function isExpired(attachment: Attachment): boolean;
export declare function getConfig(): AttachmentsConfig;
export declare function setConfig(config: Partial<AttachmentsConfig>): void;
export declare function validateS3Config(config?: AttachmentsConfig): void;
export declare function validateStorageConfig(config?: AttachmentsConfig): void;
export declare function parseExpiry(expiry: string): number | null;
export declare function parseExpiryStrict(expiry: string): { milliseconds: number | null; never: boolean };
export declare function setConfigPath(path: string): void;
export declare function resolveInternalBaseUrl(config?: AttachmentsConfig): Promise<{ baseUrl: string; source: "config" | "open-machines" | "tailscale" | "lan"; target: string }>;
export declare function resolveInternalBindHost(config?: AttachmentsConfig): { host: string; source: "config" | "tailscale"; baseUrl: string };
export declare function uploadFileToCloudApi(path: string, options?: UploadOptions): Promise<Attachment>;
export declare function uploadUrlToCloudApi(url: string, options?: UploadOptions): Promise<Attachment>;
export declare function downloadFromCloud(idOrUrl: string, output?: string, options?: DownloadOptions): Promise<DownloadResult>;
export declare function listCloudAttachments(options?: { limit?: number; includeExpired?: boolean; tag?: string }): Promise<Attachment[]>;
export declare function deleteCloudAttachment(id: string): Promise<void>;
export declare function getCloudAttachmentLink(id: string): Promise<{ link: string | null; expires_at: number | null }>;
export declare function regenerateCloudAttachmentLink(id: string, options?: { expiry?: string; password?: string; maxDownloads?: number; linkType?: "presigned" | "server" }): Promise<{ link: string | null; expires_at: number | null }>;
export declare function getCloudHealth(): Promise<Record<string, unknown>>;
export declare function generatePresignedLink(s3: unknown, key: string, expiryMs: number | null): Promise<string>;
export declare function generateServerLink(id: string, baseUrl: string): string;
export declare function generateShareLink(token: string, baseUrl: string, publicPath?: string): string;
export declare function getLinkType(config: AttachmentsConfig): "presigned" | "server";
export declare function resolveShareAccess(db: unknown, token: string, opts?: { password?: string; consume?: boolean }): { attachment: Attachment; shareLink: ShareLink };
export declare class ShareAccessError extends Error {
  status: 401 | 404 | 410;
}
export declare class AttachmentsDB {
  constructor(dbPath?: string);
}
export declare class S3Client {
  constructor(config: S3Config);
}
export declare class LocalObjectStore {
  constructor(config: AttachmentsConfig);
}
export declare function createObjectStore(config: AttachmentsConfig): LocalObjectStore | S3Client;
export declare function buildDeploymentPlan(config?: AttachmentsConfig): unknown;
export declare function createApp(): unknown;
export declare function startServer(port: number, hostname?: string): void;
export declare const STORAGE_TABLES: readonly string[];
export declare function storagePull(options?: unknown): Promise<unknown>;
export declare function storagePush(options?: unknown): Promise<unknown>;
export declare function storageSync(options?: unknown): Promise<unknown>;
export declare function getStorageStatus(options?: unknown): Promise<unknown>;
export declare const PG_MIGRATIONS: readonly string[];
export declare class PgAdapterAsync {
  constructor(options?: unknown);
}
`;

const storageTypes = `export * from "./index";
`;

writeFileSync("dist/index.d.ts", indexTypes);
writeFileSync("dist/storage.d.ts", storageTypes);
