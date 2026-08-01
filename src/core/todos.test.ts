import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { withTodosAuth } from "./todos";

function clearTodosEnv() {
  delete process.env.HASNA_TODOS_API_KEY;
  delete process.env.TODOS_API_KEY;
  delete process.env.HASNA_TODOS_API_URL;
  delete process.env.TODOS_API_URL;
}

beforeEach(clearTodosEnv);
afterEach(clearTodosEnv);

describe("withTodosAuth", () => {
  it("returns the original request init when no API key is configured", () => {
    const init = { method: "POST" };

    expect(withTodosAuth("http://localhost:3000/api/tasks/TASK-001", init)).toBe(init);
    expect(withTodosAuth()).toBeUndefined();
  });

  it("uses TODOS_API_KEY as an x-api-key header for the default todos origin", () => {
    process.env.TODOS_API_KEY = "todos-fallback-key";

    const init = withTodosAuth("http://localhost:3000/api/tasks/TASK-001", {
      headers: { "Content-Type": "application/json" },
    });
    const headers = new Headers(init?.headers);

    expect(headers.get("x-api-key")).toBe("todos-fallback-key");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("prefers a non-empty HASNA_TODOS_API_KEY", () => {
    process.env.HASNA_TODOS_API_KEY = "hasna-key";
    process.env.TODOS_API_KEY = "fallback-key";

    const headers = new Headers(withTodosAuth("http://localhost:3000/api/tasks/TASK-001")?.headers);

    expect(headers.get("x-api-key")).toBe("hasna-key");
  });

  it("falls back when HASNA_TODOS_API_KEY is empty", () => {
    process.env.HASNA_TODOS_API_KEY = "";
    process.env.TODOS_API_KEY = "fallback-key";

    const headers = new Headers(withTodosAuth("http://localhost:3000/api/tasks/TASK-001")?.headers);

    expect(headers.get("x-api-key")).toBe("fallback-key");
  });

  it("does not forward the API key to an arbitrary override origin", () => {
    process.env.HASNA_TODOS_API_KEY = "hasna-key";
    const init = { method: "GET" };

    expect(withTodosAuth("https://example.invalid/api/tasks/TASK-001", init)).toBe(init);
  });

  it("allows a remote origin only when it is explicitly configured", () => {
    process.env.HASNA_TODOS_API_URL = "https://todos.example.com";
    process.env.HASNA_TODOS_API_KEY = "hasna-key";

    const headers = new Headers(withTodosAuth("https://todos.example.com/api/tasks/TASK-001")?.headers);

    expect(headers.get("x-api-key")).toBe("hasna-key");
  });
});
