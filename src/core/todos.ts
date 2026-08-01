const DEFAULT_TODOS_ORIGIN = new URL("http://localhost:3000").origin;

function parseOrigin(url: string | URL | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function trustedTodosOrigins(): Set<string> {
  const origins = new Set<string>([DEFAULT_TODOS_ORIGIN]);
  for (const value of [process.env.HASNA_TODOS_API_URL, process.env.TODOS_API_URL]) {
    const origin = parseOrigin(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

export function withTodosAuth(
  requestUrl?: string | URL,
  init?: RequestInit
): RequestInit | undefined {
  const apiKey = process.env.HASNA_TODOS_API_KEY || process.env.TODOS_API_KEY;
  if (!apiKey) return init;

  const requestOrigin = parseOrigin(requestUrl);
  if (!requestOrigin || !trustedTodosOrigins().has(requestOrigin)) return init;

  const headers = new Headers(init?.headers);
  headers.set("x-api-key", apiKey);

  return { ...init, headers };
}
