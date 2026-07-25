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
 * Parse the trusted-proxy allowlist (`ATTACHMENTS_TRUSTED_PROXIES`).
 *
 * Each entry is the address a proxy in front of this service appears as to the
 * hop behind it — e.g. the public address of the Caddy that fronts `has.na`.
 */
export function parseTrustedProxies(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Identify the caller for throttling purposes.
 *
 * `trustProxy` must only be true when the service is genuinely behind a proxy
 * that sets the forwarding headers (ALB / Caddy). When it is false we fall back
 * to the socket address if the runtime exposes one; the literal `"remote"`
 * bucket is the last resort and is shared, so callers should prefer providing
 * `directAddress`.
 *
 * The chain is read RIGHT TO LEFT. Everything a client sends in
 * `x-forwarded-for` survives into the header the origin sees, so the leftmost
 * entry is attacker-controlled: keying on it hands out a fresh throttle bucket
 * per guess and defeats the password lockout entirely. The rightmost entry is
 * the one the nearest proxy appended, i.e. the socket peer it actually saw.
 * `trustedProxies` names the hops that are ours (Caddy in front of the ALB), so
 * we can step over them and land on the real visitor instead of bucketing every
 * visitor together — which would turn the lockout into a denial of service.
 */
export function clientIdentity(
  req: HeaderReader,
  opts: { trustProxy: boolean; trustedProxies?: readonly string[]; directAddress?: string | null }
): string {
  if (opts.trustProxy) {
    const chain = parseTrustedProxies(req.header("x-forwarded-for"));
    if (chain.length > 0) {
      const trusted = new Set(opts.trustedProxies ?? []);
      for (let i = chain.length - 1; i >= 0; i--) {
        const hop = chain[i]!;
        if (!trusted.has(hop)) return hop;
      }
      // Every hop is one of ours: nothing better to key on than the far end.
      return chain[0]!;
    }
    // No chain at all — these single-value headers are only meaningful when the
    // edge sets them, and they cannot be layered the way x-forwarded-for is.
    const single = req.header("cf-connecting-ip")?.trim() || req.header("x-real-ip")?.trim();
    if (single) return single;
  }
  return opts.directAddress?.trim() || "remote";
}

export function passwordFailureKey(token: string, identity: string): string {
  return `${token}:${identity}`;
}
