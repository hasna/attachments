import type { Context } from "hono";
import { getConfig } from "../core/config";

export const DIRECT_MULTIPART_PART_SIZE = 64 * 1024 * 1024;
export const FORM_UPLOAD_SOFT_LIMIT = 64 * 1024 * 1024;

export type UploadRequestOptions = {
  expiry?: string;
  tag?: string;
  password?: string;
  encrypt?: boolean;
  maxDownloads?: number;
  linkType?: "presigned" | "server";
};

export function maxUploadBytes(): number {
  const config = getConfig();
  return parseInt(
    process.env.ATTACHMENTS_MAX_SIZE ?? String(config.storage.maxSizeBytes),
    10
  );
}

export function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseBooleanOption(value: string | undefined | null): boolean {
  return value === "true" || value === "1" || value === "yes";
}

function parsePositiveInteger(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function requestUploadOptions(c: Context): UploadRequestOptions {
  const linkTypeInput = firstNonEmpty(c.req.query("link_type"), c.req.header("x-attachments-link-type"));
  const linkType = linkTypeInput === "presigned" || linkTypeInput === "server" ? linkTypeInput : undefined;
  return {
    expiry: firstNonEmpty(c.req.query("expiry"), c.req.header("x-attachments-expiry")),
    tag: firstNonEmpty(c.req.query("tag"), c.req.header("x-attachments-tag")),
    password: firstNonEmpty(c.req.header("x-attachments-password"), c.req.header("x-attachment-password")),
    encrypt: parseBooleanOption(firstNonEmpty(c.req.query("encrypt"), c.req.header("x-attachments-encrypt"))),
    maxDownloads: parsePositiveInteger(firstNonEmpty(c.req.query("max_downloads"), c.req.header("x-attachments-max-downloads"))),
    linkType,
  };
}
