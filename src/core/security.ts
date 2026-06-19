import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { basename, extname } from "path";
import { nanoid } from "nanoid";

export function generateShareToken(): string {
  return nanoid(32);
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sanitizeFilename(filename: string): string {
  const base = basename(filename).replace(/[\x00-\x1f\x7f]/g, "").trim();
  const safe = base.replace(/[\\/]/g, "-").replace(/\s+/g, " ");
  return safe || "attachment";
}

export function createObjectKey(attachmentId: string, filename: string, now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const ext = extname(filename).slice(0, 24);
  return `attachments/${year}-${month}-${day}/${attachmentId}/${nanoid(18)}${ext}`;
}

export function buildPasswordHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPasswordHash(password: string, encodedHash: string | null): boolean {
  if (!encodedHash) return true;
  const [scheme, salt, expectedHex] = encodedHash.split("$");
  if (scheme !== "scrypt" || !salt || !expectedHex) return false;
  const actual = Buffer.from(scryptSync(password, salt, 32).toString("hex"), "utf-8");
  const expected = Buffer.from(expectedHex, "utf-8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function contentDispositionAttachment(filename: string): string {
  const safe = sanitizeFilename(filename).replace(/["\\]/g, "");
  const encoded = encodeURIComponent(safe).replace(/['()]/g, escape);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
