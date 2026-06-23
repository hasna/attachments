// Core library API — use this when embedding @hasna/attachments in another project
// For agent workflows, prefer @hasna/attachments-sdk (REST client, zero-dep)
export { uploadFile, uploadFromUrl, uploadFromBuffer, uploadStreamAttachment } from "./core/upload.js";
export type { UploadOptions, UploadDeps } from "./core/upload.js";
export { downloadAttachment, streamAttachment, openAttachmentStream, extractId, extractShareToken, isExpired } from "./core/download.js";
export type { DownloadResult, DownloadDeps } from "./core/download.js";
export { AttachmentsDB } from "./core/db.js";
export type { Artifact, ArtifactFilters, Attachment, ShareLink } from "./core/db.js";
export { getConfig, setConfig, validateS3Config, validateStorageConfig, parseExpiry, parseExpiryStrict, setConfigPath } from "./core/config.js";
export type { AttachmentsConfig } from "./core/config.js";
export { S3Client } from "./core/s3.js";
export type { S3Config } from "./core/s3.js";
export { generatePresignedLink, generateServerLink, generateShareLink, getLinkType } from "./core/links.js";
export { resolveShareAccess, ShareAccessError } from "./core/share.js";
export { LocalObjectStore, createObjectStore } from "./core/object-storage.js";
export { buildDeploymentPlan } from "./core/deployment.js";
export { resolveInternalBaseUrl, resolveInternalBindHost } from "./core/internal-link.js";
export {
  ARTIFACT_CONTRACT_VERSION,
  BROWSERPLAN_DEFAULT_FLEET,
  BROWSERPLAN_DEFAULT_FLEET_EXCLUDES,
  artifactTag,
  artifactToJson,
  buildFleetInstallPlan,
  buildMacArtifactInstallPlan,
  chooseLatestArtifact,
  compareArtifactVersions,
  downloadArtifact,
  expandMachineTargets,
  inferArtifactKind,
  publishArtifact,
  registerArtifact,
  resolveArtifact,
  sha256File,
  verifyFileSha256,
} from "./core/artifacts.js";
export type {
  ArtifactInstallPlan,
  ArtifactJson,
  DownloadedArtifact,
  FleetInstallPlan,
  RegisterArtifactOptions,
  ResolvedArtifact,
} from "./core/artifacts.js";
export {
  deleteCloudAttachment,
  downloadFromCloud,
  getCloudArtifact,
  getCloudAttachmentLink,
  getCloudHealth,
  getCloudLatestArtifact,
  listCloudAttachments,
  listCloudArtifacts,
  registerCloudArtifact,
  regenerateCloudAttachmentLink,
  uploadFileToCloudApi,
  uploadUrlToCloudApi,
} from "./core/api-client.js";
export type { ApiArtifact, CloudArtifactFilters, CloudRegisterArtifactOptions } from "./core/api-client.js";
export { createApp, startServer } from "./api/server.js";
export {
  STORAGE_TABLES,
  storagePull,
  storagePush,
  storageSync,
  getStorageDatabaseEnv,
  getStorageDatabaseUrl,
  getStorageMode,
  getStorageStatus,
  runStorageMigrations,
  getSyncMetaAll,
} from "./db/storage-sync.js";
export type { StorageEnv, StorageMode, SyncMeta, SyncResult } from "./db/storage-sync.js";
