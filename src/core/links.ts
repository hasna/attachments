import { S3Client } from "./s3";
import { AttachmentsConfig } from "./config";
import { normalizePublicPath } from "./config";

const DEFAULT_PRESIGN_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Generate a presigned S3 URL for an attachment.
 * If expiresInMs is null, uses the 7-day default.
 */
export async function generatePresignedLink(
  s3: S3Client,
  s3Key: string,
  expiresInMs: number | null
): Promise<string> {
  const expiresInSeconds =
    expiresInMs !== null
      ? Math.floor(expiresInMs / 1000)
      : DEFAULT_PRESIGN_EXPIRY_SECONDS;

  return s3.presign(s3Key, expiresInSeconds);
}

/**
 * Generate a server-hosted share link.
 * Returns: `${baseUrl}/a/${token}` by default.
 */
export function generateServerLink(id: string, baseUrl: string): string {
  return generateShareLink(id, baseUrl);
}

export function generateShareLink(token: string, baseUrl: string, publicPath = "/a"): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const cleanPath = normalizePublicPath(publicPath);
  return `${cleanBase}${cleanPath}/${token}`;
}

/**
 * Determine the link type to use based on config.
 */
export function getLinkType(config: AttachmentsConfig): "presigned" | "server" {
  return config.defaults.linkType;
}
