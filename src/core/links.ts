import { S3Client } from "./s3";
import { AttachmentsConfig } from "./config";
import { getInternalBaseUrl, getPublicBaseUrl, normalizePublicPath } from "./config";

/**
 * AWS SigV4 hard limit for presigned GET URLs: the signature is invalid beyond
 * one week and `getSignedUrl` throws ("Signature version 4 presigned URLs must
 * have an expiration date less than one week in the future") rather than
 * clamping. Anything longer-lived MUST use a server-hosted share link.
 */
export const AWS_MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60; // 604800

const DEFAULT_PRESIGN_EXPIRY_SECONDS = AWS_MAX_PRESIGN_SECONDS;

export class PresignExpiryError extends Error {
  constructor(public readonly requestedSeconds: number) {
    super(
      `Presigned links cannot outlive ${AWS_MAX_PRESIGN_SECONDS} seconds (7 days); ` +
        `requested ${requestedSeconds}. Use a server-hosted link (link_type="server") instead.`,
    );
    this.name = "PresignExpiryError";
  }
}

/**
 * True when the requested lifetime cannot be expressed as a presigned S3 URL.
 * `null` means "never expires", which a presigned URL can never honour either —
 * returning a 7-day URL for a "never" link is a silent lie, so it counts too.
 */
export function exceedsPresignLimit(expiresInMs: number | null): boolean {
  if (expiresInMs === null) return true;
  return Math.floor(expiresInMs / 1000) > AWS_MAX_PRESIGN_SECONDS;
}

/**
 * Generate a presigned S3 URL for an attachment.
 * If expiresInMs is null, uses the 7-day maximum.
 *
 * Throws {@link PresignExpiryError} instead of letting the AWS SDK raise an
 * opaque error that callers used to surface as a bare HTTP 500.
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

  if (expiresInSeconds > AWS_MAX_PRESIGN_SECONDS) {
    throw new PresignExpiryError(expiresInSeconds);
  }

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

export interface DeliverableLinkTypeInput {
  requested: "presigned" | "server";
  backend: "local" | "s3";
  expiryMs: number | null;
  password?: string;
  encrypt?: boolean;
  maxDownloads?: number | null;
  requireEmail?: boolean;
}

/**
 * Pick the link type that can actually be delivered for a request.
 *
 * A presigned S3 URL cannot express a password, a download cap, an email gate,
 * client-side encryption, a local (non-S3) backend, or a lifetime beyond the AWS
 * 7-day signing ceiling. Every caller used to open-code a subset of these rules;
 * the expiry rule was missing everywhere, so `expiry=30d` reached the AWS SDK and
 * blew up as an opaque HTTP 500 (D2). This is now the single decision point.
 */
export function resolveDeliverableLinkType(input: DeliverableLinkTypeInput): "presigned" | "server" {
  if (input.requested === "server") return "server";
  if (input.backend !== "s3") return "server";
  if (input.password || input.encrypt || input.requireEmail) return "server";
  if (input.maxDownloads !== undefined && input.maxDownloads !== null) return "server";
  if (exceedsPresignLimit(input.expiryMs)) return "server";
  return "presigned";
}

function origin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function loopbackBaseUrl(config: AttachmentsConfig): string {
  const host =
    !config.server.host || config.server.host === "0.0.0.0" || config.server.host === "::"
      ? "localhost"
      : config.server.host;
  return `http://${host}:${config.server.port}`;
}

export interface LocalShareBaseUrl {
  /** Base URL a share link created on THIS box may safely use. */
  baseUrl: string;
  /**
   * Present when the configured public base URL was rejected. The configured
   * host belongs to the remote API this client talks to, so a link pointing at
   * it would resolve against a database that does not contain this token.
   */
  rejectedBaseUrl?: string;
}

/**
 * Resolve the base URL for a share link stored in the ON-BOX database.
 *
 * D1(b): `attachments upload --client-mode local` wrote metadata into the local
 * SQLite database but built the link from `getPublicBaseUrl(config)`, which on a
 * developer machine points at the remote service (`HASNA_ATTACHMENTS_API_URL`).
 * The command reported success and handed back a link that can never resolve —
 * the remote service has no such token.
 *
 * The conflict is detected from data, not from a hardcoded hostname: the same
 * origin cannot simultaneously be "the remote API this client calls" and "the
 * server that serves my local database". When it is, fall back to the internal
 * (Tailscale/LAN) base URL if one is configured, otherwise the local loopback
 * address of `attachments serve`.
 */
export function resolveLocalShareBaseUrl(
  config: AttachmentsConfig,
  env: NodeJS.ProcessEnv = process.env,
): LocalShareBaseUrl {
  const configured = getPublicBaseUrl(config);
  const remoteApi = env["HASNA_ATTACHMENTS_API_URL"] || env["ATTACHMENTS_API_URL"] || "";
  if (!remoteApi) return { baseUrl: configured };

  const configuredOrigin = origin(configured);
  const remoteOrigin = origin(remoteApi);
  if (!configuredOrigin || !remoteOrigin || configuredOrigin !== remoteOrigin) {
    return { baseUrl: configured };
  }

  return {
    baseUrl: getInternalBaseUrl(config) ?? loopbackBaseUrl(config),
    rejectedBaseUrl: configured,
  };
}
