import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Readable } from "stream";
import { normalizeConfig } from "./config";
import {
  createObjectStore,
  LocalObjectStore,
  parseRangeHeader,
  resolveLocalObjectPath,
} from "./object-storage";
import { S3Client } from "./s3";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = join(tmpdir(), `attachments-object-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function config(dir = tempDir()) {
  return normalizeConfig({
    storage: {
      backend: "local",
      localDir: dir,
      maxSizeBytes: 1024 * 1024,
    },
  });
}

async function streamText(body: Readable | ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  const stream = typeof (body as Readable).pipe === "function" ? body as Readable : Readable.fromWeb(body as never);
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("object-storage helpers", () => {
  it("parses byte ranges and rejects malformed ranges", () => {
    expect(parseRangeHeader(null, 10)).toBeNull();
    expect(parseRangeHeader("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseRangeHeader("bytes=2-", 10)).toEqual({ start: 2, end: undefined });
    expect(parseRangeHeader("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
    expect(parseRangeHeader("bytes=-20", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRangeHeader("items=0-1", 10)).toBeNull();
    expect(parseRangeHeader("bytes=-0", 10)).toBeNull();
    expect(parseRangeHeader("bytes=9-1", 10)).toBeNull();
    expect(parseRangeHeader("bytes=10-", 10)).toBeNull();
    expect(parseRangeHeader("bytes=--", 10)).toBeNull();
  });

  it("resolves local paths including home-relative directories", () => {
    const cfg = normalizeConfig({ storage: { backend: "local", localDir: "~/attachments-objects" } });

    expect(resolveLocalObjectPath(cfg, "a/b.txt")).toContain("attachments-objects/a/b.txt");
  });
});

describe("LocalObjectStore", () => {
  it("uploads buffers, streams, and files into nested local paths", async () => {
    const cfg = config();
    const store = new LocalObjectStore(cfg);
    const sourceDir = tempDir();
    const sourceFile = join(sourceDir, "source.txt");
    writeFileSync(sourceFile, "file");

    await store.uploadBuffer("buf/out.txt", Buffer.from("buffer"), "text/plain");
    await store.uploadStream("stream/out.txt", Readable.from(["stream"]), "text/plain", {
      transform: (stream) => stream,
    });
    await store.uploadFile("file/out.txt", sourceFile, "text/plain");

    expect(readFileSync(resolveLocalObjectPath(cfg, "buf/out.txt"), "utf8")).toBe("buffer");
    expect(readFileSync(resolveLocalObjectPath(cfg, "stream/out.txt"), "utf8")).toBe("stream");
    expect(readFileSync(resolveLocalObjectPath(cfg, "file/out.txt"), "utf8")).toBe("file");
  });

  it("returns full and ranged streams with metadata", async () => {
    const cfg = config();
    const store = new LocalObjectStore(cfg);
    await store.uploadBuffer("data.txt", Buffer.from("abcdef"), "text/plain");

    const full = store.getStream("data.txt", "text/plain");
    expect(full.status).toBe(200);
    expect(full.contentLength).toBe(6);
    expect(await streamText(full.body)).toBe("abcdef");

    const range = store.getStream("data.txt", "text/plain", { start: 1, end: 3 });
    expect(range.status).toBe(206);
    expect(range.contentLength).toBe(3);
    expect(range.contentRange).toBe("bytes 1-3/6");
    expect(await streamText(range.body)).toBe("bcd");
  });

  it("downloads and deletes local objects while ignoring missing deletes", async () => {
    const cfg = config();
    const store = new LocalObjectStore(cfg);
    const dest = join(tempDir(), "nested", "out.txt");

    await store.uploadBuffer("data.txt", Buffer.from("contents"), "text/plain");
    await expect(store.downloadToFile("data.txt", dest)).resolves.toBe(8);
    expect(readFileSync(dest, "utf8")).toBe("contents");

    await store.delete("data.txt");
    expect(existsSync(resolveLocalObjectPath(cfg, "data.txt"))).toBe(false);
    await expect(store.delete("data.txt")).resolves.toBeUndefined();
  });

  it("creates local or S3 object stores based on resolved backend", () => {
    expect(createObjectStore(config())).toBeInstanceOf(LocalObjectStore);
    expect(
      createObjectStore(
        normalizeConfig({
          storage: { backend: "s3" },
          s3: { bucket: "bucket", region: "us-east-1" },
        }),
      ),
    ).toBeInstanceOf(S3Client);
  });
});
