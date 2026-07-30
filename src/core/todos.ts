export function withTodosAuth(init?: RequestInit): RequestInit | undefined {
  const apiKey = process.env.HASNA_TODOS_API_KEY || process.env.TODOS_API_KEY;
  if (!apiKey) return init;

  const headers = new Headers(init?.headers);
  headers.set("x-api-key", apiKey);

  return { ...init, headers };
}
