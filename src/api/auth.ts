import type { Context } from "hono";
import { timingSafeEqual } from "crypto";

export function getApiToken(): string | null {
  const token =
    process.env.ATTACHMENTS_API_TOKEN?.trim() ||
    process.env.HASNA_ATTACHMENTS_API_TOKEN?.trim() ||
    "";
  return token || null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestApiToken(c: Context): string | null {
  const auth = c.req.header("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  return bearer || c.req.header("x-attachments-token") || c.req.header("x-api-key") || null;
}

export function requireApiAuth(c: Context): Response | null {
  const expected = getApiToken();
  if (!expected) return null;
  const actual = requestApiToken(c);
  if (actual && safeEqual(actual, expected)) return null;
  return c.json({ error: "Unauthorized" }, 401);
}
