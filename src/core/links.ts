import { S3Client } from "./s3";
import { AttachmentsConfig } from "./config";

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
 * Generate a server-hosted download link for an attachment.
 * Returns: `${baseUrl}/d/${id}`
 */
export function generateServerLink(id: string, baseUrl: string): string {
  return `${baseUrl}/d/${id}`;
}

/**
 * Determine the link type to use based on config.
 */
export function getLinkType(config: AttachmentsConfig): "presigned" | "server" {
  return config.defaults.linkType;
}
