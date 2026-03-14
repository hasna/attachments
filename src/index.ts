// Core library API — use this when embedding @hasna/attachments in another project
// For agent workflows, prefer @hasna/attachments-sdk (REST client, zero-dep)
export { uploadFile, uploadFromUrl, uploadFromBuffer } from "./core/upload.js";
export type { UploadOptions, UploadDeps } from "./core/upload.js";
export { downloadAttachment, streamAttachment, extractId, isExpired } from "./core/download.js";
export type { DownloadResult, DownloadDeps } from "./core/download.js";
export { AttachmentsDB } from "./core/db.js";
export type { Attachment } from "./core/db.js";
export { getConfig, setConfig, validateS3Config, parseExpiry, setConfigPath } from "./core/config.js";
export type { AttachmentsConfig } from "./core/config.js";
export { S3Client } from "./core/s3.js";
export type { S3Config } from "./core/s3.js";
export { generatePresignedLink, generateServerLink, getLinkType } from "./core/links.js";
export { createApp, startServer } from "./api/server.js";
