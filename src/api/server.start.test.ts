import { describe, it, expect } from "bun:test";
import { startServer } from "./server.test-harness.test";

describe("REST API — startServer", () => {
  it("calls Bun.serve when typeof Bun !== undefined (Bun environment)", () => {
    const originalServe = Bun.serve;
    let serveCallArgs: unknown = null;
    (Bun as unknown as { serve: (opts: unknown) => unknown }).serve = (opts: unknown) => {
      serveCallArgs = opts;
      return {} as ReturnType<typeof Bun.serve>;
    };

    try {
      startServer(9999);
      expect(serveCallArgs).not.toBeNull();
    } finally {
      (Bun as unknown as { serve: typeof Bun.serve }).serve = originalServe;
    }
  });
});
