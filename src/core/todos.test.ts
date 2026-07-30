import { afterEach, describe, expect, it } from "bun:test";
import { withTodosAuth } from "./todos";

afterEach(() => {
  delete process.env.HASNA_TODOS_API_KEY;
  delete process.env.TODOS_API_KEY;
});

describe("withTodosAuth", () => {
  it("returns the original request init when no API key is configured", () => {
    const init = { method: "POST" };

    expect(withTodosAuth(init)).toBe(init);
    expect(withTodosAuth()).toBeUndefined();
  });

  it("uses TODOS_API_KEY as an x-api-key header", () => {
    process.env.TODOS_API_KEY = "todos-fallback-key";

    const init = withTodosAuth({ headers: { "Content-Type": "application/json" } });
    const headers = new Headers(init?.headers);

    expect(headers.get("x-api-key")).toBe("todos-fallback-key");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("prefers a non-empty HASNA_TODOS_API_KEY", () => {
    process.env.HASNA_TODOS_API_KEY = "hasna-key";
    process.env.TODOS_API_KEY = "fallback-key";

    const headers = new Headers(withTodosAuth()?.headers);

    expect(headers.get("x-api-key")).toBe("hasna-key");
  });

  it("falls back when HASNA_TODOS_API_KEY is empty", () => {
    process.env.HASNA_TODOS_API_KEY = "";
    process.env.TODOS_API_KEY = "fallback-key";

    const headers = new Headers(withTodosAuth()?.headers);

    expect(headers.get("x-api-key")).toBe("fallback-key");
  });
});
