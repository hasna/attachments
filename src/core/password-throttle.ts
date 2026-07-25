/**
 * Brute-force throttle for password-protected share links.
 *
 * Extracted from the on-box public routes so the cloud service enforces exactly
 * the same policy instead of re-implementing it. In-process only: each replica
 * keeps its own counters, which is a deliberate trade-off (no shared state
 * dependency) — the limit bounds a single connection's guess rate, it is not a
 * distributed lockout.
 */

export const PASSWORD_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
export const PASSWORD_ATTEMPT_LIMIT = 10;

export interface PasswordThrottleOptions {
  limit?: number;
  windowMs?: number;
  now?: () => number;
}

export class PasswordThrottle {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: PasswordThrottleOptions = {}) {
    this.limit = options.limit ?? PASSWORD_ATTEMPT_LIMIT;
    this.windowMs = options.windowMs ?? PASSWORD_ATTEMPT_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  isLimited(key: string): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (entry.resetAt <= this.now()) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.limit;
  }

  recordFailure(key: string): void {
    const now = this.now();
    const current = this.failures.get(key);
    if (!current || current.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    current.count += 1;
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  /** Test-only: drop every counter. */
  reset(): void {
    this.failures.clear();
  }
}

export interface HeaderReader {
  header(name: string): string | undefined;
}

/**
 * Identify the caller for throttling purposes.
 *
 * `trustProxy` must only be true when the service is genuinely behind a proxy
 * that sets the forwarding headers (ALB / Caddy). When it is false we fall back
 * to the socket address if the runtime exposes one; the literal `"remote"`
 * bucket is the last resort and is shared, so callers should prefer providing
 * `directAddress`.
 */
export function clientIdentity(
  req: HeaderReader,
  opts: { trustProxy: boolean; directAddress?: string | null }
): string {
  if (opts.trustProxy) {
    const forwarded =
      req.header("cf-connecting-ip") ||
      req.header("x-real-ip") ||
      req.header("x-forwarded-for") ||
      "";
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return opts.directAddress?.trim() || "remote";
}

export function passwordFailureKey(token: string, identity: string): string {
  return `${token}:${identity}`;
}
