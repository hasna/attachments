import { describe, expect, test } from "bun:test";
import {
  PasswordThrottle,
  clientIdentity,
  passwordFailureKey,
  parseTrustedProxies,
  type HeaderReader,
} from "./password-throttle";

function headers(map: Record<string, string>): HeaderReader {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (name: string) => lower.get(name.toLowerCase()) };
}

describe("PasswordThrottle", () => {
  test("locks after the limit and unlocks when the window rolls over", () => {
    let now = 1_000;
    const throttle = new PasswordThrottle({ limit: 3, windowMs: 100, now: () => now });
    expect(throttle.isLimited("k")).toBe(false);
    throttle.recordFailure("k");
    throttle.recordFailure("k");
    expect(throttle.isLimited("k")).toBe(false);
    throttle.recordFailure("k");
    expect(throttle.isLimited("k")).toBe(true);
    now += 101;
    expect(throttle.isLimited("k")).toBe(false);
  });

  test("a correct password clears the counter for that key only", () => {
    const throttle = new PasswordThrottle({ limit: 2 });
    throttle.recordFailure("a");
    throttle.recordFailure("b");
    throttle.recordFailure("b");
    throttle.clear("b");
    expect(throttle.isLimited("b")).toBe(false);
    throttle.recordFailure("a");
    expect(throttle.isLimited("a")).toBe(true);
  });

  test("keys are scoped per token, so one link cannot lock another", () => {
    expect(passwordFailureKey("tok1", "1.2.3.4")).not.toBe(passwordFailureKey("tok2", "1.2.3.4"));
  });
});

describe("clientIdentity — spoof resistance", () => {
  // REGRESSION (D3 hardening): the old implementation took the LEFTMOST
  // x-forwarded-for entry, which is fully attacker-controlled. Behind the ALB
  // that let one client mint a fresh throttle bucket per guess and brute-force
  // a share-link password without ever hitting the 10-attempt lockout.
  test("ignores a client-supplied x-forwarded-for prefix and uses the hop the proxy appended", () => {
    const id = clientIdentity(headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }), {
      trustProxy: true,
    });
    expect(id).toBe("203.0.113.7");
  });

  test("two guesses that differ only in the spoofed prefix share one throttle bucket", () => {
    const a = clientIdentity(headers({ "x-forwarded-for": "9.9.9.1, 203.0.113.7" }), {
      trustProxy: true,
    });
    const b = clientIdentity(headers({ "x-forwarded-for": "9.9.9.2, 203.0.113.7" }), {
      trustProxy: true,
    });
    expect(a).toBe(b);
  });

  // has.na fronts the cloud service with Caddy, so the rightmost hop is Caddy's
  // own address. Keying on it would put EVERY visitor in one bucket — ten wrong
  // guesses from anyone would lock the link for the whole internet.
  test("skips a configured trusted proxy and keys on the address behind it", () => {
    const id = clientIdentity(headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.7, 13.216.193.122" }), {
      trustProxy: true,
      trustedProxies: ["13.216.193.122"],
    });
    expect(id).toBe("203.0.113.7");
  });

  test("a spoofer cannot impersonate the trusted proxy to widen the bucket", () => {
    // Client sends the Caddy address itself; the real edge still appends the
    // socket peer to the right of it, so the untrusted rightmost hop wins.
    const id = clientIdentity(headers({ "x-forwarded-for": "13.216.193.122, 198.51.100.5" }), {
      trustProxy: true,
      trustedProxies: ["13.216.193.122"],
    });
    expect(id).toBe("198.51.100.5");
  });

  test("falls back to the leftmost hop when the whole chain is trusted", () => {
    const id = clientIdentity(headers({ "x-forwarded-for": "13.216.193.122" }), {
      trustProxy: true,
      trustedProxies: ["13.216.193.122"],
    });
    expect(id).toBe("13.216.193.122");
  });

  test("x-real-ip / cf-connecting-ip only apply when no forwarded chain exists", () => {
    expect(
      clientIdentity(headers({ "x-real-ip": "5.5.5.5", "x-forwarded-for": "1.1.1.1, 203.0.113.7" }), {
        trustProxy: true,
      })
    ).toBe("203.0.113.7");
    expect(clientIdentity(headers({ "cf-connecting-ip": "5.5.5.5" }), { trustProxy: true })).toBe(
      "5.5.5.5"
    );
  });

  test("without trustProxy the socket address wins over any header", () => {
    expect(
      clientIdentity(headers({ "x-forwarded-for": "1.1.1.1" }), {
        trustProxy: false,
        directAddress: "10.0.0.9",
      })
    ).toBe("10.0.0.9");
  });

  test("falls back to the shared bucket only when nothing identifies the caller", () => {
    expect(clientIdentity(headers({}), { trustProxy: true })).toBe("remote");
  });

  test("tolerates blank and padded chain entries", () => {
    expect(
      clientIdentity(headers({ "x-forwarded-for": " 1.1.1.1 , , 203.0.113.7 , " }), {
        trustProxy: true,
      })
    ).toBe("203.0.113.7");
  });
});

describe("parseTrustedProxies", () => {
  test("splits, trims and drops empties", () => {
    expect(parseTrustedProxies(" 13.216.193.122 , 10.0.0.1,, ")).toEqual([
      "13.216.193.122",
      "10.0.0.1",
    ]);
  });

  test("undefined or blank yields no trusted hops", () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies("   ")).toEqual([]);
  });
});
