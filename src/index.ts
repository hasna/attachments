// Core library API — use this when embedding @hasna/attachments in another project
// For agent workflows, prefer @hasna/attachments-sdk (REST client, zero-dep)
//
// The ONLY client data surface is the unified Store (LocalStore / ApiStore via
// resolveStore, below). The pre-Store primitives (uploadFile/downloadAttachment/…)
// and the raw `AttachmentsDB` bun:sqlite class are intentionally NOT exported:
// they default to an on-box sqlite DB and never consult api-mode env, so exposing
// them lets a consumer write to local sqlite even when HASNA_ATTACHMENTS_API_URL/
// KEY are set — exactly the split-brain bug this package's Store abstraction kills.
export type { Attachment } from "./core/db.js";
export { getConfig, setConfig, validateS3Config, validateStorageConfig, parseExpiry, parseExpiryStrict, setConfigPath } from "./core/config.js";
export type { AttachmentsConfig } from "./core/config.js";
export { S3Client } from "./core/s3.js";
export type { S3Config } from "./core/s3.js";
export { generatePresignedLink, generateServerLink, generateShareLink, getLinkType } from "./core/links.js";
export { resolveShareAccess, ShareAccessError } from "./core/share.js";
export { LocalObjectStore, createObjectStore } from "./core/object-storage.js";
export { buildDeploymentPlan } from "./core/deployment.js";
export { resolveInternalBaseUrl, resolveInternalBindHost } from "./core/internal-link.js";
// Unified storage abstraction — the single client surface for CLI/MCP/SDK.
export { LocalStore, ApiStore, resolveStore } from "./core/store.js";
export type { Store, ListOptions, LinkResult, RegenerateLinkOptions, ResolveStoreOptions, UploadOptions, FeedbackInput } from "./core/store.js";
export type { DownloadResult } from "./core/download.js";
export { resolveAttachmentsV1 } from "./core/cloud-v1.js";
export type { AttachmentsV1Store } from "./core/cloud-v1.js";
export { createApp, startServer } from "./api/server.js";
